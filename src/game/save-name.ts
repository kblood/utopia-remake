// The save-name step of the save page (static trace of Disk.1, file offset = address + `$28800`; notes/formats/game-proper.md,
// "Save name step"). A row release of the save list runs `$8918`: the prompt `$13E`/`$13F`, then a loop on the key cell `$161A0`
// and the left button. A press (and its release, `$2E52`) saves under the default name at once; Return (`$44`) enters the name
// entry `$5110`, which builds a new name from the key table `$64C8`. This module is the pure key and click model of that step; the
// page and the write are in `Game` (game.ts). Raw bytes behind every constant here are checked by test/save-name.mjs.
import { isEnterKey, typedDigit, type Input } from "./intro.js";

/** `$8986`: `moveq #$10,d4`. `$5110` stops taking characters when the length (d5) equals d4, so 16 characters can be typed. */
export const NAME_TYPED_MAX = 16;

/** `$89B4`: the save tail copies 15 bytes of the `$161AA` buffer into the slot's header record, so only the first 15 are stored. */
export const SAVED_NAME_LENGTH = 15;

/** Width in characters of the wrapped prompt lines (REMAKE layout choice: the save page's panel is 240 px wide). */
export const NAME_PROMPT_COLUMNS = 40;

/**
 * The key table `$64C8` of the name entry (`$5110`, `$5182`-`$518E`): pairs of raw key code and character, 53 pairs, scanned in
 * order. Read from Disk.1 by test/save-name.mjs (raw bytes), not typed from the trace.
 */
export const NAME_KEY_TABLE: readonly (readonly [number, string])[] = [
  [0x10, "Q"], [0x11, "W"], [0x12, "E"], [0x13, "R"], [0x14, "T"], [0x15, "Y"], [0x16, "U"], [0x17, "I"], [0x18, "O"], [0x19, "P"],
  [0x20, "A"], [0x21, "S"], [0x22, "D"], [0x23, "F"], [0x24, "G"], [0x25, "H"], [0x26, "J"], [0x27, "K"], [0x28, "L"],
  [0x31, "Z"], [0x32, "X"], [0x33, "C"], [0x34, "V"], [0x35, "B"], [0x36, "N"], [0x37, "M"],
  [0x0c, "="], [0x0b, "-"], [0x0d, "\\"], [0x38, ","], [0x39, "."], [0x3a, "/"], [0x40, " "],
  [0x01, "1"], [0x02, "2"], [0x03, "3"], [0x04, "4"], [0x05, "5"], [0x06, "6"], [0x07, "7"], [0x08, "8"], [0x09, "9"], [0x0a, "0"],
  [0x0f, "0"], [0x1d, "1"], [0x1e, "2"], [0x1f, "3"], [0x2d, "4"], [0x2e, "5"], [0x2f, "6"], [0x3d, "7"], [0x3e, "8"], [0x3f, "9"],
];

/** The characters a name can hold: the table's characters (uppercase letters, digits, and `- = \ , . /` and space). */
const NAME_CHARACTERS = new Set(NAME_KEY_TABLE.map(([, c]) => c));

/** Symbol keys whose `KeyboardEvent.key` is the table's character unshifted (the remake's key tokens carry `key`, not the raw code). */
const SYMBOL_KEYS = new Set(["-", "=", "\\", ",", ".", "/", " "]);

/**
 * The character a key types in the name entry, or undefined for a key the table does not map. Letters are upper case (the raw codes
 * carry no case). Top-row and keypad digits are the table's digits. Shifted symbols (`_`, `+`, ...) are not mapped: the original's
 * raw code for those keys is a table key, but the remake's key token is the shifted character.
 */
export function typedCharacter(entry: string): string | undefined {
  if (/^[a-zA-Z]$/.test(entry)) return entry.toUpperCase();
  const digit = typedDigit(entry);
  if (digit !== undefined) return digit;
  return SYMBOL_KEYS.has(entry) ? entry : undefined;
}

/** A name the save record can hold: 1..15 characters, all of them in the entry's table. The date default always qualifies. */
export function isSaveName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= SAVED_NAME_LENGTH && Array.from(value).every((c) => NAME_CHARACTERS.has(c));
}

/** Greedy word wrap at `columns` characters; a word longer than a line is cut. Used for the remake's prompt lines only. */
export function wrapWords(text: string, columns = NAME_PROMPT_COLUMNS): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0).flatMap((w) => w.match(new RegExp(`.{1,${columns}}`, "g")) ?? []);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length <= columns) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

export type NameOutcome = { readonly kind: "confirm"; readonly name: string } | { readonly kind: "cancel" };

/**
 * The name step after the row release. `prompt` is the `$8958` loop: Return (main key only, `$44`) starts the entry; a left press
 * followed by its release saves under the default name (`$2E52`, `bra $89B4`); keypad Enter and every other key are ignored there.
 * `edit` is `$5110`: characters are typed (16 at most), Backspace (`$41`) deletes one, Return or keypad Enter (`$44`/`$43`) finishes
 * with at least one character, and the mouse is not read. REMAKE choices with no traced counterpart: Escape and the right button
 * cancel in both phases (the original has no cancel; its loop exits only by a save).
 *
 * `update` consumes the keys it reads from `input.keys`, like `NumberEntry`. It returns null while the step is open.
 */
export class SaveNameEntry {
  phase: "prompt" | "edit" = "prompt";
  /** The name being typed (edit phase), as typed: at most `NAME_TYPED_MAX` characters. */
  text = "";
  private down: boolean | null = null;
  private rightDown: boolean | null = null;
  private latched = false;

  constructor(readonly defaultName: string) {}

  update(input: Input): NameOutcome | null {
    if (this.down === null) {
      this.down = input.leftButton;
      this.rightDown = input.rightButton;
    }
    const pressed = input.leftButton && !this.down;
    const released = !input.leftButton && this.down;
    const rightPressed = input.rightButton && !this.rightDown;
    this.down = input.leftButton;
    this.rightDown = input.rightButton;
    if (rightPressed) return { kind: "cancel" };

    const keys = input.keys ?? [];
    if (this.phase === "prompt") {
      const lastKey = keys.at(-1);
      if (lastKey === "Escape") {
        keys.pop();
        return { kind: "cancel" };
      }
      // `$8958` compares the one raw-key cell with Return but leaves every other value in place. Preserve ignored events so
      // a key waiting before the name prompt is still the cell's value after the default-name click save returns to the menu.
      // The original cell is last-wins: a Return followed by its release is not a Return at the poll.
      if (lastKey === "Enter") {
        this.phase = "edit";
        this.text = "";
        this.latched = false;
        keys.splice(0); // Return enters `$5110`, whose setup clears the pending key cell.
      }
    }
    if (this.phase === "edit" && keys.length > 0) {
      // Like `$161A0`, the browser batch represents one raw key cell here: the last event before this update is the one read.
      const key = keys.pop()!;
      keys.splice(0);
      if (key === "Escape") return { kind: "cancel" };
      if (isEnterKey(key)) {
        if (this.text.length > 0) return { kind: "confirm", name: this.text.slice(0, SAVED_NAME_LENGTH) };
      } else if (key === "Backspace") {
        this.text = this.text.slice(0, -1);
      } else {
        const character = typedCharacter(key);
        if (character !== undefined && this.text.length < NAME_TYPED_MAX) this.text += character;
      }
    }

    if (this.phase === "prompt") {
      if (pressed) this.latched = true;
      if (released && this.latched) return { kind: "confirm", name: this.defaultName };
    }
    return null;
  }
}
