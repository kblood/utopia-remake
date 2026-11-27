// Opt-in, observational runtime checkpoints of the live map loop (notes/formats/runtime-checkpoints.md).
//
// Purpose: compare original debugger observations with the remake at aligned main-loop pass boundaries. A checkpoint
// is a deep-frozen, JSON-serializable copy of the evidence-backed runtime state taken at ONE point of
// `MapScene.update()`: after a completed normal pass has redrawn, advanced the date, run periodic work and polled input;
// modal checkpoints instead follow menu input and redraw without simulation work.
// Nothing here writes game state, draws RNG, calls a game hook
// or reads input; the only game-side hooks are two passive read paths (`EnemySystem.inspectShip`,
// `Messages.observer` / `inspect`). Nothing is persisted, logged or sent anywhere: checkpoints live in the memory of
// the recorder the caller created, and `onCheckpoint` is the caller's own callback.
//
// Not included on purpose: original asset bytes or hashes (no map, tile, picture, string or sound content, no
// state-image dump or digest), the RNG state (a closure inside Sim, not observable without touching it), and
// message text (only string-table indices are exposed).

import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";
import { DISK4_ADDR } from "../data/disk4-state.js";
import { cellFlagIndex, cellFlagPointer, mapIndex } from "./cell-flags.js";
import { ENEMY_CRUSHER, type Enemy, type EnemySystem } from "./enemies.js";
import type { MainLoop } from "./main-loop.js";
import type { Effect } from "./effect-pool.js";
import type { Marker } from "./objects.js";
import { A, PERIOD } from "./state.js";
import { isMissile, isRestoredMissile, type FleetRecord } from "./sim-ships.js";
import type { Sim, SimEvent } from "./sim.js";
import type { HardwareState } from "./sim-hardware.js";
import { inMap, OCCUPIED, type Unit, type UnitSystem } from "./units.js";
import { OBJECT_SIZE, OBJECT_SLOTS, T, TYPE_COUNT, type World } from "./world.js";

/**
 * Version of the checkpoint contract. Schema 4 records the pass boundary after redraw/date/periodic/input; schema 3 used a
 * pre-redraw boundary and introduced fixed `effectSlots`.
 */
export const CHECKPOINT_SCHEMA = 4;

/**
 * Where in `MapScene.update()` the checkpoint was taken:
 * - "pass-end": the update completed a normal main-loop cycle; taken after redraw, date/periodic work and input poll.
 * - "pass-end-modal": the update completed a modal build-menu pass; taken after menu input and redraw (simulation, units
 *   and pass clock were frozen). Video-side counters still moved.
 * - "manual": `MapScene.captureCheckpoint()` / `captureCheckpoint()` called by the caller at an arbitrary moment.
 */
export type CheckpointBoundary = "pass-end" | "pass-end-modal" | "manual";

const AIR_LAYER = 0x2000; // map word bit 13: a flying object stands here
const ENEMY_SLOT_SIZE = 0x1a;
const POOLS = 9;
const GOODS = 6;

/** A per-cell flag byte pointer plus the cell it names (derived from the reservation cell, never stored raw). */
export interface CheckpointReservation {
  readonly x: number;
  readonly y: number;
  /** `$3D3A6 + y * $66 + x`, the original's +$14 long. */
  readonly pointer: number;
}

export interface CheckpointTank {
  readonly slot: number;
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly dir: number;
  readonly vx: number;
  readonly vy: number;
  readonly hp: number;
  /** Full +9 byte (bit 7 = waiting for the move tick). */
  readonly control: number;
  readonly tech: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly recent: readonly number[];
  /** Cell holding this unit's occupancy marks; null when outside the map. */
  readonly reservation: CheckpointReservation | null;
}

