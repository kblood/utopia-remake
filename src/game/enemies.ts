// The enemy side of the map and the combat of everything that flies or fights: enemy ground units ($3A12C,
// $1193E) and aircraft ($39E20, $11A9E), their attacks ($1266A), the own tanks' and ships' fire ($12588), the
// ship mode machine ($42BE, $4526), missiles, the two kinds of gun ($11D34), the unit bookkeeping of $4692 /
// $46CC / $11C30 / $11C5C, defecting tanks, weekly repairs and the overview feed. Notes: notes/formats/enemies.md.
//
// The system is driven once per main-loop pass by `pass(clock)` (after the own tanks, as in $333A) and, for the
// guns, by `frame()` once per video frame. It touches the simulation only through Sim (state words, `bomb`,
// `roll`, `applyMorale`, the fleet), so it can run headless. Lookup tables come from the game image at runtime
// (src/data/combat.ts).

import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK } from "../data/scenario.js";
import type { CombatTables } from "../data/combat.js";
import { SFX } from "../audio/sfx.js";
import type { Drawable } from "./objects.js";
import type { EnemySpawn } from "./sim-aliens.js";
import type { Ship } from "./sim-ships.js";
import type { Sim } from "./sim.js";
import { A } from "./state.js";
import { OBJECT_SLOTS } from "./world.js";
import {
  BLOCKED,
  DIR_STEP,
  NO_TARGET,
  OCCUPIED,
  ROCK_FIRST_ID,
  STEP_PIXELS,
  UNIT_ADVANCED,
  VELOCITY,
  inMap,
  walkerStep,
  type PassClock,
  type StepEnv,
  type Unit,
  type UnitSystem,
  type Walker,
} from "./units.js";

// ---- constants ------------------------------------------------------------------------------------

export const ENEMY_WALKER_A = 22; // ground: walks to random buildings and bombs active cells
export const ENEMY_WALKER_B = 23;
export const ENEMY_CRUSHER = 24; // ground: crosses and destroys active buildings
export const ENEMY_BOMBER = 25; // air: flies over buildings and bombs them
export const ENEMY_KAMIKAZE = 26; // air: dives onto a building
export const ENEMY_KAMIKAZE_FAST = 27; // as 26 at double speed
export const MISSILE = 17; // ship list type: guided projectile
export const MAX_GROUND = 60;
export const MAX_AIR = 30;
export const FRONT_X = 0x135c4; // $135C4/$135C5: the front, a cell off the map
export const FRONT_Y = 0x135c5;
// Ship orders of the ship window ($F173, dispatched at $3F9E): what a flying or landed ship is told to do.
export const SHIP_ORDER = { land: 0, hover: 1, goLand: 2, goHover: 3, buildPad: 4, front: 9 } as const;
export const MSG_NO_FUEL = 0xed; // $3F94: a ship without fuel cannot be ordered

const AIR_LAYER = 0x2000; // map word bit 13
const ACTIVE = 0x0400; // map word bit 10: animated / active building
const AIR_START_LIFT = 0x22;
export const FLAG_GROUND = 1; // per-cell flag byte bits ($3D3A6): enemy ground, enemy air, own ground, flying ship
export const FLAG_AIR = 2;
export const FLAG_OWN = 4;
export const FLAG_SHIP = 8;
const LAND_CELL_BLOCK = 0x5000; // $41DA: a ship cannot land on a blocked or occupied cell
const TILE_ACID = 0x61; // enemy ground units standing on it take damage ($11ECA)
const TILE_PAD = 0x48; // launch pad tile
const GUN_A = 0x1f;
const GUN_B = 0x0f;
const POWER_LEVEL = 0x144c8;
const KILLS = 0x14298;
const LOST = 0x14294;

// Desired direction from (x, y) towards (tx, ty) ($11B70-$11BAE); -1 = on the target.
export function dirToward(x: number, y: number, tx: number, ty: number): number {
  if (x === tx) return y === ty ? -1 : y < ty ? 4 : 0;
  if (x < tx) return y < ty ? 3 : y === ty ? 2 : 1;
  return y < ty ? 5 : y === ty ? 6 : 7;
}

function s8(v: number): number {
  return ((v + 128) & 255) - 128;
}

// ---- records ----------------------------------------------------------------------------------------

// One entry of the enemy ground list ($3A12C, stride $1A) or the enemy air list ($39E20).
export class Enemy implements Walker {
  dx = 0;
  dy = 0;
  vx = 0;
  vy = 0;
  mode = 6; // +9: 6 choose a target, 1 on the way, 5 frozen, 2 diving, 3 flying on
  targetX = NO_TARGET;
  targetY = NO_TARGET;
  recent: [number, number, number] = [0xff, 0xff, 0xff];
  reserveX: number;
  reserveY: number;
  waiting = false; // +9 bit 7
  steps = 0; // +D: cell moves / steps in the current mode
  aux = 0; // +$13 (signed): bomb count of a bomber, dive altitude of a kamikaze
  p14 = 0; // +$14: bomb chance in percent (air)
  p15 = 0; // +$15: non-zero = a bomber that has dropped everything turns into a kamikaze
  toggle = false; // crusher: bit 7 of +$13, it moves every second call
  counter = 0; // crusher: step counter 0..7
  anim = 0; // crusher: +$14, second animation dimension of its sprite
  lift = 0; // +$10: altitude of an aircraft

  constructor(
    public type: number,
    public x: number,
    public y: number,
    public dir: number,
    public hp: number,
    public dmg: number, // +F: damage of an attack
    public bombPct: number, // +E: chance in percent that an attack on a building drops a bomb
    readonly air: boolean,
  ) {
    this.reserveX = x;
    this.reserveY = y;
  }
}

