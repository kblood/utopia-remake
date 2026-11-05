# Enemies, combat, ships and guns (static analysis of the game image; port in `src/game/enemies.ts`)

Status tags: [V] read from the disassembly, [H] hypothesis / guess. Addresses are image addresses (file offset = address + $28800).
No game data is stored in the port: the lookup tables are read from Disk.1 at runtime by `src/data/combat.ts`.

## 1. Main-loop pass `$333A` [V]

Sub-tick `$144C9` counts 0..8. Wrapping to 0 sets the **move tick** (`$156A9` bit 7), reaching 4 sets the **enemy tick** (bit 6); both last
one pass. Per pass: own tanks (units.md), ships (`$42BE`, then own fire if `$145A4[class]` != 0, not for type $11), enemy ground (`$1193E`),
enemy air (`$11A9E`), effects. Bit 7 of record byte +9 = "waiting for the next move tick": own tanks start waiting, are cleared by the first
move tick and then step every pass; the fire routine `$12588` (move tick only) sets the shooter waiting again. Enemy ground units are stepped on the
enemy tick or whenever they are not waiting (an attack sets them waiting). Aircraft have no waiting check. `PassClock` (units.ts) holds the flags;
`ObjectLayer.update()` runs `units.tick()` then `enemies.pass(clock)` once per pass (2 frames [H]).

## 2. Enemy record (stride $1A; ground list `$3A12C`, air list `$39E20`) [V]

+0 type (22/23 walker, 24 crusher, 25 bomber, 26/27 kamikaze, 9/10 defected tank), +1/+2 cell, +3/+4 pixel offset, +5 direction, +6/+7 velocity,
+8 hit points, +9 mode, +A tech, +B/+C target cell ($FF = none), +D step counter, +E bomb chance %, +F damage, +$10 lift (air) / recent directions (ground),
+$13 aux (bomb count of a bomber, dive height of a kamikaze, crusher toggle), +$14, +$15, +$16 flag pointer.
Spawn init (`$48B6` air, `$48EC` ground) from the wave entry (sim-aliens.ts `EnemySpawn.entry`): hp = e[1], +F = e[3], +E = e[6], +$13 = e[5], +$14 = e[6],
+$15 = e[7], mode 6, target $FF; aircraft start with lift $22. The spawner already sets the map bits and the counters `$142A2` / `$142A4`.
Map marks: ground unit = word bit 14 (`$4000`) + flag bit 0, aircraft = word bit 13 (`$2000`) + flag bit 1; own tank flag bit 2, flying ship flag bit 3.

## 3. Behaviour [V unless tagged]

- **Walker (22/23, `$1197C`)**: mode 6 picks a random building (`Sim.randomBuilding`) and goes to mode 1; mode 5 idles; otherwise the shared walk
  step `$38E2` (units.ts `walkerStep`, enemy variant) and, when the target is done, mode 6; then the attack. Defected tanks (types 9/10 in the enemy list) spin
  (dir - 1 each step) and attack.
- **Crusher (24, `$11F12`/`$11F42`)**: steps on every second call, counter 0..7 with an animation table (`$12D60`) feeding the sprite's second dimension; walks over
  rocks (tile >= $88) and active buildings ($0400, destroyed with `Sim.bomb` on entering the cell); acid tile $61 hurts it by `byte($13116) + 2 * tech`;
  mode 1 lasts at most 80 steps. It does not shoot. [H] arriving clears its velocity (the original keeps stepping).
- **Aircraft step `$11AE6`**: type 27 moves at double speed; the air-layer mark moves to the next cell when a step starts; leaving the map destroys the unit with
  morale +50 (`$11C30`).
- **Bomber (25, `$11C7A`)**: mode 6: steps = 0, pick a target; mode 1: fly, after 20 cell moves back to mode 6, about 10 % chance per cell move to try a bomb run.
  A bomb run only works over an active cell: +$13 --; below 0: mode 6, and if +$15 == 0 then +$13 = 0 and mode 3 (flies straight off the map); otherwise bomb the
  cell when `roll(100) < +$14`. With +$13 < 0 the unit behaves as a kamikaze.
