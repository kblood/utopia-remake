// Own ground units (the list at $3AB06, max 99): spawning and movement.
// Port of $37CA (create), $A6D2-$A756 (free cell next to the building that makes them), $C8B4 (order a
// unit to a marker pin) and $38E2 (one movement step), see notes/formats/units.md. The movement step is
// shared with the enemy ground units (enemies.ts); the combat hook $12588 is a UnitHooks callback.

import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";
import type { Disk4TankSlot } from "../data/disk4-entities.js";
import { CELL_FLAG_BYTES, cellFlagIndex, mapIndex, resolveCellFlagPointer } from "./cell-flags.js";

export const UNIT_BASIC = 9; // object types 9 and 10 are the ground units; 11-17 are spaceships
export const UNIT_ADVANCED = 10; // made instead of 9 once invention bit 2 is set ($14472); crosses rocks
export const MAX_UNITS = 99;
export const NO_TARGET = 0xff;

export const BLOCKED = 0x1000; // map cell flag bit 12: building or rock
export const OCCUPIED = 0x4000; // map cell flag bit 14: reserved by a unit (the original's "visited" bit)
export const ROCK_FIRST_ID = 0x88; // the advanced unit may enter blocked cells whose tile id is at least this
export const TILE_ID = 0x3ff;
const OWN_UNIT_FLAG = 4; // per-cell flag byte bit 2 ($3D3A6 array)

// Direction 0 is up-right on the screen and the numbering runs clockwise: 0 (0,-1), 1 (+1,-1),
// 2 (+1,0), 3 (+1,+1), 4 (0,+1), 5 (-1,+1), 6 (-1,0), 7 (-1,-1) in map cells.
// $4C1A: per direction the pixel offset of the next cell centre (dx, dy) and the map step.
export const STEP_PIXELS: readonly (readonly [number, number])[] = [
  [16, -8],
  [32, 0],
  [16, 8],
  [0, 16],
  [-16, 8],
  [-32, 0],
  [-16, -8],
  [0, -16],
];
export const DIR_STEP: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];
// $4BCA + 8, +9: pixel offset added per movement step in each direction.
export const VELOCITY: readonly (readonly [number, number])[] = [
  [2, -1],
  [2, 0],
  [2, 1],
  [0, 2],
  [-2, 1],
  [-2, 0],
  [-2, -1],
  [0, -2],
];
// Candidate order when the straight way is blocked: d, d+1, d-1, d+2, d-2, d+3, d-3 ($4BCA).
export const TURNS = [0, 1, -1, 2, -2, 3, -3];

// What the movement step needs from a unit: the own tanks and the enemy ground units both have these fields.
export interface Walker {
  readonly type: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  dir: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  recent: [number, number, number];
  reserveX: number;
  reserveY: number;
}

// The part of $38E2 that differs between the users: which map word / flag byte bit marks the unit, which
// blocked cells it may enter, and what happens when it walks off the map.
export interface StepEnv {
  cells: Uint16Array; // packed map words, index y * 100 + x
  flags: Uint8Array; // original flag plane, index y * 102 + x
  flagBit: number; // per-cell flag byte bit (own units 4, enemy ground units 1)
  canEnter(word: number, u: Walker): boolean; // false = blocked for this unit
  leave(u: Walker): void; // the border cell was reached ($3C40)
  entered?(u: Walker, x: number, y: number, word: number): void; // the unit starts towards cell (x, y)
  atCentre?(u: Walker): boolean; // on a cell centre before a direction is chosen; true = the unit is gone, stop
  /**
   * The next cell's occupancy bit has just been set, but nothing else has moved yet: the old cell still holds its
   * bit and flag, the next cell's flag byte is not set, the reservation, recent directions, direction and velocity
   * are the old ones. Crusher only: `$1228A` knocks the building down at exactly this point, before `$122B4` moves
   * the marks.
   */
  claimed?(u: Walker, x: number, y: number, word: number): void;
  /** Replaces `arrive` (the order is finished or every way is blocked). Crusher: `$1231A` only sets +B to $FF. */
  arrive?(u: Walker): void;
  /** Overrides whether the last candidate slot repeats d+3 (the default: only for UNIT_ADVANCED). The crusher repeats it. */
  repeatLastCandidate?: boolean;
  /** Pixel offsets and velocities are bytes (`add.b`, `cmp.b`) and wrap at 256; the crusher step does that. */
  byteOffsets?: boolean;
}

