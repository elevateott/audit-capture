# Project Handoff — Audit Capture (Chrome Extension)

**For the new Cowork project / repo.** This doc is self-contained: it carries the full context, the decisions already locked, and the build plan so the receiving agent does not need the original conversation or the Elevate knowledge base. Two companion docs (`PRD.md`, `BUILD-GUIDE.md`) should be copied into the new repo alongside this one — they hold the detailed requirements and step-by-step build.

---

## Project title

**Audit Capture — web-app audit recorder (Chrome extension)**

## Project description

A Manifest V3 Chrome extension that records a walkthrough of any web app into a single, AI-ready **audit package**. In one session it captures interval \+ on-click screenshots, a click/navigation spine, console errors, failed network requests, typed MARK annotations, and push-to-talk voice notes — then exports them as a folder an AI agent can read to produce a UX/QA findings report. It replaces a three-app stack (screenshot tool \+ DevTools Recorder \+ transcription app \+ manual file-copy). Runs unpacked/local — no Web Store. Built generic so it can audit any web project; Elevate OTT is the first consumer.

---

## 1\. Why this exists

Capturing material for an AI-assisted UX/QA audit currently means running three separate tools and hand-copying their outputs into one folder. It's friction every time, and it leaves the downstream AI step reconstructing the timeline by guesswork (deduping frames, sorting by filename, matching narration to screens by sequence).

This extension collapses all of that into one session. Because it runs **inside the page**, it also captures signal the old stack couldn't — console errors, failed requests, the resolved app context — and emits a pre-aligned timeline so the AI step stops guessing.

## 2\. What's already decided (do not relitigate)

These came out of a design discussion and are settled:

- **Form factor:** unpacked MV3 extension, loaded via `chrome://extensions` → Developer mode → Load unpacked. **Not published.** Personal/internal use. Productizing is a separate future decision.  
- **No always-on microphone.** Audio is **push-to-talk**: discrete clips, each anchored to the frame \+ route at record time (a "voice MARK"). Rationale: continuous narration is low-signal and expensive to reconcile; discrete clips are self-anchoring. Voice exists specifically to capture *intent to change* ("move this to the sidebar") that screenshots and typed notes can't carry.  
- **Transcription \= Web Speech API**, live, written straight into the notes file. The `.webm` clip is saved as a backup if the transcript is garbage.  
- **Typed MARK annotations** are a first-class capture: a hotkey writes `MARK — <id>, <what you see>, <verdict>`, stamped with timestamp \+ route, pinned to the current frame.  
- **Capture set, all default-on:** frames, click spine, MARK, push-to-talk voice, console errors/warnings, failed network requests (4xx/5xx \+ network-level), context header, and a `timeline.json` manifest. **Frame annotation (draw-on-frame)** is the one optional power feature.  
- **Deliberately excluded:** full HAR (noise \+ large files), localStorage/sessionStorage dumps (secret-leak risk), accessibility/axe scans (different tool's job), continuous video.  
- **The `timeline.json` manifest is the keystone.** The extension already knows the order of every event at capture time, so it emits an ordered join — every event with timestamp, route, type, and a file pointer. This is what removes the downstream guesswork.  
- **Console/network mechanism:** recommended `chrome.debugger` (complete, but shows a "being debugged" banner on the tab) over a content-script monkeypatch (no banner, misses some errors). Keep it swappable. See `BUILD-GUIDE.md §3`.

## 3\. What must be GENERALIZED (this is new for the standalone project)

The PRD/build guide were written with Elevate as the target. For a reusable tool:

- **Host allowlist is config, not hardcoded.** `manifest.json` `host_permissions` and `content_scripts.matches` should be easy to set per project. Consider an options page (or a simple `config.js`) where the user lists the hosts to audit, instead of editing the manifest by hand.  
- **Custom context fields are a hook, not a fixed schema.** The PRD's "resolved tenant" capture is Elevate-specific. Generalize `environment.json` to always capture the universal fields (viewport, DPR, zoom, UA, host, URL) plus an **optional, configurable extractor** — a small per-project function/selector that pulls app-specific context (e.g. Elevate's tenant) if defined. Ship with none configured.  
- **No Elevate assumptions anywhere else.** The output package and capture logic are app-agnostic.

## 4\. Output package contract (self-contained — the AI step depends on this exact shape)

