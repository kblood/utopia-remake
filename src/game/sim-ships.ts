// Own spaceships and the ship yard: $AC04 (yard production), $4060 (launch), $387E (create a ship), $46CC
// (destroy a ship), $ACE2 (daily fuel burn), $4798 (weekly refuelling of landed ships), $12510 (weekly repair),
// $A5A6 (fuel withdrawal), events 12 (ship explosion, $113A6) and 15 (fuel beaming, $114AC).
// No graphics: the interface gets `effect(kind, x, y)` and `Sim.events` entries. Notes: notes/formats/sim-port.md.

import { MAP_WIDTH, MAP_HEIGHT, TILE_ID_MASK } from "../data/scenario.js";
import { divuQ, mulu, s16, s8 } from "./sim-math.js";
import { SHIP_FUEL_CAP, SHIP_UNIT_TYPE, UNIT_INIT, YARD_FRAME_COST, YARD_GOODS3 } from "./sim-tables.js";
import type { RestoredMissile } from "./ship-roster.js";
import type { Sim } from "./sim.js";
import { OBJECT_SLOTS } from "./world.js";

// Graphics hook kinds (SimOptions.effect). Coordinates are map cells.
export type EffectKind =
  | "explosion" // $1237C: explosion at a cell
  | "focus" // $11432: the original recentres the view on the cell (scroll target)
  | "launch" // $4128 loop: yard flash while a ship takes off
  | "alienAppear" // $144A8 sprite (type 19) shown at a marker cell
  | "meteorFall" // $1449C meteor (type 21) starts falling
  | "meteorImpact"; // $11676 meteor lands at the cell

// Fields every ship-list record has, missile included ($3A75E list, $18 bytes). Field names after game-state.md 3.8 / units.md.
export interface ShipCore {
  type: number; // +0: 11..16 (class + 11), 17 projectile
  x: number; // +1
  y: number; // +2
  dx: number; // +3
  dy: number; // +4
  dir: number; // +5 (8 = parked frame)
  hp: number; // +8
  mode: number; // +9: 0 landed, 1 hovering, 2/3 flying, 4 building pad, 5 launching, 6 landing, 7 to the enemy
  tech: number; // +A tech level at creation
  targetX: number; // +B ($FF none)
  targetY: number; // +C
  lift: number; // +$10 non-zero = airborne cell layer (clears bit 13 instead of bit 14 of the cell on removal)
}

// Ordinary ship record: ship types 11..16 and the projectiles Fleet.createShip makes (type 17, class 6, fuel 0).
export interface Ship extends ShipCore {
  cls: number; // +D class 0..5
  fuel: number; // +E word
}

// Projectile (ship list type 17), the ONE shape of every missile, launched at run time (`Fleet.createMissile`, $49E8) or
// restored from Disk.4 (`RestoredMissile` extends it with provenance). It has NO class and NO fuel: the bytes +$D..+$F of a
// missile are its 24-bit enemy-slot pointer ($ACE2 masks the long at +$C), which the EnemySystem keeps as a fixed
// list/slot identity in its ShipExtra, so code that reads `cls` / `fuel` must first rule it out with isMissile().
export interface MissileRecord extends ShipCore {
  readonly kind: "missile";
  type: 17;
}

// What a Fleet slot can hold.
export type FleetRecord = Ship | MissileRecord;

export function isMissile(record: FleetRecord): record is MissileRecord {
  return (record as { kind?: string }).kind === "missile";
}

/** A missile adopted from a Disk.4 save (carries the saved bytes and the saved target pointer), as opposed to a launched one. */
export function isRestoredMissile(record: FleetRecord): record is RestoredMissile {
  return isMissile(record) && "sourceRaw" in record;
}

export const MAX_SHIPS = 40;
export const SHIP_YARD_TILE = 0x36;
const TILE_LAUNCHPAD = 0x48;
const CELL_UNIT = 0x4000; // map flag bit 14: a ground-layer unit stands here
const CELL_AIR = 0x2000; // bit 13

const V = { ships: 0x1429e, tanksStored: 0x13310, tanksStoredB: 0x13322, fuelStored: 0x14342, tankCountA: 0x13302, tankCountB: 0x13314 };

