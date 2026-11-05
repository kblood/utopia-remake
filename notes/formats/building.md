# Building: placement, construction, demolition

Ports in `src/game/build.ts` (rules) and `src/game/controls.ts` (mouse, modes, menu). Verified by
`test/build.mjs` (place, count down, complete, demolish, then 3 simulated years). Addresses are
original game-image addresses (see game-proper.md).

## Click flow (`$158CA`)
A left press picks a cell with `$5CDA` (map-rendering.md section 8), computes the map cell
(`$6A5A`: scroll + view offset, stored at `$142BA/$142BC`), then dispatches on the mode byte `$14591`:
1 = select (info screens `$311E`/`$7140`, not ported), 2 = build (`$6BF4`), 3 = demolish (`$7372`).
Command buttons (rectangles `$5E06`): index 0 = build menu (`$6BA2` -> `$B2AA`, sets mode 2),
index 2 = demolish (`$15ECA`, mode 3), the rest open other screens (not ported yet).

## Placement `$6BF4` (VERIFIED)
1. `$6D58`: x > 3, y > 3, x < $61, y < $48, otherwise message 2.
2. `$7696`: a base tile (ids 1-3) must exist in the 24 x 24 window starting at (x-12, y-12). If not:
   only tile 1 (power storage) may be built, and only next to a cell with flag bit 10 (`$7628`;
   4 neighbours for a single cell, 8 around a 2 x 2). Messages $127 and 1.
3. `$6F22`: occupancy = any of the footprint cells with flag bits 14/12/10 (`$5400`) is blocked.
   Tile $3C (drill) instead needs ground tiles $94-$9B under it.
4. Tile $61 (ground clearing, `$6D10`) costs twice the table price and rewrites the cell to $38.
5. A free object slot (`$6FAC`, word 0), `$144B1` bit 1 / bit 2 (messages $5E, $11B), free colonists
   >= type byte +4 (message $5D), money >= cost word +6 (message $25).
6. Effects: colonists move from `$13136` to the builders counter `$1432A`, cost leaves `$135BA` and is
   added to `$142CA`; record = {tile $0032, target tile word, x, y, weeks = type byte +2}; counters
   `$142C2`/`$142C4` +1; `$6FC4` writes tile $32 plus the flag byte from table `$16408` (indexed by tile id)
   into the cell(s) (`word = (word & $E800) | tile | flag << 8`).
Footprint = type byte +1 (1 or 4 cells).

## Construction `$7000`, `$703A` (weekly)
Each site's week counter (+6) decrements; at 0 the record becomes the real building (type byte +1/+3,
colonists returned from `$1432A` to `$13136`, T+$A active +1, T+$C total +1, command centre: first one
is online (+3 = $FF), later ones become tile $50; warehouse +80000 capacity; mine and fuel get their
richness count in +6; solar tiles $0F/$1F get a random phase). The cells are rewritten by `$6A8C`
(tile, +1, +2, +3 for a 2 x 2).

## Demolition `$7372`
Construction site: removed, workers returned (money is not refunded). Cleared/ground tiles ($61,
$94-$9B, $38): become $9E. Buildings: stored amounts reduce by their share, farms return 10 workers,
a warehouse reduces stocks, weight and capacity; the cell becomes the cleared tile $38. Others: message $58.

## Build menu (`$B2AA`, HYPOTHESIS for the layout)
Three pages of buildings (lists at `$E9A0/$E9B6/$E9CC`); research bits of `$14472` replace entries
(bit 12 -> $42, 7 -> $0A, 11 -> $0F, 13 -> $31, 14 -> $34, 15 -> $47; page 2: bit 1 -> $40, 0 -> $3C,
5 -> $35, 6 -> $61). The remake draws a plain text list in a panel; the original's picture layout
(`$E908`, `$E95C`) is not reproduced.
