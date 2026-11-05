// Own ground units (the list at $3AB06, max 99): spawning and movement.
// Port of $37CA (create), $A6D2-$A756 (free cell next to the building that makes them), $C8B4 (order a
// unit to a marker pin) and $38E2 (one movement step), see notes/formats/units.md. Not ported: the
// combat hook $12588, the enemy lists, spaceships (separate list with their own mode machine).

import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";

export const UNIT_BASIC = 9; // object types 9 and 10 are the ground units; 11-17 are spaceships
export const UNIT_ADVANCED = 10; // made instead of 9 once invention bit 2 is set ($14472); crosses rocks
export const MAX_UNITS = 99;
export const NO_TARGET = 0xff;

const BLOCKED = 0x1000; // map cell flag bit 12: building or rock
const OCCUPIED = 0x4000; // map cell flag bit 14: reserved by a unit (the original's "visited" bit)
const ROCK_FIRST_ID = 0x88; // the advanced unit may enter blocked cells whose tile id is at least this
const TILE_ID = 0x3ff;
const OWN_UNIT_FLAG = 4; // per-cell flag byte bit 2 ($3D3A6 array)

// Direction 0 is up-right on the screen and the numbering runs clockwise: 0 (0,-1), 1 (+1,-1),
// 2 (+1,0), 3 (+1,+1), 4 (0,+1), 5 (-1,+1), 6 (-1,0), 7 (-1,-1) in map cells.
// $4C1A: per direction the pixel offset of the next cell centre (dx, dy) and the map step.
const STEP_PIXELS: readonly (readonly [number, number])[] = [
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
const VELOCITY: readonly (readonly [number, number])[] = [
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
const TURNS = [0, 1, -1, 2, -2, 3, -3];

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

  constructor(
    readonly type: number,
    public x: number,
    public y: number,
    public tech: number,
  ) {
    this.hp = 8 + 2 * tech; // $4B76 table value 8, plus 2 per tech level ($3810)
    this.reserveX = x;
    this.reserveY = y;
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
}

export class UnitSystem {
  readonly units: Unit[] = [];
  // Per-cell flag bytes ($3D3A6, bit 2 = own unit on the cell), a 2-D array instead of the 102-wide one.
  readonly flags = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  private substep = 0; // $144C9

  constructor(
    private readonly cells: Uint16Array,
    private readonly techLevel: () => number = () => 1,
    private readonly hooks: UnitHooks = {},
  ) {}

  private static inMap(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT;
  }

  // Map cell word as the original sees it: outside the 100 x 75 area is the border value $73FF.
  private cellWord(x: number, y: number): number {
    return UnitSystem.inMap(x, y) ? this.cells[y * MAP_WIDTH + x] : 0x73ff;
  }

  // The test of $A6D4-$A754: a cell is free when neither bit 12 nor bit 14 is set.
  cellFree(x: number, y: number): boolean {
    return (this.cellWord(x, y) & (BLOCKED | OCCUPIED)) === 0;
  }

  // $37CA with the inputs of $A776: type 9 or 10, cell (x, y), direction 0. Null when the list is full.
  spawn(type: number, x: number, y: number, dir = 0): Unit | null {
    if (this.units.length >= MAX_UNITS) return null; // the original shows message $8F
    const unit = new Unit(type, x, y, this.techLevel());
    unit.dir = dir;
    this.cells[y * MAP_WIDTH + x] |= OCCUPIED;
    this.flags[y * MAP_WIDTH + x] |= OWN_UNIT_FLAG;
    this.units.push(unit);
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
    const at = this.units.indexOf(unit);
    if (at >= 0) this.units.splice(at, 1);
    const index = unit.reserveY * MAP_WIDTH + unit.reserveX;
    this.cells[index] &= ~OCCUPIED;
    this.flags[index] &= ~OWN_UNIT_FLAG;
  }

  // One pass of the main loop ($333A): the units move on every 9th pass.
  tick(): void {
    if (++this.substep < 9) return;
    this.substep = 0;
    for (const unit of this.units.slice()) this.step(unit);
  }

  // $38E2: advance one unit by one movement step.
  step(u: Unit): void {
    if (!u.hasTarget) return;
    const saved = { x: u.x, y: u.y, dx: u.dx, dy: u.dy, dir: u.dir, vx: u.vx, vy: u.vy };

    // Move the pixel offset; when it equals the distance to the next cell centre, change cells.
    let dx = u.dx + u.vx;
    let dy = u.dy + u.vy;
    const [stepX, stepY] = STEP_PIXELS[u.dir];
    if (dx === stepX && dy === stepY) {
      dx = 0;
      dy = 0;
      u.x += DIR_STEP[u.dir][0];
      u.y += DIR_STEP[u.dir][1];
    }
    u.dx = dx;
    u.dy = dy;
    if (dx !== 0 || dy !== 0) return; // still between two cell centres

    // On a cell centre: pick the direction towards the target, greedy and without path finding.
    const tx = u.targetX;
    const ty = u.targetY;
    let want: number;
    if (u.x === tx) {
      if (u.y === ty) return this.arrive(u);
      want = u.y < ty ? 4 : 0;
    } else if (u.x < tx) {
      want = u.y < ty ? 3 : 1;
      if (u.y === ty) want = 2;
    } else {
      want = u.y < ty ? 5 : 7;
      if (u.y === ty) want = 6;
    }

    const advanced = u.type === UNIT_ADVANCED;
    // Candidate slots: d, d+1, d-1, d+2, d-2, d+3, d-3. The advanced unit's code repeats d+3 in the last
    // slot instead of trying d-3 (original quirk, kept).
    for (let k = 0; k < TURNS.length; k++) {
      const turn = advanced && k === 6 ? TURNS[5] : TURNS[k];
      const dir = (want + turn + 8) & 7;
      const last = k === TURNS.length - 1;
      if (u.recent.includes(dir)) {
        if (last) return this.arrive(u);
        continue;
      }
      const nx = u.x + DIR_STEP[dir][0];
      const ny = u.y + DIR_STEP[dir][1];
      if (!UnitSystem.inMap(nx, ny)) {
        // The border cell: the unit leaves the map and is lost.
        this.remove(u);
        this.hooks.lost?.(u);
        return;
      }
      const index = ny * MAP_WIDTH + nx;
      const word = this.cells[index];
      const blocked = (word & BLOCKED) !== 0 && !(advanced && (word & TILE_ID) >= ROCK_FIRST_ID);
      if (blocked) {
        if (last) return this.arrive(u);
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
      this.go(u, dir, nx, ny, index);
      return;
    }
  }

  // $3C7C: the order is finished (or the way is blocked): stop and forget the target.
  private arrive(u: Unit): void {
    u.targetX = NO_TARGET;
    u.targetY = NO_TARGET;
    u.vx = 0;
    u.vy = 0;
  }

  // $3BC6: reserve the next cell, release the current one and start moving.
  private go(u: Unit, dir: number, nx: number, ny: number, index: number): void {
    this.cells[index] |= OCCUPIED;
    this.flags[index] |= OWN_UNIT_FLAG;
    const here = u.y * MAP_WIDTH + u.x;
    this.cells[here] &= ~OCCUPIED;
    this.flags[here] &= ~OWN_UNIT_FLAG;
    u.reserveX = nx;
    u.reserveY = ny;
    const back = (dir + 4) & 7; // the three directions that would turn the unit around
    u.recent = [back, (back + 7) & 7, (back + 1) & 7];
    u.dir = dir;
    [u.vx, u.vy] = VELOCITY[dir];
  }
}
