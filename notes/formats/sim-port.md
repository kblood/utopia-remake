# Simulation port (src/game/sim.ts) - status and findings

Code: `src/game/sim.ts` (class `Sim`), `src/game/sim-math.ts` (68000 arithmetic helpers, injectable RNG), `src/game/sim-tables.ts`
(constant tables copied from the game image, source addresses in comments). Checks: `npm run build && npm test` (`test/sim.mjs`).
All addresses refer to the game image (Disk.1 sectors $14C-$208 at $1000). No game text; message strings are exposed as index numbers
(`Sim.messages`), modal announcements and Earth offers as `Sim.events`.

Tags: **VERIFIED** = ported line by line from the disassembly (register widths, byte/word compares and quirks kept; behaviour checked only by
most routines have synthetic or plausibility checks, while original-run comparisons are bounded and described in their sections). **NOT PORTED** = skipped on purpose.

## Driver

- The map scene drives `Sim.countFrame()` once per video update (VBL: `$14590`, frozen by pause, an offer, or the build-menu modal bit; expiry queues a day). On a normal pass (4 video updates by default; `map-rendering.md` section 6 "Main-loop timing"), `ObjectLayer.update()` advances own units, ships, enemy ground/air and effects; `Sim.pass()` advances alien frame, meteor countdown and spawner `$1187C`; then `animateCells()` models the caller's `$6936` scan. The gate is captured and the scene draws into the alternate persistent bitmap; intervening video updates retain the displayed pixels. The queued day tick runs between money and date drawing (`$4D1C` calls `$564A` before drawing the date, while money `$4D48` is drawn before it); this calendar step is not pause-gated, but `$99C4` periodic work is, so its period bits remain pending until resume. After the VBL wait, `Sim.runAfterVblWait()` mirrors `$99C4`, and the input poll follows. This matches the static outer-loop order; the browser groups that wait at a configured pass boundary and uses a fixed default cadence, so frame timing is still approximate. `Sim.periodicPass()` is the combined headless date-plus-worker form; `Sim.loopPass()` calls `pass()` then `periodicPass()` and is not used by `MapScene`. The draw sort between the meteor and spawner is performed in the renderer, not simulated.
  Gun A is latched by the VBL handler when the post-decrement countdown equals `$2D` and fires when `$99C4` consumes `$144C1` bit 4; gun B fires in the daily branch before `$ACE2` (static Disk.1 trace). One bounded, RAM-staged live Gun A cycle was observed (latch every 90 video updates at `$14590 = $2D`, timer 3,2,1,0,3, kill on the fifth round) and matches the port; the effect-dependent map-mark behavior on the kill is implemented from the static `$4732`/`$1237C` path and that capture. Gun B and any natural game state are not compared (`enemies.md` section 6).
- `Sim.tick()` performs one VBL followed by one main-loop pass for headless callers; the map scene does not use it. `run()` mirrors `$99C4`: it consumes the pending bits of `$144C1` in the original order
  (special, daily, weekly, monthly, yearly) and does nothing while `paused` ($156A9 bit 2) or after game over. `monthly()` is public for tests.
- RNG: `$2DCA/$2DCC` (d2 = range, result 0..d2-1) is replaced by `Rng = (range) => number`; `createRng(seed)` is a seeded mulberry32. The original routine's arithmetic exists separately as an isolated model (`src/game/original-rng.ts`, see "Original RNG routine model"); it is not the Sim's generator. Pass
  `new Sim(world, { rng })`. The Earth dialogs (`$DECC`) are the `decide(offer)` callback (true = first button; default false).
- `$156AA` system flags live in `Sim.sysFlags` (`SYS`): bit0 is cleared from the `$866E` initialization value by ordinary game-start routine `$80A6` (its runtime meaning is not mapped); bit2 no-unit-bonus, bit3 game over, bit4/5 QoL 80/90 announced, bit6 eclipse,
  bit7 Tutorial mode (set by `$8114`; blocks daily events and eclipses, modifies QoL).
- `$14432` (goods weight capacity) is not set by `World`; the `Sim` constructor copies `world.warehouseCapacity` into it when it is 0.
  A world made by `World.fromSnapshot` (Disk.4 restore foundation, game-proper.md section 6) keeps `warehouseCapacity` at 0, so the saved word stays.
- `World.objectCount` (the JS field) is the record count at world creation (or the saved `$142C2` word after a snapshot restore) and is NOT kept current by placement, completion or demolition; it is also what version-5 native saves store.
  The live `$142C2` count is the GAME STATE word (`OBJECT_COUNT_ADDRESS`), which placement/demolition (`build.ts`, building screens) do update and the Sim and checkpoints read. Test fixtures that add records by hand bump the field themselves.
  Used records are not a dense prefix. Yard, mine, command-centre and window scans iterate all `OBJECT_SLOTS` (tile word 0 = free); do not bound those scans by either count. Coordinate-based building lookup is different: `$72C0` uses `$142C2 - 1` as a DBRA budget over non-empty records, so the remake's `Builder.findObject` and building-screen `findRecord` now stop after that many occupied records.

## Ported, in the order of $99C4

| Routine | Source | Notes |
|---|---|---|
| daily: QoL on day 1, game over, event slot | `$99C4`, `$A8E8`, `$B086`, `$10E1E` | VERIFIED |
| weekly: eclipse countdown, `$144B2` | `$10FCA` | VERIFIED for the countdown, messages `$DD`/`$DE`, the tutorial gate and the date test (raw `$1459F` = 21, `$145A0` = 11: the calendar month is 0-based, so 21 December). Scratch probe 2026-11-13 (outside the repo): start pass, three decrements, `$DE` on the fourth weekly pass; no start on other dates or in tutorial mode. No repo test covers it. **The `$11024` descriptor swap is a stored parity of the traced calls** (2026-11-13, handoff `HANDOFF-2026-11-13-eclipse-parity.md`): `Sim.tileExchange` toggles at the weekly start and end, event 14, the disk-menu entry while bit 6 is set and the disk-menu exit while `$144BB` is nonzero. `src/game/eclipse-tiles.ts` exchanges the data addresses of descriptors 4/51 and 50/54 while the parity is set; `MapScene.syncTileView` applies it before each draw. VERIFIED (static): every traced call toggles the table and no reset rebuilds it; bit 6 alone is not the state (the menu entry and the new-game reset break it). Saved in version 11. Visible effect not observed. Covered by `test/eclipse-tiles.mjs` and `test/eclipse-parity.mjs` (synthetic and real-loader checks; no original comparison). See game-state.md 5.1 item 3. |
| monthly warning bit hook | `$99C4` / `$9B06` | VERIFIED. `$144B1` bit0 (set by the UI, `$C486`) gives message 98 and morale +500 |
| trade income, supply/demand, market walk | `$A86A`, `$A784`, `$A802`, `$A7AE` | VERIFIED, see below |
| farm workers | `$9E3A` | VERIFIED. Uses the active counts (+$A) of T[18]/T[19]; T[19] is filled first |
| food | `$9E98` | VERIFIED. No production at power level >= 18; message 109 on overflow |
| housing / overcrowding | `$9DBA` | VERIFIED. No housing building = flag, 80% death term, message 99 |
| air | `$9CDA` | VERIFIED. No production at power level >= 20; storage quirk below |
| births and deaths | `$9BAE`, `$9C80` | VERIFIED. Correction to game-state.md 5.2, see below |
| tax, grant, statistics copy | `$A010` | VERIFIED. Income = pop * tax (+ grant, minus 100 per month, message 101 at 0) |
| power | `$A0D4` | VERIFIED, with the 21-entry priority table `$B100` |
| Command Centre offline/online | `$A1C2`, `$9B52` | VERIFIED. Level >= 14 clears record byte +3 and T[29].C, message 300 |
| job allocation | `$9F36`, `$9F4A`, pool table `$B0C4` | VERIFIED. See "caps" below |
| morale | `$A246`, `$A270` | VERIFIED. Tables `$B178` |
| crime level | `$10BC8` | VERIFIED (formula was H in game-state.md, now read from code) |
| production | `$A360`, `$A4A8`, `$A51A`, `$A2DE`, `$A32C` | VERIFIED. Weights `$B0EC` |
| quality of life | `$A8E8` | VERIFIED. Tables `$B1A2`, pollution decay, announcements 2/3 |
| yearly: statistics, tax change | `$A096` + register copy in `$99C4` | VERIFIED. Tax rise applies a positive morale change (original quirk kept) |
| game over | `$B086` | VERIFIED. Sets `SYS.gameOver`, event `{announce, id 1}`; then `jmp $157AE` (disk menu): the rest of the daily pass is skipped (`Sim.daily` returns after `checkGameOver`). game-proper.md, "Game over" |
| events 0, 2, 6, 7, 10, 14, 16, 18, 19 | `$110FE`, `$1135A`, `$10F5E`, `$10F8E`, `$111A6`, `$11058`, `$113FA`, `$10ED2`, `$10C72` | VERIFIED handlers; 19 only up to crime 50 |

