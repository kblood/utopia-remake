// The world: map cells plus the 8-byte object records the original builds from the map at the
// start of a game ($6D78). Layouts: notes/formats/game-state.md, sections 7.1-7.3.

import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK } from "../data/scenario.js";
import { CELL_FLAG_BYTES } from "./cell-flags.js";
import { createRng, type SeededRng } from "./sim-math.js";
import { GameState, type SnapshotError, type SnapshotResult } from "./state.js";

// The flag array layout (102-byte rows) lives in cell-flags.ts; re-exported for existing importers.
export { CELL_FLAG_BYTES, CELL_FLAG_ROW_BYTES } from "./cell-flags.js";

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

/** Word in the variable block: number of used object records ("saved count"). */
export const OBJECT_COUNT_ADDRESS = 0x142c2;

/** The map and object parts of a saved game, as World.fromSnapshot takes them (all copied, nothing interpreted). */
export interface WorldSnapshot {
  /** MAP_WIDTH * MAP_HEIGHT cell words, row-major, tile id and flag bits exactly as stored. */
  readonly cells: Uint16Array;
  /** CELL_FLAG_BYTES per-cell flag bytes ($3D3A6, 102-byte rows) exactly as stored. */
  readonly cellFlags: Uint8Array;
  /** OBJECT_SLOTS * OBJECT_SIZE bytes: every record slot exactly as stored, free slots (tile word 0) included. */
  readonly objects: Uint8Array;
}

/** Optional fresh-world inputs used by deterministic trace replay; omitted in normal play. */
export interface WorldOptions {
  /** Seed for the remake's solar-phase stream, including phases requested after initial map construction. */
  readonly solarPhaseSeed?: number;
  /** One-shot override for solar phases consumed while `$6D78` builds records; called before the first map pass. */
  readonly startupSolarPhase?: () => boolean;
}

// Module-private marker: selects the constructor overload that adopts saved world data.
const FROM_SNAPSHOT: unique symbol = Symbol("World.fromSnapshot");

export class World {
  /** Remake-only approximation for the original's beam-position solar phase bit. Saved separately from Sim RNG. */
  private readonly solarPhaseRng: SeededRng;
  readonly cells: Uint16Array;
  readonly objects = new Uint8Array(OBJECT_SLOTS * OBJECT_SIZE);
  /**
   * Number of used object records as the original's count word ($142C2) saw it when the world was
   * created: buildObjects() sets it to the records it made, fromSnapshot() to the saved count word.
   * It is NOT kept current by building, demolishing or construction, and used records are NOT a
   * dense prefix: construction takes the first free slot and demolition frees a slot in place.
   * Never use it as a loop bound over `objects`; scan all OBJECT_SLOTS (a slot is free when its tile
   * word is 0) and use the state word at OBJECT_COUNT_ADDRESS for the live count.
   */
  objectCount = 0;
  warehouseCapacity = 0;
  /**
   * The original's per-cell flag bytes ($3D3A6, CELL_FLAG_BYTES = 75 rows x 102, index y * 102 + x; see
   * cell-flags.ts). Always a real buffer: all zero for a world built from a scenario, a copy of the saved
   * bytes (padding columns included) for World.fromSnapshot. The runtime flag users (UnitSystem,
   * EnemySystem, the building screens) share THIS buffer and only touch bits of playable cells; map words
   * stay in `cells` with their own 100-wide indexing.
   */
  readonly cellFlags: Uint8Array;
  private readonly startupSolarPhase: (() => boolean) | undefined;

