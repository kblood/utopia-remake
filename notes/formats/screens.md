# Window screens (F1-F6 reports, trade, market, staffing, intelligence)

Port: `src/game/screens/` (`createScreen(kind, ctx)` in `index.ts`), test: `test/screens.mjs`.
Addresses are those of the original program image (Disk.1 sectors $14C+, loaded at $1000, so
file offset = address + $28800) and of the state image (`game-state.md`). Strings are given by
index into the string table (`game-text.md`); no text is stored here or in the repository, the
engine reads it from the player's disk at runtime. "VERIFIED" = rendered and compared against the
disassembly; "HYPOTHESIS" = read from code only.

## 1. Common machinery

- The screens are **windows over the frozen map screen**, not full-screen. A window descriptor is
  four words {x pixels, y pixels, width in 8-pixel bytes, height in 8-pixel rows}; `$B680` draws
  the frame with a filled interior. The frame pieces are 8x8 tiles copied from the main background
  picture at row 70, x = 80 + 8k (k: 0 fill, 1 top-left, 2 top-right, 3 bottom-left, 4 bottom-right,
  5 top, 6 left, 7 right, 8 bottom). VERIFIED (renders like the original).
- Label list ($55CA): triples {string index (word), x, y}, ended by $FFFF; drawn with `$538A` in the
  colour held in $156AB (1 = normal, $15 = yellow highlight).
- Number columns ($560A): `a0` = array of longs, `d0/d1` = x/y, `d3` = count, `d2` = first power
  of ten of the digit field (so d2 = 1000 means 4 digit slots). One row per 9 pixels. Leading zeros
  are replaced by '#' (a blank glyph), values are never drawn negative (`$15C5A`).
- Ten 16x16 buttons, rectangles at $5E06 (x0, x1, y0, y1 words), two columns by five rows at the
  right edge. Each screen draws them from a table of ten image pointers (0 = the blank default
  image $185A2; 5 planes of 16 words each). `$58F8` / `$57FA` + `$5730` return the released button;
  a pressed button is shown inverted (all planes complemented, `$5756`). Tables: $E930 default
  (blank buttons, exit icon at index 9), $EF02 trade, $EF50 market, $F118 intelligence.
- Number entry `$5110`: `d0/d1` = x/y, `d4` = maximum digits, `d2` = width of the erased field in
  bytes; digits are echoed followed by '-', Return confirms (not when empty), Backspace deletes. The
  text is converted by `$15CD0` (decimal, result in d1).
- Result messages that contain a number (e.g. "units bought") have a first byte giving the offset
  of four filler characters; `$15C5A` writes the number there with d2 = 1000.

Remake conveniences (not in the original): Escape or the right mouse button leaves a window
that has no entry open; Escape cancels an entry.

## 2. F-key report windows

All six end by waiting for a button; any button leaves. They only read state. VERIFIED by rendering.

| Key | Routine | Window | Labels | Notes |
|---|---|---|---|---|
| F1 | $B81C | $E910 {0,32,28,15} | $EA76 (idx 39 title, 40, 41, 42, 43, 44, 45, 83), second list $EAA8 | birth-rate string, three numbers, seven numbers, morale and crime texts |
| F2 | $BA1E | $E918 {24,32,24,12} | $EAB0 (idx 50, 51, 52, 53) | four columns of five |
| F3 | $BD9E | $E928 {8,16,26,16} | $EAE4 (idx 59, 60, 61, 62) | finance |
| F4 | $C516 | $EC4E {0,8,28,21} | $EC56 (title idx 119, 31 building names in two columns) | counts |
| F5 | $D6BA | $EF7C {24,24,25,13} | $EF84 (idx 180, 181, 182) | research status |
| F6 | $E1AA | $ED9E {8,8,25,21} | $EDA6 (idx 303, 276, 277, 130, 275, 190-195, 6, 7, 9, 122, 278) | defence |

F1 ($B81C), colour $15 from the second label list on:
- Rate string: `$A224` picks index 46/47/48/49 from the difficulty byte $145A2 (0 / $14 / $1E / other), drawn at (172, 55) via the patched first word of list $EAA8.
- Numbers (x 194, y 73, 4 digits): births $1432E, deaths $14332, population density = population $1314A * 100 / (housing total $1326C * 50), 100 if there is no housing.
- Numbers (x 76, y 55, 6 digits): free $13136, workers ($1432A + $143BE + $143C2), technicians (employed $1313A - security $13146 - medics $1313E - scientists $13142), medics $1313E, scientists $13142, security $13146, population $1314A.
- Morale text at (48, 138): morale $144EC / 100; negative: index $59 when |m| >= 50 else $5A; otherwise $5C when m >= 50 else $5B.
- Crime text at (48, 125): $142CE negative = $68; byte <= $14 = $69; <= $32 = $6A; else $6B.

