// Build menu ($B2AA): page/item data, hit rectangles and a read-only renderer for its panel. The tile lists and
// research substitutions are the static `$E9A0/$E9B6/$E9CC` data and `$B2AA` patches, the rectangles the
// `$E9E2/$EA3C` tables; `Controls` uses the same exports for hit testing and selection, so what is drawn is
// exactly what can be clicked. The panel frame, button column, tile placement and the name / cost / preview
// lines follow `$B680`, `$E95C`, `$B258`/`$6A22`/`$69D8`, `$B512-$B624` and `$6B3C`. Static evidence and remaining
// visual comparison gaps are recorded in notes/formats/building.md.

import { COLOR, drawGameText, patchNumber } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import { TILE_WIDTH, type Tile } from "../data/scenario.js";
import type { Screen } from "../gfx/screen.js";
import { Ui, type WindowRect } from "./screens/ui.js";

export interface MenuHitbox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// Research bits of `$14472` that replace list entries (`$B2AA`): [bit, list slot, tile].
export type MenuUnlock = readonly [bit: number, slot: number, tile: number];

export interface MenuPageDef {
  // The static list in the game image ($E9A0 / $E9B6 / $E9CC, `$FFFF` entries dropped).
  readonly tiles: readonly number[];
  // List slots that `$B2AA` sets to `$FFFF` (no building) every time the menu opens, before the research
  // substitutions below are applied: the entry exists only once its research bit is set.
  readonly blank: readonly number[];
  readonly unlock: readonly MenuUnlock[];
}

// Build menu pages ($E9A0, $E9B6, $E9CC) with the research bits that replace entries ($B2AA).
export const MENU_PAGES: readonly MenuPageDef[] = [
  {
    tiles: [0x2f, 0x01, 0x41, 0x44, 0x3e, 0x06, 0x60, 0x1f, 0x30, 0x33, 0x47],
    blank: [10],
    unlock: [[12, 2, 0x42], [7, 5, 0x0a], [11, 7, 0x0f], [13, 8, 0x31], [14, 9, 0x34], [15, 10, 0x47]],
  },
  {
    tiles: [0x0e, 0x3d, 0x3f, 0x04, 0x43, 0x45, 0x46, 0x36, 0x3c, 0x35, 0x61],
    blank: [8, 9, 10],
    unlock: [[1, 2, 0x40], [0, 8, 0x3c], [5, 9, 0x35], [6, 10, 0x61]],
  },
  { tiles: [0x48, 0x4c, 0x54, 0x58, 0x5c], blank: [], unlock: [] },
];

export const MENU_PAGE_COUNT = MENU_PAGES.length;

// `$E9E2` and `$EA3C`, the hitbox tables selected alongside the corresponding tile lists at `$E988`.
// Rectangle order is `{x0,x1,y0,y1}` and the hit test `$5730` includes both endpoints.
export const BUILD_MENU_HITBOXES: readonly (readonly MenuHitbox[])[] = [
  [
    { x0: 16, x1: 47, y0: 50, y1: 80 },
    { x0: 48, x1: 79, y0: 50, y1: 80 },
    { x0: 80, x1: 111, y0: 50, y1: 80 },
    { x0: 112, x1: 143, y0: 50, y1: 80 },
    { x0: 144, x1: 175, y0: 50, y1: 80 },
    { x0: 16, x1: 47, y0: 100, y1: 130 },
    { x0: 48, x1: 79, y0: 100, y1: 130 },
    { x0: 80, x1: 111, y0: 100, y1: 130 },
    { x0: 112, x1: 143, y0: 100, y1: 130 },
    { x0: 144, x1: 175, y0: 100, y1: 130 },
    { x0: 176, x1: 207, y0: 50, y1: 80 },
  ],
  [
    { x0: 16, x1: 47, y0: 50, y1: 80 },
    { x0: 48, x1: 79, y0: 50, y1: 80 },
    { x0: 80, x1: 111, y0: 50, y1: 80 },
    { x0: 112, x1: 143, y0: 50, y1: 80 },
    { x0: 144, x1: 175, y0: 50, y1: 80 },
    { x0: 16, x1: 47, y0: 100, y1: 130 },
    { x0: 48, x1: 79, y0: 100, y1: 130 },
    { x0: 80, x1: 111, y0: 100, y1: 130 },
    { x0: 112, x1: 143, y0: 100, y1: 130 },
    { x0: 144, x1: 175, y0: 100, y1: 130 },
    { x0: 176, x1: 207, y0: 50, y1: 80 },
  ],
  // First five rectangles of `$EA3C` correspond to the five non-sentinel page-three entries (the table has two
  // more, `{208,239,70,100}` and `{144,175,125,155}`, whose list entries are `$FFFF` and so never select).
  [
    { x0: 16, x1: 79, y0: 50, y1: 100 },
    { x0: 80, x1: 143, y0: 50, y1: 100 },
    { x0: 144, x1: 207, y0: 50, y1: 100 },
    { x0: 16, x1: 79, y0: 105, y1: 155 },
    { x0: 80, x1: 143, y0: 105, y1: 155 },
  ],
];

