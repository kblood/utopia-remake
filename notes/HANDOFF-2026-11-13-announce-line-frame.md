# Utopia handoff: announcement opened over a showing line (2026-11-13)

Model and routing: Claude Haiku 5.5, run inline as the review sub-agent (no delegate was started, so `claudeAgent` routing was not confirmed; no subscription usage was checked and no timer was scheduled). Synthetic `Game.update` probe only, reading the user's own `original/utopia-whdload/Disk.1` and `Disk.2`; no emulator was run and nothing under `original/` was written. Nothing was committed or pushed.

Scope: follow-up to `HANDOFF-2026-11-13-modal-exit-paths.md`, path 6 (announcement, "argued from code"). Question: when `$E770` (`AnnounceScene`, stage `"announce"`) opens while the message line is showing, (a) do the backdrop pixels survive the dialog and the close exactly, (b) does the line's remaining lifetime survive the close exactly, and (c) can the close frame show stale line or overlay pixels.

## 1. Mechanism (from code)

- `Game.updateMap` calls `map.update()` first (the line tick, the expiry erase `presentLineErase`, the pass and its draw, and the poll), then drains `map.sim.events`, then `startAnnouncement()`. So the dialog's backdrop is `map.screen` after every write of that update. The expiry erase is in the backdrop when the line expires on the opening update.
- `AnnounceScene` copies the backdrop into its own `base`. It never writes `map.screen`, and nothing writes back on close. `Game.screen` returns `announce.screen` while the dialog is open, and `map.screen` again after close.
- `Game.update` does not call `map.update()` in stage `"announce"`, so the line timer, the log idle timer and the pass loop are all frozen while the dialog is open. Close (`returnToMap`, stage `"map"`) runs no map update in the same update, so the close frame is the frame held in `map.screen`.
- Chained announcements (`case "announce"` -> `startAnnouncement()`) copy the same unchanged `map.screen` again.

## 2. Measured invariants (`test/announce-line-frame.mjs`, new, 24 checks)

Opened with a line at 194 frames left after a completed pass:

| Invariant | Measured |
|---|---|
| The opening update ticks the line once (194 -> 193) and the dialog opens on that update | yes; that update also ran one pass (`passesRan=1`) |
| Outside the dialog windows (portrait x 96..175 / y 106..185, text x 0..247 / y 8..95, button column x >= 256) the displayed dialog frame equals the map frame | 0 pixels differ |
| Line glyph rows left of the portrait keep the line's pixels | equal |
| 40 idle updates with the dialog open: timer, pass count and `map.screen` | timer stays 193, no pass, map frame unchanged |
| Close by press on the exit icon (button 9) and release elsewhere | stage `map` after the release; the press alone does not close |
| Whole close frame equals the frame shown before the dialog | 0 of 64,000 pixels differ |
| Close update's timer | unchanged (193) |
| Remaining lifetime after close | expires after exactly 193 more map updates (= the remaining frames) |
| Expiry frame, rows 159..165 full width | equal the picture (no stale glyphs) |
| Edge: line at its last frame (1), dialog opens on the expiry update | the line is gone at open; backdrop and `map.screen` rows 160..165 (x 0..95) carry no glyphs; after close rows 159..165 equal the picture |

