# Units, sprites and markers (static analysis of the game image)

How the original creates, moves and draws the objects that stand on the map. Addresses refer to the game image (Disk.1 sectors $14C-$208 at $1000, "variant A"); Disk.1 file offset = address + $28800. No game graphics or text are reproduced here. Companion notes: `map-rendering.md` (sections 7.2-7.5: draw list, descriptors, blit), `game-state.md` (entity lists 3.8, per-frame routines 6). Ported in `src/data/sprites.ts`, `src/game/units.ts`, `src/game/objects.ts`; checked by `test/units.mjs`.

Tags: **[V]** = read from disassembly/data (and, where noted, checked by test/render); **[H]** = hypothesis. Static code findings are not automatically runtime-confirmed. The tank-production/order/movement observations and the optional tank comparison are described in section 7; no broad unit or combat parity is claimed.

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
- Type `$18` (24): the blit adds `descriptor +8 * 8 * entry byte +$14` to image and mask, i.e. a second animation dimension of 8 frame sets. Scenarios 3, 5, 7, 8 and 9 define a type 24 (read from the local Disk.2 records; earlier text listed 3/7/8/9), with 600-byte frames. Implemented in `SpriteSet.frame(type, frame, anim)`; the enemy crusher passes its `+$14` animation (`test/disk4-crusher.mjs` draws an adopted crusher with the local sprite set).
- The sprite art has transparent rows at the bottom (about 5 of 20), which is why a sprite whose bottom row lies on the cell's bottom row looks as if it stands on the cell centre.

## 2. Entity lists and the draw list [V]

See `map-rendering.md` 7.2 for the arrays. Only the own ground units (`$3AB06`, "tanks") are covered by this port. `$333A` (once per main-loop pass):

1. Sub-tick `$144C9`: incremented each pass; at 9 it wraps to 0 and sets bit 7 of `$156A9` = **"move tick"**; at 4 it sets bit 6 (enemy ground move tick).
2. For every used slot of `$3AB06` (type byte != 0): unless paused (`$156A9` bit 2): if the move tick is set, or byte +9 is >= 0, then clear bit 7 of +9, call **`$38E2`** (movement) and `$12588` (combat hook, d7 = `$145A3`). Types 9 and 10 have +9 = $FF at creation: the first step waits for a move tick; that tick clears bit 7 and from then on the unit is stepped in **every pass** (the earlier reading "once per 9 passes" was wrong). Only the combat hook `$12588` (which acts on the move tick only and sets bit 7 again for the shooter) makes a firing tank wait for the next move tick. See enemies.md.
3. `$3694` computes the screen position and the visibility, the entry goes into the draw list (flags 1 for these units).

The pass rate is CPU-bound and not known statically; **observed** on Copperline 1.0.1 (A1200 / 68020 / AGA PAL, scenario 0): one pass per 4 video frames with the pointer at (175,41), 5 with it at (250,141), alternating 5/4 at some other positions (see `map-rendering.md` section 6). In the original tank-production run, movement used 5-VBL passes throughout with the pointer at (280,147), and `$144C9` advanced once per pass. The port runs `ObjectLayer.update()` once per `MainLoop` pass, 4 video updates by default (`src/game/main-loop.ts`); pointer-dependent cadence is not modeled. A unit is released from its initial waiting state on the next move tick (up to 9 passes); after that it is stepped every pass, not only on move ticks. The original run observed the first movement 7 passes after the first capture of the new tank (`$144C9` = 2 there); the creation-time value itself was not captured. From the post-order baseline (`$144C9` = 3) the capture shows the direction chosen exactly on the pass where the counter wraps to 0 (p006), which is what the port's rule gives (`test/tank-original-compare.mjs`, runtime-checkpoints.md section 6). That run measured eight passes per cell for directions 3 and 2 along (48,48)→(49,49)→(50,49)→(51,49)→(52,49), with reservations following each cell and target/velocity cleared on arrival. The remake test's separate `(5,3)` route takes 41 movement passes once released (1 direction-selection pass plus 5 cells at 8 passes each); it remains a port regression, not a matched-state comparison. Directions 1 and 5 imply 16 passes per cell from the velocity/displacement tables, but were not measured in the original. While the tank order window was open, passes and the `$14590` countdown froze across a 97-frame observation; that modal observation is separate from the game's pause control. Static Disk.1 checks `$156A9` bit 2 before `$38E2` (tank), `$42BE` (ship), `$1193E` (enemy ground), `$11A9E` (enemy air) and effect countdown updates, so those entities remain still while paused. `$144C9` nevertheless advances once per `$333A` pass. No live-original run with moving entities during pause has been made.

