"""Render the 8x8 isometric world view of a Utopia scenario to a PNG (static re-implementation of $6540).
usage: python map_render.py <out.png> [scenario 0-9] [scroll_x scroll_y] [--bg] [--full]
  --bg    composite over the main-screen background picture (320x200), palette from its tail
  --full  ignore the 8x8 window and render the whole 100x75 map as a flat overview (debug only)
Projection (verified against the $7828 table): view cell (vx,vy), 0..7:
  anchor_x = 112 + 16*(vx-vy)           (left edge of the 32-px tile)
  anchor_y = 39 + 8*(vx+vy)             (row just below the tile's bottom row)
  tile occupies rows anchor_y-rows .. anchor_y-1; image rows are stored bottom row first.
Draw order: diagonals vx+vy ascending, vx ascending inside a diagonal.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from PIL import Image
import map_common as M

def planar_screen(buf, nplanes=5):
    idx = np.zeros((200, 320), dtype=np.uint8)
    for p in range(nplanes):
        pl = np.frombuffer(buf[p * 8000:(p + 1) * 8000], dtype=np.uint8).reshape(200, 40)
        idx |= (np.unpackbits(pl, axis=1) << p).astype(np.uint8)
    return idx

def tile_arrays(tile):
    rows, data = tile
    a = M.planar_rows(data, rows, 6, flip=True)       # flip: stored bottom row first
    return rows, a & 31, (a >> 5) & 1

def draw_tile(scr, tile, ax, ay):
    rows, col, mask = tile_arrays(tile)
    for r in range(rows):
        y = ay - rows + r
        if not (0 <= y < 200): continue
        for x in range(32):
            if mask[r, x] and 0 <= ax + x < 320:
                scr[y, ax + x] = col[r, x]

def order():
    out = []
    for s in range(15):
        for vx in range(max(0, s - 7), min(7, s) + 1):
            out.append((vx, s - vx))
    return out

ANIM_RANGES = None

def render(scen=0, sx=0, sy=0, bg=True):
    ms = M.main_screen()
    pal = M.palette(ms)
    scr = planar_screen(ms) if bg else np.zeros((200, 320), np.uint8)
    tiles = M.all_tiles(scen)
    cells = M.map_cells(scen)
    for vx, vy in order():
        w = cells[sy + vy][sx + vx]
        tid = (w & 0x3FF) - 1
        if not (0 <= tid < len(tiles)):
            continue
        draw_tile(scr, tiles[tid], 112 + 16 * (vx - vy), 39 + 8 * (vx + vy))
    return np.array(pal, dtype=np.uint8)[scr]

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = args[0]
    scen = int(args[1]) if len(args) > 1 else 0
    sx = int(args[2]) if len(args) > 2 else 0
    sy = int(args[3]) if len(args) > 3 else 0
    img = render(scen, sx, sy, bg="--nobg" not in sys.argv)
    Image.fromarray(img).resize((640, 400), Image.NEAREST).save(out)