export interface CheckpointEnemy {
  readonly slot: number;
  readonly list: "ground" | "air";
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly dir: number;
  readonly vx: number;
  readonly vy: number;
  readonly hp: number;
  /** +9 low bits: 6 choose a target, 1 on the way, 5 frozen, 2 diving, 3 flying on. */
  readonly mode: number;
  /** Ground bit 7 of +9. Always false for aircraft. */
  readonly waiting: boolean;
  readonly tech: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly recent: readonly number[];
  readonly reservation: CheckpointReservation | null;
  /** Raw unsigned +$16 long owned by this fixed enemy slot; may be zero, padding, or stale. */
  readonly flagPointer: number;
  /** +D step counter, +E bomb chance, +F damage, +$10 lift, +$13 aux (signed), +$14 / +$15 raw bytes. */
  readonly steps: number;
  readonly bombChance: number;
  readonly damage: number;
  readonly lift: number;
  readonly aux: number;
  readonly byte14: number;
  readonly byte15: number;
  /** Crusher (type 24) +$13 toggle bit, counter and +$14 animation; null for every other type. */
  readonly crusher: { readonly toggle: boolean; readonly counter: number; readonly anim: number } | null;
}

export interface CheckpointShip {
  readonly slot: number;
  /** "ship" types 11..16, "missile" type 17 launched at run time, "restoredMissile" type 17 adopted from Disk.4 (same MissileRecord shape). */
  readonly kind: "ship" | "missile" | "restoredMissile";
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly dir: number;
  readonly hp: number;
  /** +9: 0 landed, 1 hovering, 2/3 flying, 4 building pad, 5 launching, 6 landing, 7 to the enemy. */
  readonly mode: number;
  readonly tech: number;
  readonly targetX: number;
  readonly targetY: number;
  /** +$10 */
  readonly lift: number;
  /** +D class and +E fuel; null for every missile, launched or restored (those bytes are its target pointer). */
  readonly cls: number | null;
  readonly fuel: number | null;
  /** Extra state (+6/+7 velocity, +$11, +$12, +$14 reservation); null while the ship has none yet. */
  readonly extra: {
    readonly vx: number;
    readonly vy: number;
    readonly next: number;
    readonly turn: number;
    readonly reservation: CheckpointReservation | null;
  } | null;
  /** The enemy slot a missile follows and the original RAM address of that slot; null for ships. */
  readonly target: { readonly list: "ground" | "air"; readonly index: number; readonly address: number; readonly occupied: boolean } | null;
}

export interface CheckpointObjectRecord {
  readonly slot: number;
  /** Word +0 (a building tile id, `$32` = construction site). */
  readonly tile: number;
  /** Bytes +2, +3, +6, +7 as stored (meaning depends on the tile; `$FF` at +3 = online command centre / finished gun). */
  readonly b2: number;
  readonly b3: number;
  readonly x: number;
  readonly y: number;
  readonly b6: number;
  readonly b7: number;
}

export interface CheckpointSite {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  /** Word +2: the tile the site becomes. */
  readonly targetTile: number;
  /** Byte +6: weekly countdown. */
  readonly weeksLeft: number;
}

export interface CheckpointCell {
  readonly x: number;
  readonly y: number;
  /** Map word bits 13/14 only (`$2000` air layer, `$4000` ground occupancy); tile id and other flags are not copied. */
  readonly layers: number;
  /** Per-cell flag byte (`$3D3A6`), raw. */
  readonly flagByte: number;
}

export interface CheckpointWatchedCell {
  readonly x: number;
  readonly y: number;
  /** The whole map word, only for cells the caller asked for with `watchCells`. */
  readonly word: number;
  readonly flagByte: number;
}

