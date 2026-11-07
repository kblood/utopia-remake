// Parser for an already expanded, raw (offset-addressable) Disk.4 save-disk image.
// Layout evidence: notes/formats/game-proper.md section 6 and notes/formats/xpk-mash.md.
//
// Scope: parse and validate the "UTOPSAVE" header at sector $3C0 and hand out copies of the two
// save areas (A and B) of a populated slot. parseDisk4() is raw-only: it rejects an XPK container
// (the compressed seed the WHDLoad set ships). parseDisk4Input() is the composition entry point: it
// detects XPKF, expands it with src/data/xpk-mash.ts, then runs the same raw parser, reporting
// decode failures and Disk.4 failures as distinct stages. Nothing here restores a game from the
// areas, writes or exports a disk, or is wired into the loader or UI. It is independent of the
// remake's localStorage slots (src/game/save.ts); DISK4_SLOT_COUNT is the original disk's slot
// count, not that save flow's.

import { isXpkContainer, unpackXpkMash, type XpkMashError, type XpkMashInfo } from "./xpk-mash.js";

export const DISK4_SECTOR_SIZE = 512;
/** Header sector on the save disk ($3C0); the header spans DISK4_HEADER_SECTORS sectors. */
export const DISK4_HEADER_SECTOR = 0x3c0;
export const DISK4_HEADER_SECTORS = 2;
export const DISK4_HEADER_OFFSET = DISK4_HEADER_SECTOR * DISK4_SECTOR_SIZE;
export const DISK4_SIGNATURE = "UTOPSAVE";
/** Header offset of the first 64-byte record. */
export const DISK4_RECORDS_OFFSET = 10;
export const DISK4_RECORD_SIZE = 0x40;
/** Slots on the original save disk (not the remake's localStorage slot count). */
export const DISK4_SLOT_COUNT = 10;
/** Bytes of the header that the parser reads (signature, id word, ten records). */
export const DISK4_HEADER_BYTES = DISK4_RECORDS_OFFSET + DISK4_SLOT_COUNT * DISK4_RECORD_SIZE;
/** Area A (object list and map): exactly 73 sectors. Area B (scenario + variable block): exactly 11. */
export const DISK4_AREA_A_SECTORS = 73;
export const DISK4_AREA_B_SECTORS = 11;

const NAME_LENGTH = 16;
const EMPTY_NAME = "EMPTY";

export type Disk4ErrorCode =
  | "not-bytes"
  | "compressed-xpk"
  | "too-short"
  | "bad-signature"
  | "blank-name"
  | "extent-order"
  | "extent-size"
  | "extent-bounds"
  | "extent-overlap"
  | "slot-index"
  | "slot-empty";

export interface Disk4Error {
  readonly code: Disk4ErrorCode;
  readonly message: string;
}

export type Disk4Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Disk4Error };

/** Inclusive sector extent as stored in a record (first and last sector, big-endian words). */
export interface Disk4Extent {
  readonly firstSector: number;
  readonly lastSector: number;
  readonly sectorCount: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export type Disk4Slot =
  | { readonly index: number; readonly state: "empty"; readonly name: string }
  | {
      readonly index: number;
      readonly state: "populated";
      readonly name: string;
      readonly areaA: Disk4Extent;
      readonly areaB: Disk4Extent;
    }
  | { readonly index: number; readonly state: "invalid"; readonly name: string; readonly error: Disk4Error };

export interface Disk4SlotAreas {
  readonly name: string;
  /** Copy of area A (73 sectors, 37,376 bytes). */
  readonly areaA: Uint8Array;
  /** Copy of area B (11 sectors, 5,632 bytes). */
  readonly areaB: Uint8Array;
}

export interface Disk4Image {
  /** Word at header+8. Observed 0 on the supplied disk; the original loader does not read it. */
  readonly idWord: number;
  readonly slots: readonly Disk4Slot[];
  /** The bytes given to parseDisk4 (not copied; the caller must not modify them while in use). */
  readonly bytes: Uint8Array;
}

const fail = <T>(code: Disk4ErrorCode, message: string): Disk4Result<T> => ({ ok: false, error: { code, message } });
const err = (code: Disk4ErrorCode, message: string): Disk4Error => ({ code, message });

const word = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];

