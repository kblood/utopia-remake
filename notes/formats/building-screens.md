# Clicking a building in select mode ($7140): windows, actions, ship building

Port: `src/game/screens/buildings.ts` (`createBuildingScreen(ctx, x, y, hooks?)`), test:
`test/buildings.mjs` (windows, controls, write-backs) and `test/window-input.mjs` section 2e (input of each window's loop). Addresses are those of the original program image (Disk.1 sectors $14C+, loaded
at $1000, so file offset = address + $28800) and of the state image (`game-state.md`). Strings are given
by index into the string table; no text, graphics or data are stored here or in the repository, the
engine reads them from the player's disk at runtime. "VERIFIED" = traced in the disassembly and/or
checked by the headless test and rendered; "HYPOTHESIS" = read from code only or inferred.
The window framework (frame, labels, number columns, buttons) is described in `screens.md` section 1.

## 1. Entry point

A left click on a map cell in select mode ($14591 = 1) runs `$7140`. VERIFIED.

1. `$72C0` finds the object record of the clicked cell (section 2). No record:
   tile `$32` (scaffold) -> message `$7D`; tile `$61` (mine without record) -> message `$89`; otherwise nothing.
2. `$6BE0` finds the type entry for the record's tile word (the original would loop forever on a missing
   one; the port treats it as "no type").
3. Dispatch on the record tile word:

| record tile | handler | what |
|---|---|---|
| 1 (tiles 1-3) | `$BED4` | power storage window (3.1) |
| `$4C` | `$BFEC` | command centre window (3.3) |
| `$3F`, `$40` | `$BF56` | fuel tank window (3.2) |
| `$0E` | `$C1BE` | hospital window (3.4) |
| `$30`, `$31` | `$E086` | missile launcher window (3.6) |
| `$36` | `$D7D6` | ship yard: order or status window (3.7) |
| `$5C` | `$C312` | sports complex window (3.5) |
| `$1F`, `$0F` | `$71D0-$7228` | gun turret step, no window (3.9) |
| `$47` | `$CAAE` + `$722A` | tank teleporter window (3.8) |
| anything else | `$729A` | message: the type's name (type entry +`$10`) |

A window is modal in the original (its loop owns the main loop), so the simulation, the units and the map
do not advance while one is open. In the port the caller must stop ticking them until the scene closes.

## 2. Record lookup ($72C0) - VERIFIED

- Cell tile id (low 10 bits of the map word) `>= $62`, `$32` or `$38`: no record.
- Tiles `$48-$5F` are the parts of 2x2 buildings; table `$77C8` (4 bytes per tile: base word, dx, dy) gives the
  part's offset from the origin cell. Part n of a 2x2 (tile base + n) lies at (0,0), (1,0), (0,1), (1,1). The record
  position is the clicked cell minus (dx, dy). The offline command centre tiles `$50-$53` map to the base `$4C`.
- All other tiles (including `$60`/`$61`, mines): the record at the clicked cell.
- The scan is over the non-empty records and compares x and y only (not the tile). The first match wins.

## 3. Windows

All windows are read from the image: window descriptor {x, y, width bytes, height rows}, label list
{string, x, y}..., button image table. Colours: labels first in the normal colour (1), then everything
marked "highlight" in colour `$15`. Number columns use 9 pixel rows. "T[i]" is the type entry at
`$131E2 + 18*i`, fields +`$A` active (A), +`$C` finished/online count (C), +`$E` stored, +`$10` name string.

Buttons: 10 icons, rects at `$5E06`; slot 8 (x 296-311, y 139-154) is the action, slot 9 (x 272-287, same y)
leaves. Windows with an action ignore the other slots; the read-out windows leave on any button (`$B99C`).

### 3.1 Power storage `$BED4` (T[0]) - VERIFIED
Window `$EB8A`, labels `$EBBA`, default buttons, no power check. Read-out: it ends in `$B99C` (input as 3.2).
Three numbers at (187,75), 4 digits, highlight: T[0].E / 10; T[0].C * (word `$1310C` / 10); T[0].C.

