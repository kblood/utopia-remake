"""Print structure numbers of the music block (no names, no music): size check, sample table, order list, effect census.
usage: python blocks_modinfo.py"""
from blocks_common import load_range, BLOCKS

d = load_range(*BLOCKS["module"][:2])
assert d[1080:1084] == b"M.K."
songlen, restart = d[950], d[951]
order = d[952:952 + 128]
npat = max(order) + 1
tot = 0
print("size", len(d), "song length", songlen, "restart byte", restart, "patterns", npat)
for i in range(31):
    o = 20 + 30 * i
    ln = int.from_bytes(d[o + 22:o + 24], "big") * 2
    tot += ln
    print("smp %2d len %6d finetune %d vol %2d loop %6d+%d" % (i + 1, ln, d[o + 24], d[o + 25],
          int.from_bytes(d[o + 26:o + 28], "big") * 2, int.from_bytes(d[o + 28:o + 30], "big") * 2))
print("header 1084 + patterns %d + samples %d = %d" % (npat * 1024, tot, 1084 + npat * 1024 + tot))
eff = {}
for p in range(npat):
    for r in range(64):
        for c in range(4):
            e = d[1084 + p * 1024 + r * 16 + c * 4 + 2] & 15
            eff[e] = eff.get(e, 0) + 1
print("effect census", dict(sorted(eff.items())))
