// Which scenario a Disk.4 save belongs to.
//
// PRIMARY (static trace of the original load path, game-proper.md section 6a): the save itself carries the answer. The load
// handler `$87DC` (`$938D = 2`) reads area B and then (a) copies the saved word `$1453E` to `$8D00` and calls the disk
// check `$8A5A` (`$888A`/`$8894`), which accepts only a disk whose header word at +8 equals it (the supplied Disk.2 holds 2);
// (b) indexes the scenario header table `$8F96` with the saved word `$135C2` times `$40` (`$889E`-`$88AA`), without a bounds
// check, to load that scenario's tiles/sprites. Every Disk.2 scenario block carries its own index at `$135C2` (block offset
// `$58E`: 0..9), so a save made in a scenario holds that scenario's index. `resolveDisk4Scenario` reads those two words.
//
// ADVISORY ONLY: `rankDisk4ScenarioMaps` / `identifyDisk4Scenario` compare the saved map tiles with the Disk.2 maps. The map
// is mutable (building, demolition), so this is a heuristic that the activation path uses to list recovery suggestions, never
// to choose the scenario of a save whose metadata is valid.

import { DISK4_AREA_B_BASE, DISK4_AREA_B_BYTES } from "./disk4-state.js";
import { loadMap, MAP_HEIGHT, MAP_WIDTH, readScenarioDiskId, readScenarioRecords, TILE_ID_MASK } from "./scenario.js";

/** RAM address of the saved scenario index word (inside area B; Disk.1 `$88A0` reads it, every Disk.2 block seeds it). */
export const DISK4_SCENARIO_INDEX_ADDR = 0x135c2;
/** RAM address of the saved scenario-disk id word (inside area B; Disk.1 `$888C` reads it into `$8D00`). */
export const DISK4_DISK_ID_ADDR = 0x1453e;

const MAP_CELLS = MAP_WIDTH * MAP_HEIGHT;
const MIN_MATCH_RATIO = 0.5;
const MIN_MARGIN_RATIO = 0.1;

export interface ScenarioMapCandidate {
  readonly index: number;
  readonly name: string;
  readonly matches: number;
  readonly ratio: number;
}

export type Disk4ScenarioError =
  | { readonly code: "map-size"; readonly message: string }
  | { readonly code: "disk2"; readonly message: string };

export type Disk4ScenarioMatch =
  | { readonly status: "identified"; readonly scenario: number; readonly candidate: ScenarioMapCandidate; readonly candidates: readonly ScenarioMapCandidate[] }
  | { readonly status: "ambiguous"; readonly candidates: readonly ScenarioMapCandidate[] };

export type Disk4ScenarioResult =
  | { readonly ok: true; readonly value: Disk4ScenarioMatch }
  | { readonly ok: false; readonly error: Disk4ScenarioError };

/**
 * Rank fixed-size map snapshots against caller-supplied scenario maps. Flag bits are ignored; tile ids
 * are compared. Classification is deliberately conservative and heuristic: at least half the cells
 * must match and the leader must beat second place by ten percentage points.
 */
export function rankDisk4ScenarioMaps(
  savedCells: Uint16Array,
  scenarios: readonly { readonly index: number; readonly name: string; readonly cells: Uint16Array }[],
): Disk4ScenarioMatch | Disk4ScenarioError {
  if (!(savedCells instanceof Uint16Array) || savedCells.length !== MAP_CELLS) {
    return { code: "map-size", message: `Saved map must contain exactly ${MAP_CELLS} cells` };
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.some((s) =>
    !s || !Number.isInteger(s.index) || typeof s.name !== "string" || !(s.cells instanceof Uint16Array) || s.cells.length !== MAP_CELLS)) {
    return { code: "map-size", message: `Each scenario map must contain exactly ${MAP_CELLS} cells` };
  }

  const candidates = scenarios.map((scenario) => {
    let matches = 0;
    for (let i = 0; i < MAP_CELLS; i++) {
      if ((savedCells[i] & TILE_ID_MASK) === (scenario.cells[i] & TILE_ID_MASK)) matches++;
    }
    return { index: scenario.index, name: scenario.name, matches, ratio: matches / MAP_CELLS };
  }).sort((a, b) => b.ratio - a.ratio || a.index - b.index);

  const best = candidates[0];
  const runnerUpRatio = candidates[1]?.ratio ?? 0;
  if (best.ratio < MIN_MATCH_RATIO || best.ratio - runnerUpRatio < MIN_MARGIN_RATIO) {
    return { status: "ambiguous", candidates };
  }
  return { status: "identified", scenario: best.index, candidate: best, candidates };
}