### 3.2 Fuel tanks `$BF56` (T[16] small `$13302`, T[17] large `$13314`) - VERIFIED
Window `$EB92`, labels `$EBC8`, default buttons. Four numbers at (188,75), 4 digits, highlight:
T16.E + T17.E (stored); T16.C * 800 + T17.C * 1200 (capacity); T16.C; T17.C.
**Input (VERIFIED statically, 2026-11-10; `test/window-input.mjs`).** The window ends in `$BF56`'s `bsr $B99C`: the default
buttons (`$E930`) are drawn and `$58F8` waits for a latched button. Any index latches (the ten rectangles, blank ones included),
its click plays on the press, and its release, wherever the pointer is, closes the window (`$B628`). Escape is not read on this
path: static reachability from `$BF56` and from the building entry `$7140` reaches no key register or key reader (the count
entry `$5110` is not reached). A right press alone does nothing; a right press while the left is held is a press at the pointer
again (`$5928`, section "Window loops" of screens.md). The remake: `ReadOut` (`buildings.ts`) leaves only on a button release.
Before 2026-11-10 it also left on Escape and the right button (a remake convenience now removed for this window).

### 3.3 Command centre `$BFEC` (T[29]) - VERIFIED
Refused with message `$12E` when byte `$144C8` (power shortage level) >= 14.
Window `$EB9A`, labels `$EBD6` (normal), buttons `$E95C` (slot 8 = switch icon `$174C2`).
Highlight: label `$EBE4` at (148,66) shows string `$49` when record byte +3 = `$FF` (online), else `$48`;
T[29].A at (205,48), 4 digits; if T[29].C = 0 the warning label `$EBEC`.
Button 8 (`$C0FE-$C1B4`): `not` of record byte +3. Now offline: T.C -= 1. Now online: T.C += 1, and if T.C
is not 1 (another was online) every record with tile `$4C` gets +3 = 0 and its map cells redrawn, the clicked
one gets +3 = `$FF` again and T.C = 1. Map cells of a centre (`$7342` via `$6A8C`, 4 cells, tile ids base+0..3
with flag byte of the flag table at `$16408`): tile `$4C` when online, `$50` when offline. Button 9 leaves.
The window is redrawn from state after each toggle.
**Input (VERIFIED statically, 2026-11-10; `test/window-input.mjs` 2e).** The loop `$C0C6` sets `bset.b #2,$156A8` and calls `$58F8`
on the buttons `$E95C`. Button 8 (`$C0FE`) toggles, redraws and loops; button 9 (`cmpi.b #9` at `$C0E6`) runs `$B628` and leaves; any
other index (0-7) loops with no effect. The key reach is nil (screens.md, "Key reads"). The remake: `CommandCentreScreen` (`TracedPanel`):
Escape and a right press alone do nothing; 8 toggles and 9 leaves, both on the release, wherever the pointer is.

### 3.4 Hospital `$C1BE` (T[4]) - VERIFIED
Refused with `$12E` when `$144C8` >= 15. Window `$EBA2`, labels `$EBF4`, buttons `$E95C`.
Highlight: numbers at (173,48), 4 digits: T[4].C (word `$13236`) and the medics (long `$1313E`).
Birth-rate string at (134,79): `$A224` maps byte `$145A2` 0 -> `$2E`, `$14` -> `$2F`, `$1E` -> `$30`,
anything else -> `$31` (none / low / medium / high). Button 8 cycles `$145A2`: 0 -> `$14` -> `$1E` -> `$3C` -> 0
(any other value -> 0). Note `state.ts` names `$145A2` "difficulty"; the hospital shows and edits it as the birth rate.
**Input (VERIFIED statically; `test/window-input.mjs` 2e).** Loop `$C280` on `$E95C`, the same `$58F8` shape as 3.3: button 8
(`$C2B4`) steps `$145A2` and redraws, then the loop repeats; button 9 (`$C2A4`) runs `$B628` and leaves; other indices loop. No key is
read. The remake: `HospitalScreen` (`TracedPanel`); Escape and a right press alone do nothing.

