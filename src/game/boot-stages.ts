// Boot stages after the language choice: the traced steps B to G of the boot stage (notes/formats/text.md, "Language screen and
// what follows"; notes/formats/graphics-and-music-blocks.md). Steps A (the language fade-out) belong to `LanguageScene`.
//
// Timing model: each `yield` in the sequence below is one vertical blank. The stage resumes in the update after it, so a
// count of updates is the original's count of VBL waits. The code between two waits runs in the update that resumes, as the
// original's code runs between two VBLs. Fades are 15 steps of 3 VBLs (`$78CEC` / `$78D54`). A fade whose first wait is already
// pending (the VBL flag was set by a long operation just before it: a picture or block decode, or a clear and a blit) takes 44
// VBLs: `fadeIn(true)` / `fadeOut(true)` below, one per such start (notes/formats/graphics-and-music-blocks.md, "Fade timing").
// Typed text waits 2 VBLs per character while bit 4 of `$79556` is set (`$78AB8`); a button down during a wait ends it after one
// VBL. The slide hold (`$78BB8` with d7 = $78) is 121 checks, as in the credit roll (intro.ts).
//
// Not reproduced: the loads (`$77F84`) and the unpack time, which the original does not trace. They take no updates here, so
// the message in step B does not stay up for the load time. The pointer is never shown (the boot sprite is off, text.md).
//
// Step E (the code check) is reproduced as the WHDLoad 1.2 slave runs it: the slave writes `bra` over the compare branch at
// `$78856` (`move.w #$6022,$78856`, Utopia.Slave, the path for CRC $D9C1 that this profile recognises) and NOPs the empty-entry
// test at `$78C70`. So the typed number is shown but never compared, and Return (or keypad Enter) is accepted with no digits.
// No answer key is derived from the manual (text.md, the code-check note): the original's compare is not reproduced.

import { FADE_FRAMES_PER_STEP, FADE_STEPS, ocsPalette, PaletteFader, type Palette } from "../gfx/fade.js";
import { Screen, SCREEN_WIDTH } from "../gfx/screen.js";
import { decodePicture, PICTURES, SECTOR_SIZE } from "../data/picture.js";
import { drawText, getString } from "../data/text.js";
import { unpackLz } from "../data/unpack.js";
import { isEnterKey, type Input, typedDigit } from "./intro.js";

const PLANES = 5;
const TEXT_COLOUR = 1; // `$79557` is 1 in the image and never written by the boot code
const LINE_ADVANCE = 9; // newline: the next line starts 9 rows down (`$78B9C`, $168 = 9 rows of 40 bytes)

// Image layouts of the picture blocks, as blitted by `$790BE` (5 planes stored one after the other, rows of whole bytes).
interface BlockLayout {
  first: number; // sector range on Disk.1 (inclusive)
  last: number;
  frames: number;
  rows: number;
  bytes: number; // bytes per row
  x: number; // blit origin (x is taken to whole bytes)
  y: number;
}

// `$60`-`$DC`: block A, 35 frames of 64 x 64 (the code-check picture, `$7879C`).
const BLOCK_A: BlockLayout = { first: 0x60, last: 0xdc, frames: 35, rows: 64, bytes: 8, x: 0x80, y: 0x36 };
// `$DD`-`$14B`: block B, 22 frames of 88 x 79 (the slide show, `$788CE`).
const BLOCK_B: BlockLayout = { first: 0xdd, last: 0x14b, frames: 22, rows: 79, bytes: 11, x: 0x74, y: 0x1e };

// The slide table at `$7956C` (29 pairs of words: frame index, string number; `$FFFF` follows). Disk.1 file offset = RAM - $74F18
// (the slave loads Disk.1 offset $3000 to $77F18).
const RAM_TO_FILE = 0x74f18;
const SLIDE_TABLE = 0x7956c - RAM_TO_FILE;
const SLIDE_COUNT = 29;
const HOLD_CHECKS = 0x79; // 121 (dbra with d7 = $78): the slide hold, one check per VBL

// Text positions (pixels; the blit is byte aligned, the text is not).
const MESSAGE_B = { string: 40, x: 130, y: 96 }; // LOADING...
const MESSAGE_G = { string: 41, x: 85, y: 114 }; // EXPANSION MEMORY DETECTED. (when `$904` is not zero)
const PROMPTS = [
  { string: 38, x: 32, y: 140 },
  { string: 39, x: 32, y: 158 },
];
const CAPTION_X = 20;
const CAPTION_Y = 140;
const FIELD = { x: 150, y: 182, rows: 7, bytes: 5 }; // typed number: the erase covers plane 0 only (`$78A00`)
const FIELD_MAX_DIGITS = 2;