export class Fleet {
  readonly slots: (FleetRecord | null)[] = new Array(MAX_SHIPS).fill(null);
  // $156B3: "out of fuel" message shown once per month.
  fuelWarned = false;
  // Daily step ($ACE2) of every missile, launched or restored: it needs the enemy slots, so the EnemySystem installs it.
  private missileDaily: ((missile: MissileRecord) => void) | null = null;
  // $4732 releases the layer mark at the cell addressed by +$14. EnemySystem owns the live reservation state.
  private releaseReservation: ((ship: FleetRecord) => void) | null = null;

  constructor(private readonly sim: Sim) {}

  /** Installed by EnemySystem so every destruction path (daily fuel/event as well as combat) frees +$14's cell. */
  setReservationRelease(release: (ship: FleetRecord) => void): void {
    this.releaseReservation = release;
  }

  /** Installed by EnemySystem: the $ACE2 refresh / destruction of a missile (the Fleet has no enemy slots). */
  setMissileDaily(daily: (missile: MissileRecord) => void): void {
    this.missileDaily = daily;
  }

  // Used ships and projectiles in slot order (the order the original iterates).
  get ships(): FleetRecord[] {
    return this.slots.filter((s): s is FleetRecord => s !== null);
  }

  // Disk.4 restore: puts already-validated records into their saved slots (identity and holes kept). Writes nothing else:
  // no createShip, no counters ($1429E and the per-type counts are the saved ones), no map or flag byte. The caller
  // (EnemySystem.fromRoster) has validated everything; this only refuses a fleet that is not empty.
  adoptRestored(records: readonly (FleetRecord | null)[]): boolean {
    if (records.length !== MAX_SHIPS || this.slots.some((s) => s !== null)) return false;
    for (let i = 0; i < MAX_SHIPS; i++) this.slots[i] = records[i];
    return true;
  }

  private get s() {
    return this.sim.state;
  }

  private cellIndex(x: number, y: number): number {
    return y * MAP_WIDTH + x;
  }

  // ---- creation / destruction -----------------------------------------------------------

  // $387E: d1 = unit type 11..16, (x, y) the launch cell, dir = 8. Fails (message $C8) with 40 ships. A missile (type 17) is
  // not made here: $49E8 has its own free-slot check and message, see createMissile (null, nothing written).
  createShip(type: number, x: number, y: number, dir = 8): Ship | null {
    if (type === 0x11) return null;
    const s = this.s;
    if (s.word(V.ships) === 40) {
      this.sim.msg(0xc8);
      return null;
    }
    const slot = this.slots.indexOf(null);
    if (slot < 0) return null;
    s.setWord(V.ships, s.word(V.ships) + 1);
    this.sim.world.cells[this.cellIndex(x, y)] |= CELL_UNIT;
    const init = UNIT_INIT[type - 9];
    const cls = type - 11;
    const ship: Ship = {
      type,
      x,
      y,
      dx: 0,
      dy: 0,
      dir,
      hp: init.hp,
      mode: init.mode,
      tech: s.byte(0x14592),
      targetX: 0xff,
      targetY: 0xff,
      cls: cls & 0xff,
      fuel: cls !== 4 ? 0 : init.fuel, // $387E clears the fuel word unless class 4
      lift: 0,
    };
    // $381E: per-type count at $14254 + 4 * (type - 9), none for type 17.
    if (type !== 17) s.setLong(0x14254 + 4 * (type - 9), s.long(0x14254 + 4 * (type - 9)) + 1);
    this.slots[slot] = ship;
    return ship;
  }

  // $49E8 / $381E: a missile record in the first free ship slot, count word $1429E + 1. No per-type count (none for type 17),
  // no map or flag write (the EnemySystem sets the air mark and the reservation) and no message: a full list ($1429E == 40 or no
  // free slot) is refused by returning null and the caller says $12B. Mode 4, lift 0, no target yet (+B/+C = $FF); the target
  // pointer is the EnemySystem's (ShipExtra.targetSlot). hp from table $4B76 row 17, tech byte $14592.
  createMissile(x: number, y: number): MissileRecord | null {
    const s = this.s;
    if (s.word(V.ships) >= MAX_SHIPS) return null;
    const slot = this.slots.indexOf(null);
    if (slot < 0) return null;
    s.setWord(V.ships, s.word(V.ships) + 1);
    const missile: MissileRecord = {
      kind: "missile",
      type: 17,
      x,
      y,
      dx: 0,
      dy: 0,
      dir: 0,
      hp: UNIT_INIT[17 - 9].hp,
      mode: 4,
      tech: s.byte(0x14592),
      targetX: 0xff,
      targetY: 0xff,
      lift: 0,
    };
    this.slots[slot] = missile;
    return missile;
  }

