// The trade window ($CC8E: retain percentages, next-year tax, military/civilian grants) and the
// market window ($D0D8 / $D106: buy, sell and dump goods). Both write back to the state fields
// the original uses; the simulation reads them from the same addresses.

import { COLOR } from "../../data/gamefont.js";
import type { Screen } from "../../gfx/screen.js";
import type { Input } from "../intro.js";
import { A, type GameState } from "../state.js";
import { BUTTON_TABLE, PanelScene } from "./panel.js";
import type { ScreenContext, ScreenScene } from "./types.js";
import { NumberEntry, Ui } from "./ui.js";

export const TRADE = {
  fuelCopy: 0x1314e, // fuel stock copy, goods stock follows at $13152 (6 longs)
  fuelStored: 0x14342,
  fuelUsed: [0x14376, 0x1439a], // monthly and yearly fuel consumption, raised when fuel is removed
  market: 0x1316a, // 12 entries of 10 bytes, the first word is the price
  tradable: 0x14234, // 6 longs
  supply: 0x1443a, // 6 longs
  demand: 0x14452, // 6 longs
  militaryGrant: 0x142d2,
  civilianGrant: 0x142d6,
  tradeIncome: 0x142f6,
  flags: 0x144c2, // bit 1: has traded this month
  tradeFailure: 0x144ba,
  tradeAllowed: 0x133f8, // word: 0 while there is no commander (no trade possible)
  foodStock: 0x13156,
  foodCopy: 0x1434a,
  tankA: 0x13302,
  tankB: 0x13314,
} as const;

const WEIGHTS = 0xb0e8; // 6 longs in the program image: kg per unit
const ITEMS = 6;
const GRANT_LIMIT = 99999;
const MAX_TAX = 20;

function mulu(a: number, b: number): number {
  return ((a & 0xffff) * (b & 0xffff)) >>> 0;
}

// ---- $A784: tradable = stock - stock * retain / 100 ---------------------------------------

export function updateTradable(state: GameState): void {
  for (let i = 0; i < ITEMS; i++) {
    const stock = state.long(TRADE.fuelCopy + 4 * i);
    const kept = Math.floor(mulu(state.long(A.retainPercent + 4 * i), stock) / 100) & 0xffff;
    state.setLong(TRADE.tradable + 4 * i, (stock - kept) >>> 0);
  }
}

// ---- $A5A6: take fuel out of the tanks ------------------------------------------------------

export function removeFuel(state: GameState, units: number): void {
  state.setLong(TRADE.fuelStored, (state.long(TRADE.fuelStored) - units) >>> 0);
  state.setLong(TRADE.fuelUsed[0], (state.long(TRADE.fuelUsed[0]) + units) >>> 0);
  state.setLong(TRADE.fuelUsed[1], (state.long(TRADE.fuelUsed[1]) + units) >>> 0);
  const countA = state.word(TRADE.tankA + 0xc);
  const countB = state.word(TRADE.tankB + 0xc);
  let total = (state.word(TRADE.tankA + 0xe) + state.word(TRADE.tankB + 0xe) - units) | 0;
  let spill = 0;
  const capacityA = mulu(countA, 800);
  if (capacityA === 0) {
    spill = total;
    total = 0;
  } else if (capacityA - total < 0) {
    spill = total - 800;
    total = 800;
  } else {
    state.setWord(TRADE.tankA + 0xe, total);
    return;
  }
  if (mulu(countB, 1200) - spill < 0) spill = 1200;
  if (countB === 0) spill = 0;
  state.setWord(TRADE.tankB + 0xe, spill);
  state.setWord(TRADE.tankA + 0xe, total);
}

// $A51A through the simulation's port: units that really went into the tanks.
function storeFuel(ctx: ScreenContext, units: number): { added: number; full: boolean } {
  const s = ctx.world.state;
  if (s.word(TRADE.tankA + 0xc) === 0 && s.word(TRADE.tankB + 0xc) === 0) return { added: 0, full: true };
  const before = s.word(TRADE.tankA + 0xe) + s.word(TRADE.tankB + 0xe);
  const full = ctx.sim.storeFuel(units);
  return { added: (s.long(TRADE.fuelStored) - before) | 0, full };
}

function moneyOf(state: GameState): number {
  return state.signedLong(A.money);
}

// ---- trade window ----------------------------------------------------------------------------

type TradeEntry = { kind: "retain"; row: number } | { kind: "tax" } | { kind: "grant"; military: boolean };

