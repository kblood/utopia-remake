// In-game font and top-bar text. Tables and templates are read from the game image inside the
// user's Disk.1; layout: notes/formats/game-text.md.

import type { Screen } from "../gfx/screen.js";
import { SECTOR_SIZE } from "./picture.js";

const IMAGE_START = 0x14c * SECTOR_SIZE; // Disk.1 offset of the game image loaded at $1000
const IMAGE_BASE = 0x1000;

function imageOffset(address: number): number {
  return IMAGE_START + address - IMAGE_BASE;
}

const CHAR_TABLE = 0x62d8; // codes $20-$5D: glyph index, advance
const GLYPHS = 0x6354; // 6 bytes per glyph
const GLYPH_ROWS = 6;
const LINE_ADVANCE = 9;
const TABLE_ENTRIES = 62;
const BLANK_DIGIT = 0x23; // '#': blank glyph used for leading zeros

export const TEMPLATES = { money: 0x2f48, qualityOfLife: 0x2f53, title: 0x6532 };
export const COLOR = { text: 1, highlight: 21 };

export function readTemplate(disk: Uint8Array, address: number): number[] {
  const out: number[] = [];
  for (let at = imageOffset(address); disk[at] !== 0; at++) out.push(disk[at]);
  return out;
}

// Draws a string with the in-game font; only ink pixels are painted. Returns the x after it.
export function drawGameText(disk: Uint8Array, screen: Screen, text: ArrayLike<number>, x: number, y: number, color: number): number {
  let cx = x;
  let cy = y;
  for (let i = 0; i < text.length; i++) {
    const raw = text[i];
    if (raw & 0x80) {
      cx = x;
      cy += LINE_ADVANCE;
      continue;
    }
    if (raw === 0x09) continue;
    const code = (raw >= 0x61 ? raw - 0x20 : raw) - 0x20;
    if (code < 0 || code >= TABLE_ENTRIES) continue; // codes past the table draw nothing
    const glyph = disk[imageOffset(CHAR_TABLE) + 2 * code];
    const advance = disk[imageOffset(CHAR_TABLE) + 2 * code + 1];
    for (let row = 0; row < GLYPH_ROWS; row++) {
      const bits = disk[imageOffset(GLYPHS) + glyph * GLYPH_ROWS + row];
      for (let col = 0; col < 8; col++) {
        if (bits & (0x80 >> col)) screen.set(cx + col, cy + row, color);
      }
    }
    cx += advance;
  }
  return cx;
}

// Writes `value` over `digits` placeholders starting at `start`, right-aligned with blank digits.
export function patchNumber(text: number[], value: number, start: number, digits: number): number[] {
  const out = text.slice();
  const s = String(Math.max(0, Math.floor(value))).padStart(digits, String.fromCharCode(BLANK_DIGIT)).slice(-digits);
  for (let i = 0; i < digits; i++) out[start + i] = s.charCodeAt(i);
  return out;
}
