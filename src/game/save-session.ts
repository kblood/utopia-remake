// The remake's own saved session (localStorage format version 12; field-by-field list and exclusions in
// notes/formats/remake-save.md). This is NOT the original's Disk.4 save record: nothing here is written to, read from or
// compatible with Disk.4, and no original file, asset or captured RAM is stored. A save is the live state of the remake:
//   - the flat state image, the 7500 map words, the 7650 per-cell flag bytes and the 1000 object records (verbatim),
//   - the fixed-slot own tanks (99), enemy ground (60) / air (30) units, ships and missiles (40) with every field the
//     step code reads, the ShipExtra of each ship (velocity, next mode, turn, reservation cell, missile target slot),
//     the enemy system's legacy gun-countdown compatibility field and remembered launch target,
//   - the pass clock, exact main-loop phase and a pending modal-return pass, the simulation flags (system flags, pause, blast mark (version 10), queued day, warning lights, alien
//     and meteor, spawner position, fuel warning) and the port's RNG counter,
//   - the descriptor exchange parity of `$11024` (`tileExchange`, version 11; versions 2..10 migrate with the disk-menu value 0 and are flagged as assumed),
//   - the eight marker pins and the view origin,
//   - the 30 FIXED effect (explosion) slots, holes kept (version 8; versions 6 and 7 stored a dense list): the pool is
//     gameplay-relevant because a full pool makes a combat explosion fail, which decides whether the enemy's occupancy bit is
//     cleared (map.ts `enemyExplosion`), and because the first-free-slot allocation and the slot order decide the draw-list
//     order of effects (static trace of `$1237C` / `$333A`, effect-pool.ts). `effectSlotsAssumed` records that the slot numbers of
//     a migrated dense list are an assumption,
//   - the raw +$16 flag pointer of EVERY fixed enemy slot (60 ground + 30 air), free slots included: the original never
//     clears it on death (static trace), so a freed slot's stale pointer decides which cell a later enemy that dies before
//     its first move releases (enemies.md section 3b).
// `captureSession` reads, `validateSession` is pure, `restoreSession` replaces the live session only after everything was
// validated and every object built (the commit phase only assigns). Slots keep their numbers and holes: a freed slot stays
// free and the next spawn takes the first free slot, exactly as on the live system.

import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";
import { CELL_FLAG_BYTES, resolveCellFlagPointer } from "./cell-flags.js";
import { Enemy, ENEMY_AIR_TYPES, ENEMY_CRUSHER, ENEMY_GROUND_TYPES, MAX_AIR, MAX_GROUND, type EnemySlotRef, type EnemySystem, type ShipExtraState } from "./enemies.js";
import type { MainLoop } from "./main-loop.js";
import { EFFECT_START, MAX_EFFECTS, type Effect, type EffectPool } from "./effect-pool.js";
import { EFFECT_EXPLOSION, EFFECT_EXPLOSION_HIGH, type Marker } from "./objects.js";
import { isMissile, isRestoredMissile, MAX_SHIPS, type FleetRecord, type MissileRecord, type Ship } from "./sim-ships.js";
import type { Sim } from "./sim.js";
import type { HardwareState } from "./sim-hardware.js";
import { isSaveName } from "./save-name.js";
import { STATE_BYTES } from "./state.js";
import { inMap, MAX_UNITS, Unit, UNIT_ADVANCED, UNIT_BASIC, type UnitSystem } from "./units.js";
import { FIXED_SOLAR_PHASE_STATE, OBJECT_SIZE, OBJECT_SLOTS, type World } from "./world.js";

/**
 * Version of the session shape below. Bump when a field is renamed, removed or changes meaning. Version 12 adds the optional save
 * name (`name`, the slot record's name field of the original; save-name.ts); versions 2..11 migrate with `name` null.
 */
export const SESSION_VERSION = 12;

const MARKER_COUNT = 8;
const NO_MARKER = 0xff;
const VIEW_CELLS = 8; // map.ts VIEW_CELLS
const MAX_SCROLL_X = MAP_WIDTH - VIEW_CELLS;
const MAX_SCROLL_Y = MAP_HEIGHT - VIEW_CELLS;
const CURSOR_START = 0x80; // $12A94 initial value, the largest the spawner cursor can hold

// ---- the saved shapes -----------------------------------------------------------------------------------------------

/** An own tank (fixed slot = its index in `SessionSave.tanks`). */
export interface SavedTank {
  type: number; // 9 basic, 10 advanced
  x: number;
  y: number;
  tech: number;
  dx: number;
  dy: number;
  dir: number;
  vx: number;
  vy: number;
  hp: number;
  /** Full +9 byte (bit 7 = waiting for the move tick). */
  control: number;
  targetX: number;
  targetY: number;
  recent: number[];
  /** The cell holding this unit's occupancy marks (+$14). */
  reserveX: number;
  reserveY: number;
}

/** An enemy ground unit or aircraft (list and slot = where it stands in `SessionSave.enemies`). */
export interface SavedEnemy {
  type: number;
  x: number;
  y: number;
  dir: number;
  hp: number;
  dmg: number;
  bombPct: number;
  dx: number;
  dy: number;
  vx: number;
  vy: number;
  mode: number;
  targetX: number;
  targetY: number;
  recent: number[];
  /**
   * The cell the slot's raw +$16 pointer (`SessionSave.enemies.groundPointers` / `airPointers`) names, or -1 / -1 when that
   * pointer names no playable cell (zero before the first claim). `validateSession` requires exactly that agreement.
   */
  reserveX: number;
  reserveY: number;
  waiting: boolean;
  steps: number;
  aux: number;
  p14: number;
  p15: number;
  /** Crusher only (type 24): +$13 toggle bit, +$13 counter, +$14 animation. Zero/false for every other type. */
  toggle: boolean;
  counter: number;
  anim: number;
  lift: number;
  tech: number;
}

/** The fixed enemy slot a missile follows. */
export interface SavedSlotRef {
  air: boolean;
  index: number;
}

export interface SavedShipExtra {
  vx: number;
  vy: number;
  next: number;
  turn: number;
  /** The cell the ship's map mark sits on; -1 / -1 = none. */
  rx: number;
  ry: number;
  /** Missiles only: the followed enemy slot. null for ships. */
  target: SavedSlotRef | null;
}

