# Utopia handoff: first map pass after a disk-menu load, scenario and tutorial (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started.

Scope: does a load from the disk menu run a simulation pass before or after EXIT, compared with a fresh scenario and the tutorial? Static Disk.1 disassembly only (`tools/game_img.py` helpers, read-only), the remake's `Game`, `MapScene`, `MainLoop` and `Sim` code, and the tests. No emulator run. Nothing under `original/` was written. Nothing was committed or pushed. The dirty worktree was preserved.

## 1. Static answer (VERIFIED from the raw Disk.1 bytes, no runtime capture)

**Before EXIT: no pass, in any of the three.**

- The disk-menu loop `$7EF6` dispatches on the icon in `d2` (`$7FE4`-`$8028`). Its pick routine is `$87DC` (`$7FDC`, `bsr.w $87dc`, then `bra.w $7ef6`). `$87DC` reads the mode byte `$938D` and branches: 4 to the track list `$8A42`, 1 to the save `$8918`, otherwise `$8820`: `cmpi.b #2,d7; bne.w $88f0`, so mode 2 falls through into the load `$8828` and mode 3 goes to the scenario `$88F0`.
- Load `$8828`: prints `$144`, `$2F5E`, the file reads `$7D96`, `$84F4`, the state restore `$8A5A`/`$7C80`/`$7D0E`, prints `$145` (`$88CA`), then `move.b #1,d0; bsr.w $866e` (`$88D4`-`$88D8`). It ends with `bra.w $82b8` (`$88EA`), whose `rts` returns into the loop through `$7FE0 bra.w $7ef6`.
- `$866E` with d0 = 1 takes `beq.w $875c` (`$8670`), skipping the default block; d0 = 2 (scenario `$88F0`, tutorial `$80C8`) runs the defaults and falls through `$8754` into the same reset `$875C`. Both end with `$156A8 = $94` (bit 7 queues the day), `$156AA = 1` (bit 3 clear) and the rest of the `$875C` block.
- Reachability (linear recursive descent from `$7EF6` over the image, 2,334 instructions, 85 call targets): neither `$99C4` (the sim pass) nor `$157BC` (the map loop top) nor `$11476` (the apparition) nor `$15EF0` is reached. Control: the same walker reaches `$99C4` from `$157AE` (the boot tail), so the negative result is not a walker failure. The load-only walk (`$8828`, 1,191 instructions) and the scenario-only walk (`$88F0`, 1,335) also reach none of them.
- The menu's own VBL wait is `$7F32`-`$7F42` (`bclr.b #0,$156a8` then `beq.b $7f3a`), so the menu keeps pacing itself by VBL but runs no map work.

**After EXIT: the same return for load, scenario and tutorial.**

