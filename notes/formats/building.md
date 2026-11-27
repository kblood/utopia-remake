# Building: placement, construction, demolition

Ports in `src/game/build.ts` (rules) and `src/game/controls.ts` (mouse, modes, menu). Verified by
`test/build.mjs` (place, count down, complete, demolish, then 3 simulated years). Addresses are
original game-image addresses (see game-proper.md).

## Click flow (`$158CA`)
A left press picks a cell with `$5CDA` (map-rendering.md section 8), computes the map cell
(`$6A5A`: scroll + view offset, stored at `$142BA/$142BC`), then dispatches on the mode byte `$14591`:
1 = select (`$311E`/`$7140`; `createBuildingScreen()` dispatches implemented storage, command-centre, fuel, hospital, missile, shipyard, sports, gun and teleport interactions, with generic name/refusal handling for other records), 2 = build (`$6BF4`), 3 = demolish (`$7372`). The selected-building windows are tested in `test/buildings.mjs` using local Disk.1/Disk.2 assets; no original screenshot comparison is claimed.

Command buttons (rectangles `$5E06`, table order in `src/game/controls.ts`): 0 = build menu (`$6BA2` -> `$B2AA`, sets mode 2), 1 = overview, 2 = demolish (`$15ECA`, mode 3 without a test of the current mode: a second press keeps it, 2026-11-13 remake fix), 3 = marker mode (`$30FE`: outside select mode it leaves build or demolish mode first, `$15EF0`), 4 = trade, 5 = council, 6 = staffing, 7 = intelligence, 8 = disk menu, and 9 = pause. Their remake dispatch is wired through `Controls` and `Game.openScreen()`; the original floppy operations behind disk-menu icons remain remake pages rather than emulated floppy screens.

## Placement `$6BF4` (VERIFIED)
1. `$6D58`: x > 3, y > 3, x < $61, y < $48, otherwise message 2.
2. `$7696`: a base tile (ids 1-3) must exist in the 24 x 24 window starting at (x-12, y-12). If not:
   only tile 1 (power storage) may be built, and only next to a cell with flag bit 10 (`$7628`;
   4 neighbours for a single cell, 8 around a 2 x 2). Messages $127 and 1.
3. `$6F22`: occupancy = any of the footprint cells with flag bits 14/12/10 (`$5400`) is blocked.
   Tile $3C (drill) instead needs ground tiles $94-$9B under it.
