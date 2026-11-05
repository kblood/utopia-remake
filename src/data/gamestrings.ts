// In-game string tables (408 strings per language), unpacked from Disk.1 at runtime.
// Layout: notes/formats/game-proper.md section 7 and game-text.md section 6.

import { SECTOR_SIZE, type SectorRange } from "./picture.js";
import { unpackLz } from "./unpack.js";

export const GAME_STRING_RANGES: SectorRange[] = [
  { first: 0x209, last: 0x221 }, // English
  { first: 0x387, last: 0x3a0 }, // French
  { first: 0x6ec, last: 0x707 }, // German
  { first: 0x3a2, last: 0x3bb }, // Italian
];

export const STRING_COUNT = 408;

export class GameStrings {
  private readonly data: Uint8Array;

  constructor(disk: Uint8Array, language: number) {
    const range = GAME_STRING_RANGES[language];
    this.data = unpackLz(disk.subarray(range.first * SECTOR_SIZE, (range.last + 1) * SECTOR_SIZE));
  }

  // Bytes of string `index` (0-based) without its terminator. Strings that start with a
  // placeholder-offset byte (below $20, or above $8A for long strings) lose that prefix.
  get(index: number): number[] {
    if (index < 0 || index >= STRING_COUNT) return [];
    let at = (this.data[index * 2] << 8) | this.data[index * 2 + 1];
    const out: number[] = [];
    if (this.data[at] < 0x20 || (this.data[at] >= 0x8b && this.data[at] <= 0x96 && this.data[at + 1] >= 0x20)) at++;
    while (this.data[at] !== 0 && at < this.data.length) out.push(this.data[at++]);
    return out;
  }
}
