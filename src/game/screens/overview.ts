// Full-screen map overview (icon column button 1, $F176): the whole 100 x 75 map at two pixels per
// cell, seven "layer" buttons that recolour it, an 8 x 8 cell magnified preview of the current view,
// click-to-scroll, and the eight marker pins. Everything (picture, palette, button rectangles, legend
// table, view-box and pin images, circle masks) is read from the user's Disk.1 at runtime. Layout and
// logic: notes/formats/screens.md section 8.

import { COLOR, drawGameText } from "../../data/gamefont.js";
import { SFX } from "../../audio/sfx.js";
import { decodePicture, type SectorRange } from "../../data/picture.js";
import { MAP_HEIGHT, MAP_WIDTH } from "../../data/scenario.js";
import { Screen, SCREEN_WIDTH, type Rgb } from "../../gfx/screen.js";
import type { Input } from "../intro.js";
import { GameImage } from "./image.js";
import { placeNextMarker } from "./markers.js";
import { fillRect, restoreMainBackground } from "./planar.js";
import { MousePoll } from "./mouse-poll.js";
import type { Cell, OverviewUnits, ScreenContext, ScreenScene } from "./types.js";

// Events one frame can carry: a left press, then a right re-press (and a release before them). Same bound as the windows.
const MAX_POLL_EVENTS = 4;

const PICTURE: SectorRange = { first: 0x2e8, last: 0x2f6 }; // picture 0 of the table at $8C8C

export const OVERVIEW = {
  mode: 0x144b6, // layer button last used (0-6)
  power: 0x144c8, // buildings of tile ids 6-13 only project coverage while this is below 4
  inventions: 0x14472,
  scrollX: 0x144e4,
  scrollY: 0x144e6,
} as const;

// Tables in the program image.
const BUTTON_RECTS = 0xff5c; // 8 x {x0, x1, y0, y1}, ended by $FFFF
const LEGEND = 0xff9e; // 7 modes x 6 string indices ($FFFE = blank)
const LEGEND_SLOTS = 0xfff2; // 6 label records {index, x, y}
const PIN_GLYPHS = 0x10a88; // 8 pin images, 8 x 8 pixels, 5 planes x 8 rows
const VIEW_BOX = 0x105c4; // 16 x 16 frame, 5 planes x 16 rows x 4 bytes (plane 0 doubles as the mask)
const CIRCLES = [
  { at: 0x10018, size: 7 },
  { at: 0x10049, size: 21 },
  { at: 0x10202, size: 31 },
] as const;

export const MODE_COUNT = 7;
export const EXIT_BUTTON_INDEX = 7;

