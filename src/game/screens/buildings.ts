// What a left click on a building does in select mode ($7140): the information and control windows of
// the power storage, fuel tanks, command centre, hospital, sports complex, missile launcher, ship yard
// and tank teleporter, plus the click-only actions (gun turret step, scaffold / land mine messages and the
// building's name). Every layout, string and table is read from the user's own Disk.1 at runtime.
// Usage (from a map click on cell x, y):
//   const scene = createBuildingScreen(ctx, x, y, hooks);
//   if (scene) { /* stop ticking the sim and the map until scene.update(input) returns "close" */ }
// A null result means the click was handled at once (state changed and/or a message said through ctx.say) or
// does nothing. Layouts, state fields and the monthly ship-yard step: notes/formats/building-screens.md.

import { TILE_ID_MASK, MAP_HEIGHT, MAP_WIDTH } from "../../data/scenario.js";
import { COLOR } from "../../data/gamefont.js";
import { readFlagTable } from "../../data/gameimage.js";
import { loadBuiltinSprites } from "../../data/sprites.js";
import type { SpriteSet } from "../../data/sprites.js";
import type { Screen } from "../../gfx/screen.js";
import type { GameState } from "../state.js";
import type { Unit, UnitSystem } from "../units.js";
import { OBJECT_SIZE, T, type World } from "../world.js";
import { BUTTON_TABLE, PanelScene } from "./panel.js";
import type { ScreenContext, ScreenScene } from "./types.js";
import { Ui, type Label } from "./ui.js";

// ---- constants of the original -------------------------------------------------------------

// Messages ($551A string indices).
export const MSG = {
  scaffold: 0x7d,
  landMine: 0x89,
  noPower: 0x12e,
  noTank: 0x10a,
  teleported: 0x10d,
  teleportBlocked: 0x10e,
  noCommandCentre: 0xb3,
  launchMalfunction: 0x12b,
} as const;

// Object types (index into the type table at $131E2).
export const TYPE = {
  storage: 0,
  hospital: 4,
  missileA: 8,
  missileB: 9,
  fuelA: 16,
  fuelB: 17,
  teleport: 25,
  shipYard: 27,
  commandCentre: 29,
  sports: 32,
} as const;

// Record tiles (the first word of a record in the object list).
const TILE = {
  storage: 1, // tiles 1-3
  plasma: 0x0f,
  hospital: 0x0e,
  laser: 0x1f,
  missileA: 0x30,
  missileB: 0x31,
  scaffold: 0x32,
  shipYard: 0x36,
  fuelA: 0x3f,
  fuelB: 0x40,
  teleport: 0x47,
  launchpad: 0x48,
  commandCentre: 0x4c,
  commandCentreOff: 0x50,
  sports: 0x5c,
  mine: 0x61,
  rubble: 0x9e,
} as const;

// State variables.
const V = {
  power: 0x144c8, // byte: power shortage level; most windows refuse at a threshold
  birthRate: 0x145a2, // byte: 0 / $14 / $1E / $3C (named "difficulty" in state.ts)
  eventWeeks: 0x144b2, // byte: weeks until another sports event may be called
  eventFlags: 0x144b1, // byte: bit 0 = event called, announced by the simulation
  shipStaff: 0x143f6, // long: staff assigned to pool 3 (ship builders)
  inventions: 0x14472, // long
  storageUnit: 0x1310c, // word: stored power per pod, in tens
  medics: 0x1313e, // long
} as const;

const GUN_FIRING_OFFSET = 8; // the firing frames of a gun tile sit 8 tiles above its facing frames
const FLAG_KEEP = 0xe800;
const OCCUPIED = 0x4000;
const OWN_UNIT_FLAG = 4;
const TELEPORT_BLOCKERS = 0x7400; // bits 10, 12, 13 and 14 of the destination cell
const INVENTION_FUSION = 4; // bit of $14472 that unlocks the 5th ship type
const SHIP_SPRITE_FIRST = 11; // sprite types 11-16 are the six ship types
const SHIP_TYPES = 6;
const PIN_COUNT = 8;
const ICON_ROWS = 20; // the sprite blitter is called with 20 rows for window icons
const NO_PIN = 0xff;

