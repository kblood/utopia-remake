// The transient state the ORIGINAL Disk.4 load path resets after the two saved areas are in memory. STATIC TRACE ONLY
// (Disk.1 `$87DC` mode `$938D = 2`, instructions `$885C`-`$88EA`; no emulator comparison). Details and caveats:
// notes/formats/game-proper.md section 6a.
//
// The load handler does, in order:
//   `$885C`-`$887A`  read area A to `$39E3A` and area B to `$13034` (the saved ranges);
//   `$888A`/`$8894`  `$8D00 = $1453E` (saved word), disk check `$8A5A`;
//   `$889E`-`$88AA`  header = `$8F96 + $135C2 * $40`; `$1453A = header` (the ONLY load-path write inside area B, see below);
//   `$88B0`-`$88C2`  load that scenario's tiles/descriptors (`$7C80`, `$7D0E`): resources, not state;
//   `$88D4`/`$88D8`  `$866E` with d0 = 1, which branches to `$875C`-`$87DA` (the shared reset below) and returns;
//   `$88DC`-`$88E6`  clear 120 words = 240 bytes at `$39D4A` (the 30 effect slots), then `bra $82B8` (menu redraw).
// `$866E` mode 1 does NOT run the defaults block `$8674`-`$8754` (`$14234`..`$145A2`): the saved variable block (date, timers,
// pending period bits `$144C1`, markers, view origin, alien/meteor records) is kept.
//
// Every address below lies OUTSIDE the saved ranges: area B is `$13034`-`$14633`, area A starts at `$39E3A`, the effect slots end
// at `$39E39`. So the reset never changes a saved byte; it only fixes what a save cannot hold.

import type { Sim } from "./sim.js";

/** One reset write exactly as the original performs it: big-endian bytes at an original RAM address. */
export interface Disk4ResetWrite {
  readonly address: number;
  readonly bytes: readonly number[];
  /** Original instructions that perform it. */
  readonly at: string;
  /** What the remake does with it. */
  readonly model: string;
}

const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);
const long = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** `$875C`-`$87DA` (the shared reset) followed by the effect-slot clear `$88DC`-`$88E6`, in execution order. */
export const DISK4_LOAD_RESET: readonly Disk4ResetWrite[] = [
  { address: 0x156ac, bytes: zeros(8), at: "$875C-$876A", model: "$156AC message-line timer = 0 (a fresh Messages is empty); $156AE effect count = 0 (empty pool); $156B0-$156B3 unmodelled" },
  { address: 0x14634, bytes: [0xff, 0xff], at: "$876E-$8770", model: "unmodelled word (VBL-decremented while > 0; $FFFF is not > 0)" },
  { address: 0x14636, bytes: [0xff, 0xff], at: "$8776", model: "pointer-selected view cell: none (MapScene starts with no hover cell)" },
  { address: 0x15624, bytes: long(0x135c6), at: "$877C", model: "unmodelled pointer" },
  { address: 0x14638, bytes: long(0xe9a0), at: "$8786", model: "building-menu list pointer, page 1 (unmodelled here; the menu opens at page 1)" },
  { address: 0x1463c, bytes: long(0xe9e2), at: "$8790", model: "building-menu rectangle pointer, page 1 (as above)" },
  { address: 0x15634, bytes: [0, 0], at: "$87A0", model: "warning light 0 (power) unlit" },
  { address: 0x15644, bytes: [0, 0], at: "$87A2", model: "warning light 1 (view bookmark) unlit" },
  { address: 0x15654, bytes: [0, 0], at: "$87A6", model: "warning light 2 (food) unlit" },
  { address: 0x15664, bytes: [0, 0], at: "$87AA", model: "warning light 3 (air) unlit" },
  { address: 0x15698, bytes: [0xff], at: "$87AE", model: "message list head: empty log (a fresh Messages)" },
  { address: 0x1568c, bytes: [0, 0], at: "$87B4", model: "message panel used-line count = 0 (a fresh Messages)" },
  { address: 0x156a8, bytes: [0x94], at: "$87BA", model: "bit 7 = a day change is queued (Sim.dayQueued = true); bit 4 (dialog busy) and bit 2 (screen active) are cleared/set again by the exit handler $802C, not modelled" },
  { address: 0x156a9, bytes: [0x02], at: "$87C2", model: "pause bit 2 clear (Sim.paused = false); redraw-gate bit 3 clear; blast mark bit 5 clear (Sim.blastMark = false)" },
  { address: 0x156aa, bytes: [0x01], at: "$87CA", model: "system flags: every flag cleared (game over, tutorial, no-unit-bonus, QoL, eclipse, attack pending); bit 0 is cleared again by $80A6 on game start, so Sim.sysFlags = 0" },
  { address: 0x156ab, bytes: [0x01], at: "$87D2", model: "draw-mode byte (unmodelled)" },
  { address: 0x39d4a, bytes: zeros(240), at: "$88DC-$88E6", model: "all 30 effect slots free (the effect pool of the scene starts empty)" },
];