/** An own ship (types 11..16) or a launched missile (type 17); fixed slot = its index in `SessionSave.ships`. */
export interface SavedShip {
  kind: "ship" | "missile";
  type: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  dir: number;
  hp: number;
  mode: number;
  tech: number;
  targetX: number;
  targetY: number;
  lift: number;
  /** null for a missile (those bytes are its target pointer). */
  cls: number | null;
  fuel: number | null;
  /** null while the ship has not been stepped or ordered yet (it then gets the usual lazy default). */
  extra: SavedShipExtra | null;
}

/**
 * One live effect (`Effect` of effect-pool.ts) in its fixed slot (= its index in `SessionSave.effectSlots`). A new effect
 * starts at frame 4 and `EffectPool.tick` frees it when the counter would drop below 0, so a live record holds frame 0..4;
 * `lift` is the victim's altitude byte (air kills keep the enemy's saved `lift`, which `ENEMY_SPEC` allows as -128..255; ground
 * and tank kills use 0).
 */
export interface SavedEffect {
  /** 0x12 explosion, 0x14 high (airborne) explosion. */
  type: number;
  x: number;
  y: number;
  frame: number;
  lift: number;
}

export interface SavedSim {
  /** `$156AA` */
  sysFlags: number;
  /** `$156A9` bit 2 */
  paused: boolean;
  /** A day change waits for the next pass (`$156A8` bit 7). */
  dayQueued: boolean;
  /** `$156A9` bit 5, the blast mark left by a missile hit on a free slot (ship-control.md 5e); false in versions 2..9. */
  blastMark: boolean;
  /**
   * The descriptor exchange of `$11024` (sim.ts `tileExchange`): the parity of the traced calls since boot. Version 11+. Versions
   * 2..10 stored none and migrate with 0 (the disk-menu value, save.ts) and `tileExchangeAssumed` set.
   */
  tileExchange: boolean;
  /** True when `tileExchange` was assumed at a migration (versions 2..10); kept true in later saves, since the traced calls cannot verify it. */
  tileExchangeAssumed: boolean;
  /** The port's RNG counter, or null when it was not captured (a legacy save or a custom generator): the target keeps its own. */
  rng: number | null;
  /** Separate deterministic CIA/raster stand-in stream state; null for older saves or custom sources without state access. */
  hardware: HardwareState | null;
  /** `$156B3` */
  fuelWarned: boolean;
  /** Power, event bookmark, food, air: 0 or 255. */
  lights: number[];
  aliens: {
    alien: { x: number; y: number } | null;
    meteor: { x: number; y: number; timer: number } | null;
    /** `$156B2` */
    groupIndex: number;
    /** `$12A94` */
    cursor: number;
  };
}

/** One saved session. Binary parts are typed arrays here; `save.ts` stores them as base64 inside JSON. */
export interface SessionSave {
  /** Index into the scenario records of Disk.2. */
  scenario: number;
  /**
   * The name the player gave the save (save-name.ts): 1..15 characters of the original's name table, or null for a save with no
   * name (the direct `saveToSlot` call, and every version 2..11 save). The slot list shows it in place of the date when present.
   */
  name: string | null;
  scroll: { x: number; y: number };
  state: Uint8Array;
  cells: Uint16Array;
  cellFlags: Uint8Array;
  objects: Uint8Array;
  world: { objectCount: number; solarPhaseRng: number | null };
  sim: SavedSim;
  loop: { vblPerPass: number; vbls: number; passes: number; phase: number; immediatePass: boolean };
  /** `$144C9` sub-tick plus the move / enemy tick flags of the pass. null = not captured: the target's clock is reset. */
  passClock: { sub: number; moveTick: boolean; enemyTick: boolean } | null;
  /** The eight pins (y = 255 unplaced). null = the session had no object layer: the target's pins are cleared. */
  markers: { x: number; y: number }[] | null;
  /** 99 slots, null = free. null = no object layer / not captured: the target's tank slots are emptied. */
  tanks: (SavedTank | null)[] | null;
  /** 60 / 30 slots, null = free. null = no enemy system / not captured: the target's enemy slots are emptied. */
  enemies: {
    ground: (SavedEnemy | null)[];
    air: (SavedEnemy | null)[];
    /** Raw +$16 long of each of the 60 ground / 30 air slots, free slots included (unsigned 32-bit). Version 7+. */
    groundPointers: number[];
    airPointers: number[];
    lastCountdown: number;
    lastTarget: SavedSlotRef | null;
  } | null;
  /** 40 slots, null = free. */
  ships: (SavedShip | null)[];
  /**
   * The 30 fixed effect slots (`$39D4A`, stride 8), null = free; slot index = identity. The OUTER null = the session had no
   * object layer (the target's effects are cleared). Present exactly when `tanks` is (both belong to the object layer).
   */
  effectSlots: (SavedEffect | null)[] | null;
  /**
   * True when the slot numbers of the records are an assumption: the save came from version 6 or 7, which stored the effects
   * as a dense list, so the records are all kept in slots 0..n-1 in list order but their original slots are unknown. The
   * continuation is not claimed exact until the pool drains (the live pool clears the flag when it is empty). Needs at least
   * one record; false without an object layer.
   */
  effectSlotsAssumed: boolean;
}

// ---- typed errors -----------------------------------------------------------------------------------------------------

export type SessionErrorCode =
  /** The live scene is an experimental Disk.4 continuation: it cannot be captured, and a remake save cannot be loaded into it. */
  | "disk4-session"
  /** A record carries Disk.4 provenance (saved bytes / address): the remake save has no place for it. */
  | "disk4-provenance"
  /** An Earth offer waits for an answer: its continuation is a closure that cannot be stored. */
  | "offer-pending"
  /** The live objects do not share one world / flag buffer set (identity), so references would not hold. */
  | "graph"
  /** The live state is outside the domains the save format can load back (so it is not written at all). */
  | "unsupported-state"
  /** The save itself is malformed (shape, length, range, reference). `path` names the field. */
  | "invalid"
  /** The save is well-formed but does not fit the target scene (loop length, missing object layer, RNG support). */
  | "mismatch";

export interface SessionError {
  readonly code: SessionErrorCode;
  readonly message: string;
  /** Field path inside the save, for "invalid". */
  readonly path?: string;
}

export type CaptureResult = { readonly ok: true; readonly value: SessionSave } | { readonly ok: false; readonly error: SessionError };
export type RestoreResult = { readonly ok: true } | { readonly ok: false; readonly error: SessionError };

