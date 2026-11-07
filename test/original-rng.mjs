// Tests for the isolated model of the original random routine `$2DCC`/`$2DCA` (src/game/original-rng.ts). Run after `npm run build`.
//
// Scope, kept separate on purpose:
//   1. MODEL ARITHMETIC: hand-derived vectors (instruction by instruction), an independent BigInt reference, and a sweep. The
//      sections cover the low-byte carry of `addq.b #7`, nonzero D0 bits 8..15 (carried through `mulu.w #13`), the TOD byte
//      replacing only D0.b, ignored D0 bits 16..31, seed wrapping in `add.l`, range edge cases, and D0 preservation.
//   2. OPTIONAL RAW-CAPTURE CHECK: only when UTOPIA_PRODUCTION_TRACE_DIR is set (directory with rng-tape-seg1.jsonl and
//      rng-tape-seg2.jsonl, or its out/). The 50 captured calls are recomputed from their recorded D0 / range / TOD / seed and
//      must reproduce the recorded result and the next seed. A set-but-unusable path fails; an unset variable skips only this part.
// NOT covered here: which of the 62 original call sites reach this routine with which D0 (only 7 sites are in the capture),
// and the seed initialiser `$2DA0` (untraced; initial seed provenance unknown). The routine is not wired into `Sim`.

import fs from "node:fs";
import path from "node:path";
import { originalRngStep, originalRngStep100, OriginalRngModel } from "../dist/game/original-rng.js";
import { loadRawRngRows } from "./original-rng-capture.mjs";

let failures = 0;
let checks = 0;
const eq = (name, got, want) => {
  checks++;
  if (got !== want) { failures++; console.log(`FAIL ${name}: got ${typeof got === "number" ? "0x" + got.toString(16) : got}, want ${typeof want === "number" ? "0x" + want.toString(16) : want}`); }
};

// ---- independent reference (BigInt, written from the instruction list, not from the module) ----------------------------------
const M32 = 0xffffffffn, M16 = 0xffffn, M8 = 0xffn;
function reference({ d0, range, tod, seed }) {
  let D0 = (BigInt(d0) & ~M8 & M32) | (BigInt(tod) & M8);           // move.b $BFE801,D0
  D0 = ((D0 & M16) * 13n) & M32;                                       // mulu.w #13,D0
  D0 = (D0 & ~M8 & M32) | ((D0 + 7n) & M8);                            // addq.b #7,D0
  let D1 = BigInt(seed) & M32;
  D1 = ((D1 << 3n) | (D1 >> 29n)) & M32;                               // rol.l #3,D1
  const D3 = D1;
  D0 = ((D0 & M16) * (D3 & M16)) & M32;                                // mulu.w D3,D0
  D0 >>= 1n;                                                           // lsr.l #1,D0
  const sum = D1 + D0;                                                 // add.l D0,D1
  D1 = sum & M32;
  const D2 = (((BigInt(range) & M16) * (D1 & M8)) & M32) >> 8n;      // mulu.w D0(=D1.b),D2 ; lsr.l #8,D2
  return { seed: Number(D1), result: Number(D2), overflowed: sum > M32 };
}

function check(name, input, want) {
  const before = JSON.stringify(input);
  const out = originalRngStep(input);
  eq(`${name}: seed`, out.seed, want.seed);
  eq(`${name}: result`, out.result, want.result);
  eq(`${name}: caller D0 preserved`, out.d0, input.d0 >>> 0);
  eq(`${name}: input not mutated`, JSON.stringify(input), before);
  const ref = reference(input);
  eq(`${name}: matches BigInt reference (seed)`, out.seed, ref.seed);
  eq(`${name}: matches BigInt reference (result)`, out.result, ref.result);
}