// Extra state of a ship (the Ship record of sim-ships.ts has no room for it).
interface ShipExtra {
  vx: number; // +6, +7
  vy: number;
  next: number; // +$11: the mode to switch to when the current one ends
  turn: number; // +$12: the direction the ship turns to while it climbs or descends
  rx: number; // the cell holding the ship's map mark (-1 = none)
  ry: number;
  target: Enemy | null; // missiles: +$C, the pointer to the enemy
}

export interface EnemyTarget {
  x: number;
  y: number;
  enemy: Enemy;
}

export interface EnemyHooks {
  // $1237C: an explosion at a cell; `lift` is the altitude of an airborne victim, `high` the unit-destroyed sound.
  explode?: (x: number, y: number, lift: number, high: boolean) => void;
  sound?: (id: number) => void;
  // Height in pixels of the building on a cell: a kamikaze dives down to height - 10 (table $1612E +3).
  buildingHeight?: (x: number, y: number) => number;
  // $771E: a hovering ship starts a launchpad on the 2x2 cells at (x, y); false = refused (the builder says why).
  buildPad?: (x: number, y: number) => boolean;
}

export class EnemySystem {
  readonly ground: Enemy[] = [];
  readonly air: Enemy[] = [];
  private readonly cells: Uint16Array;
  private readonly flags: Uint8Array;
  private readonly extras = new WeakMap<Ship, ShipExtra>();
  private clock: PassClock | null = null;
  private lastTarget: Enemy | null = null; // $E904
  private lastCountdown = -1;
  private cache: Drawable[] = [];
  private dirty = true;
  private readonly walkEnv: StepEnv;
  private readonly crushEnv: StepEnv;

  constructor(
    private readonly sim: Sim,
    private readonly units: UnitSystem,
    private readonly tables: CombatTables,
    private readonly hooks: EnemyHooks = {},
  ) {
    this.cells = sim.world.cells;
    this.flags = units.flags;
    const leave = (u: Walker): void => this.destroyGround(u as Enemy, false);
    this.walkEnv = {
      cells: this.cells,
      flags: this.flags,
      flagBit: FLAG_GROUND,
      canEnter: (word, u) => !(word & BLOCKED) || (u.type === UNIT_ADVANCED && (word & TILE_ID_MASK) >= ROCK_FIRST_ID),
      leave,
    };
    this.crushEnv = {
      cells: this.cells,
      flags: this.flags,
      flagBit: FLAG_GROUND,
      // $1208C: rocks and active buildings can be crossed, other blocked cells cannot.
      canEnter: (word) => !(word & BLOCKED) || (word & TILE_ID_MASK) >= ROCK_FIRST_ID || (word & ACTIVE) !== 0,
      leave,
      atCentre: (u) => this.acid(u as Enemy),
      entered: (_u, x, y, word) => {
        if (word & ACTIVE) this.sim.bomb(x, y); // $22A2: the building under the crusher is destroyed
      },
    };
  }

  private get s() {
    return this.sim.state;
  }

  // ---- creation ---------------------------------------------------------------------------------------

  // $48EC / $48B6: a new enemy from a wave entry. Returns false when its list is full.
  spawn(spawn: EnemySpawn): boolean {
    const e = spawn.entry;
    const index = spawn.y * MAP_WIDTH + spawn.x;
    if (spawn.air) {
      if (this.air.length >= MAX_AIR) return false;
      const a = new Enemy(spawn.type, spawn.x, spawn.y, spawn.dir & 7, e[1], e[3], e[6], true);
      a.lift = AIR_START_LIFT;
      a.aux = s8(e[5]);
      a.p14 = e[6];
      a.p15 = e[7];
      this.cells[index] |= AIR_LAYER;
      this.flags[index] |= FLAG_AIR;
      this.air.push(a);
    } else {
      if (this.ground.length >= MAX_GROUND) return false;
      const g = new Enemy(spawn.type, spawn.x, spawn.y, spawn.dir & 7, e[1], e[3], e[6], false);
      g.aux = e[5];
      this.cells[index] |= OCCUPIED;
      this.flags[index] |= FLAG_GROUND;
      this.ground.push(g);
    }
    this.dirty = true;
    return true;
  }

  // Event 17 ($11566): the first own tank turns into an enemy ground unit (the type stays 9 or 10; it spins in
  // place and shoots). Returns its cell, or null when there is no tank or the list is full. The counters
  // ($142A2, $1429C) are changed by the caller (Aliens.eventTankDefect).
  defect(): { x: number; y: number } | null {
    const u = this.units.units[0];
    if (!u || this.ground.length >= MAX_GROUND) return null;
    this.units.remove(u);
    const g = new Enemy(u.type, u.x, u.y, u.dir, u.hp, this.s.byte(0x145a3), 0, false); // damage: [H] the tank's own
    g.mode = 5;
    this.cells[u.y * MAP_WIDTH + u.x] |= OCCUPIED;
    this.flags[u.y * MAP_WIDTH + u.x] |= FLAG_GROUND;
    this.ground.push(g);
    this.dirty = true;
    return { x: u.x, y: u.y };
  }

  // $12510: every own ground unit gains `amount` hit points, capped at the base value 8 of table $4B76
  // (the cap ignores the tech bonus the unit was created with, so a tank of 10 hit points drops to 8: original).
  repair(amount: number): void {
    for (const u of this.units.units) {
      u.hp = (u.hp + amount) & 0xff;
      if (s8(8 - u.hp) < 0) u.hp = 8;
    }
  }

  // ---- bookkeeping (destruction) ------------------------------------------------------------------------

  private explode(x: number, y: number, lift: number, high: boolean): void {
    this.hooks.explode?.(x, y, Math.max(0, lift), high);
  }