// Screen geometry.
const MAP_X = 8; // top-left of the overview map (2 x 2 pixels per cell)
const MAP_Y = 8;
const MAP_LIMIT_X = 0xd1; // clicks left of this and above MAP_LIMIT_Y scroll the view
const MAP_LIMIT_Y = 0xa0;
const PREVIEW_X = 232; // 8 x 8 cells of 8 x 8 pixels; drawn from y 75, clicks use y 74-137
const PREVIEW_Y = 75;
const PREVIEW_HIT = { x0: 0xe8, x1: 0x128, y0: 0x4a, y1: 0x8a };
const PIN_STRIP_X = 232;
const PIN_STRIP_Y = 151;
export const VIEW_CELLS = 8;
const MAX_SCROLL_X = 0x5c;
const MAX_SCROLL_Y = 0x43;
// Blink cadence (static trace of Disk.1, screens.md section 8 "Blink cadence"). Copperline measured 10 VBLs per blink on a
// 68020 reference machine and 14 on a 68000 A600 config (2026-11-10); this model, with its constants, still gives 10 and is
// not recalibrated here. The loop counts
// idle passes in `$10A84`: `move.w #$1770` at `$F214` (6000) on every restart of the loop at `$F208`, one decrement per pass
// at `$F21C`. At zero the loop waits for a VBL (`$F22C`), the pin routine `$FD80` waits for a second (`$FDA6`), then it
// toggles the pin phase `$10A86` (`$FEC8`) and restarts. The model counts passes, not frames: a frame has room for a fixed
// number of idle passes, so the blink lands on a frame boundary, `IDLE_POLLS_PER_FRAME` passes after the last restart.
export const BLINK_POLLS = 0x1770; // $F214: passes until the blink
// One idle pass: `$F21C`-`$F268` plus the `$50B2` idle path (`$50B4`-`$50FE`), summed from the 68000 table as recalled (no
// table in the repo, unverified); the bus floor (executed words and bus accesses at 4 clocks each) is 188. DMA only adds.
// Measured (screens.md, section 8): 196 clocks at 7.09 MHz matches the A1200 68020 run (96 CCK, about 27 us per pass); the
// 68000 A600 run took about 305 clocks per pass, so this constant is not a 68000 figure. Not recalibrated here.
export const IDLE_POLL_CLOCKS = 196;
// One PAL video frame: 312.5 lines of 454 clocks at 7,093,790 Hz. The frames themselves are 141,648 or 142,102 clocks.
export const PAL_FRAME_CLOCKS = 141875;
/** Idle passes per video frame in the model (723 with the figures above). */
export const IDLE_POLLS_PER_FRAME = Math.floor(PAL_FRAME_CLOCKS / IDLE_POLL_CLOCKS);

// Colours of the classes the layers use.
const GROUND = 5;
const ROCK = 2;
const PIN_COLOUR = 13;
const BUTTON_FLIP = 8; // $57D6 complements the plane behind pointer #3 (a6 + $C): colour bit 3

const BOX_HALF = 5; // $F954: resource detection reaches 5 cells around every animated cell

export interface OverviewEnv {
  cells: Uint16Array; // 100 x 75 map words
  inventions: number; // long $14472
  power: number; // byte $144C8
  circles: Uint8Array[]; // the three coverage masks (7 x 7, 21 x 21, 31 x 31), nonzero = covered
  units: OverviewUnits;
}

function s8(v: number): number {
  return ((v & 0xff) << 24) >> 24;
}

const isRock = (w: number): boolean => ((w >> 8) & 0x14) === 0x10; // bit 12 set, bit 10 clear

// $F6E4: map of the cells inside the range of the working buildings. Everything is covered when the
// invention bit 17 is set. Only cells with the animated flag (bit 10) project a range, by tile id: below 6
// and from 14 up a 7 x 7 circle, 6-9 a 21 x 21 circle, 10-13 a 31 x 31 circle (the two big ones only
// while power byte $144C8 is below 4).
export function coverageMap(env: OverviewEnv): Uint8Array {
  const cover = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  if (env.inventions & (1 << 17)) cover.fill(0xff);
  const working = s8(env.power) < 4;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const w = env.cells[y * MAP_WIDTH + x];
      if (!(w & 0x400)) continue;
      const id = w & 0x3ff;
      let mask: number;
      if (id < 6 || id >= 14) mask = 0;
      else if (!working) continue;
      else mask = id < 10 ? 1 : 2;
      stamp(cover, env.circles[mask], CIRCLES[mask].size, x, y);
    }
  }
  return cover;
}

function stamp(into: Uint8Array, mask: Uint8Array, size: number, cx: number, cy: number): void {
  const half = (size - 1) >> 1;
  for (let j = 0; j < size; j++) {
    const y = cy - half + j;
    if (y < 0 || y >= MAP_HEIGHT) continue;
    for (let i = 0; i < size; i++) {
      const x = cx - half + i;
      if (x < 0 || x >= MAP_WIDTH) continue;
      if (mask[j * size + i]) into[y * MAP_WIDTH + x] |= 0xff;
    }
  }
}

