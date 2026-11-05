// Mouse handling on the map screen: cell picking ($5CDA), the command button column ($5E06
// rectangles, dispatch $15A74), build / demolish modes ($14591 = 2 / 3) and a simple build
// menu standing in for the original's $B2AA screen. Notes: notes/formats/map-rendering.md
// section 8 and 9, notes/formats/building.md.

import { COLOR, drawGameText } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";
import type { Screen } from "../gfx/screen.js";
import type { Builder, Placement } from "./build.js";
import type { Input } from "./intro.js";
import type { World } from "./world.js";

const VIEW_CELLS = 8;

export type Mode = "select" | "build" | "demolish";

// Command buttons in the original's table order ($5E06): index = d2 of the icon dispatch.
const BUTTONS: { x: number; y: number }[] = [
  { x: 272, y: 63 },
  { x: 296, y: 63 },
  { x: 272, y: 82 },
  { x: 296, y: 82 },
  { x: 272, y: 101 },
  { x: 296, y: 101 },
  { x: 272, y: 120 },
  { x: 296, y: 120 },
  { x: 296, y: 139 },
  { x: 272, y: 139 },
];
const BUTTON_SIZE = 16;
export const BUTTON = { build: 0, demolish: 2, trade: 4, staff: 6, intel: 7, disk: 8 } as const;

const INVENTION = 0x14472;
const NAME_STRING = 0x10; // type entry +$10: string index of the building name
const COST = 6;
const NO_MONEY_MESSAGE = 0x25;

// Build menu pages ($E9A0, $E9B6, $E9CC) with the research bits that replace or unlock
// entries ($B2AA). -1 = not yet available.
const MENU_PAGES: { tiles: number[]; unlock: [number, number, number][] }[] = [
  {
    tiles: [0x2f, 0x01, 0x41, 0x44, 0x3e, 0x06, 0x60, 0x1f, 0x30, 0x33, -1],
    unlock: [[12, 2, 0x42], [7, 5, 0x0a], [11, 7, 0x0f], [13, 8, 0x31], [14, 9, 0x34], [15, 10, 0x47]],
  },
  {
    tiles: [0x0e, 0x3d, 0x3f, 0x04, 0x43, 0x45, 0x46, 0x36, -1, -1, -1],
    unlock: [[1, 2, 0x40], [0, 8, 0x3c], [5, 9, 0x35], [6, 10, 0x61]],
  },
  { tiles: [0x48, 0x4c, 0x54, 0x58, 0x5c], unlock: [] },
];

const PANEL = { x: 24, y: 48, w: 200, h: 102 };
const ROW_HEIGHT = 9;
const ROWS_TOP = PANEL.y + 14;

export class Controls {
  mode: Mode = "select";
  selection: Placement | null = null;
  private menuOpen = false;
  private page = 0;
  private wasDown = false;
  private wasRight = false;
  // Opens a window screen for icon buttons 4 (trade), 6 (staffing) and 7 (intelligence).
  onClick: () => void = () => {};
  onScreen: (kind: "trade" | "staff" | "intel") => void = () => {};

  constructor(
    private readonly disk: Uint8Array,
    private readonly world: World,
    private readonly builder: Builder,
    private readonly strings: GameStrings,
    private readonly say: (message: number) => void,
    private readonly view: () => { x: number; y: number },
    private readonly onDiskMenu: () => void = () => {},
  ) {}

  get menuVisible(): boolean {
    return this.menuOpen;
  }

  // $5CDA: first of the 72 overlapping rectangles that contains the pointer wins.
  pickCell(px: number, py: number): { x: number; y: number } | null {
    const origin = this.view();
    for (let vy = 0; vy < VIEW_CELLS; vy++) {
      for (let vx = 0; vx < VIEW_CELLS; vx++) {
        const x0 = 112 + 16 * (vx - vy);
        const y0 = 24 + 8 * (vx + vy);
        if (px >= x0 && px <= x0 + 31 && py >= y0 && py <= y0 + 14) {
          const x = origin.x + vx;
          const y = origin.y + vy;
          return x < MAP_WIDTH && y < MAP_HEIGHT ? { x, y } : null;
        }
      }
    }
    return null;
  }

  buttonAt(px: number, py: number): number {
    return BUTTONS.findIndex((b) => px >= b.x && px < b.x + BUTTON_SIZE && py >= b.y && py < b.y + BUTTON_SIZE);
  }

  private pageTiles(page: number): number[] {
    const def = MENU_PAGES[page];
    const bits = this.world.state.long(INVENTION);
    const tiles = def.tiles.slice();
    for (const [bit, slot, tile] of def.unlock) if ((bits >>> bit) & 1) tiles[slot] = tile;
    return tiles;
  }

  private typeOf(tile: number): number {
    try {
      return this.world.findType(tile);
    } catch {
      return -1;
    }
  }

