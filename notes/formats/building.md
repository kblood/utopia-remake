# Building: placement, construction, demolition

Ports in `src/game/build.ts` (rules) and `src/game/controls.ts` (mouse, modes, menu). Verified by
`test/build.mjs` (place, count down, complete, demolish, then 3 simulated years). Addresses are
original game-image addresses (see game-proper.md).

## Click flow (`$158CA`)
A left press picks a cell with `$5CDA` (map-rendering.md section 8), computes the map cell
(`$6A5A`: scroll + view offset, stored at `$142BA/$142BC`), then dispatches on the mode byte `$14591`:
1 = select (`$311E`/`$7140`; `createBuildingScreen()` dispatches implemented storage, command-centre, fuel, hospital, missile, shipyard, sports, gun and teleport interactions, with generic name/refusal handling for other records), 2 = build (`$6BF4`), 3 = demolish (`$7372`). The selected-building windows are tested in `test/buildings.mjs` using local Disk.1/Disk.2 assets; no original screenshot comparison is claimed.

Command buttons (rectangles `$5E06`, table order in `src/game/controls.ts`): 0 = build menu (`$6BA2` -> `$B2AA`, sets mode 2), 1 = overview, 2 = demolish (`$15ECA`, mode 3), 3 = marker mode, 4 = trade, 5 = council, 6 = staffing, 7 = intelligence, 8 = disk menu, and 9 = pause. Their remake dispatch is wired through `Controls` and `Game.openScreen()`; the original floppy operations behind disk-menu icons remain remake pages rather than emulated floppy screens.

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
richness count in +6; solar tiles $0F/$1F get a phase from the beam-position bit. The remake approximates this with a World-owned seeded PRNG, added to native save version 4 and retained in version 5; this does not reproduce beam timing. The cells are rewritten by `$6A8C`
(tile, +1, +2, +3 for a 2 x 2).

## Demolition `$7372`
Construction site: removed, workers returned (money is not refunded). Cleared/ground tiles ($61,
$94-$9B, $38): become $9E. Buildings: stored amounts reduce by their share, farms return 10 workers,
a warehouse reduces stocks, weight and capacity; the cell becomes the cleared tile $38. Others: message $58.
Only the real-building branch lists blast cells (`$75A8` at `$74D6`: the origin, plus the other three cells of a 2x2); `Builder.demolish(x, y, footprint?)` reports them. A plain demolition (click, mine collapse) never blasts; only `$12332` does (units.md section 6, "Blast ownership").

## Build menu (`$B2AA`, static selection mapping verified; panel layout traced statically, art parity not compared)
Three pages of buildings (lists at `$E9A0/$E9B6/$E9CC`); research bits of `$14472` put tiles into the lists
(bit 12 -> $42, 7 -> $0A, 11 -> $0F, 13 -> $31, 14 -> $34, 15 -> $47; page 2: bit 1 -> $40, 0 -> $3C,
5 -> $35, 6 -> $61). Of those, bit 15 (page 1 slot 10) and bits 0, 5, 6 (page 2 slots 8, 9, 10) fill slots that
`$B2AA` first sets to `$FFFF` (no building), see "Menu panel rendering" below. The remake draws the panel with
`src/game/build-menu.ts`; the facts it follows are in that section. All of it is STATIC evidence (disassembly of the
local Disk.1 game image plus the table bytes); no emulator run compared the panel's pixels.

**Static list and selection data (Disk.1, variant A):** the 11 big-endian words at `$E9A0` are
`2F,01,41,44,3E,06,60,1F,30,33,47`; at `$E9B6`: `0E,3D,3F,04,43,45,46,36,3C,35,61`; at `$E9CC`:
`48,4C,54,58,5C` followed by `$FFFF` entries. These are the building tile lists in table order. The page-pointer pairs at
`$E988` are (tile list, hitbox list): (E9A0,E9E2), (E9B6,E9E2), (E9CC,EA3C). The click loop `$B440-$B546` calls
`$5730` with the current hitbox list, then indexes the tile list with the returned hitbox index; `$5730` tests inclusive
rectangles laid out as `{x0,x1,y0,y1}`. Therefore page 2 tank yard tile `$45` is list index 5 (zero-based), rectangle
`{16,47,100,130}` in Amiga screen coordinates. This resolves the selection target statically; the emulator run below
then observed that selection, a placement and the completion of the tank yard.

