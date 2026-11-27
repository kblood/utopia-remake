# Utopia handoff: two announcements in a row over a near-expiry line (2026-11-13)

Model and routing: Claude Haiku 5.5, run inline as the test sub-agent. No delegate was started, so `claudeAgent` routing was not confirmed here; no subscription usage was checked and no timer was scheduled. Synthetic `Game.update` probe only, reading the user's own `original/utopia-whdload/Disk.1` and `Disk.2`; no emulator was run and nothing under `original/` was written. Nothing was committed or pushed.

Scope: follow-up to `HANDOFF-2026-11-13-announce-line-frame.md`, section 4 (the chained-announcement path was named there but not tested). Question: when a second `$E770` announcement follows the first immediately while the message line is near expiry, (a) is the backdrop of both dialogs the current map frame, (b) does the line timer stay frozen across both dialogs, (c) does no pass advance, and (d) does closing the second restore the exact frame shown before the first.

## 1. Chain order (confirmed in `src/game/game.ts` before asserting)

- `updateMap` runs `map.update()`, then drains `map.sim.events` FIFO into `this.announcements`, then calls `startAnnouncement()` when no dialog is open. `startAnnouncement` takes the first id and builds `AnnounceScene` over `this.map!.screen`.
- `Game.update` does not call `updateMap` in stage `"announce"`. A second event therefore cannot be drained while the first dialog is open. It can only be queued in the same drain.
- Closing a dialog (`case "announce"`, `update` returns true) sets `announce = null`, and if `announcements` is not empty it calls `startAnnouncement()` in the same update. It calls `returnToMap()` only when the queue is empty. So the second dialog opens in the update that closes the first, with no stage `"map"` and no map update in between.
- Neither the backdrop of the second dialog nor the close writes to `map.screen`. Both dialogs copy the same unchanged map frame.

## 2. Measured invariants (`test/announce-chain-frame.mjs`, new, 37 checks)

Opened with the line at 3 frames left (after a completed pass), with two `announce` events (ids 1, 2) in one map update:

| Invariant | Measured |
|---|---|
| The drain update opens dialog 1 (id 1); the line ticks 3 -> 2 | yes |
| Dialog 1 backdrop outside the windows equals the map frame | 0 pixels differ |
| Dialog 1: line glyph rows left of the portrait keep their pixels | equal |
| 20 idle updates with dialog 1 open: timer, pass count, map frame, displayed frame | timer 2, no pass, unchanged |
| Press on the exit icon does not close; release closes and the same update opens dialog 2 (id 2) | stage `announce`, id 2 |
| The chain update: timer and pass count | unchanged (2, no pass) |
| Dialog 2 backdrop outside the windows equals the current map frame | 0 pixels differ |
| Dialog 2: line glyph rows left of the portrait keep their pixels | equal |
| 20 idle updates with dialog 2 open: timer across both dialogs, pass count, map frame | timer 2, no pass, unchanged |
| Close dialog 2 (exit icon): stage `map`, no third dialog | yes |
| Close frame equals the map frame under the dialogs, and equals the frame before dialog 1 (exact, whole frame) | 0 of 64,000 pixels differ, both |
| Close frame keeps the line glyph rows; close update's timer | kept; unchanged (2) |
| Remaining lifetime after the chain | expires after exactly 2 more map updates |
| Expiry frame, rows 159..165 full width | equal the picture |

So, for this chain: both backdrops are the current map frame, the line timer and the pass count are frozen across both dialogs and across the chain update, and the close frame is the pre-dialog frame exactly.

## 3. Mutation check (dist only, test sub-agent)

Method: the compiled `dist/game/game.js` was replaced with a copy in which closing a dialog first writes that dialog's screen into `map.screen` (`this.map.screen.pixels.set(this.announce.screen.pixels)` before the chain). The mutation was applied with an exact anchor (count 1) in a script outside the repository, then the original `dist` file was restored and `npm run build` was run again.

| Mutant | Exit | FAIL checks |
|---|---|---|
| Chain write-back of dialog 1's pixels into the map frame | 1 | `the map frame is unchanged by closing the first dialog`; `second dialog open: the map frame is unchanged`; `the close frame equals the map frame shown under the dialogs (exact, whole frame)  differs=26602`; `the close frame equals the frame before the first dialog (exact, whole frame)  differs=26602` |

Restored `dist` then passed 37 `ok`. A first attempt at the mutant script had a broken anchor (a sed edit left a literal newline); that run applied nothing and the restored build passed, so it is not counted as a result.

## 4. Changes

- `test/announce-chain-frame.mjs` (new): 37 checks, real `Game.update` clicks; skipped when the original files are missing.
- `package.json`: `npm test` chain runs `node test/announce-chain-frame.mjs` after `node test/announce-line-frame.mjs`.
- `notes/README.md`: newest-handoff pointer.
- No source change under `src/`: no defect was found.

## 5. Open points (not observed in the original)

Same as `HANDOFF-2026-11-13-announce-line-frame.md`, section 4: the original's line timer during `$E770` (the remake freezes it), whether the original's backdrop includes the line's glyph rows, and the first-update pointer rule. This test does not add new original-game claims. Whether the original chains two `$E770` calls with no intervening frame is not observed here; the remake's chain is what is tested.

## 6. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (before and after the mutant, and after restoring) |
| `node test/announce-chain-frame.mjs` | exit 0, 37 `ok`, no `FAIL` |
| `node test/announce-line-frame.mjs` | exit 0, announce line frame tests passed |
| `node test/announce.mjs` | exit 0, all announce checks passed |
| `npm test` (full chain) | exit 0, 4,615 `ok`, no `FAIL`; includes `announce chain frame tests passed` |

Repository state: nothing committed or pushed. The dirty worktree was preserved. `original/` was only read.
