// Preparation steps for a Disk.4 restore: pure decoders and snapshot constructors build detached
// state/world data, then optional layers add own tanks, inert Sim helpers and a headless enemy system.
// Game.activateDisk4 can attach that prepared graph to an experimental MapScene; it does not claim
// original post-load fidelity. Preparation itself remains inert.
//   ... -> GameState.fromSnapshot -> World.fromSnapshot -> UnitSystem.fromDisk4 -> Sim.fromSnapshot
// Evidence and limits: notes/formats/game-proper.md section 6-7, notes/formats/game-state.md.
//
// Scope:
//  - Preparation is pure with respect to input bytes and any currently running Game. It returns a
//    fresh graph (or one typed error, no partial result); Game.activateDisk4 owns later scene activation.
//  - `prepareDisk4Load` stays explicit and inert about scenario identity: it requires the scenario index and count from
//    the caller and neither reads nor checks the saved words `$135C2` (scenario index) / `$1453E` (disk id) and applies none
//    of the original load path's resets. Game.activateDisk4 validates those saved words first (resolveDisk4Scenario, static
//    trace of `$888A`-`$88AA`), passes the result in, and applies the traced reset (disk4-reset.ts) to the detached graph
//    afterwards. Area B is kept verbatim and never replaced by the selected scenario's new-game block.
//  - Restored: the full area-B image (scenario block + variable block, byte for byte, no new-game
//    defaults), all 7,500 map cell words, all 7,650 per-cell flag bytes, and all 1,000 object records in
//    their original slots with the saved count word.
//  - Decoded, not restored: own ship slots remain in `entities`; own tanks and enemy air/ground records
//    may be hydrated in the detached tank/sim/enemy variants (fixed slots, inert, no occupancy writes); own ships 11-16
//    and missiles (type 17, typed enemy-slot target ref) may be hydrated in the detached ship variant
//    (ShipRoster, no map/flag/counter writes). Snapshot Sim construction skips the two known
//    constructor-time writes (capacity fallback and marker rescan), but its transient flags and alien /
//    meteor runtime objects are not loaded until scene activation; live alien/meteor entries are refused.
//    The experimental activation binds scene hooks but does not reproduce the original post-load path.
//    Fidelity against a persisted save and the running original remains unverified.
//  - Most tests are synthetic. Optional local checks use player-supplied assets and one memory-derived
//    capture (see game-proper.md); the capture is not a persisted Disk.4 write-through.

import {
  parseDisk4Input,
  readDisk4Slot,
  type Disk4Error,
  type Disk4InputError,
  type Disk4Source,
} from "../data/disk4.js";
import { decodeDisk4State, type Disk4State, type Disk4StateError } from "../data/disk4-state.js";
import { decodeDisk4Entities, type Disk4Entities, type Disk4EntitiesError } from "../data/disk4-entities.js";
import { GameState, type SnapshotError } from "./state.js";
import { World } from "./world.js";
import { UnitSystem, type UnitRestoreError } from "./units.js";
import { Sim, type SimOptions } from "./sim.js";
import { EnemyRoster, EnemySystem, type EnemyAdoptError, type EnemyHooks, type EnemyRestoreError } from "./enemies.js";
import type { CombatTables } from "../data/combat.js";
import { ShipRoster, type ShipRestoreError } from "./ship-roster.js";

/** What the caller asks for. All three fields are required: nothing is inferred or checked against the save. */
export interface Disk4LoadRequest {
  /** Save slot on the Disk.4 (0-9). */
  readonly slot: number;
  /** Scenario index the caller attributes to this save (0 to scenarioCount - 1). Not read from or compared with the save here. */
  readonly scenario: number;
  /** Number of scenarios the caller can load (for the remake: readScenarioRecords(disk2).length). */
  readonly scenarioCount: number;
}

export type Disk4LoadError =
  | { readonly stage: "request"; readonly code: "bad-request" | "scenario-count" | "scenario-index"; readonly message: string }
  | { readonly stage: "input"; readonly error: Disk4InputError }
  | { readonly stage: "slot"; readonly error: Disk4Error }
  | { readonly stage: "state"; readonly error: Disk4StateError }
  | { readonly stage: "entities"; readonly error: Disk4EntitiesError }
  | { readonly stage: "restore"; readonly error: SnapshotError };

export type Disk4TankLoadError = Disk4LoadError | { readonly stage: "tanks"; readonly error: UnitRestoreError };

