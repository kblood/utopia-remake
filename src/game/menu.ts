// A plain list menu drawn with the game's own font over the main-screen picture. REMAKE presentation, not original screens: the
// scenario choice, the remake submenu (remake save / load / new scenario / Disk.4), the slot lists and the error pages. The
// original's disk menu (`$7EF6`, picture + icons) is `disk-menu.ts`; its save-disk family, which needs floppies, has no
// counterpart on these pages other than the choices they keep.

import { COLOR, drawGameText } from "../data/gamefont.js";
import { decodePicture, PICTURES } from "../data/picture.js";
import { Screen } from "../gfx/screen.js";
import type { Input } from "./intro.js";

const LEFT = 40;
const TOP = 40;
const ROW = 12;
const WIDTH = 240;

export interface MenuEntry {
  label: string;
  enabled?: boolean;
}

export class MenuScene {
  readonly screen = new Screen();
  private wasDown = true; // ignore the click that opened the menu
  private wasRight = true; // ... also a right click that is still held (the disk menu opens the remake submenu with one)
  private hover = -1;

  constructor(
    private readonly disk: Uint8Array,
    private readonly title: string,
    private readonly entries: MenuEntry[],
  ) {
    decodePicture(disk, PICTURES.main, this.screen);
    this.clearPanel();
    this.draw();
  }

  private clearPanel(): void {
    const height = 16 + this.entries.length * ROW + 8;
    for (let y = TOP - 6; y < TOP - 6 + height; y++) {
      for (let x = LEFT - 8; x < LEFT + WIDTH; x++) this.screen.pixels[y * 320 + x] = 0;
    }
  }

  private codes(text: string): number[] {
    return Array.from(text.toUpperCase(), (c) => c.charCodeAt(0));
  }

  private draw(): void {
    this.clearPanel();
    drawGameText(this.disk, this.screen, this.codes(this.title), LEFT, TOP, COLOR.highlight);
    this.entries.forEach((entry, i) => {
      const colour = entry.enabled === false ? COLOR.text : i === this.hover ? COLOR.highlight : COLOR.text + 0;
      drawGameText(this.disk, this.screen, this.codes(entry.label), LEFT, TOP + 16 + i * ROW, colour);
    });
  }

  // Returns the chosen entry on a fresh left press, -1 for a right press (cancel), else null.
  update(input: Input): number | null {
    const pressed = input.leftButton && !this.wasDown;
    this.wasDown = input.leftButton;
    const rightPressed = input.rightButton && !this.wasRight;
    this.wasRight = input.rightButton;
    const row = Math.floor((input.pointerY - (TOP + 16)) / ROW);
    const inside = input.pointerX >= LEFT && input.pointerX < LEFT + WIDTH && row >= 0 && row < this.entries.length;
    const hover = inside ? row : -1;
    if (hover !== this.hover) {
      this.hover = hover;
      this.draw();
    }
    if (rightPressed) return -1;
    if (pressed && inside && this.entries[row].enabled !== false) return row;
    return null;
  }
}