/** Infer the scenario from Disk.2's ten maps; an ambiguous result must be resolved by the caller. */
export function identifyDisk4Scenario(savedCells: Uint16Array, disk2: Uint8Array): Disk4ScenarioResult {
  if (!(savedCells instanceof Uint16Array) || savedCells.length !== MAP_CELLS) {
    return { ok: false, error: { code: "map-size", message: `Saved map must contain exactly ${MAP_CELLS} cells` } };
  }
  if (!(disk2 instanceof Uint8Array)) {
    return { ok: false, error: { code: "disk2", message: "Disk.2 must be supplied as a Uint8Array" } };
  }
  try {
    const records = readScenarioRecords(disk2);
    const scenarios = records.map((record) => ({ index: record.index, name: record.name, cells: loadMap(disk2, record) }));
    const result = rankDisk4ScenarioMaps(savedCells, scenarios);
    if ("code" in result) return { ok: false, error: result };
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, error: { code: "disk2", message: error instanceof Error ? error.message : String(error) } };
  }
}

// ---- saved metadata (primary) ---------------------------------------------------------------------------------------

/** The two words of saved area B that the original's load path reads before anything else is loaded. */
export interface Disk4SaveMetadata {
  /** `$1453E`: id of the scenario disk the save needs (original `$8A5A` compares it with the disk header word at +8). */
  readonly diskId: number;
  /** `$135C2`: index into the scenario header table (`$8F96 + index * $40`). Raw word; not range-checked by the original. */
  readonly scenarioIndex: number;
}

/** What the loadable Disk.2 offers: its header id word and how many scenario records it lists. */
export interface Disk4ScenarioReference {
  readonly diskId: number;
  readonly scenarioCount: number;
}

export type Disk4MetadataError =
  /** Disk.2 has no readable scenario header, so neither the id nor the index can be checked. Nothing is guessed. */
  | { readonly code: "disk2"; readonly message: string }
  | { readonly code: "area-b-size"; readonly message: string }
  | { readonly code: "reference"; readonly message: string }
  /** The saved id word differs from the supplied Disk.2 header id. The original would ask for that disk forever; no other id is known, so none is accepted. NOT recoverable by choosing a scenario. */
  | { readonly code: "unsupported-disk-id"; readonly message: string; readonly savedDiskId: number; readonly expectedDiskId: number }
  /** The saved index is not a scenario of the supplied Disk.2 (the original would read outside its header table). Recoverable with a deliberate `recoverScenario`. */
  | { readonly code: "scenario-index"; readonly message: string; readonly savedScenario: number; readonly scenarioCount: number }
  /** A recovery choice was given but is itself outside 0 .. scenarioCount - 1. */
  | { readonly code: "recovery-index"; readonly message: string; readonly requested: unknown; readonly scenarioCount: number }
  /** A recovery choice differs from a VALID saved index. Valid metadata is never overridden; the conflict is reported. */
  | { readonly code: "scenario-conflict"; readonly message: string; readonly savedScenario: number; readonly requested: number };

/** `saved`: the save's own index was used. `recovery`: the saved index was invalid and the caller's deliberate choice was used. */
export type Disk4ScenarioSource = "saved" | "recovery";

export interface ResolvedDisk4Scenario {
  readonly scenario: number;
  readonly by: Disk4ScenarioSource;
  /** The metadata exactly as saved (also when it was invalid and recovery was used). */
  readonly saved: Disk4SaveMetadata;
}

export type Disk4MetadataResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Disk4MetadataError };

const be16 = (b: Uint8Array, at: number): number => ((b[at] << 8) | b[at + 1]) & 0xffff;

