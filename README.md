# Audit Capture

A local, unpacked **Manifest V3** Chrome extension that records a web-app walkthrough into a single, AI-ready **audit package**: screenshots, a click/nav spine, typed MARK notes, and an ordered `timeline.json` — exported as one zip a downstream `/audit` step can read with no transformation.

It is **generic** — it audits any web app. Elevate OTT is just the first consumer; nothing app-specific lives in the core.

> Full context lives in [`HANDOFF.md`](./HANDOFF.md), [`PRD.md`](./PRD.md), and [`BUILD-GUIDE.md`](./BUILD-GUIDE.md). Read those before changing capture logic or the output contract.

## Status — Phase 1 (MVP)

Implemented: interval + on-click **frames**, **click spine** → `recording.json`, **MARK** → `narration.txt`, the **`timeline.json`** keystone, and **zip export** to Downloads.

Not yet (later phases): console/network capture via `chrome.debugger` (Phase 2), `environment.json`, push-to-talk voice + Web Speech, draw-on-frame annotation, File System Access delivery (Phase 3). See `HANDOFF.md §6`.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select this folder (`audit-capture/`).
4. Optional: set hotkeys at `chrome://extensions/shortcuts` if the defaults conflict.

There is **no build step** — vanilla JS, loaded directly. After editing a file, click the extension's **reload** icon, then reload the target tab so the new content script injects.

## Use

1. Open the page you want to audit.
2. Click the extension → **Start session** (or `Alt+Shift+A`).
3. Walk through the app. Frames capture every 5s and on each click; clicks build the spine.
4. Hit **MARK** in the floating overlay, or `Alt+Shift+M`, to drop a typed note: `MARK 001 — what you see, verdict`.
5. **Stop & export** → a `audit-<timestamp>.zip` lands in Downloads. Unzip into your repo's `audits/` folder and run `/audit`.

## Configuring which hosts to audit

Host access is **per-project config**, intentionally not hardcoded to any app. Phase 1 ships matching only `localhost` / `127.0.0.1` for safe testing.

To audit a real app, add its host in **two places that must stay in sync** in `manifest.json`:

- `host_permissions` — e.g. `"https://*.example.com/*"`
- `content_scripts[0].matches` — the same pattern

Then reload the extension. (A config/options page that manages this is a Phase 2 item — see `HANDOFF.md §3`.)

> ⚠️ Frames are full visible-tab screenshots — they capture whatever is on screen. Test on a throwaway page or localhost, not on a tab with secrets. Captured packages under `audits/` are git-ignored for the same reason.

## Output package contract

`audit-<timestamp>.zip` contains a single `audit-<timestamp>/` folder. **Phase 1 subset:**

| File | Purpose |
| :--- | :--- |
| `YYYY-MM-DD_HH-MM-SS.mmm.jpeg` (many) | Frames. Filename = capture time → lexical sort = chronological. |
| `recording.json` | Click/nav spine, DevTools Recorder shape: `{ title, steps[] }`. |
| `narration.txt` | One line per MARK: `[HH-MM-SS.mmm] (/route) <text>`. |
| `timeline.json` | Ordered join of every event: `{ t, route, type, ref }`. **The keystone.** |

`console.txt`, `network-errors.txt`, `environment.json`, voice clips, and `*_annotated.png` are added in later phases. **These filenames and JSON shapes are a hard contract** — a downstream consumer depends on them. Don't rename without treating it as a contract change (`HANDOFF.md §4`).

## Layout

```
manifest.json
background/service-worker.js   orchestrator: session, capture, timeline, zip
content/recorder.js            in-page: interval tick, click spine, MARK overlay
lib/selector.js                stable-ish CSS path generator
lib/store.js                   IndexedDB persistence (survives worker restarts)
lib/package.js                 builds the contract files + zips them
lib/jszip.min.js               vendored (no package manager / build step)
popup/                         Start / Stop UI
icons/                         action icons
audits/                        drop exported packages here (git-ignored)
```

## Architecture notes (the three that bite)

- **Service-worker lifecycle:** the worker dies after ~30s idle. The capture interval is driven from `content/recorder.js`'s `setInterval` (not the worker, not `chrome.alarms` — 30s floor). Session state persists to `chrome.storage.session` + IndexedDB so a restart loses nothing.
- **Audio (Phase 3)** needs an offscreen document — `getUserMedia` + Web Speech can't run in the worker.
- **Console/network (Phase 2)** will use `chrome.debugger`; it shows a "being debugged" banner that appears in screenshots — note it so the audit step doesn't mis-flag it. `lib/debugger-tap.js` will be kept swappable.