export interface PreparedDisk4Load {
  readonly slot: number;
  /** Save name from the Disk.4 record. */
  readonly name: string;
  /** The scenario index the caller supplied (range-checked only, never derived from or compared with the save). */
  readonly scenario: number;
  readonly source: Disk4Source;
  /** New state adopting the saved area-B image verbatim (no defaults applied). */
  readonly state: GameState;
  /** New world over `state`: saved map cells, cell flags and object records in their original slots. */
  readonly world: World;
  /**
   * The decoded save, including the four entity lists and the raw area copies. The lists are NOT
   * restored into any unit system; they are here for the step that will do that.
   */
  readonly disk4: Disk4State;
  /**
   * The four entity lists decoded by `decodeDisk4Entities(disk4)`: fixed slot arrays (30 enemy air, 60
   * enemy ground, 40 own ships, 99 own tanks), free slots included, raw record bytes kept per slot.
   * Detached copies. Decoded data only; NOT restored into any unit, ship or enemy system.
   */
  readonly entities: Disk4Entities;
}

export type Disk4LoadResult = { readonly ok: true; readonly value: PreparedDisk4Load } | { readonly ok: false; readonly error: Disk4LoadError };

export interface PreparedDisk4TankLoad extends PreparedDisk4Load {
  /** Detached runtime tank slots; no occupancy bits are rebuilt and no hooks are called. */
  readonly tanks: UnitSystem;
}
export type Disk4TankLoadResult = { readonly ok: true; readonly value: PreparedDisk4TankLoad } | { readonly ok: false; readonly error: Disk4TankLoadError };

export interface PreparedDisk4SimLoad extends PreparedDisk4TankLoad {
  /** Detached simulation helpers; still inert and missing restored ships/enemies/post-load state. */
  readonly sim: Sim;
}
export type Disk4SimLoadResult = { readonly ok: true; readonly value: PreparedDisk4SimLoad } | { readonly ok: false; readonly error: Disk4TankLoadError };

export type Disk4EnemyLoadError = Disk4TankLoadError | { readonly stage: "enemies"; readonly error: EnemyRestoreError };

export interface PreparedDisk4EnemyLoad extends PreparedDisk4SimLoad {
  /**
   * Detached fixed-slot enemy ground (60) and air (30) objects; free slots are null. Shares the world's
   * map and flag buffers by reference and never writes them. A crusher's +$13 toggle/counter and +$14
   * animation are decoded into the Enemy (validated only by the adoption); ships and all post-load behaviour are
   * not restored here.
   */
  readonly enemies: EnemyRoster;
}
export type Disk4EnemyLoadResult = { readonly ok: true; readonly value: PreparedDisk4EnemyLoad } | { readonly ok: false; readonly error: Disk4EnemyLoadError };

export type Disk4ShipLoadError = Disk4EnemyLoadError | { readonly stage: "ships"; readonly error: ShipRestoreError };

export interface PreparedDisk4ShipLoad extends PreparedDisk4EnemyLoad {
  /**
   * Detached fixed-slot own ships 11-16 and missiles (type 17, a distinct `RestoredMissile` with a typed
   * enemy-slot target ref and, here, the same-slot `enemy` object identity at save time) in a `ShipRoster`
   * (40 slots, null = free); not a Fleet. Building it touches no map/flag buffer, counter, RNG, enemy or state.
   * The +$14 flag pointer is kept raw. Missile flight, the daily $ACE2 target refresh/self-destruction and ship
   * stepping exist only after `prepareDisk4HeadlessEnemies()` adopts these exact objects into the Fleet; plain
   * `prepareDisk4ShipLoad()` stays detached.
   */
  readonly ships: ShipRoster;
}
export type Disk4ShipLoadResult = { readonly ok: true; readonly value: PreparedDisk4ShipLoad } | { readonly ok: false; readonly error: Disk4ShipLoadError };

const fail = (error: Disk4LoadError): Disk4LoadResult => ({ ok: false, error });

export interface InspectedDisk4Slot {
  readonly slot: number;
  readonly name: string;
  readonly source: Disk4Source;
  /** The decoded save (copies); `disk4.mapCells` is what scenario identification compares. */
  readonly disk4: Disk4State;
}
export type InspectDisk4SlotResult =
  | { readonly ok: true; readonly value: InspectedDisk4Slot }
  | { readonly ok: false; readonly error: Extract<Disk4LoadError, { readonly stage: "input" | "slot" | "state" }> };

/**
 * The parse / slot / area-decode prefix of `prepareDisk4Load` on its own: no scenario is needed or checked, no
 * state, world or runtime object is built. Used to read the saved metadata words and the saved map before the scenario is
 * chosen (`resolveDisk4Scenario`, advisory `identifyDisk4Scenario`). Total: never throws for bad input; the input bytes are only read.
 */