4. Tile $61 (ground clearing, `$6D10`) costs twice the table price and rewrites the cell to $38. A refused clearing runs `$6ACE` (the side panel's rows 7..51 restored, so the preview leaves at once; the bottom row stays, see map-rendering.md "Mode exit, commit and placement") and `$6D2C` (selection cleared, mode kept, message `$25`); the bottom row of the preview stays (map-rendering.md section 9, "Clearing refusal").
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
a warehouse reduces stocks, weight and capacity (-80000); the cell becomes the cleared tile $38. Others: message $58.
**Sports countdown and warehouse share (STATIC, Disk.1, 2026-11-25; no emulator run).** Real-building branch only: `cmpi.w #$5C,d0` at `$7454`, `bne $7470`, `clr.b $144B2` (sports countdown, weeks until another event may be called; file offset `$2FC54`). Warehouse tile `$44` at `$7470`-`$749E`: for each of the five goods, `d3` = stock long `divu.w` the type total word (`T+$C`), `ext.l`, stock `-=` d3, then the weight `-=` `mulu.w` (weight of the good, `$B0EC`) of the low word of d3; capacity `-= 80000` (`$13880`) at `$749E`. The remake (`Builder.demolish`) uses `divuQ` and `mulu` from `sim-math.ts` for this share, so a negative stock gives its sign-extended low word (test `test/demolish-quirks.mjs`).
**Footprint writes (STATIC, 2026-11-10):** the real-building branch ends at `$74DE` with `bsr $6FC4` and `d0 = $38`, `d1` = the type's footprint byte (+1). `$6FC4` writes the SAME tile id into every footprint cell (`addq` is absent; only the flag byte is per table), so a 2x2 building leaves `$38` in all four cells. The `$6A8C` writer, used by completion (`$703A`, `bsr $6A8C` at `$7104`) and the Command Centre redraw (`$7342`), writes tile +0..+3 instead. The remake had used the `$6A8C` pattern for demolition, leaving `$38..$3B`; fixed in `src/game/build.ts` (`Builder.demolish` and `cancelSite`), see `test/build.mjs`.
Site cancellation (`$74FE` -> `$752C`) is the same: `$753C` returns footprint 4 for a site whose target tile is `$48`..`$5F` and 1 otherwise (checked against the type table's footprint byte in all scenario blocks), and `$6FC4` writes `$38` into each of those cells.
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
   flips the button back, then 8 advances the page and 9 exits; buttons 0-7 do nothing. There is no pause handling (the menu
   cannot open while paused: `$15AB4-$15ABC`). The remake draws the flipped buttons from `MenuView.flipped` and runs page / exit
   on the release (`Controls.menuPress` / `menuRelease`; `test/build.mjs`, `test/build-menu.mjs`, `test/map-loop.mjs`).
   **Right button (VERIFIED statically, Disk.1, 2026-11-10; no emulator run; `test/order-input.mjs` section 4).** The loop polls
   only through `$50B2` (screens.md, "Window loops"), so a right press has the two branches of any `$50B2` event, picked by the
   left bit after the event (`$B3E8`):
   - A right press alone (left up) runs the release branch `$B3F2`. Nothing is pending with the left up (the release that ended
     the last press ran `$57FA`, which clears `$5DD4`), so it does nothing: no click, no page, no exit, no selection.
   - A right press while the left is held runs the press branch `$B41A` at the pointer again: a command button is clicked
     (`$5756`: id 4 and another flip) and an item is selected again (the last press wins; an item press never touches `$5DD4`).
   - A left press with the right already down gives two events in one pass: the left press (which clears the right bit,
     `$50D0`), then the right re-press at the same pointer.
   - Each `$5756` toggles the button image (XOR), and the release (`$57FA`) toggles the released button back. A repeated press
     on a button therefore leaves it inverted after the release (two presses, one release: the image is inverted), and a press
     followed by a re-press on another button leaves the first one inverted. The column is drawn fresh only when the menu opens
     (`$B36C` -> `$58A0`), so the parity starts at zero each time.
   - A release dispatches the pending button once (`$5DD4` is cleared), so a right button still held through the release does
     not repeat the page or the exit.
   - The exit release clears the right bit too (`$50D0`), so a right button still held is a new press for the map's next pass;
     build mode then ends through the map's right-click branch (`$15F44`, `Controls.update`). This is the poll's consequence,
     not a separate rule, and the remake follows it.
   - Latch: the map's press latch `$156A9` bit 0 is clear while the menu runs (every left-up poll clears it, `$50BE`; the
     build command's release that opens the menu is such a poll). Raw scan of Disk.1 (2026-11-10, static): the only `bset #0,$156A9`
     is at `$1596A` (file offset `$3E16A`, the scroll-arrow press in the map's `$15940` handler), and no `jsr` reaches `$158CA`,
     `$15940`, `$1596A` or `$15A74`. The `$B3D8` callees that are called directly (`$5730`, `$5756`, `$57FA`, `$B628`, `$6B3C`, `$2F5E`,
     `$52A8`, `$6BE0`, `$51E6`, `$538A`, `$5A16`, `$4E08`, `$15C5A`, a number formatter) were not followed to closure, and relative
     `bra`/`bsr` edges were not scanned. So the latch is clear at entry (VERIFIED from the release that opens the menu) and no
     direct path from the menu sets it (STATIC, not a full call-closure: HYPOTHESIS for the rest).
   Re-check 2026-11-12 (static, scratch forward walks; screens.md, "Window loops", the press latch): `$B3D8` is reached from neither the key dispatcher `$15B4A` nor the press path `$158CA`, so its entry is a release (`$15A74`, one caller, after the latch-clearing release poll). The latch is therefore clear while the menu runs, and `MousePoll` (`menuPoll`) takes no latch. The only setter `$1596A` lies in `$15940`, whose one entry is the branch at `$158D0` in `$158CA` (the press path). Forward walks from every window entry (this one, the release-entered windows, the F-key reports and the cell-click windows) reach neither `$158CA` nor `$15B4A`, so no window sets the latch during its own loop. Key cell (2026-11-14, STATIC): the menu does not read or clear `$161A0` either (screens.md "Key reads"), so a key still in the cell when it closes is dispatched by the same iteration's `$15B4A` (`$15A74` returns through `$158B0` -> `$158B4` -> `$15B4A`), unless a later byte overwrote it; `notes/formats/game-proper.md`, "One key cell".
   The remake implements this with `MousePoll` (`Controls.pollMenu`: drained per video update, at most a few events; `menuFlips`).
   Re-check 2026-11-10 (static, same session): the `$50B2` branches were re-read from Disk.1 (`$50B4`-`$5104`) and match
   `mouse-poll.ts` line for line, except the latch above. `$B3D8` (`$B3E0` poll, `$B3E8` left bit, `$B3F2` release with `$5DD4`,
   `$B41A` press) matches `pollMenu`/`menuPress`/`menuRelease`. The earlier note that the build menu's right-press path was
   left unimplemented is stale. Regressions for right-down alone, left-held then right, both simultaneous-transition orders and
   the release-with-right case: `test/order-input.mjs` section 4. The `$DCFE` window press was not re-disassembled in this pass.
   The remake's input is sampled once per video update, so a press and release that both fall between two samples are not seen.
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
Charging, placement, `Builder` and page wrap are untouched; the right-click cancel of the menu was removed (step 3). The build command opens the menu on its release (`$15A74` -> `$6BA2`), and exit / page act on the release too (see step 3); page persistence now follows `$156B0`. While the menu is open the right button follows the loop's poll (step 3): a right press alone does nothing, and a right press with the left held repeats the press at the pointer.

**Remaining open (static findings are not pixel-parity evidence).** (a) Whether the frame pieces here are bit-identical to the pieces the other windows use (both are runtime copies; assumed equal). (b) Whether the detail lines should also appear for the carried-over selection at open (the static code draws them only after a click; the remake follows that). (c) The pressed-button look and release-time button activation are implemented from `$5756`/`$57FA` and covered by `test/build-menu.mjs` (single press) and `test/order-input.mjs` (repeated presses, the XOR residue); the panel comparison below does not include the command buttons, so their pressed look has no original pixel comparison. The synchronous strip erase sequence has no VBL wait inside its 14-iteration loop; the remake renders the destination page directly on the release, without an asserted visible wipe animation. Page persistence follows `$156B0`. Text colour 1 is statically supported for the normal map-to-menu path: `$4D96` resets `$156AB` to 1 immediately before the input poll that dispatches the menu open. On entry
`$B36C` writes 2 to `$14591`; later map clicks dispatch mode 2 through `$158F6` to `$6BF4`.
The remake represents the modal interval with `Controls.menuOpen` and does not mirror `$14591` during that interval.
(d) The side preview at (272, 52) is drawn by `Controls` in build mode from the committed tile (`$6B10`); it is outside the menu panel. Two original frames of one state are now compared (see "Side preview comparison" below); no other state is. The select and demolish mode icons at the same place (`$39`, `$3A`, map-rendering.md section 9) are drawn by `Controls` too; the select icon matches the Copperline map frame exactly (map-rendering.md section 11), the demolish icon has no capture. (e) The English unaffordable line is
141 px wide (ends near x = 157) and does not reach the preview erase area (x >= 176, rows up to 181); other languages' widths were not checked, and the
remake keeps the original draw order (text first, preview erase last). (f) Before the comparison below, no pixel comparison against the running original existed for the menu. The layout was a static
derivation; the comparison below covers one state of the panel only.

**Panel pixel comparison with the running original (2026-11-10, one capture; OBSERVED pixels, MEASURED counts).** The capture is
the Copperline 1.0.1 window grab `tankyard-selected.png` from the 2026-11-06 tank-yard trace (716 x 285, SHA-256
`931946A15536AA8792A2641483BD7279A7F5613D16DD716B4BEB518A599270AA`). It is kept in the player's temp folder, is not copied,
and is not in the repository. It shows page 2 with tile `$45` picked: the name and price lines and the preview inside the
panel.
- Provenance (OBSERVED): the run's `Disk.1`, `Disk.2`, `disk.4` and `Utopia.Slave` are byte-identical (SHA-256) to the player's
  `original/utopia-whdload` files. The slave header reads "Version 1.2 (12.03.2004)". The run's `copperline.toml` is A1200,
  AGA, 68020, 1536K chip, 4M fast.
- Alignment (MEASURED): every 2x column pair of the grab is identical. The panel origin is native (31, 16), with 29 mismatches
  in 41,664 panel pixels. The next origin outside +-2 has 8,083. The crop is grab columns 62..557 (every second column) and
  rows 40..207, which holds the native panel x 0..247, rows 24..191 (window `{0,24,31,21}` in 8-pixel units).
- Result (MEASURED): 41,635 of 41,664 panel pixels are exact. The 29 that differ lie in an 8 x 8 box at x 25..32, y 115..122,
  which starts at the recorded pointer position (25, 115). Frame ring, title, item grid, name, price and message lines have
  zero mismatches outside that box.
- Pointer identity (MEASURED on the same capture, 2026-11-10): the 29 differing pixels are exactly the 29 opaque pixels of the
  arrow descriptor `$4A74` (Disk.1, 8 rows) placed with its top-left at (25, 115), no more and no fewer. Their capture colours
  are the arrow's own palette colours: `006600` x21 and `009900` x8. So the pixels are the remake's software arrow
  (`src/gfx/pointer.ts`, drawn by `main.ts`) at the hotspot, drawn over the panel. This does not show that the original drew
  it in software: the hotspot is still an input (the recorded words `$161A6/$161A8`), and this frame does not show the
  original's sprite hardware. The earlier "Amiga hardware pointer" reading was a guess from the colours and is withdrawn.
- Negative controls (MEASURED, same comparator): page 1 instead of page 2 gives 5,266 mismatches in the item grid; no detail
  lines gives 441 in the name and price lines; no pending tile gives 457 in the lines and preview area; research bit 1 gives
  515 in the item grid. The exact match is therefore not trivial.
- Not covered: one frame, one state (page 2, no research bits, tank yard picked, detail lines shown). The command buttons,
  the top bar, the side preview at (272, 52) and the rest of the screen lie outside the crop. No other item, page, research
  state, press, or animation is covered. No renderer mismatch was found, so `build-menu.ts` is unchanged.
- Comparator: `test/build-menu-capture-compare.mjs` (`npm run compare:menu`, `UTOPIA_MENU_CAPTURE=<png>`, optional
  `UTOPIA_MENU_POINTER=25,115`). Its self-test runs without a capture. Without the pointer option, the same run reports the 29
  arrow pixels as mismatches and exits 1. With the option, the excluded set is the arrow descriptor's opaque mask at the hotspot
  (not the whole 8 x 8 box), and the run also requires every opaque arrow pixel to carry the arrow's palette colour in the
  capture (29 of 29 on this frame; the run then exits 0).

Tests: `test/build-menu.mjs` (synthetic tile / mask / row-order / 2 x 2 composition / list and hit-rectangle data; with local
Disk.1/Disk.2 the constants against the image tables, all three pages with and without research, the name/price lines
including T[22]'s 6000, the preview area, and that rendering writes none of disks, state, world or tiles) and the
updated `test/build.mjs` (exit-button commit, unaffordable pick).

**Side preview comparison (2026-11-10, two captures of one state; OBSERVED pixels, MEASURED counts).** Source: the Copperline
1.0.1 window grabs `snap-D-before-placement.png` and `snap-E-after-placement.png` (716 x 285) from the 2026-11-06 tank-yard
cost/production run (`UtopiaCostProbe-20261106-161056/out/`, in the player's temp folder, not copied, not in the repository).
Provenance (OBSERVED): the run's `Disk.1`, `Disk.2`, `disk.4` and `Utopia.Slave` are byte-identical (SHA-256) to the player's
`original/utopia-whdload` files; `copperline.toml` is A1200, AGA, 68020, 1536K chip, 4M fast. The sequence (protocol log): the
menu exit (`snap-C2` JSON; grab `q3-after-exit.png`), mouse moves with no click, the `snap-D` grab; then one left press at a
map site and the `snap-E` grab. D shows build mode ("CLICK ON MAP TO CHOOSE A SITE"), money 506030, and the tank yard at the
side preview; E shows money 500030 (6000 spent; the T[22] cost word `$13374` is 1770 hex) with the same preview, so the placement
did not change it. The first eight bytes of `$142B2` agree in both frames: `$00000045 $0001336E` (tile $45, type entry T[22] at
`$1336E`). E's last four bytes read `$00330023` where D's are zero (not interpreted; likely the placed site, HYPOTHESIS).
- Pointer / state (OBSERVED words, reading as a pointer is HYPOTHESIS): `$161A6` = 157, 80 in D and E. Only 9 of the 3,235
  full-frame mismatches fall in the 8 x 8 box at (157, 80), so the pointer is not what the residual is; the capture tool reported
  no overlays.
- Result (MEASURED, `test/build-side-preview-capture-compare.mjs`, `npm run compare:side`): frame origin (31, 16) (second best
  (23, 16) with 28,832 mismatches). Preview box x 271..304, rows 20..53 (1,156 pixels): **D 0 mismatches, E 0 mismatches**. The
  box contains the whole 1 x 1 preview (bottom row 52, 32 columns).
- Sensitivity (MEASURED, D box, same renderer): select icon `$39` 503 mismatches, demolish icon `$3A` 469, neighbouring tiles
  `$47` 493 and `$44` 578. The match is not trivial.
- Not covered: the 2 x 2 buildings (ids `$48-$5F` get the +16 offset), other tiles, other pages or states, select/demolish
  icons in this capture (they are not in this frame), timing, and every pixel outside the box. Full-frame residual (MEASURED, not
  attributed): 3,235 (D) and 3,363 (E) mismatches, of which rows 160..199 (log and cost lines, not staged) and scattered map
  pixels in rows 56..159 are the bulk; these are outside the comparison and were not investigated. The comparator therefore
  uses a 10% whole-frame origin gate plus the three-times separation test, not an exact frame match.
- Renderer: no mismatch in the box, so `controls.ts` is unchanged.

**Construction-site frame comparison (2026-11-10, one capture; OBSERVED pixels, MEASURED counts).** Source: `snap-E-after-placement.png`
(716 x 285, SHA-256 `009FBB2009B4883FB2E484DF4F3F8F4537F968A4F8D8AA7BD59F3B85B7A6A362`) from the same probe run, outside the repository. Its
`Disk.1`, `Disk.2`, `disk.4` and `Utopia.Slave` have the SHA-256 of `original/utopia-whdload` (Disk.1 `47b5edea...`, disk.4 `31ca97f4...`).
The snapshot JSON gives money `$135BA` = 500030, spent `$142CA` = 6000, used objects `$142C2` = 21, sites `$142C4` = 1, builders `$1432A` = 20
and the selection `$142AA` = tile `$45`, type T[22]. Staged in the remake (`test/construction-site-capture-compare.mjs`): those values, one object
record (tile `$32`, target `$45`, weeks from the type table), the cell through `Construction.markSite`, build mode, scroll (47, 33). The
pointer (157, 80) is picked by the remake's own `controls.pickCell`, which gives (51, 35); that cell is drawn with cursor tile 58. No pass,
tick or RNG step runs; the state is written and the frame drawn once.
- Alignment (MEASURED): origin (31, 16); full frame 3,107 mismatches of 64,000 (next origin (23, 16): 28,902).
- Map layer, rows 24..159 x 0..255 (34,816 pixels): **0 mismatches**. Bounded 3 x 3 crop around (51, 35), x 96..191, rows 39..110
  (6,912 pixels): **0 mismatches**.
- Controls on the same pointer (MEASURED): no site, 0 mismatches (the cursor hides the cell); site at (52, 36), 352 mismatches in x 144..175,
  rows 76..102 (its scaffold would show there, and the capture has none).
- Residual outside the map layer, same staging (MEASURED, not attributed beyond the region): top bar rows 0..23: 65; right panel rows 24..159,
  x 256..319: 348; message line and log rows 160..199: 2,694. Total 3,107.
- Interpretation. The earlier attribution of the E residual to "scattered map pixels in rows 56..159" is superseded for the map layer: with the
  cursor staged there is no map-layer residual in E. The frame does **not** show the yard site: the cursor covers its cell (51, 35), so the
  frame neither confirms nor refutes a site there. The frame argues against (52, 36) as the drawn cell, under the remake's tile `$32` art. The
  record's coordinates are therefore not settled. The `$142B2` tail `00330023` reads as (51, 35) (HYPOTHESIS, not interpreted), while
  the record observed in the 2026-11-06 trace was (52, 36), which these JSON snapshots do not contain. No draw-order, art or timing mismatch
  was found, so no renderer change was made. To settle the record's cell, the next capture must place the pointer off the yard cell and read
  the record bytes in the same frame.
- Limits: one frame, one state, scenario 0 only, the cursor-covered yard cell, no record bytes in the capture, no timing, and no top bar, panel
  or side-preview claim beyond the counts above.
- **Message line at the build-selection commit (2026-11-11; STATIC trace + the same E capture, OBSERVED pixels).** `$6BA2` (Disk.1 `$6BA2`-`$6BD6`)
  runs `$309E` and `$6B10` for a non-zero tile, then `moveq #0,d0` / `bsr.w $551a`: it posts **string 0**, "Click on map to choose a site.",
  on the message line (row 160; string 0 is not in the log-panel index set). The remake's exit commit (`Controls`, `controls.ts`) used to post
  the building name (type entry `+$10`, string `$1B` for the tank yard) there, which the original never does; that was an implementation
  choice from the first placement commit, not a traced behaviour. The commit now posts string 0 (`BUILD_SITE_PROMPT`), and the remake shows it in the exit frame (2026-11-13, `HANDOFF-2026-11-13-build-commit-prompt.md`; the timer reads 200 there, as in the traced `$552C`; the modal-exit hold, `game-text.md` section 4). Pixel check, staged
  with string 0 in `test/construction-site-capture-compare.mjs`: message-line rows 158..170, x 0..319, **0 of 4,160 mismatches**. Staging the
  name instead gives 320 mismatches (x 8..142, rows 160..165); staging nothing gives 300. So the text, its position and colour agree in this
  frame. Limits: the line's 200-frame lifetime is not compared; no other message is claimed. `test/build.mjs`
  asserts the commit posts exactly `[0]` and that string 0 reads as above.

**Log panel strip of the E capture (2026-11-11; OBSERVED pixels, MEASURED counts; the staging order is a fit to those pixels, not a traced original sequence).**
- Breakdown of the E frame's residual in the committed comparator, before this step (MEASURED): full frame 2,807 of 64,000 after the
  string-0 change (the 3,107 above predates it). Top bar rows 0..23: 65; right panel x 256..319, rows 24..159: 348; message line rows
  158..170: 0 (with string 0 posted last); log strip rows 171..199: 2,394 (every one inside rows 171..194, x 8..311, the fill's rectangle;
  rows 195..199 match).
- The E frame shows the **cleared** panel: the strip matches the remake's cleared fill exactly (0 of 9,280, x 0..319, rows 171..199) when
  the idle clear (`LOG_IDLE_FRAMES` = 500 updates, `$1586E`) runs before string 0 is posted. Posting the picture (no clear) leaves the
  2,394 mismatches above. The other orders tested do not fit: a line posted before the clear has expired (the message line lasts 200
  updates), so the message line then shows no text (300 mismatches in rows 158..170). `test/message-panel.mjs` checks this ordering.
- Result: full frame 413 of 64,000 (top bar 65 and right panel 348 only). `test/construction-site-capture-compare.mjs` now compares the
  strip and exits 0 on this capture. The renderer and engine were unchanged at that point; the right-panel build-marker part of the
  residual was changed later (see "E residual breakdown and closing step" below).
- **E-state RAM (2026-11-11; OBSERVED, one replay, read-only).** The probe's `protocol.log` was replayed into a fresh Copperline 1.0.1
  on a disposable copy of the probe's config and boot tree (game files hash-identical to `original/utopia-whdload`), with the replay
  stopped before the E snapshot request (line 2171; 1000 requests, 0 mismatches). Then `mem.read` only (no run, input or capture).
  State: paused, frame 16447, pc `$68F4`, the same frame the E snapshot was taken at.
  - `$14634` = `$FFFF` (word at `$14634`; `$14636` = `$0402`). Not a countdown: no log add is pending and the main loop's idle clear
    is not armed (see below).
  - Log list `$15698`: first byte `$FF`, all of `$15698..$156A7` zero except that; empty. The descriptor at `$15688`:
    x 8, y `$AB`, used word `$1568C` = 0, max 3, width `$130`, bpr `$25`, skip 2.
  - Message line timer `$156AC` = 100 (word `$0064`), i.e. 100 VBL frames have run since the last `$551A` (which sets 200 at `$5584`).
    That is the string-0 site prompt's remaining lifetime at E, assuming no later `$551A` call; the line's text was not read.
  - Flags at E: `$156A8` = `$09`, `$156A9` = `$08`, `$156AA` = `$84` (bit0 clear, bit2 and bit7 set), `$156AB` = `$01`
    (draw mode back to 1), `$156B0` = `$0001`. `$14590` = `$04` (byte), `$144C1` = `$00`.
- **Static timer and log facts used for the reading (STATIC, Disk.1 disassembly 2026-11-11):** VBL `$2CBE`: `tst.w $14634; ble`
  then `subq.w #1` (decrements only while positive). Main loop `$15850`: `tst.w $14634; bne $15888`; at zero it does
  `subq.w #1` (to `$FFFF`) and runs the clear (`$15688`, pattern `$16D6A`). So `$FFFF` is never cleared again and never counts.
  Log add `$5A8C` (`$5ADC`-`$5B00`): the free slot is the first entry whose first byte is `$FF`; it writes {used, lines, `$0A`},
  sets `$14634 = $01F4` (500) at `$5AF4`, and writes `$FF` into the **next** slot's first byte at `$5AFC` (`st.b $2(a0)`, which
  terminates the list). Writers of `$FFFF` or the list head: `$876E` (`$875C` reset path), `$8772`/`$87B0` (reset), `$5B68`, `$15884`.
  The `$80A6`-`$80AE` pair is the exit tail `$802C`-`$80C6` (raw bytes, 2026-11-11): `bclr #0,$156AA` at `$80A6`, `move.w #1,$14634` at `$80AE`. It is reached by fall-through from every exit that is not refused, so it runs on the tutorial start (`game-proper.md`, "Tutorial start route"). The static trace does not say whether it ran in this capture's session before the E state. At E the word is `$FFFF`, and a `#1` set earlier would have counted down to zero and then reached `$FFFF` through the idle clear (`$15850`), so the E-state read does not settle that question.
- **Consequence for the open question (INFERENCE, not an observation of the clear itself):** a non-`$FFFF` `$14634` would mean a log add
  is pending, and an add always leaves at least one entry. At E the list is empty and the timer is `$FFFF`, so the last add (if any)
  was followed by the main-loop idle clear, which empties the list and sets `$FFFF`. The `$FFFF` alone does not prove a clear ran: the
  reset path writes it too. The cleared appearance of the E panel is therefore consistent with the idle clear having run before the
  commit, not proven by this read. The `$80AE` `#1` write would, if it ran, produce a clear one frame after the game start.
- Not established: whether the original's `$80AE` routine ran in this session, whether the E panel's fill came from the idle path or
  `$5B46`, and the text of the string-0 line (not read). The **874** residual mentioned in the request could not be reproduced under any
  staging tested here; the nearest count is 2,394 (log strip without the clear), not 874.
- Next evidence: the same replay from the start of `protocol.log` with breakpoints (or periodic `mem.read` of `$14634` at each stop) to
  see whether `$80AE` executes and whether a `$5AF4` add precedes the E panel; the message-line text at `$161AA`.

**E residual breakdown and closing step (2026-11-11; OBSERVED pixels, MEASURED counts, RAM from one replay; closes the 413 above).**
- Where the 413 are (origin (31, 16), MEASURED): top bar 65 pixels in rows 2..7 only, in the date and QoL text (columns 8..16 and
  27..30 for the date, 247..255 for the QoL; money has none). Right panel 348 pixels, all inside the ten command-button rectangles
  (`$5E06`; x 272..287 and 296..311, rows 63..78, 82..97, 101..116, 120..135, 139..154). Message line, log strip, map layer and the
  3 x 3 crop: 0. No other pixel differs.
- **Top bar = state staging, not renderer.** RAM at E from the 2026-11-11 replay (the same run as the E-state RAM bullet above, read
  only): day `$1459F` = 2, month byte `$145A0` = 6 (shown as 07), elapsed years `$142A6` = 0 (2090), QoL word `$142C8` = 44 (shown as
  DOL 44). The E frame's date `02/07/2090` and `DOL: 44` read exactly these bytes. The comparator does not stage them. With those four
  values set (scratch copy of the comparator, same staging otherwise), the top bar rows 0..23, x 0..255 match exactly (0 mismatches).
  The comparator now stages these bytes in `test/construction-site-capture-compare.mjs` (2026-11-11, same step as the ring fix)
  and checks the top bar exactly; a synthetic grab built from the remake's own frame gives 0 mismatches there (self-consistency
  only, not the E capture; the E capture is on this machine, see the 2026-11-12 check in the "Construction-site frame comparison" note).
- **Right panel, part 1: the build-mode marker (fixed).** `Controls.draw` drew a 1-pixel yellow frame (`COLOR.highlight`) around the build
  button (272, 63) in build mode (`mode === "build"`), added in commit ffdfe82 with no trace behind it and no note. Both build-mode frames
  show the plain button there: E (menu closed, after placement) and D (`snap-D-before-placement.png`, build mode, no site). The frame would
  cost 60 pixels in that box (E: 60 mismatches; the other nine boxes 32 each). **Changed:** build mode now draws no marker; demolish mode
  keeps its frame (no original capture of demolish exists, so that frame is still unverified). Effect on the E frame: build box 60 to
  32; right panel 348 to 320; full frame 413 to 385. On D the right panel goes 348 to 320 the same way. Test:
  `test/command-buttons.mjs`, "build mode: the build button (272, 63) is drawn with no marker frame" (the pre-fix build fails with 60
  pixels differing; the demolish frame check still expects 60).
  Scope: two frames of one run, closed menu only. Whether the original shows any frame with the build menu open was not observed; the
  remake now draws none in that state too.
- **Right panel, part 2: the command-button ring (320 pixels; EXPLAINED 2026-11-11 by static trace, pixels not re-captured).**
  Resolution, read first: the build-menu exit `$B628` redraws the ten command buttons from the map's image table `$5DDA`
  (`lea $5dda,a1` at `$B638`, then `jsr $58A0`, which draws each image with `$5876`; static, Disk.1). The picture's own blank
  buttons are the select-mode state (the remake's picture ring matched the select-mode capture, 0 of 7,968). The `$5DDA` images
  agree with the picture in all 1,960 interior pixels and differ from it only on the 16 x 16 edge ring, 32 pixels per button,
  and each of those 320 pixels equals the picture's pixel at the horizontally mirrored position (scratch decode of Disk.1,
  2026-11-11; the same check is `test/map-loop.mjs`, "build-menu exit"). The remake had restored the pre-menu picture ring, so
  the exit's redraw was missing. Fixed: `Controls` sets `commandButtonImagesFromTable` on the exit and `MapScene` draws the
  `$5DDA` images on the exit frame and in each `restoreOverlayAreas` (`src/game/controls.ts`, `src/game/map.ts`). The comparator
  stages the same state (`Controls.markMenuExitButtonImages`) and now checks the right panel exactly, with the top bar.
  Evidence: static trace and image decode are VERIFIED; the E and D pixel counts above are the earlier captures (the
  the E capture (`snap-E-after-placement.png`, probe folder under `%TEMP%`) is on this machine and was re-run on 2026-11-12: with the
  current comparator and its defaults the full frame has 0 mismatches of 64,000, including the right panel, so the ring is verified on
  that capture). Scope: the state
  holds for the map scene's lifetime; the other two `$5DDA` loads (`$159AC`, `$15C2C`) only feed the press flip `$5756`.
  Pause at the exit (resolved as unreachable, 2026-11-11, remake probe and `test/map-loop.mjs` "pause key"): the build menu
  cannot open while paused (the build command's release takes no action while paused, `$15A74-$15ABC`), the modal menu reads
  no key and pause is not set by its buttons, so no latched pause reaches `$B628`. The redraw therefore never has to
  reapply the `$57D6` flip; the remake's exit draws the `$5DDA` images without a flip, which is the only state that exit can produce.
  **Button ring after a save load (2026-11-12; STATIC, Disk.1 disassembly and caller scan; no emulator capture).** The remake's saves
  store no button-image state. Its restored scene is a new `MapScene`, so the column state comes from the route that builds it.
  - Disk-menu round trip (VERIFIED static): the map's disk button `$15AE6` calls `$7E52` and then `$15EF0`. `$7E52` decodes its
    picture into the back bitmap (`$7D52`, `$5A16` copy of `$2FD4A`) and swaps (`$4E08`). The exit `$802C` swaps back (`$4E08` at
    `$807A`), reloads the map palette (`$7FA40`) and copies the displayed frame into the other bitmap (`$5A16` at `$8098`). So the
    bitmap shown after the exit is the pre-menu frame. This assumes the menu's own draws (slot list and message lines through the
    `$160FA` list) go to the displayed disk bitmap and not to the pre-menu one; that is read from the disassembly, see the caveats.
  - Picture copy and unpack run only at boot (VERIFIED static, caller scan): `$4E28` (unpack) has one caller, `$157A8` on the boot tail;
    `$2B1A` (copy) is called from `$4E3C` (inside `$4E28`) and from `$15702` (no caller found; the boot init path). The in-game load
    `$85FE` (mode 2: `$855A`, slot list `$85CA` into `$160FA`, loop `$7EF6`), its apply `$88D4`-`$8910` (`$866E` with d0 = 1, the block
    copy `$8AF4`, the loaders `$7C80`, `$7C3A`, `$7D0E`) and the scenario `$8632`/`$88F0` and tutorial `$80C8` routes never reach
    `$4E28` or `$2B1A`. The loaders end in `$5A16` copies from the displayed bitmap into the back one and leave the displayed one alone.
  - First session (boot disk menu `$157AE` -> `$7E52` -> load -> `$802C` -> `$157B4`): the pre-menu frame is the boot unpack, so the
    column is the picture's blank buttons. The remake agrees: the held boot scene has no earlier map.
  - In game (map disk button -> load -> exit): the column is the pre-menu frame's. That is the `$5DDA` image set when a build-menu exit
    (`$B628`) happened earlier in this bitmap lineage (the whole session since boot), and the picture ring otherwise. A scenario or the
    tutorial started from the in-game disk menu follows the same rule (the tutorial exits by `bra $802C`).
  - Remake, fixed (2026-11-12): a scene built by a disk-menu route starts with the column state of the scene it replaces
    (`MapSceneOptions.commandButtonImagesFromTable`, set from the current map in `Game.sceneOptions`, so the first frame already shows
    it). Before this, an in-game load always showed the picture ring. Test: `test/button-image-carry.mjs` (in-game load after an exit,
    no-exit control, disk-menu round trip, in-game scenario, boot route; the images are decoded from Disk.1 there).
  - Caveats: the front/back meaning of `$4E08` and the `$B628` claim that both bitmaps then hold the redrawn frame come from the
    disassembly and the earlier `$B628` trace, not from a capture. `$15702`'s caller was not found (a fall-through was not excluded).
    The column is assumed untouched by the passes, as the `$16012` note above says. A Copperline capture of an in-game load after a
    build-menu exit, grabbed at the first returned map frame, would confirm the pixels; it was not run.
  The earlier note follows as the record of how the ring was measured.
  After part 1, every one of the ten boxes differs in 32
  pixels, and all 320 lie on the box's 16 x 16 edge ring (MEASURED, E and D alike). For the ring, the captured colour equals the remake's
  pixel at the **horizontally mirrored** position in all 600 ring pixels (left and right columns swap; the top and bottom rows keep their
  colours, mirrored along x). The 1,960 interior pixels, icons included, match as-is. This is not the plane-3 flip (`colour ^ 8`): the
  flipped colour matches none of the 480 ring pixels of buttons 2..9 (the blank ring and icon boxes), and a whole-box flip mismatches
  every pixel of a box.
  - (Superseded by the resolution above: the candidate list below is the 2026-11-11 state before the `$B628` trace.)
  - Not the same in the select-mode frame: the production-run map capture (`map_start.png`, select mode, the map-capture comparator's
    frame) matches the same remake draw on its right panel outside the mode icon, 0 of 7,968 (map-rendering.md section 11; re-run in
    this step with `UTOPIA_MAP_CAPTURE`, after the marker change, 0 pixels differ). So the difference follows the state
    of frames D and E, not the blank-button draw itself. Candidates, none tested: the build-menu session (`$B628` redraws the buttons
    after the menu closes) or a build-mode-specific draw in the original. Both are open.
  - Best next capture (one run, one Copperline replay if possible): (1) a select-mode frame and (2) a build-mode frame, each reached
    from a fresh start **without** opening the build menu, with the same window grab; and in the same frame `mem.read` of the button
    image source for entry 0 (`$E930` / `$E95C` table, blank `$185A2`) and of `$156A8`. If the fresh build-mode frame shows the remake's ring,
    the menu session is the cause; if it shows the mirror, the original draws build mode differently.
- Staging of this step's comparator run: unchanged (`npm run compare:site` on the E capture exits 0 as before). The full-frame count is
  now 385 (top bar 65, right panel 320) and the message line, log strip and map layer stay exact.
- Limits: one E frame and one D frame from one run; one RAM replay (no simulation, input or capture); the mode-marker change rests on
  those two frames; demolish mode and the menu-open state are not observed.

**Off-yard pointer capture (2026-11-10, replay of the 2026-11-06 probe; OBSERVED pixels and RAM, MEASURED counts).** The probe's
`protocol.log` (one emulator run, 1,069 requests) was replayed into a fresh Copperline 1.0.1 instance on a disposable copy of the
same A1200 / 68020 / AGA config (`copperline.toml`, SHA-256 `c895925074f50023bd6e0cbea2e9b84e1948defa51076096428becc94517179c`).
The replay reproduced the recorded frame, cck, pc, vpos and hpos on every response (1,000 requests, 0 mismatches) and stopped at
the snap-E state. Verified there: money `$135BA` = 500030, spent `$142CA` = 6000, used `$142C2` = 21 / sites 1, builders 20, selection
tile `$45`, pointer `$161A6` = (157, 80), scroll `$144E4` = (47, 33). The pointer was then moved by one relative input to (127, 30), the
cell (47, 33), which lies away from the site art, and the frame was captured at frame 16467 (paused).
- Construction record `$3B506` (16 bytes): `00 32 00 45 33 23 06 00 ...` = tile `$32`, target `$45`, **x 51, y 35**, weeks 6. The map
  words `$3F256 + y*$CC + 2x` read `$1432` at (51, 35) (tile `$32` with flag), so the site cell is (51, 35). This disagrees with the
  (52, 36) in step 3 of the 2026-11-06 trace; this replay does not reproduce that reading, and the cause is not established.
- Neighbouring words (rows 32..38, cols 48..55) hold the usual ground words `$009E..$00A1`, and other structures at (53,35) `$142F`,
  (53..54, 36..37) `$0448..$044B`; those are existing map features, not the site.
- Comparator (`test/construction-site-capture-compare.mjs`, pointer (127, 30), site (51, 35), window grab SHA-256
  `52bc05b33b59dd99c79cea204038f2334c7ddddb39d96fc007f07df43b1a0221`): the **3 x 3 crop around (51, 35) matches exactly** (0 of
  6,912), so the site's footprint art is visible and agrees with the remake's tile `$32`. Controls on the same frame: no site gives
  599 mismatches in the map layer, site (52, 36) gives 891; both are refuted, (51, 35) is confirmed. Map-layer total: 256 mismatches,
  all in x 112..143, rows 24..38, which is the cell (47, 33) under the pointer (cursor tile 58, blink phase 0 assumed by the comparator).
  Those pixels are a cursor/blink-phase question, not the site, and were not changed (no renderer edit made).
  **Resolved 2026-11-12 (comparator staging, not renderer):** the comparator forced `selectionBlinkBit = 0` (cursor drawn) for every
  capture. The capture shows no cursor. Reproduced byte-identically on a fresh Copperline 1.0.1 (below), its RAM reads `$156A9` = `$0A`
  (bit 1 set) and `$14636` = (0, 0) (cell (47, 33)). With phase 1 (`UTOPIA_SITE_BLINK=1`) and the RAM pointer (127, 30), the map layer
  matches exactly (0 of 34,816). The 362 figure of the 2026-11-12 handoff used the wrong phase, and pointer (157, 80) with phase 0
  draws the cursor tile on (51, 35), which gives x 144..175, rows 60..86.
- Reproduction (OBSERVED, 2026-11-12): the probe's `protocol.log` replayed to line 2172 (1,000 requests, 0 mismatches, frame 16447,
  pointer (157, 80), the snap-E state), then `scripts/capture.py` run twice in the same instance (one relative move of (-30, -50) to
  (127, 30) and 10 frames, then the same call again with no move). The second grab matches the recorded window and native SHA-256
  (`52bc05b3...`, `2cbd739a...`) and reports frame 16467, pc 26726, the recorded `status_capture`. Scratch files only, under `%TEMP%`.
- Cursor phase against RAM (2 samples, OBSERVED): the E state (snap-E, `$156A9` = `$08`) shows the cursor tile on (51, 35); the
  2026-11-10 state (`$156A9` = `$0A`) does not show it. Both fit "cursor drawn when `$156A9` bit 1 is clear". The mechanism (the two
  bitmaps and the toggle order in `$6570`) is not established from two samples.
- Native frame SHA-256 `2cbd739a8f5f026a8c7983699b50335fcc003496be02f5862691434bf99c9492`. Captures and RAM dumps are kept outside the
  repository (`%TEMP%\UtopiaSiteCapture-20261110\out`).
- **Top-bar residual, 5 pixels at x 13..16, rows 4..6: resolved 2026-11-12 as date staging (OBSERVED RAM, MEASURED pixels; comparator
  staging, not renderer).** Before this, the comparator staged the E capture's day byte (`$1459F` = 2) on every capture. This frame
  is later: its day byte is 3.
  - The five pixels are in the second digit of the day (the `2` of `02`, x 13..17). Expected vs captured: (14,4) `444444` vs `ffff00`,
    (14,5) `ffff00` vs `000000`, (16,5) `222222` vs `ffff00`, (13,6) `ffff00` vs `222222`, (16,6) `444444` vs `ffff00`. Nothing else in
    the top bar differs.
  - Brute force of the day byte with the rest of the top bar staged as before (MEASURED, no renderer change): day 3 (`03/07/2090`) gives
    **0 of 7,680** mismatches. Day 5 gives 4, day 2 gives 5 (the staged value), day 6 gives 6. Money, DOL and the other staged bytes are
    unchanged: a different day is the only change that fits.
  - RAM (OBSERVED, a fresh Copperline 1.0.1, disposable copy of the same boot tree, read-only after the replay): the replay of the probe's
    `protocol.log` to line 2172 reads frame 16447 with `$1459F` = `02` (the E state). After the reproduced move to (127, 30) and the first
    10-frame step (frame 16459) it reads `03`. After the second call (frame 16467, pc 26726, the recorded status) it still reads `03`,
    with `$145A0` = `06`, `$142A6` = 0, `$142C8` = `002C`, money `$135BA` = `0007A13E` (500030), phase `$156A9` = `$0A`. The two window
    grabs of that second call are byte-identical to the recorded ones (`52bc05b3...`, `2cbd739a...`). So a day tick occurred in the 20
    frames between E and this capture, and the staged day 2 was wrong for this frame.
  - The alert lights are not the cause: the four warning lights are drawn at y = 139 (`LIGHT_Y` in `src/game/sim-alerts.ts`), outside the
    top bar, so the lit state cannot change rows 4..6.
  - The comparator now takes the day as an explicit input (`UTOPIA_SITE_DAY`, default 2 for the E capture). With
    `UTOPIA_SITE_POINTER=127,30 UTOPIA_SITE_BLINK=1 UTOPIA_SITE_DAY=3` the 2026-11-10 capture gives full frame **0 of 64,000** (top bar
    0 of 7,680, right panel 0 of 8,704, message line 0, log strip 0, map layer 0 of 34,816, crop 0), exit 0. The E capture with the
    defaults is unchanged: 0 of 64,000, exit 0. Test: `test/construction-site-capture-compare.mjs` (self-test `day parser`).
  - Reproduction note: `capture.py` passes its output path to Copperline as written. A relative path is resolved against Copperline's
    working directory, which was `original/utopia-whdload` here, so it wrote `run2/out/` into the original folder. Use an absolute path
    (the reproduction used `%TEMP%`). The stray files were removed; the original files' hashes were checked afterwards.
  - Limits: one reproduced state and one recorded frame; the day tick's exact frame is not located; the comparator's other staged bytes
    (month, years, QoL, money) were read at 16459 and 16467 and are the same as before.
- Not covered: pointer-cell blink phase beyond this frame, timing after the replay, other cells, the top bar on other dates, and the
  record's footprint beyond its single cell. The `Disk.1`/`Disk.2` inputs of the 2026-11-10 run were hashed on 2026-11-12 (the staged
  copy matches `original/utopia-whdload`: Disk.1 `47b5edea…`, Disk.2 `a6883496…`, disk.4 `31ca97f4…`).

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
