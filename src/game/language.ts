// Language selection screen: fade the title out, show the language picture, fade it in and
// wait for a left click. The pointer's vertical position picks the language (four bands,
// one per flag). Behaviour follows the original boot stage; see notes/formats/text.md.

import { decodePicture, PICTURES } from "../data/picture.js";
import { blackPalette, clonePalette, Fade } from "../gfx/fade.js";
import { Screen } from "../gfx/screen.js";
import type { Input } from "./intro.js";

export type Language = 0 | 1 | 2 | 3; // English, French, German, Italian

// Pointer rows below which each language is chosen; anything lower is Italian.
const ENGLISH_BELOW = 0x2c;
const FRENCH_BELOW = 0x5b;
const GERMAN_BELOW = 0x89;

export function languageAt(y: number): Language {
  if (y < ENGLISH_BELOW) return 0;
  if (y < FRENCH_BELOW) return 1;
  if (y < GERMAN_BELOW) return 2;
  return 3;
}

export type LanguageResult = { state: "running" } | { state: "chosen"; language: Language };

export class LanguageScene {
  private phase: "fadeOut" | "fadeIn" | "choosing" = "fadeOut";
  private fade: Fade;
  private buttonWasDown = true; // the click that ended the intro must be released first

  // `screen` is the intro's screen, so the title fades out before the picture is replaced.
  constructor(
    private readonly disk: Uint8Array,
    readonly screen: Screen,
  ) {
    this.fade = new Fade(screen.palette, blackPalette());
  }

  get pointerVisible(): boolean {
    return this.phase !== "fadeOut";
  }

  update(input: Input): LanguageResult {
    const pressed = input.leftButton && !this.buttonWasDown;
    this.buttonWasDown = input.leftButton;

    if (this.phase === "fadeOut") {
      if (this.fade.tick()) {
        const target = new Screen();
        decodePicture(this.disk, PICTURES.language, target);
        this.screen.pixels.set(target.pixels);
        this.screen.palette = blackPalette();
        this.fade = new Fade(this.screen.palette, clonePalette(target.palette));
        this.phase = "fadeIn";
      }
      return { state: "running" };
    }

    if (this.phase === "fadeIn") {
      if (this.fade.tick()) this.phase = "choosing";
      return { state: "running" };
    }

    if (pressed) return { state: "chosen", language: languageAt(input.pointerY) };
    return { state: "running" };
  }
}
