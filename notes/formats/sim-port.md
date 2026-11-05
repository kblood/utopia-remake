# Simulation port (src/game/sim.ts) - status and findings

Code: `src/game/sim.ts` (class `Sim`), `src/game/sim-math.ts` (68000 arithmetic helpers, injectable RNG), `src/game/sim-tables.ts`
(constant tables copied from the game image, source addresses in comments). Checks: `npm run build && npm test` (`test/sim.mjs`).
All addresses refer to the game image (Disk.1 sectors $14C-$208 at $1000). No game text; message strings are exposed as index numbers
(`Sim.messages`), modal announcements and Earth offers as `Sim.events`.

Tags: **VERIFIED** = ported line by line from the disassembly (register widths, byte/word compares and quirks kept; behaviour checked only by
plausibility tests, there is no emulator comparison). **NOT PORTED** = skipped on purpose.

## Driver

- `Sim.tick()` = `GameState.tickFrame()` + `run()`. `run()` mirrors `$99C4`: it consumes the pending bits of `$144C1` in the original order
  (special, daily, weekly, monthly, yearly) and does nothing while `paused` ($156A9 bit 2) or after game over. `monthly()` is public for tests.
- RNG: `$2DCA/$2DCC` (d2 = range, result 0..d2-1) is replaced by `Rng = (range) => number`; `createRng(seed)` is a seeded mulberry32. Pass
  `new Sim(world, { rng })`. The Earth dialogs (`$DECC`) are the `decide(offer)` callback (true = first button; default false).
- `$156AA` system flags live in `Sim.sysFlags` (`SYS`): bit2 no-unit-bonus, bit3 game over, bit4/5 QoL 80/90 announced, bit6 eclipse,
  bit7 "attack" (blocks events and the eclipse countdown, QoL -30; nothing in the ported code sets it).
- `$14432` (goods weight capacity) is not set by `World`; the `Sim` constructor copies `world.warehouseCapacity` into it when it is 0.

## Ported, in the order of $99C4

| Routine | Source | Notes |
|---|---|---|
| daily: QoL on day 1, game over, event slot | `$99C4`, `$A8E8`, `$B086`, `$10E1E` | VERIFIED |
| weekly: eclipse countdown, `$144B2` | `$10FCA` | VERIFIED. Scripted eclipse of 3 weeks on month 11, day 21 |
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
| game over | `$B086` | VERIFIED. Sets `SYS.gameOver`, event `{announce, id 1}` |
| events 0, 2, 6, 7, 10, 14, 16, 18, 19 | `$110FE`, `$1135A`, `$10F5E`, `$10F8E`, `$111A6`, `$11058`, `$113FA`, `$10ED2`, `$10C72` | VERIFIED handlers; 19 only up to crime 50 |

### Findings that differ from, or add to, game-state.md

- **Births** (`$9BAE`): the roll is `rand(d)` with d = difficulty byte ($14 or $1E), plus a band: 0 for $14, $1E for $1E, $3C otherwise. Difficulty 0
  means no births. births = ((((pop*10+500)/1000) * rate) + 5) / 10. Death percent = 1 + $144B4 + $144B5 + $144B9, +1 if pop/20 > medics, +1 if that
  exceeds 10, +1 if it exceeds 30; if >= 20 morale gets -20*percent; the overcrowding value $144C5 is a floor. `$9C80` removes percent of the free
  colonists and of each pool; a fraction below one colonist is decided by `remainder >= rand(percent)` (kills one).
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
- Morale is not clamped by the code: `$A246` scales the change by (100 - |m|/100)/100, so it stalls at +-10000 but can overshoot slightly.

## Not ported

| Routine | Reason |
|---|---|
| `$11D34` (gun animation, special bit and daily) | graphics/unit logic (enemy units and combat belong to units.ts / enemies.ts) |
| `$15xxx` redraw flags | the remake redraws every frame |
| sound calls | out of scope |

Ported since the first version of this table: the construction countdown `$7000`/`$703A` (`src/game/construction.ts`), the Command Centre
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
  solar tiles `$0F`/`$1F`: +2 = 0, +6 = 1 or `$FF` from the beam position bit (`$2E00`; `Construction.phase`), +7 = 0. Finally `$6A8C` writes tile+n into the cells
  (footprint byte 1 = one cell, else 2 x 2: tile, +1 right, +2 below, +3 diagonal; flag byte from the first tile). **No completion message is posted.**