  // $11C5C: an enemy ground unit is gone (no morale change).
  destroyGround(e: Enemy, explosion: boolean): void {
    const at = this.ground.indexOf(e);
    if (at < 0) return;
    this.ground.splice(at, 1);
    if (inMap(e.reserveX, e.reserveY)) {
      const i = e.reserveY * MAP_WIDTH + e.reserveX;
      this.cells[i] &= ~OCCUPIED;
      this.flags[i] &= ~FLAG_GROUND;
    }
    this.s.setWord(0x142a2, Math.max(0, this.s.word(0x142a2) - 1));
    this.s.setLong(KILLS, this.s.long(KILLS) + 1);
    if (explosion) this.explode(e.x, e.y, 0, true);
    this.dirty = true;
  }

  // $11C30: an enemy aircraft is gone (also when it flies off the map); the colony gains 50 morale.
  destroyAir(e: Enemy, explosion: boolean): void {
    const at = this.air.indexOf(e);
    if (at < 0) return;
    this.air.splice(at, 1);
    if (inMap(e.reserveX, e.reserveY)) {
      const i = e.reserveY * MAP_WIDTH + e.reserveX;
      this.cells[i] &= ~AIR_LAYER;
      this.flags[i] &= ~FLAG_AIR;
    }
    this.s.setWord(0x142a4, Math.max(0, this.s.word(0x142a4) - 1));
    this.s.setLong(KILLS, this.s.long(KILLS) + 1);
    this.sim.applyMorale(50);
    if (explosion) this.explode(e.x, e.y, e.lift, true);
    this.dirty = true;
  }

  private destroyEnemy(e: Enemy, explosion: boolean): void {
    if (e.air) this.destroyAir(e, explosion);
    else this.destroyGround(e, explosion);
  }

  // $4692: an own tank is destroyed: counts, the lost-units statistic and -50 morale.
  destroyTank(u: Unit, explosion = true): void {
    if (!this.units.units.includes(u)) return;
    this.units.remove(u);
    const s = this.s;
    s.setWord(0x1429c, Math.max(0, s.word(0x1429c) - 1));
    const addr = u.type === 9 ? 0x14254 : 0x14258;
    s.setLong(addr, Math.max(0, s.long(addr) - 1));
    s.setLong(LOST, s.long(LOST) + 1);
    this.sim.applyMorale(-50);
    if (explosion) this.explode(u.x, u.y, 0, true);
    this.dirty = true;
  }

  // $3C40: an own tank walked off the map: it joins the front fleet ($14274), -50 morale.
  tankLeft(u: Unit): void {
    this.sim.aliens.sendToFront(u.type);
    this.dirty = true;
  }

  // $46CC for the ships: counts, -100 morale (not for missiles), the map marks of the ship are released.
  destroyShip(ship: Ship, explosion = true): void {
    const ex = this.extra(ship);
    this.releaseShip(ship, ex);
    const lift = ship.lift;
    const x = ship.x;
    const y = ship.y;
    this.sim.fleet.destroyShip(ship, 0, false);
    if (explosion) this.explode(x, y, lift, true);
    this.dirty = true;
  }

  private releaseShip(ship: Ship, ex: ShipExtra): void {
    if (inMap(ex.rx, ex.ry)) {
      const i = ex.ry * MAP_WIDTH + ex.rx;
      this.cells[i] &= ~(AIR_LAYER | OCCUPIED);
      this.flags[i] &= ~(FLAG_SHIP | FLAG_OWN);
    }
    ex.rx = ex.ry = -1;
    if (inMap(ship.x, ship.y)) this.flags[ship.y * MAP_WIDTH + ship.x] &= ship.lift !== 0 ? ~FLAG_SHIP : ~FLAG_OWN;
  }

  // ---- own units: fire ($12588) ------------------------------------------------------------------------------

  // Own tank hook (UnitHooks.combat): on the move tick the tank shoots the first enemy around it.
  tankCombat(unit: Unit, moveTick: boolean): void {
    if (!moveTick) return;
    this.fire(unit.x, unit.y, this.s.byte(0x145a3), () => (unit.waiting = true));
  }

  // The 48 cells around (x, y) in spiral order; the first one holding an enemy (flag bit 0 ground, bit 1 air) is
  // hit for `damage`. The scan ends at the map edge or when the flagged cell has no enemy within one cell.
  private fire(x: number, y: number, damage: number, shooterWaits: () => void): void {
    for (const [dx, dy] of this.tables.spiral) {
      const cx = x + dx;
      const cy = y + dy;
      if (!inMap(cx, cy)) return;
      const f = this.flags[cy * MAP_WIDTH + cx] & 3;
      if (f === 0) continue;
      const list = f & FLAG_GROUND ? this.ground : this.air;
      const target = list.find((e) => Math.abs(e.x - cx) <= 1 && Math.abs(e.y - cy) <= 1);
      if (!target) return;
      this.hooks.sound?.(SFX.HIT);
      shooterWaits();
      target.hp = s8(target.hp - damage);
      if (target.hp <= 0) this.destroyEnemy(target, true);
      return;
    }
  }

  // ---- enemy attack ($1266A) ----------------------------------------------------------------------------------