### 3.5 Sports complex `$C312` (T[32]) - VERIFIED
Refused with `$12E` when `$144C8` >= 2. Window `$EBAA`, labels `$EC08`, buttons `$EB06` (slot 8 = `$17562`).
Highlight: T[32].C at (175,62), 4 digits. Status at (24,80): when byte `$144B2` != 0 string `$51` with the
2-digit number `$144B2` patched into its placeholder (via `$15C5A`, leading zero blank); else string `$4F`.
Button 8 (only while `$144B2` = 0): `$144B2` = 12, `$144B1` bit 0 set (the simulation announces the event with
message 98 and adds 500 morale in its monthly step - already in `sim.ts`), and the status is overdrawn with
string `$50` (the window is not redrawn afterwards, so it stays until it is left; the port keeps a flag).
Button 9 leaves.
**Input (VERIFIED statically; `test/window-input.mjs` 2e).** Loop `$C3DE` on `$EB06`: button 8 (`$C41C`) first tests `$144B2`
(`tst.b`; `bne $C3DE`): while the countdown runs it does nothing, otherwise it sets the event and the loop goes on; 9 (`$C40C`)
runs `$B628` and leaves; other indices loop. No key is read. The remake: `SportsScreen` (`TracedPanel`).

### 3.6 Missile launchers `$E086` (T[8] small `$30`, T[9] large `$31`) - VERIFIED, enemy side HYPOTHESIS
No power check. Window `$EBB2`, labels `$EC16`, buttons `$EB5E`.
On entry the target search `$12456` runs once: range 20 cells (`$14`) for tile `$30`, 100 (`$64`) otherwise;
it scans the enemy ground list (`$3A12C`, stride `$1A`, count `$142A2`) and the enemy air list (`$39E20`, count
`$142A4`) for units with |dx| and |dy| <= range; a unit of type `$18` (ground) or `$1A`/`$1B` (air) is taken at
once, otherwise the last one found wins. The result pointer is kept in `$E904`.
- Found: third label (73,96) uses string `$12A` and slot 8 shows the fire icon (image `$179C2`, the original
  stores it into the table slot `$EB7E`).
- Not found: string `$129` and slot 8 stays blank (slot cleared).
Labels (normal): `$124` at (99,47), `$125` at (73,69), the third at (73,96). Highlight: T[8].C (`$1327E`) and T[9].C
(`$13290`) at (182,69), 4 digits.
Button 8 with a target runs `$49E8`: needs a free slot in the ship list (`$3A75E`, max 40, stride `$18`, count
`$1429E`); none -> message `$12B` and the window closes. Otherwise it creates a ship of type `$11` (missile) with
`$381E`. In the daily ship step `$ACE2`, a type `$11` record does `move.l $C(a6),d2; andi.l #$FFFFFF,d2`: the effective 24-bit enemy-record address is bytes +`$D..+$F` (+$C, the saved target y, is the masked-away top byte of that long). It refreshes target x/y (+$B/+C) from the pointed record +1/+2, and is destroyed if that record type byte is zero. [V] A missile therefore has no class (+$D) or fuel word (+$E/+$F): those bytes are the pointer. `$49E8` stores a separate own-cell flag pointer at +$14 (`$497E`: `$3D3A6 + y*$66 + x`). The same `$497E` call + store of `a4` at +$14 is made by the ordinary-ship creation `$387E` (before `$381E`), so +$14 is the per-cell flag-byte pointer for every ship-list record. [V, static]. Whether it is updated while a ship moves or lands is not traced. `$49E8` removes the
launcher (record word cleared, word `$142C2` -= 1, T.A -= 1, T.C -= 1 when record +3 != 0, its cell becomes tile `$9E`
rubble, one cell, with the flag byte) and closes with a sound. The missile then flies in the daily step `$ACE2` (section 5).
The port has no enemy model: `BuildingHooks.findTarget` / `launchMissile` provide it; without them a launcher
never has a target. The port's `launchMissile` stores the slot identity of the target (`Fleet.createMissile`, not `createShip`; ship-control.md 5d) and returns false when the ship list is full, which is when this screen says `$12B`.
**Input (VERIFIED statically; `test/window-input.mjs` 2e).** Loop `$E122` on `$EB5E`: button 8 (`$E158`) runs only with a target
(`tst.l $EB7E`, else the loop goes on); with a target `$49E8` runs and the window closes whether it fired (`$E14A`) or not
(`$E16A`: message `$12B`, then the close); 9 (`$E146`) runs `$B628` and leaves. No key is read. The remake: `MissileScreen` (`TracedPanel`).

