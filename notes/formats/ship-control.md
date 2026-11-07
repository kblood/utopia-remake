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

## 5b. Saved ship records (Disk.4 hydration; adoption in 5c)

`prepareDisk4ShipLoad()` / `ShipRoster.fromDisk4()` (`src/game/ship-roster.ts`) restore the 40 fixed ship slots: types 11..16 as `RestoredShip` and type 17 as a distinct `RestoredMissile`. The order bytes of
sections 2-3 are kept as stored in a typed detached extra record: `+$11` -> `extra.next`, `+$12` -> `extra.turn`, `+6/+7` -> signed `extra.vx/vy`; `+9` is the
whole mode (accepted range 0..8, no bit split off) and `+$E` the unsigned fuel word. Nothing is re-derived, no take-off/landing/launchpad logic runs, and map
marks, flags and counters are not touched. Missile (type 17) layout [V]: `$ACE2` does `move.l $C(a6),d2; andi.l #$FFFFFF,d2`, so the enemy-record address is bytes `+$D..+$F`; `+$C` is the saved target y and is masked away; it refreshes `+$B/+C` from the target `+1/+2` each day and destroys the missile when the target type byte is zero. There is no class or fuel for a missile. The decoder (`src/data/disk4-entities.ts`) therefore reports type 17 as `layout: "missile"` (`targetLong`, `targetAddress`, no `shipClass`/`fuel`) and every other type (free slots and undocumented types included, bytes as stored) as `layout: "ship"`. `RestoredMissile` keeps the raw long (`target.rawLong`), the masked address and a typed `target.ref { list, index, address, status }` resolved against the decoded fixed enemy slots by **exact slot start only**: air `$39E3A + i*$1A` (30 slots) directly followed by ground `$3A146 + i*$1A` (60); `$3A12C` (the ground scan base) is air slot 29. A free enemy slot is accepted with `status: "free"` (`$ACE2` destroys the missile on its next daily step; hydration itself does not, see 5c). Typed `missile-target` errors, with `reason`: `header` (air list header `$39E20..$39E39`), `misaligned` (inside a slot, not at its start), `out-of-range`; `enemy-slots` / `enemy-object` for bad enemy inputs. When called through `prepareDisk4ShipLoad()` the target also carries `enemy: Enemy | null` (the detached `EnemyRoster` object by reference, null for a free slot; list/slot/sourceAddress/type are checked); this is the save-time identity only, hydration reads and writes nothing of it, and the runtime binding in 5c is the slot, not this object. `+$14` is the per-cell flag-byte pointer for ordinary ships too (`$387E` -> `$497E`, see building-screens.md 3.6) and is kept raw as `flagPointer { semantics: "VERIFIED", raw, target, atOwnCell }`, classified by hydration but never written; the headless adoption in 5c requires a playable flag byte and uses it as the current reservation (`$4526` / `$4732`). Missile `+$10..+$12` are mapped by position (lift, next, turn); only lift is used by the traced `$4408`. Coverage is synthetic (`test/disk4-ships.mjs`, `test/disk4-entities.mjs`, `test/disk4-fleet.mjs`).

## 5c. Headless adoption and continuation of saved ships and missiles (synthetic tests only; the experimental scene consumes it)

`prepareDisk4HeadlessEnemies()` now returns one composed `EnemySystem` that adopts the detached `ShipRoster` into `sim.fleet` (`Fleet.adoptRestored`) together with the
`EnemyRoster`. The 40 fixed ship slots keep their indices, holes and exact object identity (`RestoredShip` / `RestoredMissile` are the live objects). Preparation and adoption perform no
`Fleet.createShip()`, no `extra()` defaults, no take-off/landing, counters, hooks, RNG, and no map/flag/state/object writes; everything is validated first and any failure is a typed
`EnemyAdoptError` (`ship-roster`, `ship-count`, `flag-pointer`, `unsupported-state` with reason `missile-mode` / `lift` / `crusher-counter` / `crusher-anim`) with nothing installed. The caller advances only
through `pass(clock)`; gun periods are consumed by `Sim.periodicPass()` (inside the headless `Sim.loopPass()`) and `frame()` is a legacy no-op. Test: `test/disk4-fleet.mjs` (the expected transitions there are written from the traces below, not from the implementation).