The 11 `$E9E2` rectangles, in index order, are `{16,47,50,80}`, `{48,79,50,80}`, `{80,111,50,80}`,
`{112,143,50,80}`, `{144,175,50,80}`, `{16,47,100,130}`, `{48,79,100,130}`, `{80,111,100,130}`,
`{112,143,100,130}`, `{144,175,100,130}`, `{176,207,50,80}`. `$B3D8` is a modal input loop: it repeatedly calls `$50B2`
without an intervening VBL wait, then branches back to `$B3D8` while the input routine reports no completed action. It does
not return through `$157BC/$333A` until exit, so map simulation and entity movement wait. The remake polls modal input once per
video update (50 Hz), the fastest cadence exposed by its browser input layer; it does not reproduce the original's tight CPU loop.
On exit, `$158C6` branches directly to `$157BC` without a VBL wait. The remake counts video frames during the modal interval
but freezes the outer-loop phase, then runs the next simulation pass on the next browser update.

### Menu panel rendering (`$B2AA` .. `$B680`, `$B258`, `$6A22`/`$69D8`, `$6B3C`; STATIC, 2026-11-06)
Read from the player's local Disk.1 game image with the existing image tools (read-only, no emulator). Pixel
coordinates are Amiga bitmap rows/columns (row 0 = first row of the 320 x 200 bitmaps); text origins are the top-left of the
6-row glyph box as in `game-text.md`. No asset bytes are reproduced here.

1. **Open `$B2AA` (STATIC).** It rewrites the three list tables in RAM: page 1 (`$E9A0`) slots 2, 5, 7, 8, 9 are set to
   `$41`, `$06`, `$1F`, `$30`, `$33` and slot 10 to `$FFFF`; page 2 (`$E9B6`) slot 2 to `$3F` and slots 8, 9, 10 to
   `$FFFF`; then every set research bit puts its tile into its slot (page 1: bit 12 -> slot 2 `$42`, 7 -> slot 5 `$0A`,
   11 -> slot 7 `$0F`, 13 -> slot 8 `$31`, 14 -> slot 9 `$34`, 15 -> slot 10 `$47`; page 2: 1 -> slot 2 `$40`, 0 -> slot 8
   `$3C`, 5 -> slot 9 `$35`, 6 -> slot 10 `$61`). So without bit 15 / 0 / 5 / 6 those four slots hold no building and
   cannot be drawn or selected (`$B258` and `$B546` skip a negative entry). (The Disk.1 image itself still holds `$47`,
   `$3C`, `$35`, `$61` at those slots; the remake's earlier list offered them from the start, which this trace does not
   support, and `menuTiles` now blanks them.) It then sets mode `$14591` = 2, draws the panel and copies the last
   committed selection `$142B2/$142B6` into the pending cells `$142AA/$142AE` (`$B386`). The current page lives in `$156B0`
   with its list/rectangle pointers in `$14638/$1463C` (initialised to page 1 at `$8786`); `$B2AA` does not reset them, so the
   original reopens on the page last shown. `Controls` now retains its current page when the build menu is closed and reopened.
2. **Panel frame `$B680` with window `$E908` = {x 0, y 24, 31 columns, 21 rows} (STATIC).** A frame of 8 x 8 pieces
   (corner, edge and fill pieces) filling x 0-247, y 24-191. The piece buffers at `$16CF2..$16EAA` are zero in the
   Disk.1 image, so the pieces are copied at runtime exactly as for the other windows (`screens.md`): the remake draws it
   with `Ui.frame`.