### 3.7 Ship yard `$D7D6` (T[27] `$133D4`, tile `$36`) - VERIFIED
If word `$133F8` (T[29].C, online command centres) = 0: message `$B3`, nothing else. Otherwise the yard record's
byte +6 decides: 0 = order window, else status window. Record bytes: +6 = ordered ship (type index + 1, 1-6),
+7 = work left (`$FF` = finished, waiting for a launch pad).

Shared quantity: months = work / d1 + 1, d1 = (long `$143F6` / T[27].C) + 1, where `$143F6` is the staff assigned to
pool 3 (shipbuilders, `screens.md` staffing) - the port guards T[27].C = 0.

**Order window** (`$EF98`, labels `$EFA0` normal, buttons `$EFB4` slot 8 = `$16F22`):
six icons = sprite types 11-16 (descriptors from `$12D6A`, +`$22` each, frame 0, 20 rows) drawn at x = rect.x0 - 8 and
bottom y = rect.y1, rects at `$EFE0` (4 words each, x0 62, step 26; y 62-93). The 5th (index 4) is drawn only when
bit 4 of the invention long `$14472` is set. A click on an icon selects it: name string `$BE` + index at (57,103), work
from the word table `$F012` = {50, 100, 180, 240, 80, 50} kept in `$F173`, months at (136,121), 3 digits (both
highlight). Button 8: if something is selected, record +6 = index + 1, +7 = work; leaves. Button 9 leaves unchanged.
Locked icon (VERIFIED, static re-read 2026-11-10 of `$D7D6`-`$D9B0`; no emulator run). The window opens with `$F174 = -1`
(`st.b` at `$D7EA`); `$F173` is not reset there. A press on one of the six icon rectangles `$EFE0` (only when no command button
was hit) stores the index in `$F174` at `$D91C` BEFORE the lock test (`$D922`-`$D932`: index 4 with invention bit 4 clear returns
to the loop: no name, no estimate, no write to `$F173`, no click sound). Only an unlocked index reaches the name draw and
`$F173 = work table[index]` (`$D98E`-`$D99C`). Button 8 (`$D8DE`-`$D8EC`) orders `$F174 + 1` with the current `$F173` when
`$F174 >= 0`. So a locked click followed by Launch orders the locked type with whatever `$F173` holds: the work of an unlocked
choice in this window, or the byte left by an earlier window of the session (writers below).

**`$F173` writers (VERIFIED, static raw scan of Disk.1, 2026-11-10; no emulator run).** The 29 absolute-long operands of
`$0000F173` are all byte operations in `$C5E6`-`$DE88`, and no word or long write covers the byte (the `$F172` operands of the
same code are byte operations too). Disk.2 and the Disk.4 seed hold no code: their `$F17x` hits are table data.
- Tank window `$C5BE`: `$C5E6` clears it at open (0). `$C774` writes 5 (front; only when `$EE74` is set). `$C7CC` writes 6 (hover)
  or 7 (land) only with a pin selected (`$F172`). `$C91A` writes 9 on a placed-pin click (`$C914` sets `$F172` to the pin).
- Tank teleporter `$CAAE`: `$CC0E` writes `$FF` on every button event; button 8 then copies `$F172` (`$CC22`); the result is read at `$CC3A`.
- Ship window `$DA94`: `$DA98` writes the ship's mode (+9) at open, before the `$D6` refusal test (+$11 = 4), so a refused window
  writes it too. Button and pin changes write 1, 3, 0, 2, 9, 3, 2 and 4 (`$DD60`, `$DD70`, `$DD82`, `$DD90`, `$DDA6`, `$DE32`,
  `$DE4A`, `$DE84`). The window returns the byte to the dispatch (`$DDB2`, d1).
- Ship yard `$D99C`: the work value of an unlocked choice.

Readers of the byte outside these windows: the yard launch `$D8EC` only. No traced code resets it when a window closes or the
yard opens, and no traced save range covers it.

**Port (IMPLEMENTED 2026-11-10: `src/game/screens/order-byte.ts`; synthetic tests `test/order-byte.mjs`).** The byte is session
state per `World`. Each writer above calls `writeOrderByte`, and the launch reads `readOrderByte`. A reopened yard therefore orders
a locked icon with the work of the last unlocked choice of any earlier window, as the static trace says. The byte is not in the
native save (the `GameState` image covers `$13034`-`$14633` only), so a World created from a snapshot starts unknown (`null`), and
a locked launch then orders nothing. Not traced (HYPOTHESIS): the power-on value, and whether the original keeps the last RAM value
across a Disk.4 load, which the port does not do. While the byte is unknown the port orders nothing, where the original copies
whatever the RAM holds.