export class TradeScreen extends PanelScene {
  private entry: NumberEntry | null = null;
  private target: TradeEntry | null = null;
  private child: ScreenScene | null = null;

  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xeece), BUTTON_TABLE.trade, ui);
    // $CCD8: the fuel row shows the tank contents.
    this.state.setLong(TRADE.fuelCopy, this.state.long(TRADE.fuelStored));
    updateTradable(this.state);
  }

  protected override get modal(): boolean {
    return this.entry !== null;
  }

  // Buttons 0-7 are inactive; 8 opens the market, 9 leaves.
  protected override onButton(index: number): "running" | "close" {
    if (index < 8) return "running";
    if (index === 9) return "close";
    const market = openMarket(this.ctx, this.ui);
    if (market instanceof MarketScreen) {
      this.child = market;
      return "running";
    }
    return "close";
  }

  override update(input: Input): "running" | "close" {
    if (this.child) return this.child.update(input);
    return super.update(input);
  }

  override draw(screen: Screen): void {
    if (this.child) this.child.draw(screen);
    else super.draw(screen);
  }

  protected override onClick(): void {
    if (this.entry) return;
    const { x, y } = this.pointer;
    if (y >= 0x7c) {
      if (y >= 0x8f) return;
      if (x < 0x81) {
        this.target = { kind: "tax" };
        this.entry = new NumberEntry(0x56, 0x85, 2, 3);
      } else {
        const military = y < 0x85;
        this.target = { kind: "grant", military };
        this.entry = new NumberEntry(0xc0, military ? 0x7c : 0x85, 5, 4);
      }
      return;
    }
    const offset = y - 0x36;
    if (offset < 0) return;
    const row = Math.floor(offset / 9);
    if (row >= ITEMS) return;
    this.target = { kind: "retain", row };
    this.entry = new NumberEntry(0xa0, 0x36 + 9 * row, 3, 3);
  }

  protected override onKeys(keys: string[]): boolean {
    const entry = this.entry;
    if (!entry) return false;
    entry.feed(keys);
    if (entry.done !== null) {
      this.apply(this.target!, entry.done);
      this.entry = null;
      this.target = null;
    } else if (entry.cancelled) {
      this.entry = null;
      this.target = null;
    }
    return true;
  }

  // $CEB6-$D080: write the typed value back.
  private apply(target: TradeEntry, value: number): void {
    const s = this.state;
    if (target.kind === "retain") {
      this.ctx.sim.setRetainPercent(target.row, Math.min(value, 100));
      updateTradable(s);
    } else if (target.kind === "tax") {
      this.ctx.sim.setNextTax(Math.min(value, MAX_TAX));
    } else {
      addToGrant(s, target.military, value);
    }
  }

  protected drawContent(screen: Screen): void {
    const s = this.state;
    const ui = this.ui;
    const labels = ui.readLabels(0xeed6);
    this.labels(screen, labels.filter((l) => l.index !== 57), COLOR.text);
    const prompt = labels.find((l) => l.index === 57);
    if (prompt) ui.str(screen, this.promptIndex(), prompt.x, prompt.y, COLOR.text);
    const weights = Array.from({ length: ITEMS }, (_, i) => ui.image.long(WEIGHTS + 4 * i));
    ui.numbers(screen, weights, 80, 0x36, 4);
    const column = (address: number) => Array.from({ length: ITEMS }, (_, i) => s.long(address + 4 * i));
    ui.numbers(screen, column(TRADE.fuelCopy), 0x74, 0x36, 6);
    ui.numbers(screen, column(A.retainPercent), 0xa0, 0x36, 3);
    ui.numbers(screen, column(TRADE.tradable), 0xc4, 0x36, 5);
    ui.str(screen, 0xa1, 0xb4, 0x36, COLOR.highlight);
    ui.numbers(screen, [s.long(A.nextTax)], 0x56, 0x85, 2);
    ui.numbers(screen, [s.long(TRADE.militaryGrant), s.long(TRADE.civilianGrant)], 0xc0, 0x85 - 9, 5);
    ui.numbers(screen, [Math.min(moneyOf(s), 999999)], 0x42, 0x7c, 6);
    this.entry?.draw(ui, screen);
  }

  private promptIndex(): number {
    const t = this.target;
    if (!this.entry || !t) return 57;
    return t.kind === "grant" ? 186 : 58;
  }
}

// $CFB0-$D058: money moved into a grant; the grant stops at 99999 and only what fits is paid.
export function addToGrant(state: GameState, military: boolean, amount: number): void {
  const address = military ? TRADE.militaryGrant : TRADE.civilianGrant;
  let paid = Math.min(amount, moneyOf(state));
  let grant = state.long(address) + paid;
  const room = GRANT_LIMIT - grant;
  if (room < 0) {
    grant += room;
    paid += room;
  }
  state.setLong(address, grant >>> 0);
  state.setLong(A.money, (moneyOf(state) - paid) >>> 0);
}

