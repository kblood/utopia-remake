// Validated resource availability for the supported WHDLoad 1.2 (0757) profile.
//
// detect.ts only RECOGNISES a candidate from names and sizes. This module inspects the bytes that were
// actually read and decides whether the engine may start on them: signatures, the Disk.2 scenario header
// and every sector range declared by the ten scenario records. It reads the user's bytes at runtime and
// stores nothing from them. Passing it means "the declared resources are present and in bounds", not that
// the game is proven to run correctly (compatibility is only established by running against the original).
//
// Nothing here throws for malformed or truncated input; every failure is a typed InputError.

import type { Profile } from "./detect.js";
import { SECTOR_SIZE } from "./picture.js";
import { HEADER_SECTOR, HEADER_SECTORS, readScenarioRecords, type ScenarioRecord } from "./scenario.js";

export type InputErrorCode =
  | "missing-file" // required file not present in the picked folder
  | "file-size-mismatch" // size differs from the profile (recognition, or bytes read differ from it)
  | "read-failed" // the host could not deliver the file's bytes
  | "disk1-too-small" // too short to hold the signature
  | "disk1-signature" // Disk.1 does not start with the AmigaDOS boot block signature "DOS\0"
  | "disk2-header-truncated" // Disk.2 ends before the two header sectors at $3C0
  | "disk2-signature" // Disk.2 header magic is not "UTOPSCEN"
  | "scenario-range-inverted" // a declared range has last < first
  | "scenario-range-out-of-bounds"; // a declared range extends past the end of Disk.2

export interface InputError {
  code: InputErrorCode;
  /** Profile file name the problem refers to. */
  file: string;
  /** Actionable, human-readable description. */
  message: string;
  /** Scenario record index for range errors. */
  scenario?: number;
  /** Record field for range errors, e.g. "map" or "text[2]". */
  field?: string;
  first?: number;
  last?: number;
}

export interface InputWarning {
  code: "disk4-unreadable";
  file: string;
  message: string;
}

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

export interface ProfileBytes {
  disk1: NamedBytes | null;
  disk2: NamedBytes | null;
  /** Optional save seed. Only presence is recorded here; its content is validated when it is opened. */
  disk4: NamedBytes | null;
}

export interface ValidatedInput {
  profile: Profile;
  disk1: Uint8Array;
  disk2: Uint8Array;
  records: ScenarioRecord[];
  disk4: NamedBytes | null;
}

export type ValidationResult = { ok: true; input: ValidatedInput } | { ok: false; errors: InputError[] };

const DOS_SIGNATURE = [0x44, 0x4f, 0x53, 0x00]; // "DOS\0"
const SCEN_MAGIC = "UTOPSCEN";

function expectedSize(profile: Profile, name: string): number | undefined {
  return profile.files.find((f) => f.name.toLowerCase() === name.toLowerCase())?.size;
}

function sizeError(profile: Profile, name: string, actual: number): InputError | null {
  const expected = expectedSize(profile, name);
  if (expected === undefined || expected === actual) return null;
  return {
    code: "file-size-mismatch",
    file: name,
    message: `${name} is ${actual} bytes but ${profile.label} expects ${expected}. Pick the unmodified, unpacked WHDLoad 1.2 (0757) folder.`,
  };
}

function checkDisk1(profile: Profile, disk1: Uint8Array, errors: InputError[]): void {
  const size = sizeError(profile, "Disk.1", disk1.length);
  if (size) errors.push(size);
  if (disk1.length < DOS_SIGNATURE.length) {
    errors.push({
      code: "disk1-too-small",
      file: "Disk.1",
      message: `Disk.1 is only ${disk1.length} bytes, too short to hold the "DOS\\0" boot block signature.`,
    });
  } else if (!DOS_SIGNATURE.every((b, i) => disk1[i] === b)) {
    errors.push({
      code: "disk1-signature",
      file: "Disk.1",
      message: 'Disk.1 does not start with "DOS\\0". It is not the game disk image of this profile (an ADF or other release is not supported).',
    });
  }
}

