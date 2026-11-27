// A plain list menu drawn with the game's own font over the main-screen picture. REMAKE presentation, not original screens: the
// remake submenu (remake save / load / new scenario / Disk.4), the slot lists and the error pages. The original's disk menu
// (`$7EF6`, picture, icons, the music and scenario lists) is `disk-menu.ts`, which also draws the scenario list (mode 3).

import { COLOR, drawGameText } from "../data/gamefont.js";
import { decodePicture, PICTURES } from "../data/picture.js";
import { Screen } from "../gfx/screen.js";
import type { Input } from "./intro.js";

const LEFT = 40;
const TOP = 40;
const ROW = 12;
const WIDTH = 240;
/** REMAKE ONLY: gap between the last entry and the prompt line of a page (see `setPrompt`). */
const PROMPT_GAP = 4;

/** Text column of the list: entries start at `left` and must stay left of `left + width` (the panel that `clearPanel` blanks). */
export const MENU_PANEL = { left: LEFT, width: WIDTH, top: TOP, row: ROW } as const;

export interface MenuEntry {
  label: string;
  enabled?: boolean;
}

/** REMAKE ONLY: how a page's entries are chosen. `press` (the default) on the left press over an enabled entry; `release` (the save and load pages) on the release of a press that began over an entry, the row being the one under the pointer at the press (the original's `$7FCE` -> `$2E52` -> `$8CFE`). */
export interface MenuOptions {
  readonly activate?: "press" | "release";
}

export class MenuScene {
  readonly screen = new Screen();
  // The picture as decoded: each redraw restores it first, so a prompt line that goes away leaves no pixels behind.
  private readonly background: Uint8Array;
  // The prompt lines under the entries (none, one, or several: the save name step prints wrapped lines). Each is a list of string codes.
  private prompts: (readonly number[])[] = [];
  private wasDown = true; // ignore the click that opened the menu
  private wasRight = true; // ... also a right click that is still held (the disk menu opens the remake submenu with one)
  private hover = -1;
  // `release` mode only: the entry the left press began on (-1 for none). Latched at the press, so the pointer's position at the release does not matter.
  private pressRow = -1;

  constructor(
    private readonly disk: Uint8Array,
    private readonly title: string,
    private readonly entries: MenuEntry[],
    private readonly options: MenuOptions = {},
  ) {
    decodePicture(disk, PICTURES.main, this.screen);
    this.background = this.screen.pixels.slice();
    this.clearPanel();
    this.draw();
  }

  private clearPanel(): void {
    const height = 16 + this.entries.length * ROW + 8 + (this.prompts.length === 0 ? 0 : PROMPT_GAP + this.prompts.length * ROW);
    for (let y = TOP - 6; y < TOP - 6 + height; y++) {
      for (let x = LEFT - 8; x < LEFT + WIDTH; x++) this.screen.pixels[y * 320 + x] = 0;
    }
  }

  private codes(text: string): number[] {
    return Array.from(text.toUpperCase(), (c) => c.charCodeAt(0));
  }

  private draw(): void {
    this.screen.pixels.set(this.background);
    this.clearPanel();
    drawGameText(this.disk, this.screen, this.codes(this.title), LEFT, TOP, COLOR.highlight);
    this.entries.forEach((entry, i) => {
      const colour = entry.enabled === false ? COLOR.text : i === this.hover ? COLOR.highlight : COLOR.text + 0;
      drawGameText(this.disk, this.screen, this.codes(entry.label), LEFT, TOP + 16 + i * ROW, colour);
    });
    this.prompts.forEach((line, i) => {
      drawGameText(this.disk, this.screen, line, LEFT, TOP + 16 + this.entries.length * ROW + PROMPT_GAP + i * ROW, COLOR.text);
    });
  }

  /** The entry index under the pointer (-1 for none). */
  private rowAt(x: number, y: number): number {
    const row = Math.floor((y - (TOP + 16)) / ROW);
    return x >= LEFT && x < LEFT + WIDTH && row >= 0 && row < this.entries.length ? row : -1;
  }

  /**
   * REMAKE ONLY: a prompt line under the entries, in the panel. The position is a remake layout choice, not a traced one.
   * `null` removes it.
   */
  setPrompt(codes: readonly number[] | null): void {
    this.prompts = codes === null ? [] : [codes];
    this.draw();
  }

  /** REMAKE ONLY: several prompt lines in order (the save name step's wrapped text); an empty list removes them. */
  setPromptLines(lines: readonly (readonly number[])[]): void {
    this.prompts = lines.slice();
    this.draw();
  }

  /** REMAKE ONLY: `setPrompt` with a remake message (text, not a string-table code); null removes the line. */
  setPromptText(text: string | null): void {
    this.setPrompt(text === null ? null : this.codes(text));
  }

  /** The first prompt line as set (null: none). The other lines of `setPromptLines` are not reported here. */
  get promptCodes(): readonly number[] | null {
    return this.prompts.length === 0 ? null : this.prompts[0];
  }

  /** All prompt rows as set, for a temporary interaction to restore the status line it replaced. */
  get promptLines(): readonly (readonly number[])[] {
    return this.prompts.map((line) => line.slice());
  }

  /** REMAKE ONLY: the text of entry `index` (the save name step shows the name being typed on its slot row); no-op when unchanged. */
  setEntryLabel(index: number, label: string): void {
    if (index < 0 || index >= this.entries.length || this.entries[index].label === label) return;
    this.entries[index] = { ...this.entries[index], label };
    this.draw();
  }

  /**
   * Returns the chosen entry (-1 for a right press: cancel), else null. `press` mode chooses on the left press; `release` mode latches
   * the entry under the pointer at the press and chooses it on the release, wherever the pointer is then (a press that began off the
   * entries chooses nothing).
   */
  update(input: Input): number | null {
    const wasDown = this.wasDown;
    const pressed = input.leftButton && !wasDown;
    const released = !input.leftButton && wasDown;
    this.wasDown = input.leftButton;
    const rightPressed = input.rightButton && !this.wasRight;
    this.wasRight = input.rightButton;
    const row = this.rowAt(input.pointerX, input.pointerY);
    const enabled = row >= 0 && this.entries[row].enabled !== false;
    if (row !== this.hover) {
      this.hover = row;
      this.draw();
    }
    if (rightPressed) {
      this.pressRow = -1;
      return -1;
    }
    if (this.options.activate === "release") {
      if (pressed) this.pressRow = row;
      if (!released) return null;
      const latched = this.pressRow;
      this.pressRow = -1;
      return latched >= 0 && this.entries[latched].enabled !== false ? latched : null;
    }
    return pressed && enabled ? row : null;
  }
}
