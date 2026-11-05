// Full-screen announcement dialog ($E770): a 64 x 64 portrait, a heading and a message.
// id 0 = colony falls to crime, id 1 = game over, 2 = quality of life 80, 3 = quality of life 90. Layout: notes/formats/screens-misc.md.

import { COLOR, drawGameText, wrapText } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import { SECTOR_SIZE } from "../data/picture.js";
import { unpackLz } from "../data/unpack.js";
import { Screen } from "../gfx/screen.js";
import type { Input } from "./intro.js";

const PORTRAITS = { first: 0x2c0, last: 0x2cd }; // Disk.1, packed: 4 frames of 5 planes, 64 x 64
const PORTRAIT_SIZE = 64;
const PLANE_BYTES = (PORTRAIT_SIZE / 8) * PORTRAIT_SIZE;
const PORTRAIT_X = 0x68;
const PORTRAIT_Y = 0x72;
const HEADING_X = 0x58;
const HEADING_Y = 0x0c;
const HEADING_GAME_OVER = 0x183;
const HEADING_OTHER = 0x184;
const MESSAGES = [0x122, 0x185, 0x187, 0x188]; // table $F162, second word of each entry
const TEXT_X = 20;
const TEXT_Y = 30;
const TEXT_WIDTH = 280;

export class AnnounceScene {
  readonly screen: Screen;
  private wasDown = true;

  constructor(disk: Uint8Array, strings: GameStrings, backdrop: Screen, readonly id: number) {
    this.screen = new Screen();
    this.screen.pixels.set(backdrop.pixels);
    this.screen.palette = backdrop.palette.map((c) => [...c] as [number, number, number]);

    for (let y = 6; y < 194; y++) for (let x = 16; x < 304; x++) this.screen.pixels[y * 320 + x] = 0;

    const heading = strings.get(id < 2 ? HEADING_GAME_OVER : HEADING_OTHER);
    drawGameText(disk, this.screen, heading, HEADING_X, HEADING_Y, COLOR.highlight);
    const message = wrapText(disk, strings.get(MESSAGES[id] ?? MESSAGES[0]), TEXT_WIDTH);
    drawGameText(disk, this.screen, message.text, TEXT_X, TEXT_Y, COLOR.text);

    const frames = unpackLz(disk.subarray(PORTRAITS.first * SECTOR_SIZE, (PORTRAITS.last + 1) * SECTOR_SIZE));
    const base = Math.min(id, 3) * 5 * PLANE_BYTES;
    for (let y = 0; y < PORTRAIT_SIZE; y++) {
      for (let x = 0; x < PORTRAIT_SIZE; x++) {
        let index = 0;
        for (let plane = 0; plane < 5; plane++) {
          index |= ((frames[base + plane * PLANE_BYTES + y * 8 + (x >> 3)] >> (7 - (x & 7))) & 1) << plane;
        }
        this.screen.pixels[(PORTRAIT_Y + y) * 320 + PORTRAIT_X + x] = index;
      }
    }
  }

  // True once the player clicks to dismiss the dialog.
  update(input: Input): boolean {
    const pressed = input.leftButton && !this.wasDown;
    this.wasDown = input.leftButton;
    return pressed;
  }
}
