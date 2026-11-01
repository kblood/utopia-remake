// Palette fades as done by the original boot stage: 15 steps, one step every 3 video frames,
// each step moves every colour channel by one 4-bit level.

import { PALETTE_SIZE, Rgb } from "./screen.js";

export const FADE_STEPS = 15;
export const FADE_FRAMES_PER_STEP = 3;

const LEVEL = 17; // 8-bit value of one 4-bit level

export type Palette = Rgb[];

export function clonePalette(palette: Palette): Palette {
  return palette.map(([r, g, b]) => [r, g, b] as Rgb);
}

export function blackPalette(): Palette {
  return Array.from({ length: PALETTE_SIZE }, () => [0, 0, 0] as Rgb);
}

function stepChannel(value: number, target: number): number {
  if (value < target) return value + LEVEL;
  if (value > target) return value - LEVEL;
  return value;
}

// Moves `current` one level toward `target` (fade-in) or toward black (fade-out).
export function fadeStep(current: Palette, target: Palette): void {
  for (let i = 0; i < PALETTE_SIZE; i++) {
    for (let c = 0; c < 3; c++) {
      current[i][c] = stepChannel(current[i][c], target[i][c]);
    }
  }
}

// Runs a complete fade over frames. Call `tick()` once per video frame; it returns true when done.
export class Fade {
  private frames = 0;
  private steps = 0;

  constructor(
    private readonly palette: Palette,
    private readonly target: Palette,
  ) {}

  tick(): boolean {
    if (this.steps >= FADE_STEPS) return true;
    if (++this.frames < FADE_FRAMES_PER_STEP) return false;
    this.frames = 0;
    fadeStep(this.palette, this.target);
    return ++this.steps >= FADE_STEPS;
  }
}
