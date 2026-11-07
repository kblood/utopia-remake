// Checks of the map background restore (src/game/map-background.ts), the port of `$15F9A` (mask pattern generator) and
// `$16012` (per-pass background restore). Run after `npm run build`.
// Parts 1-3 are asset-free: synthetic pixels and hand-derived expectations written independently of the module code
// (a closed form for the pattern, a literal row table for the texture rows, a region predicate for placement).
// Part 4 uses the player's own Disk.1 in original/utopia-whdload and is skipped when missing; it only checks region
// placement on the real picture, not visual parity with the running original.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { generateMapPattern, restoreMapBackground } = await import("../dist/game/map-background.js");
const { SCREEN_WIDTH: W, SCREEN_HEIGHT: H } = await import("../dist/gfx/screen.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}
const hex = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, "0");

// ---- 1. generator -----------------------------------------------------------------------------------------------------
{
  const { table, tail } = generateMapPattern();
  check("table is 64 vectors x 8 longs (0x800 bytes), tail 63 x 8", table.length === 512 && tail.length === 504);
  const entry = (e) => Array.from(table.subarray(e * 8, e * 8 + 8), hex).join(" ");

  // Hand-derived: the state starts as D0=$C0000000, D7=3 (entry 62); every stored state adds two 1 bits to the top of the
  // D0..D3 chain (arithmetic shift) and two to the bottom of the D4..D7 chain. Entry 63 is the zero vector stored first.
  check("entry 63 is all zero", entry(63) === "00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000", entry(63));
  check("entry 62 = seed (D0 $C0000000, D7 3)", entry(62) === "C0000000 00000000 00000000 00000000 00000000 00000000 00000000 00000003", entry(62));
  check("entry 61 (after two passes)", entry(61) === "F0000000 00000000 00000000 00000000 00000000 00000000 00000000 0000000F", entry(61));
  check("entry 60", entry(60) === "FC000000 00000000 00000000 00000000 00000000 00000000 00000000 0000003F", entry(60));
  check("entry 48 (30 ones per side)", entry(48) === "FFFFFFFC 00000000 00000000 00000000 00000000 00000000 00000000 3FFFFFFF", entry(48));
  check("entry 47 (32 ones per side)", entry(47) === "FFFFFFFF 00000000 00000000 00000000 00000000 00000000 00000000 FFFFFFFF", entry(47));
  check("entry 46 (34 ones: the carry reaches D1 / D6)", entry(46) === "FFFFFFFF C0000000 00000000 00000000 00000000 00000000 00000003 FFFFFFFF", entry(46));
  check("entry 0 (126 ones per side)", entry(0) === "FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFC 3FFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF", entry(0));

  // Closed form for all 63 non-zero entries, with BigInt: n = 126 - 2e ones, top n bits of the 128-bit D0..D3 chain and
  // bottom n bits of the D4..D7 chain.
  let closed = true;
  for (let e = 0; e < 63; e++) {
    const n = BigInt(126 - 2 * e);
    const left = ((1n << n) - 1n) << (128n - n);
    const right = (1n << n) - 1n;
    let gotLeft = 0n, gotRight = 0n;
    for (let i = 0; i < 4; i++) gotLeft = (gotLeft << 32n) | BigInt(table[e * 8 + i]);
    for (let i = 4; i < 8; i++) gotRight = (gotRight << 32n) | BigInt(table[e * 8 + i]);
    if (gotLeft !== left || gotRight !== right) { closed = false; console.log("  mismatch at entry", e); }
  }
  check("entries 0..62 match the closed form (126-2e leading / trailing ones)", closed);

  // Forward stores (`$14E40`...): state k in generation order = table entry 62-k.
  let mirrored = true;
  for (let k = 0; k < 63; k++) for (let i = 0; i < 8; i++) if (tail[k * 8 + i] !== table[(62 - k) * 8 + i]) mirrored = false;
  check("tail holds the same 63 states in generation order", mirrored && hex(tail[0]) === "C0000000" && hex(tail[7]) === "00000003");

  // Stable vectors (SHA-256 over the big-endian bytes), computed with an independent Python bit-list model of the 68k ops.
  const sha = (arr) => {
    const buf = Buffer.alloc(arr.length * 4);
    arr.forEach((v, i) => buf.writeUInt32BE(v, i * 4));
    return crypto.createHash("sha256").update(buf).digest("hex");
  };
  check("table SHA-256", sha(table) === "1dc1da918f54a288c5cbb65633382ee61445ad0e6e6ddc2f04f2b449d3307eb2");
  check("tail SHA-256", sha(tail) === "fb103e7aa6ad2c8e3da6c50b2b05bac1bc607ef956a4c57952bcea9893628ff1");
  const again = generateMapPattern();
  check("deterministic and independent buffers", sha(again.table) === sha(table) && again.table !== table);
}

// ---- 2. restore: placement, texture rows, mask, untouched pixels, no mutation ---------------------------------------------
// initial: nonzero everywhere, texture T(tx,ty) = f(128+tx, ty). current: a different field so untouched pixels are known.
const f = (x, y) => ((x * 7 + y * 13) % 31) + 1;
const g = (x, y) => (x * 5 + y * 3) % 32;
const initial = new Uint8Array(W * H);
const current = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { initial[y * W + x] = f(x, y); current[y * W + x] = g(x, y); }
const initialCopy = initial.slice();
const currentCopy = current.slice();
const T = (tx, ty) => f(128 + tx, ty);