export interface RuntimeCheckpoint {
  readonly schema: typeof CHECKPOINT_SCHEMA;
  /** 0-based index of this capture in its recorder (counts dropped ones too); -1 for a one-off manual capture. */
  readonly sequence: number;
  readonly boundary: CheckpointBoundary;
  readonly video: {
    /** Video updates counted by the loop (VBL interrupts). */
    readonly updates: number;
    /** Completed main-loop passes. */
    readonly passes: number;
    readonly updatesPerPass: number;
    /** Updates since the last completed pass: 0 at a pass boundary. */
    readonly updatesIntoPass: number;
  };
  /** `$144C9` sub-tick and the move / enemy tick flags of the pass; null without a unit system. */
  readonly passClock: { readonly sub: number; readonly moveTick: boolean; readonly enemyTick: boolean } | null;
  /** Deterministic stand-in counters for CIA TOD/raster reads; these are not original hardware values. */
  readonly approximations: { readonly hardware: HardwareState | null };
  readonly time: {
    /** `$14590` frame countdown. */
    readonly frameCountdown: number;
    readonly day: number;
    /** 0..11 as stored. */
    readonly month: number;
    readonly weekday: number;
    readonly year: number;
    readonly dateText: string;
    /** `$144C1` pending periodic bits. */
    readonly pendingBits: number;
    readonly pending: { readonly daily: boolean; readonly weekly: boolean; readonly monthly: boolean; readonly yearly: boolean; readonly special: boolean };
    /** A day change waits for the next pass (`$156A8` bit 7). */
    readonly dayQueued: boolean;
    /** `$156A9` bit 2. */
    readonly paused: boolean;
    /** `$156A9` bit 5, the blast mark: set only between a free-slot missile hit and the next `$4732` (ship-control.md 5e). */
    readonly blastMark: boolean;
    /** `$156AA`. */
    readonly sysFlags: number;
    readonly gameOver: boolean;
    /** An Earth offer waits for an answer (time is stopped); null when none. */
    readonly offer: { readonly what: string; readonly count: number; readonly price: number } | null;
  };
  readonly economy: {
    readonly money: number;
    /** `$135B6`: the expenditure of the month before (shown on the finance screen); set from `$142CA` at the monthly boundary. */
    readonly spentLastMonth: number;
    /** `$142CA`: construction spend accumulated since the last monthly boundary (placement adds the cost word, `$6CD0`-`$6CE0`); copied to `$135B6` and cleared by the monthly finance step. Not the same cell as `spentLastMonth`. */
    readonly currentExpenditure: number;
    readonly grant: number;
    readonly capacity: number;
    readonly goodsWeight: number;
    readonly tax: number;
    readonly nextTax: number;
    readonly morale: number;
    readonly pollution: number;
    readonly qualityOfLife: number;
    readonly crime: number;
    readonly techLevel: number;
    readonly inventions: number;
    readonly inventionQueue: number;
    readonly researchAccumulator: number;
  };
  readonly population: {
    readonly total: number;
    readonly freeColonists: number;
    readonly employed: number;
    readonly medics: number;
    readonly scientists: number;
    readonly security: number;
    readonly constructionWorkers: number;
    readonly births: number;
    readonly deaths: number;
    readonly farmWorkersA: number;
    readonly farmWorkersB: number;
    /** Nine job pools, in the original's pool order (game-state.md 3.2). */
    readonly jobRequired: readonly number[];
    readonly jobAssigned: readonly number[];
    readonly jobShortage: readonly number[];
    readonly jobCap: readonly number[];
  };
  readonly resources: {
    /** Six goods, index 0 = fuel (`$13152`). */
    readonly stock: readonly number[];
    readonly tradable: readonly number[];
    readonly retainPercent: readonly number[];
    readonly fuelStored: number;
  };
  readonly status: {
    readonly powerLevel: number;
    readonly eclipse: number;
    readonly airShort: number;
    readonly starving: number;
    readonly crowded: number;
    readonly virusLevel: number;
    readonly tradeFail: number;
    readonly warnBits: number;
    readonly securityPercent: number;
    readonly inventionDelay: number;
    readonly eventIndex: number;
  };
  readonly counters: {
    /** `$142C2` used object records: the live state word (placement/demolition update it; the `World.objectCount` field is not kept current). */
    readonly objectRecordsWord: number;
    /** `$142C4` construction sites. */
    readonly sitesWord: number;
    /** `$1429C` own tanks, `$1429E` own ships, `$142A2` enemy ground, `$142A4` enemy air. */
    readonly tanks: number;
    readonly ships: number;
    readonly enemyGround: number;
    readonly enemyAir: number;
    /** `$14254` + 4 * (type - 9), types 9..16. */
    readonly ownUnitsByType: readonly number[];
    /** `$14274`, types 9..16. */
    readonly leftMapByType: readonly number[];
    /** `$14294`. */
    readonly lostTotal: number;
  };
  /** Per building type 0..33 (`$131E2`, 18-byte entries): active (+$A) and total (+$C) counts. */
  readonly buildingTypes: { readonly active: readonly number[]; readonly total: readonly number[] };
  readonly alerts: {
    /** Power, event bookmark, food, air (`$FF` = lit). */
    readonly lights: readonly number[];
    /** `$144BD` bookmark countdown, `$144E8` / `$144EA` stored view. */
    readonly bookmarkCountdown: number;
    readonly bookmark: { readonly x: number; readonly y: number };
  };
  readonly aliens: {
    readonly alien: { readonly x: number; readonly y: number; readonly frame: number } | null;
    readonly meteor: { readonly x: number; readonly y: number; readonly timer: number } | null;
    /** `$144A4` word index used by the active alien animation; `$144A5` is its low byte. */
    readonly alienFrameIndex: number;
  };
  /** Occupied object records and construction sites; null when `includeObjectRecords` is false. */
  readonly objectRecords: {
    readonly occupied: number;
    readonly records: readonly CheckpointObjectRecord[];
    readonly sites: readonly CheckpointSite[];
  } | null;
  /** Cells with an occupancy bit (13/14) or a non-zero flag byte, in index order; null when `includeCells` is false. */
  readonly cells: readonly CheckpointCell[] | null;
  readonly watchedCells: readonly CheckpointWatchedCell[];
  /** 99 fixed slots (null = free); null without a unit system. */
  readonly tanks: readonly (CheckpointTank | null)[] | null;
  /** 60 / 30 fixed slots (null = free); null without an enemy system. */
  readonly enemies: {
    readonly ground: readonly (CheckpointEnemy | null)[];
    readonly air: readonly (CheckpointEnemy | null)[];
    /** Raw +$16 pointers for all fixed slots, including free slots whose old pointer survives death. */
    readonly groundFlagPointers: readonly number[];
    readonly airFlagPointers: readonly number[];
  } | null;
  /** 40 fixed slots (null = free). */
  readonly ships: readonly (CheckpointShip | null)[];
  readonly queues: {
    /** `Sim.messages` waiting to be shown (string-table indices), not yet drained by the scene. */
    readonly simMessages: readonly number[];
    /** `Sim.events` not yet taken by the game shell. */
    readonly simEvents: readonly SimEvent[];
    /** Every message request seen by the message line since the previous checkpoint of this recorder (-1 = patched text). */
    readonly messagesPushed: readonly number[];
    /** Message line / log timers and shape (no text). Null when the source has no message log. */
    readonly messageLog: { readonly lineFramesLeft: number; readonly logIdleFrames: number; readonly log: readonly { readonly lineCount: number; readonly protectDays: number }[] } | null;
    /**
     * The 30 fixed effect (explosion) slots at `$39D4A` (stride 8), slot index = identity, `null` = free slot (a hole, distinct
     * from an empty pool, which is 30 `null`s). The whole value is `null` when the source has no object layer / effect pool.
     */
    readonly effectSlots: readonly ({ readonly type: number; readonly x: number; readonly y: number; readonly frame: number; readonly lift: number } | null)[] | null;
    /** The word `$156AE`: how many effect slots are occupied (0 without an effect pool). */
    readonly effectCount: number;
  };
  readonly view: { readonly x: number; readonly y: number } | null;
  /** Marker pins 1..8 (y = 255 = unplaced); empty without an object layer. */
  readonly markers: readonly { readonly type: number; readonly x: number; readonly y: number }[];
}