### Findings that differ from, or add to, game-state.md

- **Births** (`$9BAE`): the roll is `rand(d)` with d = difficulty byte ($14 or $1E), plus a band: 0 for $14, $1E for $1E, $3C otherwise. Difficulty 0
  means no births. births = ((((pop*10+500)/1000) * rate) + 5) / 10. Death percent = 1 + $144B4 + $144B5 + $144B9, +1 if pop/20 > medics, +1 if that
  exceeds 10, +1 if it exceeds 30; if >= 20 morale gets -20*percent; the overcrowding value $144C5 is a floor. `$9C80` removes percent of the free
  colonists and of each pool; a fraction below one colonist is decided by `remainder >= rand(100)` (kills one). The roll range is 100 (`$9CB0` calls `$2DCA` = `moveq #100,d2`; every `$9CB6` draw in the 01/11/2090 capture has range 100); an earlier port rolled `percent`, which killed a colonist for every fraction (fixed, see "Monthly RNG tape").
- **Power**: type that cannot be powered at position k (0-based) of the table gives level 21-k. Stored power ($131F0, T[0].E) is wiped when the level is >= 2
  and not touched when it is 1. Solar output (T[11]/T[12] .E * count) is 0 during an eclipse; the power station (T[31]) always counts.
- **Job caps**: `$14500[pool]` is the staffing level the player chooses. `$866E` zeroes it, so without player action nobody is ever employed
  (shortage = min(required, cap) - assigned). `Sim.setJobCap(pool, n)`. Each month a fifth of the free colonists (+1) is available.
- **Fuel/air storage quirk (original behaviour, kept)**: when the stock does not fit the first type, `$A51A` and `$9CDA` store a flat 800 / 1200 (fuel) and
  one building's `$13104` (air) in the first type, not count * capacity; when everything fits the first type the second type's stored word is left unchanged.
- **Trade**: the six commodities are slot 0 = fuel (`$14342`, mirrored to `$1314E`) and goods 0..4 (`$13152..`). Tradable units = stock - retain% of stock
  (`$144CC`, default 100% = nothing sold). A monthly roll (`>50`) turns each commodity's supply into demand; sales are limited by demand and paid at the
  market price (entries at `$1316A`, 10 bytes: value, min, max, step, countdown). No trade income in the very first month (`$144C2` bit0), none while the trade
  computer is down ($144BA).
- **Byte compares**: several tests are `cmpi.b` on values that can exceed 127 and are kept as in the code (QoL crime term capped by a signed-byte
  compare, crime message thresholds 20/50, `$A8E8` announcements). The power term of QoL ($144C8) is added to a6 and has no effect (original bug).
- Morale is not clamped by the code. `$A246` uses signed-word arithmetic for `100 - trunc(|m|/100)` and for the caller's `d0`, multiplies those words, divides by 100 with truncation toward zero, then adds the sign-extended result to the signed long. The factor reaches zero at the nominal +/-10000 points, but can change sign outside that region; no general ordinary-play bound is established. See the exact trace and RNG consequences in `original-rng-callers.md` §6.3.

## Not ported

| Routine | Reason |
|---|---|
| `$15xxx` redraw flags | the map is now drawn once per scheduled pass; exact machine-dependent redraw cadence is not reproduced |
| sound calls | out of scope |

Ported since the first version of this table: the enemy/combat side (`enemies.ts`, notes/formats/enemies.md: enemy units, attacks, own fire, guns `$11D34`, ships, missiles, defect/repair hooks), the construction countdown `$7000`/`$703A` (`src/game/construction.ts`), the Command Centre
redraw `$7342`, the warning lights and view bookmark, the message log timers, and the power gate of the tile animation (section below).

## Construction, lights, message timers (`construction.ts`, `sim-alerts.ts`, `messages.ts`, `map.ts`)

- **Placement `$6BF4`** (`Builder.place`): the type's worker count moves from the free colonists `$13136` to the builders `$1432A` **before** the money test
  (original quirk, kept: a failed purchase for lack of money leaves the workers in `$1432A`; message `$25`, then select mode via `$15EF0`). On success the
  cost is paid, `$6FC4` writes the scaffold tile `$32` (flag byte of tile `$32` from `$16408`, bits `$E800` of the old cell preserved) into 1 or 4 cells,
  the record gets word `$32`, +2 = target tile, +6 = type build weeks, and `$142C4` (site count) is raised.
- **Weekly `$7000`** (first step of the weekly branch): loops `$142C4` times over the records whose word is `$32`; byte +6 is decremented, at 0 the site is
  completed (`$703A`) and `$142C4` lowered. The site count bounds the loop; the original scan has no end bound, the port stops at the end of the list.
  The week count is therefore the type's weeks byte (type +2): the scaffold shows for weeks-1 weekly passes, the building appears on the pass number weeks.
  With 90 frames per day and 7 days per week one week = 630 frames.
