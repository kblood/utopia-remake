// Language selection screen: fade the title out, show the language picture, fade it in and
// then poll the left button. The pointer's vertical position picks the language (four bands,
// one per flag). After the choice the picture fades out (45 updates, `$78748` -> `$78758` ->
// `$78CEC`, no button read during it) and the scene returns the choice once; `Game` then starts
// the boot stages (`boot-stages.ts`: message, code check, slide show, final fade), and the boot
// disk menu opens when they end. Behaviour follows the original boot stage.
// The poll is level-triggered, as the original's `btst #6,$BFE001` / `bne` at $786F4 is:
// a left button that is already down when the fade-in ends chooses at once, with no release
// first.

import { decodePicture, PICTURES } from "../data/picture.js";
import { clonePalette, Fade, ocsPalette, PaletteFader, type Palette } from "../gfx/fade.js";
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
  private phase: "fadeOut" | "fadeIn" | "choosing" | "leaving" | "done" = "fadeOut";
  private readonly fader: PaletteFader;
  private fade: Fade;
  // Set by the poll update (the pointer row at that moment); the choice is returned only after the fade-out.
  private choice: Language | null = null;
  // The language picture's palette (the fade-out target after the picture is decoded): the boot stages start from it.
  private picture: Palette | null = null;

  // `screen` is the intro's screen, so the title fades out before the picture is replaced.
  constructor(
    private readonly disk: Uint8Array,
    readonly screen: Screen,
  ) {
    // The title's fade-out starts from the registers (the title fade-in left them equal to its working copy).
    this.fader = new PaletteFader(screen);
    this.fade = new Fade(this.fader, "out");
  }

  /** The language picture's palette (a copy), available once the picture is decoded (after the title fade-out). */
  get picturePalette(): Palette | null {
    return this.picture ? clonePalette(this.picture) : null;
  }

  /** The language chosen by the poll, or null before it. It is returned by `update` only when the fade-out has ended. */
  get chosenLanguage(): Language | null {
    return this.choice;
  }

  // The original pointer is hardware sprite 2. Sprite DMA is off through the whole boot stage up to the language poll: the boot init
  // clears DMACON (`$78EBE`, via `$78570`) and nothing sets SPREN again until `move.w #$8020,$DFF096` at `$786E4`, which runs after the
  // fade-in returns. The VBL handler builds the sprite only once bit 2 of `$79556` is set (`$786EC`), so the first visible frame is
  // the one after the update that ends the fade-in. Hidden during both fades (text.md, "Language screen"). `Game` reads this before
  // each update. Once a choice is made the boot sprite is off (`$78748` clears SPREN), so it is false after the choosing update and
  // through the fade-out.
  get pointerVisible(): boolean {
    return this.phase === "choosing";
  }

  update(input: Input): LanguageResult {
    if (this.phase === "fadeOut") {
      if (this.fade.tick()) {
        const target = new Screen();
        decodePicture(this.disk, PICTURES.language, target);
        this.picture = clonePalette(target.palette);
        this.screen.pixels.set(target.pixels);
        // The registers are black here (the title fade-out ended), and the picture's palette is the target (`$71D98`).
        this.fader.target.set(ocsPalette(target.palette));
        // The language picture is decoded just before the fade-in (`$786D0` before `$786E0`): the decode leaves the VBL flag
        // pending, so the first wait is over at once and the fade takes 44 updates (notes/formats/graphics-and-music-blocks.md).
        this.fade = new Fade(this.fader, "in", true);
        this.phase = "fadeIn";
      }
      return { state: "running" };
    }

    if (this.phase === "fadeIn") {
      if (!this.fade.tick()) return { state: "running" };
      // The traced fade (`$78D54`) returns after its last palette step and the poll (`$786F4`) follows in the same pass.
      this.phase = "choosing";
    }

    if (this.phase === "choosing") {
      // Level poll: the button being down at the poll chooses, whatever happened earlier (no edge is needed).
      // A button already down at the first poll (the update that ends the fade-in) passes straight through `$786F4` to `$78748`,
      // with no VBL in between, so the boot sprite never shows (text.md, "Pointer visibility").
      if (!input.leftButton) return { state: "running" };
      this.choice = languageAt(input.pointerY);
      // `$78758` runs `$78CEC`, the fade-out. It first waits for a VBL, so its first step is one update after the choice.
      this.phase = "leaving";
      this.fade = new Fade(this.fader, "out");
      return { state: "running" };
    }

    if (this.phase === "leaving") {
      // No button is read during the fade-out: presses and pointer moves in these updates have no effect.
      if (!this.fade.tick()) return { state: "running" };
      this.phase = "done";
      return { state: "chosen", language: this.choice! };
    }

    // Done: the choice was returned once. Later updates do nothing (the caller has moved on to the boot disk menu).
    return { state: "running" };
  }
}
