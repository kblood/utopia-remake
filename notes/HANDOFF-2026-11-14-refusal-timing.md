# Utopia handoff: refusal timing of direct messages (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No emulator or original writes; `original/` was only read. Nothing committed or pushed. The dirty worktree was preserved.

Question: three refusal messages go through `MapScene.say` / `Builder.say` directly, not through `sim.messages`. How many drawn frames and timer ticks should each get, and are they drawn in the right update?

## 1. Routine order (STATIC, Disk.1 and the remake)

| Message | Original routine context | Original frame count | Remake before | Remake after |
|---|---|---|---|---|
| Launchpad refusal `$E9` / `$EA` (`$771E`) | enemy ship mode-4 step inside the `$333A` pass body | 200, drawn by the pass, first tick next update | pushed in the pass's update, ticked once there (199) | `say` holds the tick in `loopPass()` (`inPassBody`) |
| Bombed-cell demolition refusal `$58` (`$7372` from `$12332`) | arson `$10D00`/`$10D60` inside `$99C4`, after the VBL wait | 200, drawn at once | tick right, but the band not presented in the posting update; line first shown at the next completed pass (up to 3 updates late) | `say` marks a post made in `runAfterVblWait` (`inPostWait`); the completed branch repaints the band in that update |
| F1-F6 refusal `$B2` (`$15B4A` -> `$15B3E`) | press poll, after the pass draw | 200, drawn in the press frame | `map.say` before `updateMap`: ticked in the handling update (199), not drawn until the next completed pass | `game.ts` calls `MapScene.sayFromKey`: hold, then the line is drawn in the handling update |

The arson event is in `$99C4` (`Sim.run` via `runAfterVblWait`): `eventScheduler` is called from `run()`, and `Builder.weekly` does not call `say`. The pad refusal is in the pass body: `ObjectLayer.update` calls `EnemySystem.pass` (`src/game/objects.ts:245`).

## 2. Change

- `src/game/map.ts`
  - `say(index)` returns `PostedAs`. Routing: while `polling`, unchanged; while `keySay`, a line sets `holdLineTick()` and `keyLinePending`; in `inPassBody`, a line sets `holdLineTick()`; in `inPostWait`, any non-empty post sets `postWaitChanged`.
  - `loopPass()` wraps the old body in `inPassBody`.
  - `update()`: the `runAfterVblWait` call is wrapped in `inPostWait`; the completed branch presents the band when `spliced || postWaitChanged`. A `keyLinePending` (consumed at the start of the update) presents the line in a non-completed, non-modal update.
  - `sayFromKey(index)`: with the menu open it is a plain `say`; otherwise it sets `keySay` around `say`. (A first version that read `say`'s return value failed the `screens.mjs` test, because that test wraps `map.say` and the wrapper returns nothing.)
- `src/game/game.ts`: the F1-F6 refusal calls `map.sayFromKey(refusal)`.
- No timer, pass, RNG, date or loop-state change beyond the one-shot hold, which is consumed by the same update's `messages.update()`.

## 3. Tests

- `test/map-loop.mjs`, new section 7l (13 checks), each run beside a twin that posts nothing, counting updates whose band (rows 160..199) differs:
  - pass-body line (`$E9` through `enemies.pass`): timer 200 and drawn in the posting update; drawn for exactly 200 updates.
  - pass-body log entry over an active line: the line timer matches the twin (no hold).
  - pass-body line over an active line: restarts at 200 and is drawn in the posting update.
  - post-wait refusal (a poked tile with no building, `sim.run` wrapped to call `bomb` and then the real `run`): drawn in the posting update; drawn for exactly 200 updates.
  - F-key refusal (`sayFromKey` on a non-boundary update): timer 200 and drawn there; drawn for exactly 200 updates.
  - F-key log entry over an active line: the line timer matches the twin.
- `test/screens.mjs`: the existing F1 refusal now also checks the timer (200 in the handling update, 199 on the next update).

Mutants (compiled `dist` only, restored afterwards; the unmutated build passes):

| Mutant | Failing checks |
|---|---|
| no pass-body hold | 3 (posting timer, drawn 200, over-active restart) |
| no post-wait presentation | 2 (drawn in posting update, drawn 200) |
| no `sayFromKey` hold / no key-line presentation | 2 each (timer and drawn 200) |
| `game.ts` back to `map.say(refusal)` | 2 (screens F1 timer checks) |

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (after each source change) |
| `node test/map-loop.mjs` | exit 0, 366 `ok`, no `FAIL` |
| `node test/screens.mjs` | exit 0, 91 `ok`, no `FAIL` |
| `node test/message-panel.mjs` | exit 0, 15 `ok`, no `FAIL` |
| `node test/checkpoint.mjs` | exit 0, 66 `ok`, no `FAIL` |
| `node test/announce-line-frame.mjs`, `announce-chain-frame.mjs`, `offer-exit-frame.mjs`, `map-background.mjs`, `game-over.mjs` | exit 0, no `FAIL` |
| `npm test` (full chain) | exit 0, 4,674 `ok`, no `FAIL` (was 4,659 before this slice) |

## 5. Open points

1. The original's exact call order of the pad and arson paths against the draw is static only. No emulator run.
2. The `$58` bombed-cell refusal needs a record origin whose cell is not a building tile. Whether that happens in play was not traced. The test pokes a tile.
3. (Resolved 2026-11-14, see `HANDOFF-2026-11-14-fkey-poll.md`: F-keys are taken by the completed pass poll; `sayFromKey` and the arrival-time handling described above no longer exist.) F-key timing residual (historical): the remake handled F-keys on arrival (`game.ts`), the original at the next pass poll. The frame count from the handling update is the same, but the start can be up to 3 updates early. Not changed (the same residual as the poll-refusal handoff).
4. The launch `$12B` text from the missile window is still not presented in the window's frame (window-stage, not traced).
5. The `sim.messages` window-stage messages (trade, staff, ship and missile windows) remain spliced on the first map update after the window closes (`notes/formats/game-text.md`, section 4).

## 6. Notes changed

- `notes/formats/game-text.md`, section 4: the old "Residual timing" paragraph now points to the correction; new paragraph "Refusal timing (2026-11-14)" before "Other full-screen exits".
- `notes/README.md`: newest handoff pointer.
- This note.
