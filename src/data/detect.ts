// Identifies the user's own copy of Utopia by file name and size.
// Only names and sizes are used. No original content is stored or hashed here.

export interface ExpectedFile {
  name: string;
  size: number;
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
      { name: "disk.4", size: 656 },
      { name: "Utopia.Slave", size: 1264 },
    ],
  },
];

export interface DetectResult {
  profile: Profile | null;
  missing: string[];
}

// Matches files case-insensitively by name, since AmigaDOS and host file systems differ.
export function detectProfile(files: { name: string; size: number }[]): DetectResult {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f.size]));

  let best: DetectResult = { profile: null, missing: [] };
  for (const profile of PROFILES) {
    const missing = profile.files
      .filter((expected) => byName.get(expected.name.toLowerCase()) !== expected.size)
      .map((expected) => expected.name);

    if (missing.length === 0) {
      return { profile, missing };
    }
    if (best.profile === null || missing.length < best.missing.length) {
      best = { profile: null, missing };
    }
  }
  return best;
}