// $F954: 11 x 11 boxes around every animated cell (bit 10) - where deposits can be seen.
export function detectionMap(cells: Uint16Array): Uint8Array {
  const seen = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (!((cells[y * MAP_WIDTH + x] >> 8) & 4)) continue;
      for (let j = -BOX_HALF; j <= BOX_HALF; j++) {
        for (let i = -BOX_HALF; i <= BOX_HALF; i++) {
          const nx = x + i;
          const ny = y + j;
          if (nx >= 0 && ny >= 0 && nx < MAP_WIDTH && ny < MAP_HEIGHT) seen[ny * MAP_WIDTH + nx] = 0xff;
        }
      }
    }
  }
  return seen;
}

// $F632 (layer 0): classes of the buildings by tile id.
function colourBuildings(w: number): number {
  if (isRock(w)) return ROCK;
  if (!(w & 0x400)) return GROUND;
  const id = w & 0x3ff;
  if (id === 0x32) return 9;
  if (id >= 1 && id < 4) return 0x0d;
  if (id === 0x60) return 0x15;
  if (id === 0x3e) return 0x18;
  if (id >= 0x48 && id < 0x4c) return 6;
  return 0x12;
}

// $F7FE (layer 6).
function colourLayerSix(w: number): number {
  let c = GROUND;
  if (isRock(w)) return ROCK;
  const id = w & 0x3ff;
  if (w & 0x400) {
    if (id >= 0x1f && id < 0x2f) c = 0x0d;
    else if (id >= 0x0f && id < 0x1f) c = 0x12;
    else if (id === 0x30) c = 0x15;
    else if (id === 0x31) c = 0x18;
  }
  return id === 0x61 ? 9 : c;
}

// $F86A (layer 5): no rock test, animated cells only.
function colourLayerFive(w: number): number {
  if (!(w & 0x400)) return GROUND;
  const id = w & 0x3ff;
  if (id === 0x33) return 9;
  if (id === 0x34) return 6;
  if (id >= 0x4c && id < 0x54) return 0x18;
  if (id >= 0x58 && id < 0x5c) return 0x12;
  if (id === 0x35) return 0x15;
  if (id >= 1 && id < 4) return 0x0d;
  return GROUND;
}

// $FA24: units on top of the terrain: own ground units 0x18, own ships 6, enemy ground units 9 and
// enemy aircraft 0x15 (the enemy ones only inside the coverage).
function overlayUnits(colours: Uint8Array, cover: Uint8Array, units: OverviewUnits): void {
  const put = (list: Cell[], colour: number, needCover: boolean): void => {
    for (const u of list) {
      if (u.x < 0 || u.y < 0 || u.x >= MAP_WIDTH || u.y >= MAP_HEIGHT) continue;
      const at = u.y * MAP_WIDTH + u.x;
      if (!needCover || cover[at]) colours[at] = colour;
    }
  };
  put(units.own, 0x18, false);
  put(units.ships, 6, false);
  put(units.enemyGround, 9, true);
  put(units.enemyAir, 0x15, true);
}

// The colour index of every cell for layer `mode` (0-6), the table the original builds at $2954A.
export function overviewColours(mode: number, env: OverviewEnv): Uint8Array {
  const out = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const cells = env.cells;
  switch (mode) {
    case 0:
      for (let i = 0; i < out.length; i++) out[i] = colourBuildings(cells[i]);
      break;
    case 1:
    case 2: {
      // Deposits (map flag bit 15 / bit 11) show up only inside the detection boxes or once the
      // matching invention (bit 9 / bit 10 of $14472) is known.
      const seen = detectionMap(cells);
      const flagBit = mode === 1 ? 0x80 : 0x08;
      const invention = mode === 1 ? 9 : 10;
      for (let i = 0; i < out.length; i++) {
        const w = cells[i];
        if (((w >> 8) & flagBit) && ((env.inventions >>> invention) & 1 || seen[i])) out[i] = 0x0d;
        else out[i] = isRock(w) ? ROCK : GROUND;
      }
      break;
    }
    case 3: {
      const cover = coverageMap(env);
      for (let i = 0; i < out.length; i++) {
        const id = cells[i] & 0x3ff;
        out[i] = id >= 6 && id < 14 ? 0x0d : cover[i] ? 0x12 : GROUND;
      }
      overlayUnits(out, cover, env.units);
      break;
    }
    case 4: {
      const cover = coverageMap(env);
      for (let i = 0; i < out.length; i++) out[i] = isRock(cells[i]) ? ROCK : GROUND;
      overlayUnits(out, cover, env.units);
      break;
    }
    case 5:
      for (let i = 0; i < out.length; i++) out[i] = colourLayerFive(cells[i]);
      break;
    default:
      for (let i = 0; i < out.length; i++) out[i] = colourLayerSix(cells[i]);
      break;
  }
  return out;
}

