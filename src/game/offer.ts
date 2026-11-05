// Earth dialogs ($DECC): colonist offer ($110FE) and scientist requisition ($111A6). Text and
// coordinates follow the call sites (title (108,33), body (56,48), amount (56,99), question
// (56,117)); the original's two bitmap buttons are replaced by plain text buttons.

import { COLOR, drawGameText } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import type { Screen } from "../gfx/screen.js";
import type { Input } from "./intro.js";
import type { Offer } from "./sim.js";

const PLACEHOLDER = 0x78; // 'x'
const LINE_BREAK = 0xff;
const QUESTION = 0xe3;
const TEXTS = {
  colonists: { title: 0xe0, body: 0xe1, amount: 0xe2 },
  scientists: { title: 0xe4, body: 0xe5, amount: 0xe6 },
} as const;
const BUTTONS = [
  { label: "ACCEPT", x: 76, y: 140, w: 72, h: 16, accept: true },
  { label: "REFUSE", x: 172, y: 140, w: 72, h: 16, accept: false },
];
const PANEL = { x: 44, y: 24, w: 232, h: 140 };

// Replaces the run of placeholder letters by `value`, right aligned.
export function fillNumber(text: number[], value: number): number[] {
  const first = text.indexOf(PLACEHOLDER);
  if (first < 0) return text;
  let last = first;
  while (text[last + 1] === PLACEHOLDER) last++;
  const digits = String(Math.max(0, Math.floor(value))).padStart(last - first + 1, " ");
  const out = text.slice();
  for (let i = 0; i < digits.length; i++) out[first + i] = digits.charCodeAt(i);
  return out;
}

function lines(text: number[]): number[][] {
  const out: number[][] = [[]];
  for (const c of text) {
    if (c === LINE_BREAK) out.push([]);
    else out[out.length - 1].push(c);
  }
  return out;
}

export class OfferScene {
  private wasDown = true;

  constructor(
    private readonly disk: Uint8Array,
    private readonly strings: GameStrings,
    readonly offer: Offer,
  ) {}

  // Returns true (accept) or false (refuse) once a button is clicked, otherwise null.
  update(input: Input): boolean | null {
    const pressed = input.leftButton && !this.wasDown;
    this.wasDown = input.leftButton;
    if (!pressed) return null;
    const hit = BUTTONS.find((b) => input.pointerX >= b.x && input.pointerX < b.x + b.w && input.pointerY >= b.y && input.pointerY < b.y + b.h);
    return hit ? hit.accept : null;
  }

  draw(screen: Screen): void {
    for (let y = PANEL.y; y < PANEL.y + PANEL.h; y++) {
      for (let x = PANEL.x; x < PANEL.x + PANEL.w; x++) screen.pixels[y * 320 + x] = 0;
    }
    this.frame(screen, PANEL.x, PANEL.y, PANEL.w, PANEL.h);
    const set = TEXTS[this.offer.what];
    const amount = this.offer.what === "colonists" ? this.offer.count : this.offer.price;
    const text = (index: number, y: number, colour: number, value?: number): void => {
      // String $E1 starts with a patch-offset byte for the original's number routine, not a letter.
      const raw = index === 0xe1 ? this.strings.get(index).slice(1) : this.strings.get(index);
      const filled = value === undefined ? raw : fillNumber(raw, value);
      lines(filled).forEach((line, i) => drawGameText(this.disk, screen, line, 56, y + 9 * i, colour));
    };
    drawGameText(this.disk, screen, this.strings.get(set.title), 108, 33, COLOR.highlight);
    text(set.body, 48, COLOR.text, this.offer.count);
    text(set.amount, 99, COLOR.text, amount);
    text(QUESTION, 117, COLOR.highlight);
    for (const b of BUTTONS) {
      this.frame(screen, b.x, b.y, b.w, b.h);
      drawGameText(this.disk, screen, Array.from(b.label, (c) => c.charCodeAt(0)), b.x + 12, b.y + 4, COLOR.highlight);
    }
  }

  private frame(screen: Screen, x: number, y: number, w: number, h: number): void {
    for (let i = 0; i < w; i++) {
      screen.set(x + i, y, COLOR.text);
      screen.set(x + i, y + h - 1, COLOR.text);
    }
    for (let j = 0; j < h; j++) {
      screen.set(x, y + j, COLOR.text);
      screen.set(x + w - 1, y + j, COLOR.text);
    }
  }
}
