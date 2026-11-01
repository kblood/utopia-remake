"""Utopia packed-stream decoder (byte LZ/RLE, see notes/formats/picture-lz.md) with
strict bookkeeping: returns (output, bytes_consumed, ok). ok=True when the stream ended
with the 0x00 control byte inside the supplied buffer."""
def unpack(src, limit=None):
    out = bytearray(); p = 0
    while p < len(src):
        b = src[p]; p += 1
        if b == 0:
            return bytes(out), p, True
        if b & 0x80:
            if b & 0x40:
                off = ((b & 3) << 8) | src[p]; p += 1
                n = ((b & 0x3F) >> 2) + 3
            else:
                n = 2 if b & 0x20 else 1
                off = b & 0x1F
            start = len(out) - 1 - off - n
            if start < 0: return bytes(out), p, False
            for i in range(n + 1): out.append(out[start + i])
        elif b & 0x40:
            if b & 0x20:
                n = (((b & 0x1F) << 8) | src[p]) + 0x24; p += 1
            else:
                n = (b & 0x1F) + 3
            out += bytes([src[p]]) * n; p += 1
        else:
            if b & 0x20:
                n = (((b & 0x1F) << 8) | src[p]) + 0x20; p += 1
            else:
                n = b & 0x1F
            out += src[p:p + n]; p += n
        if limit and len(out) >= limit: break
    return bytes(out), p, False