/** Record name: bytes up to the first NUL (Latin-1), trailing spaces removed. */
function readName(b: Uint8Array, o: number): string {
  let s = "";
  for (let i = 0; i < NAME_LENGTH && b[o + i] !== 0; i++) s += String.fromCharCode(b[o + i]);
  return s.replace(/ +$/, "");
}

function makeExtent(first: number, last: number): Disk4Extent {
  const sectorCount = last - first + 1;
  return {
    firstSector: first,
    lastSector: last,
    sectorCount,
    byteOffset: first * DISK4_SECTOR_SIZE,
    byteLength: sectorCount * DISK4_SECTOR_SIZE,
  };
}

const overlaps = (a: Disk4Extent, b: Disk4Extent): boolean => a.firstSector <= b.lastSector && b.firstSector <= a.lastSector;

const headerExtent: Disk4Extent = makeExtent(DISK4_HEADER_SECTOR, DISK4_HEADER_SECTOR + DISK4_HEADER_SECTORS - 1);

/** Validates one area's pair: order, exact size, inside the image, clear of the header. */
function checkArea(label: "A" | "B", first: number, last: number, expected: number, imageSectors: number): Disk4Result<Disk4Extent> {
  if (last < first) return fail("extent-order", `Area ${label}: last sector ${last} is before first sector ${first}`);
  const extent = makeExtent(first, last);
  if (extent.sectorCount !== expected) {
    return fail("extent-size", `Area ${label}: ${extent.sectorCount} sectors (${first}-${last}), expected exactly ${expected}`);
  }
  if (last >= imageSectors) {
    return fail("extent-bounds", `Area ${label}: sectors ${first}-${last} extend past the image (${imageSectors} sectors)`);
  }
  if (overlaps(extent, headerExtent)) {
    return fail("extent-overlap", `Area ${label}: sectors ${first}-${last} overlap the header (sectors ${headerExtent.firstSector}-${headerExtent.lastSector})`);
  }
  return { ok: true, value: extent };
}

/**
 * Parses the header of a raw Disk.4 image. Empty slots ("EMPTY") are classified from their name
 * alone and their extents are never read or validated. Populated slots are validated per slot, so
 * one corrupt record becomes an "invalid" slot instead of failing the whole disk.
 */
export function parseDisk4(bytes: Uint8Array): Disk4Result<Disk4Image> {
  if (!(bytes instanceof Uint8Array)) return fail("not-bytes", "Disk.4 image must be a Uint8Array");
  if (isXpkContainer(bytes)) {
    return fail("compressed-xpk", "Input is an XPK-compressed container (XPKF); parseDisk4 needs the expanded raw image (use parseDisk4Input to unpack XPK/MASH first)");
  }
  if (bytes.length < DISK4_HEADER_OFFSET + DISK4_HEADER_BYTES) {
    return fail(
      "too-short",
      `Image is ${bytes.length} bytes; the header at sector $${DISK4_HEADER_SECTOR.toString(16).toUpperCase()} needs at least ${DISK4_HEADER_OFFSET + DISK4_HEADER_BYTES} bytes`,
    );
  }
  for (let i = 0; i < DISK4_SIGNATURE.length; i++) {
    if (bytes[DISK4_HEADER_OFFSET + i] !== DISK4_SIGNATURE.charCodeAt(i)) {
      return fail("bad-signature", `No ${DISK4_SIGNATURE} signature at byte offset ${DISK4_HEADER_OFFSET}`);
    }
  }

  const imageSectors = Math.floor(bytes.length / DISK4_SECTOR_SIZE);
  const slots: Disk4Slot[] = [];
  const candidates: { index: number; a: Disk4Extent; b: Disk4Extent }[] = [];
  for (let index = 0; index < DISK4_SLOT_COUNT; index++) {
    const rec = DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + index * DISK4_RECORD_SIZE;
    const name = readName(bytes, rec);
    if (name === EMPTY_NAME) {
      slots.push({ index, state: "empty", name });
      continue;
    }
    const bad = (e: Disk4Error): Disk4Slot => ({ index, state: "invalid", name, error: err(e.code, `Slot ${index}: ${e.message}`) });
    if (name === "") {
      slots.push(bad(err("blank-name", "record name is blank (neither a save name nor EMPTY)")));
      continue;
    }
    const a = checkArea("A", word(bytes, rec + 0x10), word(bytes, rec + 0x12), DISK4_AREA_A_SECTORS, imageSectors);
    if (!a.ok) {
      slots.push(bad(a.error));
      continue;
    }
    const b = checkArea("B", word(bytes, rec + 0x14), word(bytes, rec + 0x16), DISK4_AREA_B_SECTORS, imageSectors);
    if (!b.ok) {
      slots.push(bad(b.error));
      continue;
    }
    if (overlaps(a.value, b.value)) {
      slots.push(bad(err("extent-overlap", `areas A (${a.value.firstSector}-${a.value.lastSector}) and B (${b.value.firstSector}-${b.value.lastSector}) overlap`)));
      continue;
    }
    candidates.push({ index, a: a.value, b: b.value });
    slots.push({ index, state: "populated", name, areaA: a.value, areaB: b.value });
  }

  // Populated slots must not share sectors with each other; both slots of a clash are invalidated.
  for (const c of candidates) {
    for (const o of candidates) {
      if (o === c) continue;
      const hit = [o.a, o.b].some((oe) => overlaps(c.a, oe) || overlaps(c.b, oe));
      if (hit) {
        const s = slots[c.index];
        slots[c.index] = {
          index: c.index,
          state: "invalid",
          name: s.name,
          error: err("extent-overlap", `Slot ${c.index}: sectors overlap those of slot ${o.index}`),
        };
        break;
      }
    }
  }

  return { ok: true, value: { idWord: word(bytes, DISK4_HEADER_OFFSET + 8), slots, bytes } };
}

