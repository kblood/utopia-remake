// Intelligence window ($E2D2, icon column button 7): grant, level, scenario reports and portraits.

import { COLOR, wrapText } from "../../data/gamefont.js";
import type { Screen } from "../../gfx/screen.js";
import { A, type GameState } from "../state.js";
import { PanelScene } from "./panel.js";
import type { IntelligenceAssets, ScreenContext } from "./types.js";
import { drawPlanar } from "./planar.js";
import { NumberEntry, Ui } from "./ui.js";

export const INTEL = {
  grant: 0x1446a,
  level: 0x144ca,
} as const;

const LEVEL_STRING = 0x18b; // + level
const GRANT_LEVELS = [5000, 20000]; // grant from which level 2 / level 3 apply
const REPORT_FLAGS = 0x1447c;
const REPORT_TABLE = 0x13ee6;
const REPORT_STRIDE = 0x2a;
const REPORT_SLOTS = 16;
const REPORT_TYPES = 6;
const PORTRAIT_BYTES = 8 * 64 * 5;

type ReportLine = number[];

function replaceAt(bytes: number[], offset: number, replacement: number[]): number[] {
  if (offset < 0 || offset > bytes.length) return bytes;
  return [...bytes.slice(0, offset), ...replacement, ...bytes.slice(offset + replacement.length)];
}

function reportGameString(state: GameState, strings: ScreenContext["strings"], index: number): number[] {
  const bytes = strings.get(index);
  const at = strings.placeholder(index);
  if (at < 0) return bytes;
  if (index === 0x154) return replaceAt(bytes, at, [state.byte(0x141b0), state.byte(0x141b1)]);
  if (index === 0x155 || index === 0x15e) return replaceAt(bytes, at, [state.byte(0x13467) + 0x30]);
  if (index >= 0x161 && index <= 0x164) {
    const replacement: number[] = [];
    for (let address = 0x13456; address < 0x13534; address++) {
      const ch = state.byte(address);
      if (ch === 0) break;
      replacement.push(ch);
    }
    return replaceAt(bytes, at, replacement);
  }
  return bytes;
}

function reportText(table: Uint8Array, index: number): number[] {
  if (index <= 0 || (index - 1) * 2 + 1 >= table.length) return [];
  const p = (index - 1) * 2;
  let at = (table[p] << 8) | table[p + 1];
  if (at >= table.length) return [];
  const bytes: number[] = [];
  while (at < table.length && table[at] !== 0) bytes.push(table[at++]);
  return bytes;
}

function reportLines(state: GameState, strings: ScreenContext["strings"], assets?: IntelligenceAssets): { lines: ReportLine[]; portrait: number } {
  const lines: ReportLine[] = [];
  const sourceLevel = state.byte(INTEL.level);
  if (sourceLevel === 0) return { lines, portrait: 0 };
  const level = Math.min(3, sourceLevel);
  // $E324 checks categories 6..1, and within each category scans event slots 15..0.
  // The screen is redrawn for each match without waiting; the final match stays visible.
  let selected = 0; // $E366 falls back to slot 0 when nothing matched.
  found: {
  for (let category = 1; category <= REPORT_TYPES; category++) {
    for (let slot = 0; slot < REPORT_SLOTS; slot++) {
      if (state.byte(REPORT_FLAGS + slot * 2) === category) {
        selected = slot;
        break found;
      }
    }
  }
  }
  if (state.byte(REPORT_FLAGS + selected * 2) === 0) return { lines, portrait: 0 };

  const base = REPORT_TABLE + selected * REPORT_STRIDE;
  const record = base + 4 + (level - 1) * 12;
  for (let i = 0; i < 3; i++) {
    const textIndex = state.word(record + i * 2);
    if (textIndex !== 0) lines.push(reportGameString(state, strings, textIndex));
  }
  if (assets) for (let i = 0; i < 3; i++) {
    const textIndex = state.word(record + 6 + i * 2);
    if (textIndex !== 0) lines.push(reportText(assets.text, textIndex));
  }
  return { lines, portrait: state.byte(base + 0x28) };
}

// $AD70: intelligence level from the grant (0 = none, 1 low, 2 normal, 3 special operatives).
export function intelLevel(grant: number): number {
  if (grant === 0) return 0;
  if (grant < GRANT_LEVELS[0]) return 1;
  if (grant < GRANT_LEVELS[1]) return 2;
  return 3;
}

// $E4D6-$E52C: move money into the intelligence grant (never more than the colony has).
export function fundIntelligence(state: GameState, amount: number): void {
  const money = state.signedLong(A.money);
  const paid = Math.min(amount, money);
  state.setLong(INTEL.grant, (state.long(INTEL.grant) + paid) >>> 0);
  state.setLong(A.money, (money - paid) >>> 0);
  state.setByte(INTEL.level, intelLevel(state.long(INTEL.grant)));
}

export class IntelScreen extends PanelScene {
  private entry: NumberEntry | null = null;

  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xf110), 0xf118, ui);
  }

  protected override get modal(): boolean {
    return this.entry !== null;
  }

  // Buttons 8 and 9 leave; the others do nothing here.
  protected override onButton(index: number): "running" | "close" {
    return index >= 8 ? "close" : "running";
  }

  protected override onClick(): void {
    if (this.entry) return;
    const y = this.pointer.y;
    if (y < 0x1d || y >= 0x26) return;
    this.entry = new NumberEntry(0x5e, 0x1d, 5, 6);
  }

  protected override onKeys(keys: string[]): boolean {
    const entry = this.entry;
    if (!entry) return false;
    entry.feed(keys);
    if (entry.done !== null) {
      fundIntelligence(this.state, entry.done);
      this.entry = null;
    } else if (entry.cancelled) {
      this.entry = null;
    }
    return true;
  }

  protected drawContent(screen: Screen): void {
    const s = this.state;
    const ui = this.ui;
    // The small window on the right ($F100) holds the report picture in the original.
    ui.frame(screen, ui.readWindow(0xf100));
    this.labels(screen, ui.readLabels(0xf144), COLOR.text);
    ui.str(screen, LEVEL_STRING + s.byte(INTEL.level), 0x66, 0x14, COLOR.highlight);
    ui.numbers(screen, [s.long(INTEL.grant)], 0x58, 0x1d, 6);
    ui.numbers(screen, [Math.min(s.signedLong(A.money), 999999)], 0xb2, 0x1d, 6);
    const reports = reportLines(s, this.ctx.strings, this.ctx.intelligence);
    const portraitAt = (reports.portrait - 1) * PORTRAIT_BYTES;
    if (reports.portrait > 0 && this.ctx.intelligence && portraitAt + PORTRAIT_BYTES <= this.ctx.intelligence.portraits.length) {
      drawPlanar(screen, this.ctx.intelligence.portraits, portraitAt, 8 * 64, 8, 64, 248, 10);
    }
    // $5A60 uses the text context at $15678: x=8, y=45, up to 16 wrapped rows, width=232.
    let y = 0x2d;
    let usedRows = 0;
    for (const line of reports.lines) {
      if (usedRows >= 16) break;
      const wrapped = wrapText(this.ctx.disk, line, 232);
      ui.text(screen, wrapped.text, 8, y, COLOR.text);
      usedRows += wrapped.lines;
      y += wrapped.lines * 9;
    }
    this.entry?.draw(ui, screen);
  }
}
