// Building placement, construction and demolition. Ports of the original routines
// $6BF4 (place), $7372 (demolish), $6F22/$7628/$7696 (placement rules); the weekly construction
// countdown $7000/$703A and the cell writers $6FC4/$6A8C live in construction.ts. Notes:
// notes/formats/game-state.md section 7 and notes/formats/building.md.

import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK } from "../data/scenario.js";
import { Construction, SITE_TILE, TILE_WAREHOUSE } from "./construction.js";
import { T, type World } from "./world.js";

export { SITE_TILE };
const TILE_CLEARED = 0x38;
const TILE_DRILL = 0x3c;

const V = {
  freeColonists: 0x13136,
  builders: 0x1432a,
  money: 0x135ba,
  spent: 0x142ca,
  objects: 0x142c2,
  sites: 0x142c4,
  warn: 0x144b1,
  capacity: 0x14432,
  farmA: 0x143be,
  farmB: 0x143c2,
  stock: 0x13152,
  weight: 0x13166,
} as const;

const FLAG_BLOCK_MASK = 0x5400; // $6F22: bits 14, 12, 10 of a cell word
const FLAG_NEAR = 0x0400; // $7628: bit 10

// Strings the original shows for placement results (indices into the language string table).
export const MSG = {
  noWorkers: 0x5d,
  noMoney: 0x25,
  noFreeSlot: 3,
  blocked: 2,
  mustBeConnected: 1,
  tooFar: 0x127,
  demolishRefused: 0x58,
  warnPowerOff: 0x5e,
  warnStrike: 0x11b,
  noGroundForVent: 0x123,
} as const;

// Weights per stock slot ($B0EC), used when a warehouse is demolished (5 entries as longs).
const WAREHOUSE_WEIGHTS_SLOTS = 5;

export interface Placement {
  tile: number; // building tile id the player picked ($142B2)
  type: number; // index into the type table
}

export class Builder {
  // `flagTable` = the 256 bytes at $16408 of the game image (cell flag byte per tile id),
  // `weights` = longs at $B0EC (weight per unit of the five stored goods).
  readonly construction: Construction;
  // A click refused for lack of money drops the selection; $15EF0 (placement) also leaves build mode.
  // The owner of the mode (controls.ts) sets this.
  onBuildCancelled: (leaveBuildMode: boolean) => void = () => {};

  constructor(
    private readonly world: World,
    flagTable: Uint8Array,
    private readonly weights: number[],
    private readonly say: (message: number) => void,
    phase?: () => boolean,
  ) {
    this.construction = new Construction(world, flagTable, phase);
  }

  private get s() {
    return this.world.state;
  }

  private cellIndex(x: number, y: number): number {
    return y * MAP_WIDTH + x;
  }

  private footprint(type: number): number {
    return this.s.byte(this.world.typeAddress(type) + 1); // 1 or 4 cells
  }

  private freeSlot(): number {
    const o = this.world.objects;
    for (let i = 0; i < o.length; i += 8) if (o[i] === 0 && o[i + 1] === 0) return i;
    return -1;
  }

  // $6FC4 / $6A8C, see construction.ts.
  private markCells(tile: number, x: number, y: number, size: number): void {
    this.construction.markSite(tile, x, y, size);
  }

  private writeBuilding(tile: number, x: number, y: number, size: number): void {
    this.construction.writeTiles(tile, x, y, size);
  }

  // $6D58: placement is only allowed away from the map border.
  private inRange(x: number, y: number): boolean {
    return x > 3 && y > 3 && x < 0x61 && y < 0x48;
  }

