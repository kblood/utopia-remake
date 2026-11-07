// Message line (one line, 4 s) and message log panel (up to 3 wrapped lines, cleared 10 s after the
// last message). Positions, colours and timings: notes/formats/game-text.md, sections 4-5.

import { COLOR, drawGameText, wrapText } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import type { Screen } from "../gfx/screen.js";

const LINE_X = 8;
const LINE_Y = 160;
const LINE_FRAMES = 200;
const LOG_X = 8;
const LOG_Y = 171;
const LOG_WIDTH = 304;
const LOG_LINES = 3;
const LOG_IDLE_FRAMES = 500;
const LOG_LINE_HEIGHT = 9;
const LOG_PROTECT_DAYS = 10; // $5AF0: a new entry cannot be scrolled out for ten game days

/** What the observer is told for `pushText` (a pre-patched line with no string-table index). */
export const PATCHED_TEXT_MESSAGE = -1;

// String indices the original shows in the log panel rather than on the message line.
const LOG_INDICES = new Set([
  82, 98, 99, 101, 108, 109, 110, 141, 143, 148, 149, 150, 179, 197, 198, 199, 200, 215, 218, 219, 221, 223, 238, 239, 265, 285, 299, 300, 343, 390,
]);

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

  push(index: number): void {
    this.observer?.(index);
    const text = this.strings.get(index);
    if (text.length === 0) return;
    if (!LOG_INDICES.has(index)) {
      this.lineText = text;
      this.lineLeft = LINE_FRAMES;
      return;
    }
    const wrapped = wrapText(this.disk, text, LOG_WIDTH);
    const lines: number[][] = [[]];
    for (const c of wrapped.text) {
      if (c === 0xff) lines.push([]);
      else lines[lines.length - 1].push(c);
    }
    this.addLog(lines.slice(0, LOG_LINES));
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

  update(): void {
    if (this.lineLeft > 0 && --this.lineLeft === 0) this.lineText = [];
    if (this.logIdle > 0 && --this.logIdle === 0) this.entries = [];
  }

  draw(screen: Screen): void {
    if (this.lineLeft > 0) drawGameText(this.disk, screen, this.lineText, LINE_X, LINE_Y, COLOR.highlight);
    this.entries.flatMap((e) => e.lines).forEach((line, i) => drawGameText(this.disk, screen, line, LOG_X, LOG_Y + i * LOG_LINE_HEIGHT, COLOR.text));
  }
}