/** What capture reads and restore replaces: the members of a `MapScene` (`world`, `sim`, `loop`, `objects?.units`, `enemies`, `objects?.markers`, `scrollRef`, `restoredFromDisk4`). */
export interface SessionParts {
  readonly world: World;
  readonly sim: Sim;
  readonly loop: MainLoop;
  readonly units: UnitSystem | null;
  readonly enemies: EnemySystem | null;
  readonly markers: readonly Marker[] | null;
  /** The object layer's live effect pool (restore replaces its slots in place); null without an object layer. */
  readonly effectPool: EffectPool | null;
  /**
   * The object layer's untagged extra drawables (`ObjectLayer.extra`), null without an object layer. They are not part of the
   * traced draw list and have no saved form: capture REFUSES a non-empty list instead of silently dropping it.
   */
  readonly extras?: readonly unknown[] | null;
  /** View origin; read by capture, assigned by restore. */
  readonly scroll: { x: number; y: number };
  readonly restoredFromDisk4: boolean;
}

// ---- validation ---------------------------------------------------------------------------------------------------------

type Range = readonly [number, number];
type Spec = Readonly<Record<string, Range>>;

const BYTE: Range = [0, 255];
const SBYTE: Range = [-128, 127];
const HP: Range = [-128, 255];
const CELL_X: Range = [0, MAP_WIDTH - 1];
const CELL_Y: Range = [0, MAP_HEIGHT - 1];

const TANK_SPEC: Spec = {
  type: [UNIT_BASIC, UNIT_ADVANCED], x: CELL_X, y: CELL_Y, tech: BYTE, dx: SBYTE, dy: SBYTE, dir: [0, 7], vx: SBYTE, vy: SBYTE, hp: HP,
  control: BYTE, targetX: BYTE, targetY: BYTE, reserveX: CELL_X, reserveY: CELL_Y,
};
const ENEMY_SPEC: Spec = {
  x: CELL_X, y: CELL_Y, dir: [0, 7], hp: HP, dmg: BYTE, bombPct: BYTE, dx: SBYTE, dy: SBYTE, vx: SBYTE, vy: SBYTE, mode: BYTE,
  targetX: BYTE, targetY: BYTE, reserveX: [-1, MAP_WIDTH - 1], reserveY: [-1, MAP_HEIGHT - 1], steps: BYTE, aux: [-128, 255], p14: BYTE, p15: BYTE,
  counter: [0, 7], anim: BYTE, lift: [-128, 255], tech: BYTE,
};
const SHIP_SPEC: Spec = {
  x: CELL_X, y: CELL_Y, dx: SBYTE, dy: SBYTE, dir: [0, 8], hp: HP, mode: [0, 8], tech: BYTE, targetX: BYTE, targetY: BYTE, lift: [0, 0x7f],
};
const EFFECT_SPEC: Spec = { x: CELL_X, y: CELL_Y, frame: [0, EFFECT_START], lift: [-128, 255] };
const EFFECT_TYPES: readonly number[] = [EFFECT_EXPLOSION, EFFECT_EXPLOSION_HIGH];
const EXTRA_SPEC: Spec = { vx: SBYTE, vy: SBYTE, next: BYTE, turn: [0, 7], rx: [-1, MAP_WIDTH - 1], ry: [-1, MAP_HEIGHT - 1] };

const invalid = (path: string, message: string): SessionError => ({ code: "invalid", path, message: `${path}: ${message}` });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function checkInts(value: unknown, spec: Spec, path: string): SessionError | null {
  if (!isObject(value)) return invalid(path, "is not an object");
  for (const key of Object.keys(spec)) {
    const [lo, hi] = spec[key];
    if (!isInt(value[key], lo, hi)) return invalid(`${path}.${key}`, `must be an integer in ${lo}..${hi}`);
  }
  return null;
}

function checkRecent(value: unknown, path: string): SessionError | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => isInt(v, 0, 255))) return invalid(`${path}.recent`, "must be three bytes");
  return null;
}

function checkSlotRef(value: unknown, path: string): SessionError | null {
  if (!isObject(value) || typeof value.air !== "boolean") return invalid(path, "is not a { air, index } enemy slot");
  const limit = value.air ? MAX_AIR : MAX_GROUND;
  if (!isInt(value.index, 0, limit - 1)) return invalid(`${path}.index`, `must be an integer in 0..${limit - 1} (the ${value.air ? "air" : "ground"} list has ${limit} slots)`);
  return null;
}

function checkTank(value: unknown, path: string): SessionError | null {
  return checkInts(value, TANK_SPEC, path) ?? checkRecent((value as Record<string, unknown>).recent, path);
}

function checkEnemy(value: unknown, air: boolean, path: string): SessionError | null {
  const bad = checkInts(value, ENEMY_SPEC, path);
  if (bad) return bad;
  const e = value as unknown as SavedEnemy;
  const types = air ? ENEMY_AIR_TYPES : ENEMY_GROUND_TYPES;
  if (!types.includes(e.type)) return invalid(`${path}.type`, `${e.type} is not a ${air ? "flying" : "ground"} enemy type (${types.join(", ")})`);
  if (typeof e.waiting !== "boolean") return invalid(`${path}.waiting`, "must be a boolean");
  if ((e.reserveX === -1) !== (e.reserveY === -1)) return invalid(`${path}.reserveX`, "reserveX and reserveY are both -1 (no reservation cell) or both a map cell");
  if (typeof e.toggle !== "boolean") return invalid(`${path}.toggle`, "must be a boolean");
  if ((air || e.type !== ENEMY_CRUSHER) && (e.toggle || e.counter !== 0 || e.anim !== 0)) return invalid(`${path}.toggle`, "toggle, counter and animation belong to crushers (type 24) only");
  return checkRecent(e.recent, path);
}

/**
 * The raw +$16 pointer arrays of the enemy slots: exactly `records.length` unsigned 32-bit longs (free slots included), and
 * every occupied record's reservation cell must be the playable cell its slot's pointer names (-1 / -1 for none).
 */
function checkPointers(pointers: unknown, records: readonly (SavedEnemy | null)[], path: string): SessionError | null {
  if (!Array.isArray(pointers) || pointers.length !== records.length) return invalid(path, `must be an array of exactly ${records.length} unsigned 32-bit longs (one per slot, free slots included)`);
  for (let i = 0; i < records.length; i++) {
    if (!isInt(pointers[i], 0, 0xffffffff)) return invalid(`${path}[${i}]`, "must be an unsigned 32-bit integer");
  }
  for (let i = 0; i < records.length; i++) {
    const e = records[i];
    if (e === null) continue;
    const t = resolveCellFlagPointer(pointers[i] as number);
    const x = t.kind === "playable" ? t.x : -1;
    const y = t.kind === "playable" ? t.y : -1;
    if (e.reserveX !== x || e.reserveY !== y) {
      return invalid(`${path}[${i}]`, `the pointer names ${x < 0 ? "no playable cell" : `cell (${x}, ${y})`} but the slot's enemy reserves (${e.reserveX}, ${e.reserveY})`);
    }
  }
  return null;
}

