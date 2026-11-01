// Title screen with the looping credit roll. Runs at 50 Hz (one update per video frame).
// Timing and drawing follow the original boot stage; see notes/formats/text.md.

import { decodePicture, PICTURES } from "../data/picture.js";
import { drawText, getString } from "../data/text.js";
import { Screen } from "../gfx/screen.js";

const CREDIT_LIST = 0x4644; // word list of string indices, ends with a negative word
const TEXT_X = 0x30;
const TEXT_Y = 0xb4;
const TEXT_COLOR = 1;
const CLEAR_X = 0x28;
const CLEAR_WIDTH_BYTES = 0x1f;
const TEXT_ROWS = 7;
const CHAR_DELAY_FRAMES = 2;
const HOLD_FRAMES = 0x79;

export interface Input {
  leftButton: boolean;
}

export type IntroResult = "running" | "clicked";

export class IntroScene {
  readonly screen = new Screen();
  private readonly credits: number[] = [];
  private creditIndex = 0;
  private text: Uint8Array = new Uint8Array(0);
  private shown = 0;
  private wait = 0;
  private phase: "typing" | "holding" = "typing";

  constructor(private readonly disk: Uint8Array) {
    decodePicture(disk, PICTURES.title, this.screen);
    for (let at = CREDIT_LIST; ; at += 2) {
      const word = (disk[at] << 8) | disk[at + 1];
      if (word & 0x8000) break;
      this.credits.push(word);
    }
    this.startString();
  }

  private startString(): void {
    this.text = getString(this.disk, 0, this.credits[this.creditIndex]);
    this.shown = 0;
    this.wait = CHAR_DELAY_FRAMES;
    this.phase = "typing";
  }

  // The original clears bitplane 0 only, which removes colour 1 text over a black background.
  private clearText(): void {
    for (let y = TEXT_Y; y < TEXT_Y + TEXT_ROWS; y++) {
      for (let x = CLEAR_X; x < CLEAR_X + CLEAR_WIDTH_BYTES * 8; x++) {
        this.screen.pixels[y * 320 + x] &= ~1;
      }
    }
  }

  update(input: Input): IntroResult {
    if (this.phase === "typing") {
      if (input.leftButton) this.wait = 0;
      if (this.wait > 0) {
        this.wait--;
        return "running";
      }
      this.shown++;
      drawText(this.disk, this.screen, this.text.subarray(0, this.shown), TEXT_X, TEXT_Y, TEXT_COLOR);
      if (this.shown >= this.text.length) {
        this.phase = "holding";
        this.wait = HOLD_FRAMES;
      } else {
        this.wait = CHAR_DELAY_FRAMES;
      }
      return "running";
    }

    if (input.leftButton) return "clicked";
    if (--this.wait > 0) return "running";

    this.clearText();
    this.creditIndex = (this.creditIndex + 1) % this.credits.length;
    this.startString();
    return "running";
  }
}
