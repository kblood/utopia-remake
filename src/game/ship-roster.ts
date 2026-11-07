// Detached fixed-slot own-ship records of a Disk.4 restore: ship types 11..16 (`RestoredShip`) and
// projectile type 17 (`RestoredMissile`, a distinct representation).
// Evidence: notes/formats/game-state.md 3.8 (ship list $3A75E, 40 slots, $18 stride), sim-port.md (class +D,
// fuel word +E, lift +$10), ship-control.md sections 2-3 (+9 mode 0..8, +$11 next/order, +$12 turn direction),
// building-screens.md 3.6 and 5 (missile creation $49E8, daily step $ACE2).
//
// Scope of THIS module: inert. ShipRoster is NOT a Fleet and NOT created through Fleet.createShip(); building it
// spawns, moves, refuels, destroys, calls hooks, updates counters ($1429E, $14254..), uses RNG, and touches the
// map words, the per-cell flag bytes, the enemy objects and the saved state in NO way. It takes only decoded slots,
// copies what it keeps, and returns either a roster or one typed error and nothing. Velocities, next mode and
// turn direction live in a typed `extra` record per record (the Ship record of sim-ships.ts has no room for them).
//
// Adoption (EnemySystem.fromRoster(..., ships)): the SAME record objects, in their saved slots, become the live
// entries of `sim.fleet` (still no createShip, counters, RNG, hooks or map/flag/state writes at adoption). From then
// on the position/mode/lift/... fields of an adopted record are live and change as the system runs; the provenance
// fields (`slot`, `sourceAddress`, `sourceRaw`, `savedControl`, `extra`, `flagPointer`, `target`) stay exactly as
// saved and are never rewritten. The roster's own `slots` array is a detached index and is not kept in sync with
// the Fleet afterwards (a ship the Fleet destroys stays listed here); `sim.fleet.slots` is authoritative.
//
// Values are kept exactly as stored: nothing is clamped, normalised or derived (no waiting flag, no
// reservation, no map mark). The full +9 byte is the mode (validated 0..8, bit 7 is not split off: no waiting
// bit is documented for ships).
//
// VERIFIED (static, $387E / $49E8 / $497E): the long at +$14 of every ship-list record, missile included, is a
// pointer into the per-cell flag bytes ($3D3A6 + y*$66 + x) that $497E computes from the record's own cell at
// creation. It is kept raw and classified with the shared 102-byte resolver as `flagPointer`; the roster never
// validates, rejects or repairs it. Tracing since then ($4152, $4526, $43EE, $4732): takeoff writes it from the
// current x/y, a new cell step ($4660) writes the pointer of the NEXT cell, landing writes the landing cell, and
// the destroy routine $4732 reads it back as THE cell whose mark ($ACE2/$46CC) is released. It is therefore the ship's
// current reservation. The roster still only keeps it; the EnemySystem adoption is what turns a playable pointer
// into the reservation cell (and rejects any other pointer).
//
// Missile (type 17) layout, VERIFIED from $ACE2 / $49E8 (building-screens.md 3.6, 5): `move.l $C(a6),d2;
// andi.l #$FFFFFF,d2` - the long at +$C is read and masked, so the effective enemy-record address is the
// 24-bit value in bytes +$D..+$F. Byte +$C is the saved y of the target cell (+B/+C, rewritten from the
// pointed record's +1/+2 every day) and is masked away. The ordinary ship fields +$D class and +$E/+$F fuel do
// NOT exist for a missile (the same bytes are the pointer), so a missile never exposes class/fuel. +$10..+$12
// are mapped by position as for ships (lift, next, turn); that the flight code uses them the same way is
// not separately traced.
//
// Missile target resolution: the 24-bit address must be the exact start of a fixed enemy slot. The enemy air
// records are $39E3A + i*$1A (30 slots) and run straight into the ground records at $3A146 (60 slots); the
// ground scan base $3A12C ($12456, header+$1A) is therefore air slot 29, not a separate header. Resolution is
// against the decoded fixed slots (free slots included) and yields a typed ref {list, index, address,
// status}. A FREE slot is a legal target: $ACE2 destroys a missile whose target type byte is zero on its next
// daily step, so the state can be saved before that happens; the ref reports status "free" and the restore
// does not destroy anything. Pointers into the air list header, off a slot start or outside both lists are a
// typed `missile-target` error. No Enemy object is bound (EnemyRoster identity is reachable through the ref's
// list/index and its sourceAddress). When the caller also passes the detached EnemyRoster arrays
// (`enemies.objects`, as prepareDisk4ShipLoad does) the target additionally carries `enemy: Enemy | null`
// (the same object by reference, null for a free slot), after checking list/slot/sourceAddress/type agree;
// a disagreement is an "enemy-object" error. This is shared identity only: nothing is read from or written to it.