/** What a checkpoint reads. Every member is only read. */
export interface CheckpointSource {
  readonly loop: MainLoop;
  readonly sim: Sim;
  readonly units: UnitSystem | null;
  readonly enemies: EnemySystem | null;
  /** The object layer's fixed effect slots (`ObjectLayer.effectSlots`), null = free slot. */
  readonly effectSlots?: readonly (Effect | null)[];
  readonly markers?: readonly Marker[];
  readonly view?: { readonly x: number; readonly y: number };
  readonly messageLog?: RuntimeCheckpoint["queues"]["messageLog"];
}

export interface CheckpointOptions {
  /** Copy the occupied object records and the construction sites. Default true. */
  readonly includeObjectRecords?: boolean;
  /** Copy the cells that carry an occupancy bit or a flag byte. Default true. */
  readonly includeCells?: boolean;
  /** Extra cells whose full map word and flag byte are copied. Default none. */
  readonly watchCells?: readonly { readonly x: number; readonly y: number }[];
}

const longs = (read: (addr: number) => number, base: number, count: number): number[] => Array.from({ length: count }, (_, i) => read(base + 4 * i));

function reservation(x: number, y: number): CheckpointReservation | null {
  return inMap(x, y) ? { x, y, pointer: cellFlagPointer(x, y) } : null;
}

