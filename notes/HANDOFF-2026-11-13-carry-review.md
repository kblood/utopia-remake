# Utopia handoff: review of the restart generator carry (`Game.createScene`), 2026-11-13

Model and routing: Claude Haiku 5.5, inline, as the review sub-agent. No orchestration tool was called, so the `claudeAgent` routing requested in the brief is not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run. Nothing under `original/` was written. Nothing was committed or pushed. The dirty worktree was preserved. Probes lived in `/tmp/utopia-carry-probe` and are not part of the repository.

Scope: the carry in `Game.createScene` (the `diskMenuFromTail && freshStart` guard), `Game.loadFromSlot` and `restoreSession` (save/load), `Game.returnToMap` / `openMapDiskMenu` / `runDiskMenuExit` / `enterScene` (where the flag is set and cleared), `Sim` RNG and hardware streams, and `test/game-over.mjs`. Previous handoff: `notes/HANDOFF-2026-11-13-disk-menu-tail-review.md`.

## 1. Invariant checked

The carry is the only place a new game takes the ended game's streams. It holds when all of these hold, and each was checked by reading the code and by probes:

- **No leak between campaigns.** `createScene` reads the ended map only while `diskMenuFromTail` is set. That flag is set by `returnToMap` in a game over and cleared by `openMapDiskMenu`, by a non-game-over `returnToMap`, and by `runDiskMenuExit` (the entered scene). While it is set, `this.map` is the frozen game-over map (exit and save are refused, and `update` does not tick the map). A held scene built during the tail is replaced by a newer pick or entered by EXIT, and both replacement paths are covered by the menu tests. No path reaches another campaign's stream.
- **Loads never carry.** `loadFromSlot` builds with `createScene(save.scenario, false)`, so `freshStart` is false and `restoreSession` sets the saved `sim.rng` and `sim.hardware`. Verified by the existing section 2c and the new section 2d.
- **No source default overwrites the carry after it is applied.** The carry runs after `new MapScene(...)`. The only freshScenario step is `Sim.initializeScenarioStart()`, which sets `dayQueued` and draws nothing. A probe showed the held scene's `rngState` equals the ended game's state exactly at build time, and its hardware state equals the ended game's (no constructor draw after the carry). The first draws come later, from `leaveBootMenu()` and the immediate pass, as intended.
- **Save/load is deterministic.** `captureSession` stores `sim.rngState` and `sim.hardwareState`. A save taken after a restart, then a draw, then a load restores both exactly (new section 2d).

Known non-carry: `World.solarPhaseRng` (see section 4). Save/load covers it, but the stream itself is not a continuation.

## 2. Findings and changes

**Fixed: hardware streams replayed on restart (concrete bug, same class as the seed fix in the previous handoff).** `Sim` builds its hardware approximation (`sim-hardware.ts`, default `createHardware()`) with fixed seeds for every new scene. The enemy gate (`enemies.ts`, `todLow() <= 24`) and the alien parity (`sim-aliens.ts`, `rasterParity()`) read these. A probe showed the ended game's TOD/raster state had advanced, while the restarted scene's state was back at the default seeds, so a restart replayed the first game's sequence. The original's TOD and beam position are continuous hardware, so this is not faithful. **Change:** `createScene` now carries the hardware state with the same guard (`restoreHardwareState`).

**Fixed (latent): an injected generator was overwritten.** `FreshStartInputs.simulation.rng` is documented as a deterministic harness input. The carry replaced it silently with the ended game's state. Nothing in production or in any test passes `freshStartInputs` today (`test/build.mjs` and `test/game-music.mjs` use `solarPhaseSeed` on `World`, not this option). **Change:** the carry of each stream is skipped when that stream was injected. The other stream still carries.

**Change in tests (not a product change):** the first attempt at the injected-rng check failed because `freshStartInputs` gives the same generator object to every fresh scene, including the first game. The check now builds the first game with `createScene(0, false)` and enters it, so the ended game has its own generator.

## 3. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/game-over.mjs` | exit 0, 50 `ok`, 0 `FAIL` (was 42; section 2d adds 8 checks) |
| Mutation: hardware carry removed (`dist`, `&& false`) | 2 `FAIL` (held-pick hardware, injected-rng hardware) |
| Mutation: rng carry removed | 2 `FAIL` (second-restart apparition, held-pick rng) |
| Mutation: injected guard removed | 1 `FAIL` (injected rng kept) |
| `npm test` (full chain) | exit 0, 4,135 `ok`, 0 `FAIL`. Log at `/tmp/utopia-carry-probe/npm-test.log` (not committed) |

The mutations were applied to the compiled `dist/game/game.js` (copies restored and `npm run build` rerun afterwards). The earlier handoff's mutation checks were not run, so its statement that the discrimination "rests on the probe and on reading the code" is now superseded for the rng carry: the mutation above shows the test catches it.

## 4. Residual risks (not changed here)

- **World solar-phase stream is host-random for every new world.** `World` seeds `solarPhaseRng` from `Math.random()` unless `solarPhaseSeed` is given, and production gives no seed. The initial solar-building phases of every new scene, including a restart, are therefore not reproducible across runs. This is deliberate (the `World` comment says a new world consumes host randomness; the original `$2E00` is a beam-position read, not a seeded stream), and saves store the stream. It is not carried on restart. The marker draw is unaffected, because it uses the Sim RNG.
- **Legacy (version-less) slots carry no generator.** `save.ts` `migrateLegacy` (line 203) sets `sim.rng: null` and `sim.hardware: null`. `restoreSession` skips null streams, so such a load keeps the default seeds. It is deterministic but is not a continuation of the saved game. Not changed.
- **Hardware carry is a continuity claim, not a trace value.** The original's TOD and beam counters at a restart are not captured (see the earlier handoff). The carry only stops the remake from replaying its own first values; it does not match any original value.
- **Scope unchanged:** a first game, a mid-game scenario pick and a Disk.4 continuation still start the default generators (`Sim` and hardware). Disk.4 continuations keep their prepared generator (`prepareDisk4HeadlessEnemies`, "RNG restoration incomplete" in `game-proper.md`).
- **Restart draws are deterministic** (same save and same play, same marker). This is not a parity claim, as in the previous handoff.
- **Still no runtime capture** of the restart order, the seed continuity, or the hardware sequence.

## 5. Notes changed

- `notes/formats/game-proper.md`: the restart bullet, "Generator continuity", now covers the hardware streams, the injected-input rule, and section 2d.
- `notes/ARCHITECTURE.md`: the fresh-startup paragraph names the hardware carry and the injected rule.
- `notes/README.md`: points to this note as the latest handoff.
- `test/game-over.mjs`: section 2d (held-pick exactness, hardware carry, save/load round trip, injected generator); the existing section 2b/2c checks are unchanged.
