// The six report windows opened with F1-F6 ($B81C, $BA1E, $BD9E, $C516, $D6BA, $E1AA). Each
// draws labels from the string table and numbers straight from the state fields the original
// reads; nothing is written except the two sums F3 stores back. Layout: notes/formats/screens.md.
// Input (static trace of Disk.1): every report ends with `$B99C`, whose wait is `$58F8` (the `$50B2` poll): the release of
// any command button leaves, and a council-room report leaves on a left click (`$2E48`). Escape and the right button are
// not read, so `PanelScene` leaves them alone for these windows.

import { COLOR } from "../../data/gamefont.js";
import type { Screen } from "../../gfx/screen.js";
import { A, type GameState } from "../state.js";
import { T, TYPE_SIZE, TYPE_TABLE } from "../world.js";
import { PanelScene } from "./panel.js";
import type { ScreenContext } from "./types.js";
import { Ui } from "./ui.js";

const CROWDING_TYPE_HOUSING = 0x1326c; // T[7].C: housing buildings, 50 colonists each
const ONLINE_COMMAND_CENTRES = 0x133f8; // word: T[29].C, online command centres

// $15B4A: each F1-F6 key tests word $133F8 before it calls its report (`$B81C` ... `$E1AA`). Zero branches to `$15B3E`, which
// posts message $B2 (`$551A`) and returns: no report opens and the key is used up. Static trace of Disk.1 (screens.md section 7).
export const REPORT_REFUSAL = 0xb2;

/** The message string index that refuses an F1-F6 report, or -1 when the report opens. */
export function reportRefusal(state: GameState): number {
  return state.word(ONLINE_COMMAND_CENTRES) === 0 ? REPORT_REFUSAL : -1;
}

function s8(v: number): number {
  return ((v & 0xff) << 24) >> 24;
}

// ---- F1: colony administrator ($B81C) ------------------------------------------------------

export class ColonyScreen extends PanelScene {
  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xe910), undefined, ui);
  }

  // $A224: title of the birth-rate text by difficulty ($145A2: 0, $14, $1E, else).
  static rateString(difficulty: number): number {
    if (difficulty === 0) return 46;
    if (difficulty === 0x14) return 47;
    if (difficulty === 0x1e) return 48;
    return 49;
  }

  // $B81C: population density = pop * 100 / (housing * 50), 100 when there is no housing.
  static density(pop: number, housing: number): number {
    const num = ((pop & 0xffff) * 100) >>> 0;
    const den = (housing & 0xffff) * 50;
    if (den === 0) return 100;
    return Math.min(0xffff, Math.floor(num / (den & 0xffff || 1)));
  }

  // $B81C: morale text index from morale/100 and the crime text index from the crime level.
  static moraleString(morale: number): number {
    const m = Math.trunc(morale / 100);
    if (m < 0) return -m >= 50 ? 0x59 : 0x5a;
    return m >= 50 ? 0x5c : 0x5b;
  }

  static crimeString(crime: number): number {
    if (crime < 0) return 0x68;
    const c = s8(crime);
    if (c <= 0x14) return 0x69;
    if (c <= 0x32) return 0x6a;
    return 0x6b;
  }

  protected drawContent(screen: Screen): void {
    const s = this.state;
    const ui = this.ui;
    this.labels(screen, ui.readLabels(0xea76), COLOR.text);
    ui.str(screen, ColonyScreen.rateString(s.byte(A.difficulty)), 172, 55, COLOR.highlight);
    const housing = s.word(CROWDING_TYPE_HOUSING);
    ui.numbers(screen, [s.long(0x1432e), s.long(0x14332), ColonyScreen.density(s.long(A.population), housing)], 194, 73, 4);
    const pop = s.long(A.population);
    const workers = s.long(0x1432a) + s.long(0x143be) + s.long(0x143c2);
    const technicians = s.long(0x1313a) - s.long(0x13146) - s.long(0x1313e) - s.long(0x13142);
    ui.numbers(screen, [s.long(0x13136), workers, technicians, s.long(0x1313e), s.long(0x13142), s.long(0x13146), pop], 76, 55, 6);
    ui.str(screen, ColonyScreen.moraleString(s.signedLong(A.morale)), 48, 138, COLOR.highlight);
    ui.str(screen, ColonyScreen.crimeString(s.signedLong(0x142ce)), 48, 125, COLOR.highlight);
  }
}

// ---- F2: resources report ($BA1E) ----------------------------------------------------------

export class ResourceScreen extends PanelScene {
  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xe918), undefined, ui);
  }

  private column(addr: number): number[] {
    return Array.from({ length: 5 }, (_, i) => this.state.long(addr + 4 * i));
  }

  protected drawContent(screen: Screen): void {
    this.labels(screen, this.ui.readLabels(0xeab0), COLOR.text);
    // Air, food, fuel, power, ore: stored, produced this month, used this month, used this year.
    const cols: [number, number][] = [
      [0x1433a, 69],
      [0x1434e, 101],
      [0x14362, 135],
      [0x1437e, 167],
    ];
    for (const [addr, x] of cols) this.ui.numbers(screen, this.column(addr), x, 76, 6);
  }
}

// ---- F3: financial consultant ($BD9E) ------------------------------------------------------

