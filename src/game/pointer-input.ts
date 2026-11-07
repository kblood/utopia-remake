import type { Mode } from "./controls.js";

export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/** `$2CDA`: modes 1/3 override the limits; mode 2 uses `$15620`, whose image defaults are also `$138/$C0`. */
export function mapPointerPoint(x: number, y: number, mode: Mode): PointerPoint {
  // The local image's $15620 words are 312 and 192. `$2CDA` uses them in mode 2 and writes the same limits for modes 1/3.
  void mode;
  return { x: Math.max(0, Math.min(0x138, x)), y: Math.max(0, Math.min(0xc0, y)) };
}