// Window descriptors, label lists, rectangle and word tables in the game image.
const IMG = {
  storageWindow: 0xeb8a,
  storageLabels: 0xebba,
  fuelWindow: 0xeb92,
  fuelLabels: 0xebc8,
  ccWindow: 0xeb9a,
  ccLabels: 0xebd6,
  ccStatus: 0xebe4,
  ccNone: 0xebec,
  hospitalWindow: 0xeba2,
  hospitalLabels: 0xebf4,
  sportsWindow: 0xebaa,
  sportsLabels: 0xec08,
  missileWindow: 0xebb2,
  missileLabels: 0xec16,
  teleportWindow: 0xee8c,
  teleportLabels: 0xee94,
  orderWindow: 0xef98,
  orderLabels: 0xefa0,
  statusWindow: 0xf01e,
  statusLabels: 0xf026,
  shipRects: 0xefe0,
  pinRects: 0xee1e,
  shipWork: 0xf012,
  shipCost: 0xb251,
} as const;

export const BUTTONS = {
  commandCentre: 0xe95c,
  hospital: 0xe95c,
  sports: 0xeb06,
  missile: 0xeb5e,
  order: 0xefb4,
  teleport: 0xeea2,
} as const;

const FIRE_ICON = 0x179c2; // 16x16 image of the missile launcher's fire button
const ICON_LAUNCH = 8; // button 8 = the action of a window, 9 = exit
const ICON_EXIT = 9;

// ---- hooks -----------------------------------------------------------------------------------

export interface MissileTarget {
  x: number;
  y: number;
}

export interface BuildingHooks {
  // Own ground units. Default: ctx.objects.units. The tank teleporter needs it.
  units?: UnitSystem;
  // Position of marker pin n (0-7) or null when it is not placed. Default: ctx.objects markers.
  pin?: (n: number) => { x: number; y: number } | null;
  // Enemy search of a missile launcher ($12456): the nearest enemy within `range` cells of (x, y)
  // (20 for a small launcher, 100 for a large one). The port has no enemy model yet; without this hook a
  // launcher never has a target.
  findTarget?: (range: number, x: number, y: number) => MissileTarget | null;
  // Fire ($49E8, $381E): creates the missile. Return false when no ship slot is free.
  launchMissile?: (from: { x: number; y: number }, target: MissileTarget) => boolean;
}

// ---- record lookup ($72C0) -------------------------------------------------------------------

// Part offsets of a 2x2 building tile: tile $48 + 4k + n lies at (dx, dy) from the origin cell.
const PART = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;
const MULTI_FIRST = 0x48;
const MULTI_LAST = 0x5f;

// Byte offset of the object record that belongs to the building covering cell (x, y), or -1.
export function findRecord(world: World, x: number, y: number): number {
  const id = world.cell(x, y) & TILE_ID_MASK;
  if (id >= 0x62 || id === TILE.scaffold || id === 0x38) return -1;
  let rx = x;
  let ry = y;
  if (id >= MULTI_FIRST && id <= MULTI_LAST) {
    const [dx, dy] = PART[(id - MULTI_FIRST) % 4];
    rx -= dx;
    ry -= dy;
  }
  const o = world.objects;
  for (let slot = 0; slot < world.objectCount; slot++) {
    const at = slot * OBJECT_SIZE;
    if (o[at] === 0 && o[at + 1] === 0) continue;
    if (o[at + 4] === rx && o[at + 5] === ry) return at;
  }
  return -1;
}

function recordTile(world: World, at: number): number {
  return (world.objects[at] << 8) | world.objects[at + 1];
}

// $6BE0 without the endless loop: the type entry whose tile matches, or -1.
function typeOf(world: World, tile: number): number {
  try {
    return world.findType(tile);
  } catch {
    return -1;
  }
}

// ---- small helpers ---------------------------------------------------------------------------

const flagTables = new WeakMap<Uint8Array, Uint8Array>();

function flagTable(disk: Uint8Array): Uint8Array {
  let table = flagTables.get(disk);
  if (!table) {
    table = readFlagTable(disk);
    flagTables.set(disk, table);
  }
  return table;
}

