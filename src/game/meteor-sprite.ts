// Read-only drawable adapter for the active meteor: the single type-21 record at $1449C that event 8 ($1160E) creates
// and the pass worker counts down ($3626). Nothing here writes: it reads the record bytes out of a state and describes
// them as an `ObjectLayer` Drawable, nothing more. Drawing uses the existing `SpriteSet` masked blit and the existing
// clip of `ObjectLayer.blit`; the adapter never touches RNG, occupancy, the effect list or the countdown
// (`Aliens.meteorStep` is the only thing that moves +6, and the layer never retains a meteor effect).
//
// Evidence (notes/formats/map-rendering.md 7.2, game-state.md 3.8, sim-port.md "Alien events"):
//  - VERIFIED (static Disk.1 trace, read-only; no original pixel parity): the record is a common 7.2 entry: +0 type
//    ($15 = 21), +1/+2 map x/y, +3/+4 signed pixel dx/dy, +5 descriptor frame index, +6 a signed byte that is BOTH the
//    countdown ($3626 subtracts 4 per unpaused pass, impact at 0) and the drawing lift; +7 is not read by the inspected
//    draw path. Creation ($1160E) writes +3..+7 = 0 and then +6 = $78 (the port: `Aliens.eventMeteor`).
//  - VERIFIED (static): type 21 has a 32 x 25 descriptor, 600-byte frames and frame offsets [0, 600, 0 x 7]; the
//    ordinary meteor frame is 0 and no countdown-driven animation was found.
//  - VERIFIED (static): for view cell (vx, vy) the bottom row is 38 + 8 * (vx + vy) + s8(+4) - s8(+6) and the left edge
//    112 + 16 * (vx - vy) + s8(+3). The entry is only added to the draw list when its anchor cell lies inside the
//    8 x 8 window; the ordinary edge-visibility rule takes (+5, +3, +4). Unlike the alien it has no extra y adjustment.
//  - UNRESOLVED: the original's control flow for a meteor while the game is PAUSED (an anomaly in the traced code:
//    which of the countdown / draw-entry steps run is not settled). This adapter simply reads whatever the record
//    holds at draw time and claims nothing about paused behaviour.
//  - VERIFIED (static): the x >= 224 clip is the shared per-pixel rule of `ObjectLayer.blit` (`spriteVisibleColumns`,
//    map-rendering.md 7.3), the same for every sprite type; it is no longer a meteor-specific mismatch.
//  - VERIFIED (static trace, no pixel parity): the entry is the last original source `$333A` inserts (after the
//    effect slots and the alien, flags 0) and `$4860` sorts the whole list with the literal unstable selection sort
//    (draw-list.ts `sortDrawList`); same-cell order is that sort's result. It never opens the redraw gate and, as a
//    pick-list entry, is an obstacle that no order can target (`METEOR_REF`).
//  - UNRESOLVED: artwork parity. The frames are decoded from the player's Disk.1 sheet by the existing decoder; there
//    is no emulator pixel comparison.

import type { Drawable } from "./objects.js";
import type { ByteReader } from "./alien-sprite.js";
import { METEOR_SLOT } from "./disk4-scene.js";
import { s8 } from "./sim-math.js";

/** Object type byte of the meteor record ($1449C +0): sprite type 21. */
export const METEOR_TYPE = 0x15;
/** The descriptor holds nine frame offsets; a frame byte outside 0..8 selects nothing. */
export const METEOR_FRAME_SLOTS = 9;

/**
 * The active meteor as a drawable, or null when none is drawn: the slot is free (type byte 0), holds another type byte
 * (only $15 is the traced meteor; anything else is not interpreted), or its frame byte is outside the descriptor's nine
 * slots. `lift` is the signed +6 byte (the countdown, $78 on creation), so the sprite starts high above its cell and
 * descends as the countdown runs down. Reads only $1449C..$144A2.
 */
export function readMeteor(state: ByteReader): Drawable | null {
  if (state.byte(METEOR_SLOT) !== METEOR_TYPE) return null;
  const frame = state.byte(METEOR_SLOT + 5);
  if (frame >= METEOR_FRAME_SLOTS) return null;
  return {
    type: METEOR_TYPE,
    x: state.byte(METEOR_SLOT + 1),
    y: state.byte(METEOR_SLOT + 2),
    dx: s8(state.byte(METEOR_SLOT + 3)),
    dy: s8(state.byte(METEOR_SLOT + 4)),
    frame,
    lift: s8(state.byte(METEOR_SLOT + 6)),
  };
}