/**
 * The one load-path write that lands INSIDE saved area B: `$1453A` (long) := `$8F96 + index * $40`, a pointer into the Disk.1
 * RAM copy of the scenario header table (`$88AA`). Applied to the runtime GameState copy by `applyDisk4ScenarioPointer`; the
 * raw decoded area-B bytes and caller's Disk.4 input remain unchanged.
 */
export const DISK4_LOAD_AREA_B_POINTER = { address: 0x1453a, headerTable: 0x8f96, recordSize: 0x40, at: "$88AA" } as const;

/** Address ranges of the saved areas (inclusive start, exclusive end): area B `$13034`-`$14633`, area A `$39E3A`-`$43039`. */
export const DISK4_SAVED_RANGES: readonly (readonly [number, number])[] = [
  [0x13034, 0x14634],
  [0x39e3a, 0x39e3a + 73 * 512],
];

export type Disk4ScenarioPointerError =
  | { readonly code: "not-snapshot-graph"; readonly message: string }
  | { readonly code: "scenario-index"; readonly message: string };
export type Disk4ScenarioPointerResult = { readonly ok: true; readonly address: number } | { readonly ok: false; readonly error: Disk4ScenarioPointerError };

/**
 * Mirrors the original load-path write `$88AA`: `$1453A = $8F96 + scenario * $40`. Unlike the transient reset below,
 * this write is inside the saved area B. It updates the prepared runtime GameState copy, never the input Disk.4 bytes or
 * `disk4.areaB` raw copy. The pointer is not dereferenced by the remake, but preserving the original value keeps the
 * loaded state coherent for code that inspects it later.
 */
export function applyDisk4ScenarioPointer(
  graph: { readonly sim: Sim; readonly state: { setLong(address: number, value: number): void } },
  scenario: number,
  scenarioCount: number,
): Disk4ScenarioPointerResult {
  if (graph.sim.initialization !== "snapshot") {
    return { ok: false, error: { code: "not-snapshot-graph", message: "The Disk.4 scenario pointer applies to a snapshot graph only" } };
  }
  if (!Number.isInteger(scenarioCount) || scenarioCount < 1 || !Number.isInteger(scenario) || scenario < 0 || scenario >= scenarioCount) {
    return { ok: false, error: { code: "scenario-index", message: `Scenario index ${String(scenario)} is outside 0-${scenarioCount - 1}` } };
  }
  const address = DISK4_LOAD_AREA_B_POINTER.headerTable + scenario * DISK4_LOAD_AREA_B_POINTER.recordSize;
  graph.state.setLong(DISK4_LOAD_AREA_B_POINTER.address, address);
  return { ok: true, address };
}

/** Every byte the reset writes as address -> value (later writes win, as in the original). */
export function expandDisk4LoadReset(writes: readonly Disk4ResetWrite[] = DISK4_LOAD_RESET): Map<number, number> {
  const out = new Map<number, number>();
  for (const w of writes) w.bytes.forEach((b, i) => out.set(w.address + i, b));
  return out;
}

export type Disk4ResetError =
  | { readonly code: "not-snapshot-graph"; readonly message: string }
  | { readonly code: "scenario-index"; readonly message: string };
export type Disk4ResetResult = { readonly ok: true } | { readonly ok: false; readonly error: Disk4ResetError };

/**
 * Applies the part of `DISK4_LOAD_RESET` the engine models to a DETACHED prepared graph's Sim, before the scene is built:
 * `sysFlags = 0`, `paused = false`, `blastMark = false` (`$156A9` bit 5), `dayQueued = true` (`$156A8` bit 7), all four warning lights unlit. The message log, the
 * hover cell and the 30-slot effect pool belong to the scene and start empty / unset there (the traced values above). No saved
 * byte (area A/B image, map, flags, objects, enemy/ship/tank slots, pending period bits, gun/period state, alien and meteor
 * records, markers, view origin) is read or written, no RNG is drawn, no hook runs. Refuses a Sim that is not a snapshot
 * graph; calling it on a graph that already drives a live scene is a caller error (the Game calls it once, before
 * `MapScene.fromPrepared`).
 */
export function applyDisk4LoadReset(graph: { readonly sim: Sim }): Disk4ResetResult {
  const sim = graph.sim;
  if (sim.initialization !== "snapshot") {
    return { ok: false, error: { code: "not-snapshot-graph", message: "The load reset applies to a Disk.4 snapshot graph only" } };
  }
  sim.sysFlags = 0;
  sim.paused = false;
  sim.blastMark = false;
  sim.dayQueued = true;
  sim.alerts.flags.fill(0);
  return { ok: true };
}
