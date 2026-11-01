"""Render the two frame blocks to PNG contact sheets (needs numpy + Pillow).
usage: python blocks_render.py <out_dir>      (out_dir must NOT be inside the repo; images are never committed)
Palette = the title picture's 32 OCS colours (the boot stage restores it before drawing these frames)."""
import sys, os
import numpy as np
from PIL import Image
from blocks_common import load_range, BLOCKS


def frames(data, wb, h):
    fs = wb * h * 5
    assert len(data) % fs == 0, "size is not a whole number of frames"
    out = []
    for f in range(len(data) // fs):
        base = f * fs
        planes = [np.unpackbits(np.frombuffer(data[base + p * wb * h: base + (p + 1) * wb * h], np.uint8).reshape(h, wb), axis=1)
                  for p in range(5)]
        out.append(sum(planes[p].astype(np.uint8) << p for p in range(5)))
    return out


def sheet(fr, cols, pal, name):
    h, w = fr[0].shape
    rows = (len(fr) + cols - 1) // cols
    im = np.full((rows * (h + 2), cols * (w + 2), 3), 40, np.uint8)
    lut = np.array(pal, np.uint8)
    for i, f in enumerate(fr):
        r, c = divmod(i, cols)
        im[r * (h + 2): r * (h + 2) + h, c * (w + 2): c * (w + 2) + w] = lut[f]
    Image.fromarray(im).resize((im.shape[1] * 2, im.shape[0] * 2), Image.NEAREST).save(name)


if __name__ == "__main__":
    out = sys.argv[1]
    t = load_range(*BLOCKS["title"][:2])
    words = [int.from_bytes(t[40000 + 2 * i: 40002 + 2 * i], "big") for i in range(32)]
    pal = [((w >> 8 & 15) * 17, (w >> 4 & 15) * 17, (w & 15) * 17) for w in words]
    a = load_range(*BLOCKS["frames64"][:2]); b = load_range(*BLOCKS["frames88"][:2])
    assert len(a) == 89600 and len(b) == 95590
    sheet(frames(a, 8, 64), 7, pal, os.path.join(out, "frames64.png"))
    sheet(frames(b, 11, 79), 6, pal, os.path.join(out, "frames88.png"))
    print("frames64:", len(a) // (8 * 64 * 5), "frames88:", len(b) // (11 * 79 * 5))
