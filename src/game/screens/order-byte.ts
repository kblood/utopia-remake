import type { World } from "../world.js";

// $F173, the order byte shared by four windows. The original keeps one RAM byte that is written by:
//   - the ship window $DA94 (its mode at open, then every order change; a refused window still writes the mode),
//   - the tank window $C5BE (0 at open, then 5 front, 6/7 near a pin, 9 single pin),
//   - the tank teleporter $CAAE (on every button event $FF, button 8 then copies the selected pin $F172),
//   - the ship yard $D7D6 (the work value of an unlocked choice, $D99C).
// The ship yard launch ($D8DE-$D8EC) copies it into the new order's work field, so a locked icon chosen after an
// earlier window ordered it with that stale byte. The byte is not reset when a window opens or closes.
//
// Session RAM only: it is not in the native save (no traced save range covers $F173), and a new World starts with
// it unknown (`null`). Nothing traced sets its power-on value, so a yard that reads it before any write orders nothing.
const orderBytes = new WeakMap<World, number>();

/** The current byte of $F173 (0-255), or null while no window of this session has written it. */
export function readOrderByte(world: World): number | null {
  return orderBytes.get(world) ?? null;
}

/** Stores a byte of $F173; a signed value such as -1 ($FF) is stored as its byte. */
export function writeOrderByte(world: World, value: number): void {
  orderBytes.set(world, value & 0xff);
}