import type { Disk4EnemyAirSlot, Disk4EnemyGroundSlot, Disk4ShipSlot } from "../data/disk4-entities.js";
import { DISK4_ADDR } from "../data/disk4-state.js";
import { resolveCellFlagPointer, type CellFlagTarget } from "./cell-flags.js";
import type { Enemy } from "./enemies.js";
import type { MissileRecord, Ship } from "./sim-ships.js";
import { inMap } from "./units.js";

export const SHIP_SLOTS = 40;
export const SHIP_RECORD_SIZE = 0x18;
/** Own ship types 11..16 = ship class 0..5 + 11. Type 17 (missile) is restored as a RestoredMissile. */
export const SHIP_TYPE_FIRST = 11;
export const SHIP_TYPE_LAST = 16;
export const SHIP_TYPE_MISSILE = 17;

export const ENEMY_RECORD_SIZE = 0x1a;
export const ENEMY_AIR_SLOTS = 30;
export const ENEMY_GROUND_SLOTS = 60;
/** Start of the air list header ($39E20); its records start $1A later at DISK4_ADDR.enemyAir. */
export const ENEMY_AIR_HEADER = DISK4_ADDR.enemyAir - ENEMY_RECORD_SIZE;
/** Mask $ACE2 applies to the long at +$C. */
export const MISSILE_TARGET_MASK = 0xffffff;

/** Detached extra state of a saved ship or missile: the bytes the Ship record of sim-ships.ts has no room for. */
export interface ShipExtraRecord {
  /** +6 signed pixel velocity. */
  readonly vx: number;
  /** +7 signed pixel velocity. */
  readonly vy: number;
  /** +$11: pending order / mode to take after the climb (raw). */
  readonly next: number;
  /** +$12: turn direction (raw). */
  readonly turn: number;
}

/**
 * The +$14 long of a ship-list record: VERIFIED to be created as a per-cell flag-byte pointer ($497E), kept
 * raw. `target` is the classification under the shared resolver; it is informational (see header comment).
 */
export interface UnitFlagPointer {
  readonly semantics: "VERIFIED";
  /** Raw unsigned long exactly as stored. */
  readonly raw: number;
  readonly target: CellFlagTarget;
  /** The pointer names the record's own saved cell (informational; a difference is not an error). */
  readonly atOwnCell: boolean;
}

/**
 * One restored ship (types 11..16). Field names follow Ship (sim-ships.ts); +9 is `mode`, and the full byte is
 * `savedControl`. The Ship fields are live once adopted into a Fleet; everything below `kind` is the saved record.
 */
export interface RestoredShip extends Ship {
  readonly kind: "ship";
  /** Position in the fixed 40-slot array (never re-indexed). */
  readonly slot: number;
  /** Original RAM address of the record. */
  readonly sourceAddress: number;
  /** Exact $18 record bytes (a copy owned by this ship). */
  readonly sourceRaw: Uint8Array;
  /** Full saved +9 byte (equals `mode`; validated 0..8). */
  readonly savedControl: number;
  readonly extra: ShipExtraRecord;
  readonly flagPointer: UnitFlagPointer;
}