// $6A8C: a finished building's tile ids (tile, +1, +2, +3 for a 2x2) with their flag bytes.
function writeTiles(ctx: ScreenContext, tile: number, x: number, y: number, size: number): void {
  const flags = flagTable(ctx.disk);
  const cells = ctx.world.cells;
  for (let n = 0; n < (size === 1 ? 1 : 4); n++) {
    const cx = x + PART[n][0];
    const cy = y + PART[n][1];
    if (cx >= MAP_WIDTH || cy >= MAP_HEIGHT) continue;
    const i = cy * MAP_WIDTH + cx;
    cells[i] = (cells[i] & FLAG_KEEP) | (tile + n) | (flags[tile + n] << 8);
  }
}

class Access {
  readonly state: GameState;
  constructor(readonly ctx: ScreenContext) {
    this.state = ctx.world.state;
  }
  // A field of an entry of the object type table.
  t(type: number, offset: number): number {
    return this.state.word(this.ctx.world.typeAddress(type) + offset);
  }
  setT(type: number, offset: number, value: number): void {
    this.state.setWord(this.ctx.world.typeAddress(type) + offset, value);
  }
  get power(): number {
    return this.state.byte(V.power);
  }
}

function blitIcon(screen: Screen, sprites: SpriteSet, type: number, x: number, bottomY: number): void {
  const frame = sprites.frame(type, 0);
  if (!frame) return;
  const rows = Math.min(frame.rows, ICON_ROWS);
  const first = frame.rows - rows; // the blitter takes the first 20 rows counted from the bottom
  const top = bottomY - rows + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 32; c++) {
      const i = (first + r) * 32 + c;
      if (frame.opaque[i]) screen.set(x + c, top + r, frame.index[i]);
    }
  }
}

// A window that only shows numbers and leaves on any button ($B99C).
abstract class ReadOut extends PanelScene {
  constructor(ctx: ScreenContext, windowAddress: number, buttons: number = BUTTON_TABLE.default, ui?: Ui) {
    const u = ui ?? new Ui(ctx.disk, ctx.strings);
    super(ctx, u.readWindow(windowAddress), buttons, u);
  }
}

// ---- power storage $BED4 and fuel tanks $BF56 ----------------------------------------------

class StorageScreen extends ReadOut {
  private readonly a: Access;
  private readonly labelList: Label[];

  constructor(ctx: ScreenContext) {
    super(ctx, IMG.storageWindow);
    this.a = new Access(ctx);
    this.labelList = this.ui.readLabels(IMG.storageLabels);
  }

  protected drawContent(screen: Screen): void {
    const a = this.a;
    this.labels(screen, this.labelList);
    const count = a.t(TYPE.storage, T.total);
    const values = [Math.floor(a.t(TYPE.storage, T.stored) / 10), count * Math.floor(a.state.word(V.storageUnit) / 10), count];
    this.ui.numbers(screen, values, 187, 75, 4, COLOR.highlight);
  }
}

class FuelScreen extends ReadOut {
  private readonly a: Access;
  private readonly labelList: Label[];

  constructor(ctx: ScreenContext) {
    super(ctx, IMG.fuelWindow);
    this.a = new Access(ctx);
    this.labelList = this.ui.readLabels(IMG.fuelLabels);
  }

  protected drawContent(screen: Screen): void {
    const a = this.a;
    this.labels(screen, this.labelList);
    const small = a.t(TYPE.fuelA, T.total);
    const large = a.t(TYPE.fuelB, T.total);
    const values = [a.t(TYPE.fuelA, T.stored) + a.t(TYPE.fuelB, T.stored), small * 800 + large * 1200, small, large];
    this.ui.numbers(screen, values, 188, 75, 4, COLOR.highlight);
  }
}

// ---- command centre $BFEC ---------------------------------------------------------------------

class CommandCentreScreen extends PanelScene {
  private readonly a: Access;
  private readonly labelList: Label[];
  private readonly status: Label;
  private readonly none: Label;

  constructor(
    ctx: ScreenContext,
    private readonly at: number,
    ui: Ui,
  ) {
    super(ctx, ui.readWindow(IMG.ccWindow), BUTTONS.commandCentre, ui);
    this.a = new Access(ctx);
    this.labelList = ui.readLabels(IMG.ccLabels);
    this.status = ui.readLabels(IMG.ccStatus)[0];
    this.none = ui.readLabels(IMG.ccNone)[0];
  }