  // On the enemy tick an enemy looks at the 48 cells around it: an active building (one time in ten, then with
  // chance +E percent) is bombed; otherwise the first own tank or ship found is hit for +F.
  private attack(e: Enemy): void {
    if (!this.clock?.enemyTick) return;
    const gate = this.sim.roll(256) < 25; // the original tests the CIA clock register for 0..24
    for (const [dx, dy] of this.tables.spiral) {
      const cx = e.x + dx;
      const cy = e.y + dy;
      if (!inMap(cx, cy)) return;
      const index = cy * MAP_WIDTH + cx;
      if (this.cells[index] & ACTIVE && gate) {
        if (this.sim.roll(100) >= e.bombPct) return;
        e.waiting = true;
        this.sim.bomb(cx, cy);
        return;
      }
      const f = this.flags[index] & (FLAG_OWN | FLAG_SHIP);
      if (f === 0) continue;
      if (f & FLAG_OWN) {
        const tank = this.units.units.find((u) => Math.abs(u.x - cx) <= 1 && Math.abs(u.y - cy) <= 1);
        if (tank) {
          this.hooks.sound?.(SFX.HIT);
          e.waiting = true;
          tank.hp = s8(tank.hp - e.dmg);
          if (tank.hp <= 0) this.destroyTank(tank);
          return;
        }
      }
      const ship = this.sim.fleet.ships.find((p) => Math.abs(p.x - cx) <= 1 && Math.abs(p.y - cy) <= 1);
      if (!ship) return;
      this.hooks.sound?.(SFX.HIT);
      e.waiting = true;
      ship.hp = s8(ship.hp - e.dmg);
      if (ship.hp <= 0) this.destroyShip(ship);
      return;
    }
  }

  // ---- the main-loop pass -------------------------------------------------------------------------------------

  // One pass of $333A after the own tanks: ships, enemy ground units, enemy aircraft.
  pass(clock: PassClock): void {
    this.clock = clock;
    for (const ship of this.sim.fleet.ships) {
      this.shipStep(ship);
      if (ship.type === MISSILE || !this.sim.fleet.slots.includes(ship)) continue;
      const damage = this.s.byte(0x145a4 + ship.cls);
      if (damage !== 0 && clock.moveTick) this.fire(ship.x, ship.y, damage, () => {});
    }
    for (const g of this.ground.slice()) {
      if (g.waiting && !clock.enemyTick) continue;
      g.waiting = false;
      this.groundStep(g);
    }
    for (const a of this.air.slice()) this.airStep(a);
    this.dirty = true;
  }

  // ---- enemy ground units ($1193E) ----------------------------------------------------------------------------

  private pickTarget(e: Enemy): void {
    const t = this.sim.randomBuilding();
    e.targetX = t ? t[0] : NO_TARGET;
    e.targetY = t ? t[1] : NO_TARGET;
    e.mode = 1;
  }

  private groundStep(g: Enemy): void {
    if (g.type === ENEMY_WALKER_A || g.type === ENEMY_WALKER_B) {
      if (g.mode === 6) this.pickTarget(g);
      else if (g.mode !== 5) {
        walkerStep(g, this.walkEnv);
        if (g.targetX & 0x80) g.mode = 6; // the order is finished
      }
      if (this.ground.includes(g)) this.attack(g);
    } else if (g.type === ENEMY_CRUSHER) {
      this.crusher(g);
    } else {
      g.dir = (g.dir + 7) & 7; // a defected tank spins and shoots
      this.attack(g);
    }
  }

  // $11F12: the crusher walks to a building, destroying active buildings on its way, for at most 80 steps.
  private crusher(g: Enemy): void {
    if (g.mode === 6) {
      g.steps = 0;
      this.pickTarget(g);
    } else if (g.mode === 1) {
      this.crusherStep(g);
      g.steps++;
      if (g.steps === 0x50 || g.targetX & 0x80) g.mode = 6;
    }
  }

  // $11F42: a step on every second call, with its own animation counter.
  private crusherStep(g: Enemy): void {
    if (g.targetX & 0x80) return;
    const was = g.toggle;
    g.toggle = !was;
    if (!was) return;
    g.counter = g.counter - 1 < 0 ? 7 : g.counter - 1;
    g.anim = this.tables.crusherAnim[g.counter];
    walkerStep(g, this.crushEnv);
  }

  // $11ECA: standing on an acid tile hurts; returns true when the unit died.
  private acid(g: Enemy): boolean {
    if ((this.cells[g.y * MAP_WIDTH + g.x] & TILE_ID_MASK) !== TILE_ACID) return false;
    g.hp = s8(g.hp - (this.s.byte(0x13116) + 2 * this.s.byte(0x14592)));
    if (g.hp > 0) return false;
    this.destroyGround(g, true);
    return true;
  }

  // ---- enemy aircraft ($11A9E) --------------------------------------------------------------------------------

  private airStep(a: Enemy): void {
    if (a.type === ENEMY_KAMIKAZE || a.type === ENEMY_KAMIKAZE_FAST) {
      this.kamikaze(a);
      if (a.type === ENEMY_KAMIKAZE && this.air.includes(a)) this.attack(a);
    } else {
      this.bomber(a);
      if (this.air.includes(a)) this.attack(a);
    }
  }

  // $11AE6: the aircraft step: -1 between two cells (or gone), 0 on the target cell, 1 a new step was started.
  private airMove(a: Enemy): number {
    let dx = a.dx + a.vx;
    let dy = a.dy + a.vy;
    if (a.type === ENEMY_KAMIKAZE_FAST) {
      dx += a.vx;
      dy += a.vy;
    }
    const [sx, sy] = STEP_PIXELS[a.dir];
    if (dx === sx && dy === sy) {
      dx = dy = 0;
      a.x += DIR_STEP[a.dir][0];
      a.y += DIR_STEP[a.dir][1];
    }
    a.dx = dx;
    a.dy = dy;
    if (dx !== 0 || dy !== 0) return -1;
    if (!inMap(a.x, a.y)) {
      // $11C24: off the map the aircraft is gone (and counts as a kill)
      this.destroyAir(a, false);
      return -1;
    }
    if (a.mode !== 3) {
      const want = dirToward(a.x, a.y, a.targetX, a.targetY);
      if (want < 0) return 0;
      if (a.dir !== want) a.dir = this.tables.turn[a.dir * 8 + want];
    }
    [a.vx, a.vy] = VELOCITY[a.dir];
    // The air layer mark moves to the next cell when the step starts.
    const here = a.y * MAP_WIDTH + a.x;
    this.cells[here] &= ~AIR_LAYER;
    this.flags[here] &= ~FLAG_AIR;
    const nx = a.x + DIR_STEP[a.dir][0];
    const ny = a.y + DIR_STEP[a.dir][1];
    if (inMap(nx, ny)) {
      this.cells[ny * MAP_WIDTH + nx] |= AIR_LAYER;
      this.flags[ny * MAP_WIDTH + nx] |= FLAG_AIR;
      a.reserveX = nx;
      a.reserveY = ny;
    } else {
      a.reserveX = a.reserveY = -1;
    }
    return 1;
  }

