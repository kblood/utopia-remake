# Utopia handoff: poll refusals and building-select texts on the message line (2026-11-13)

Model and routing: Claude Haiku 5.5, run inline as the research and implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No emulator was run and nothing under `original/` was written (read-only disassembly through `tools/game_img.py`, scratch files under the user's temp folder, outside the repository). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: the open items of `HANDOFF-2026-11-13-key-pin-line.md` (section 5, item 3) and `HANDOFF-2026-11-13-message-line-timing.md` (section 5, item 1): which input-poll actions post into `Sim.messages`, which poll messages the original draws at once, and whether accepted placement and demolition post a line at all.

## 1. Answers from the traces (STATIC, Disk.1)

Draw timing. The main loop (`$157BC`) runs the pass body `$333A`, then `$16012`, `$6936`, the draw `$6540`, `$3310`, the date work `$4D48`/`$4D1C`/`$4D96`, `$5D30`, the VBL wait (`$15846` loop), `$99C4`, and then the poll `$50B2`. On a press edge `$158A0` calls the press handler `$158CA`, then `$15B4A` runs the keys, then the loop restarts. So a poll message is posted after this iteration's draw, and `$551A` draws it into both bitmaps at that moment (game-text.md section 4). Its 200 frames start there, with the first decrement at the next VBL.

Which poll actions post a line. `$158CA` dispatches on `$14591` (`$158F6`): mode 2 calls `$6BF4` (placement), mode 3 calls `$7372` (demolition), mode 1 calls `$311E` (marker pin, when `$144B3` is set) or `$7140` (building select). The remake's `Controls.update` press path (`controls.ts`, cell dispatch) and `MapScene.poll` run at the same point of the iteration. The lines:

| Path | Original `$551A` calls (Disk.1) | Remake before | Remake now |
|---|---|---|---|
| Placement refusals `$6BF4`: `$2` out of range (`$6C48`), `$127` / `$1` near-base and connection tests (`$6C16`, `$6C2C`), `$3` no free slot (`$6C66`), `$5E` / `$11B` power off / strike, `$5D` no colonists, `$25` money (`$6CC6`) | yes, each | next pass (only `$25` was same-frame) | same frame |
| Accepted placement `$6BF4` success (`$6CD0`-`$6D0E`, calls `$6FC4` only) | none | nothing | nothing (verified) |
| Demolition refusals `$7372`: `$58` (`$73AE`), `$123` vent (`$744E`) | yes, each | next pass | same frame |
| Demolition success: real building (`$74D6`-`$74F4`: `$75A8`, `$710A`, `$6FC4`), cleared ground (`$6A8C`), site cancel `$74FE` | none | nothing | nothing (verified) |
| Building select `$7140`: scaffold `$7D` and mine `$89` (`$72AC`-`$72A0`), power `$12E`, tank `$10A`, the generic name (`+$10` word); command centre `$B3` and launch `$12B` go through `$5A8C` (log) | yes (line) / log | next pass | line in the press frame; log entries unchanged (see section 4) |

Which poll actions call `Sim` methods that enqueue messages. None, in the current remake. The poll's message sources are `Messages.push` through `MapScene.say` (the Builder, Controls, and building-screen callbacks all use it). `Sim.msg` is reached only from the pass, the post-wait `$99C4`, and window-stage actions (trade and staff through `ctx.sim`, the ship and missile windows). Checked by grep over `src/game` (`ctx.sim`, `sim.msg`, `resolveOffer`, the `Game` callbacks). Window-stage `Sim` messages are spliced on the first map update after the window closes; the original's draw for them was not traced.

## 2. Change

- `src/game/map.ts`:
  - `say(index)`: `Messages.push` as before; when the call is made during `poll()` and the push made a line (`push` returns true), it calls `controls.markMessageLineChanged()`. Log entries and calls outside the poll do not set the flag.
  - The Builder and Controls message callbacks, and the building-screen context (`game.ts` through `map.say`), now reach `say`. The Builder's pass-time calls (bombed demolition, launchpad) run outside the poll and are not flagged.
  - `update()`: the completed-pass poll runs with `polling = true` (try/finally). `presentMessageLine()` then runs as before, after the poll.
  - Comments that named only the marker and money cases now name the general rule.
- Nothing changed in `Messages`, the timer, the pass order, RNG, or the Builder and Controls logic. The modal-exit and pass-time holds are unchanged.

## 3. Tests

`test/map-loop.mjs`, new section 7j (twin scenes; probes choose the cell in separate scenes so each case scene starts clean):

- Placement refused, blocked (`$2`, scroll 0, cell (0,0)): the line is in the press frame; only the band and the panel box differ from the twin; timer 200 (twin 0); build mode and selection stay; money unchanged; no `Sim` message; no pass advanced; the next pass keeps the band.
- Accepted placement (a probe cell that spends money): no line; the band equals the frame before the press and the twin; the selection stays; no `Sim` message.
- Demolition refused (a probe cell that refuses): the line in the press frame; timer 200; demolish mode stays; no record removed; no `Sim` message; the next pass keeps the band.
- Accepted demolition (a probe cell whose press removes a record): record count falls by one; no line; the band equals the twin; no `Sim` message.
- Building select, scaffold (`$7D`) and land mine (`$89`): a poked cell with no record; the line in the press frame; no window opens (`createBuildingScreen` returns null); timer 200; select mode stays; the next pass keeps the band.
- A line said outside the poll (`MapScene.say` in a quiet scene): no presentation flag (the pass draws it).

Mutation check (compiled `dist/game/map.js` only, source untouched, rebuilt and restored afterwards, runner outside the repository):

| Mutant | Exit | FAIL checks |
|---|---|---|
| M1: `say` never sets the presentation flag (the flag statement removed from compiled `say`) | 1 | `placement refused (blocked): the line is in the press frame`, `... the next pass shows the same message band`, `demolition refused: the line is in the press frame`, `... the next pass ...`, `scaffold: the line is in the press frame ...`, `scaffold: the next pass ...`, `land mine: the line is in the press frame ...`, `land mine: the next pass ...` (8 checks) |
| M2: `say` sets the flag for every line (also outside the poll) | 1 | `a line said outside the poll sets no presentation flag` (1 check) |

The accepted-placement and accepted-demolition "silent" checks pass under both mutants, as they should: they test that no line is posted, and neither mutant posts one. The restored build passes 344 checks in `map-loop.mjs` (the previous count was 309; the 35 new ones are section 7j).

## 4. Open points and residuals (not changed)

1. **Log entries from the poll.** `$5A8C` paths (`$B3` command centre, `$12B` launch) and the log of any poll message are not presented in the press frame. The log panel is not touched by `presentMessageLine`. The original draws the log at once (`$5A8C`); this is the same gap as in section 5 of the key-pin note, not closed here.
2. **Pass-time direct pushes (code reading, not measured).** `Builder.say` during the pass (the bombed-cell demolition refusal `$58` via `demolishAt`, the launchpad refusals `$E9`/`$EA` via `buildPad`) pushes straight into `Messages`, before `messages.update()` of its own update. The line is therefore ticked once in that update: 199 drawn frames, against 200 for the original's `$551A` before the VBL decrement (the same reasoning as `HANDOFF-2026-11-13-pass-message-timer.md`, which fixed only `Sim.messages`).
3. **F1-F6 report refusal (code reading, not measured).** `game.ts` calls `map.say` before `updateMap` in the same update, so its line is ticked once in that update, as in item 2. The original runs `$15B4A` after the poll; the remake's key order also differs (see 4).
4. **Key order inside the poll.** The original runs the press `$158CA` before the keys `$15B4A` in one iteration. `MapScene.poll` runs keys first, then `controls.update`. The difference matters only when a key and a press land in the same poll (the last line shown would differ). Not changed.
5. **Building-select branch placement.** The `$12E` and `$10A` calls, and the generic name, were found by static reachability from `$7140`; the branch each sits in was not traced further. The remake's branches for them are in `createBuildingScreen`, tested in `test/buildings.mjs`.
6. **No original capture.** Every claim above is static (disassembly and the remake's measurements); no emulator comparison was made.

## 5. Notes changed

- `notes/formats/game-text.md`, section 4: the "Remake, same-frame line" paragraph now lists the refusal and building-select paths, records the accepted-placement and accepted-demolition disassembly, and replaces the "still open" sentence (no poll path reaches `Sim.msg`; residual timing items).
- `notes/formats/map-rendering.md`, section 9 bullet: the same-frame sentence now covers the refusals and building-select texts, and the silent accepted paths.
- `notes/README.md`: this note is the newest handoff; the previous pointer is kept.
- This note.

## 6. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 344 `ok`, no `FAIL` (section 7j: 35 checks) |
| mutants M1 and M2 (`node test/map-loop.mjs` on compiled `dist` only) | both exit 1, the FAIL checks in section 3; restored build exit 0 |
| `node test/build.mjs`, `test/buildings.mjs`, `test/build-menu.mjs`, `test/message-panel.mjs`, `test/command-buttons.mjs`, `test/checkpoint.mjs`, `test/construction.mjs`, `test/game-over.mjs`, `test/offer-exit-frame.mjs`, `test/area-blast.mjs` | all exit 0, no `FAIL` |
| `node test/announce.mjs`, `test/announce-line-frame.mjs`, `test/announce-chain-frame.mjs` | all exit 0, no `FAIL` (`announce-chain-frame` prints 31 `ok` lines now; `HANDOFF-2026-11-13-announce-chain-frame.md` recorded 37; the cause of the difference was not investigated; the file is unchanged in git and the run exits 0 with no `FAIL`) |
| `npm test` (full chain) | exit 0, 4,650 `ok`, no `FAIL` lines (log in the user's temp folder, scratch) |

Repository state: nothing committed or pushed. The dirty worktree was preserved. `original/` was only read. The mutant runner and the disassembly listings were written under the user's temp folder, not in the repository.
