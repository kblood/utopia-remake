# Units, sprites and markers (static analysis of the game image)

How the original creates, moves and draws the objects that stand on the map. Addresses refer to the game image (Disk.1 sectors $14C-$208 at $1000, "variant A"); Disk.1 file offset = address + $28800. No game graphics or text are reproduced here. Companion notes: `map-rendering.md` (sections 7.2-7.5: draw list, descriptors, blit), `game-state.md` (entity lists 3.8, per-frame routines 6). Ported in `src/data/sprites.ts`, `src/game/units.ts`, `src/game/objects.ts`; checked by `test/units.mjs`.

Tags: **[V]** = read from disassembly/data (and, where noted, checked by test/render); **[H]** = hypothesis. Nothing here was run in an emulator; "verified" means the code was read and the port reproduces the read logic.

## 1. Sprite types and loading [V]

27 object types; the type byte (+0 of every entry) is 1-based and indexes the $22-byte descriptors at `$12D6A` (21 built-in) followed directly by the 6 scenario descriptors at `$13034` (the start of the scenario block; `$12D6A + 21 * $22 = $13034`).

| Types | Content (from rendering all frames) | Frames |
|---|---|---|
| 1-8 | numbered marker pins (20 rows) | 1 (frame 0 only) |
| 9, 10 | ground units (20 rows) | 8 facings (+5 = direction 0-7), frame 8 = copy of 0 |
| 11-17 | spaceships / aircraft (20 rows) | 8 facings + a 9th |
| 18-21 | effects, 25 rows (600-byte frames): 18 and 20 explosions, 19 a plume, 21 a fireball | 3-5 steps; offsets list reuses frames (18: 0, 600, 1200, 600, 0) |
| 22-27 | scenario-specific (enemy units), 20 or 25 rows; unused slots all zero | 7-8 facings |

- **Built-in images:** Disk.1 sectors $25C-$280, LZ-packed, 47,280 bytes unpacked (`$7CD6`, loaded to `$16136`). The descriptor address longs (+0 image, +4 mask) are *offsets into that block*; `$7CF0` adds the base `$16136` to the 21 built-in entries.
- **Scenario images:** the record's first sector pair (record +$10, e.g. $5A-$78 for scenario 0) is read **raw** (not packed) to `$16136 + $BA00` by `$7D0E` (called from the scenario loader `$8B02` at `$8B3C`). `$8B5C-$8B80` then adds `$16136 + $BA00` to the six descriptors at `$13034` (offsets into that sheet). `$BA00` is past the end of the built-in block ($B8B0), so both blocks sit in one buffer. Unused slots keep size 0 (scenario 0: types 24 and 27; other scenarios: 3-5 of the 6 are used).
- **Descriptor ($22 bytes):** +0 image, +4 mask, +8 bytes per frame (480 for 20 rows, 600 for 25), +$A rows-1 (19 or 24), +$C unused, +$E nine words = frame offsets (index = byte +5 of the entry), +$20 bytes per plane (rows * 4; 1000 in a few type-24 descriptors is a data quirk, not used by `$3260`). Mask address = image + 5 * plane bytes (the mask is stored right after the five colour planes, bottom row first, and reused for every plane by the blit).
- Type `$18` (24): the blit adds `descriptor +8 * 8 * entry byte +$14` to image and mask, i.e. a second animation dimension of 8 frame sets. Scenario 3, 7, 8 and 9 define a type 24 with 600-byte frames. Implemented in `SpriteSet.frame(type, frame, anim)`, not exercised by any list yet.
- The sprite art has transparent rows at the bottom (about 5 of 20), which is why a sprite whose bottom row lies on the cell's bottom row looks as if it stands on the cell centre.

## 2. Entity lists and the draw list [V]

See `map-rendering.md` 7.2 for the arrays. Only the own ground units (`$3AB06`, "tanks") are covered by this port. `$333A` (once per main-loop pass):

1. Sub-tick `$144C9`: incremented each pass; at 9 it wraps to 0 and sets bit 7 of `$156A9` = **"move tick"**; at 4 it sets bit 6 (enemy ground move tick).
2. For every used slot of `$3AB06` (type byte != 0): unless paused (`$156A9` bit 2): if the move tick is set, or byte +9 is >= 0, then clear bit 7 of +9, call **`$38E2`** (movement) and `$12588` (combat hook, d7 = `$145A3`). Types 9 and 10 have +9 = $FF at creation: the first step waits for a move tick; that tick clears bit 7 and from then on the unit is stepped in **every pass** (the earlier reading "once per 9 passes" was wrong). Only the combat hook `$12588` (which acts on the move tick only and sets bit 7 again for the shooter) makes a firing tank wait for the next move tick. See enemies.md.
3. `$3694` computes the screen position and the visibility, the entry goes into the draw list (flags 1 for these units).