  private get online(): boolean {
    return this.ctx.world.objects[this.at + 3] === 0xff;
  }

  protected drawContent(screen: Screen): void {
    const a = this.a;
    this.labels(screen, this.labelList);
    // Highlighted part: the state of this centre, the count of active ones, and a warning when none is online.
    this.ui.str(screen, this.online ? 0x49 : 0x48, this.status.x, this.status.y, COLOR.highlight);
    if (a.t(TYPE.commandCentre, T.total) === 0) this.ui.str(screen, this.none.index, this.none.x, this.none.y, COLOR.highlight);
    this.ui.numbers(screen, [a.t(TYPE.commandCentre, T.active)], 205, 48, 4, COLOR.highlight);
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === ICON_EXIT) return "close";
    if (index === ICON_LAUNCH) this.toggle();
    return "running";
  }

  // Button 8: switch this centre on or off. Only one centre can be online ($C0FE-$C1B4).
  private toggle(): void {
    const world = this.ctx.world;
    const o = world.objects;
    const at = this.at;
    o[at + 3] = ~o[at + 3] & 0xff;
    if (o[at + 3] === 0) {
      this.a.setT(TYPE.commandCentre, T.total, this.a.t(TYPE.commandCentre, T.total) - 1);
    } else {
      const count = this.a.t(TYPE.commandCentre, T.total) + 1;
      this.a.setT(TYPE.commandCentre, T.total, count);
      if (count !== 1) {
        // Another centre was online: every centre goes offline, this one stays the only online one.
        for (let slot = 0; slot < world.objectCount; slot++) {
          const r = slot * OBJECT_SIZE;
          if (recordTile(world, r) !== TILE.commandCentre) continue;
          o[r + 3] = 0;
          this.redraw(r);
        }
        o[at + 3] = 0xff;
        this.a.setT(TYPE.commandCentre, T.total, 1);
      }
    }
    this.redraw(at);
  }

  // $7342: the map cells of a centre show the online or the offline tiles.
  private redraw(at: number): void {
    const o = this.ctx.world.objects;
    writeTiles(this.ctx, o[at + 3] === 0xff ? TILE.commandCentre : TILE.commandCentreOff, o[at + 4], o[at + 5], 4);
  }
}

// ---- hospital $C1BE ----------------------------------------------------------------------------

const BIRTH_LABEL = [0x2e, 0x2f, 0x30, 0x31]; // none, low, medium, high
const BIRTH_RATES = [0, 0x14, 0x1e, 0x3c];

export function birthRateLabel(rate: number): number {
  const i = BIRTH_RATES.indexOf(rate);
  return BIRTH_LABEL[i < 0 ? 3 : i];
}

// Button 8: the next birth rate (an unknown value starts again at 0).
export function nextBirthRate(rate: number): number {
  const i = BIRTH_RATES.indexOf(rate);
  return i < 0 ? 0 : BIRTH_RATES[(i + 1) % BIRTH_RATES.length];
}

class HospitalScreen extends PanelScene {
  private readonly a: Access;
  private readonly labelList: Label[];

  constructor(ctx: ScreenContext, ui: Ui) {
    super(ctx, ui.readWindow(IMG.hospitalWindow), BUTTONS.hospital, ui);
    this.a = new Access(ctx);
    this.labelList = ui.readLabels(IMG.hospitalLabels);
  }

  protected drawContent(screen: Screen): void {
    this.labels(screen, this.labelList);
    const s = this.a.state;
    this.ui.numbers(screen, [this.a.t(TYPE.hospital, T.total), s.long(V.medics)], 173, 48, 4, COLOR.highlight);
    this.ui.str(screen, birthRateLabel(s.byte(V.birthRate)), 134, 79, COLOR.highlight);
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === ICON_EXIT) return "close";
    if (index === ICON_LAUNCH) this.a.state.setByte(V.birthRate, nextBirthRate(this.a.state.byte(V.birthRate)));
    return "running";
  }
}

// ---- sports complex $C312 -------------------------------------------------------------------

export const EVENT_WEEKS = 12;

class SportsScreen extends PanelScene {
  private readonly a: Access;
  private readonly labelList: Label[];
  private announced = false;

