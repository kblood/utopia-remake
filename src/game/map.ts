// Gameplay map view: 8x8-cell isometric window over the 100x75 map, with scroll arrows.
// Projection, tile blit and scroll rules: notes/formats/map-rendering.md. Objects, text and
// the animation of cells are not implemented yet.

import { COLOR, drawGameText, patchNumber, readTemplate, TEMPLATES } from "../data/gamefont.js";
import { decodePicture, PICTURES } from "../data/picture.js";
import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK, TILE_WIDTH, type Tile } from "../data/scenario.js";
import { Screen, SCREEN_WIDTH } from "../gfx/screen.js";
import type { Input } from "./intro.js";
import { A, GameState } from "./state.js";

export const VIEW_CELLS = 8;
const MAX_SCROLL_X = MAP_WIDTH - VIEW_CELLS;
const MAX_SCROLL_Y = MAP_HEIGHT - VIEW_CELLS;
const START_X = 47;
const START_Y = 33;
const REPEAT_FRAMES = 4;
const ANIMATED_FLAG = 0x400;
// The original steps animated cells once per main-loop pass; its real rate is unknown, so this is a guess.
const ANIMATION_FRAMES = 6;

// Window clip: the map occupies x 0..255 of the screen.
const CLIP_RIGHT = 256;

interface Arrow {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  dx: number;
  dy: number;
}

// Scroll arrow rectangles (inclusive) and the scroll change per step.
const ARROWS: Arrow[] = [
  { x0: 240, x1: 261, y0: 122, y1: 132, dx: 0, dy: -1 },
  { x0: 216, x1: 237, y0: 122, y1: 132, dx: -1, dy: 0 },
  { x0: 216, x1: 237, y0: 136, y1: 146, dx: 0, dy: 1 },
  { x0: 240, x1: 261, y0: 136, y1: 146, dx: 1, dy: 0 },
];

export function anchorX(vx: number, vy: number): number {
  return 112 + 16 * (vx - vy);
}

export function anchorY(vx: number, vy: number): number {
  return 39 + 8 * (vx + vy);
}

export class MapScene {
  readonly screen = new Screen();
  private readonly background: Uint8Array;
  private readonly cells: Uint16Array;
  scrollX = START_X;
  scrollY = START_Y;
  private repeat = 0;
  private frame = 0;

  constructor(
    private readonly disk: Uint8Array,
    private readonly tiles: Tile[],
    cells: Uint16Array,
    private readonly state: GameState,
  ) {
    this.cells = cells.slice();
    decodePicture(disk, PICTURES.main, this.screen);
    this.background = this.screen.pixels.slice();
  }

  private scroll(dx: number, dy: number, step: number): void {
    const x = Math.max(0, Math.min(MAX_SCROLL_X, this.scrollX + dx * step));
    const y = Math.max(0, Math.min(MAX_SCROLL_Y, this.scrollY + dy * step));
    if (x !== this.scrollX || y !== this.scrollY) {
      this.scrollX = x;
      this.scrollY = y;
    }
  }

  update(input: Input): void {
    const step = input.rightButton ? 6 : 1;
    if (input.leftButton || input.rightButton) {
      const arrow = ARROWS.find(
        (a) => input.pointerX >= a.x0 && input.pointerX <= a.x1 && input.pointerY >= a.y0 && input.pointerY <= a.y1,
      );
      if (arrow && this.repeat-- <= 0) {
        this.scroll(arrow.dx, arrow.dy, step);
        this.repeat = REPEAT_FRAMES;
      }
    } else {
      this.repeat = 0;
    }
    if (++this.frame % ANIMATION_FRAMES === 0) this.animateCells();
    this.state.tickFrame();
    this.draw();
  }

  // Animated cells (flag bit 10) cycle through fixed id loops: 1-3 and the building loops 6-9, 10-13.
  private animateCells(): void {
    for (let vy = 0; vy < VIEW_CELLS; vy++) {
      for (let vx = 0; vx < VIEW_CELLS; vx++) {
        const at = (this.scrollY + vy) * MAP_WIDTH + this.scrollX + vx;
        const cell = this.cells[at];
        if (!(cell & ANIMATED_FLAG)) continue;
        let id = cell & TILE_ID_MASK;
        if (id >= 1 && id <= 3) {
          id = id === 3 ? 1 : id + 1;
        } else if (id >= 6 && id <= 13) {
          id++;
          if (id === 10 || id > 13) id -= 4;
        } else {
          continue;
        }
        this.cells[at] = (cell & ~TILE_ID_MASK) | id;
      }
    }
  }

  private draw(): void {
    this.screen.pixels.set(this.background);
    this.drawTiles();
    this.drawTopBar();
  }

  private drawTiles(): void {
    // Painter order: diagonals by vx + vy, then vx ascending.
    for (let s = 0; s <= 2 * (VIEW_CELLS - 1); s++) {
      for (let vx = Math.max(0, s - (VIEW_CELLS - 1)); vx <= Math.min(VIEW_CELLS - 1, s); vx++) {
        const vy = s - vx;
        const cell = this.cells[(this.scrollY + vy) * MAP_WIDTH + this.scrollX + vx];
        const tile = this.tiles[(cell & TILE_ID_MASK) - 1]; // ids are 1-based
        if (tile) this.drawTile(tile, anchorX(vx, vy), anchorY(vx, vy));
      }
    }
  }

  // Top bar, redrawn every frame: date, money, and quality of life (notes/formats/game-text.md, section 8).
  private drawTopBar(): void {
    const disk = this.disk;
    const y = 2;
    drawGameText(disk, this.screen, Array.from(this.state.dateText(), (c) => c.charCodeAt(0)), 8, y, COLOR.highlight);
    const money = patchNumber(readTemplate(disk, TEMPLATES.money), this.state.displayMoney(), 0, 7);
    drawGameText(disk, this.screen, money, 110, y, COLOR.highlight);
    const quality = this.state.word(A.qualityOfLife + 2);
    if (quality >= 90 && (this.frame & 32) !== 0) {
      drawGameText(disk, this.screen, readTemplate(disk, TEMPLATES.title), 182, y, COLOR.highlight);
    }
    const label = patchNumber(readTemplate(disk, TEMPLATES.qualityOfLife), quality, 4, 3);
    drawGameText(disk, this.screen, label, 224, y, COLOR.highlight);
  }

  // Images are stored bottom row first, 5 colour planes then a mask plane, 32 pixels wide.
  private drawTile(tile: Tile, x: number, bottomY: number): void {
    const planeBytes = tile.rows * 4;
    for (let row = 0; row < tile.rows; row++) {
      const y = bottomY - 1 - row;
      if (y < 0) continue;
      for (let px = 0; px < TILE_WIDTH; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= CLIP_RIGHT) continue;
        const at = row * 4 + (px >> 3);
        const bit = 7 - (px & 7);
        if (((tile.planes[5 * planeBytes + at] >> bit) & 1) === 0) continue;
        let index = 0;
        for (let plane = 0; plane < 5; plane++) {
          index |= ((tile.planes[plane * planeBytes + at] >> bit) & 1) << plane;
        }
        this.screen.pixels[y * SCREEN_WIDTH + sx] = index;
      }
    }
  }
}
