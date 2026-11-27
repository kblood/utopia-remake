// Palette fades as the original boot stage does them (Disk.1 trace, notes/formats/graphics-and-music-blocks.md, "Palette fades").
//
// The boot code keeps three palette arrays: the working copy `$7910A` (32 OCS words, 0x0RGB with 4 bits per channel), the target
// `$71D98` that a fade-in reads through the pointer at `$7918A`, and the COLOR registers at `$DFF180`. A fade is 15 steps, each
// taken after 3 VBL waits (44 VBLs in all when the first wait is already pending, see `Fade`). A step visits the 32 entries in order:
//   - fade in (`$78D54`): an entry whose working word equals its target word is skipped (no write). Otherwise each channel that
//     differs moves ONE level up (`addq #1`, `addi #$10`, `addi #$100`), and the new word is written to the working copy and to the
//     COLOR register. The working copy is cleared when the fade starts (`clr.w (a0)+`); the COLOR registers are not touched.
//   - fade out (`$78CEC`): an entry whose working word is zero is skipped. Otherwise each non-zero channel moves ONE level down
//     (`subq #1`, `subi #$10`, `subi #$100`), and the new word is written to the working copy and to the COLOR register.
// Other COLOR writes: `$789E6` copies a palette into the working copy AND the COLOR registers (no arithmetic); `clr.w $dff180`
// (`$789B6`) writes COLOR00 alone and leaves the working copy as it is.
//
// Display: a COLOR register value shows as n * 17 per channel (`ocsColor`, the picture decoder's mapping). Canvas cannot show the
// register writes one at a time inside a frame, but every step's writes land in the blanking period before the display starts
// (static estimate, notes), so the frame shows the register file after the step. `PaletteFader` writes the same display entries at
// the same points as the original writes registers, so a skipped entry keeps its previous colour exactly as the register does.

import { ocsColor, PALETTE_SIZE, type Rgb, type Screen } from "./screen.js";

export const FADE_STEPS = 15;
export const FADE_FRAMES_PER_STEP = 3;
export const COLOR_COUNT = PALETTE_SIZE;

export type Palette = Rgb[];
export type OcsPalette = Uint16Array; // COLOR_COUNT words, 0x0RGB

const CHANNEL_SHIFTS = [0, 4, 8] as const; // blue, green, red: the low nibble is blue

export function clonePalette(palette: Palette): Palette {
  return palette.map(([r, g, b]) => [r, g, b] as Rgb);
}

export function blackPalette(): Palette {
  return Array.from({ length: PALETTE_SIZE }, () => [0, 0, 0] as Rgb);
}

// The OCS words of a palette whose channels are all `n * 17` (the only values `ocsColor` produces). Throws otherwise.
export function ocsPalette(palette: Palette): OcsPalette {
  const words = new Uint16Array(COLOR_COUNT);
  for (let i = 0; i < COLOR_COUNT; i++) {
    const [r, g, b] = palette[i];
    if (r % 17 !== 0 || g % 17 !== 0 || b % 17 !== 0 || r > 255 || g > 255 || b > 255) {
      throw new Error(`ocsPalette: entry ${i} (${r},${g},${b}) is not a 4-bit colour`);
    }
    words[i] = ((r / 17) << 8) | ((g / 17) << 4) | (b / 17);
  }
  return words;
}

/**
 * The boot code's palette state for one screen: the working copy, the target and the COLOR registers. The registers are the
 * screen's palette (`screen.palette`), so every register write is a display change. Scenes share the screen, not the fader:
 * a new fader starts from the registers, and the registers equal the working copy at each scene boundary (every fade ends
 * with them equal, and a scene starts from the registers).
 */
export class PaletteFader {
  /** `$7910A`: the words the fades step. */
  readonly working: OcsPalette = new Uint16Array(COLOR_COUNT);
  /** `$71D98`: the words a fade-in steps towards. Scenes write it when a picture is decoded or a palette is copied. */
  readonly target: OcsPalette = new Uint16Array(COLOR_COUNT);

  constructor(private readonly screen: Screen) {
    this.working.set(ocsPalette(screen.palette));
  }

  /** `$789E6`: copies `words` into the working copy and into all 32 COLOR registers. */
  load(words: ArrayLike<number>): void {
    for (let i = 0; i < COLOR_COUNT; i++) {
      this.working[i] = words[i] & 0x0fff;
      this.writeRegister(i, words[i]);
    }
  }

  /** One COLOR register write (`move.w ..., $DFF180+2i`). The working copy is not changed. */
  writeRegister(index: number, word: number): void {
    this.screen.palette[index] = ocsColor(word & 0x0fff);
  }

  /** The first thing `$78D54` does: clears the working copy (32 words). The registers keep their values. */
  clearWorking(): void {
    this.working.fill(0);
  }

  /** One step of `$78D54`: moves every entry that differs from its target one level towards it. */
  stepIn(): void {
    for (let i = 0; i < COLOR_COUNT; i++) {
      const word = this.working[i];
      const target = this.target[i];
      if (word === target) continue;
      let next = word;
      for (const shift of CHANNEL_SHIFTS) {
        const have = (word >> shift) & 15;
        const want = (target >> shift) & 15;
        if (have === want) continue;
        if (have > want) throw new Error(`fade in: entry ${i} would move away from its target`);
        next += 1 << shift;
      }
      this.working[i] = next;
      this.writeRegister(i, next);
    }
  }

  /** One step of `$78CEC`: moves every non-zero channel one level towards black. Zero entries are skipped. */
  stepOut(): void {
    for (let i = 0; i < COLOR_COUNT; i++) {
      const word = this.working[i];
      if (word === 0) continue;
      let next = word;
      for (const shift of CHANNEL_SHIFTS) {
        if ((word >> shift) & 15) next -= 1 << shift;
      }
      this.working[i] = next;
      this.writeRegister(i, next);
    }
  }
}

/**
 * Runs one complete fade over frames. `fade-in` clears the working copy when it is created (the start of `$78D54`).
 * `firstWaitPending`: the VBL flag (`$79556` bit 0) was already set when the fade began, because a long operation ran after the
 * last wait (see notes/formats/graphics-and-music-blocks.md, "Fade timing"). The first wait then returns at once, so the first
 * step comes after two frames and the fade lasts 44, not 45. Only the caller knows this (the trace decides, not the code).
 */
export class Fade {
  private frames: number;
  private steps = 0;

  constructor(
    private readonly fader: PaletteFader,
    private readonly direction: "in" | "out",
    firstWaitPending = false,
  ) {
    if (direction === "in") fader.clearWorking();
    this.frames = firstWaitPending ? 1 : 0; // a pending first wait is already one frame of the three
  }

  // Call `tick()` once per video frame; it returns true when the last step has been taken.
  tick(): boolean {
    if (this.steps >= FADE_STEPS) return true;
    if (++this.frames < FADE_FRAMES_PER_STEP) return false;
    this.frames = 0;
    if (this.direction === "in") this.fader.stepIn();
    else this.fader.stepOut();
    return ++this.steps >= FADE_STEPS;
  }
}
