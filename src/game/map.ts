// Gameplay map view: 8x8-cell isometric window over the 100x75 map, with scroll arrows.
// Projection, tile blit and scroll rules: notes/formats/map-rendering.md. Objects, text and
// the animation of cells are not implemented yet.

import { decodePicture, PICTURES } from "../data/picture.js";
import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK, TILE_WIDTH, type Tile } from "../data/scenario.js";
import { Screen, SCREEN_WIDTH } from "../gfx/screen.js";
import type { Input } from "./intro.js";

export const VIEW_CELLS = 8;
const MAX_SCROLL_X = MAP_WIDTH - VIEW_CELLS;
const MAX_SCROLL_Y = MAP_HEIGHT - VIEW_CELLS;
const START_X = 47;
const START_Y = 33;
const REPEAT_FRAMES = 4;

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
  scrollX = START_X;
  scrollY = START_Y;
  private dirty = true;
  private repeat = 0;

  constructor(
    disk1: Uint8Array,
    private readonly tiles: Tile[],
    private readonly cells: Uint16Array,
  ) {
    decodePicture(disk1, PICTURES.main, this.screen);
    this.background = this.screen.pixels.slice();
  }

  private scroll(dx: number, dy: number, step: number): void {
    const x = Math.max(0, Math.min(MAX_SCROLL_X, this.scrollX + dx * step));
    const y = Math.max(0, Math.min(MAX_SCROLL_Y, this.scrollY + dy * step));
    if (x !== this.scrollX || y !== this.scrollY) {
      this.scrollX = x;
      this.scrollY = y;
      this.dirty = true;
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
    if (this.dirty) this.draw();
  }

  private draw(): void {
    this.dirty = false;
    this.screen.pixels.set(this.background);
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
