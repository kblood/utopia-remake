// Canonical addressing of the original's per-cell flag bytes ($3D3A6, 75 rows x $66 = 102 bytes).
// Evidence: notes/formats/game-state.md section 1 ("per-cell flag bytes, 75 rows x $66"), units.md section 3
// (own unit record +$14 = long pointer `$3D3A6 + y * $66 + x`) and map-rendering.md (map rows are 100 cell
// words + 2 pad words in memory). The two arrays therefore use DIFFERENT strides in this port:
//
//   map cell word index  = y * MAP_WIDTH (100) + x      -> World.cells, a packed 100 x 75 array
//   cell flag byte index = y * CELL_FLAG_ROW_BYTES (102) + x -> World.cellFlags, the original's layout verbatim
//
// A flag index is never a map index; always go through cellFlagIndex() / mapIndex(). Columns 100 and 101 of
// every flag row are padding: the notes document no meaning for them, so they are kept as stored and never
// written by the simulation. A flag pointer is "relative to $3D3A6": offset = pointer - CELL_FLAG_BASE.

import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";

/** RAM address of flag byte (0, 0) in the original. */
export const CELL_FLAG_BASE = 0x3d3a6;
/** Bytes per flag row: the 100 playable columns plus 2 padding columns. */
export const CELL_FLAG_ROW_BYTES = 102;
/** Whole flag array: 75 rows x 102 bytes. */
export const CELL_FLAG_BYTES = MAP_HEIGHT * CELL_FLAG_ROW_BYTES;

/** Map word index of a playable cell (stride 100). No range check. */
export function mapIndex(x: number, y: number): number {
  return y * MAP_WIDTH + x;
}

/** Flag byte index of a playable cell (stride 102). No range check. */
export function cellFlagIndex(x: number, y: number): number {
  return y * CELL_FLAG_ROW_BYTES + x;
}

/** The original's long pointer to the flag byte of (x, y). */
export function cellFlagPointer(x: number, y: number): number {
  return CELL_FLAG_BASE + cellFlagIndex(x, y);
}

/**
 * What a raw flag pointer points at:
 *  - "playable": a flag byte of map cell (x, y), 0 <= x < 100, 0 <= y < 75; `index` is the flag array index.
 *  - "padding": inside the flag array but in column 100 or 101 of row `y` (x is that column); no map cell.
 *  - "out-of-range": below $3D3A6 or beyond the last flag byte (or not an unsigned 32-bit integer).
 */
export type CellFlagTarget =
  | { readonly kind: "playable"; readonly x: number; readonly y: number; readonly index: number }
  | { readonly kind: "padding"; readonly x: number; readonly y: number; readonly index: number }
  | { readonly kind: "out-of-range" };

/** Resolves a raw flag pointer (relative to CELL_FLAG_BASE, 102-byte rows). Pure and total. */
export function resolveCellFlagPointer(pointer: number): CellFlagTarget {
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > 0xffffffff) return { kind: "out-of-range" };
  const index = pointer - CELL_FLAG_BASE;
  if (index < 0 || index >= CELL_FLAG_BYTES) return { kind: "out-of-range" };
  const y = Math.floor(index / CELL_FLAG_ROW_BYTES);
  const x = index - y * CELL_FLAG_ROW_BYTES;
  return x < MAP_WIDTH ? { kind: "playable", x, y, index } : { kind: "padding", x, y, index };
}