### `$3694` visibility [V]
View cell = (x - scrollX, y - scrollY); outside 0..7 in either axis = hidden. Types `$12`/`$14` (explosions) are always shown inside the window. Otherwise (b = facing byte +5, dx = +3, dy = +4 signed):
- column 7 (vx = 7), b in 1..3: hidden if dx > 0 or dy > 0 (b = 0 or >= 4 falls through);
- row 7 (vy = 7): b = 7 shown; b = 6 hidden if dx < 0 or dy < 0; b = 3 hidden if dy > 0; b < 4 otherwise shown; b = 4 or 5 hidden if dx < 0.
Position: x = pick-table x0 + dx, bottom row y = pick-table y1 + dy (minus the lift byte for lists that have one), x0 = 112 + 16 (vx - vy), y1 = 38 + 8 (vx + vy). `$3768` draws only 0 <= x <= 255; the blit applies the per-pixel right clip of map-rendering.md 7.3 (x >= 224 loses columns beyond 254, x = 255 quirk) and clips to y >= 0.

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
- The only caller is the unit-making building at **`$A776`** (inside `$A620`, the monthly "tank yard progress" of the production step, see `game-state.md` 5.7). Its neighbour-cell scan and create call are at `$A6D2-$A756`. It looks up the first record with tile $45, spends goods, and when a unit is ready puts it on the **first free cell around the record's (x, y)**, tested in this order (map offsets (dx, dy)): (0,-1), (+1,-1), (-1,+1), (-1,0), (+1,0), (+1,+1), (0,+1), (-1,-1). A cell is free when bits 12 and 14 of its word are both clear (`and.b #$50` on the high byte; the building's own cells are blocked, so the usable exits are the free neighbours). If none is free, message $95. Type = 10 if invention bit 2 of `$14472` is set, else 9; direction 0. This is a static disassembly trace; the complete production path has not been compared with original runtime behavior.
- Scenarios start **without any ground unit** (the lists are zeroed by `$15F84`; `$6D78` only builds building records). Save files keep the lists (`game-state.md` 9). So "initial units" appear only when this building produces them.

## 5. Orders and movement [V]

### Orders
The target (+B/+C) is set by the player's orders, none of which is a click on the map: right-click selection (`$3EDC`) opens the tank window (`$C5BE`), where a pin is chosen from the eight pin rectangles at `$EE1E`; the exit action applies the single or group order. `$C8B4` sets +B/+C to the chosen pin's x/y and clears +$10..+$12. The group order (`$CA20`) targets the selected pin or the front cell. Pins are the destination mechanism. `$AD62`/`$4270` copy a target from another entity (ships, chase). See `ship-control.md` section 4 for the tank window's buttons and group selection; these are static traces, not emulator-observed interactions.

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
done: +B = $FF (order finished or way blocked), +6/+7 = 0     (+C is NOT cleared: an arrived tank was observed with +B = $FF, +C = 49)
```
So a cell is **reserved by writing its map flag bit 14 when the unit starts towards it**, the unit's coordinates (+1/+2) change only at arrival, and a stationary unit holds bit 14 on its own cell. The tested route to (5,3) takes 1 + 8 * 5 = 41 passes (the first step chooses the direction); this is not a universal cell speed, because horizontal screen-diagonal directions 1 and 5 take 16 passes per cell. A fresh unit first waits up to 9 passes for its move tick, then steps on every pass unless another routine sets its waiting bit. The remake test asserts the (5,3) case, not original timing.

Type 10 (UNIT_ADVANCED in the port) passes blocked cells whose tile id is >= $88 (the rock/crater range) [V code; the name "advanced" and the "rock crossing" purpose are H, based on the unlock bit and the data]. Both types never leave via the recent-direction list the way they came ("no U-turn within the next 3 directions").

### Border and removal [V]
- Walking onto the border (`$3C40` in own mode): `$14274++` (and for type != 9 `$14278++`, `$14274--`), then `$4692`: `$1429C--`, per-type count (`$14254` for type 9, `$14258` otherwise) `--`, `$14294++`, `$4732` (clear the unit slot: word +0, byte +2, word +8; clear the flags), and morale `$A246(-50)`. **[H]** `$14274/78/94` are "units lost" statistics.
- `$4732` is also the destroy path used by combat: if bit 5 of `$156A9` was set (by the destroyer) it calls `$1237C`, which creates an explosion effect (below) at the unit's cell.

## 6. Effects and markers

### Effects (`$39D42` list, 8-byte entries from `$39D4A`, 30 FIXED slots, count word `$156AE`) [V]
The pool is a fixed array, not a compacted list (static Disk.1 trace): a new effect takes the FIRST free slot (a freed lower slot is reused before any later one), an expiry frees only its own slot, `$333A`'s update and its draw-list scan walk the slots in ascending order and skip holes (the count word is the number of occupied slots), and survivors keep their slot index. (Whether the original's scan stops after `$156AE` live entries or visits all 30 slots is equivalent while the count equals the number of occupied slots; the remake derives the count from the slots and scans all 30, skipping holes.) The slot order is the insertion order of effects into the draw list (map-rendering.md 7.2b), and a full pool (30 occupied) is what makes `$1237C` return without a sprite (enemies.md section 6). Ported as `EffectPool` (`src/game/effect-pool.ts`, `ObjectLayer.pool`); the remake's saves store all 30 slots since version 8 (remake-save.md), and a dense list from versions 6/7 can only be migrated with assumed slot numbers.

`$1237C(x, y)`: if the cell is inside the window (not otherwise: plays a sound only), takes the first free entry: +0 type = `$12` (or `$14` when the lift variable `$12D68` is non-zero, which is also stored in +6), +1/+2 cell, +3 = 0, +4..+7 = 0, **+5 = 4**. In `$333A` each pass `subq.b #1, +5`; below 0 the entry is freed; otherwise the entry is drawn with frame = +5, lifted by +6, flags 0. So an explosion is visible for frames 3, 2, 1, 0 (the frame offsets of type 18 are 0, 600, 1200, 600, 0: it swells and shrinks). One step per pass (see 2 for the timing doubt).