/** Fixed enemy slot an address resolves to. `status` is the type byte of the decoded slot (0 = free). */
export interface EnemyRecordRef {
  readonly list: "enemyAir" | "enemyGround";
  /** 0-based position in that list's fixed slot array. */
  readonly index: number;
  /** Original RAM address of the slot start (equals the pointer's 24-bit address). */
  readonly address: number;
  readonly status: "occupied" | "free";
}

/** Result of classifying a 24-bit address against the fixed enemy slots (occupancy not applied). */
export type EnemyRecordPointer =
  | { readonly kind: "record"; readonly list: "enemyAir" | "enemyGround"; readonly index: number; readonly address: number }
  | { readonly kind: "header" }
  | { readonly kind: "misaligned"; readonly list: "enemyAir" | "enemyGround" }
  | { readonly kind: "out-of-range" };

/**
 * Pure classification of an address against the enemy lists: exact slot starts of the air list
 * ($39E3A + i*$1A, i < 30) and the ground list ($3A146 + i*$1A, i < 60); the air header ($39E20..$39E39);
 * a position inside a slot but not at its start; or anything else. Does not look at slot contents.
 */
export function resolveEnemyRecordPointer(address: number): EnemyRecordPointer {
  const lists = [
    { list: "enemyAir", first: DISK4_ADDR.enemyAir, size: ENEMY_AIR_SLOTS },
    { list: "enemyGround", first: DISK4_ADDR.enemyGround, size: ENEMY_GROUND_SLOTS },
  ] as const;
  if (!Number.isInteger(address)) return { kind: "out-of-range" };
  for (const l of lists) {
    const end = l.first + l.size * ENEMY_RECORD_SIZE;
    if (address < l.first || address >= end) continue;
    const off = address - l.first;
    if (off % ENEMY_RECORD_SIZE !== 0) return { kind: "misaligned", list: l.list };
    return { kind: "record", list: l.list, index: off / ENEMY_RECORD_SIZE, address };
  }
  if (address >= ENEMY_AIR_HEADER && address < DISK4_ADDR.enemyAir) return { kind: "header" };
  return { kind: "out-of-range" };
}

/** VERIFIED ($ACE2): the 24-bit enemy-record pointer of a missile, plus the typed slot it resolves to. */
export interface MissileTarget {
  readonly semantics: "VERIFIED";
  /** The long at +$C exactly as stored; its top byte is the saved target y (+$C), masked away by $ACE2. */
  readonly rawLong: number;
  /** rawLong & $FFFFFF = bytes +$D..+$F: the address $ACE2 dereferences. */
  readonly address: number;
  readonly ref: EnemyRecordRef;
  /**
   * Identity of the already-hydrated detached Enemy the ref names at SAVE time (shared by reference, never copied,
   * never written): the Enemy for an occupied slot, null for a free slot. `undefined` = no enemy objects were passed
   * to the restore, so only the typed ref is available. Verified at restore time against list/slot/sourceAddress/type.
   * It is a snapshot fact, NOT the runtime binding: an adopted missile resolves the CURRENT occupant of the slot
   * `ref` names on every step (the Enemy named here may be dead and the slot reused by then).
   */
  readonly enemy?: Enemy | null;
}

/**
 * One restored projectile (ship list type 17): the shared `MissileRecord` shape (the same one `Fleet.createMissile`
 * makes for a launched missile) plus the saved provenance. Deliberately NOT a Ship: it has no class and no fuel (those
 * bytes are the target pointer). `targetX`/`targetY` are +B/+C as stored; $ACE2 refreshes them from the target
 * every day (EnemySystem does that once the missile is adopted; building the roster does not). Once adopted the
 * MissileRecord fields are live; `target` is the SAVED pointer and never changes - the occupant of the slot it names
 * is looked up when the missile runs, never kept (a launched missile has no `target`: its identity is the same
 * fixed enemy slot, kept in the EnemySystem's ShipExtra).
 */
export interface RestoredMissile extends MissileRecord {
  readonly slot: number;
  readonly sourceAddress: number;
  readonly sourceRaw: Uint8Array;
  /** +9 as saved (validated 0..8); equals `savedControl`. `mode` is the live copy. */
  readonly savedControl: number;
  readonly extra: ShipExtraRecord;
  readonly target: MissileTarget;
  readonly flagPointer: UnitFlagPointer;
}

