# Utopia handoff: messages posted after the VBL wait (`$99C4`, 2026-11-13)

Model and routing: Claude Haiku 5.5, inline research and implementation. No orchestration tool was called. No emulator was run and nothing under `original/` was written; the probe lived outside the repo (scratch directory in the user's temp folder, not committed). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: messages that `Sim.runAfterVblWait()` (`$99C4`) posts into `sim.messages`. Question: should they be drawn in the same update or the next, and when does the 200-frame timer start relative to the first displayed frame. Previous open point: `HANDOFF-2026-11-13-pass-message-timer.md`, section 5.2.

## 1. Answer

Same update. Evidence (STATIC, Disk.1 caller order, as in `game-text.md` section 4 and `map-rendering.md` section "Back-buffer cadence"):

- The original loop is pass body (`$333A`) → draw (`$6540`/`$3310`, back buffer) → date work → VBL wait (`$15846`) → `$99C4` → `$50B2`.
- `$99C4` therefore runs after the VBL wait that ends the pass. A message it posts through `$551A` / `$5A8C` draws at once and sets `$156AC` = 200 at that point. The VBL decrement (`$2CAA`) for that VBL has already run, so the line is not ticked at posting.
- Its first visible frame is the one posted in that iteration. The line then lasts 200 VBL decrements.

Remake before this slice (measured, `probe-wait.mjs`, real Disk.1/Disk.2 scene, posting update P):

| Measure | Original (static) | Remake before | Remake after |
|---|---|---|---|
| Timer at posting update P | 200 | 200 (spliced at P+1 with hold) | 200 |
| First painted update | P | P+4 (next completed draw) | P |
| Timer at first paint | 200 | 197 | 200 |
| Visible run | 200 from P | 200 from P+4 (shifted one pass) | 200 from P |

The discrepancy was a presentation lag of one full pass, not a timer difference: the splice ran at the start of the next update, and lines are painted only in `drawPass` (completed passes) or in the presentation helpers.

## 2. Change

`src/game/map.ts`:

- `spliceSimMessages()`: one shared splice of `Sim.messages` into `Messages`, with the alert sound. Returns `{ count, line }`.
- Pass-time splice (before `messages.update()`): unchanged behaviour. It still holds one tick when a line was set (`holdLineTick`).
- After `this.sim.runAfterVblWait()` in the completed branch: `spliceSimMessages()`, with no hold, because `messages.update()` already ran in this update. If anything was spliced, `presentMessageBand()` runs before `poll()`, so the original order `$99C4` → `$50B2` holds (a `$99C4` line is set before a poll line).
- `presentMessageBand()`: repaints rows 160..199 from the pristine picture (`restoreMessageBand()`, the same step `restoreOverlayAreas()` uses in `drawPass`), applies the clear-fill when the log is cleared, then `messages.draw()` (line and every log entry). Copies to the active bitmap. No timer, pass, RNG, date or loop state changes. Skipped while a modal menu is visible.
- `restoreOverlayAreas()` now calls `restoreMessageBand()` (no behaviour change).

Not changed: poll-side pushes, the modal-exit hold, `presentMessageLine()` (rows 160..170, poll path), the checkpoint recorder, and the pass-time order.

## 3. Tests

- `test/map-loop.mjs` section 7f (new, real Disk.1/Disk.2): a `$99C4` line: timer 200 in the posting update; the band differs from a quiet twin in that update; the next update ticks to 199; the band in the posting update equals the next completed pass's band (`differs=0`). A `$99C4` log message: the band differs from the twin in the posting update; the line timer stays 0; one log entry (the twin has none).
- `test/checkpoint.mjs`: the old expectation pinned the one-update lag ("queued after the drain, first seen in the next checkpoint"). It now expects the `$99C4` message drained in its posting update (`messagesPushed` `113,143` at the first pass-end checkpoint, the queue empty, nothing at the second).
- Mutant check (compiled `dist/game/map.js` only, source untouched, rebuilt and restored): removing `presentMessageBand()` fails exactly the three 7f presentation checks.

## 4. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 269 `ok`, no `FAIL` |
| `node test/checkpoint.mjs` | exit 0, all checks passed (after the expectation update above) |
| `node test/message-panel.mjs` | exit 0, no `FAIL` |
| `npm test` (full chain) | exit 0, 4,508 `ok`, no `FAIL` line |

Optional capture comparators were not run (no external Copperline captures set), as before.

## 5. Still open

1. **Erase lag (every line): resolved by `HANDOFF-2026-11-13-line-expiry.md`.** The line's pixels now go in the update whose VBL makes the timer 0 (`$2CAA` -> `$558A`). The log's go with the next completed pass (`$15850`). Before that fix, `Messages.update()` cleared the text at 0 but the pixels went only with the next completed pass draw: 0 to 3 updates later (a pre-fix probe measured 3, timer 0 at update 201, last visible at 203). The original erases at that VBL decrement (`$558A`, from `$2CAA`). This is the same mechanism for poll-posted lines, so it is a separate path and was not fixed.
2. **Poll-posted `Sim.messages`.** If an input path calls a `Sim` method that posts through `Sim.msg` (for example the placement or demolition text, which `game-text.md` lists as next-pass), those messages are still spliced on the next update. The original draws them in the poll (`$50B2`). Not traced in this slice.
3. **`$551A` call site of each `$99C4` message.** Only the order "posted in `$99C4`, after the draw and the VBL wait" is traced; which string index is posted by which `$99C4` routine (gun A/B, daily, weekly, monthly, yearly, the event scheduler) was not swept. The fix does not depend on the index.
4. **One remake update is one VBL.** Same assumption as the pass-time note (section 5.3 there). The 200-frame count depends on it.
5. **No original capture** exists for these timings. The claims above are static order plus remake measurement.

## 6. Notes changed

- `notes/formats/game-text.md` section 4: the "Not verified" sentence on `runAfterVblWait` is replaced by the post-wait fix, with the still-open points.
- `notes/HANDOFF-2026-11-13-pass-message-timer.md`: section 5.2 is resolved by this note (see below).
- `notes/README.md`: newest handoff pointer.
- This note.