  constructor(ctx: ScreenContext, ui: Ui) {
    super(ctx, ui.readWindow(IMG.sportsWindow), BUTTONS.sports, ui);
    this.a = new Access(ctx);
    this.labelList = ui.readLabels(IMG.sportsLabels);
  }

  protected drawContent(screen: Screen): void {
    this.labels(screen, this.labelList);
    this.ui.numbers(screen, [this.a.t(TYPE.sports, T.total)], 175, 62, 4, COLOR.highlight);
    const weeks = this.a.state.byte(V.eventWeeks);
    if (this.announced) {
      this.ui.str(screen, 0x50, 24, 80, COLOR.highlight);
    } else if (weeks !== 0) {
      const text = this.ctx.strings.get(0x51);
      const at = this.ctx.strings.placeholder(0x51);
      if (at >= 0) {
        const digits = this.ui.numberText(weeks, 2);
        digits.forEach((d, i) => {
          if (at + i < text.length) text[at + i] = d;
        });
      }
      this.ui.text(screen, text, 24, 80, COLOR.highlight);
    } else {
      this.ui.str(screen, 0x4f, 24, 80, COLOR.highlight);
    }
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === ICON_EXIT) return "close";
    if (index === ICON_LAUNCH && this.a.state.byte(V.eventWeeks) === 0) {
      // The simulation reports the event and adds morale on its next monthly step.
      this.a.state.setByte(V.eventWeeks, EVENT_WEEKS);
      this.a.state.setByte(V.eventFlags, this.a.state.byte(V.eventFlags) | 1);
      this.announced = true;
    }
    return "running";
  }
}

// ---- missile launcher $E086 ---------------------------------------------------------------

// $49E8 (the part that removes the launcher): the record is freed, the counters drop and the cell becomes rubble.
export function removeBuilding(ctx: ScreenContext, at: number): void {
  const world = ctx.world;
  const o = world.objects;
  const a = new Access(ctx);
  const type = typeOf(world, recordTile(world, at));
  const x = o[at + 4];
  const y = o[at + 5];
  const active = o[at + 3] !== 0;
  o[at] = 0;
  o[at + 1] = 0;
  a.state.setWord(0x142c2, a.state.word(0x142c2) - 1);
  if (type >= 0) {
    a.setT(type, T.active, a.t(type, T.active) - 1);
    if (active) a.setT(type, T.total, a.t(type, T.total) - 1);
  }
  writeTiles(ctx, TILE.rubble, x, y, 1);
}

class MissileScreen extends PanelScene {
  private readonly a: Access;
  private readonly labelList: Label[];
  private readonly target: MissileTarget | null;
  private readonly launcher: { x: number; y: number };

  constructor(
    ctx: ScreenContext,
    private readonly at: number,
    private readonly hooks: BuildingHooks,
    ui: Ui,
  ) {
    super(ctx, ui.readWindow(IMG.missileWindow), BUTTONS.missile, ui);
    this.a = new Access(ctx);
    this.labelList = ui.readLabels(IMG.missileLabels);
    const o = ctx.world.objects;
    this.launcher = { x: o[at + 4], y: o[at + 5] };
    // $12456: searched once when the window opens; range 20 for the small launcher, 100 for the large one.
    const range = recordTile(ctx.world, at) === TILE.missileA ? 0x14 : 0x64;
    this.target = hooks.findTarget ? hooks.findTarget(range, this.launcher.x, this.launcher.y) : null;
  }

  // The fire icon exists only while there is a target: the original stores the icon's address in slot 8 of the
  // button table when its search succeeds and clears the slot otherwise.
  override draw(screen: Screen): void {
    super.draw(screen);
    this.ui.drawButton(screen, ICON_LAUNCH, this.target ? FIRE_ICON : 0);
    if (this.pressedButton === ICON_LAUNCH && this.target) this.ui.invertButton(screen, ICON_LAUNCH);
  }