// ---- market window ----------------------------------------------------------------------------

const MARKET_BUTTON = { sell: 0, buy: 1, dump: 8, exit: 9 } as const;
const WAIT_FRAMES = 76;
const LINE_1 = { x: 18, y: 135 };
const LINE_2 = { x: 18, y: 144 };

// $D0D8: why the market cannot be opened right now, as a message-line string index, or -1.
export function marketRefusal(state: GameState): number {
  if (state.byte(TRADE.flags) & 2) return 0xa5;
  if (state.byte(TRADE.tradeFailure) !== 0) return 0x117;
  if (state.word(TRADE.tradeAllowed) === 0) return 0xb2;
  return -1;
}

class ClosedScreen implements ScreenScene {
  update(): "running" | "close" {
    return "close";
  }
  draw(): void {}
}

// The scene for the market icon: refuses with a message ($D0D8) or opens the window.
export function openMarket(ctx: ScreenContext, ui?: Ui): ScreenScene {
  const refusal = marketRefusal(ctx.world.state);
  if (refusal >= 0) {
    ctx.say?.(refusal);
    return new ClosedScreen();
  }
  return new MarketScreen(ctx, ui);
}

type MarketMode = "buy" | "sell" | "dump";

export class MarketScreen extends PanelScene {
  selected = -1; // $F174: item row 0-5, -1 = none
  private lines: number[][] = [[], []];
  private entry: NumberEntry | null = null;
  private mode: MarketMode = "buy";
  private wait = 0;
  private prices: number[];

  constructor(ctx: ScreenContext, ui?: Ui) {
    super(ctx, (ui ?? new Ui(ctx.disk, ctx.strings)).readWindow(0xef2e), BUTTON_TABLE.market, ui);
    this.prices = Array.from({ length: ITEMS }, (_, i) => this.state.word(TRADE.market + 10 * i));
    this.reset();
  }

  protected override get modal(): boolean {
    return this.entry !== null || this.wait > 0;
  }

  // $D182: no item selected, ask for one.
  private reset(): void {
    this.selected = -1;
    this.say(166);
  }

  private say(first: number, second = -1): void {
    this.lines = [first >= 0 ? this.ctx.strings.get(first) : [], second >= 0 ? this.ctx.strings.get(second) : []];
  }

  private show(first: number[], second: number[] = []): void {
    this.lines = [first, second];
  }

  // $D33C: a result message stays for a moment while the window ignores input.
  private hold(): void {
    this.wait = WAIT_FRAMES;
  }

