# Build Guide — Audit Capture Chrome Extension

Implementation-ready guide for building the extension described in `PRD.md`. Written so a coding agent can execute it step by step. Manifest V3, plain JS/TS, no framework required.

**Honest difficulty read:** the capture primitives are individually easy. The genuinely fiddly parts — flagged inline — are (1) the MV3 service-worker lifecycle, (2) audio \+ Web Speech needing an **offscreen document**, and (3) choosing how console/network are captured. Get those three right and the rest is plumbing. Estimate: a focused MVP (frames \+ click spine \+ MARK \+ export) in one Claude Code session; full feature set in two.

---

## 1\. Architecture (MV3 components)

audit-capture/

├── manifest.json

├── background/

│   └── service-worker.js      \# orchestrates capture, holds session, writes package

├── content/

│   └── recorder.js            \# in-page: click spine, interval tick, floating overlay, MARK UI

├── offscreen/

│   ├── offscreen.html         \# hosts audio (getUserMedia) \+ Web Speech (needs a DOM)

│   └── offscreen.js

├── popup/

│   ├── popup.html             \# Start/Stop, settings (interval, optional toggles)

│   └── popup.js

├── lib/

│   ├── selector.js            \# stable CSS-path generator for the recorder spine

│   ├── package.js             \# builds timeline.json \+ writes/zips the package

│   └── debugger-tap.js        \# console \+ network capture via chrome.debugger (see §3)

└── icons/

**Why these pieces:**

- `captureVisibleTab` and `chrome.debugger` can only be called from an **extension context** (service worker), not a content script.  
- Click events, the interval timer, and the on-page overlay must live in a **content script** (it has the DOM).  
- `getUserMedia` \+ `webkitSpeechRecognition` need a real document and a user-gesture/secure context — a **service worker has no DOM**, so audio lives in an **offscreen document**.

### Data flow

1. Content script detects a click / fires its interval → `chrome.runtime.sendMessage({type:'capture'})`.  
2. Service worker wakes, calls `captureVisibleTab`, stamps \+ stores the frame, appends a `timeline` entry.  
3. Console/network events stream from the `chrome.debugger` tap (§3) into the same timeline.  
4. MARK text and voice transcripts come back from the content script / offscreen doc and append `timeline` \+ `narration.txt` lines.  
5. On Stop, `lib/package.js` serializes everything (§7).

---

## 2\. Manifest

{

  "manifest\_version": 3,

  "name": "Audit Capture",

  "version": "0.1.0",

  "permissions": \[

    "activeTab", "tabs", "scripting", "downloads",

    "storage", "offscreen", "debugger"

  \],

  "host\_permissions": \[

    "https://\*.elevate.tv/\*",        // ← set to your real Elevate hosts

    "http://localhost/\*"

  \],

  "background": { "service\_worker": "background/service-worker.js", "type": "module" },

  "action": { "default\_popup": "popup/popup.html" },

  "commands": {

    "toggle-session": { "suggested\_key": { "default": "Alt+Shift+A" }, "description": "Start/stop audit session" },

    "mark":           { "suggested\_key": { "default": "Alt+Shift+M" }, "description": "Add a MARK" },

    "push-to-talk":   { "suggested\_key": { "default": "Alt+Shift+V" }, "description": "Toggle voice note" }

  },

  "content\_scripts": \[

    { "matches": \["https://\*.elevate.tv/\*", "http://localhost/\*"\],

      "js": \["content/recorder.js"\], "run\_at": "document\_idle" }

  \]

}