// Literal texture-row table for rows 0..23 (`$16012` first loop): 8..15, 0..7, 8..15.
const BAR_SOURCE = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// Independent per-pixel expectation: region predicate + rules.
function expected(x, y) {
  if (x < 256 && y < 24) return T(x & 31, BAR_SOURCE[y]);
  if (x < 256 && y >= 24 && y <= 87) {
    const e = y - 24; // layer * 16 + row = vector index
    const r = e & 15; // texture row
    const ones = 126 - 2 * e; // visible columns from each edge (0 for e = 63)
    const visible = e <= 62 && (x < ones || x >= 256 - ones);
    return visible ? T(x & 31, r) : 0;
  }
  if (x < 256 && y >= 89 && y <= 159) return initial[y * W + x];
  if (x >= 256 && x <= 271 && y >= 47 && y <= 96) return initial[y * W + x];
  return current[y * W + x];
}

{
  const out = restoreMapBackground(initial, current);
  let bad = 0;
  let first = "";
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (out[y * W + x] !== expected(x, y)) { bad++; if (!first) first = `(${x},${y}) got ${out[y * W + x]} want ${expected(x, y)}`; }
  }
  check("every one of 64000 pixels matches the hand-derived expectation", bad === 0, first);
  check("returns a new buffer of the same size", out !== current && out !== initial && out.length === W * H);
  check("inputs are not modified", initial.every((v, i) => v === initialCopy[i]) && current.every((v, i) => v === currentCopy[i]));

  // Spot checks written out by hand (not via expected()).
  const px = (x, y) => out[y * W + x];
  check("row 0 takes texture row 8, row 8 takes row 0, row 16 takes row 8", px(0, 0) === T(0, 8) && px(0, 8) === T(0, 0) && px(0, 16) === T(0, 8) && px(33, 23) === T(1, 15));
  check("the strip is tiled: x and x+32 agree, x 255 = texture column 31", px(5, 3) === px(5 + 32, 3) && px(255, 3) === T(31, 11));
  check("row 24 hides only x 126..129 (zeros)", px(125, 24) === T(29, 0) && px(126, 24) === 0 && px(129, 24) === 0 && px(130, 24) === T(2, 0));
  check("row 39 (last of layer 0) hides x 96..159", px(95, 39) === T(31, 15) && px(96, 39) === 0 && px(159, 39) === 0 && px(160, 39) === T(0, 15));
  check("row 40 (layer 1 row 0) restarts the texture at row 0, hides x 94..161", px(93, 40) === T(29, 0) && px(94, 40) === 0 && px(161, 40) === 0 && px(162, 40) === T(2, 0));
  check("row 86 (vector 62, texture row 14) shows only x 0,1 and 254,255", px(0, 86) === T(0, 14) && px(1, 86) === T(1, 14) && px(2, 86) === 0 && px(253, 86) === 0 && px(254, 86) === T(30, 14) && px(255, 86) === T(31, 14));
  check("row 87 is entirely color 0 across x 0..255", Array.from({ length: 256 }, (_, x) => px(x, 87)).every((v) => v === 0));
  check("row 88 is untouched for x 0..255 and x >= 272 (x 256..271 belongs to the column snapshot)", Array.from({ length: W }, (_, x) => x >= 256 && x <= 271 || px(x, 88) === current[88 * W + x]).every(Boolean) && px(256, 88) === initial[88 * W + 256]);
  check("rows 89 and 159 come from the snapshot (initial), x >= 272 does not", px(0, 89) === initial[89 * W] && px(255, 159) === initial[159 * W + 255] && px(272, 89) === current[89 * W + 272] && px(256, 97) === current[97 * W + 256] && px(0, 160) === current[160 * W]);
  check("column x 256..271 rows 47..96 come from the snapshot", px(256, 47) === initial[47 * W + 256] && px(271, 96) === initial[96 * W + 271] && px(256, 46) === current[46 * W + 256] && px(256, 97) === current[97 * W + 256] && px(272, 60) === current[60 * W + 272]);
  check("the top bar's right edge (x 256..319, rows 0..23) is untouched", px(256, 0) === current[256] && px(319, 23) === current[23 * W + 319]);

  // The restore must be a function of `initial` and `current` only.
  const same = restoreMapBackground(initial, current);
  check("deterministic", same.every((v, i) => v === out[i]));
  const defaulted = restoreMapBackground(initial);
  check("current defaults to a copy of initial (untouched pixels equal the picture)", defaulted[88 * W + 10] === initial[88 * W + 10] && defaulted[170 * W + 300] === initial[170 * W + 300] && defaulted !== initial);
  check("default call does not mutate initial", initial.every((v, i) => v === initialCopy[i]));
}

// ---- 3. refused inputs -----------------------------------------------------------------------------------------------------
{
  let threw = 0;
  for (const [a, b] of [[new Uint8Array(10), undefined], [initial, new Uint8Array(W * H - 1)], [new Uint8Array(W * H + 1), undefined]]) {
    try { restoreMapBackground(a, b); } catch { threw++; }
  }
  check("wrong buffer sizes are refused", threw === 3);
}

// ---- 4. the player's own Disk.1 (skipped when missing) ----------------------------------------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
if (fs.existsSync(disk1Path)) {
  const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
  const picture = decodePicture(new Uint8Array(fs.readFileSync(disk1Path)), PICTURES.main).pixels;
  const before = picture.slice();
  const out = restoreMapBackground(picture);
  let outside = 0, inside = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (out[y * W + x] === picture[y * W + x]) continue;
    if (x < 256 && y <= 87) inside++;
    else outside++;
  }
  check("local picture: only x 0..255, rows 0..87 differ from the decoded picture", outside === 0 && inside > 0, `inside=${inside} outside=${outside}`);
  check("local picture: input unchanged", picture.every((v, i) => v === before[i]));
  check("local picture: all indices stay within 0..31", out.every((v) => v < 32));
} else {
  console.log("skip  local Disk.1 not present (original/utopia-whdload/Disk.1)");
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall map background checks passed");
