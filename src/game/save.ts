// The remake's own saved games in localStorage (slots 0-7). The original writes two areas to Disk.4
// (notes/formats/game-proper.md); a browser cannot write the player's disk image, so the remake keeps ITS OWN record
// here. It is not the Disk.4 record and not compatible with it (no import, no export). What a save holds and what it
// leaves out is listed in notes/formats/remake-save.md; the schema and the validation live in save-session.ts.
//
// Stored text = JSON { format, version, ...fields } with the four binary parts as base64 (the map words as explicit
// little-endian bytes, independent of the host). Reading never throws and never returns a half-valid object: every
// failure is a typed `SlotError`, and a save that reads back is a complete, validated `SessionSave`.
//
// Compatibility of old slots (version 2 stored the absolute calendar year; versions 3+ store elapsed years;
// version-less saves contain only state, map words, object bytes,
// sysFlags and scroll):
//   - an old save made while NO unit, ship or flying object stood on the map is migrated (units, enemies, ships and
//     flags start empty, which is what that moment was) and marked `legacy`;
//   - an old save with a ground/air mark in the map words or any own ship cannot be completed (the units behind the marks
//     were never stored) and is rejected as "legacy-incomplete" instead of loading an inconsistent world;
//   - version 2 and version-less saves convert their absolute `$142A6` year to elapsed years;
//   - versions 2 and 3 have no solar-phase RNG state; versions 2..4 have no hardware-approximation state;
//   - versions 2..5 never stored the effect list: a session with an object layer migrates to an EMPTY pool (a lossy
//     compatibility assumption, reported as `effectsAssumedEmpty`; continuation is not claimed exact), one without to null;
//   - versions 6 and 7 stored the effects as a DENSE list (`effects`, at most 30 records); version 8 stores the 30 fixed slots
//     (`effectSlots`, null = free) plus the durable flag `effectSlotsAssumed`. A non-empty dense list keeps ALL records, in
//     slots 0..n-1 in list order, but the original slot numbers cannot be recovered: that is reported as `effectSlotsAssumed`
//     (slot label `FX SLOT UNK`), is written into the next save (version 8 persists the flag) and is cleared by the live pool
//     only when it drains. Continuation is not claimed exact. An empty dense list converts cleanly (30 free slots, no warning);
//   - versions 2..6 never stored the raw +$16 flag pointer of the enemy slots (version 7 does, free slots included): a session
//     with an enemy system derives occupied pointers from saved reservations where possible (an outbound aircraft with
//     reserve -1/-1 reconstructs its off-map next-cell pointer from x/y/direction; other unresolvable tails use 0), and
//     assumes every free slot is 0. This is reported as `enemyPointersAssumed` because stale freed-slot values are lost;
//   - versions 2..8 derive the old regular loop phase from `vbls` and have no pending modal-return pass; version 9 stores both.
//   - versions 2..9 have no blast mark (`$156A9` bit 5, ship-control.md 5e); they migrate with it CLEAR. That is exact only
//     when no free-slot missile hit was pending at the save, which those versions could not record (a lossy assumption);
//   - versions 2..10 store no descriptor exchange parity (`$11024`, sim.ts `tileExchange`, version 11). Every save is taken inside
//     the disk menu (`save` is reached only from the disk-menu loop), and the menu entry `$7ECA` already runs `$11024` while bit 6
//     is set, so the traced calls leave parity 0 there (the table is exchanged on the map exactly while bit 6 is set). They migrate
//     with parity 0 and `tileExchangeAssumed` set (the slot label names TBL with any other assumption, see slotWarning). That is a static, unverified inference. The bit-derived
//     value (1 during an eclipse) would be wrong: the exit `$802C` would flip it back to 0 on the map;
//   - versions 2..11 store no save name (version 12 adds `name`, save-name.ts); they migrate with `name` null, so their slot label
//     stays the date as before;
//   - a version other than 2..12 is rejected as "unsupported-version".