The pass rate is not known statically (the loop waits for at least one vertical blank per pass; with 64 CPU-blitted tiles it is probably 2-3 frames). The port assumes 2 frames per pass: **[H]** a unit crosses a cell in 8 move ticks = 72 passes = 144 frames = 2.9 s; the effect timings are equally uncertain.

### `$3694` visibility [V]
View cell = (x - scrollX, y - scrollY); outside 0..7 in either axis = hidden. Types `$12`/`$14` (explosions) are always shown inside the window. Otherwise (b = facing byte +5, dx = +3, dy = +4 signed):
- column 7 (vx = 7), b in 1..3: hidden if dx > 0 or dy > 0 (b = 0 or >= 4 falls through);
- row 7 (vy = 7): b = 7 shown; b = 6 hidden if dx < 0 or dy < 0; b = 3 hidden if dy > 0; b < 4 otherwise shown; b = 4 or 5 hidden if dx < 0.
Position: x = pick-table x0 + dx, bottom row y = pick-table y1 + dy (minus the lift byte for lists that have one), x0 = 112 + 16 (vx - vy), y1 = 38 + 8 (vx + vy). `$3768` draws only 0 <= x <= 255; the blit clips to x < 256 and to y >= 0.

## 3. Unit record (`$3AB06` list, stride $18, header slot at `$3AB06`, first record `$3AB1E`, max 99) [V unless noted]

| Off | Meaning |
|---|---|
| +0 | type (9 or 10), 0 = free slot (bit 6 of the type byte of a *map cell*, not this byte, is the occupied mark, see below) |
| +1, +2 | map cell x, y (the cell the unit started its current step from) |
| +3, +4 | signed pixel offset from the cell centre (dx, dy) |
| +5 | facing = direction 0-7 = sprite frame |
| +6, +7 | pixel velocity (vx, vy) added to +3/+4 on each move tick; 0 = not moving |
| +8 | hit points (created as 8 + 2 * tech level, `$3810-$381C`) |
| +9 | byte, $FF for types 9/10 (bit 7 = "only on the move tick") |
| +A | tech level at creation (`$14592`) |
| +B, +C | target cell x, y; +B = $FF (bit 7 set) = no order |
| +D | 0 |
| +E | word, $FFFF for types 9/10 (fuel for the spaceship types) |
| +$10..+$12 | the three directions that would turn the unit back (see 5), $FF = none |
| +$14 | long pointer to the per-cell flag byte (`$3D3A6 + y * $66 + x`) of the cell the unit has *reserved* |

Initial values come from the 8-byte table at `$4B76` (index type - 9, copied to +8..+F by `$381E`): types 9 and 10 = {8, $FF, 1, $FF, $FF, 0, $FF, $FF}. Types 11-17 (spaceships, same copy routine) have other values (hit points 10-50, +9 = 0 or 4, fuel 400-1200).

The same `$381E` fills +0 type, +1/+2 cell, +5 direction (d4), clears +3/+4/+6/+7, sets +$10..+$12 = $FF and increments the per-type count `$14254 + 4 * (type - 9)` (types 9-16, long).

## 4. Creation [V]

- **`$37CA`** (d1 = type, d2/d3 = cell, d4 = direction): fails with message $8F when the count `$1429C` is 99. Finds the first free slot from `$3AB1E`, increments `$1429C`, then `$497E` (d2/d3 -> a6 = map cell word pointer, a4 = flag byte pointer), sets bit 6 of the map cell's *high byte* (= **map flag bit 14, `$4000`**) and bit 2 of the cell flag byte, stores a4 in +$14, then `$381E`, then +8 += 2 * tech level.
- The only caller is the unit-making building at **`$A776`** (inside `$A620`, the monthly "tank yard progress" of the production step, see `game-state.md` 5.7). It looks up the first record with tile $45, spends goods, and when a unit is ready puts it on the **first free cell around the record's (x, y)**, tested in this order (map offsets (dx, dy)): (0,-1), (+1,-1), (-1,+1), (-1,0), (+1,0), (+1,+1), (0,+1), (-1,-1). A cell is free when bits 12 and 14 of its word are both clear (`and.b #$50` on the high byte; the building's own cells are blocked, so the usable exits are the free neighbours). If none is free, message $95. Type = 10 if invention bit 2 of `$14472` is set, else 9; direction 0.
- Scenarios start **without any ground unit** (the lists are zeroed by `$15F84`; `$6D78` only builds building records). Save files keep the lists (`game-state.md` 9). So "initial units" appear only when this building produces them.

