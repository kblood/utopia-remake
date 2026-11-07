// Read-only decoder for the four entity lists of a decoded Disk.4 state (Disk4State).
// Evidence: notes/formats/game-state.md 3.8 (list addresses, record sizes, capacities, unit record
// fields), units.md section 3 (own unit record, free slot = type byte 0, +$14 reservation pointer),
// enemies.md section 2 (enemy record, stride $1A, flag pointer at +$16), ship-control.md sections 2-3
// (ship +$11 order / next mode, +$12 turn direction), sim-port.md (ship class +D, fuel word +E) and
// building-screens.md 3.6 / 5 (missile: 24-bit enemy-record pointer in +$D..+$F, no class/fuel).
//
// Scope: view each list as a FIXED array of slots (30 enemy air, 60 enemy ground, 40 own ships,
// 99 own tanks), in slot order, and decode only the fields the notes document. Nothing is
// compacted, counts are never iteration bounds, pointers stay raw numbers (no resolution to a map
// cell or object), values are not clamped or normalised (signed bytes are only sign-extended where
// the notes call them signed), and the input Disk4State is not mutated. Every slot keeps its exact
// record bytes in `raw`, so bytes the notes do not document (or document only as creation values)
// stay opaque there. A free slot (type byte 0) keeps whatever bytes are stored: the original's
// destroy path ($4732) clears only the word at +0, the byte at +2 and the word at +8, so stale fields
// can remain and are reported as stored. This module is not wired into the game, loader or UI and
// nothing restores units, ships or enemies from it. Tests are synthetic only.
//
// Field offsets are record offsets; all multi-byte values are big-endian.

import { DISK4_ADDR, DISK4_ENTITY_SPECS, type Disk4EntityList, type Disk4State } from "./disk4-state.js";

export type Disk4EntityListName = "enemyAir" | "enemyGround" | "ownShips" | "ownTanks";
/** "free" = type byte 0 (map-rendering.md 7.2 / units.md section 3); anything else is "occupied". Not validated against the count word. */
export type Disk4SlotStatus = "occupied" | "free";

/** Offset of the raw long that points at a per-cell flag byte: +$14 for own units, +$16 for enemies (stride $1A leaves exactly 4 bytes). */
export const DISK4_FLAG_POINTER_OFFSET = { enemyAir: 0x16, enemyGround: 0x16, ownShips: 0x14, ownTanks: 0x14 } as const satisfies Record<Disk4EntityListName, number>;

/** Fields shared by every list (game-state.md 3.8 unit record, enemies.md section 2). */
export interface Disk4EntitySlotBase<L extends Disk4EntityListName> {
  readonly list: L;
  /** 0-based position in the fixed slot array (never re-indexed). */
  readonly index: number;
  /** Original RAM address of this record: list base + index * record size. */
  readonly address: number;
  readonly status: Disk4SlotStatus;
  /** Exact record bytes (copy), recordSize long. */
  readonly raw: Uint8Array;
  /** Raw unsigned long at the list's flag-pointer offset. Documented as the pointer into the per-cell flag bytes ($3D3A6 + y * $66 + x); not validated or resolved. */
  readonly flagPointer: number;
  /** +0. Meaning per list: see the interfaces below. */
  readonly type: number;
  /** +1, +2: map cell (unsigned bytes). */
  readonly x: number;
  readonly y: number;
  /** +3, +4: signed pixel offset from the cell centre. */
  readonly dx: number;
  readonly dy: number;
  /** +5: raw direction byte (0..7 = sprite frame; own ships also use 8 for the parked frame). */
  readonly direction: number;
  /** +6, +7: signed pixel velocity. */
  readonly vx: number;
  readonly vy: number;
  /** +8: raw unsigned byte. Whether the original treats it as signed is not documented; not interpreted. */
  readonly hp: number;
  /** +9: raw byte. Own tanks / enemy ground: bit 7 = waiting for the move tick. Ships: mode 0..8. Enemies: mode. */
  readonly control: number;
  /** +A */
  readonly tech: number;
  /** +B, +C: target cell; $FF in +B = none (raw, not interpreted). */
  readonly targetX: number;
  readonly targetY: number;
}

