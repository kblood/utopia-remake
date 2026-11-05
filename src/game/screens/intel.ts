// Intelligence window ($E2D2, icon column button 7): the intelligence grant, its level and the
// money transfer into it. The alien report text and portraits the original draws on top come from
// a separate Disk.2 block and are not ported (see notes/formats/screens.md).

import { COLOR } from "../../data/gamefont.js";
import type { Screen } from "../../gfx/screen.js";
import { A, type GameState } from "../state.js";
import { PanelScene } from "./panel.js";
import type { ScreenContext } from "./types.js";
import { NumberEntry, Ui } from "./ui.js";

export const INTEL = {
  grant: 0x1446a,
  level: 0x144ca,
} as const;

const LEVEL_STRING = 0x18b; // + level
const GRANT_LEVELS = [5000, 20000]; // grant from which level 2 / level 3 apply

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
    this.entry?.draw(ui, screen);
  }
}
