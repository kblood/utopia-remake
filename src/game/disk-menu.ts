// The disk menu (`$7E52` sets it up, `$7EF6` is its loop): the original picture with nine 32 x 32 icon buttons, the black 10-row
// list panel and the message areas. ONE scene covers the landing page and the shared list (`$938D` = 4, the music-select list),
// exactly as the original keeps both on the same screen. Everything here comes from the static Disk.1 trace in
// notes/formats/music.md ("Music-select flow") and notes/formats/sfx.md ("Button click call paths"); the picture, text and labels
// are read from the user's own disk at run time and never stored.
//
// The scene owns pixels and input only. What an icon DOES (music, effects, exit, tutorial, the save-disk family) is decided by
// `Game`, which receives `{ kind: "icon" }` on the release. Remake-only behaviour is marked as such below:
//   * right button: closes an open music list, does nothing on the scenario list (no original route), otherwise asks for the
//     remake submenu (the original loop ignores the right button),
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
 * `$88F0` (scenario pick): "Scenario loaded. Select 'EXIT' to play.", printed by `$8462` on the list PROMPT (y `$A3`), not the result
 * line, and never erased by a countdown. `$88F0` returns into the loop without `$82B8` and leaves `$938D` (mode 3) alone, so the list
 * stays open and a later row release picks again; the prompt stays until the list closes or EXIT enters the picked scene. The remake
 * shows it on the list prompt (`printPrompt`, game.ts `pickScenario`). A right click does not close the scenario list (see `update`).
 */
export const SCENARIO_LOADED_STRING = 0x8b;
/**
 * `$855A` (icon 2, after its click): "Insert scenario disk in internal drive and click mouse button..", printed on the list prompt by
 * `$8462` (`move.w #$13B,d0`). `$2E48` then waits for the left button to go DOWN with a raw poll (`btst.b #6,$bfe001`): no latch,
 * no row or icon test, and the right button is not read. The list opens after that press (`$84F4` erases this line first).
 * The remake shows it while its scenario wait runs (game.ts `awaitScenarioPress`).
 */
export const SCENARIO_WAIT_STRING = 0x13b;
/**
 * `$865A` (mode 3, after the disk check): `move.w #$13D,d0; bsr $85CA`. `$85CA` prints d0 on the list prompt (`$8462`, first line, y `$A3`)
 * and then draws the ten scenario rows (`$85D2`-`$85F8`). The prompt is shown while the list is open, until a pick replaces it
 * (`SCENARIO_LOADED_STRING`) or the list closes. Static trace, Disk.1 raw bytes (2026-11-14, notes/formats/game-proper.md).
 */
export const SCENARIO_OPEN_STRING = 0x13d;
/**
 * `$88CA` (load, mode 2): "Game loaded. Select 'EXIT' to play." It is printed on the list prompt (`$8462`), and the load's `bra $82B8`
 * (`$88EA`) erases the prompt. `$84F4` waits for the next VBL before erasing (`$851A`-`$8522`), so the original's text is up for one
 * VBL interval (printed at VBL C, erased at VBL C+1; test/load-message-trace.mjs). Whether that field shows it depends on the raster
 * and the handler's length, and the start is after the disk reads (`$7D96`) and the disk-header check (`$8A5A`), whose length is not
 * measured. The remake's slot load and Disk.4 pick (both the mode-2 `$8828` path) therefore show none; no frame is modelled
 * (game-proper.md, "Load success message").
 */
export const GAME_LOADED_STRING = 0x145;
/**
 * The save tail `$89B4` (`$8A34`): the last message, printed on the list prompt line 0 (`$8462`) after the slot is written, and the
 * loop then continues without an exit (`$8A40` `rts` -> `$7FDC` `bra $7EF6`; notes/formats/game-proper.md "Save tail"). The tail's
 * `$84F4` erased the prompt first, so this is the only prompt line until a traced erase (`$84F4` / `$82B8`).
 */
export const SAVE_DONE_STRING = 0x141;
/**
 * `$85B8` (icon 1, mode 1): "Click on slot to save game into...", printed on the list prompt (`$85CA` -> `$8462`) when the save list
 * opens, after `$855A`'s erase. The remake shows it on its save page's status line while the page is open.
 */
