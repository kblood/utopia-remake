"""In-game text renderer for Utopia (game proper), read-only on the user's original disk.

Re-implements the game's own text drawing (routine $538a / $539e of the game image, see
notes/formats/game-text.md) literally on five 8000-byte bitplanes (row stride 40 bytes), so
the result matches what the 68k routine writes, including the byte-boundary shifting.
Fonts, character table, string tables, the screen background and the palette are all read
from Disk.1 at run time; nothing from the game is stored in this file.

usage:  python -I text_render.py INDEX --out OUT.png [--lang 0..3] [--mode log|line|raw]
                                 [--x X --y Y --colour C] [--topbar] [--date DD/MM/YYYY]
                                 [--money N] [--qol N] [--digit D] [--scale K] [--bg main|plain]
                                 [--disk PATH]
        python -I text_render.py --stats        (line counts of the string tables, no text)

INDEX is the 0-based string-table index (408 entries; language 0=EN 1=FR 2=DE 3=IT).
modes:  log  = message log panel ($5A8C): wrapped to 304 px, 3 lines of 9 px at x=8, y=171..,
               colour 1
        line = single message line ($551A): x=8, y=160, colour 21, no wrapping
        raw  = draw at --x/--y with --colour (default 1), no wrapping
--topbar adds the three top-bar fields (colour 21) with the given values.
Output is a PNG; write it outside the repository.
"""
import argparse, os, struct, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
DISK1 = os.path.join(HERE, "..", "original", "utopia-whdload", "Disk.1")
GAME_FIRST, GAME_LAST, BASE = 0x14C, 0x208, 0x1000          # game proper: sectors -> chip $1000
LANG_SECTORS = [(0x209, 0x221), (0x387, 0x3A0), (0x6EC, 0x707), (0x3A2, 0x3BB)]  # EN FR DE IT
BG_SECTORS = (0x282, 0x2A0)                                  # main screen background (packed)

CHAR_TABLE, GLYPHS = 0x62D8, 0x6354       # 2 bytes per code (glyph, advance); 6 bytes per glyph
GLYPH_ROWS, LINE_STEP, STRIDE, PLANE = 6, 9, 40, 8000


# ---------------------------------------------------------------- data loading
def unpack(src):
    """Utopia byte LZ/RLE stream (notes/formats/picture-lz.md)."""
    out = bytearray(); p = 0
    while p < len(src):
        b = src[p]; p += 1
        if b == 0:
            break
        if b & 0x80:
            if b & 0x40:
                off = ((b & 3) << 8) | src[p]; p += 1
                n = ((b & 0x3F) >> 2) + 3
            else:
                n = 2 if b & 0x20 else 1
                off = b & 0x1F
            start = len(out) - 1 - off - n
            for i in range(n + 1):
                out.append(out[start + i])
        elif b & 0x40:
            if b & 0x20:
                n = (((b & 0x1F) << 8) | src[p]) + 0x24; p += 1
            else:
                n = (b & 0x1F) + 3
            out += bytes([src[p]]) * n; p += 1
        else:
            if b & 0x20:
                n = (((b & 0x1F) << 8) | src[p]) + 0x20; p += 1
            else:
                n = b & 0x1F
            out += src[p:p + n]; p += n
    return bytes(out)


class Game:
    def __init__(self, disk=DISK1):
        d = open(disk, "rb").read()
        self.disk = d
        self.img = d[GAME_FIRST * 512:(GAME_LAST + 1) * 512]

    def mem(self, addr):
        o = addr - BASE
        return self.img[o] if 0 <= o < len(self.img) else 0

    def cstr(self, addr):
        out = bytearray()
        while self.mem(addr):
            out.append(self.mem(addr)); addr += 1
        return bytes(out)

    def strings(self, lang):
        a, b = LANG_SECTORS[lang]
        t = unpack(self.disk[a * 512:(b + 1) * 512])
        offs = struct.unpack(">408H", t[:816])
        return t, offs

    def string(self, lang, idx):
        t, offs = self.strings(lang)
        return t[offs[idx]:t.index(0, offs[idx])]

    def background(self):
        a, b = BG_SECTORS
        pic = unpack(self.disk[a * 512:(b + 1) * 512])
        planes = [bytearray(pic[p * PLANE:(p + 1) * PLANE]) for p in range(5)]
        pal = struct.unpack(">32H", pic[40000:40064])
        rgb = [(((w >> 8) & 15) * 17, ((w >> 4) & 15) * 17, (w & 15) * 17) for w in pal]
        return planes, rgb