- `$802C` (icon 5, `beq.b $802c` at `$7FE8`): `btst #3,$156AA` (refused in game over), the eclipse branch, `$2F5E`, `$2E36`, `$4E08`, `$2E26`, `$5A16` (screen work), the exit tail `$80A6`/`$80AE`/`$80B6`/`$80C0`, then `rts` at `$80C6`.
- The tutorial reaches the same `rts`: `$800C beq.w $80c8` (a branch, not a call), `$80C8` ... `$812E bra.w $802c`. The notes' "tutorial exits by itself" holds.
- Where the `rts` returns depends on the entry frame, not on load versus scenario: `$7E52` is entered by `jsr` from `$157AE` (the boot and game-over tail: `$157B4 bsr $15EF0`, `$157B8 bsr $11476`, then `$157BC`) and from `$15AE6` (the in-game disk icon: `$15AEC bsr $15EF0`, then `rts` into the map loop's caller, which continues its iteration).
- `$157BC` is the map-loop top. One iteration is: body `$333A`...`$5D30`, `$2E10`, `$2F5E`, then `$15846 bclr.b #0,$156A8 / beq` (the VBL wait), then `$15850`, then `jsr $99C4` at `$15888`, then `$50B2` (the poll), then the dispatch, then `bra.w $157bc` at `$158C6`. `$99C4` is called only from `$15888` (whole-image scan).

**Conclusion (static):** load, scenario and tutorial share one post-EXIT route in the original. Nothing load-specific runs a pass. The first `$99C4` after EXIT is the next iteration's, after its body and the VBL wait at `$15846`. For the boot and game-over tails that iteration is entered from `$157BC` after `$11476`; for the in-game icon it is entered by the loop's continuation. The VBL bit is cleared by the menu's own wait just before the exit, so the wait at `$15846` is at most one VBL after the body. Whether that adds a frame cannot be settled statically (see section 4).

## 2. Remake before this change

- A fresh scenario or tutorial is built with `freshScenario`, so `MapScene` calls `loop.resumeWithImmediatePass()` at construction (`src/game/map.ts`, the `freshScenario` branch of the constructor). Its EXIT update then runs the pass (`Game.update`, the immediate-pass block after the disk-menu handling).
- A load is built with `freshStart` false (`Game.loadFromSlot` -> `createScene(index, false)`) and restored from the save. A save stores no pending pass (`save-session.ts` writes `immediatePass` from the loop, which is false after the normal passes), so EXIT ran no pass and the first pass followed the 4-update cadence. The held-load test in `test/save.mjs` recorded this as "EXIT shows the default picture until the first pass".
- So the same original exit route gave the remake two behaviours: an immediate pass for a fresh scene, none for a loaded one.

## 3. Change (narrow)

`src/game/game.ts`, `Game.enterHeldScene`: when the held scene is not a Disk.4 continuation, call `held.map.loop.resumeWithImmediatePass()` before `enterScene`. A scenario already has the flag from its build, so this changes only loads. A Disk.4 continuation is left alone because its disk-menu exit has not been traced.

Discrimination: before the change, a held load's EXIT left `loop.passes` unchanged (`passes` = saved count) and the printed session equal to the saved text. After it, one pass runs in the EXIT update.

## 4. Tests

`test/save.mjs`:

- Two existing checks asserted `gprint(game) === savedText` after EXIT on a held load (`menu load: EXIT enters the loaded save`, `held: EXIT then enters the held save`). Those encoded "no pass on EXIT". They now assert `loop.passes === restored + 1`, with the restored count read from the held scene before the exit clicks. Their intent (the entered scene is the saved one, nothing held, scenario 2) is kept.
- New block "held load pass": a held load arms no pass; EXIT arms `immediatePassPending`; the next update runs exactly one pass and clears the flag.

Mutation check: the new block fails on the pre-change code by construction (the flag stays false after EXIT). I did not rebuild the old code to run it.

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/save.mjs` | exit 0, 360 ok, 0 FAIL (after the two assertion updates) |
| `npm test` (full chain) | exit 0, 4,313 `ok`, 0 `FAIL`. Log at `/tmp/npm-test-load-pass.log` (not committed) |

## 6. Gaps and residual risks

- **Timing is unresolved.** The original's pass after EXIT waits on the VBL bit at `$15846`, and the menu clears that bit just before exit, so the first pass may lag the body by up to one VBL. The remake's immediate pass runs the pass in the EXIT update and does not model that frame. Resolving it needs an emulator run (breakpoints at `$15846` and `$15888` after the EXIT click, for a load and a scenario). No emulator was run.
- **The in-game map-icon exit is not immediate in the remake, and the original's is not a `$157BC` entry.** The static route for that exit is `$15AEC` into the loop's continuation. The remake treats it as ordinary cadence. That is the same question as above and was not changed here. **Superseded 2026-11-13:** the static route ends in `bra $157BC` (`$158C6`) after the keyboard poll, so the in-game exit now arms the immediate pass too; see `HANDOFF-2026-11-13-icon-exit-pass.md`.
- **Disk.4 continuation.** Its exit path is not traced; it is left as it was.
- **Save fidelity.** The extra pass runs for a load on EXIT, so the state a player sees after EXIT is one pass beyond the saved state, matching the original's route only in the static sense. The save format is unchanged.
- **Mutation check not run against the old code.** Its discrimination rests on the code path and the assertion.

## 7. Notes changed

- `notes/formats/game-proper.md`: a "First pass on EXIT" paragraph in the held-scene section (static, with addresses and the open timing question).
- `notes/HANDOFF-2026-11-13-load-first-pass.md`: this note.
- `notes/README.md`: points to this note as the latest handoff.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
