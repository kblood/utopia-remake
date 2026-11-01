"""Cross-check the isometric projection formulas used by map_render.py against the data tables
embedded in the game image (Disk.1 sectors $14C-$208 at $1000). Read-only; prints OK lines.
usage: python map_verify.py
"""
import os, sys, struct
sys.path.insert(0, os.path.dirname(__file__))
import game_img as G

g = G.load_game()
W = lambda a: struct.unpack(">H", g[a - 0x1000:a - 0x1000 + 2])[0]

def order():
    out = []
    for s in range(15):
        for vx in range(max(0, s - 7), min(7, s) + 1):
            out.append((vx, s - vx))
    return out

ORD = order()
assert len(ORD) == 64

# 1. draw table $7828: 64 x 12 bytes {map byte offset, screen byte offset, 4 neighbour entry offsets}
for i, (vx, vy) in enumerate(ORD):
    a = 0x7828 + 12 * i
    assert W(a) == 2 * (vy * 102 + vx), (i, "map offset")
    assert W(a + 2) == (39 + 8 * (vx + vy)) * 40 + 14 + 2 * (vx - vy), (i, "screen offset")
    idx = {c: n for n, c in enumerate(ORD)}
    for k, (dx, dy) in zip((4, 6, 8, 10), ((1, -1), (1, 0), (0, 1), (1, 1))):
        n = (vx + dx, vy + dy)
        exp = (idx[n] - i) * 12 if n in idx else 0
        assert W(a + k) == exp, (i, k)
print("OK  $7828 draw table == formula (map offset, screen offset, neighbour offsets)")

# 2. $7B28 (cell id word = vx<<8|vy) and $7BA8 (order index 63-i at vx+8*vy)
for i, (vx, vy) in enumerate(ORD):
    assert W(0x7B28 + 2 * i) == (vx << 8 | vy)
    assert W(0x7BA8 + 2 * (vx + 8 * vy)) == 63 - i
print("OK  $7B28 / $7BA8 tables")

# 3. pick table $5E58: 72 x 16 bytes, index vy*9+vx, {x0,y0,x1,y1,(vx<<8|vy),...}
for vy in range(8):
    for vx in range(9):
        a = 0x5E58 + 16 * (vy * 9 + vx)
        x0 = 112 + 16 * (vx - vy); y0 = 24 + 8 * (vx + vy)
        assert (W(a), W(a + 2), W(a + 4), W(a + 6)) == (x0, y0, x0 + 31, y0 + 14), (vx, vy)
        assert W(a + 8) == (vx << 8 | vy)
print("OK  $5E58 pick rectangles == formula (32x15 boxes)")

# 4. unrolled blit routine $6754: 30 groups of 16 bytes, group k writes at row offset 40*k, rts at $6934
for k in range(30):
    a = 0x6754 + 16 * k
    assert W(a) == 0x2E20 and W(a + 8) == 0xC5AD and W(a + 10) == 40 * k and W(a + 14) == 40 * k
assert W(0x6934) == 0x4E75
print("OK  $6754 unrolled tile blitter: 30 rows max, 40 bytes per row, rts at $6934")

# 5. scroll limits at $15A44/$15A60 (cmpi.w #$43 / #$5c)
assert W(0x15A44 + 2) == 0x43 and W(0x15A60 + 2) == 0x5C
print("OK  scroll limits y<=$43 (67), x<=$5C (92)")

# 6. scroll arrow rectangles $5DAA (x0,x1,y0,y1) inclusive
exp = [(0xF0, 0x105, 0x7A, 0x84), (0xD8, 0xED, 0x7A, 0x84), (0xD8, 0xED, 0x88, 0x92), (0xF0, 0x105, 0x88, 0x92)]
got = [tuple(W(0x5DAA + 8 * i + 2 * k) for k in range(4)) for i in range(4)]
assert got == exp
print("OK  scroll arrow rectangles", got)
