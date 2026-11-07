// Read-only drawable adapter for the active alien apparition: the single type-19 record at $144A8 that event 1
// ($1146A) creates and the pass worker animates ($35C8). Nothing here writes: it reads the record bytes out of a
// state and describes them as an `ObjectLayer` Drawable, nothing more. Drawing uses the existing `SpriteSet` masked
// blit and the existing clip of `ObjectLayer.blit`; the adapter itself never touches RNG, occupancy, the effect list
// or the animation word $144A4 (`Aliens.alienFrameStep` is the only thing that advances the frame).
//
// Evidence (notes/formats/map-rendering.md 7.2/7.3, game-state.md 3.8, sim-port.md "Alien events"):
//  - VERIFIED (static): the record is a common 7.2 entry: +0 type (19 = $13), +1 map x, +2 map y, +3/+4 signed pixel
//    dx/dy, +5 frame index into the descriptor's nine frame offsets. `$3694` places it at (pick-table x0 + dx,
//    pick-table y1 + dy) of its cell and `$3768`/`$3260` blit the 32 pixel wide frame upward from the bottom row.
//  - VERIFIED (static trace, no original pixel parity): the type-19 insertion block at `$3604` subtracts 13 from the y
//    anchor after `$3694`, so the alien's bottom row is `anchorY - 1 + dy - 13` (`ALIEN_ANCHOR_Y_ADJUST` in
//    objects.ts). Meteor and the other objects do not take this adjustment.
//    `$333A` writes the frame ($144AD) from table $11718 once per unpaused pass; the draw entry is built after that
//    and visibility never gates the animation.
//  - VERIFIED (static `$3694` trace): bytes +3/+4 are sign-extended and added to the pick-table x/y pixel anchors.
//    `$3694` receives +5 as its edge-rule selector; for type 19, frames 0..3 are visible at the last column with
//    frame 0 always admitted and frames 1..3 hidden only when dx > 0 or dy > 0. At the last row, frame 3 is hidden
//    when dy > 0; frames 0..2 are admitted. Other frame values follow the common traced rule, though active alien
//    animation uses only 0..3. The port writes zero offsets for a newly spawned alien, but restored state can supply them.
//  - VERIFIED (static trace, no pixel parity): the entry is inserted by `$333A` after the effect slots and before the
//    meteor, flags 0, and `$4860` sorts the whole list with a literal, unstable selection sort (draw-list.ts
//    `sortDrawList`), so its position among objects on the SAME cell is whatever that sort yields for the cell's ties.
//    The apparition is an admitted entry: it sorts, it never opens the redraw gate, and as a pick-list entry it is an
//    obstacle that no order can target (`ALIEN_REF`, objects.ts `pickables`).
//  - UNRESOLVED: artwork parity. The sprite frames are decoded from the player's Disk.1 sheet by the existing
//    decoder; no pixel comparison with the running original exists.

import type { Drawable } from "./objects.js";
import { ALIEN_SLOT } from "./disk4-scene.js";
import { s8 } from "./sim-math.js";

/** Object type byte of the alien record ($144A8 +0): sprite type 19. */
export const ALIEN_TYPE = 0x13;
/** The descriptor holds nine frame offsets; a frame byte outside 0..8 selects nothing. */
export const ALIEN_FRAME_SLOTS = 9;

/** The only capability the adapter needs: a byte read. A `GameState` satisfies it; nothing can be written through it. */
export interface ByteReader {
  byte(addr: number): number;
}

/**
 * The active apparition as a drawable, or null when none is drawn: the slot is free (type byte 0), holds another
 * type byte (only $13 is the traced alien; anything else is not interpreted), or its frame byte is outside the
 * descriptor's nine slots. Reads only $144A8..$144AD.
 */
export function readAlienApparition(state: ByteReader): Drawable | null {
  if (state.byte(ALIEN_SLOT) !== ALIEN_TYPE) return null;
  const frame = state.byte(ALIEN_SLOT + 5);
  if (frame >= ALIEN_FRAME_SLOTS) return null;
  return {
    type: ALIEN_TYPE,
    x: state.byte(ALIEN_SLOT + 1),
    y: state.byte(ALIEN_SLOT + 2),
    dx: s8(state.byte(ALIEN_SLOT + 3)),
    dy: s8(state.byte(ALIEN_SLOT + 4)),
    frame,
  };
}
