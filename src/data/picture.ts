// Decodes a packed 320x200, 5-bitplane picture from the user's Disk.1 image into a Screen.
// Layout of the unpacked data: 5 planes of 8000 bytes (non-interleaved), then 32 OCS palette words.

import { ocsColor, PALETTE_SIZE, Screen, SCREEN_HEIGHT, SCREEN_WIDTH } from "../gfx/screen.js";
import { unpackLz } from "./unpack.js";

export const SECTOR_SIZE = 512;
const PLANES = 5;
const ROW_BYTES = SCREEN_WIDTH / 8;
const PLANE_BYTES = ROW_BYTES * SCREEN_HEIGHT;

export interface SectorRange {
  first: number;
  last: number;
}

// Sector ranges of the full-screen pictures on Disk.1 (inclusive).
export const PICTURES = {
  presents: { first: 0x729, last: 0x733 },
  language: { first: 0x5a, last: 0x5f },
  title: { first: 0x70a, last: 0x728 },
  main: { first: 0x282, last: 0x2a0 },
} satisfies Record<string, SectorRange>;

export function decodePicture(disk: Uint8Array, range: SectorRange, target: Screen = new Screen()): Screen {
  const packed = disk.subarray(range.first * SECTOR_SIZE, (range.last + 1) * SECTOR_SIZE);
  const data = unpackLz(packed);
  if (data.length < PLANES * PLANE_BYTES + PALETTE_SIZE * 2) {
    throw new Error(`decodePicture: unpacked ${data.length} bytes, too short`);
  }

  for (let i = 0; i < PALETTE_SIZE; i++) {
    const at = PLANES * PLANE_BYTES + i * 2;
    target.palette[i] = ocsColor((data[at] << 8) | data[at + 1]);
  }

  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      let index = 0;
      for (let plane = 0; plane < PLANES; plane++) {
        const byte = data[plane * PLANE_BYTES + y * ROW_BYTES + (x >> 3)];
        index |= ((byte >> (7 - (x & 7))) & 1) << plane;
      }
      target.pixels[y * SCREEN_WIDTH + x] = index;
    }
  }
  return target;
}
