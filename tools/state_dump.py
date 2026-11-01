#!/usr/bin/env python3
"""Dump the Disk.2 scenario blocks (loaded to $13034 by the game) as number tables.

Usage (run with -I; Disk.2 is read-only user data and is never copied):

    python -I tools/state_dump.py list                 # scenario records: sector pairs, numeric words
    python -I tools/state_dump.py params [N]           # parameter words $13100..$1313B of scenario N (all if omitted)
    python -I tools/state_dump.py events [N]           # event chance bytes $13118.. (20 entries)
    python -I tools/state_dump.py types  [N]           # object-type table $131E2 (18-byte entries)
    python -I tools/state_dump.py words N LO HI        # raw words LO..HI (hex addresses) of scenario N
    python -I tools/state_dump.py diff                 # which parameter words differ between scenarios

Only numbers are printed.  The 16-byte scenario name in each record is deliberately not printed.
See notes/formats/game-state.md for the field meanings.
"""
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DISK2 = os.path.join(ROOT, "original", "utopia-whdload", "Disk.2")
BASE = 0x13034          # load address of the scenario block
TYPES = 0x131E2         # object-type table
HDR_SECTOR = 0x3C0      # scenario header sector on Disk.2
REC0, RECSZ, NREC = 10, 0x40, 10


def load():
    with open(DISK2, "rb") as f:
        return f.read()


def records(d2):
    h = d2[HDR_SECTOR * 512:HDR_SECTOR * 512 + 1024]
    out = []
    for i in range(NREC):
        r = h[REC0 + i * RECSZ:REC0 + (i + 1) * RECSZ]
        words = struct.unpack(">%dH" % ((RECSZ - 0x10) // 2), r[0x10:])
        out.append(words)
    return out


def block(d2, i):
    w = records(d2)[i]
    s, e = w[8], w[9]                       # record +$20 / +$22
    return d2[s * 512:(e + 1) * 512]


def u16(b, addr):
    o = addr - BASE
    return struct.unpack(">H", b[o:o + 2])[0]


def cmd_list(d2):
    for i, w in enumerate(records(d2)):
        print("scenario %d  words(+$10..): %s" % (i, " ".join("%04x" % x for x in w[:14])))
        print("             block sectors %d..%d  (%d bytes)" % (w[8], w[9], len(block(d2, i))))


def cmd_params(d2, sel):
    for i in sel:
        b = block(d2, i)
        print("scenario %d" % i)
        for a in range(0x13100, 0x1313C, 2):
            print("  %05x = %5d" % (a, u16(b, a)))


def cmd_events(d2, sel):
    for i in sel:
        b = block(d2, i)
        o = 0x13118 - BASE
        print("scenario %d event chance bytes $13118+k: %s" % (i, " ".join("%3d" % x for x in b[o:o + 20])))


def cmd_types(d2, sel):
    for i in sel:
        b = block(d2, i)
        print("scenario %d object-type table" % i)
        print("   addr  idx fl size  stf pwr  cost tile  cntA cntC  out name")
        for k in range(34):
            o = TYPES - BASE + 18 * k
            e = b[o:o + 18]
            w = struct.unpack(">9H", e)
            print("  %05x %3d  %02x%02x  %3d %3d %3d %5d %4d %5d %4d %4d %4d" % (
                TYPES + 18 * k, k, e[0], e[1], e[2], e[4], e[5], w[3], w[4], w[5], w[6], w[7], w[8]))


def cmd_words(d2, i, lo, hi):
    b = block(d2, i)
    for a in range(lo, hi, 16):
        row = ["%04x" % u16(b, x) for x in range(a, min(a + 16, hi), 2)]
        print("%05x: %s" % (a, " ".join(row)))


def cmd_diff(d2):
    blocks = [block(d2, i) for i in range(NREC)]
    for a in range(0x13100, 0x1313C, 2):
        vals = [u16(b, a) for b in blocks]
        if len(set(vals)) > 1:
            print("%05x: %s" % (a, " ".join("%5d" % v for v in vals)))
    o = 0x13118 - BASE
    for k in range(20):
        vals = [b[o + k] for b in blocks]
        if len(set(vals)) > 1:
            print("event[%2d]: %s" % (k, " ".join("%4d" % v for v in vals)))


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    d2 = load()
    cmd = argv[1]
    sel = [int(argv[2])] if len(argv) > 2 and cmd in ("params", "events", "types") else list(range(NREC))
    if cmd == "list":
        cmd_list(d2)
    elif cmd == "params":
        cmd_params(d2, sel)
    elif cmd == "events":
        cmd_events(d2, sel)
    elif cmd == "types":
        cmd_types(d2, sel)
    elif cmd == "words":
        cmd_words(d2, int(argv[2]), int(argv[3], 16), int(argv[4], 16))
    elif cmd == "diff":
        cmd_diff(d2)
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
