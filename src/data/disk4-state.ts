// Pure decoder for the documented contents of Disk.4 save areas A and B.
// Evidence: notes/formats/game-state.md sections 1, 3.8, 7.2 and 9 (VERIFIED extents and address
// ranges) and notes/formats/game-proper.md sections 6-7 (map layout).
//
// Scope: slice the VERIFIED ranges of a populated slot (Disk4SlotAreas from readDisk4Slot) into
// typed views: map cell words, per-cell flag bytes, the 1000 object records, and the four entity
// lists with their counts. Every byte is copied verbatim. Higher layers read saved scenario
// metadata and prepare/activate a limited continuation, but this decoder does not select a
// scenario or reproduce all original post-load behavior. Fields it does not document remain in
// the raw areaA/areaB copies. The activation remains experimental; one populated save was observed
// only as a memory-derived Copperline capture (2026-11-06, slot 0 REFRUN), not persisted write-through.
//
// Addresses below are original RAM addresses. Area A is loaded to/saved from $39E3A (73 sectors,
// 37,376 bytes); area B is $13034..$14633 (11 sectors, 5,632 bytes). All values are big-endian.

import type { Disk4SlotAreas } from "./disk4.js";

/** RAM address area A is loaded to / saved from. */
export const DISK4_AREA_A_BASE = 0x39e3a;
/** RAM address area B is loaded to / saved from (scenario block followed by the variable block). */
export const DISK4_AREA_B_BASE = 0x13034;
export const DISK4_AREA_A_BYTES = 73 * 512;
export const DISK4_AREA_B_BYTES = 11 * 512;

export const DISK4_MAP_WIDTH = 100;
export const DISK4_MAP_HEIGHT = 75;
/** Words per map row in memory: 100 cells plus 2 pad words. */
export const DISK4_MAP_ROW_WORDS = 102;
/** Bytes per per-cell flag row: same 102-column stride as the map. */
export const DISK4_FLAG_ROW_BYTES = 102;
export const DISK4_OBJECT_SLOTS = 1000;
export const DISK4_OBJECT_RECORD_SIZE = 8;

/** RAM addresses of the documented regions inside area A (game-state.md section 1 and 3.8). */
export const DISK4_ADDR = {
  enemyAir: 0x39e3a,
  enemyGround: 0x3a146,
  ownShips: 0x3a75e,
  ownTanks: 0x3ab1e,
  objects: 0x3b466,
  flags: 0x3d3a6,
  mapCells: 0x3f256,
  /** Count words in the variable block (area B). */
  countEnemyAir: 0x142a4,
  countEnemyGround: 0x142a2,
  countOwnShips: 0x1429e,
  countOwnTanks: 0x1429c,
  countObjects: 0x142c2,
} as const;

export interface Disk4EntityListSpec {
  readonly recordSize: number;
  readonly capacity: number;
}
/** Record size and slot capacity per list (game-state.md section 3.8). */
export const DISK4_ENTITY_SPECS = {
  enemyAir: { recordSize: 0x1a, capacity: 30 },
  enemyGround: { recordSize: 0x1a, capacity: 60 },
  ownShips: { recordSize: 0x18, capacity: 40 },
  ownTanks: { recordSize: 0x18, capacity: 99 },
} as const satisfies Record<string, Disk4EntityListSpec>;

export type Disk4StateErrorCode = "not-areas" | "area-a-size" | "area-b-size" | "count-range";

export interface Disk4StateError {
  readonly code: Disk4StateErrorCode;
  readonly message: string;
}

export type Disk4StateResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Disk4StateError };

/**
 * A raw entity list: the full slot array exactly as stored (capacity * recordSize bytes) plus the
 * stored count word. Slots are not compacted: units are allocated at the first free slot, so used
 * records are not guaranteed to be a prefix of `records`, and which slots are "used" is not decided here.
 */
export interface Disk4EntityList {
  readonly recordSize: number;
  readonly capacity: number;
  /** Count word from the variable block, validated to 0..capacity. */
  readonly count: number;
  /** capacity * recordSize bytes (copy). */
  readonly records: Uint8Array;
}

export interface Disk4ObjectRecords {
  readonly recordSize: number;
  readonly slots: number;
  /** Word $142C2 ("number of used object records"), validated to 0..1000. */
  readonly count: number;
  /** 1000 * 8 bytes (copy). Per record: +0 word tile id (0 = free), +2..+7 as in game-state.md 7.2; not decoded here. */
  readonly records: Uint8Array;
}

export interface Disk4State {
  readonly name: string;
  /** Untouched copy of area A (37,376 bytes); holds every byte outside the documented ranges (list headers' tails, gaps, map header, pad words). */
  readonly areaA: Uint8Array;
  /** Untouched copy of area B (5,632 bytes): scenario block + variable block, byte for byte. */
  readonly areaB: Uint8Array;
  /** 75 rows x 100 cell words, row-major (index y * 100 + x), padding words dropped. Raw words: tile id/flag bits not split. */
  readonly mapCells: Uint16Array;
  /** 75 rows x 102 bytes, row-major (index y * 102 + x); columns 100 and 101 are kept as stored (padding, semantics unknown). */
  readonly cellFlags: Uint8Array;
  readonly objects: Disk4ObjectRecords;
  readonly enemyAir: Disk4EntityList;
  readonly enemyGround: Disk4EntityList;
  readonly ownTanks: Disk4EntityList;
  readonly ownShips: Disk4EntityList;
}