  // $46CC: remove a ship. `message` 0 = none. Counts as a lost unit (-100 morale) except for projectiles.
  destroyShip(ship: FleetRecord, message = 0, explode = true): void {
    const s = this.s;
    const sim = this.sim;
    const slot = this.slots.indexOf(ship);
    if (slot < 0) return;
    if (ship.type !== 0x11) {
      const addr = 0x14254 + 4 * (ship.type - 9);
      s.setLong(addr, s.long(addr) - 1);
      s.setLong(0x14294, s.long(0x14294) + 1);
      sim.applyMorale(-100);
    }
    s.setWord(V.ships, s.word(V.ships) - 1);
    this.slots[slot] = null;
    if (this.releaseReservation) this.releaseReservation(ship);
    else {
      // Standalone Fleet fallback, used only when no EnemySystem owns ship movement/reservations.
      const i = this.cellIndex(ship.x, ship.y);
      if (ship.lift !== 0) sim.world.cells[i] &= ~CELL_AIR;
      else sim.world.cells[i] &= ~CELL_UNIT;
    }
    if (explode) sim.effect("explosion", ship.x, ship.y);
    sim.events.push({ kind: "ship", what: "destroyed", type: ship.type, x: ship.x, y: ship.y });
    if (message !== 0) sim.msg(message);
  }

  // ---- ship yard ($AC04, monthly after the tank yard) -----------------------------------------------

  // The yard dialog $D7D6 ($D8E8): choose ship class 1..6 for the yard record at object slot `slot`.
  // Class 5 (index 4) needs invention bit 4. Stores +6 = class, +7 = frame cost (good 1 units).
  orderShip(slot: number, shipClass: number): boolean {
    const o = this.sim.world.objects;
    const at = slot * 8;
    if (((o[at] << 8) | o[at + 1]) !== SHIP_YARD_TILE) return false;
    if (shipClass < 1 || shipClass > 6) return false;
    if (shipClass === 5 && (this.s.long(0x14472) & 0x10) === 0) return false;
    o[at + 6] = shipClass;
    o[at + 7] = YARD_FRAME_COST[shipClass - 1] & 0xff;
    return true;
  }

  // $AC04. Record +6 = ordered class (0 = idle), +7 = remaining frame cost, $FF = ready to launch.
  shipYard(): void {
    const s = this.s;
    const sim = this.sim;
    if (s8(s.byte(0x144c8)) >= 9) return;
    if (s.word(0x133f8) === 0) return; // no command centre
    let yards = s.word(0x133d4);
    const workers = s.long(0x143f6);
    if (workers === 0 || yards === 0) return;
    const per = divuQ(workers, yards); // workers per yard
    if (per === 0) return;
    const o = sim.world.objects;
    for (let slot = 0; slot < OBJECT_SLOTS && yards > 0; slot++) {
      const at = slot * 8;
      if (((o[at] << 8) | o[at + 1]) !== SHIP_YARD_TILE) continue;
      yards--;
      if (o[at + 6] === 0) continue;
      const left = o[at + 7];
      let launch = left === 0xff;
      if (!launch) {
        if (left !== 0) {
          // stage 1: good 1 (at most `per` units per month, byte-truncated like the original)
          const want = ((per & 0xffff) <= left ? per : left) & 0xff;
          const took = sim.removeGoods(want, 1);
          if (took === 0) return sim.msg(0xc6);
          const rest = (left - took) & 0xff;
          o[at + 7] = rest;
          s.setLong(0x1437a, s.long(0x1437a) + took);
          s.setLong(0x143a2, s.long(0x143a2) + took);
          s.setLong(0x1434a, (s.long(0x1434a) - took) >>> 0);
          if (rest !== 0) continue;
        }
        // stage 2: good 3 by class
        const need = YARD_GOODS3[o[at + 6] - 1] ?? 0;
        if (need !== 0 && sim.removeGoods(need, 3) === 0) return sim.msg(0xc5);
        o[at + 7] = 0xff;
        launch = true;
      }
      if (launch) this.launch(slot);
    }
  }