### Blast ownership: which demolitions are blasts, and how `$1237C` is applied [V static, no emulator comparison]
Static Disk.1 trace of `$12332`, `$7372`, `$75A8`, `$1237C` and every caller of `$7372`:
- **`$12332` ("bomb")** = clear `$7C28` to `$FFFF`, set bit 4 of `$156A9`, `jsr $7372`, clear the bit, `$1346A++` (always, even when nothing was demolished), clear `$12D68` (lift), then for EACH cell of the `$7C28` list: clear bit 3 of `$1581`, push A6, `bsr $1237C`, pop A6. So an area blast makes one `$1237C` call (sprite + sound, or the off-view / full-pool outcomes below) PER LISTED CELL, with sprite type `$12`, lift 0 and the area sound, and the call does not clobber the caller's A6 (unlike the combat path, enemies.md section 6).
- **The list** is written only by `$75A8` (called at `$74D6`, the real-building branch of `$7372`): the record's origin, and for a type whose first word is not 1 the other three cells of the 2x2 footprint in the order (x+1,y), (x+1,y+1), (x,y+1). Clearing ground (`$739E`), cancelling a construction site (`$74FE`) and every refusal leave it empty, so bombing such a cell counts in `$1346A` but makes no blast.
- **2x2 terminator:** `$75A8` writes `$FFFF` after the one-cell entry at `$7C2C`, but the 2x2 path overwrites that word with its second cell and does not write another sentinel at `$7C38`. The local image's initial `$7C38` word is `$FFFF`, and no code writer was found, so the four-cell loop currently relies on that initialized terminator (static assumption; no runtime watchpoint capture).
- **Callers of `$7372`:** (1) the player's demolish click (`$7372` alone: no `$12332`, no blast); (2) mine collapse `$11090` (`$7372` alone at `$110D8`, then `$11432`, message `$DF`, morale: no `$1346A`, no blast); (3) `$12332`, called by arson `$10D00` (`$10D60`), the meteor impact `$11676` (`$116B8`, once per cell of the 5x5 window whose map word has `$0400`, read live), and the enemy attack/claim paths (`Sim.bomb` call sites in enemies.ts). The other `$12332` callers listed in sfx.md (`$11A50`, `$11CFC`, `$122AC`, `$12798`) are not individually mapped.
- **Meteor centre:** neither `$3626` (the countdown and, at 0, `jsr $11676`) nor `$11676` calls `$1237C` for the impact centre; the only blasts of an impact are those of the bombed building cells. The port's old extra centre blast (`meteorImpact` -> explosion sound + sprite) had no counterpart and was removed from the presentation (the `meteorImpact` effect is still emitted by `Aliens.impact` for headless consumers).
- **`$1237C` is the same routine for every caller:** in the 8x8 window at (`$144E4`, `$144E6`): first free of the 30 fixed slots (full -> return early: no sprite AND no sound), sprite + volume 64; outside: volume 32 sound only, no pool use. Window test, volume and pool rule are therefore applied once per cell, identically for area blasts and combat kills; only the parameters differ (lift/type, sound variant, A6).