function deepFreeze(value: unknown): void {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
}

function tank(u: Unit): CheckpointTank {
  return {
    slot: u.slot, type: u.type, x: u.x, y: u.y, dx: u.dx, dy: u.dy, dir: u.dir, vx: u.vx, vy: u.vy, hp: u.hp,
    control: u.control, tech: u.tech, targetX: u.targetX, targetY: u.targetY, recent: [...u.recent],
    reservation: reservation(u.reserveX, u.reserveY),
  };
}

function enemy(e: Enemy, slot: number, flagPointer: number): CheckpointEnemy {
  return {
    slot, list: e.air ? "air" : "ground", type: e.type, x: e.x, y: e.y, dx: e.dx, dy: e.dy, dir: e.dir, vx: e.vx, vy: e.vy, hp: e.hp,
    mode: e.mode, waiting: e.waiting, tech: e.tech, targetX: e.targetX, targetY: e.targetY, recent: [...e.recent],
    reservation: reservation(e.reserveX, e.reserveY),
    flagPointer,
    steps: e.steps, bombChance: e.bombPct, damage: e.dmg, lift: e.lift, aux: e.aux, byte14: e.p14, byte15: e.p15,
    crusher: !e.air && e.type === ENEMY_CRUSHER ? { toggle: e.toggle, counter: e.counter, anim: e.anim } : null,
  };
}

function ship(record: FleetRecord, slot: number, enemies: EnemySystem | null): CheckpointShip {
  const missile = isMissile(record);
  const kind = isRestoredMissile(record) ? "restoredMissile" : missile ? "missile" : "ship";
  const inspected = enemies?.inspectShip(record) ?? null;
  const target = inspected?.targetSlot
    ? {
        list: inspected.targetSlot.air ? "air" as const : "ground" as const,
        index: inspected.targetSlot.index,
        address: (inspected.targetSlot.air ? DISK4_ADDR.enemyAir : DISK4_ADDR.enemyGround) + inspected.targetSlot.index * ENEMY_SLOT_SIZE,
        occupied: inspected.targetOccupied === true,
      }
    : null;
  return {
    slot, kind, type: record.type, x: record.x, y: record.y, dx: record.dx, dy: record.dy, dir: record.dir, hp: record.hp,
    mode: record.mode, tech: record.tech, targetX: record.targetX, targetY: record.targetY, lift: record.lift,
    cls: missile ? null : record.cls, fuel: missile ? null : record.fuel,
    extra: inspected ? { vx: inspected.vx, vy: inspected.vy, next: inspected.next, turn: inspected.turn, reservation: inspected.rx >= 0 ? reservation(inspected.rx, inspected.ry) : null } : null,
    target,
  };
}