/** Returns copies of areas A and B of a populated slot, or a descriptive error. */
export function readDisk4Slot(disk: Disk4Image, index: number): Disk4Result<Disk4SlotAreas> {
  if (!Number.isInteger(index) || index < 0 || index >= disk.slots.length) {
    return fail("slot-index", `Slot index ${index} is outside 0-${disk.slots.length - 1}`);
  }
  const slot = disk.slots[index];
  if (slot.state === "empty") return fail("slot-empty", `Slot ${index} is empty`);
  if (slot.state === "invalid") return { ok: false, error: slot.error };
  const { areaA, areaB } = slot;
  return {
    ok: true,
    value: {
      name: slot.name,
      areaA: disk.bytes.slice(areaA.byteOffset, areaA.byteOffset + areaA.byteLength),
      areaB: disk.bytes.slice(areaB.byteOffset, areaB.byteOffset + areaB.byteLength),
    },
  };
}

/** Where a Disk.4 image came from: raw bytes as given, or expanded from an XPKF/MASH container. */
export type Disk4Source = "raw" | "xpk-mash";

/** Failure of parseDisk4Input, tagged with the stage that failed. */
export type Disk4InputError =
  | { readonly stage: "decode"; readonly error: XpkMashError }
  | { readonly stage: "disk4"; readonly error: Disk4Error };

export interface Disk4Input {
  readonly source: Disk4Source;
  /** For "xpk-mash", image.bytes is the freshly unpacked buffer; for "raw" it is the caller's input. */
  readonly image: Disk4Image;
  /** Container details when the input was XPK-packed (without the bytes; those are image.bytes). */
  readonly container?: XpkMashInfo;
}

export type Disk4InputResult = { readonly ok: true; readonly value: Disk4Input } | { readonly ok: false; readonly error: Disk4InputError };

/**
 * Parses a Disk.4 image from either raw bytes or the supplied XPKF/MASH seed. Input starting with
 * `XPKF` is unpacked (bounded, fully validated; see xpk-mash.ts) and the result is handed to
 * parseDisk4; anything else goes to parseDisk4 unchanged. Unpacked data that itself starts with
 * `XPKF` is not unpacked again and fails in the "disk4" stage. Read-only: nothing is restored,
 * written or exported, and the result is not connected to the game or its save slots.
 */
export function parseDisk4Input(bytes: Uint8Array): Disk4InputResult {
  if (!isXpkContainer(bytes)) {
    const r = parseDisk4(bytes);
    return r.ok ? { ok: true, value: { source: "raw", image: r.value } } : { ok: false, error: { stage: "disk4", error: r.error } };
  }
  const unpacked = unpackXpkMash(bytes);
  if (!unpacked.ok) return { ok: false, error: { stage: "decode", error: unpacked.error } };
  const { bytes: raw, ...container } = unpacked.value;
  const r = parseDisk4(raw);
  if (!r.ok) return { ok: false, error: { stage: "disk4", error: r.error } };
  return { ok: true, value: { source: "xpk-mash", image: r.value, container } };
}