  // $4060: launch the finished ship from a free launchpad cell within 5 cells of the yard (launchpad = record
  // tile $48 with active flag $FF; its 2x2 cells are tried in the order (x,y) (x,y+1) (x+1,y+1) (x+1,y)).
  // No free cell: message $C7 and the yard keeps waiting (+7 = $FF). Returns the new ship.
  launch(slot: number): Ship | null {
    const sim = this.sim;
    const o = sim.world.objects;
    const at = slot * 8;
    const yx = o[at + 4];
    const yy = o[at + 5];
    const cells: [number, number][] = [];
    for (let i = 0; i < OBJECT_SLOTS; i++) {
      const p = i * 8;
      if (((o[p] << 8) | o[p + 1]) !== TILE_LAUNCHPAD) continue;
      if (o[p + 3] !== 0xff) continue;
      if (Math.abs(o[p + 4] - yx) > 5 || Math.abs(o[p + 5] - yy) > 5) continue;
      const px = o[p + 4];
      const py = o[p + 5];
      cells.push([px, py], [px, py + 1], [px + 1, py + 1], [px + 1, py]);
    }
    const free = cells.find(([x, y]) => x < MAP_WIDTH && y < MAP_HEIGHT && (sim.world.cells[this.cellIndex(x, y)] & CELL_UNIT) === 0);
    if (!free) {
      sim.msg(0xc7);
      return null;
    }
    const cls = o[at + 6] - 1;
    o[at + 6] = 0;
    o[at + 7] = 0;
    const s = this.s;
    s.setLong(0x143b2, s.long(0x143b2) + 1);
    sim.effect("launch", free[0], free[1]);
    const ship = this.createShip(SHIP_UNIT_TYPE[cls], free[0], free[1], 8);
    if (ship) sim.events.push({ kind: "ship", what: "launched", type: ship.type, x: ship.x, y: ship.y });
    return ship;
  }

  // ---- fuel ---------------------------------------------------------------------------------------

  // $ACE2 (daily): hovering ships burn 1 fuel, flying ones 2; at 0 the ship is lost (message $40). Class 4
  // (type 15) never burns. Every missile (launched or restored; pointer to a fixed enemy slot) is handed to the EnemySystem:
  // it refreshes +B/+C from the slot's current occupant or is destroyed when the slot is free. No fuel for type 17.
  dailyFuel(): void {
    for (const ship of this.ships) {
      if (isMissile(ship)) {
        this.missileDaily?.(ship);
        continue;
      }
      if (ship.type === 0x0f) continue;
      const burn = ship.mode === 1 ? 1 : ship.mode === 2 || ship.mode === 3 ? 2 : 0;
      if (burn === 0) continue;
      const left = s16(ship.fuel - burn);
      if (left <= 0) this.destroyShip(ship, 0x40);
      else ship.fuel = left & 0xffff;
    }
  }

  // $76DE: a fuel tank tile ($3F/$40) within 7 cells left/up and 6 right/down of the cell.
  private tankNear(x: number, y: number): boolean {
    for (let cy = y - 7; cy <= y + 6; cy++) {
      for (let cx = x - 7; cx <= x + 6; cx++) {
        if (cx < 0 || cy < 0 || cx >= MAP_WIDTH || cy >= MAP_HEIGHT) continue;
        const id = this.sim.world.cells[this.cellIndex(cx, cy)] & TILE_ID_MASK;
        if (id === 0x3f || id === 0x40) return true;
      }
    }
    return false;
  }

  // $A5A6: take `amount` of fuel out of the two tank types. Same flat 800/1200 limits and untouched
  // second type as $A51A (Sim.storeFuel).
  withdrawFuel(amount: number): void {
    const s = this.s;
    s.setLong(V.fuelStored, (s.long(V.fuelStored) - amount) >>> 0);
    s.setLong(0x14376, (s.long(0x14376) + amount) >>> 0);
    s.setLong(0x1439a, (s.long(0x1439a) + amount) >>> 0);
    const countA = s.word(V.tankCountA + 0xc);
    const countB = s.word(V.tankCountB + 0xc);
    let d0 = (s.word(V.tankCountA + 0xe) + s.word(V.tankCountB + 0xe) - amount) | 0;
    let d1 = 0;
    const capA = mulu(countA, 800);
    let fitsA = false;
    if (capA === 0) {
      d1 = d0;
      d0 = 0;
    } else if (((capA - d0) | 0) >= 0) {
      fitsA = true;
    } else {
      d1 = d0 - 800;
      d0 = 800;
    }
    if (!fitsA) {
      if (((mulu(countB, 1200) - d1) | 0) < 0) d1 = (d1 & 0xffff0000) | 1200;
      if (countB === 0) d1 = 0;
      s.setWord(V.tankCountB + 0xe, d1);
    }
    s.setWord(V.tankCountA + 0xe, d0);
  }