function objectRecords(world: World): NonNullable<RuntimeCheckpoint["objectRecords"]> {
  const o = world.objects;
  const records: CheckpointObjectRecord[] = [];
  const sites: CheckpointSite[] = [];
  for (let slot = 0; slot < OBJECT_SLOTS; slot++) {
    const at = slot * OBJECT_SIZE;
    const tile = (o[at] << 8) | o[at + 1];
    if (tile === 0) continue;
    records.push({ slot, tile, b2: o[at + 2], b3: o[at + 3], x: o[at + 4], y: o[at + 5], b6: o[at + 6], b7: o[at + 7] });
    if (tile === 0x32) sites.push({ slot, x: o[at + 4], y: o[at + 5], targetTile: (o[at + 2] << 8) | o[at + 3], weeksLeft: o[at + 6] });
  }
  return { occupied: records.length, records, sites };
}

function occupiedCells(world: World): CheckpointCell[] {
  const out: CheckpointCell[] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const layers = world.cells[mapIndex(x, y)] & (OCCUPIED | AIR_LAYER);
      const flagByte = world.cellFlags[cellFlagIndex(x, y)];
      if (layers !== 0 || flagByte !== 0) out.push({ x, y, layers, flagByte });
    }
  }
  return out;
}

/**
 * Takes one checkpoint of `source`. Pure with respect to the game: it only reads, and the result shares no object or
 * array with the live state (every value is a fresh copy, deep-frozen). Safe to call at any time; at a pass boundary
 * the values are those described in notes/formats/runtime-checkpoints.md.
 */
