// The disk menu (`$7E52` sets it up, `$7EF6` is its loop): the original picture with nine 32 x 32 icon buttons, the black 10-row
// list panel and the message areas. ONE scene covers the landing page and the shared list (`$938D` = 4, the music-select list),
// exactly as the original keeps both on the same screen. Everything here comes from the static Disk.1 trace in
// notes/formats/music.md ("Music-select flow") and notes/formats/sfx.md ("Button click call paths"); the picture, text and labels
// are read from the user's own disk at run time and never stored.
//
// The scene owns pixels and input only. What an icon DOES (music, effects, exit, tutorial, the save-disk family) is decided by
// `Game`, which receives `{ kind: "icon" }` on the release. Remake-only behaviour is marked as such below:
//   * right button: closes an open list, otherwise asks for the remake submenu (the original loop ignores the right button),
//   * `printRemakeNote`: text of the remake in the message area (no original string exists for it).

import { COLOR, drawGameText } from "../data/gamefont.js";
import { readMusicLabels } from "../data/gameimage.js";
import type { GameStrings } from "../data/gamestrings.js";
import { decodePicture, type SectorRange } from "../data/picture.js";
import { Screen } from "../gfx/screen.js";
import type { Input } from "./intro.js";
import { MUSIC_LIST, MUSIC_PROMPT_STRING, MUSIC_TRACK_ROWS, musicRowAt } from "./music-select.js";

/** Picture 1 of the table `$8C8C` (`$2CE`-`$2E4`), loaded by `$7E52`: textured frame, black list panel, nine icons, message area. */
export const DISK_MENU_PICTURE: SectorRange = { first: 0x2ce, last: 0x2e4 };

export interface Rect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** The nine 32 x 32 icon rectangles at `$8CB4` ({x0, x1, y0, y1}, inclusive as in `$5730`); the index is the `d2` of the dispatch `$7FE4`. */
export const DISK_MENU_BUTTONS: readonly Rect[] = [
  { x0: 208, x1: 239, y0: 24, y1: 55 },
  { x0: 256, x1: 287, y0: 24, y1: 55 },
  { x0: 208, x1: 239, y0: 70, y1: 101 },
  { x0: 256, x1: 287, y0: 70, y1: 101 },
  { x0: 208, x1: 239, y0: 116, y1: 147 },
  { x0: 256, x1: 287, y0: 116, y1: 147 },
  { x0: 160, x1: 191, y0: 24, y1: 55 },
  { x0: 160, x1: 191, y0: 70, y1: 101 },
  { x0: 160, x1: 191, y0: 116, y1: 147 },
];

/**
 * The `$7FE4` dispatch, by rectangle index. Meanings were traced from the handlers and their strings, and agree with the icon
 * pictures (arrow out of a floppy, arrow into a floppy, plain floppy, floppy with "!", music note, red stop square, graduation cap,
 * floppy with a note, "FX"):
 *   0 `$85FE` load game from a save disk (mode 2, "Click on slot to load game from..."),
 *   1 `$856C` save game (mode 1; refused with `$18A` when `$156AA` bit 3, game over, is set),
 *   2 `$8632` load scenario from a scenario disk (mode 3),
 *   3 `$8314` format a save disk (Return confirms, a mouse click aborts),
 *   4 `$1062` music on/off,
 *   5 `$802C` exit to the map (refused while `$156AA` bit 3 is set),
 *   6 `$80C8` tutorial: string `$191`, scenario record 0, `$156AA` bits 7 and 2, money `$7A120`, then exit to the map,
 *   7 `$1006` music select (opens the shared list, mode 4),
 *   8 `$10BC` effects on/off.
 */
export const DISK_BUTTON = { load: 0, save: 1, scenario: 2, format: 3, music: 4, exit: 5, tutorial: 6, musicSelect: 7, effects: 8 } as const;

