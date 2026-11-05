// The four warning lights and the "jump to event" view bookmark: main-loop duties of the original
// that live next to the simulation. Sources: $5D30 (draws the lights from the table at $15628),
// $9A22-$9A34 (daily countdown $144BD), $11432 (focus on a cell), $159CE-$159F8 and $5D70 (click
// on the second light swaps the view), light writers in $A0D4, $9E98, $9CDA. Notes:
// notes/formats/sim-port.md ("Main-loop duties").

import type { GameState } from "./state.js";

// Index of each light = (address - $15634) / 16: flag bytes $15634, $15644, $15654, $15664.
export const LIGHT = { power: 0, focus: 1, food: 2, air: 3 } as const;
export type LightName = keyof typeof LIGHT;

// Screen position of the 16 x 16 icons (word pairs at +8/+10 of the $15628 entries) and the click
// rectangle of the bookmark light (table $5D70: x $10-$1F, y $8B-$9B).
export const LIGHT_X = [0, 16, 32, 48] as const;
export const LIGHT_Y = 139;
export const LIGHT_SIZE = 16;
export const BOOKMARK_RECT = { x0: 0x10, x1: 0x1f, y0: 0x8b, y1: 0x9b } as const;

const FOCUS = { countdown: 0x144bd, markX: 0x144e8, markY: 0x144ea } as const;
const FOCUS_DAYS = 6; // $11460: move.b #6, $144BD
const MAX_X = 0x5c; // the view origin is limited to 100 - 8 and 75 - 8 cells
const MAX_Y = 0x43;

export class Alerts {
  // The flag bytes ($FF = lit). Not part of the saved state image (they sit above $14633).
  readonly flags = new Uint8Array(4);

  constructor(private readonly s: GameState) {}

  lit(light: number): boolean {
    return this.flags[light] !== 0;
  }

  set(light: number, on: boolean): void {
    this.flags[light] = on ? 0xff : 0;
  }

  // $11432: events that happen at a cell store a view origin 4 cells up and left of it (limited to
  // the map) at $144E8/$144EA, light the bookmark light and start a six day countdown. The view
  // itself does not move: the player clicks the light to jump there.
  focus(x: number, y: number): void {
    const s = this.s;
    s.setWord(FOCUS.markX, Math.min(MAX_X, Math.max(0, x - 4)));
    s.setWord(FOCUS.markY, Math.min(MAX_Y, Math.max(0, y - 4)));
    this.flags[LIGHT.focus] = 0xff;
    s.setByte(FOCUS.countdown, FOCUS_DAYS);
  }

  // $9A22: the daily countdown. `subq.b #1; bpl` keeps counting while the result is not negative;
  // when it goes below zero the counter and the light are cleared.
  daily(): void {
    const s = this.s;
    const left = (s.byte(FOCUS.countdown) - 1) & 0xff;
    if ((left & 0x80) === 0) {
      s.setByte(FOCUS.countdown, left);
      return;
    }
    s.setByte(FOCUS.countdown, 0);
    this.flags[LIGHT.focus] = 0;
  }

  // $159E6: a click inside BOOKMARK_RECT swaps the current view origin with the stored one. The
  // caller passes its own view origin (the map scene keeps it outside the state image) and
  // moves the view to the returned one.
  swapView(viewX: number, viewY: number): { x: number; y: number } {
    const s = this.s;
    const target = { x: s.word(FOCUS.markX), y: s.word(FOCUS.markY) };
    s.setWord(FOCUS.markX, viewX);
    s.setWord(FOCUS.markY, viewY);
    return target;
  }

  static hitsBookmark(px: number, py: number): boolean {
    return px >= BOOKMARK_RECT.x0 && px <= BOOKMARK_RECT.x1 && py >= BOOKMARK_RECT.y0 && py <= BOOKMARK_RECT.y1;
  }

  // $5D30, once per displayed frame and light: an unlit light sets its toggle byte (+$D) to $FF and
  // is skipped; a lit one inverts the byte and is drawn when the result is $FF, i.e. on every
  // second frame (the blink; on the Amiga the two screen buffers make it a 25 Hz flicker).
  private readonly toggle = [false, false, false, false];
  visible(light: number): boolean {
    if (!this.lit(light)) this.toggle[light] = true;
    this.toggle[light] = !this.toggle[light];
    return this.toggle[light];
  }
}