**Open, not changed: `$F174` is shared.** It is also the tank window's count (`$C876` writes it; the group order path near `$C9FE`
reads it) and the trade item row. The port keeps the tank count in `lastCounts`, so a yard visit (its open writes `$F174 = -1`)
does not reach the tank window. The two differ only if the original's group order reads `$F174` after a cancelled count prompt;
that path is not traced.

**Input of the order window (VERIFIED statically, 2026-11-10; `test/window-input.mjs`).** The loop `$D886` polls only through
`$50B2` (screens.md, "Window loops"). A press at the pointer is a command button first (`$5730` over `$5E06`): it latches and
flips with the click (`$5756`). Otherwise an icon rectangle (`$D902`): the press chooses it silently and stores `$F174` before the
lock test. A release, wherever the pointer is, runs the latched index (`$57FA`, then `$D898`-`$D8D4`): 8 orders the chosen icon
when `$F174` is not negative (`bmi` at `$D8E4`; +6 = index + 1, +7 = the order byte `$F173`, see below) and leaves; 9 leaves without an order; 0-7 do
nothing and the loop goes on. Escape is never read, and a right press alone changes nothing. A right press while the left is held
is a press at the pointer again: the latch moves to the button under it, or the icon under it is chosen, and the left release then
runs that latch. The remake (`ShipOrderScreen`): `pollsLikeOriginal`, and no Escape or right-button leave. Its only visual difference
is the flip residue described in screens.md ("Window loops").

**Status window** (`$F01E`, default buttons, any button leaves): labels `$F026` normal (`$BB` (87,42), `$C4` (73,61),
`$BD` (73,88)); highlight: ship name string `$BD` + record +6 at (73,70); months at (156,88), 3 digits: 0 when
+7 = `$FF` else (+7 / d1) + 1.

### 3.8 Tank teleporter `$CAAE` + `$722A` (T[25], tile `$47`) - VERIFIED
1. `$144C8` != 0 -> message `$12E`, result -1.
2. Cell bit 14 (`$4000`, unit present) clear -> message `$10A`.
3. `$49AA`: first own unit (list `$3AB1E`) with |x - ux| <= 1 and |y - uy| <= 1 of the clicked cell; none -> `$10A`.
4. Window `$EE8C`, labels `$EE94` (normal), buttons `$EEA2` (slot 8 = `$17BA2`). Then highlight.
   If the marker mask `$144B0` = 0 (no pin placed): string `$92` at (92,102). Else the marker pin sprites (types 1-8,
   frame 0, 20 rows) of the placed pins at rect.x0 - 8 / rect.y1, rects `$EE1E` (8 entries: x0 52 + 24n, width 16,
   y 75-100). A click on a placed pin's rect selects it (`$F172`) and shows string `$10B` with the pin digit ('1' + n)
   in its placeholder at (68,102), the strip (18 bytes wide) erased first; clicks on unplaced pins are ignored.
   Button 8 returns the selected pin (or -1), button 9 returns -1.
5. Result n >= 0, pin n at pin record `$14540` + 10n (+1 x, +2 y): when the destination cell word & `$7400` != 0
   (bits 10, 12, 13, 14) -> message `$10E`. Otherwise: set bit 14 on the destination and bit 2 in its flag byte;
   the unit's reserve pointer = destination; bit 14 and flag bit 2 are cleared at the unit's OLD (x, y); unit x, y =
   pin; message `$10D`. The original leaves dx, dy and (if the unit was moving) the old reserved cell as they are;
   the port does the same. The port reads pins from `ObjectLayer.markers` (the mask is derived from them).
