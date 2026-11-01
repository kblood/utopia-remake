// Bitmap font and language string tables, read from the user's Disk.1 at runtime.
// Offsets are image offsets of the boot stage data; see notes/formats/text.md.

import type { Screen } from "../gfx/screen.js";

const WIDTH_TABLE = 0x43a2; // per character code - 0x20: glyph index, advance width
const GLYPHS = 0x4468; // 7 rows of 1 byte per glyph
const GLYPH_ROWS = 7;
const LINE_ADVANCE = 9;

export const LANGUAGE_TABLES = [0x46ca, 0x5356, 0x5fda, 0x6d98]; // English, French, German, Italian

export const NEWLINE_MIN = 0x80; // bytes with bit 7 set start a new line

// Returns the string with the given 1-based index from a language table.
export function getString(disk: Uint8Array, language: number, index: number): Uint8Array {
  const table = LANGUAGE_TABLES[language];
  const offset = (disk[table + 2 * (index - 1)] << 8) | disk[table + 2 * (index - 1) + 1];
  let end = table + offset;
  while (disk[end] !== 0) end++;
  return disk.subarray(table + offset, end);
}

// Draws text with its top-left corner at (x, y). Only set glyph pixels are painted.
// Returns the x position after the last character.
export function drawText(disk: Uint8Array, screen: Screen, text: Uint8Array, x: number, y: number, color: number): number {
  let cx = x;
  let cy = y;
  for (const raw of text) {
    if (raw & NEWLINE_MIN) {
      cx = x;
      cy += LINE_ADVANCE;
      continue;
    }
    const code = (raw >= 0x61 ? raw - 0x20 : raw) - 0x20;
    const glyph = disk[WIDTH_TABLE + 2 * code];
    const width = disk[WIDTH_TABLE + 2 * code + 1];
    for (let row = 0; row < GLYPH_ROWS; row++) {
      const bits = disk[GLYPHS + glyph * GLYPH_ROWS + row];
      for (let col = 0; col < 8; col++) {
        if (bits & (0x80 >> col)) screen.set(cx + col, cy + row, color);
      }
    }
    cx += width;
  }
  return cx;
}
