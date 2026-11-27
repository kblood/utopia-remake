// Title screen: the pre-roll (logo, then title) and the looping credit roll. Runs at 50 Hz (one update per video frame).
// Timing and drawing follow the original boot code; see notes/formats/text.md ("Credit roll") and
// notes/formats/graphics-and-music-blocks.md ("Boot-stage sequence"). Traced pre-roll, one update per VBL:
//   - logo picture (`$729`-`$733`) fades in from black: 15 steps of 3 VBLs (`$785C4`, `$78D54`); the logo decode (`$785A6`)
//     runs just before it and leaves the VBL flag pending, so the first wait is already over and the fade takes 44 VBLs;
//   - logo holds for 51 VBLs (`$785C8`, `$78BB8` with d7 = $32); a button ends the hold early, and the result is ignored;
//   - logo fades out: 45 VBLs (`$785CE`, `$78CEC`); the title picture (`$70A`-`$728`) decodes over it in that same update;
//   - title fades in: 44 VBLs (`$78610`), pending like the logo fade-in: its decode (`$785F2`) runs just before it;
//   - track 3 starts in the update that ends the title fade-in (`$78614`-`$78654`, no VBL wait traced); then the roll loop
//     starts (`$78662`). Track 3 is decoded (`$78634`) before the roll loop, so the first wait of the roll's first character is
//     pending too: that character is drawn in the roll's first update, one VBL earlier than the later characters (`$78A48`).
//     Evidence and limits: notes/formats/graphics-and-music-blocks.md, "Fade timing".
// The fades and the logo fade-out read no buttons. Only the logo hold ends early on a button, and only the roll reads a click.

import { decodePicture, PICTURES } from "../data/picture.js";
import { drawText, getString } from "../data/text.js";
import { COLOR_COUNT, FADE_FRAMES_PER_STEP, FADE_STEPS, ocsPalette, PaletteFader } from "../gfx/fade.js";
import { Screen } from "../gfx/screen.js";

const CREDIT_LIST = 0x4644; // word list of string indices, ends with a negative word
const TEXT_X = 0x30;
const TEXT_Y = 0xb4;
const TEXT_COLOR = 1;
const CLEAR_X = 0x28;
const CLEAR_WIDTH_BYTES = 0x1f;
const TEXT_ROWS = 7;
const CHAR_DELAY_FRAMES = 2;
// The roll's first character: its first wait is already over (the module decode precedes it), so it takes one update less.
const FIRST_CHAR_DELAY_FRAMES = CHAR_DELAY_FRAMES - 1;
const HOLD_FRAMES = 0x79;
const LOGO_HOLD_CHECKS = 0x33; // 51: `moveq #$32,d7` at `$785C8` with `dbra`, which runs d7 + 1 times; one check per VBL

export interface Input {
  leftButton: boolean;
  rightButton: boolean;
  pointerX: number; // screen pixels, 0-319
  pointerY: number; // screen rows, 0-199
  // KeyboardEvent.key values pressed since the last update, in order (consumed by the scene), with key releases
  // interleaved as `keyUpToken(key)` strings. Releases are not presses: scenes that look for a key name ignore them.
  keys?: string[];
}

/** Prefix of a key-release entry in `Input.keys` (see `keyUpToken`). No KeyboardEvent.key value starts with it. */
export const KEY_UP_PREFIX = "keyup:";

/**
 * The `Input.keys` entry for the release of `key`. In the original, the keyboard handler (`$2BC2`) stores every decoded byte in the
 * one cell `$161A0`, releases included, so a release overwrites a pending key (notes/formats/game-proper.md, Keyboard). The release
 * byte's encoding (bit 7 set) is the Amiga raw-key convention (external HRM; the image's `not.b`/`ror.b #1` decode puts the up/down bit
 * in bit 7). It is not read from the image itself, and no game handler tests bit 7 of the cell.
 */
export function keyUpToken(key: string): string {
  return KEY_UP_PREFIX + key;
}

export function isKeyUpToken(entry: string): boolean {
  return entry.startsWith(KEY_UP_PREFIX);
}

