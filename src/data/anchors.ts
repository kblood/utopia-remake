// Finds the constant tables of the game program in another build by content, not by fixed address. The reference
// is the user's WHDLoad program image (loaded at $1000); each table's first bytes there are used as a pattern and must
// occur exactly once in the target image. The pattern bytes come from the user's own reference file at run time and
// are never stored in the repository. Evidence: notes/formats/utopia-disks.md, "Table locations by content".

import { BytePattern, locateUnique } from "./locate.js";

/** Load address of the game program image. */
export const PROGRAM_BASE = 0x1000;
export const ANCHOR_BYTES = 16;

export interface TableAnchor {
  name: string;
  /** Address in the WHDLoad build (reference), as read from the game program (notes/formats/game-proper.md). */
  address: number;
}

// Tables the engine reads from the program image (see gameimage.ts and gamefont.ts).
export const TABLE_ANCHORS: readonly TableAnchor[] = [
  { name: "flag table", address: 0x16408 },
  { name: "weights", address: 0xb0ec },
  { name: "inventions", address: 0xb1cc },
  { name: "music labels", address: 0x1530 },
  { name: "font character table", address: 0x62d8 },
  { name: "font glyphs", address: 0x6354 },
  { name: "money template", address: 0x2f48 },
  { name: "title template", address: 0x6532 },
];

export type AnchorResult =
  | { name: string; ok: true; address: number }
  | { name: string; ok: false; count: number };

/**
 * Locate each anchor table in `target` (a program image loaded at PROGRAM_BASE) using the bytes at the reference address
 * in `reference` (same base). Each result is either one address or the number of matches (0 or more than one).
 */
export function locateAnchors(reference: Uint8Array, target: Uint8Array, anchors: readonly TableAnchor[] = TABLE_ANCHORS): AnchorResult[] {
  return anchors.map((anchor) => {
    const at = anchor.address - PROGRAM_BASE;
    if (at < 0 || at + ANCHOR_BYTES > reference.length) return { name: anchor.name, ok: false, count: 0 };
    const pattern: BytePattern = {
      bytes: reference.slice(at, at + ANCHOR_BYTES),
      mask: new Uint8Array(ANCHOR_BYTES).fill(1),
    };
    const found = locateUnique(target, pattern);
    return found.ok ? { name: anchor.name, ok: true, address: found.offset + PROGRAM_BASE } : { name: anchor.name, ok: false, count: found.count };
  });
}