3. **Command button column `$B3C0` -> `$58A0` with image table `$E95C` (STATIC).** Ten 16 x 16 button images at the
   `$5E06` rectangles; entries 0-7 are 0 (default blank image `$185A2`), entry 8 = `$174C2` (page button) and entry 9 =
   `$17422` (exit button). The remake reads these through `Ui.readButtonTable`/`drawButtons` (the image layout is the
   one `$5876` draws: 5 planes of 16 words). Buttons 8/9 are the two the menu loop polls (`$B400-$B40A`); other buttons do
   nothing. The press (`$B41A-$B43E`) only runs `$5756` (flip of plane 3, colour ^ 8, and id 4 for any of the ten rectangles, blank ones
   included); `$B3F2-$B40A` acts on the release edge with the index `$5DD4` recorded at the press (STATIC, no emulator capture): `$57FA`
   flips the button back, then 8 advances the page and 9 exits; buttons 0-7 do nothing. The loop has no right-button branch and no
   pause handling (the menu cannot open while paused: `$15AB4-$15ABC`). The remake now draws the pressed button flipped
   (`MenuView.pressed`) and runs page / exit on the release (`Controls.menuPress` / `menuRelease`; `test/build.mjs`,
   `test/build-menu.mjs`, `test/map-loop.mjs`). The right-click cancel of the remake is a convenience that the original lacks.
4. **Title.** String index 4 ("Select a building.." in the English table) drawn at (83, 30) (`$B3B0-$B3B4`, `$538A`). The
   remake's earlier invented "PAGE n/3" header does not exist in the original; there is no page number on screen.
5. **Items `$B258` (STATIC).** For the 11 slots (loop count `$A`+1) it takes the page list entry (skips a negative one)
   and the slot's rectangle: x = rectangle `x0`, bottom row = rectangle `y1` (the rectangle word at +6). Tile ids `$48-$5F`
   are 2 x 2 buildings and get x + 16 (`$B26E-$B27C`). `$6A22` then calls `$69D8` per tile with d5 = 1-based tile id into
   the descriptor table `$1612E` (the same decoded tiles as the map): image rows are stored bottom row first and are drawn
   upward from the given row (`$69D8` subtracts 40 bytes per row), five colour planes selected by the sixth plane as mask
   (`mask = (image & mask) | (screen & ~mask)`), 32 pixels wide, x truncated to a byte column. With the 1 x 1 tiles of
   pages 1 and 2 (at most 30 rows in scenario 0) this puts the image inside the 31-row rectangle `y0..y1`. 2 x 2
   composition `$6A22` (STATIC): top tile (id) at (x, row - 16), right (id + 1) at (x + 16, row - 8), left (id + 2) at
   (x - 16, row - 8), bottom (id + 3) at (x, row), drawn in that order (the same diamond `$6A8C` writes into the map
   cells). With the +16 the 64-pixel diamond fills the 64-pixel-wide page-3 rectangles exactly.