- **Kamikaze (26/27, `$119C0`)**: mode 6 picks a target and sets +$13 = building height - 10 [H: from the tile's rows]; mode 1 flies; on arrival at an active
  cell: mode 2, dir 3, velocity 0 (else mode 6); mode 2 lowers the lift by 2 (4 for type 27) and detonates when +$13 >= lift: `destroyAir` then `Sim.bomb`. Type 26
  and bombers also call the attack routine.
- **Attack (`$1266A`, enemy tick only)**: scan the 48 cells of the spiral table `$12C96` (stops at the map edge). A gate `roll(256) < 25` (the original reads a CIA
  register) lets an active cell be bombed with chance +E %. Flag bits 2/3 (tank / ship): the tank within +-1 is hit for +F (destroyed -> `$4692`), otherwise a ship
  (`$46CC`). The attacker waits afterwards.
- **Own fire (`$12588`, move tick only)**: the first cell in the spiral with flag bit 0 or 1 selects the enemy within +-1 (none: scan ends); hit sound, shooter waits,
  hp -= `$145A3` (tank) or `$145A4[class]` (ship); at hp <= 0 the enemy dies with an explosion (air: morale +50).

## 4. Bookkeeping [V]

| Event | Routine | Effect |
|---|---|---|
| ground enemy gone | `$11C5C` | `$142A2`--, `$14298`++ (kills), clear `$4000` and flag 0 |
| aircraft gone | `$11C30` | `$142A4`--, `$14298`++, morale +50, clear `$2000` and flag 1 |
| own tank destroyed | `$4692` | `$1429C`--, per-type count (`$14254` type 9, else `$14258`)--, `$14294`++, morale -50 |
| own tank leaves the map | `$3C40` | `Aliens.sendToFront` (counters, morale -50) |
| ship destroyed | `$46CC` | `Fleet.destroyShip`: type counters, `$14294`++, morale -100 (not for type 17) |
| ship leaves the map (to the front) | `$4672` | `$1427C[class]`++, `$46CC` (so morale -100 as well), `$14294`-- |

## 5. Ships and missiles (`$42BE`, `$4526`, `$4408`) [V]

Ship modes: 0 landed, 1 hovering; 2 / 5 fly, on arrival (or when holding) start landing (mode 8, or hover if the cell word & $5000); 3 fly, on arrival hover;
4 on a pad tile ($48) land; 6 fly then mode = +$11; 7 climb 2 per pass to lift $22, then mode = +$11 (turns every 8 lift units); 8 descend 2 per pass, at lift <= 0
land (dir 8, ground mark + flag 2, fuel -4 below $8000). `shipMove` returns 0 when holding / on the target and -1 while moving. The front is the off-map cell
`$135C4/$135C5`. Extra ship state (velocity, next mode, turn, reserved cell, missile target) is kept in a WeakMap, the `Ship` record of sim-ships.ts has no room.

Missiles (ship list type 17): mode 4 climbs 4 per pass to $22, then flies (mode 1) towards the enemy, re-aimed at each cell centre; within +-1 of the enemy a ground
target freezes (mode 5) and the missile goes to mode 2 and descends 4 per pass before both explode; an aircraft is hit at once; a vanished target removes the missile
silently. `findTarget` (`$12456`): range 20 (small launcher, tile $30) or 100; crushers and kamikazes are returned at once, otherwise the last enemy found (ground
list first, then air); the result is kept as the launch target (`$E904`).

## 6. Guns `$11D34` [V]

Skipped when the power level `$144C8` >= $10. Gun A = tile $1F, damage `long($1310E)`, fires at the half-day moment (frame countdown `$14590` == $2D); gun B = tile
$0F, damage `long($13112)`, fires once per day. Per record with tile = the gun tile and byte +3 = $FF the timer +7 is decremented; at 1 the flash is removed (tile -8);
below 0 the gun looks along its arc (table `$12A96`, 8 facings x 32 cells; rotation = record +2): the first 8 cells stop at the map border or an active building, A
looks 8 further cells, B 24 further (border stops only); an enemy within +-1 of a flagged cell is hit (destroyed at hp <= 0), timer +7 = 3, tile +8, +6 = 0, hit sound.
No target: the gun turns by its +6 step (the tile low byte follows). The port detects the two events from the frame countdown in `EnemySystem.frame()`.

## 7. Repair and defection [V / H]

`$12510`: weekly hp += tech/2 for own tanks, capped at the base value 8 of table `$4B76` (so a tech-boosted tank drops to 8; original quirk, kept; ships are healed by
`Fleet.weeklyRepair`). Event 17 (defection): the counters are updated by `Aliens.eventTankDefect`; the hook turns the first own tank into an idle enemy ground unit
of the same type [H: its damage is the tank's own `$145A3`].

## 8. Port and open points

`enemies.ts`: `EnemySystem(sim, units, CombatTables, hooks)` with `spawn`, `defect`, `repair`, `pass(clock)`, `tankCombat`, `tankLeft`, `orderShip`, `sendShipToFront`,
`findTarget`, `launchMissile`, `fireGuns`, `frame`, `overview`, `drawables`. Wired in `map.ts` (hooks `spawnEnemy`, `defectUnit`, `repairUnits`, explosion sprite + sound) and
`game.ts` (`otherUnits` for the overview, `findTarget` / `launchMissile` for the missile launcher window). Sprite sets differ per scenario (the crusher, type 24, exists
in scenarios 3, 5 and 7 only; 27 in 3, 5, 6). Test: `test/enemies.mjs`.

Open: the real pass rate; exact kamikaze dive altitude (`buildingHeight`); who calls `orderShip` (the ship order screens are not ported - only the movement machine is);
the exact explosion altitude for ships; whether a defected tank keeps shooting own units only.
