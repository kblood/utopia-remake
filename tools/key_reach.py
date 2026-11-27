"""Static reachability check for the key-code cell $161A0 on the Disk.1 image (read-only).

usage: python tools/key_reach.py <Disk.1> <entry_hex>[,<entry_hex>...]
 e.g.  python tools/key_reach.py original/utopia-whdload/Disk.1 bfec,c1be,c312,e086,caae,11b4,1608,16d0,16da,16e0,1754,175e,1766,176e,1794
 (the last nine are the targets of the $15DE table: word i at $15F6+2i, target $15F6+word-2, index 0..8 under the bound word $15F4 = 9;
  decoded from Disk.1 on 2026-11-14, handoff HANDOFF-2026-11-14-held-key-routes.md)

Addresses are game-image addresses (file offset = address + 0x28800). Each routine is walked intra-procedurally: both
branch paths, `bra` followed, `rts`/`rte`/`jmp` end the path, `bsr`/`jsr` with a static target add a callee. The walk
over-approximates (it may decode data as code), so an empty result is conservative; a hit is a chain to check by hand.
Indirect transfers and PC-relative jumps are listed as unresolved and must be followed by hand (e.g. the table dispatch
at $15DE, whose targets the caller passes as entries).

Capstone is required (plain `python`, not `python -I`; see notes/formats/screens.md, "Key reads").
Positive control: `python tools/key_reach.py <Disk.1> bcea` finds the count entry $5110 through its caller $BCEA.
"""
import re
import sys
from collections import deque

import capstone

BASE = 0x28800
CONDITIONAL = {"bcc", "bcs", "beq", "bne", "bge", "bgt", "ble", "blt", "bhi", "bls", "bpl", "bmi", "bvc", "bvs", "bhs", "blo"}
KEY_CELL = "$161a0"


def target_of(op):
    m = re.search(r"\$([0-9a-f]+)", op)
    return int(m.group(1), 16) if m else None


def main():
    data = open(sys.argv[1], "rb").read()
    md = capstone.Cs(capstone.CS_ARCH_M68K, capstone.CS_MODE_M68K_020)
    md.skipdata = True

    def fetch(addr):
        off = addr + BASE
        if off < 0 or off + 16 > len(data):
            return None
        for ins in md.disasm(data[off : off + 16], addr):
            return ins
        return None

    unresolved = []

    def walk(entry):
        """Returns (callees, touches the key cell) for one routine."""
        callees, key, seen, work = set(), False, set(), [entry]
        while work and len(seen) < 4000:
            a = work.pop()
            while a not in seen:
                ins = fetch(a)
                if ins is None or ins.size == 0:
                    break
                seen.add(a)
                # capstone prints size suffixes (bsr.w, bra.b, beq.s): compare the bare name
                name = ins.mnemonic.lower().split(".")[0]
                op = ins.op_str.lower()
                if KEY_CELL in op:
                    key = True
                if name in ("rts", "rte", "rtr"):
                    break
                if name == "bra":
                    t = target_of(op)
                    if t is not None:
                        work.append(t)
                    break
                if name == "jmp":
                    t = target_of(op)
                    if t is None or "(" in op:
                        unresolved.append((entry, a, op))
                    else:
                        work.append(t)
                    break
                if name in ("bsr", "jsr"):
                    t = target_of(op)
                    if t is None or "(" in op:
                        unresolved.append((entry, a, op))
                    else:
                        callees.add(t)
                    a += ins.size
                    continue
                if name in CONDITIONAL or name.startswith("db"):
                    t = target_of(op)
                    if t is not None:
                        work.append(t)
                a += ins.size
        return callees, key

    entries = [int(x, 16) for x in sys.argv[2].split(",")]
    parent = {e: None for e in entries}
    queue = deque(entries)
    hits = {}
    while queue:
        routine = queue.popleft()
        callees, key = walk(routine)
        if key:
            hits[routine] = True
        for c in callees:
            if c not in parent:
                parent[c] = routine
                queue.append(c)

    # Raw scan: every absolute-long operand $00 01 61 A0 in the image (readers and writers; data words included).
    raw, at = [], data.find(bytes([0x00, 0x01, 0x61, 0xA0]))
    while at >= 0:
        raw.append(at - BASE)
        at = data.find(bytes([0x00, 0x01, 0x61, 0xA0]), at + 1)
    print("absolute operands of $161A0 (raw scan, operand addresses): " + " ".join(f"{a:#x}" for a in raw))
    print(f"routines reached: {len(parent)}")
    for routine in sorted(hits):
        chain = []
        x = routine
        while x is not None:
            chain.append(f"{x:#x}")
            x = parent[x]
        print(f"KEY-CELL routine {routine:#x} via " + " <- ".join(chain))
    if not hits:
        print(f"no reached routine touches {KEY_CELL}")
    print(f"unresolved transfers: {len(unresolved)}")
    for entry, a, op in unresolved[:20]:
        print(f"  in {entry:#x} at {a:#x}: {op}")


if __name__ == "__main__":
    main()