/** Index of the disk-menu icon under the pointer (`$5730`), or -1. */
export function diskButtonAt(x: number, y: number): number {
  return DISK_MENU_BUTTONS.findIndex((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
}

/** The pressed look (`$5948` -> `$59A0`): `not.b` over 32 rows x 4 bytes of the plane at `$C($160FA)` = plane 3, i.e. colour ^ 8. Applied on the press, undone on the release (`$59C8`). */
export const ICON_FLIP_COLOR = 8;

/** Strings printed by the icon handlers through `$83A2` (message area at y `$B5` / `$BE`). */
export const EFFECTS_STRING = {
  /** `$10BC` with bit 2 of `$1581` clear: set it, "Effects on.". */
  on: 0x194,
  /** `$10BC` with the bit set: clear it, clear the four channel timers, DMACON `$F`, "Effects off.". */
  off: 0x195,
} as const;
/** `$856C` with `$156AA` bit 3 set: "There is no game to save!" (first line of the info area). */
export const NO_GAME_TO_SAVE_STRING = 0x18a;

/**
 * The two message areas. `$8462` (the list prompt) prints a first line at y `$A3` and a second at `$AC`, erasing 37 bytes (296 pixels)
 * from x 8 first (`$539E` = `$51E6` + text); `$84F4` clears both prompt lines 38 bytes wide. `$83A2` (the handlers' results) prints at
 * y `$B5` and `$BE`, erasing 37 bytes first. Each erase is 6 scanlines tall and replaces the pixels with the 8-row pattern at `$5D7A`
 * (`$16D6A` while the disk menu runs), sampled from the displayed picture by `$4F92`; the remake reconstructs this pattern from the decoded
 * menu image at the same source coordinates.
 * `$82B8` (close the list) clears only the prompt lines and the ten rows, never the result lines.
 */
export const MESSAGE_AREA = {
  x: 8,
  prompt: { y: [0xa3, 0xac], printBytes: 0x25, clearBytes: 0x26 },
  info: { y: [0xb5, 0xbe], printBytes: 0x25 },
  lineHeight: 6,
} as const;

/** `$4F92`: the menu pattern is sampled from byte column 19, rows 70..77 of each displayed bitplane. */
export const MESSAGE_PATTERN_SAMPLE = { x: 19 * 8, y: 70 } as const;

/**
 * `$83F2` stores 20000 (`$4E20`) in `$8CB0` after every result message; the loop `$7EF6` decrements it once per iteration and, at 0,
 * erases both result lines (`$7F0C`-`$7F68`). The unit is loop iterations of a mouse-polling busy loop, not frames, so the wall time
 * is not known statically (roughly 0.2-1.2 s depending on the CPU). HYPOTHESIS: the remake uses 50 frames (1 s).
 */
export const INFO_LIFETIME_FRAMES = 50;

/** What a call of `update` can report. */
export type DiskMenuResult =
  /** Row 0-3 of the open list, acted on after the release (`$2E52`); `$110A` restarts that module even if it plays. The list is closed (`$8A46` -> `$82B8`). */
  | { readonly kind: "track"; readonly track: number }
  /** Rows 4-9 released (`$110A` -> `$82B8`) or the remake's right click: the list is closed, the music is not touched. */
  | { readonly kind: "listClosed" }
  /** An icon released (its press already called `onButtonPress`): the caller runs the handler of `$7FE4`. */
  | { readonly kind: "icon"; readonly index: number }
  /** REMAKE ONLY: right click on the landing page (no list open) asks for the remake submenu. */
  | { readonly kind: "remake" };

export interface DiskMenuOptions {
  /** Called once on the press of any icon (`$7FC0` -> `$5948` requests the id 4 click on the press; every rectangle, blank ones included). */
  readonly onButtonPress?: (index: number) => void;
}

/** One message line: a string-table index (0 = nothing, -1 = remake text) and its character codes. */
interface Line {
  readonly index: number;
  readonly codes: readonly number[];
}
const EMPTY: Line = { index: 0, codes: [] };

export class DiskMenuScene {
  readonly screen = new Screen();
  private readonly background: Uint8Array;
  private readonly labels: number[][];
  private list: "closed" | "music" = "closed";
  private prompt: [Line, Line] = [EMPTY, EMPTY];
  private info: [Line, Line] = [EMPTY, EMPTY];
  // `$82B8` clears both prompt rows at setup/close (38 bytes). Result rows start untouched and are erased at print/timeout (37 bytes).
  private promptEraseBytes: [number, number] = [MESSAGE_AREA.prompt.clearBytes, MESSAGE_AREA.prompt.clearBytes];
  private infoEraseBytes: [number, number] = [0, 0];
  private infoFrames = 0;
  private wasDown = true; // ignore the click that opened the menu
  private wasRight = true;
  private hover = -1;
  // What the press began on; the action runs when the button is released, wherever the pointer is by then.
  private pressRow = -1;
  private pressButton = -1;
  private flipped = -1;

  constructor(
    private readonly disk: Uint8Array,
    private readonly strings: GameStrings,
    private readonly options: DiskMenuOptions = {},
  ) {
    decodePicture(disk, DISK_MENU_PICTURE, this.screen);
    this.background = this.screen.pixels.slice();
    this.labels = readMusicLabels(disk);
    this.draw();
  }

  /** True while the shared list (music select, `$938D` = 4) is open. */
  get listOpen(): boolean {
    return this.list !== "closed";
  }

  /** Row highlighted by the hover test `$8132` (-1 none, always -1 while the list is closed). */
  get highlighted(): number {
    return this.hover;
  }

  /** Icon drawn pressed (flipped) right now, or -1. */
  get pressedIcon(): number {
    return this.flipped;
  }

  /** String indexes of the prompt lines (`$8462`); 0 = nothing. */
  get shownPrompt(): readonly [number, number] {
    return [this.prompt[0].index, this.prompt[1].index];
  }

  /** String indexes of the result lines (`$83A2`); 0 = nothing, -1 = remake text. */
  get shownInfo(): readonly [number, number] {
    return [this.info[0].index, this.info[1].index];
  }

  /** Frames left before the result lines are erased (0 = no countdown running). */
  get infoFramesLeft(): number {
    return this.infoFrames;
  }

  private line(index: number): Line {
    return index === 0 ? EMPTY : { index, codes: this.strings.get(index) };
  }

  /** `$83A2`: result message(s) in the info area. A zero argument leaves its line as it was (no erase); a print restarts the countdown (`$83F2`). */
  printInfo(first: number, second: number): void {
    if (first !== 0) {
      this.info[0] = this.line(first);
      this.infoEraseBytes[0] = MESSAGE_AREA.info.printBytes;
    }
    if (second !== 0) {
      this.info[1] = this.line(second);
      this.infoEraseBytes[1] = MESSAGE_AREA.info.printBytes;
    }
    this.infoFrames = INFO_LIFETIME_FRAMES;
    this.draw();
  }

  /** REMAKE ONLY: remake-authored text on the second result line (no original string exists), with the same countdown. */
  printRemakeNote(text: string): void {
    this.info[1] = { index: -1, codes: Array.from(text.toUpperCase(), (c) => c.charCodeAt(0)) };
    this.infoEraseBytes[1] = MESSAGE_AREA.info.printBytes;
    this.infoFrames = INFO_LIFETIME_FRAMES;
    this.draw();
  }

  /**
   * `$82B8`: close the list. Clears the prompt lines (`$84F4`) and the ten row areas, resets the mode byte. Result lines and their
   * countdown stay. The original leaves `$8CFE` (the hover row) as it is until the loop's next `$8132` call; the remake clears it.
   */
  closeList(): void {
    this.list = "closed";
    this.prompt = [EMPTY, EMPTY];
    this.promptEraseBytes = [MESSAGE_AREA.prompt.clearBytes, MESSAGE_AREA.prompt.clearBytes];
    this.hover = -1;
    this.draw();
  }

  /**
   * `$1006`: close any list first (`$82B8`), then, with expansion memory, draw the ten rows and print the prompt `$190`
   * (`$8462`, first line) and enter mode 4. Without expansion memory (`available` false: the remake has no `Music`) print `$197` in the
   * info area and leave the list closed. Returns whether the list is open now.
   */
  openMusicList(available: boolean): boolean {
    this.closeList();
    if (!available) {
      this.printInfo(0, 0x197);
      return false;
    }
    this.list = "music";
    this.prompt = [this.line(MUSIC_PROMPT_STRING), EMPTY];
    this.draw();
    return true;
  }

  private draw(): void {
    const m = MUSIC_LIST;
    const screen = this.screen;
    screen.pixels.set(this.background);
    const a = MESSAGE_AREA;
    this.fillMessageErase(a.prompt.y[0], this.promptEraseBytes[0]);
    this.fillMessageErase(a.prompt.y[1], this.promptEraseBytes[1]);
    this.fillMessageErase(a.info.y[0], this.infoEraseBytes[0]);
    this.fillMessageErase(a.info.y[1], this.infoEraseBytes[1]);
    this.prompt.forEach((line, i) => drawGameText(this.disk, screen, line.codes, a.x, a.prompt.y[i], COLOR.text));
    this.info.forEach((line, i) => drawGameText(this.disk, screen, line.codes, a.x, a.info.y[i], COLOR.text));
    if (this.list !== "closed") {
      if (this.hover >= 0) {
        const top = m.y0 + this.hover * m.pitch;
        for (let y = top; y < top + m.barHeight; y++) {
          for (let x = m.barX; x < m.barX + m.barWidth; x++) screen.set(x, y, m.barColor);
        }
      }
      this.labels.forEach((label, i) => drawGameText(this.disk, screen, label, m.labelX, m.y0 + i * m.pitch, COLOR.text));
    }
    if (this.flipped >= 0) {
      const r = DISK_MENU_BUTTONS[this.flipped];
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) screen.pixels[y * 320 + x] ^= ICON_FLIP_COLOR;
      }
    }
  }

  /** `$51E6` repeats the sampled eight-pixel row at each eight-pixel horizontal step, with screen-y phase. */
  private fillMessageErase(y0: number, bytes: number): void {
    const sample = MESSAGE_PATTERN_SAMPLE;
    for (let y = y0; y < y0 + MESSAGE_AREA.lineHeight; y++) {
      const patternY = y & 7;
      for (let x = MESSAGE_AREA.x; x < MESSAGE_AREA.x + bytes * 8; x++) {
        const patternX = x & 7;
        const source = (sample.y + patternY) * 320 + sample.x + patternX;
        this.screen.set(x, y, this.background[source]);
      }
    }
  }

  /** One update per frame (50 Hz). */
  update(input: Input): DiskMenuResult | null {
    if (this.infoFrames > 0 && --this.infoFrames === 0) {
      this.info = [EMPTY, EMPTY];
      this.infoEraseBytes = [MESSAGE_AREA.info.printBytes, MESSAGE_AREA.info.printBytes];
      this.draw();
    }

    const down = input.leftButton;
    // `$7F80` branches back to the menu loop while the right button is held, before handling left-button edges.
    // Right-click navigation below is a remake convenience; a simultaneous left edge must not also activate an icon/row.
    const pressed = down && !this.wasDown && !input.rightButton;
    const released = !down && this.wasDown && !input.rightButton;
    this.wasDown = down;
    const rightPressed = input.rightButton && !this.wasRight;
    this.wasRight = input.rightButton;

    // `$8132`: the hover row only exists while a list is open.
    const row = this.list === "closed" ? -1 : musicRowAt(input.pointerX, input.pointerY);
    if (row !== this.hover) {
      this.hover = row;
      this.draw();
    }

    if (pressed) {
      this.pressButton = diskButtonAt(input.pointerX, input.pointerY);
      this.pressRow = this.pressButton < 0 ? row : -1;
      if (this.pressButton >= 0) {
        this.flipped = this.pressButton;
        this.draw();
        this.options.onButtonPress?.(this.pressButton);
      }
    }
    if (released) {
      const button = this.pressButton;
      const pressedRow = this.pressRow;
      this.pressButton = -1;
      this.pressRow = -1;
      if (button >= 0) {
        this.flipped = -1; // `$59C8`: flip back, silent, then the handler
        this.draw();
        return { kind: "icon", index: button };
      }
      if (pressedRow >= 0) {
        this.closeList();
        return pressedRow >= MUSIC_TRACK_ROWS ? { kind: "listClosed" } : { kind: "track", track: pressedRow };
      }
    }
    if (rightPressed) {
      if (this.list !== "closed") {
        this.closeList();
        return { kind: "listClosed" };
      }
      return { kind: "remake" };
    }
    return null;
  }
}
