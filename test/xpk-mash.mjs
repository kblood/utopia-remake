// Synthetic coverage of the bounded XPKF/MASH decoder (src/data/xpk-mash.ts) and its composition
// with the raw Disk.4 parser (parseDisk4Input). No original data is required: containers and MASH
// streams are produced here by a small test-only encoder. One optional golden check at the end
// uses the player's local original/ files and is skipped when they are absent.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  unpackXpkMash, isXpkContainer, XPK_MAX_INPUT_BYTES, XPK_MAX_OUTPUT_BYTES, XPK_MAX_CHUNKS,
} = await import("../dist/data/xpk-mash.js");
const {
  parseDisk4, parseDisk4Input, readDisk4Slot, DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT,
} = await import("../dist/data/disk4.js");

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !extra ? "" : ` (${extra})`}`); if (!ok) failed++; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- deterministic data -------------------------------------------------------------------------
let seed = 12345;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const WORDS = ["utopia", "colony", "energy", "reactor", "mine", "defense", "alien"].map((s) => [...s].map((c) => c.charCodeAt(0)));
function soup(n) {
  const r = [];
  while (r.length < n) { r.push(...WORDS[rnd(WORDS.length)]); if (rnd(3) === 0) r.push(rnd(256)); }
  return Uint8Array.from(r.slice(0, n));
}
const randomBytes = (n) => Uint8Array.from({ length: n }, () => rnd(256));

// ---- test-only MASH encoder (mirrors the decoder's bit order) ------------------------------------
// Control bits are packed MSB first into "slots"; literal bytes are appended to the stream directly,
// so they never disturb a partly used control byte (this is the quirk the decoder must reproduce).
class BitEnc {
  constructor() { this.out = []; this.slot = -1; this.free = 0; }
  bits(v, n) {
    for (let i = n - 1; i >= 0; i--) {
      if (this.free === 0) { this.slot = this.out.length; this.out.push(0); this.free = 8; }
      this.free--;
      if ((v >>> i) & 1) this.out[this.slot] |= 1 << this.free;
    }
  }
  byte(b) { this.out.push(b); }
}
const VLC_BITS = [5, 7, 9, 10, 11, 12, 13, 14];
const VLC_OFF = [0, 32, 160, 672, 1696, 3744, 7840, 16032];
function vlc(e, d) {
  let k = 7;
  while (d < VLC_OFF[k]) k--;
  e.bits(k, 3);
  e.bits(d - VLC_OFF[k], VLC_BITS[k]);
}
function unary(e, v) { // v in [2^L, 2^(L+1)): L-1 ones, a zero, then L low bits
  let L = 1;
  while (v >= (1 << (L + 1))) L++;
  for (let i = 1; i < L; i++) e.bits(1, 1);
  e.bits(0, 1);
  e.bits(v - (1 << L), L);
}
function litLen(e, n) {
  if (n <= 5) { e.bits(((1 << n) - 1) << 1, n + 1); return; }
  e.bits(0b111111, 6);
  unary(e, n - 4);
}
function matchCode(e, dist, count) {
  if (count === 2 && dist < 512) { e.bits(0, 1); e.bits(0, 1); e.bits(dist, 9); return; }
  if (count === 3) { e.bits(0, 1); e.bits(1, 1); vlc(e, dist); return; }
  if (count < 4) throw new Error(`test encoder cannot encode count ${count} dist ${dist}`);
  e.bits(1, 1);
  unary(e, count - 2);
  vlc(e, dist);
}
/** tokens: { lit: number[], dist, count }; dist 0 is the spare end match. */
function encodeTokens(tokens) {
  const e = new BitEnc();
  for (const t of tokens) {
    litLen(e, t.lit.length);
    for (const b of t.lit) e.byte(b);
    matchCode(e, t.dist, t.count);
  }
  return Uint8Array.from(e.out);
}
/** Reference expansion of the same tokens (overlap allowed, final match clipped to rawLen). */
function expand(tokens, rawLen = Infinity) {
  const out = [];
  for (const t of tokens) {
    for (const b of t.lit) out.push(b);
    if (t.dist === 0) continue;
    const count = Math.min(t.count, rawLen - out.length);
    for (let i = 0; i < count; i++) out.push(out[out.length - t.dist]);
  }
  return Uint8Array.from(out);
}
function greedyTokens(raw) {
  const tokens = [];
  let p = 0, litStart = 0;
  while (p < raw.length) {
    let bestLen = 0, bestDist = 0;
    for (let d = 1; d <= p; d++) {
      let l = 0;
      while (p + l < raw.length && l < 300 && raw[p + l] === raw[p + l - d]) l++;
      if (l > bestLen) { bestLen = l; bestDist = d; }
    }
    if (bestLen >= 3 || (bestLen === 2 && bestDist < 512)) {
      tokens.push({ lit: Array.from(raw.subarray(litStart, p)), dist: bestDist, count: bestLen });
      p += bestLen; litStart = p;
    } else p++;
  }
  if (litStart < raw.length) tokens.push({ lit: Array.from(raw.subarray(litStart)), dist: 0, count: 2 });
  return tokens;
}
/** Cheap tokenizer for mostly-zero data: runs of >= 3 zeros become one dist-1 match. */
function rleTokens(raw) {
  const tokens = [];
  let lit = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === 0) {
      let j = i;
      while (j < raw.length && raw[j] === 0) j++;
      if (j - i >= 3) { lit.push(0); tokens.push({ lit, dist: 1, count: j - i - 1 }); lit = []; i = j; continue; }
    }
    lit.push(raw[i]); i++;
  }
  if (lit.length) tokens.push({ lit, dist: 0, count: 2 });
  return tokens;
}

// ---- test-only XPKF container builder ------------------------------------------------------------
const put32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const xor = (b, s = 0, e = b.length) => { let x = 0; for (let i = s; i < e; i++) x ^= b[i]; return x; };
function sum16(p) { let hi = 0, lo = 0; p.forEach((v, i) => { if (i & 1) lo ^= v; else hi ^= v; }); return (hi << 8) | lo; }
/** One chunk: 12-byte long header, payload, zero (or `padFill`) padding to 4 bytes. */
function chunk(type, payload, rawLen, o = {}) {
  payload = Uint8Array.from(payload);
  const h = new Uint8Array(12);
  h[0] = type;
  const sum = o.sum ?? sum16(payload);
  h[2] = sum >> 8; h[3] = sum & 255;
  put32(h, 4, o.packed ?? payload.length);
  put32(h, 8, rawLen);
  h[1] = xor(h);
  return cat(h, payload, new Uint8Array((4 - (payload.length & 3)) & 3).fill(o.padFill ?? 0));
}
const endChunk = () => { const h = new Uint8Array(12); h[0] = 15; h[1] = 15; return h; };
function fixMain(b) { b[33] = 0; b[33] = xor(b, 0, 36); }
function fixChunkHeader(b, off) { b[off + 1] = 0; b[off + 1] = xor(b, off, off + 12); }
function container(chunks, rawLen, o = {}) {
  const flags = o.flags ?? 1;
  const raw = o.raw ?? new Uint8Array(0);
  const head = new Uint8Array(36);
  head.set([0x58, 0x50, 0x4b, 0x46], 0);
  head.set([...(o.codec ?? "MASH")].map((c) => c.charCodeAt(0)), 8);
  put32(head, 12, rawLen);
  head.set(raw.subarray(0, Math.min(16, raw.length)), 16);
  if (o.prefix) head.set(o.prefix, 16);
  head[32] = flags;
  const parts = [head];
  if (flags & 4) {
    const ext = o.ext ?? new Uint8Array(0);
    const len = o.extLen ?? ext.length;
    parts.push(Uint8Array.of(len >> 8, len & 255), ext);
  }
  let pos = parts.reduce((s, p) => s + p.length, 0);
  const offs = [];
  for (const c of chunks) { offs.push(pos); parts.push(c); pos += c.length; }
  offs.push(pos);
  if (!o.omitEnd) parts.push(o.end ?? endChunk());
  if (o.tail) parts.push(o.tail);
  const bytes = cat(...parts);
  put32(bytes, 4, bytes.length - 8 + (o.sizeDelta ?? 0));
  fixMain(bytes);
  return { bytes, offs };
}
const mutated = (b, fn) => { const c = b.slice(); fn(c); return c; };
const errCode = (r) => (r.ok ? "ok" : r.error.code);
function expectCode(name, input, code, opts) {
  const r = unpackXpkMash(input, opts);
  check(`${name} -> ${code}`, errCode(r) === code, `got ${errCode(r)}${r.ok ? "" : `: ${r.error.message}`}`);
  return r;
}
/** Single MASH chunk container holding the expansion of `tokens`. */
function mashContainer(tokens, rawLen) {
  const raw = expand(tokens, rawLen);
  return { raw, ...container([chunk(1, encodeTokens(tokens), raw.length)], raw.length, { raw }) };
}
/** Single MASH chunk with a hand-written payload (decode errors). */
const badMash = (payload, rawLen) => container([chunk(1, payload, rawLen)], rawLen).bytes;

// Standard 3-chunk fixture: raw chunk + two MASH chunks.
function standard() {
  const raw = soup(3000);
  const m1 = encodeTokens(greedyTokens(raw.subarray(1000, 2000)));
  const m2 = encodeTokens(greedyTokens(raw.subarray(2000, 3000)));
  const chunks = [chunk(0, raw.subarray(0, 1000), 1000), chunk(1, m1, 1000), chunk(1, m2, 1000)];
  return { raw, chunks, payloads: [raw.slice(0, 1000), m1, m2], ...container(chunks, 3000, { raw }) };
}

// ---- limits ---------------------------------------------------------------------------------------
check("documented limits", XPK_MAX_INPUT_BYTES === 2 * 1024 * 1024 && XPK_MAX_OUTPUT_BYTES === 1024 * 1024 && XPK_MAX_CHUNKS === 4096);

// ---- valid decoding -------------------------------------------------------------------------------
{
  const s = standard();
  const before = s.bytes.slice();
  const r = unpackXpkMash(s.bytes);
  check("standard container unpacks", r.ok && eq(r.value.bytes, s.raw));
  check("info fields", r.ok && r.value.rawLength === 3000 && r.value.packedLength === s.bytes.length && r.value.headerLength === 36 &&
    r.value.extendedHeaderLength === 0 && r.value.prefixVerified === true);
  check("chunk list", r.ok && r.value.chunks.map((c) => c.type).join() === "raw,mash,mash" &&
    r.value.chunks.map((c) => c.outputOffset).join() === "0,1000,2000" && r.value.chunks[1].headerOffset === s.offs[1] &&
    r.value.chunks[1].packedLength === s.payloads[1].length && r.value.chunks.every((c) => c.rawLength === 1000));
  check("input not modified", eq(s.bytes, before));
  if (r.ok) { s.bytes.fill(0); check("output is an independent buffer", eq(r.value.bytes, s.raw)); }
  check("isXpkContainer", isXpkContainer(before) && !isXpkContainer(new Uint8Array(40)) && !isXpkContainer(new Uint8Array(3)) && !isXpkContainer([0x58, 0x50, 0x4b, 0x46]));
}

// Hand-assembled stream (independent of the test encoder): literal "AB", then match(count 2, dist 2).
// C0 = litlen 2 ("110") + match bits "00" + 3 high distance bits; the literals sit between the control
// bytes; 08 = remaining distance bits "000010". Output "ABAB".
{
  const raw = Uint8Array.of(0x41, 0x42, 0x41, 0x42);
  const r = unpackXpkMash(container([chunk(1, [0xc0, 0x41, 0x42, 0x08], 4)], 4, { raw }).bytes);
  check("hand-built stream: literals bypass buffered control bits", r.ok && eq(r.value.bytes, raw));
}

// Overlapping back-reference repeats the pattern; matching spans extended count lengths.
{
  const m = mashContainer([{ lit: [0x41], dist: 1, count: 20 }, { lit: [], dist: 1, count: 3 }]);
  const r = unpackXpkMash(m.bytes);
  check("overlapping match (dist 1)", r.ok && r.value.bytes.length === 24 && r.value.bytes.every((v) => v === 0x41));
  const m2 = mashContainer([{ lit: [1, 2, 3], dist: 3, count: 9 }]);
  const r2 = unpackXpkMash(m2.bytes);
  check("overlapping match (dist 3, repeats pattern)", r2.ok && eq(r2.value.bytes, [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]));
}

// Every distance class boundary, extended literal and match length boundaries.
{
  const tokens = [{ lit: Array.from(randomBytes(33000)), dist: 16100, count: 5 }];
  for (const d of [7900, 3800, 1700, 700, 200, 40, 31, 32, 159, 160, 671, 672, 1695, 1696, 3743, 3744, 7839, 7840, 16031, 16032, 32415, 1, 511]) {
    tokens.push({ lit: [], dist: d, count: 3 });
  }
  tokens.push({ lit: [], dist: 20, count: 2 }, { lit: [], dist: 511, count: 2 });
  for (const n of [0, 1, 5, 6, 7, 8, 11, 12, 19, 20, 100, 1000]) tokens.push({ lit: Array.from(randomBytes(n)), dist: 1, count: 3 });
  for (const c of [4, 5, 6, 9, 10, 17, 18, 33, 34, 65, 66, 129, 257, 1000, 3000]) tokens.push({ lit: [], dist: 1, count: c });
  const m = mashContainer(tokens);
  const r = unpackXpkMash(m.bytes);
  check("distance classes, literal and match length boundaries", r.ok && eq(r.value.bytes, m.raw), r.ok ? "" : r.error.message);
}

// Greedy-compressed text, a trailing literal run (spare zero-distance match), and per-chunk history.
{
  const raw = soup(2500);
  const m = mashContainer(greedyTokens(raw));
  const r = unpackXpkMash(m.bytes);
  check("greedy-compressed data round-trips", r.ok && eq(r.value.bytes, raw));
  const t = [{ lit: [1, 2, 3], dist: 3, count: 6 }];
  const raw2 = expand(t);
  const two = container([chunk(1, encodeTokens(t), raw2.length), chunk(1, encodeTokens(t), raw2.length)], raw2.length * 2, { raw: cat(raw2, raw2) });
  const r2 = unpackXpkMash(two.bytes);
  check("history restarts in every chunk", r2.ok && eq(r2.value.bytes, cat(raw2, raw2)));
}

// EOF quirks: clipped final match; zero distance accepted only at the end; count-0 match still checks distance.
{
  const tokens = [{ lit: [0x41, 0x42], dist: 2, count: 20 }];
  const c = mashContainer(tokens, 10);
  const r = unpackXpkMash(c.bytes);
  check("final match longer than the chunk is clipped", r.ok && r.value.bytes.length === 10 && eq(r.value.bytes, [65, 66, 65, 66, 65, 66, 65, 66, 65, 66]));
  const abc = mashContainer([{ lit: [1, 2, 3], dist: 3, count: 5 }], 3);
  check("literals fill the chunk, clipped match has count 0", unpackXpkMash(abc.bytes).ok);
  const far = container([chunk(1, encodeTokens([{ lit: [1, 2, 3], dist: 4, count: 5 }]), 3)], 3);
  expectCode("count-0 match still validates its distance", far.bytes, "mash-bad-distance");
  const mid = container([chunk(1, encodeTokens([{ lit: [9], dist: 0, count: 2 }]), 5)], 5);
  expectCode("zero distance before the end is rejected", mid.bytes, "mash-bad-distance");
  const spare = mashContainer([{ lit: [1, 2, 3, 4, 5, 6, 7], dist: 0, count: 2 }]);
  check("trailing literals + spare zero-distance match accepted", unpackXpkMash(spare.bytes).ok);
}

// ---- MASH hardening -------------------------------------------------------------------------------
{
  const r = expectCode("literal unary prefix of 16 ones", badMash([0xff, 0xff, 0xfc], 10), "mash-literal-length");
  check("error carries chunk index", !r.ok && r.error.chunkIndex === 0);
  expectCode("17 ones form a huge literal run (reference quirk), caught as an overrun", badMash([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 10), "mash-literal-overrun");
  expectCode("match length unary prefix too long", badMash([0x7f, 0xff, 0x80], 10), "mash-match-length");
  expectCode("literal run overruns chunk", badMash([0xf8, 1, 2, 3, 4, 5], 3), "mash-literal-overrun");
  expectCode("literal bytes past payload end", badMash([0xc0], 4), "mash-truncated");
  expectCode("control bits past payload end", badMash([0xc0, 0x41, 0x42], 4), "mash-truncated");
  expectCode("payload ends inside the distance bits", badMash([0], 4), "mash-truncated");
  expectCode("match before any output", container([chunk(1, encodeTokens([{ lit: [], dist: 1, count: 2 }]), 4)], 4).bytes, "mash-bad-distance");

  // A back-reference into the previous chunk is invalid: history is per chunk.
  const prev = chunk(0, [65, 66, 67, 68], 4);
  const cross = container([prev, chunk(1, encodeTokens([{ lit: [0x41], dist: 2, count: 3 }]), 4)], 8);
  const rc = expectCode("cross-chunk reference rejected", cross.bytes, "mash-bad-distance");
  check("cross-chunk error names chunk 1", !rc.ok && rc.error.chunkIndex === 1);
}

// ---- container validation -------------------------------------------------------------------------
{
  const s = standard();
  const big = new Uint8Array(XPK_MAX_INPUT_BYTES + 1);
  expectCode("non-bytes", [1, 2, 3], "not-bytes");
  expectCode("null", null, "not-bytes");
  expectCode("input over the limit", big, "input-too-large");
  expectCode("shorter than the main header", new Uint8Array(35), "truncated-header");
  expectCode("no signature", new Uint8Array(64), "bad-signature");
  expectCode("main header checksum", mutated(s.bytes, (b) => { b[16] ^= 1; }), "header-checksum");
  expectCode("unsupported codec", mutated(s.bytes, (b) => { b.set([0x4e, 0x4f, 0x4e, 0x45], 8); fixMain(b); }), "unsupported-codec");
  expectCode("password flag", mutated(s.bytes, (b) => { b[32] = 3; fixMain(b); }), "password-protected");
  expectCode("unknown flag bit", mutated(s.bytes, (b) => { b[32] = 9; fixMain(b); }), "unsupported-flags");
  expectCode("short chunk headers", mutated(s.bytes, (b) => { b[32] = 0; fixMain(b); }), "unsupported-flags");
  expectCode("packed size zero", mutated(s.bytes, (b) => { put32(b, 4, 0); fixMain(b); }), "bad-packed-size");
  expectCode("packed size too small", container(s.chunks, 3000, { raw: s.raw, sizeDelta: -4 }).bytes, "bad-packed-size");
  expectCode("packed size too large", container(s.chunks, 3000, { raw: s.raw, sizeDelta: 4 }).bytes, "bad-packed-size");
  expectCode("raw size zero", container(s.chunks, 0, { raw: s.raw }).bytes, "bad-raw-size");
  expectCode("raw size over the output limit", mutated(s.bytes, (b) => { put32(b, 12, XPK_MAX_OUTPUT_BYTES + 1); fixMain(b); }), "output-too-large");
  expectCode("raw size 0xFFFFFFFF", mutated(s.bytes, (b) => { put32(b, 12, 0xffffffff); fixMain(b); }), "output-too-large");
  expectCode("trailing bytes after the end chunk", container(s.chunks, 3000, { raw: s.raw, tail: new Uint8Array(4) }).bytes, "trailing-data");
  expectCode("missing end chunk", container(s.chunks, 3000, { raw: s.raw, omitEnd: true }).bytes, "missing-end-chunk");
  expectCode("truncated chunk header", container(s.chunks, 3000, { raw: s.raw, omitEnd: true, tail: new Uint8Array(5) }).bytes, "truncated-chunk");
  expectCode("payload runs past the input", container([chunk(0, [1, 2, 3, 4], 4, { packed: 400 })], 4).bytes, "truncated-chunk");
  const hc = expectCode("chunk header checksum", mutated(s.bytes, (b) => { b[s.offs[1] + 9] ^= 1; }), "chunk-header-checksum");
  check("chunk header checksum names chunk 1", !hc.ok && hc.error.chunkIndex === 1);
  expectCode("chunk data checksum (flipped payload byte)", mutated(s.bytes, (b) => { b[s.offs[0] + 12 + 5] ^= 1; }), "chunk-checksum");
  expectCode("chunk data checksum (wrong field)", container([chunk(0, [1, 2, 3, 4], 4, { sum: 0x1234 })], 4).bytes, "chunk-checksum");
  expectCode("unsupported chunk type", container([chunk(2, [1, 2, 3, 4], 4)], 4).bytes, "unsupported-chunk-type");
  expectCode("non-zero padding", container([chunk(0, [1, 2, 3, 4, 5], 5, { padFill: 7 })], 5).bytes, "nonzero-padding");
  check("zero padding accepted", unpackXpkMash(container([chunk(0, [1, 2, 3, 4, 5], 5)], 5, { raw: Uint8Array.of(1, 2, 3, 4, 5) }).bytes).ok);
  expectCode("raw chunk packed != raw length", container([chunk(0, [1, 2, 3, 4], 5)], 5).bytes, "chunk-length");
  expectCode("empty chunk", container([chunk(0, [], 0)], 4).bytes, "chunk-length");
  const e1 = endChunk(); put32(e1, 4, 1); fixChunkHeader(e1, 0);
  expectCode("end chunk with a length", container([chunk(0, [1, 2, 3, 4], 4)], 4, { end: e1 }).bytes, "chunk-length");
  const e2 = endChunk(); e2[2] = 1; fixChunkHeader(e2, 0);
  expectCode("end chunk with a checksum", container([chunk(0, [1, 2, 3, 4], 4)], 4, { end: e2 }).bytes, "chunk-length");
  expectCode("chunks exceed the declared raw size", container([chunk(0, [1, 2, 3, 4, 5, 6, 7, 8], 8)], 4).bytes, "output-overrun");
  expectCode("chunks fall short of the declared raw size", container([chunk(0, [1, 2, 3, 4], 4)], 8).bytes, "output-size-mismatch");
}

// ---- extended header ------------------------------------------------------------------------------
{
  const s = standard();
  const ok = container(s.chunks, 3000, { raw: s.raw, flags: 5, ext: Uint8Array.of(1, 2, 3, 4, 5, 6) });
  const r = unpackXpkMash(ok.bytes);
  check("extended header skipped", r.ok && eq(r.value.bytes, s.raw) && r.value.extendedHeaderLength === 6 && r.value.headerLength === 44 &&
    r.value.chunks[0].headerOffset === 44);
  expectCode("extended length points past the input", container(s.chunks, 3000, { raw: s.raw, flags: 5, ext: Uint8Array.of(1, 2), extLen: 0xffff }).bytes, "extended-header-bounds");
  // 36 + 2 + 20 = 58 bytes; the header would end at 56, leaving 2 bytes: no room for a 12-byte chunk header.
  expectCode("extended length leaves no chunk header", container([], 4, { flags: 5, extLen: 18, omitEnd: true, tail: new Uint8Array(20) }).bytes, "extended-header-bounds");
  const tiny = mutated(s.bytes.slice(0, 36), (b) => { put32(b, 4, 28); b[32] = 5; fixMain(b); });
  expectCode("extended flag without a length word", tiny, "extended-header-bounds");
}

// ---- header prefix --------------------------------------------------------------------------------
{
  const s = standard();
  const bad = mutated(s.bytes, (b) => { b[16] ^= 1; fixMain(b); });
  expectCode("initial prefix differs from the output", bad, "prefix-mismatch");
  const r = unpackXpkMash(bad, { verifyPrefix: false });
  check("prefix check can be disabled", r.ok && eq(r.value.bytes, s.raw) && r.value.prefixVerified === false);
  const raw = Uint8Array.of(1, 2, 3, 4, 5);
  const tiny = container([chunk(0, raw, 5)], 5, { raw, prefix: Uint8Array.from([1, 2, 3, 4, 5, ...new Array(11).fill(0xee)]) });
  const rt = unpackXpkMash(tiny.bytes);
  check("short output compares only its own bytes", rt.ok && rt.value.prefixVerified && eq(rt.value.bytes, raw));
}

// ---- resource limits ------------------------------------------------------------------------------
{
  const full = new Uint8Array(XPK_MAX_OUTPUT_BYTES);
  const c = container([chunk(0, full, full.length)], full.length, { raw: full });
  const r = unpackXpkMash(c.bytes);
  check("output exactly at the limit is accepted", r.ok && r.value.bytes.length === XPK_MAX_OUTPUT_BYTES);
  const many = (n) => {
    const chunks = Array.from({ length: n }, (_, i) => chunk(0, [i & 255], 1));
    return container(chunks, n, { raw: Uint8Array.from({ length: n }, (_, i) => i & 255) }).bytes;
  };
  const okMany = unpackXpkMash(many(XPK_MAX_CHUNKS - 1));
  check("4096 chunk headers (incl. end chunk) accepted", okMany.ok && okMany.value.chunks.length === XPK_MAX_CHUNKS - 1);
  expectCode("4097 chunk headers rejected", many(XPK_MAX_CHUNKS), "too-many-chunks");
}

// ---- never throws, never partial -------------------------------------------------------------------
{
  const s = standard();
  let threw = 0, internal = 0, badOk = 0, errors = 0;
  const run = (input) => {
    let r;
    try { r = unpackXpkMash(input); } catch { threw++; return; }
    if (r.ok) { if (r.value.bytes.length !== r.value.rawLength) badOk++; return; }
    errors++;
    if (r.error.code === "internal" || typeof r.error.message !== "string") internal++;
  };
  for (let it = 0; it < 800; it++) {
    const b = s.bytes.slice();
    for (let k = 1 + rnd(4); k > 0; k--) b[rnd(b.length)] = rnd(256);
    run(rnd(4) === 0 ? b.subarray(0, rnd(b.length + 1)) : b);
  }
  // Payload-level fuzz with valid checksums so the corruption reaches the MASH decoder.
  let mashErrors = 0;
  for (let it = 0; it < 1200; it++) {
    const pl = s.payloads.map((p) => p.slice());
    for (let k = 1 + rnd(3); k > 0; k--) { const t = 1 + rnd(2); pl[t][rnd(pl[t].length)] = rnd(256); }
    if (rnd(5) === 0) pl[1 + rnd(2)] = pl[1].slice(0, rnd(pl[1].length));
    const input = container([chunk(0, pl[0], 1000), chunk(1, pl[1], 1000), chunk(1, pl[2], 1000)], 3000, { raw: s.raw }).bytes;
    let r;
    try { r = unpackXpkMash(input); } catch { threw++; continue; }
    if (r.ok) { if (r.value.bytes.length !== 3000) badOk++; continue; }
    if (r.error.code.startsWith("mash-")) mashErrors++;
    else if (r.error.code === "internal") internal++;
  }
  check("fuzz: no exception escapes", threw === 0, `${threw} thrown`);
  check("fuzz: no 'internal' errors, outputs complete", internal === 0 && badOk === 0, `internal ${internal}, badOk ${badOk}`);
  check("fuzz: corruption actually reaches the decoder", errors > 0 && mashErrors > 0, `errors ${errors}, mash ${mashErrors}`);
}

// ---- composition with the Disk.4 parser -----------------------------------------------------------
const IMAGE_BYTES = 1920 * 512;
const rec = (i) => DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + i * DISK4_RECORD_SIZE;
function syntheticDisk() {
  const b = new Uint8Array(IMAGE_BYTES);
  for (let k = 0; k < 8; k++) b[DISK4_HEADER_OFFSET + k] = "UTOPSAVE".charCodeAt(k);
  for (let i = 0; i < DISK4_SLOT_COUNT; i++) for (let k = 0; k < 5; k++) b[rec(i) + k] = "EMPTY".charCodeAt(k);
  return b;
}
function packDisk(img) {
  const chunks = [];
  for (let off = 0; off < img.length; off += 65536) {
    const part = img.subarray(off, off + 65536);
    chunks.push(chunk(1, encodeTokens(rleTokens(part)), part.length));
  }
  return container(chunks, img.length, { raw: img }).bytes;
}
{
  const img = syntheticDisk();
  // Slot 0 populated like the documented seed extents (0,72) and (74,84).
  const name = "SAVE 01.02.93";
  img.fill(0, rec(0), rec(0) + 16);
  for (let k = 0; k < name.length; k++) img[rec(0) + k] = name.charCodeAt(k);
  img[rec(0) + 0x13] = 72; img[rec(0) + 0x15] = 74; img[rec(0) + 0x17] = 84; // low bytes of (0,72) and (74,84)
  img.fill(0xa1, 0, 73 * 512);
  img.fill(0xb2, 74 * 512, 85 * 512);
  const packed = packDisk(img);

  const raw = parseDisk4(img);
  const viaRaw = parseDisk4Input(img);
  check("raw input passes through unchanged", viaRaw.ok && viaRaw.value.source === "raw" && viaRaw.value.image.bytes === img && viaRaw.value.container === undefined &&
    raw.ok && viaRaw.value.image.slots.length === 10);

  const viaXpk = parseDisk4Input(packed);
  check("XPK input is unpacked then parsed", viaXpk.ok && viaXpk.value.source === "xpk-mash" && eq(viaXpk.value.image.bytes, img) &&
    viaXpk.value.container.chunks.length === 15 && viaXpk.value.container.rawLength === IMAGE_BYTES);
  check("unpacked slots match", viaXpk.ok && viaXpk.value.image.slots[0].state === "populated" && viaXpk.value.image.slots[1].state === "empty");
  const areas = viaXpk.ok ? readDisk4Slot(viaXpk.value.image, 0) : null;
  check("unpacked areas readable", areas && areas.ok && areas.value.name === name && areas.value.areaA.every((v) => v === 0xa1) && areas.value.areaB.every((v) => v === 0xb2));
  check("container info omits the bytes", viaXpk.ok && !("bytes" in viaXpk.value.container));

  const r = parseDisk4(packed);
  check("parseDisk4 stays raw-only", !r.ok && r.error.code === "compressed-xpk");

  const corrupt = parseDisk4Input(mutated(packed, (b) => { b[packed.length - 40] ^= 1; }));
  check("decode failure is stage 'decode'", !corrupt.ok && corrupt.error.stage === "decode" && typeof corrupt.error.error.code === "string");

  const blank = parseDisk4Input(packDisk(new Uint8Array(IMAGE_BYTES)));
  check("valid container, no signature: stage 'disk4'", !blank.ok && blank.error.stage === "disk4" && blank.error.error.code === "bad-signature");
  const small = parseDisk4Input(container([chunk(1, encodeTokens(rleTokens(new Uint8Array(4096))), 4096)], 4096, { raw: new Uint8Array(4096) }).bytes);
  check("valid container, image too short: stage 'disk4'", !small.ok && small.error.stage === "disk4" && small.error.error.code === "too-short");

  const nestedRaw = new Uint8Array(64); nestedRaw.set([0x58, 0x50, 0x4b, 0x46]);
  const nested = parseDisk4Input(container([chunk(0, nestedRaw, 64)], 64, { raw: nestedRaw }).bytes);
  check("unpacked data starting with XPKF is not unpacked again", !nested.ok && nested.error.stage === "disk4" && nested.error.error.code === "compressed-xpk");
  const bad = parseDisk4Input("nope");
  check("non-bytes input: stage 'disk4'", !bad.ok && bad.error.stage === "disk4" && bad.error.error.code === "not-bytes");
}

// ---- optional golden check against the player's local files --------------------------------------
{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const seedPath = `${root}original/utopia-whdload/disk.4`;
  const pythonOutPath = `${root}original/extracted/disk4.bin`;
  if (!existsSync(seedPath) || !existsSync(pythonOutPath)) {
    console.log("skip golden: original/utopia-whdload/disk.4 and original/extracted/disk4.bin are not both present");
  } else {
    const seedBytes = new Uint8Array(readFileSync(seedPath));
    const expected = new Uint8Array(readFileSync(pythonOutPath));
    const r = unpackXpkMash(seedBytes);
    check("golden: TypeScript expansion equals the Python output byte for byte", r.ok && r.value.bytes.length === expected.length && Buffer.compare(r.value.bytes, expected) === 0,
      r.ok ? "" : r.error.message);
    const d = parseDisk4Input(seedBytes);
    check("golden: seed parses as Disk.4 with the UTOPSAVE header", d.ok && d.value.source === "xpk-mash" && d.value.image.slots.length === 10 &&
      d.value.image.slots.every((s) => s.state === "empty"), d.ok ? "" : JSON.stringify(d.error));
    const direct = parseDisk4(expected);
    check("golden: raw Python output parses to the same slots", direct.ok && d.ok && JSON.stringify(direct.value.slots) === JSON.stringify(d.value.image.slots) && direct.value.idWord === d.value.image.idWord);
  }
}

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("xpk-mash tests passed");
