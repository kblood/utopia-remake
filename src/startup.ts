// Startup gate: recognise the picked files, read them, validate the bytes, and only then run the
// constructors that need the data (music, sound, Game). DOM-free so it can be tested with synthetic files.
//
// Three separate claims, in increasing strength (see notes/formats/utopia-disks.md):
//   1. recognition      - names and sizes match a profile (detect.ts)
//   2. validated input  - the bytes carry the signatures and in-bounds scenario ranges (profile-input.ts)
//   3. runtime compat.  - the game behaves like the original; never established by this gate

import { detectProfile, findByName } from "./data/detect.js";
import {
  validateProfileBytes,
  type InputError,
  type InputWarning,
  type NamedBytes,
  type ValidatedInput,
} from "./data/profile-input.js";

/** A picked file. `read` is only called after recognition succeeds, and its failure is reported, not thrown. */
export interface InputFile {
  name: string;
  size: number;
  read(): Promise<Uint8Array>;
}

export type LoadResult =
  | { ok: true; input: ValidatedInput; warnings: InputWarning[] }
  | { ok: false; errors: InputError[] };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readNamed(file: InputFile): Promise<{ named: NamedBytes } | { error: string }> {
  try {
    const bytes: unknown = await file.read();
    if (!(bytes instanceof Uint8Array)) {
      const got = bytes === null ? "null" : typeof bytes === "object" ? "a non-byte value" : typeof bytes;
      return { error: `the read returned ${got} instead of file bytes` };
    }
    return { named: { name: file.name, bytes } };
  } catch (err) {
    return { error: describe(err) };
  }
}

/** Recognises the profile, reads Disk.1/Disk.2 (and Disk.4 when present) and validates them. Never throws. */
export async function loadValidatedInput(files: readonly InputFile[]): Promise<LoadResult> {
  const detected = detectProfile(files);
  if (!detected.profile) {
    const errors: InputError[] = detected.problems.map((p): InputError =>
      p.kind === "missing"
        ? { code: "missing-file", file: p.name, message: `${p.name} is missing from the picked folder.` }
        : {
            code: "file-size-mismatch",
            file: p.name,
            message: `${p.name} is ${p.actualSize} bytes but ${p.expectedSize} was expected. Pick the unmodified, unpacked WHDLoad 1.2 (0757) folder.`,
          },
    );
    if (errors.length === 0) {
      errors.push({ code: "missing-file", file: "Disk.1", message: "No supported game profile was recognised in the picked folder." });
    }
    return { ok: false, errors };
  }

  const warnings: InputWarning[] = [];
  const errors: InputError[] = [];
  const loaded: Record<"disk1" | "disk2" | "disk4", NamedBytes | null> = { disk1: null, disk2: null, disk4: null };

  for (const [key, name] of [["disk1", "Disk.1"], ["disk2", "Disk.2"]] as const) {
    const file = findByName(files, name);
    if (!file) continue; // recognition guarantees presence; validation would report it anyway
    const result = await readNamed(file);
    if ("error" in result) {
      errors.push({ code: "read-failed", file: name, message: `${name} could not be read: ${result.error}` });
    } else {
      loaded[key] = result.named;
    }
  }

  // Disk.4 is optional: an unreadable one is dropped with a warning instead of blocking startup.
  const disk4File = findByName(files, "disk.4");
  if (disk4File) {
    const result = await readNamed(disk4File);
    if ("error" in result) {
      warnings.push({
        code: "disk4-unreadable",
        file: disk4File.name,
        message: `${disk4File.name} could not be read and the Disk.4 continuation is unavailable: ${result.error}`,
      });
    } else {
      loaded.disk4 = result.named;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const validation = validateProfileBytes(detected.profile, loaded);
  return validation.ok ? { ok: true, input: validation.input, warnings } : { ok: false, errors: validation.errors };
}

/** Constructors that must not run until the input has been validated. */
export interface StartupFactories<Music, Sfx, GameT> {
  createMusic(disk1: Uint8Array, disk2: Uint8Array): Music;
  createSfx(disk1: Uint8Array, disk2: Uint8Array, music: Music): Sfx;
  createGame(disk1: Uint8Array, disk2: Uint8Array, music: Music, sfx: Sfx): GameT;
}

export type StartupResult<Music, Sfx, GameT> =
  | { ok: true; input: ValidatedInput; warnings: InputWarning[]; music: Music; sfx: Sfx; game: GameT }
  | { ok: false; errors: InputError[] };

/**
 * Validates the picked files and, only if they pass, builds music, sound and the Game in that order.
 * Invalid or truncated input yields typed errors and no factory is called. An exception thrown by a factory
 * itself (a defect or an unsupported-but-valid input) is not swallowed.
 */
export async function startFromFiles<Music, Sfx, GameT>(
  files: readonly InputFile[],
  factories: StartupFactories<Music, Sfx, GameT>,
): Promise<StartupResult<Music, Sfx, GameT>> {
  const loaded = await loadValidatedInput(files);
  if (!loaded.ok) return loaded;
  const { disk1, disk2 } = loaded.input;
  const music = factories.createMusic(disk1, disk2);
  const sfx = factories.createSfx(disk1, disk2, music);
  const game = factories.createGame(disk1, disk2, music, sfx);
  return { ok: true, input: loaded.input, warnings: loaded.warnings, music, sfx, game };
}