  override update(input: Input): "running" | "close" {
    if (this.wait > 0) {
      this.pointer.update(input);
      if (input.keys) input.keys.length = 0;
      if (--this.wait === 0) this.reset();
      return "running";
    }
    return super.update(input);
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === MARKET_BUTTON.exit) return "close";
    if (index === MARKET_BUTTON.buy) this.begin("buy");
    else if (index === MARKET_BUTTON.sell) this.begin("sell");
    else if (index === MARKET_BUTTON.dump) this.begin("dump");
    else {
      this.selected = index - 2;
      this.say(167);
    }
    return "running";
  }

  protected override onClose(): void {
    // $D2D2: the food copy is refreshed when the window is left.
    this.state.setLong(TRADE.foodCopy, this.state.long(TRADE.foodStock));
  }

  // The refusals the original shows before it asks for a quantity.
  private begin(mode: MarketMode): void {
    const s = this.state;
    const item = this.selected;
    if (item < 0) {
      this.reset();
      return;
    }
    const stock = s.long(TRADE.fuelCopy + 4 * item);
    this.mode = mode;
    let prompt = 0;
    if (mode === "buy") {
      if (s.long(TRADE.supply + 4 * item) === 0) return this.refuse(169);
      prompt = 170;
    } else if (mode === "sell") {
      if (s.long(TRADE.demand + 4 * item) === 0) return this.refuse(177);
      if (stock === 0) return this.refuse(168);
      prompt = 171;
    } else {
      if (stock === 0) return this.refuse(168);
      prompt = 349;
    }
    this.say(prompt);
    this.entry = new NumberEntry(0x96, 0x87, 4, 6);
  }

  private refuse(message: number): void {
    this.say(message);
    this.hold();
  }

  protected override onKeys(keys: string[]): boolean {
    const entry = this.entry;
    if (!entry) return false;
    entry.feed(keys);
    if (entry.done !== null) {
      this.entry = null;
      this.finish(this.mode, entry.done);
    } else if (entry.cancelled) {
      this.entry = null;
      this.say(167);
    }
    return true;
  }

  private finish(mode: MarketMode, quantity: number): void {
    const result = mode === "buy" ? this.buy(this.selected, quantity) : mode === "sell" ? this.sell(this.selected, quantity) : this.dump(this.selected, quantity);
    this.show(result.first, result.second);
    this.hold();
  }

  private digits(value: number): number[] {
    return this.ui.numberText(value, 4);
  }

  private markTraded(): void {
    const s = this.state;
    s.setByte(TRADE.flags, (s.byte(TRADE.flags) | 2) & ~1);
  }

  // $D38E-$D42E.
  buy(item: number, quantity: number): { first: number[]; second: number[] } {
    const s = this.state;
    const strings = this.ctx.strings;
    const supplyAt = TRADE.supply + 4 * item;
    const units = Math.min(quantity, s.long(supplyAt));
    const cost = mulu(this.prices[item], units);
    if (((cost - moneyOf(s)) | 0) >= 0) return { first: strings.get(176), second: [] };
    let added: number;
    let full: boolean;
    if (item === 0) {
      ({ added, full } = storeFuel(this.ctx, units));
      s.setLong(TRADE.fuelCopy, (s.long(TRADE.fuelCopy) + added) >>> 0);
    } else {
      const result = this.ctx.sim.addGoods(units, item - 1);
      added = result.added;
      full = result.overflow;
    }
    s.setLong(supplyAt, (s.long(supplyAt) - added) >>> 0);
    s.setLong(A.money, (moneyOf(s) - mulu(this.prices[item], added)) >>> 0);
    this.markTraded();
    return { first: strings.withNumber(172, this.digits(added)), second: full ? strings.get(175) : [] };
  }

  // $D45A-$D540.
  sell(item: number, quantity: number): { first: number[]; second: number[] } {
    const s = this.state;
    const strings = this.ctx.strings;
    const demandAt = TRADE.demand + 4 * item;
    let units = Math.min(quantity, s.long(demandAt), s.long(TRADE.fuelCopy + 4 * item));
    units = this.take(item, units);
    s.setLong(demandAt, (s.long(demandAt) - units) >>> 0);
    const income = mulu(this.prices[item], units);
    s.setLong(A.money, (moneyOf(s) + income) >>> 0);
    s.setLong(TRADE.tradeIncome, (s.long(TRADE.tradeIncome) + income) >>> 0);
    this.markTraded();
    const gone = s.long(TRADE.fuelCopy + 4 * item) === 0;
    return { first: strings.withNumber(173, this.digits(units)), second: gone ? strings.get(174) : [] };
  }

  // $D56C-$D608. The original prints the dumped count from the wrong pointer, so the first
  // line stays empty (reading of $D5F8-$D602: a0 is not restored before $D41E).
  dump(item: number, quantity: number): { first: number[]; second: number[] } {
    const s = this.state;
    const units = this.take(item, Math.min(quantity, s.long(TRADE.fuelCopy + 4 * item)));
    void units;
    this.markTraded();
    const gone = s.long(TRADE.fuelCopy + 4 * item) === 0;
    return { first: [], second: gone ? this.ctx.strings.get(379) : [] };
  }

  // Removes goods from the stores ($A5A6 for fuel, $A32C for the others); returns the units removed.
  private take(item: number, units: number): number {
    const s = this.state;
    if (item !== 0) return this.ctx.sim.removeGoods(units, item - 1); // the stock array is the copy
    removeFuel(s, units);
    s.setLong(TRADE.fuelCopy, (s.long(TRADE.fuelCopy) - units) >>> 0);
    return units;
  }

  protected drawContent(screen: Screen): void {
    const s = this.state;
    const ui = this.ui;
    this.labels(screen, ui.readLabels(0xef36), COLOR.text);
    const weights = Array.from({ length: ITEMS }, (_, i) => ui.image.long(WEIGHTS + 4 * i));
    const column = (address: number) => Array.from({ length: ITEMS }, (_, i) => s.long(address + 4 * i));
    ui.numbers(screen, weights, 0x48, 0x38, 4);
    ui.numbers(screen, column(TRADE.fuelCopy), 0x6d, 0x38, 6);
    ui.numbers(screen, this.prices, 0x96, 0x38, 3);
    ui.numbers(screen, column(TRADE.supply), 0xb5, 0x38, 4);
    ui.numbers(screen, column(TRADE.demand), 0xd4, 0x38, 4);
    ui.numbers(screen, [Math.min(moneyOf(s), 999999)], 0x36, 0x78, 6);
    ui.text(screen, this.lines[0], LINE_1.x, LINE_1.y, COLOR.highlight);
    ui.text(screen, this.lines[1], LINE_2.x, LINE_2.y, COLOR.highlight);
    this.entry?.draw(ui, screen);
  }
}