import { MAP_HEIGHT, MAP_WIDTH } from "../data/scenario.js";
import { CELL_FLAG_BYTES, cellFlagPointer } from "./cell-flags.js";
import { DEFAULT_VBL_PER_PASS } from "./main-loop.js";
import { DIR_STEP } from "./units.js";
import { MAX_EFFECTS } from "./effect-pool.js";
import { SAVED_NAME_LENGTH } from "./save-name.js";
import { SESSION_VERSION, validateEffectRecord, validateSession, type SessionSave } from "./save-session.js";

import { START_YEAR, STATE_BASE, STATE_BYTES } from "./state.js";
import { OBJECT_COUNT_ADDRESS, OBJECT_SIZE, OBJECT_SLOTS } from "./world.js";

export const SAVE_SLOTS = 8;
const PREFIX = "utopia-remake-save-";
const FORMAT = "utopia-remake-session";

export type SlotErrorCode =
  /** The slot holds nothing. */
  | "empty"
  /** No localStorage in this environment. */
  | "no-storage"
  /** Not JSON, not base64 or not the expected shape of any known version. */
  | "corrupt"
  /** A `version` this build does not know. */
  | "unsupported-version"
  /** Well-formed, but a field fails validation (see `message`). */
  | "invalid"
  /** An old (pre-version-2) save that cannot be completed. */
  | "legacy-incomplete"
  /** Slot number outside 0..SAVE_SLOTS-1. */
  | "bad-slot"
  /** The storage refused the write (quota, private mode). */
  | "write-failed";

export interface SlotError {
  readonly code: SlotErrorCode;
  readonly message: string;
}

export type ReadResult =
  | {
      readonly ok: true;
      readonly save: SessionSave;
      readonly legacy: boolean;
      /**
       * True for a version 2..5 save that had an object layer: those versions never stored the effect list, so the decoded
       * save carries an EMPTY pool as a lossy compatibility assumption. The original pool may have held explosions (which
       * only affect the occupancy outcome of a combat explosion when the pool is full), so continuation is not exact.
       */
      readonly effectsAssumedEmpty: boolean;
      /**
       * True when the effect records' slot numbers are an assumption: a non-empty dense effect list of a version 6 or 7 save was
       * placed in slots 0..n-1 (all records kept, original slot identity unrecoverable), or a version 8 save carries the flag
       * on from such a migration. Continuation is not exact until the pool drains.
       */
      readonly effectSlotsAssumed: boolean;
      /**
       * True for a version 2..6 save that had an enemy system: those versions never stored the raw +$16 pointers, so the decoded
       * save derives occupied slots' pointers from their reservation cells and assumes 0 for free slots (the stale pointers
       * of freed slots are unknown). Continuation is not exact. Always false for version 7 and for saves without enemies.
       */
      readonly enemyPointersAssumed: boolean;
      /** True when the descriptor exchange parity was assumed at a migration (versions 2..10, version-less: the disk-menu value 0). */
      readonly tableAssumed: boolean;
    }
  | { readonly ok: false; readonly error: SlotError };
export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly error: SlotError };

const err = (code: SlotErrorCode, message: string): { ok: false; error: SlotError } => ({ ok: false, error: { code, message } });