// ---- 1. hand-derived vectors -----------------------------------------------------------------------------------------------
// seed 1, D0 0, TOD 0, range 100: D0 = 0*13+7 = 7; rol -> 8; 7*8 = 56 >> 1 = 28; seed = 8 + 28 = 36; 100 * 36 >> 8 = 14.
check("simple", { d0: 0, range: 100, tod: 0, seed: 1 }, { seed: 36, result: 14 });
// `$2DCA` is the same with range 100.
{
  const a = originalRngStep100({ d0: 0, tod: 0, seed: 1 });
  eq("$2DCA seed", a.seed, 36);
  eq("$2DCA result", a.result, 14);
}
// Low-byte carry of addq.b: TOD 39 -> 39*13 = $1FB; $FB + 7 wraps to $02 WITHOUT carrying into bit 8 -> D0 = $102 (a word add would give $202).
// seed $20000000 rotates to 1: D0 = $102 * 1 >> 1 = 129; seed = 1 + 129 = $82; 100 * $82 >> 8 = 50. (Word add: 257 + 1 = $102 -> byte $02.)
check("addq.b carry", { d0: 0, range: 100, tod: 39, seed: 0x20000000 }, { seed: 0x82, result: 50 });
// No carry: TOD 0x10 -> 208 = $D0; $D0 + 7 = $D7; * 1 >> 1 = 107; seed = 108 = $6C; 100 * 108 >> 8 = 42.
check("addq.b no carry", { d0: 0, range: 100, tod: 0x10, seed: 0x20000000 }, { seed: 0x6c, result: 42 });
// Nonzero D0 bits 8..15 survive move.b and enter mulu.w #13: D0 = $1200 -> *13 = $EA00 -> +7 = $EA07 = 59911; *1 >> 1 = 29955; seed = 29956 = $7504; result 100*4>>8 = 1.
check("D0 bits 8..15", { d0: 0x1200, range: 100, tod: 0, seed: 0x20000000 }, { seed: 0x7504, result: 1 });
// The caller's D0.b is REPLACED by TOD and bits 16..31 do not reach mulu.w.
{
  const a = originalRngStep({ d0: 0x1200, range: 100, tod: 0, seed: 0x20000000 });
  const b = originalRngStep({ d0: 0xabcd12ff, range: 100, tod: 0, seed: 0x20000000 });
  eq("D0.b replaced and D0 bits 16..31 ignored (seed)", b.seed, a.seed);
  eq("D0.b replaced and D0 bits 16..31 ignored (result)", b.result, a.result);
  eq("same call keeps its own caller D0", b.d0, 0xabcd12ff);
  eq("d0AfterTod keeps bits 8..31", b.d0AfterTod, 0xabcd1200);
  const c = originalRngStep({ d0: 0x3400, range: 100, tod: 0, seed: 0x20000000 });
  eq("byte 1 is significant (seed differs)", c.seed === a.seed, false);
}
// add.l wraps modulo 2^32: seed $FFFFFFFF rotates to itself, D0 = 7 * $FFFF >> 1 = $37FFC, sum = $1_0003_7FFB -> $37FFB; byte $FB; 100*251>>8 = 98.
check("seed wrap", { d0: 0, range: 100, tod: 0, seed: 0xffffffff }, { seed: 0x37ffb, result: 98 });
eq("seed wrap really overflowed", reference({ d0: 0, range: 100, tod: 0, seed: 0xffffffff }).overflowed, true);
// rol.l #3 moves the top bits to the bottom: seed $E0000000 -> 7.
check("rol top bits", { d0: 0, range: 100, tod: 0, seed: 0xe0000000 }, { seed: 0x7 + ((7 * 7) >> 1), result: ((0x7 + ((7 * 7) >> 1)) & 0xff) * 100 >> 8 });

// ---- range / result edges --------------------------------------------------------------------------------------------------
{
  let byteFF = null, byte00 = null;
  for (let s = 0; s < 0x20000 && (byteFF === null || byte00 === null); s++) {
    const seed = Math.imul(s, 0x9e3779b1) >>> 0; // spread the seeds (with small seeds, D0=0 and TOD=0 the new seed is always a multiple of 4)
    const out = originalRngStep({ d0: 0, range: 0xffff, tod: 0, seed });
    if ((out.seed & 0xff) === 0xff && byteFF === null) byteFF = seed;
    if ((out.seed & 0xff) === 0x00 && byte00 === null) byte00 = seed;
  }
  eq("found a seed giving byte $FF", byteFF !== null, true);
  eq("found a seed giving byte $00", byte00 !== null, true);
  eq("max range, byte $FF -> $FEFF (never range)", originalRngStep({ d0: 0, range: 0xffff, tod: 0, seed: byteFF }).result, (0xffff * 255) >> 8);
  eq("byte $00 -> 0", originalRngStep({ d0: 0, range: 0xffff, tod: 0, seed: byte00 }).result, 0);
  eq("range 1 -> 0", originalRngStep({ d0: 0, range: 1, tod: 0, seed: byteFF }).result, 0);
  eq("range 0 -> 0", originalRngStep({ d0: 0, range: 0, tod: 0, seed: byteFF }).result, 0);
  eq("range word 0 (high word ignored) -> 0", originalRngStep({ d0: 0, range: 0x10000, tod: 0, seed: byteFF }).result, 0);
  eq("range high word ignored", originalRngStep({ d0: 0, range: 0x12340064, tod: 0, seed: 12345 }).result, originalRngStep({ d0: 0, range: 100, tod: 0, seed: 12345 }).result);
  eq("result high word is zero", originalRngStep({ d0: 0, range: 0xffff, tod: 0, seed: byteFF }).result >>> 16, 0);
}

