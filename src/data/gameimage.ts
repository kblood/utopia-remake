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

const LIGHT_TABLE = 0x15628; // four 16-byte entries: long, long = image address, word x, word y, flag byte, toggle byte
const LIGHT_ROWS = 16;

// The four 16 x 16 warning-light icons drawn by $5D30 / $5876 (power, event bookmark, food, air). Each
// image is 5 bit-planes of 16 rows x 2 bytes, no mask; the result is 256 palette indices per icon.
export function readLightIcons(disk1: Uint8Array): Uint8Array[] {
  const icons: Uint8Array[] = [];
  for (let k = 0; k < 4; k++) {
    const e = imageOffset(LIGHT_TABLE) + 16 * k;
    const address = ((disk1[e + 4] << 24) | (disk1[e + 5] << 16) | (disk1[e + 6] << 8) | disk1[e + 7]) >>> 0;
    const at = imageOffset(address);
    const pixels = new Uint8Array(16 * LIGHT_ROWS);
    for (let plane = 0; plane < 5; plane++) {
      for (let row = 0; row < LIGHT_ROWS; row++) {
        const word = (disk1[at + plane * 32 + row * 2] << 8) | disk1[at + plane * 32 + row * 2 + 1];
        for (let x = 0; x < 16; x++) pixels[row * 16 + x] |= ((word >> (15 - x)) & 1) << plane;
      }
    }
    icons.push(pixels);
  }
  return icons;
}