So, for this path: backdrop pixels are preserved exactly, the remaining lifetime is preserved exactly across the dialog (the only tick is the opening update's normal one), and the close frame cannot reveal stale line or overlay pixels, because it is the pre-dialog frame and the expiry erase reached it before the dialog copied it.

## 3. Things checked and found not to be bugs

- The apparent "row 159 differs from the picture after close" during the first probe run was a probe error: the close had not happened (stage still `announce`). With the close done, row 159 matches the picture (the probe trace showed 5,31,31,31,31,31,31,31,19 before open, during and after the close).
- The first update of a new dialog only initialises its pointer (`announce.ts` `Pointer`, documented in `test/game-over.mjs`). A press that is the first update after the dialog opens is therefore not a press. The probe waits one idle update before pressing. This is the existing rule, not a new finding; it is noted here so a future probe does not mistake it for a stale close.
- Row 159 equals the picture in the map frame of a tutorial state with a line showing and after the expiry (the same claim `notes/formats/game-text.md` section 4 makes for row 159 in probed states; this probe adds the announcement path to those states).

## 4. Open points (not observed in the original)

1. The original's line timer during `$E770`. The remake freezes it (the same rule as the modal-exit note, section 4.2). If the original keeps counting while `$E770` blocks, a line could expire under the dialog. The close frame would then still be the pre-dialog frame in the remake, but the original's would differ. Not observed.
2. Whether the original's `$E770` backdrop includes the line's glyph rows where the portrait does not cover them. The remake draws the line into the backdrop, which follows the trace that `$E770` draws over the displayed bitmap (`screens-misc.md`). Not observed.
3. The first-update pointer initialisation rule (section 3, bullet 2) is inferred from the `$58F8` loop structure, not observed on the original.

## 5. Changes

- `test/announce-line-frame.mjs` (new): 24 `ok` checks, real `Game.update` clicks; skipped when the original files are missing.
- `package.json`: `npm test` chain runs `node test/announce-line-frame.mjs` after `node test/announce.mjs`.
- `notes/formats/game-text.md`, "Other full-screen exits": the announcement row now points here.
- `notes/README.md`: newest-handoff pointer.
- No source change under `src/`: no defect was found.

Mutation check: run, see section 7. Four mutants applied to compiled `dist/` only; each made `test/announce-line-frame.mjs` exit 1. No source or test file was changed.

## 6. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/announce-line-frame.mjs` | exit 0, 24 `ok`, no `FAIL` |
| `node test/announce.mjs` | exit 0, all checks passed |
| `node test/message-panel.mjs` | exit 0, no `FAIL` |
| `node test/offer-exit-frame.mjs` | exit 0 |
| `node test/map-loop.mjs` | exit 0, 309 `ok`, no `FAIL` |
| `npm test` (full chain) | exit 0, 4,584 `ok`, no `FAIL` (the previous handoff recorded 4,560) |

Repository state: nothing committed or pushed. The dirty worktree was preserved. `original/` was only read.

## 7. Mutation check (2026-11-13, test sub-agent)

Method: the compiled `dist/game/announce.js` and `dist/game/game.js` were snapshotted in memory, each mutant was applied as a single exact-string replacement (anchor count checked to be 1), `node test/announce-line-frame.mjs` was run, and the originals were restored before the next mutant. The run script lived outside the repository (in a temp directory) and was not added to the test suite. Afterwards `npm run build` regenerated `dist/` from unchanged `src/`; no mutant string remains in `dist/`. Source and tests were not edited.

| Mutant | Edit to compiled dist | Exit | FAIL checks |
|---|---|---|---|
| M1: announce backdrop written back into the map screen | `announce.js`, after `drawButtons(base)`: `backdrop.pixels.set(this.base.pixels)` | 1 | `the close frame equals the map frame shown before the dialog (exact, whole frame)  differs=26300`; `edge: after close the displayed frame has no line glyphs` |
| M2: line timer ticks while the announcement is open | `game.js`, `case "announce"`: `this.map.messages.update();` before `announce.update` | 1 | `40 updates with the dialog open: the line timer is frozen  left=153`; `the timer is unchanged by the close update`; `the line expires after exactly the remaining frames  updates=151 expected=193` |
| M3: close frame keeps the dialog pixels | `game.js`, `case "announce"`, on close: `this.map.screen.pixels.set(this.announce.screen.pixels)` before `announce = null` | 1 | `the close frame equals the map frame shown before the dialog (exact, whole frame)  differs=26475`; `edge: after close the displayed frame has no line glyphs` |
| M4: backdrop taken from the picture, not the map frame | `game.js`, `startAnnouncement`: backdrop `{ pixels: this.map.initialPicture, palette: ... }` | 1 | `outside the dialog windows the displayed frame equals the map frame (pixels differing: 0)  differs=4666`; `the line glyph rows keep their pixels left of the portrait` |

Baseline before the mutants: 24 `ok`, exit 0. The first M4 attempt passed a raw `Uint8Array` as the backdrop; it threw in the harness (`TypeError` at `frame`), which was a malformed mutant, not a check result. It was corrected and rerun as above.

What this shows: each of the three requested failure modes is caught by an exact check on the frame or timer (close-frame equality, the frozen-timer count, the expiry count), and a fourth backdrop-source fault is caught by the backdrop checks. M2 also shows the timer checks are independent of the frame checks.

Not covered by these mutants: the edge-case expiry erase on the opening update (`presentLineErase` ordering) and the chained-announcement path. Neither was mutated here.

## 8. Verification (test sub-agent run, 2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (before and after the mutants) | exit 0 |
| `node test/announce-line-frame.mjs` (baseline and after restore) | exit 0, 24 `ok` |
| `node test/announce.mjs` | exit 0 |
| `node test/message-panel.mjs` | exit 0 |
| `node test/offer-exit-frame.mjs` | exit 0 |

No test file changed, so the full `npm test` chain was not rerun. Routing: this run was done inline by the Haiku sub-agent. No `claudeAgent` delegate was started, so that routing is not confirmed here. No emulator or original-file writes; nothing committed or pushed.