export class FinanceScreen extends PanelScene {
  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xe928), undefined, ui);
  }

  // Message at the bottom: $DB trade computer failure, $EB grant nearly used up, $3F loss.
  static warning(failure: number, grant: number, gross: number, spent: number): number {
    if (failure !== 0) return 0xdb;
    if (grant !== 0 && grant <= 0x258) return 0xeb;
    return gross - spent < 0 ? 0x3f : -1;
  }

  protected drawContent(screen: Screen): void {
    const s = this.state;
    const ui = this.ui;
    this.labels(screen, ui.readLabels(0xeae4), COLOR.text);
    ui.numbers(screen, [s.long(0x144fc)], 62, 71, 3);
    // The original stores the three month figures' sum at $142EE and the year sum at $1430E.
    s.setLong(0x142ee, (s.long(0x142e2) + s.long(0x142e6) + s.long(0x142ea)) >>> 0);
    ui.numbers(screen, [s.long(0x142e2), s.long(0x142e6), s.long(0x142ea), s.long(0x142ee)], 120, 53, 7);
    ui.numbers(screen, [s.long(0x135b6), s.signedLong(0x135ba)], 120, 99, 7);
    s.setLong(0x1430e, (s.long(0x14302) + s.long(0x14306) + s.long(0x1430a)) >>> 0);
    ui.numbers(screen, [s.long(0x14302), s.long(0x14306), s.long(0x1430a), s.long(0x1430e)], 170, 53, 7);
    ui.numbers(screen, [s.long(0x14312)], 170, 99, 7);
    const w = FinanceScreen.warning(s.byte(0x144ba), s.long(0x135be), s.signedLong(0x142ee), s.signedLong(0x135b6));
    if (w >= 0) ui.str(screen, w, 16, 130, COLOR.highlight);
  }
}

// ---- F4: civil engineer, building counts ($C516) -------------------------------------------

export class BuildingScreen extends PanelScene {
  private readonly records: number[];

  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xec4e), undefined, ui);
    this.records = this.ui.readPointers(0xed1e, 32);
  }

  // Number of finished buildings of the type record at `address` (+$A).
  private count(address: number): number {
    return this.state.word(address + T.active);
  }

  protected drawContent(screen: Screen): void {
    this.labels(screen, this.ui.readLabels(0xec56), COLOR.text);
    const values = this.records.map((a) => this.count(a));
    this.ui.numbers(screen, values.slice(0, 16), 94, 31, 4);
    this.ui.numbers(screen, values.slice(16), 200, 31, 4);
  }

  // Type index of a record pointer (for tests).
  static typeIndex(address: number): number {
    return (address - TYPE_TABLE) / TYPE_SIZE;
  }
}

// ---- F5: head of research ($D6BA) ----------------------------------------------------------

const TECH_THRESHOLDS = 0xb154; // longs: research points for tech levels 1..9

export class ResearchScreen extends PanelScene {
  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xef7c), undefined, ui);
  }

  // $D6BA: status text 184 / 183 / 185 (or none) from the research progress and staffing.
  static message(tech: number, threshold: number, accumulated: number, militaryGrant: number, civilGrant: number, scientists: number, labStaff: number): number {
    const remaining = threshold - accumulated;
    const tenth = Math.floor(threshold / 10);
    if (remaining < tenth) return 0xb8;
    if (militaryGrant === 0 && civilGrant === 0) return 0xb7;
    void tech;
    return scientists === labStaff ? 0xb9 : -1;
  }

  protected drawContent(screen: Screen): void {
    const s = this.state;
    const ui = this.ui;
    this.labels(screen, ui.readLabels(0xef84), COLOR.text);
    const tech = s.byte(A.techLevel);
    ui.numbers(screen, [tech, s.word(0x13200), s.long(0x13142), s.long(0x142d2), s.long(0x142d6)], 151, 48, 5);
    const threshold = ui.image.long(TECH_THRESHOLDS + 4 * (tech - 1));
    const m = ResearchScreen.message(tech, threshold, s.long(0x142de), s.long(0x142d2), s.long(0x142d6), s.long(0x13142), s.long(0x143e2));
    if (m >= 0) ui.str(screen, m, 35, 118, COLOR.highlight);
    const last = s.word(0x1447a);
    if (last !== 0) ui.str(screen, last, 35, 104, COLOR.highlight);
  }
}

// ---- F6: supreme commander ($E1AA) ---------------------------------------------------------

export class DefenceScreen extends PanelScene {
  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xed9e), undefined, ui);
  }

  private column(addr: number, n: number): number[] {
    return Array.from({ length: n }, (_, i) => this.state.long(addr + 4 * i));
  }

  protected drawContent(screen: Screen): void {
    const s = this.state;
    const ui = this.ui;
    this.labels(screen, ui.readLabels(0xeda6), COLOR.text);
    ui.numbers(screen, this.column(0x14254, 8), 85, 49, 4);
    ui.numbers(screen, this.column(0x14274, 8), 130, 49, 4);
    // Defence buildings: laser turret, plasma gun, missile launcher, HDX missile (+$A of T[5], T[6], T[8], T[9]).
    ui.numbers(screen, [s.word(0x13246), s.word(0x13258), s.word(0x1327c), s.word(0x1328e)], 90, 130, 4);
    ui.numbers(screen, this.column(0x14294, 2), 156, 139, 5);
  }
}