const fail = <T>(code: Disk4StateErrorCode, message: string): Disk4StateResult<T> => ({ ok: false, error: { code, message } });

const hex = (n: number): string => `$${n.toString(16).toUpperCase()}`;

const be16 = (b: Uint8Array, o: number): number => ((b[o] << 8) | b[o + 1]) & 0xffff;

/** Byte offset of a RAM address inside area A / area B. */
const offA = (addr: number): number => addr - DISK4_AREA_A_BASE;
const offB = (addr: number): number => addr - DISK4_AREA_B_BASE;

function readCount(areaB: Uint8Array, addr: number, label: string, max: number): Disk4StateResult<number> {
  const count = be16(areaB, offB(addr));
  if (count > max) return fail("count-range", `${label} count (word at ${hex(addr)}) is ${count}, maximum is ${max}`);
  return { ok: true, value: count };
}

function readList(
  areaA: Uint8Array,
  areaB: Uint8Array,
  label: string,
  addr: number,
  countAddr: number,
  spec: Disk4EntityListSpec,
): Disk4StateResult<Disk4EntityList> {
  const count = readCount(areaB, countAddr, label, spec.capacity);
  if (!count.ok) return count;
  const start = offA(addr);
  return {
    ok: true,
    value: {
      recordSize: spec.recordSize,
      capacity: spec.capacity,
      count: count.value,
      records: areaA.slice(start, start + spec.capacity * spec.recordSize),
    },
  };
}

/**
 * Decodes the documented regions of a slot's areas. Pure and total: wrong input shapes or sizes and
 * out-of-range counts return a typed error and no partial state. All returned buffers are copies, so
 * later changes to the input do not affect the result.
 */
export function decodeDisk4State(areas: Disk4SlotAreas): Disk4StateResult<Disk4State> {
  if (typeof areas !== "object" || areas === null || !(areas.areaA instanceof Uint8Array) || !(areas.areaB instanceof Uint8Array)) {
    return fail("not-areas", "Input must be { name, areaA: Uint8Array, areaB: Uint8Array } (as returned by readDisk4Slot)");
  }
  if (areas.areaA.length !== DISK4_AREA_A_BYTES) {
    return fail("area-a-size", `Area A is ${areas.areaA.length} bytes, expected exactly ${DISK4_AREA_A_BYTES}`);
  }
  if (areas.areaB.length !== DISK4_AREA_B_BYTES) {
    return fail("area-b-size", `Area B is ${areas.areaB.length} bytes, expected exactly ${DISK4_AREA_B_BYTES}`);
  }
  const name = typeof areas.name === "string" ? areas.name : "";
  const a = areas.areaA.slice();
  const b = areas.areaB.slice();

  const air = readList(a, b, "Enemy air", DISK4_ADDR.enemyAir, DISK4_ADDR.countEnemyAir, DISK4_ENTITY_SPECS.enemyAir);
  if (!air.ok) return air;
  const ground = readList(a, b, "Enemy ground", DISK4_ADDR.enemyGround, DISK4_ADDR.countEnemyGround, DISK4_ENTITY_SPECS.enemyGround);
  if (!ground.ok) return ground;
  const tanks = readList(a, b, "Own tank", DISK4_ADDR.ownTanks, DISK4_ADDR.countOwnTanks, DISK4_ENTITY_SPECS.ownTanks);
  if (!tanks.ok) return tanks;
  const ships = readList(a, b, "Own ship", DISK4_ADDR.ownShips, DISK4_ADDR.countOwnShips, DISK4_ENTITY_SPECS.ownShips);
  if (!ships.ok) return ships;
  const objCount = readCount(b, DISK4_ADDR.countObjects, "Object record", DISK4_OBJECT_SLOTS);
  if (!objCount.ok) return objCount;

  const objStart = offA(DISK4_ADDR.objects);
  const objects: Disk4ObjectRecords = {
    recordSize: DISK4_OBJECT_RECORD_SIZE,
    slots: DISK4_OBJECT_SLOTS,
    count: objCount.value,
    records: a.slice(objStart, objStart + DISK4_OBJECT_SLOTS * DISK4_OBJECT_RECORD_SIZE),
  };

  const flagStart = offA(DISK4_ADDR.flags);
  const cellFlags = a.slice(flagStart, flagStart + DISK4_MAP_HEIGHT * DISK4_FLAG_ROW_BYTES);

  const mapStart = offA(DISK4_ADDR.mapCells);
  const mapCells = new Uint16Array(DISK4_MAP_WIDTH * DISK4_MAP_HEIGHT);
  for (let y = 0; y < DISK4_MAP_HEIGHT; y++) {
    const row = mapStart + y * DISK4_MAP_ROW_WORDS * 2;
    for (let x = 0; x < DISK4_MAP_WIDTH; x++) mapCells[y * DISK4_MAP_WIDTH + x] = be16(a, row + x * 2);
  }

  return {
    ok: true,
    value: { name, areaA: a, areaB: b, mapCells, cellFlags, objects, enemyAir: air.value, enemyGround: ground.value, ownTanks: tanks.value, ownShips: ships.value },
  };
}
