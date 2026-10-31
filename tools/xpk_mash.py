"""XPK MASH unpacker, ported to Python.

Ported from MASHDecompressor.cpp and XPKMain.cpp in temisu/ancient
(Copyright (C) Teemu Suutari, BSD-2-Clause). See tools/LICENSE-ancient.txt.

Usage: python tools/xpk_mash.py <input.xpk> <output.bin>
"""

import struct
import sys

LIT_DECODE_CODES = {  # value k (0..5) is k ones followed by a zero; 6 is six ones
    0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6,
}
VLC_BITS = [5, 7, 9, 10, 11, 12, 13, 14]
VLC_OFFSETS = []
_acc = 0
for _bits in VLC_BITS:
    VLC_OFFSETS.append(_acc)
    _acc += 1 << _bits


class XPKError(Exception):
    pass


class _BitReader:
    """MSB-first bit reader that mirrors MSBBitReader in InputStream.hpp."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0
        self.buf = 0
        self.buf_len = 0

    def read_bits(self, count: int) -> int:
        ret = 0
        while count:
            if not self.buf_len:
                if self.pos >= len(self.data):
                    raise XPKError("input exhausted")
                self.buf = self.data[self.pos]
                self.pos += 1
                self.buf_len = 8
            take = min(count, self.buf_len)
            self.buf_len -= take
            ret = (ret << take) | ((self.buf >> self.buf_len) & ((1 << take) - 1))
            count -= take
        return ret

    def read_bit(self) -> int:
        return self.read_bits(1)

    def read_byte(self) -> int:
        # Mirrors inputStream.readByte(): bypasses the bit buffer, as the C++ does.
        if self.pos >= len(self.data):
            raise XPKError("input exhausted")
        value = self.data[self.pos]
        self.pos += 1
        return value


def _read_literal_code(bits: _BitReader) -> int:
    k = 0
    while k < 6:
        if not bits.read_bit():
            break
        k += 1
    return k


def _read_vlc(bits: _BitReader) -> int:
    base = bits.read_bits(3)
    return VLC_OFFSETS[base] + bits.read_bits(VLC_BITS[base])


def decompress_mash(packed: bytes, raw_size: int) -> bytearray:
    bits = _BitReader(packed)
    out = bytearray(raw_size)
    op = 0

    while op < raw_size:
        lit_len = _read_literal_code(bits)
        if lit_len == 6:
            lit_bits = 1
            while lit_bits <= 17:
                if not bits.read_bit():
                    break
                lit_bits += 1
            if lit_bits == 17:
                raise XPKError("bad literal length")
            lit_len = bits.read_bits(lit_bits) + (1 << lit_bits) + 4

        if op + lit_len > raw_size:
            raise XPKError("literal overruns output")
        for _ in range(lit_len):
            out[op] = bits.read_byte()
            op += 1

        if bits.read_bit():
            count_bits = 1
            while count_bits <= 16:
                if not bits.read_bit():
                    break
                count_bits += 1
            if count_bits == 16:
                raise XPKError("bad match length")
            count = bits.read_bits(count_bits) + (1 << count_bits) + 2
            distance = _read_vlc(bits)
        elif bits.read_bit():
            distance = _read_vlc(bits)
            count = 3
        else:
            distance = bits.read_bits(9)
            count = 2

        if not distance and op >= raw_size:
            break
        count = min(count, raw_size - op)
        if not distance or distance > op:
            raise XPKError("bad match distance")
        for _ in range(count):
            out[op] = out[op - distance]
            op += 1

    return out


def unpack_xpk(data: bytes) -> bytes:
    if data[:4] != b"XPKF":
        raise XPKError("not an XPKF file")
    chunk_type = data[8:12]
    raw_size = struct.unpack_from(">I", data, 12)[0]
    if chunk_type != b"MASH":
        raise XPKError(f"unsupported XPK type {chunk_type!r}")
    flags = data[32]
    if flags & 2:
        raise XPKError("password-protected XPK")
    if flags & 4:
        header_size = 38 + struct.unpack_from(">H", data, 36)[0]
    else:
        header_size = 36
    long_headers = bool(flags & 1)
    if long_headers is False:
        raise XPKError("short chunk headers are not handled")

    result = bytearray()
    offset = header_size
    prev_packed = None
    while True:
        if prev_packed is not None:
            offset += 12 + ((prev_packed + 3) & ~3)
        chunk_packed, chunk_raw = struct.unpack_from(">II", data, offset + 4)
        ctype = data[offset]
        payload = data[offset + 12: offset + 12 + chunk_packed]
        if ctype == 0:
            if len(payload) != chunk_raw:
                raise XPKError("raw chunk size mismatch")
            result += payload
        elif ctype == 1:
            result += decompress_mash(payload, chunk_raw)
        elif ctype == 15:
            break
        else:
            raise XPKError(f"unknown chunk type {ctype}")
        prev_packed = chunk_packed

    if len(result) != raw_size:
        raise XPKError(f"size mismatch: got {len(result)}, header says {raw_size}")
    return bytes(result)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    with open(sys.argv[1], "rb") as f:
        data = f.read()
    out = unpack_xpk(data)
    with open(sys.argv[2], "wb") as f:
        f.write(out)
    print(f"wrote {len(out)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
