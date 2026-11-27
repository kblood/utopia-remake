"""Compare a local ADF pair with the WHDLoad disk images (read only, prints a report).

Usage: python tools/adf_compare.py <Utopia-a.adf> <Utopia-b.adf> [<whdload dir>]

Findings and their evidence level: notes/formats/utopia-disks.md, "ADF pair: relocated and packed data".
Nothing is written and no game data is stored in the repository.
"""
import os
import struct
import sys

SECTOR = 512
# (label, Disk.1 first sector, Disk.1 last sector, ADF A first sector)
MOVED = [
    ("music 3, tail", 0x6E0, 0x6EB, 0x007),
    ("German strings", 0x6EC, 0x707, 0x013),
    ("filler", 0x708, 0x709, 0x02F),
    ("title picture (packed)", 0x70A, 0x727, 0x031),
    ("logo picture (packed)", 0x729, 0x733, 0x04F),
]
# ADF A sectors that each start with an unpacker; its stream header sits $10C bytes in.
STREAMS = [("game program", 0x14C), ("boot stage", 0x1BB)]
STREAM_HEADER = 0x10C


def long_at(data, offset):
    return struct.unpack_from(">I", data, offset)[0]


def unpack(data, offset):
    """Backwards-bitstream unpacker as traced from the stub at ADF A sector $14C (ByteKiller layout).

    Header: packed length, unpacked length, XOR checksum. Returns (bytes, checksum_ok).
    """
    packed, size, check = (long_at(data, offset + k) for k in (0, 4, 8))
    pos = offset + 12 + packed - 4
    word = long_at(data, pos)
    check ^= word
    out = bytearray(size)
    end = size

    def bit():
        nonlocal word, pos, check
        carry = word & 1
        word >>= 1
        if word == 0:
            pos -= 4
            fresh = long_at(data, pos)
            check ^= fresh
            carry = fresh & 1
            word = (fresh >> 1) | 0x80000000
        return carry

    def bits(count):
        value = 0
        for _ in range(count):
            value = (value << 1) | bit()
        return value

    def literal(count):
        nonlocal end
        for _ in range(count):
            byte = bits(8)
            end -= 1
            out[end] = byte

    def copy(distance, count):
        nonlocal end
        for _ in range(count):
            end -= 1
            out[end] = out[end + distance]

    while end > 0:
        if not bit():
            if bit():
                copy(bits(8), 2)
            else:
                literal(bits(3) + 1)
        else:
            kind = bits(2)
            if kind < 2:
                copy(bits(9 + kind), kind + 3)
            elif kind == 3:
                literal(bits(8) + 9)
            else:
                count = bits(8) + 1
                copy(bits(12), count)
    return bytes(out), check == 0


def main(argv):
    if len(argv) not in (3, 4):
        print(__doc__)
        return 2
    base = argv[3] if len(argv) == 4 else os.path.join("original", "utopia-whdload")
    read = lambda path: open(path, "rb").read()
    a, b = read(argv[1]), read(argv[2])
    disk1, disk2 = read(os.path.join(base, "Disk.1")), read(os.path.join(base, "Disk.2"))
    span = lambda data, first, last: data[first * SECTOR:(last + 1) * SECTOR]

    print("ADF B equals the start of Disk.2:", disk2[:len(b)] == b)
    print("Rest of Disk.2 is filler (distinct byte values):", len(set(disk2[len(b):])))
    for first, last in ((0x05A, 0x14B), (0x209, 0x6DF)):
        print(f"ADF A ${first:03X}-${last:03X} equals Disk.1:", span(a, first, last) == span(disk1, first, last))
    for label, first, last, at in MOVED:
        theirs = span(a, at, at + last - first)
        differing = sum(x != y for x, y in zip(span(disk1, first, last), theirs))
        print(f"{label}: Disk.1 ${first:03X}-${last:03X} at ADF A ${at:03X}, raw bytes differing: {differing}")
    for label, sector in STREAMS:
        data, ok = unpack(a, sector * SECTOR + STREAM_HEADER)
        print(f"{label}: stream in ADF A sector ${sector:03X} unpacks to {len(data)} bytes, checksum {'ok' if ok else 'BAD'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