  protected drawContent(screen: Screen): void {
    // The third label's string is replaced: "armed" with a target, "no target" without.
    const [first, second, third] = this.labelList;
    this.ui.str(screen, first.index, first.x, first.y, COLOR.text);
    this.ui.str(screen, second.index, second.x, second.y, COLOR.text);
    if (third) this.ui.str(screen, this.target ? 0x12a : 0x129, third.x, third.y, COLOR.text);
    this.ui.numbers(screen, [this.a.t(TYPE.missileA, T.total), this.a.t(TYPE.missileB, T.total)], 182, 69, 4, COLOR.highlight);
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === ICON_EXIT) return "close";
    if (index !== ICON_LAUNCH || !this.target) return "running";
    const fired = this.hooks.launchMissile ? this.hooks.launchMissile(this.launcher, this.target) : false;
    if (!fired) {
      this.ctx.say?.(MSG.launchMalfunction);
      return "close";
    }
    removeBuilding(this.ctx, this.at);
    return "close";
  }
}

// ---- tank teleporter $CAAE ----------------------------------------------------------------

// $49AA: the first own unit within one cell of (x, y).
export function unitNear(units: UnitSystem, x: number, y: number): Unit | null {
  return units.units.find((u) => Math.abs(u.x - x) <= 1 && Math.abs(u.y - y) <= 1) ?? null;
}

// $722A: move the unit to the pin's cell. Returns the message the original shows.
export function teleportUnit(ctx: ScreenContext, units: UnitSystem, unit: Unit, to: { x: number; y: number }): number {
  const cells = ctx.world.cells;
  const dest = to.y * MAP_WIDTH + to.x;
  if ((cells[dest] & TELEPORT_BLOCKERS) !== 0) return MSG.teleportBlocked;
  cells[dest] |= OCCUPIED;
  units.flags[dest] |= OWN_UNIT_FLAG;
  // The original clears the marks at the unit's own (x, y), not at the cell it had reserved, and leaves the
  // pixel offset alone: a unit teleported in mid-step keeps its stale reserved cell.
  const old = unit.y * MAP_WIDTH + unit.x;
  cells[old] &= ~OCCUPIED;
  units.flags[old] &= ~OWN_UNIT_FLAG;
  unit.reserveX = to.x;
  unit.reserveY = to.y;
  unit.x = to.x;
  unit.y = to.y;
  return MSG.teleported;
}

class TeleportScreen extends PanelScene {
  private readonly labelList: Label[];
  private readonly sprites: SpriteSet;
  private readonly rects: { x0: number; x1: number; y0: number; y1: number }[];
  private readonly pins: ({ x: number; y: number } | null)[];
  private selected = NO_PIN;

  constructor(
    ctx: ScreenContext,
    private readonly units: UnitSystem,
    private readonly unit: Unit,
    pin: (n: number) => { x: number; y: number } | null,
    ui: Ui,
  ) {
    super(ctx, ui.readWindow(IMG.teleportWindow), BUTTONS.teleport, ui);
    this.labelList = ui.readLabels(IMG.teleportLabels);
    this.sprites = loadBuiltinSprites(ctx.disk);
    this.rects = readRects(ui, IMG.pinRects, PIN_COUNT);
    this.pins = Array.from({ length: PIN_COUNT }, (_, n) => pin(n));
  }

  private get mask(): number {
    return this.pins.reduce((m, p, n) => (p ? m | (1 << n) : m), 0);
  }

  protected drawContent(screen: Screen): void {
    this.labels(screen, this.labelList);
    if (this.mask === 0) {
      this.ui.str(screen, 0x92, 92, 102, COLOR.highlight);
      return;
    }
    this.pins.forEach((p, n) => {
      if (p) blitIcon(screen, this.sprites, n + 1, this.rects[n].x0 - 8, this.rects[n].y1);
    });
    if (this.selected !== NO_PIN) {
      const text = this.ctx.strings.get(0x10b);
      const at = this.ctx.strings.placeholder(0x10b);
      if (at >= 0 && at < text.length) text[at] = 0x31 + this.selected;
      this.ui.text(screen, text, 68, 102, COLOR.highlight);
    }
  }

  protected override onClick(): void {
    const { x, y } = this.pointer;
    const n = this.rects.findIndex((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    if (n >= 0 && this.pins[n]) this.selected = n;
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === ICON_EXIT) return "close";
    if (index !== ICON_LAUNCH) return "running";
    if (this.selected !== NO_PIN) {
      const to = this.pins[this.selected];
      if (to) this.ctx.say?.(teleportUnit(this.ctx, this.units, this.unit, to));
    }
    return "close";
  }
}

function readRects(ui: Ui, address: number, count: number): { x0: number; x1: number; y0: number; y1: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const a = address + 8 * i;
    return { x0: ui.image.word(a), x1: ui.image.word(a + 2), y0: ui.image.word(a + 4), y1: ui.image.word(a + 6) };
  });
}

