# Ordering launched ships and own ground units (static analysis; port in `src/game/orders.ts`, `src/game/screens/orders.ts`, `EnemySystem.commandShip`, `Builder.placeLaunchpad`)

Status tags: [V] read from the disassembly, [H] hypothesis / guess. Addresses are image addresses (file offset = address + $28800).
No game data is stored: window layouts, pin rectangles, icons and texts are read from Disk.1 at runtime (offsets below).

## 1. How the player reaches the windows [V]

- **Right click in select mode** runs `$15F44` (the arrow buttons are tested first), then the pick `$3EDC`, then the classifier `$3F5E`.
  A left click only reaches the building windows (`$7140`); nothing else on the map reacts to it.
- Classifier: a record whose type is 9/10 (own tank) opens the **tank window `$C5BE`**; types 11..16 (the six ship classes) open the
  **ship window `$DA94`**; everything else (projectile type 17, enemies, buildings) ends the search without a window. Both windows are modal
  (they run their own loop and the map stands still).
- Pick `$3EDC` [V]: with a map cell under the pointer (`$5CDA`) the first ship (ship list order), then the first own tank standing exactly
  on that cell is chosen. If none, the drawn-object list is scanned (`$3F1E`) for the first sprite whose 20 x 20 box (`$3F28`; x = left edge,
  y = bottom row) contains a point; after a cell hit that point is the cell's top-left corner (`$5D28`), otherwise the pointer.
  [H] the port additionally retries with the pointer after a failed cell scan, so a flying ship can be picked by its sprite.

## 2. Ship window `$DA94` and the dispatch `$3F9E` [V]

Window rectangle table `$F03A`, labels `$F042`, the eight pin rectangles `$F056`, buttons `$F098`; class tables `$4BC4` and `$4A98`
(name / data per ship class). `$F172` = selected pin (`$FF` none), `$F173` = chosen order.

| Order `$F173` | Meaning |
|---|---|
| 0 | land here |
| 1 | hover here |
| 2 | go to the selected pin and land |
| 3 | go to the selected pin and hover |
| 4 | build a launchpad here (Explorer, class 0, only when the current order is "land") |
| 9 | go to the front (the front cell is the off-map pair `$135C4/$135C5`) |

- A ship whose fuel word (+$E) is 0 refuses every order with message `$ED` (`$3F94`).
- A ship that still has "order 4" pending (+$11 == 4) cannot be given a new order: message `$D6` instead of the window.
- Dispatch: 1 and 4 -> `$41A8`; 0 -> `$4204`; 9 -> front cell as order 2 through `$427C`; 2 and 3 -> `$4260` (copies the pin cell to +$B/+$C) then `$427C`.
  The ship's order byte is +$11, its own mode +9.
- `$41A8` (hold orders 1/4): +$11 = order. Mode 0 -> take off (`$4152`); modes 2, 3, 5 -> 6; mode 8 -> 7.
- `$4204` (land): hovering (1) or climbing (7) -> mode 8, but stay at hover (1) when the cell word & $5000 (blocked); flying (2, 3, 6) -> mode 5.
- `$427C` (go): mode 0 -> take off; mode 8 -> 7; mode < 5 and != order -> mode = order.
- Takeoff `$4152`: +$12 = 2 when +$11 == 1, else the direction towards the target (`$44DE`, 6 when already on the target cell); the ground mark
  (word bit 14, flag 4) becomes the air mark (bit 13, flag 8), direction = 2, fuel -= 8 (skipped when the word is negative, floored at 0), mode 7.
- Orders 2/3 without a selected pin and the "unchanged" no-op cases read a stale table row in the original; the port ignores them [H].
- The button that sends a ship to the front is gated by `$13EE6` bit 7 (as in the tank window), icon at `$17C42` [V].

## 3. Launchpad (order 4) [V]

Mode 4 is entered from the climb's `nextMode` when +$11 == 4: `$771E` is called for the ship's cell. If it refuses, the ship starts landing at once.
Otherwise it hovers in mode 4 and lands when the map cell's tile id becomes `$48` (the finished pad).

`$771E` rules: the cell must be in range x 4..$60, y 4..$47; a 2 x 2 footprint must be free (mask `$5400` on all four cells); a free object slot must exist;
cost = word +6 of the type-28 record versus money `$135BA` (message `$E9` = refused, `$EA` = not enough money). No workers, no power and no
base-connection check. It writes the record {0, `$32` (construction site), 0, `$48`, x, y, weeks = byte(type +2), 0}, increments `$142C2`
(objects) and `$142C4` (sites) and marks the four cells as a site; the weekly construction pass later turns it into tile `$48`.

## 4. Tank window `$C5BE` [V]

Window `$EE08`, labels `$EE10`, pins `$EE1E`, buttons `$EE60`. A group order asks for a count N (two digits). Sorting `$3FEE`: Chebyshev distance
to the reference cell, bubble sort that also swaps equal neighbours (so ties reverse each pass). The N nearest tanks (counted from the window's own
tank for "go to pin" / "near this tank", from the pin cell for "near the pin") get the pin as target (`$C8B4`: target set, recent directions cleared).
N = 0 does nothing; N greater than the number of tanks means all. Button 8 stops the tank (`$C8DC`: no target, zero speed and offsets);
button 5 (front) needs `$13EE6` bit 7.

## 5. Ship-completed notification and hit sounds [V]

When the yard finishes a ship (`$4060`, effect "launch") the original runs a loop at `$4128` that plays **four button-click sounds**, 11 frames
apart, while the yard flashes (port: `MapScene.playClicks`, `SFX.CLICK`, `LAUNCH_CLICKS = 4`, `CLICK_FRAMES = 11`). The launch sound (`$E1A2`) belongs
to the missile launcher (`EnemySystem.launchMissile`, `SFX.LAUNCH`), not to the yard. The hit sound on a weapon hit is hooked in `enemies.ts` at the four hit sites
(own fire, guns, kamikaze/bomb hits, missile hits).

## 6. Deviations and open points [H]

- Escape (or a right click) cancels a window without applying; the count entry can be cancelled with Escape.
- Positions and colours of the current-order text (100,105) and the number-entry width (2 digits at 176,125) are best guesses; the window button click
  sounds are not played.
- Whether ties between own tanks on equal distance follow array order or object-slot order of the original.
- Sprite entry origin (left edge, bottom row) and the frames-per-pass rate are unverified.
- After a pad is placed, the original keeps the ship in mode 4 even if the site is later demolished (the port the same).