export function captureCheckpoint(
  source: CheckpointSource,
  boundary: CheckpointBoundary = "manual",
  options: CheckpointOptions = {},
  sequence = -1,
  messagesPushed: readonly number[] = [],
): RuntimeCheckpoint {
  const { loop, sim, units, enemies } = source;
  const world = sim.world;
  const s = sim.state;
  const pending = s.byte(A.pending);
  const rl = (base: number, n: number): number[] => longs((a) => s.long(a), base, n);
  const checkpoint: RuntimeCheckpoint = {
    schema: CHECKPOINT_SCHEMA,
    sequence,
    boundary,
    video: { updates: loop.vbls, passes: loop.passes, updatesPerPass: loop.vblPerPass, updatesIntoPass: loop.updatesIntoPass },
    passClock: units ? { sub: units.clock.sub, moveTick: units.clock.moveTick, enemyTick: units.clock.enemyTick } : null,
    approximations: { hardware: sim.hardwareState },
    time: {
      frameCountdown: s.byte(A.frameCountdown),
      day: s.byte(A.day),
      month: s.byte(A.month),
      weekday: s.byte(A.weekday),
      year: s.long(A.year),
      dateText: s.dateText(),
      pendingBits: pending,
      pending: {
        daily: (pending & PERIOD.daily) !== 0,
        weekly: (pending & PERIOD.weekly) !== 0,
        monthly: (pending & PERIOD.monthly) !== 0,
        yearly: (pending & PERIOD.yearly) !== 0,
        special: (pending & PERIOD.special) !== 0,
      },
      dayQueued: sim.dayQueued,
      paused: sim.paused,
      blastMark: sim.blastMark,
      sysFlags: sim.sysFlags,
      gameOver: sim.gameOver,
      offer: sim.pending ? { what: sim.pending.offer.what, count: sim.pending.offer.count, price: sim.pending.offer.price } : null,
    },
    economy: {
      money: s.signedLong(A.money),
      spentLastMonth: s.long(0x135b6),
      currentExpenditure: s.long(0x142ca),
      grant: s.long(0x135be),
      capacity: s.long(0x14432),
      goodsWeight: s.long(0x13166),
      tax: s.long(A.tax),
      nextTax: s.long(A.nextTax),
      morale: s.signedLong(A.morale),
      pollution: s.long(A.pollution),
      qualityOfLife: s.long(A.qualityOfLife),
      crime: s.signedLong(0x142ce),
      techLevel: s.byte(A.techLevel),
      inventions: s.long(0x14472),
      inventionQueue: s.long(0x14476),
      researchAccumulator: s.long(0x142da),
    },
    population: {
      total: s.long(A.population),
      freeColonists: s.long(A.freeColonists),
      employed: s.long(0x1313a),
      medics: s.long(0x1313e),
      scientists: s.long(0x13142),
      security: s.long(0x13146),
      constructionWorkers: s.long(0x1432a),
      births: s.long(0x1432e),
      deaths: s.long(0x14332),
      farmWorkersA: s.long(0x143be),
      farmWorkersB: s.long(0x143c2),
      jobRequired: rl(0x143c6, POOLS),
      jobAssigned: rl(0x143ea, POOLS),
      jobShortage: longs((a) => s.signedLong(a), 0x1440e, POOLS),
      jobCap: rl(0x14500, POOLS),
    },
    resources: {
      stock: rl(0x13152, GOODS),
      tradable: rl(0x14234, GOODS),
      retainPercent: rl(A.retainPercent, GOODS),
      fuelStored: s.long(0x14342),
    },
    status: {
      powerLevel: s.byte(0x144c8),
      eclipse: s.byte(0x144bb),
      airShort: s.byte(0x144b5),
      starving: s.byte(0x144b4),
      crowded: s.byte(0x144c4),
      virusLevel: s.byte(0x144b7),
      tradeFail: s.byte(0x144ba),
      warnBits: s.byte(0x144b1),
      securityPercent: s.byte(0x144c6),
      inventionDelay: s.byte(0x144c7),
      eventIndex: s.byte(0x144bf),
    },
    counters: {
      objectRecordsWord: s.word(0x142c2),
      sitesWord: s.word(0x142c4),
      tanks: s.word(0x1429c),
      ships: s.word(0x1429e),
      enemyGround: s.word(0x142a2),
      enemyAir: s.word(0x142a4),
      ownUnitsByType: rl(0x14254, 8),
      leftMapByType: rl(0x14274, 8),
      lostTotal: s.long(0x14294),
    },
    buildingTypes: {
      active: Array.from({ length: TYPE_COUNT }, (_, i) => s.word(world.typeAddress(i) + T.active)),
      total: Array.from({ length: TYPE_COUNT }, (_, i) => s.word(world.typeAddress(i) + T.total)),
    },
    alerts: {
      lights: Array.from(sim.alerts.flags),
      bookmarkCountdown: s.byte(0x144bd),
      bookmark: { x: s.word(0x144e8), y: s.word(0x144ea) },
    },
    aliens: {
      alien: sim.aliens.alien ? { x: sim.aliens.alien.x, y: sim.aliens.alien.y, frame: s.byte(0x144ad) } : null,
      meteor: sim.aliens.meteor ? { x: sim.aliens.meteor.x, y: sim.aliens.meteor.y, timer: sim.aliens.meteor.timer } : null,
      alienFrameIndex: s.word(0x144a4),
    },
    objectRecords: options.includeObjectRecords === false ? null : objectRecords(world),
    cells: options.includeCells === false ? null : occupiedCells(world),
    watchedCells: (options.watchCells ?? []).filter((c) => inMap(c.x, c.y)).map((c) => ({
      x: c.x, y: c.y, word: world.cells[mapIndex(c.x, c.y)], flagByte: world.cellFlags[cellFlagIndex(c.x, c.y)],
    })),
    tanks: units ? units.slots.map((u) => (u ? tank(u) : null)) : null,
    enemies: enemies
      ? {
          ground: enemies.groundSlots.map((e, i) => (e ? enemy(e, i, enemies.groundFlagPointers[i]) : null)),
          air: enemies.airSlots.map((e, i) => (e ? enemy(e, i, enemies.airFlagPointers[i]) : null)),
          groundFlagPointers: enemies.groundFlagPointers.slice(),
          airFlagPointers: enemies.airFlagPointers.slice(),
        }
      : null,
    ships: sim.fleet.slots.map((r, i) => (r ? ship(r, i, enemies) : null)),
    queues: {
      simMessages: [...sim.messages],
      simEvents: sim.events.map((e) => ({ ...e })),
      messagesPushed: [...messagesPushed],
      messageLog: source.messageLog ? { lineFramesLeft: source.messageLog.lineFramesLeft, logIdleFrames: source.messageLog.logIdleFrames, log: source.messageLog.log.map((l) => ({ ...l })) } : null,
      effectSlots: source.effectSlots ? source.effectSlots.map((e) => (e === null ? null : { type: e.type, x: e.x, y: e.y, frame: e.frame, lift: e.lift })) : null,
      effectCount: source.effectSlots ? source.effectSlots.filter((e) => e !== null).length : 0,
    },
    view: source.view ? { x: source.view.x, y: source.view.y } : null,
    markers: (source.markers ?? []).map((m) => ({ type: m.type, x: m.x, y: m.y })),
  };
  deepFreeze(checkpoint);
  return checkpoint;
}