**Input (VERIFIED statically; `test/window-input.mjs` 2e).** This loop polls `$50B2` itself (`$CBB4`), not through `$58F8`. A press
on a command button (`$5730` over the rectangles `$5E06`; images `$EEA2`) latches it with the click (`$5756`); a press on a pin (`$CC46`: its rectangle `$EE1E`
and mask `$144B0` bit n set) sets `$F172` to the pin and draws its number, with no click and no leave; any other press does nothing.
A release runs the latch (`$57FA`) wherever the pointer is, and first sets `$F173` to `$FF` (`$CC0E`). Button 8 (`$CC1C`) copies
`$F172` into `$F173` and leaves (`$CC22`, `$CC2C`); 9 (`$CC14`) leaves with `$FF` in place; other indices loop. The caller reads
`$F173` after the return (`$CC3A`), so a confirmed pick leaves the pin number there and an empty one leaves `$FF`. No key is read.
The remake: `TeleportScreen` (`TracedPanel`): the pin press is its `onClick`, the release its `onButton`, and the order byte is
written as above (`order-byte.ts`).

### 3.9 Gun turrets (tiles `$1F` laser, `$0F` plasma) - VERIFIED
No window. Record: +2 facing frame 0-7, +6 rotation (`$FF` = -1, 1 = +1, 0 = stopped), +7 cooldown; map tile low byte
= base + facing, firing flashes are the frames 8 higher ($17-$1E plasma, $27-$2E laser; AI `$11D34`, active only when
+3 = `$FF` and `$144C8` < 16). A click: if +6 != 0, +6 = 0 (stops the automatic turn); else it steps one facing: low byte
`>= $27` or in `$17-$1E` -> minus 8 and +7 = 0; then low byte + 1 and +2 + 1; when +2 reaches 8: +2 = 0 and the low
byte = the type's base tile (T +9). The cell low byte is written back (flags kept), +6 = 0. Either way the type's name
(T+`$10`) is said.

## 4. Monthly ship building `$AC04` + launch `$4060` (ported: `src/game/sim-ships.ts` `Fleet.shipYard` / `launch` / `createShip`; traced VERIFIED, no live comparison) - VERIFIED

Called from the monthly step. Returns at once when `$144C8` >= 9 or word `$133F8` (online CCs) = 0.
d7 = long `$143F6` (staff pool 3); stop if 0. d6 = T[27].C (yards); d7 /= d6 = workers per yard; stop if 0.
For each yard record (tile `$36`, T[27].C of them):

- +6 = 0 -> next yard.
- d2 = +7. If d2 = 0 -> finish (below). If d2 = `$FF` -> go straight to the launch `$4060` (a retry after a blocked launch).
- d3 = min(d2, d7). `$A32C(d0 = d3, d1 = 1)` removes that much stock of good 1 (ore) and returns the amount removed.
  Removed 0 -> message `$C6` (needs more ore) and the whole routine stops.
- +7 -= removed; `$1437A` += removed; `$143A2` += removed; `$1434A` -= removed (`$1434A` = the stock copy of good 1).
- +7 = 0 -> finish; else next yard.

Finish: cost = byte table `$B251` indexed by (+6 - 1) = {0, 2, 4, 2, 3, 1} units of good 3 (weapons). If cost != 0
`$A32C(cost, 3)`; removed 0 -> message `$C5` (needs more weapons) and the routine stops (a partial amount is accepted).
Then +7 = `$FF` and `$4060` is called; the loop continues with the next yard.

