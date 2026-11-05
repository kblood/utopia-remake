// Object sprites (units, marker pins, effects). Layout: notes/formats/map-rendering.md, section 7.3.
// 27 object types: 21 built-in (descriptors in the game image at $12D6A, images in the Disk.1 block of
// sectors $25C-$280, LZ-packed) and 6 scenario-specific ones (descriptors at the start of the scenario
// block, images in the raw sprite sheet of the scenario record, +$10). Everything is read from the
// user's own disk images at runtime.

import { SECTOR_SIZE, type SectorRange } from "./picture.js";
import { unpackLz } from "./unpack.js";
import type { ScenarioRecord } from "./scenario.js";

export const SPRITE_WIDTH = 32;
export const SPRITE_PLANES = 5;

const GAME_FIRST_SECTOR = 0x14c; // game image sectors $14C-$208, loaded at $1000
const GAME_BASE = 0x1000;
const DESCRIPTORS = 0x12d6a;
const DESCRIPTOR_SIZE = 0x22;
const BUILTIN_TYPES = 21;
const SCENARIO_TYPES = 6;
export const SPRITE_TYPES = BUILTIN_TYPES + SCENARIO_TYPES;
const FRAME_SLOTS = 9;
const BUILTIN_SHEET = { first: 0x25c, last: 0x280 } satisfies SectorRange; // packed, 47,280 bytes

// Object type that adds an animation counter (entry byte +$14) to the frame address ($3768).
export const TYPE_ANIMATED = 0x18;

export interface SpriteType {
  type: number; // 1-based, as in byte +0 of an object entry
  rows: number;
  frameBytes: number; // descriptor +8
  planeBytes: number; // descriptor +$20 (rows * 4)
  frameOffsets: number[]; // nine byte offsets, indexed by the object's frame/direction byte
  image: number; // offset of the first frame's colour planes in `sheet`
  mask: number; // offset of the first frame's mask plane in `sheet`
  sheet: Uint8Array;
}

// One decoded frame: palette indices plus an opacity flag per pixel, row 0 = TOP row.
export interface SpriteFrame {
  rows: number;
  index: Uint8Array;
  opaque: Uint8Array;
}

function word(data: Uint8Array, at: number): number {
  return (data[at] << 8) | data[at + 1];
}

function long(data: Uint8Array, at: number): number {
  return ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
}

function sectors(disk: Uint8Array, range: SectorRange): Uint8Array {
  return disk.subarray(range.first * SECTOR_SIZE, (range.last + 1) * SECTOR_SIZE);
}

// Reads one $22-byte descriptor; null for the all-zero placeholders of unused scenario slots.
function readDescriptor(raw: Uint8Array, at: number, type: number, sheet: Uint8Array): SpriteType | null {
  const frameBytes = word(raw, at + 8);
  if (frameBytes === 0) return null;
  const frameOffsets: number[] = [];
  for (let i = 0; i < FRAME_SLOTS; i++) frameOffsets.push(word(raw, at + 0xe + 2 * i));
  return {
    type,
    rows: word(raw, at + 0xa) + 1,
    frameBytes,
    planeBytes: word(raw, at + 0x20),
    frameOffsets,
    image: long(raw, at), // relocated by the original's base; here an offset into `sheet`
    mask: long(raw, at + 4),
    sheet,
  };
}

export class SpriteSet {
  private readonly cache = new Map<number, SpriteFrame>();

  // Index = type - 1.
  constructor(readonly types: (SpriteType | null)[]) {}

  has(type: number): boolean {
    return this.types[type - 1] != null;
  }

  // Frame `frame` (0-8) of object type `type`. `animation` is the extra counter of type $18.
  frame(type: number, frame: number, animation = 0): SpriteFrame | null {
    const t = this.types[type - 1];
    if (!t) return null;
    const key = (type << 16) | (animation << 8) | frame;
    let decoded = this.cache.get(key);
    if (!decoded) {
      let shift = 0;
      if (type === TYPE_ANIMATED && animation > 0) shift = t.frameBytes * 8 * animation;
      const base = t.frameOffsets[frame] + shift;
      decoded = decodeFrame(t, t.image + base, t.mask + base);
      this.cache.set(key, decoded);
    }
    return decoded;
  }
}

function decodeFrame(t: SpriteType, image: number, mask: number): SpriteFrame {
  const { rows, sheet, planeBytes } = t;
  const index = new Uint8Array(rows * SPRITE_WIDTH);
  const opaque = new Uint8Array(rows * SPRITE_WIDTH);
  for (let row = 0; row < rows; row++) {
    const top = rows - 1 - row; // rows are stored bottom row first
    for (let px = 0; px < SPRITE_WIDTH; px++) {
      const at = row * 4 + (px >> 3);
      const bit = 7 - (px & 7);
      if (((sheet[mask + at] ?? 0) >> bit) & 1) {
        let value = 0;
        for (let plane = 0; plane < SPRITE_PLANES; plane++) {
          value |= (((sheet[image + plane * planeBytes + at] ?? 0) >> bit) & 1) << plane;
        }
        index[top * SPRITE_WIDTH + px] = value;
        opaque[top * SPRITE_WIDTH + px] = 1;
      }
    }
  }
  return { rows, index, opaque };
}

function builtinTypes(disk1: Uint8Array): (SpriteType | null)[] {
  const gameStart = GAME_FIRST_SECTOR * SECTOR_SIZE - GAME_BASE;
  const builtinSheet = unpackLz(sectors(disk1, BUILTIN_SHEET));
  const types: (SpriteType | null)[] = [];
  for (let i = 0; i < BUILTIN_TYPES; i++) {
    types.push(readDescriptor(disk1, gameStart + DESCRIPTORS + i * DESCRIPTOR_SIZE, i + 1, builtinSheet));
  }
  return types;
}

const builtinCache = new WeakMap<Uint8Array, SpriteSet>();

// The 21 built-in sprite types only (marker pins, units, ships, effects), which need Disk.1 alone.
// The window screens use it for the ship and marker icons; the result is cached per disk.
export function loadBuiltinSprites(disk1: Uint8Array): SpriteSet {
  let set = builtinCache.get(disk1);
  if (!set) {
    set = new SpriteSet([...builtinTypes(disk1), ...Array.from({ length: SCENARIO_TYPES }, () => null)]);
    builtinCache.set(disk1, set);
  }
  return set;
}

// Builds the 27 sprite types for a scenario: the 21 built-in ones and the scenario's six.
export function loadSprites(disk1: Uint8Array, disk2: Uint8Array, record: ScenarioRecord): SpriteSet {
  const types = builtinTypes(disk1);
  const scenarioSheet = sectors(disk2, record.sprites);
  const block = sectors(disk2, record.block);
  for (let i = 0; i < SCENARIO_TYPES; i++) {
    types.push(readDescriptor(block, i * DESCRIPTOR_SIZE, BUILTIN_TYPES + i + 1, scenarioSheet));
  }
  return new SpriteSet(types);
}