// Master volume of the module (command 4): 62 down to 0 in steps, 3 VBLs each (`$78966`); 64 is unchanged.
const VOLUME_FULL = 64;
const VOLUME_START = 62;
const VOLUME_STEP_CHECKS = 3;

export type BootPhase = "B" | "C" | "D" | "E" | "F" | "slide" | "G" | "done";

/**
 * Audio the boot stages drive in step G (the module's master volume and stop). The module itself is started by `Game` at the
 * credit roll, before these stages (`$78614`-`$78654`); these stages never start it.
 */
export interface BootAudio {
  setVolume(volume: number): void;
  stop(): void;
}

export interface BootOptions {
  /**
   * `$904` is not zero: the message in step G reads "EXPANSION MEMORY DETECTED." The boot code never writes `$904`; the WHDLoad
   * 1.2 slave writes `$00080000` there before it starts the boot stage (Utopia.Slave, the CRC $D9C1 path), so the profile sets it.
   */
  expansionMemory: boolean;
  audio: BootAudio | null;
}

/** Thrown inside the sequence when the right button leaves the slide show (`$78BDC` / `$78932`). */
class LeaveShow {}

type Buttons = { left: boolean; right: boolean };
const NO_BUTTONS: Buttons = { left: false, right: false };

function word(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

// Blits one frame (the plane-by-plane copy of `$790BE`) onto the screen.
function blitFrame(screen: Screen, data: Uint8Array, layout: BlockLayout, frame: number): void {
  const planeBytes = layout.rows * layout.bytes;
  const base = frame * PLANES * planeBytes;
  const left = (layout.x >> 3) << 3;
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.bytes; col++) {
      for (let bit = 0; bit < 8; bit++) {
        let index = 0;
        for (let plane = 0; plane < PLANES; plane++) {
          index |= ((data[base + plane * planeBytes + row * layout.bytes + col] >> (7 - bit)) & 1) << plane;
        }
        screen.set(left + col * 8 + bit, layout.y + row, index);
      }
    }
  }
}