// ---- ship yard $D7D6 -------------------------------------------------------------------------

// Months shown for an order: work / (staff per yard + 1) + 1 ($D9xx).
export function shipMonths(work: number, staff: number, yards: number): number {
  const d1 = Math.floor(staff / Math.max(1, yards)) + 1;
  return Math.floor(work / d1) + 1;
}

class ShipOrderScreen extends PanelScene {
  private readonly a: Access;
  private readonly labelList: Label[];
  private readonly sprites: SpriteSet;
  private readonly rects: { x0: number; x1: number; y0: number; y1: number }[];
  private readonly workTable: number[];
  private selected = -1; // $F174 (-1 = none yet)
  private work = 0; // $F173

  constructor(
    ctx: ScreenContext,
    private readonly at: number,
    ui: Ui,
  ) {
    super(ctx, ui.readWindow(IMG.orderWindow), BUTTONS.order, ui);
    this.a = new Access(ctx);
    this.labelList = ui.readLabels(IMG.orderLabels);
    this.sprites = loadBuiltinSprites(ctx.disk);
    this.rects = readRects(ui, IMG.shipRects, SHIP_TYPES);
    this.workTable = Array.from({ length: SHIP_TYPES }, (_, i) => ui.image.word(IMG.shipWork + 2 * i));
  }

  private unlocked(index: number): boolean {
    return index !== INVENTION_FUSION || (this.a.state.long(V.inventions) & (1 << INVENTION_FUSION)) !== 0;
  }

  protected drawContent(screen: Screen): void {
    this.labels(screen, this.labelList);
    for (let k = 0; k < SHIP_TYPES; k++) {
      if (this.unlocked(k)) blitIcon(screen, this.sprites, SHIP_SPRITE_FIRST + k, this.rects[k].x0 - 8, this.rects[k].y1);
    }
    if (this.selected >= 0) {
      this.ui.str(screen, 0xbe + this.selected, 57, 103, COLOR.highlight);
      const months = shipMonths(this.work, this.a.state.long(V.shipStaff), this.a.t(TYPE.shipYard, T.total));
      this.ui.numbers(screen, [months], 136, 121, 3, COLOR.highlight);
    }
  }

