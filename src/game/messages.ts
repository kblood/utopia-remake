// Message line (one line, 4 s) and message log panel (up to 3 wrapped lines, cleared 10 s after the
// last message). Positions, colours and timings: notes/formats/game-text.md, sections 4-5.

import { COLOR, drawGameText, wrapText } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import { type Screen, SCREEN_WIDTH } from "../gfx/screen.js";

const LINE_X = 8;
const LINE_Y = 160;
const LINE_FRAMES = 200;
const LOG_X = 8;
const LOG_Y = 171;
/** Rows that hold only the message line (above the log panel): y 160 up to the log's first row. Glyphs are 6 rows tall. */
export const LINE_BAND = { y: LINE_Y, rows: LOG_Y - LINE_Y } as const;
/**
 * The rows `$558A` (VBL, `$2CAA`) restores at the line's expiry: 7 rows from y 159, full width (5 planes x 40 bytes per row), from
 * the setup strip (`$28FD2`, captured from bitmap A at setup by `$4FFA`, i.e. the picture). The remake repaints the same rows from
 * the picture (map.ts `presentLineErase`). Row 159 is the map window's last row and the panel's top row; in every remake state probed
 * it already equals the picture, so repainting it changes nothing there (notes/formats/game-text.md section 4).
 */
export const LINE_ERASE_BAND = { y: 159, rows: 7 } as const;
const LOG_WIDTH = 304;
const LOG_LINES = 3;
export const LOG_IDLE_FRAMES = 500;
const LOG_LINE_HEIGHT = 9;
const LOG_PROTECT_DAYS = 10; // $5AF0: a new entry cannot be scrolled out for ten game days

/**
 * The log panel's background after a clear: `$5C9A` -> `$52A8` fills 8 rows per line over 38 bytes (x 8..311), three lines
 * (rows 171..194), with pattern phase `y & 7`. OBSERVED on one Copperline frame (map-rendering.md section 11): the whole
 * panel is this fill, exactly. Static: the clear is the idle path in the main loop (`$1586E`, game-text.md section 5 step 6).
 */
export const LOG_PANEL_FILL = { x: LOG_X, y: LOG_Y, bytes: 38, rows: LOG_LINES * 8 } as const;
/** `$4F92` (STATIC, the code is in Disk.1): the 8 x 8 pattern is byte column 19 (x 152..159) of rows 70..77 of the displayed picture. */
const LOG_PATTERN_SOURCE = { x: 19 * 8, y: 70 } as const;

/** The 8 x 8 pattern (index `(y & 7) * 8 + (x & 7)`) that `$4F92` samples from the picture as it is displayed at setup. */
export function logPanelPattern(picture: ArrayLike<number>): Uint8Array {
  const pattern = new Uint8Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) pattern[r * 8 + c] = picture[(LOG_PATTERN_SOURCE.y + r) * SCREEN_WIDTH + LOG_PATTERN_SOURCE.x + c];
  }
  return pattern;
}

/** Paints the log panel background as `$52A8` does: rows 171..194, x 8..311, pattern row `y & 7` at every column `x & 7`. */
export function fillLogPanel(screen: Screen, pattern: Uint8Array): void {
  const { x, y, bytes, rows } = LOG_PANEL_FILL;
  for (let yy = y; yy < y + rows; yy++) {
    for (let xx = x; xx < x + bytes * 8; xx++) screen.set(xx, yy, pattern[(yy & 7) * 8 + (xx & 7)]);
  }
}

/** What the observer is told for `pushText` (a pre-patched line with no string-table index). */
export const PATCHED_TEXT_MESSAGE = -1;

// String indices the original shows in the log panel rather than on the message line.
const LOG_INDICES = new Set([
  82, 98, 99, 101, 108, 109, 110, 141, 143, 148, 149, 150, 179, 197, 198, 199, 200, 215, 218, 219, 221, 223, 238, 239, 265, 285, 299, 300, 343, 390,
]);

/** Where `Messages.post` put a message: the message line, the log panel, or nowhere (empty text). */
export type PostedAs = "line" | "log" | "none";

// One message in the log panel: the list at $15698 holds {first line, line count, protect counter}.
interface LogEntry {
  lines: number[][];
  protect: number;
}

export class Messages {
  private lineText: number[] = [];
  private lineLeft = 0;
  private entries: LogEntry[] = [];
  private logIdle = 0;
  // Set by holdLineTick(); consumed by the next update(), which then leaves the line timer alone once.
  private lineHeld = false;
  // Set by a log clear that paints the pattern fill ($5C9A): the idle expiry and the full wipe ($5B46). A fresh scene starts
  // NOT cleared: `$866E` sets `$14634 = $FFFF`, which the main loop's zero test never clears (game-state.md 3.10). Not saved.
  private cleared = false;

  /** True once a clear has painted the pattern fill over the panel background. Until then the panel shows the picture. */
  get panelCleared(): boolean {
    return this.cleared;
  }

  /** True while the message line has text and timer left (set by `push`, cleared at expiry by `update`). */
  get lineShowing(): boolean {
    return this.lineLeft > 0;
  }