function checkShip(value: unknown, path: string): SessionError | null {
  const bad = checkInts(value, SHIP_SPEC, path);
  if (bad) return bad;
  const s = value as unknown as SavedShip;
  if (s.kind !== "ship" && s.kind !== "missile") return invalid(`${path}.kind`, 'must be "ship" or "missile"');
  if (s.kind === "ship") {
    if (!isInt(s.type, 11, 16)) return invalid(`${path}.type`, "a ship is type 11..16");
    if (s.cls !== s.type - 11) return invalid(`${path}.cls`, `must be ${s.type - 11} (type - 11)`);
    if (!isInt(s.fuel, -0x8000, 0xffff)) return invalid(`${path}.fuel`, "must be an integer in -32768..65535 (a negative word means unlimited)");
  } else {
    if (s.type !== 17) return invalid(`${path}.type`, "a missile is type 17");
    if (s.cls !== null || s.fuel !== null) return invalid(`${path}.cls`, "a missile has no class and no fuel");
    if (s.mode !== 1 && s.mode !== 2 && s.mode !== 4) return invalid(`${path}.mode`, "a missile is in mode 1, 2 or 4");
  }
  if (s.extra === null) {
    return s.kind === "missile" ? invalid(`${path}.extra`, "a missile always has its target slot") : null;
  }
  const extraBad = checkInts(s.extra, EXTRA_SPEC, `${path}.extra`);
  if (extraBad) return extraBad;
  if ((s.extra.rx === -1) !== (s.extra.ry === -1)) return invalid(`${path}.extra.rx`, "rx and ry are both -1 (no reservation) or both a map cell");
  if (s.kind === "ship") return s.extra.target === null ? null : invalid(`${path}.extra.target`, "a ship follows no enemy slot");
  return checkSlotRef(s.extra.target, `${path}.extra.target`);
}

function checkEffect(value: unknown, path: string): SessionError | null {
  const bad = checkInts(value, EFFECT_SPEC, path);
  if (bad) return bad;
  const type = (value as SavedEffect).type;
  if (!EFFECT_TYPES.includes(type)) return invalid(`${path}.type`, `${String(type)} is not an effect type (${EFFECT_TYPES.map((t) => `0x${t.toString(16)}`).join(", ")})`);
  return null;
}

function checkArray(value: unknown, length: number, path: string, each: (item: unknown, path: string) => SessionError | null): SessionError | null {
  if (!Array.isArray(value) || value.length !== length) return invalid(path, `must be an array of exactly ${length} slots`);
  for (let i = 0; i < length; i++) {
    if (value[i] === null) continue;
    const bad = each(value[i], `${path}[${i}]`);
    if (bad) return bad;
  }
  return null;
}

/**
 * Checks a save on its own, without any live object: types, buffer lengths, integer ranges, slot counts, list/type
 * agreement, missile slot references and the loop/clock arithmetic. Pure; returns the first problem, null when sound.
 * Cell-level coherence (an occupancy bit under every reservation) is NOT checked: the map words and flag bytes are
 * restored verbatim, as the live system holds them.
 */