export class BootStages {
  readonly screen: Screen;
  private readonly blockA: Uint8Array;
  private readonly blockB: Uint8Array;
  private readonly titlePalette: Palette;
  // The boot palette state (`$7910A` working copy, `$71D98` target, COLOR registers = `screen.palette`); see gfx/fade.ts. The target
  // starts as the language picture's palette and is replaced by the title's.
  private readonly fader: PaletteFader;
  private input: Input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0 };
  private checks = 0; // update counter (VBLs seen), the cosmetic source of the code-check picture index
  // Bit 4 (typing) of `$79556` is set in the image at `$10` and stays set until step E clears it (`$787C4`).
  private typing = true;
  // Bit 5 of `$79556`: set while a slide is shown; a right button then leaves the show.
  private inShow = false;
  private phase: BootPhase = "B";
  private slide = -1;
  private digits: string[] = [];
  private keys: string[] = [];
  private finished = false;
  private readonly run: Generator<void, void, void>;

  constructor(
    private readonly disk: Uint8Array,
    private readonly language: number,
    screen: Screen,
    languagePicture: Palette,
    private readonly options: BootOptions,
  ) {
    this.screen = screen;
    // The registers hold black here (the language fade-out ended), so the fader starts from black too.
    this.fader = new PaletteFader(screen);
    this.fader.target.set(ocsPalette(languagePicture));
    // Decoded up front so a damaged block fails at the language choice, not in the middle of the sequence.
    this.blockA = unpackLz(disk.subarray(BLOCK_A.first * SECTOR_SIZE, (BLOCK_A.last + 1) * SECTOR_SIZE));
    this.blockB = unpackLz(disk.subarray(BLOCK_B.first * SECTOR_SIZE, (BLOCK_B.last + 1) * SECTOR_SIZE));
    this.titlePalette = decodePicture(disk, PICTURES.title).palette;
    this.run = this.sequence();
  }

  /** The current step: B, C, D, E, F (slide show), G, or done. Read-only, for the caller and the tests. */
  get currentPhase(): BootPhase {
    return this.phase;
  }

  /** The slide being shown (0-based), or -1 before the first slide. */
  get slideIndex(): number {
    return this.slide;
  }

  /** The number typed in step E (digits only, no placeholder). */
  get typedNumber(): string {
    return this.digits.join("");
  }

  /** Runs the sequence to its first wait. Call once, in the update that ends the language fade-out. */
  start(): void {
    this.run.next();
  }

  /** One update (one VBL). Returns "done" once the final fade-out has ended; later calls return "done" too. */
  update(input: Input): "running" | "done" {
    if (this.finished) return "done";
    this.input = input;
    // The keys belong to this update only: they are taken from the shared list, as map.ts does (`splice(0)`). The list is never
    // cleared by the caller, so unread keys would otherwise be read again in every later update.
    this.keys = input.keys?.splice(0) ?? [];
    this.checks++;
    const step = this.run.next();
    if (step.done) {
      this.finished = true;
      return "done";
    }
    return "running";
  }

  private *sequence(): Generator<void, void, void> {
    // B (`$7875C`): LOADING..., typed, then the language palette's fade-in.
    this.phase = "B";
    yield* this.message(MESSAGE_B.string, MESSAGE_B.x, MESSAGE_B.y);

    // C (`$78760`-`$78794`): block A is loaded and unpacked, the title palette is copied to the target. No time is traced.
    this.phase = "C";
    this.fader.target.set(ocsPalette(this.titlePalette));

    // D (`$78798`): fade out. Block A was decoded just before (`$78780`): the first wait is pending.
    this.phase = "D";
    yield* this.fadeOut(true);

    // E (`$7879C`): the code check. Its end is the success path `$7887A`.
    this.phase = "E";
    yield* this.check();

    // F (`$7887A`): fade out, LOADING... again, block B loaded (no time), title palette copied, fade out.
    this.phase = "F";
    this.typing = true; // `bset #4` at `$7887A`
    this.inShow = false;
    yield* this.fadeOut();
    yield* this.message(MESSAGE_B.string, MESSAGE_B.x, MESSAGE_B.y);
    this.fader.target.set(ocsPalette(this.titlePalette));
    // Block B was decoded just before this fade-out (`$788B2`, then the palette copy): the first wait is pending.
    yield* this.fadeOut(true);

    // The slide show (`$788CE`-`$78944`).
    this.phase = "slide";
    yield* this.slides();

    // G (`$78950`): LOADING... again, then the expansion line for `$904`, the module's fade (`$78966`), audio off, the final
    // fade-out, and the jump to the game proper (`$789A4`).
    this.phase = "G";
    yield* this.message(MESSAGE_B.string, MESSAGE_B.x, MESSAGE_B.y);
    if (this.options.expansionMemory) {
      yield* this.typeText(getString(this.disk, this.language, MESSAGE_G.string), MESSAGE_G.x, MESSAGE_G.y);
    }
    for (let volume = VOLUME_START; volume >= 0; volume--) {
      this.options.audio?.setVolume(volume / VOLUME_FULL);
      yield* this.waitChecks(VOLUME_STEP_CHECKS);
    }
    // `$7897E`-`$78986`: the module tick stops and the audio DMA is switched off (silence). The master volume is restored
    // so that the next track the player loads is at full level.
    this.options.audio?.stop();
    this.options.audio?.setVolume(1);
    yield* this.fadeOut();

    this.phase = "done";
  }

  // Step E. Keys are read once per update after the poll starts (`$78BFC`); the poll starts in the update that ends the fade-in,
  // so keys latched before it are dropped (the first poll clears `$79108`). Typed digits are shown and never compared.
  private *check(): Generator<void, void, void> {
    this.typing = false; // `bclr #4` at `$787C4`: the prompts are not typed
    this.screen.clear(0);
    this.fader.target[0] = 0; // `clr.w $71D98` (`$787BE`); the COLOR registers are not written here
    for (const prompt of PROMPTS) {
      yield* this.typeText(getString(this.disk, this.language, prompt.string), prompt.x, prompt.y);
    }
    blitFrame(this.screen, this.blockA, BLOCK_A, (this.checks & 0xff) >> 3);
    // The clear (`$78caa`, at least 100,000 clocks on the 68000 bus floor) and the blit of the block A frame (`$790BE`, at least
    // 60,000) precede this fade-in: together at least 160,000 clocks, longer than one VBL interval (at most 142,102), so an edge
    // falls in them and the first wait is pending (static bus-floor bound; notes, "Fade timing").
    yield* this.fadeIn(true);

    this.digits = [];
    this.drawField(true);
    for (;;) {
      yield;
      for (const key of this.keys) {
        if (isEnterKey(key)) {
          // Return (raw $44) or keypad Enter (raw $43). The WHDLoad-patched code accepts it with no digit typed.
          this.drawField(false);
          return;
        }
        if (key === "Backspace") {
          if (this.digits.length > 0) {
            this.digits.pop();
            this.drawField(true);
          }
        } else if (typedDigit(key) !== undefined && this.digits.length < FIELD_MAX_DIGITS) {
          this.digits.push(typedDigit(key)!);
          this.drawField(true);
        }
      }
    }
  }

  // The typed number: the field is erased in plane 0 and the digits are drawn again. The dash after the digits is the cursor.
  private drawField(cursor: boolean): void {
    for (let row = 0; row < FIELD.rows; row++) {
      for (let x = FIELD.x & ~7; x < (FIELD.x & ~7) + FIELD.bytes * 8; x++) {
        this.screen.pixels[(FIELD.y + row) * SCREEN_WIDTH + x] &= ~1;
      }
    }
    drawText(this.disk, this.screen, new TextEncoder().encode(this.digits.join("") + (cursor ? "-" : "")), FIELD.x, FIELD.y, TEXT_COLOUR);
  }

  // The slide show (`$788CE`-`$78944`): 29 slides, each cleared, drawn, faded in, captioned, held and faded out. A left button
  // ends a hold early (next slide); a right button leaves the show (after a fade-out of the current slide).
  private *slides(): Generator<void, void, void> {
    try {
      for (let slide = 0; slide < SLIDE_COUNT; slide++) {
        this.slide = slide;
        const frame = word(this.disk, SLIDE_TABLE + 4 * slide);
        const string = word(this.disk, SLIDE_TABLE + 4 * slide + 2);
        this.screen.clear(0);
        blitFrame(this.screen, this.blockB, BLOCK_B, frame);
        // The clear and the blit of the frame precede the fade-in (static bus-floor bound: at least 197,960 clocks, as for the
        // code check): pending.
        yield* this.fadeIn(true);
        this.inShow = true;
        yield* this.typeText(getString(this.disk, this.language, string), CAPTION_X, CAPTION_Y);
        yield* this.waitChecks(HOLD_CHECKS);
        yield* this.fadeOut();
      }
    } catch (error) {
      if (!(error instanceof LeaveShow)) throw error;
      yield* this.fadeOut(); // `$78944`
    }
    this.inShow = false; // `$78948`
  }

  // A message on a cleared screen (`$789AC`): typed, then faded in towards the target palette.
  private *message(index: number, x: number, y: number): Generator<void, void, void> {
    this.screen.clear(0);
    this.fader.writeRegister(0, 0); // `clr.w $dff180` (`$789B6`): COLOR00 alone, the working copy is not touched
    this.fader.target[0] = 0; // `clr.w $71d98` (`$789BC`)
    yield* this.typeText(getString(this.disk, this.language, index), x, y);
    yield* this.fadeIn();
  }

  // The palette fades (`$78D54` in, `$78CEC` out): 15 steps, the step after each 3 VBLs. A fade-in clears the working copy first.
  // `firstWaitPending`: the VBL flag was already set when the fade began (see the header and gfx/fade.ts `Fade`).
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

  // Text (`$78A48`, `$78AB8`): with bit 4 set, each character waits 2 VBLs before it is drawn (a newline does not wait).
  private *typeText(text: Uint8Array, x: number, y: number): Generator<void, void, void> {
    let cx = x;
    let cy = y;
    for (const raw of text) {
      if (raw & 0x80) {
        cx = x;
        cy += LINE_ADVANCE;
        continue;
      }
      if (this.typing) yield* this.waitChecks(2);
      cx = drawText(this.disk, this.screen, Uint8Array.of(raw), cx, cy, TEXT_COLOUR);
    }
  }

  // The wait routine (`$78BB8`): up to `checks` VBLs, ended early by any button. A right button in the show leaves it.
  private *waitChecks(checks: number): Generator<void, Buttons, void> {
    for (let i = 0; i < checks; i++) {
      yield;
      const buttons = this.buttons();
      if (buttons.left || buttons.right) {
        if (buttons.right && this.inShow) throw new LeaveShow();
        return buttons;
      }
    }
    return NO_BUTTONS;
  }

  private buttons(): Buttons {
    return { left: this.input.leftButton, right: this.input.rightButton };
  }
}
