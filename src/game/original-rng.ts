// The original's random routine `$2DCC` / `$2DCA` as a pure, isolated arithmetic model.
//
// This module is NOT the engine's default generator: `Sim` still uses the seeded `createRng` of sim-math.ts, and no call site is
// switched to this model. It exists so that (a) the arithmetic can be unit-tested against the static disassembly and a raw
// Copperline capture, and (b) the optional original-vs-remake comparators can COMPUTE the original's results from the recorded
// inputs instead of injecting them.
//
// Static routine (68020 code, notes/formats/sim-port.md "Monthly RNG tape"):
//   $2DCA  moveq  #100,D2          ; default range, falls through
//   $2DCC  save D0,D1,D3 (restored on return)
//          move.b $BFE801,D0       ; CIA-A TOD low byte -> D0.b ONLY (D0 bits 8..31 keep the caller's value)
//          mulu.w #13,D0           ; D0 = (D0 & $FFFF) * 13 (32 bit)
//          addq.b #7,D0            ; byte add, wraps inside the low byte, NO carry into bit 8
//          move.l $2EA0,D1         ; seed
//          rol.l  #3,D1
//          move.l D1,D3
//          mulu.w D3,D0            ; D0 = (D0 & $FFFF) * (D3 & $FFFF)
//          lsr.l  #1,D0
//          add.l  D0,D1
//          move.l D1,$2EA0         ; new seed
//          D1.b -> D0 (zero ext.)  ; D0 = D1 & $FF
//          mulu.w D0,D2            ; D2 = (D2 & $FFFF) * (D1 & $FF)
//          lsr.l  #8,D2            ; result 0 .. range-1, in D2
//          restore D0,D1,D3
//
// Verification status (kept separate on purpose):
//   - Arithmetic: matches 50 raw calls of one local Copperline capture (zero mismatches in an independent recomputation and in
//     test/original-rng.mjs when UTOPIA_PRODUCTION_TRACE_DIR is set). In that capture D0 bits 8..15 were always zero, so the
//     nonzero-byte-1 behaviour is derived from the instruction semantics above and covered by synthetic vectors only.
//   - Static call-site inventory and per-site context audit: 62 direct sites in the loaded image (44 call `$2DCA`, 18 call
//     `$2DCC`); only 7 appear in the capture. See `notes/formats/original-rng-callers.md` for D0/D2 setup, premises and
//     unresolved paths. The audit is static, not a reachability proof; many contexts remain data- or caller-dependent, so
//     this model cannot run the game: `d0` is an explicit input of every draw.
//   - `$2DA0` reads CIA-A TOD hi/mid/low, substitutes a second mid-byte read when low is zero, multiplies the resulting
//     mid/low word by VHPOSR (`$DFF006`), then stores the 32-bit product at `$2EA0`. No caller/reference was found in the
//     scanned game image, and boot-stage/slave literal scans found no `$2EA0` address. The image contains `$BFE0450D` at
//     `$2EA0`; this supports an image default, not a verified runtime seed. No capture exists before the first draw, and
//     indirect startup writes or execution of `$2DA0` have not been excluded. CIA TOD is a hardware input to `$2DCC` too.

const U32 = 0xffffffff;

/** Inputs of one `$2DCC` call. All values are taken modulo their register width. */
export interface OriginalRngInput {
  /** Caller's D0 at entry (only bits 8..15 matter besides the byte replaced by TOD; all of D0 is restored on return). */
  d0: number;
  /** D2 on entry: the range. Only the low word is used by `mulu.w`; `$2DCA` supplies 100. */
  range: number;
  /** CIA-A TOD low byte read from `$BFE801`. */
  tod: number;
  /** Seed at `$2EA0` before the call. */
  seed: number;
}

/** Outputs of one `$2DCC` call. */
export interface OriginalRngOutput {
  /** Seed written back to `$2EA0`. */
  seed: number;
  /** D2 on return: the draw, 0 .. (range & $FFFF) - 1 (high word is always zero; 0 when the range word is 0). */
  result: number;
  /** D0 after `move.b $BFE801,D0` (kept for diagnostics and capture cross-checks; NOT the caller-visible D0). */
  d0AfterTod: number;
  /** Caller-visible D0 on return: restored, always equal to the input `d0` (as unsigned 32 bit). */
  d0: number;
}

const mulu = (a: number, b: number): number => Math.imul(a & 0xffff, b & 0xffff) >>> 0;

/** One call of `$2DCC` with explicit range. Pure: no hidden state. */
export function originalRngStep(input: OriginalRngInput): OriginalRngOutput {
  const callerD0 = input.d0 >>> 0;
  // move.b $BFE801,D0: only the low byte is replaced.
  const d0AfterTod = ((callerD0 & ~0xff) | (input.tod & 0xff)) >>> 0;
  // mulu.w #13,D0 (low word * 13, 32-bit result), addq.b #7,D0 (low byte only, wraps without carry).
  let d0 = mulu(d0AfterTod, 13);
  d0 = ((d0 & ~0xff) | ((d0 + 7) & 0xff)) >>> 0;
  // rol.l #3 on the seed; D3 = rotated seed; mulu.w D3,D0; lsr.l #1; add.l into the rotated seed.
  const s = input.seed >>> 0;
  const rotated = ((s << 3) | (s >>> 29)) >>> 0;
  d0 = mulu(d0, rotated) >>> 1;
  const seed = (rotated + d0) & U32;
  // D0 = seed.b zero-extended; mulu.w D0,D2; lsr.l #8,D2.
  const result = mulu(input.range, seed & 0xff) >>> 8;
  return { seed: seed >>> 0, result, d0AfterTod, d0: callerD0 };
}

/** `$2DCA`: `moveq #100,D2` then `$2DCC`. */
export function originalRngStep100(input: Omit<OriginalRngInput, "range">): OriginalRngOutput {
  return originalRngStep({ ...input, range: 100 });
}

/**
 * Seed holder for callers that chain draws (`$2EA0`). Not an `Rng`: the original needs D0 and the hardware TOD byte per call,
 * neither of which the remake's call sites supply.
 */
export class OriginalRngModel {
  #seed: number;

  constructor(seed: number) {
    this.#seed = seed >>> 0;
  }

  get seed(): number {
    return this.#seed;
  }

  set seed(value: number) {
    this.#seed = value >>> 0;
  }

  /** Draw with explicit range (`$2DCC`); advances the seed. */
  draw(d0: number, range: number, tod: number): OriginalRngOutput {
    const out = originalRngStep({ d0, range, tod, seed: this.#seed });
    this.#seed = out.seed;
    return out;
  }

  /** Draw with the `$2DCA` default range of 100. */
  draw100(d0: number, tod: number): OriginalRngOutput {
    return this.draw(d0, 100, tod);
  }
}
