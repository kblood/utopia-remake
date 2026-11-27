// Shared drawing and input helpers of the window screens (F1-F6, trade, market, staffing, ...).
// A window is a bordered panel over the map screen: the frame pieces ($B680) are 8x8 tiles that
// the original copies out of the main background picture at row 70, byte columns 10..19; label
// lists ($55CA), number columns ($560A) and the 16x16 button images ($58A0) are drawn on top.
// Layout notes: notes/formats/screens.md.

import { COLOR, drawGameText } from "../../data/gamefont.js";
import type { GameStrings } from "../../data/gamestrings.js";
import { decodePicture, PICTURES } from "../../data/picture.js";
import { Screen, SCREEN_WIDTH } from "../../gfx/screen.js";
import { type Input, isEnterKey, typedDigit } from "../intro.js";
import { GameImage } from "./image.js";

export interface WindowRect {
  x: number; // pixels
  y: number; // pixels
  w: number; // width in bytes (8 pixels)
  h: number; // height in 8-pixel rows
}

export interface Label {
  index: number;
  x: number;
  y: number;
}

// The ten command buttons: rectangle table $5E06 {x0, x1, y0, y1}, 16x16 images.
export const BUTTON_COUNT = 10;
const BUTTON_RECTS = 0x5e06;
const DEFAULT_BUTTON_IMAGE = 0x185a2;
export const EXIT_BUTTON = 9;

// Frame pieces: index k is the 8x8 tile at x = 80 + 8k, y = 70 of the main picture.
const PIECE_X = 80;
const PIECE_Y = 70;
const PIECE = { fill: 0, topLeft: 1, topRight: 2, bottomLeft: 3, bottomRight: 4, top: 5, left: 6, right: 7, bottom: 8 } as const;

const NUMBER_ROW = 9; // $560A: rows 9 pixels apart
const BLANK = 0x23; // '#': blank digit used for leading zeros

const pictureCache = new WeakMap<Uint8Array, Uint8Array>();

function mainPicture(disk: Uint8Array): Uint8Array {
  let pixels = pictureCache.get(disk);
  if (!pixels) {
    pixels = decodePicture(disk, PICTURES.main).pixels;
    pictureCache.set(disk, pixels);
  }
  return pixels;
}

export function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

export class Ui {
  readonly image: GameImage;
  private readonly picture: Uint8Array;
  private readonly rects: { x0: number; x1: number; y0: number; y1: number }[] = [];

  constructor(
    readonly disk: Uint8Array,
    readonly strings: GameStrings,
  ) {
    this.image = new GameImage(disk);
    this.picture = mainPicture(disk);
    for (let i = 0; i < BUTTON_COUNT; i++) {
      const a = BUTTON_RECTS + 8 * i;
      this.rects.push({ x0: this.image.word(a), x1: this.image.word(a + 2), y0: this.image.word(a + 4), y1: this.image.word(a + 6) });
    }
  }

  // ---- data tables in the image -------------------------------------------------------------

  readWindow(address: number): WindowRect {
    const m = this.image;
    return { x: m.word(address), y: m.word(address + 2), w: m.word(address + 4), h: m.word(address + 6) };
  }

  // Label list: triples {string index, x, y}, ended by a word of $FFFF.
  readLabels(address: number): Label[] {
    const out: Label[] = [];
    for (let a = address; this.image.signedWord(a) !== -1; a += 6) {
      out.push({ index: this.image.signedWord(a), x: this.image.word(a + 2), y: this.image.word(a + 4) });
    }
    return out;
  }

