// Remake-only stand-ins for two hardware reads the original makes inside its game code. Neither is a game random
// number: the original does NOT call its generator ($2DCC) for them, so the port must not consume the Sim RNG either
// (doing so shifts every later roll of an unrelated routine).
//
//   - `todLow`      $1266A (enemy attack scan) reads the CIA TOD low byte at $BFE801 once per call and tests it for
//                   0..24 (about 25/256, the "one time in ten" bomb gate). The byte depends on the wall-clock
//                   moment of the read; it is not reproducible.
//   - `rasterParity` $2E00 reads the beam position at $DFF006 and keeps one bit. $117EE (wave launch) takes the sign
//                   of its +/-2 entry-count jitter from it; the solar-building phase ($6A8C path, World) reads the
//                   same routine through its own, older stream (World.nextSolarPhase, saved as `world.solarPhaseRng`).
//
// APPROXIMATION, not a reproduction: each is a separate seeded 32-bit stream (same mixer as `createRng`) with a fixed
// default seed, so a given sequence of calls is deterministic and the two never influence each other or the Sim
// RNG. Only the distribution (uniform byte / fair bit) is modelled; beam and clock timing are not. The static Disk.1
// trace establishes parity 0 = +2 and parity 1 = -2 in `$117EE`; the stand-in does not reproduce which parity a real
// beam position supplies at a given spawn. Tests and callers inject a plain
// `HardwareSource` (no state, then nothing is saved for it); the default is a `SeededHardware` whose two states travel
// in native saves since version 5 (`sim.hardware`) and in runtime checkpoints (`aliens.approximations`).

import { createRng, type SeededRng } from "./sim-math.js";

/** What the game code reads from the hardware. Inject a stub in tests; a stub has no state to save. */
export interface HardwareSource {
  /** `$BFE801`, 0..255; read once per enemy attack call (`$1266A`). */
  todLow(): number;
  /** The bit `$2E00` derives from `$DFF006`, 0 or 1; read once per wave-entry jitter (`$117EE`). */
  rasterParity(): number;
}

/** The two 32-bit stream counters of the default approximation. */
export interface HardwareState {
  readonly tod: number;
  readonly raster: number;
}

/** A `HardwareSource` whose position can be saved and restored (the default one). */
export interface SeededHardware extends HardwareSource {
  getState(): HardwareState;
  setState(state: HardwareState): void;
}

/** Fixed default seeds: "TOD\0" and "RAST". Never derived from host randomness, so a fresh Sim is reproducible. */
export const HARDWARE_SEEDS: HardwareState = { tod: 0x544f4400, raster: 0x52415354 };

export function createHardware(seeds: HardwareState = HARDWARE_SEEDS): SeededHardware {
  const tod: SeededRng = createRng(seeds.tod);
  const raster: SeededRng = createRng(seeds.raster);
  return {
    todLow: () => tod(256),
    rasterParity: () => raster(2),
    getState: () => ({ tod: tod.getState(), raster: raster.getState() }),
    setState: (state) => {
      tod.setState(state.tod);
      raster.setState(state.raster);
    },
  };
}

export function isSeededHardware(source: HardwareSource): source is SeededHardware {
  const s = source as Partial<SeededHardware>;
  return typeof s.getState === "function" && typeof s.setState === "function";
}
