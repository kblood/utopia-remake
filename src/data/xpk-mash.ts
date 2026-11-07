// Bounded decoder for the XPKF container with the MASH sub-codec, as used by the supplied
// WHDLoad `disk.4` seed. Format evidence: notes/formats/xpk-mash.md.
//
// The container parsing and the MASH bit-stream decoder are a TypeScript translation of
// MASHDecompressor.cpp and XPKMain.cpp from temisu/ancient (via the Python port in
// tools/xpk_mash.py).
//
// Copyright (C) Teemu Suutari (original ancient sources)
// BSD 2-Clause License, Copyright (c) 2017-2026, Teemu Suutari. All rights reserved. The full
// licence text (including the redistribution conditions and disclaimer) is in
// tools/LICENSE-ancient.txt and applies to this translation.
//
// Scope: a pure function from bytes to bytes. Supported: XPKF with long chunk headers, an optional
// extended header (skipped, not interpreted), raw chunks (type 0), MASH chunks (type 1) and the end
// chunk (type 15). Rejected explicitly: short chunk headers, password protection, any other flag
// bit, any other codec, any other chunk type. It does not interpret the unpacked data, does not
// compress, and never returns partial output: the result is either a complete, fully validated
// buffer or a typed error.

/**
 * Resource limits. These are implementation safety limits of this decoder, not properties of the
 * XPK format. They bound memory and work for untrusted input; the supplied seed is 656 bytes packed
 * and 983,040 bytes unpacked.
 */
export const XPK_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const XPK_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Counts every chunk header read, including the end chunk. */
export const XPK_MAX_CHUNKS = 4096;

/** Size of the fixed main header; the optional extended header follows it. */
export const XPK_MAIN_HEADER_BYTES = 36;
/** Size of a long chunk header. */
export const XPK_LONG_CHUNK_HEADER_BYTES = 12;

export type XpkMashErrorCode =
  | "not-bytes"
  | "input-too-large"
  | "truncated-header"
  | "bad-signature"
  | "header-checksum"
  | "unsupported-codec"
  | "unsupported-flags"
  | "password-protected"
  | "bad-packed-size"
  | "bad-raw-size"
  | "output-too-large"
  | "extended-header-bounds"
  | "truncated-chunk"
  | "missing-end-chunk"
  | "chunk-header-checksum"
  | "chunk-checksum"
  | "unsupported-chunk-type"
  | "chunk-length"
  | "nonzero-padding"
  | "too-many-chunks"
  | "output-overrun"
  | "output-size-mismatch"
  | "trailing-data"
  | "prefix-mismatch"
  | "mash-truncated"
  | "mash-literal-length"
  | "mash-literal-overrun"
  | "mash-match-length"
  | "mash-bad-distance"
  | "internal";

export interface XpkMashError {
  readonly code: XpkMashErrorCode;
  readonly message: string;
  /** Zero-based chunk index when the failure belongs to one chunk. */
  readonly chunkIndex?: number;
}

export type XpkMashResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: XpkMashError };

export interface XpkMashChunk {
  readonly index: number;
  readonly type: "raw" | "mash";
  /** Byte offset of the 12-byte chunk header inside the packed input. */
  readonly headerOffset: number;
  readonly packedLength: number;
  readonly rawLength: number;
  /** Offset of this chunk's data inside the unpacked output. */
  readonly outputOffset: number;
}

export interface XpkMashInfo {
  /** Length of the packed input (header field + 8; trailing bytes are rejected). */
  readonly packedLength: number;
  /** Unpacked length from the main header (verified against the chunks). */
  readonly rawLength: number;
  /** Main header plus extended header: offset of the first chunk header. */
  readonly headerLength: number;
  /** Length field of the extended header (0 when the flag is not set). Its contents are skipped. */
  readonly extendedHeaderLength: number;
  /** True when the 16-byte initial prefix of the header was compared with the output. */
  readonly prefixVerified: boolean;
  /** Data chunks in order (the end chunk is not listed). */
  readonly chunks: readonly XpkMashChunk[];
}

export interface XpkMashUnpacked extends XpkMashInfo {
  /** Freshly allocated unpacked data, exactly `rawLength` bytes. */
  readonly bytes: Uint8Array;
}

export interface XpkMashOptions {
  /**
   * Compare the 16-byte initial prefix in the main header (bytes 16-31) with the first
   * min(rawLength, 16) output bytes, as ancient does when verifying. Default true.
   */
  readonly verifyPrefix?: boolean;
}

/** True when the bytes start with the `XPKF` signature (does not validate anything else). */
export function isXpkContainer(bytes: Uint8Array): boolean {
  return bytes instanceof Uint8Array && bytes.length >= 4 && bytes[0] === 0x58 && bytes[1] === 0x50 && bytes[2] === 0x4b && bytes[3] === 0x46;
}

