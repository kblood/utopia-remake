// Construction sites and their weekly countdown. Ports of $7000 (weekly pass over the object
// records), $703A (a finished site becomes the real building), $6A8C / $6FC4 (writing a
// building's tile ids and flag bytes into the map cells), $75D4 (resource flag count) and
// $7342 (redraw of a Command Centre after it went on- or offline). Placement ($6BF4) and
// demolition ($7372) stay in build.ts, which shares this class for the cell writes.
// Notes: notes/formats/building.md and notes/formats/sim-port.md.

import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK } from "../data/scenario.js";
import { T, type World } from "./world.js";

export const SITE_TILE = 0x32; // object record word of a site; word +2 holds the target tile
export const TILE_COMMAND_CENTRE = 0x4c;
export const TILE_COMMAND_OFF = 0x50; // map tiles of a Command Centre that is not the online one
export const TILE_WAREHOUSE = 0x44;
export const TILE_MINE = 0x60;
export const TILE_FUEL = 0x3e;

const VAR = {
  builders: 0x1432a, // colonists working on sites
  freeColonists: 0x13136,
  sites: 0x142c4, // number of site records
  capacity: 0x14432, // goods weight capacity, +80000 per warehouse
} as const;

const FLAG_KEEP = 0xe800; // $6A8C: andi.w #$E800 keeps bits 11, 13, 14, 15 of a cell word
const FLAG_RICHNESS = 0x8000; // bit 15, counted for a mine ($75D4 with bit 7 of the high byte)
const FLAG_FUEL = 0x0800; // bit 11, counted for a fuel well (bit 3 of the high byte)
const WAREHOUSE_CAPACITY = 80000;
const ONLINE = 0xff; // object record byte +3 of the one online Command Centre

export class Construction {
  // `flagTable` = the 256 bytes at $16408 (cell flag byte per tile id). `phase` stands in for the
  // beam position bit read by $2E00 that gives a new solar-type building its phase (1 or $FF).
  constructor(
    private readonly world: World,
    private readonly flagTable: Uint8Array,
    private readonly phase: () => boolean = () => Math.random() < 0.5,
  ) {}

  private get s() {
    return this.world.state;
  }

  private at(x: number, y: number): number {
    return y * MAP_WIDTH + x;
  }

  private inMap(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT;
  }

