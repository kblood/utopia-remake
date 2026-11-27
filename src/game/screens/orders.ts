// The two order windows opened by a right click on the map in select mode ($3EDC): the ship window ($DA94, orders for a
// launched ship: land, hover, go to a pin, go to the front, build a launchpad) and the tank window ($C5BE: send the
// tank to a pin, send groups of tanks, stop). Layouts, strings, button images and the per-class tables are read from the
// user's own Disk.1 at runtime; the orders themselves are EnemySystem.commandShip and orders.ts. Notes:
// notes/formats/ship-control.md.

import { COLOR } from "../../data/gamefont.js";
import { loadBuiltinSprites } from "../../data/sprites.js";
import type { SpriteSet } from "../../data/sprites.js";
import type { Screen } from "../../gfx/screen.js";
import { SHIP_ORDER, type EnemySystem } from "../enemies.js";
import { orderGroup, stopUnit, type GroupOrder, type Pick } from "../orders.js";
import type { Ship } from "../sim-ships.js";
import type { Unit, UnitSystem } from "../units.js";
import type { World } from "../world.js";
import { blitIcon } from "./buildings.js";
import { writeOrderByte } from "./order-byte.js";
import { PanelScene } from "./panel.js";
import type { ScreenContext, ScreenScene } from "./types.js";
import { NumberEntry, Ui, type Label } from "./ui.js";

const PIN_COUNT = 8;
const NO_PIN = 0xff;
const ICON_FRONT = 5; // button 5 (to the front) exists only after the first alien report; 6 hover, 7 land, 8 pad / stop
const ICON_HOVER = 6;
const ICON_LAND = 7;
const ICON_ACTION = 8;
const ICON_EXIT = 9;
const FRONT_ICON = 0x17c42; // image of the "to the front" button
const FRONT_KNOWN = 0x13ee6; // bit 7: the first alien intelligence report has come in
const TECH_LEVEL = 0x14592;
const TANK_COUNT = 0x1429c;

const IMG = {
  shipWindow: 0xf03a,
  shipLabels: 0xf042,
  shipPins: 0xf056,
  shipButtons: 0xf098,
  shipClassA: 0x4bc4, // byte per ship class
  shipClassB: 0x4a98, // word per ship class (negative = none)
  tankWindow: 0xee08,
  tankLabels: 0xee10,
  tankPins: 0xee1e,
  tankButtons: 0xee60,
} as const;

// String indices (the texts themselves stay on the disk).
const STR = {
  className: 0xbe, // + ship class
  order: 0xcc, // + order code ($F173, minus 2 from 7 up)
  noPins: 0x92,
  pinChosen: 0xf0, // placeholder = pin digit
  noFuel: 0xec,
  lowFuel: 0x2f,
  padNotLanded: 0x12d,
  padNotExplorer: 0xd5,
  padChosen: 0xd4,
  tankPinChosen: 0x93,
  frontA: 0x55,
  frontB: 0x56,
  needPin: 0x97,
  nearA: 0x98,
  nearTank: 0x99,
  nearPin: 0x9a,
  howMany: 0x9b,
} as const;
export const MSG_PAD_BUSY = 0xd6; // the ship is on its way to build a pad: no window
export const MSG_TANK_STOPPED = 0x54;

type Rect = { x0: number; x1: number; y0: number; y1: number };

function readRects(ui: Ui, address: number, count: number): Rect[] {
  return Array.from({ length: count }, (_, i) => {
    const a = address + 8 * i;
    return { x0: ui.image.word(a), x1: ui.image.word(a + 2), y0: ui.image.word(a + 4), y1: ui.image.word(a + 6) };
  });
}

// $F174: the last number typed in a tank window stays for the next one (the original never clears it).
const lastCounts = new WeakMap<World, number>();

// Behaviour shared by both windows: the pin icons, the "to the front" button and the message area.
abstract class OrderScreen extends PanelScene {
  protected readonly sprites: SpriteSet;
  protected readonly rects: Rect[];
  protected readonly labelList: Label[];
  protected readonly pins: ({ x: number; y: number } | null)[];
  protected pin = NO_PIN; // $F172
  protected readonly frontKnown: boolean;