/** Own tank / ground unit record (units.md section 3). +D..+F (creation values 0 / $FFFF) and +$13 are not documented as fields and stay in `raw`. */
export interface Disk4TankSlot extends Disk4EntitySlotBase<"ownTanks"> {
  /** control & $80 (units.md: bit 7 of +9 = only on the move tick). */
  readonly waiting: boolean;
  /** +$10..+$12 raw bytes: the three directions that would turn the unit back ($FF = none). */
  readonly recentDirections: readonly [number, number, number];
}

/** The ship-list bytes after +$F that ships and missiles share by position (+$10..+$12). */
interface Disk4ShipTail {
  /** +$10: lift; non-zero = airborne cell layer (ship-control.md section 2, sim-ships.ts). */
  readonly lift: number;
  /** +$11: pending order / mode to take after the climb ("nextMode"; 4 = launchpad order pending). */
  readonly nextMode: number;
  /** +$12: turn direction (2 for the hover order, else the direction towards the target at take-off). */
  readonly turn: number;
}

/**
 * Own ship record layout: every type except 17 (types 11..16 = class + 11; also free slots and undocumented types,
 * which keep this layout only so their stale/unknown bytes are reported as stored; nothing validates them here).
 * Same $18 stride as tanks, different overlap from +$D on.
 */
export interface Disk4OrdinaryShipSlot extends Disk4EntitySlotBase<"ownShips">, Disk4ShipTail {
  readonly layout: "ship";
  /** +D: class 0..5 (sim-port / sim-ships.ts). For tanks the same byte is not a documented field. */
  readonly shipClass: number;
  /** +E, +F: raw unsigned word (fuel). Signedness is not documented. */
  readonly fuel: number;
}

/**
 * Ship-list projectile (type 17, missile). Bytes +$C..+$F are a long read and masked by $ACE2
 * (`move.l $C(a6),d2; andi.l #$FFFFFF,d2`), so +$D..+$F are the 24-bit enemy-record address and there is
 * NO class or fuel field. +$C is also the saved target y (`targetY` in the base); +$B is `targetX`.
 * building-screens.md 3.6 / 5 (VERIFIED). The address is not resolved here (see ship-roster.ts).
 */
export interface Disk4MissileSlot extends Disk4EntitySlotBase<"ownShips">, Disk4ShipTail {
  readonly layout: "missile";
  /** The long at +$C exactly as stored (its top byte is +$C = targetY). */
  readonly targetLong: number;
  /** targetLong & $FFFFFF = bytes +$D..+$F: the address $ACE2 dereferences. */
  readonly targetAddress: number;
}

/** Own ship-list record: ordinary layout for every type except 17, missile layout for type 17. */
export type Disk4ShipSlot = Disk4OrdinaryShipSlot | Disk4MissileSlot;

/** Ship-list type byte of a projectile. */
export const DISK4_SHIP_TYPE_MISSILE = 17;

export type Disk4EnemyKind = "walker" | "defected-tank" | "crusher" | "bomber" | "kamikaze" | "unknown";
export type Disk4EnemyAuxMeaning = "bomb-count" | "dive-height" | "crusher-toggle-counter" | "unknown";

/**
 * How the type-dependent enemy bytes are used for this record's type (enemies.md sections 2-3).
 * Bytes are always reported raw; this only labels which meaning the notes give them for that type.
 * "unknown" = the notes document no use of that byte for the type.
 */
export interface Disk4EnemyOverlap {
  readonly kind: Disk4EnemyKind;
  /** +$13: bomber bomb count, kamikaze dive height, crusher toggle (bit 7) + step counter (low 7 bits). */
  readonly aux: Disk4EnemyAuxMeaning;
  /** +$14: "bomb-run-chance" for bombers (roll(100) < +$14), "crusher-animation" for crushers ($11F6E, read by $3768), otherwise unknown. */
  readonly byte14: "bomb-run-chance" | "crusher-animation" | "unknown";
  /** +$15: bomber bomb-run gate (tested against 0 in the bomb run), otherwise unknown. */
  readonly byte15: "bomb-run-gate" | "unknown";
}

/** Fields shared by both enemy lists ($1A stride; enemies.md section 2). */
interface Disk4EnemySlotCommon {
  /** +D: step counter. */
  readonly stepCounter: number;
  /** +E: bomb chance in percent. */
  readonly bombChance: number;
  /** +F: damage. */
  readonly damage: number;
  /** +$13 raw unsigned byte; meaning in `overlap.aux`. */
  readonly aux: number;
  /** +$13 sign-extended (the bomber test is "+$13 below 0"). */
  readonly auxSigned: number;
  /** +$14 raw byte; meaning in `overlap.byte14`. */
  readonly byte14: number;
  /** +$15 raw byte; meaning in `overlap.byte15`. */
  readonly byte15: number;
  readonly overlap: Disk4EnemyOverlap;
}

