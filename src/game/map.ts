// Gameplay map view: 8x8-cell isometric window over the 100x75 map, with scroll arrows.
// Projection, tile blit and scroll rules: notes/formats/map-rendering.md. Objects, text and
// the animation of cells are not implemented yet.

import { COLOR, drawGameText, patchNumber, readTemplate, TEMPLATES } from "../data/gamefont.js";
import { decodePicture, PICTURES } from "../data/picture.js";
import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK, TILE_WIDTH, type Tile } from "../data/scenario.js";
import { Screen, SCREEN_WIDTH } from "../gfx/screen.js";
import type { Input } from "./intro.js";
import type { GameStrings } from "../data/gamestrings.js";
import { readFlagTable, readInventionText, readWeights } from "../data/gameimage.js";
import { Builder } from "./build.js";
import { Controls } from "./controls.js";
import { Messages } from "./messages.js";
import { ObjectLayer } from "./objects.js";
import type { SpriteSet } from "../data/sprites.js";
import { SFX } from "../audio/sfx.js";
import { MarkerMode, markerMessageText } from "./screens/markers.js";
import { A } from "./state.js";
import { Sim } from "./sim.js";
import type { World } from "./world.js";

export const VIEW_CELLS = 8;
// News and spy-report messages that come with the alert tone ($11B4 callers).
const ALERT_MESSAGES = new Set([0x157, 0x8d, 0x186]);
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
  private readonly state: World["state"];
  readonly sim: Sim;
  readonly world: World;
  private readonly messages: Messages;
  readonly controls: Controls;
  readonly objects: ObjectLayer | null; // units, marker pins and effects; null without the sprite sheets
  scrollX = START_X;
  scrollY = START_Y;
  // Live accessor for the overview window, which reads and writes the scroll position.
  readonly scrollRef: { x: number; y: number } = (() => {
    const scene = this;
    return {
      get x() { return scene.scrollX; },
      set x(v: number) { scene.scrollX = v; },
      get y() { return scene.scrollY; },
      set y(v: number) { scene.scrollY = v; },
    };
  })();
  private readonly playSfx: (id: number, volume?: number) => void;
  private readonly markerMode = new MarkerMode();
  private repeat = 0;
  private frame = 0;

  constructor(
    private readonly disk: Uint8Array,
    private readonly tiles: Tile[],
    world: World,
    strings: GameStrings,
    options: { onDiskMenu?: () => void; onScreen?: (kind: "trade" | "staff" | "intel" | "overview" | "council") => void; sfx?: (id: number, volume?: number) => void; sprites?: SpriteSet } = {},
  ) {
    this.messages = new Messages(disk, strings);
    this.world = world;
    this.cells = world.cells;
    this.state = world.state;
    this.objects = options.sprites
      ? new ObjectLayer(options.sprites, tiles, this.cells, (t, x, y) => this.drawTile(t, x, y), () => world.state.byte(A.techLevel))
      : null;
    const builder = new Builder(world, readFlagTable(disk), readWeights(disk), (n) => this.messages.push(n));
    this.sim = new Sim(world, {
      interactive: true,
      demolishAt: (x, y) => {
        builder.demolish(x, y);
        this.explosionAt(x, y);
      },
      destroyUnit: () => this.destroyFirstUnit(),
      onWeek: () => builder.weekly(),
      spawnUnit: (x, y, advanced) => (this.objects ? this.objects.units.spawnAtYard(x, y, advanced) !== null : true),
    });
    this.controls = new Controls(disk, world, builder, strings, (n) => this.messages.push(n), () => ({ x: this.scrollX, y: this.scrollY }), options.onDiskMenu);
    if (options.onScreen) this.controls.onScreen = options.onScreen;
    this.playSfx = options.sfx ?? (() => {});
    this.controls.onMarkerButton = () => this.messages.push(this.markerMode.arm());
    this.controls.cellHook = (x, y) => {
      if (!this.objects) return false;
      const result = this.markerMode.click(this.objects, x, y);
      if (!result) return false;
      if (result.pin) this.messages.pushText(markerMessageText(strings, result.pin));
      else this.messages.push(result.message);
      return true;
    };
    this.controls.onClick = () => this.playSfx(SFX.CLICK);
    decodePicture(disk, PICTURES.main, this.screen);
    this.background = this.screen.pixels.slice();
  }

  // $4692: removes the first unit (the original walks its list in slot order).
  private destroyFirstUnit(): number | null {
    const layer = this.objects;
    if (!layer) return this.state.long(0x14254) > 0 ? 9 : this.state.long(0x14258) > 0 ? 10 : null;
    const unit = layer.units.units[0];
    if (!unit) return null;
    layer.destroyUnit(unit);
    return unit.type;
  }

  // $1237C: full volume when the blast is inside the visible 8x8 window, half outside.
  private explosionAt(x: number, y: number): void {
    const inside = x >= this.scrollX && x < this.scrollX + VIEW_CELLS && y >= this.scrollY && y < this.scrollY + VIEW_CELLS;
    this.playSfx(SFX.EXPLOSION_LOW, inside ? 64 : 32);
  }

  // Shows a string-table message on the message line / log.
  say(index: number): void {
    this.messages.push(index);
  }

  // $DF5A: a new invention. The original opens a picture dialog; here the description from table
  // $B1CC (word pair per invention: title, description) goes to the message log.
  announceInvention(bit: number): void {
    this.messages.push(readInventionText(this.disk, bit));
  }

  // Keyboard ($15B4A): P and space toggle the pause ($156A9 bit 2).
  private key(key: string, input: Input): void {
    if (key === "p" || key === "P" || key === " ") this.sim.paused = !this.sim.paused;
    // Keys 1-8 drop or lift a marker pin on the cell under the pointer (messages $71 / $72).
    if (this.objects && key >= "1" && key <= "8") {
      const cell = this.controls.pickCell(input.pointerX, input.pointerY);
      if (cell) this.messages.push(this.objects.toggleMarker(Number(key), cell.x, cell.y) === "placed" ? 0x71 : 0x72);
    }
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
    for (const key of input.keys?.splice(0) ?? []) this.key(key, input);
    const used = this.controls.update(input);
    if (!used && (input.leftButton || input.rightButton)) {
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
    this.sim.tick();
    if (this.objects) {
      this.objects.paused = this.sim.paused;
      this.objects.update();
    }
    for (const index of this.sim.messages.splice(0)) {
      this.messages.push(index);
      if (ALERT_MESSAGES.has(index)) this.playSfx(SFX.ALERT);
    }
    this.messages.update();
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
    this.controls.draw(this.screen);
    this.messages.draw(this.screen);
  }

  private drawTiles(): void {
    // Painter order: diagonals by vx + vy, then vx ascending.
    for (let s = 0; s <= 2 * (VIEW_CELLS - 1); s++) {
      for (let vx = Math.max(0, s - (VIEW_CELLS - 1)); vx <= Math.min(VIEW_CELLS - 1, s); vx++) {
        const vy = s - vx;
        const cell = this.cells[(this.scrollY + vy) * MAP_WIDTH + this.scrollX + vx];
        const tile = this.tiles[(cell & TILE_ID_MASK) - 1]; // ids are 1-based
        if (tile && !this.objects?.claimed(vx, vy)) this.drawTile(tile, anchorX(vx, vy), anchorY(vx, vy));
        this.objects?.drawAfterCell(this.screen, this.scrollX, this.scrollY, vx, vy);
      }
    }
    this.objects?.drawMarkers(this.screen, this.scrollX, this.scrollY);
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