  constructor(ctx: ScreenContext, ui: Ui, window: number, labels: number, pinRects: number, buttons: number) {
    super(ctx, ui.readWindow(window), buttons, ui);
    this.labelList = ui.readLabels(labels);
    this.sprites = loadBuiltinSprites(ctx.disk);
    this.rects = readRects(ui, pinRects, PIN_COUNT);
    this.pins = Array.from({ length: PIN_COUNT }, (_, n) => ctx.objects?.markerCell(n + 1) ?? null);
    this.frontKnown = (ctx.world.state.byte(FRONT_KNOWN) & 0x80) !== 0;
  }

  protected get anyPin(): boolean {
    return this.pins.some((p) => p !== null);
  }

  // Strict (static trace of Disk.1: the ship loop `$DCDC` and the tank loop `$C6EC` read the mouse only through `$50B2`,
  // and no key). Escape and a right click do nothing; only the exit button (9) closes the window and applies the order.
  protected override get leavesOnEscapeOrRight(): boolean {
    return false;
  }

  // The loops `$DCDC` and `$C6EC` poll the mouse through `$50B2` (mouse-poll.ts), see notes/formats/ship-control.md 6.
  protected override get pollsLikeOriginal(): boolean {
    return true;
  }

  protected drawPins(screen: Screen): void {
    this.pins.forEach((p, n) => {
      if (p) blitIcon(screen, this.sprites, n + 1, this.rects[n].x0 - 8, this.rects[n].y1);
    });
  }

  // A string with its number placeholder replaced by the digit of pin n.
  protected pinText(index: number, pin: number): number[] {
    const text = this.ctx.strings.get(index);
    const at = this.ctx.strings.placeholder(index);
    if (at >= 0 && at < text.length) text[at] = 0x31 + pin;
    return text;
  }

  // The icon of button 5 is the "front" image when it is available and a blank one otherwise ($DC28 / $C6B6). The press
  // flips the rectangle whichever image it shows ($5756 flips the position), so the flip is drawn over the blank one too.
  override draw(screen: Screen): void {
    super.draw(screen);
    this.ui.drawButton(screen, ICON_FRONT, this.frontKnown ? FRONT_ICON : 0);
    if (this.pressedButton === ICON_FRONT) this.ui.invertButton(screen, ICON_FRONT);
  }