/** Enemy air list record. Aircraft have no waiting check (enemies.md section 1), so no `waiting`. +$11/+$12 stay in `raw`. */
export interface Disk4EnemyAirSlot extends Disk4EntitySlotBase<"enemyAir">, Disk4EnemySlotCommon {
  /** +$10: lift (aircraft start at $22). */
  readonly lift: number;
}

/** Enemy ground list record. */
export interface Disk4EnemyGroundSlot extends Disk4EntitySlotBase<"enemyGround">, Disk4EnemySlotCommon {
  /** control & $80 (enemies.md section 1: bit 7 of +9 = waiting for the next move tick). */
  readonly waiting: boolean;
  /** +$10..+$12 raw bytes: recent directions ($FF = none). */
  readonly recentDirections: readonly [number, number, number];
}

export interface Disk4DecodedList<S> {
  readonly recordSize: number;
  readonly capacity: number;
  /** Original RAM address of slot 0. */
  readonly address: number;
  /** The count word as stored (validated 0..capacity). Reported only; never used to bound iteration. */
  readonly storedCount: number;
  /** Slots whose type byte is non-zero. */
  readonly occupiedCount: number;
  /** storedCount === occupiedCount. A mismatch is reported, not an error. */
  readonly countMatchesOccupied: boolean;
  /** Exactly `capacity` slots in slot order, free and occupied alike. */
  readonly slots: readonly S[];
}

export interface Disk4Entities {
  readonly enemyAir: Disk4DecodedList<Disk4EnemyAirSlot>;
  readonly enemyGround: Disk4DecodedList<Disk4EnemyGroundSlot>;
  readonly ownShips: Disk4DecodedList<Disk4ShipSlot>;
  readonly ownTanks: Disk4DecodedList<Disk4TankSlot>;
}

export type Disk4EntitiesErrorCode = "not-state" | "list-shape" | "count-range";

export interface Disk4EntitiesError {
  readonly code: Disk4EntitiesErrorCode;
  readonly list?: Disk4EntityListName;
  readonly message: string;
}

export type Disk4EntitiesResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Disk4EntitiesError };

const fail = <T>(code: Disk4EntitiesErrorCode, message: string, list?: Disk4EntityListName): Disk4EntitiesResult<T> => ({
  ok: false,
  error: list === undefined ? { code, message } : { code, list, message },
});

const s8 = (v: number): number => (v << 24) >> 24;
const be16 = (b: Uint8Array, o: number): number => ((b[o] << 8) | b[o + 1]) & 0xffff;
const be32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function enemyOverlap(type: number): Disk4EnemyOverlap {
  switch (type) {
    case 22:
    case 23:
      return { kind: "walker", aux: "unknown", byte14: "unknown", byte15: "unknown" };
    case 9:
    case 10:
      return { kind: "defected-tank", aux: "unknown", byte14: "unknown", byte15: "unknown" };
    case 24:
      return { kind: "crusher", aux: "crusher-toggle-counter", byte14: "crusher-animation", byte15: "unknown" };
    case 25:
      return { kind: "bomber", aux: "bomb-count", byte14: "bomb-run-chance", byte15: "bomb-run-gate" };
    case 26:
    case 27:
      return { kind: "kamikaze", aux: "dive-height", byte14: "unknown", byte15: "unknown" };
    default:
      return { kind: "unknown", aux: "unknown", byte14: "unknown", byte15: "unknown" };
  }
}

function enemyCommon(r: Uint8Array): Disk4EnemySlotCommon {
  return {
    stepCounter: r[0x0d],
    bombChance: r[0x0e],
    damage: r[0x0f],
    aux: r[0x13],
    auxSigned: s8(r[0x13]),
    byte14: r[0x14],
    byte15: r[0x15],
    overlap: enemyOverlap(r[0]),
  };
}

