// Shared, read-only reader for the raw `ev:"rng"` rows of an external Copperline RNG tape (rng-tape-seg*.jsonl).
// Used by test/original-rng.mjs and test/production-original-compare.mjs. The capture is local evidence supplied by the player
// through an environment variable; nothing from it is copied, hashed or stored in this repository.
//
// Row shape read here (everything else in a row is ignored):
//   { "ev": "rng", "n": int, "date": "DD/MM/YYYY", "d": [D0..D7 at entry, 8 unsigned 32-bit ints], "ret": int (return address),
//     "d2": range, "tod": 0..255, "d0AfterTod": int, "seedBefore": uint32, "seedAfter": uint32, "result": int, "d2out": int }
// Every field is validated; a malformed row throws (callers turn that into a failure, never into a skip).

import fs from "node:fs";
import path from "node:path";

const isU32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/** Read and validate the `ev:"rng"` rows of the given JSONL files. Throws Error on a missing/unreadable file or malformed row. */
export function loadRawRngRows(files) {
  const rows = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`${path.basename(file)}: cannot be read (${e.message})`); }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length === 0) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch (e) { throw new Error(`${path.basename(file)} line ${i + 1}: not JSON (${e.message})`); }
      if (r === null || typeof r !== "object" || r.ev !== "rng") continue;
      const at = `${path.basename(file)} line ${i + 1} (n=${r.n})`;
      if (!Number.isInteger(r.n) || r.n < 0) throw new Error(`${at}: bad n`);
      if (!Array.isArray(r.d) || r.d.length !== 8 || !r.d.every(isU32)) throw new Error(`${at}: d must be eight unsigned 32-bit register values`);
      if (!isU32(r.ret) || !isU32(r.seedBefore) || !isU32(r.seedAfter) || !isU32(r.d0AfterTod)) throw new Error(`${at}: ret/seedBefore/seedAfter/d0AfterTod must be unsigned 32-bit integers`);
      if (!Number.isInteger(r.tod) || r.tod < 0 || r.tod > 255) throw new Error(`${at}: tod must be a byte`);
      if (!Number.isInteger(r.d2) || r.d2 < 0 || r.d2 > 0xffff || r.d[2] !== r.d2) throw new Error(`${at}: d2 must equal D2 at entry and be a word`);
      if (!Number.isInteger(r.result) || r.result < 0 || r.result !== r.d2out) throw new Error(`${at}: result must equal d2out`);
      if (typeof r.date !== "string") throw new Error(`${at}: date missing`);
      rows.push({
        n: r.n, date: r.date, ret: r.ret, retText: `$${r.ret.toString(16).toUpperCase()}`, d0: r.d[0], range: r.d2, tod: r.tod,
        d0AfterTod: r.d0AfterTod, seedBefore: r.seedBefore, seedAfter: r.seedAfter, result: r.result,
      });
    }
  }
  return rows;
}

/** Resolve the capture directory like the production comparator: the directory itself or its `out/` sub-directory. */
export function resolveCaptureDir(envValue, requiredFile) {
  const dir = path.resolve(envValue);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("capture path is not a directory");
  if (fs.existsSync(path.join(dir, requiredFile))) return dir;
  const out = path.join(dir, "out");
  if (fs.existsSync(path.join(out, requiredFile))) return out;
  throw new Error(`${requiredFile} not found in the capture directory (or its out/)`);
}