/** Prefix of a numeric-keypad digit entry in `Input.keys` (see `keypadToken`). No KeyboardEvent.key value starts with it. */
export const KEYPAD_PREFIX = "keypad:";

/**
 * The `Input.keys` entry for a digit typed on the numeric keypad (`KeyboardEvent.code` `Numpad0`-`Numpad9`). The original's count
 * entry accepts keypad digits: its key table `$650A` maps raw `$0F`, `$1D`-`$1F`, `$2D`-`$2F`, `$3D`-`$3F` to 0-9 (STATIC, Disk.1).
 * The key dispatcher `$15B4A` places a pin only for raw `$01`-`$08` (the top row 1-8; `cmpi.b #$8` / `bgt` at `$15C42`), so a keypad digit
 * is a digit to the entries and not a pin key. Hence the separate token.
 */
export function keypadToken(digit: string): string {
  return KEYPAD_PREFIX + digit;
}

export function isKeypadToken(entry: string): boolean {
  return entry.startsWith(KEYPAD_PREFIX);
}

/** The digit an entry types: "0"-"9" from the top row, or a keypad token; undefined for any other entry (names, releases). */
export function typedDigit(entry: string): string | undefined {
  const digit = isKeypadToken(entry) ? entry.slice(KEYPAD_PREFIX.length) : entry;
  return /^[0-9]$/.test(digit) ? digit : undefined;
}

/**
 * The `Input.keys` entry for the numeric keypad's Enter (`KeyboardEvent.code` `NumpadEnter`). The save name step's prompt ignores it:
 * its loop tests only Return (`$8958`, `cmpi.b #$44`), while the entries accept both `$44` and keypad `$43` (`$5110`, static Disk.1).
 */
export const KEYPAD_ENTER_TOKEN = keypadToken("Enter");

/** Return or keypad Enter: the two keys the entries accept (`$5110` tests `$44` and `$43`). The main Return key alone is `"Enter"`. */
export function isEnterKey(entry: string): boolean {
  return entry === "Enter" || entry === KEYPAD_ENTER_TOKEN;
}

export type IntroResult = "running" | "clicked";

/** The pre-roll stages, then the roll. */
export type IntroStage = "logo-in" | "logo-hold" | "logo-out" | "title-in" | "roll";

export interface IntroOptions {
  /**
   * Starts track 3 (the boot module). Called once, in the update that ends the title fade-in, before the roll's first update
   * (`$78614`-`$78654`). The boot code starts the module there; the remake's music is owned by `Game`.
   */
  startModule?: () => void;
}