On Stop, the extension produces a folder (or zip) named `audit-<timestamp>/` containing:

| File | Purpose |
| :---- | :---- |
| `YYYY-MM-DD_HH-MM-SS.mmm.jpeg` (many) | Screenshot frames. **Filename \= capture time**, so lexical sort \= chronological. |
| `recording.json` | Click/nav spine in DevTools-Recorder shape: \`{ "title": ..., "steps": \[ {"type":"navigate" |
| `narration.txt` | One line per MARK and per voice note: `[HH-MM-SS.mmm] (/route) <text>`. MARK ids must be regex-extractable. |
| `console.txt` | Timestamped console errors/warnings, tagged with route. |
| `network-errors.txt` | Failed requests only: method, URL, status, timestamp, route. |
| `environment.json` | Viewport, DPR, zoom, UA, host, URL, capturedAt \+ optional custom fields. |
| `<ts>_annotated.png` (optional) | Draw-on-frame annotations, next to the raw frame. |
| `timeline.json` | Ordered join of every event: `{t, route, type, ref}`. The keystone. A `'mark'` entry additionally carries an optional `markId` (string, zero-padded, e.g. `"001"`) that matches the MARK id in `narration.txt`, so the two streams join exactly without guessing by timestamp+route. |

This shape is designed so a downstream AI audit step can inventory the folder and reconcile the streams with no transformation. Keep filenames and JSON shapes stable — changing them breaks consumers. New fields must be **additive and backward-compatible**: consumers that ignore unknown keys (like `markId`, added on `'mark'` entries) keep working.

## 5\. Architecture summary (full detail in BUILD-GUIDE.md)

MV3 components: **service worker** (orchestration, `captureVisibleTab`, `chrome.debugger`, package writer), **content script** (click spine, interval tick, on-page overlay \+ MARK UI), **offscreen document** (audio `getUserMedia` \+ Web Speech — a service worker has no DOM), **popup** (Start/Stop, settings).

Three genuinely fiddly bits, flagged so they're not underestimated:

1. **MV3 service-worker lifecycle** — worker dies after \~30s idle; drive the capture interval from the content script's `setInterval` (which wakes the worker via message), not from the worker or `chrome.alarms`.  
2. **Audio needs an offscreen document** — `getUserMedia` \+ Web Speech can't run in the worker.  
3. **Console/network capture fork** — `chrome.debugger` vs monkeypatch (§3 of build guide).

## 6\. Recommended build order (ship MVP first)

- **Phase 1 (MVP):** manifest \+ worker \+ content script; Start/Stop; interval \+ on-click frames; click spine → `recording.json`; MARK → `narration.txt`; `timeline.json`; zip-download delivery. **Verify end-to-end before going further.**  
- **Phase 2:** `chrome.debugger` tap → `console.txt` \+ `network-errors.txt`; `environment.json`; floating overlay with live counters; host-allowlist config/options page.  
- **Phase 3:** offscreen audio \+ Web Speech push-to-talk; draw-on-frame annotation; optional File System Access delivery (write straight into the target `audit-<ts>/` folder instead of zip).

## 7\. Open questions to resolve with the user

1. **Repo location/name** for the new project.  
2. **Delivery:** File System Access (write directly to a chosen folder) vs zip-to-Downloads. Lean: zip for MVP, FS Access later.  
3. **Transcript review:** edit/redo each voice transcript on the spot, or trust-and-continue (with the `.webm` as backup). Lean: trust-and-continue.  
4. **Config surface:** options page vs a checked-in `config.js` for the host allowlist and custom context extractor.  
5. **TS or plain JS**, and whether to add a bundler (likely unnecessary for MVP).

## 8\. How to verify it works

Run a real walkthrough, export, and confirm the package: frames sort chronologically; `recording.json` parses with selectors+routes; `narration.txt` MARK ids are regex-extractable; a deliberately-triggered console error and a forced 404 show up in their files; `timeline.json` is ordered and every `ref` resolves; a voice clip transcribes with `.webm` backup present. Final gate: hand the package to an AI audit step and confirm it produces a coherent findings report that references at least one console/network finding the screenshots alone wouldn't show.

---

**Companion docs to copy into the new repo:** `PRD.md` (detailed requirements, defaults, non-goals) and `BUILD-GUIDE.md` (component-by-component implementation, manifest, code sketches, install steps).  