  // $119C0: kamikaze: pick a building, fly there, dive onto it and blow up.
  private kamikaze(a: Enemy): void {
    if (a.mode === 6) {
      this.pickTarget(a);
      if (a.targetX !== NO_TARGET) {
        const height = this.hooks.buildingHeight?.(a.targetX, a.targetY) ?? 20;
        a.aux = s8(height - 10); // +$13: the altitude at which it hits
      }
    } else if (a.mode === 1) {
      if (this.airMove(a) !== 0) return;
      if (inMap(a.targetX, a.targetY) && this.cells[a.targetY * MAP_WIDTH + a.targetX] & ACTIVE) {
        a.mode = 2;
        a.dir = 3;
        a.vx = a.vy = 0;
      } else {
        a.mode = 6;
      }
    } else if (a.mode === 2) {
      a.lift -= 2;
      if (a.type === ENEMY_KAMIKAZE_FAST) a.lift -= 2;
      if (a.aux < a.lift) return;
      const x = a.x;
      const y = a.y;
      this.destroyAir(a, false);
      this.sim.bomb(x, y);
    } else {
      this.airMove(a);
    }
  }

  // $11C7A: bomber: fly from building to building, drop bombs on active cells.
  private bomber(a: Enemy): void {
    if (a.aux < 0) return this.kamikaze(a);
    if (a.mode === 6) {
      a.steps = 0;
      this.pickTarget(a);
    } else if (a.mode === 1) {
      const r = this.airMove(a);
      if (r < 0) return;
      if (r === 1) {
        if (++a.steps === 0x14) {
          a.mode = 6;
          return;
        }
        if (this.sim.roll(100) >= 10) return;
      }
      this.bombRun(a);
    } else {
      this.airMove(a);
    }
  }

  // $11CC2: over an active building a bomber drops a bomb with chance +$14 percent.
  private bombRun(a: Enemy): void {
    if (!(this.cells[a.y * MAP_WIDTH + a.x] & ACTIVE)) return;
    a.aux = s8(a.aux - 1);
    if (a.aux < 0) {
      a.mode = 6;
      if (a.p15 === 0) {
        a.aux = 0;
        a.mode = 3; // out of bombs: flies on straight and leaves the map
      }
      return;
    }
    a.mode = 6;
    if (this.sim.roll(100) >= a.p14) return;
    this.sim.bomb(a.x, a.y);
  }

  // ---- ships ($42BE, $4526) ------------------------------------------------------------------------------------

  private extra(ship: Ship): ShipExtra {
    let ex = this.extras.get(ship);
    if (!ex) {
      const landed = ship.lift === 0 && ship.mode === 0;
      ex = { vx: 0, vy: 0, next: 0, turn: 2, rx: landed ? ship.x : -1, ry: landed ? ship.y : -1, target: null };
      this.extras.set(ship, ex);
    }
    return ex;
  }

  // ---- orders ($3F9E dispatch, $41A8, $4204, $4260/$427C, takeoff $4152) ----
  //
  // +$11 (`next`) is the mode the ship takes when its current movement ends; +$B/+$C is the target cell.

  // $4152: a landed ship lifts off: its marks move from the ground layer to the air layer, it faces direction 2, loses 8
  // fuel (not when the word is negative = unlimited; never below 0) and climbs in mode 7 turning towards +$12.
  private takeoff(ship: Ship, ex: ShipExtra): void {
    const want = dirToward(ship.x, ship.y, ship.targetX, ship.targetY);
    ex.turn = ex.next === 1 ? 2 : want < 0 ? 6 : want; // $44DE gives 6 when the ship is on the target
    const i = ship.y * MAP_WIDTH + ship.x;
    this.cells[i] = (this.cells[i] & ~OCCUPIED) | AIR_LAYER;
    this.flags[i] = (this.flags[i] & ~FLAG_OWN) | FLAG_SHIP;
    ex.rx = ship.x;
    ex.ry = ship.y;
    ship.dir = 2;
    if (ship.fuel < 0x8000) ship.fuel = Math.max(0, ship.fuel - 8);
    ship.mode = 7;
    this.dirty = true;
  }

  // $41A8 with order 1 (hover) or 4 (build a launchpad): +$11 = order. Landed: take off; flying to a cell (2, 3, 5):
  // stop (mode 6) and then continue in +$11; coming down: climb again (mode 7).
  private holdOrder(ship: Ship, order: number): void {
    const ex = this.extra(ship);
    ex.next = order;
    if (ship.mode === 0) this.takeoff(ship, ex);
    else if (ship.mode === 2 || ship.mode === 3 || ship.mode === 5) ship.mode = 6;
    else if (ship.mode === 8) ship.mode = 7;
  }

  // $4204 (order 0): land where the ship is. Hovering or climbing: descend at once (hover again on a blocked cell);
  // flying: stop and descend (mode 5). Other modes (4, 5, 8) ignore it, but +$11 is set.
  private landOrder(ship: Ship): void {
    const ex = this.extra(ship);
    ex.turn = 2;
    ex.next = 0;
    if (ship.mode === 1 || ship.mode === 7) {
      ship.mode = 8;
      if (this.cells[ship.y * MAP_WIDTH + ship.x] & LAND_CELL_BLOCK) ship.mode = 1;
      ship.dx = ship.dy = 0;
      ex.vx = ex.vy = 0;
    } else if (ship.mode === 2 || ship.mode === 3 || ship.mode === 6) {
      ship.mode = 5;
    }
  }