- **Command Centre redraw `$7342`**: after the online/offline change by `$A1EA` (power failure) / `$9B8C` (recovery) the record's cells are rewritten with
  `$4C` (byte +3 = `$FF`) or `$50`. `Sim` option `centreChanged(slot)` is wired to `Construction.redrawCentre` in `map.ts`.
- **Warning lights `$5D30`** (table `$15628`, 16 bytes per light: image pointer at +4, x/y words at +8/+10 = 16x16 at (0|16|32|48, 139), flag byte at `$15634` +
  16k, toggle byte +`$D`): power (set `$A19C`, cleared `$A0D4`), bookmark (`$11432`), food (`$9F0E` set / `$9E9E` clear), air (`$9D9C` / `$9CE0`). An unlit light is
  skipped; a lit one is drawn on every second frame. Icons: 5 planes, 16 x 16, unmasked, at the pointer in the table (`readLightIcons`).
- **View bookmark**: `$11432` (the "focus" effect of events: meteor, alien, battle, ...) does not scroll. It stores x-4, y-4 (limited to `$5C` / `$43`) at
  `$144E8`/`$144EA`, lights the second light and sets the countdown `$144BD` to 6. The daily pass (`$144BD`, between `$B086` and `$15698`) does `subq.b #1`; once
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

## Tank yard (`$A620`, ported as `Sim.tankYard()`)

Monthly after production. Workers per yard = `$143FA` (job pool 4) / yard count (`$1337A`). Each
record with tile `$45` has a counter in byte +6: it takes good 1 until the counter reaches 20
(message `$96` when the stock is empty), then 2 of good 3 (`$94`), sets the counter to `$FF`, then
asks `SimOptions.spawnUnit(x, y, advanced)` for a free neighbour cell (`UnitSystem.spawnAtYard`);
on success the counter resets and `$143B6` counts the unit, otherwise message `$95` and it retries.
Test: `test/sim.mjs`.

Unit bookkeeping (`$37CA`, `$4692`): a new unit raises `$1429C` (cap 99, message `$8F`) and the type count
`$14254` (type 9) / `$14258` (type 10); destroying one lowers them, raises `$14294` and costs 50 morale.

## Crime consequences (`$10C72` daily, ported in `Sim.eventCrime()`)

Crime above 50 runs arson (`$10D00`): unless invention bit 3 is set, a 40% roll starts a six-round spell
(`$144BC`); each round the security percentage (`$144C6`, doubled) decides whether the spell ends
(+1000 morale, message `$11A`) or a random object record (`$11A5C`) is knocked down (`$12332` = demolish,
damage counter `$1346A`++, -500 morale, message `$119`). Above 60 `$10D9E` runs unrest (`$144BE`): a 10%
roll starts it, each round either the police win (`$121`), or it drains until the counter hits 0, which
is announcement id 0 and game over (heading `$183`); otherwise message `$120` with chance (6-n)*10%.

## Ship yard, ships, fuel (`src/game/sim-ships.ts`, `Sim.fleet`)