## 5. Orders and movement [V]

### Orders
The target (+B/+C) is set by the player's orders, none of which is a click on the map: the unit screens (`$C5BE` from `$3EDC`) set it from one of the **eight marker pins** (`$C8B4`: +B/+C = pin x/y, and +$10..+$12 = $FF), or from a group order (`$CA20`). Pins are the destination mechanism. `$AD62`/`$4270` copy a target from another entity (ships, chase).

### Step `$38E2` (own units; the same routine serves the enemy ground units when `$156A8` bit 1 is set around the call at `$11990`) [V]
Tables: `$4C1A` (4 bytes per direction): pixel offset of the next cell centre (dx, dy) then the map step (sx, sy); `$4BCA` (10 bytes per direction): the candidate directions then the velocity (vx, vy) at +8/+9; `$4C3A`: map word offset of the neighbour in each direction.

| dir | next centre | map step | velocity |
|---|---|---|---|
| 0 | (16,-8) | (0,-1) | (2,-1) |
| 1 | (32,0) | (+1,-1) | (2,0) |
| 2 | (16,8) | (+1,0) | (2,1) |
| 3 | (0,16) | (+1,+1) | (0,2) |
| 4 | (-16,8) | (0,+1) | (-2,1) |
| 5 | (-32,0) | (-1,+1) | (-2,0) |
| 6 | (-16,-8) | (-1,0) | (-2,-1) |
| 7 | (0,-16) | (-1,-1) | (0,-2) |

Candidate order in `$4BCA` for direction d: d, d+1, d-1, d+2, d-2, d+3, d-3 (mod 8).

```
if target x (+B) is $FF: return
save bytes +0..+7
dx += vx; dy += vy                       (byte adds)
if (dx, dy) == nextCentre[dir]: dx = dy = 0; x += stepX; y += stepY   (cell changes at arrival)
store dx, dy;  if dx != 0 or dy != 0: return          (between two centres: nothing else happens)
; on a cell centre
want = direction towards the target: x == tx: (y == ty -> done) y < ty ? 4 : 0
         x < tx: 3 if y < ty, 1 if y > ty, 2 if y == ty;   x > tx: 5 / 7 / 6        (greedy, 8 directions)
for k in 0..6:                           (slot 6 repeats slot 5 for type 10, original quirk)
    c = candidate k for `want`
    if c in {+$10,+$11,+$12}: next k (k = 6: done)
    cell = neighbour in direction c; if it is the border ($73FF, outside 100 x 75): the unit is removed (`$3C40`)
    blocked = flag bit 12 ($1000)    [type 10: only if the tile id (low 10 bits) < $88]
    if blocked: next k (k = 6: done)
    if flag bit 14 ($4000) already set: next k (k = 6: restore the saved bytes +0..+7 and try again next time, `$3C88`)
    set bit 14 on the neighbour; clear bit 14 of the unit's current cell (map word and flag byte bit 2, move the flag
    pointer +$14 to the new cell); +$10 = c - 4 (mod 8), +$11 = +$10 - 1, +$12 = +$10 + 1 (mod 8); +5 = c; (+6,+7) = velocity[c]
    return
done: +B = $FF (order finished or way blocked), +6/+7 = 0
```
So a cell is **reserved by writing its map flag bit 14 when the unit starts towards it**, the unit's coordinates (+1/+2) change only at arrival, and a stationary unit holds bit 14 on its own cell. A target 5 cells away diagonally+straight takes 1 + 8 * 5 = 41 steps (the first step chooses the direction) once the unit is running; a fresh unit first waits up to 9 passes for its move tick. The remake test asserts both.

Type 10 (UNIT_ADVANCED in the port) passes blocked cells whose tile id is >= $88 (the rock/crater range) [V code; the name "advanced" and the "rock crossing" purpose are H, based on the unlock bit and the data]. Both types never leave via the recent-direction list the way they came ("no U-turn within the next 3 directions").

