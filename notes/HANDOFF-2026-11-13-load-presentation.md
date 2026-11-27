# Utopia handoff: presentation of a held load and the descriptor view, 2026-11-13

Review sub-agent task: inspect the eclipse parity and slot-error handoffs, `Game` / `MenuScene` / `MapScene` stage transitions and the UI tests,
then fix one reproducible mismatch narrowly.

Routing: run inline as Claude Haiku 5.5. No orchestration tool was called, so the `claudeAgent` routing requested in the brief is not confirmed.
No subscription usage was checked and no timer was scheduled. No emulator was run, no file under `original/` was written, and nothing was
committed or pushed.

Read first: [AGENTS.md](../AGENTS.md), [HANDOFF-2026-11-13-eclipse-parity.md](HANDOFF-2026-11-13-eclipse-parity.md) (sections 2, 8, 9),
[HANDOFF-2026-11-13-slot-error-held.md](HANDOFF-2026-11-13-slot-error-held.md), [formats/remake-save.md](formats/remake-save.md)
("Disk menu behaviour on failure").

## 1. Reviewed and consistent (read, probed or tested; no change)

- **Parity round trips.** Entry (`enterDiskMenu`) and exit (`leaveDiskMenu`) toggle together while bit 6 is set, so the pre-menu frame
  (which `drawModal`/`drawPass` drew with the old parity) matches the parity after an exit. Because the pre-menu bitmap is restored on exit,
  the stale-looking first frame after a map-icon exit is consistent. Not a mismatch.
- **Game-over tail.** `returnToMap` enters once; `closeMenu`'s game-over branch and the slot-error BACK do not toggle again; the exit is
  refused while bit 3 is set. Consistent with `test/eclipse-parity.mjs` Part 1i.
- **Slot-error actions.** `RETRY` success for a save calls `closeMenu` (map, one exit toggle), a load success calls `acceptScene`
  (held, or entered). BACK / DISK MENU labels follow the `closeMenu` test. Consistent with the slot-error handoff.
- **Tile list consumers.** `ObjectLayer`, `Controls` and `BuildMenuRenderer` hold the scene's own `tiles` array, which `syncTileView`
  rewrites in place. No caches keyed on tile objects were found (`grep` of `src/game`).

## 2. The mismatch (reproduced, then fixed)

**Symptom.** A held load (LOAD from the disk menu, then EXIT) showed the scenario's *default* picture for up to `vblPerPass - 1` updates
(the default is 4, `main-loop.ts`) before the loaded picture appeared. The descriptor view could also keep the parity the scene was built
with rather than the restored one.

**Cause.** `Game.createScene` builds the MapScene for a load, which draws `drawInitialFrame()` from the scenario's default state in its
constructor. `loadFromSlot` then calls `restoreSession`, which replaces the state, but nothing redraws. The loop's pending immediate pass
comes from the save (`loop.immediatePass` is stored), so a save taken after passes has none, and `enterScene` gets no pass before the
browser shows `map.screen`. A fresh scenario has an immediate pass (`freshScenario`), so a new game was not affected. Most saves are of
the first kind.

**Probe (outside the repo, `%TEMP%\utopia-probe\load-exit.mjs`, real Disk.1/Disk.2):** a save taken after 9 updates with scroll 30,20,
loaded as a pick, EXIT, then updates:

| Measurement | Before | After |
|---|---|---|
| `drawPass` calls on the first 3 updates after EXIT | 0 | 0 |
| Frame shown on EXIT vs default scenario frame | 0 differing pixels (it *is* the default) | 9,093 |
| Frame shown on EXIT vs the loaded state drawn now | 9,093 | 0 |
| Frame shown on EXIT vs first real pass | 9,093 | 0 |

The first pass of the loaded state gives the same picture as the restored presentation (zero pixels differ), so the fix changes only the
frames before the pass.

## 3. Change

- `src/game/map.ts`: `MapScene.presentRestoredState()` (after `drawInitialFrame`). It refreshes the object gate (`preparePassGate`, as the
  restored-graph constructor does) and calls `drawInitialFrame()`. Presentation only: no tick, pass, RNG draw, or screen-buffer write.
  The descriptor view follows the restored parity through `syncTileView` inside that draw. `preparePassGate` is recomputed at the end of
  every normal pass (`loopPass`), so the early call cannot leave a stale gate that the first pass would not also refresh.
- `src/game/game.ts`, `loadFromSlot`: calls `presentRestoredState()` after a successful `restoreSession`, inside a `try` that returns a
  `resources` error. The scene is not yet active, so a failure leaves the game as it was.
- `test/save.mjs`, end of the Game wiring block: a new block "Held load presentation" with 6 checks: the source session has no pending pass
  and the exchanged parity; the save succeeds; the load holds its scene; EXIT enters it at the saved view; the frame on EXIT is not the default
  picture; the descriptor view shows the restored parity (`tiles[4]` holds tile 51's address). Two of these failed before the change (the
  frame and the view). A "slot list" sub-block (3 checks) pins right click on the load list, which returns to the disk menu with the map and
  held scene kept.
- `notes/formats/remake-save.md`: a paragraph on the held-load presentation; the right-click line corrected (see 4).

No save format, migration, loop state or simulation timing changed. The restored loop keeps its saved `immediatePass`, so the first pass
timing is unchanged.

## 4. Documentation correction

`remake-save.md` said that a right click on a save or load slot list "still just closes to the map". The code (`game.ts` `case "save"` and
`case "load"`) returns to the disk menu, which is what `closeMenu`'s comment and the remake submenu pattern (`boot-menu.mjs`) expect. The note
was wrong, not the code. The note now says so, and `test/save.mjs` pins the behaviour.

## 5. Verification

- `npm run build` (`tsc`): exit 0.
- `node test/eclipse-parity.mjs`: exit 0, "all eclipse parity checks passed".
- `node test/save.mjs`: exit 0, 356 `ok` lines, 0 FAIL, "all save checks passed" (347 before this change; +9 checks).
  Before the map fix, the held-load frame and view checks failed (2 FAIL), which confirms they detect the mismatch.
- `npm test`: exit 0, 4,309 `ok` lines, 0 FAIL. The optional external captures (`UTOPIA_*_CAPTURE`) were skipped as not set.

## 6. Not verified

- The original's first frame after a load. The remake's immediate-pass rule (`freshScenario` only) comes from the traced `$157BC`
  behaviour for new scenarios and tutorials, and was not checked against a run for loads. The fix presents the restored state without
  changing the timing of the first pass, so it does not decide this question.
- Whether a load exit should also consume an immediate pass, as a scenario pick does (`Game.update`, the comment on
  `immediatePassPending`). That is an open question for the owner; it was not changed.
- The eclipse view after a load of a hand-edited save with parity 1. A UI save stores 0, and the test sets 1 by hand to check that the view
  follows the value. The UI menu never produces such a save.
- No emulator comparison and no visible check of the frames at real speed.

## 7. Loads, errors and parity: what was exercised here

The brief asked to exercise the map disk menu entry and exit, the game-over tail, the held scene, and load/error retry while the eclipse
parity is toggled. Those paths were covered by reading the code and by the existing tests (`test/eclipse-parity.mjs` Parts 1h to 1k,
`test/save.mjs` sections 10). The only new mismatch found in them is the one fixed in section 2. The menu-entry toggle during an eclipse
and the held-load exit toggle were re-read against the traced routines and found consistent with the handoff notes.