export function inspectDisk4Slot(bytes: Uint8Array, slot: number): InspectDisk4SlotResult {
  const input = parseDisk4Input(bytes);
  if (!input.ok) return { ok: false, error: { stage: "input", error: input.error } };
  const areas = readDisk4Slot(input.value.image, slot);
  if (!areas.ok) return { ok: false, error: { stage: "slot", error: areas.error } };
  const decoded = decodeDisk4State(areas.value);
  if (!decoded.ok) return { ok: false, error: { stage: "state", error: decoded.error } };
  return { ok: true, value: { slot, name: decoded.value.name, source: input.value.source, disk4: decoded.value } };
}

/**
 * Prepares a restore of `request.slot` from Disk.4 bytes (raw expanded, or the XPKF/MASH seed). Total:
 * never throws for bad input and returns exactly one typed error naming the failing stage. The input
 * bytes are only read.
 */
export function prepareDisk4Load(bytes: Uint8Array, request: Disk4LoadRequest): Disk4LoadResult {
  if (typeof request !== "object" || request === null) {
    return fail({ stage: "request", code: "bad-request", message: "Request must be { slot, scenario, scenarioCount }" });
  }
  const { slot, scenario, scenarioCount } = request;
  if (!Number.isInteger(scenarioCount) || scenarioCount < 1) {
    return fail({ stage: "request", code: "scenario-count", message: `scenarioCount must be an integer of at least 1, got ${String(scenarioCount)}` });
  }
  if (!Number.isInteger(scenario) || scenario < 0 || scenario >= scenarioCount) {
    return fail({ stage: "request", code: "scenario-index", message: `Scenario index ${String(scenario)} is outside 0-${scenarioCount - 1}; the scenario is not read from the Disk.4 and must be given explicitly` });
  }

  const input = parseDisk4Input(bytes);
  if (!input.ok) return fail({ stage: "input", error: input.error });
  const areas = readDisk4Slot(input.value.image, slot);
  if (!areas.ok) return fail({ stage: "slot", error: areas.error });
  const decoded = decodeDisk4State(areas.value);
  if (!decoded.ok) return fail({ stage: "state", error: decoded.error });
  const disk4 = decoded.value;
  const entities = decodeDisk4Entities(disk4);
  if (!entities.ok) return fail({ stage: "entities", error: entities.error });

  const state = GameState.fromSnapshot(disk4.areaB);
  if (!state.ok) return fail({ stage: "restore", error: state.error });
  const world = World.fromSnapshot(state.value, { cells: disk4.mapCells, cellFlags: disk4.cellFlags, objects: disk4.objects.records });
  if (!world.ok) return fail({ stage: "restore", error: world.error });

  return {
    ok: true,
    value: { slot, name: disk4.name, scenario, source: input.value.source, state: state.value, world: world.value, disk4, entities: entities.value },
  };
}

/**
 * Prepares the same detached save snapshot as prepareDisk4Load plus runtime own-tank objects.
 * The saved sub-tick and tank slot numbers are preserved. Ships, enemies, scenario selection,
 * post-load initialization and activation in a running Game are still outside this function.
 */
export function prepareDisk4TankLoad(bytes: Uint8Array, request: Disk4LoadRequest): Disk4TankLoadResult {
  const prepared = prepareDisk4Load(bytes, request);
  if (!prepared.ok) return prepared;
  const { state, world, entities } = prepared.value;
  const tanks = UnitSystem.fromDisk4(
    world.cells,
    world.cellFlags,
    entities.ownTanks.slots,
    state.byte(0x144c9),
    () => state.byte(0x14592),
  );
  if (!tanks.ok) return { ok: false, error: { stage: "tanks", error: tanks.error } };
  return { ok: true, value: { ...prepared.value, tanks: tanks.value } };
}

/** Adds inert Sim helpers over the same detached snapshot without capacity/marker new-game writes. */
export function prepareDisk4SimLoad(
  bytes: Uint8Array,
  request: Disk4LoadRequest,
  options: SimOptions = {},
): Disk4SimLoadResult {
  const prepared = prepareDisk4TankLoad(bytes, request);
  if (!prepared.ok) return prepared;
  const sim = Sim.fromSnapshot(prepared.value.world, options);
  return { ok: true, value: { ...prepared.value, sim } };
}

/**
 * Adds detached enemy ground/air hydration on top of prepareDisk4SimLoad. Inert: no spawn, defection,
 * movement, combat, RNG use, hooks, counter updates or occupancy flag writes. An invalid occupied enemy
 * record rejects the whole preparation with an "enemies" stage error and no partial value.
 */
export function prepareDisk4EnemyLoad(
  bytes: Uint8Array,
  request: Disk4LoadRequest,
  options: SimOptions = {},
): Disk4EnemyLoadResult {
  const prepared = prepareDisk4SimLoad(bytes, request, options);
  if (!prepared.ok) return prepared;
  const { world, entities } = prepared.value;
  const enemies = EnemyRoster.fromDisk4(world.cells, world.cellFlags, entities.enemyGround.slots, entities.enemyAir.slots);
  if (!enemies.ok) return { ok: false, error: { stage: "enemies", error: enemies.error } };
  return { ok: true, value: { ...prepared.value, enemies: enemies.value } };
}