### Border and removal [V]
- Walking onto the border (`$3C40` in own mode): `$14274++` (and for type != 9 `$14278++`, `$14274--`), then `$4692`: `$1429C--`, per-type count (`$14254` for type 9, `$14258` otherwise) `--`, `$14294++`, `$4732` (clear the unit slot: word +0, byte +2, word +8; clear the flags), and morale `$A246(-50)`. **[H]** `$14274/78/94` are "units lost" statistics.
- `$4732` is also the destroy path used by combat: if bit 5 of `$156A9` was set (by the destroyer) it calls `$1237C`, which creates an explosion effect (below) at the unit's cell.

## 6. Effects and markers

### Effects (`$39D42` list, 8-byte entries, max 30, count `$156AE`) [V]
`$1237C(x, y)`: if the cell is inside the window (not otherwise: plays a sound only), takes the first free entry: +0 type = `$12` (or `$14` when the lift variable `$12D68` is non-zero, which is also stored in +6), +1/+2 cell, +3 = 0, +4..+7 = 0, **+5 = 4**. In `$333A` each pass `subq.b #1, +5`; below 0 the entry is freed; otherwise the entry is drawn with frame = +5, lifted by +6, flags 0. So an explosion is visible for frames 3, 2, 1, 0 (the frame offsets of type 18 are 0, 600, 1200, 600, 0: it swells and shrinks). One step per pass (see 2 for the timing doubt).

### Marker pins (`$14540`, 8 x 10 bytes) [V]
The image's initial data has +0 = 1..8 (type = pin number) and +2 = $FF (`$866E` only rewrites +2 = $FF). Key n (1-8, `$3202`): the cell is scroll + selected cell (`$14636/37` = view cell); if a pin already stands there (any slot) it is removed (`$31BC`: bit in `$144B0` cleared, +2 = $FF, message $72); otherwise pin n is set to the cell (replacing its old position, bit n-1 of `$144B0` set, message $71). Key $22 (`$31CC`) clears all eight. `$3310` draws them after everything else with `$3694` (+3/+4 = 0, +5 = 0) and `$3768`.

## 7. Port (`src/game/units.ts`, `objects.ts`, `data/sprites.ts`)

- `loadSprites(disk1, disk2, record)` builds the 27 types from the two sheets; `SpriteSet.frame(type, frame, anim)` decodes a frame to palette indices + opacity (top row first).
- `UnitSystem` (units.ts): `spawn`, `spawnAtYard` (the exit order above), `order`, `remove`, `tick()` (one main-loop pass; the unit waits for its first move tick, then steps every pass; `UnitSystem.clock` is the shared `PassClock` of the sub-tick `$144C9`), `step(unit)` (= `$38E2`). The occupied mark is bit 14 of the shared `world.cells` word, plus a per-cell flag byte array (`flags`, bit 2). Hook `lost` for border exits (no morale change applied).
- `ObjectLayer` (objects.ts): `update()` per 50 Hz frame (2 frames per pass), `drawAfterCell(screen, scrollX, scrollY, vx, vy)` draws everything on a view cell right after its tile, drawing the flat neighbour tiles in front of a moving unit first (map-rendering.md 7.4) and exposing `claimed(vx, vy)` so the tile loop skips them; `drawMarkers` last; `toggleMarker(n, x, y)`, `clearMarkers`, `markerCell(n)`, `spawnEffect`, `destroyUnit`, `extra` (a list of other drawables) and `enemies` (an `EnemySystem`, stepped after the own units in every pass and drawn after them; see enemies.md).
- `MapScene` creates the layer when it is given `{ sprites }` in its options (`loadSprites(...)` in `main.ts`).

## 8. Not traced / open

- `$12588`, spaceships (`$3A746`, `$42BE`), enemy ground (`$3A12C`, `$1193E`) and air (`$39E20`, `$11A9E`), guns `$11D34`: ported, see enemies.md.
- The specials `$144A8`, `$1449C`; the selection/hit test `$3EDC` and the unit screens that issue the orders.
- Whether pass rate = frame rate; real animation speeds of units and effects.
- `$14274`, `$14278`, `$14294` exact meaning; what happens when a unit enters a type >= $88 cell (does a rock vanish?) - not seen in `$38E2`.
