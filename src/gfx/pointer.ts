// Mouse pointer images taken from the game image in the user's Disk.1. A descriptor is
// {rows-1, image address, mask address}: 32 pixels wide, 5 bit-planes one after the other,
// one mask plane. $4A74 is the arrow and $4AA4 is the map-cell hover variant.

import { SECTOR_SIZE } from "../data/picture.js";
import type { Screen } from "./screen.js";

const IMAGE_START = 0x14c * SECTOR_SIZE;
const IMAGE_BASE = 0x1000;
export const POINTER_ARROW = 0x4a74;
export const POINTER_CELL_HOVER = 0x4aa4;
const PLANES = 5;
const WIDTH = 32;

export interface PointerImage {
  rows: number;
  index: Uint8Array; // rows * 32 palette indices
  opaque: Uint8Array; // rows * 32 flags
  /** Offset from the pointer position to the image's top-left corner (0,0 for the software arrow). */
  hotspot: { readonly x: number; readonly y: number };
}

// The boot stage's pointer is hardware sprite 2 (text.md, "Pointer visibility"). The VBL handler (`$78F40`-`$78FF6`) builds its
// control words at `$79282` from the pointer position (`$79104` x, `$79106` y): VSTART = y - 5 + $2C, VSTOP = VSTART + 11, and
// HSTART = x - 5 + $80. The image data follows the two control words, one word per plane per row, 11 rows (`$79286`-`$792B1`).
// Sprite colour 1..3 is COLOR25..27 (sprite 2 uses colour registers 24 + colour). Decoded from Disk.1 only (text.md has the trace).
const BOOT_SPRITE_DATA = 0x79286;
const BOOT_SPRITE_ROWS = 11;
const BOOT_SPRITE_WIDTH = 16;
const BOOT_SPRITE_COLOUR_BASE = 24;
const BOOT_RAM_TO_FILE = 0x74f18;
/** Pointer position is the hotspot: the sprite's top-left is 5 pixels up and left of the position (`$78F80`-`$78F98`). */
export const BOOT_SPRITE_HOTSPOT = 5;

function offset(address: number): number {
  return IMAGE_START + address - IMAGE_BASE;
}

function word(disk: Uint8Array, address: number): number {
  const at = address - BOOT_RAM_TO_FILE;
  if (at < 0 || at + 1 >= disk.length) throw new RangeError(`boot sprite word $${address.toString(16)} is outside Disk.1`);
  return (disk[at] << 8) | disk[at + 1];
}

/** The boot stage's hardware sprite 2 as the VBL handler sets it up, decoded from the image (see the constants above). */
export function readBootPointer(disk: Uint8Array): PointerImage {
  const index = new Uint8Array(BOOT_SPRITE_ROWS * WIDTH);
  const opaque = new Uint8Array(BOOT_SPRITE_ROWS * WIDTH);
  for (let row = 0; row < BOOT_SPRITE_ROWS; row++) {
    const plane0 = word(disk, BOOT_SPRITE_DATA + row * 4);
    const plane1 = word(disk, BOOT_SPRITE_DATA + row * 4 + 2);
    for (let x = 0; x < BOOT_SPRITE_WIDTH; x++) {
      const bit = 15 - x;
      const colour = ((plane0 >> bit) & 1) | (((plane1 >> bit) & 1) << 1);
      if (colour === 0) continue; // colour 0 is transparent for a sprite
      index[row * WIDTH + x] = BOOT_SPRITE_COLOUR_BASE + colour;
      opaque[row * WIDTH + x] = 1;
    }
  }
  return { rows: BOOT_SPRITE_ROWS, index, opaque, hotspot: { x: BOOT_SPRITE_HOTSPOT, y: BOOT_SPRITE_HOTSPOT } };
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
  return { rows, index, opaque, hotspot: { x: 0, y: 0 } };
}

// Draws the pointer, hotspot at (x, y), into an RGBA frame of the screen's size.
export function drawPointer(pointer: PointerImage, screen: Screen, rgba: Uint8ClampedArray, x: number, y: number): void {
  const left = x - pointer.hotspot.x;
  const top = y - pointer.hotspot.y;
  for (let row = 0; row < pointer.rows; row++) {
    for (let col = 0; col < WIDTH; col++) {
      if (!pointer.opaque[row * WIDTH + col]) continue;
      const px = left + col;
      const py = top + row;
      if (px < 0 || py < 0 || px >= 320 || py >= 200) continue;
      const [r, g, b] = screen.palette[pointer.index[row * WIDTH + col]];
      const i = (py * 320 + px) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
    }
  }
}

// Stamps the pointer's opaque pixels into a screen's palette indices, hotspot at (x, y), clipped to the screen. The boot sprite is
// on top of the picture (`BPLCON2` `$0024`: sprite 2 is above playfield 1), so its pixels replace the picture's.
export function stampPointer(pointer: PointerImage, screen: Screen, x: number, y: number): void {
  const left = x - pointer.hotspot.x;
  const top = y - pointer.hotspot.y;
  for (let row = 0; row < pointer.rows; row++) {
    for (let col = 0; col < WIDTH; col++) {
      if (!pointer.opaque[row * WIDTH + col]) continue;
      const px = left + col;
      const py = top + row;
      if (px < 0 || py < 0 || px >= 320 || py >= 200) continue;
      screen.pixels[py * 320 + px] = pointer.index[row * WIDTH + col];
    }
  }
}