export function clampScroll(x: number, y: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(MAX_SCROLL_X, x)), y: Math.max(0, Math.min(MAX_SCROLL_Y, y)) };
}

// A click on the overview map ($F2D4-$F2E0): the clicked cell becomes the middle of the 8 x 8 view.
export function scrollForClick(px: number, py: number): { x: number; y: number } {
  const axis = (pixel: number, origin: number, max: number): number => {
    // `$F2D4-$F2E0` uses SUBQ.W, LSR.W, SUBQ.W before `$FB1E` clamps the result as a signed word.
    // Preserve the 16-bit underflow: pixels in the 8-pixel top/left margin become a large positive
    // scroll request and therefore clamp to the far edge, rather than to zero.
    const delta = (Math.trunc(pixel) - origin) & 0xffff;
    const shifted = delta >>> 1;
    const word = (shifted - 4) & 0xffff;
    const signed = word >= 0x8000 ? word - 0x10000 : word;
    return Math.max(0, Math.min(max, signed));
  };
  return { x: axis(px, MAP_X, MAX_SCROLL_X), y: axis(py, MAP_Y, MAX_SCROLL_Y) };
}

interface OverviewAssets {
  picture: Screen;
}

const assetCache = new WeakMap<Uint8Array, OverviewAssets>();

function loadAssets(disk: Uint8Array): OverviewAssets {
  let a = assetCache.get(disk);
  if (!a) {
    a = { picture: decodePicture(disk, PICTURE) };
    assetCache.set(disk, a);
  }
  return a;
}

interface Pin {
  number: number; // 1-8
  x: number;
  y: number;
}

export class OverviewScreen implements ScreenScene {
  private readonly image: GameImage;
  private readonly assets: OverviewAssets;
  private readonly mouse = new MousePoll(); // the `$50B2` state of the loop (mouse-poll.ts)
  private mouseStarted = false;
  private readonly rects: { x0: number; x1: number; y0: number; y1: number }[] = [];
  private readonly circles: Uint8Array[];
  private colours: Uint8Array = new Uint8Array(0);
  private pins: Pin[] = [];
  private pressed = -1;
  private idlePolls = 0; // $10A84 counted up: idle passes since the last restart of the loop (BLINK_POLLS expires it)
  private blinkWait = false; // the first VBL wait of the blink ($F22C) ended this frame; the second ($FDA6) ends the next
  private pinsShown = false; // $10A86: markers are drawn on the map and preview only every other period
  private target: Screen | null = null;
  private done = false;
  mode: number;
  scrollX = 0;
  scrollY = 0;

