"""Loaders for the Utopia world-map data (read-only on the user's original disks).
Disk.1: tile sheet (sectors $222-$25B, packed), main screen background ($282-$2A0, packed),
        sprite-sheet block ($25C-$280, packed), game image ($14C-$208).
Disk.2: scenario records (header at sector $3C0): graphics, descriptors, map, scenario block.
Nothing here is saved into the repository; callers write PNGs to a scratch directory.
"""
import os, struct, sys
sys.path.insert(0, os.path.dirname(__file__))
from game_unpack import unpack

ORIG = os.path.join(os.path.dirname(__file__), "..", "original", "utopia-whdload")

def disk(n):
    return open(os.path.join(ORIG, f"Disk.{n}"), "rb").read()

def sectors(d, a, b):
    return d[a * 512:(b + 1) * 512]

def be16(b, o): return struct.unpack(">H", b[o:o + 2])[0]
def be32(b, o): return struct.unpack(">I", b[o:o + 4])[0]

def tile_sheet(d1=None):
    """Unpacked Disk.1 $222-$25B: 161 descriptors (8 bytes each, first 95 used) + image data from +$508."""
    d1 = d1 or disk(1)
    out, used, ok = unpack(sectors(d1, 0x222, 0x25B))
    assert ok
    return out

def main_screen(d1=None):
    d1 = d1 or disk(1)
    out, used, ok = unpack(sectors(d1, 0x282, 0x2A0))
    assert ok and len(out) == 40064
    return out

def sprite_block(d1=None):
    d1 = d1 or disk(1)
    out, used, ok = unpack(sectors(d1, 0x25C, 0x280))
    assert ok
    return out

def scen_records(d2=None):
    d2 = d2 or disk(2)
    h = sectors(d2, 0x3C0, 0x3C1)
    recs = []
    for i in range(10):
        r = h[10 + i * 0x40: 10 + (i + 1) * 0x40]
        recs.append(r)
    return recs

def scenario(idx, d2=None):
    """Return dict with images (raw), descriptors (66 x (rows-1, off)), map (bytes), block (bytes)."""
    d2 = d2 or disk(2)
    r = scen_records(d2)[idx]
    P = lambda o: (be16(r, o), be16(r, o + 2))
    gfx = sectors(d2, *P(0x14))
    desc = sectors(d2, *P(0x18))
    mp = sectors(d2, *P(0x1C))
    blk = sectors(d2, *P(0x20))
    sp = sectors(d2, *P(0x10))
    return dict(gfx=gfx, desc=desc, map=mp, block=blk, sprites=sp)

def parse_desc(buf, n):
    return [(be32(buf, i * 8), be32(buf, i * 8 + 4)) for i in range(n)]

def all_tiles(scen_idx=0, d1=None, d2=None):
    """Return list of 161 tiles: (rows, planes[6][rows*4 bytes]) with planes stored bottom row first (as in file)."""
    sheet = tile_sheet(d1)
    sc = scenario(scen_idx, d2)
    tiles = []
    d = parse_desc(sheet, 95)
    for rows_m1, off in d:
        rows = rows_m1 + 1
        tiles.append((rows, sheet[0x508 + off: 0x508 + off + 24 * rows]))
    d = parse_desc(sc["desc"], 66)
    for rows_m1, off in d:
        rows = rows_m1 + 1
        tiles.append((rows, sc["gfx"][off: off + 24 * rows]))
    return tiles

def map_cells(scen_idx=0, d2=None):
    """100x75 cell words (row-major) from the scenario map block (header $CE bytes, stride 102 words)."""
    m = scenario(scen_idx, d2)["map"]
    cells = []
    for y in range(75):
        row = [be16(m, 0xCE + (y * 102 + x) * 2) for x in range(100)]
        cells.append(row)
    return cells

def palette(raw40064):
    """32 OCS words at the end of a 40064-byte unpacked picture -> list of (r,g,b) 0..255."""
    pal = []
    for i in range(32):
        w = be16(raw40064, 40000 + i * 2)
        pal.append((((w >> 8) & 15) * 17, ((w >> 4) & 15) * 17, (w & 15) * 17))
    return pal

def planar_rows(planes_bytes, rows, nplanes, flip=True):
    """planes_bytes: nplanes*rows*4 bytes, plane after plane; returns rows x 32 array of color indices
    and mask list (if nplanes==6, the 6th is mask)."""
    import numpy as np
    res = np.zeros((rows, 32), dtype=np.uint8)
    for p in range(nplanes):
        pl = planes_bytes[p * rows * 4:(p + 1) * rows * 4]
        for r in range(rows):
            v = struct.unpack(">I", pl[r * 4:r * 4 + 4])[0]
            for x in range(32):
                bit = (v >> (31 - x)) & 1
                res[r, x] |= bit << p
    if flip:
        res = res[::-1]
    return res