export function inMap(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT;
}

// $3C7C: the order is finished (or the way is blocked): +B becomes $FF (that alone means "no order"), the velocity is
// zeroed. +C keeps the old target y: the original capture of an arrived own tank still held +C = 49 with +B = $FF.
function arrive(u: Walker): void {
  u.targetX = NO_TARGET;
  u.vx = 0;
  u.vy = 0;
}

// $38E2: advance one walker by one movement step.
export function walkerStep(u: Walker, env: StepEnv): void {
  if (u.targetX === NO_TARGET) return;
  const saved = { x: u.x, y: u.y, dx: u.dx, dy: u.dy, dir: u.dir, vx: u.vx, vy: u.vy };
  const finish = env.arrive ?? arrive;

  // Move the pixel offset; when it equals the distance to the next cell centre, change cells.
  let dx = u.dx + u.vx;
  let dy = u.dy + u.vy;
  const [stepX, stepY] = STEP_PIXELS[u.dir];
  if (env.byteOffsets) {
    dx = ((dx + 128) & 255) - 128; // add.b
    dy = ((dy + 128) & 255) - 128;
  }
  if (dx === stepX && dy === stepY) {
    dx = 0;
    dy = 0;
    u.x += DIR_STEP[u.dir][0];
    u.y += DIR_STEP[u.dir][1];
  }
  u.dx = dx;
  u.dy = dy;
  if (dx !== 0 || dy !== 0) return; // still between two cell centres
  // A unit that kept its velocity after an arrival (crusher, `$1231A`) can slide into a cell it never reserved, and
  // off the map. The original reads the pad words there (untraced); HYPOTHESIS: it counts as leaving the map.
  if (!inMap(u.x, u.y)) return env.leave(u);

  // On a cell centre: pick the direction towards the target, greedy and without path finding.
  const tx = u.targetX;
  const ty = u.targetY;
  let want: number;
  if (u.x === tx) {
    if (u.y === ty) return finish(u);
    want = u.y < ty ? 4 : 0;
  } else if (u.x < tx) {
    want = u.y < ty ? 3 : 1;
    if (u.y === ty) want = 2;
  } else {
    want = u.y < ty ? 5 : 7;
    if (u.y === ty) want = 6;
  }
  if (env.atCentre?.(u)) return;

  // Candidate slots: d, d+1, d-1, d+2, d-2, d+3, d-3. The advanced unit's code repeats d+3 in the last
  // slot instead of trying d-3 (original quirk, kept).
  const advanced = env.repeatLastCandidate ?? u.type === UNIT_ADVANCED;
  for (let k = 0; k < TURNS.length; k++) {
    const turn = advanced && k === 6 ? TURNS[5] : TURNS[k];
    const dir = (want + turn + 8) & 7;
    const last = k === TURNS.length - 1;
    if (u.recent.includes(dir)) {
      if (last) return finish(u);
      continue;
    }
    const nx = u.x + DIR_STEP[dir][0];
    const ny = u.y + DIR_STEP[dir][1];
    if (!inMap(nx, ny)) return env.leave(u); // the border cell: the unit leaves the map and is lost
    const index = mapIndex(nx, ny);
    const flagIndex = cellFlagIndex(nx, ny);
    const word = env.cells[index];
    if (!env.canEnter(word, u)) {
      if (last) return finish(u);
      continue;
    }
    if (word & OCCUPIED) {
      if (last) {
        // Every way is taken: undo this step and try again next time ($3C88).
        Object.assign(u, saved);
        return;
      }
      continue;
    }
    // $3BC6: reserve the next cell, release the current one and start moving.
    env.cells[index] |= OCCUPIED;
    env.claimed?.(u, nx, ny, word);
    env.flags[flagIndex] |= env.flagBit;
    const here = mapIndex(u.x, u.y);
    const hereFlag = cellFlagIndex(u.x, u.y);
    env.cells[here] &= ~OCCUPIED;
    env.flags[hereFlag] &= ~env.flagBit;
    u.reserveX = nx;
    u.reserveY = ny;
    const back = (dir + 4) & 7; // the three directions that would turn the unit around
    u.recent = [back, (back + 7) & 7, (back + 1) & 7];
    u.dir = dir;
    [u.vx, u.vy] = VELOCITY[dir];
    env.entered?.(u, nx, ny, word);
    return;
  }
}