- **Completion `$703A`**: record word := target tile, +2 := type +1 (footprint), +3 := type +3, workers go from `$1432A` back to `$13136`, type active (+A) ++,
  total (+C) ++ except a non-first Command Centre (tile `$4C` with active > 1: tile becomes `$50`, +3 stays, not counted; the first one gets +3 = `$FF`),
  warehouse `$44`: `$14432` += 80000, +6/+7 cleared; mine `$60`: +6 = number of the 9 cells with flag `$8000` (`$75D4`); fuel `$3E`: same with `$0800`;
  solar tiles `$0F`/`$1F`: +2 = 0, +6 = 1 or `$FF` from the beam position bit (`$2E00`), +7 = 0. The remake approximates that bit with the World-owned seeded solar-phase stream; it was added to native save version 4 and is retained by version 5, separately from Sim RNG, but does not claim the original's beam timing. Finally `$6A8C` writes tile+n into the cells
  (footprint byte 1 = one cell, else 2 x 2: tile, +1 right, +2 below, +3 diagonal; flag byte from the first tile). **No completion message is posted.**
- **Command Centre redraw `$7342`**: after the online/offline change by `$A1EA` (power failure) / `$9B8C` (recovery) the record's cells are rewritten with
  `$4C` (byte +3 = `$FF`) or `$50`. `Sim` option `centreChanged(slot)` is wired to `Construction.redrawCentre` in `map.ts`.
- **Warning lights `$5D30`** (table `$15628`, 16 bytes per light: image pointer at +4, x/y words at +8/+10 = 16x16 at (0|16|32|48, 139), flag byte at `$15634` +
  16k, toggle byte +`$D`): power (set `$A19C`, cleared `$A0D4`), bookmark (`$11432`), food (`$9F0E` set / `$9E9E` clear), air (`$9D9C` / `$9CE0`). An unlit light is
  skipped; a lit one is drawn on every second frame. Icons: 5 planes, 16 x 16, unmasked, at the pointer in the table (`readLightIcons`).
- **View bookmark**: `$11432` (the "focus" effect) does not scroll and writes no view word (`$144E4`/`$144E6`). It stores x-4, y-4 (each clamped to 0..`$5C` / 0..`$43`, signed word compares) at
  `$144E8`/`$144EA`, lights the second light (`$15644`) and sets the countdown `$144BD` to 6. VERIFIED (static Disk.1 disassembly, 2026-11-10): the five direct callers are event 4 `$110E6` (mine, before message `$DF`), event 8 `$11650` (meteor, before `$182`), event 12 `$113E4` (ship, before `$46CC` / `$109`), event 17 `$115E6` (tank, before `$181`) and event 19 `$10D6C` (arson, after `$12332`, before `$119`), each with that event's own cell. Events 4 and 19 were missing from the port until 2026-11-10 and now emit the focus; 8, 12 and 17 were already ported. No event-path code writes the view: a static recursive walk from the dispatcher and the 20 handler entries reaches `$11432` but not `$FB1E` (the clamped view setter, used by the map loop), the map input loop `$F208` (`$F2E0` placement), `$15A28` (arrow scroll, called from `$15966` / `$15F5E`), the bookmark swap `$159E8`, or the start-view initialiser at `$86A0` (writes `$144E4 = $2F`, `$144E6 = $21`). The remake's focus therefore moves nothing; `test/event-focus.mjs` checks that a live `MapScene` keeps its view through defections at edge cells, and that scrolling and the bookmark click still work. Only static evidence: no original run has compared these view words during an event. The daily pass (`$144BD`, between `$B086` and `$15698`) does `subq.b #1`; once
  the byte goes negative the counter is cleared and the light turns off (seven days of light). A click inside the rect x `$10-$1F`, y `$8B-$9B` (`$5D70`, handler
  `$159CE`) swaps the current view origin with the bookmark, so a second click returns.
- **Message log `$5A8C` / `$15698`**: the panel holds three entries, each with a protect counter set to 10 (days) when added; the daily pass decrements them.
  A new entry on a full panel scrolls the oldest out; if the oldest is still protected the panel is wiped instead (new one alone). Survivors of a scroll or wipe
  have their protect cleared. The idle timer `$14634` = 500 frames empties the panel. `Messages.dayPassed()` is called from `Sim` (`onDay`).
- **`$6936` animation**: tile ids 6..13 animate only while the power level `$144C8` is below 4.
- Tests: `test/construction.mjs` (both footprints, order of two sites, count bound, Command Centre / warehouse / mine / fuel / solar completion, funds quirk,
  frame-driven weeks, Command Centre redraw through power failure and recovery, lights, bookmark, message protect counters).
- Hypotheses: icon order is power / bookmark / food / air from the set and clear sites; the 25 Hz blink on the Amiga comes from the double-buffered toggle;
  the funds quirk is genuine original behaviour (the `$6BF4` code subtracts before comparing); `$15EF0` = back to select mode.

## Test results (npm test, scenario 0 and all ten starting states)

Date chain (336 days, 48 weeks, first month roll 01/07/2090), month income = pop*tax + grant (pop 104 after births: 6040), no shortage at the start of any
scenario, shortage paths (food, air), job conservation, staffed workshop production and weight bookkeeping, game over, five years without player action
(survives, QoL 41..55, morale -5845..8016, money integer, nothing non-finite), determinism with a seed.

## Research (`$AB0C`, ported as `Sim.research()`)

Runs monthly after production. Skipped when the power byte `$144C8` is 7 or more; without a command
centre (`$133F8` = 0) it only posts message `$EF`. Price = 25 + 10 x technology level (`$14592`).
Progress `$142DE` gains the scientist count (`$13142`) plus the spend of fund `$142D2` divided by the
price and half of the spend of fund `$142D6` divided by the price (the same half also feeds
`$142DA`). Reaching the per-level threshold (table `$B154`) raises the level (capped at 10), ORs the
level's invention bits (`$B214`) into the queue `$14476` (`$1135A` then announces them one by one into `$14472`), clears `$144C7`, and rewrites the scale bytes
`$145A3..$145A9` from tables `$12D56` / `$B251`. Test: `test/sim.mjs`.

## Tank yard (`$A620`, static code ported as `Sim.tankYard()`; one observed original production-to-movement run, not full parity)

Monthly after production. Workers per yard = `$143FA` (job pool 4) / yard count (`$1337A`). Each
record with tile `$45` has a counter in byte +6: it takes good 1 until the counter reaches 20
(message `$96` when the stock is empty), then 2 of good 3 (`$94`), sets the counter to `$FF`, then
searches the eight neighbour cells through `SimOptions.yardExit(x, y)` (`UnitSystem.yardExit`, order and bit-12/14 test
as in units.md section 4). No free neighbour: message `$95`, the counter keeps `$FF` and the retry happens next month.
A free exit (static `$A756`, VERIFIED against Disk.1 2026-11-10): the counter is cleared and `$143B6` is counted
BEFORE the call to `$37CA`; then `SimOptions.spawnUnit(x, y, advanced)` places the unit (`UnitSystem.spawnAt`) and
`$37CA` fails with message `$8F` only when `$1429C` is 99 (the port's pre-2026-11-10 order showed `$8F` before the
neighbour search and did not count `$143B6` for a full list, which changed the counter and the message; fixed).
On success `$1429C` and the type count (`$14254`/`$14258`) rise by one.
Test: `test/sim.mjs` (`tankYard()` alone, `spawnUnit` and `yardExit` are stubs there; the full-list cases check the `$95`/`$8F` split, the counter and `$143B6`; `test/units.mjs` checks `yardExit` and `spawnAt`). `test/tank-lifecycle.mjs` runs the same step
unstubbed inside a real `MapScene` (the monthly period bit consumed by `Sim.periodicPass()` -> `run()` -> `monthly()`; `spawnUnit` is the scene's
own `UnitSystem.spawnAtYard()`) and follows the tank on: two months of production (progress 10, then 20 + 2 good 3, counter
restart), the spawn on the first free exit of the documented order, the `$1429C` / type-count / `$143B6` bookkeeping, a pin set
through the scene's marker button and cell click, the right-click pick, the real tank window (pin icon click, exit button) ordering
the tank, and movement to arrival under the scene's passes with the occupancy bits following the tank. Further cases: all eight exits
unusable (message `$95`, counter stays `$FF`, no goods spent on the retry, the last exit `(-1,-1)` used once it is free) and invention
bit 2 (type 10 on exit 0, `$14258`). Staging: one hand-built yard record and map cell on a free area, stocks, power 0, a command
centre word, and the staffing choice `$14510` (pool 4 cap) = 10; without that cap the monthly job pass `$9F4A` ported in
`Sim.allocateJobs()` releases the hand-set pool. The month's births/deaths step removes one pool-4 worker from the staged 10 and the
job pass refills it from the free colonists, which depends on the scene's fixed default random seed (the test pins the end value,
progress 10 per month, not that sequence). This is a connected regression of the remake's own ported rules, not an emulator
comparison.

