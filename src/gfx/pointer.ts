// Mouse pointer image taken from the game image in the user's Disk.1. A descriptor is
// {rows-1, image address, mask address}: 32 pixels wide, 5 bit-planes one after the other,
// one mask plane. Only the descriptor at $4A74 (the arrow) is used so far.

import { SECTOR_SIZE } from "../data/picture.js";
import type { Screen } from "./screen.js";

const IMAGE_START = 0x14c * SECTOR_SIZE;
const IMAGE_BASE = 0x1000;
export const POINTER_ARROW = 0x4a74;
const PLANES = 5;
const WIDTH = 32;

export interface PointerImage {
  rows: number;
  index: Uint8Array; // rows * 32 palette indices
  opaque: Uint8Array; // rows * 32 flags
}

function offset(address: number): number {
  return IMAGE_START + address - IMAGE_BASE;
}

function long(disk: Uint8Array, address: number): number {
  const at = offset(address);
  return ((disk[at] << 24) | (disk[at + 1] << 16) | (disk[at + 2] << 8) | disk[at + 3]) >>> 0;
}

export function readPointer(disk: Uint8Array, descriptor: number): PointerImage {
  const rows = (long(disk, descriptor) & 0x7fff) + 1;
  const image = long(disk, descriptor + 4);
  const mask = long(disk, descriptor + 8);
  const index = new Uint8Array(rows * WIDTH);
  const opaque = new Uint8Array(rows * WIDTH);
  for (let row = 0; row < rows; row++) {
    const m = long(disk, mask + row * 4);
    for (let x = 0; x < WIDTH; x++) {
      const bit = 31 - x;
      if (((m >>> bit) & 1) === 0) continue;
      let value = 0;
      for (let plane = 0; plane < PLANES; plane++) {
        value |= ((long(disk, image + (plane * rows + row) * 4) >>> bit) & 1) << plane;
      }
      index[row * WIDTH + x] = value;
      opaque[row * WIDTH + x] = 1;
    }
  }
  return { rows, index, opaque };
}

// Draws the pointer with its top-left corner at (x, y) into an RGBA frame of the screen's size.
export function drawPointer(pointer: PointerImage, screen: Screen, rgba: Uint8ClampedArray, x: number, y: number): void {
  for (let row = 0; row < pointer.rows; row++) {
    for (let col = 0; col < WIDTH; col++) {
      if (!pointer.opaque[row * WIDTH + col]) continue;
      const px = x + col;
      const py = y + row;
      if (px < 0 || py < 0 || px >= 320 || py >= 200) continue;
      const [r, g, b] = screen.palette[pointer.index[row * WIDTH + col]];
      const i = (py * 320 + px) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
    }
  }
}