  // $6A8C: d0 = tile, d1 = footprint (1 = one cell, else 2 x 2). The flag byte comes from the
  // first tile id; a 2 x 2 building gets tile, +1 (x+1,y), +2 (x,y+1), +3 (x+1,y+1).
  writeTiles(tile: number, x: number, y: number, size: number): void {
    const flags = this.flagTable[tile] << 8;
    const cells = this.world.cells;
    const parts: [number, number][] = size === 1 ? [[0, 0]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
    parts.forEach(([dx, dy], n) => {
      if (!this.inMap(x + dx, y + dy)) return;
      const i = this.at(x + dx, y + dy);
      cells[i] = (cells[i] & FLAG_KEEP) | (tile + n) | flags;
    });
  }

  // $6FC4: the same tile id (the site tile) in every cell of the footprint.
  markSite(tile: number, x: number, y: number, size: number): void {
    const flags = this.flagTable[tile] << 8;
    const cells = this.world.cells;
    const parts: [number, number][] = size === 1 ? [[0, 0]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (const [dx, dy] of parts) {
      if (!this.inMap(x + dx, y + dy)) continue;
      const i = this.at(x + dx, y + dy);
      cells[i] = (cells[i] & FLAG_KEEP) | tile | flags;
    }
  }

  // $75D4: the number of the nine cells around (x, y), itself included, with `flag` set.
  countFlag(x: number, y: number, flag: number): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.inMap(x + dx, y + dy) && this.world.cells[this.at(x + dx, y + dy)] & flag) n++;
      }
    }
    return n;
  }

  // $7000: called once a week. The original walks `$142C4` site records (those whose first word
  // is $32), counts byte +6 down, and at zero runs $703A and lowers `$142C4`. Returns the
  // record slots that were completed in this pass (for callers that want to react, e.g. sound).
  weekly(): number[] {
    const s = this.s;
    const o = this.world.objects;
    const done: number[] = [];
    let remaining = s.word(VAR.sites);
    let slot = 0;
    while (remaining > 0) {
      // The original searches forward without a bound; stop at the end of the list.
      while (slot < o.length && ((o[slot] << 8) | o[slot + 1]) !== SITE_TILE) slot += 8;
      if (slot >= o.length) break;
      o[slot + 6] = (o[slot + 6] - 1) & 0xff;
      if (o[slot + 6] === 0) {
        this.complete(slot);
        s.setWord(VAR.sites, s.word(VAR.sites) - 1);
        done.push(slot);
      }
      slot += 8;
      remaining--;
    }
    return done;
  }

  // $703A: the site at `slot` becomes the building of its target tile.
  complete(slot: number): void {
    const s = this.s;
    const o = this.world.objects;
    const target = (o[slot + 2] << 8) | o[slot + 3]; // word +2: the tile the player picked
    let tile = target;
    const t = this.world.typeAddress(this.world.findType(target));
    const x = o[slot + 4];
    const y = o[slot + 5];
    o[slot] = target >> 8;
    o[slot + 1] = target & 0xff;
    o[slot + 2] = s.byte(t + 1); // footprint
    o[slot + 3] = s.byte(t + 3);
    const workers = s.byte(t + 4);
    s.setLong(VAR.builders, s.long(VAR.builders) - workers);
    s.setLong(VAR.freeColonists, s.long(VAR.freeColonists) + workers);
    s.setWord(t + T.active, s.word(t + T.active) + 1);
    let counted = true;
    if (tile === TILE_COMMAND_CENTRE) {
      if (s.word(t + T.active) === 1) {
        o[slot + 3] = ONLINE; // the first centre is the online one
      } else {
        tile = TILE_COMMAND_OFF; // later centres are drawn offline and are not counted
        counted = false;
      }
    }
    if (counted) s.setWord(t + T.total, s.word(t + T.total) + 1);
    if (tile === TILE_WAREHOUSE) s.setLong(VAR.capacity, s.long(VAR.capacity) + WAREHOUSE_CAPACITY);
    o[slot + 6] = 0;
    o[slot + 7] = 0;
    if (tile === TILE_MINE) o[slot + 6] = this.countFlag(x, y, FLAG_RICHNESS);
    if (tile === TILE_FUEL) o[slot + 6] = this.countFlag(x, y, FLAG_FUEL);
    if (tile === 0x0f || tile === 0x1f) {
      o[slot + 2] = 0;
      o[slot + 6] = this.phase() ? 1 : 0xff;
      o[slot + 7] = 0;
    }
    this.writeTiles(tile, x, y, s.byte(t + 1)); // $6A8C: `cmpi.b #1, d1` on the type's first word
  }

  // $7342: a Command Centre record is redrawn with the online tiles ($4C) when byte +3 is $FF,
  // else with the offline ones ($50). Called after the centre changed state.
  redrawCentre(slot: number): void {
    const o = this.world.objects;
    const tile = o[slot + 3] === ONLINE ? TILE_COMMAND_CENTRE : TILE_COMMAND_OFF;
    this.writeTiles(tile, o[slot + 4], o[slot + 5], 4);
  }

  // First object record with the given tile word, or -1 (the scan at $9B72 / $A1C8).
  findRecord(tile: number): number {
    const o = this.world.objects;
    for (let i = 0; i < o.length; i += 8) if (((o[i] << 8) | o[i + 1]) === tile) return i;
    return -1;
  }

  // The tile id currently in a cell.
  tileAt(x: number, y: number): number {
    return this.world.cells[this.at(x, y)] & TILE_ID_MASK;
  }
}