/**
 * Adds detached own-ship hydration on top of prepareDisk4EnemyLoad: types 11-16 as `RestoredShip`, type 17 as
 * `RestoredMissile` whose 24-bit target pointer is resolved against the decoded fixed enemy slots as a typed ref
 * plus, because the detached EnemyRoster objects are passed, the save-time Enemy identity of that slot (`target.enemy`,
 * checked for list/slot/address/type; read-only). Inert: no Fleet, no createShip, hooks, counter/map/flag writes, RNG or
 * saved-state changes. Any invalid occupied ship/missile record (including a missile pointer into the air
 * header, off a slot start or outside the enemy lists) rejects the whole preparation with a "ships" stage
 * error and no partial value.
 */
export function prepareDisk4ShipLoad(
  bytes: Uint8Array,
  request: Disk4LoadRequest,
  options: SimOptions = {},
): Disk4ShipLoadResult {
  const prepared = prepareDisk4EnemyLoad(bytes, request, options);
  if (!prepared.ok) return prepared;
  const { entities, enemies } = prepared.value;
  const ships = ShipRoster.fromDisk4(entities.ownShips.slots, {
    ground: entities.enemyGround.slots,
    air: entities.enemyAir.slots,
    objects: { ground: enemies.ground, air: enemies.air },
  });
  if (!ships.ok) return { ok: false, error: { stage: "ships", error: ships.error } };
  return { ok: true, value: { ...prepared.value, ships: ships.value } };
}

export type Disk4HeadlessEnemyLoadError = Disk4ShipLoadError | { readonly stage: "enemy-system"; readonly error: EnemyAdoptError };

export interface PreparedDisk4HeadlessEnemies extends PreparedDisk4ShipLoad {
  /**
   * One headless controller that adopted BOTH `enemies` and `ships`: the same Enemy objects in their fixed slots
   * (`enemies.ground` / `enemies.air` are its slot arrays) and the same restored ship / missile objects in their saved
   * `sim.fleet.slots` positions (holes kept; `ships.slots` stays a detached index and is not updated afterwards).
   * It is inert until the caller explicitly calls `pass(clock)` (e.g. with `tanks.clock`, which holds the saved
   * sub-tick) or `frame()`; the daily $ACE2 missile step runs when the caller's Sim performs its daily step. Own
   * ships therefore move / fly / get attacked and restored missiles follow the CURRENT occupant of their saved
   * enemy slot. The Sim / tank hooks are whatever `options` supplied (spawn, defection and tank combat are not wired
   * to this system); ship saved-state limits are documented in notes/formats/ship-control.md section 5b.
   */
  readonly enemySystem: EnemySystem;
}
export type Disk4HeadlessEnemyLoadResult = { readonly ok: true; readonly value: PreparedDisk4HeadlessEnemies } | { readonly ok: false; readonly error: Disk4HeadlessEnemyLoadError };

/**
 * Explicitly headless composition over prepareDisk4ShipLoad: adopts the detached enemy roster AND ship roster into an
 * `EnemySystem` / `sim.fleet` (fromRoster with `ships`). `tables` (CombatTables, normally loadCombatTables(disk1)) is
 * required: nothing is defaulted. Any earlier-stage error passes through; a crusher whose +$13 counter is above 7 or
 * whose +$14 animation is above the table maximum, or an unsupported ship state
 * (missile mode outside 1/2/4, lift above $7F), a non-playable +$14 pointer, a saved $1429E count that differs from the
 * occupied ship slots, a corrupt roster or bad tables give one "enemy-system" stage error and no partial value (nothing
 * is installed or written before every record has been validated). Not original post-load behaviour. The
 * experimental Game / MapScene activation (MapScene.fromPrepared) takes this prepared graph as it is.
 */
export function prepareDisk4HeadlessEnemies(
  bytes: Uint8Array,
  request: Disk4LoadRequest,
  tables: CombatTables,
  options: SimOptions = {},
  hooks: EnemyHooks = {},
): Disk4HeadlessEnemyLoadResult {
  const prepared = prepareDisk4ShipLoad(bytes, request, options);
  if (!prepared.ok) return prepared;
  const { sim, tanks, enemies, ships } = prepared.value;
  const system = EnemySystem.fromRoster(sim, tanks, tables, enemies, hooks, ships);
  if (!system.ok) return { ok: false, error: { stage: "enemy-system", error: system.error } };
  return { ok: true, value: { ...prepared.value, enemySystem: system.value } };
}