export class IntroScene {
  readonly screen = new Screen();
  private readonly credits: number[] = [];
  private creditIndex = 0;
  private text: Uint8Array = new Uint8Array(0);
  private shown = 0;
  private wait = 0;
  private phase: "typing" | "holding" = "typing";
  private step: IntroStage = "logo-in";
  // The boot palette state (`$7910A` working copy, `$71D98` target, COLOR registers = `screen.palette`); see gfx/fade.ts.
  private readonly fader: PaletteFader;
  private input: Input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0 };
  private readonly preroll: Generator<void, void, void>;

  constructor(
    private readonly disk: Uint8Array,
    private readonly options: IntroOptions = {},
  ) {
    this.fader = new PaletteFader(this.screen);
    // The logo is decoded off-screen: its 32 palette words are the fade target (`$71D98`), not the display, which stays black.
    const logo = decodePicture(disk, PICTURES.presents);
    this.screen.pixels.set(logo.pixels);
    this.fader.target.set(ocsPalette(logo.palette));
    for (let at = CREDIT_LIST; ; at += 2) {
      const word = (disk[at] << 8) | disk[at + 1];
      if (word & 0x8000) break;
      this.credits.push(word);
    }
    this.startString();
    this.preroll = this.prerollSequence();
    this.preroll.next(); // runs to the first VBL wait; the first update resumes it (no VBL is consumed here)
  }

  /** Characters of the current credit line drawn so far (test and status access; read-only). */
  get charactersShown(): number {
    return this.shown;
  }

  /** True once the current line is fully typed and the roll is holding it (read-only). */
  get holding(): boolean {
    return this.phase === "holding";
  }

  /** The pre-roll stage, or "roll" once the roll is running (read-only). */
  get stage(): IntroStage {
    return this.step;
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
    this.input = input;
    if (this.step !== "roll") {
      this.preroll.next();
      return "running";
    }
    // Either button counts: the original wait routine ($78BB8) returns on any button bit (left = bit 0, right = bit 1)
    // and its callers treat any non-zero result as a click during the hold.
    const button = input.leftButton || input.rightButton;
    if (this.phase === "typing") {
      // A character waits two VBLs; a held button makes that wait return after one frame (one character per frame).
      if (!button && this.wait > 0) {
        this.wait--;
        if (this.wait > 0) return "running";
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

    if (button) return "clicked";
    if (--this.wait > 0) return "running";

    this.clearText();
    this.creditIndex = (this.creditIndex + 1) % this.credits.length;
    this.startString();
    return "running";
  }

  // The pre-roll (`$78550`-`$78662`). Each `yield` is one VBL; the code between two yields runs in the update that resumes.
  private *prerollSequence(): Generator<void, void, void> {
    // `$785B0`: `$789E6` loads black into the working copy and the registers before the logo fade-in. The logo was decoded
    // just before (`$785A6`), so the flag is pending (see the header).
    this.step = "logo-in";
    this.fader.load(new Uint16Array(COLOR_COUNT));
    yield* this.fadeIn(true);

    this.step = "logo-hold";
    yield* this.holdChecks(LOGO_HOLD_CHECKS);

    this.step = "logo-out";
    yield* this.fadeOut();

    // `$785D2`-`$785F6`: the title decodes over the logo (off-screen palette, so the registers stay black), then `$789E6` loads black.
    const title = decodePicture(this.disk, PICTURES.title);
    this.screen.pixels.set(title.pixels);
    this.fader.target.set(ocsPalette(title.palette));
    this.fader.load(new Uint16Array(COLOR_COUNT));
    this.step = "title-in";
    yield* this.fadeIn(true);

    // `$78614`-`$78654`: track 3 starts with no VBL wait before the roll loop (`$78662`). Its decode (`$78634`) left the flag
    // pending, so the roll's first character is one update earlier (the typing branch of `update`).
    this.options.startModule?.();
    this.wait = FIRST_CHAR_DELAY_FRAMES;
    this.step = "roll";
  }

  // The palette fades (`$78D54` in, `$78CEC` out): 15 steps, each after 3 VBLs. A fade-in clears the working copy first and
  // leaves the registers as they are (see gfx/fade.ts). `firstWaitPending`: the flag was already set when the fade began, so its
  // first wait is over at once (the first step comes after two VBLs; see `Fade` in gfx/fade.ts).
  private *fadeIn(firstWaitPending = false): Generator<void, void, void> {
    this.fader.clearWorking();
    yield* this.fade("in", firstWaitPending);
  }

  private *fadeOut(firstWaitPending = false): Generator<void, void, void> {
    yield* this.fade("out", firstWaitPending);
  }

  private *fade(direction: "in" | "out", firstWaitPending = false): Generator<void, void, void> {
    for (let step = 0; step < FADE_STEPS; step++) {
      const waits = step === 0 && firstWaitPending ? FADE_FRAMES_PER_STEP - 1 : FADE_FRAMES_PER_STEP;
      for (let frame = 0; frame < waits; frame++) yield;
      if (direction === "in") this.fader.stepIn();
      else this.fader.stepOut();
    }
  }

  // The wait routine `$78BB8` as the logo hold uses it: one check per VBL, ended early by either button. The caller ignores the result.
  private *holdChecks(checks: number): Generator<void, void, void> {
    for (let i = 0; i < checks; i++) {
      yield;
      if (this.input.leftButton || this.input.rightButton) return;
    }
  }
}