/** Reads `$1453E` and `$135C2` from a decoded area B copy (exactly 5,632 bytes). Pure; the input is only read. */
export function readDisk4SaveMetadata(areaB: Uint8Array): Disk4MetadataResult<Disk4SaveMetadata> {
  if (!(areaB instanceof Uint8Array) || areaB.length !== DISK4_AREA_B_BYTES) {
    return { ok: false, error: { code: "area-b-size", message: `Area B must be exactly ${DISK4_AREA_B_BYTES} bytes to read the saved scenario metadata` } };
  }
  return {
    ok: true,
    value: {
      diskId: be16(areaB, DISK4_DISK_ID_ADDR - DISK4_AREA_B_BASE),
      scenarioIndex: be16(areaB, DISK4_SCENARIO_INDEX_ADDR - DISK4_AREA_B_BASE),
    },
  };
}

/** The id and record count of the supplied Disk.2, read from its header; a typed `disk2` error when that fails. */
export function readDisk4ScenarioReference(disk2: Uint8Array): Disk4MetadataResult<Disk4ScenarioReference> {
  if (!(disk2 instanceof Uint8Array)) return { ok: false, error: { code: "disk2", message: "Disk.2 must be supplied as a Uint8Array" } };
  try {
    return { ok: true, value: { diskId: readScenarioDiskId(disk2), scenarioCount: readScenarioRecords(disk2).length } };
  } catch (error) {
    return { ok: false, error: { code: "disk2", message: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * Decides the scenario of a save from its own metadata, before any resource is loaded. Order as in the original: the disk
 * id first, then the index. Rules:
 *  - id differs from the reference -> `unsupported-disk-id`, whatever `recoverScenario` says.
 *  - index valid, no choice or the same choice -> the saved index (`by: "saved"`).
 *  - index valid, a different choice -> `scenario-conflict`; valid metadata is never silently overridden.
 *  - index invalid, no choice -> `scenario-index` (recoverable); with a valid choice -> that choice (`by: "recovery"`);
 *    with an invalid choice -> `recovery-index`.
 * Pure: nothing is read from or written to any save or disk.
 */
export function resolveDisk4Scenario(
  areaB: Uint8Array,
  reference: Disk4ScenarioReference,
  recoverScenario?: number,
): Disk4MetadataResult<ResolvedDisk4Scenario> {
  if (!reference || typeof reference !== "object" || !Number.isInteger(reference.diskId) || reference.diskId < 0 || reference.diskId > 0xffff ||
    !Number.isInteger(reference.scenarioCount) || reference.scenarioCount < 1 || reference.scenarioCount > 0xffff) {
    return { ok: false, error: { code: "reference", message: "Disk.2 reference must contain a 16-bit disk id and a positive 16-bit scenario count" } };
  }
  const read = readDisk4SaveMetadata(areaB);
  if (!read.ok) return read;
  const saved = read.value;
  const { scenarioCount } = reference;
  const inRange = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < scenarioCount;
  if (saved.diskId !== reference.diskId) {
    return {
      ok: false,
      error: {
        code: "unsupported-disk-id",
        message: `The save names scenario disk id ${saved.diskId} (word $1453E); the supplied Disk.2 is id ${reference.diskId}. No other disk id is known, so this save is not accepted`,
        savedDiskId: saved.diskId,
        expectedDiskId: reference.diskId,
      },
    };
  }
  if (recoverScenario !== undefined && !inRange(recoverScenario)) {
    return { ok: false, error: { code: "recovery-index", message: `The recovery scenario ${String(recoverScenario)} is outside 0-${scenarioCount - 1}`, requested: recoverScenario, scenarioCount } };
  }
  if (inRange(saved.scenarioIndex)) {
    if (recoverScenario !== undefined && recoverScenario !== saved.scenarioIndex) {
      return {
        ok: false,
        error: {
          code: "scenario-conflict",
          message: `The save names scenario ${saved.scenarioIndex} (word $135C2) but ${recoverScenario} was requested; a valid saved scenario is not overridden`,
          savedScenario: saved.scenarioIndex,
          requested: recoverScenario,
        },
      };
    }
    return { ok: true, value: { scenario: saved.scenarioIndex, by: "saved", saved } };
  }
  if (recoverScenario === undefined) {
    return {
      ok: false,
      error: {
        code: "scenario-index",
        message: `The saved scenario index ${saved.scenarioIndex} (word $135C2) is outside 0-${scenarioCount - 1}; choose a scenario explicitly to recover`,
        savedScenario: saved.scenarioIndex,
        scenarioCount,
      },
    };
  }
  return { ok: true, value: { scenario: recoverScenario, by: "recovery", saved } };
}