# ---------------------------------------------------------------- font access
def sbyte(v):
    return v - 256 if v > 127 else v


def char_entry(game, c):
    """Table lookup exactly as $539e: lowercase -> upper, minus $20, sign-extended byte."""
    if c >= 0x61:
        c = (c - 0x20) & 0xFF
    idx = sbyte((c - 0x20) & 0xFF)
    a = CHAR_TABLE + 2 * idx
    return game.mem(a), game.mem(a + 1)      # (glyph index, advance width)


def text_width(game, s):
    w = 0
    for c in s:
        if c == 0 or c & 0x80:
            break
        if c != 9:
            w += char_entry(game, c)[1]
    return w


# ---------------------------------------------------------------- drawing ($538a)
def draw_text(game, planes, x, y, s, colour):
    """Transparent 5-plane text. Glyph ink pixels get the colour value, others are untouched.
    Bit-for-bit follow of $538a: per glyph row clear the ink bits in all planes, then OR the
    colour bits into the planes whose colour bit is set. Any byte with bit 7 set = line break
    (back to the start x, down 9 rows), NUL ends, TAB ($09) is skipped."""
    line_base = y * STRIDE + (x >> 3)
    line_shift = x & 7
    base, shift = line_base, line_shift

    def put(off, mask):
        if mask == 0 or off < 0:
            return
        for p in range(5):
            if off < PLANE:
                planes[p][off] &= ~mask & 0xFF
                if (colour >> p) & 1:
                    planes[p][off] |= mask

    for c in s:
        if c == 0:
            break
        if c & 0x80:
            line_base += LINE_STEP * STRIDE
            base, shift = line_base, line_shift
            continue
        if c == 9:
            continue
        gi, w = char_entry(game, c)
        gi = sbyte(gi)
        for r in range(GLYPH_ROWS):
            gb = game.mem(GLYPHS + 6 * gi + r) if gi >= 0 else 0
            off = base + r * STRIDE
            put(off, gb >> shift)
            if shift + w >= 8 and (shift + w - 8) != 0:
                put(off + 1, (gb << (8 - shift)) & 0xFF)
        if shift + w >= 8:
            base += 1
        shift = (shift + w) & 7