export function validateSession(save: unknown): SessionError | null {
  if (!isObject(save)) return invalid("save", "is not an object");
  if (!isInt(save.scenario, 0, 0xffff)) return invalid("scenario", "must be an integer in 0..65535");
  if (save.name !== null && !isSaveName(save.name)) return invalid("name", "must be null or 1..15 characters from the name table (uppercase letters, digits, - = \\ , . / and space)");
  if (!isObject(save.scroll) || !isInt(save.scroll.x, 0, MAX_SCROLL_X) || !isInt(save.scroll.y, 0, MAX_SCROLL_Y)) {
    return invalid("scroll", `must be { x: 0..${MAX_SCROLL_X}, y: 0..${MAX_SCROLL_Y} }`);
  }
  if (!(save.state instanceof Uint8Array) || save.state.length !== STATE_BYTES) return invalid("state", `must be a Uint8Array of exactly ${STATE_BYTES} bytes`);
  if (!(save.cells instanceof Uint16Array) || save.cells.length !== MAP_WIDTH * MAP_HEIGHT) return invalid("cells", `must be a Uint16Array of exactly ${MAP_WIDTH * MAP_HEIGHT} words`);
  if (!(save.cellFlags instanceof Uint8Array) || save.cellFlags.length !== CELL_FLAG_BYTES) return invalid("cellFlags", `must be a Uint8Array of exactly ${CELL_FLAG_BYTES} bytes`);
  if (!(save.objects instanceof Uint8Array) || save.objects.length !== OBJECT_SLOTS * OBJECT_SIZE) return invalid("objects", `must be a Uint8Array of exactly ${OBJECT_SLOTS * OBJECT_SIZE} bytes`);
  if (!isObject(save.world) || !isInt(save.world.objectCount, 0, OBJECT_SLOTS)) return invalid("world.objectCount", `must be an integer in 0..${OBJECT_SLOTS}`);
  if (save.world.solarPhaseRng !== null && !isInt(save.world.solarPhaseRng, 0, 0xffffffff)) return invalid("world.solarPhaseRng", "must be null or an unsigned 32-bit integer");

  const sim = save.sim;
  if (!isObject(sim)) return invalid("sim", "is not an object");
  if (!isInt(sim.sysFlags, 0, 255)) return invalid("sim.sysFlags", "must be a byte");
  if (typeof sim.paused !== "boolean") return invalid("sim.paused", "must be a boolean");
  if (typeof sim.dayQueued !== "boolean") return invalid("sim.dayQueued", "must be a boolean");
  if (typeof sim.blastMark !== "boolean") return invalid("sim.blastMark", "must be a boolean");
  if (typeof sim.tileExchange !== "boolean") return invalid("sim.tileExchange", "must be a boolean");
  if (typeof sim.tileExchangeAssumed !== "boolean") return invalid("sim.tileExchangeAssumed", "must be a boolean");
  if (sim.rng !== null && !isInt(sim.rng, 0, 0xffffffff)) return invalid("sim.rng", "must be null or an unsigned 32-bit integer");
  if (sim.hardware !== null && (!isObject(sim.hardware) || !isInt(sim.hardware.tod, 0, 0xffffffff) || !isInt(sim.hardware.raster, 0, 0xffffffff))) {
    return invalid("sim.hardware", "must be null or contain unsigned 32-bit tod and raster counters");
  }
  if (typeof sim.fuelWarned !== "boolean") return invalid("sim.fuelWarned", "must be a boolean");
  if (!Array.isArray(sim.lights) || sim.lights.length !== 4 || !sim.lights.every((v) => v === 0 || v === 255)) return invalid("sim.lights", "must be four values of 0 or 255");
  const aliens = sim.aliens;
  if (!isObject(aliens)) return invalid("sim.aliens", "is not an object");
  if (aliens.alien !== null && (!isObject(aliens.alien) || !isInt(aliens.alien.x, 0, 255) || !isInt(aliens.alien.y, 0, 255))) return invalid("sim.aliens.alien", "must be null or { x, y } bytes");
  if (aliens.meteor !== null) {
    const bad = checkInts(aliens.meteor, { x: CELL_X, y: CELL_Y, timer: [1, 255] }, "sim.aliens.meteor");
    if (bad) return bad;
  }
  if (!isInt(aliens.groupIndex, 0, 15)) return invalid("sim.aliens.groupIndex", "must be an integer in 0..15");
  if (!isInt(aliens.cursor, 0, CURSOR_START)) return invalid("sim.aliens.cursor", `must be an integer in 0..${CURSOR_START}`);

  const loop = save.loop;
  if (!isObject(loop) || !isInt(loop.vblPerPass, 1, 1000) || !isInt(loop.vbls, 0, Number.MAX_SAFE_INTEGER) ||
    !isInt(loop.passes, 0, Number.MAX_SAFE_INTEGER) || !isInt(loop.phase, 0, loop.vblPerPass - 1) || typeof loop.immediatePass !== "boolean") {
    return invalid("loop", "must include vblPerPass, vbls, passes, phase and immediatePass with valid ranges");
  }
  if (loop.passes > loop.vbls) return invalid("loop.passes", "cannot exceed the number of video updates");

  const clock = save.passClock;
  if (clock !== null) {
    if (!isObject(clock) || !isInt(clock.sub, 0, 8) || typeof clock.moveTick !== "boolean" || typeof clock.enemyTick !== "boolean") return invalid("passClock", "must be { sub: 0..8, moveTick, enemyTick }");
    if (clock.moveTick && clock.sub !== 0) return invalid("passClock.moveTick", "the move tick exists only on sub-tick 0");
    if (clock.enemyTick && clock.sub !== 4) return invalid("passClock.enemyTick", "the enemy tick exists only on sub-tick 4");
  }

  if (save.markers !== null) {
    if (!Array.isArray(save.markers) || save.markers.length !== MARKER_COUNT) return invalid("markers", `must be null or ${MARKER_COUNT} pins`);
    for (let i = 0; i < MARKER_COUNT; i++) {
      const m = save.markers[i];
      if (!isObject(m) || !isInt(m.x, 0, 255) || !isInt(m.y, 0, 255)) return invalid(`markers[${i}]`, "must be { x, y } bytes");
      if (m.y !== NO_MARKER && !inMap(m.x as number, m.y as number)) return invalid(`markers[${i}]`, `a placed pin (y != ${NO_MARKER}) must be on a map cell`);
    }
  }

  if (save.tanks !== null) {
    const bad = checkArray(save.tanks, MAX_UNITS, "tanks", checkTank);
    if (bad) return bad;
    if (save.markers === null) return invalid("markers", "a session with tanks has the eight marker pins");
  }
  if (save.enemies !== null) {
    const enemies = save.enemies;
    if (!isObject(enemies)) return invalid("enemies", "is not an object");
    if (save.tanks === null) return invalid("enemies", "enemies need the tank / object layer they belong to");
    const bad = checkArray(enemies.ground, MAX_GROUND, "enemies.ground", (e, p) => checkEnemy(e, false, p)) ?? checkArray(enemies.air, MAX_AIR, "enemies.air", (e, p) => checkEnemy(e, true, p));
    if (bad) return bad;
    const pointerBad = checkPointers(enemies.groundPointers, enemies.ground as (SavedEnemy | null)[], "enemies.groundPointers") ?? checkPointers(enemies.airPointers, enemies.air as (SavedEnemy | null)[], "enemies.airPointers");
    if (pointerBad) return pointerBad;
    if (!isInt(enemies.lastCountdown, -1, 255)) return invalid("enemies.lastCountdown", "must be an integer in -1..255");
    if (enemies.lastTarget !== null) {
      const refBad = checkSlotRef(enemies.lastTarget, "enemies.lastTarget");
      if (refBad) return refBad;
    }
  }
  const shipBad = checkArray(save.ships, MAX_SHIPS, "ships", checkShip);
  if (shipBad) return shipBad;
  if (save.enemies === null && (save.ships as (SavedShip | null)[]).some((s) => s !== null && s.extra !== null)) return invalid("ships", "ship extras need the enemy system they belong to");

  if (typeof save.effectSlotsAssumed !== "boolean") return invalid("effectSlotsAssumed", "must be a boolean");
  if (save.effectSlots !== null) {
    if (save.tanks === null) return invalid("effectSlots", "effect slots belong to the object layer, which a session without tanks does not have");
    const bad = checkArray(save.effectSlots, MAX_EFFECTS, "effectSlots", checkEffect);
    if (bad) return bad;
    if (save.effectSlotsAssumed && (save.effectSlots as (SavedEffect | null)[]).every((e) => e === null)) {
      return invalid("effectSlotsAssumed", "assumed slot numbers need at least one effect record (an empty pool is exact)");
    }
  } else {
    if (save.tanks !== null) return invalid("effectSlots", `a session with an object layer has ${MAX_EFFECTS} effect slots (all null when empty)`);
    if (save.effectSlotsAssumed) return invalid("effectSlotsAssumed", "a session without an object layer has no effect slots to assume");
  }
  return null;
}

/**
 * Checks one effect record on its own (type, cell, frame, lift). Exported for the migration of the dense effect list of
 * versions 6 and 7 (save.ts), which must apply exactly the same record rules before converting.
 */
export function validateEffectRecord(value: unknown, path: string): SessionError | null {
  return checkEffect(value, path);
}

// ---- capture ---------------------------------------------------------------------------------------------------------------