export class Unit {
  dx = 0; // +3, +4: pixel offset from the cell centre while moving
  dy = 0;
  dir = 0; // +5: facing and sprite frame
  vx = 0; // +6, +7
  vy = 0;
  hp: number; // +8
  targetX = NO_TARGET; // +B, +C
  targetY = NO_TARGET;
  recent: [number, number, number] = [0xff, 0xff, 0xff]; // +$10-$12: the three directions that would turn back
  reserveX: number; // cell this unit holds the "occupied" bit of (the original keeps a pointer, +$14)
  reserveY: number;
  // Byte +9 bit 7: the unit waits for the next move tick. It starts set ($FF at creation) and combat sets it
  // again; the move tick clears it, and a unit that is not waiting is stepped on every pass.
  /** Full original +9 control byte; bit 7 is the waiting bit. */
  control = 0xff;
  readonly sourceRaw: Uint8Array | null;
  readonly sourceAddress: number | null;
  readonly flagPointer: number | null;

  constructor(
    readonly type: number,
    public x: number,
    public y: number,
    public tech: number,
    readonly slot: number = -1,
    snapshot?: {
      dx: number; dy: number; dir: number; vx: number; vy: number; hp: number;
      control: number; targetX: number; targetY: number; recent: readonly [number, number, number];
      reserveX: number; reserveY: number; raw: Uint8Array; address: number; flagPointer: number;
    },
  ) {
    if (snapshot) {
      this.dx = snapshot.dx; this.dy = snapshot.dy; this.dir = snapshot.dir;
      this.vx = snapshot.vx; this.vy = snapshot.vy; this.hp = snapshot.hp;
      this.control = snapshot.control; this.targetX = snapshot.targetX; this.targetY = snapshot.targetY;
      this.recent = [...snapshot.recent]; this.reserveX = snapshot.reserveX; this.reserveY = snapshot.reserveY;
      this.sourceRaw = snapshot.raw.slice(); this.sourceAddress = snapshot.address; this.flagPointer = snapshot.flagPointer;
    } else {
      this.hp = 8 + 2 * tech; // $4B76 table value 8, plus 2 per tech level ($3810)
      this.reserveX = x;
      this.reserveY = y;
      this.sourceRaw = null; this.sourceAddress = null; this.flagPointer = null;
    }
  }

  get waiting(): boolean { return (this.control & 0x80) !== 0; }
  set waiting(value: boolean) { this.control = value ? (this.control | 0x80) : (this.control & 0x7f); }

  static fromDisk4(slot: Disk4TankSlot, reservation: { x: number; y: number }): Unit {
    return new Unit(slot.type, slot.x, slot.y, slot.tech, slot.index, {
      dx: slot.dx, dy: slot.dy, dir: slot.direction, vx: slot.vx, vy: slot.vy, hp: slot.hp,
      control: slot.control, targetX: slot.targetX, targetY: slot.targetY,
      recent: slot.recentDirections, reserveX: reservation.x, reserveY: reservation.y,
      raw: slot.raw, address: slot.address, flagPointer: slot.flagPointer,
    });
  }

  get moving(): boolean {
    return this.vx !== 0 || this.vy !== 0;
  }

  get hasTarget(): boolean {
    return this.targetX !== NO_TARGET;
  }
}

export interface UnitHooks {
  // A unit walked off the map edge; the original removes it and lowers morale by 50 ($4692, $A246).
  lost?: (unit: Unit) => void;
  // $12588, called after each step: the unit shoots at enemies around it (only on the move tick).
  combat?: (unit: Unit, moveTick: boolean) => void;
}

export interface UnitRestoreError {
  readonly code: "slot-count" | "slot-index" | "unit-type" | "position" | "direction" | "flag-pointer" | "sub-tick";
  readonly slot?: number;
  readonly field?: string;
  readonly message: string;
}
export type UnitRestoreResult = { readonly ok: true; readonly value: UnitSystem } | { readonly ok: false; readonly error: UnitRestoreError };