// ---- base64 -------------------------------------------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Decodes standard base64; null for anything else (never throws). */
function fromBase64(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Map words as explicit little-endian bytes. */
function cellsToBytes(cells: Uint16Array): Uint8Array {
  const out = new Uint8Array(cells.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < cells.length; i++) view.setUint16(i * 2, cells[i], true);
  return out;
}

function cellsFromBytes(bytes: Uint8Array): Uint16Array | null {
  if (bytes.length !== MAP_WIDTH * MAP_HEIGHT * 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint16Array(MAP_WIDTH * MAP_HEIGHT);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// ---- text <-> SessionSave -------------------------------------------------------------------------------------------------

/** The current versioned text of a save. The caller validates the save first (`writeSlot` does). */
export function encodeSave(save: SessionSave): string {
  return JSON.stringify({
    format: FORMAT,
    version: SESSION_VERSION,
    ...save,
    state: toBase64(save.state),
    cells: toBase64(cellsToBytes(save.cells)),
    cellFlags: toBase64(save.cellFlags),
    objects: toBase64(save.objects),
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Older remake saves stored the displayed calendar year at `$142A6`; convert it to elapsed years in place. */
function convertAbsoluteYear(state: Uint8Array, source: string): SlotError | null {
  if (state.length !== STATE_BYTES) return { code: "corrupt", message: `${source}: state image has the wrong length` };
  const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
  const offset = 0x142a6 - STATE_BASE;
  const year = view.getUint32(offset);
  if (year < START_YEAR) return { code: "invalid", message: `${source}: $142A6 year ${year} is below the old save baseline ${START_YEAR}` };
  view.setUint32(offset, year - START_YEAR);
  return null;
}

/** Legacy (version-less) slot -> a session with empty units, or a typed refusal. */
function migrateLegacy(j: Record<string, unknown>): ReadResult {
  const state = fromBase64(j.state);
  const cellBytes = fromBase64(j.cells);
  const objects = fromBase64(j.objects);
  if (!state || !cellBytes || !objects) return err("corrupt", "Old save: a binary part is not valid base64");
  const cells = cellsFromBytes(cellBytes);
  if (!cells || state.length !== STATE_BYTES || objects.length !== OBJECT_SLOTS * OBJECT_SIZE) return err("corrupt", "Old save: a binary part has the wrong length");
  const yearError = convertAbsoluteYear(state, "Old save");
  if (yearError) return { ok: false, error: yearError };
  const ships = (state[0x1429e - STATE_BASE] << 8) | state[0x1429e - STATE_BASE + 1];
  let marked = false;
  for (let i = 0; i < cells.length && !marked; i++) marked = (cells[i] & 0x6000) !== 0; // bit 14 ground-layer mark, bit 13 air mark
  if (ships !== 0 || marked) {
    return err("legacy-incomplete", "Old save made while own units, ships or flying objects were on the map: they were never stored, so it cannot be loaded without an inconsistent map");
  }
  const count = (state[OBJECT_COUNT_ADDRESS - STATE_BASE] << 8) | state[OBJECT_COUNT_ADDRESS - STATE_BASE + 1];
  const save: SessionSave = {
    scenario: j.scenario as number,
    name: null,
    scroll: { x: j.scrollX as number, y: j.scrollY as number },
    state,
    cells,
    cellFlags: new Uint8Array(CELL_FLAG_BYTES),
    objects,
    world: { objectCount: count, solarPhaseRng: null },
    sim: {
      sysFlags: j.sysFlags as number,
      paused: false,
      dayQueued: false,
      blastMark: false,
      tileExchange: false, // no parity stored: the disk-menu value (every save is taken inside the menu), flagged below
      tileExchangeAssumed: true,
      rng: null,
      hardware: null,
      fuelWarned: false,
      lights: [0, 0, 0, 0],
      aliens: { alien: null, meteor: null, groupIndex: 0, cursor: 0x80 },
    },
    loop: { vblPerPass: DEFAULT_VBL_PER_PASS, vbls: 0, passes: 0, phase: 0, immediatePass: false },
    passClock: null,
    markers: null,
    tanks: null,
    enemies: null,
    ships: new Array(40).fill(null),
    effectSlots: null, // like tanks and markers: no object layer in the migrated session
    effectSlotsAssumed: false,
  };
  const bad = validateSession(save);
  if (bad) return err("invalid", `Old save: ${bad.message}`);
  return { ok: true, save, legacy: true, effectsAssumedEmpty: false, effectSlotsAssumed: false, enemyPointersAssumed: false, tableAssumed: true };
}

/**
 * Versions 2..6 stored no raw +$16 pointers. Returns `enemies` completed with them (occupied slot = saved reservation; an
 * outbound air unit with reserve -1/-1 reconstructs its off-map next-cell address from x/y/direction; free or otherwise
 * unresolvable tails = 0), or a typed error when an occupied reservation is malformed. A section that is not the expected
 * 60 / 30 slot arrays is returned unchanged for `validateSession` to report. Pure: the parsed JSON is not mutated.
 */
function migrateEnemyPointers(enemies: unknown, version: number): { readonly enemies: unknown } | SlotError {
  if (!isObject(enemies) || !Array.isArray(enemies.ground) || enemies.ground.length !== 60 || !Array.isArray(enemies.air) || enemies.air.length !== 30) return { enemies };
  const derive = (list: readonly unknown[], name: string, air: boolean): number[] | SlotError => {
    const out: number[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isObject(e)) { out.push(0); continue; }
      const { reserveX: x, reserveY: y } = e;
      if (typeof x === "number" && typeof y === "number" && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT) {
        out.push(cellFlagPointer(x, y));
        continue;
      }
      // In the old runtime an aircraft stores the pointer of its NEXT cell when a step begins. If that cell is
      // outside the map, reserveX/Y become -1/-1 while the aircraft remains alive until the next pass. Reconstruct
      // that raw pointer from its saved cell and direction; the migration is still labelled assumed because the old
      // save did not store the long itself. Ground records with no playable reservation have no recoverable target.
      if (x === -1 && y === -1) {
        const px = e.x, py = e.y, dir = e.dir;
        if (air && typeof px === "number" && typeof py === "number" && typeof dir === "number" &&
          Number.isInteger(px) && Number.isInteger(py) && px >= 0 && py >= 0 && px < MAP_WIDTH && py < MAP_HEIGHT &&
          Number.isInteger(dir) && dir >= 0 && dir < DIR_STEP.length) {
          const [dx, dy] = DIR_STEP[dir];
          out.push(cellFlagPointer(px + dx, py + dy));
        } else {
          out.push(0);
        }
        continue;
      }
      {
        return { code: "invalid", message: `enemies.${name}[${i}].reserveX: a version-${version} save must hold a map cell here` };
      }
    }
    return out;
  };
  const groundPointers = derive(enemies.ground, "ground", false);
  if (!Array.isArray(groundPointers)) return groundPointers;
  const airPointers = derive(enemies.air, "air", true);
  if (!Array.isArray(airPointers)) return airPointers;
  return { enemies: { ...enemies, groundPointers, airPointers } };
}

/**
 * Versions 6 and 7 stored the effects as a dense list (`effects`: null without an object layer, else at most 30 records in list
 * order). Converts it to the 30 fixed slots (records in slots 0..n-1 in list order, the rest free) and says whether the slot
 * numbers are therefore an assumption (any record present). Applies the version-8 record rules to every record first; the
 * error path keeps the old `effects` / `effects[i]...` names. Pure.
 */
function migrateDenseEffects(effects: unknown, hasObjectLayer: boolean): { readonly slots: unknown[] | null; readonly assumed: boolean } | SlotError {
  if (effects === null || effects === undefined) {
    if (hasObjectLayer) return { code: "invalid", message: "effects: a session with an object layer has an effect list (possibly empty)" };
    return { slots: null, assumed: false };
  }
  if (!Array.isArray(effects) || effects.length > MAX_EFFECTS) return { code: "invalid", message: `effects: must be null or an array of at most ${MAX_EFFECTS} effects` };
  if (!hasObjectLayer) return { code: "invalid", message: "effects: effects belong to the object layer, which a session without tanks does not have" };
  for (let i = 0; i < effects.length; i++) {
    const bad = validateEffectRecord(effects[i], `effects[${i}]`);
    if (bad) return { code: "invalid", message: bad.message };
  }
  const slots: unknown[] = new Array<unknown>(MAX_EFFECTS).fill(null);
  effects.forEach((e, i) => { slots[i] = e; });
  return { slots, assumed: effects.length > 0 };
}

/** Parses and fully validates stored text. Never throws; returns the first problem as a typed error. */
export function decodeSave(text: string | null): ReadResult {
  if (!text) return err("empty", "Empty slot");
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return err("corrupt", "The slot does not hold JSON");
  }
  if (!isObject(j)) return err("corrupt", "The slot does not hold a save object");
  if (!("version" in j)) {
    if (typeof j.scenario === "number" && typeof j.state === "string" && typeof j.cells === "string" && typeof j.objects === "string" && typeof j.sysFlags === "number") return migrateLegacy(j);
    return err("corrupt", `The slot holds neither a version-2 to version-${SESSION_VERSION} save nor an old save`);
  }
  if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, SESSION_VERSION].includes(j.version as number)) return err("unsupported-version", `Save version ${String(j.version)} is not supported (this build reads versions 2 through ${SESSION_VERSION})`);
  const version = j.version as number;
  if (j.format !== FORMAT) return err("corrupt", `Unknown save format ${String(j.format)}`);
  const state = fromBase64(j.state);
  const cellBytes = fromBase64(j.cells);
  const cellFlags = fromBase64(j.cellFlags);
  const objects = fromBase64(j.objects);
  if (!state || !cellBytes || !cellFlags || !objects) return err("corrupt", "A binary part is not valid base64");
  if (version === 2) {
    const yearError = convertAbsoluteYear(state, "Version-2 save");
    if (yearError) return { ok: false, error: yearError };
  }
  const cells = cellsFromBytes(cellBytes);
  if (!cells) return err("invalid", `cells: must be exactly ${MAP_WIDTH * MAP_HEIGHT * 2} bytes`);
  const { format: _format, version: _version, effects: legacyEffects, ...rest } = j;
  void _format;
  void _version;
  const world = isObject(rest.world) ? { ...rest.world, solarPhaseRng: version >= 4 ? rest.world.solarPhaseRng : null } : rest.world;
  // Version 10 stores the blast mark (`$156A9` bit 5); older saves carry none and start with it clear (see the header).
  // Version 11 stores the descriptor exchange parity; older saves take the disk-menu value 0 and are marked assumed (see the header).
  const sim = isObject(rest.sim)
    ? {
        ...rest.sim,
        hardware: version >= 5 && "hardware" in rest.sim ? rest.sim.hardware : null,
        blastMark: version >= 10 ? rest.sim.blastMark : false,
        tileExchange: version >= 11 ? rest.sim.tileExchange : false,
        tileExchangeAssumed: version >= 11 ? rest.sim.tileExchangeAssumed : true,
      }
    : rest.sim;
  // Version 9 records scheduler state explicitly because a build-menu return can queue a pass before the normal phase.
  // Earlier saves used the regular modulo cadence; derive that phase and clear the new one-shot flag.
  const loop = isObject(rest.loop) && version < 9 && Number.isSafeInteger(rest.loop.vblPerPass) && Number.isSafeInteger(rest.loop.vbls)
    ? { ...rest.loop, phase: (rest.loop.vbls as number) % (rest.loop.vblPerPass as number), immediatePass: false }
    : rest.loop;
  // Versions 2..5 never stored effects: a session with an object layer (tanks present) gets an empty pool, one without
  // none (null), exactly like the other object-layer parts. Versions 6 and 7 carry a dense `effects` list that converts to the
  // fixed slots with an assumed slot identity (see migrateDenseEffects); version 8 carries `effectSlots` and the durable
  // `effectSlotsAssumed` itself (validateSession checks them). A stray `effects` key in version 8 is not part of the schema and is dropped.
  let effectSlots: unknown = rest.effectSlots;
  let effectSlotsAssumed: unknown = rest.effectSlotsAssumed;
  if (version < 8) {
    if (version >= 6) {
      const dense = migrateDenseEffects(legacyEffects, rest.tanks !== null && rest.tanks !== undefined);
      if ("code" in dense) return { ok: false, error: dense };
      effectSlots = dense.slots;
      effectSlotsAssumed = dense.assumed;
    } else {
      effectSlots = rest.tanks === null ? null : new Array<unknown>(MAX_EFFECTS).fill(null);
      effectSlotsAssumed = false;
    }
  }
  // Versions 2..6 never stored raw per-slot +$16 pointers: derive what can be reconstructed and flag the lossy migration.
  // Version 7 must carry its own arrays (validateSession checks counts, unsigned-long values and agreement with the records).
  let enemies = rest.enemies;
  if (version < 7 && rest.enemies !== null && rest.enemies !== undefined) {
    const migrated = migrateEnemyPointers(rest.enemies, version);
    if ("code" in migrated) return { ok: false, error: migrated };
    enemies = migrated.enemies;
  }
  // Version 12 stores the save name (save-name.ts); versions 2..11 have none and migrate with `name` null (validateSession checks it).
  const name = version >= 12 ? rest.name : null;
  const save = { ...rest, name, world, sim, loop, state, cells, cellFlags, objects, effectSlots, effectSlotsAssumed, enemies };
  const bad = validateSession(save);
  if (bad) return err("invalid", bad.message);
  return {
    ok: true, save: save as unknown as SessionSave, legacy: false, effectsAssumedEmpty: version < 6 && effectSlots !== null,
    effectSlotsAssumed: (save as unknown as SessionSave).effectSlotsAssumed,
    enemyPointersAssumed: version < 7 && (save as unknown as SessionSave).enemies !== null,
    tableAssumed: (save as unknown as SessionSave).sim.tileExchangeAssumed,
  };
}

// ---- slots ------------------------------------------------------------------------------------------------------------------

function slotKey(slot: number): string | null {
  return Number.isInteger(slot) && slot >= 0 && slot < SAVE_SLOTS ? PREFIX + slot : null;
}

/** Writes a validated save into a slot. A save that fails validation, or a write the storage refuses, leaves the slot as it was. */
export function writeSlot(slot: number, save: SessionSave): WriteResult {
  const key = slotKey(slot);
  if (key === null) return err("bad-slot", `Slot ${slot} is outside 0..${SAVE_SLOTS - 1}`);
  const bad = validateSession(save);
  if (bad) return err("invalid", bad.message);
  const store = storage();
  if (!store) return err("no-storage", "No localStorage here");
  const body = encodeSave(save);
  const check = decodeSave(body);
  if (!check.ok) return check;
  try {
    store.setItem(key, body);
  } catch {
    return err("write-failed", "The browser refused to store the save (quota or private mode)");
  }
  return { ok: true };
}

export function readSlot(slot: number): ReadResult {
  const key = slotKey(slot);
  if (key === null) return err("bad-slot", `Slot ${slot} is outside 0..${SAVE_SLOTS - 1}`);
  const store = storage();
  if (!store) return err("no-storage", "No localStorage here");
  let text: string | null;
  try {
    text = store.getItem(key);
  } catch {
    return err("no-storage", "localStorage cannot be read");
  }
  return decodeSave(text);
}

export type SlotSummary =
  | { readonly slot: number; readonly status: "ok"; readonly scenario: number; readonly date: string; readonly name: string | null; readonly legacy: boolean; readonly effectsAssumedEmpty: boolean; readonly effectSlotsAssumed: boolean; readonly enemyPointersAssumed: boolean; readonly tableAssumed: boolean }
  | { readonly slot: number; readonly status: "unusable"; readonly error: SlotError }
  /** localStorage is missing or cannot be read: the slot's content is unknown, which is not the same as empty. */
  | { readonly slot: number; readonly status: "unavailable"; readonly error: SlotError };

/** Per slot: null = empty, a summary of the usable save, why the stored text cannot be used, or that the storage itself is unavailable. */
export function slotSummaries(): (SlotSummary | null)[] {
  return Array.from({ length: SAVE_SLOTS }, (_, slot): SlotSummary | null => {
    const read = readSlot(slot);
    if (!read.ok) return read.error.code === "empty" ? null : { slot, status: read.error.code === "no-storage" ? "unavailable" : "unusable", error: read.error };
    const state = read.save.state;
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const day = state[0x1459f - STATE_BASE];
    const month = state[0x145a0 - STATE_BASE] + 1;
    const year = START_YEAR + view.getUint32(0x142a6 - STATE_BASE);
    return {
      slot, status: "ok", scenario: read.save.scenario, date: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`, name: read.save.name,
      legacy: read.legacy, effectsAssumedEmpty: read.effectsAssumedEmpty, effectSlotsAssumed: read.effectSlotsAssumed, enemyPointersAssumed: read.enemyPointersAssumed,
      tableAssumed: read.tableAssumed,
    };
  });
}

/**
 * Columns left for the slot-label suffix: "SLOT n  dd/mm/yyyy" is 18 characters. This is a CHARACTER budget that keeps the label
 * short; the real limit is the pixel width of the list panel (`MENU_PANEL` in menu.ts, 240 px from x 40). The font advances are 5 px
 * per glyph (4 for space and "/"), so the longest label is about 143 px of ink; `test/slot-label-width.mjs` pins the measured widths.
 */
export const SLOT_SUFFIX_COLUMNS = 13;

/**
 * The warning a slot label appends (including its leading space; "" for none). The label "SLOT n  dd/mm/yyyy" + suffix must fit
 * the menu's 31 columns, so the suffix has at most `SLOT_SUFFIX_COLUMNS` (13) characters. Every applicable assumption is named:
 *   - FX: an assumed effect pool (`effectsAssumedEmpty`, versions 2..5) or assumed effect slot numbers (`effectSlotsAssumed`);
 *   - PTR: assumed enemy-slot pointers (`enemyPointersAssumed`, versions 2..6);
 *   - V1: a version-less save (`legacy`, which never carries FX or PTR: migrateLegacy);
 *   - TBL: the descriptor exchange parity was assumed at a migration (`tableAssumed`, versions 2..10).
 * A single assumption keeps its established wording (" FX UNKNOWN", " FX SLOT UNK", " PTR UNKNOWN", " V1", " TBL UNK"). Two or more
 * are joined with "/" (FX before PTR before V1 before TBL), and " UNK" is appended when it fits (" FX/PTR UNK", " PTR/TBL UNK",
 * " V1/TBL UNK"); otherwise it is dropped (" FX/PTR/TBL", 11 columns). Every reachable combination fits; the four-way combination
 * would not (14 columns) and is unreachable because a version-less save has neither FX nor PTR.
 */
export function slotWarning(summary: { readonly legacy: boolean; readonly effectsAssumedEmpty: boolean; readonly effectSlotsAssumed?: boolean; readonly enemyPointersAssumed: boolean; readonly tableAssumed?: boolean }): string {
  const fx = summary.effectsAssumedEmpty || summary.effectSlotsAssumed === true;
  const ptr = summary.enemyPointersAssumed;
  const v1 = summary.legacy;
  const tbl = summary.tableAssumed === true;
  const parts = [fx ? "FX" : "", ptr ? "PTR" : "", v1 ? "V1" : "", tbl ? "TBL" : ""].filter((p) => p !== "");
  if (parts.length === 0) return "";
  if (parts.length === 1) {
    if (fx) return summary.effectsAssumedEmpty ? " FX UNKNOWN" : " FX SLOT UNK";
    if (ptr) return " PTR UNKNOWN";
    if (v1) return " V1";
    return " TBL UNK";
  }
  const body = parts.join("/");
  const withUnknown = ` ${body} UNK`;
  return withUnknown.length <= SLOT_SUFFIX_COLUMNS ? withUnknown : ` ${body}`;
}

/** Columns of one slot-list label (the menu's width in characters, see SLOT_SUFFIX_COLUMNS). */
export const SLOT_LABEL_COLUMNS = 31;

/**
 * The text of one line of the save/load slot list: `SLOT n  dd/mm/yyyy` plus the warning, or EMPTY, STORAGE OFF, UNUSABLE. A save
 * with a name (version 12, save-name.ts) shows the name in place of the date, as the original's slot row shows its name; the name is
 * cut (never the warning) so that the label stays within `SLOT_LABEL_COLUMNS`.
 */
export function slotListLabel(slot: number, summary: SlotSummary | null): string {
  if (summary === null) return `SLOT ${slot + 1}  EMPTY`;
  if (summary.status === "ok") {
    const warning = slotWarning(summary);
    if (summary.name === null) return `SLOT ${slot + 1}  ${summary.date}${warning}`;
    const room = SLOT_LABEL_COLUMNS - `SLOT ${slot + 1}  `.length - warning.length;
    return `SLOT ${slot + 1}  ${summary.name.slice(0, Math.min(SAVED_NAME_LENGTH, room))}${warning}`;
  }
  return `SLOT ${slot + 1}  ${summary.status === "unavailable" ? "STORAGE OFF" : "UNUSABLE"}`;
}