F2: columns x 69 / 101 / 135 / 167 at y 76, 6 digits, five rows (air, food, fuel, power, ore) from $1433A, $1434E, $14362, $1437E.

F3: tax copy $144FC at (62, 71), 3 digits. Month column x 120, y 53 (7 digits): $142E2, $142E6, $142EA and their sum, which the original stores in $142EE. Year column x 170: $14302, $14306, $1430A and the sum stored in $1430E. Expenditure $135B6 and funds $135BA at (120, 99); year expenditure $14312 at (170, 99). Warning at (16, 130): $DB when $144BA (trade computer failure) is set; else $EB when the grant $135BE is non-zero and <= $258; else $3F when $142EE - $135B6 is negative.

F4: 32 pointers at $ED1E to the building type records; value = word +$A (finished buildings). First 16 at x 94, next 16 at x 200, y 31, 4 digits.

F5: tech level $14592, laboratories word $13200, scientists $13142, military grant $142D2, civilian grant $142D6 at (151, 48), 5 digits. Status text at (35, 118): threshold = long at $B154 + 4 * (tech - 1); $B8 when threshold - $142DE < threshold / 10; else $B7 when both grants are 0; else $B9 only when scientists $13142 equals $143E2 (nothing otherwise). Last invention string (word $1447A, 0 = none) at (35, 104).

F6: $14254 (8 longs, "on map") at (85, 49), $14274 (8 longs, "at enemy city") at (130, 49), 4 digits; defence buildings (words $13246, $13258, $1327C, $1328E) at (90, 130); forces destroyed $14294 (2 longs, yours/enemy) at (156, 139), 5 digits.

## 3. Staffing window (icon column button 6, $BAAE) - VERIFIED render, write-back by reading the code

Window $E920 {8, 8, 29, 18}, labels $EACA (idx 54 row names at (17,40), 55 and 56 headers, 57 "click to alter" at (17,139); idx 58 replaces 57 while a value is typed).
Rows: y = 40 + 9 * row, row 6 is a spacer; rows 0-5 = pools 0-5 (production buildings), rows 7-9 = pools 6-8 (medics, scientists, security). Columns (4 digits): $143EA employed x 86, $14500 allowed x 113, $143C6 required x 144, $1440E vacant x 172, $143A6 production x 200 (5 digits, rows 0-5 only).
Click (any x, y in the row band): `$5110` at x 115 on that row, 4 digits. Write-back (`$BD1C-$BD6C`): $14500[pool] = typed value; `diff = employed - value`; if diff >= 0: employed = value, $1313A -= diff, $13136 += diff, vacant = 0; else vacant = (value >= required ? required : value) - employed. Leaving copies $143EA[6..8] to $1313E, $13142, $13146.

## 4. Trade window (icon column button 4, $CC8E)

