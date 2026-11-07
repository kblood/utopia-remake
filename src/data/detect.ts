// Format RECOGNITION: identifies the user's own copy of Utopia by file name and size only.
// No original content is read, stored or hashed here. Passing this check says nothing about whether the
// bytes are usable; that is the job of profile-input.ts (validated resource availability), and neither
// proves runtime compatibility (see notes/formats/utopia-disks.md).

export interface ExpectedFile {
  name: string;
  /** Omit when the file is expected to change size during normal game use. */
  size?: number;
  /** The game starts without this file; its absence is not a recognition problem. */
  optional?: boolean;
}

export interface Profile {
  id: string;
  label: string;
  files: ExpectedFile[];
}

// WHDLoad 1.2 (0757) unpacked set. Sizes are taken from the user's own files.
export const PROFILES: Profile[] = [
  {
    id: "whdload-1.2-0757",
    label: "Utopia – WHDLoad 1.2 (0757)",
    files: [
      { name: "Disk.1", size: 970752 },
      { name: "Disk.2", size: 983040 },
      // WHDLoad writes saves at sector-derived offsets and expands this seed file. The game starts without it;
      // when present it is only offered as an experimental continuation source.
      { name: "disk.4", optional: true },
      { name: "Utopia.Slave", size: 1264 },
    ],
  },
];

export interface DetectProblem {
  name: string;
  kind: "missing" | "wrong-size";
  expectedSize?: number;
  actualSize?: number;
}

export interface DetectResult {
  profile: Profile | null;
  /** Names of required files that are absent or have the wrong size (for the closest profile). */
  missing: string[];
  problems: DetectProblem[];
}

/** First file with this name, case-insensitively. Startup and recognition both resolve names through this. */
export function findByName<T extends { name: string }>(files: readonly T[], name: string): T | undefined {
  const key = name.toLowerCase();
  return files.find((f) => f.name.toLowerCase() === key);
}

// Matches files case-insensitively by name, since AmigaDOS and host file systems differ.
export function detectProfile(files: readonly { name: string; size: number }[]): DetectResult {
  let best: DetectResult = { profile: null, missing: [], problems: [] };
  let bestSet = false;
  for (const profile of PROFILES) {
    const problems: DetectProblem[] = [];
    for (const expected of profile.files) {
      const found = findByName(files, expected.name);
      if (!found) {
        if (!expected.optional) problems.push({ name: expected.name, kind: "missing", expectedSize: expected.size });
      } else if (expected.size !== undefined && found.size !== expected.size) {
        problems.push({ name: expected.name, kind: "wrong-size", expectedSize: expected.size, actualSize: found.size });
      }
    }

    if (problems.length === 0) {
      return { profile, missing: [], problems };
    }
    if (!bestSet || problems.length < best.problems.length) {
      best = { profile: null, missing: problems.map((p) => p.name), problems };
      bestSet = true;
    }
  }
  return best;
}