6. **Click and detail lines `$B512-$B624` (STATIC).** `$5730` over the page's rectangle table gives the index; the page
   list entry at that index (negative = ignored) is looked up with `$6BE0`; d1 = +6 cost word is compared with the money
   long `$135BA` (`bgt` = more than the money). Affordable: `$142AA/$142AE` = tile and type row, and a 21-column strip at
   (16, 177) is cleared. Not affordable: `$142AA/$142AE` = 0 and string `$25` (English: a "you can't afford that
   building" line) is drawn at (16, 177). Both cases then draw the type row's name string (+`$10`) at (16, 159) after a
   21-column clear, and string `$26` ("Cost: xxxxx Gr.", a 5-character placeholder at offset 6) at (16, 168) after a
   10-column clear, with `$15C5A` writing the T+6 price into the placeholder with divisor 10000 (leading zeros become the
   blank glyph `$23`). Then `$6B3C` runs and the loop returns to `$B3D8`: **the menu does not close on an item click**.
   `$6B3C` erases the 8-column x 56-row area at (176, 126) and, if `$142AA` is non-zero, draws that tile (or 2 x 2
   building) with `$6A22` at x 192, bottom row 181, i.e. the selected-building preview inside the panel.
7. **Exit and page buttons `$B3E8-$B40C`, `$B45E` (STATIC).** Button 9 (exit) runs `$B628` and returns `$142AA/$142AE`;
   `$6BA2` then stores them in `$142B2/$142B6` and, with a non-zero tile, draws the side preview (`$6B10`, tile at (272, 52))
   and continues in build mode; with zero it jumps to `$15EF0` (mode 1, selection cleared). Both run on the release of the button (`$B3FA`, see step 3). Button 8 advances `$156B0`
   modulo 3 and loads the matching `$E988` pointer pair. It waits for a VBL before the erase loop (`$B48A-$B49A`), then
   performs 14 successive 28-column x 8-row pattern fills from (16, 46) (`$B4CA-$B4E0`) with **no VBL wait inside
   the loop**. After the loop it waits once (`$B4E4-$B4F4`), calls `$6B3C` (which has its own VBL waits), redraws items
   with `$B258` and returns to the modal loop. The name/price lines are below the cleared area and stay. The remake does
   not animate 14 strips across video frames; it switches to the destination page in the release update, representing the
   resulting menu state. No running-original screenshot comparison exists.
8. **Evidence relation to the tank-yard trace.** The observed run saw the name and price lines after selecting tile
   `$45` and, later, the placement; neither contradicts the exit-button return path above, but that trace does not say whether
   an exit click happened between them, so the fact that an item click does not close the menu rests on the static loop alone.

**Implemented from the above (`src/game/build-menu.ts`, `Controls`).** The renderer draws, in this order: frame (`$E908`),
button column (`$E95C`), items (the same `menuItems` that hit testing uses, anchored per step 5), title (string 4), the detail
lines when an item was clicked (name, price, and the unaffordable line), then the preview area erase/draw. `Controls` keeps the
`$142AA` pending item (starting from the previous committed selection), leaves the menu open on item clicks, commits only on the
exit button, and clears the pending item on an unaffordable click; the remake's inline "can't afford" line replaces the earlier
`say($25)` message-log entry. The only behaviour change besides that: slots that `$B2AA` blanks are now blank until their research bit is set.
Charging, placement, `Builder`, page wrap and the right-click cancel are untouched. The build command opens the menu on its release (`$15A74` -> `$6BA2`), and exit / page act on the release too (see step 3); page persistence now follows `$156B0`, while right-click cancel remains a remake convenience.

**Remaining open (static findings are not pixel-parity evidence).** (a) Whether the frame pieces here are bit-identical to the pieces the other windows use (both are runtime copies; assumed equal). (b) Whether the detail lines should also appear for the carried-over selection at open (the static code draws them only after a click; the remake follows that). (c) The pressed-button look and release-time button activation are implemented from `$5756`/`$57FA` and covered by `test/build-menu.mjs`; there is no original screenshot comparison. The synchronous strip erase sequence has no VBL wait inside its 14-iteration loop; the remake renders the destination page directly on the release, without an asserted visible wipe animation. Page persistence follows `$156B0`. Text colour 1 is statically supported for the normal map-to-menu path: `$4D96` resets `$156AB` to 1 immediately before the input poll that dispatches the menu open. On entry
`$B36C` writes 2 to `$14591`; later map clicks dispatch mode 2 through `$158F6` to `$6BF4`.
The remake represents the modal interval with `Controls.menuOpen` and does not mirror `$14591` during that interval.
(d) The side preview at (272, 52) is drawn by `Controls` in build mode from the committed tile (`$6B10`); it is outside the menu panel and has only synthetic pixel checks, no original screenshot comparison. (e) The English unaffordable line is
141 px wide (ends near x = 157) and does not reach the preview erase area (x >= 176, rows up to 181); other languages' widths were not checked, and the
remake keeps the original draw order (text first, preview erase last). (f) No pixel comparison against the running original was done: the layout is a static derivation,
so art parity is not claimed.

Tests: `test/build-menu.mjs` (synthetic tile / mask / row-order / 2 x 2 composition / list and hit-rectangle data; with local
Disk.1/Disk.2 the constants against the image tables, all three pages with and without research, the name/price lines
including T[22]'s 6000, the preview area, and that rendering writes none of disks, state, world or tiles) and the
updated `test/build.mjs` (exit-button commit, unaffordable pick).

### Observed gameplay trace: tank yard (2026-11-06)
**OBSERVED** in a disposable run of the user's WHDLoad 1.2 (0757) image under Copperline 1.0.1 (A1200 / 68020 /
AGA PAL). Addresses below are for that observed image only. Captures, RAM dumps, hashes, input recordings and local
paths are player-local and deliberately not part of the repository. The run used a temporary copy; its `disk.4` was
unchanged at shutdown, no save was made and the installed files were untouched. (An older local ledger from an earlier
attempt recorded only a negative result and is not evidence for this trace.)

Steps, in order, with what was directly observed (O) versus statically interpreted (S):
1. Boot to the language screen, select English, answer the manual check, Escape skips the intro, open the scenario map
   via the graduation-cap icon. (O)
2. Open Build, click the bottom-right arrow to show page 2. Pointer words `$161A6/$161A8` read x=25, y=115, inside
   the statically traced hitbox `{16,47,100,130}`. The click selected tile `$45`; the UI showed TANK CONSTRUCTION
   YARD with COST 6000 GR. (O; mapping to list index 5 is S, section above.) The earlier version of this trace
   reported COST 8000 GR; that was a misreading of the 6000 glyph (see the price measurement below).
3. The menu closed and the UI requested a map site. (Static `$B3D8` shows the menu closes via the exit button after an item
   pick; the trace does not record that click, see "Menu panel rendering" step 8.) The yard was placed at map coordinate (52,36). The construction
   record at `$3B506` became `{tile $32, target $45, x 52, y 36, weeks 6}`, site count `$142C4` = 1, used objects
   `$142C2` = 21, builders `$1432A` = 20. (O; field meanings per the placement steps above, S.) Exact footprint cells
   were not derived: the click geometry overlaps neighbouring cells, so do not infer them from this trace.
4. Completion was observed on 21/08: the record became tile `$45`, active `$FF`, x 52, y 36, week counter 0, and
   `$142C4` returned to 0. (O)
5. In the staffing screen the tank yard was set to 10. At the monthly boundary 01/09 the assignment read 10
   (`$143EA + 4*4`), the yard progress counter (+6) read 10, and the good-1 stock at `$13156` fell from 10 to 0. (O)
6. No Ore was available; a later UI message said TANK YARDS REQUIRE MORE ORE. The market did not enable a purchase
   (ore supply zero). No tank was produced. (O)

Consistency with the port: the weeks value (6) and the builders figure (20 = colonists-needed byte +4) match the
table row for tile `$45` in game-state.md.

**Tank yard price measurement (fresh Copperline 1.0.1 run, same configuration, one scenario; scenario index not
identified).** The earlier text recorded the displayed price as 8000 GR. That was a misreading: a fresh run's menu
screenshot shows TANK CONSTRUCTION YARD / COST 6000 GR, and the name/cost text region of the earlier screenshot is
pixel-identical to it (zero changed pixels), so its 6000 glyph had been read as 8000. The price was never a conflict
between display and table. Observations (O):
- At checkpoints A through E the T[22] row at `$1336E` read (raw bytes) `000106ff140a17700045000000000000001b`, with the
  +6 cost word at `$13374` = `$1770` (6000). T[13] at `$132CC` read `000108ff1e191f400035000000000000000d`, with +6 at
  `$132D2` = `$1F40` (8000). Both rows stayed unchanged through selection and placement.
- Breakpoints: at `$B54A` d0=`$45`, d2=`$0A`, a0=`$E9B6` (page-2 list); at `$B550` a0=`$1336E` and +6=`$1770`; at
  `$B566` d1=6000; the `$B602` formatting used d0=6000 and the print routine. The selected-type fields at `$142AA`
  held tile `$45` and `$142AE` pointed to `$1336E`. Selected name index 27 decodes to Tank Construction Yard.
- Charge path: at `$6CB0` a0=`$1336E`; at `$6CBC` d0=`$1770` (6000); `$6CD0` stores the new money. Before the
  successful placement (checkpoint D) money `$135BA` = `$0007B8AE` (506030) and expenditure `$142CA` = 0. Immediately
  after the transaction (`$6CD6`/`$6CE0`) money = `$0007A13E` (500030) and expenditure = `$1770` (6000): a delta of
  -6000 money and +6000 expenditure.

Static (S) context, now agreeing with the runtime rows:
- The T[22] row starts at `$1336E`, so its +6 cost word is at `$13374`. Independently, the `$B0C4` job-pool table
  anchors pool 4 (tank yard) at `$1336E`.
- (S) Static Disk.1 code uses the same T+6 field for display, affordability check and placement charge: the menu
  selects tile `$45` via `$6BE0`, `$B550` reads +6, `$B5E0`-`$B602` displays it, and `$6CB0` reads +6 for the charge.
  The remake mirrors those reads in `controls.ts` and `build.ts`.
- (S) All ten Disk.2 scenario blocks contain the same T[22] row values: cost 6000 (`$1770`), weeks 6, +4 = 20,
  tile `$45`, name string index 27. T[13] has cost 8000 but tile `$35`, weeks 8, +4 = 30, name index 13.
- (S) Static inspection found no writer to a type-row +6 cost field among the inspected code references. This is not
  proof against all indirect or computed writers, or against overlays.
- (O) The runtime T[22] row, the displayed price and the charged amount all agree with the static Disk.2 row and
  the `$B0C4` job-pool anchor: 6000 for tile `$45`. The weeks (6) and builders (20) values also align with T[22].

**Executable remake checks (what pins which observation).** These make the existing remake paths assert the observed
values; they are regression checks of the remake against the recorded numbers, not new evidence about the original, and no
code behaviour changed for them. Run after `npm run build`; the Disk-dependent ones need the player's own Disk.1/Disk.2.
- `test/build.mjs`: the page-2 hitbox click (centre (31,115) and the observed pointer (25,115)) selects tile `$45` and
  resolves to type T[22] at `$1336E`; every Disk.2 scenario block has T[22] with cost 6000, weeks 6, colonists 20; from
  hand-set preconditions (money 506030, `$142CA` 0, no builders, 100 free colonists, no warning bits) `Builder.place`
  charges 6000 (money 500030), `$142CA` becomes 6000 with `$135B6` untouched, 20 builders are reserved, the record is
  `{tile $32, target $45, x, y, weeks 6}` with `$142C4` and `$142C2` each +1, and six weekly passes turn it into the
  finished record (tile `$45`, +3 `$FF`, progress 0, `$142C4` back). Not asserted: footprint cells, the calendar date of
  completion, the observed absolute counts (21 objects), builders returning on completion is checked but is a port rule.
- `test/sim.mjs`: with hand-set preconditions (one yard record, assigned `$143FA` = 10, good-1 stock 10, power 0, active
  command centre) one `tankYard()` call gives progress 10, good-1 stock 0, good 3 untouched, no tank, no warning; a
  second call with good 1 empty gives message `$96` (which reads "Tank Yards require more ore" in the local Disk.1 English
  strings), progress stays 10 and no tank spawns. The two calls are staged cases; the original's actual month in which the
  message appeared, and its ore supply mechanics, are not asserted.
- `test/checkpoint.mjs`: `RuntimeCheckpoint.economy.currentExpenditure` (`$142CA`) is separate from `spentLastMonth`
  (`$135B6`); a 6000 charge shows as money -6000 / `currentExpenditure` +6000, and capture writes neither cell.

No code correction is needed from this measurement. The remake's menu and placement read the same T+6 field, and
this run confirms the observed original price (6000 GR) and charge (-6000 money, +6000 expenditure) for T[22].

The original installed files were untouched; the temporary copy's Disk.1, Disk.2 and `disk.4` hashes matched the
originals at shutdown, and no save was made. Raw captures are kept outside the repository.

Limits: this is one scenario (index not identified) and one observed trace of selection, placement, completion,
staffing, resource consumption and the 6000 GR price/charge for the tank yard. A separate original run observed
tank production, a marker order and movement through arrival (sim-port.md "Observed original production, order, and
movement"). The connected `test/tank-lifecycle.mjs` remains a remake-side regression with hand-staged conditions;
its route and exact first-move phase have not been compared at matched checkpoints against the original captures.
No other structures, group orders, blocked routes or combat have been covered, and broad gameplay parity is not
claimed. The remake's menu/placement/staffing code is compared against selected values only in the hand-staged
regression checks above, not in a captured-vs-remake run.

### Live-original Gun A construction (2026-11-07)

In a separate Copperline 1.0.1 run, a **Laser Turret (Gun A, tile `$1F`) was selected, placed, and completed through
the ordinary build UI**. This makes the building itself an ordinary-play state; it does not upgrade the earlier
RAM-staged Gun A combat capture into a natural combat observation. Machine: A1200 / 68020 / AGA PAL, 1536 KiB chip
RAM and 4 MiB fast RAM, no audio. The run used a disposable copy of the WHDLoad tree; its `Disk.1` and `Disk.2`
matched the local originals byte-for-byte at the post-build check. I did not load or save Disk.4 or invoke the game
save path. Screenshots and a 552-row pass-top log are outside the repository under the local temporary
`UtopiaDefenseCapture-20261107-r1` directory.

- **Starting state:** scenario 0, 24/08/2090; money 511,980 GR, 86 free colonists, 0 builders, 20 occupied object
  records, no own units, no enemy, and no active effect. The map cell chosen below held the unoccupied ground word
  `$009E`.
- **Selection:** page 1, tile `$1F`, shown as `LASER TURRET / COST 5000 GR`. Runtime type row T[5] at `$1323C` was
  `000104ff0f321388001f0000000000000006`: weeks 4, 15 builders, cost word `$1388` = 5000, tile `$1F`, name
  index 6. This agrees with the live menu text.
- **Placement:** tile `$1F` was placed at map cell (54,35), near the starting base. Before/after: money
  `$135BA` 511,980 -> 506,980; free colonists `$13136` 86 -> 71; builders `$1432A` 0 -> 15; expenditure
  `$142CA` 0 -> 5000; occupied records `$142C2` 20 -> 21; construction sites `$142C4` 0 -> 1. Object slot 20
  became `0032001f36230400` (scaffold tile `$32`, target `$1F`, x=54, y=35, four weeks).
- **Completion:** on 21/09/2090, frame 25038 at pass top, slot 20 read `001f00ff3623ff00`; `$142C4` was 0,
  `$142C2` remained 21, and T[5]'s active and total counts were both 1. Free colonists had returned to 88 and the
  builder count to 0. The build interval was 28 in-game days, from 24/08 through 21/09.
- **Combat status at this checkpoint:** no enemy or queued wave was present, and the kill counter was 0. The gun
  had not yet fired. No combat, invasion, or remake-parity claim follows from this construction trace.

This is one scenario and one structure, observed through ordinary mouse input on the disposable WHDLoad copy. The
RAM reads establish the transaction and completion values; they are not a full memory replay or an emulator-level
comparison. The pass log starts at frame 22834 and ends at the completed-build pass top, frame 25038; the menu and
placement screenshots are retained outside the repository with the same temporary capture set.
