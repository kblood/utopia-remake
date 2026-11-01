"""Shared helpers for the graphics/music block tools (see notes/formats/graphics-and-music-blocks.md).
Reads the user's own, gitignored Disk.1. Never writes into the repo."""
import os

DISK1 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "original", "utopia-whdload", "Disk.1")


def unpack(src):
    """Byte LZ/RLE decoder of the boot stage (see notes/formats/picture-lz.md)."""
    out = bytearray(); p = 0
    while p < len(src):
        b = src[p]; p += 1
        if b == 0:
            break
        if b & 0x80:
            if b & 0x40:
                off = ((b & 3) << 8) | src[p]; p += 1
                n = ((b & 0x3F) >> 2) + 3
            else:
                n = 2 if b & 0x20 else 1
                off = b & 0x1F
            start = len(out) - 1 - off - n
            for i in range(n + 1):
                out.append(out[start + i])
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
    return bytes(out)


def load_range(first, last, disk=DISK1):
    """Decode the packed block stored in Disk.1 sectors first..last (inclusive)."""
    with open(disk, "rb") as f:
        f.seek(first * 512)
        raw = f.read((last - first + 1) * 512)
    return unpack(raw)


# sector ranges (inclusive) -> expected unpacked size
BLOCKS = {
    "frames64": (0x60, 0xDC, 89600),    # 35 frames of 64x64, 5 planes
    "frames88": (0xDD, 0x14B, 95590),   # 22 frames of 88x79, 5 planes
    "module": (0x3C3, 0x4AC, 160028),   # ProTracker M.K. module
    "title": (0x70A, 0x728, 40064),     # title picture, palette = last 64 bytes
}