Unit bookkeeping (`$37CA`, `$4692`): a new unit raises `$1429C` (cap 99, message `$8F`) and the type count
`$14254` (type 9) / `$14258` (type 10); destroying one lowers them, raises `$14294` and costs 50 morale.

### Observed original production, order, and movement (Copperline 1.0.1, 2026-11-06)

This was a fresh WHDLoad 1.2 (0757) scenario run in a disposable copy, A1200/68020/AGA PAL, 1536 KiB chip + 4 MiB fast.
The game files were unchanged and no game save or Disk.4 load was used. This is one observed sequence, not a controlled
state-by-state remake comparison. Captures and scripts remain outside the repository under the user's temp directory.

- The starting ore stock was 10. A mine was placed at (50,51), whose 3x3 area had nine ore-flagged cells; its completed
  record +6 was 9. A tank yard was placed at (48,49). Both staffing caps were set to 10; at 01/09 each pool had 9 workers
  assigned. The mine and yard were completed by 23/08.
- At monthly boundaries: 01/09, yard progress +6 = 9, ore 10→41, good 3 = 4; 01/10, progress = 19, ore = 76, good 3 = 4;
  01/11, a tank spawned, progress reset to 0, ore = 77, and good 3 fell 4→2. At that spawn `$1429C/$14254/$143B6` were
  1/1/1.
- The detailed November endpoint captures are `cap_008_nov_pre_28-10-2090_f23029` (frame 23029) and
  `cap_009_nov_post_01-11-2090` (frame 23034), both at PC `$157BC`; the pair is five video frames apart and `$144C9`
  advances 1→2. Across those endpoints, population is 114→118 (births 5, deaths 1), free colonists 74→78, money
  512,780→518,560 GR, and the grant 4,600→4,500 GR. Tax income is 1,180 GR and grant income 4,600 GR, matching the
  5,780 GR net increase. Captured production counters include `$143AE/$1435E` = 2 ore added, `$14436` = 3 good-2
  production, `$14372` = 1 previous-month ore consumption, `$1437A` = 0 and cumulative `$143A2` = 20. The observed
  five stock values were `[476,76,1,4,0]`→`[562,77,4,2,0]`; stored weight `$13166` was 70,801→75,800 with capacity
  80,000. The summed stock weights in the latter capture give 75,604, so the stored weight is 196 kg above the stock. That gap is the capacity-overflow remainder of `$A2DE` (game-state.md 5.17, checked 2026-11-10 by reading the disassembly): an add that overflows stores the leftover kilograms, so the stored weight reaches 80,000 while the stock gains only whole units. For example, one order that fits the production endpoint is an ore add (200 kg per unit) with 596 kg left: 2 units are stored and 196 kg stay in the stored weight; the later removals subtract whole units only. The RNG-tape November capture shows the same signature (stored 75,800 over a summed 75,701, a 99 kg remainder from a 100 kg good), and the optional `test/production-original-compare.mjs` matches its stored weight and stock exactly. The production capture's event order is not recorded, so its 196 kg is consistent with the rule rather than traced; `test/goods-capacity.mjs` pins the arithmetic of both endpoints.
  These are endpoint observations, not a complete monthly RNG tape or a deterministic remake comparison.
- The new type-9 tank was in slot 0 at (48,48), HP 10, tech 1, control +9 = `$FF`, no target, reservation pointer `$3E6F6`.
  That matches yard exit 0 (0,-1) relative to the yard at (48,49); both the map word and flag byte marked occupancy.
- Marker key 1 set pin 1 at (52,49) without changing map or flag bits. Right-clicking the tank opened its order window;
  pin 1 followed by exit set +B/+C to (52,49). No movement occurred when the order was issued.
- The path (48,48)→(49,49)→(50,49)→(51,49)→(52,49) used directions 3,2,2,2 and eight passes per cell. At every cell
  transition the old map/flag occupancy cleared, the new cell became occupied, and +$14 followed that reservation. On
  arrival +B became `$FF` and +6/+7 zeroed in the same pass. This agrees with the statically ported movement transitions
  for the captured route. `test/tank-original-compare.mjs` (optional, `UTOPIA_TANK_TRACE_DIR`) stages a live scene with the remake's
  own yard exit, pin and order and compares it with these captured RAM slices at the post-order baseline and passes 6/14/22/30/38
  (tank fields, reservation pointer, `$144C9`, map bit 14, flag bytes, pin; details in runtime-checkpoints.md section 6): after the
  arrival fix (`+C` is not cleared) no divergence. `test/tank-lifecycle.mjs` stays a synthetic, remake-only regression.
- Passes were five VBLs apart throughout this movement capture. While the tank window was open, passes and `$14590` froze;
  over 97 frames between the spawn capture and the first capture after closing it, the countdown decreased by five.

The first move began seven passes after the spawn capture (`$144C9` = 2 there, 3 at the post-order baseline); the value at the
moment of creation was not recorded. The captured counters show the first direction choice on the pass where `$144C9` wraps to 0,
which the remake's `9 - k` rule reproduces from the baseline value. Resource output and ore reaching 77 near the 80,000
weight capacity were observed, but the storage-cap explanation is an interpretation, not a confirmed message/code trace.
This run covers one scenario and one 5-VBL cadence only; it did not exercise blocked movement, groups, or combat.

## Monthly RNG tape and the 01/11/2090 production comparison (Copperline 1.0.1, 2026-11-06, a second, separate run)

Evidence: one fresh WHDLoad 1.2 (0757) scenario-0 run (mine (50,51), yard (48,49), staffing caps 10, A1200/68020/AGA PAL), captured by the player outside the repository (never copied, hashed or stored here): an RNG call tape (per call: return address, D2 range, result, seed before/after, frame) and two RAM snapshots, pre (28/10/2090, pass 560, frame 23709, `$14590` = 4, `$144C9` = 7) and post (01/11/2090, pass 561, frame 23716, `$14590` = 87, `$144C9` = 8). This is NOT the run summarised above (that one had ore 77 and different money/population at 01/11); the two are not mixed. (The task brief quoted `$144C9` = 1 for the pre snapshot; the capture itself holds 7, in the `$144C9` segment and inside the state image.)

