// Eclipse tile view: the data-address exchange of the original's `$11024`, shown from the session's exchange state.
//
// VERIFIED (static, Disk.1): `$11024` loads the descriptor table `$1612E` (8-byte entries `{rows-1, data address}`) and
// exchanges the data-address longs of entries 4 and 51, and of entries 50 and 54. Each entry keeps its own rows-1. Tile ids
// are 1-based, so the exchanged ids are 5 and 52, and 51 and 55. The original runs `$11024` at the weekly eclipse start and
// end (`$1100A`), at event 14 (`$1107A`), at a disk-menu entry while bit 6 is set (`$7ECA`) and at the disk-menu exit while
// `$144BB` is nonzero (`$8040`). Each call toggles the table, so its state is a PARITY of those calls (sim.ts `tileExchange`).
// The table is built once at boot (`$15762`, `$7C4A`), and no reset (`$866E`, `$875C`) rebuilds it: a new game keeps the parity.
// The eclipse flag (`$156AA` bit 6) does not give the parity: a disk-menu entry during an eclipse leaves the table unexchanged
// while bit 6 is set, and a new game clears bit 6 without a swap. So the parity is stored (save-session.ts, version 11).
// Visible effect: not observed.
//
// This module is pure. It never writes to the source tiles, their planes or their image buffers: an exchanged entry is a new
// `Tile` object with the other entry's address and its own rows, and every other entry is the same object as in the input.
// Applying the exchange twice returns the original addresses (see `test/eclipse-tiles.mjs` and `test/eclipse-parity.mjs`).

import { TILE_BYTES_PER_ROW, TILE_PLANES, type Tile, type TileSource } from "../data/scenario.js";

/** Descriptor index pairs (0-based; tile id = index + 1) whose data addresses `$11024` exchanges. */
export const ECLIPSE_TILE_PAIRS: readonly (readonly [number, number])[] = [
  [4, 51],
  [50, 54],
];

/**
 * The tile list for the given exchange state. `exchanged` false returns a new array of the same tile objects. `exchanged` true
 * returns a new array in which each pair of `ECLIPSE_TILE_PAIRS` has its addresses exchanged (rows kept). The input array
 * and its tiles are not modified. Throws when a pair is outside the list or a tile has no source address to exchange.
 */
export function eclipseTileView(tiles: readonly Tile[], exchanged: boolean): Tile[] {
  const view = tiles.slice();
  if (!exchanged) return view;
  for (const [a, b] of ECLIPSE_TILE_PAIRS) {
    const ta = tiles[a];
    const tb = tiles[b];
    if (!ta || !tb) throw new Error(`eclipseTileView: descriptors ${a} and ${b} are needed`);
    view[a] = withAddress(ta, addressOf(tb, b));
    view[b] = withAddress(tb, addressOf(ta, a));
  }
  return view;
}

function addressOf(tile: Tile, index: number): TileSource {
  if (!tile.source) throw new Error(`eclipseTileView: descriptor ${index} has no source address`);
  return tile.source;
}

// Rows come from the entry, the planes from the address it now names; the size is the entry's own rows.
function withAddress(tile: Tile, address: TileSource): Tile {
  const size = tile.rows * TILE_BYTES_PER_ROW * TILE_PLANES;
  if (address.offset + size > address.image.length) throw new Error("eclipseTileView: exchanged tile lies outside its image data");
  return { rows: tile.rows, planes: address.image.slice(address.offset, address.offset + size), source: address };
}
