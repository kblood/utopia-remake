# World map rendering (static analysis of the game proper)

How the original draws the isometric world view in gameplay mode (`$14591 = 1`). Addresses refer to the game image (Disk.1 sectors $14C-$208 at $1000, "variant A"), see `game-proper.md` for the surrounding structure. No game graphics are reproduced here, only addresses, layouts and numbers. Helper tools: `tools/map_common.py` (loaders), `tools/map_render.py` (renders a view of any scenario to a PNG using the formulas below; this is how the projection was checked visually), `tools/map_verify.py` (asserts the formulas against the tables inside the game image).

Tags: **VERIFIED** = read from disassembly/data and cross-checked (by script or by a coherent rendering); **HYPOTHESIS** = inference.

## 1. Summary (VERIFIED)

- The map view is a fixed **8 x 8 cell window** of the 100 x 75 map, drawn as a **diamond** (2:1 isometric). Tile images are **32 pixels wide**, flat ground tiles are 15 rows high, buildings/rocks up to 30 rows, bottom-aligned on the cell.
- Everything is drawn by the **CPU** (no blitter registers are touched anywhere in the map code) into the back buffer of a double-buffered 320 x 200, 5-plane screen; every frame redraws all 64 cells and all visible moving objects.
- The 6th plane of a tile image is a **mask** (1 = opaque). Image rows are stored **bottom row first**.
- The scroll position is a pair of cell indices, x 0..92 and y 0..67 (inclusive), top cell of the diamond = map cell (scrollX, scrollY).
- In-game palette = the 32 colour words at the end of the unpacked main-screen background picture.

## 2. Per-frame sequence (VERIFIED)

Main loop `$157BC` (see `game-proper.md` section 3), only the drawing-relevant calls:

| Call | Purpose |
|---|---|
| `$333A` | Builds the **draw list** of moving objects at `$2954A` (12-byte entries, sorted descending by cell order index, terminated by $FFFF) and runs per-object update hooks. Also advances the slow-tick counter `$144C9` (0..8; bit 6 of `$156A9` at 4, bit 7 at wrap). |
| `$16012` | Restores the background of the map window and top bar into the back buffer (section 9). |
| `$6936` | Computes the map pointer for the current scroll in a6, animates map cells (section 7). |
| `$6540` | **Draws the 64 tiles in back-to-front order and interleaves the objects.** |
| `$3310` | Draws the 8 user marker pins on top of everything (section 8.5). |
| `$4D48`, `$4D1C`, `$4D96` | Text in the top bar: money (x 110, y 2), date (x 8, y 2), a second counter (x 224, y 2). Not map related. |
| `$5D30` | Draws small overlay images from a 4-entry table at `$15628` (not analysed). |
| `$4E08` (called after the VBL flag clear at `$15838`) | Swaps the two screen blocks (`$160F2`, `$1610E`), loads COP1LC. Drawing goes to the block whose plane pointers are at `$16116` (5 longs). |

The mouse pointer is software drawn into the displayed buffer (`$2F5E`/`$2FBA`, background saved at `$42F88`), clamped to x 0..$138, y 0..$C0 in **bitmap pixel coordinates** (hot spot = top-left of the pointer image). All hit tests below use these coordinates.

## 3. Scroll state (VERIFIED)