export const SAVE_OPEN_STRING = 0x138;
/**
 * The save name step (`$8918`, save-name.ts): `$13E` "Game will be saved as 'xxxxxxxxxx'..." (its 15-byte placeholder is overwritten
 * by the default name, and the line is printed up to that name's NUL), `$13F` "Click mouse to use this name, or press 'RETURN' to edit
 * name..", and `$142` "Enter new name. 'RETURN' to finish..." (`$8974`, the entry's line). Read from Disk.1 by test/save-name.mjs.
 */
export const SAVE_NAME_STRING = 0x13e;
export const SAVE_NAME_CLICK_STRING = 0x13f;
export const SAVE_NAME_EDIT_STRING = 0x142;

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
 * The list geometry shared by every list on the disk picture: `$8132` (hover), `$818C` (bar), and the rows `$539E` draws (`$1006` for
 * the music list, `$85D2`-`$85F8` for the scenario list): x `$3A`, y `$20 + 9n`, each row an 11-byte, 6-scanline `$51E6` erase, then the
 * text. Traced statically (notes/formats/music.md, game-proper.md "Scenario list rows"); the same values serve both lists.
 */
export const DISK_LIST_GEOMETRY = {
  x0: MUSIC_LIST.x0,
  x1: MUSIC_LIST.x1,
  y0: MUSIC_LIST.y0,
  pitch: MUSIC_LIST.pitch,
  labelX: MUSIC_LIST.labelX,
  /** `$85DC` / `$1030`: `moveq #$0B,d2`, the erase is `d2 + 1` = 11 byte columns, and `$51E6` covers 6 scanlines. */
  eraseBytes: 11,
  eraseRows: MESSAGE_AREA.lineHeight,
  barX: MUSIC_LIST.barX,
  barWidth: MUSIC_LIST.barWidth,
  barHeight: MUSIC_LIST.barHeight,
  barColor: MUSIC_LIST.barColor,
} as const;

/**
 * `$53xx` opaque text, `$51E6` erase: fills `rows` scanlines from y, `bytes` bytes wide from the byte that holds x (`x / 8`, so the
 * fill starts at `floor(x / 8) * 8`), with the eight-pixel pattern sampled from `background` at `MESSAGE_PATTERN_SAMPLE`. Pattern row =
 * screen row & 7; pattern column = screen column & 7. `$51E6` (static, Disk.1): `d2` = `bytes` (the caller's `d2 + 1` loop count),
 * the strip starts at `y * 40 + x / 8`, and the sampled block is repeated per row with the phase `y & 7`.
 */
export function eraseBandPattern(screen: Screen, background: Uint8Array, x: number, y: number, bytes: number, rows: number): void {
  const sample = MESSAGE_PATTERN_SAMPLE;
  const left = Math.floor(x / 8) * 8;
  for (let row = y; row < y + rows; row++) {
    const patternY = row & 7;
    for (let px = left; px < left + bytes * 8; px++) {
      const source = (sample.y + patternY) * 320 + sample.x + (px & 7);
      screen.set(px, row, background[source]);
    }
  }
}

/**
 * `$83F2` stores 20000 (`$4E20`) in `$8CB0` after every result message; the loop `$7EF6` decrements it once per iteration and, at 0,
 * erases both result lines (`$7F0C`-`$7F68`). The unit is loop iterations of a mouse-polling busy loop, not frames, so the wall time
 * is not known statically, and the countdown is CPU-bound (no VBL wait inside the loop), so the wall time depends on the machine.
 * REFERENCE PROFILE (EMULATOR, Copperline 1.0.1, A1200 / 68020 / PAL, 2026-11-10; notes/formats/screens-misc.md): two messages
 * (`$195` effects, `$196` music) each lasted 53 VBLs from the `$83FC` return to the `$7F0C` erase (about 52.9 fields of 70,938 CCK),
 * with 20000 passes each. The previous guess of 50 frames (1 s) was about 3 frames short on this machine. Other CPUs (for example the
 * 68000 of the A600 profile) were not measured for this countdown, so the value is a reference profile, not a universal constant.
 */
export const INFO_LIFETIME_FRAMES = 53;

