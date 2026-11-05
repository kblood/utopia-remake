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
| `$11D34` (gun animation, special bit and daily) | graphics/unit logic |
| `$ACE2` (ship fuel), `$4798`, `$12510`, `$127A0` (weekly unit/enemy code), `$A5A6` (fuel withdrawal for ships) | unit lists not modelled |
| `$7000` construction countdown (weekly) | needs the placement code; conversion logic is `$703A` (documented in game-state.md 7.2) |
| `$AC04` ship yard | spawns ships |
| `$AF12/$B018` alien intelligence | not traced to the point of a faithful port |
| events 1, 3, 8, 9, 12, 13, 15, 17 (event 11, tank requisition `$11280`, is ported with the Earth dialog and `SimOptions.destroyUnit` = `$4692`; event 4, mine collapse `$11090`, is ported: random mine record demolished through `SimOptions.demolishAt`, message `$DF`, morale -300) | alien/meteor/units/mine collapse (needs `$7372` demolish); event 5 is empty in the original |
| crime consequences above level 50 (`$10D00`, `$10D9E`) | unit and building destruction |
| `$15698` message timers, `$144BD` scroll countdown, `$15xxx` redraw flags, `$7342` redraw | UI only |

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