**Lifecycle gotcha:** an MV3 service worker is killed after \~30s idle. **Do not** drive the capture interval from a `setInterval` in the worker — it won't survive. Drive it from the **content script's** `setInterval`, which posts a message each tick; the inbound message wakes the worker just long enough to capture. (`chrome.alarms` has a 30s minimum, too slow for a 5s interval — don't use it for the tick.) Persist the session to `chrome.storage.session` or IndexedDB so a worker restart doesn't lose data.

---

## 3\. Console \+ network capture — pick the mechanism (Open Question \#3)

Two options; the build should choose one and note it.

**Option A — `chrome.debugger` (recommended for completeness).** Attach to the tab and subscribe to DevTools Protocol events:

- Console: `Runtime.enable` → `Runtime.consoleAPICalled`, plus `Log.enable` → `Log.entryAdded`.  
- Network failures: `Network.enable` → `Network.responseReceived` (filter status ≥ 400\) and `Network.loadingFailed`.  
- Pros: catches everything DevTools would, including resource errors and non-fetch requests.  
- Con: Chrome shows a **"…is being debugged"** banner on the tab for the whole session. Acceptable for a deliberate audit, but it *is* visible in the screenshots — note it so the skill doesn't flag the banner as a defect.

**Option B — content-script monkeypatch (lighter, no banner).** Override `console.error/warn` and wrap `fetch` \+ `XMLHttpRequest` in the page to log failures.

- Pros: no banner.  
- Cons: misses resource-load errors, CSP violations, requests not going through fetch/XHR; can be defeated by page code; injection timing means early errors slip through.

**Recommendation:** Option A. The banner is a small price for not missing the exact API failures the audit exists to find. Keep `debugger-tap.js` isolated so it can be swapped for Option B if the banner ever becomes a problem.

---

## 4\. Frame capture

In the service worker:

async function captureFrame(reason /\* 'interval' | 'click' \*/) {

  const dataUrl \= await chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 80 });

  const ts \= stamp();                       // 'YYYY-MM-DD\_HH-MM-SS.mmm'

  const name \= \`${ts}.jpeg\`;

  await store.put('frames', name, dataUrl); // IndexedDB

  timeline.push({ t: Date.now(), route: currentRoute, type: 'frame', ref: name, reason });

}

- Interval tick comes from the content script (see lifecycle gotcha). On-click capture: content script sends `{type:'capture', reason:'click'}` from a capture-phase click listener.  
- `captureVisibleTab` is rate-limited (\~2/sec). A 5s interval \+ clicks stays well under; if you ever burst, debounce.  
- Filenames **must** be `YYYY-MM-DD_HH-MM-SS.mmm.jpeg` so the skill's lexical sort \= chronological order.

---

## 5\. Click spine (recorder.json)

In `content/recorder.js`, capture-phase listeners for `click`, `change`, and `popstate`/navigation:

document.addEventListener('click', (e) \=\> {

  send('step', { type: 'click', selectors: \[\[cssPath(e.target)\]\], route: location.pathname });

}, true);

- `lib/selector.js` returns a stable CSS path (prefer `id`, then `data-*`, then nth-of-type). Keep it small; this just needs to be good enough to identify the element in a ticket.  
- Build `recording.json` as `{ "title": "<session>", "steps": [...] }` matching the DevTools Recorder shape, with a leading `{ "type": "setViewport", ... }` and `navigate` steps on route change. The `/audit` skill reads exactly this shape.

---

## 6\. MARK \+ push-to-talk voice

**MARK** (typed): hotkey or overlay button opens a one-line input. On submit, append to `narration.txt`:

\[HH-MM-SS.mmm\] (/route) MARK 041 — readiness panel missing "featured image", verdict: bug

and push a `{type:'mark', ...}` timeline entry referencing the nearest frame.

**Push-to-talk** (offscreen doc):

1. Service worker ensures the offscreen document exists: `chrome.offscreen.createDocument({ url:'offscreen/offscreen.html', reasons:['USER_MEDIA'], justification:'record audit voice notes' })`.  
2. Offscreen `offscreen.js`: on "start", `getUserMedia({audio:true})` → `MediaRecorder` to a `.webm`, and `new webkitSpeechRecognition()` (`continuous=true`, `interimResults=false`) for the transcript.  
3. On "stop": save `clip_<ts>.webm`, and append the recognized transcript to `narration.txt` as a voice line, anchored to the frame/route at record-start.

**Audio gotchas:** mic permission must be granted to the extension (trigger a one-time permission prompt from a visible extension page, e.g. the popup, before first use). Web Speech sends audio to Google's service — fine for a UI audit, worth noting. If recognition returns empty, the `.webm` is the fallback the operator can replay.

---

## 7\. Package assembly (`lib/package.js`)

On Stop:

1. Read all frames \+ clips from IndexedDB.  
2. Emit `recording.json`, `narration.txt`, `console.txt`, `network-errors.txt`, `environment.json`, and **`timeline.json`** (the ordered join of every event).  
3. Deliver — two options (Open Question \#1):  
   - **A. File System Access API:** first session, prompt `showDirectoryPicker()` for the repo's `audits/` folder, then write `audits/<timestamp>/...` directly. Fewest steps. (Note: FS Access from an extension works best invoked from the popup page, not the worker.)  
   - **B. Zip download:** bundle with JSZip → `chrome.downloads.download(...)` → user unzips into `audits/<timestamp>/`. Simpler to build, one manual move.  
4. `environment.json` example:

{ "viewport": {"w":1280,"h":800}, "dpr": 2, "zoom": 1, "ua": "...", "host": "acme.elevate.tv", "tenant": "acme", "capturedAt": "2026-06-28T14:32:00Z" }

The output contract is in `PRD.md §6` — every file maps onto a `/audit` skill Step 0 classification, so **no skill changes are required.**

---

## 8\. Build order (phased — ship MVP first)

**Phase 1 — MVP (one session).** Manifest \+ service worker \+ content script. Start/Stop from popup. Interval \+ on-click frames. Click spine → `recording.json`. MARK → `narration.txt`. `timeline.json`. Zip download (Option B). **Verification:** run a real flow, unzip, run `/audit "audits/<ts>"`, confirm it produces a findings report.

**Phase 2 — in-page signal.** `chrome.debugger` tap → `console.txt` \+ `network-errors.txt`. `environment.json` with tenant. Floating overlay with live counters.

**Phase 3 — voice \+ annotation.** Offscreen audio \+ Web Speech push-to-talk. Frame annotation (draw). Optionally switch delivery to File System Access (Option A).

---

## 9\. Local install & reload

1. `chrome://extensions` → toggle **Developer mode** (top right).  
2. **Load unpacked** → select the `audit-capture/` folder.  
3. After code changes: click the **reload** icon on the extension card (and reload the target tab so the new content script injects).  
4. Set hotkeys at `chrome://extensions/shortcuts` if the suggested keys conflict.

No Web Store, no packaging, no review. (If you ever want to hand it to another dev, zip the folder; they Load unpacked the same way. Publishing is only needed for auto-update / public listing.)

---

## 10\. Verification checklist

- [ ] Frame filenames sort chronologically (`ls audits/<ts>` is in journey order).  
- [ ] `recording.json` parses as `{title, steps[]}`; steps have selectors \+ routes.  
- [ ] `narration.txt` lines carry timestamp \+ route; MARK ids extractable by regex.  
- [ ] A deliberately-triggered console error and a forced 404 appear in `console.txt` / `network-errors.txt`.  
- [ ] `timeline.json` is monotonically ordered and every `ref` resolves to a file.  
- [ ] Voice clip transcribes; `.webm` present as backup.  
- [ ] **End-to-end:** `/audit "audits/<ts>"` produces `audit-findings.md` with no skill edits, and the report references at least one console/network finding the screenshots alone wouldn't show.  
- [ ] Confirm the `chrome.debugger` banner (if Option A) isn't mis-flagged — note it in the session or strip it from frames.