// The sub-tick clock of the main loop ($144C9, $156A9 bits 7 and 6): counts passes 0..8; on the pass that wraps to
// 0 the "move tick" is set, on the pass that reaches 4 the "enemy tick". Both last for that pass only.
export class PassClock {
  sub = 0;
  moveTick = false;
  enemyTick = false;

  advance(): void {
    this.moveTick = false;
    this.enemyTick = false;
    this.sub++;
    if (this.sub === 9) {
      this.sub = 0;
      this.moveTick = true;
    } else if (this.sub === 4) {
      this.enemyTick = true;
    }
  }
}

export class UnitSystem {
  readonly slots: (Unit | null)[] = new Array<Unit | null>(MAX_UNITS).fill(null);
  /** Occupied units in stable slot order. */
  get units(): Unit[] { return this.slots.filter((unit): unit is Unit => unit !== null); }
  readonly flags: Uint8Array;
  readonly clock = new PassClock(); // $144C9 / $156A9
  private readonly env: StepEnv;

  constructor(
    private readonly cells: Uint16Array,
    private readonly techLevel: () => number = () => 1,
    private hooks: UnitHooks = {},
    flags: Uint8Array = new Uint8Array(CELL_FLAG_BYTES),
  ) {
    if (flags.length !== CELL_FLAG_BYTES) throw new Error(`UnitSystem flags are ${flags.length} bytes, expected ${CELL_FLAG_BYTES}`);
    this.flags = flags;
    this.env = {
      cells,
      flags: this.flags,
      flagBit: OWN_UNIT_FLAG,
      canEnter: (word, u) => !(word & BLOCKED) || (u.type === UNIT_ADVANCED && (word & TILE_ID) >= ROCK_FIRST_ID),
      leave: (u) => {
        this.remove(u as Unit);
        this.hooks.lost?.(u as Unit);
      },
    };
  }

  /**
   * Creates a detached tank system from all 99 saved slots. This never calls spawn, touches map/flag
   * occupancy, invokes hooks or changes saved counts. Invalid occupied records reject the whole system.
   */
  static fromDisk4(
    cells: Uint16Array,
    flags: Uint8Array,
    records: readonly Disk4TankSlot[],
    subTick: number,
    techLevel: () => number = () => 1,
    hooks: UnitHooks = {},
  ): UnitRestoreResult {
    const fail = (error: UnitRestoreError): UnitRestoreResult => ({ ok: false, error });
    if (records.length !== MAX_UNITS) return fail({ code: "slot-count", message: `Tank list has ${records.length} slots, expected ${MAX_UNITS}` });
    if (!Number.isInteger(subTick) || subTick < 0 || subTick > 8) return fail({ code: "sub-tick", field: "$144C9", message: `Saved sub-tick ${subTick} is outside 0..8` });
    const hydrated: (Unit | null)[] = new Array<Unit | null>(MAX_UNITS).fill(null);
    for (let i = 0; i < MAX_UNITS; i++) {
      const record = records[i];
      if (!record || record.index !== i || record.raw.length !== 0x18) {
        return fail({ code: "slot-index", slot: i, field: "record", message: `Tank slot ${i} has missing or inconsistent provenance` });
      }
      if (record.status === "free") continue;
      if (record.type !== UNIT_BASIC && record.type !== UNIT_ADVANCED) {
        return fail({ code: "unit-type", slot: i, field: "+0", message: `Tank slot ${i} has unsupported type ${record.type}` });
      }
      if (!inMap(record.x, record.y)) return fail({ code: "position", slot: i, field: "+1/+2", message: `Tank slot ${i} position (${record.x}, ${record.y}) is outside the map` });
      if (!Number.isInteger(record.direction) || record.direction < 0 || record.direction > 7) {
        return fail({ code: "direction", slot: i, field: "+5", message: `Tank slot ${i} direction ${record.direction} is outside 0..7` });
      }
      const reservation = resolveCellFlagPointer(record.flagPointer);
      if (reservation.kind !== "playable") {
        return fail({ code: "flag-pointer", slot: i, field: "+$14", message: `Tank slot ${i} reservation pointer is ${reservation.kind}` });
      }
      hydrated[i] = Unit.fromDisk4(record, reservation);
    }
    const system = new UnitSystem(cells, techLevel, hooks, flags);
    for (let i = 0; i < MAX_UNITS; i++) system.slots[i] = hydrated[i];
    system.clock.sub = subTick;
    return { ok: true, value: system };
  }