export interface CheckpointRecorderOptions extends CheckpointOptions {
  /** Keep at most this many checkpoints in memory (oldest dropped first). Default 512; 0 keeps none (callback only). */
  readonly capacity?: number;
  /** Record every Nth completed pass (pass counter modulo N is 0). Default 1 = every pass. */
  readonly everyPasses?: number;
  /**
   * Called with each recorded checkpoint, after it is stored. The caller decides what to do with it (the engine never
   * writes or logs anything itself). An exception is caught and counted in `failures`, never propagated into the loop.
   */
  readonly onCheckpoint?: (checkpoint: RuntimeCheckpoint) => void;
}

/**
 * In-memory, bounded recorder created by `MapScene.enableCheckpoints()`. It observes only; a failure while capturing is
 * caught and counted so that enabling it can never throw out of the game loop.
 */
export class CheckpointRecorder {
  readonly capacity: number;
  readonly everyPasses: number;
  /** Captures taken so far, including those already dropped from the buffer. */
  captured = 0;
  /** Captures dropped because the buffer was full. */
  dropped = 0;
  /** Captures or callbacks that threw. */
  failures = 0;
  lastError: string | null = null;
  private buffer: RuntimeCheckpoint[] = [];
  private pushed: number[] = [];

  constructor(private readonly options: CheckpointRecorderOptions = {}) {
    const capacity = options.capacity ?? 512;
    const everyPasses = options.everyPasses ?? 1;
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`CheckpointRecorder: capacity ${capacity} must be an integer >= 0`);
    if (!Number.isInteger(everyPasses) || everyPasses < 1) throw new Error(`CheckpointRecorder: everyPasses ${everyPasses} must be an integer >= 1`);
    this.capacity = capacity;
    this.everyPasses = everyPasses;
  }

  /** The stored checkpoints, oldest first. The checkpoints are frozen; the returned array is a copy. */
  get checkpoints(): readonly RuntimeCheckpoint[] {
    return this.buffer.slice();
  }

  /** Forgets the stored checkpoints (counters are kept). */
  clear(): void {
    this.buffer = [];
  }

  /** Message observer (`Messages.observer`): remembers the requests until the next checkpoint. */
  noteMessage(index: number): void {
    if (this.pushed.length < 4096) this.pushed.push(index);
  }

  /** Called by the scene at a pass boundary. Skips passes that are not due. */
  atPass(source: CheckpointSource, boundary: CheckpointBoundary): void {
    if (source.loop.passes % this.everyPasses !== 0) return;
    this.record(source, boundary);
  }

  /** Captures now (also used for passes that are due). Never throws. */
  record(source: CheckpointSource, boundary: CheckpointBoundary): RuntimeCheckpoint | null {
    try {
      const checkpoint = captureCheckpoint(source, boundary, this.options, this.captured, this.pushed);
      this.pushed = [];
      this.captured++;
      if (this.capacity === 0) {
        this.dropped++;
      } else {
        this.buffer.push(checkpoint);
        if (this.buffer.length > this.capacity) {
          this.buffer.shift();
          this.dropped++;
        }
      }
      try {
        this.options.onCheckpoint?.(checkpoint);
      } catch (error) {
        this.failures++;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      return checkpoint;
    } catch (error) {
      this.failures++;
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }
}