  // Ten button image pointers (0 = default image).
  readButtonTable(address: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < BUTTON_COUNT; i++) out.push(this.image.long(address + 4 * i));
    return out;
  }

  // Table of longs holding the addresses of other records (e.g. the object type entries).
  readPointers(address: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => this.image.long(address + 4 * i));
  }

  // ---- drawing -------------------------------------------------------------------------------

  private piece(screen: Screen, k: number, x: number, y: number): void {
    const sx = PIECE_X + 8 * k;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        screen.set(x + col, y + row, this.picture[(PIECE_Y + row) * SCREEN_WIDTH + sx + col]);
      }
    }
  }

  // $B680: frame with filled interior. Width counts 8-pixel columns, height 8-pixel rows.
  frame(screen: Screen, win: WindowRect): void {
    const { x, y, w, h } = win;
    for (let row = 0; row < h; row++) {
      const top = row === 0;
      const bottom = row === h - 1;
      const edge = top
        ? [PIECE.topLeft, PIECE.top, PIECE.topRight]
        : bottom
          ? [PIECE.bottomLeft, PIECE.bottom, PIECE.bottomRight]
          : [PIECE.left, PIECE.fill, PIECE.right];
      for (let col = 0; col < w; col++) {
        const k = col === 0 ? edge[0] : col === w - 1 ? edge[2] : edge[1];
        this.piece(screen, k, x + 8 * col, y + 8 * row);
      }
    }
  }

  // $51E6 / $52A8: repaint a strip of the window background (8-pixel texture, phase y and 7).
  erase(screen: Screen, x: number, y: number, widthBytes: number, rows = 6): void {
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < widthBytes * 8; col++) {
        screen.set((x & ~7) + col, y + r, this.picture[(PIECE_Y + ((y + r) & 7)) * SCREEN_WIDTH + PIECE_X + (col & 7)]);
      }
    }
  }

  text(screen: Screen, bytes: ArrayLike<number>, x: number, y: number, color: number): void {
    drawGameText(this.disk, screen, bytes, x, y, color);
  }

  str(screen: Screen, index: number, x: number, y: number, color: number): void {
    drawGameText(this.disk, screen, this.strings.get(index), x, y, color);
  }

  // $55CA: each label is a string of the table drawn at its position.
  labels(screen: Screen, list: Label[], color: number): void {
    for (const l of list) this.str(screen, l.index, l.x, l.y, color);
  }

  // $15C5A text of a number: `digits` characters, leading zeros blanked, never negative.
  numberText(value: number, digits: number): number[] {
    const v = Math.max(0, Math.floor(value)) % 10 ** digits;
    const s = String(v).padStart(digits, "0");
    const out: number[] = [];
    let blank = true;
    for (let i = 0; i < digits; i++) {
      if (s[i] !== "0" || i === digits - 1) blank = false;
      out.push(blank ? BLANK : s.charCodeAt(i));
    }
    return out;
  }

  // $560A: a column of numbers, one per 9 pixel row. `digits` = number of digit slots (the
  // original passes the first power of ten as divisor).
  numbers(screen: Screen, values: number[], x: number, y: number, digits: number, color: number = COLOR.highlight): void {
    values.forEach((v, i) => this.text(screen, this.numberText(v, digits), x, y + NUMBER_ROW * i, color));
  }

  // ---- buttons -------------------------------------------------------------------------------

  buttonPosition(i: number): { x: number; y: number } {
    return { x: this.rects[i].x0, y: this.rects[i].y0 };
  }

  buttonAt(px: number, py: number): number {
    return this.rects.findIndex((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
  }

  // $5876: 16x16 image, five planes of 16 words one after the other.
  drawButton(screen: Screen, i: number, imageAddress: number): void {
    const { x, y } = this.buttonPosition(i);
    const base = imageAddress === 0 ? DEFAULT_BUTTON_IMAGE : imageAddress;
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        let index = 0;
        for (let plane = 0; plane < 5; plane++) {
          const word = this.image.word(base + plane * 32 + row * 2);
          index |= ((word >> (15 - col)) & 1) << plane;
        }
        screen.set(x + col, y + row, index);
      }
    }
  }

  drawButtons(screen: Screen, table: number[]): void {
    for (let i = 0; i < BUTTON_COUNT; i++) this.drawButton(screen, i, table[i]);
  }

  // $5756 / $57D6: a pressed button is shown flipped (see `flipButtonPixels`).
  invertButton(screen: Screen, i: number): void {
    const { x, y } = this.buttonPosition(i);
    flipButtonPixels(screen, x, y);
  }
}

// `$57D6` (static trace): 16 rows of `not.b (a0)+` twice (16 pixels) through `$C(a6)` of the plane array at `$160FA`/`$16116`,
// i.e. only plane 3 (colour bit 3), not all five planes: pixel ^= 8. The x position is truncated to a byte column (the ten
// command buttons sit on multiples of 8). `$57FA` runs the same routine again, so the flip is its own inverse.
export const BUTTON_FLIP = 8;
export function flipButtonPixels(screen: Screen, x: number, y: number): void {
  const left = x & ~7;
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) screen.pixels[(y + row) * SCREEN_WIDTH + left + col] ^= BUTTON_FLIP;
  }
}

// Edge-detecting mouse helper shared by the scenes. A button that is already held when the
// scene opens (the click that opened it) does not count as a press.
export class Pointer {
  private down: boolean | null = null;
  private rightDown = false;
  pressedEdge = false;
  releasedEdge = false;
  rightPressed = false;
  x = 0;
  y = 0;

  update(input: Input): void {
    if (this.down === null) {
      this.down = input.leftButton;
      this.rightDown = input.rightButton;
    }
    this.pressedEdge = input.leftButton && !this.down;
    this.releasedEdge = !input.leftButton && this.down;
    this.rightPressed = input.rightButton && !this.rightDown;
    this.down = input.leftButton;
    this.rightDown = input.rightButton;
    this.x = input.pointerX;
    this.y = input.pointerY;
  }
}

// $5110 text entry (static trace of Disk.1 `$5110`-`$51DA`, key table `$650A`): digits are echoed followed by a '-'
// cursor. The routine accepts the digits of the table (main keys and keypad), Backspace (raw key `$41`), and Return or
// keypad Enter (`$44` / `$43`, only with at least one digit). Every other key is dropped: Escape and Delete have no
// branch, so the entry cannot be cancelled. `$5110` reads only the key code `$161A0`; it never calls `$50B2`, `$5730` or
// `$5756`, so the mouse does nothing while an entry is open (PanelScene enforces that via `modal`).
export class NumberEntry {
  digits = "";
  done: number | null = null;

  constructor(
    readonly x: number,
    readonly y: number,
    readonly maxDigits: number,
    readonly widthBytes: number,
  ) {}

  feed(keys: string[]): void {
    for (const key of keys.splice(0)) {
      if (this.done !== null) break;
      const digit = typedDigit(key);
      if (digit !== undefined) {
        if (this.digits.length < this.maxDigits) this.digits += digit;
      } else if (key === "Backspace") {
        this.digits = this.digits.slice(0, -1);
      } else if (isEnterKey(key)) {
        if (this.digits.length > 0) this.done = parseInt(this.digits, 10);
      }
    }
  }

  draw(ui: Ui, screen: Screen): void {
    ui.erase(screen, this.x, this.y, this.widthBytes);
    ui.text(screen, ascii(this.digits + "-"), this.x, this.y, COLOR.text);
  }
}