class XpkMashFault extends Error {
  chunkIndex: number | undefined;
  constructor(readonly code: XpkMashErrorCode, message: string, chunkIndex?: number) {
    super(message);
    this.chunkIndex = chunkIndex;
  }
}

function fault(code: XpkMashErrorCode, message: string): never {
  throw new XpkMashFault(code, message);
}

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const hex = (n: number): string => `$${n.toString(16).toUpperCase()}`;

function xorBytes(b: Uint8Array, start: number, end: number): number {
  let x = 0;
  for (let i = start; i < end; i++) x ^= b[i];
  return x;
}

/** 16-bit chunk checksum: even-indexed bytes XOR into the high byte, odd-indexed into the low byte. */
function chunkChecksum(b: Uint8Array, start: number, end: number): number {
  let hi = 0;
  let lo = 0;
  for (let i = start; i < end; i++) {
    if ((i - start) & 1) lo ^= b[i];
    else hi ^= b[i];
  }
  return (hi << 8) | lo;
}

// ---------------------------------------------------------------------------------------------
// MASH sub-codec
// ---------------------------------------------------------------------------------------------

/** Bit widths of the eight distance classes; class k adds the sum of the earlier class sizes. */
const VLC_BITS = [5, 7, 9, 10, 11, 12, 13, 14] as const;
const VLC_OFFSETS = [0, 32, 160, 672, 1696, 3744, 7840, 16032] as const;

/**
 * Decodes one MASH chunk from src[srcStart, srcEnd) into out[outStart, outStart + rawLength).
 * Returns the number of source bytes consumed. Back-references only reach into this chunk's own
 * output (the reference decoder ignores earlier chunks). Throws XpkMashFault.
 */
function decodeMashChunk(src: Uint8Array, srcStart: number, srcEnd: number, out: Uint8Array, outStart: number, rawLength: number): number {
  let pos = srcStart;
  let buf = 0;
  let bufLen = 0;
  const outEnd = outStart + rawLength;
  let op = outStart;

  // MSB-first. Literal bytes are taken straight from `pos` and bypass any bits still buffered.
  const readBits = (count: number): number => {
    let ret = 0;
    while (count > 0) {
      if (bufLen === 0) {
        if (pos >= srcEnd) fault("mash-truncated", `MASH data ended early at output offset ${op - outStart} of ${rawLength}`);
        buf = src[pos++];
        bufLen = 8;
      }
      const take = count < bufLen ? count : bufLen;
      bufLen -= take;
      ret = (ret << take) | ((buf >> bufLen) & ((1 << take) - 1));
      count -= take;
    }
    return ret;
  };
  const readBit = (): number => readBits(1);
  const readVlc = (): number => {
    const base = readBits(3);
    return VLC_OFFSETS[base] + readBits(VLC_BITS[base]);
  };

  while (op < outEnd) {
    // Literal length: k ones then a zero for 0..5, six ones for the extended form.
    let litLength = 0;
    while (litLength < 6 && readBit()) litLength++;
    if (litLength === 6) {
      // Mirrors the reference loop exactly: 16 ones then a zero is an error, while 17 ones are not.
      let litBits = 1;
      while (litBits <= 17 && readBit()) litBits++;
      if (litBits === 17) fault("mash-literal-length", "MASH extended literal length uses an invalid unary prefix");
      litLength = readBits(litBits) + (1 << litBits) + 4;
    }
    if (op + litLength > outEnd) {
      fault("mash-literal-overrun", `MASH literal run of ${litLength} bytes at output offset ${op - outStart} overruns the chunk (${rawLength} bytes)`);
    }
    if (pos + litLength > srcEnd) {
      fault("mash-truncated", `MASH literal run of ${litLength} bytes at output offset ${op - outStart} extends past the chunk data`);
    }
    out.set(src.subarray(pos, pos + litLength), op);
    pos += litLength;
    op += litLength;

    let count: number;
    let distance: number;
    if (readBit()) {
      let countBits = 1;
      while (countBits <= 16 && readBit()) countBits++;
      if (countBits === 16) fault("mash-match-length", "MASH match length uses an invalid unary prefix");
      count = readBits(countBits) + (1 << countBits) + 2;
      distance = readVlc();
    } else if (readBit()) {
      distance = readVlc();
      count = 3;
    } else {
      distance = readBits(9);
      count = 2;
    }

    // Reference quirk: the stream ends with a spare match whose distance is zero.
    if (distance === 0 && op >= outEnd) break;
    // Reference quirk: a match running past the end of the chunk is clipped, not rejected.
    if (count > outEnd - op) count = outEnd - op;
    if (distance === 0 || distance > op - outStart) {
      fault("mash-bad-distance", `MASH match distance ${distance} at output offset ${op - outStart} is invalid (history is ${op - outStart} bytes, per chunk)`);
    }
    // Byte by byte on purpose: distance < count overlaps and repeats the pattern.
    for (let i = 0; i < count; i++, op++) out[op] = out[op - distance];
  }
  return pos - srcStart;
}