  constructor(private readonly ctx: ScreenContext) {
    this.image = new GameImage(ctx.disk);
    this.assets = loadAssets(ctx.disk);
    for (let a = BUTTON_RECTS; this.image.signedWord(a) !== -1; a += 8) {
      this.rects.push({ x0: this.image.word(a), x1: this.image.word(a + 2), y0: this.image.word(a + 4), y1: this.image.word(a + 6) });
    }
    this.circles = CIRCLES.map((c) => Uint8Array.from(this.image.bytes(c.at, c.size * c.size)));
    const state = ctx.world.state;
    const mode = state.byte(OVERVIEW.mode);
    this.mode = mode < MODE_COUNT ? mode : 0;
    this.setScroll(this.currentScroll().x, this.currentScroll().y); // $FB1E clamps what the map had
    this.rebuild();
  }

  // ---- state --------------------------------------------------------------------------------

  private currentScroll(): { x: number; y: number } {
    if (this.ctx.scroll) return { x: this.ctx.scroll.x, y: this.ctx.scroll.y };
    const s = this.ctx.world.state;
    return { x: s.word(OVERVIEW.scrollX), y: s.word(OVERVIEW.scrollY) };
  }

  // $FB1E: clamp and store the scroll position.
  setScroll(x: number, y: number): void {
    const c = clampScroll(x, y);
    this.scrollX = c.x;
    this.scrollY = c.y;
    if (this.ctx.scroll) {
      this.ctx.scroll.x = c.x;
      this.ctx.scroll.y = c.y;
    }
    const s = this.ctx.world.state;
    s.setWord(OVERVIEW.scrollX, c.x);
    s.setWord(OVERVIEW.scrollY, c.y);
  }

  // Everything the original recomputes after a click ($F3D8, $FB1E, $FB68, $FC7A).
  private rebuild(): void {
    const s = this.ctx.world.state;
    const units: OverviewUnits = {
      own: (this.ctx.objects?.units.units ?? []).map((u) => ({ x: u.x, y: u.y })),
      ships: [],
      enemyGround: [],
      enemyAir: [],
      ...this.ctx.otherUnits?.(),
    };
    this.colours = overviewColours(this.mode, {
      cells: this.ctx.world.cells,
      inventions: s.long(OVERVIEW.inventions),
      power: s.byte(OVERVIEW.power),
      circles: this.circles,
      units,
    });
    this.pins = (this.ctx.objects?.markers ?? []).filter((m) => m.y !== 0xff).map((m) => ({ number: m.type, x: m.x, y: m.y }));
    this.pinsShown = false; // $FC7A: `clr.b $10A86` on every rebuild, so the next blink draws the pins
  }

  // Test and diagnostic reads of the blink state (no caller changes it).
  get idlePassCount(): number {
    return this.idlePolls;
  }
  get blinkPending(): boolean {
    return this.blinkWait;
  }
  get pinsDrawn(): boolean {
    return this.pinsShown;
  }
  get latchedButton(): number {
    return this.pressed;
  }

  // ---- input --------------------------------------------------------------------------------