  // $7696: a base building (tiles 1-3) must lie within a 24 x 24 window starting 12 rows up
  // and 12 columns left of the cell (the original's pointer arithmetic: a0 - $9A8 words).
  private nearBase(x: number, y: number): boolean {
    for (let dy = -12; dy < 12; dy++) {
      for (let dx = -12; dx < 12; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx < 0 || cy < 0 || cx >= MAP_WIDTH || cy >= MAP_HEIGHT) continue;
        const id = this.world.cells[this.cellIndex(cx, cy)] & TILE_ID_MASK;
        if (id === 1 || id === 2 || id === 3) return true;
      }
    }
    return false;
  }

  // $7628: a power-storage site needs a neighbouring cell with flag bit 10.
  private touchesFlag(x: number, y: number, size: number): boolean {
    const at = (dx: number, dy: number): boolean => {
      const cx = x + dx;
      const cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= MAP_WIDTH || cy >= MAP_HEIGHT) return false;
      return (this.world.cells[this.cellIndex(cx, cy)] & FLAG_NEAR) !== 0;
    };
    const offsets = size === 1 ? [[0, -1], [-1, 0], [1, 0], [0, 1]] : [[0, -1], [1, -1], [-1, 0], [2, 0], [-1, 1], [2, 1], [0, 2], [1, 2]];
    return offsets.some(([dx, dy]) => at(dx, dy));
  }

  // $6F22: 0 = free, -1 = blocked, -0x8c = the drill needs ground tiles $94-$9B.
  private occupancy(selected: number, x: number, y: number, size: number): number {
    const cells = this.world.cells;
    const offsets = size === 1 ? [[0, 0]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
    const blocked = offsets.some(([dx, dy]) => (cells[this.cellIndex(x + dx, y + dy)] & FLAG_BLOCK_MASK) !== 0);
    const origin = cells[this.cellIndex(x, y)] & TILE_ID_MASK;
    const onGround = origin >= 0x94 && origin < 0x9c;
    if (selected === TILE_DRILL) {
      if (blocked) return onGround ? 0 : -1;
      return onGround ? -0x8c : 0;
    }
    return blocked ? -1 : 0;
  }

  // $6BF4: a left click on map cell (x, y) in build mode.
  place(selection: Placement, x: number, y: number): boolean {
    const s = this.s;
    const { tile, type } = selection;
    if (!this.inRange(x, y)) {
      this.say(MSG.blocked);
      return false;
    }
    const size = this.footprint(type);
    if (!this.nearBase(x, y)) {
      if (tile !== 1) {
        this.say(MSG.tooFar);
        return false;
      }
      if (!this.touchesFlag(x, y, size)) {
        this.say(MSG.mustBeConnected);
        return false;
      }
    }
    const occ = this.occupancy(tile, x, y, size);
    if (occ < 0) {
      this.say(occ === -0x8c ? MSG.mustBeConnected : MSG.blocked);
      return false;
    }
    if (tile === 0x61) return this.clearGround(selection, x, y);
    const slot = this.freeSlot();
    if (slot < 0) {
      this.say(MSG.noFreeSlot);
      return false;
    }
    const t = this.world.typeAddress(type);
    if (s.byte(V.warn) & 2) {
      this.say(MSG.warnPowerOff);
      return false;
    }
    if (s.byte(V.warn) & 4) {
      this.say(MSG.warnStrike);
      return false;
    }
    const workers = s.byte(t + 4);
    const free = s.signedLong(V.freeColonists) - workers;
    if (free < 0) {
      this.say(MSG.noWorkers);
      return false;
    }
    // $6CA2-$6CBE: the workers are moved to the builders counter BEFORE the money test. Without the
    // money the click is refused (message $25, build mode left by $15EF0) but the colonists stay
    // in `$1432A`: an original quirk, kept.
    s.setLong(V.freeColonists, free);
    s.setLong(V.builders, s.long(V.builders) + workers);
    const cost = s.word(t + T.buildCost);
    const money = s.signedLong(V.money) - cost;
    if (money < 0) {
      this.say(MSG.noMoney);
      this.onBuildCancelled(true);
      return false;
    }
    s.setLong(V.money, money >>> 0);
    s.setLong(V.spent, s.long(V.spent) + cost);

    const o = this.world.objects;
    o[slot] = 0;
    o[slot + 1] = SITE_TILE;
    o[slot + 2] = tile >> 8;
    o[slot + 3] = tile & 0xff;
    o[slot + 4] = x;
    o[slot + 5] = y;
    o[slot + 6] = s.byte(t + 2); // weeks remaining
    o[slot + 7] = 0;
    s.setWord(V.objects, s.word(V.objects) + 1);
    s.setWord(V.sites, s.word(V.sites) + 1);
    this.markCells(SITE_TILE, x, y, size);
    return true;
  }

  // $6D10: ground clearing costs twice the table price and rewrites the cell to tile $38.
  private clearGround(selection: Placement, x: number, y: number): boolean {
    const s = this.s;
    const t = this.world.typeAddress(selection.type);
    const cost = s.word(t + T.buildCost) * 2;
    const money = s.signedLong(V.money) - cost;
    if (money < 0) {
      this.say(MSG.noMoney);
      this.onBuildCancelled(false); // $6D2C: the selection ($142B2/$142B6) is cleared, the mode stays
      return false;
    }
    s.setLong(V.money, money >>> 0);
    s.setLong(V.spent, s.long(V.spent) + cost);
    this.writeBuilding(selection.tile, x, y, 1);
    return true;
  }

  // $7000: one week passes; every construction site counts down and completes at zero.
  weekly(): void {
    this.construction.weekly();
  }

  // $72C0: the object record whose origin cell is (x, y) (a 2x2 building is found through
  // any of its four cells), or -1.
  findObject(x: number, y: number): number {
    const id = this.world.cells[this.cellIndex(x, y)] & TILE_ID_MASK;
    let ox = x;
    let oy = y;
    if (id >= 0x62) return -1;
    if (id >= 0x48 && id < 0x60) {
      const part = (id - 0x48) & 3;
      ox -= part & 1;
      oy -= part >> 1;
    }
    const o = this.world.objects;
    for (let i = 0; i < o.length; i += 8) {
      if (o[i] === 0 && o[i + 1] === 0) continue;
      if (o[i + 4] === ox && o[i + 5] === oy) return i;
    }
    return -1;
  }

  // $7372: a left click on map cell (x, y) in demolish mode.
  demolish(x: number, y: number): boolean {
    const slot = this.findObject(x, y);
    const cellId = this.world.cells[this.cellIndex(x, y)] & TILE_ID_MASK;
    if (slot < 0) {
      if (cellId === 0x61 || (cellId >= 0x94 && cellId <= 0x9b) || cellId === TILE_CLEARED) {
        this.writeBuilding(0x9e, x, y, 1);
        return true;
      }
      this.say(MSG.demolishRefused);
      return false;
    }
    const o = this.world.objects;
    const tile = (o[slot] << 8) | o[slot + 1];
    if (tile === SITE_TILE) return this.cancelSite(slot);
    const s = this.s;
    const type = this.world.findType(tile);
    const t = this.world.typeAddress(type);
    if (tile === 0x47 && this.cellWord(x, y) & 0x4000 && !(s.byte(0x156a9) & 0x10)) {
      this.say(MSG.noGroundForVent);
      return false;
    }
    const stored = new Set([1, 2, 3, 0x3f, 0x40, 0x54, 0x3c]);
    const total = s.word(t + T.total);
    if (stored.has(tile) && total > 0) {
      s.setWord(t + T.stored, s.word(t + T.stored) - Math.floor(s.word(t + T.stored) / total));
    }
    if (tile === 0x41) {
      s.setLong(V.farmA, s.long(V.farmA) - 10);
      s.setLong(V.freeColonists, s.long(V.freeColonists) + 10);
    } else if (tile === 0x42) {
      s.setLong(V.farmB, s.long(V.farmB) - 10);
      s.setLong(V.freeColonists, s.long(V.freeColonists) + 10);
    } else if (tile === TILE_WAREHOUSE && total > 0) {
      for (let i = 0; i < WAREHOUSE_WEIGHTS_SLOTS; i++) {
        const at = V.stock + 4 * i;
        const share = Math.floor(s.long(at) / total);
        s.setLong(at, s.long(at) - share);
        s.setLong(V.weight, s.long(V.weight) - share * (this.weights[i] ?? 0));
      }
      s.setLong(V.capacity, s.long(V.capacity) - 80000);
    }
    o[slot] = 0;
    o[slot + 1] = 0;
    s.setWord(V.objects, s.word(V.objects) - 1);
    s.setWord(t + T.active, Math.max(0, s.word(t + T.active) - 1));
    if (o[slot + 3] !== 0) s.setWord(t + T.total, Math.max(0, s.word(t + T.total) - 1));
    this.writeBuilding(TILE_CLEARED, o[slot + 4], o[slot + 5], s.byte(t + 1));
    return true;
  }

  private cellWord(x: number, y: number): number {
    return this.world.cells[this.cellIndex(x, y)];
  }

  // $74FE: demolishing a construction site refunds the workers (not the money).
  private cancelSite(slot: number): boolean {
    const s = this.s;
    const o = this.world.objects;
    const target = (o[slot + 2] << 8) | o[slot + 3];
    const t = this.world.typeAddress(this.world.findType(target));
    const x = o[slot + 4];
    const y = o[slot + 5];
    o[slot] = 0;
    o[slot + 1] = 0;
    s.setWord(V.objects, s.word(V.objects) - 1);
    s.setWord(V.sites, Math.max(0, s.word(V.sites) - 1));
    const workers = s.byte(t + 4);
    s.setLong(V.builders, s.long(V.builders) - workers);
    s.setLong(V.freeColonists, s.long(V.freeColonists) + workers);
    this.writeBuilding(TILE_CLEARED, x, y, s.byte(t + 1));
    return true;
  }
}