  // $427C (order 2 = go and land, 3 = go and hover; the target is already in +$B/+$C).
  private goOrder(ship: Ship, order: number): void {
    const ex = this.extra(ship);
    ex.next = order;
    if (ship.mode === 0) this.takeoff(ship, ex);
    else if (ship.mode === 8) ship.mode = 7;
    else if (ship.mode < 5 && ship.mode !== order) ship.mode = order;
  }

  // +$11 = 4: the ship is on its way to build a launchpad or is building it; the ship window refuses it ($DA9E).
  padPending(ship: Ship): boolean {
    return this.extra(ship).next === SHIP_ORDER.buildPad;
  }

  // The dispatch of $3F9E after the ship window: `order` is one of SHIP_ORDER, `target` the cell of the chosen pin
  // (orders 2 and 3). Returns the string index of a refusal message ($ED, no fuel), 0 when the order was given.
  commandShip(ship: Ship, order: number, target: { x: number; y: number } | null): number {
    if (ship.fuel === 0) return MSG_NO_FUEL;
    if (order === SHIP_ORDER.hover || order === SHIP_ORDER.buildPad) this.holdOrder(ship, order);
    else if (order === SHIP_ORDER.land) this.landOrder(ship);
    else if (order === SHIP_ORDER.front) this.sendShipToFront(ship);
    else if (order === SHIP_ORDER.goLand || order === SHIP_ORDER.goHover) {
      // $4260: without a pin the original reads a stale table row; the port leaves the ship alone.
      if (!target) return 0;
      ship.targetX = target.x;
      ship.targetY = target.y;
      this.goOrder(ship, order);
    }
    this.dirty = true;
    return 0;
  }

  // Order a ship to fly to a cell (`land`: come down there, otherwise hover).
  orderShip(ship: Ship, tx: number, ty: number, land: boolean): void {
    ship.targetX = tx;
    ship.targetY = ty;
    this.goOrder(ship, land ? SHIP_ORDER.goLand : SHIP_ORDER.goHover);
    this.dirty = true;
  }

  // A ship goes to the front ($135C4/$135C5, off the map): it leaves and joins the front fleet ($1427C).
  sendShipToFront(ship: Ship): void {
    ship.targetX = this.s.byte(FRONT_X);
    ship.targetY = this.s.byte(FRONT_Y);
    this.goOrder(ship, SHIP_ORDER.goLand); // $3FD2: order 2 to the front cell
    this.dirty = true;
  }

  // $4526: like the aircraft step; also -1 between cells, 0 when holding (modes 5, 6) or on the target cell.
  private shipMove(ship: Ship, ex: ShipExtra): number {
    let dx = ship.dx + ex.vx;
    let dy = ship.dy + ex.vy;
    if (ship.type === MISSILE) {
      dx += ex.vx;
      dy += ex.vy;
    }
    const facing = ship.dir & 7;
    const [sx, sy] = STEP_PIXELS[facing];
    if (dx === sx && dy === sy) {
      dx = dy = 0;
      ship.x += DIR_STEP[facing][0];
      ship.y += DIR_STEP[facing][1];
    }
    ship.dx = dx;
    ship.dy = dy;
    if (dx !== 0 || dy !== 0) return -1;
    if (ship.mode === 5 || ship.mode === 6) return 0;
    if (!inMap(ship.x, ship.y)) {
      // $4672: off the map the ship joins the front fleet of its class ($1427C); no lost-unit statistic
      this.s.setLong(0x1427c + 4 * ship.cls, this.s.long(0x1427c + 4 * ship.cls) + 1);
      ship.x = Math.max(0, Math.min(MAP_WIDTH - 1, ship.x));
      ship.y = Math.max(0, Math.min(MAP_HEIGHT - 1, ship.y));
      this.releaseShip(ship, ex);
      this.sim.fleet.destroyShip(ship, 0, false);
      this.s.setLong(LOST, this.s.long(LOST) - 1);
      this.dirty = true;
      return -1;
    }
    const want = dirToward(ship.x, ship.y, ship.targetX, ship.targetY);
    if (want < 0) return 0;
    if (ship.dir > 7 || ship.dir !== want) ship.dir = this.tables.turn[(ship.dir & 7) * 8 + want];
    [ex.vx, ex.vy] = VELOCITY[ship.dir];
    // the air layer mark follows the ship when the step starts
    if (inMap(ex.rx, ex.ry)) {
      this.cells[ex.ry * MAP_WIDTH + ex.rx] &= ~AIR_LAYER;
      this.flags[ex.ry * MAP_WIDTH + ex.rx] &= ~FLAG_SHIP;
    }
    const nx = ship.x + DIR_STEP[ship.dir][0];
    const ny = ship.y + DIR_STEP[ship.dir][1];
    if (inMap(nx, ny)) {
      this.cells[ny * MAP_WIDTH + nx] |= AIR_LAYER;
      this.flags[ny * MAP_WIDTH + nx] |= FLAG_SHIP;
      ex.rx = nx;
      ex.ry = ny;
    } else {
      ex.rx = ex.ry = -1;
    }
    return -1;
  }

  // Rotate towards +$12 every 8 lift units ($4386).
  private rotateShip(ship: Ship, ex: ShipExtra): void {
    if ((ship.lift & 7) !== 0 || ship.dir > 7 || ship.dir === ex.turn) return;
    ship.dir = this.tables.turn[ship.dir * 8 + ex.turn];
  }

