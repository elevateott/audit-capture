# Phase 1 + console smoke test (~15 min)

The verifier proves the machine-checkable tier. This proves the **spine** the verifier
can't reach: classic-worker `importScripts`, `captureVisibleTab`, the data-URL zip
download, content-script ↔ worker messaging, and the `chrome.debugger` attach. Run this
after a batch of loops, before stacking more surfaces.

## 1. Serve the test page on localhost

The manifest only matches `localhost` / `127.0.0.1`, so serve the repo (not `file://`):

```powershell
cd C:\Users\davew\repos\audit-capture
python -m http.server 8000      # or: npx serve -l 8000
```

Open <http://localhost:8000/fixtures/smoke.html>.

## 2. Load the extension

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → select the repo folder.
2. If you'd already loaded it, click **reload** on the card.
3. **Reload the smoke.html tab** so the current content script injects (a stale tab runs the old one).

## 3. Run a session

1. Click the extension → **Start session** (or `Alt+Shift+A`).
2. **Confirm the "…is being debugged" banner appears** at the top of the tab. (Expected — `chrome.debugger`.)
3. In the page, do all of these:
   - Click **Primary**, **Secondary**, and a couple of the **Row** buttons.
   - Type in the **Text field**, then click away (fires a `change`).
   - Click **pushState → /dashboard**, then **/settings**.
   - Click **console.error**, **console.warn**, **console.log**, **uncaught throw**, **load broken image → 404**.
   - Hit **MARK** in the floating overlay (or `Alt+Shift+M`), type `MARK 001 — smoke test, verdict: ok`, Enter.
4. Wait ~10 s so a couple of interval frames fire.
5. Click **Stop & export** → a `audit-<timestamp>.zip` lands in Downloads.
6. **Confirm the debug banner disappears** on Stop.

## 4. Check the package (unzip it)

- [ ] **Frames** — several `YYYY-MM-DD_HH-MM-SS.mmm.jpeg`; sorting by name = chronological; they show the page (not a blank/again the popup).
- [ ] **recording.json** — `{ title, steps[] }`; first step `setViewport`; click steps carry `selectors` like `#primary-action`, `button[data-testid="secondary"]`, `…li > button:nth-of-type(3)`; the text field produced a `change` with `value`.
- [ ] **narration.txt** — one line: `[HH-MM-SS.mmm] (/route) MARK 001 — …`.
- [ ] **console.txt** — has `ERROR: SMOKE console.error sample`, `WARNING: SMOKE console.warn sample`, an `ERROR:` line with the uncaught `thisFunctionDoesNotExist`/`ReferenceError`, and an `ERROR:` line for the 404 image. **No `log` line.** Routes look right (later lines show `/dashboard` or `/settings`).
- [ ] **timeline.json** — ascending by `t`; every `frame` `ref` matches a real `.jpeg` in the zip.

If all boxes check, the spine is sound and you can keep stacking surfaces with confidence.

## 5. If something's off — read the worker logs first

`chrome://extensions` → **Audit Capture** → click **service worker** → its DevTools console.
That's where capture errors surface. Common failures:

| Symptom | Likely cause | Fix |
| :--- | :--- | :--- |
| No frames in the zip | `captureVisibleTab` needs the active tab / permission | check worker console; ensure the tab was focused during capture |
| Clicks but no `recording.json` steps | content script not injected | you loaded/reloaded the extension after opening the tab — reload the tab |
| No `console.txt` errors, no banner | `chrome.debugger` attach failed | worker console will say why (e.g. real DevTools open on that tab — close it) |
| Uncaught throw missing but console.error present | Chrome didn't emit `Runtime.exceptionThrown` for the page | note it; this is the browser-gated piece the unit test can't cover |
| Download didn't start / zip won't open | data-URL / download error | check worker console for the `[audit]` error line |

To report back: paste any red lines from the **worker console** plus which checklist boxes
failed, and I'll diagnose.