Static trace of the Disk.1 image (read-only, `tools/game_img.py`) [V as reading; the port's equivalence is synthetic only]:

- **Step `$4526`.** The pixel offset (+3/+4) is advanced by (+6,+7) (twice for type `$11`) and compared with the cell-edge table `$4C1A[dir]`. At a cell centre modes 5/6 return 0. A new cell step
  (`$4646`-`$465C`) clears the mark on the ship's own x/y cell, sets it on the next cell and stores that cell's flag-byte pointer in `+$14` (`$4660`); the new velocity comes from `$4BCA`.
  Leaving the map increments `$1427C + 4 * byte(+$D)` (for a missile the byte at `+$D` is the high byte of the target long: the port uses `s8(target.address >>> 16)`).
- **`+$14` is the current reservation cell.** Take-off `$4152` writes it from x/y; the destroy/leave paths `$4732` / `$46CC` release the cell named by `+$14`, not by x/y. Restore therefore seeds the
  `EnemySystem` extra `rx, ry` from the saved `+$14` (a playable flag byte; padding, zero, out-of-range pointers fail with `flag-pointer` before any mutation) and keeps the raw bytes
  (`sourceRaw`, `flagPointer`) unchanged. The extra `vx, vy, next, turn` come from `+6/+7`, `+$11`, `+$12`.
- **Missile main pass `$4408`** (since 5d the one step of every missile, launched or restored): mode 4 climbs 4 per pass to lift `$22`, then mode 1 with direction `$44DE` (6 when already on the target cell);
  mode 1 moves through `$4526`, on arrival reads the *pointed* enemy record: within 1 cell a ground target gives mode 2 / dir 3 / `+B = $FF` / target mode 5 (freeze), an air target is a hit at once;
  any other mode (2) lowers lift by 4 and destroys the missile at lift <= 0 (hit). There is **no** target-gone check and **no** `+B/+C` refresh in the main pass.
- **Daily `$ACE2`** loops over the `$1429E` count word: type byte 0 at the pointed record destroys the missile with an explosion (bit 5 of `$156A9`), without kill/lost counts;
  otherwise `+B/+C` are refreshed from the occupant's `+1/+2`. The port hooks this into `Fleet.dailyFuel` (`Fleet.setMissileDaily`, installed by the `EnemySystem` constructor so launched and restored missiles alike are covered); type `$11` stays out of the fuel burn and
  `weeklyRefuel` / `eventFuelBeam` skip every missile. Ship fuel burning in slot order is unchanged.
- **Target binding.** `target.ref` `{list, index, address}` is the authority. `EnemySystem` resolves the *current* occupant of that fixed enemy slot on every use (`occupant(slot)`), never a kept `Enemy`:
  if the saved enemy died and the slot was reused (`$48EC` / `$48B6` first-free allocation), the missile follows the new occupant exactly as the original's address-based pointer does. Nothing is inferred from coordinates.
  A target slot that is free at save time is accepted: the missile survives main passes and dies on the first daily `$ACE2`.

Rejected as unsupported (typed, before any mutation): crusher enemies with a counter above 7 or an animation above the table maximum (enemies.md 3a); missile modes other than 1, 2, 4; missile lift above `$7F`; a saved `$1429E` count that differs from the occupied-slot count; a ship `+$14`
that is not a playable flag byte; any duplicate / foreign / already adopted roster or non-empty fleet.

Restored ship landing (`$43BC-$4406`) is statically traced: mode 8 subtracts 2 lift per pass, rotates only while lift remains positive, then sets direction 8, mode 0, zero offsets/velocity, clears map AIR and sets OCCUPIED at the landing cell, sets own flag and clears ship flag, writes that cell's flag pointer to +$14, and subtracts 4 fuel when the signed fuel word is nonnegative (clamped at zero). `$43BC` loads transient map/flag pointers saved by `$41DA` at the accepted landing cell via `$1424C`; mode 8 does not move x/y, so the restored path derives the same cell pointers from saved coordinates. Synthetic coverage is in `test/disk4-fleet.mjs`; this is a static trace, not an emulator comparison.

Confidence limits [H]: stale bytes of freed enemy records are not modelled (the original would read them through the pointer, the port sees `null`);
the `$1237C` explosion on a daily destroy is inferred statically and the missile-hit explosion position is the existing shared port behaviour; the fresh port's `$44DE` equal-cell direction 0 vs the source's 6 is a pre-existing
deviation, since 5d fixed for every missile; whether original saves can contain the rejected states is unknown. Nothing here shows playable restore or original post-load initialization.

## 5d. One missile runtime for launched and restored missiles (static traces as in 5c; synthetic tests only)

Before this slice a missile made by `EnemySystem.launchMissile` was an ordinary `Ship` (type 17, fictitious class 6, fuel 0) that followed a kept `Enemy` object, re-aimed at every cell centre, vanished in the main pass when that object died, and was skipped by the daily step. None of that is in the traces; the two paths are now one:

- **Shape.** `MissileRecord` (`src/game/sim-ships.ts`: `kind: "missile"`, type 17, the shared `ShipCore` fields and nothing else; no `cls`, no `fuel`, no `target`). `RestoredMissile` extends it with the saved provenance only. `Fleet.createMissile(x, y)` (the `$49E8` / `$381E` creation: first free slot, `$1429E` + 1, no type count, no map write, no message `$C8`; null when the count word is 40 or no slot is free, and the launcher screen then says `$12B`) replaces `createShip(17)`, which now returns null. `isMissile()` selects the missile shape everywhere class/fuel would otherwise be read; `isRestoredMissile()` only tells provenance (checkpoint `kind`).
- **Identity [V as reading `$ACE2` / `$4408`; `$49E8` storing the same pointer is the symmetric reading, not separately re-traced in this slice].** The pointer in `+$C..+$F` is a fixed enemy slot, kept for every missile as `ShipExtra.targetSlot { air, index }` (`enemySlotAddress()` gives the 24-bit value, air `$39E3A + i*$1A`, ground `$3A146 + i*$1A`). `launchMissile` resolves it from the slot, never from coordinates: an explicit `target.enemy` is looked up in the slots at launch time (a dead one refuses the launch), without one the slot `findTarget` remembered is used (`$E904` is a pointer, so a slot reused after the search is followed). A free slot refuses the launch (the original would read the freed record's stale bytes, not modelled). `+B/+C` start as the occupant's `+1/+2`.
- **Step and daily.** The restored `$4408` step of 5c is the only step: no target-gone check and no `+B/+C` refresh in the main pass (a missile that arrives at a stale `+B/+C` farther than one cell from the pointed occupant just waits there until the daily refresh), the `$44DE` equal-cell direction is 6 for launched missiles too (it used to be 0), and `$ACE2` refreshes or destroys every missile (explosion at the missile, no message, no kill/lost/type count, no morale).
- **Reservation.** Launch sets the air mark and ship flag on the launcher cell and seeds `rx, ry` there (the `+$14` own-cell pointer `$497E`); `$4526` moves it, `$4732` / `$46CC` release the cell it names.
- **Departure `$4672`.** A missile that steps off the map increments `$1427C + 4 * byte(+$D)`; `byte(+$D)` is the top byte of the 24-bit slot address, 3, so both kinds use `$14288` [V for the restored reading]. The old launched path indexed by its fictitious class 6, i.e. `$14294` (the lost-units counter) itself. [H] The port's net effect on `$14294` is the existing reading that `$46CC` skips its whole statistics block for type 17 while `$4672` decrements `$14294` unconditionally (net -1); these notes record no trace of that block's exact branch, so it is shared by both kinds and not claimed as fact. A launched missile cannot leave the map by pursuit, so this is exercised only by forcing a cell off the map in the test.
- **Not changed / unsupported.** Missiles still need an `EnemySystem`; stale bytes of freed enemy records are not modelled; the launch direction (0) and `hp` / `tech` initialisation are hypotheses carried over from the old `createShip` path; original post-load behaviour of restored missiles is untested against the running game. The static recheck of this slice was against these notes and the existing code, not a fresh disassembly pass. Test: `test/missile-runtime.mjs` runs a launched and a restored missile in lockstep (record, extra, map words, flags, state image, explosions, enemy slots) for ground target, air target, equal-cell, stale/refreshed target and departure, plus slot reuse with a decoy, daily refresh next to ordinary ships, reservation release by `+$14`, and the counters.

## 6. Deviations and open points [H]

- Escape (or a right click) cancels a window without applying; the count entry can be cancelled with Escape.
- Positions and colours of the current-order text (100,105) and the number-entry width (2 digits at 176,125) are best guesses; the window button click
  sounds are not played.
- Whether ties between own tanks on equal distance follow array order or object-slot order of the original.
- Sprite entry origin (left edge, bottom row) and the frames-per-pass rate are unverified.
- After a pad is placed, the original keeps the ship in mode 4 even if the site is later demolished (the port the same).