  // $42D8: start the descent; on a blocked or occupied cell the ship hovers instead.
  private startLanding(ship: Ship, ex: ShipExtra): void {
    ship.mode = 8;
    ex.turn = 2;
    if (this.cells[ship.y * MAP_WIDTH + ship.x] & LAND_CELL_BLOCK) ship.mode = 1;
    ship.dx = ship.dy = 0;
    ex.vx = ex.vy = 0;
  }

  // $4346: the climb or the stop is over: continue in the stored next mode.
  // Mode 4 starts the launchpad ($771E); a refusal makes the ship land again.
  private nextMode(ship: Ship, ex: ShipExtra): void {
    ship.mode = ex.next;
    if (ship.mode === 4 && !(this.hooks.buildPad?.(ship.x, ship.y) ?? false)) this.startLanding(ship, ex);
  }

  private land(ship: Ship, ex: ShipExtra): void {
    ship.lift = 0;
    ship.dir = 8;
    ship.mode = 0;
    ex.next = 0;
    ex.vx = ex.vy = 0;
    ship.dx = ship.dy = 0;
    const i = ship.y * MAP_WIDTH + ship.x;
    this.cells[i] = (this.cells[i] & ~AIR_LAYER) | OCCUPIED;
    this.flags[i] = (this.flags[i] & ~FLAG_SHIP) | FLAG_OWN;
    ex.rx = ship.x;
    ex.ry = ship.y;
    if (ship.fuel < 0x8000) ship.fuel = Math.max(0, ship.fuel - 4);
  }

  private shipStep(ship: Ship): void {
    const ex = this.extra(ship);
    if (ship.type === MISSILE) return this.missileStep(ship, ex);
    switch (ship.mode) {
      case 2:
      case 5:
        if (this.shipMove(ship, ex) >= 0) this.startLanding(ship, ex);
        break;
      case 3:
        if (this.shipMove(ship, ex) === 0) ship.mode = 1; // arrived: hover
        break;
      case 4:
        if ((this.cells[ship.y * MAP_WIDTH + ship.x] & TILE_ID_MASK) === TILE_PAD) this.startLanding(ship, ex);
        break;
      case 6:
        if (this.shipMove(ship, ex) >= 0) this.nextMode(ship, ex);
        break;
      case 7:
        ship.lift += 2;
        if (ship.lift >= AIR_START_LIFT) this.nextMode(ship, ex);
        else this.rotateShip(ship, ex);
        break;
      case 8:
        ship.lift -= 2;
        if (ship.lift > 0) this.rotateShip(ship, ex);
        else this.land(ship, ex);
        break;
      default:
        break; // 0 landed, 1 hovering
    }
  }

  // ---- missiles (ship list type 17) -------------------------------------------------------------------------------

  // $12456: the enemy a launcher at (x, y) can aim at within `range` cells. Kamikaze aircraft and crushers come
  // first, otherwise the last enemy found; the result is remembered for the launch ($E904).
  findTarget(range: number, x: number, y: number): EnemyTarget | null {
    let found: Enemy | null = null;
    for (const list of [this.ground, this.air]) {
      for (const e of list) {
        if (Math.abs(e.x - x) > range || Math.abs(e.y - y) > range) continue;
        if (e.type === ENEMY_CRUSHER || e.type === ENEMY_KAMIKAZE || e.type === ENEMY_KAMIKAZE_FAST) {
          this.lastTarget = e;
          return { x: e.x, y: e.y, enemy: e };
        }
        found = e;
      }
    }
    this.lastTarget = found;
    return found ? { x: found.x, y: found.y, enemy: found } : null;
  }

  // $E158..: a missile from a launcher cell at the enemy found by `findTarget`. False when the ship list is full.
  launchMissile(from: { x: number; y: number }, target?: { x: number; y: number }): boolean {
    const enemy = (target as EnemyTarget | undefined)?.enemy ?? this.lastTarget;
    if (!enemy) return false;
    const index = from.y * MAP_WIDTH + from.x;
    const before = this.cells[index];
    const ship = this.sim.fleet.createShip(MISSILE, from.x, from.y, 0);
    if (!ship) return false;
    this.cells[index] = before | AIR_LAYER; // createShip marked the ground layer; a missile flies
    ship.mode = 4;
    ship.lift = 0;
    ship.targetX = enemy.x;
    ship.targetY = enemy.y;
    const ex = this.extra(ship);
    ex.target = enemy;
    ex.rx = from.x;
    ex.ry = from.y;
    this.flags[index] |= FLAG_SHIP;
    this.dirty = true;
    this.hooks.sound?.(SFX.LAUNCH); // $E1A2
    return true;
  }

  private enemyAlive(e: Enemy | null): e is Enemy {
    return e !== null && (e.air ? this.air : this.ground).includes(e);
  }

  // $4408: climb to $22, fly to the enemy (it is followed: the target cell is refreshed at every cell centre),
  // and on arrival hit it. A ground target freezes and the missile comes down on it first; an aircraft is hit at once.
  private missileStep(ship: Ship, ex: ShipExtra): void {
    const target = ex.target;
    if (ship.mode !== 2 && !this.enemyAlive(target)) {
      this.destroyShip(ship, false); // the target is gone: the missile vanishes
      return;
    }
    if (ship.mode === 4) {
      ship.lift += 4;
      if (ship.lift > AIR_START_LIFT) {
        ship.lift = AIR_START_LIFT;
        ship.mode = 1;
        const want = dirToward(ship.x, ship.y, ship.targetX, ship.targetY);
        ship.dir = want < 0 ? 0 : want;
      }
    } else if (ship.mode === 1) {
      if (ship.dx === 0 && ship.dy === 0 && target) {
        ship.targetX = target.x;
        ship.targetY = target.y;
      }
      if (this.shipMove(ship, ex) < 0 || !target) return;
      if (Math.abs(ship.x - target.x) > 1 || Math.abs(ship.y - target.y) > 1) return;
      if (!target.air) {
        ship.mode = 2;
        ship.dir = 3;
        ex.vx = ex.vy = 0;
        target.targetX = NO_TARGET;
        target.mode = 5;
      } else {
        this.missileHit(ship, target);
      }
    } else {
      ship.lift -= 4;
      if (ship.lift > 0) return;
      if (target) this.missileHit(ship, target);
      else this.destroyShip(ship, false);
    }
  }