Observed (tape rows 21..50 = the 30 calls of the transition; October rows and the reconstructed row 0 are not used): market walk 5 pairs (roll(4) from `$A7C0`, then roll(max-min) from `$A7D2`, ranges 19/9/100/200/100), six range-100 supply/demand coins (`$A854`), one birth roll range 30 (`$9BD2`), two range-100 death-fraction rolls (`$9CB6`), one crime roll range 20 (`$10BEE`), ten range-100 miner rolls (`$A3FE`). The tank yard step draws nothing. An independent model of the original matches all 50 calls; a forward replay from the tape reproduces the 30 November calls. Post vs pre: good 3 4 to 2, ore 76 to 75, one type-9 tank in slot 0 at (48,48) (hp 10, tech 1, control `$FF`, reservation `$3E6F6`), `$1429C` / `$14254` / `$143B6` 0 to 1, yard record +6 19 to 0, money 512690 to 518430, population 112 to 114; map word (48,48) gains bit 14 and flag byte (48,48) becomes 4. Crime cross-check: `$142A6` is 0 in both snapshots and the captured crime -26 equals `100 - ((q+100)>>1) - (16-8-2) - (5 - year) * 8` with q = 60 (post morale 6082) and elapsed year 0.

Capture coverage: the whole state image `$13034..$14633`, all 1000 object records (`$3B466..$3D3A6`), the entity lists and tank list `$39D42..$3B466` (empty in the pre snapshot apart from 8 non-zero bytes of the effects-list header at `$39D42`), `$156A8..$156AB` and `$144C9`. Map words cover only row 39 col 22 through row 59 col 81, flag bytes only rows 40..60; the mine neighbourhood, the yard and its exit ring lie inside both. In the pre snapshot the covered map equals the Disk.2 start map except at the two player-built cells (48,49) and (50,51), and the covered flag bytes are all 0.

`test/production-original-compare.mjs` (optional; `npm test` skips it without `UTOPIA_PRODUCTION_TRACE_DIR`) requires the local capture directory or its parent with `out/`, containing `rng-calls.json|csv`, `state_pre_nov_*.json`, `state_post_nov_*.json`, `rng-tape-seg2.jsonl`, and local Disk.1/Disk.2. It builds a real MapScene on the scenario-0 map and seeds it from the pre snapshot only where the capture covers the data: state image, all object records, covered map/flag cells, `$156AA` (capture `$84`, ordinary-play Sim default `$00`) and `$144C9`; other map rows keep the Disk.2 start map (premise check: the test fails if covered cells differ from the start map away from player-built records). It calls `scene.update()` until the day timer runs out, so `Sim.periodicPass()` -> `run()` -> `monthly()` -> `tankYard()` -> `UnitSystem.spawnAtYard()` run unmodified; no result field is patched. Only the random source is replaced: a test adapter labels each draw by the calling Sim method and checks it and its range against the next tape row; the returned result is then COMPUTED by the isolated `$2DCC` model (`src/game/original-rng.ts`, next subsection) from the row's recorded caller D0, recorded TOD byte, the remake's range and the model's own chained seed, and verified against the row's recorded seed and result (a mismatch is its own comparator group). Recorded D0/TOD/seed are capture inputs, not patched results; after the first mismatch the tape is no longer applied. At the pass-end checkpoint it compares call order/site/range, stock and weight, jobs/population/economy, yard progress and all 1000 object records, tank slots, counters, covered map/flag cells, and every other state-image byte. It then continues the same scene, without reseeding, across the four captured full pass snapshots at frames 23716/20/25/30 and checks special-sprite bytes at each aligned `$144C9` boundary. Excluded: `$14590`, the computed date string `$14594..`, map/flags outside the captured slices, padding columns, tank-list/effects-list headers, screen/sound/messages and draw timing. The snapshots confirm `$144A4` phases 5/6/7/8 with alien `+$5` frames 3/2/3/2. `$144A5` is the low byte of `$144A4`, not meteor `+$9`; the meteor record ends at `$144A3`. Only call order, site and range are compared for RNG because absolute values depend on CIA TOD and frame timing.

An earlier comparison matched the 30-draw tape sequence/site/range, stock and weight, jobs/population/economy, all 1000 object records and yard progress, tank slots, counters, and covered map/flag cells, but differed at `$144A5` (`$05` vs `$04`) and `$144AD` (`$03` vs `$02`). A static trace resolves both: `$35DC..$35EC` in `$333A` increments word `$144A4` once per pass while `$144A8` is active and pause bit 2 of `$156A9` is clear; low-byte 11 wraps to zero. `$35F2/$35F8` uses the new index to copy table `$11718` into alien `+$5` (`$144AD`). Table bytes are `00 01 02 03 02 03 02 03 02 01 00`. `$144A5` is the low byte of the animation word, not meteor `+$9`; the meteor record is `$1449C..$144A3`. The four saved pass snapshots corroborate phases 5/6/7/8 and frames 3/2/3/2.

The runtime hydrates the alien from the captured state before constructing the live scene. The explicit capture-enabled comparison passed on 2026-11-06 and was rerun against the current worktree on 2026-11-07; both runs had zero divergences in all groups: RNG calls (31 fields), stock/weight (15), jobs/population/economy (52), yard/object records (8001), tank slots (115), counters (4), covered map/flags (6220), residual state image (5361), and special-sprite state at frames 23716, 23720, 23725 and 23730 (19 fields each). The staging bug found during the earlier verification was that the comparator constructed `MapScene` before restoring captured state, leaving the runtime alien handle null; the comparator now seeds first and constructs afterward. The default `npm test` skips this capture comparator when its variable is unset. The death-fraction fix is source-supported by `$9CB0` calling `$2DCA` with `moveq #100,d2` and by the captured `$9CB6` ranges; `test/sim.mjs` has a synthetic regression. This result covers one month plus three later passes in one scenario, not other months, scenarios, seeds or weekly/yearly steps.

Resolved from the new-game initializer `$866E`, date chain `$564A`, and capture: `$142A6` is elapsed years, cleared to zero at new game and incremented on each January rollover; the displayed year begins at 2090 and `$14594` is incremented independently. A remake-started game now uses that elapsed value in the original's early-crime bonus and meteor gate while `GameState.dateText()` and save-slot summaries display `2090 + $142A6`. Version-2 and version-less remake saves convert their previous absolute-year value to elapsed years on read; versions 3 and 4 store elapsed years. `test/sim.mjs`, `test/aliens.mjs`, `test/checkpoint.mjs` and `test/save.mjs` cover the semantics and migration.

### Original RNG routine model (`src/game/original-rng.ts`, `test/original-rng.mjs`)