export type RestoredShipRecord = RestoredShip | RestoredMissile;

/** Decoded fixed enemy slots a missile pointer is resolved against (as in Disk4Entities). */
export interface EnemySlotLists {
  readonly ground: readonly Disk4EnemyGroundSlot[];
  readonly air: readonly Disk4EnemyAirSlot[];
  /**
   * Optional fixed-slot Enemy objects from a detached EnemyRoster (`roster.ground` / `roster.air`; null = free).
   * When given, each missile target must agree with them (see MissileTarget.enemy) and the restore stays inert.
   */
  readonly objects?: {
    readonly ground: readonly (Enemy | null)[];
    readonly air: readonly (Enemy | null)[];
  };
}

export type ShipRestoreErrorCode =
  | "slot-count"
  | "slot-index"
  | "enemy-slots"
  | "enemy-object"
  | "ship-type"
  | "position"
  | "direction"
  | "class"
  | "mode"
  | "missile-target";

/** Why a missile target pointer was rejected (code "missile-target"). */
export type MissileTargetReason = "header" | "misaligned" | "out-of-range";

export interface ShipRestoreError {
  readonly code: ShipRestoreErrorCode;
  readonly list?: "ownShips" | "enemyAir" | "enemyGround";
  readonly slot?: number;
  readonly field?: string;
  /** Only with code "missile-target". */
  readonly reason?: MissileTargetReason;
  /** Only with code "missile-target": the 24-bit address that failed. */
  readonly address?: number;
  readonly message: string;
}
export type ShipRestoreResult = { readonly ok: true; readonly value: ShipRoster } | { readonly ok: false; readonly error: ShipRestoreError };

const be32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function flagPointer(raw: number, x: number, y: number): UnitFlagPointer {
  const target = resolveCellFlagPointer(raw);
  return { semantics: "VERIFIED", raw, target, atOwnCell: target.kind === "playable" && target.x === x && target.y === y };
}

/** Detached fixed-slot own ships and missiles of a Disk.4 restore; null = free slot (stale bytes stay in the decoded slot). */
export class ShipRoster {
  readonly slots: (RestoredShipRecord | null)[] = new Array<RestoredShipRecord | null>(SHIP_SLOTS).fill(null);
  private constructor() {}

  /** Occupied ships (types 11..16) in stable slot order. Missiles are not included. */
  get ships(): RestoredShip[] { return this.slots.filter((s): s is RestoredShip => s !== null && s.kind === "ship"); }
  /** Occupied missiles (type 17) in stable slot order. */
  get missiles(): RestoredMissile[] { return this.slots.filter((s): s is RestoredMissile => s !== null && s.kind === "missile"); }
  /** Every occupied record, ships and missiles, in stable slot order. */
  get records(): RestoredShipRecord[] { return this.slots.filter((s): s is RestoredShipRecord => s !== null); }