  private buttonAt(px: number, py: number): number {
    return this.rects.findIndex((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
  }

  // The loop of $F208-$F2F6 (static trace of Disk.1): every event of the mouse poll `$50B2` runs its branch at once. A left
  // press hit-tests the pointer: a layer button is latched and clicked, the preview or the map scrolls or places a pin, and
  // anything else does nothing. A release runs the latched button ($57FA) wherever the pointer is; only the exit button (7)
  // leaves. The loop reads no key and no right button: Escape and a right click do nothing here (screens.md section 8).
  // One video frame (one update). The loop of $F208-$F2F6 is what runs between the VBL waits: idle passes count `$10A84`
  // down from 6000, every event that reaches `$F208` restarts the count (see press() and the release below), and the
  // blink waits for the VBLs of section "Blink cadence" in screens.md. The frame's events come first, then its idle passes.
  // The event's place within the frame is not resolved, so a frame with a restart keeps half a frame of idle passes (the
  // expected passes after a uniformly placed event). Tests: test/overview.mjs, "blink cadence".
  update(input: Input): "running" | "close" {
    if (this.done) return "close";
    if (input.keys) input.keys.length = 0;
    if (!this.mouseStarted) {
      this.mouse.start(input.leftButton, input.rightButton);
      this.mouseStarted = true;
    }

    // $FDA6 after the first VBL ($F22C) of the blink: the loop polls nothing while it waits. This frame's end is the second
    // VBL; the pin phase toggles ($FEC8) and the count restarts from zero at $F214 (no idle pass of this frame is counted).
    if (this.blinkWait) {
      this.blinkWait = false;
      this.pinsShown = !this.pinsShown;
      this.idlePolls = 0;
      return "running";
    }

    let restarted = false;
    for (let n = 0; n < MAX_POLL_EVENTS && this.mouse.poll(input.leftButton, input.rightButton); n++) {
      if (this.mouse.isLeftHeld) {
        restarted = this.press(input.pointerX, input.pointerY) || restarted;
      } else if (this.pressed >= 0) {
        const b = this.pressed;
        this.pressed = -1;
        if (b === EXIT_BUTTON_INDEX) return this.leave();
        this.mode = b; // $144B6 = the button; the map is redrawn with the new layer
        this.ctx.world.state.setByte(OVERVIEW.mode, b);
        this.rebuild();
        restarted = true; // $F2F6 -> $F208
      }
      // A release with nothing latched and a right press alone leave through $F21C: no restart.
    }

    if (restarted) this.idlePolls = IDLE_POLLS_PER_FRAME >> 1;
    else this.idlePolls += IDLE_POLLS_PER_FRAME;
    if (this.idlePolls >= BLINK_POLLS) this.blinkWait = true; // the first VBL ($F22C) ends this frame
    return "running";
  }

  // A left press at the pointer ($F284). Returns true when the original restarts the loop through $F208: the preview ($F3B2,
  // then $F2F6), the map ($F2D4, then $F2F6) and the pointer off the map ($F2C4 branches to $F208 without changing anything).
  // A layer button press only latches the button and returns to $F21C ($5756, `bra $F21C`), so it does not restart the count.
  private press(px: number, py: number): boolean {
    const b = this.buttonAt(px, py);
    if (b >= 0) {
      this.ctx.sound?.(SFX.CLICK); // $F29C -> $5756 requests id 4 on the press
      this.pressed = b; // $5756: shown flipped until released ($5DD4 holds the index)
      return false;
    }
    if (px >= PREVIEW_HIT.x0 && px < PREVIEW_HIT.x1 && py >= PREVIEW_HIT.y0 && py < PREVIEW_HIT.y1) {
      // $F3B2: the clicked preview cell gets (or loses) a marker pin through $311E, no message shown.
      const cx = this.scrollX + ((px - PREVIEW_HIT.x0) >> 3);
      const cy = this.scrollY + ((py - PREVIEW_HIT.y0) >> 3);
      if (this.ctx.objects) placeNextMarker(this.ctx.objects, cx, cy);
      this.rebuild();
      return true;
    }
    if (px < MAP_LIMIT_X && py < MAP_LIMIT_Y) {
      const c = scrollForClick(px, py);
      this.setScroll(c.x, c.y);
      this.rebuild();
      return true;
    }
    return true; // $F2C4: off the map (x >= $D1 or y >= $A0) the loop restarts at once and nothing else changes
  }

  private leave(): "close" {
    this.done = true;
    if (this.target) restoreMainBackground(this.target, this.ctx.disk);
    return "close";
  }

  // ---- drawing ------------------------------------------------------------------------------

  draw(screen: Screen): void {
    this.target = screen;
    const picture = this.assets.picture;
    screen.pixels.set(picture.pixels);
    screen.palette = picture.palette.map((c) => [...c] as Rgb);

    this.drawLegend(screen);
    this.drawMap(screen);
    this.drawViewBox(screen);
    this.drawPreview(screen);
    this.drawPinStrip(screen);
    if (this.pinsShown) this.drawPins(screen);
    if (this.pressed >= 0) this.flipButton(screen, this.pressed);
  }

  // $F560: the six description lines of the layer, drawn in the message panel.
  private drawLegend(screen: Screen): void {
    for (let i = 0; i < 6; i++) {
      const index = this.image.signedWord(LEGEND + 12 * this.mode + 2 * i);
      if (index < 0) continue;
      const slot = LEGEND_SLOTS + 6 * i;
      drawGameText(this.ctx.disk, screen, this.ctx.strings.get(index), this.image.word(slot + 2), this.image.word(slot + 4), COLOR.text);
    }
  }

  private drawMap(screen: Screen): void {
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const c = this.colours[y * MAP_WIDTH + x] & 31;
        const px = MAP_X + 2 * x;
        const py = MAP_Y + 2 * y;
        screen.set(px, py, c);
        screen.set(px + 1, py, c);
        screen.set(px, py + 1, c);
        screen.set(px + 1, py + 1, c);
      }
    }
  }

