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

// String indices the original shows in the log panel rather than on the message line.
const LOG_INDICES = new Set([
  82, 98, 99, 101, 108, 109, 110, 141, 143, 148, 149, 150, 179, 197, 198, 199, 200, 215, 218, 219, 221, 223, 238, 239, 265, 285, 299, 300, 343, 390,
]);

export class Messages {
  private lineText: number[] = [];
  private lineLeft = 0;
  private logLines: number[][] = [];
  private logIdle = 0;

  constructor(
    private readonly disk: Uint8Array,
    private readonly strings: GameStrings,
  ) {}

  // A message line with already patched text (e.g. the marker pin number).
  pushText(text: number[]): void {
    this.lineText = text;
    this.lineLeft = LINE_FRAMES;
  }

  push(index: number): void {
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
    if (this.logLines.length + lines.length > LOG_LINES) this.logLines = [];
    this.logLines.push(...lines.slice(0, LOG_LINES));
    this.logIdle = LOG_IDLE_FRAMES;
  }

  update(): void {
    if (this.lineLeft > 0 && --this.lineLeft === 0) this.lineText = [];
    if (this.logIdle > 0 && --this.logIdle === 0) this.logLines = [];
  }

  draw(screen: Screen): void {
    if (this.lineLeft > 0) drawGameText(this.disk, screen, this.lineText, LINE_X, LINE_Y, COLOR.highlight);
    this.logLines.forEach((line, i) => drawGameText(this.disk, screen, line, LOG_X, LOG_Y + i * LOG_LINE_HEIGHT, COLOR.text));
  }
}