  // A press that is not on a button: a pin icon.
  protected pinAt(): number {
    const { x, y } = this.pointer;
    const n = this.rects.findIndex((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    return n >= 0 && this.pins[n] ? n : -1;
  }
}

// ---- ship window $DA94 ---------------------------------------------------------------------------------------------

class ShipScreen extends OrderScreen {
  private order = 0;
  private note: { index: number; pin?: number } | null = null;

  // $F173, starts as the ship's mode, so leaving at once repeats what the ship is doing. Every change is also written
  // to the shared order byte (order-byte.ts), which the ship yard reads after this window closes.
  private get cmd(): number {
    return this.order;
  }

  private set cmd(value: number) {
    this.order = value;
    writeOrderByte(this.ctx.world, value);
  }

  constructor(
    ctx: ScreenContext,
    private readonly ship: Ship,
    private readonly enemies: EnemySystem,
    ui: Ui,
  ) {
    super(ctx, ui, IMG.shipWindow, IMG.shipLabels, IMG.shipPins, IMG.shipButtons);
    this.cmd = ship.mode;
  }

  protected drawContent(screen: Screen): void {
    const ui = this.ui;
    const ship = this.ship;
    this.labels(screen, this.labelList);
    ui.str(screen, STR.className + ship.cls, 100, 41, COLOR.highlight);
    const image = ui.image;
    const b = image.word(IMG.shipClassB + 2 * ship.cls);
    ui.numbers(screen, [ship.tech, ship.hp, image.byte(IMG.shipClassA + ship.cls), ship.fuel & 0x8000 ? 0 : ship.fuel, b & 0x8000 ? 0 : b], 163, 55, 4, COLOR.highlight);
    // $DB7A: an empty tank and a nearly empty one are announced; a negative word means unlimited fuel.
    if (!(ship.fuel & 0x8000)) {
      if (ship.fuel === 0) ui.str(screen, STR.noFuel, 193, 82, COLOR.highlight);
      else if (ship.fuel <= 0x32) ui.str(screen, STR.lowFuel, 193, 82, COLOR.highlight);
    }
    if (!this.anyPin) {
      if (!this.note) ui.str(screen, STR.noPins, 64, 145, COLOR.highlight);
    } else {
      this.drawPins(screen);
    }
    if (this.note) {
      const text = this.note.pin !== undefined ? this.pinText(this.note.index, this.note.pin) : ui.strings.get(this.note.index);
      ui.text(screen, text, 64, 145, COLOR.highlight);
    }
    ui.str(screen, STR.order + (this.cmd >= 7 ? this.cmd - 2 : this.cmd), 100, 105, COLOR.highlight);
  }

  protected override onClick(): void {
    const n = this.pinAt();
    if (n < 0) return;
    this.pin = n;
    this.note = { index: STR.pinChosen, pin: n };
    // A pin keeps a hover order a hover (3) and makes everything else a go-and-land (2).
    this.cmd = this.cmd === SHIP_ORDER.hover || this.cmd === SHIP_ORDER.goHover ? SHIP_ORDER.goHover : SHIP_ORDER.goLand;
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === ICON_EXIT) {
      this.apply();
      return "close";
    }
    if (index === ICON_HOVER) {
      this.cmd = this.cmd === SHIP_ORDER.goLand ? SHIP_ORDER.goHover : SHIP_ORDER.hover;
    } else if (index === ICON_LAND) {
      this.cmd = this.cmd === SHIP_ORDER.goHover ? SHIP_ORDER.goLand : SHIP_ORDER.land;
    } else if (index === ICON_FRONT) {
      if (this.frontKnown) this.cmd = SHIP_ORDER.front;
    } else if (index === ICON_ACTION) {
      // $DE56: a launchpad can only be ordered while the order is "land", and only the Explorer (class 0) builds one.
      let message: number = STR.padNotLanded;
      if (this.cmd === SHIP_ORDER.land) {
        message = STR.padNotExplorer;
        if (this.ship.cls === 0) {
          this.pin = NO_PIN;
          this.cmd = SHIP_ORDER.buildPad;
          message = STR.padChosen;
        }
      }
      this.note = { index: message };
    }
    return "running";
  }

  // $3F9E after the window: orders 0-4 and 9 go to the ship (a mode left unchanged and above 4 is not an order).
  private apply(): void {
    const cmd = this.cmd;
    if (cmd > SHIP_ORDER.buildPad && cmd !== SHIP_ORDER.front) return;
    const target = this.pin !== NO_PIN ? this.pins[this.pin] : null;
    const message = this.enemies.commandShip(this.ship, cmd, target);
    if (message) this.ctx.say?.(message);
  }
}

// ---- tank window $C5BE -----------------------------------------------------------------------------------------------

// $F173 of the tank window.
const TANK = { none: 0, front: 5, nearTank: 6, nearPin: 7, single: 9 } as const;

class TankScreen extends OrderScreen {
  private current: number = TANK.none;
  private lines: [number[], number[]] | null = null; // the two message lines at x 56 ($CA3E)
  private asking = false; // the "how many" prompt is shown
  private entry: NumberEntry | null = null;
  private count: number;

  // $F173 of the tank window: every change is also written to the shared order byte (order-byte.ts).
  private get mode(): number {
    return this.current;
  }

  private set mode(value: number) {
    this.current = value;
    writeOrderByte(this.ctx.world, value);
  }

  constructor(
    ctx: ScreenContext,
    private readonly unit: Unit,
    private readonly units: UnitSystem,
    ui: Ui,
  ) {
    super(ctx, ui, IMG.tankWindow, IMG.tankLabels, IMG.tankPins, IMG.tankButtons);
    this.count = lastCounts.get(ctx.world) ?? 0;
    this.mode = TANK.none; // $C5E6: the window clears the order byte when it opens
  }

  protected override get modal(): boolean {
    return this.entry !== null;
  }

