"""Disassemble a range of the Utopia boot stage (Disk.1 image offset $3000 -> chip $77F18).
usage: python -I blocks_dis.py <start_addr_hex> <end_addr_hex>
Needs capstone. Reads original/utopia-whdload/Disk.1 (gitignored, user's own data)."""
import sys, capstone, os
here = os.path.dirname(os.path.abspath(__file__))
d = open(os.path.join(here, "..", "original", "utopia-whdload", "Disk.1"), "rb").read()
BASE = 0x77F18
buf = d[0x3000:0x3000 + 0x7800]
md = capstone.Cs(capstone.CS_ARCH_M68K, capstone.CS_MODE_M68K_000)
a = int(sys.argv[1], 16); e = int(sys.argv[2], 16)
while a < e:
    off = a - BASE
    g = list(md.disasm(buf[off:off + 12], a, count=1))
    if not g:
        print("%x  .word %04x" % (a, int.from_bytes(buf[off:off+2], "big"))); a += 2; continue
    i = g[0]; print("%x  %-8s %s" % (a, i.mnemonic, i.op_str)); a += i.size
