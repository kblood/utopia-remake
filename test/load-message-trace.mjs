// Static trace of the original's load message timing (notes/formats/game-proper.md, "Load success message"). It reads only the
// user's own original/utopia-whdload/Disk.1 at runtime (nothing is stored), checks raw bytes and branch targets at the traced
// addresses (file offset = address + 0x28800), and checks the structure the timing note relies on:
//   - `$8462` prints on the list prompt after one VBL wait (`$8488`-`$8498`), and `$84F4` erases it after one VBL wait
//     (`$851A`-`$852A`);
//   - the only absolute `bset #0,$156A8` in the image is the VBL handler's (`$2C58`, gated by INTREQR bit 5 at `$2C4A`);
//   - the code between the print and the erase (`$88D4`-`$88E6`, `$866E`-`$87DA`, `$82B8`-`$82E4`) contains no VBL wait.
// This does NOT measure cycles, the raster, or the disk-read length; those are not established (see the note). A mutation
// self-check runs at the end: each mutated copy must fail, so the checker is not vacuous. Skipped without the game files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const FILE_BASE = 0x28800;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`); }
};

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const hexBytes = (s) => new Uint8Array(Buffer.from(s, "hex"));
const BSET0 = hexBytes("08f90000000156a8"); // bset.b #0,$156A8 (absolute long)
const BCLR0 = hexBytes("08b90000000156a8"); // bclr.b #0,$156A8
const BTST0 = hexBytes("08390000000156a8"); // btst.b #0,$156A8
const NOP = hexBytes("4e71");

// Every byte offset (file) at which `pattern` occurs.
function sites(buf, pattern) {
  // Buffer.indexOf takes a byte sequence; Uint8Array.indexOf takes a single number and would never match.
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  for (let i = b.indexOf(pattern); i >= 0; i = b.indexOf(pattern, i + 1)) out.push(i - FILE_BASE);
  return out;
}
const word = (buf, a) => (buf[a + FILE_BASE] << 8) | buf[a + FILE_BASE + 1];
const bytesAt = (buf, a, n) => hex(buf.subarray(a + FILE_BASE, a + FILE_BASE + n));
// Target of a `bsr.w`/`bra.w` (opcode $6100/$6000, 16-bit displacement) or a `bsr.b`/`bra.b`/`beq.b` (8-bit) at `a`.
function target(buf, a) {
  const op = word(buf, a);
  if (op === 0x6100 || op === 0x6000) {
    const d = (word(buf, a + 2) << 16) >> 16;
    return a + 2 + d;
  }
  const hi = op >> 8;
  if (hi === 0x61 || hi === 0x60 || hi === 0x67) {
    const d8 = (op & 0xff) << 24 >> 24;
    return a + 2 + d8;
  }
  return null;
}

// The structural findings for one image: an empty list means every traced claim holds.
export function traceFindings(buf) {
  const f = [];
  const expectBytes = [
    [0x88ca, "303c0145", "move.w #$145,d0 (the load's message)"],
    [0x88d4, "103c0001", "move.b #1,d0 (the reset argument)"],
    [0x2c4a, "08000005", "btst.b #5,d0 (VERTB gate in the VBL handler)"],
    [0x2c44, "33c100dff09c", "move.w d1,$dff09c (INTREQ acknowledge)"],
    [0x2c58, "08f90000000156a8", "bset.b #0,$156A8 (the VBL flag)"],
    [0x8462, "33fc002000dff09a", "print: INTENA off (`$20`)"],
    [0x84f4, "33fc002000dff09a", "erase: INTENA off (`$20`)"],
    [0x8488, "08b90000000156a8", "print: bclr #0 before the wait"],
    [0x851a, "08b90000000156a8", "erase: bclr #0 before the wait"],
  ];
  for (const [a, want, label] of expectBytes) {
    const got = bytesAt(buf, a, want.length / 2);
    if (got !== want) f.push(`bytes at ${a.toString(16)} ${label}: got ${got}, want ${want}`);
  }
  const branches = [
    [0x88d0, 0x8462, "bsr $8462 (print $145)"],
    [0x88d8, 0x866e, "bsr $866E (reset)"],
    [0x88ea, 0x82b8, "bra $82B8 (close the list)"],
    [0x88c6, 0x84f4, "bsr $84F4 (erase before the print)"],
    [0x82e4, 0x84f4, "bsr $84F4 (erase in $82B8)"],
    [0x8894, 0x8a5a, "bsr $8A5A (disk-header check)"],
    [0x8498, 0x8490, "beq back to $8490 (print wait)"],
    [0x852a, 0x8522, "beq back to $8522 (erase wait)"],
  ];
  for (const [a, want, label] of branches) {
    const t = target(buf, a);
    if (t !== want) f.push(`branch at ${a.toString(16)} ${label}: target ${t === null ? "none" : t.toString(16)}`);
  }
  // Positive control: the two waits' clears are where the trace says.
  const clears = sites(buf, BCLR0);
  for (const a of [0x8488, 0x8490, 0x851a, 0x8522]) if (!clears.includes(a)) f.push(`no bclr #0 at ${a.toString(16)}`);
  // The only absolute bset #0 is the VBL handler's.
  const sets = sites(buf, BSET0);
  if (sets.length !== 1 || sets[0] !== 0x2c58) f.push(`bset #0,$156A8 absolute sites: ${sets.map((x) => x.toString(16)).join(",")} (want only 2c58)`);
  // No VBL-bit wait on the post-print path: between the print (`$88D0`) and the erase (`$851A`) the code is the reset
  // (`$866E`-`$87DA`) and the list close (`$82B8`-`$82E4`), and it has no absolute test or clear of $156A8 bit 0.
  const waits = [...sites(buf, BCLR0), ...sites(buf, BTST0)];
  const inRange = (x, lo, hi) => x >= lo && x < hi;
  for (const x of waits) {
    if (inRange(x, 0x82b8, 0x82e5) || inRange(x, 0x866e, 0x87db)) f.push(`VBL-bit access on the post-print path at ${x.toString(16)}`);
  }
  return f;
}

if (!fs.existsSync(disk1Path)) {
  console.log("skip load-message trace: original/utopia-whdload/Disk.1 not found (the trace needs the user's own game files)");
  process.exit(0);
}

const image = new Uint8Array(fs.readFileSync(disk1Path));
const original = traceFindings(image);
check("traced bytes, branch targets and wait loops match the original Disk.1", original.length === 0, original.join("; "));

// Mutation self-check: each mutant of the image must be reported (the checker is not vacuous).
const mutants = [
  ["bsr $8462 at $88D0 replaced by nop", (m) => m.set(NOP, 0x88d0 + FILE_BASE)],
  ["the print wait's beq at $8498 replaced by nop", (m) => m.set(NOP, 0x8498 + FILE_BASE)],
  ["a bclr #0 inside the reset loop at $8680", (m) => m.set(BCLR0, 0x8680 + FILE_BASE)],
  ["a second bset #0 at $8700", (m) => m.set(BSET0, 0x8700 + FILE_BASE)],
  ["bra $82B8 at $88EA replaced by nop", (m) => m.set(NOP, 0x88ea + FILE_BASE)],
];
for (const [label, mutate] of mutants) {
  const m = image.slice();
  mutate(m);
  const found = traceFindings(m);
  check(`mutant detected: ${label}`, found.length > 0, "no finding");
  if (found.length) console.log(`     first finding: ${found[0]}`);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall load-message trace checks passed (static: bytes, branch targets, wait loops; no cycle or raster measurement)");
