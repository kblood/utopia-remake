// Icon column button 3 ($30FE) and the marker placement routine $311E.
//
// $30FE is not a screen: it shows message $6F and sets the flag $144B3. The next left click on a map
// cell ($158CA, screen mode 1) then calls $311E with that cell instead of the normal cell selection,
// and clears the flag. $311E toggles one of the eight marker pins: a pin already on the cell is
// lifted (message $72); otherwise the first unused pin (lowest number) is put there (message $71 with
// the pin number, '1'-'8', written into the text); with all eight in use nothing happens (message
// $70). The overview map ($F3CE) calls the same routine for clicks in its preview window, where
// messages are suppressed ($156A8 bit 4). Notes: notes/formats/screens.md section 8.

import type { GameStrings } from "../../data/gamestrings.js";
import type { ObjectLayer } from "../objects.js";

export const MARKER_MESSAGE = { armed: 0x6f, full: 0x70, placed: 0x71, removed: 0x72 } as const;
const PIN_COUNT = 8;

export interface MarkerResult {
  action: "placed" | "removed" | "full";
  message: number; // string index for the message line ($70 / $71 / $72)
  pin: number | null; // pin number 1-8 for message $71 (the original writes it into the text), else null
}

// $311E: toggle a marker on map cell (x, y).
export function placeNextMarker(layer: ObjectLayer, x: number, y: number): MarkerResult {
  const there = layer.markers.find((m) => m.y !== 0xff && m.x === x && m.y === y);
  if (there) {
    layer.toggleMarker(there.type, x, y);
    return { action: "removed", message: MARKER_MESSAGE.removed, pin: null };
  }
  const free = layer.markers.find((m) => m.y === 0xff);
  if (!free) return { action: "full", message: MARKER_MESSAGE.full, pin: null };
  layer.toggleMarker(free.type, x, y);
  return { action: "placed", message: MARKER_MESSAGE.placed, pin: free.type };
}

// Text of message $71 with the pin number written in ($31AE: first byte of the string = offset of the
// character to replace, value = pin index + '1'). Returns the plain text when the string has no
// placeholder.
export function markerMessageText(strings: GameStrings, pin: number): number[] {
  const text = strings.get(MARKER_MESSAGE.placed);
  const probe = strings.withNumber(MARKER_MESSAGE.placed, [1, 1, 1, 1]);
  const at = probe.findIndex((v, i) => v !== text[i]);
  if (at >= 0 && pin >= 1 && pin <= PIN_COUNT) text[at] = 0x30 + pin;
  return text;
}

// The flag $144B3 and what clicking does with it.
export class MarkerMode {
  armed = false;

  // Button 3 pressed: returns the message to show ($6F). The caller returns to the map screen first
  // when another screen mode is active ($15EF0); in this port the map is always the base scene.
  arm(): number {
    this.armed = true;
    return MARKER_MESSAGE.armed;
  }

  // A left click on map cell (x, y) in screen mode 1. Returns null when marker mode is not armed (the
  // click is then a normal cell selection). The flag is cleared even when all pins are in use.
  click(layer: ObjectLayer, x: number, y: number): MarkerResult | null {
    if (!this.armed) return null;
    this.armed = false;
    return placeNextMarker(layer, x, y);
  }
}