Ships are kept as `Fleet.slots` (type 11..16, x, y, dir, hp, mode, tech, class, fuel word, lift). `$AC04` runs monthly after the tank yard:
skipped when the power byte `$144C8` is 9 or more (signed) or without a command centre (`$133F8`); workers per yard = job pool 3 (`$143F6`) /
yard count (`$133D4`). Each record with tile `$36`: +6 = ordered class 1..6 (0 idle), +7 = remaining cost of good 1. Stage 1 removes
min(workers per yard, +7) units of good 1 per month (message `$C6` and abort when the stock is empty; `$1437A`/`$143A2` += taken, `$1434A` -= taken);
stage 2 takes `$B251[class-1]` = 0,2,4,2,3,1 units of good 3 (message `$C5` when none could be removed), sets +7 = `$FF` and launches.
Frame costs `$F012` = 50,100,180,240,80,50 (class 5 needs invention bit 4); order is made by `Fleet.orderShip(slot, class)`.
Launch `$4060`: pad = record tile `$48` with +3 = `$FF` within 5 cells of the yard; its four cells are tried in the order (x,y) (x,y+1) (x+1,y+1) (x+1,y),
first without cell bit 14. None: message `$C7`, yard keeps +7 = `$FF` and retries next month. Success: +6/+7 cleared, `$143B2`++, `$387E` creates a
ship of type `$4BBE[class]` = 11..16, direction 8 (cap 40 ships `$1429E`, message `$C8`), hp/mode/fuel from table `$4B76` (rows type 9..17), fuel
cleared unless class 4, type count `$14254 + 4*(type-9)`++ (not type 17), cell bit 14 set.
Destroy `$46CC`: type count--, `$14294`++, morale -100 (not type 17), ship count--, cell bit cleared, explosion effect, optional message.
`$ACE2` daily fuel: mode 1 burns 1, modes 2/3 burn 2; fuel <= 0 destroys with message `$40`; types 15 and 17 are skipped.
`$4798` weekly refuel: landed (mode 0), class != 4 ships on pad tiles `$48..$4B` with a fuel tank tile `$3F/$40` within x-7..x+6, y-7..y+6 are filled
to `$4A98` = 400,600,600,1200,`$FFFF`,400 from the tanks (`$13310` + `$13322`); too little stock = all of it and message `$EE` once a month
(flag cleared in the monthly code). `$A5A6` withdrawal has the same flat 800/1200 split as `$A51A`. `$12510` weekly repair: ships and ground units
heal tech/2 hit points up to the type maximum (ground units through `SimOptions.repairUnits(amount)`).

## Alien events and intelligence (`src/game/sim-aliens.ts`, `Sim.aliens`)

- Event 12 `$113A6`: first ship with lift != 0 explodes (message `$109`). Event 15 `$114AC` (power level < 6): T[13].C x 400 fuel is beamed out of
  the tanks (message `$52`), half is lost, the ships are topped up 20 per round, the rest goes back into the tanks. Event 17 `$11566`: first own tank
  defects to the enemy (`$142A2`++, `$1429C`--, message `$181`; `SimOptions.defectUnit`).
- Event 1 `$1146A`: alien sprite (`$144A8`, type 19) at a random marker cell (tile `$7F`, first 10 in row-major order, kept at `$14524`/`$144A6`).
  Event 8 `$1160E`: meteor (`$1449C`, type 21, timer `$78`, message `$182`, none with invention bit 8) falls 4 per main-loop pass (`Sim.pass()`), impact
  `$11676` bombs the 5x5 cells flagged `$0400` (counter `$1346A`, morale -1000 once).
- Event 9 `$11724` attack wave: `$B018` countdown `$141B2`, strength +`$18` decaying by `$1D`, roll against strength, warning pass-through by table
  `$14060` (message `$8D`; SYS bit1 pending flag), then entries of the alien block (`$13456 + $20 + 64*(level-1)`) are queued into one of 16 spawn groups
  (`$135C6`, stride `$92`: 8 spawn cells, 32-long queue at +`$10`, count +`$90`, direction +`$91`). `$1187C` (`Sim.pass()` -> `spawnStep`) spawns one
  queued enemy per group visit through `SimOptions.spawnEnemy(spawn)`.
- Event 13 `$ADA6`: funds decay, level recompute `$AD70` (funds 0 -> 0, < 5000 -> 1, < 20000 -> 2, else 3), ticker countdown, one-shot reports via the tables at
  `$13EE6/$13F10/$13F3A/$13F64`. Event 3 `$12A16`: battle report when `$144CB` = 4 using tally `$1446E`. `$AF12` daily: aliens age (every 10th call, level from age).
- `$127A0` weekly battle: front fleet counts `$14274` (8 longs) x power weights, tech/2, the alien age (`$13456 + $14`) wears down; victory sets SYS bit2,
  morale +5000, funds `$1446A` go to the treasury, level 4; otherwise casualties.
- Hooks: `SimOptions.effect(kind, x, y)` (explosion, focus, launch, alienAppear, meteorFall, meteorImpact), `spawnEnemy`, `defectUnit`, `repairUnits`.
  New `SimEvent` kinds: ship (launched/destroyed), intel, aliensDefeated. Test: `test/aliens.mjs`.