Port: `MapScene.blastCell(x, y, lift, high)` is the single `$1237C` implementation (the combat `EnemyHooks.explode` returns its clobber flag unchanged); `Sim.bomb` passes `bombing=true` to the demolish hook, representing `$156A9` bit 4 only across `$7372`, then increments `$1346A` and emits one `explosion` effect per reported `$75A8` cell, which `MapScene` routes to `blastCell(x, y, 0, false)`. This scoped permission allows the original vent demolition while a unit occupies its cell; `$156A9` is outside `GameState`'s captured memory image, so the port models its effect as a call argument instead of writing a fictitious state byte. The demolish callback itself does not play a sound; presentation belongs to `$12332`'s per-cell loop. A void or invalid footprint report is unknown and produces no invented blast cell; the map hook reports `[]` for ground, construction sites and refusals. Arson now calls `Sim.bomb` (it previously demolished and counted by hand without calling `$1237C`). `Fleet.destroyShip` still emits `explosion` at the ship cell with lift 0 and the area sound; that caller's own `$12D68`/`$1581` parameters are not traced (HYPOTHESIS), only the shared window/pool rule now applies to it. Tank requisition (`$11280` -> `$4692` alone, no attacker mark) is silent: `ObjectLayer.removeUnit` (formerly `destroyUnit`, which spawned an effect unconditionally) only frees the slot and cell marks, with no effect slot, no sound and no pool use; `Sim` keeps the counts and morale. Combat destruction (`EnemySystem.destroyTank`, `$4692` with bit 5 of `$156A9` set by the attacker) still calls the blast hook (`blastCell`, high volume). Static trace only (the `$4732` bit-5 test); no emulator comparison. Coverage: `test/area-blast.mjs`.

### Marker pins (`$14540`, 8 x 10 bytes) [V]
The image's initial data has +0 = 1..8 (type = pin number) and +2 = $FF (`$866E` only rewrites +2 = $FF). Key n (1-8, `$3202`): the cell is scroll + selected cell (`$14636/37` = view cell); if a pin already stands there (any slot) it is removed (`$31BC`: bit in `$144B0` cleared, +2 = $FF, message $72); otherwise pin n is set to the cell (replacing its old position, bit n-1 of `$144B0` set, message $71). Key $22 (`$31CC`) clears all eight. `$3310` draws them after everything else with `$3694` (+3/+4 = 0, +5 = 0) and `$3768`.

## 7. Port (`src/game/units.ts`, `objects.ts`, `data/sprites.ts`)