  private missileHit(ship: Ship, target: Enemy): void {
    this.destroyShip(ship, true);
    this.destroyEnemy(target, true);
  }

  // ---- guns ($11D34) -------------------------------------------------------------------------------------------

  // Called once per video frame after Sim.tick(): the half-day moment (frame countdown $2D) fires gun A, the day
  // change fires gun B ($144C1 bits 4 and 0 in the original).
  frame(): void {
    const now = this.s.byte(A.frameCountdown);
    const before = this.lastCountdown;
    this.lastCountdown = now;
    if (before < 0 || before === now) return;
    if (now === 0x2d) this.fireGuns(GUN_A, this.s.long(0x1310e));
    if (now > before) this.fireGuns(GUN_B, this.s.long(0x13112));
  }

  // One firing round of all guns with tile `tile` (record byte +3 = $FF: finished). Each gun counts its timer
  // (+7) down; flash tile +8 shows for the call after a shot, and when the timer runs out the gun looks for an
  // enemy in the cells of its fire arc (+2 = facing). Without a target it turns by +6.
  fireGuns(tile: number, damage: number): void {
    if (this.s.byte(POWER_LEVEL) >= 0x10) return;
    const o = this.sim.world.objects;
    for (let slot = 0; slot < OBJECT_SLOTS; slot++) {
      const at = slot * 8;
      if (((o[at] << 8) | o[at + 1]) !== tile || o[at + 3] !== 0xff) continue;
      const x = o[at + 4];
      const y = o[at + 5];
      const index = y * MAP_WIDTH + x;
      const timer = (o[at + 7] - 1) & 0xff;
      o[at + 7] = timer;
      if (!(timer & 0x80)) {
        if (timer === 1) this.setTileLow(index, -8); // the muzzle flash ends
        continue;
      }
      o[at + 7] = 0;
      const rot = o[at + 2] & 7;
      const arc = this.tables.arcs[rot];
      const reach = tile === GUN_A ? 16 : 32;
      let hit = false;
      let ended = false;
      for (let i = 0; i < reach && !ended && !hit; i++) {
        const cx = x + arc[i][0];
        const cy = y + arc[i][1];
        if (!inMap(cx, cy)) break;
        const word = this.cells[cy * MAP_WIDTH + cx];
        if (i < 8 && word & ACTIVE) break; // a building in the way ends the first part of the arc
        const f = this.flags[cy * MAP_WIDTH + cx];
        if (f & FLAG_GROUND || f & FLAG_AIR) {
          const list = f & FLAG_GROUND ? this.ground : this.air;
          const target = list.find((e) => Math.abs(e.x - cx) <= 1 && Math.abs(e.y - cy) <= 1);
          if (!target) {
            ended = true; // flagged cell without an enemy: this gun does nothing this round
            hit = true;
            break;
          }
          target.hp = s8(target.hp - damage);
          if (target.hp <= 0) this.destroyEnemy(target, true);
          o[at + 7] = 3;
          this.setTileLow(index, 8);
          o[at + 6] = 0;
          this.hooks.sound?.(SFX.HIT);
          hit = true;
        }
      }
      if (hit) continue;
      // no enemy in the arc: turn by +6 (the tile low byte holds base tile + facing, +8 while flashing)
      const step = s8(o[at + 6]);
      if (step === 0) continue;
      let low = this.cells[index] & 0xff;
      if (low >= 0x27 || (low >= 0x17 && low < 0x1f)) low -= 8;
      low += step;
      let facing = rot + step;
      if (facing < 0) {
        facing = 7;
        low = tile + 7;
      } else if (facing === 8) {
        facing = 0;
        low = tile;
      }
      o[at + 2] = facing;
      this.cells[index] = (this.cells[index] & ~0xff) | (low & 0xff);
    }
  }

  private setTileLow(index: number, delta: number): void {
    const word = this.cells[index];
    this.cells[index] = (word & ~0xff) | ((word + delta) & 0xff);
  }

  // ---- views ---------------------------------------------------------------------------------------------------------

  // Positions for the overview map (ScreenContext.otherUnits).
  overview(): { ships: { x: number; y: number }[]; enemyGround: { x: number; y: number }[]; enemyAir: { x: number; y: number }[] } {
    return {
      ships: this.sim.fleet.ships.map((p) => ({ x: p.x, y: p.y })),
      enemyGround: this.ground.map((e) => ({ x: e.x, y: e.y })),
      enemyAir: this.air.map((e) => ({ x: e.x, y: e.y })),
    };
  }

  // Everything this system draws on the map: ships, enemy ground units, aircraft (lifted by their altitude).
  drawables(): Drawable[] {
    if (!this.dirty) return this.cache;
    const out: Drawable[] = [];
    for (const g of this.ground) out.push({ type: g.type, x: g.x, y: g.y, dx: g.dx, dy: g.dy, frame: g.dir, anim: g.anim, ref: g });
    for (const a of this.air) out.push({ type: a.type, x: a.x, y: a.y, dx: a.dx, dy: a.dy, frame: a.dir, lift: Math.max(0, a.lift), ref: a });
    for (const p of this.sim.fleet.ships) out.push({ type: p.type, x: p.x, y: p.y, dx: p.dx, dy: p.dy, frame: p.dir, lift: Math.max(0, p.lift), ref: p });
    this.cache = out;
    this.dirty = false;
    return out;
  }
}