  constructor(state: GameState, cells: Uint16Array, options?: WorldOptions);
  /** Internal: adopts validated saved data; use World.fromSnapshot. */
  constructor(state: GameState, cells: Uint16Array, marker: typeof FROM_SNAPSHOT, saved: WorldSnapshot);
  constructor(
    readonly state: GameState,
    cells: Uint16Array,
    markerOrOptions?: typeof FROM_SNAPSHOT | WorldOptions,
    saved?: WorldSnapshot,
  ) {
    const marker = markerOrOptions === FROM_SNAPSHOT ? FROM_SNAPSHOT : undefined;
    const options = marker ? undefined : markerOrOptions as WorldOptions | undefined;
    const seed = options?.solarPhaseSeed;
    if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)) {
      throw new RangeError("World: solarPhaseSeed must be an unsigned 32-bit integer");
    }
    // A snapshot/restored world must not consume host randomness while a load is being prepared.
    this.solarPhaseRng = createRng(marker === FROM_SNAPSHOT ? 0 : seed ?? Math.floor(Math.random() * 0x1_0000_0000));
    this.startupSolarPhase = options?.startupSolarPhase;
    this.cells = cells.slice();
    if (marker === FROM_SNAPSHOT && saved) {
      // Adopt as stored: no buildObjects, no solar-tile normalisation, no random phases, no type
      // counters or warehouse capacity touched. warehouseCapacity stays 0 so that Sim does not
      // overwrite the saved capacity word.
      this.objects.set(saved.objects);
      this.cellFlags = saved.cellFlags.slice();
      this.objectCount = state.word(OBJECT_COUNT_ADDRESS);
    } else {
      this.cellFlags = new Uint8Array(CELL_FLAG_BYTES);
      this.buildObjects();
    }
  }

  /** Current serializable state for future solar-building phase rolls. */
  get solarPhaseRngState(): number {
    return this.solarPhaseRng.getState();
  }

  /** Restore the remake's solar phase stream; callers validate before committing a session. */
  restoreSolarPhaseRngState(value: number): void {
    this.solarPhaseRng.setState(value);
  }

  /** $2E00 is approximated by a separate serializable random stream, not the Sim RNG. */
  nextSolarPhase(): boolean {
    return this.solarPhaseRng(2) === 0;
  }

  /**
   * Builds a world from a saved game over an already restored state, without the new-game builder:
   * all map cells, all per-cell flag bytes and all OBJECT_SLOTS records are copied byte for byte,
   * keeping every record in its original slot (free slots stay free, nothing is compacted) and the
   * saved count word of `state` ($142C2) as is. No defaults are applied, no counters are recomputed
   * and no randomness is used. Pure: `state` is only read, inputs are copied, and a bad input yields
   * a typed error and no object.
   */
  static fromSnapshot(state: GameState, saved: WorldSnapshot): SnapshotResult<World> {
    const fail = (code: SnapshotError["code"], message: string): SnapshotResult<World> => ({ ok: false, error: { code, message } });
    if (!(state instanceof GameState)) return fail("not-bytes", "World.fromSnapshot needs a GameState");
    if (typeof saved !== "object" || saved === null) return fail("not-bytes", "World.fromSnapshot needs { cells, cellFlags, objects }");
    if (!(saved.cells instanceof Uint16Array)) return fail("not-bytes", "Map cells must be a Uint16Array");
    if (!(saved.cellFlags instanceof Uint8Array) || !(saved.objects instanceof Uint8Array)) {
      return fail("not-bytes", "Cell flags and object records must be Uint8Arrays");
    }
    if (saved.cells.length !== MAP_WIDTH * MAP_HEIGHT) {
      return fail("map-size", `Map has ${saved.cells.length} cells, expected exactly ${MAP_WIDTH * MAP_HEIGHT}`);
    }
    if (saved.cellFlags.length !== CELL_FLAG_BYTES) {
      return fail("flags-size", `Cell flags are ${saved.cellFlags.length} bytes, expected exactly ${CELL_FLAG_BYTES}`);
    }
    if (saved.objects.length !== OBJECT_SLOTS * OBJECT_SIZE) {
      return fail("object-size", `Object records are ${saved.objects.length} bytes, expected exactly ${OBJECT_SLOTS * OBJECT_SIZE}`);
    }
    const count = state.word(OBJECT_COUNT_ADDRESS);
    if (count > OBJECT_SLOTS) {
      return fail("object-count", `Saved object count (word at $${OBJECT_COUNT_ADDRESS.toString(16).toUpperCase()}) is ${count}, maximum is ${OBJECT_SLOTS}`);
    }
    return { ok: true, value: new World(state, saved.cells, FROM_SNAPSHOT, saved) };
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
          // Solar-type tiles: the map cell is normalised and the record gets a beam-phase approximation.
          view.setUint16(at, tile);
          this.cells[y * MAP_WIDTH + x] = (this.cell(x, y) & CELL_FLAGS) | (this.cell(x, y) & 0x300) | tile;
          this.objects[at + 2] = 0;
          this.objects[at + 7] = 0;
          const phase = this.startupSolarPhase ? this.startupSolarPhase() : this.nextSolarPhase();
          this.objects[at + 6] = phase ? 0xff : 1;
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
