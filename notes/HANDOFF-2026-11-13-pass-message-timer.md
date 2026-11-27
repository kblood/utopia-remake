# Utopia handoff: pass-time line timer (2026-11-13)

Model and routing: Claude Haiku 5.5, inline research and implementation. No orchestration tool was called and no subscription usage was checked. No emulator was run, nothing under `original/` was written, and nothing was committed or pushed. The dirty worktree was preserved (many files were already modified before this slice).

Scope: whether pass-time line messages (`Sim.messages`, posted inside the simulation pass) are ticked before their first visible frame, compared with the traced `$551A`/`$552C` order. Only that path was changed.

## 1. Question and answer

Before the fix, yes. A pass-time line was spliced into `Messages` and ticked once in the same update that drew it, so its first drawn frame read 199 (poll-posted lines read 200).

Code order in `MapScene.update` (src/game/map.ts) before the fix:

1. `sim.pass()` (completed pass only, via `loopPass`), which posts into `sim.messages`.
2. `for (index of sim.messages.splice(0)) messages.push(index)`: a line gets `lineLeft = 200`.
3. `messages.update()`: decrements the line timer to 199.
4. `drawPass()` / `messages.draw()`: draws the line with 199.

Original order (VERIFIED from the Disk.1 trace in `notes/formats/runtime-checkpoints.md` line 16 and `game-text.md` section 4): pass body `$333A` (where the line message calls `$551A`, which draws at once and sets `$156AC` = 200) → `$6540` draw → VBL wait (the `$2CAA` decrement runs here, after the draw) → `$99C4` → `$50B2`. So the original's first drawn frame reads 200.

Measured (scratch probe outside the repo, `/tmp/haiku-msg/probe2.mjs`, real `MapScene` on the user's Disk.1/Disk.2):

| Path | Timer after posting update | Drawn frames |
|---|---|---|
| pass-time line, before fix | 199 | 199 |
| poll-style line (`Messages.push` after the draw) | 200 | 200 |
| pass-time line, after fix | 200 | 200 (`test/map-loop.mjs` section 7e) |

## 2. Change

- `src/game/messages.ts`: `push()` returns `true` when the message became the line (log messages, empty text: `false`). The `holdLineTick()` doc now names both held cases.
- `src/game/map.ts`, `MapScene.update`: the splice records whether any pass-time message set the line. If so, `holdLineTick()` runs before `messages.update()`, so that update skips its one tick. Log messages do not set the hold, and the log idle timer is unaffected.

Nothing else changed: poll-side pushes (controls, builder, marker and key paths) do not go through the splice, the modal-exit hold is unchanged, and the pass, RNG, date and loop state are untouched.

## 3. Tests

`test/map-loop.mjs` section 7e (new, real Disk.1/Disk.2):
- A pass-time line: the pass runs, the timer reads 200 in its posting update, and 200 updates are drawn (the posting update, then 199).
- A pass-time log message (index 82) during a showing line: the line timer equals a twin that posts nothing; the message goes to the log panel only.
- A pass-time line over an active line: the new line reads 200 in its posting update.

Mutation check (compiled `dist/game/map.js` only, source untouched, rebuilt and restored): removing the hold makes exactly the three line checks fail (timer 199, 199 drawn frames). The log check still passes.

## 4. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/message-panel.mjs` | exit 0 |
| `node test/map-loop.mjs` | exit 0, no FAIL (262 ok) |
| `npm test` (full chain) | exit 0, 4,501 `ok`, no `FAIL` (log at `/tmp/haiku-msg/npm-test.log`, scratch) |

Optional capture comparators were skipped (external Copperline captures not set), as before.

## 5. Still uncertain

1. **The exact `$551A` call site of each pass-time message.** Only the order "pass body before the draw, VBL decrement after the draw" is traced. The sim's pass-time messages are modelled as posted inside `$333A`'s chain; I did not sweep Disk.1 call sites for each string index.
2. **Messages posted by `Sim.runAfterVblWait()`. RESOLVED 2026-11-13, see `HANDOFF-2026-11-13-post-wait-message.md`.** These were spliced on the next update and drawn at the next completed pass (4 updates late, timer already 197). They are now spliced and presented in their posting update, with 200 frames from there.
3. **One remake update is one VBL.** The line timer is ticked per video update, as `game-text.md` section 4 says. The count of 200 frames assumes that; the original's pass length (4 VBLs in the remake, not measured) is not involved.
4. **No original capture** exists for this timing. Every claim above is static order plus remake measurement.

## 6. Notes changed

- `notes/formats/game-text.md` section 4: the "timer residual still open" sentence is replaced by the fixed status and its uncertainty.
- `notes/README.md`: newest handoff pointer.
- This note.
