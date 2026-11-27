// Capture-backed check of the original random routine `$2DCC` (src/game/original-rng.ts) against the tutorial first-pass
// capture of 2026-11-12 (notes/formats/game-proper.md, "Births draw observed"). Run after `npm run build`.
//
// Scope, kept separate on purpose:
//   1. BIRTHS FIXTURE (always runs; numbers only): the births call `$9BCC` -> `$9BD2` of that capture: D0 = D2 = 30, seed before
//      $A9851FE5, seed after $51DE46DF, observed D2 result 26. The result is COMPUTED by the model; the observed 26 is only compared.
//      The capture records no TOD byte, so the TOD is found by searching the 256 byte values for the one that reproduces the
//      observed seed. The fixture pins that inferred byte ($E1), labelled as an inference.
//   2. CHAIN (optional; set UTOPIA_TUTORIAL_CAPTURE_DIR to the capture folder that holds route2-capture.json, or its out/): the
//      32 recorded `$2DCC` entries (D0, D2 at entry, frame, return address, seed before). Every seed-to-seed link (31) must be
//      reproduced by exactly one TOD byte. Calls in the same frame share one byte, and the two frames differ by the frame count
//      (6 frames, $DB then $E1). The TOD bytes are INFERRED, not observed: the capture does not record TOD, and the one-step-per-
//      frame pattern rests on one pair of frames. A set-but-unusable path fails; an unset variable skips only this section.
//   3. CONTROLS: changing the TOD byte changes the births seed, and a seed that is not on the chain yields no TOD byte.
//
// NOT covered: the TOD source itself (CIA-A `$BFE801` is not modelled in the engine), the D0 of the other call sites, the seed
// before the first draw of a boot (the tutorial's first recorded seed equals the image default `$BFE0450D`; see the notes), and
// the game-wide `Sim` (not wired: `Sim` keeps its own generator).

import fs from "node:fs";
import path from "node:path";
import { originalRngStep } from "../dist/game/original-rng.js";

let failures = 0;
let checks = 0;
const eq = (name, got, want) => {
  checks++;
  if (got !== want) {
    failures++;
    const show = (v) => (typeof v === "number" ? "0x" + (v >>> 0).toString(16) : JSON.stringify(v));
    console.log(`FAIL ${name}: got ${show(got)}, want ${show(want)}`);
  }
};

/** Every TOD byte (0..255) that makes one `$2DCC` step (d0, range, seed) produce `seedAfter`. Pure search over the model. */
function todBytesForSeed({ d0, range, seed }, seedAfter) {
  const found = [];
  for (let tod = 0; tod < 256; tod++) {
    const o = originalRngStep({ d0, range, tod, seed });
    if (o.seed === (seedAfter >>> 0)) found.push({ tod, result: o.result });
  }
  return found;
}

// ---- 1. births fixture (tutorial first pass, one call) -----------------------------------------------------------------------
const BIRTHS = { d0: 30, range: 30, seedBefore: 0xa9851fe5, seedAfter: 0x51de46df, observedResult: 26, inferredTod: 0xe1 };
{
  const hits = todBytesForSeed({ d0: BIRTHS.d0, range: BIRTHS.range, seed: BIRTHS.seedBefore }, BIRTHS.seedAfter);
  eq("births: exactly one TOD byte reproduces the observed seed", hits.length, 1);
  eq("births: the inferred TOD byte", hits[0]?.tod, BIRTHS.inferredTod);
  eq("births: computed draw equals the observed D2 result", hits[0]?.result, BIRTHS.observedResult);
  // The result is computed from the explicit inputs; the same call with a different TOD must not reproduce both observations.
  const other = originalRngStep({ d0: BIRTHS.d0, range: BIRTHS.range, tod: BIRTHS.inferredTod ^ 1, seed: BIRTHS.seedBefore });
  eq("births: a neighbouring TOD byte does not reproduce the seed", other.seed === BIRTHS.seedAfter, false);
  // A seed that no TOD byte maps to from the births inputs must yield no candidate (the search is not vacuous).
  eq("births: a seed off the reachable set yields no TOD byte", todBytesForSeed({ d0: BIRTHS.d0, range: BIRTHS.range, seed: BIRTHS.seedBefore }, BIRTHS.seedAfter ^ 0x1).length, 0);
}

