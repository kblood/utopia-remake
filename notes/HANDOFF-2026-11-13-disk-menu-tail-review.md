# Utopia handoff: review of the disk-menu tail flow (`diskMenuFromTail`), 2026-11-13

Model and routing: Claude Haiku 5.5, inline, as the review sub-agent. The brief asked for `claudeAgent`; no orchestration tool was called in this run, so that routing is not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started.

Scope: the new `Game.diskMenuFromTail` flow (`returnToMap`, `openMapDiskMenu`, `runDiskMenuExit`, `enterScene`, `acceptScene`, `diskIcon`, the menu back paths) for states other than the apparition itself: queued day, `hasEnteredGame`, scene replacement timing, save/load and the tutorial. Sources: `notes/HANDOFF-2026-11-13-restart-apparition.md`, `notes/formats/game-proper.md`, `notes/formats/sim-port.md`, `src/game/game.ts`, `src/game/sim.ts`, `src/game/sim-aliens.ts`, `src/game/map.ts`, `src/game/sim-math.ts`, `test/game-over.mjs`. No emulator was run. Nothing under `original/` was written. Nothing was committed or pushed. The dirty worktree was preserved. A throwaway probe lived in `/tmp` and is not part of the repository.

## 1. Finding (trace-backed mismatch, fixed)

**Mismatch.** The restart apparition is a fresh draw in the remake only in name. Every `Sim` is built with `createRng(0x55746f70)` (`sim.ts`, default) and production passes no `freshStartInputs` (`main.ts`). So each new scene starts the same stream, and `leaveBootMenu()` draws its first value.

- **Probe before the fix** (scenario 0, three game-over restarts through the tutorial): the apparition was cell `7,65` every time, and the generator state after each exit was identical (`fae3ae10`).
- **Trace that the original does not reseed.** The seed `$2EA0` is one cell. Only `$2DCC` writes it (sim-port.md, "Seed initialisation"). The only initialiser, `$2DA0`, has no branch or call to it in the recursive descent from `$156B6` (13,550 instructions, 306 call targets). So the original's seed continues across a restart. This is a static finding, not a runtime capture.

**Correction (one change, `src/game/game.ts`).** `Game.createScene(index, freshStart)` carries the ended game's generator into a new scene only when all three hold: `freshStart` is true (scenario pick or tutorial, not a load), `diskMenuFromTail` is set (the tail's menu is open), and the current map has a default-type generator (`rngState` not null). The current map is still the game-over map during the held period, and its frozen sim does not draw (probe: the state is unchanged over the tail). A custom generator is not carried.

**Probe after the fix:** `7,65 | 70,12 | 44,2` (three restarts, each a different draw of one continuing stream).

**Scope held back:** a first game's boot exit, a mid-game scenario pick and a Disk.4 continuation still use the default seed. The original's continuity would also cover those, but the brief asked for one minimal correction in the tail path. They are listed as residual risks.

## 2. Path table (`Game`, current code after the fix)

`bootMenuOpen`: the boot session (before the first entry). `diskMenuFromTail`: the open disk menu came from `$157AE` (game-over tail). `held`: `heldScene` (built, not entered). "Apparition" is `Sim.leaveBootMenu()` at the moment the scene is entered.

| # | Path | Flags at the menu | Built / entered | Apparition at entry | Notes |
|---|---|---|---|---|---|
| 1 | Boot: scenario, load or Disk.4 pick, then EXIT | `bootMenuOpen` | held until EXIT | once | `enterHeldScene` -> `enterScene` -> `runDiskMenuExit` |
| 2 | Boot: tutorial (icon 6) | `bootMenuOpen` | entered at once | once | `$80C8` ends with `bra $802C` |
| 3 | Boot: EXIT with nothing held | `bootMenuOpen` | refused, remake note | no | `$802C` refuses without a scene |
| 4 | Mid-game map icon, pick or load, then EXIT | `openMapDiskMenu` clears the flag | held until EXIT | no (`$15AEC`) | `closeMenu` -> `returnToMap` |
| 5 | Mid-game map icon, tutorial | flag clear | entered at once | no | `$80C8` exit returns through `$15AEC` |
| 6 | Game over (`returnToMap`), EXIT with nothing held | flag set | refused | no | `$802C` refuses while `$156AA` bit 3 is set |
| 7 | Game over, scenario, load or Disk.4 pick, then EXIT | flag set | held until EXIT | once | new scenes carry the ended generator; loads keep the saved one |
| 8 | Game over, tutorial | flag set | entered at once | once | `startTutorial` -> `enterScene` (scene is new, bit 3 clear) |
| 9 | Game over, SAVE | flag set | - | - | `saveRefusal`: `$18A` with no held scene, exit-first note with one |
| 10 | Game over, load error, "DISK MENU" or "BACK TO DISK MENU" | flag kept | - | - | `openDiskMenu` does not touch the flag |
| 11 | Game over, load error, "BACK TO GAME" (labelled "BACK TO DISK MENU" in a game over) | flag re-armed | - | - | `closeMenu` -> `returnToMap` sets it again, matching the label |
| 12 | Game over, right-click remake menu | flag kept | as 7 | as 7 | SAVE refused by `saveRefusal`; LOAD, SCENARIO and Disk.4 as 7 |
| 13 | Game proper, SAVE success | flag clear | - | - | `closeMenu` -> map, no tail |
| 14 | Announcement or offer in a game over, then the tail | flag set on `returnToMap` | - | - | queued announcements finish first; `announcements` are empty when the tail opens |

