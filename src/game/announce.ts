// Full-screen announcement dialog ($E770). It is drawn over the frozen map picture, not on a black panel:
//   - the portrait window $F0F8 (96,106, 10 x 10 pieces) around the 64 x 64 portrait at (104,114);
//   - the text window $F108 (0,8, 31 x 11 pieces) with the heading at (88,12) and the message below it;
//   - the ten command buttons ($5E06 rectangles, images $E930): blank, except index 9, the exit icon.
// The dialog leaves like `$58F8`: a press on one of the command buttons flips it and plays the click (id 4, `$5756`),
// and the release anywhere returns to the caller (`$57FA`). A press elsewhere does nothing; Escape and the right
// button do not leave (the original loop reads neither). The id selects the heading and the portrait frame.
// Layout and evidence: notes/formats/screens-misc.md. The message origin and wrap width come from the $15668 record
// (readMessageContext), read from the user's disk.

import { COLOR, drawGameText, wrapText } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import { SECTOR_SIZE } from "../data/picture.js";
import { unpackLz } from "../data/unpack.js";
import { Screen } from "../gfx/screen.js";
import type { Input } from "./intro.js";
import { GameImage } from "./screens/image.js";
import { Pointer, Ui } from "./screens/ui.js";

const PORTRAITS = { first: 0x2c0, last: 0x2cd }; // Disk.1, packed: 4 frames of 5 planes, 64 x 64
const PORTRAIT_SIZE = 64;
const PLANE_BYTES = (PORTRAIT_SIZE / 8) * PORTRAIT_SIZE;
const PORTRAIT_X = 0x68;
const PORTRAIT_Y = 0x72;
const PORTRAIT_WINDOW = 0xf0f8; // $F0F8 window rectangle (x, y, width in 8-pixel bytes, height in 8-pixel rows)
const TEXT_WINDOW = 0xf108; // $F108
const BUTTON_IMAGES = 0xe930; // $E930: ten image pointers, index 9 = exit icon
const HEADING_GAME_OVER = 0x183;
const HEADING_OTHER = 0x184;
const HEADING_X = 0x58;
const HEADING_Y = 0x0c;
const MESSAGES = [0x122, 0x185, 0x187, 0x188]; // table $F162, second word of each entry
// Text context record $15668, used by $E770 (and the F-key screen $E000) with $5A4E. Words: +0 x, +2 y, +4 used-line
// cursor (cleared by $E770 before the call), +6 max lines (read only by $5A8C), +8 wrap width in pixels ($5C30 wraps
// when the advance sum reaches it). No traced code writes x, y or the width, so their values are the disk's own
// (STATIC, notes/formats/screens-misc.md): x 8, y 39, width 240.
const MESSAGE_CONTEXT = 0x15668;

export interface MessageContext {
  x: number;
  y: number;
  width: number;
}

export function readMessageContext(disk: Uint8Array): MessageContext {
  const image = new GameImage(disk);
  return { x: image.word(MESSAGE_CONTEXT), y: image.word(MESSAGE_CONTEXT + 2), width: image.word(MESSAGE_CONTEXT + 8) };
}

export class AnnounceScene {
  // The displayed frame. It is re-rendered in place when the pressed button changes.
  readonly screen: Screen;
  private readonly base: Screen;
  private readonly ui: Ui;
  private readonly buttons: number[];
  private readonly pointer = new Pointer();
  private pressed = -1;

  constructor(
    disk: Uint8Array,
    strings: GameStrings,
    backdrop: Screen,
    readonly id: number,
    private readonly onPress: () => void = () => {},
  ) {
    this.ui = new Ui(disk, strings);
    this.buttons = this.ui.readButtonTable(BUTTON_IMAGES);

    this.base = new Screen();
    this.base.pixels.set(backdrop.pixels);
    this.base.palette = backdrop.palette.map((c) => [...c] as [number, number, number]);
    this.ui.frame(this.base, this.ui.readWindow(PORTRAIT_WINDOW));
    this.ui.frame(this.base, this.ui.readWindow(TEXT_WINDOW));

    const heading = strings.get(id < 2 ? HEADING_GAME_OVER : HEADING_OTHER);
    // $E770 does not set the text colour byte $156AB; the pass leaves it at 1 (the date and money draws restore it), so the
    // heading takes the inherited colour 1 (INFERENCE, notes/formats/screens-misc.md).
    drawGameText(disk, this.base, heading, HEADING_X, HEADING_Y, COLOR.text);
    const context = readMessageContext(disk);
    const message = wrapText(disk, strings.get(MESSAGES[id] ?? MESSAGES[0]), context.width);
    drawGameText(disk, this.base, message.text, context.x, context.y, COLOR.text);

    const frames = unpackLz(disk.subarray(PORTRAITS.first * SECTOR_SIZE, (PORTRAITS.last + 1) * SECTOR_SIZE));
    const portrait = Math.min(id, 3) * 5 * PLANE_BYTES;
    for (let y = 0; y < PORTRAIT_SIZE; y++) {
      for (let x = 0; x < PORTRAIT_SIZE; x++) {
        let index = 0;
        for (let plane = 0; plane < 5; plane++) {
          index |= ((frames[portrait + plane * PLANE_BYTES + y * 8 + (x >> 3)] >> (7 - (x & 7))) & 1) << plane;
        }
        this.base.pixels[(PORTRAIT_Y + y) * 320 + PORTRAIT_X + x] = index;
      }
    }
    this.ui.drawButtons(this.base, this.buttons);

    this.screen = new Screen();
    this.screen.palette = this.base.palette.map((c) => [...c] as [number, number, number]);
    this.render();
  }

  // Returns true when the dialog is left: a release after a press on a command button.
  update(input: Input): boolean {
    this.pointer.update(input);
    const p = this.pointer;
    if (p.pressedEdge) {
      const b = this.ui.buttonAt(p.x, p.y);
      if (b >= 0) {
        this.pressed = b;
        this.onPress();
        this.render();
      }
    }
    if (p.releasedEdge && this.pressed >= 0) {
      this.pressed = -1;
      return true;
    }
    return false;
  }

  private render(): void {
    this.screen.pixels.set(this.base.pixels);
    if (this.pressed >= 0) this.ui.invertButton(this.screen, this.pressed);
  }
}
