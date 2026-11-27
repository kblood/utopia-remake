// Staffing window ($BAAE, icon column button 6): per job pool the staff the player allows
// ($14500[pool]), the staff employed, required and short. A click on a row asks for a new
// staffing level and writes it back the way $BD1C-$BD6C does.

import { COLOR } from "../../data/gamefont.js";
import type { Screen } from "../../gfx/screen.js";
import type { GameState } from "../state.js";
import { PanelScene } from "./panel.js";
import type { ScreenContext } from "./types.js";
import { NumberEntry, Ui } from "./ui.js";

export const STAFF = {
  free: 0x13136,
  employed: 0x1313a,
  medics: 0x1313e,
  scientists: 0x13142,
  security: 0x13146,
  production: 0x143a6, // 6 longs, rows 0-5
  required: 0x143c6, // 9 longs: staff the buildings call for
  assigned: 0x143ea, // 9 longs: staff employed (pools 6-8 are medics, scientists, security)
  shortage: 0x1440e, // 9 longs: vacancies
  cap: 0x14500, // 9 longs: the player's staffing level
} as const;

const FIRST_ROW_Y = 40;
const ROW_STEP = 9;
const BLANK_ROW = 6; // row 6 of the list is a spacer
const POOLS = 9;
const ENTRY_X = 115;
const ENTRY_DIGITS = 4;
const STAFF_EXIT_BUTTON = 9; // the only button that leaves the window ($BC26-$BC30)

// Row on screen -> job pool ($BC8C-$BC9E: rows above the spacer shift down by one).
export function poolOfRow(row: number): number {
  return row >= 7 ? row - 1 : row;
}

// $BD1C-$BD6C: store the new staffing level of a pool, release staff above it and recompute
// the vacancies. Writes the same fields as the original ($14500, $143EA, $1440E, $13136, $1313A).
export function setStaffLevel(state: GameState, pool: number, level: number): void {
  const assigned = STAFF.assigned + 4 * pool;
  state.setLong(STAFF.cap + 4 * pool, level);
  const employed = state.long(assigned);
  const excess = (employed - level) | 0;
  let vacancies = 0;
  if (excess >= 0) {
    state.setLong(assigned, level);
    state.setLong(STAFF.employed, (state.long(STAFF.employed) - excess) >>> 0);
    state.setLong(STAFF.free, (state.long(STAFF.free) + excess) >>> 0);
  } else {
    const required = state.long(STAFF.required + 4 * pool);
    vacancies = (((level - required) | 0) >= 0 ? required : level) - employed;
  }
  state.setLong(STAFF.shortage + 4 * pool, vacancies >>> 0);
}

export class StaffingScreen extends PanelScene {
  private entry: NumberEntry | null = null;
  private pool = 0;

  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xe920), undefined, ui);
  }

  protected override get modal(): boolean {
    return this.entry !== null;
  }

  // The staffing loop ($BAAE, static trace of Disk.1): the release of button 9 leaves (`cmpi.b #9,d2` before `$BC5A`), and
  // a release of any other command button does nothing (`bra $BC0C`). Escape and the right button are not read.
  protected override onButton(index: number): "running" | "close" {
    return index === STAFF_EXIT_BUTTON ? "close" : "running";
  }

  // A click on a row (anywhere in the window) asks for the new level of that pool.
  protected override onClick(): void {
    if (this.entry) return;
    const offset = this.pointer.y - FIRST_ROW_Y;
    if (offset < 0) return;
    const row = Math.floor(offset / ROW_STEP);
    if (row >= POOLS + 1 || row === BLANK_ROW) return;
    this.pool = poolOfRow(row);
    this.entry = new NumberEntry(ENTRY_X, FIRST_ROW_Y + ROW_STEP * row, ENTRY_DIGITS, 4);
  }

  protected override onKeys(keys: string[]): boolean {
    const entry = this.entry;
    if (!entry) return false;
    entry.feed(keys);
    if (entry.done !== null) {
      this.ctx.sim.setJobCap(this.pool, entry.done);
      setStaffLevel(this.state, this.pool, entry.done);
      this.entry = null;
    }
    return true;
  }

  // $BC5A: leaving copies the three staff pools that have their own counters back.
  protected override onClose(): void {
    const s = this.state;
    s.setLong(STAFF.medics, s.long(STAFF.assigned + 4 * 6));
    s.setLong(STAFF.scientists, s.long(STAFF.assigned + 4 * 7));
    s.setLong(STAFF.security, s.long(STAFF.assigned + 4 * 8));
  }

  private column(screen: Screen, address: number, x: number): void {
    const s = this.state;
    const top = Array.from({ length: 6 }, (_, i) => s.long(address + 4 * i));
    const bottom = Array.from({ length: 3 }, (_, i) => s.long(address + 4 * (6 + i)));
    this.ui.numbers(screen, top, x, FIRST_ROW_Y, ENTRY_DIGITS, COLOR.highlight);
    this.ui.numbers(screen, bottom, x, FIRST_ROW_Y + ROW_STEP * 7, ENTRY_DIGITS, COLOR.highlight);
  }

  protected drawContent(screen: Screen): void {
    const ui = this.ui;
    const labels = ui.readLabels(0xeaca);
    // The prompt line is label 57 ("click to alter") or, during an entry, string 58.
    this.labels(screen, labels.filter((l) => l.index !== 57), COLOR.text);
    const prompt = labels.find((l) => l.index === 57);
    if (prompt) ui.str(screen, this.entry ? 58 : 57, prompt.x, prompt.y, COLOR.text);
    this.column(screen, STAFF.assigned, 86);
    this.column(screen, STAFF.cap, 113);
    this.column(screen, STAFF.required, 144);
    this.column(screen, STAFF.shortage, 172);
    const production = Array.from({ length: 6 }, (_, i) => this.state.long(STAFF.production + 4 * i));
    ui.numbers(screen, production, 200, FIRST_ROW_Y, 5, COLOR.highlight);
    this.entry?.draw(ui, screen);
  }
}