// ---- 2. optional full chain from the capture folder -------------------------------------------------------------------------
const captureEnv = process.env.UTOPIA_TUTORIAL_CAPTURE_DIR;
if (!captureEnv) {
  console.log("tutorial chain check skipped: UTOPIA_TUTORIAL_CAPTURE_DIR is not set (local Copperline capture folder, optional)");
} else {
  try {
    const dir = path.resolve(captureEnv);
    let file = path.join(dir, "route2-capture.json");
    if (!fs.existsSync(file)) file = path.join(dir, "out", "route2-capture.json");
    if (!fs.existsSync(file)) throw new Error("route2-capture.json not found in the folder (or its out/)");
    const cap = JSON.parse(fs.readFileSync(file, "utf8"));
    const hits = cap.rng_hits;
    if (!Array.isArray(hits) || hits.length !== 32) throw new Error(`expected 32 rng_hits, found ${Array.isArray(hits) ? hits.length : "none"}`);
    const u32 = (text, label) => {
      if (typeof text !== "string" || !/^[0-9a-f]{1,8}$/i.test(text)) throw new Error(`${label}: not a hex word (${text})`);
      return parseInt(text, 16) >>> 0;
    };
    const rows = hits.map((h, i) => {
      if (!Number.isInteger(h.d0) || h.d0 < 0 || h.d0 > 0xffffffff) throw new Error(`hit ${i + 1}: bad d0`);
      if (!Number.isInteger(h.d2_entry) || h.d2_entry < 0 || h.d2_entry > 0xffffffff) throw new Error(`hit ${i + 1}: bad d2_entry`);
      if (!Number.isInteger(h.frame) || h.frame < 0) throw new Error(`hit ${i + 1}: bad frame`);
      return {
        d0: h.d0 >>> 0,
        range: h.d2_entry & 0xffff,
        ret: u32(h.return_addr, `hit ${i + 1} return_addr`),
        seed: u32(h.seed_before, `hit ${i + 1} seed_before`),
        frame: h.frame,
      };
    });
    // Each link (hit i -> hit i+1) is a call made at hit i's frame. The TOD byte of that call is INFERRED as the unique byte
    // that reproduces hit i+1's seed. The capture records no TOD, so this is a derived value, not an observation.
    const tods = [];
    let unmatched = 0, ambiguous = 0;
    for (let i = 0; i + 1 < rows.length; i++) {
      const found = todBytesForSeed(rows[i], rows[i + 1].seed);
      if (found.length === 0) unmatched++;
      if (found.length > 1) ambiguous++;
      tods.push({ frame: rows[i].frame, tod: found.length === 1 ? found[0].tod : null });
    }
    eq("chain: every seed-to-seed link has a TOD byte", unmatched, 0);
    eq("chain: no link has more than one TOD byte", ambiguous, 0);
    eq("chain: 31 links resolved", tods.filter((t) => t.tod !== null).length, rows.length - 1);
    // Market walk control flow ($A7AE, notes/formats/original-rng-callers.md section 6.4): the first draw ($A7BA, range 4) returns
    // 0..3; its second draw ($A7CC, range max-min) runs only when the first is nonzero (`tst.b d2` / `beq $A800`). Each draw stays
    // below its range. Results come from the model with the inferred TOD of each link, so this is a check of the model's output
    // against the traced branch, not a new TOD observation.
    {
      let firstZero = 0, firstNonzero = 0, walkBad = 0;
      for (let i = 0; i + 1 < rows.length; i++) {
        if (tods[i].tod === null) continue;
        const r = originalRngStep({ d0: rows[i].d0, range: rows[i].range, tod: tods[i].tod, seed: rows[i].seed }).result;
        if (rows[i].ret === 0xa7c0) {
          if (r > 3) walkBad++;
          const nextIsSecond = rows[i + 1].ret === 0xa7d2;
          if (r === 0) firstZero++; else firstNonzero++;
          if (nextIsSecond !== (r !== 0)) walkBad++;
        } else if (rows[i].ret === 0xa7d2) {
          if (r >= rows[i].range) walkBad++;
        }
      }
      eq("chain: market walk draws stay below their ranges and the second draw follows a nonzero first draw", walkBad, 0);
      eq("chain: market walk: first draws returning 0 (second draw skipped)", firstZero, 1);
      eq("chain: market walk: first draws returning nonzero (second draw taken)", firstNonzero, 11);
    }
    // Calls in one frame share one inferred TOD byte (the capture: frame 14327 for 30 calls, frame 14321 for the first).
    const byFrame = new Map();
    for (const t of tods) {
      if (t.tod === null) continue;
      if (!byFrame.has(t.frame)) byFrame.set(t.frame, new Set());
      byFrame.get(t.frame).add(t.tod);
    }
    eq("chain: calls in one frame share one inferred TOD byte", [...byFrame.values()].every((s) => s.size === 1), true);
    eq("chain: two frames observed", byFrame.size, 2);
    // Hypothesis (two frames, one pair): the inferred TOD advances by the frame difference. Recorded as a check, not as a model.
    const frames = [...byFrame.keys()].sort((a, b) => a - b);
    const todAt = (f) => [...byFrame.get(f)][0];
    if (frames.length === 2) {
      const step = (todAt(frames[1]) - todAt(frames[0]) + 256) & 0xff;
      eq("chain: inferred TOD step equals the frame step (6 frames, 6 units)", step, (frames[1] - frames[0]) & 0xff);
      console.log(`chain: inferred TOD $${todAt(frames[0]).toString(16)} at frame ${frames[0]}, $${todAt(frames[1]).toString(16)} at frame ${frames[1]} (inferred; the capture has no TOD column)`);
    }
    // The births link must be the last of the chain and agree with the fixture.
    const births = rows.findIndex((r) => r.ret === 0x9bd2);
    eq("chain: births call is hit 31 (index 30)", births, 30);
    eq("chain: births call seed before equals the fixture", rows[births]?.seed, BIRTHS.seedBefore);
    eq("chain: the call after births starts from the births seed after", rows[births + 1]?.seed, BIRTHS.seedAfter);
    const observed = cap.births_hits?.[0]?.d2_result;
    eq("chain: births_hits D2 result equals the fixture", observed, BIRTHS.observedResult);
    const first = rows[0]?.seed;
    eq("chain: first recorded seed equals the image default $2EA0 ($BFE0450D)", first, 0xbfe0450d);
    // The first draw is the boot-exit marker call ($157B8 -> $11476), not event 1: its return is $1148A (call at $11484)
    // and its range is the marker count $144A6 = 10. Event 1 would first draw roll(100) at $1146A, which the seed link rules out.
    eq("chain: first draw returns to $1148A (call at $11484 inside $11476)", rows[0]?.ret, 0x1148a);
    eq("chain: first draw range is the marker count $144A6 (10)", rows[0]?.range, 10);
  } catch (e) {
    failures++;
    console.log(`FAIL tutorial chain explicitly requested but unusable: ${e.message}`);
  }
}

if (failures > 0) {
  console.log(`original-rng-tutorial: ${failures} failure(s) in ${checks} checks`);
  process.exit(1);
}
console.log(`original-rng-tutorial: ${checks} checks passed (model arithmetic against capture numbers; not wired into Sim)`);
