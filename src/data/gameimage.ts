// Constant tables inside the game program image on Disk.1 (loaded at $1000 from sector $14C),
// read at runtime from the user's own disk. Addresses: notes/formats/game-proper.md.

import { SECTOR_SIZE } from "./picture.js";

const IMAGE_FIRST_SECTOR = 0x14c;
const IMAGE_BASE = 0x1000;
const FLAG_TABLE = 0x16408; // cell flag byte per tile id
const FLAG_TABLE_BYTES = 256;
const WEIGHT_TABLE = 0xb0ec; // longs, weight per unit of the five stored goods

function imageOffset(address: number): number {
  return IMAGE_FIRST_SECTOR * SECTOR_SIZE + address - IMAGE_BASE;
}

export function readFlagTable(disk1: Uint8Array): Uint8Array {
  const at = imageOffset(FLAG_TABLE);
  return disk1.slice(at, at + FLAG_TABLE_BYTES);
}

export function readWeights(disk1: Uint8Array): number[] {
  const out: number[] = [];
  const at = imageOffset(WEIGHT_TABLE);
  for (let i = 0; i < 5; i++) {
    const p = at + 4 * i;
    out.push(((disk1[p] << 24) | (disk1[p + 1] << 16) | (disk1[p + 2] << 8) | disk1[p + 3]) >>> 0);
  }
  return out;
}

const INVENTION_TABLE = 0xb1cc; // two words per invention: title string, description string

// String index of the description shown when invention `bit` arrives ($DF5A).
export function readInventionText(disk1: Uint8Array, bit: number): number {
  const at = imageOffset(INVENTION_TABLE) + 4 * bit + 2;
  return (disk1[at] << 8) | disk1[at + 1];
}