  /**
   * Passive observer of every message request (the runtime checkpoint recorder installs it; nothing else does).
   * It is told the string-table index of each `push`, and `PATCHED_TEXT_MESSAGE` for `pushText`, before the
   * message is handled; it must not call back into this object. It never changes what is shown.
   */
  observer: ((index: number) => void) | null = null;

  constructor(
    private readonly disk: Uint8Array,
    private readonly strings: GameStrings,
  ) {}

  /** Read-only timers and log shape for observers: no text, no string-table content. */
  inspect(): { lineFramesLeft: number; logIdleFrames: number; log: { lineCount: number; protectDays: number }[] } {
    return {
      lineFramesLeft: this.lineLeft,
      logIdleFrames: this.logIdle,
      log: this.entries.map((e) => ({ lineCount: e.lines.length, protectDays: e.protect })),
    };
  }

  // A message line with already patched text (e.g. the marker pin number).
  pushText(text: number[]): void {
    this.observer?.(PATCHED_TEXT_MESSAGE);
    this.lineText = text;
    this.lineLeft = LINE_FRAMES;
  }

  /** Posts a string-table message. Returns true when it became the message line (its 200 frames are set here). */
  push(index: number): boolean {
    return this.post(index) === "line";
  }

  /**
   * Posts a string-table message and says where it went: the message line (its 200 frames are set here), a log entry (`$5A8C`), or
   * nothing (an empty string). A log entry sets the log's idle timer, not the line's.
   */
  post(index: number): PostedAs {
    this.observer?.(index);
    const text = this.strings.get(index);
    if (text.length === 0) return "none";
    if (!LOG_INDICES.has(index)) {
      this.lineText = text;
      this.lineLeft = LINE_FRAMES;
      return "line";
    }
    const wrapped = wrapText(this.disk, text, LOG_WIDTH);
    const lines: number[][] = [[]];
    for (const c of wrapped.text) {
      if (c === 0xff) lines.push([]);
      else lines[lines.length - 1].push(c);
    }
    this.addLog(lines.slice(0, LOG_LINES));
    return "log";
  }

  // The lines currently in the log panel, top to bottom.
  get logText(): number[][] {
    return this.entries.flatMap((e) => e.lines);
  }

  private get used(): number {
    return this.entries.reduce((n, e) => n + e.lines.length, 0);
  }

  // $5A8C steps 3-4. If the lines fit they are appended. Otherwise the oldest entries that cover the
  // missing lines are dropped, the survivors move up and lose their protection ($5BDC clears byte +2);
  // an entry whose protect counter is still running, or running out of entries, wipes the whole panel.
  private addLog(lines: number[][]): void {
    let missing = this.used + lines.length - LOG_LINES;
    if (missing > 0) {
      let dropped = 0;
      let freed = 0;
      while (dropped < this.entries.length && freed < missing && this.entries[dropped].protect === 0) {
        freed += this.entries[dropped].lines.length;
        dropped++;
      }
      if (freed >= missing && dropped < this.entries.length) {
        this.entries.splice(0, dropped);
        for (const e of this.entries) e.protect = 0;
      } else {
        this.entries = []; // $5B46: the panel is cleared and the message starts at the top
        this.cleared = true;
      }
      missing = 0;
    }
    this.entries.push({ lines, protect: LOG_PROTECT_DAYS });
    this.logIdle = LOG_IDLE_FRAMES;
  }

  // $9A36: once per game day the protect counters of the log entries count down.
  dayPassed(): void {
    for (const e of this.entries) if (e.protect > 0) e.protect--;
  }

  /**
   * One-shot: the next `update()` does not tick the message line's timer. Used only for a line that is posted and drawn in
   * the same video update before `update()` runs: the build-menu commit's prompt in the modal-exit frame, and a pass-time
   * line spliced in its pass's update (map.ts). `$551A` sets 200 at the draw and the VBL decrement comes after it, so the
   * first tick comes on the next update, as for a line posted by the input poll. The log's idle timer is not affected.
   */
  holdLineTick(): void {
    this.lineHeld = true;
  }

  /**
   * One video update. Returns true when the line's timer reached 0 in this call, so the caller can erase the line's pixels in the
   * same update (`$2CAA` calls `$558A` in the VBL that makes the count 0). The log's idle clear is not reported: its pixels go with
   * the next completed pass (the main-loop check `$15850`, see map.ts).
   */
  update(): boolean {
    let expired = false;
    if (this.lineHeld) this.lineHeld = false;
    else if (this.lineLeft > 0 && --this.lineLeft === 0) {
      this.lineText = [];
      expired = true;
    }
    if (this.logIdle > 0 && --this.logIdle === 0) {
      this.entries = []; // the main loop's idle clear ($1586E, `$5C9A`)
      this.cleared = true;
    }
    return expired;
  }

  draw(screen: Screen): void {
    this.drawLine(screen);
    this.entries.flatMap((e) => e.lines).forEach((line, i) => drawGameText(this.disk, screen, line, LOG_X, LOG_Y + i * LOG_LINE_HEIGHT, COLOR.text));
  }

  /** Draws only the message line (no log, no timer change). Used by the same-frame presentation of a line message (map.ts). */
  drawLine(screen: Screen): void {
    if (this.lineLeft > 0) drawGameText(this.disk, screen, this.lineText, LINE_X, LINE_Y, COLOR.highlight);
  }
}
