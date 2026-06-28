# Updating the `/audit` skill to consume Audit Capture packages

The `/audit` skill was written for the **old three-app stack** (Auto Screen Capture
frames + Otter transcript + optional DevTools Recorder JSON) and reconciles the
streams **by sequence**, because their clocks don't share a zero. The Audit Capture
extension changes that: it emits one pre-aligned package with `timeline.json` as the
authoritative join. This doc is the change plan — apply it to the skill's source
(the installed copy is read-only).

Guiding principle: **the extension becomes the capture method (Mode A), but Mode B must
still read old packages** (no `timeline.json`) so existing audits don't break. Detect by
presence of `timeline.json`.

## What the package now contains (the contract the skill consumes)

| File | What it is | Skill should treat it as |
| :--- | :--- | :--- |
| `YYYY-MM-DD_HH-MM-SS.mmm.jpeg` | interval + on-click frames | primary visual source (already chronological by name) |
| `*_annotated.png` | operator-drawn frame (arrow/circle) | **high-signal** frame — the operator explicitly flagged this |
| `recording.json` | `{title, steps[]}` click/nav spine | action spine (already handled) |
| `narration.txt` | `[HH-MM-SS.mmm] (/route) <text>` — MARK + voice lines | transcript; MARK ids + route already attached |
| `console.txt` | `[HH-MM-SS.mmm] (/route) LEVEL: message` | first-class finding source (errors/warnings) |
| `network-errors.txt` | `[HH-MM-SS.mmm] (/route) METHOD STATUS URL` | first-class finding source (failed requests) |
| `environment.json` | `{viewport,dpr,zoom,ua,host,url,capturedAt,custom}` | context header ("why does this look broken") |
| `timeline.json` | ordered `[{t, route, type, ref}]`, types: frame/click/mark/console/network/annotation | **THE KEYSTONE — the join. Use instead of sequence-guessing.** |

## Section-by-section changes

### 1. Frontmatter + intro
Add the extension as the primary capture path. Keep the old-stack wording only as the
back-compat fallback. Suggested intro addition:

> The preferred input is an **Audit Capture** package (a `audit-<timestamp>/` folder
> exported by the Audit Capture Chrome extension), which ships a pre-aligned
> `timeline.json`. Older three-app packages (Auto Screen Capture + transcript +
> Recorder) are still read via the sequence-based path when no `timeline.json` is present.

### 2. Mode A — replace the capture guide
The three-app guide (Auto Screen Capture monitor folders, Otter, separate Recorder export)
is replaced by the extension. New Mode A body:

> 1. Create `audits/<timestamp>/` (unchanged).
> 2. Print this capture guide:
>    - Load the Audit Capture extension (unpacked), open the app/page to audit.
>    - Click the extension → **Start** (or Alt+Shift+A). The `● REC` overlay confirms it.
>    - Walk the flow. Frames capture on interval + click automatically. Drop a **MARK**
>      (overlay button or Alt+Shift+M) — type it or click 🎤 to dictate. Use **Annotate**
>      to draw an arrow/circle on the current screen when a picture says it better.
>    - **Stop & export** → unzip the downloaded `audit-<timestamp>.zip` into `audits/<timestamp>/`.
>    - Run `/audit "audits/<timestamp>"`.
> Keep the old three-app instructions in a collapsed "Legacy capture" note for back-compat.

### 3. Step 0 — extend the inventory/classification
Add to the classification list:

> - **timeline.json** — the ordered event join (`[{t, route, type, ref}]`). If present, this
>   is an **Audit Capture** package; it is the authoritative spine (see Step 4').
> - **console.txt / network-errors.txt** — structured, route-tagged error sources. First-class
>   finding inputs, not loose logs.
> - **environment.json** — the context header. Read viewport/dpr/zoom/host before judging
>   layout findings.
> - **`*_annotated.png`** — operator-emphasized frames. Treat as high-signal and pair each with
>   the MARK/voice at the same timestamp.

### 4. NEW Step 4' — timeline-first reconciliation (supersedes sequence-guessing when present)
Insert before the existing Step 4:

> **If `timeline.json` is present, it is the join — do not reconstruct order by sequence.**
> Read it as the ordered list of every event with a shared clock (`t`, epoch ms) and the
> `route` for each. For each entry use `ref` to resolve its file (frame jpeg, annotated png)
> or to find the matching `narration.txt` / `console.txt` / `network-errors.txt` line by
> `[time] (route)`. This makes frame↔MARK↔voice↔console↔network alignment deterministic.
> Fall back to the existing sequence-based Step 4 only for legacy packages with no timeline.

### 5. Console + network as findings (new emphasis)
> Cross-reference `console.txt` and `network-errors.txt` against the timeline: a `console`
> or `network` entry at time `t`/route `r` pins to the frame captured nearest `t` on `r`. A
> red console error or a 4xx/5xx on a screen **is itself a finding** the screenshots alone
> can't show — surface these in the findings table with the exact message/URL/status.

### 6. environment.json (new)
> Read `environment.json` up front. Use viewport/dpr/zoom to decide whether a "broken
> layout" is a genuine defect or an artifact of the capture viewport/zoom, and record
> host/url (and any `custom` fields a per-project extractor added) in the report header.

### 7. The `chrome.debugger` banner (important — avoid a false finding)
> Audit Capture uses `chrome.debugger`, so frames show a **"… is being debugged"** banner
> at the top of the tab for the whole session. This is expected instrumentation, **not a
> defect** — do not flag it, and ignore it when reading the address bar/route.

### 8. Step 0.5 dedupe — soften
> Extension frames are event-driven (interval + click), so there are far fewer near-dupes
> than Auto Screen Capture produced. Dedupe is still safe to run but rarely load-bearing;
> when `timeline.json` is present you can also pick one representative `frame` entry per
> route/state directly from the timeline.

### 9. Findings report header
> Add to the header: that this was an Audit Capture package (timeline present), counts of
> console/network entries and annotations, and the `environment.json` summary.

## How to apply
Edit these into the audit skill's **source** SKILL.md (not the read-only session cache).
The changes are additive and gated on `timeline.json` presence, so legacy three-app
packages continue to work through the existing sequence path.