const fail = (code: SessionErrorCode, message: string): { ok: false; error: SessionError } => ({ ok: false, error: { code, message } });

/** Cheap structural identity checks shared by capture and restore: one world, one flag buffer, one Sim. */
function graphProblem(parts: SessionParts): string | null {
  const { world, sim, units, enemies } = parts;
  if (sim.world !== world) return "the Sim runs over another world";
  if (units && !units.usesBuffers(world.cells, world.cellFlags)) return "the tank system runs over other map or flag buffers than the world";
  if (enemies && (!units || !enemies.isComposedOf(sim, units))) return "the enemy system is not composed of this Sim and tank system";
  if (parts.markers && parts.markers.length !== MARKER_COUNT) return `the object layer has ${parts.markers.length} marker pins, expected ${MARKER_COUNT}`;
  if ((parts.effectPool === null) !== (units === null)) return "the effect pool and the tank system must both belong to an object layer or both be absent";
  return null;
}

function savedTank(u: Unit): SavedTank {
  return {
    type: u.type, x: u.x, y: u.y, tech: u.tech, dx: u.dx, dy: u.dy, dir: u.dir, vx: u.vx, vy: u.vy, hp: u.hp, control: u.control,
    targetX: u.targetX, targetY: u.targetY, recent: [...u.recent], reserveX: u.reserveX, reserveY: u.reserveY,
  };
}

function savedEffect(e: Effect | null): SavedEffect | null {
  return e === null ? null : { type: e.type, x: e.x, y: e.y, frame: e.frame, lift: e.lift };
}

function savedEnemy(e: Enemy): SavedEnemy {
  return {
    type: e.type, x: e.x, y: e.y, dir: e.dir, hp: e.hp, dmg: e.dmg, bombPct: e.bombPct, dx: e.dx, dy: e.dy, vx: e.vx, vy: e.vy, mode: e.mode,
    targetX: e.targetX, targetY: e.targetY, recent: [...e.recent], reserveX: e.reserveX, reserveY: e.reserveY, waiting: e.waiting,
    steps: e.steps, aux: e.aux, p14: e.p14, p15: e.p15, toggle: e.toggle, counter: e.counter, anim: e.anim, lift: e.lift, tech: e.tech,
  };
}

function savedShip(record: FleetRecord, enemies: EnemySystem | null): SavedShip {
  const missile = isMissile(record);
  const inspected = enemies?.inspectShip(record) ?? null;
  return {
    kind: missile ? "missile" : "ship", type: record.type, x: record.x, y: record.y, dx: record.dx, dy: record.dy, dir: record.dir, hp: record.hp,
    mode: record.mode, tech: record.tech, targetX: record.targetX, targetY: record.targetY, lift: record.lift,
    cls: missile ? null : (record as Ship).cls, fuel: missile ? null : (record as Ship).fuel,
    extra: inspected
      ? { vx: inspected.vx, vy: inspected.vy, next: inspected.next, turn: inspected.turn, rx: inspected.rx, ry: inspected.ry, target: inspected.targetSlot ? { air: inspected.targetSlot.air, index: inspected.targetSlot.index } : null }
      : null,
  };
}

/**
 * Takes one remake save of the live session. Reads only: no state, RNG, hook, map or flag byte is touched and the result
 * shares no array or object with the live graph. Refuses (typed error, nothing returned) for an experimental Disk.4 session
 * or any record with Disk.4 provenance, for a pending Earth offer, for a graph whose buffers are not shared, and for live
 * state the format could not load back (e.g. an effect with an unknown type or a frame outside 0..4). Call it at an idle
 * point (the disk menu is one): the Sim message / event queues, message log and UI modes are not part of a save; the effect
 * list is, as detached copies (no sound, hook or allocation happens).
 */
export function captureSession(parts: SessionParts, scenario: number): CaptureResult {
  if (parts.restoredFromDisk4) return fail("disk4-session", "A Disk.4 continuation cannot be saved: the remake save does not hold its state and original Disk.4 export does not exist");
  const { world, sim, loop, units, enemies } = parts;
  const problem = graphProblem(parts);
  if (problem) return fail("graph", problem);
  if (sim.pending) return fail("offer-pending", "An Earth offer is waiting for an answer: answer it first, its continuation cannot be stored");
  if (parts.extras && parts.extras.length > 0) {
    return fail("unsupported-state", `The object layer holds ${parts.extras.length} unregistered extra drawable(s): they are outside the traced draw list and have no saved form, so the session is not saved instead of losing them silently`);
  }

  let tanks: (SavedTank | null)[] | null = null;
  if (units) {
    tanks = [];
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units.slots[i];
      if (u === null) {
        tanks.push(null);
        continue;
      }
      if (u.sourceRaw !== null || u.sourceAddress !== null || u.flagPointer !== null) return fail("disk4-provenance", `Tank slot ${i} carries Disk.4 provenance`);
      if (u.slot !== i) return fail("graph", `Tank slot ${i} holds a unit that says it is slot ${u.slot}`);
      tanks.push(savedTank(u));
    }
  }

  let enemyPart: SessionSave["enemies"] = null;
  if (enemies) {
    const list = (slots: readonly (Enemy | null)[], name: string): (SavedEnemy | null)[] | SessionError => {
      const out: (SavedEnemy | null)[] = [];
      for (let i = 0; i < slots.length; i++) {
        const e = slots[i];
        if (e === null) {
          out.push(null);
          continue;
        }
        if (e.sourceRaw !== null || e.sourceAddress !== null || e.flagPointer !== null || e.savedControl !== null) return { code: "disk4-provenance", message: `${name} slot ${i} carries Disk.4 provenance` };
        out.push(savedEnemy(e));
      }
      return out;
    };
    const ground = list(enemies.groundSlots, "Enemy ground");
    if (!Array.isArray(ground)) return { ok: false, error: ground };
    const air = list(enemies.airSlots, "Enemy air");
    if (!Array.isArray(air)) return { ok: false, error: air };
    const { lastCountdown, lastTarget } = enemies.sessionState;
    // Detached copies of the raw per-slot +$16 longs, free slots included (nothing shares an array with the live system).
    enemyPart = {
      ground, air, groundPointers: enemies.groundFlagPointers.slice(), airPointers: enemies.airFlagPointers.slice(),
      lastCountdown, lastTarget: lastTarget ? { air: lastTarget.air, index: lastTarget.index } : null,
    };
  }

  const ships: (SavedShip | null)[] = [];
  for (let i = 0; i < MAX_SHIPS; i++) {
    const r = sim.fleet.slots[i];
    if (r === null || r === undefined) {
      ships.push(null);
      continue;
    }
    if (isRestoredMissile(r) || "sourceRaw" in r) return fail("disk4-provenance", `Ship slot ${i} carries Disk.4 provenance`);
    ships.push(savedShip(r, enemies));
  }

  const lights = Array.from(sim.alerts.flags);
  const alien = sim.aliens.alien;
  const meteor = sim.aliens.meteor;
  const spawner = sim.aliens.spawner;
  const clock = units?.clock ?? null;
  const save: SessionSave = {
    scenario,
    name: null, // the caller names the save (`Game.saveToSlot`); a capture alone has no name
    scroll: { x: parts.scroll.x, y: parts.scroll.y },
    state: world.state.snapshot(),
    cells: world.cells.slice(),
    cellFlags: world.cellFlags.slice(),
    objects: world.objects.slice(),
    world: { objectCount: world.objectCount, solarPhaseRng: world.solarPhaseRngState },
    sim: {
      sysFlags: sim.sysFlags, paused: sim.paused, dayQueued: sim.dayQueued, blastMark: sim.blastMark, tileExchange: sim.tileExchange, tileExchangeAssumed: sim.tileExchangeAssumed, rng: sim.rngState, hardware: sim.hardwareState, fuelWarned: sim.fleet.fuelWarned, lights,
      aliens: { alien: alien ? { x: alien.x, y: alien.y } : null, meteor: meteor ? { x: meteor.x, y: meteor.y, timer: meteor.timer } : null, groupIndex: spawner.groupIndex, cursor: spawner.cursor },
    },
    loop: { vblPerPass: loop.vblPerPass, vbls: loop.vbls, passes: loop.passes, phase: loop.updatesIntoPass, immediatePass: loop.immediatePassPending },
    passClock: clock ? { sub: clock.sub, moveTick: clock.moveTick, enemyTick: clock.enemyTick } : null,
    markers: parts.markers ? parts.markers.map((m) => ({ x: m.x, y: m.y })) : null,
    tanks,
    enemies: enemyPart,
    ships,
    effectSlots: parts.effectPool ? parts.effectPool.slots.map(savedEffect) : null,
    effectSlotsAssumed: parts.effectPool ? parts.effectPool.assumedSlots : false,
  };
  const bad = validateSession(save);
  if (bad) return fail("unsupported-state", `The live state is outside what the save format can load back and was not saved (${bad.message})`);
  return { ok: true, value: save };
}