  protected drawContent(screen: Screen): void {
    const ui = this.ui;
    this.labels(screen, this.labelList);
    const s = this.state;
    ui.numbers(screen, [this.unit.tech, this.unit.hp, 8 + 2 * s.byte(TECH_LEVEL), s.word(TANK_COUNT)], 168, 44, 2, COLOR.highlight);
    if (!this.anyPin) {
      if (!this.lines) ui.str(screen, STR.noPins, 80, 102, COLOR.highlight);
    } else {
      this.drawPins(screen);
    }
    if (this.lines) {
      ui.text(screen, this.lines[0], 56, 102, COLOR.highlight);
      if (this.lines[1].length) ui.text(screen, this.lines[1], 56, 111, COLOR.highlight);
    }
    if (this.asking) {
      ui.str(screen, STR.howMany, 80, 125, COLOR.highlight);
      if (this.entry) this.entry.draw(ui, screen);
      else ui.text(screen, Array.from(String(this.count), (c) => c.charCodeAt(0)), 176, 125, COLOR.highlight);
    }
  }

  private setLines(first: number[], second: number[] = []): void {
    this.lines = [first, second];
    this.asking = false;
    this.entry = null;
  }

  // $C814-$C876: after the two message lines the count is asked for.
  private ask(): void {
    this.asking = true;
    this.entry = new NumberEntry(176, 125, 2, 4);
  }

  // `$5110` (count entry `$C862`): only Return with a digit ends it; Escape is not a key of the entry (see NumberEntry).
  protected override onKeys(keys: string[]): boolean {
    const entry = this.entry;
    if (!entry) return false;
    entry.feed(keys);
    if (entry.done !== null) {
      this.count = entry.done & 0xff;
      lastCounts.set(this.ctx.world, this.count);
      this.entry = null;
    }
    return true;
  }

  protected override onClick(): void {
    if (this.entry) return;
    const n = this.pinAt();
    if (n < 0) return;
    this.pin = n;
    this.mode = TANK.single;
    this.setLines(this.pinText(STR.tankPinChosen, n));
  }

  protected override onButton(index: number): "running" | "close" {
    if (this.entry) return "running";
    const strings = this.ctx.strings;
    if (index === ICON_EXIT) {
      this.apply();
      return "close";
    }
    if (index === ICON_ACTION) {
      stopUnit(this.unit);
      this.ctx.say?.(MSG_TANK_STOPPED);
      return "close";
    }
    if (index === ICON_FRONT) {
      if (!this.frontKnown) return "running";
      this.mode = TANK.front;
      this.setLines(strings.get(STR.frontA), strings.get(STR.frontB));
      this.ask();
    } else if (index === ICON_HOVER || index === ICON_LAND) {
      if (this.pin === NO_PIN) {
        this.setLines(strings.get(STR.needPin));
        return "running";
      }
      this.mode = index === ICON_HOVER ? TANK.nearTank : TANK.nearPin;
      this.setLines(strings.get(STR.nearA), this.pinText(index === ICON_HOVER ? STR.nearTank : STR.nearPin, this.pin));
      this.ask();
    }
    return "running";
  }

  // $C880: the exit button carries the order out.
  private apply(): void {
    const front = { x: this.state.byte(0x135c4), y: this.state.byte(0x135c5) };
    if (this.mode === TANK.front) {
      orderGroup(this.units, this.unit, "front", this.count, front);
      return;
    }
    const target = this.pin !== NO_PIN ? this.pins[this.pin] : null;
    if (!target) return;
    if (this.mode === TANK.single) this.units.order(this.unit, target.x, target.y);
    else if (this.mode === TANK.nearTank || this.mode === TANK.nearPin) {
      const kind: GroupOrder = this.mode === TANK.nearPin ? "nearPin" : "nearTank";
      orderGroup(this.units, this.unit, kind, this.count, target);
    }
  }
}

// The window of a right click ($3F5E): the tank window for an own tank, the ship window for a ship. Null when none
// opens: the ship is building a launchpad ($D6 is said), or the object layer is missing.
export function createOrderScreen(ctx: ScreenContext, pick: Pick): ScreenScene | null {
  const layer = ctx.objects;
  if (!layer) return null;
  const ui = new Ui(ctx.disk, ctx.strings);
  if (pick.kind === "tank") return new TankScreen(ctx, pick.unit, layer.units, ui);
  // $DA98: the ship's mode is written to the order byte before the refusal test below, so a refused window writes it too.
  writeOrderByte(ctx.world, pick.ship.mode);
  const enemies = layer.enemies;
  if (!enemies) return null;
  if (enemies.padPending(pick.ship)) {
    ctx.say?.(MSG_PAD_BUSY);
    return null;
  }
  return new ShipScreen(ctx, pick.ship, enemies, ui);
}
