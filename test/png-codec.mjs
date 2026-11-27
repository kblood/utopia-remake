// Shared PNG codec for the optional pixel comparators (test/pixel-compare.mjs, test/map-capture-compare.mjs).
// Decoding and encoding only: no game data, no paths, no side effects on import.

import zlib from "node:zlib";

export class PixelError extends Error {}

export const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---- PNG decoding (8-bit, non-interlaced; colour types 0, 2, 3, 4 and 6) -----------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new PixelError("not a PNG file");
  let pos = 8;
  let header = null;
  let palette = null;
  const idat = [];
  let ended = false;
  while (!ended) {
    if (pos + 12 > buf.length) throw new PixelError("truncated PNG (no IEND chunk)");
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const dataEnd = pos + 8 + len;
    if (dataEnd + 4 > buf.length) throw new PixelError(`truncated ${type} chunk`);
    if (zlib.crc32(buf.subarray(pos + 4, dataEnd)) !== buf.readUInt32BE(dataEnd)) throw new PixelError(`bad CRC in ${type} chunk`);
    const data = buf.subarray(pos + 8, dataEnd);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      ended = true;
    }
    pos = dataEnd + 4;
  }
  if (!header) throw new PixelError("PNG has no IHDR chunk");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (channels === undefined) throw new PixelError(`unsupported PNG colour type ${header.colorType}`);
  if (header.depth !== 8) throw new PixelError(`unsupported PNG bit depth ${header.depth} (8 required)`);
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) throw new PixelError("unsupported PNG encoding (interlaced or non-standard)");
  if (header.colorType === 3 && (!palette || palette.length < 3)) throw new PixelError("indexed PNG without a PLTE chunk");
  const { width, height } = header;
  if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new PixelError(`implausible PNG size ${width} x ${height}`);
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new PixelError(`PNG data is ${raw.length} bytes, expected ${(stride + 1) * height}`);
  const bytes = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? bytes[dst + x - channels] : 0;
      const b = y > 0 ? bytes[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? bytes[dst - stride + x - channels] : 0;
      let pred;
      switch (filter) {
        case 0: pred = 0; break;
        case 1: pred = a; break;
        case 2: pred = b; break;
        case 3: pred = (a + b) >> 1; break;
        case 4: pred = paeth(a, b, c); break;
        default: throw new PixelError(`bad PNG filter type ${filter} on row ${y}`);
      }
      bytes[dst + x] = (raw[src + x] + pred) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    switch (header.colorType) {
      case 0: rgba.set([bytes[s], bytes[s], bytes[s], 255], d); break;
      case 2: rgba.set([bytes[s], bytes[s + 1], bytes[s + 2], 255], d); break;
      case 3: {
        const p = bytes[s] * 3;
        if (p + 2 >= palette.length) throw new PixelError(`palette index ${bytes[s]} outside PLTE`);
        rgba.set([palette[p], palette[p + 1], palette[p + 2], 255], d);
        break;
      }
      case 4: rgba.set([bytes[s], bytes[s], bytes[s], bytes[s + 1]], d); break;
      default: rgba.set([bytes[s], bytes[s + 1], bytes[s + 2], bytes[s + 3]], d);
    }
  }
  return { width, height, rgba };
}

// Encoder for the self-test only (8-bit RGBA, one filter type per row, so every decode path is exercised).
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= 4 ? rgba[i - 4] : 0;
      const b = y > 0 ? rgba[i - stride] : 0;
      const c = x >= 4 && y > 0 ? rgba[i - stride - 4] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      raw[y * (stride + 1) + 1 + x] = (rgba[i] - pred) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