| Address | Meaning |
|---|---|
| `$144E4` word | scroll X (cell column of the diamond's top cell), 0..$5C (92) |
| `$144E6` word | scroll Y (cell row), 0..$43 (67) |
| `$144E8`, `$144EA` words | stored alternate position; new game default is the same as the current one |

- Limits: `$15A28` clamps x to 0..$5C and y to 0..$43 (so the window never leaves the 100 x 75 area; 92 + 7 = 99, 67 + 7 = 74).
- New game (init at `$866E`): both pairs are set to x = $2F (47), y = $21 (33). Whether loading a save or other paths override this was not traced (HYPOTHESIS that saves store the pair in the block `$14234...`).
- **Scrolling is only by the mouse; there are no cursor-key or screen-edge scroll rules.** `$15A28` (d2 = direction, d3 = step) is called from `$15966` (left button, step 1) and `$15F5E` (right button, step 6). Four diamond-shaped arrow buttons, hit rectangles `{x0,x1,y0,y1}` inclusive at `$5DAA`:

| d2 | Rectangle | Effect on scroll | Screen direction of the move |
|---|---|---|---|
| 0 | x 240-261, y 122-132 | y - step | up-right |
| 1 | x 216-237, y 122-132 | x - step | up-left |
| 2 | x 216-237, y 136-146 | y + step | down-left |
| 3 | x 240-261, y 136-146 | x + step | down-right |

- Holding the left button on an arrow repeats the scroll once per main-loop pass (`$50B2` keeps returning "clicked" while bit 0 of `$156A9` is set, and `$15966` sets it). A normal map click acts only on the press.
- Rectangle x 16-31, y 139-155 (`$5D70`, handled at `$159CE`) swaps the current scroll pair with the stored pair at `$144E8` (a "jump back" bookmark).
- The overview-map screen (`$F2E0`) sets the scroll directly: `scroll = (pixel - 8) / 2 - 4` per axis, not clamped there (HYPOTHESIS: the overview limits the clickable area so values stay near the legal range; a remake should clamp to 0..92 / 0..67).
- Keys 1-8 (`$3202`) place one of 8 marker pins at the selected cell; key `$22` (`$31CC`) clears all pins (section 8.5).

## 4. Projection (VERIFIED)

View cells (vx, vy), vx, vy in 0..7, map cell = (scrollX + vx, scrollY + vy). Top vertex of the diamond = view (0,0); right corner = (7,0); left corner = (0,7); bottom = (7,7).

```
anchorX(vx,vy) = 112 + 16 * (vx - vy)      // left edge of the 32-pixel-wide image
anchorY(vx,vy) =  39 +  8 * (vx + vy)      // the row just BELOW the image's bottom row
image rows occupy y = anchorY - rows ... anchorY - 1     (rows = descriptor rows-1 + 1, max 30)
cell box (used for hit tests and objects): x0 = anchorX, y0 = anchorY - 15 (= 24 + 8*(vx+vy)), size 32 x 15
```

These formulas reproduce all 64 entries of the draw table at `$7828` exactly (12 bytes per entry: word map byte offset = 2 * (vy*102 + vx), word screen byte offset = anchorY*40 + anchorX/8, then four words giving the table-entry distance in bytes to the neighbour cells (vx+1,vy-1), (vx+1,vy), (vx,vy+1), (vx+1,vy+1), 0 when that neighbour is outside the 8 x 8 window). Screen byte offsets assume 40 bytes per row; anchorX is always a multiple of 16, so the CPU blit works with word-aligned longs.

Drawing order (the order of table `$7828`): diagonals by `vx + vy` ascending (0..14), inside a diagonal by `vx` ascending. The ordinal of a cell in that sequence is `seq` (0..63); the object code uses `order = 63 - seq` (tables `$7B28`: cell id word `vx << 8 | vy`; `$7BA8`: `order` at index `vx + 8*vy`).

The window covers x 0..255 (cell boxes) and y 24..~158. Tall images extend above the anchor, so the top of the diamond can draw into the top bar rows (the top bar background is restored *before* tiles, then text on top). The right clip for objects is x ~ 255 (section 8.3).

Pseudocode (map `m` = 100 x 75 array of 16-bit words, stride 102 in memory but a 2-D array in a remake):

```ts
for (let s = 0; s <= 14; s++)
  for (let vx = Math.max(0, s - 7); vx <= Math.min(7, s); vx++) {
    const vy = s - vx;
    const order = 63 - seqOf(vx, vy);
    drawTile(map[scrollY + vy][scrollX + vx], 112 + 16*(vx - vy), 39 + 8*(vx + vy));
    drawObjectsWithOrder(order);          // section 8
  }
drawMarkers();                            // section 8.5
```

## 5. Tile images and the blit (VERIFIED)

- Cell word: low 10 bits = tile id, high 6 bits = flags. **Descriptor index = (word & $3FF) - 1** (`$6588`: `subq #1`, `andi #$3FF`, `lsl #3`); id 0 would give index $3FF (outside the table; no map in the data set contains id 0 or 1 below 2, ids seen in all 10 scenarios: 2..161).
- **Ids are 1-based, so id 161 is valid** (VERIFIED over all 10 scenarios with `tools/map_common.py`): the maximum id is 161 and there are no ids above 161 and no id 0. Id 161 maps to descriptor index 160, the last of the 161 entries (0-160). The 1,200-1,600 cells per scenario with id 161 are the fourth flat ground variant (ids 158-161 are four flat ground images that make up 4,800-6,650 cells per scenario). There is no remap, object or special value involved in these ids; an implementation that indexes the table with the raw id (no `- 1`) goes one past the end for id 161 and shifts every tile by one. Ids 1-13 are the animated building ids of section 6, the border pad value $73FF (id $3FF) never appears inside the 100 x 75 area and is never drawn because the scroll limits keep the window inside it.
- Descriptor table: pointer in `$1612E`, 8-byte entries `{long rows-1, long absolute data address}`, 161 entries. Entries 0-94 come from the Disk.1 tile sheet (offsets relative to sheet + $508, relocated by `$7C62`), entries 95-160 from the scenario's graphics (relocated at `$7CA6`: offset + (`$1612E` + $CA00)). Map ids 96-161 therefore select scenario-specific images (ids 98-161 are terrain: rocks and craters with blocked flag, and four flat ground variants 158-161); ids 1-95 are shared buildings and base parts.
- Image data (per image): `rows` rows of 4 bytes (32 pixels) per plane, planes 0..4 one after the other, then the **mask plane** (6th) = `24 * rows` bytes total. **Rows are stored bottom row first** (the unrolled blitter reads the data backwards while writing the screen top-down).
- Blit routine `$6540` (base tile at `$655E`-`$65D6`): for each of the 5 bit-planes it calls a 30-group unrolled routine at `$6754` (16 bytes per group, one row per group: `dst = (dst & ~mask) | (src & mask)` on one 32-bit long, destination row stride 40 bytes). The entry address is `$6754 + (30 - rows) * 16`, so any height up to 30 rows works; destination = plane pointer + `anchorY*40 + anchorX/8` - 1200. Plane order in the loop is 4 down to 0 (irrelevant for the result).
- Mask polarity: bit 1 = image pixel is drawn; 0 = destination kept.
- The cursor/selection tile: when the cell equals the selected cell (word `$14636` = `vx << 8 | vy`, -1 = none) the descriptor with index 58 (`$1D0 / 8`) is drawn instead of the real tile on every second draw of that cell (bit 1 of `$156A9` toggles each time; HYPOTHESIS that this gives the selection blink).
- Large (2 x 2) buildings are just four neighbouring map ids. Ids $48-$5F are 24 ids = 6 buildings x 4 parts; table `$77C8` (2 words per id: type word, footprint offset word with 0, $100, 1, $101 for the parts) is used only by the building-record builder `$6D78` and the overview map `$F41E`, **not** by drawing. The same ids are drawn as a composite of 4 images by `$6A22`/`$69D8` for user-interface previews (x/y given are the bottom row; `$69D8` blits upward from the bottom row).
- Verified by rendering: with these rules the tile images fit the diamond pad of the main-screen picture exactly and tall rocks/buildings overlap correctly for all 5 graphics sets (`tools/map_render.py`).

### Cell flags (high 6 bits)

- Bit 10 ($0400): "animated cell". The only flag the drawing code looks at (section 7).
- Bits 11, 14, 15 are preserved by the tile writers (`andi #$E800`).
- Data observation (scenario 0, 3): bit 12 ($1000) is set on all rock/crater ids and on building ids, together with the border pad value $73FF: **HYPOTHESIS: blocked/occupied terrain.** The path finder at `$3A00` tests bit 12 and uses bit 14 (`bset #6` of the high byte) as a visited marker (VERIFIED code, interpretation HYPOTHESIS). Bit 11 and bit 15 occur on ground tiles (meaning unknown, possibly resource/ownership markers); bit 13 not seen in the data.

## 6. Animation of map cells, `$6936` (VERIFIED code; timing HYPOTHESIS)

Runs once per main-loop pass, for each of the 64 window cells whose flag bit 10 is set (also sets bit 3 of `$156A9`, "needs redraw"):

- id 1..3: id + 1, wrapping 4 -> 1 (3-frame loop; ids 0, 4, 5 not animated).
- ids 6..13, only while byte `$144C8 < 4`: id + 1; if the result is 10 or > 13 then id - 4 (two 4-frame loops: 6-9 and 10-13).
- other ids: unchanged. The low byte of the map cell is rewritten in place, so the animation state lives in the map.
- Because it runs per pass, the animation speed equals the main-loop speed (at most one step per 50 Hz frame; the real pass time is not known statically). A remake should pick its own rate (HYPOTHESIS: a few steps per second).
- Meaning of `$144C8` (set at `$A17E`/`$A1B6`, compared in several places) not determined.

## 7. Moving objects over the map (VERIFIED structure, field meanings partly HYPOTHESIS)

### 7.1 The 8-byte records of `$6D78` are not drawn

The records at `$3B466` (built from the map by `$6D78`: type word, bytes, x, y, rand) are **building/game-logic records**. Buildings appear on screen only through their map tile ids (section 5). Only objects in the arrays below are drawn as sprites.

### 7.2 Object arrays and the draw list

`$333A` walks several arrays (the first byte of an entry = type, 0 = free slot) and, via `$3694`, turns each visible entry into a draw-list entry `{word order, word y, word x, long entry address, word flags}` (12 bytes) at `$2954A`:

| Array | Stride | Count variable | Flags in draw list | Notes |
|---|---|---|---|---|
| `$3AB06` | $18 | `$1429C` (max 99) | 1 | units/vehicles; neighbour redraw applies (8.2) |
| `$3A746` | $18 | `$1429E` | 0 | uses lift byte +$10 |
| `$3A12C` | $1A | `$142A2` (max 60) | 3 | |
| `$39E20` | $1A | `$142A4` (max 30) | 2 | uses lift byte +$10 |
| `$39D42` | 8 | `$156AE` | 0 | short-lived effects; counts down byte +5, frees at 0; lift byte +6 |
| `$144A8`, `$1449C` | single | - | 0 | special effects |

Common entry layout: +0 type (index into the sprite descriptor table, 1-based), +1 map x, +2 map y, +3 signed byte pixel dx, +4 signed byte pixel dy, +5 frame/direction index. `$3694` returns **screen position = (pick-table x0 + dx, pick-table y1 + dy)** for the object's cell where `x0 = 112 + 16*(vx-vy)` and `y1 = y0 + 14 = 38 + 8*(vx+vy)` (the bottom row of the cell box), minus the lift byte for some arrays. The object is skipped when its cell is outside the 8 x 8 window; a few extra rules for cells in the last column/row (vx = 7 or vy = 7) hide objects that are moving out of the window depending on type (types $12/$14 are always shown) and the sign of dx/dy (code at `$36D4`-`$3732`).

The list is sorted by `$4860` (selection sort on the first word, **descending**, 12-byte entries) so the entries come in the same order as the cells are drawn.

### 7.3 Sprite descriptors and the sprite blit (VERIFIED)

- Descriptor table `$12D6A`: 21 entries of $22 bytes in the game image, followed directly by 6 more entries that are the first 6 descriptors of the scenario block (`$13034`); type t uses entry t - 1 (27 types).
- Entry layout: +0 long image address, +4 long mask address, +8 word frame size in bytes (480 or 600), +$A word rows-1 (19 or 24), +$C word unused, +$E..+$1E nine words = byte offset of each frame (indexed by byte +5 of the object, 0..8), +$20 word = bytes per plane. The address longs of the 21 built-in entries are relocated at `$7CF0` by the base `$16136` (the Disk.1 block of sectors $25C-$280, 47,280 bytes after unpacking).
- Frame layout (32 pixels wide, 20 or 25 rows): 5 bit-planes of `rows * 4` bytes, then the mask plane (mask address = image address + 5 * rows * 4), **bottom row first**, exactly like tiles. Types 1-8 are small numbered pin markers, 9-17 are vehicle-like sprites with 8-9 facing frames, 18-21 are effect animations with 3-4 frames (rendering them confirms the layout).
- Blit `$3260` (called from `$3768`): d0 = x, d1 = y of the **bottom row**, rows are written upward (stride -40), any x pixel alignment via shifts, `dst = (dst & ~mask) | (src & mask)` per plane. Objects with x < 0 or x > 255 are not drawn; the sprite is clipped on the right by a mask table `$4C9A` for x >= 224 (visible pixels end around x = 254/255, i.e. the window edge).
- For type $18 the frame address is advanced by `+8(descriptor) * 8 * byte $14(entry)` (animation counter); purpose not explored.
- Scenario descriptors (types 22-27): the scenario loader (`$8B02`, `$7D0E`) reads the record's +$10 sector pair raw to `$16136 + $BA00`, and `$8B5C-$8B80` adds that base to the six descriptors at `$13034`. Implemented in `src/data/sprites.ts`. Details, the per-type content and the unit/effect/pin logic: `units.md`.

### 7.4 Draw order interleaving, `$6540` (VERIFIED)

After drawing the tile of cell `seq` (unless it was already drawn early, see below), the code draws every draw-list entry whose order word equals `63 - seq`:

- flag bit 1 set: drawn only if bit 3 of `$156A9` is set (HYPOTHESIS: dirty/"something changed" gating for effects).
- flag bit 0 set (units): if the unit has a pixel offset (bytes +3/+4 not both zero) and facing byte +5 is 1..5, the **neighbour cells in front of it are drawn first** so the unit appears on top of them: facing 1: cells (vx+1,vy-1) and (vx+1,vy); 2: (vx+1,vy); 3: (vx+1,vy), (vx,vy+1), (vx+1,vy+1); 4 or 5: (vx,vy+1). A neighbour is drawn only if its image has at most 16 rows (flat tiles; rows-1 < $10), and each neighbour is marked (bit 15 of the screen-offset word of the `$7828` entry) so that it is skipped when its own turn comes (`bclr` at the start of the cell loop). Facing 0 or > 5: no neighbours.
- then the sprite is blitted with `$3768`.

For a remake the equivalent is: draw tiles in painter order, and draw each object right after its own cell, additionally after the flat tiles of the cells the unit overlaps in its facing direction.

### 7.5 Marker pins (VERIFIED)

`$14540`: 8 entries of 10 bytes {type 1..8, x, y, ...}, set by keys 1-8 at the selected cell (`$3202`), cleared by `$31CC` (`st` on the y byte). `$3310` draws them **after** all tiles and objects (not depth sorted) with the same position formula and sprite types 1-8.

## 8. Selection, picking (VERIFIED)

`$5CDA` (called on a left press from `$158CA`, and by `$3EDC`/`$2FE8`): tests the pointer against 72 rectangles at `$5E58` (16 bytes each, index `vy*9 + vx`, vx 0..8, vy 0..7): `{x0, y0, x1, y1}` = `{112+16(vx-vy), 24+8(vx+vy), x0+31, y0+14}` inclusive, then the cell word `vx<<8|vy` at +8. First matching rectangle in index order wins (rectangles overlap, so picking is rectangle-first-match, not exact diamond); a hit with vx = 8 means "no cell". Result is stored in `$14636` (-1 when none). The map cell for logic is `(scrollX + vx, scrollY + vy)` (`$6A5A`).
The pointer image changes while it is over a cell (second pointer variant at `$4A74`).

## 9. Screen layout, background restore, palette

### Palette (VERIFIED)
- Gameplay uses the **32 OCS colour words stored at offset 40,000 of the unpacked main-screen background picture** (Disk.1 sectors $282-$2A0 -> 40,064 bytes, 5 planes of 8,000 bytes then 32 words). At init `$2B1A` copies the picture to both screen buffers, `$2B2A` loads the palette from chip `$7FA40` (= `$75E00 + 40,000`, i.e. the palette tail of buffer A) with `$2E26` (CPU writes to COLOR00-31). Screens that return to the map (`$15EA2`, `$F38A`, `$8080`) reload the same `$7FA40`. Other full-screen pictures load their own palette from `$3998A` (tail of the picture at `$2FD4A`).
- The copper list (`$2EA4`) contains no colour moves; no palette animation or fading was found (the only COLOR writers are `$2E26`/`$2E36`).
- All 10 scenarios use this palette; tile sets differ per scenario, the palette does not (renderings with this palette look coherent for 5 sets).

### Layout of the main screen (VERIFIED from rectangles in code and from the picture geometry)
- Display 320 x 200, 5 planes lowres, planes at 8,000-byte steps (`$75E00 + 8000*n` and `$6C000 + 8000*n`).
- Top bar y 0..23: date, money, counter text (section 2).
- Map window: diamond pad, cell boxes x 0..255, y 24..158.
- Scroll arrows: 4 rectangles at x 216-261, y 122-146 (section 3).
- Command buttons, two columns x 272-287 and 296-311, five rows y 63-78, 82-97, 101-116, 120-135, 139-154 (rectangle table `$5E06`, d2 order: (272,63) (296,63) (272,82) (296,82) (272,101) (296,101) (272,120) (296,120) (296,139) (272,139)); these are the icon dispatch of `game-proper.md` section 3 (the picture shows the button artwork).
- Mode icon area at the top right: image drawn with its bottom row at (272, 52) by `$6B10`/`$6A22` (tile ids $39 or $3A, descriptors 56/57).
- Bottom message/status panel y ~168..199 (text drawn by `$551A`).

### Per-frame background restore, `$16012` (code VERIFIED, purpose HYPOTHESIS)
Before the tiles are drawn, `$16012` rewrites parts of the back buffer so objects and tall images from the previous frame do not leave trails:
- rows 0-23, full width: tiled from a 32 x 16 texture strip that `$4E7E` copied out of the background picture (byte offset $10, i.e. x 128-159, rows 0-15, all 5 planes, stored at `$16BB2`);
- rows 24-87, x 0-255: rebuilt from a generated pattern table at `$14640` (made by `$15F9A`) ANDed with that strip;
- rows 89-159, x 0-255: copied from a saved bitmap at `$26372` (71 rows x 32 bytes x 5 planes);
- x 256-271, rows 47-96: a 16-pixel column restored from `$2617E`.
A remake can simply redraw the pristine background picture for the region x 0..271, y 0..159 each frame (HYPOTHESIS: visually equivalent; the generated pattern for rows 24-87 was not decoded, and the render with the plain picture looks coherent).

## 10. Unknown / not verified

- Meaning of flag bits 11, 13, 15 and exact meaning of bit 12 (blocked/occupied is a hypothesis).
- Real animation rate of cells and objects (depends on the pass time of the main loop).
- Purpose of the draw-list flag bit 1 gating (`$156A9` bit 3), of `$144C8`, of the type-$18 frame logic, and of overlay table `$15628` (`$5D30`).
- Which game entities the arrays at `$3A746`, `$3A12C`, `$39E20`, `$39D42` hold (types and behaviour), the exact sub-cell offset ranges (dx, dy) of moving objects, and the hide rules at the window edge (`$36D4`-`$3732`) beyond the sketch above.
- Types 22-27 (scenario sprites): loading and relocation are traced (7.3); entries 24 and 27 of scenario 0 are all zero. What the enemy sprites are used for is in `units.md` section 8 (not traced).
- Whether a loaded save restores scroll, and the default scroll for scenario starts beyond the new-game init (47, 33).
- The generated pattern behind rows 24-87 of the background (section 9).
- Variant B of the slave (different patch addresses) was not compared; the map code itself is not patched by the slave.