# ---------------------------------------------------------------- number text ($15C5A)
def format_number(value, divisor):
    """$15C5A: digits from `divisor` (a power of ten) down to 1, leading zeros replaced by '#'
    (a blank 5-px glyph); an all-zero value keeps one '0'."""
    digits = []
    d = divisor
    while d >= 1:
        digits.append(chr(0x30 + (value // d) % 10))
        value %= d
        d //= 10
    s = "".join(digits)
    t = s.lstrip("0")
    return "#" * (len(s) - len(t)) + t if t else "#" * (len(s) - 1) + "0"


# ---------------------------------------------------------------- top bar ($4D1C/$4D48/$4D96)
def draw_topbar(game, planes, date="28/06/2090", money=100000, qol=60, blink=True):
    c = 21
    draw_text(game, planes, 8, 2, date.encode().ljust(10)[:10], c)                 # $14594
    t = bytearray(game.cstr(0x2F48))                                               # 7 digits + suffix
    t[0:7] = format_number(min(money, 9999999), 1000000).encode()
    draw_text(game, planes, 110, 2, bytes(t), c)
    t = bytearray(game.cstr(0x2F53))                                               # label, 3 digits, suffix
    t[4:7] = format_number(qol, 100).encode()
    draw_text(game, planes, 224, 2, bytes(t), c)
    if blink and qol >= 90:                                                        # alternate frames only
        draw_text(game, planes, 182, 2, game.cstr(0x6532), c)


# ---------------------------------------------------------------- message wrap ($5C30)
def wrap(game, s, width=304):
    """Re-implementation of $5C30: breaks at the last space when the accumulated advance
    reaches `width`; returns (bytes with $FF as line break, number of lines)."""
    out = bytearray(); p = 0; acc = 0; lines = 1; sp_in = sp_out = None
    while p < len(s):
        c = s[p]; p += 1
        if c == 9:
            continue
        if c == 0xFF:
            acc = 0; lines += 1; out.append(0xFF); continue
        if c == 0x20:
            sp_in, sp_out = p, len(out)
        cc = (c - 0x20) & 0xFF if c < 0x61 else (c - 0x40) & 0xFF
        acc += game.mem(CHAR_TABLE + 2 * cc + 1)
        if acc >= width:
            if sp_in is None:
                sp_in, sp_out = p - 1, len(out)
            p = sp_in; del out[sp_out:]
            acc = 0; lines += 1; out.append(0xFF); continue
        out.append(c)
    return bytes(out), lines


def strip_prefix(s, digit):
    """Strings whose first byte is < $20 or >= $80 (not $FF) start with a placeholder offset:
    the byte is the offset of a placeholder letter in the rest of the string (VERIFIED for the
    marker messages built at $3198; others HYPOTHESIS). Return the body with a digit patched in."""
    if s and (s[0] < 0x20 or (0x80 <= s[0] < 0xFF)):
        off = s[0]
        body = bytearray(s[1:])
        if off < len(body):
            body[off] = ord(digit)
        return bytes(body)
    return s


# ---------------------------------------------------------------- PNG
def write_png(path, w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def ch(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b""))


def to_rows(planes, rgb, scale):
    rows = []
    for y in range(200):
        r = bytearray()
        for x in range(320):
            v = 0
            for p in range(5):
                if planes[p][y * STRIDE + (x >> 3)] & (0x80 >> (x & 7)):
                    v |= 1 << p
            r += bytes(rgb[v]) * scale
        rows += [r] * scale
    return rows


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("index", nargs="?", type=lambda s: int(s, 0))
    ap.add_argument("--lang", type=int, default=0, choices=range(4))
    ap.add_argument("--mode", choices=("log", "line", "raw"), default="log")
    ap.add_argument("--x", type=int, default=8); ap.add_argument("--y", type=int, default=171)
    ap.add_argument("--colour", type=int, default=1)
    ap.add_argument("--topbar", action="store_true")
    ap.add_argument("--date", default="28/06/2090"); ap.add_argument("--money", type=int, default=100000)
    ap.add_argument("--qol", type=int, default=60)
    ap.add_argument("--digit", default="1", help="digit patched into placeholder strings")
    ap.add_argument("--scale", type=int, default=3)
    ap.add_argument("--bg", choices=("main", "plain"), default="main")
    ap.add_argument("--disk", default=DISK1)
    ap.add_argument("--out")
    ap.add_argument("--stats", action="store_true")
    a = ap.parse_args()
    game = Game(a.disk)
    if a.stats:
        for lang in range(4):
            t, offs = game.strings(lang)
            hist = {}
            for o in offs:
                n = wrap(game, strip_prefix(t[o:t.index(0, o)], "1"))[1]
                hist[n] = hist.get(n, 0) + 1
            print("lang", lang, "strings", len(offs), "bytes", len(t), "lines@304px", dict(sorted(hist.items())))
        return
    if a.index is None or not a.out:
        ap.error("INDEX and --out are required")
    planes, rgb = game.background()
    if a.bg == "plain":
        planes = [bytearray(PLANE) for _ in range(5)]
    if a.topbar:
        draw_topbar(game, planes, a.date, a.money, a.qol)
    s = strip_prefix(game.string(a.lang, a.index), a.digit)
    if a.mode == "log":
        body, n = wrap(game, s)
        draw_text(game, planes, 8, 171, body, 1)
        print("lines:", n)
    elif a.mode == "line":
        draw_text(game, planes, 8, 160, s, 21)
        print("width px:", text_width(game, s))
    else:
        draw_text(game, planes, a.x, a.y, s, a.colour)
    write_png(a.out, 320 * a.scale, 200 * a.scale, to_rows(planes, rgb, a.scale))
    print("wrote", a.out)


if __name__ == "__main__":
    main()