// ---- restore -----------------------------------------------------------------------------------------------------------------

function buildTank(t: SavedTank, slot: number): Unit {
  const u = new Unit(t.type, t.x, t.y, t.tech, slot);
  u.dx = t.dx;
  u.dy = t.dy;
  u.dir = t.dir;
  u.vx = t.vx;
  u.vy = t.vy;
  u.hp = t.hp;
  u.control = t.control;
  u.targetX = t.targetX;
  u.targetY = t.targetY;
  u.recent = [t.recent[0], t.recent[1], t.recent[2]];
  u.reserveX = t.reserveX;
  u.reserveY = t.reserveY;
  return u;
}

function buildEnemy(s: SavedEnemy, air: boolean): Enemy {
  const e = new Enemy(s.type, s.x, s.y, s.dir, s.hp, s.dmg, s.bombPct, air);
  e.dx = s.dx;
  e.dy = s.dy;
  e.vx = s.vx;
  e.vy = s.vy;
  e.mode = s.mode;
  e.targetX = s.targetX;
  e.targetY = s.targetY;
  e.recent = [s.recent[0], s.recent[1], s.recent[2]];
  e.reserveX = s.reserveX;
  e.reserveY = s.reserveY;
  e.waiting = s.waiting;
  e.steps = s.steps;
  e.aux = s.aux;
  e.p14 = s.p14;
  e.p15 = s.p15;
  e.toggle = s.toggle;
  e.counter = s.counter;
  e.anim = s.anim;
  e.lift = s.lift;
  e.tech = s.tech;
  return e;
}

function buildShip(s: SavedShip): { record: FleetRecord; extra: ShipExtraState | null } {
  const core = { type: s.type, x: s.x, y: s.y, dx: s.dx, dy: s.dy, dir: s.dir, hp: s.hp, mode: s.mode, tech: s.tech, targetX: s.targetX, targetY: s.targetY, lift: s.lift };
  const record: FleetRecord = s.kind === "missile" ? ({ kind: "missile", ...core, type: 17 } as MissileRecord) : ({ ...core, cls: s.cls as number, fuel: s.fuel as number } as Ship);
  const x = s.extra;
  const extra: ShipExtraState | null = x
    ? { vx: x.vx, vy: x.vy, next: x.next, turn: x.turn, rx: x.rx, ry: x.ry, targetSlot: x.target ? { air: x.target.air, index: x.target.index } : null }
    : null;
  return { record, extra };
}

/**
 * Replaces the live session in `parts` with `save`. Order: (1) `validateSession(save)`, (2) compatibility with the target
 * (not a Disk.4 scene, one shared world / flag buffer set, same pass length, matching object layer / enemy system, RNG
 * support), (3) every Unit / Enemy / ship record is built detached, (4) only then the commit, which just assigns and
 * copies already-sized buffers. Any refusal returns before step 4, so a rejected save never changes the live session.
 *
 * Replaced: state image, map words, flag bytes, object records and count, tank / enemy / ship slots (holes kept) and
 * ship extras, the raw +$16 pointer of every enemy slot (free ones too), legacy gun-countdown field and remembered launch target, pass clock, loop position, system flags, pause, queued day,
 * warning lights, alien / meteor / spawner, fuel warning, solar phase RNG, markers, the 30 effect slots (new Effect objects, slot numbers and holes kept, assumption flag),
 * view origin, RNG counters (when saved). Emptied: the
 * Sim message and event queues and a pending offer (a save holds none). Left alone: callbacks, sprites, tiles, the message
 * log, UI modes, the untagged `ObjectLayer.extra` list and everything that is not gameplay state. A `null` section of the save empties its target (effects too).
 */