/** The list open on the picture: none, the music-select list (mode 4), or the scenario list (mode 3). */
export type DiskListKind = "closed" | "music" | "scenario";

/** What a call of `update` can report. */
export type DiskMenuResult =
  /** Row 0-3 of the open list, acted on after the release (`$2E52`); `$110A` restarts that module even if it plays. The list is closed (`$8A46` -> `$82B8`). */
  | { readonly kind: "track"; readonly track: number }
  /**
   * Mode 3: a row released on the open scenario list (`$7FCE` -> `$2E52` -> `$87DC` -> `$88F0`). The list STAYS open (`$88F0` does not
   * write `$938D` or close it), so the caller holds the scenario and the next release picks again.
   */
  | { readonly kind: "scenario"; readonly index: number }
  /** Rows 4-9 of the music list released (`$110A` -> `$82B8`) or the remake's right click on the music list: it is closed, the music is not touched. */
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
  private readonly musicLabels: number[][];
  // The labels of the open list's rows (the music names, or the record names of the scenario list).
  private rowLabels: readonly (readonly number[])[] = [];
  private list: DiskListKind = "closed";
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
    this.musicLabels = readMusicLabels(disk);
    this.draw();
  }

  /** True while a list is open: the music-select list (mode 4) or the scenario list (mode 3). */
  get listOpen(): boolean {
    return this.list !== "closed";
  }

  /** Which list is open (`closed` when none). */
  get listKind(): DiskListKind {
    return this.list;
  }

  /** The open list's row labels, as character codes (the music names, or the scenario record names); empty while closed. */
  get listRows(): readonly (readonly number[])[] {
    return this.list === "closed" ? [] : this.rowLabels;
  }

  /** The first prompt line's character codes (`$8462`), or null when it is empty. */
  get promptCodes(): readonly number[] | null {
    return this.prompt[0].index === 0 ? null : this.prompt[0].codes;
  }

  /** The string index on the first prompt line (0 for none): what `printPrompt` last showed there. */
  get promptIndex(): number {
    return this.prompt[0].index;
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

  /** Character codes of the two result lines (`$83A2`); empty for a line with nothing printed. */
  get infoCodes(): readonly (readonly number[])[] {
    return this.info.map((line) => (line.index === 0 ? [] : line.codes));
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
    this.rowLabels = this.musicLabels;
    this.prompt = [this.line(MUSIC_PROMPT_STRING), EMPTY];
    this.draw();
    return true;
  }

  /**
   * `$865A` (mode 3): the scenario list over the disk picture. `$85CA` prints `$13D` on the list prompt, then the rows are drawn
   * (`$85D2`-`$85F8`), one per record name (`names`, at most the ten rows of the list). The list stays open: a right click does nothing
   * (no original route) and it closes only through EXIT (icon 5) or a page icon; a row release picks (`scenario` result). `pressPending`: opened by icon 2's wait (`$2E48`),
   * so a button still down at the next update is a press (the first list poll, `$50B2`); without it the button is taken as up.
   */
  openScenarioList(names: readonly (readonly number[])[], pressPending: boolean): void {
    this.list = "scenario";
    this.hover = -1;
    this.rowLabels = names.slice(0, MUSIC_LIST.rows);
    this.printPrompt(SCENARIO_OPEN_STRING);
    if (pressPending) this.wasDown = false;
  }

  /**
   * `$8462` (first prompt line, d1 = 0): prints a string on the list prompt without opening a list. The save tail uses it for
   * `SAVE_DONE_STRING` after the slot is written, and a scenario pick for `SCENARIO_LOADED_STRING`; the list rows of the original's
   * save page and the scenario list's rows are not drawn by the remake's save and load pages. No countdown starts (the prompt has none).
   */
  printPrompt(index: number): void {
    this.prompt = [this.line(index), EMPTY];
    this.promptEraseBytes = [MESSAGE_AREA.prompt.printBytes, this.promptEraseBytes[1]];
    this.draw();
  }

  /**
   * The open list's rows, as `$1006` and `$85CA` draw them (`$539E` per row): the `$51E6` erase, then the hover bar on the hovered row,
   * then the text in colour 1 (`$156AB`). Blank rows (the music list's rows 4-9) are erased too.
   */
  private drawRows(): void {
    const g = DISK_LIST_GEOMETRY;
    this.rowLabels.forEach((label, i) => {
      const y = g.y0 + i * g.pitch;
      eraseBandPattern(this.screen, this.background, g.labelX, y, g.eraseBytes, g.eraseRows);
      if (i === this.hover) {
        for (let py = y; py < y + g.barHeight; py++) {
          for (let px = g.barX; px < g.barX + g.barWidth; px++) this.screen.set(px, py, g.barColor);
        }
      }
      drawGameText(this.disk, this.screen, label, g.labelX, y, COLOR.text);
    });
  }

  private draw(): void {
    const screen = this.screen;
    screen.pixels.set(this.background);
    const a = MESSAGE_AREA;
    this.fillMessageErase(a.prompt.y[0], this.promptEraseBytes[0]);
    this.fillMessageErase(a.prompt.y[1], this.promptEraseBytes[1]);
    this.fillMessageErase(a.info.y[0], this.infoEraseBytes[0]);
    this.fillMessageErase(a.info.y[1], this.infoEraseBytes[1]);
    this.prompt.forEach((line, i) => drawGameText(this.disk, screen, line.codes, a.x, a.prompt.y[i], COLOR.text));
    this.info.forEach((line, i) => drawGameText(this.disk, screen, line.codes, a.x, a.info.y[i], COLOR.text));
    if (this.list !== "closed") this.drawRows();
    if (this.flipped >= 0) {
      const r = DISK_MENU_BUTTONS[this.flipped];
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) screen.pixels[y * 320 + x] ^= ICON_FLIP_COLOR;
      }
    }
  }

  /** `$51E6` repeats the sampled eight-pixel row at each eight-pixel horizontal step, with screen-y phase (`eraseBandPattern`). */
  private fillMessageErase(y0: number, bytes: number): void {
    eraseBandPattern(this.screen, this.background, MESSAGE_AREA.x, y0, bytes, MESSAGE_AREA.lineHeight);
  }

  /**
   * The result lines' countdown (`$83F2`), one step per frame. Split out so a caller that does not run the menu's `update` (the
   * scenario wait, which is a raw button poll in the original) still lets the lines expire.
   */
  tickInfo(): void {
    if (this.infoFrames > 0 && --this.infoFrames === 0) {
      this.info = [EMPTY, EMPTY];
      this.infoEraseBytes = [MESSAGE_AREA.info.printBytes, MESSAGE_AREA.info.printBytes];
      this.draw();
    }
  }

  /** Row under the pointer (`$8132`) among the open list's rows, or -1. A row past the list's labels (fewer records) is not a row. */
  private rowAt(x: number, y: number): number {
    const row = musicRowAt(x, y);
    return row >= 0 && row < this.rowLabels.length ? row : -1;
  }

  /** One update per frame (50 Hz). */
  update(input: Input): DiskMenuResult | null {
    this.tickInfo();

    const down = input.leftButton;
    // `$7F80` branches back to the menu loop while the right button is held, before handling left-button edges.
    // Right-click navigation below is a remake convenience; a simultaneous left edge must not also activate an icon/row.
    const pressed = down && !this.wasDown && !input.rightButton;
    const released = !down && this.wasDown && !input.rightButton;
    this.wasDown = down;
    const rightPressed = input.rightButton && !this.wasRight;
    this.wasRight = input.rightButton;

    // `$8132`: the hover row only exists while a list is open.
    const row = this.list === "closed" ? -1 : this.rowAt(input.pointerX, input.pointerY);
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
        if (this.list === "scenario") return { kind: "scenario", index: pressedRow }; // `$88F0`: the list stays open
        this.closeList();
        return pressedRow >= MUSIC_TRACK_ROWS ? { kind: "listClosed" } : { kind: "track", track: pressedRow };
      }
    }
    if (rightPressed) {
      // The original loop has no right-button route on the scenario list: the press only sets the bit that skips the left release
      // (`$50B2`, `$7F80`), so nothing changes. The music list's right click is the remake's own close (not traced to the original).
      if (this.list === "scenario") return null;
      if (this.list !== "closed") {
        this.closeList();
        return { kind: "listClosed" };
      }
      return { kind: "remake" };
    }
    return null;
  }
}