/** Declared Disk.2 ranges of one record, in record order, with names for error messages. */
function declaredRanges(record: ScenarioRecord): { field: string; first: number; last: number }[] {
  return [
    { field: "sprites", ...record.sprites },
    { field: "tiles", ...record.tiles },
    { field: "descriptors", ...record.descriptors },
    { field: "map", ...record.map },
    { field: "block", ...record.block },
    { field: "intel", ...record.intel },
    ...record.text.map((range, language) => ({ field: `text[${language}]`, ...range })),
  ];
}

function checkDisk2(profile: Profile, disk2: Uint8Array, errors: InputError[]): ScenarioRecord[] | null {
  const size = sizeError(profile, "Disk.2", disk2.length);
  if (size) errors.push(size);

  const headerEnd = (HEADER_SECTOR + HEADER_SECTORS) * SECTOR_SIZE;
  if (disk2.length < headerEnd) {
    errors.push({
      code: "disk2-header-truncated",
      file: "Disk.2",
      message: `Disk.2 is ${disk2.length} bytes and ends before its scenario header (sectors $${HEADER_SECTOR.toString(16).toUpperCase()}-$${(HEADER_SECTOR + HEADER_SECTORS - 1).toString(16).toUpperCase()}, ${headerEnd} bytes needed). The file is truncated.`,
    });
    return null;
  }
  const at = HEADER_SECTOR * SECTOR_SIZE;
  const magic = String.fromCharCode(...disk2.subarray(at, at + SCEN_MAGIC.length));
  if (magic !== SCEN_MAGIC) {
    errors.push({
      code: "disk2-signature",
      file: "Disk.2",
      message: 'Disk.2 has no "UTOPSCEN" scenario header at sector $3C0. It is not the scenario disk image of this profile.',
    });
    return null;
  }

  let records: ScenarioRecord[];
  try {
    records = readScenarioRecords(disk2); // cannot throw after the checks above; guarded anyway
  } catch (err) {
    errors.push({ code: "disk2-signature", file: "Disk.2", message: `Disk.2 scenario header could not be read: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }

  const totalSectors = Math.floor(disk2.length / SECTOR_SIZE);
  for (const record of records) {
    for (const { field, first, last } of declaredRanges(record)) {
      const where = `scenario ${record.index} (${record.name || "unnamed"}) ${field} sectors ${first}-${last}`;
      if (last < first) {
        errors.push({
          code: "scenario-range-inverted",
          file: "Disk.2",
          scenario: record.index,
          field,
          first,
          last,
          message: `Disk.2 ${where}: the last sector precedes the first. The scenario header is corrupt.`,
        });
      } else if (last >= totalSectors) {
        errors.push({
          code: "scenario-range-out-of-bounds",
          file: "Disk.2",
          scenario: record.index,
          field,
          first,
          last,
          message: `Disk.2 ${where} lies beyond the ${totalSectors} sectors in the file. The file is truncated or damaged.`,
        });
      }
    }
  }
  return records;
}

/** Validates the bytes of a recognised profile. Pure and non-throwing; reports every problem found. */
export function validateProfileBytes(profile: Profile, bytes: ProfileBytes): ValidationResult {
  const errors: InputError[] = [];
  let records: ScenarioRecord[] | null = null;

  if (!bytes.disk1) {
    errors.push({ code: "missing-file", file: "Disk.1", message: "Disk.1 is missing from the picked folder." });
  } else {
    checkDisk1(profile, bytes.disk1.bytes, errors);
  }
  if (!bytes.disk2) {
    errors.push({ code: "missing-file", file: "Disk.2", message: "Disk.2 is missing from the picked folder." });
  } else {
    records = checkDisk2(profile, bytes.disk2.bytes, errors);
  }

  if (errors.length > 0 || !bytes.disk1 || !bytes.disk2 || !records) return { ok: false, errors };
  return {
    ok: true,
    input: { profile, disk1: bytes.disk1.bytes, disk2: bytes.disk2.bytes, records, disk4: bytes.disk4 },
  };
}

/** One-line summary for a status display: the first few messages and how many were left out. */
export function summariseInputErrors(errors: readonly InputError[], limit = 3): string {
  const shown = errors.slice(0, limit).map((e) => e.message);
  const rest = errors.length - shown.length;
  return rest > 0 ? `${shown.join(" ")} (+${rest} more)` : shown.join(" ");
}
