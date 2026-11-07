// Scenario disk (Disk.2) records, tile images and map. Layouts: notes/formats/game-proper.md,
// sections 6 and 7. Everything is read from the user's own disk images at runtime.

import { SECTOR_SIZE, type SectorRange } from "./picture.js";
import { unpackLz } from "./unpack.js";

export const HEADER_SECTOR = 0x3c0;
export const HEADER_SECTORS = 2;
const HEADER_MAGIC = "UTOP";
const RECORD_START = 10;
const RECORD_SIZE = 0x40;
const RECORD_COUNT = 10;
const NAME_LENGTH = 16;

export const MAP_WIDTH = 100;
export const MAP_HEIGHT = 75;
const MAP_STRIDE = 102; // cells per row including two pad words
const MAP_HEADER_BYTES = 0xce;
export const TILE_ID_MASK = 0x3ff;

const TILE_SHEET = { first: 0x222, last: 0x25b } satisfies SectorRange; // Disk.1, packed
const DISK1_TILES = 95;
const SCENARIO_TILES = 66;
const TILE_TABLE_BYTES = 0x508; // descriptors in front of the Disk.1 image data
const TILE_BYTES_PER_ROW = 4;
export const TILE_WIDTH = 32;
export const TILE_PLANES = 6;

export interface ScenarioRecord {
  index: number;
  name: string;
  sprites: SectorRange; // raw sprite sheet for the scenario's object types 22-27
  tiles: SectorRange; // raw tile images
  descriptors: SectorRange; // 8-byte {rows-1, offset} entries for the tile images
  map: SectorRange;
  block: SectorRange; // scenario parameter block
  intel: SectorRange; // scenario-specific intelligence portraits/report assets
  text: SectorRange[]; // per language
}

export interface Tile {
  rows: number;
  planes: Uint8Array; // 6 planes one after the other, each rows * 4 bytes
}

export interface TileSet {
  tiles: Tile[]; // indexed like the original descriptor table (Disk.1 tiles first)
}

function word(data: Uint8Array, at: number): number {
  return (data[at] << 8) | data[at + 1];
}

function long(data: Uint8Array, at: number): number {
  return ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
}

function sectors(disk: Uint8Array, range: SectorRange): Uint8Array {
  return disk.subarray(range.first * SECTOR_SIZE, (range.last + 1) * SECTOR_SIZE);
}

export function readScenarioRecords(disk2: Uint8Array): ScenarioRecord[] {
  const header = disk2.subarray(HEADER_SECTOR * SECTOR_SIZE, (HEADER_SECTOR + HEADER_SECTORS) * SECTOR_SIZE);
  const magic = String.fromCharCode(...header.subarray(0, 8));
  if (!magic.startsWith(HEADER_MAGIC) || magic.slice(4) !== "SCEN") {
    throw new Error("readScenarioRecords: Disk.2 has no scenario header");
  }

  const records: ScenarioRecord[] = [];
  for (let index = 0; index < RECORD_COUNT; index++) {
    const at = RECORD_START + index * RECORD_SIZE;
    const pair = (n: number): SectorRange => ({ first: word(header, at + 0x10 + n * 4), last: word(header, at + 0x12 + n * 4) });
    records.push({
      index,
      name: String.fromCharCode(...header.subarray(at, at + NAME_LENGTH)).replace(/[\0 ]+$/, ""),
      sprites: pair(0),
      tiles: pair(1),
      descriptors: pair(2),
      map: pair(3),
      block: pair(4),
      intel: pair(5),
      text: [pair(6), pair(7), pair(8), pair(9)],
    });
  }
  return records;
}

/**
 * The disk id word at header+8 of the scenario disk ("UTOPSCEN" + word). VERIFIED statically that the original's disk
 * check `$8A5A` compares this word of the presented disk with `$8D00`, which the Disk.4 load fills from the saved word
 * `$1453E` (`$888A`); the supplied Disk.2 holds 2. Throws like `readScenarioRecords` when the disk has no scenario header.
 */
export function readScenarioDiskId(disk2: Uint8Array): number {
  const header = disk2.subarray(HEADER_SECTOR * SECTOR_SIZE, (HEADER_SECTOR + HEADER_SECTORS) * SECTOR_SIZE);
  const magic = String.fromCharCode(...header.subarray(0, 8));
  if (!magic.startsWith(HEADER_MAGIC) || magic.slice(4) !== "SCEN") {
    throw new Error("readScenarioDiskId: Disk.2 has no scenario header");
  }
  return word(header, 8);
}

function readTiles(descriptors: Uint8Array, count: number, images: Uint8Array, base: number): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < count; i++) {
    const rows = long(descriptors, i * 8) + 1;
    const offset = base + long(descriptors, i * 8 + 4);
    const size = rows * TILE_BYTES_PER_ROW * TILE_PLANES;
    if (offset + size > images.length) throw new Error(`readTiles: tile ${i} lies outside its image data`);
    tiles.push({ rows, planes: images.slice(offset, offset + size) });
  }
  return tiles;
}

// Tile images: 95 shared ones from Disk.1, then the 66 of the chosen scenario.
export function loadTileSet(disk1: Uint8Array, disk2: Uint8Array, record: ScenarioRecord): TileSet {
  const sheet = unpackLz(sectors(disk1, TILE_SHEET));
  const shared = readTiles(sheet, DISK1_TILES, sheet, TILE_TABLE_BYTES);
  const own = readTiles(sectors(disk2, record.descriptors), SCENARIO_TILES, sectors(disk2, record.tiles), 0);
  return { tiles: [...shared, ...own] };
}

// Map cells in row-major order; each cell word = tile id (low 10 bits) | flags (high 6 bits).
export function loadMap(disk2: Uint8Array, record: ScenarioRecord): Uint16Array {
  const raw = sectors(disk2, record.map);
  const cells = new Uint16Array(MAP_WIDTH * MAP_HEIGHT);
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      cells[y * MAP_WIDTH + x] = word(raw, MAP_HEADER_BYTES + (y * MAP_STRIDE + x) * 2);
    }
  }
  return cells;
}
