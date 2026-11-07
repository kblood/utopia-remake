// Read-only readers for the parts of a Disk.4 snapshot that a map scene needs to show it: the saved view
// origin, the eight marker pin records and the two "special effect" slots that this port keeps outside the state
// image. Nothing here writes: every function only reads the GameState it is given.
//
// Evidence (notes/formats/map-rendering.md sections 3, 7.2, 7.5; game-state.md 3.8, 3.10):
//  - view origin: words $144E4 (x, 0..$5C) and $144E6 (y, 0..$43); `$15A28` clamps to these limits. A saved word
//    outside them is clamped for the VIEW only; the saved words are never rewritten. Whether the original reads
//    these words back after a load was not traced (map-rendering.md: HYPOTHESIS).
//  - marker pins: 8 records of 10 bytes at $14540, +1 x, +2 y, "not placed" = y byte $FF ($866E writes it, `$31CC`
//    does `st` on it). The type byte at +0 and bytes +3..+9 are not interpreted. A placed pin must lie on the map.
//  - special slots: $144A8 (alien sprite, type 19) and $1449C (meteor, type 21, timer in +6) are single entries
//    whose first byte is the type, 0 = free. Their runtime fields are preserved in area B and hydrated by Aliens;
//    activation accepts traced active layouts and refuses unknown/corrupt types, counters, frames or positions.

import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";
import { A, type GameState } from "./state.js";

export const MARKER_RECORD_BASE = 0x14540;
export const MARKER_RECORD_SIZE = 10;
export const MARKER_RECORD_COUNT = 8;
export const MARKER_NOT_PLACED = 0xff;
export const ALIEN_SLOT = 0x144a8;
export const METEOR_SLOT = 0x1449c;
/** Highest legal view origin ($15A28): 100 - 8 and 75 - 8. */
export const VIEW_MAX_X = MAP_WIDTH - 8;
export const VIEW_MAX_Y = MAP_HEIGHT - 8;

export type SceneRestoreErrorCode =
  | "sprites-required" // a restored scene needs the sprite sheets: without them tanks, ships and enemies would be invisible
  | "graph-mismatch" // the prepared objects do not belong together (different world / unit system / buffers / state)
  | "already-activated" // this prepared graph already drives a scene; its hooks can only be bound once
  | "marker-record" // a saved marker record marks a pin outside the map
  | "special-state" // an active alien/meteor record contains fields outside the traced continuation domain
  | "exception"; // a resource or constructor step threw; the message is the exception text

export interface SceneRestoreError {
  readonly code: SceneRestoreErrorCode;
  readonly message: string;
  /** Marker index (0..7) for "marker-record". */
  readonly marker?: number;
}

export interface SavedView {
  /** The view origin the scene starts with (clamped to 0..VIEW_MAX_X / 0..VIEW_MAX_Y). */
  readonly x: number;
  readonly y: number;
  /** The words as saved in $144E4 / $144E6. */
  readonly savedX: number;
  readonly savedY: number;
  readonly clamped: boolean;
}

/** Reads $144E4/$144E6 and clamps them for display. The state is not modified. */
export function readSavedView(state: GameState): SavedView {
  const savedX = state.word(A.scrollX);
  const savedY = state.word(A.scrollY);
  const x = Math.min(VIEW_MAX_X, savedX);
  const y = Math.min(VIEW_MAX_Y, savedY);
  return { x, y, savedX, savedY, clamped: x !== savedX || y !== savedY };
}

export type SavedMarkerResult =
  | { readonly ok: true; readonly value: readonly ({ x: number; y: number } | null)[] }
  | { readonly ok: false; readonly error: SceneRestoreError };

/** Reads the eight pin records: null = not placed ($FF in +2), otherwise the map cell (+1, +2). */
export function readSavedMarkers(state: GameState): SavedMarkerResult {
  const out: ({ x: number; y: number } | null)[] = [];
  for (let i = 0; i < MARKER_RECORD_COUNT; i++) {
    const at = MARKER_RECORD_BASE + MARKER_RECORD_SIZE * i;
    const x = state.byte(at + 1);
    const y = state.byte(at + 2);
    if (y === MARKER_NOT_PLACED) {
      out.push(null);
      continue;
    }
    if (x >= MAP_WIDTH || y >= MAP_HEIGHT) {
      return { ok: false, error: { code: "marker-record", marker: i, message: `Saved marker pin ${i + 1} sits at (${x}, ${y}), outside the ${MAP_WIDTH} x ${MAP_HEIGHT} map` } };
    }
    out.push({ x, y });
  }
  return { ok: true, value: out };
}

/** Validates active special records for the runtime fields currently traced by Aliens and the drawable adapters. */
export function validateSpecialSlots(state: GameState): SceneRestoreError | null {
  const alienType = state.byte(ALIEN_SLOT);
  if (alienType !== 0) {
    if (alienType !== 0x13) return { code: "special-state", message: `Unsupported active record type $${alienType.toString(16)} at $144A8; only type $13 is traced` };
    const x = state.byte(ALIEN_SLOT + 1);
    const y = state.byte(ALIEN_SLOT + 2);
    if (x >= MAP_WIDTH || y >= MAP_HEIGHT) return { code: "special-state", message: `Alien position ($144A9/$144AA) ${x},${y} is outside the ${MAP_WIDTH}x${MAP_HEIGHT} map` };
    const phase = state.word(0x144a4);
    if (phase > 10) return { code: "special-state", message: `Alien phase word $144A4 is ${phase}; traced table indices are 0..10` };
    const frame = state.byte(ALIEN_SLOT + 5);
    if (frame > 3) return { code: "special-state", message: `Alien frame $144AD is ${frame}; the traced animation table emits only frames 0..3` };
  }
  const meteorType = state.byte(METEOR_SLOT);
  if (meteorType !== 0) {
    if (meteorType !== 0x15) return { code: "special-state", message: `Unsupported active record type $${meteorType.toString(16)} at $1449C; only type $15 is traced` };
    const x = state.byte(METEOR_SLOT + 1);
    const y = state.byte(METEOR_SLOT + 2);
    if (x >= MAP_WIDTH || y >= MAP_HEIGHT) return { code: "special-state", message: `Meteor position ($1449D/$1449E) ${x},${y} is outside the ${MAP_WIDTH}x${MAP_HEIGHT} map` };
    if (state.byte(METEOR_SLOT + 5) !== 0) return { code: "special-state", message: `Meteor frame $144A1 must be 0 in the traced active lifecycle` };
    const timer = state.byte(METEOR_SLOT + 6);
    // Creation writes $78 and each unpaused pass subtracts 4; the pass that reaches 0 impacts and frees the record
    // ($3626-$3640), so an active record with 0 is not a reachable state and would wrap to $FC on the next pass.
    if (timer === 0 || timer > 0x78 || timer % 4 !== 0) return { code: "special-state", message: `Meteor countdown/lift $144A2 is ${timer}; traced active values are 4..120 in steps of 4` };
  }
  return null;
}