function base<L extends Disk4EntityListName>(list: L, index: number, address: number, raw: Uint8Array): Disk4EntitySlotBase<L> {
  return {
    list,
    index,
    address,
    status: raw[0] === 0 ? "free" : "occupied",
    raw,
    flagPointer: be32(raw, DISK4_FLAG_POINTER_OFFSET[list]),
    type: raw[0],
    x: raw[1],
    y: raw[2],
    dx: s8(raw[3]),
    dy: s8(raw[4]),
    direction: raw[5],
    vx: s8(raw[6]),
    vy: s8(raw[7]),
    hp: raw[8],
    control: raw[9],
    tech: raw[10],
    targetX: raw[11],
    targetY: raw[12],
  };
}

function decodeList<L extends Disk4EntityListName, S>(
  name: L,
  list: Disk4EntityList | undefined,
  build: (b: Disk4EntitySlotBase<L>, raw: Uint8Array) => S,
): Disk4EntitiesResult<Disk4DecodedList<S>> {
  const spec = DISK4_ENTITY_SPECS[name];
  if (typeof list !== "object" || list === null || !(list.records instanceof Uint8Array)) {
    return fail("list-shape", `${name}: list is missing or has no records buffer`, name);
  }
  if (list.recordSize !== spec.recordSize || list.capacity !== spec.capacity || list.records.length !== spec.capacity * spec.recordSize) {
    return fail(
      "list-shape",
      `${name}: expected record size ${spec.recordSize}, capacity ${spec.capacity} and ${spec.capacity * spec.recordSize} bytes; got ${list.recordSize}, ${list.capacity}, ${list.records.length}`,
      name,
    );
  }
  if (!Number.isInteger(list.count) || list.count < 0 || list.count > spec.capacity) {
    return fail("count-range", `${name}: count ${list.count} is not an integer in 0..${spec.capacity}`, name);
  }
  const address = DISK4_ADDR[name];
  const slots: S[] = [];
  let occupied = 0;
  for (let i = 0; i < spec.capacity; i++) {
    const raw = list.records.slice(i * spec.recordSize, (i + 1) * spec.recordSize);
    if (raw[0] !== 0) occupied++;
    slots.push(build(base(name, i, address + i * spec.recordSize, raw), raw));
  }
  return {
    ok: true,
    value: {
      recordSize: spec.recordSize,
      capacity: spec.capacity,
      address,
      storedCount: list.count,
      occupiedCount: occupied,
      countMatchesOccupied: list.count === occupied,
      slots,
    },
  };
}

const recent = (r: Uint8Array): readonly [number, number, number] => [r[0x10], r[0x11], r[0x12]];

/**
 * Decodes the four entity lists of a Disk4State into fixed slot arrays. Pure and total: a malformed
 * state (not an object, wrong list shape, count outside 0..capacity) returns a typed error and no
 * partial result. Results are copies; the input is not modified and later changes to it do not
 * affect the result.
 */
export function decodeDisk4Entities(state: Disk4State): Disk4EntitiesResult<Disk4Entities> {
  if (typeof state !== "object" || state === null) return fail("not-state", "Input must be a Disk4State (as returned by decodeDisk4State)");
  const air = decodeList("enemyAir", state.enemyAir, (b, r) => ({ ...b, ...enemyCommon(r), lift: r[0x10] }) as Disk4EnemyAirSlot);
  if (!air.ok) return air;
  const ground = decodeList(
    "enemyGround",
    state.enemyGround,
    (b, r) => ({ ...b, ...enemyCommon(r), waiting: (r[9] & 0x80) !== 0, recentDirections: recent(r) }) as Disk4EnemyGroundSlot,
  );
  if (!ground.ok) return ground;
  const ships = decodeList(
    "ownShips",
    state.ownShips,
    (b, r): Disk4ShipSlot => {
      const tail = { lift: r[0x10], nextMode: r[0x11], turn: r[0x12] };
      if (r[0] === DISK4_SHIP_TYPE_MISSILE) {
        const targetLong = be32(r, 0x0c);
        return { ...b, ...tail, layout: "missile", targetLong, targetAddress: (targetLong & 0xffffff) >>> 0 };
      }
      return { ...b, ...tail, layout: "ship", shipClass: r[0x0d], fuel: be16(r, 0x0e) };
    },
  );
  if (!ships.ok) return ships;
  const tanks = decodeList(
    "ownTanks",
    state.ownTanks,
    (b, r) => ({ ...b, waiting: (r[9] & 0x80) !== 0, recentDirections: recent(r) }) as Disk4TankSlot,
  );
  if (!tanks.ok) return tanks;
  return { ok: true, value: { enemyAir: air.value, enemyGround: ground.value, ownShips: ships.value, ownTanks: tanks.value } };
}