export function restoreSession(save: SessionSave, parts: SessionParts): RestoreResult {
  const bad = validateSession(save);
  if (bad) return { ok: false, error: bad };
  if (parts.restoredFromDisk4) return fail("disk4-session", "A remake save cannot be loaded into a Disk.4 continuation scene");
  const { world, sim, loop, units, enemies, markers, effectPool } = parts;
  const problem = graphProblem(parts);
  if (problem) return fail("graph", problem);
  if (loop.vblPerPass !== save.loop.vblPerPass) return fail("mismatch", `The save was made with ${save.loop.vblPerPass} video updates per pass, this scene runs ${loop.vblPerPass}`);
  if ((save.tanks !== null || save.effectSlots !== null) && (!units || !markers || !effectPool)) return fail("mismatch", "The save has tanks, marker pins and effects but this scene has no object layer");
  if (save.enemies !== null && !enemies) return fail("mismatch", "The save has enemies but this scene has no enemy system");
  if (save.sim.rng !== null && sim.rngState === null) return fail("mismatch", "The save has an RNG counter but this Sim uses a generator that cannot be set");
  if (save.sim.hardware !== null && sim.hardwareState === null) return fail("mismatch", "The save has hardware-approximation counters but this Sim uses a source that cannot be restored");
  if (!enemies && save.ships.some((s) => s !== null && s.extra !== null)) return fail("mismatch", "The save has ship extras but this scene has no enemy system");

  // Detached objects (nothing live is touched until the commit below).
  const tanks: (Unit | null)[] = new Array<Unit | null>(MAX_UNITS).fill(null);
  if (save.tanks) save.tanks.forEach((t, i) => { tanks[i] = t ? buildTank(t, i) : null; });
  const ground: (Enemy | null)[] = new Array<Enemy | null>(MAX_GROUND).fill(null);
  const air: (Enemy | null)[] = new Array<Enemy | null>(MAX_AIR).fill(null);
  const groundPointers: number[] = new Array<number>(MAX_GROUND).fill(0);
  const airPointers: number[] = new Array<number>(MAX_AIR).fill(0);
  if (save.enemies) {
    save.enemies.ground.forEach((e, i) => { ground[i] = e ? buildEnemy(e, false) : null; });
    save.enemies.air.forEach((e, i) => { air[i] = e ? buildEnemy(e, true) : null; });
    save.enemies.groundPointers.forEach((p, i) => { groundPointers[i] = p; });
    save.enemies.airPointers.forEach((p, i) => { airPointers[i] = p; });
  }
  const records: (FleetRecord | null)[] = new Array<FleetRecord | null>(MAX_SHIPS).fill(null);
  const extras: (ShipExtraState | null)[] = new Array<ShipExtraState | null>(MAX_SHIPS).fill(null);
  save.ships.forEach((s, i) => {
    if (!s) return;
    const built = buildShip(s);
    records[i] = built.record;
    extras[i] = built.extra;
  });
  const builtEffects: (Effect | null)[] = new Array<Effect | null>(MAX_EFFECTS).fill(null);
  if (save.effectSlots) save.effectSlots.forEach((e, i) => { builtEffects[i] = e ? { type: e.type, x: e.x, y: e.y, frame: e.frame, lift: e.lift } : null; });
  const enemyPart = save.enemies;
  const lastTarget: EnemySlotRef | null = enemyPart?.lastTarget ? { air: enemyPart.lastTarget.air, index: enemyPart.lastTarget.index } : null;

  // installSession is the only commit helper that can return a refusal. Call it before changing world / sim / loop
  // state; it validates all array shapes and raw pointer values before its first assignment, so false leaves the target
  // untouched and the rest of this commit consists only of validated fixed-size copies and scalar assignments.
  if (enemies && !enemies.installSession({
    ground, air, groundPointers, airPointers, ships: records, shipExtras: extras,
    lastCountdown: enemyPart?.lastCountdown ?? -1, lastTarget,
  })) return fail("mismatch", "The enemy system refused the fixed-slot restore package");

  // ---- commit: assignments and copies of validated, equally sized data only ----
  world.state.restore(save.state);
  world.cells.set(save.cells);
  world.cellFlags.set(save.cellFlags);
  world.objects.set(save.objects);
  world.objectCount = save.world.objectCount;
  // A save without the stream (versions 2-3, version-less) has no state to continue: the fixed state, not the scene's
  // host-random seed (World's constructor uses Math.random for a new world), so the same slot always loads the same stream.
  world.restoreSolarPhaseRngState(save.world.solarPhaseRng ?? FIXED_SOLAR_PHASE_STATE);

  sim.sysFlags = save.sim.sysFlags;
  sim.paused = save.sim.paused;
  sim.dayQueued = save.sim.dayQueued;
  sim.blastMark = save.sim.blastMark;
  sim.tileExchange = save.sim.tileExchange;
  sim.tileExchangeAssumed = save.sim.tileExchangeAssumed;
  sim.pending = null;
  sim.messages.length = 0;
  sim.events.length = 0;
  if (save.sim.rng !== null) sim.restoreRngState(save.sim.rng);
  if (save.sim.hardware !== null) sim.restoreHardwareState(save.sim.hardware);
  sim.fleet.fuelWarned = save.sim.fuelWarned;
  sim.alerts.flags.set(save.sim.lights);
  const a = save.sim.aliens;
  sim.aliens.alien = a.alien ? { x: a.alien.x, y: a.alien.y } : null;
  sim.aliens.meteor = a.meteor ? { x: a.meteor.x, y: a.meteor.y, timer: a.meteor.timer } : null;
  sim.aliens.restoreSpawner(a.groupIndex, a.cursor);

  if (!loop.restoreState(save.loop.vbls, save.loop.passes, save.loop.phase, save.loop.immediatePass)) {
    return fail("mismatch", "The save's main-loop scheduler state could not be restored");
  }

  if (units) {
    for (let i = 0; i < MAX_UNITS; i++) units.slots[i] = tanks[i];
    units.clock.sub = save.passClock?.sub ?? 0;
    units.clock.moveTick = save.passClock?.moveTick ?? false;
    units.clock.enemyTick = save.passClock?.enemyTick ?? false;
  }
  if (markers) {
    for (let i = 0; i < MARKER_COUNT; i++) {
      const saved = save.markers?.[i];
      markers[i].x = saved ? saved.x : 0;
      markers[i].y = saved ? saved.y : NO_MARKER;
    }
  }
  if (effectPool) effectPool.restore(builtEffects, save.effectSlotsAssumed); // in place, slot for slot; a null section empties it, like tanks
  if (!enemies) {
    for (let i = 0; i < MAX_SHIPS; i++) sim.fleet.slots[i] = records[i];
  }
  parts.scroll.x = save.scroll.x;
  parts.scroll.y = save.scroll.y;
  return { ok: true };
}
