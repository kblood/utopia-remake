// Read-only access to the game program image inside the user's Disk.1 (loaded at $1000 from
// sector $14C). The F-key screens keep their window rectangles, label lists, button image
// tables and pointer tables there, so they are read at runtime instead of being copied.

import { SECTOR_SIZE } from "../../data/picture.js";

const IMAGE_START = 0x14c * SECTOR_SIZE;
const IMAGE_BASE = 0x1000;

export class GameImage {
  constructor(readonly disk: Uint8Array) {}

  private at(address: number): number {
    return IMAGE_START + address - IMAGE_BASE;
  }

  byte(address: number): number {
    return this.disk[this.at(address)];
  }

  word(address: number): number {
    const p = this.at(address);
    return (this.disk[p] << 8) | this.disk[p + 1];
  }

  signedWord(address: number): number {
    const v = this.word(address);
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  long(address: number): number {
    const p = this.at(address);
    return ((this.disk[p] << 24) | (this.disk[p + 1] << 16) | (this.disk[p + 2] << 8) | this.disk[p + 3]) >>> 0;
  }

  bytes(address: number, count: number): Uint8Array {
    const p = this.at(address);
    return this.disk.subarray(p, p + count);
  }
}