  /**
   * Hydrates all 40 slots, or returns one typed error and nothing. The saved count word is never consulted.
   * Free slots (type 0) stay null whatever their stale bytes hold. Occupied records need an on-map cell,
   * direction 0..8 and mode 0..8, plus: types 11..16 a class 0..5 equal to type - 11; type 17 a target
   * pointer that is the exact start of a fixed enemy slot (free or occupied). Missiles need `enemies`
   * (the decoded fixed enemy slots); without them an occupied missile is an "enemy-slots" error. When given,
   * `enemies` is shape-checked even if no missile exists. Nothing outside the returned roster is read or written.
   */
  static fromDisk4(records: readonly Disk4ShipSlot[], enemies?: EnemySlotLists): ShipRestoreResult {
    const fail = (error: ShipRestoreError): ShipRestoreResult => ({ ok: false, error });
    if (!Array.isArray(records) || records.length !== SHIP_SLOTS) {
      return fail({ code: "slot-count", list: "ownShips", message: `Ship list has ${Array.isArray(records) ? records.length : "no"} slots, expected ${SHIP_SLOTS}` });
    }
    if (enemies !== undefined) {
      const bad = checkEnemySlots(enemies);
      if (bad) return fail(bad);
    }
    const roster = new ShipRoster();
    for (let i = 0; i < SHIP_SLOTS; i++) {
      const r = records[i];
      if (!r || r.list !== "ownShips" || r.index !== i || r.address !== DISK4_ADDR.ownShips + i * SHIP_RECORD_SIZE ||
        !(r.raw instanceof Uint8Array) || r.raw.length !== SHIP_RECORD_SIZE || r.type !== r.raw[0] ||
        r.status !== (r.raw[0] === 0 ? "free" : "occupied") || (r.layout === "missile") !== (r.type === SHIP_TYPE_MISSILE)) {
        return fail({ code: "slot-index", list: "ownShips", slot: i, field: "record", message: `Ship slot ${i} has missing or inconsistent provenance` });
      }
      if (r.status === "free") continue;
      if (r.layout !== "missile" && (!Number.isInteger(r.type) || r.type < SHIP_TYPE_FIRST || r.type > SHIP_TYPE_LAST)) {
        return fail({ code: "ship-type", list: "ownShips", slot: i, field: "+0", message: `Ship slot ${i} has unsupported type ${r.type}` });
      }
      if (r.layout === "missile" && enemies === undefined) {
        return fail({ code: "enemy-slots", list: "ownShips", slot: i, field: "+$D", message: `Ship slot ${i} holds a missile; the decoded enemy slots are needed to resolve its target` });
      }
      if (!inMap(r.x, r.y)) {
        return fail({ code: "position", list: "ownShips", slot: i, field: "+1/+2", message: `Ship slot ${i} position (${r.x}, ${r.y}) is outside the map` });
      }
      if (!Number.isInteger(r.direction) || r.direction < 0 || r.direction > 8) {
        return fail({ code: "direction", list: "ownShips", slot: i, field: "+5", message: `Ship slot ${i} direction ${r.direction} is outside 0..8` });
      }
      if (r.layout !== "missile" && (!Number.isInteger(r.shipClass) || r.shipClass < 0 || r.shipClass > 5 || r.shipClass !== r.type - SHIP_TYPE_FIRST)) {
        return fail({ code: "class", list: "ownShips", slot: i, field: "+D", message: `Ship slot ${i} class ${r.shipClass} does not match type ${r.type} (expected ${r.type - SHIP_TYPE_FIRST})` });
      }
      if (!Number.isInteger(r.control) || r.control < 0 || r.control > 8) {
        return fail({ code: "mode", list: "ownShips", slot: i, field: "+9", message: `Ship slot ${i} mode ${r.control} is outside 0..8` });
      }
      const extra: ShipExtraRecord = { vx: r.vx, vy: r.vy, next: r.nextMode, turn: r.turn };
      const fp = flagPointer(r.flagPointer, r.x, r.y);
      if (r.layout === "missile") {
        const rawLong = r.targetLong;
        const address = (rawLong & MISSILE_TARGET_MASK) >>> 0;
        if (address !== r.targetAddress || rawLong !== be32(r.raw, 0x0c)) {
          return fail({ code: "slot-index", list: "ownShips", slot: i, field: "+$C", message: `Missile slot ${i} target long disagrees with its raw record` });
        }
        const res = resolveEnemyRecordPointer(address);
        if (res.kind !== "record") {
          const reason: MissileTargetReason = res.kind;
          const what = reason === "header" ? "in the enemy air list header" : reason === "misaligned" ? "inside an enemy slot, not at its start" : "outside the enemy lists";
          return fail({
            code: "missile-target", list: "ownShips", slot: i, field: "+$D..+$F", reason, address,
            message: `Missile slot ${i} target address $${address.toString(16).toUpperCase()} is ${what}`,
          });
        }
        const slot = (res.list === "enemyAir" ? enemies!.air : enemies!.ground)[res.index];
        let enemy: Enemy | null | undefined;
        if (enemies!.objects) {
          enemy = (res.list === "enemyAir" ? enemies!.objects.air : enemies!.objects.ground)[res.index];
          const agrees = slot.status === "free"
            ? enemy === null
            : enemy != null && enemy.slot === res.index && enemy.sourceAddress === res.address &&
              enemy.type === slot.type && enemy.air === (res.list === "enemyAir");
          if (!agrees) {
            return fail({
              code: "enemy-object", list: res.list, slot: res.index, field: "target", address,
              message: `Missile slot ${i} target ${res.list}[${res.index}] does not match the supplied Enemy object (${slot.status === "free" ? "free slot needs null" : "occupied slot needs the hydrated Enemy of the same slot, address and type"})`,
            });
          }
        }
        roster.slots[i] = {
          kind: "missile",
          type: 17,
          slot: i,
          sourceAddress: r.address,
          sourceRaw: r.raw.slice(),
          x: r.x,
          y: r.y,
          dx: r.dx,
          dy: r.dy,
          dir: r.direction,
          hp: r.hp,
          mode: r.control,
          savedControl: r.control,
          tech: r.tech,
          targetX: r.targetX,
          targetY: r.targetY,
          lift: r.lift,
          extra,
          target: {
            semantics: "VERIFIED", rawLong, address, ref: { list: res.list, index: res.index, address: res.address, status: slot.status },
            ...(enemy === undefined ? {} : { enemy }),
          },
          flagPointer: fp,
        };
        continue;
      }
      roster.slots[i] = {
        kind: "ship",
        type: r.type,
        x: r.x,
        y: r.y,
        dx: r.dx,
        dy: r.dy,
        dir: r.direction,
        hp: r.hp,
        mode: r.control,
        tech: r.tech,
        targetX: r.targetX,
        targetY: r.targetY,
        cls: r.shipClass,
        fuel: r.fuel,
        lift: r.lift,
        slot: i,
        sourceAddress: r.address,
        sourceRaw: r.raw.slice(),
        savedControl: r.control,
        extra,
        flagPointer: fp,
      };
    }
    return { ok: true, value: roster };
  }
}

