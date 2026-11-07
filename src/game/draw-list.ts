// The original's draw list of moving objects, as pure data and algorithms (no screen, no game state, no RNG).
// Static trace of the local Disk.1 image (notes/formats/map-rendering.md sections 7.2 and 7.4): `$333A` fills the list in a
// fixed source order, `$3694` admits each entry (visibility) BEFORE the sort, `$4860` sorts it, and `$6540` walks the 64 map
// cells in painter order with ONE cursor through the sorted list. Nothing in this module draws a pixel; `objects.ts` feeds it
// and paints what it hands out.

/** Draw-list flag bit 0: the neighbour tiles in front of a moving entry are drawn first (own tanks and enemy ground units). */
export const FLAG_NEIGHBOURS = 1;
/** Draw-list flag bit 1: the entry is drawn only while `$156A9` bit 3 (the "redraw gate") is set (enemy ground and air). */
export const FLAG_GATED = 2;

/** Who put an entry in the list. Only the first seven are original sources; `extra` is the remake's untagged, approximate one. */
export type DrawKind = "tank" | "ship" | "ground" | "air" | "effect" | "alien" | "meteor" | "extra";

/**
 * `$333A` insertion order of the sources (traced) and the flags each one stores. `extra` (arbitrary `ObjectLayer.extra`
 * drawables) is NOT in the original: it is appended last with flags 0 as an explicit approximation.
 */
export const SOURCE_ORDER: readonly { readonly kind: DrawKind; readonly flags: number }[] = [
  { kind: "tank", flags: FLAG_NEIGHBOURS },
  { kind: "ship", flags: 0 },
  { kind: "ground", flags: FLAG_NEIGHBOURS | FLAG_GATED },
  { kind: "air", flags: FLAG_GATED },
  { kind: "effect", flags: 0 },
  { kind: "alien", flags: 0 },
  { kind: "meteor", flags: 0 },
  { kind: "extra", flags: 0 },
];

export const VIEW_CELLS = 8;

/** The 64 view cells in painter order (diagonals by vx + vy ascending, inside a diagonal vx ascending): index = seq. */
export const PAINTER_CELLS: readonly { readonly vx: number; readonly vy: number }[] = (() => {
  const out: { vx: number; vy: number }[] = [];
  for (let s = 0; s <= 2 * (VIEW_CELLS - 1); s++) {
    for (let vx = Math.max(0, s - (VIEW_CELLS - 1)); vx <= Math.min(VIEW_CELLS - 1, s); vx++) out.push({ vx, vy: s - vx });
  }
  return out;
})();

// Table `$7BA8` (word per cell, index vx + 8 * vy): 63 - seq. 64 distinct keys.
const ORDER_KEY: readonly number[] = (() => {
  const table = new Array<number>(VIEW_CELLS * VIEW_CELLS).fill(0);
  PAINTER_CELLS.forEach((c, seq) => {
    table[c.vx + VIEW_CELLS * c.vy] = 63 - seq;
  });
  return table;
})();

/** `$7BA8[2 * (vx + 8 * vy)]` = 63 - painterSeq of the view cell. The caller guarantees 0 <= vx, vy < 8. */
export function orderKey(vx: number, vy: number): number {
  return ORDER_KEY[vx + VIEW_CELLS * vy];
}

/**
 * The sort `$4860`, ported literally (a plain sort would give different results for equal keys, which several entries of
 * one cell have). For `end` from n - 1 down to 1: `selected = 0`; for `scan` in 1..end the selected index becomes `scan`
 * when `entries[selected].order >= entries[scan].order`, and then, inside EVERY inner iteration, `selected` and `end` are
 * exchanged when they differ (the index `selected` stays; it now holds what was at `end`). The result is globally
 * descending by `order`; entries of equal order are NOT kept in insertion order (three equal entries a, b, c end as a, c, b).
 * Returns a new array; the input is not touched.
 */
export function sortDrawList<T extends { readonly order: number }>(entries: readonly T[]): T[] {
  const e = entries.slice();
  for (let end = e.length - 1; end >= 1; end--) {
    let selected = 0;
    for (let scan = 1; scan <= end; scan++) {
      if (e[selected].order >= e[scan].order) selected = scan;
      if (selected !== end) {
        const swap = e[selected];
        e[selected] = e[end];
        e[end] = swap;
      }
    }
  }
  return e;
}

/**
 * Neighbour cells (dvx, dvy) of the entry redraw `$6540` performs for flag bit 0 (`$6626-$6682`), by the entry's facing byte
 * +5: 1 -> (+1,-1), (+1,0); 2 -> (+1,0); 3 -> (+1,0), (0,+1), (+1,+1); 4 or 5 -> (0,+1); anything else none.
 */
export function neighbourOffsets(facing: number): readonly (readonly [number, number])[] {
  switch (facing) {
    case 1:
      return [[1, -1], [1, 0]];
    case 2:
      return [[1, 0]];
    case 3:
      return [[1, 0], [0, 1], [1, 1]];
    case 4:
    case 5:
      return [[0, 1]];
    default:
      return [];
  }
}

/**
 * The single cursor of `$6540` through the sorted list. `turn(order, gate)` is called once per map cell in painter order
 * (key 63 down to 0) and returns the entries to draw at that cell. When the entry under the cursor has flag bit 1 and the
 * gate is clear it is NOT consumed: the cursor stays on it, its order never matches a later cell, and so every later entry
 * of the list stays blocked for the rest of the frame (tiles and pins are not affected). Nothing is skipped or filtered.
 * A call whose order is below pending entries (cells visited out of painter order, a diagnostic use) first walks the cursor
 * past the cells in between with the same blocking rule and returns nothing for them.
 */
export class DrawCursor<T extends { readonly order: number; readonly flags: number }> {
  private index = 0;
  private blocked = false;

  constructor(readonly entries: readonly T[]) {}

  /** True once a gated entry met a clear gate: no later entry of this frame is ever returned. */
  get isBlocked(): boolean {
    return this.blocked;
  }

  turn(order: number, gate: boolean): T[] {
    const out: T[] = [];
    if (this.blocked) return out;
    // Cells never visited (out-of-order use): consume their entries without returning them.
    while (this.index < this.entries.length && this.entries[this.index].order > order) {
      if (!this.step(gate)) return out;
    }
    while (this.index < this.entries.length && this.entries[this.index].order === order) {
      const entry = this.entries[this.index];
      if (!this.step(gate)) return out;
      out.push(entry);
    }
    return out;
  }

  // Consumes the entry under the cursor unless it is gated shut (then the cursor sticks for good).
  private step(gate: boolean): boolean {
    if ((this.entries[this.index].flags & FLAG_GATED) !== 0 && !gate) {
      this.blocked = true;
      return false;
    }
    this.index++;
    return true;
  }
}