  // Returns true when the click was used by the interface (the scroll arrows are handled by the map).
  update(input: Input): boolean {
    const pressed = input.leftButton && !this.wasDown;
    const rightPressed = input.rightButton && !this.wasRight;
    this.wasDown = input.leftButton;
    this.wasRight = input.rightButton;

    if (this.menuOpen) {
      if (rightPressed) this.menuOpen = false;
      else if (pressed) this.menuClick(input.pointerX, input.pointerY);
      return true;
    }
    if (rightPressed && this.mode !== "select") {
      this.mode = "select";
      this.selection = null;
      return true;
    }
    if (!pressed) return false;

    const button = this.buttonAt(input.pointerX, input.pointerY);
    if (button >= 0) {
      this.onClick();
      this.press(button);
      return true;
    }
    const cell = this.pickCell(input.pointerX, input.pointerY);
    if (!cell) return false;
    if (this.mode === "build" && this.selection) this.builder.place(this.selection, cell.x, cell.y);
    else if (this.mode === "demolish") this.builder.demolish(cell.x, cell.y);
    return true;
  }

  private press(button: number): void {
    if (button === BUTTON.build) {
      this.menuOpen = true;
      this.page = 0;
    } else if (button === BUTTON.demolish) {
      this.mode = this.mode === "demolish" ? "select" : "demolish";
      this.selection = null;
    } else if (button === BUTTON.trade) {
      this.onScreen("trade");
    } else if (button === BUTTON.staff) {
      this.onScreen("staff");
    } else if (button === BUTTON.intel) {
      this.onScreen("intel");
    } else if (button === BUTTON.disk) {
      this.onDiskMenu();
    }
  }

  private menuClick(px: number, py: number): void {
    if (px < PANEL.x || px >= PANEL.x + PANEL.w || py < PANEL.y || py >= PANEL.y + PANEL.h) {
      this.menuOpen = false;
      return;
    }
    if (py < ROWS_TOP) {
      this.page = (this.page + 1) % MENU_PAGES.length;
      return;
    }
    const row = Math.floor((py - ROWS_TOP) / ROW_HEIGHT);
    const tile = this.pageTiles(this.page)[row];
    if (tile === undefined || tile < 0) return;
    const type = this.typeOf(tile);
    if (type < 0) return;
    const cost = this.world.state.word(this.world.typeAddress(type) + COST);
    if (cost > this.world.state.signedLong(0x135ba)) {
      this.say(NO_MONEY_MESSAGE);
      return;
    }
    this.selection = { tile, type };
    this.mode = "build";
    this.menuOpen = false;
    this.say(this.world.state.word(this.world.typeAddress(type) + NAME_STRING));
  }

  draw(screen: Screen): void {
    // Mode marker: a frame around the active command button.
    const active = this.mode === "build" ? BUTTON.build : this.mode === "demolish" ? BUTTON.demolish : -1;
    if (active >= 0) this.frame(screen, BUTTONS[active].x, BUTTONS[active].y, BUTTON_SIZE, BUTTON_SIZE, COLOR.highlight);
    if (!this.menuOpen) return;

    for (let y = PANEL.y; y < PANEL.y + PANEL.h; y++) {
      for (let x = PANEL.x; x < PANEL.x + PANEL.w; x++) screen.pixels[y * 320 + x] = 0;
    }
    this.frame(screen, PANEL.x, PANEL.y, PANEL.w, PANEL.h, COLOR.text);
    const header = Array.from(`PAGE ${this.page + 1}/${MENU_PAGES.length}`, (c) => c.charCodeAt(0));
    drawGameText(this.disk, screen, header, PANEL.x + 6, PANEL.y + 4, COLOR.highlight);
    const tiles = this.pageTiles(this.page);
    const money = this.world.state.signedLong(0x135ba);
    tiles.forEach((tile, row) => {
      if (tile < 0) return;
      const type = this.typeOf(tile);
      if (type < 0) return;
      const t = this.world.typeAddress(type);
      const name = this.strings.get(this.world.state.word(t + NAME_STRING));
      const cost = this.world.state.word(t + COST);
      const y = ROWS_TOP + row * ROW_HEIGHT;
      const colour = cost > money ? COLOR.text : COLOR.highlight;
      drawGameText(this.disk, screen, name.slice(0, 26), PANEL.x + 6, y, colour);
      drawGameText(this.disk, screen, Array.from(String(cost), (c) => c.charCodeAt(0)), PANEL.x + PANEL.w - 40, y, colour);
    });
  }

  private frame(screen: Screen, x: number, y: number, w: number, h: number, colour: number): void {
    for (let i = 0; i < w; i++) {
      screen.set(x + i, y, colour);
      screen.set(x + i, y + h - 1, colour);
    }
    for (let j = 0; j < h; j++) {
      screen.set(x, y + j, colour);
      screen.set(x + w - 1, y + j, colour);
    }
  }
}
