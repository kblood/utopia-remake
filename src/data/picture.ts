// Decodes a packed 320x200, 5-bitplane picture from the user's Disk.1 image.
// Layout of the unpacked data: 5 planes of 8000 bytes (non-interleaved), then 32 OCS palette words.

import { unpackLz } from "./unpack.js";

export const SECTOR_SIZE = 512;
export const PIC_WIDTH = 320;
export const PIC_HEIGHT = 200;
const PLANES = 5;
const PLANE_BYTES = (PIC_WIDTH / 8) * PIC_HEIGHT;
const PALETTE_COLORS = 32;

export interface Picture {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

// Sector range of the title picture on Disk.1, inclusive.
export const TITLE_SECTORS = { first: 0x70a, last: 0x728 };

export function decodePicture(disk: Uint8Array, first: number, last: number): Picture {
  const packed = disk.subarray(first * SECTOR_SIZE, (last + 1) * SECTOR_SIZE);
  const data = unpackLz(packed);
  if (data.length < PLANES * PLANE_BYTES + PALETTE_COLORS * 2) {
    throw new Error(`decodePicture: unpacked ${data.length} bytes, too short`);
  }

  const palette: number[][] = [];
  for (let i = 0; i < PALETTE_COLORS; i++) {
    const word = (data[PLANES * PLANE_BYTES + i * 2] << 8) | data[PLANES * PLANE_BYTES + i * 2 + 1];
    palette.push([((word >> 8) & 15) * 17, ((word >> 4) & 15) * 17, (word & 15) * 17]);
  }

  const rgba = new Uint8ClampedArray(new ArrayBuffer(PIC_WIDTH * PIC_HEIGHT * 4));
  const rowBytes = PIC_WIDTH / 8;
  for (let y = 0; y < PIC_HEIGHT; y++) {
    for (let x = 0; x < PIC_WIDTH; x++) {
      let index = 0;
      for (let plane = 0; plane < PLANES; plane++) {
        const byte = data[plane * PLANE_BYTES + y * rowBytes + (x >> 3)];
        index |= ((byte >> (7 - (x & 7))) & 1) << plane;
      }
      const o = (y * PIC_WIDTH + x) * 4;
      rgba[o] = palette[index][0];
      rgba[o + 1] = palette[index][1];
      rgba[o + 2] = palette[index][2];
      rgba[o + 3] = 255;
    }
  }

  return { width: PIC_WIDTH, height: PIC_HEIGHT, rgba };
}