Window $EECE, labels $EED6 (idx 156 item names (26,54), 157 money (26,124), 162 tax (26,133), 158/159 headers, 160 grants (121,124), 57 prompt (26,146)), buttons $EF02. VERIFIED render.
Columns (y 54, six rows): kg/unit from the program image at $B0E8 (x 80, 4 digits); stock copy from $1314E (x 116, 6 digits; the fuel entry is first set to $14342); retain % $144CC (x 160, 3 digits); idx 161 ('%' signs) at (180,54); tradable $14234 (x 196, 5 digits) = stock - stock * retain / 100 (`$A784`). Next-year tax $144F8 at (86,133) (2 digits); grants $142D2 / $142D6 at (192,124) (5 digits); money (<= 999999) at (66,124).
Buttons 0-7 do nothing; 8 opens the market, 9 leaves.
Clicks (by pointer position, `$CE46-$D080`):
- y < 124: row (y - 54) / 9 (0-5): entry at x 160, 3 digits, prompt idx 58; value capped at 100, stored to retain[row]; then `$A784` recomputes tradable.
- 124 <= y < 143 and x < 129: entry at (86,133), 2 digits; value (byte compare) capped at 20, stored to $144F8 (next year's tax; $144F4 changes at the year change).
- 124 <= y < 143 and x >= 129: entry at x 192 (y 124 when the click was above 133, grant = military, else y 133 = civilian), 5 digits, prompt idx 186. The amount is capped by the funds; grant += amount; if grant > 99999 the grant is cut to 99999 and only what fitted is paid; money -= paid.

## 5. Market window ($D0D8 entry, $D106 window)

Refusals on the map screen ($D0D8, message line indices): bit 1 of $144C2 set (already traded this month) = $A5; $144BA non-zero (trade computer failure) = $117; word $133F8 = 0 (no commander) = $B2. Otherwise the window opens. VERIFIED render; refusals, flow and quirk below by reading the code (HYPOTHESIS: not run in an emulator).
Window $EF2E {8,24,30,17}, labels $EF36 (156 items (18,56), 157 money (18,120), 163 headers (67,43), 164 (116,34)), buttons $EF50. Columns (y 56, rows 0-5): kg/unit $B0E8 x 72 (4); stock $1314E x 109 (6); price = first word of market entry i ($1316A + 10 i) x 150 (3); supply $1443A x 181 (4); demand $14452 x 212 (4); money x 54, y 120. Result lines at (18,135) and (18,144), cleared before each message.
Buttons: 2-7 select item 0-5 ($F174, message idx 167); 1 buy; 0 sell; 8 dump; 9 leave (`$1434A = $13156`). With nothing selected buy/sell/dump show idx 166 again.
Entry: x 150, y 135, 4 digits, field 6 bytes; prompts idx 170 (buy), 171 (sell), 349 (dump). After a result the window ignores input for 76 frames, then returns to idx 166.
- Buy: refused with idx 169 when supply is 0. Units = min(typed, supply); cost = price * units (word multiply); if cost >= money: idx 176. Fuel goes through `$A51A` (units that fit the tanks are added to $1314E), goods through `$A2DE` (stock and weight; idx 175 when the store is full). supply -= units actually stored; money -= price * stored; result idx 172 with the count.
- Sell: idx 177 when demand is 0; idx 168 when stock is 0. Units = min(typed, demand, stock); fuel through `$A5A6`, goods through `$A32C`; demand -= units; money += price * units and $142F6 += the same; result idx 173; idx 174 on a second line when the stock is now 0.
- Dump: idx 168 when stock is 0; units = min(typed, stock); removed like a sale; no money. Result idx 380 would carry the count, but the original does not restore the string pointer after writing the number (`$D5F8-$D602`), so the first line is empty; idx 379 on a second line when the stock is now 0.
- Buy, sell and dump all set bit 1 and clear bit 0 of $144C2 (`$D41E`), so the market stays closed until the monthly code clears it.
- For goods the stock array $13152.. is the same memory as the copy at $1314E + 4 i; only the fuel entry is a separate copy.

## 6. Intelligence window (icon column button 7, $E2D2) - PARTLY PORTED

Windows $F100 {240,2,10,10} (picture) and $F110 {0,0,30,25}, labels $F144 (idx 287 title (78,8), 294 (6,20), 157 money (140,29)), buttons $F118; heading idx $18B + level ($144CA) at (102,20) in yellow; intelligence grant $1446A at (88,29) (6 digits), money at (178,29). Buttons 8 and 9 leave. A click with y in 29-37 opens an entry at (94,29), 5 digits; `grant += min(typed, money)`, `money -= same`, then `$AD70` sets $144CA: 0 when the grant is 0, 1 below 5000, 2 below 20000, else 3 (skipped when bit 2 of $156AA is set - meaning unknown, ignored).
Not ported: the alien report text and portraits (`$E530`, `$E642`, images from Disk.2 at +$24 with a separate text table at $6B060), and the second frame style of `$B6CE` (the port uses the plain window frame).

## 7. Remaining gaps

- The F-key handlers in the original check nothing before opening; if the game is over or a dialog is up the caller should not open them.
- The overview does not simulate enemy ground units, enemy aircraft or own ships (see section 8); the caller can pass them through `ScreenContext.otherUnits`.

## 8. Overview map (icon column button 1, $F176) and marker mode (button 3, $30FE) - `overview.ts`, `markers.ts`

Status: logic traced from the disassembly and rendered headless; no emulator comparison was possible. VERIFIED = read straight from the code and the tables on the disk; HYPOTHESIS = guessed.

Opening: `createScreen("overview", ctx)`. Full-screen: picture 0 of the table at $8C8C (sectors $2E8-$2F6, palette from its tail) replaces the frame and palette. Closing puts the pristine gameplay picture and palette back (the map scene redraws on top). Button rectangles $FF5C (8 x {x0,x1,y0,y1}, ended by $FFFF): buttons 0-6 choose the layer, button 7 leaves.

Geometry (VERIFIED): the whole 100 x 75 map at 2 x 2 pixels per cell from (8,8); a 16 x 16 masked frame (image $105C4, five planes x 16 rows x 4 bytes, plane 0 is the mask) around the 8 x 8 cell view at scroll ($144E4/$144E6, clamped to $5C/$43 by $FB1E); a magnified 8 x 8 cell preview of the view at (232,75), 8 x 8 pixels per cell; a strip of eight pin images ($10A88, 8 x 8, five planes x 8 rows, 40 bytes each) at (232,151); legend text in the message panel: six string indices per layer at $FF9E (7 x 6 words, $FFFE blank), drawn at the slots $FFF2 ({index,x,y} x 6).

Controls (VERIFIED): a press on a layer button shows it inverted, the release sets mode byte $144B6 = button (7 = leave) and redraws. A click on the map (x < $D1, y < $A0) centres the view on the clicked cell: scroll = ((x-8)>>1)-4, ((y-8)>>1)-4, clamped. A click in the preview (x $E8-$127, y $4A-$89) calls $311E for the clicked cell with no message. The port also closes on Escape or the right button (the original only has button 7).

Layers (colour = palette index of the overview picture; VERIFIED from $F632-$FA24, legend swatches checked against the legend table):
- 0 buildings: rock (bit 12 set and bit 10 clear) 2, animated cells by tile id: $32 -> 9, 1-3 -> $D, $60 -> $15, $3E -> $18, $48-$4B -> 6, other -> $12; everything else 5.
- 1 and 2 deposits: cells with map flag bit 15 (layer 1) or bit 11 (layer 2) are $D when the matching invention (bit 9 resp. 10 of long $14472) is known or the cell lies inside an 11 x 11 box ($F954) around any animated cell (bit 10); otherwise rock 2 or ground 5.
- 3 coverage and units: tile ids 6-13 are $D, cells inside coverage $12, else 5; then units.
- 4 units only: rock 2 / ground 5 plus the unit overlay.
- 5, 6: further tile-id class tables ($F86A, $F7FE) - see `overview.ts`.
- Coverage ($F6E4): animated cells project a mask by tile id: <6 or >=14 the 7 x 7 mask ($10018), 6-9 the 21 x 21 mask ($10049), 10-13 the 31 x 31 mask ($10202); the two big ones only while byte $144C8 is below 4 (signed); invention bit 17 covers everything.
- Unit overlay ($FA24): own ground units $18 and ships 6 always; enemy ground units 9 and enemy aircraft $15 only inside coverage. Lists: $3AB06 own, $3A746 ships, $3A12C enemy ground, $39E20 enemy air.

Pins (VERIFIED): placed markers are drawn on the map and preview only every other blink period; a pin that is on the map leaves its slot in the strip black.

HYPOTHESIS / port decisions:
- Blink period: the original counts 6000 polls of the mouse buttons ($10A84); the port toggles every 8 frames.
- Meaning of $144C8: treated as the power state (it is only compared with 4); sim.ts uses it the same way.
- Enemy ground units, aircraft and own ships are not simulated by the port; the overview only shows them when the caller supplies them.
- The pressed-button flip: $57D6 complements one plane (colour ^ 8); `Ui.invertButton` used by the other screens complements all planes. Not unified.
- A click with x < 8 on the map wraps around in the original ($F2D4 subtracts unsigned); the port clamps to 0.

Marker mode (button 3, $30FE, VERIFIED): not a screen. It shows message $6F and sets flag $144B3. The next left click on a map cell ($158CA, screen mode 1) calls $311E with that cell instead of selecting, and clears the flag (also when nothing can be placed). $311E: a pin already on the cell is lifted (message $72); else the lowest unused pin goes there (message $71, pin number '1'-'8' patched into the text via the placeholder byte of the string); with all eight in use nothing happens (message $70). In the port: `MarkerMode.arm()` returns 0x6F, `MarkerMode.click(layer, x, y)` returns null when not armed or the result; `markerMessageText(strings, pin)` gives the text of $71.

## 9. Council room (icon column button 5, $15CFE) - `council.ts`

Status: traced and rendered headless; VERIFIED unless marked.

Button 5 refuses with message $B2 when word $133F8 is zero (no game running); otherwise it shows picture 2 of the table at $8C8C (sectors $2F8-$327, palette from its tail) with six adviser rectangles at $1614E ({x0,x1,y0,y1} each, ended by $FFFF; order = F1..F6: colony, resources, finances, buildings, research, defence). A left press on an adviser draws a caption window ($E850, label lists via the pointers at $E858, two lines each) and his portrait (88 x 79 pixels at (224,33), sheet in sectors $328-$34B, six images of 11 x 79 bytes x 5 planes, LZ packed) and calls the matching F-key report handler; that report runs with bit 5 of $156A8 set - no button column, it waits for a left press and returns to the room. A left press outside every adviser (or Escape / right button in the port) leaves; the gameplay picture and palette are restored by the port.
HYPOTHESIS: none beyond the portrait sheet's plane layout being the same as the other planar images (checked by the render).
