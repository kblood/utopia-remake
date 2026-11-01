"""Small 68k disassembly helper for the Utopia Disk.1 image (read-only).
usage: python game_dis.py <image> <file_offset_hex> <base_addr_hex> <count_or_end_hex>
 e.g.  python game_dis.py Disk.1 3a8c 789a4 40   (boot stage: ram = off + 0x74f18)
Uses capstone (M68K 020, skipdata)."""
import sys, capstone

def disasm(data, off, base, n):
    md = capstone.Cs(capstone.CS_ARCH_M68K, capstone.CS_MODE_M68K_020)
    md.skipdata = True
    out = []
    for i in md.disasm(data[off:off + n * 8], base):
        out.append((i.address, i.bytes, i.mnemonic, i.op_str))
        if len(out) >= n: break
    return out

if __name__ == "__main__":
    img, off, base, n = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16), int(sys.argv[4], 16) if len(sys.argv) > 4 else 40
    d = open(img, "rb").read()
    for a, b, m, o in disasm(d, off, base, n):
        print(f"{a:06x}  {bytes(b).hex():16s} {m:8s} {o}")
