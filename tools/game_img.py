"""Helpers to load the Utopia 'game proper' (Disk.1 sectors $14C-$208 -> chip $1000)
and walk its code with a recursive-descent 68k disassembler (capstone).
Read-only on the original data. Usage:  python game_img.py [entry_hex ...]  -> prints listing to stdout
"""
import sys, re, os, capstone

DISK1 = os.path.join(os.path.dirname(__file__), "..", "original", "utopia-whdload", "Disk.1")
BASE = 0x1000
FIRST, LAST = 0x14C, 0x208

def load_game(path=DISK1):
    d = open(path, "rb").read()
    return bytearray(d[FIRST * 512:(LAST + 1) * 512])

_md = capstone.Cs(capstone.CS_ARCH_M68K, capstone.CS_MODE_M68K_020)
_md.skipdata = True

def one(g, addr):
    off = addr - BASE
    if off < 0 or off >= len(g): return None
    for i in _md.disasm(bytes(g[off:off + 12]), addr, 1):
        if i.mnemonic == ".byte": return None
        return i
    return None

_tgt = re.compile(r"^\$([0-9a-f]+)(?:\.[wl])?(?:\(pc\))?$")
def branch_target(i):
    m = i.mnemonic.split('.')[0]
    if m in ("bsr", "bra", "jsr", "jmp") or (m.startswith("b") and m not in ("btst", "bset", "bclr", "bchg", "bfextu", "bfexts", "bfins", "bfset", "bfclr", "bftst", "bfffo", "bkpt")) or m.startswith("db"):
        ops = i.op_str.split(",")
        t = ops[-1].strip()
        mm = _tgt.match(t)
        if mm: return int(mm.group(1), 16)
    return None

def walk(g, entries):
    seen = {}; work = list(entries); calls = set(entries)
    while work:
        a = work.pop()
        while True:
            if a in seen or a < BASE or a >= BASE + len(g): break
            i = one(g, a)
            if i is None: break
            seen[a] = i
            m = i.mnemonic.split('.')[0]
            t = branch_target(i)
            if t is not None and BASE <= t < BASE + len(g):
                if t not in seen: work.append(t)
                if m in ("bsr", "jsr"): calls.add(t)
            if m in ("rts", "rte", "rtr", "bra", "jmp", "illegal") : break
            a += i.size
    return seen, calls

if __name__ == "__main__":
    g = load_game()
    ents = [int(x, 16) for x in sys.argv[1:]] or [0x156b6]
    seen, calls = walk(g, ents)
    prev = None
    for a in sorted(seen):
        i = seen[a]
        if prev is not None and a != prev: print()
        print(f"{'L' if a in calls else ' '}{a:06x}  {bytes(i.bytes).hex():20s} {i.mnemonic:8s} {i.op_str}")
        prev = a + i.size
