// Finds data inside a user's image by byte pattern instead of a fixed offset. A pattern is hex bytes with `??` as a
// wildcard, e.g. "4E 75 ?? 00". Patterns are matched only when they occur exactly once in the searched region; zero or
// several matches are a typed error, never a guess. Nothing here reads or stores game data itself.

export interface BytePattern {
  bytes: Uint8Array;
  /** 1 = the byte must match, 0 = wildcard. */
  mask: Uint8Array;
}

export function parsePattern(text: string): BytePattern {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) throw new Error("locate: empty pattern");
  const bytes = new Uint8Array(tokens.length);
  const mask = new Uint8Array(tokens.length);
  tokens.forEach((token, i) => {
    if (token === "??") {
      mask[i] = 0;
    } else if (/^[0-9a-fA-F]{2}$/.test(token)) {
      bytes[i] = parseInt(token, 16);
      mask[i] = 1;
    } else {
      throw new Error(`locate: bad pattern token "${token}"`);
    }
  });
  if (mask.every((m) => m === 0)) throw new Error("locate: pattern has no fixed bytes");
  return { bytes, mask };
}

/** Every offset in [from, to) where the pattern matches completely. */
export function findAll(data: Uint8Array, pattern: BytePattern, from = 0, to = data.length): number[] {
  const { bytes, mask } = pattern;
  const hits: number[] = [];
  const last = Math.min(to, data.length) - bytes.length;
  // Start from the first fixed byte so long runs of wildcards do not dominate the scan.
  const anchor = mask.indexOf(1);
  for (let at = from; at <= last; at++) {
    let ok = true;
    for (let k = anchor; k < bytes.length; k++) {
      if (mask[k] && data[at + k] !== bytes[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(at);
  }
  return hits;
}

export type LocateResult = { ok: true; offset: number } | { ok: false; count: number };

/** The single offset where the pattern occurs in [from, to); anything else is reported, not resolved. */
export function locateUnique(data: Uint8Array, pattern: BytePattern, from = 0, to = data.length): LocateResult {
  const hits = findAll(data, pattern, from, to);
  return hits.length === 1 ? { ok: true, offset: hits[0] } : { ok: false, count: hits.length };
}
