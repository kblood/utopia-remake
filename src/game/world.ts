// The world: map cells plus the 8-byte object records the original builds from the map at the
// start of a game ($6D78). Layouts: notes/formats/game-state.md, sections 7.1-7.3.

import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK } from "../data/scenario.js";
import { GameState } from "./state.js";

export const TYPE_TABLE = 0x131e2;
export const TYPE_SIZE = 18;
export const TYPE_COUNT = 34;
export const OBJECT_SLOTS = 1000;
export const OBJECT_SIZE = 8;

// Offsets inside an 18-byte type entry.
export const T = { active: 0x0a, total: 0x0c, tile: 8, buildCost: 6, power: 5, stored: 0x0e } as const;

const FLAG_FUEL = 0x0800;
const FLAG_RICHNESS = 0x8000;
const CELL_FLAGS = 0xfc00;

// Table $77C8: tiles $48-$5F are 2x2 buildings; each tile has the offset of its part. Only
// the origin part (offset 0) creates a record.
const MULTI_FIRST = 0x48;
const MULTI_LAST = 0x5f;
const MULTI_BASES = [0x48, 0x48, 0x48, 0x48, 0x4c, 0x4c, 0x4c, 0x4c, 0x4c, 0x4c, 0x4c, 0x4c, 0x54, 0x54, 0x54, 0x54, 0x58, 0x58, 0x58, 0x58, 0x5c, 0x5c, 0x5c, 0x5c];
const MULTI_ORIGIN = [0, 0x100, 1, 0x101]; // offset word per part, repeated

const TILE_COMMAND_CENTRE = 0x4c;
const TILE_WAREHOUSE = 0x44;
const TILE_MINE = 0x60;
const TILE_FUEL = 0x3e;
const TILE_MARKER = 0x7f;

export class World {
  readonly cells: Uint16Array;
  readonly objects = new Uint8Array(OBJECT_SLOTS * OBJECT_SIZE);
  objectCount = 0;
  warehouseCapacity = 0;

  constructor(
    readonly state: GameState,
    cells: Uint16Array,
  ) {
    this.cells = cells.slice();
    this.buildObjects();
  }

  cell(x: number, y: number): number {
    return this.cells[y * MAP_WIDTH + x];
  }

  typeAddress(index: number): number {
    return TYPE_TABLE + TYPE_SIZE * index;
  }

  // $6BE0: find the type whose tile id matches.
  findType(tile: number): number {
    for (let i = 0; i < TYPE_COUNT; i++) {
      if (this.state.word(this.typeAddress(i) + T.tile) === tile) return i;
    }
    throw new Error(`World: no object type for tile ${tile}`);
  }

  // Number of the nine cells around (x, y), itself included, that carry `flag` ($75D4).
  private countFlag(x: number, y: number, flag: number): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx < 0 || cy < 0 || cx >= MAP_WIDTH || cy >= MAP_HEIGHT) continue;
        if (this.cell(cx, cy) & flag) n++;
      }
    }
    return n;
  }

  // Tile id of the building type a map tile belongs to, or -1 when no record is made.
  private static typeTile(id: number): number {
    if (id === TILE_MARKER) return -1;
    if (id >= MULTI_FIRST && id <= MULTI_LAST) {
      const part = id - MULTI_FIRST;
      return MULTI_ORIGIN[part % 4] === 0 ? MULTI_BASES[part] : -1;
    }
    if (id >= 0x62 || id === 0x38 || id >= 0x9e) return -1;
    if (id < 4) return 1;
    if (id < 6) return id;
    if (id < 10) return 6;
    if (id < 14) return 10;
    if (id < 15) return id;
    if (id < 0x1f) return 0x0f;
    if (id < 0x2f) return 0x1f;
    return id;
  }

  private buildObjects(): void {
    const s = this.state;
    const view = new DataView(this.objects.buffer);
    let slot = 0;
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        const id = this.cell(x, y) & TILE_ID_MASK;
        const tile = World.typeTile(id);
        if (tile < 0) continue;

        const type = this.findType(tile);
        const t = this.typeAddress(type);
        const at = slot * OBJECT_SIZE;
        view.setUint16(at, tile);
        this.objects[at + 2] = s.byte(t + 1);
        this.objects[at + 3] = s.byte(t + 3);
        this.objects[at + 4] = x;
        this.objects[at + 5] = y;
        s.setWord(t + T.active, s.word(t + T.active) + 1);
        if (tile === TILE_COMMAND_CENTRE) this.objects[at + 3] = 0xff;
        if (tile === TILE_WAREHOUSE) this.warehouseCapacity += 80000;
        if (tile === TILE_MINE) this.objects[at + 6] = this.countFlag(x, y, FLAG_RICHNESS);
        if (tile === TILE_FUEL) this.objects[at + 6] = this.countFlag(x, y, FLAG_FUEL);
        if (tile === 0x0f || tile === 0x1f) {
          // Solar-type tiles: the map cell is normalised and the record gets a random phase.
          view.setUint16(at, tile);
          this.cells[y * MAP_WIDTH + x] = (this.cell(x, y) & CELL_FLAGS) | (this.cell(x, y) & 0x300) | tile;
          this.objects[at + 2] = 0;
          this.objects[at + 7] = 0;
          this.objects[at + 6] = Math.random() < 0.5 ? 0xff : 1;
        }
        s.setWord(t + T.total, s.word(t + T.total) + 1);
        slot++;
      }
    }
    this.objectCount = slot;
    s.setWord(0x142c2, slot);
  }

  // Total number of finished buildings of a type (T[i].C).
  count(type: number): number {
    return this.state.word(this.typeAddress(type) + T.total);
  }
}