Pure functions `originalRngStep({ d0, range, tod, seed })` (`$2DCC`), `originalRngStep100` (`$2DCA`: `moveq #100,D2` then `$2DCC`) and the seed holder `OriginalRngModel`. Static routine (VERIFIED from the disassembly given for this slice; arithmetic below also VERIFIED against the capture): saves D0/D1/D3; `move.b $BFE801,D0` replaces only D0 bits 0..7 (CIA-A TOD low byte); `mulu.w #13,D0` multiplies the LOW WORD of D0, so caller bits 8..15 take part; `addq.b #7,D0` adds inside the low byte only (wraps, no carry into bit 8); seed from `$2EA0`, `rol.l #3`, copy to D3, `mulu.w D3,D0` (low words), `lsr.l #1,D0`, `add.l D0,D1` (wraps modulo 2^32), store as the new seed; `D0 = D1.b` zero-extended, `mulu.w D0,D2` (low word of the range times the seed's low byte), `lsr.l #8,D2`. The result is in D2 (high word always zero, so result < range word; a zero range word yields 0); D0, D1, D3 are restored, which the model returns as `d0` equal to the input.

The read-only byte inventory (`python tools/rng_call_sites.py [Disk.1]`) finds **62 direct `JSR abs.l` encodings** in Disk.1 sectors `$14C-$208`: 44 target `$2DCA` (which sets D2 to 100 and falls through into `$2DCC`) and 18 target `$2DCC` directly (the caller supplies D2's range word). File offsets map to loaded addresses by subtracting `$28800`. This is a static encoding inventory, not proof that every site is reachable in ordinary play. The November production tape records seven sites. The separate RAM-staged invasion capture exercises 16 direct sites, five of which overlap the November set; 18 unique sites therefore have capture context, while the other 44 do not.

**Static caller-context audit (not dynamic coverage):** the per-site audit in [original-rng-callers.md](original-rng-callers.md) replaces the earlier predecessor-window summary. It records all 62 direct sites, their D2 setup and the relevant D0 byte-1 context, with explicit premises and CLOSED / FORMULA / UNRESOLVED labels. This is static tracing, not a complete reachability proof or dynamic coverage: the two captures together exercise 18 unique sites, and most data-dependent contexts have not been observed in the original. The audit identifies `$11414` as a statically fixed nonzero D0 byte-1 case; its current tally has zero UNRESOLVED rows, with remaining FORMULA rows depending on named state or branch conditions. This does not justify connecting the isolated model to `Sim.roll()`.

Evidence and limits, kept separate:
- **Arithmetic (verified):** an independent recomputation and `test/original-rng.mjs` reproduce all 50 raw calls of the local November capture (recorded entry D0, range, TOD low byte, seed before -> recorded result and seed after) with zero mismatches, and the 30 November calls drive the monthly comparator through the model. In that capture D0 bits 8..15 were always zero, so the nonzero-byte-1 behaviour follows from the instruction semantics only and is covered by synthetic vectors (hand-derived vectors, an independent BigInt reference, and a 20000-call sweep with low-byte carry, nonzero D0 byte 1, ignored D0 bits 16..31, `add.l` wrap and range edge cases).
- **Captured caller contexts (bounded):** the November tape contains 7 of the 62 call sites. Static instruction tracing explains the D0 values at those sites, and the capture records them:
  - `$A7C0` and `$A7D2` (market walk): D0 is the current market value loaded from the first word of the entry by `$A7AE` (`movem.w (a0),d0-d4`). The second draw retains that D0 because `$2DCC` restores D0. The tape's values match the relevant market entries.
  - `$A854` (supply/demand): D0 is the six-entry loop counter, 5 down to 0, initialized at `$A814` and decremented by `dbra` at `$A864`.
  - `$9BD2` (births): D0 is selected from the difficulty byte at `$145A2`: 0 for difficulty `$14`, `$1E` for `$1E`, otherwise `$3C`. The capture's difficulty is `$1E`, and D0 is `$1E`.
  - `$9CB6` (fractional deaths): D0 is the pool loop counter initialized to 8 at `$9C9C`; it is decremented as the scan advances. Only pools with a nonzero fractional remainder call `$2DCA`, so the captured calls have D0 values 6 and 4.
  - `$10BEE` (monthly crime): D0 is computed from `$144EC` by the signed divide/absolute-value branches at `$10BC8..$10BE4`; the 01/11 invocation records `$50`. This is a value derived from crime state, not a fixed constant.
  - `$A3FE` (miner rolls): D0 is the miner count minus one, initialized at `$A3EC..$A3F4` and decremented by `dbra` at `$A404`; the capture records 9 down to 0.

  These are statically explained contexts for the seven sites in the November tape; they do not cover the other 55 sites absent from that tape. The separate invasion capture adds 16 sites (five overlap), as described in `original-rng-callers.md`; its setup is RAM-staged. The November capture's 50 calls have D0 bits 8..15 equal to zero; nonzero caller byte-1 behavior remains instruction-derived and synthetic-test-covered. Since ordinary `Sim.roll(range)` does not provide caller D0 or CIA TOD, this evidence does not justify wiring the original model into the game-wide generator. No Sim call site, default generator, save field or checkpoint uses it.
- **Seed initialisation `$2DA0` (static code, runtime use unverified):** the routine reads CIA-A TOD high/mid/low at `$BFEA01/$BFE901/$BFE801`, with the high-byte read latching TOD and the low-byte read releasing it. It assembles the mid/low word; if low is zero, it re-reads the mid register into the low byte. It then multiplies that word by the low word of VHPOSR at `$DFF006` and writes the 32-bit product to `$2EA0`. A fresh byte scan of the loaded Disk.1 game-image range finds no `$00002DA0` absolute-long literal and only three `$00002EA0` absolute-long operands: the initializer store at `$2DC4` and `$2DCC` read/write at `$2DDE`/`$2DEE`. Recursive descent from game entry `$156B6` decodes 13,550 instructions and 306 direct call targets; none branches/calls to `$2DA0`, and the only decoded `$2EA0` accesses are `$2DCC`'s read/write. The same absolute-long-literal scan finds no `$00002DA0`/`$00002EA0` in Disk.1 boot-stage bytes `$3000..$A7FF` or in `Utopia.Slave`. The image contains `$BFE0450D` at `$2EA0`. This strengthens the image-default hypothesis, but does not exclude an indirect pointer, an external startup write, or another path before the first draw; there is no runtime capture of the seed before `$2DCC` first runs, so first-use seed provenance remains unverified. Partial runtime evidence (2026-11-12, tutorial capture, one run): the first recorded `$2DCC` entry after the tutorial click has seed before `$BFE0450D`, equal to the image default; whether draws ran between boot and that click is not recorded. The 32 recorded entries chain continuously, with one TOD byte per link (inferred, see game-proper.md "Seed chain and TOD"). The remake models neither this CIA TOD/VHPOSR initialization nor CIA TOD for `$2DCC`.
- The optional raw-capture check runs only when `UTOPIA_PRODUCTION_TRACE_DIR` is set (directory or its `out/` with `rng-tape-seg1.jsonl` and `rng-tape-seg2.jsonl`); a set but missing or malformed capture fails, unset skips. Captures are never committed.

## Crime consequences (`$10C72` daily, ported in `Sim.eventCrime()`)

Crime above 50 runs arson (`$10D00`): unless invention bit 3 is set, a 40% roll starts a six-round spell
(`$144BC`); each round the security percentage (`$144C6`, doubled) decides whether the spell ends
(+1000 morale, message `$11A`) or a random object record (`$11A5C`) is knocked down (`$12332` = `Sim.bomb`: demolish,
damage counter `$1346A`++, one `explosion` effect per footprint cell, -500 morale, message `$119`; before the area-blast ownership change the port demolished and counted by hand and made no blast of its own). Above 60 `$10D9E` runs unrest (`$144BE`): a 10%
roll starts it, each round either the police win (`$121`), or it drains until the counter hits 0, which
is announcement id 0 and game over (heading `$183`); otherwise message `$120` with chance (6-n)*10%.

## Ship yard, ships, fuel (`src/game/sim-ships.ts`, `Sim.fleet`)

Ships are kept as `Fleet.slots` (type 11..16, x, y, dir, hp, mode, tech, class, fuel word, lift). `$AC04` runs monthly after the tank yard:
skipped when the power byte `$144C8` is 9 or more (signed) or without a command centre (`$133F8`); workers per yard = job pool 3 (`$143F6`) /
yard count (`$133D4`). Each record with tile `$36`: +6 = ordered class 1..6 (0 idle), +7 = remaining cost of good 1. Stage 1 removes
min(workers per yard, +7) units of good 1 per month (message `$C6` and abort when the stock is empty; `$1437A`/`$143A2` += taken, `$1434A` -= taken);
stage 2 takes `$B251[class-1]` = 0,2,4,2,3,1 units of good 3 (message `$C5` when none could be removed), sets +7 = `$FF` and launches.
Frame costs `$F012` = 50,100,180,240,80,50 (class 5 needs invention bit 4); order is made by `Fleet.orderShip(slot, class)`.
The launched ship (`$387E`, port `Fleet.createShip`) sets the map occupancy bit 14 and the own flag (bit 2) of its pad cell, [V static];
the port does both (`test/aliens.mjs`, and `test/enemies.mjs` for the enemy attack on a landed yard-built ship).
Launch `$4060`: pad = record tile `$48` with +3 = `$FF` within 5 cells of the yard; its four cells are tried in the order (x,y) (x,y+1) (x+1,y+1) (x+1,y),
first without cell bit 14. None: message `$C7`, yard keeps +7 = `$FF` and retries next month. Success: +6/+7 cleared, `$143B2`++, `$387E` creates a
ship of type `$4BBE[class]` = 11..16, direction 8 (cap 40 ships `$1429E`, message `$C8`), hp/mode/fuel from table `$4B76` (rows type 9..17), fuel
cleared unless class 4, type count `$14254 + 4*(type-9)`++ (not type 17), cell bit 14 set.
Destroy `$46CC`: type count--, `$14294`++, morale -100 (not type 17), ship count--, the explosion (when bit 5 is set by the destroyer, or a stale mark from a free-slot missile hit is still set: `Sim.blastMark`, `Sim.takeBlastMark`) blasts at the ship with its lift as height and the high volume, then the reservation is released: the flag always, the map bit unless that blast clobbered A6 (ship-control.md 5e, static trace), optional message.
`$ACE2` daily fuel: mode 1 burns 1, modes 2/3 burn 2; fuel <= 0 destroys with message `$40`; type 15 is skipped; a missile (type 17, `MissileRecord`, no fuel) is handed to the `EnemySystem` hook (target refresh / destruction, ship-control.md 5d); `createShip(17)` is refused, `Fleet.createMissile` makes the record.
`$4798` weekly refuel: landed (mode 0), class != 4 ships on pad tiles `$48..$4B` with a fuel tank tile `$3F/$40` within x-7..x+6, y-7..y+6 are filled
to `$4A98` = 400,600,600,1200,`$FFFF`,400 from the tanks (`$13310` + `$13322`); too little stock = all of it and message `$EE` once a month
(flag cleared in the monthly code). `$A5A6` withdrawal has the same flat 800/1200 split as `$A51A`. `$12510` weekly repair: ships and ground units
heal tech/2 hit points up to the type maximum (ground units through `SimOptions.repairUnits(amount)`).

## Alien events and intelligence (`src/game/sim-aliens.ts`, `Sim.aliens`)

Static Disk.1 trace for the invasion path is summarized below; it has not been compared with a running original invasion.

- Event 12 `$113A6`: first ship with lift != 0 explodes (message `$109`). Event 15 `$114AC` (power level < 6): T[13].C x 400 fuel is beamed out of
  the tanks (message `$52`), half is lost, the ships are topped up 20 per round, the rest goes back into the tanks. Event 17 `$11566`: first own tank
  defects to the enemy (`$142A2`++, `$1429C`--, message `$181`; `SimOptions.defectUnit`); the converted record copies the tank's waiting bit, pixel offset, tech and target (enemies.md 3e).
- Event 1 `$1146A`: alien sprite (`$144A8`, type 19) at a random marker cell (tile `$7F`, first 10 in row-major order, kept at `$14524`/`$144A6`). The active record is now drawn on the map by a read-only adapter (`alien-sprite.ts` -> `ObjectLayer.apparition`, map-rendering.md 7.2): it reads `$144A8..$144AD` at draw time and never advances the frame, RNG, occupancy or the effect list. **Silent (VERIFIED static, Disk.1, 2026-11-10):** `$1146A` (dispatch-table entry `$10E60`, the only reference to it in the image) makes no `$5A8C` message, no `$11B4` sound request, no `$11432` focus call and no other effect; its calls are the chance roll `$2DCA`, the marker roll `$2DCC` and the record writes. The remake therefore emits no effect for event 1 (the former `alienAppear` alert sound, which had no basis in the trace, was removed; `test/aliens.mjs`). Same-cell draw order and artwork parity are untraced/unverified.
  Event 8 `$1160E`: meteor (`$1449C`, type 21, timer `$78`, message `$182`, none with invention bit 8) falls 4 per main-loop pass (`Sim.pass()`); the live record is now drawn by a read-only adapter (`meteor-sprite.ts` -> `ObjectLayer.meteor`, map-rendering.md 7.2) that polls `$1449C..$144A2` at draw time, uses `+6` (the countdown) as the lift, writes nothing and retains no effect, so `eventMeteor` / `meteorStep` / the `meteorFall` and `meteorImpact` hooks are unchanged; unresolved: paused-meteor original control flow, exact `x >= 224` clip, same-cell order, visual parity. Impact
  `$11676` bombs the 5x5 cells flagged `$0400` (counter `$1346A`, morale -1000 once) through `Sim.bomb`, one `$1237C` blast per footprint cell of each demolished building and NONE for the impact centre (static: neither `$3626` nor `$11676` calls `$1237C`); the `meteorImpact` effect is still emitted but `MapScene` gives it no sound or sprite.
- Event 9 `$11724` attack wave: `$B018` countdown `$141B2`, strength +`$18` decaying by `$1D`, roll against strength, warning pass-through by table
  `$14060` (message `$8D`; SYS bit1 pending flag), then entries of the alien block (`$13456 + $20 + 64*(level-1)`) are queued into one of 16 spawn groups
  (`$135C6`, stride `$92`: 8 spawn cells, 32-long queue at +`$10`, count +`$90`, direction +`$91`). `$1187C` (`Sim.pass()` -> `spawnStep`) visits the selected
  group at most six times per pass, potentially spawning one enemy for each successful queue entry. It stops early when the group empties or when all eight
  spawn cells for the current entry are blocked; that entry remains queued.
- Event 13 `$ADA6`: funds decay, level recompute `$AD70` (funds 0 -> 0, < 5000 -> 1, < 20000 -> 2, else 3), ticker countdown, five one-shot reports via tables at
  `$13EE6/$13F10/$13F3A/$13F64/$13FB8`, followed by a separate repeatable report/alien-strength increase. The fifth stage at `$AEB6` is represented in `SimAliens.eventIntelStep()` and covered by a synthetic regression; static mapping only, no original capture. Event 3 `$12A16`: battle report when `$144CB` = 4 using tally `$1446E`. `$AF12` daily: aliens age (every 10th call, level from age).
- `$127A0` weekly battle: front fleet counts `$14274` (8 longs) x power weights, tech/2, the alien age (`$13456 + $14`) wears down; victory sets SYS bit2,
  morale +5000, funds `$1446A` go to the treasury, level 4; otherwise casualties.
- Hooks: `SimOptions.effect(kind, x, y)` (explosion, focus, launch, meteorFall, meteorImpact; event 1 emits none), `spawnEnemy`, `defectUnit`, `repairUnits`.
- **Event dispatch gate (`$10E1E`, VERIFIED static, 2026-11-10):** `move.b (a0)+,d3; beq $10E50` skips the handler for every day slot whose chance byte (`$13118+k`) is zero, and the index `$144BF` still advances at `$10E50`. `Sim.eventScheduler` applies the same rule to all slots. The earlier exception that always ran slot 9 (attack wave) was not in the trace and was removed; the chance byte at slot 9 is 100 in all ten scenario blocks, so ordinary play is unchanged. Test: `test/aliens.mjs` (zero chance skips slot 9, chance 100 runs it, index advances). **Exception (VERIFIED static, 2026-11-13):** the colony fall (`$10E0A`, from the crime handler's riot routine in slot 19) jumps out of `$10E1E` before the advance, so a game over raised by a handler leaves the index on its slot; `Sim.eventScheduler` now returns before the advance in that case. Test: `test/game-over.mjs` section 1b.
- `SimOptions.demolishAt(x, y, bombing)` is `$7372` only. The `bombing` argument models `$156A9` bit 4, which `$12332` sets only across `$7372`; this permission lets the bombed vent path demolish an occupied vent despite `$156A9` being outside the captured `GameState` image. A hook may return the `$75A8` footprint (`DemolishFootprint`, `[]` when nothing was a building): `Sim.bomb` increments `$1346A` unconditionally and then emits one `explosion` effect per reported cell, in list order. A void/invalid report is unknown and presents no invented cell. Mine collapse (`$11090`) calls `demolishAt` alone and therefore never blasts; arson (`$10D60`) goes through `bomb`. `MapScene` applies the `$1237C` window / volume / 30-slot rules once per cell (`blastCell`, shared with the combat hook, whose A6-clobber boolean is unchanged). STATIC evidence plus synthetic coverage (`test/area-blast.mjs`); no emulator comparison. Detail: units.md section 6, "Blast ownership".
  New `SimEvent` kinds: ship (launched/destroyed), intel, aliensDefeated. Test: `test/aliens.mjs`.

### Invasion and combat trace (Disk.1 static disassembly; synthetic regressions)

- **Pass order (`$157BC`, `$333A`)**: own units, ships, enemy ground, enemy air, effects; alien frame and meteor; draw-list sort; wave spawn `$1187C`; draw work and date advance; VBL wait; periodic worker `$99C4`; input poll. The scene now follows this sequence. A new wave enemy is therefore not stepped until the next pass.
- **Wave scheduling (`$10E1E`, `$11724`)**: Tutorial bit 7 of `$156AA` skips daily events; no-unit-bonus bit 2 stops the attack event. Event 9 reduces strength and may warn/set bit 1; its next eligible evaluation consumes bit 1 and launches the wave. `$117EE` uses Sim RNG for group (range 16) and entry start (range 8), but `$2E00` reads `$DFF006` for each entry's +/-2 count jitter. **Sign [static trace, Disk.1]:** `$2E00` is `moveq #0,d2; move.b $DFF006,d2; andi.b #1,d2; tst.b d2; rts` (it returns the low bit of the raster byte in the Z flag), and the caller at `$11840` is `moveq #2,d3; jsr $2E00; beq $1184C; neg.b d3`: parity 0 keeps +2, parity 1 negates to -2. The sign mapping is therefore verified from the code (the earlier HYPOTHESIS label is removed); only the raster **timing** is approximate: the remake feeds the parity from the deterministic hardware stand-in (`SimOptions.hardware.rasterParity`, state saved from native version 5), not from the beam position of a real machine, so which parity a given spawn sees is not reproduced. This stand-in is separate from Sim RNG.
- **Queue/spawn (`$117EE`, `$1187C`)**: queue copies entry pointers into the chosen group's first free queue words. On each pass, the group cursor moves by `$14` with `$80` wrap; up to six entries are attempted. If all eight spawn cells for the selected entry are blocked, that spawn step ends with the entry still queued. Ground cells reject map bits `$5000`; air cells reject `$2000`. Allocation checks the occupied count before scanning the fixed list for the first free slot. Spawn sets only map occupancy and the count; `+$16..+$19` and the flag byte stay as the fixed slot had them (the slot's raw pointer survives death and reuse, a never-used slot is 0 in the one external pre-November snapshot, which does not prove first-boot RAM is universally zero), and the first movement claim stores the new `+$16` and sets the flag byte; a death before that claim releases whatever the stored (stale or zero) pointer names, not the spawn cell (enemies.md section 3b). Full-list and exact cursor edge behavior beyond the decoded branches are covered synthetically, not observed live.
- **Enemy building gate (`$1266A`)**: on an enemy tick, CIA TOD low byte `$BFE801` is read once per enemy attack call and opens the active-building bomb path only for values 0..24. The same byte gates every building candidate in that scan. A successful gate is followed by the existing Sim RNG bomb-percent roll. The remake uses `HardwareSource.todLow()` instead of drawing from Sim RNG; default seeded hardware state is a deterministic probability approximation, not actual CIA timing.
- **SYS bits**: `$156AA` bit 1 is the pending-wave latch; bit 2 blocks waves; bit 7 is Tutorial mode (text `$191`, set by `$8114`, and read by event, eclipse and QoL paths). Earlier `SYS.attack` terminology was misleading and is replaced by `SYS.tutorialMode`.
- **Verification boundary**: the code paths are static-trace-backed and synthetic-tested. `test/invasion-lifecycle.mjs` drives two staged event-9 slots through the daily dispatcher, then uses the real MapScene spawner, movement, bomb/demolition and gun-kill paths; the event-index calendar and wave-table row are fixture inputs. No original invasion/combat capture exists. The tank and November production capture comparisons do not exercise this path. No claim of original combat parity follows from these changes.