`hasEnteredGame` does not exist in `src/` or `test/`. Its role is covered by `bootMenuOpen` (the boot session) and `heldScene` (a built scene waiting for EXIT).

## 3. Other states checked

- **Queued day.** `Sim.initializeScenarioStart()` runs in `MapScene` construction only when `freshScenario` is set (scenario pick and tutorial, built at pick time, not at entry). A held scene therefore has its day queued from the pick, which matches the `$866E` d0=2 order in game-proper.md. Loads use `freshStart` false, so the save's `dayQueued` is kept. Not changed.
- **Scene replacement timing.** `enterScene` calls `runDiskMenuExit(map.sim)` before `this.map = map` and `this.heldScene = null`. The exit therefore sees the game-over map (needed for the carry) and reaches the new scene's `leaveBootMenu` before any map update. `enterScene` clears `announce`, `announcements`, `offer`, `window`, `frozen`, `menu` and `diskMenu` and sets stage `map`. The immediate first pass runs in the same update (`immediatePassPending`), after the apparition draw.
- **Save and load.** A game-over save is refused in all paths. A load from the tail is built with `createScene(index, false)` and `restoreSession`, so `freshStart` is false and the save's generator is kept. Covered by a new test (section 2c below).
- **Tutorial.** `tutorialScene()` uses `createScene(0)` (fresh), so it takes the carry when started from the tail. `enterScene` has no held scene in between.

## 4. Tests (`test/game-over.mjs`)

- Section 2 (existing): restart draws one marker; a map-icon exit draws none.
- Section 2b: the second restart draws the next value of the ended game's stream. Expected cell `70,12`, computed with `createRng` from the ended state. The old default-seed code would draw `7,65` here. This discrimination is inferred from the probe, not from running the old build.
- Section 2c (new): a remake load from the tail is held with the saved generator state (`0x12345678`), not the ended game's. The test first advances the ended game's generator so the two states differ.
- The exact generator state after EXIT is not compared, because the immediate first pass draws too (noted in the test).

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/game-over.mjs` | exit 0, 42 ok, 0 FAIL |
| `npm test` (full chain) | exit 0, 4,127 `ok`, 0 `FAIL`. Log at `/tmp/utopia-review-probe/npm-test.log` (not committed) |

The probe (`/tmp/utopia-review-probe/probe.mjs`) is not part of the repository.

## 6. Notes changed

- `notes/formats/game-proper.md`: the restart bullet adds "Generator continuity".
- `notes/ARCHITECTURE.md`: the fresh-startup paragraph names the carry in `Game.createScene`.
- `notes/HANDOFF-2026-11-13-restart-apparition.md`: a correction at the top; section 1's RNG sentence is superseded.
- `notes/README.md`: points to this note as the latest handoff.

## 7. Residual risks (not fixed here)

- **Only tail-built new games carry the generator.** A first game, a mid-game scenario pick and a Disk.4 continuation still start the default seed. The original's continuous seed would also cover them. Changing that alters every new scene, not only the restart, so it needs its own slice.
- **Disk.4 tail activation is not carried.** The prepared graph keeps its own generator (`prepareDisk4HeadlessEnemies`, "RNG restoration incomplete" in game-proper.md).
- **The marker is still not the original's.** The original draws `$2DCC` over the seed and the CIA TOD byte. The remake's generator is not the original's, so only the event and its range are traced.
- **Restart draws are deterministic.** The same save and the same play give the same marker. The original is not reproducible this way either, so this is not a parity claim.
- **Mutation checks were not run.** The new checks were not run against the pre-fix code or against a build without the `freshStart` guard. Their discrimination rests on the probe and on reading the code.
- **No runtime capture.** The restart order, the seed continuity and the apparition are static, same as before.