// ---------------------------------------------------------------------------------------------
// XPKF container
// ---------------------------------------------------------------------------------------------

function unpack(input: Uint8Array, options: XpkMashOptions): XpkMashUnpacked {
  if (!(input instanceof Uint8Array)) fault("not-bytes", "XPK input must be a Uint8Array");
  if (input.length > XPK_MAX_INPUT_BYTES) {
    fault("input-too-large", `Input is ${input.length} bytes; this decoder accepts at most ${XPK_MAX_INPUT_BYTES} (implementation safety limit)`);
  }
  if (input.length < XPK_MAIN_HEADER_BYTES) {
    fault("truncated-header", `Input is ${input.length} bytes; the XPK main header needs ${XPK_MAIN_HEADER_BYTES}`);
  }
  if (!isXpkContainer(input)) fault("bad-signature", "No XPKF signature at the start of the input");
  if (xorBytes(input, 0, XPK_MAIN_HEADER_BYTES) !== 0) fault("header-checksum", "XPK main header checksum (XOR of the first 36 bytes) is not zero");

  const packedField = u32(input, 4);
  const codec = u32(input, 8);
  const rawLength = u32(input, 12);
  const flags = input[32];

  if (codec !== 0x4d415348) fault("unsupported-codec", `Unsupported XPK codec ${hex(codec)}; only MASH ($4D415348) is handled`);
  if (flags & 2) fault("password-protected", "Password-protected XPK files are not supported");
  if (flags & ~7) fault("unsupported-flags", `Unsupported XPK flag bits ${hex(flags & ~7)}`);
  if (!(flags & 1)) fault("unsupported-flags", "Short chunk headers (flag bit 0 clear) are not supported; only long headers are handled");
  if (packedField === 0) fault("bad-packed-size", "XPK packed size is zero");
  if (packedField + 8 !== input.length) {
    fault("bad-packed-size", `XPK packed size field ${packedField} + 8 is ${packedField + 8}, but the input is ${input.length} bytes`);
  }
  if (rawLength === 0) fault("bad-raw-size", "XPK raw size is zero");
  if (rawLength > XPK_MAX_OUTPUT_BYTES) {
    fault("output-too-large", `Unpacked size ${rawLength} exceeds the ${XPK_MAX_OUTPUT_BYTES}-byte limit of this decoder (implementation safety limit)`);
  }

  // The extended header (flag bit 2) is a 16-bit length at byte 36 and that many bytes after it.
  // Its contents are not interpreted and are not covered by the main header checksum.
  let extendedHeaderLength = 0;
  let headerLength = XPK_MAIN_HEADER_BYTES;
  if (flags & 4) {
    if (input.length < XPK_MAIN_HEADER_BYTES + 2) fault("extended-header-bounds", "Extended header length word lies outside the input");
    extendedHeaderLength = u16(input, XPK_MAIN_HEADER_BYTES);
    headerLength = XPK_MAIN_HEADER_BYTES + 2 + extendedHeaderLength;
  }
  // At least the end chunk header must follow.
  if (headerLength + XPK_LONG_CHUNK_HEADER_BYTES > input.length) {
    fault("extended-header-bounds", `Header of ${headerLength} bytes leaves no room for a chunk header in the ${input.length}-byte input`);
  }

  const out = new Uint8Array(rawLength);
  const chunks: XpkMashChunk[] = [];
  let produced = 0;
  let cursor = headerLength;
  let chunkCount = 0;

  // Validates and decodes the chunk at `cursor`; returns true for the end chunk, otherwise
  // advances `cursor` past the chunk data and its padding.
  function readChunk(index: number): boolean {
    const type = input[cursor];
    const dataCheck = u16(input, cursor + 2);
    const packedLength = u32(input, cursor + 4);
    const chunkRaw = u32(input, cursor + 8);
    if (xorBytes(input, cursor, cursor + XPK_LONG_CHUNK_HEADER_BYTES) !== 0) {
      fault("chunk-header-checksum", `Chunk ${index} header at ${cursor}: checksum (XOR of the 12 bytes) is not zero`);
    }
    if (type !== 0 && type !== 1 && type !== 15) fault("unsupported-chunk-type", `Chunk ${index} has unsupported type ${type}`);

    const dataStart = cursor + XPK_LONG_CHUNK_HEADER_BYTES;
    if (type === 15) {
      if (packedLength !== 0 || chunkRaw !== 0 || dataCheck !== 0) {
        fault("chunk-length", `End chunk ${index} must have zero lengths and checksum`);
      }
      if (dataStart !== input.length) {
        fault("trailing-data", `${input.length - dataStart} bytes follow the end chunk`);
      }
      return true;
    }

    // Compare against the remaining input without 32-bit overflow (JS numbers are doubles).
    const paddedLength = Math.ceil(packedLength / 4) * 4;
    if (dataStart + paddedLength > input.length) {
      fault("truncated-chunk", `Chunk ${index}: ${packedLength} data bytes (padded ${paddedLength}) at ${dataStart} extend past the ${input.length}-byte input`);
    }
    if (packedLength === 0 || chunkRaw === 0) fault("chunk-length", `Chunk ${index}: empty chunks (packed ${packedLength}, raw ${chunkRaw}) are not accepted`);
    if (chunkRaw > rawLength - produced) {
      fault("output-overrun", `Chunk ${index}: ${chunkRaw} raw bytes at output offset ${produced} exceed the declared ${rawLength}`);
    }
    const dataEnd = dataStart + packedLength;
    const sum = chunkChecksum(input, dataStart, dataEnd);
    if (sum !== dataCheck) {
      fault("chunk-checksum", `Chunk ${index}: data checksum is ${hex(sum)}, header says ${hex(dataCheck)} (padding excluded)`);
    }
    for (let i = dataEnd; i < dataStart + paddedLength; i++) {
      if (input[i] !== 0) fault("nonzero-padding", `Chunk ${index}: alignment padding byte at ${i} is not zero`);
    }

    if (type === 0) {
      if (packedLength !== chunkRaw) fault("chunk-length", `Raw chunk ${index}: packed length ${packedLength} differs from raw length ${chunkRaw}`);
      out.set(input.subarray(dataStart, dataEnd), produced);
    } else {
      decodeMashChunk(input, dataStart, dataEnd, out, produced, chunkRaw);
    }
    chunks.push({
      index,
      type: type === 0 ? "raw" : "mash",
      headerOffset: cursor,
      packedLength,
      rawLength: chunkRaw,
      outputOffset: produced,
    });
    produced += chunkRaw;
    cursor = dataStart + paddedLength;
    return false;
  }

  for (;;) {
    if (cursor === input.length) fault("missing-end-chunk", "The input ends without an end chunk (type 15)");
    if (cursor + XPK_LONG_CHUNK_HEADER_BYTES > input.length) {
      fault("truncated-chunk", `Chunk header at ${cursor} extends past the ${input.length}-byte input`);
    }
    if (++chunkCount > XPK_MAX_CHUNKS) {
      fault("too-many-chunks", `More than ${XPK_MAX_CHUNKS} chunks (implementation safety limit)`);
    }
    const index = chunkCount - 1;
    let isEnd: boolean;
    try {
      isEnd = readChunk(index);
    } catch (e) {
      if (e instanceof XpkMashFault && e.chunkIndex === undefined) e.chunkIndex = index;
      throw e;
    }
    if (isEnd) break;
  }

  if (produced !== rawLength) {
    fault("output-size-mismatch", `Chunks produced ${produced} bytes, but the header declares ${rawLength}`);
  }

  let prefixVerified = false;
  if (options.verifyPrefix !== false) {
    const n = Math.min(rawLength, 16);
    for (let i = 0; i < n; i++) {
      if (input[16 + i] !== out[i]) fault("prefix-mismatch", `Header initial prefix differs from the unpacked data at byte ${i}`);
    }
    prefixVerified = true;
  }

  return { bytes: out, packedLength: input.length, rawLength, headerLength, extendedHeaderLength, prefixVerified, chunks };
}

/**
 * Unpacks an XPKF/MASH container. Returns a complete, validated buffer or a typed error; it does
 * not throw for any input and never returns partial output.
 */
export function unpackXpkMash(input: Uint8Array, options: XpkMashOptions = {}): XpkMashResult<XpkMashUnpacked> {
  try {
    return { ok: true, value: unpack(input, options ?? {}) };
  } catch (e) {
    if (e instanceof XpkMashFault) {
      const error: XpkMashError = e.chunkIndex === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, chunkIndex: e.chunkIndex };
      return { ok: false, error };
    }
    // Defensive: bounds are validated above, so this should be unreachable. Do not leak the raw exception.
    return { ok: false, error: { code: "internal", message: `Unexpected decoder failure: ${e instanceof Error ? e.message : String(e)}` } };
  }
}