/** Shape check of the decoded enemy slots used for missile resolution; null = fine. */
function checkEnemySlots(enemies: EnemySlotLists): ShipRestoreError | null {
  const lists = [
    { name: "enemyAir", slots: enemies?.air, size: ENEMY_AIR_SLOTS, first: DISK4_ADDR.enemyAir },
    { name: "enemyGround", slots: enemies?.ground, size: ENEMY_GROUND_SLOTS, first: DISK4_ADDR.enemyGround },
  ] as const;
  for (const l of lists) {
    if (!Array.isArray(l.slots) || l.slots.length !== l.size) {
      return { code: "enemy-slots", list: l.name, message: `${l.name} has ${Array.isArray(l.slots) ? l.slots.length : "no"} slots, expected ${l.size}` };
    }
    for (let i = 0; i < l.size; i++) {
      const s = l.slots[i];
      if (!s || s.list !== l.name || s.index !== i || s.address !== l.first + i * ENEMY_RECORD_SIZE ||
        !(s.raw instanceof Uint8Array) || s.raw.length !== ENEMY_RECORD_SIZE || s.type !== s.raw[0] ||
        s.status !== (s.raw[0] === 0 ? "free" : "occupied")) {
        return { code: "enemy-slots", list: l.name, slot: i, field: "record", message: `${l.name} slot ${i} has missing or inconsistent provenance` };
      }
    }
  }
  const o = enemies.objects;
  if (o !== undefined) {
    if (typeof o !== "object" || o === null || !Array.isArray(o.ground) || o.ground.length !== ENEMY_GROUND_SLOTS || !Array.isArray(o.air) || o.air.length !== ENEMY_AIR_SLOTS) {
      return { code: "enemy-object", message: `Enemy objects must be fixed arrays of ${ENEMY_GROUND_SLOTS} ground and ${ENEMY_AIR_SLOTS} air entries (null = free)` };
    }
  }
  return null;
}
