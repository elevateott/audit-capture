# PRD — Audit Capture (Chrome Extension)

**Status:** Draft for build **Owner:** David **Last updated:** 2026-06-28 **Form factor:** Unpacked Chrome extension (Manifest V3), loaded locally via `chrome://extensions` → Developer mode → Load unpacked. **Not published to the Web Store.**

---

## 1\. Problem

Capturing an audit package for the `/audit` skill today requires juggling three separate apps and a manual file copy:

1. **Otter** — start a narration session.  
2. **Chrome DevTools → Recorder** — start a click recording.  
3. **Auto Screen Capture** — start interval screenshots (and remember which monitor's `Screen N` folder to keep).  
4. **Manually copy** the screenshots, transcript, and recorder export into `audits/<timestamp>/`.

This is friction every single time, and it leaves the `/audit` skill doing avoidable work: deduping frames, sorting by filename, and guessing-by-sequence which narration line belongs to which screen.

## 2\. Goal

One Chrome extension that captures everything the `/audit` skill needs in a single session and exports it as a ready-to-audit package — replacing all three apps and the copy step. Because the extension runs **inside the page**, it can also capture signal the old stack structurally could not (console errors, failed requests, resolved tenant), and it can emit a pre-aligned timeline so the skill stops guessing.

## 3\. Non-goals (explicit)

- **Not a Web Store product.** Personal/Elevate use only, unpacked. No public listing, no support surface, no marketing. Productizing is a separate future decision, made only if other devs actually ask.  
- **No full HAR capture.** Failed requests only. The full network waterfall is mostly noise and large files.  
- **No localStorage/sessionStorage dump.** Secret-leak risk for near-zero UX signal.  
- **No accessibility (axe-core) scan.** That's the `accessibility-review` skill's job; bundling it blurs what an audit package means.  
- **No continuous video.** We deliberately replaced always-on capture with discrete, anchored events.  
- **No always-on microphone.** Audio is push-to-talk only (see §4.4).  
- **No replay.** The recorder spine is read as data by the skill, never executed.

## 4\. Users

Primary: **David**, auditing the Elevate OTT web app (admin CMS \+ public frontend). Secondary (capability only, not a shipped audience): any developer who loads the unpacked extension.

## 5\. Functional requirements

### 4.0 Session control

- **Start / Stop session** from the popup. Start creates an in-memory (persisted) session; Stop assembles and exports the package.  
- A small **floating overlay** on the page shows recording state and exposes the MARK and push-to-talk controls, plus a frame counter and elapsed time.  
- Global hotkeys (via `chrome.commands`) for: toggle session, MARK, push-to-talk.

### 4.1 Frame capture — *default on*

- Interval screenshot (default **5s**, configurable) **and** a screenshot on every click.  
- Visible-tab capture (`chrome.tabs.captureVisibleTab`, JPEG, quality \~80).  
- Filenames match Auto Screen Capture's pattern so the skill's lexical sort \= chronological: `YYYY-MM-DD_HH-MM-SS.mmm.jpeg`.

### 4.2 Click spine (recorder) — *default on*

- Content script records `click`, `change`/input, and navigation events with a stable CSS selector \+ (for inputs) the value.  
- Exported as `recording.json` in DevTools Recorder shape: `{ "title": ..., "steps": [ { "type": "navigate" | "click" | "change", "url"?, "selectors"?, "value"? } ] }`, so the skill reads it as the action spine with zero changes.

### 4.3 MARK annotations — *default on*

- Hotkey/button writes a typed `MARK — <id>, <what you see>, <verdict>` line, auto-stamped with timestamp \+ current route, pinned to the frame at that moment.  
- Lands in `narration.txt` (the skill's transcript input).

### 4.4 Push-to-talk voice notes — *default on, used on demand*

- Press to record, press to stop. Discrete clips only — **no continuous track**.  
- Each clip is anchored to the frame \+ route at record time (a "voice MARK").  
- **Web Speech API** transcribes live; the transcript line is written to `narration.txt` exactly like a MARK. The `.webm` clip is saved alongside as a backup if the transcript is garbage.  
- Rationale: captures *intent to change* ("move this to the sidebar") that screenshots and typed MARKs can't carry.

### 4.5 Console capture — *default on*

- Continuous capture of console errors/warnings (and optionally logs), each timestamped \+ tagged with the route it occurred on.  
- Output: `console.txt` (timestamped lines). A red error on a screen is itself a finding.

### 4.6 Network failure capture — *default on*

- Capture **only** failed requests (HTTP 4xx/5xx and network-level failures): method, URL, status, timestamp, route.  
- Output: `network-errors.txt` (or `.json`). Not a full HAR.

### 4.7 Context header — *default on*

- One `environment.json`: viewport size, devicePixelRatio, zoom, browser/UA version, page URL/host, and **the resolved Elevate tenant** (read from the page where available).  
- Rationale: explains "why does this look broken" (viewport/zoom) and gives instant evidence for cross-tenant rendering.

### 4.8 Frame annotation (draw) — *optional power feature*

- Before saving a frame, draw an arrow/circle on it to point at the thing being discussed. Pairs with a voice note for "I want this changed."  
- Annotated frame saved as `<same-timestamp>_annotated.png` next to the raw frame.

### 4.9 Timeline manifest — *default on, the keystone*

- A single ordered `timeline.json`: every event (`frame`, `click`, `mark`, `voice`, `console`, `network`) with `t` (timestamp), `route`, `type`, and a `ref` pointer to its file.  
- This is the join key the `/audit` skill currently reconstructs by hand. Emitting it makes reconciliation deterministic.

## 6\. Output package contract

On Stop, the extension produces a folder/zip whose contents map directly onto the `/audit` skill's Step 0 inventory:

| File | Skill classification |
| :---- | :---- |
| `*.jpeg` frames (`YYYY-MM-DD_HH-MM-SS.mmm.jpeg`) | Screenshot frames (primary visual source) |
| `recording.json` (`{title, steps[]}`) | DevTools Recorder recording (action spine) |
| `narration.txt` (MARK \+ voice transcript lines) | Transcript |
| `console.txt` | Logs |
| `network-errors.txt` | Logs / network |
| `environment.json` | Notes / context |
| `*_annotated.png` | Screenshot frames |
| `timeline.json` | Notes / context (pre-aligned join) |

Target destination: `audits/<timestamp>/` in the repo. Two viable delivery paths (decide in build): **(a)** File System Access API writes straight into the chosen `audits/` folder, or **(b)** zip download to Downloads, user moves it. (a) is fewer steps; (b) is simpler to build.

## 7\. Defaults summary

**On by default (no toggle to forget):** frames, click spine, MARK, push-to-talk, console errors, network failures, context header, timeline manifest. **Optional:** frame annotation; console *info/log* level (errors/warnings always on); interval length. **Deliberately absent:** full HAR, storage dump, a11y scan, continuous video, always-on mic.

## 8\. Success criteria

- A complete audit package is captured and exported in **one session, zero app-switching, zero manual copy.**  
- The exported package runs through `/audit` with **no changes to the skill** and produces a findings report at least as good as today's.  
- `timeline.json` removes the skill's sequence-guessing for at least frame↔MARK↔voice alignment.  
- Console/network errors surface in the findings that the screenshot-only flow missed.

## 9\. Open questions

1. **Delivery:** File System Access (write to `audits/` directly) vs zip-to-Downloads? (Build guide leans FS Access for fewer steps; fall back to zip if it's fiddly.)  
2. **Transcript review:** after a voice clip, show the transcript to edit/redo on the spot, or trust-and-continue? (Lean: trust-and-continue; the `.webm` backup covers misfires.)  
3. **Console capture mechanism:** `chrome.debugger` (complete, but shows a "DevTools" banner on the tab) vs content-script monkeypatch (no banner, misses some errors). See build guide §3.  
4. **Scope of routes:** capture only on Elevate hosts (host\_permissions allowlist) or any tab? Lean: allowlist, to avoid capturing unrelated browsing.