  /**
   * Replaces the callbacks (`lost`, `combat`) of an existing system, e.g. a Disk.4-restored one that was built with
   * none. Only the hook object changes: slots, units, clock, map/flag buffers and the tech-level source are
   * untouched and nothing is called. The new hooks take effect from the next tick.
   */
  bindHooks(hooks: UnitHooks): void {
    this.hooks = hooks;
  }

  /** True when this system runs over exactly these map-word and flag buffers (identity, not content). */
  usesBuffers(cells: Uint16Array, flags: Uint8Array): boolean {
    return this.cells === cells && this.flags === flags;
  }

  // Map cell word as the original sees it: outside the 100 x 75 area is the border value $73FF.
  private cellWord(x: number, y: number): number {
    return inMap(x, y) ? this.cells[mapIndex(x, y)] : 0x73ff;
  }

  // The test of $A6D4-$A754: a cell is free when neither bit 12 nor bit 14 is set.
  cellFree(x: number, y: number): boolean {
    return (this.cellWord(x, y) & (BLOCKED | OCCUPIED)) === 0;
  }

  // $37CA with the inputs of $A776: type 9 or 10, cell (x, y), direction 0. Null when the list is full.
  spawn(type: number, x: number, y: number, dir = 0): Unit | null {
    const slot = this.slots.indexOf(null);
    if (slot < 0) return null; // the original shows message $8F
    const unit = new Unit(type, x, y, this.techLevel(), slot);
    unit.dir = dir;
    const mapAt = mapIndex(x, y), flagAt = cellFlagIndex(x, y);
    this.cells[mapAt] |= OCCUPIED;
    this.flags[flagAt] |= OWN_UNIT_FLAG;
    this.slots[slot] = unit;
    return unit;
  }

  // $A6D2-$A756: the building at (bx, by) puts its unit on the first free neighbour, in this order.
  static readonly YARD_EXITS: readonly (readonly [number, number])[] = [
    [0, -1],
    [1, -1],
    [-1, 1],
    [-1, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, -1],
  ];

  spawnAtYard(bx: number, by: number, advanced: boolean): Unit | null {
    for (const [ox, oy] of UnitSystem.YARD_EXITS) {
      const x = bx + ox;
      const y = by + oy;
      if (this.cellFree(x, y)) return this.spawn(advanced ? UNIT_ADVANCED : UNIT_BASIC, x, y, 0);
    }
    return null; // original: message $95, tries again later
  }

  // $C8B4: send a unit to a cell (the original takes the position of one of the eight marker pins).
  order(unit: Unit, x: number, y: number): void {
    unit.targetX = x;
    unit.targetY = y;
    unit.recent = [0xff, 0xff, 0xff];
  }

  remove(unit: Unit): void {
    if (unit.slot < 0 || this.slots[unit.slot] !== unit) return;
    this.slots[unit.slot] = null;
    if (!inMap(unit.reserveX, unit.reserveY)) return;
    this.cells[mapIndex(unit.reserveX, unit.reserveY)] &= ~OCCUPIED;
    this.flags[cellFlagIndex(unit.reserveX, unit.reserveY)] &= ~OWN_UNIT_FLAG;
  }

  // One pass of the main loop ($333A). A unit is stepped on the move tick (every 9th pass) or whenever it is not
  // waiting; the combat hook runs after each step and only does something on the move tick.
  tick(): void {
    this.clock.advance();
    for (const unit of this.units.slice()) {
      if (unit.waiting && !this.clock.moveTick) continue;
      unit.waiting = false;
      this.step(unit);
      if (this.units.includes(unit)) this.hooks.combat?.(unit, this.clock.moveTick);
    }
  }

  // $38E2: advance one unit by one movement step.
  step(u: Unit): void {
    walkerStep(u, this.env);
  }
}
