# Utopia handoff: solar-phase stream after world creation, save/load and restart, 2026-11-13

Model and routing: Claude Haiku 5.5, inline, as the research sub-agent. No orchestration tool was called, so the `claudeAgent` routing requested in the brief is not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run. Nothing under `original/` was written. Nothing was committed or pushed. The dirty worktree was preserved. Probes lived in `/tmp/utopia-solar-probe` and are not part of the repository.

Scope: `World.solarPhaseRng` (`src/game/world.ts`), its consumers (`Construction` / `Builder`, `construction.ts`, `build.ts`), production seeding, `captureSession` / `restoreSession` (`save-session.ts`), the migrations (`save.ts`) and `Game.createScene` / `loadFromSlot` (`game.ts`). The `$2E00` trace is taken as documented and was not re-derived.

## 1. Is the stream gameplay-relevant after world creation?

**Draws after creation:** two kinds, both from the one stream (`World.nextSolarPhase`, `world.ts`):

- `World.buildObjects` (world creation): one draw per solar tile `$0F`/`$1F` in the map.
- `Construction` completion (`construction.ts` line 148): one draw per finished solar site. `Builder` passes no phase function, so the default `world.nextSolarPhase()` is used.

**What a draw changes:** only record `+6` of that solar record (`1` or `$FF`). It is not Sim RNG and does not touch the Sim.

**Readers of record `+6` in the remake:** a grep over `src/game` for indexed reads of object-record byte `+6` (`[+ 6]`, `[at + 6]`, `[i + 6]`, `[slot + 6]`) found these, none of them solar:

- mine and fuel-well richness counts (`sim.ts` `richnessSum`, tiles `$60` / `$3E`), where `+6` is a count;
- the tank-yard counter (`sim.ts` ~1470), the gun turret (`screens/buildings.ts` `clickGun`), the shipyard screen choice (`buildings.ts` ~846), and the build / ship order code in `sim-ships.ts`;
- the `checkpoint.ts` diagnostic dump, which copies `b6`.

Solar output (`sim.ts` `power()`) uses the type counters `tCount` / `tStored`, not the record phase.

**Conclusion (remake):** the stream is advanced in gameplay (every solar completion), but its values reach no gameplay code. Its continuation is therefore not observable in play. It is observable in the stored bytes and in checkpoint dumps. **Not established:** whether the original reads record `+6` of a solar tile anywhere. The notes (`game-state.md` ~426, `building.md` 34, `sim-port.md` 95) document only the write and say the exact raster parity is unverified. This is a static negative within the remake, not a claim about the original.

## 2. Production Math.random seeding

- The only `Math.random` in `src` is `World`'s constructor (`world.ts`, the solar seed when no `solarPhaseSeed` is given).
- Production passes no `solarPhaseSeed`: `freshStartInputs.world` is `undefined` in `Game` unless a harness supplies it.
- The constructor is also the load path: `loadFromSlot` calls `createScene(index, false)`, which runs `new World(...)`. So a load builds its world with a host-random stream, buildObjects draws from it, and then `restoreSession` overwrites the objects.
- Probe (`/tmp/utopia-solar-probe/probe.mjs`, outside the repo): four production `new World()` builds on the same empty map gave four different stream states (`2229680a 91f40835 1db9b64 4ed09fbd`). `World.fromSnapshot` gives the fixed state `0`.

## 3. Save / load continuation

- `captureSession` stores `world.solarPhaseRngState`; `restoreSession` restores it. For versions 4 and later the continuation is exact: `test/save.mjs` checks that two restores give the same next phase.
- **Inconsistency found and fixed:** versions 2 and 3 and version-less slots have `world.solarPhaseRng` null. `restoreSession` skipped the restore, so the loaded world kept the host-random stream of its `new World()` build. Loading one slot twice gave different future solar phases, and a save made after such a load stored a random state. This contradicted the carry-review's "deterministic" wording for legacy slots (`HANDOFF-2026-11-13-carry-review.md`, section 4). That wording is true for Sim RNG and hardware, which keep fixed default seeds, but not for this stream.

