// 68000 arithmetic helpers and the injectable random generator used by the simulation.
// The original works on 16/32-bit registers with truncating multiplies and divides; the
// helpers reproduce those semantics where the simulation depends on them.

export const s8 = (x: number): number => (x << 24) >> 24;
export const s16 = (x: number): number => (x << 16) >> 16;

// mulu.w: low words multiplied, 32-bit unsigned result.
export const mulu = (a: number, b: number): number => ((a & 0xffff) * (b & 0xffff)) >>> 0;

// muls.w: signed low words, 32-bit signed result.
export const muls = (a: number, b: number): number => (s16(a) * s16(b)) | 0;

// divu.w: whole destination register. 32-bit unsigned dividend / 16-bit divisor; low word =
// quotient, high word = remainder. On overflow (quotient > $FFFF) or a zero divisor the
// register keeps its old value (the original would trap on zero; the game never does that).
export function divuReg(num: number, den: number): number {
  num >>>= 0;
  den &= 0xffff;
  if (den === 0) return num;
  const q = Math.floor(num / den);
  if (q > 0xffff) return num;
  return (((num - q * den) << 16) | q) >>> 0;
}

// divu.w followed by ext.l: the quotient as a sign-extended word.
export const divuQ = (num: number, den: number): number => s16(divuReg(num, den) & 0xffff);

// divs.w followed by ext.l: signed 32-bit dividend / signed 16-bit divisor, truncating.
export function divsQ(num: number, den: number): number {
  den = s16(den);
  if (den === 0) return s16(num);
  const q = Math.trunc(num / den);
  if (q < -32768 || q > 32767) return s16(num); // overflow: register unchanged
  return q;
}

// Random numbers: rng(range) returns 0..range-1, like the original $2DCC (d2 = range).
export type Rng = (range: number) => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return (range: number): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return range > 0 ? Math.floor(r * range) : 0;
  };
}
