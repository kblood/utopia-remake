// The music-select list of the disk menu: icon 7 -> `$1006` draws it, `$8132` highlights the row under the pointer, a click on a
// row runs `$87DC` -> `$8A42` -> `$110A` (notes/formats/music.md, "Music-select flow"). Everything here comes from the static
// Disk.1 trace. The list lives on the shared disk-menu picture, so its scene, input handling and message areas are in
// `disk-menu.ts` (`DiskMenuScene`); this module keeps the list geometry and the music-specific rules: which rows are tracks, the
// prompt string and the music on/off handler `$1062` (`toggleMusic`).

/** Row geometry of `$8132` (hit test), `$818C` (highlight bar) and `$1006` (text). Rows are `pitch` pixels apart. */
export const MUSIC_LIST = {
  /** Inclusive pointer bounds: `$38 <= x <= $88`, `$20 <= y <= $79`. */
  x0: 0x38,
  x1: 0x88,
  y0: 0x20,
  y1: 0x79,
  pitch: 9,
  rows: 10,
  /** Text origin `$3A`; row `n` is drawn at y = `$20 + 9n`. */
  labelX: 0x3a,
  /** Highlight bar of `$818C`: 11 bytes (88 pixels) wide, 6 scanlines tall, palette index 7 (planes 0-2 set, 3-4 clear). */
  barX: 0x38,
  barWidth: 88,
  barHeight: 6,
  barColor: 7,
} as const;

/** `$110A` accepts only a row below 4 (`cmpi.b #4,d2`); rows 4-9 close the list without touching the music. */
export const MUSIC_TRACK_ROWS = 4;

/** String index of the prompt printed when the list opens (`$1006`: `move.w #$190,d0`, `$8462`: first prompt line, x 8, y `$A3`). */
export const MUSIC_PROMPT_STRING = 0x190;

/** String indexes printed by the music on/off handler `$1062` through `$83A2` (second result line, x 8, y `$BE`; the prompt line `$A3` is NOT touched). */
export const MUSIC_TOGGLE_STRING = {
  /** Bit 0 of `$1581` clear: "Music unavailable without expansion memory" (the same text `$1006` prints). */
  unavailable: 0x197,
  /** Inactive and `$1580 < 0`: "No music loaded". */
  noMusic: 0x196,
  /** Inactive with a loaded track: set bit 1, "Music on". */
  on: 0x192,
  /** Active: clear bit 1, DMACON `$F`, "Music Off". */
  off: 0x193,
} as const;

/** What the toggle needs from `Music` (state is read as bits 1 of `$1581` and the sign of `$1580`). */
export interface MusicSwitch {
  /** Selected track, -1 = none loaded (`$1580 < 0`). */
  readonly current: number;
  /** Music-active bit (bit 1 of `$1581`). */
  readonly active: boolean;
  setActive(active: boolean): boolean;
}

/**
 * The music on/off button `$1062`. `null` stands for "no expansion memory" (bit 0 of `$1581` clear; the slave always sets it,
 * so the remake only meets it when it has no `Music` at all): message `$197`, nothing changes. Otherwise: inactive with no
 * track -> `$196`; inactive with a track -> continue it from where it stopped, `$192`; active -> pause, `$193`.
 * Returns the string index to print. It never loads, restarts or selects a track.
 */
export function toggleMusic(music: MusicSwitch | null): number {
  if (!music) return MUSIC_TOGGLE_STRING.unavailable;
  if (music.active) {
    music.setActive(false);
    return MUSIC_TOGGLE_STRING.off;
  }
  if (music.current < 0) return MUSIC_TOGGLE_STRING.noMusic;
  music.setActive(true);
  return MUSIC_TOGGLE_STRING.on;
}

/** Row under the pointer per `$8132`, or -1 outside the list. Row = floor((y - $20) / 9), 0..9. */
export function musicRowAt(x: number, y: number): number {
  const m = MUSIC_LIST;
  if (x < m.x0 || x > m.x1 || y < m.y0 || y > m.y1) return -1;
  return Math.floor((y - m.y0) / m.pitch);
}