**Change:**

- `src/game/world.ts`: new export `FIXED_SOLAR_PHASE_STATE = 0`, used by `World.fromSnapshot` (previously a literal `0`).
- `src/game/save-session.ts`: `restoreSession` always sets the stream: `save.world.solarPhaseRng ?? FIXED_SOLAR_PHASE_STATE`.
- No format change, and no version bump. Saves that carry the stream load exactly as before.

**Regression:** `test/save.mjs`, new check "restore: a save without a solar-phase stream (legacy) gives the same future phases whatever the scene's stream was". It restores the same null-stream save into two scenes whose streams start at different states, and expects the same state and the same next phase. Mutation check: putting the old skip-on-null line back into `dist/game/save-session.js` gave `FAIL` on this check; with the fix it passes (the build was restored afterwards).

## 4. Restart behaviour (boundary, not changed)

- A restarted game (`createScene(index, true)` with `diskMenuFromTail`) carries the Sim RNG and the hardware streams (previous handoff) but **not** the solar stream. Its initial solar phases come from a fresh `Math.random` seed.
- Why it is left as it is: it has no remake reader (section 1), so it has no gameplay effect now, and it is not a save inconsistency, which is the only class this brief asked to fix.
- The change is small if it is wanted: compute `ended` before the `MapScene` is built, and pass `solarPhaseSeed: ended.world.solarPhaseRngState` to `World`. `createRng(state)` reproduces the state exactly (`createRng` sets `a = seed >>> 0`). This would make restarts deterministic in the one remaining random place. `sim-hardware.ts` documents that `$2E00` feeds the solar phase and the wave jitter, so this is the same class of continuity as the hardware carry.
- Mid-game scenario picks and the first game still use `Math.random`.

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/save.mjs` | exit 0, all checks passed, 0 `FAIL` (includes the new legacy-stream check) |
| `node test/build.mjs` | exit 0, 54 `ok`, 0 `FAIL` |
| `node test/game-over.mjs` | exit 0, 50 `ok`, 0 `FAIL` |
| `node test/game-music.mjs` | exit 0, 84 `ok`, 0 `FAIL` |
| `node test/checkpoint.mjs` | exit 0, 66 `ok`, 0 `FAIL` |
| `node test/construction.mjs` | exit 0, 58 `ok`, 0 `FAIL` |
| `npm test` (full chain) | exit 0, 4,136 `ok`, 0 `FAIL` (4,135 before plus the new check) |
| Mutation: old skip-on-null restored in `dist` | 1 `FAIL` (the new check); build restored afterwards, `test/save.mjs` exit 0 again |

Not verified: anything against the original (no capture, no emulator). The production-seed probe is a probe, not a test in the repository.

## 6. Future evidence needed

To decide whether the solar stream matters for the original (and so whether the restart carry is required):

1. **Static:** a search of the Disk.1 image for code that reads an object record byte `+6` for a solar tile (tile word `$0F`/`$1F`), including the powering and display routines. Record the result in `notes/formats/game-state.md` next to the solar sentence (~line 426). If there is no reader, the remake's gameplay-neutral claim is confirmed for the original as well.
2. **Runtime (WinUAE/Copperline):** on a disposable WHDLoad tree, one scenario with a solar site, a write breakpoint on the record's `+6` byte at completion, and a read breakpoint on that address across one game week. Record the completion's beam and any reader. This needs the user's own disk and a declared capture manifest (`runtime-checkpoints.md`).

Until then, the stream's values are a remake approximation with no measured original counterpart. Its continuation is exact for saves (version 4 and later) and now fixed for legacy loads.

## 7. Notes changed

- `notes/formats/remake-save.md`: the `world.solarPhaseRng` row and the compatibility paragraph (legacy saves restore to state 0).
- `notes/formats/game-proper.md`: the restart bullet, new sentence "Solar-phase stream (2026-11-13, not carried)".
- `notes/README.md`: points to this note as the latest handoff.
- `src/game/world.ts`, `src/game/save-session.ts`, `test/save.mjs`: section 3 above. Nothing else in the source changed.