  // $FB1E: the 16 x 16 frame around the part of the map the main view shows (drawn through the mask).
  private drawViewBox(screen: Screen): void {
    const x0 = MAP_X + 2 * this.scrollX;
    const y0 = MAP_Y + 2 * this.scrollY;
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const bit = (plane: number): number => (this.image.byte(VIEW_BOX + plane * 64 + row * 4 + (col >> 3)) >> (7 - (col & 7))) & 1;
        if (!bit(0)) continue;
        let index = 0;
        for (let plane = 0; plane < 5; plane++) index |= bit(plane) << plane;
        screen.set(x0 + col, y0 + row, index);
      }
    }
  }

  // $FB68: the 8 x 8 cells of the view, magnified to 8 x 8 pixels each.
  private drawPreview(screen: Screen): void {
    for (let cy = 0; cy < VIEW_CELLS; cy++) {
      for (let cx = 0; cx < VIEW_CELLS; cx++) {
        fillRect(screen, PREVIEW_X + 8 * cx, PREVIEW_Y + 8 * cy, 8, 8, this.colours[(this.scrollY + cy) * MAP_WIDTH + this.scrollX + cx] & 31);
      }
    }
  }

  private glyph(screen: Screen, pin: number, x: number, y: number): void {
    const at = PIN_GLYPHS + 40 * (pin - 1);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        let index = 0;
        for (let plane = 0; plane < 5; plane++) index |= ((this.image.byte(at + plane * 8 + row) >> (7 - col)) & 1) << plane;
        screen.set(x + col, y + row, index);
      }
    }
  }

  // $FC7A: eight slots below the preview; a pin that is not on the map shows its image, a placed one
  // leaves its slot black.
  private drawPinStrip(screen: Screen): void {
    for (let k = 1; k <= 8; k++) {
      const x = PIN_STRIP_X + 8 * (k - 1);
      if (this.pins.some((p) => p.number === k)) fillRect(screen, x, PIN_STRIP_Y, 8, 8, 0);
      else this.glyph(screen, k, x, PIN_STRIP_Y);
    }
  }

  // $FD80: on the blink phase every pin shows as a colour-13 dot on the map and, when its cell is in the
  // view, as its numbered image in the preview.
  private drawPins(screen: Screen): void {
    for (const pin of this.pins) {
      fillRect(screen, MAP_X + 2 * pin.x, MAP_Y + 2 * pin.y, 2, 2, PIN_COLOUR);
      const cx = pin.x - this.scrollX;
      const cy = pin.y - this.scrollY;
      if (cx >= 0 && cx < VIEW_CELLS && cy >= 0 && cy < VIEW_CELLS) this.glyph(screen, pin.number, PREVIEW_X + 8 * cx, PREVIEW_Y + 8 * cy);
    }
  }

  private flipButton(screen: Screen, index: number): void {
    const r = this.rects[index];
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) screen.pixels[y * SCREEN_WIDTH + x] ^= BUTTON_FLIP;
    }
  }
}