  protected override onClick(): void {
    const { x, y } = this.pointer;
    const k = this.rects.findIndex((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    // Deviation: the original selects a locked icon without showing it and would then store a stale work value;
    // here a locked icon is simply not selectable.
    if (k >= 0 && this.unlocked(k)) {
      this.selected = k;
      this.work = this.workTable[k];
    }
  }

  protected override onButton(index: number): "running" | "close" {
    if (index === ICON_EXIT) return "close";
    if (index !== ICON_LAUNCH) return "running";
    if (this.selected >= 0) {
      const o = this.ctx.world.objects;
      o[this.at + 6] = this.selected + 1;
      o[this.at + 7] = this.work;
    }
    return "close";
  }
}

class ShipStatusScreen extends ReadOut {
  private readonly a: Access;
  private readonly labelList: Label[];

  constructor(
    ctx: ScreenContext,
    private readonly at: number,
    ui: Ui,
  ) {
    super(ctx, IMG.statusWindow, BUTTON_TABLE.default, ui);
    this.a = new Access(ctx);
    this.labelList = ui.readLabels(IMG.statusLabels);
  }

  protected drawContent(screen: Screen): void {
    const o = this.ctx.world.objects;
    this.labels(screen, this.labelList);
    this.ui.str(screen, 0xbd + o[this.at + 6], 73, 70, COLOR.highlight);
    const work = o[this.at + 7];
    const months = work === 0xff ? 0 : shipMonths(work, this.a.state.long(V.shipStaff), this.a.t(TYPE.shipYard, T.total));
    this.ui.numbers(screen, [months], 156, 88, 3, COLOR.highlight);
  }
}

// ---- gun turrets -----------------------------------------------------------------------------

// A click on a gun turret ($71D0-$7228): while it rotates by itself the click only stops it; a stopped
// turret turns one facing step. Either way the turret's name is shown.
export function clickGun(ctx: ScreenContext, at: number): void {
  const world = ctx.world;
  const o = world.objects;
  const tile = recordTile(world, at);
  const type = typeOf(world, tile);
  if (o[at + 6] === 0) {
    const x = o[at + 4];
    const y = o[at + 5];
    const i = y * MAP_WIDTH + x;
    let low = world.cells[i] & 0xff;
    if (low >= 0x27 || (low >= 0x17 && low < 0x1f)) {
      low -= GUN_FIRING_OFFSET; // back from a firing frame to the facing frame
      o[at + 7] = 0;
    }
    low++;
    o[at + 2] = (o[at + 2] + 1) & 0xff;
    if (o[at + 2] === 8) {
      o[at + 2] = 0;
      low = type >= 0 ? ctx.world.state.byte(world.typeAddress(type) + 9) : tile;
    }
    world.cells[i] = (world.cells[i] & 0xff00) | low;
  }
  o[at + 6] = 0;
  if (type >= 0) ctx.say?.(ctx.world.state.word(world.typeAddress(type) + 0x10));
}

// ---- the dispatcher ----------------------------------------------------------------------------

// The click on map cell (x, y) in select mode ($7140). Returns the window to run, or null when the click was
// handled at once or does nothing. While a window is returned the sim and the map must not run.
export function createBuildingScreen(ctx: ScreenContext, x: number, y: number, hooks: BuildingHooks = {}): ScreenScene | null {
  const world = ctx.world;
  if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return null;
  const at = findRecord(world, x, y);
  if (at < 0) {
    const id = world.cell(x, y) & TILE_ID_MASK;
    if (id === TILE.scaffold) ctx.say?.(MSG.scaffold);
    else if (id === TILE.mine) ctx.say?.(MSG.landMine);
    return null;
  }
  const tile = recordTile(world, at);
  const power = world.state.byte(V.power);
  const refuse = (limit: number): boolean => {
    if (power < limit) return false;
    ctx.say?.(MSG.noPower);
    return true;
  };
  const ui = new Ui(ctx.disk, ctx.strings);

  switch (tile) {
    case 1:
    case 2:
    case 3:
      return new StorageScreen(ctx);
    case TILE.commandCentre:
      return refuse(14) ? null : new CommandCentreScreen(ctx, at, ui);
    case TILE.fuelA:
    case TILE.fuelB:
      return new FuelScreen(ctx);
    case TILE.hospital:
      return refuse(15) ? null : new HospitalScreen(ctx, ui);
    case TILE.missileA:
    case TILE.missileB:
      return new MissileScreen(ctx, at, hooks, ui);
    case TILE.shipYard: {
      if (world.state.word(world.typeAddress(TYPE.commandCentre) + T.total) === 0) {
        ctx.say?.(MSG.noCommandCentre);
        return null;
      }
      return world.objects[at + 6] !== 0 ? new ShipStatusScreen(ctx, at, ui) : new ShipOrderScreen(ctx, at, ui);
    }
    case TILE.sports:
      return refuse(2) ? null : new SportsScreen(ctx, ui);
    case TILE.laser:
    case TILE.plasma:
      clickGun(ctx, at);
      return null;
    case TILE.teleport:
      return openTeleport(ctx, x, y, hooks, ui);
    default: {
      const type = typeOf(world, tile);
      if (type >= 0) ctx.say?.(world.state.word(world.typeAddress(type) + 0x10));
      return null;
    }
  }
}

function openTeleport(ctx: ScreenContext, x: number, y: number, hooks: BuildingHooks, ui: Ui): ScreenScene | null {
  if (ctx.world.state.byte(V.power) !== 0) {
    ctx.say?.(MSG.noPower);
    return null;
  }
  const units = hooks.units ?? ctx.objects?.units;
  const unit = units && (ctx.world.cell(x, y) & OCCUPIED) !== 0 ? unitNear(units, x, y) : null;
  if (!units || !unit) {
    ctx.say?.(MSG.noTank);
    return null;
  }
  const pin = hooks.pin ?? ((n: number) => ctx.objects?.markerCell(n + 1) ?? null);
  return new TeleportScreen(ctx, units, unit, pin, ui);
}