- `loadSprites(disk1, disk2, record)` builds the 27 types from the two sheets; `SpriteSet.frame(type, frame, anim)` decodes a frame to palette indices + opacity (top row first).
- `UnitSystem` (units.ts): `spawn`, `spawnAtYard` (the exit order above), `order`, `remove`, `tick()` (one main-loop pass; the unit waits for its first move tick, then steps every pass; `UnitSystem.clock` is the shared `PassClock` of the sub-tick `$144C9`), `step(unit)` (= `$38E2`). Runtime slots are fixed at 99 entries; `units` presents occupied slots in ascending slot order and spawn chooses the first free slot. The occupied mark is bit 14 of the shared `world.cells` word, plus bit 2 in the shared per-cell flag plane. Map words use `y * 100 + x`; flag bytes use `y * 102 + x` (two padding bytes per row remain preserved). Hook `lost` for border exits (no morale change applied).
- `UnitSystem.fromDisk4()` hydrates all saved own-tank slots into a detached fixed-slot system. It copies the full control byte and raw source record/address, retains the raw flag pointer and resolves its reservation cell independently of the tank's current x/y. It validates occupied type, current position, direction and that the pointer targets a playable flag byte. It does not rebuild occupancy bits, invoke hooks, or update counters. `prepareDisk4TankLoad()` composes this with detached core preparation. Ground/air enemies and own ships/missiles also have detached fixed-slot decoders; `prepareDisk4HeadlessEnemies()` adopts the supported enemy roster and ship/missile records together without initialization or state writes, and experimental Disk.4 scene activation is available through the disk menu. This is not original post-load fidelity or Disk.4 roundtrip compatibility (see game-proper.md).
- Connected regression `test/tank-lifecycle.mjs` (yard production -> `spawnAtYard` -> marker pin -> tank window order -> walk to the
  pin, all inside one `MapScene`, nothing stubbed, details in sim-port.md "Tank yard"). One original Copperline run now
  observes a tank produced at (48,48), ordered through the right-click tank window to pin 1 at (52,49), and arriving after
  four cell steps: (48,48)→(49,49)→(50,49)→(51,49)→(52,49), directions 3, 2, 2, 2, eight passes per cell. The old cell's
  map/flag reservation cleared and the new one set at each step; arrival cleared +B and zeroed +6/+7. This confirms those
  transitions for that run. The optional `test/tank-original-compare.mjs` compares a live remake scene staged on the scenario-0
  map with that run's captured RAM (tank record, reservation pointer, map bit 14, flag bytes, `$144C9`, pin) at the post-order
  baseline and at 6, 14, 22, 30 and 38 passes: no divergence after fixing the arrival `+C` clearing (the remake had cleared `+C`).
  Only the baseline `$144C9` is copied from the capture. The section 5 route in `test/tank-lifecycle.mjs` is a synthetic regression
  (hand-staged terrain, same route shape), not an original comparison; the creation-time `$144C9` was still not recorded. The original tank window froze passes during a 97-frame observation;
  its pin artwork was not checked. No broad gameplay parity is claimed.
- `ObjectLayer` (objects.ts): `update()` once per scheduled main-loop pass; `MapScene` draws into alternating persistent pixel buffers at that pass boundary and keeps the displayed image between passes. The default browser cadence is four video updates per pass, while the original's CPU-bound loop measured four or five VBLs with pointer-dependent variation (map-rendering.md section 6); exact timing is not modeled. `admitted(scrollX, scrollY)` is the `$333A`/`$3694` step (own tanks, ships/missiles, enemy ground, enemy air, effect slots, alien, meteor; `kind` and flags per entry), `drawList` sorts it with the literal `$4860` selection sort (`draw-list.ts`), `beginFrame` adds the redraw gate and returns the `FramePass` that owns the one cursor and the neighbour marks of a redraw, and `drawMap(screen, scrollX, scrollY)` draws the 64 tiles, the sorted entries (each preceded by its flat neighbour tiles when flag bit 0 asks, map-rendering.md 7.4) and the pins last. `drawAfterCell(screen, scrollX, scrollY, vx, vy)` is a single-cell diagnostic over a fresh frame. `pickables` lists every admitted entry in sorted order (enemies, effects, alien and meteor are obstacles, not order targets). `toggleMarker(n, x, y)`, `clearMarkers`, `markerCell(n)`, `spawnEffect` (first free slot), `removeUnit` (silent removal, requisition), `pool` / `effects` / `effectSlots`, `extra` (an untagged list of other drawables, outside the traced list: appended last with flags 0, not saved, an explicit approximation) and `enemies` (an `EnemySystem`, stepped after the own units in every pass; its `drawables()` carry a `kind`; see enemies.md). Drawing writes no game state.
- `MapScene` creates the layer when it is given `{ sprites }` in its options (`loadSprites(...)` in `main.ts`).

## 8. Not traced / open

- `$12588`, spaceships (`$3A746`, `$42BE`), enemy ground (`$3A12C`, `$1193E`) and air (`$39E20`, `$11A9E`), guns `$11D34`: ported, see enemies.md.
- Unit/order windows and draw-list behavior are implemented from static traces, but live-original comparison covers only one tank order route. The specials `$144A8`, `$1449C` are drawn (map-rendering.md 7.2); no original frame/pixel comparison establishes their visual parity. The gate reset and map redraw are aligned to the modeled pass boundary, but machine-dependent frame timing is not reproduced.
- The exact animation speeds of units and effects across machines and pointer positions; only the Copperline 4/5-VBL observations and the single 5-VBL tank route are documented.
- `$14274`, `$14278`, `$14294` exact meaning; what happens when a unit enters a type >= $88 cell (does a rock vanish?) - not seen in `$38E2`.
