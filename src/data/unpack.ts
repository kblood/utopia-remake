// Byte-oriented LZ/RLE unpacker used for the game's pictures.
// Derived from behavioural analysis of the original loader; see notes/formats/picture-lz.md.

export function unpackLz(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let p = 0;

  while (p < src.length) {
    const b = src[p++];
    if (b === 0) break;

    if (b & 0x80) {
      // Copy from earlier output. Source ends `offset` bytes before the write position.
      let count: number;
      let offset: number;
      if (b & 0x40) {
        offset = ((b & 3) << 8) | src[p++];
        count = ((b & 0x3f) >> 2) + 4;
      } else {
        offset = b & 0x1f;
        count = b & 0x20 ? 3 : 2;
      }
      const start = out.length - count - offset;
      if (start < 0) throw new Error("unpackLz: back-reference before start of output");
      for (let i = 0; i < count; i++) out.push(out[start + i]);
    } else if (b & 0x40) {
      // Run of one byte.
      let count: number;
      if (b & 0x20) {
        count = (((b & 0x1f) << 8) | src[p++]) + 0x24;
      } else {
        count = (b & 0x1f) + 3;
      }
      const value = src[p++];
      for (let i = 0; i < count; i++) out.push(value);
    } else {
      // Literal bytes.
      let count: number;
      if (b & 0x20) {
        count = (((b & 0x1f) << 8) | src[p++]) + 0x20;
      } else {
        count = b & 0x1f;
      }
      for (let i = 0; i < count; i++) out.push(src[p++]);
    }
  }

  return Uint8Array.from(out);
}