**Launch `$4060`**: scan records with tile `$48` (launch pad) and +3 = `$FF` (online) with |dx| <= 5 and |dy| <= 5 of the
yard; each pad contributes its four cells (x,y), (x,y+1), (x+1,y+1), (x+1,y). No pad, or every cell has bit 14 set ->
message `$C7` (the order stays at +7 = `$FF`). On the first free cell: type index = +6 - 1; the word at +6 is cleared
(+6 and +7 become 0) and `$143B2` += 1; ship type = byte table `$4BBE` = {11, 12, 13, 14, 15, 16}. `$387E`: ship list full
(`$1429E` = 40) -> message `$C8` and the routine stops; else a ship record is made in `$3A75E` (stride `$18`), bit 14 set
on the cell and bit 2 in its flag byte, and `$381E` fills it: +0 type, +1/+2 cell, +5 = 8, +3/+4/+6/+7 = 0, +`$10-$12` =
`$FF`, then 8 bytes from the table `$4B76` (type 9 onwards): hp, mode, ..., fuel word:
type 11 hp 10 fuel 400; 12 hp 20 fuel 600; 13 hp 30 fuel 600; 14 hp 50 fuel 1200; 15 hp 30 no fuel (`$FFFF`);
16 hp 15 fuel 400; 17 (missile) hp 40 mode 4. Afterwards +`$A` = tech level `$14592`, +`$D` = class index = type - 11 (0..5; static disassembly of `$38C4-$38CE`:
`subq.b #8` / `subq.b #3` on the type byte, not the constant 11 as an earlier reading had it), +`$10` = 0,
and +`$E` = 0 unless the ship is type index 4. [V, static] `$387E` also does `bset.b #2,(a4)` on the launch cell's flag byte
(a4 from `$497E`; bit 2 = own-ground flag, the same bit a landed own tank uses) and stores that cell's flag pointer at +`$14`.
The port sets the flag bit in `Fleet.createShip` (before this was missing, so a freshly launched ship on a pad was not seen by
enemy ground units' scan, enemies.md attack); the reservation is the lazily created landed `ShipExtra` (rx/ry = the cell).
Four sound pulses in the trace: the port shows four clicks after completion instead (`LAUNCH_CLICKS` in `map.ts`); whether that
matches the original's pulses is unverified. Resolved statically (2026-11-09, no gameplay effect found): `$381E`/`$387E` leave +`$11` and +`$12` at `$FF` (`st.b`), while the port's `ShipExtra` for a yard-built ship uses next 0 and turn 2. Takeoff `$4152` is reached only from the `beq` at `$41B0` inside the order routine `$41A8`, which writes +`$11` (`move.b d1,$11(a0)`) before that branch, and `$4152` writes +`$12` before anything reads it. The initial values are therefore never read; the climb-end `$4346`, which copies +`$11` into the mode, only runs after such a takeoff.
String meanings: `$C5` more weapons, `$C6` more ore, `$C7` launch pad needed free, `$C8` no more ships possible.

## 5. Daily ship step `$ACE2` and refuelling - VERIFIED (flight itself HYPOTHESIS)

For every ship in `$3A746` (count `$1429E`): type `$11` (missile): refresh its target x, y (+B, +C) from the target
pointer's +1, +2; when the target's type byte is 0 the missile is destroyed (`$46CC`, d0 = 0, bit 5 of `$156A9` set).
Type `$0F` is skipped (no fuel). Otherwise by mode +9: 1 -> fuel -1; 2 or 3 -> fuel -2; other modes nothing. The fuel word
is +`$E`; at 0 or below the ship is destroyed (`$46CC`, d0 = `$40`), else stored.
`$4798` (weekly): ships in mode 0 on a launch pad tile (`$48-$4B`) are refuelled from the tanks up to the capacity table
`$4A98` = {400, 600, 600, 1200, none, 400, 0, 0, none, 0} via `$4848`/`$4854`, which call `$A5A6`; message `$EE` once.

`$A5A6` (take d0 units of fuel out of the tanks): `$14342` -= d0; `$14376` and `$1439A` += d0; the remainder is redistributed
over the two tank types (capacities 800 / 1200 per tank). Already ported as `removeFuel` in `screens/trade.ts`; other callers:
the market (`$D4AA`, `$D596`) and event 15 (`$114F6`, fuel beaming).

## 6. Using it from the map

```ts
import { createBuildingScreen } from "./screens/buildings.js";
const scene = createBuildingScreen(ctx, cellX, cellY, { units, pin, findTarget, launchMissile });
```
- `ctx` as for the other screens (`{ disk, world, sim, strings, say }`); `say` receives message string indices.
  `ctx.objects` (the object layer) supplies the units and the marker pins unless `hooks.units` / `hooks.pin` are given.
- Returns `null` when the click was handled at once (a message through `ctx.say`, the gun step) or does nothing.
- Returns a `ScreenScene` for a window: call `scene.update(input)` once per frame and `scene.draw(screen)` over the frozen
  map frame until it returns `"close"`. Do not tick the sim, units or map while it is open (the original is modal).
- Actions (command centre switch, birth rate, sports event, ship order, teleport, missile removal) write straight into the
  world / state; there is nothing to commit when the window closes. After the command centre switch and the missile launch
  the map cells changed: redraw the map.
- Simulated but not compared with the running original: the monthly ship building (section 4, `Fleet.shipYard`), the ship list and the
  daily step (section 5). The missile flight is the EnemySystem's (flight HYPOTHESIS, notes/formats/ship-control.md 5d).