// ---- sweep against the reference -------------------------------------------------------------------------------------------
{
  let state = 0x9e3779b9;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  let mismatches = 0, carries = 0, wraps = 0, byte1 = 0, preserved = true;
  for (let i = 0; i < 20000; i++) {
    const input = { d0: next(), range: next() & 0x1ffff, tod: next() & 0xff, seed: next() };
    const out = originalRngStep(input);
    const ref = reference(input);
    if (out.seed !== ref.seed || out.result !== ref.result) mismatches++;
    if (out.d0 !== input.d0) preserved = false;
    if (ref.overflowed) wraps++;
    if (input.d0 & 0xff00) byte1++;
    if ((((((input.d0 & ~0xff) | input.tod) & 0xffff) * 13) & 0xff) >= 249) carries++;
    if (out.result >= Math.max(input.range & 0xffff, 1)) mismatches++;
  }
  eq("sweep: 20000 random calls match the reference", mismatches, 0);
  eq("sweep: D0 preserved", preserved, true);
  eq("sweep: exercised carries", carries > 100, true);
  eq("sweep: exercised add.l wraps", wraps > 100, true);
  eq("sweep: exercised nonzero D0 byte 1", byte1 > 1000, true);
}

// ---- chained model -------------------------------------------------------------------------------------------------------------
{
  const m = new OriginalRngModel(1);
  const a = m.draw(0, 100, 0);
  eq("model draw 1 seed", m.seed, 36);
  eq("model draw 1 result", a.result, 14);
  const b = m.draw100(0, 0);
  eq("model draw 2 equals pure step from the new seed", b.seed, originalRngStep({ d0: 0, range: 100, tod: 0, seed: 36 }).seed);
  m.seed = -1;
  eq("seed setter masks to 32 bits", m.seed, 0xffffffff);
}

// ---- 2. optional raw capture ---------------------------------------------------------------------------------------------------
const traceEnv = process.env.UTOPIA_PRODUCTION_TRACE_DIR;
if (!traceEnv) {
  console.log("raw capture check skipped: UTOPIA_PRODUCTION_TRACE_DIR is not set (local Copperline capture directory, optional)");
} else {
  try {
    const dir = path.resolve(traceEnv);
    let base = dir;
    if (!fs.existsSync(path.join(base, "rng-tape-seg2.jsonl")) && fs.existsSync(path.join(base, "out", "rng-tape-seg2.jsonl"))) base = path.join(base, "out");
    const rows = loadRawRngRows([path.join(base, "rng-tape-seg1.jsonl"), path.join(base, "rng-tape-seg2.jsonl")]);
    rows.sort((a, b) => a.n - b.n);
    if (rows.length !== 50 || rows.some((r, i) => r.n !== i + 1)) throw new Error(`expected raw rng rows n=1..50, found ${rows.length} (n ${rows.map((r) => r.n).join(",")})`);
    let mismatches = 0, chainBreaks = 0, d0Byte1 = 0, d0AfterTodBad = 0;
    const sites = new Set();
    rows.forEach((r, i) => {
      sites.add(r.retText);
      const out = originalRngStep({ d0: r.d0, range: r.range, tod: r.tod, seed: r.seedBefore });
      if (out.seed !== r.seedAfter || out.result !== r.result) { mismatches++; console.log(`FAIL capture row ${r.n}: computed seed ${out.seed.toString(16)} result ${out.result}, recorded ${r.seedAfter.toString(16)} / ${r.result}`); }
      if (out.d0AfterTod !== r.d0AfterTod) d0AfterTodBad++;
      if (i > 0 && r.seedBefore !== rows[i - 1].seedAfter) chainBreaks++;
      if (r.d0 & 0xff00) d0Byte1++;
    });
    eq("capture: 50 raw calls recomputed from recorded D0/range/TOD/seed", mismatches, 0);
    eq("capture: recorded D0-after-TOD matches", d0AfterTodBad, 0);
    eq("capture: seed chain n=1..50 continuous", chainBreaks, 0);
    console.log(`raw capture: ${rows.length} calls, ${sites.size} distinct call sites (${[...sites].join(" ")}), ${d0Byte1} call(s) with nonzero D0 bits 8..15; ` +
      "arithmetic only: call-site coverage (7 of 62) and the seed initialiser are not established by this check");
  } catch (e) {
    failures++;
    console.log(`FAIL raw capture explicitly requested but unusable: ${e.message}`);
  }
}

if (failures > 0) { console.log(`original-rng: ${failures} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`original-rng: ${checks} checks passed (model arithmetic only; not wired into Sim)`);