  // $4798 (weekly): landed ships (mode 0, class != 4) standing on a launchpad tile ($48..$4B) with a fuel tank
  // nearby are filled from the tanks up to their capacity; when the tanks run dry message $EE (once a month).
  weeklyRefuel(): void {
    const s = this.s;
    for (const ship of this.ships) {
      if (isMissile(ship) || ship.mode !== 0 || ship.cls === 4) continue;
      if (!this.tankNear(ship.x, ship.y)) continue;
      const tile = this.sim.world.cells[this.cellIndex(ship.x, ship.y)] & TILE_ID_MASK;
      if (tile < 0x48 || tile > 0x4b) continue;
      const stock = s.word(V.tanksStored) + s.word(V.tanksStoredB);
      let need = s16((SHIP_FUEL_CAP[ship.cls] - ship.fuel) & 0xffff);
      if (need === 0) continue;
      if (stock < need) {
        need = stock;
        if (!this.fuelWarned) {
          this.fuelWarned = true;
          this.sim.msg(0xee);
        }
      }
      ship.fuel = (ship.fuel + need) & 0xffff;
      this.withdrawFuel(need);
    }
  }

  // $12510 (weekly): ships (and ground units, through `repairUnits`) heal tech/2 hit points up to the type maximum.
  weeklyRepair(): void {
    const heal = this.s.byte(0x14592) >> 1;
    if (heal === 0) return;
    for (const ship of this.ships) {
      const max = UNIT_INIT[ship.type - 9].hp;
      ship.hp = (ship.hp + heal) & 0xff;
      if (s8(max - ship.hp) < 0) ship.hp = max;
    }
    this.sim.repairUnits(heal);
  }

  // ---- events -------------------------------------------------------------------------------------

  // Event 12 ($113A6): the first ship, if it is airborne (+$10 non-zero), explodes. Message $109.
  eventShipExplosion(chance: number): void {
    const sim = this.sim;
    if (sim.roll(100) >= chance) return;
    if (this.s.word(V.ships) === 0) return;
    const ship = this.ships[0];
    if (!ship || ship.lift === 0) return;
    sim.effect("focus", ship.x, ship.y);
    this.destroyShip(ship, 0);
    sim.msg(0x109);
  }

  // Event 15 ($114AC): with power level < 6, every building of type 13 (T[13].C) beams up to 400 units of fuel
  // out of the tanks; half of it is lost, the rest tops up the ships 20 units per round until they are full,
  // whatever is left goes back into the tanks. Message $52 when it starts.
  eventFuelBeam(): void {
    const s = this.s;
    const sim = this.sim;
    if (s8(s.byte(0x144c8)) >= 6) return;
    const beamers = s.word(0x132d8);
    if (beamers === 0 || s.word(V.ships) === 0) return;
    let d0 = mulu(beamers, 400);
    const stock = (s.word(V.tanksStored) + s.word(V.tanksStoredB)) & 0xffff;
    if (stock === 0) return;
    sim.msg(0x52);
    if (d0 >= stock) d0 = stock;
    this.withdrawFuel(d0);
    d0 >>= 1;
    for (;;) {
      let any = false;
      for (const ship of this.ships) {
        if (isMissile(ship) || ship.type === 0x0f) continue;
        const missing = s16((SHIP_FUEL_CAP[ship.cls] - ship.fuel) & 0xffff);
        if (missing === 0) continue;
        any = true;
        const give = missing >= 20 ? 20 : missing;
        ship.fuel = (ship.fuel + give) & 0xffff;
        d0 -= give;
        if (d0 <= 0) return; // nothing is returned
      }
      if (!any) break;
    }
    sim.storeFuel(d0 * 2);
  }
}