// The page's tile list with `$B2AA` applied: the blanked slots are -1 (the original's `$FFFF`: not offered, not
// selectable, not drawn), then each set research bit puts its tile into its slot.
export function menuTiles(page: number, researchBits: number): number[] {
  const def = MENU_PAGES[page];
  const tiles = def.tiles.slice();
  for (const slot of def.blank) tiles[slot] = -1;
  for (const [bit, slot, tile] of def.unlock) if ((researchBits >>> bit) & 1) tiles[slot] = tile;
  return tiles;
}

// `$5730`: index of the first rectangle that contains the pointer, or -1.
export function menuHitIndex(page: number, px: number, py: number): number {
  return BUILD_MENU_HITBOXES[page].findIndex((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
}

export interface MenuItem {
  index: number; // list index = hitbox index
  tile: number;
  hitbox: MenuHitbox;
}

// The items a page shows: list entries that have a rectangle (entries without one cannot be selected).
export function menuItems(page: number, researchBits: number): MenuItem[] {
  const tiles = menuTiles(page, researchBits);
  const items: MenuItem[] = [];
  tiles.forEach((tile, index) => {
    const hitbox = BUILD_MENU_HITBOXES[page][index];
    if (tile >= 0 && hitbox) items.push({ index, tile, hitbox });
  });
  return items;
}

// `$6A22`: tile ids $48-$5F are 2 x 2 buildings made of four consecutive tiles.
export function isQuadTile(tile: number): boolean {
  return tile >= 0x48 && tile < 0x60;
}

export interface TilePlacement {
  tile: number;
  x: number; // left pixel column
  bottomRow: number; // screen row of the tile's last (bottom) image row, inclusive
}

// Where `$6A22` puts the tile(s) of a building given d0 = x and d1 = bottom row. A single tile sits at (x, row).
// A 2 x 2 building is composed in the order top (+0) at (x, row - 16), right (+1) at (x + 16, row - 8), left (+2) at
// (x - 16, row - 8) and bottom (+3) at (x, row); this is the diamond that the map cells `$6A8C` store.
export function tilePlacements(tile: number, x: number, bottomRow: number): TilePlacement[] {
  if (!isQuadTile(tile)) return [{ tile, x, bottomRow }];
  return [
    { tile, x, bottomRow: bottomRow - 16 },
    { tile: tile + 1, x: x + 16, bottomRow: bottomRow - 8 },
    { tile: tile + 2, x: x - 16, bottomRow: bottomRow - 8 },
    { tile: tile + 3, x, bottomRow },
  ];
}

// `$B258`: a list item is drawn at its rectangle's left edge (+16 for a 2 x 2 building, centring its 64 pixel
// diamond in the 64 pixel wide rectangle) with the tile bottom on the rectangle's last row (`y1`).
export const ITEM_QUAD_SHIFT = 16;

export function itemPlacements(item: MenuItem): TilePlacement[] {
  return tilePlacements(item.tile, item.hitbox.x0 + (isQuadTile(item.tile) ? ITEM_QUAD_SHIFT : 0), item.hitbox.y1);
}

// `$69D8`: one masked 32-pixel-wide tile. Image rows are stored bottom row first and the routine draws upward
// from the given row, five colour planes selected by the sixth (mask) plane. Pixels outside the screen are dropped.
export function blitTile(screen: Screen, tile: Tile | undefined, x: number, bottomRow: number): void {
  if (!tile) return;
  const planeBytes = tile.rows * 4;
  for (let row = 0; row < tile.rows; row++) {
    const y = bottomRow - row;
    for (let px = 0; px < TILE_WIDTH; px++) {
      const at = row * 4 + (px >> 3);
      const bit = 7 - (px & 7);
      if (((tile.planes[5 * planeBytes + at] >> bit) & 1) === 0) continue;
      let index = 0;
      for (let plane = 0; plane < 5; plane++) index |= ((tile.planes[plane * planeBytes + at] >> bit) & 1) << plane;
      screen.set(x + px, y, index);
    }
  }
}

// `$6A22`: draws a building (one or four tiles) with d0 = x, d1 = bottom row. Tile ids are 1-based.
export function drawBuilding(screen: Screen, tiles: readonly Tile[], tile: number, x: number, bottomRow: number): void {
  for (const p of tilePlacements(tile, x, bottomRow)) blitTile(screen, tiles[p.tile - 1], p.x, p.bottomRow);
}

// Static anchors of the panel (`$B2AA`, `$B258`, `$B512-$B624`, `$6B3C`); pixels, text origin = top-left of the glyph box.
const WINDOW_TABLE = 0xe908; // {x, y, width in 8-pixel columns, height in 8-pixel rows}
const BUTTON_TABLE = 0xe95c; // ten button image pointers (0 = default image); buttons 8 and 9 have their own
const TITLE = { string: 4, x: 83, y: 30 };
const NAME = { x: 16, y: 159 };
const COST = { string: 0x26, x: 16, y: 168, digits: 5 };
const MESSAGE = { string: 0x25, x: 16, y: 177 };
const PREVIEW_CLEAR = { x: 176, y: 126, widthBytes: 8, rows: 56 }; // `$6B3C` erases this area
const PREVIEW = { x: 192, bottomRow: 181 }; // `$6B3C` draws the selected tile here
// What the lines under the item grid show after a click on an item (`$B512`): the item's name string index, its
// T+6 price and whether the price was within the money (otherwise the "can't afford" line is shown as well).
export interface MenuDetail {
  nameIndex: number;
  cost: number;
  affordable: boolean;
}

export interface MenuView {
  page: number;
  researchBits: number;
  selected: number | null; // the pending selection (`$142AA`), previewed at the right
  detail: MenuDetail | null;
  // The command button held down by `$5756` and not yet released (`$5DD4`); shown flipped until `$57FA` flips it back.
  pressed?: number;
}

export class BuildMenuRenderer {
  private readonly ui: Ui;
  private readonly window: WindowRect;
  private readonly buttons: number[];

  // `tiles` are the decoded tile images indexed by tile id - 1 (as the map uses them). Nothing is written to them,
  // to `disk` or to the game state.
  constructor(
    private readonly disk: Uint8Array,
    private readonly strings: GameStrings,
    private readonly tiles: readonly Tile[],
    ui?: Ui,
  ) {
    this.ui = ui ?? new Ui(disk, strings);
    this.window = this.ui.readWindow(WINDOW_TABLE);
    this.buttons = this.ui.readButtonTable(BUTTON_TABLE);
  }

  get frame(): WindowRect {
    return { ...this.window };
  }

  draw(screen: Screen, view: MenuView): void {
    this.ui.frame(screen, this.window);
    this.ui.drawButtons(screen, this.buttons);
    if (view.pressed !== undefined && view.pressed >= 0) this.ui.invertButton(screen, view.pressed);
    for (const item of menuItems(view.page, view.researchBits)) {
      for (const p of itemPlacements(item)) blitTile(screen, this.tiles[p.tile - 1], p.x, p.bottomRow);
    }
    this.text(screen, this.strings.get(TITLE.string), TITLE.x, TITLE.y);
    if (view.detail) this.drawDetail(screen, view.detail);
    // `$6B3C`: the preview area is erased, then the pending selection (if any) is drawn into it.
    this.ui.erase(screen, PREVIEW_CLEAR.x, PREVIEW_CLEAR.y, PREVIEW_CLEAR.widthBytes, PREVIEW_CLEAR.rows);
    if (view.selected !== null) drawBuilding(screen, this.tiles, view.selected, PREVIEW.x, PREVIEW.bottomRow);
  }

  private drawDetail(screen: Screen, detail: MenuDetail): void {
    if (!detail.affordable) this.text(screen, this.strings.get(MESSAGE.string), MESSAGE.x, MESSAGE.y);
    this.text(screen, this.strings.get(detail.nameIndex), NAME.x, NAME.y);
    const template = this.strings.get(COST.string);
    const at = this.strings.placeholder(COST.string);
    this.text(screen, at >= 0 ? patchNumber(template, detail.cost, at, COST.digits) : template, COST.x, COST.y);
  }

  private text(screen: Screen, bytes: ArrayLike<number>, x: number, y: number): void {
    drawGameText(this.disk, screen, bytes, x, y, COLOR.text);
  }
}
