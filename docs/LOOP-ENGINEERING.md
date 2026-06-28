# Loop Engineering — how to drive this repo with an autonomous Claude Code loop

This is the playbook for handing Claude Code a goal and letting it iterate until a
**verifier** says done. Read it once before your first loop run.

## The one idea that matters

A loop converges on **whatever makes the verifier pass** — not on "a working
product." So the verifier is the whole game. Here the verifier is:

```
npm run verify     # = npm run check (node --check every file) && npm test (node --test)
```

If `npm run verify` is green but the feature is broken, your verifier was too weak.
The loop did its job; the spec was wrong.

## The hard boundary: two tiers of "done"

| Tier | Examples | Can a loop verify it? |
| :--- | :--- | :--- |
| **Machine-verifiable** | output-package contract (filenames + JSON shapes), pure logic (`selector.js`, `package.js` time/format/ordering), manifest invariants, syntax | **Yes** — this is what the loop runs against |
| **Human-gated** | load-unpacked in Chrome, real capture, mic permission, the `chrome.debugger` banner, feeding the package to `/audit` (`HANDOFF.md §8`) | **No** — needs a browser + you. Never let the loop claim these as done |

## What the harness CANNOT verify (trust green less here)

The unit harnesses mock `chrome.*` and the DOM. A mock only knows what *you* told it,
so green proves your logic against your *assumptions*, not against Chrome's real
behavior. Bugs that live in the gap between the two will pass every test and only show
up in a browser smoke run. Real examples this project hit, all green-but-broken:

- **CDP timestamp units.** `Runtime`/`Log` timestamps are epoch-ms; `Network.*`
  timestamps are `MonotonicTime` (seconds since an arbitrary origin). The mock fed
  comparable fake numbers, so a `since`-filter comparison that drops *every* live
  network failure passed the suite. Caught only in the browser.
- **Which CDP events Chrome actually emits.** The mock fires whatever event you tell
  it to; it can't tell you that, say, uncaught errors arrive via `Runtime.exceptionThrown`
  (not `consoleAPICalled`) — only a real page proves the event ever fires.
- **Stale-code / reload.** The browser runs the *previously loaded* extension until you
  reload the card AND the tab. Tests run the source on disk; they say nothing about
  what's actually executing in Chrome.
- **Anything visual/focus/z-index** (overlay rendering, the popup stealing focus, the
  debugger banner) — jsdom has no layout or real focus model.

Rule of thumb: **the more a change touches a real browser API (`chrome.debugger`,
`captureVisibleTab`, `getUserMedia`, content-script injection), the less "green" means.**
For those, a green suite is necessary but not sufficient — always finish with the
browser smoke test (`docs/SMOKE-TEST.md`) before calling it done.

## Back to the boundary

The loop is *most confident exactly where it's least trustworthy* (browser behavior),
so the rule is: **narrow the goal to the tier the verifier covers.** Anything browser-only
stays on the manual checklist below, and the loop is told explicitly not to claim it.

## Setup (once)

```
npm install      # installs jsdom + fake-indexeddb (dev only; nothing ships in the extension)
npm run verify   # should print: 6 files OK, 20 tests pass
```

## The workflow per capture surface (test-first)

Do **one capture surface per loop run** — this is `HANDOFF.md §6` phase discipline.
Bundling surfaces is how the offscreen-audio and worker-lifecycle problems tangle.

1. **You (or a planning pass) write the failing spec first.** Add contract tests in
   `test/` describing the new file's exact shape — e.g. for `console.txt`: line format,
   timestamp + route present, that it lands in the zip. Commit them **red**. This is what
   stops the loop from gaming its own tests: it cannot edit `test/` (see guardrails), so
   the only way to green is real implementation.
2. **Run the loop** (prompt below) until `npm run verify` is green.
3. **You run the manual browser gate** (checklist below). Only then is the surface done.

> Why test-first: if the loop writes both the code and the tests, it can make a trivial
> test pass and call it finished. The spec must come from outside the loop.

## The in-session Claude Code prompt

Open Claude Code in the repo root and paste a goal like this (this example targets the
first Phase 2 surface — adapt the **GOAL** line per surface):

```
GOAL: Implement console-error capture so the exported package contains a `console.txt`
that satisfies the failing tests in test/console.test.js. Use lib/debugger-tap.js
(chrome.debugger: Runtime.enable -> Runtime.consoleAPICalled, Log.enable ->
Log.entryAdded), wired into background/service-worker.js. Keep it swappable per
BUILD-GUIDE.md §3.

LOOP PROTOCOL:
- After every change, run `npm run verify`. Read the failures and fix them.
- Repeat until `npm run verify` is fully green. Do not stop while it is red.
- When green, STOP and print: (a) the files you changed, (b) the manual browser
  checks I must run myself, (c) anything you were unsure about.

HARD RULES:
- Do NOT edit anything in test/ or scripts/, and do NOT change existing filenames or
  JSON shapes in lib/package.js (the output-package contract — HANDOFF.md §4). If a
  test seems wrong, stop and tell me; do not "fix" it to pass.
- Do NOT claim browser behavior works. You cannot load the extension. Anything needing
  Chrome, a mic, or the debugger banner goes in the manual-checklist output, not "done."
- One capture surface only. Do not start audio, annotation, or other surfaces.
- Prefer a boring, readable implementation over a clever one (CLAUDE/project rules).

BUDGET: If `npm run verify` is still red after ~10 iterations, stop and summarize what's
blocking — do not thrash.
```

Claude Code iterates against `npm run verify` within the session — that *is* the loop.
You don't need a script for the common case.

## Guardrails (why each exists)

- **Can't touch `test/` or `scripts/`** → prevents reward-hacking (gaming/weakening the verifier).
- **Can't rename contract files/shapes** → a rename silently breaks the downstream `/audit` consumer.
- **One surface per run** → phase discipline; keeps diffs reviewable and avoids tangling MV3 lifecycle issues.
- **Explicit budget** → loops that can't converge should stop and ask, not burn tokens.
- **Review the diff every run** → the verifier is necessary, not sufficient. You are the final gate.

## Manual browser gate (never loopable — `HANDOFF.md §8`)

After a green loop run, you still must:

1. `chrome://extensions` → reload the extension → reload the target tab.
2. Run a real walkthrough on localhost; Start, click around, MARK, Stop.
3. Unzip the package; confirm frames sort chronologically and JSON files parse.
4. For Phase 2 surfaces: trigger a real console error and a forced 404; confirm they
   appear in `console.txt` / `network-errors.txt`.
5. Final gate: run `/audit` on the package and confirm a coherent findings report that
   references at least one console/network finding screenshots alone wouldn't show.

## Optional: headless loop (only for unattended, multi-context runs)

The in-session loop is the 80/20. If you ever want it to run unattended past a single
context window, wrap the CLI in print mode:

```bash
for i in $(seq 1 10); do
  claude -p "Continue the GOAL in docs/LOOP-ENGINEERING.md. Run npm run verify. If green,
             write DONE to .loopstatus and stop. Else fix and continue." \
    --allowedTools "Bash(npm run verify)" Edit Read Write
  grep -q DONE .loopstatus 2>/dev/null && break
done
```

Same guardrails apply. Keep the budget; review the final diff before merging.
