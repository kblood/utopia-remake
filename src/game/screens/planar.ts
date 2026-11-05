// Small helpers for the full-screen scenes (overview map, council room): the original's bitmaps are
// five planes stored one after the other, and its full-screen pictures bring their own palette.

import { decodePicture, PICTURES } from "../../data/picture.js";
import { Screen, SCREEN_WIDTH, type Rgb } from "../../gfx/screen.js";

const mainCache = new WeakMap<Uint8Array, Screen>();

// The pristine gameplay background (picture + palette), decoded once per disk image.
export function mainBackground(disk: Uint8Array): Screen {
  let screen = mainCache.get(disk);
  if (!screen) {
    screen = decodePicture(disk, PICTURES.main);
    mainCache.set(disk, screen);
  }
  return screen;
}

// What a full-screen scene leaves behind when it closes: the gameplay background and palette (the
// map scene redraws its own window, bar and messages on top every frame).
export function restoreMainBackground(screen: Screen, disk: Uint8Array): void {
  const main = mainBackground(disk);
  screen.pixels.set(main.pixels);
  screen.palette = main.palette.map((c) => [...c] as Rgb);
}

// A bitmap of `rows` rows of `rowBytes` bytes per plane, planes one after the other (`planeStride`
// bytes apart), drawn with its top-left corner at (x, y). `data[offset]` is plane 0, row 0.
export function drawPlanar(
  screen: Screen,
  data: ArrayLike<number>,
  offset: number,
  planeStride: number,
  rowBytes: number,
  rows: number,
  x: number,
  y: number,
): void {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < rowBytes * 8; col++) {
      let index = 0;
      for (let plane = 0; plane < 5; plane++) {
        const byte = data[offset + plane * planeStride + row * rowBytes + (col >> 3)];
        index |= ((byte >> (7 - (col & 7))) & 1) << plane;
      }
      screen.set(x + col, y + row, index);
    }
  }
}

export function fillRect(screen: Screen, x: number, y: number, w: number, h: number, index: number): void {
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) screen.set(x + col, y + row, index);
}

export function copyPixels(from: Uint8Array, screen: Screen): void {
  screen.pixels.set(from.subarray(0, SCREEN_WIDTH * 200));
}
