// Headless checks of the enemy / combat port (src/game/enemies.ts, src/data/combat.ts): enemy ground units and
// aircraft, attacks, own fire, the gun animation, missiles, ships and the bookkeeping. Run after `npm run build`.
// Uses the user's own game data in original/utopia-whdload (Disk.1 and Disk.2); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("enemy tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap, MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { loadCombatTables } = await import("../dist/data/combat.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World, T, TYPE_TABLE, TYPE_SIZE } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { UnitSystem, NO_TARGET } = await import("../dist/game/units.js");
const { cellFlagIndex } = await import("../dist/game/cell-flags.js");
const { EnemySystem, SHIP_ORDER, dirToward } = await import("../dist/game/enemies.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const tables = loadCombatTables(disk1);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const BLOCKED = 0x1000;
const OCCUPIED = 0x4000;
const ACTIVE = 0x0400;
const AIR = 0x2000;

// A world with the first scenario; `rng` fixes every roll (0 = every chance succeeds).
function fresh({ fixed = 0, tod = fixed === null ? 0 : fixed, raster = 0 } = {}) {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const bombs = [];
  const explosions = [];
  const sounds = [];
  const morale = [];
  const explodeResult = { value: undefined }; // what the explode hook reports (true = $1237C clobbered A6)
  const sim = new Sim(world, {
    rng: (range) => Math.min(fixed, range - 1),
    hardware: { todLow: () => tod, rasterParity: () => raster },
    demolishAt: (x, y) => bombs.push([x, y]),
    spawnEnemy: (s) => enemies.spawn(s),
    defectUnit: () => enemies.defect(),
    repairUnits: (n) => enemies.repair(n),
  });
  state.setByte(0x144c8, 0); // power level 0: the guns work
  const origMorale = sim.applyMorale.bind(sim);
  sim.applyMorale = (d) => {
    morale.push(d);
    origMorale(d);
  };
  const units = new UnitSystem(world.cells, () => 1, {
    lost: (u) => enemies.tankLeft(u),
    combat: (u, t) => enemies.tankCombat(u, t),
  }, world.cellFlags); // the production wiring (objects.ts): one flag array shared with the world and Fleet.createShip
  const enemies = new EnemySystem(sim, units, tables, {
    explode: (x, y, lift, high) => {
      if (explodeResult.value !== false) explosions.push({ x, y, lift, high });
      return explodeResult.value;
    },
    sound: (id) => sounds.push(id),
    buildingHeight: () => 20,
  });
  const run = (passes) => {
    for (let i = 0; i < passes; i++) {
      units.tick();
      enemies.pass(units.clock);
    }
  };
  return { state, world, sim, units, enemies, bombs, explosions, sounds, morale, run, cells: world.cells, explodeResult };
}

// A free 12x12 area of plain ground (no blocked, occupied or active cell) for movement tests.
function freeArea(world, size = 12) {
  for (let y = 4; y < MAP_HEIGHT - size - 4; y++) {
    for (let x = 4; x < MAP_WIDTH - size - 4; x++) {
      let ok = true;
      for (let dy = 0; dy < size && ok; dy++) {
        for (let dx = 0; dx < size; dx++) {
          if (world.cells[(y + dy) * MAP_WIDTH + x + dx] & (BLOCKED | OCCUPIED | ACTIVE | AIR)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { x, y };
    }
  }
  throw new Error("no free area");
}

function spawn(env, air, type, x, y, dir, entry) {
  const slots = air ? env.enemies.airSlots : env.enemies.groundSlots;
  const known = new Set(slots);
  const spawned = env.enemies.spawn({ air, type, x, y, dir, entry: entry ?? [0, 6, 0, 3, 0, 5, 50, 0] });
  if (!spawned) throw new Error("spawn failed");
  return slots.find((e) => e !== null && !known.has(e)); // the object that took the first free slot
}

// ---- tables read from the image --------------------------------------------------------------------------------

check("combat tables: spiral has 48 cells, the first right next to the unit", tables.spiral.length === 48 && Math.max(...tables.spiral[0].map(Math.abs)) === 1);
check("combat tables: all spiral cells distinct", new Set(tables.spiral.map((c) => c.join(","))).size === 48);
check("combat tables: 8 gun arcs of 32 cells", tables.arcs.length === 8 && tables.arcs.every((a) => a.length === 32));
check("combat tables: a gun arc runs outwards (8 cells deep)", Math.abs(tables.arcs[0][31][1]) === 8 && tables.arcs[0][0][1] === -1);
check("combat tables: turn table gives directions", tables.turn.length === 64 && tables.turn.every((d) => d >= 0 && d < 8));
check("combat tables: turning towards the same direction keeps it", [0, 1, 2, 3, 4, 5, 6, 7].every((d) => tables.turn[d * 8 + d] === d));
check("combat tables: crusher animation set", tables.crusherAnim.length === 8);
check("dirToward matches the compass of $11B70", dirToward(5, 5, 5, 3) === 0 && dirToward(5, 5, 7, 5) === 2 && dirToward(5, 5, 5, 9) === 4 && dirToward(5, 5, 2, 5) === 6 && dirToward(5, 5, 5, 5) === -1);

// ---- spawning and own fire -------------------------------------------------------------------------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const e = spawn(env, false, 22, x + 4, y + 4, 0);
  const i = (y + 4) * MAP_WIDTH + x + 4;
  check("ground enemy: occupies its cell (map bit and flag bit 0)", (env.cells[i] & OCCUPIED) !== 0 && (env.enemies.ground.length === 1) && (env.units.flags[cellFlagIndex(x + 4, y + 4)] & 1) === 1);
  check("ground enemy: record fields from the wave entry (hp 6, damage 3, bomb 50%)", e.hp === 6 && e.dmg === 3 && e.bombPct === 50 && e.mode === 6);
  const air = spawn(env, true, 25, x + 8, y + 8, 2, [0, 4, 0, 2, 0, 3, 40, 0]);
  const j = (y + 8) * MAP_WIDTH + x + 8;
  check("air enemy: air layer mark, flag bit 1, lift $22", (env.cells[j] & AIR) !== 0 && (env.units.flags[cellFlagIndex(x + 8, y + 8)] & 2) === 2 && air.lift === 0x22);
  check("overview lists the enemies", env.enemies.overview().enemyGround.length === 1 && env.enemies.overview().enemyAir.length === 1);
  check("drawables: one per enemy", env.enemies.drawables().length === 2);

  // an own tank two cells away shoots it on the move tick: damage byte $145A3
  env.state.setByte(0x145a3, 2);
  env.state.setWord(0x142a2, 1);
  const tank = env.units.spawn(9, x + 4, y + 2, 4);
  tank.hp = 8;
  e.mode = 5; // keep the target still
  e.dmg = 0; // and harmless
  const before = e.hp;
  env.run(9);
  check("own tank hits an enemy within reach on a move tick", e.hp < before, `hp ${before} -> ${e.hp}`);
  env.run(40);
  check("enemy killed by the tank: gone, cell released", env.enemies.ground.length === 0 && (env.cells[i] & OCCUPIED) === 0 && (env.units.flags[cellFlagIndex(x + 4, y + 4)] & 1) === 0);
  check("kill statistics and counters ($14298 +1, $142A2 -1)", env.state.long(0x14298) === 1 && env.state.word(0x142a2) === 0);
  check("destroyed ground unit explodes with the high blast, no morale change", env.explosions.some((e2) => e2.high && e2.x === x + 4) && env.morale.length === 0);
  check("hit sound played", env.sounds.includes(2));
}

// ---- the walker ---------------------------------------------------------------------------------------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const e = spawn(env, false, 22, x + 2, y + 2, 0);
  env.state.setWord(0x142a2, 1);
  env.run(1);
  check("walker: first step picks a target and goes to mode 1", e.mode === 1 && (e.targetX & 0x80) === 0);
  const [tx, ty] = [e.targetX, e.targetY];
  const d0 = Math.abs(tx - e.x) + Math.abs(ty - e.y);
  env.run(400);
  const d1 = Math.abs(e.targetX - e.x) + Math.abs(e.targetY - e.y);
  check("walker: moves (after the enemy tick it is stepped every pass), changes cell", e.x !== x + 2 || e.y !== y + 2 || d1 !== d0, `${x + 2},${y + 2} -> ${e.x},${e.y}  target ${tx},${ty}`);
  void d0;
}

// The enemy reads a separate CIA TOD approximation for the gate; only the bomb-percent check consumes Sim RNG.
{
  const env = fresh({ fixed: 0 });
  const rolls = [];
  env.sim.rng = (range) => (rolls.push(range), 0);
  const { x, y } = freeArea(env.world);
  env.cells[(y + 6) * MAP_WIDTH + x + 5] |= ACTIVE;
  const e = spawn(env, false, 22, x + 5, y + 5, 0);
  e.mode = 5;
  env.run(10);
  check("attack: enemy tick, an active cell within the 48 cells is bombed", env.bombs.length >= 1 && env.bombs[0][0] === x + 5 && env.bombs[0][1] === y + 6, JSON.stringify(env.bombs));
  check("attack: selected bomb coordinates are preserved in $142BA/$142BC before demolition", env.state.word(0x142ba) === x + 5 && env.state.word(0x142bc) === y + 6);
  check("attack: the attacker waits for the next enemy tick afterwards", e.waiting);
  check("attack: CIA gate consumes no Sim RNG draw; only bomb percentage uses range 100", rolls.join() === "100", `rolls ${rolls.join()}`);
}
{
  const env = fresh({ fixed: 0, tod: 25 }); // CIA values above 24 close the active-building gate
  const { x, y } = freeArea(env.world);
  env.cells[(y + 6) * MAP_WIDTH + x + 5] |= ACTIVE;
  const e = spawn(env, false, 22, x + 5, y + 5, 0);
  e.mode = 5;
  env.run(20);
  check("attack: gate closed, no bomb", env.bombs.length === 0);
}

// Event 17 defected tank: +$E is 10 (static trace $115C6; no emulator comparison). Connected through the real hook
// (Sim aliens event -> EnemySystem.defect) and the normal pass -> attack path.
{
  const COUNTER = 0x1346a;
  const defectedAttack = ({ tod, roll, passes }) => {
    const env = fresh({ fixed: 0, tod });
    const rolls = [];
    env.sim.rng = (range) => (rolls.push(range), range === 100 ? roll : 0);
    const { x, y } = freeArea(env.world);
    env.cells[(y + 6) * MAP_WIDTH + x + 5] |= ACTIVE;
    env.units.spawn(9, x + 5, y + 5, 0);
    env.state.setWord(0x1429c, 3);
    env.sim.aliens.eventTankDefect(100); // consumes one range-100 draw (roll < 100: defects)
    const g = env.enemies.ground[0];
    const eventRolls = rolls.length;
    const msgs = env.sim.messages.slice();
    const before = env.state.word(COUNTER);
    for (let i = 0; i < passes && env.bombs.length === 0; i++) env.run(1);
    return { env, g, bombs: env.bombs.length, bombed: env.state.word(COUNTER) - before, msgs, rolls: rolls.slice(eventRolls) };
  };
  const hit = defectedAttack({ tod: 0, roll: 9, passes: 20 });
  check("defect event: converted tank has bomb chance 10 and its own damage", !!hit.g && hit.g.type === 9 && hit.g.bombPct === 10 && hit.g.dmg === hit.env.state.byte(0x145a3));
  check("defect event: counters moved and message 0x181 posted once", hit.env.state.word(0x1429c) === 2 && hit.env.state.word(0x142a2) === 1 && hit.msgs.join() === "385");
  check("defect event: TOD 0 + roll 9 bombs the active building and counts $1346A", hit.bombs === 1 && hit.bombed === 1 && hit.env.bombs[0][0] === hit.env.enemies.ground[0].x && hit.rolls.every((r) => r === 100) && hit.rolls.length >= 1, JSON.stringify(hit.env.bombs));
  check("defect event: bombing posts no further message", hit.env.sim.messages.join() === "385");
  const miss = defectedAttack({ tod: 0, roll: 10, passes: 20 });
  check("defect event: TOD 0 + roll 10 (not below 10) does not bomb", miss.rolls.length >= 1 && miss.bombs === 0 && miss.bombed === 0 && miss.env.sim.messages.join() === "385");
  const gated = defectedAttack({ tod: 25, roll: 0, passes: 20 });
  check("defect event: TOD 25 closes the gate before any percentage draw", gated.rolls.length === 0 && gated.bombs === 0 && gated.bombed === 0 && gated.env.sim.messages.join() === "385");
}

// Static Disk.1 trace: a defected type-9/10 unit reaches the shared $1266A attack routine, which can also damage
// nearby own units; it is not limited to the active-building bomb branch.
{
  const env = fresh({ tod: 25 }); // close the building-bomb gate; direct unit attacks remain eligible
  const { x, y } = freeArea(env.world);
  env.state.setByte(0x145a3, 2); // copied into the converted enemy's +$F damage byte
  const former = env.units.spawn(9, x + 5, y + 5, 0);
  const target = env.units.spawn(10, x + 5, y + 6, 0);
  target.hp = 7;
  env.state.setWord(0x1429c, 2);
  const converted = env.enemies.defect();
  const defector = env.enemies.groundSlots[0];
  const hpBefore = target.hp;
  for (let i = 0; i < 4; i++) env.run(1);
  check("defection preserves the source cell and converts only the first tank", !!converted && converted.x === former.x && converted.y === former.y &&
    !env.units.units.includes(former) && env.units.units.includes(target) && defector?.type === 9 && defector.mode === 0x7f && defector.waiting);
  check("defected tank's shared attack path damages a nearby own tank on the enemy tick", !!defector && defector.waiting &&
    target.hp === hpBefore - defector.dmg && defector.dmg === 2 && env.bombs.length === 0);
}

// an enemy hits an own tank; the tank dies ($4692: counters, statistic, morale -50)
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const tank = env.units.spawn(10, x + 5, y + 6, 0);
  tank.hp = 3;
  env.state.setWord(0x1429c, 1);
  env.state.setLong(0x14258, 1);
  const e = spawn(env, false, 22, x + 5, y + 5, 0, [0, 6, 0, 4, 0, 5, 50, 0]);
  e.mode = 5;
  env.run(10);
  check("attack: an enemy kills a tank next to it", env.units.units.length === 0);
  check("tank destroyed: $1429C and the type counter drop, $14294 +1, morale -50", env.state.word(0x1429c) === 0 && env.state.long(0x14258) === 0 && env.state.long(0x14294) === 1 && env.morale.includes(-50));
  check("tank cell released", (env.cells[(y + 6) * MAP_WIDTH + x + 5] & OCCUPIED) === 0 && env.units.flags[cellFlagIndex(x + 5, y + 6)] === 0);
}

// ---- aircraft -----------------------------------------------------------------------------------------------------

{
  const env = fresh();
  // fly straight off the map to the north: mode 3 with direction 0
  const a = spawn(env, true, 25, 50, 3, 0);
  a.mode = 3;
  env.state.setWord(0x142a4, 1);
  env.run(400);
  check("bomber leaving the map: gone, $142A4 -1, +50 morale", env.enemies.air.length === 0 && env.state.word(0x142a4) === 0 && env.morale.includes(50));
  check("air layer mark and flag cleared", env.cells.every((w) => !(w & AIR)) && env.units.flags.every((f) => !(f & 2)));
}
{
  // the bomber drops its bombs on an active cell below it; with roll 0 every attempt succeeds
  const env = fresh({ fixed: 0 });
  const { x, y } = freeArea(env.world);
  for (let dy = 0; dy < 12; dy++) for (let dx = 0; dx < 12; dx++) env.cells[(y + dy) * MAP_WIDTH + x + dx] |= ACTIVE;
  const a = spawn(env, true, 25, x + 6, y + 6, 2, [0, 4, 0, 2, 0, 3, 100, 0]);
  a.mode = 1;
  a.targetX = x + 11;
  a.targetY = y + 6;
  env.run(300);
  check("bomber: bombs active cells it flies over", env.bombs.length >= 1);
  check("bomber: after its attacks the aircraft step leaves +$9 bit 7 clear (bclr after $1266A, enemies.md 3d)", env.bombs.length >= 1 && a.waiting === false, `waiting ${a.waiting}`);
}
// Target pick with no building record (enemies.md section 3d): $119AC returns +B = $FF and sets mode 1, the walk step
// returns on a negative +B, and the next pass sends the unit back to mode 6, so it picks again. One draw per pick.
{
  const env = fresh({ fixed: 0 });
  env.world.objects.fill(0); // no used object record: the scan runs out
  const rolls = [];
  env.sim.rng = (range) => (rolls.push(range), 0);
  const { x, y } = freeArea(env.world);
  const g = spawn(env, false, 22, x + 5, y + 5, 0);
  g.mode = 6;
  env.run(1);
  check("target pick miss (walker): mode 1 with +B = $FF", g.mode === 1 && g.targetX === NO_TARGET, `mode ${g.mode} tx ${g.targetX}`);
  check("target pick miss (walker): one draw, range min($142C2, $FE)", rolls.length === 1 && rolls[0] === Math.min(env.state.word(0x142c2), 0xfe), rolls.join());
  env.run(1);
  check("target pick miss (walker): the walk step ignores the cleared target and the unit returns to mode 6, cell unchanged", g.mode === 6 && g.x === x + 5 && g.y === y + 5, `mode ${g.mode}`);
  const c = spawn(env, false, 24, x + 8, y + 8, 2);
  c.mode = 6;
  c.steps = 7;
  env.run(1);
  check("target pick miss (crusher): +D cleared, mode 1, +B = $FF", c.steps === 0 && c.mode === 1 && c.targetX === NO_TARGET);
  env.run(1);
  check("target pick miss (crusher): +D counts the step, the cleared target sends it back to mode 6", c.steps === 1 && c.mode === 6, `steps ${c.steps} mode ${c.mode}`);
}
{
  // kamikaze: dives onto an active building and detonates it
  const env = fresh({ fixed: 0 });
  const target = env.sim.randomBuilding();
  if (target) {
    const [bx, by] = target;
    env.cells[by * MAP_WIDTH + bx] |= ACTIVE;
    const k = spawn(env, true, 26, Math.max(0, Math.min(MAP_WIDTH - 1, bx + 4)), by, 6);
    env.state.setWord(0x142a4, 1);
    env.run(600);
    check("kamikaze: dives, detonates, the target cell is bombed, aircraft gone", env.bombs.some(([bx2, by2]) => bx2 === bx && by2 === by) && !env.enemies.air.includes(k), JSON.stringify(env.bombs));
    check("kamikaze: +50 morale and an explosion at altitude", env.morale.includes(50));
  } else {
    check("kamikaze: scenario has a building", false);
  }
}
{
  // kamikaze dive height (enemies.md section 3c): the hook receives the tile word of the picked object RECORD, not the
  // map cell, and +$13 = (stored rows - 1) - 10 as a byte. Every building cell is given its gun-flash tile (+8) so a
  // cell read would give the wrong tile; with the RNG fixed at 0 the pick is the first non-empty record.
  const env = fresh({ fixed: 0 });
  const o = env.world.objects;
  let first = null;
  for (let at = 0; at < o.length; at += 8) {
    const tile = (o[at] << 8) | o[at + 1];
    if (tile === 0) continue;
    const index = o[at + 5] * MAP_WIDTH + o[at + 4];
    if (!first) first = { x: o[at + 4], y: o[at + 5], tile };
    env.cells[index] = (env.cells[index] & ~0xff) | ((tile + 8) & 0xff);
  }
  if (!first) {
    check("kamikaze dive height: scenario has a building record", false);
  } else {
    const cellTile = env.cells[first.y * MAP_WIDTH + first.x] & 0xff;
    const seen = [];
    env.enemies.hooks.buildingHeight = (tile) => {
      seen.push(tile);
      return 30; // stored rows - 1
    };
    const k = spawn(env, true, 26, Math.max(0, Math.min(MAP_WIDTH - 1, first.x + 4)), first.y, 6);
    k.mode = 6;
    for (let i = 0; i < 200 && seen.length === 0; i++) env.run(1);
    check("kamikaze dive height: the hook gets the record's tile word, not the flashing map cell",
      seen.length >= 1 && seen[0] === first.tile && cellTile !== first.tile, `record=${first.tile} cell=${cellTile} seen=${seen.join(",")}`);
    check("kamikaze dive height: +$13 = stored - 10 (20 for a stored 30)", k.aux === 20, `aux=${k.aux}`);
  }
}

// ---- crusher --------------------------------------------------------------------------------------------------------

{
  const env = fresh({ fixed: 0 });
  const { x, y } = freeArea(env.world);
  env.cells[(y + 6) * MAP_WIDTH + x + 8] |= ACTIVE;
  const c = spawn(env, false, 24, x + 6, y + 6, 2);
  c.mode = 1;
  c.targetX = x + 10;
  c.targetY = y + 6;
  let moves = 0;
  let lastX = c.x;
  const seen = new Set([c.counter]);
  const counterSequence = [c.counter];
  let animOk = true;
  for (let i = 0; i < 300 && env.enemies.ground.includes(c); i++) {
    env.run(1);
    if (c.x !== lastX) moves++;
    lastX = c.x;
    if (!seen.has(c.counter)) { seen.add(c.counter); counterSequence.push(c.counter); animOk = animOk && c.anim === tables.crusherAnim[c.counter]; }
  }
  check("crusher: walks, crossing an active cell and bombing it", env.bombs.some(([bx, by]) => bx === x + 8 && by === y + 6) && moves > 0, JSON.stringify(env.bombs));
  check("crusher: the step counter decreases modulo 8 and +$14 follows table $12D60", counterSequence.length > 1 &&
    counterSequence.every((n, i) => n >= 0 && n < 8 && (i === 0 || n === ((counterSequence[i - 1] + 7) & 7))) && animOk, counterSequence.join());
}

// ---- defect and repair ----------------------------------------------------------------------------------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const t = env.units.spawn(9, x + 3, y + 3, 4);
  t.hp = 7;
  const cell = env.enemies.defect();
  check("defect: returns the cell, the tank becomes an enemy ground unit", cell && cell.x === x + 3 && cell.y === y + 3 && env.units.units.length === 0 && env.enemies.ground.length === 1);
  const g9 = env.enemies.ground[0];
  check("defected tank keeps its type; a fresh tank's waiting bit and raw mode carry over (control $FF)", g9.type === 9 && g9.waiting && g9.mode === 0x7f);
  env.run(1); // clock sub-tick 1: the enemy pass skips a waiting record off the enemy tick
  check("waiting defected tank does not spin before the enemy tick", g9.dir === 4 && g9.waiting);
  env.run(3); // sub-tick 4: the enemy tick clears the wait and steps it once
  check("waiting defected tank spins on its first enemy tick", g9.dir === 3 && !g9.waiting);
  check("defect: no tank, no defection", env.enemies.defect() === null);
}

// Event 17 copy ($115BA-$115FE, enemies.md 7): what the converted record takes from the tank and what it does to the
// flag and map bytes. The tank's own reservation and map bit are not released; only the flag byte (bit 2 off, bit 0 on)
// of the tank's (x, y) is written, and +$16 names that cell.
{
  const FLAG_GROUND = 1, FLAG_OWN = 4;
  const POINTER_BASE = 0x3d3a6; // $3D3A6 + y * $66 + x (the flag byte of cell (x, y))
  const pointerOf = (cx, cy) => POINTER_BASE + cy * 102 + cx;
  // A non-waiting, moving tank: copies the pixel offset, facing, hit points, tech, target; velocity is cleared.
  {
    const env = fresh();
    const { x, y } = freeArea(env.world);
    const t = env.units.spawn(10, x + 3, y + 3, 6);
    t.dx = 3; t.dy = -2; t.vx = 2; t.vy = -1; t.hp = 6; t.tech = 2; t.targetX = x + 9; t.targetY = y + 1;
    t.control = 0x7f; // not waiting (the first move tick already cleared bit 7)
    env.state.setByte(0x145a3, 4);
    env.enemies.defect();
    const g = env.enemies.ground[0];
    check("defect copy: type 10, cell, facing, hit points and tech come from the tank", g.type === 10 && g.x === x + 3 && g.y === y + 3 && g.dir === 6 && g.hp === 6 && g.tech === 2);
    check("defect copy: pixel offset (+3/+4) is kept, velocity (+6/+7) cleared, target (+B/+C) kept", g.dx === 3 && g.dy === -2 && g.vx === 0 && g.vy === 0 && g.targetX === x + 9 && g.targetY === y + 1);
    check("defect copy: non-waiting tank gives a non-waiting record, mode $7F, +$E 10, +$F $145A3, steps 0", !g.waiting && g.mode === 0x7f && g.bombPct === 10 && g.dmg === 4 && g.steps === 0);
    check("defect copy: flag byte of (x, y) loses bit 2 and gains bit 0; +$16 names (x, y)", (env.world.cellFlags[cellFlagIndex(x + 3, y + 3)] & (FLAG_OWN | FLAG_GROUND)) === FLAG_GROUND && env.enemies.groundFlagPointers[0] === pointerOf(x + 3, y + 3) && g.reserveX === x + 3 && g.reserveY === y + 3);
    env.run(1); // non-waiting: the first pass steps it at once
    check("defect copy: a non-waiting defected tank spins on the first pass", g.dir === 5 && !g.waiting);
  }
  // A stationary tank holds bit 14 on its own cell (units.md 5): the converted cell keeps it.
  {
    const env = fresh();
    const { x, y } = freeArea(env.world);
    env.units.spawn(9, x + 3, y + 3, 0);
    env.enemies.defect();
    check("defect stationary: the cell keeps bit 14 (occupied) and the flag is ground, not own", (env.cells[(y + 3) * MAP_WIDTH + x + 3] & OCCUPIED) !== 0 && (env.world.cellFlags[cellFlagIndex(x + 3, y + 3)] & (FLAG_OWN | FLAG_GROUND)) === FLAG_GROUND);
  }
  // A tank between cells: its reservation is the NEXT cell, which keeps the tank's marks (the original does not release them).
  {
    const env = fresh();
    const { x, y } = freeArea(env.world);
    const t = env.units.spawn(9, x + 3, y + 3, 2);
    const nx = x + 4;
    // mid-move: the tank started towards (x+4, y+3): departure cell released, next cell reserved
    env.cells[(y + 3) * MAP_WIDTH + x + 3] &= ~OCCUPIED;
    env.world.cellFlags[cellFlagIndex(x + 3, y + 3)] &= ~FLAG_OWN;
    env.cells[(y + 3) * MAP_WIDTH + nx] |= OCCUPIED;
    env.world.cellFlags[cellFlagIndex(nx, y + 3)] |= FLAG_OWN;
    t.reserveX = nx;
    t.reserveY = y + 3;
    env.enemies.defect();
    const g = env.enemies.ground[0];
    check("defect mid-move: the converted record names the departure cell (x, y), not the reservation", g.x === x + 3 && g.y === y + 3 && env.enemies.groundFlagPointers[0] === pointerOf(x + 3, y + 3) && g.reserveX === x + 3);
    check("defect mid-move: the reserved cell keeps its bit 14 and own-unit flag (not released)", (env.cells[(y + 3) * MAP_WIDTH + nx] & OCCUPIED) !== 0 && (env.world.cellFlags[cellFlagIndex(nx, y + 3)] & FLAG_OWN) !== 0);
    check("defect mid-move: no map bit 14 is set on the departure cell; its flag is ground", (env.cells[(y + 3) * MAP_WIDTH + x + 3] & OCCUPIED) === 0 && env.world.cellFlags[cellFlagIndex(x + 3, y + 3)] === FLAG_GROUND);
  }
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const t = env.units.spawn(9, x + 3, y + 3, 0);
  t.hp = 2;
  env.enemies.repair(3);
  check("repair: hit points rise by the amount", t.hp === 5);
  env.enemies.repair(10);
  check("repair: capped at 8", t.hp === 8);
}

// ---- guns ($11D34) ---------------------------------------------------------------------------------------------------

function addGun(env, tile, x, y, facing, timer = 0, rotate = 0) {
  const type = env.world.findType(tile);
  const typeAt = env.world.typeAddress(type);
  const slot = env.world.objectCount++;
  const at = slot * 8;
  env.world.objects[at] = tile >> 8;
  env.world.objects[at + 1] = tile & 0xff;
  env.world.objects[at + 2] = facing;
  env.world.objects[at + 3] = 0xff;
  env.world.objects[at + 4] = x;
  env.world.objects[at + 5] = y;
  env.world.objects[at + 6] = rotate;
  env.world.objects[at + 7] = timer;
  // $11D34's DBRA budget is T[type].+$C, so this staged completed object must be counted.
  env.state.setWord(typeAt + T.total, env.state.word(typeAt + T.total) + 1);
  env.state.setWord(typeAt + T.active, env.state.word(typeAt + T.active) + 1);
  env.cells[y * MAP_WIDTH + x] = (env.cells[y * MAP_WIDTH + x] & ~0xff) | (tile + facing);
  return at;
}

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const gx = x + 6;
  const gy = y + 6;
  const at = addGun(env, 0x1f, gx, gy, 2, 0);
  const [ax, ay] = tables.arcs[2][4];
  const e = spawn(env, false, 22, gx + ax, gy + ay, 0, [0, 9, 0, 3, 0, 5, 50, 0]);
  e.mode = 5;
  env.fireGunsDamage = 5;
  env.enemies.fireGuns(0x1f, 5);
  check("gun A: fires at an enemy inside its arc: damage applied", e.hp === 4, `hp ${e.hp}`);
  check("gun A: timer reset to 3, flash tile (+8), hit sound", env.world.objects[at + 7] === 3 && (env.cells[gy * MAP_WIDTH + gx] & 0xff) === 0x1f + 2 + 8 && env.sounds.includes(2));
  env.enemies.fireGuns(0x1f, 5);
  check("gun A: timer counts down between shots", env.world.objects[at + 7] === 2 && e.hp === 4);
  env.enemies.fireGuns(0x1f, 5);
  check("gun A: the flash ends when the timer reaches 1", env.world.objects[at + 7] === 1 && (env.cells[gy * MAP_WIDTH + gx] & 0xff) === 0x1f + 2);
  env.enemies.fireGuns(0x1f, 5);
  env.enemies.fireGuns(0x1f, 5);
  check("gun A: kills the enemy when its hit points run out, explosion and counters", env.enemies.ground.length === 0 && env.explosions.length >= 1);
}
// Bounded live-original comparison (Copperline 1.0.1, A1200/AGA PAL, RAM-STAGED fixture, not a natural game state): one
// finished Gun A at (50,34) facing 4, T[5]+$C ($13248) = 1, stationary crusher (type 24) one cell below at (50,35), hp 8,
// damage 5 ($1310E). Observed after each Gun A period: gun timer 3,2,1,0,3; target hp 8 -> 3 -> (unchanged) -> destroyed on
// the 5th round; tile low byte $27 after the shot, back to $1F once the timer reached 1; ground count 1 -> 0. The wall-clock
// part (latch every 90 VBL, $14590 = 45 at the latch) is covered by test/map-loop.mjs and the Sim schedule tests. The
// original left the map-word occupancy bit of the target cell set after the kill (flag byte cleared); that is NOT asserted
// here, see notes/formats/enemies.md section 6 (open point).
{
  const env = fresh();
  const [ax, ay] = tables.arcs[4][0];
  const { x, y } = freeArea(env.world);
  const gx = x + 3;
  const gy = y + 3;
  const at = addGun(env, 0x1f, gx, gy, 4, 0);
  env.cells[gy * MAP_WIDTH + gx] = (env.cells[gy * MAP_WIDTH + gx] & ~0xff) | 0x1f; // the staged word held the bare tile $1F
  const budgetAt = TYPE_TABLE + TYPE_SIZE * 5 + T.total;
  env.state.setWord(budgetAt, 1); // the staged T[5]+$C scan budget ($13248)
  const e = spawn(env, false, 24, gx + ax, gy + ay, 0, [0, 8, 0, 5, 0, 5, 50, 0]);
  e.mode = 5;
  const timers = [];
  const hps = [];
  const lows = [];
  for (let round = 0; round < 5; round++) {
    env.enemies.fireGuns(0x1f, 5);
    timers.push(env.world.objects[at + 7]);
    hps.push(env.enemies.groundSlots[0] ? e.hp : null);
    lows.push(env.cells[gy * MAP_WIDTH + gx] & 0xff);
  }
  check("live Gun A cycle: the gun timer after the five rounds is 3,2,1,0,3", timers.join() === "3,2,1,0,3", timers.join());
  check("live Gun A cycle: target hp 8 -> 3, held for three rounds, destroyed on the fifth", hps.join() === "3,3,3,3," && e.hp === -2 /* null (slot freed) joins as empty */, `${hps.join()} hp ${e.hp}`);
  check("live Gun A cycle: tile flash $27 after the shot, reverted to $1F at timer 1, flashed again by the kill shot", lows.join() === "39,39,31,31,39", lows.join());
  check("live Gun A cycle: ground count 0 and the flag byte of the target cell cleared", env.enemies.groundSlots[0] === null && env.state.word(0x142a2) === 0 && (env.units.flags[cellFlagIndex(gx + ax, gy + ay)] & 1) === 0);
  env.state.setWord(budgetAt, 0);
  env.enemies.fireGuns(0x1f, 5);
  check("live Gun A cycle: with the scan budget T[5]+$C back at 0 the gun is not visited (timer unchanged)", env.world.objects[at + 7] === 3);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const at = addGun(env, 0x0f, x + 6, y + 6, 0, 0, 1);
  env.enemies.fireGuns(0x0f, 10);
  check("gun B without a target turns by its +6 step", env.world.objects[at + 2] === 1 && (env.cells[(y + 6) * MAP_WIDTH + x + 6] & 0xff) === 0x0f + 1);
  env.state.setByte(0x144c8, 0x10);
  env.enemies.fireGuns(0x0f, 10);
  check("guns are dead on a power failure (level >= $10)", env.world.objects[at + 2] === 1);
}
{
  const env = fresh();
  // $99C4 passes the fixed T[5] row address for Gun A. Its tile column is not needed by $11D34 and may be
  // absent from a scenario's type table when there are no such buildings.
  const gunA = TYPE_TABLE + TYPE_SIZE * 5;
  env.state.setWord(gunA + T.tile, 0);
  env.state.setWord(gunA + T.total, 0);
  let threw = false;
  try { env.enemies.fireGuns(0x1f, 20); } catch { threw = true; }
  check("Gun A reads fixed T[5].+$C and safely returns when the scenario has no matching type tile", !threw && env.state.word(gunA + T.total) === 0);
}
{
  const env = fresh();
  const shots = [];
  env.enemies.fireGuns = (tile) => shots.push(tile);
  env.state.setByte(A.frameCountdown, 0x30);
  for (let i = 0; i < 3; i++) env.sim.countFrame();
  check("gun A schedule: VBL value $2D latches pending bit 4 without firing", env.state.byte(A.frameCountdown) === 0x2d && (env.state.byte(A.pending) & 0x10) !== 0 && shots.length === 0);
  env.sim.loopPass();
  check("gun A schedule: $99C4 consumes bit 4 exactly once", shots.join() === "31" && (env.state.byte(A.pending) & 0x10) === 0);
  env.sim.run();
  check("gun A schedule: consumed latch does not repeat", shots.length === 1);
}
{
  const env = fresh();
  const shots = [];
  env.enemies.fireGuns = (tile) => shots.push(tile);
  env.state.setByte(A.frameCountdown, 0x2d);
  env.sim.paused = true;
  env.sim.countFrame();
  check("paused VBL at $2D sets the latch while leaving the countdown frozen", env.state.byte(A.frameCountdown) === 0x2d && (env.state.byte(A.pending) & 0x10) !== 0);
  env.sim.run();
  check("paused simulation retains the pending gun round", shots.length === 0 && (env.state.byte(A.pending) & 0x10) !== 0);
  env.sim.paused = false;
  env.sim.run();
  check("resume consumes the latched gun round", shots.join() === "31" && (env.state.byte(A.pending) & 0x10) === 0);
}
{
  const env = fresh();
  const shots = [];
  env.enemies.fireGuns = (tile) => shots.push(tile);
  env.state.setByte(A.frameCountdown, 2);
  env.sim.countFrame();
  env.sim.countFrame();
  env.sim.loopPass();
  check("daily gun B runs once when the queued day becomes the daily bit", shots.join() === "15" && (env.state.byte(A.pending) & 1) === 0, shots.join());
}
{
  const env = fresh();
  const order = [];
  env.enemies.fireGuns = (tile) => order.push(`gun${tile.toString(16)}`);
  env.sim.fleet.dailyFuel = () => order.push("ACE2");
  env.state.setByte(A.pending, 0x11); // special then daily
  env.sim.run();
  check("$99C4 order: gun A, daily gun B, then $ACE2", order.join(",") === "gun1f,gunf,ACE2", order.join(","));
}

// ---- map occupancy after a kill ($11C5C / $11C30 -> $4732 -> $1237C A6 clobber, enemies.md section 6) ---------------------

for (const air of [false, true]) {
  const kind = air ? "air" : "ground";
  const layer = air ? AIR : OCCUPIED;
  const flagBit = air ? 2 : 1;
  const setup = (result) => {
    const env = fresh();
    env.explodeResult.value = result;
    const { x, y } = freeArea(env.world);
    const e = spawn(env, air, air ? 25 : 22, x + 4, y + 4, 0);
    e.mode = 5;
    // Reservation cell: a flagged copy on the unit's own cell (spawn marks the map; the flag byte is set here).
    env.units.flags[cellFlagIndex(e.reserveX, e.reserveY)] |= flagBit;
    return { env, e, i: e.reserveY * MAP_WIDTH + e.reserveX, f: cellFlagIndex(e.reserveX, e.reserveY) };
  };

  {
    const { env, e, i, f } = setup(true); // would clobber, but there is no explosion
    check(`${kind} fixture: map bit set before the kill`, (env.cells[i] & layer) !== 0 && (env.units.flags[f] & flagBit) !== 0);
    air ? env.enemies.destroyAir(e, false) : env.enemies.destroyGround(e, false);
    check(`${kind} kill without explosion: map bit and flag cleared, hook not called`, (env.cells[i] & layer) === 0 && (env.units.flags[f] & flagBit) === 0 && env.explosions.length === 0);
  }
  {
    const { env, e, i, f } = setup(true); // $1237C clobbered A6 (off-view sound, or in-view effect allocated)
    air ? env.enemies.destroyAir(e, true) : env.enemies.destroyGround(e, true);
    check(`${kind} explosive kill, hook clobbers A6: map bit stays set, flag cleared, slot and counts updated`,
      (env.cells[i] & layer) !== 0 && (env.units.flags[f] & flagBit) === 0 && env.explosions.length === 1 &&
      (air ? env.enemies.airSlots : env.enemies.groundSlots).every((s) => s === null) && env.state.long(0x14298) === 1);
  }
  {
    const { env, e, i, f } = setup(false); // effect list full: $1237C returns without touching A6
    air ? env.enemies.destroyAir(e, true) : env.enemies.destroyGround(e, true);
    check(`${kind} explosive kill, effect list full (no clobber): no effect/sound, map bit and flag cleared`,
      (env.cells[i] & layer) === 0 && (env.units.flags[f] & flagBit) === 0 && env.explosions.length === 0);
  }
}

// ---- ship destruction blast ($46CC -> $4732 -> $1237C, enemies.md 6 and ship-control.md 5e) -----------------------------------
// $4732 blasts at the ship (lift as the height, high sound) before $46CC's bclr of the map bit, which goes through the A6
// the blast left behind; the flag bit at +$14 is always freed. Statically traced; no live ship capture.

{
  const FLAG_OWN = 4, FLAG_SHIP = 8;
  const shipEnv = (result, { airborne = false } = {}) => {
    const env = fresh();
    env.explodeResult.value = result;
    const { x, y } = freeArea(env.world);
    const cx = x + 4, cy = y + 4;
    const ship = env.sim.fleet.createShip(12, cx, cy, 8); // yard-built: occupied cell, own flag, +$14 = this cell
    ship.fuel = 100;
    if (airborne) {
      env.enemies.commandShip(ship, SHIP_ORDER.hover, null); // $4152: ground marks move to the air layer
      ship.lift = 0x22; // a climbed ship (the climb itself is not stepped here)
      ship.mode = 1;
    }
    return { env, ship, cx, cy, i: cy * MAP_WIDTH + cx, f: cellFlagIndex(cx, cy) };
  };
  const occ = (s) => (s.env.cells[s.i] & OCCUPIED) !== 0;
  const air = (s) => (s.env.cells[s.i] & AIR) !== 0;
  const flagOwn = (s) => (s.env.units.flags[s.f] & FLAG_OWN) !== 0;
  const flagShip = (s) => (s.env.units.flags[s.f] & FLAG_SHIP) !== 0;

  {
    const s = shipEnv(true);
    check("ship fixture: landed ship holds its occupancy bit and own flag", occ(s) && flagOwn(s));
    s.env.enemies.destroyShip(s.ship, true);
    check("landed ship destroyed with an explosion that clobbers A6: one high blast at the ship (lift 0), map bit STAYS, own flag freed",
      s.env.explosions.length === 1 && s.env.explosions[0].lift === 0 && s.env.explosions[0].high === true && occ(s) && !flagOwn(s) &&
      s.env.enemies.groundSlots.length === 60 && s.env.sim.fleet.slots.every((x) => x !== s.ship));
  }
  {
    const s = shipEnv(false);
    s.env.enemies.destroyShip(s.ship, true);
    check("landed ship, explosion that does not clobber A6 (effect list full): nothing recorded, map bit and own flag freed",
      s.env.explosions.length === 0 && !occ(s) && !flagOwn(s));
  }
  {
    const s = shipEnv(true);
    s.env.enemies.destroyShip(s.ship, false);
    check("landed ship, no explosion: no blast, map bit and own flag freed", s.env.explosions.length === 0 && !occ(s) && !flagOwn(s));
  }
  {
    const s = shipEnv(true, { airborne: true });
    check("airborne fixture: take-off moved the marks to the air layer and the ship flag", air(s) && flagShip(s) && !occ(s) && !flagOwn(s));
    s.env.enemies.destroyShip(s.ship, true);
    check("airborne ship destroyed with a clobbering blast: blast at lift $22 (high), air mark STAYS, ship flag freed",
      s.env.explosions.length === 1 && s.env.explosions[0].lift === 0x22 && s.env.explosions[0].high === true && air(s) && !flagShip(s));
  }
  {
    const s = shipEnv(false, { airborne: true });
    s.env.enemies.destroyShip(s.ship, true);
    check("airborne ship, explosion with no clobber: air mark and ship flag freed", !air(s) && !flagShip(s));
  }
  {
    // Fleet-owned destruction: $ACE2 sets bit 5 and $46CC blasts with the ship's lift (not the bomb blast at lift 0).
    const s = shipEnv(false, { airborne: true });
    const blasts = [];
    const messages0 = s.env.sim.messages.length;
    s.env.sim.bindRuntimeHooks({ blast: (x, y, lift, high) => (blasts.push([x, y, lift, high]), true) });
    s.ship.fuel = 1; // one hovering burn empties it
    s.env.sim.fleet.dailyFuel();
    check("fuel out ($ACE2): one blast at the ship with its lift and the high volume, message $40",
      blasts.length === 1 && blasts[0].join() === `${s.cx},${s.cy},34,true` && s.env.sim.messages.slice(messages0).includes(0x40) && s.env.sim.fleet.slots.every((x) => x !== s.ship));
    check("fuel out with a clobbering blast: air mark STAYS, ship flag freed", air(s) && !flagShip(s));
  }
}

// ---- missiles and ships ---------------------------------------------------------------------------------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const e = spawn(env, false, 22, x + 10, y + 2, 0);
  e.mode = 5;
  const found = env.enemies.findTarget(20, x + 2, y + 2);
  check("findTarget: finds an enemy within range", found && found.x === x + 10 && found.y === y + 2);
  check("findTarget: none out of range", env.enemies.findTarget(3, x + 2, y + 2) === null);
  const crusher = spawn(env, false, 24, x + 11, y + 6, 0);
  crusher.mode = 5;
  const prefer = env.enemies.findTarget(20, x + 2, y + 2);
  check("findTarget: crushers come first", prefer && prefer.enemy === crusher);
  env.enemies.findTarget(20, x + 2, y + 2);
  env.enemies.findTarget(20, x + 2, y + 2);
  crusher.hp = 0;
  env.enemies.destroyGround(crusher, false);
  const ships = env.sim.fleet.ships.length;
  const target = env.enemies.findTarget(20, x + 2, y + 2);
  const launched = env.enemies.launchMissile({ x: x + 2, y: y + 2 }, target);
  check("launch: a missile (ship type 17) appears", launched && env.sim.fleet.ships.length === ships + 1 && env.sim.fleet.ships.at(-1).type === 17);
  env.state.setWord(0x142a2, 1);
  env.run(600);
  check("missile: hits the ground enemy, both gone", env.enemies.ground.length === 0 && env.sim.fleet.ships.length === ships);
  check("missile: no morale loss for the lost missile", !env.morale.includes(-100));
  // $4408 removes the missile with $46CC before `bset #5,$156A9`: the missile is silent, only the occupant's $11C5C blasts.
  const boom = env.explosions;
  check("missile hit (ground): one explosion, at the enemy's cell, high volume (the missile itself is silent)",
    boom.length === 1 && boom[0].x === target.enemy.x && boom[0].y === target.enemy.y && boom[0].high === true,
    JSON.stringify(boom));
  check("missile: its map marks are gone", env.cells.every((w) => !(w & AIR)) && env.units.flags.every((f) => !(f & 8)));
}
{
  // an air target is hit at once on arrival; a vanished target is only noticed by the daily $ACE2 (no main-pass check, $4408)
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const a = spawn(env, true, 25, x + 9, y + 2, 2);
  a.mode = 5;
  a.targetX = a.x; a.targetY = a.y; // hold position so this check isolates a missile strike, not a multi-day chase
  const target = env.enemies.findTarget(20, x + 2, y + 2);
  env.enemies.launchMissile({ x: x + 2, y: y + 2 }, target);
  env.run(600);
  check("missile: hits an aircraft", env.enemies.air.length === 0 && env.sim.fleet.ships.length === 0,
    `air ${env.enemies.air.map((e) => `${e.slot}:${e.x},${e.y},mode${e.mode}`).join("|")} fleet ${env.sim.fleet.ships.map((s) => `${s.type}:${s.x},${s.y},mode${s.mode},lift${s.lift},target${s.targetX},${s.targetY}`).join("|")}`);
  // Same $4408 order as the ground hit: one explosion, at the aircraft (its $11C30 $4732 with bit 5), none for the missile.
  check("missile hit (air): one explosion, at the aircraft's cell, high volume", env.explosions.length === 1 && env.explosions[0].x === a.x && env.explosions[0].y === a.y && env.explosions[0].high === true,
    JSON.stringify(env.explosions));
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const a = spawn(env, true, 25, x + 9, y + 2, 2);
  a.mode = 5;
  env.enemies.launchMissile({ x: x + 2, y: y + 2 }, env.enemies.findTarget(20, x + 2, y + 2));
  env.enemies.destroyAir(a, false);
  env.run(5);
  check("missile: the main pass does not notice a vanished target", env.sim.fleet.ships.length === 1 && env.explosions.length === 0);
  const missile = env.sim.fleet.ships[0];
  env.sim.fleet.dailyFuel();
  check("missile: the daily $ACE2 removes it silently (one explosion, no morale or lost-unit change)", env.sim.fleet.ships.length === 0 &&
    env.explosions.length === 1 && env.explosions[0].x === missile.x && env.explosions[0].y === missile.y && !env.morale.includes(-100));
  check("missile: its air mark is released with it", env.cells.every((w) => !(w & AIR)) && env.units.flags.every((f) => !(f & 8)));
}
{
  // a ship takes off, flies to a cell and lands there
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = env.sim.fleet.createShip(11, x + 2, y + 2, 8);
  env.enemies.orderShip(ship, x + 8, y + 5, true);
  check("ship order: a landed ship starts its climb (mode 7)", ship.mode === 7);
  env.run(400);
  check("ship: arrives at the target and lands (lift 0, mode 0, parked frame)", ship.x === x + 8 && ship.y === y + 5 && ship.lift === 0 && ship.mode === 0 && ship.dir === 8, `${ship.x},${ship.y} mode ${ship.mode} lift ${ship.lift}`);
  const i = (y + 5) * MAP_WIDTH + x + 8;
  check("ship: lands with the ground mark and flag 4, the old cell is clean", (env.cells[i] & OCCUPIED) !== 0 && (env.units.flags[cellFlagIndex(x + 8, y + 5)] & 4) !== 0 && (env.cells[(y + 2) * MAP_WIDTH + x + 2] & (OCCUPIED | AIR)) === 0);
}
{
  // a ship sent to the front flies off the map: front fleet counter of its class
  const env = fresh();
  const { x, y } = freeArea(env.world);
  env.state.setByte(0x135c4, 100);
  env.state.setByte(0x135c5, 58);
  const ship = env.sim.fleet.createShip(11, x + 2, y + 2, 8);
  const lost = env.state.long(0x14294);
  const before = env.state.long(0x1427c);
  env.enemies.sendShipToFront(ship);
  env.run(3000);
  check("ship to the front: leaves the map, joins the front fleet of its class", !env.sim.fleet.ships.includes(ship) && env.state.long(0x1427c) === before + 1, `front ${env.state.long(0x1427c)}`);
  // $4672 calls $46CC (-100 morale) and takes the lost-unit count back ($14294--): the morale loss is original
  check("ship to the front: not counted as lost ($14294 unchanged), morale -100 as in $46CC", env.state.long(0x14294) === lost && env.morale.includes(-100));
}
{
  // an enemy shoots a ship that hovers nearby
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = env.sim.fleet.createShip(11, x + 5, y + 6, 8);
  ship.hp = 2;
  env.enemies.orderShip(ship, x + 5, y + 6, false);
  env.run(30); // it climbs and hovers
  const e = spawn(env, false, 22, x + 5, y + 4, 0, [0, 6, 0, 4, 0, 5, 50, 0]);
  e.mode = 5;
  env.run(30);
  check("attack: an enemy shoots a hovering ship down (-100 morale)", !env.sim.fleet.ships.includes(ship) && env.morale.includes(-100));
}
{
  // a ship built at a yard ($387E) and still landed on its pad carries the own flag (bit 2) on its cell, so a ground enemy
  // scanning that cell finds it, exactly like a landed ship that arrived by order; no order is given here
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = env.sim.fleet.createShip(11, x + 5, y + 6, 8);
  ship.hp = 2;
  check("yard-built ship: launch cell has the own flag (bit 2) and the ground mark", (env.units.flags[cellFlagIndex(x + 5, y + 6)] & 4) !== 0 && (env.cells[(y + 6) * MAP_WIDTH + x + 5] & OCCUPIED) !== 0);
  const e = spawn(env, false, 22, x + 5, y + 4, 0, [0, 6, 0, 4, 0, 5, 50, 0]);
  e.mode = 5;
  env.run(30);
  check("yard-built ship: a landed ship on the launch cell is shot by the enemy next to it", !env.sim.fleet.ships.includes(ship) && env.morale.includes(-100), `ships ${env.sim.fleet.ships.length}`);
}

// ---- stable fixed slots: first-free allocation, destroy never shifts survivors, capacity counts occupancy ---------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const E = env.enemies;
  check("fresh system: 60 ground / 30 air null slots, dense views empty", E.groundSlots.length === 60 && E.airSlots.length === 30 &&
    E.groundSlots.every((e) => e === null) && E.airSlots.every((e) => e === null) && E.ground.length === 0 && E.air.length === 0 && E.groundCount === 0 && E.airCount === 0);
  const g = [0, 1, 2, 3].map((i) => spawn(env, false, 22, x + i, y, 0));
  check("spawns take slots 0..3 in order", g.every((e, i) => E.groundSlots[i] === e));
  E.destroyGround(g[1], false);
  check("destroy frees slot 1 in place: survivors keep slots 0, 2, 3", E.groundSlots[0] === g[0] && E.groundSlots[1] === null && E.groundSlots[2] === g[2] && E.groundSlots[3] === g[3]);
  check("dense view skips the hole in slot order", E.ground.length === 3 && E.ground[0] === g[0] && E.ground[1] === g[2] && E.ground[2] === g[3] && E.groundCount === 3);
  const n = spawn(env, false, 23, x + 5, y, 0);
  check("next spawn takes the first free slot (1), not the end", E.groundSlots[1] === n && E.groundSlots[4] === null && E.groundCount === 4);
  E.destroyGround(g[0], false);
  E.destroyGround(g[3], false);
  const m = spawn(env, false, 22, x + 6, y, 0);
  const m2 = spawn(env, false, 22, x + 7, y, 0);
  check("lowest free slot first again (0, then 3)", E.groundSlots[0] === m && E.groundSlots[3] === m2 && E.groundSlots[2] === g[2] && E.groundSlots[1] === n);
  check("destroying an object that is not in a slot does nothing", (() => { const c = E.groundCount; E.destroyGround(g[1], false); return E.groundCount === c; })());

  // air list: same rules
  const a = [0, 1, 2].map((i) => spawn(env, true, 25, x + i, y + 2, 2));
  E.destroyAir(a[0], false);
  E.destroyAir(a[2], false);
  check("air destroy leaves holes, survivor keeps slot 1", E.airSlots[0] === null && E.airSlots[1] === a[1] && E.airSlots[2] === null && E.air.length === 1 && E.airCount === 1);
  const b = spawn(env, true, 26, x + 4, y + 2, 2);
  check("air spawn takes the first free slot", E.airSlots[0] === b);
}
{
  // capacity counts occupied slots: a full list with a hole in the middle still accepts exactly one more
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const E = env.enemies;
  const all = [];
  for (let i = 0; i < 60; i++) all.push(spawn(env, false, 22, x + (i % 12), y + Math.floor(i / 12), 0));
  check("60 ground enemies fill every slot, the 61st is refused", E.groundCount === 60 && E.groundSlots.every((e) => e !== null) &&
    E.spawn({ air: false, type: 22, x, y, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0] }) === false && E.groundCount === 60);
  E.destroyGround(all[37], false);
  check("a hole in a full list is the only free slot", E.groundSlots[37] === null && E.groundCount === 59);
  // $48EC checks the saved count word before scanning the fixed slots. A full count therefore refuses a wave spawn
  // even if a stale/inconsistent count leaves a physical hole; ordinary calls still use the first free slot.
  env.state.setWord(0x142a2, 60);
  check("wave allocator honors the full count word before scanning a free slot", E.groundSlots[37] === null &&
    E.spawn({ air: false, type: 22, x, y, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0], origin: "wave" }) === false &&
    E.groundSlots[37] === null && E.groundCount === 59);
  env.state.setWord(0x142a2, 59);
  const again = spawn(env, false, 23, x, y, 0);
  check("the freed slot 37 is reused and the list is full again", E.groundSlots[37] === again && E.groundCount === 60 &&
    E.spawn({ air: false, type: 22, x, y, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0] }) === false);
  const airs = [];
  for (let i = 0; i < 30; i++) airs.push(spawn(env, true, 25, x + (i % 12), y + 6 + Math.floor(i / 12), 1));
  check("30 aircraft fill every slot, the 31st is refused", E.airCount === 30 && E.spawn({ air: true, type: 25, x, y, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0] }) === false);
  E.destroyAir(airs[29], false);
  check("air slot 29 can be freed and reused", E.airSlots[29] === null && E.spawn({ air: true, type: 26, x, y, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0] }) === true && E.airSlots[29].type === 26);
}
// ---- wave spawns through the alien spawner ($1187C -> $48EC / $48B6): record bytes, occupancy, refusal -------------
// Synthetic fixtures written from the static trace (not an original-run comparison). The spawner is driven directly
// (`sim.aliens.spawnStep()`), so the real Sim -> EnemySystem hook path is exercised. Group 0, first queue cell $6C.
{
  const REC = 0x13456;
  const GROUP0 = 0x135c6;
  const ENTRY = 0x13476 + 3 * 8; // a wave-entry row inside the table: type, +1 hp, +3 damage, +4 count, +5/+6/+7 bytes
  const setup = (env, entryBytes, cell, dir) => {
    const s = env.state;
    s.setByte(REC + 0x11, 3); // alien level $13467 -> record +A
    entryBytes.forEach((b, i) => s.setByte(ENTRY + i, b));
    for (let i = 0; i < 0x80; i++) s.setLong(GROUP0 + 0x10 + 4 * i, 0);
    for (let c = 0; c < 8; c++) { s.setByte(GROUP0 + 2 * c, cell.x); s.setByte(GROUP0 + 2 * c + 1, cell.y); }
    s.setByte(GROUP0 + 0x90, 1); // one queued entry
    s.setByte(GROUP0 + 0x91, dir);
    s.setLong(GROUP0 + 0x10 + 0x6c, ENTRY);
  };
  const queuedLong = (env) => env.state.long(GROUP0 + 0x10 + 0x6c);

  // ground entry: +A = level, +$13/+$14/+$15 = entry bytes 5/6/7, map word marked, flag byte and counters per the trace
  {
    const env = fresh();
    const { x, y } = freeArea(env.world);
    setup(env, [22, 7, 0, 4, 1, 0x83, 45, 9], { x, y }, 0x0d); // direction byte is masked with 7
    const idx = y * MAP_WIDTH + x;
    env.state.setWord(0x142a2, 0);
    env.sim.aliens.spawnStep();
    const e = env.enemies.groundSlots[0];
    check("wave spawn (ground): first free slot 0, hp / damage / +$E / mode from the entry", !!e && e.type === 22 && e.hp === 7 && e.dmg === 4 && e.bombPct === 45 && e.mode === 6 && e.x === x && e.y === y);
    check("wave spawn (ground): +A = alien level $13467, +$13/+$14/+$15 = entry bytes 5/6/7 (unsigned), direction masked", !!e && e.tech === 3 && e.aux === 0x83 && e.p14 === 45 && e.p15 === 9 && e.dir === 5);
    check("wave spawn (ground): map word occupancy only; flag byte untouched, slot +$16 untouched (initial 0), no reservation cell",
      (env.cells[idx] & OCCUPIED) !== 0 && (env.units.flags[cellFlagIndex(x, y)] & 3) === 0 && e.reserveX === -1 && e.reserveY === -1 && env.enemies.groundFlagPointers[0] === 0);
    check("wave spawn (ground): $142A2 +1, queue cell emptied, group count 0, group index advanced, cursor stepped by $14",
      env.state.word(0x142a2) === 1 && queuedLong(env) === 0 && env.state.byte(GROUP0 + 0x90) === 0 &&
      env.sim.aliens.spawner.groupIndex === 1 && env.sim.aliens.spawner.cursor === 0x6c);
    check("wave spawn (ground): every other ground and air slot stays free", env.enemies.groundCount === 1 && env.enemies.airCount === 0);
  }

  // air entry: aux is signed, lift starts at the climb value, air map bit and $142A4
  {
    const env = fresh();
    const { x, y } = freeArea(env.world);
    setup(env, [25, 5, 0, 2, 1, 0xfe, 33, 1], { x, y }, 2);
    env.state.setWord(0x142a4, 0);
    env.sim.aliens.spawnStep();
    const a = env.enemies.airSlots[0];
    check("wave spawn (air): +A = level, +$13 signed (-2), +$14 / +$15 from entry, lift $22, direction from the group", !!a && a.type === 25 && a.hp === 5 && a.dmg === 2 && a.bombPct === 33 &&
      a.tech === 3 && a.aux === -2 && a.p14 === 33 && a.p15 === 1 && a.lift === 0x22 && a.dir === 2);
    check("wave spawn (air): air map bit set, flag byte untouched, $142A4 +1 (not $142A2)",
      (env.cells[y * MAP_WIDTH + x] & AIR) !== 0 && (env.units.flags[cellFlagIndex(x, y)] & 3) === 0 && env.state.word(0x142a4) === 1 && env.state.word(0x142a2) === 0 && queuedLong(env) === 0);
  }

  // crusher: the +$13/+$14 packing of a wave entry equals the saved-record packing
  {
    const env = fresh();
    const { x, y } = freeArea(env.world);
    setup(env, [24, 6, 0, 3, 1, 0x85, 2, 0], { x, y }, 0);
    env.sim.aliens.spawnStep();
    const c = env.enemies.groundSlots[0];
    check("wave spawn (crusher): +$13 = toggle bit 7 + counter, +$14 = animation byte", !!c && c.type === 24 && c.toggle === true && c.counter === 5 && c.anim === 2);
  }

  // full list: the count word is checked first; nothing is allocated, marked, counted or dequeued
  {
    const env = fresh();
    const { x, y } = freeArea(env.world, 12);
    const spawnCell = { x: x + 11, y: y + 11 };
    for (let i = 0; i < 60; i++) spawn(env, false, 22, x + (i % 10), y + Math.floor(i / 10), 0);
    env.state.setWord(0x142a2, 60);
    setup(env, [22, 7, 0, 4, 1, 0, 45, 0], spawnCell, 0);
    const idx = spawnCell.y * MAP_WIDTH + spawnCell.x;
    const before = env.cells[idx];
    env.sim.aliens.spawnStep();
    check("wave spawn with a full ground list is refused: entry stays queued, count and $142A2 unchanged, spawn cell unmarked",
      env.enemies.groundCount === 60 && queuedLong(env) === ENTRY && env.state.byte(GROUP0 + 0x90) === 1 &&
      env.state.word(0x142a2) === 60 && env.cells[idx] === before && env.sim.aliens.spawner.groupIndex === 1 && env.sim.aliens.spawner.cursor === 0x80 - 6 * 0x14);
    // The allocator's -1 lets the bounded queue scan continue. A following air entry can still spawn when
    // only the ground list is full; this proves the next queue slot is attempted after refusal.
    const air = fresh();
    const ax = freeArea(air.world);
    for (let i = 0; i < 60; i++) spawn(air, false, 22, ax.x + (i % 10), ax.y + Math.floor(i / 10), 0);
    air.state.setWord(0x142a2, 60);
    const follow = { x: ax.x + 11, y: ax.y + 11 };
    setup(air, [22, 7, 0, 4, 1, 0, 45, 0], follow, 0);
    const ENTRY_AIR = ENTRY + 8;
    air.state.setByte(ENTRY_AIR, 25);
    air.state.setByte(ENTRY_AIR + 1, 5);
    air.state.setByte(ENTRY_AIR + 3, 2);
    air.state.setByte(ENTRY_AIR + 4, 1);
    air.state.setByte(ENTRY_AIR + 5, 0);
    air.state.setByte(ENTRY_AIR + 6, 33);
    air.state.setByte(ENTRY_AIR + 7, 0);
    air.state.setLong(GROUP0 + 0x10 + 0x58, ENTRY_AIR);
    air.state.setByte(GROUP0 + 0x90, 2);
    air.sim.aliens.spawnStep();
    check("wave spawner continues after full ground list refusal and attempts the following air entry", air.enemies.groundCount === 60 &&
      air.enemies.airCount === 1 && air.enemies.airSlots[0]?.type === 25 && queuedLong(air) === ENTRY && air.state.long(GROUP0 + 0x10 + 0x58) === 0 &&
      air.state.byte(GROUP0 + 0x90) === 1 && air.state.word(0x142a2) === 60 && air.state.word(0x142a4) === 1 &&
      (air.cells[(follow.y * MAP_WIDTH) + follow.x] & AIR) !== 0);

    // An actually full air list also leaves its own queue entry intact.
    const fullAir = fresh();
    const fx = freeArea(fullAir.world);
    for (let i = 0; i < 30; i++) spawn(fullAir, true, 25, fx.x + (i % 10), fx.y + Math.floor(i / 10), 0);
    fullAir.state.setWord(0x142a4, 30);
    setup(fullAir, [25, 5, 0, 2, 1, 0, 33, 0], { x: fx.x + 11, y: fx.y + 11 }, 0);
    fullAir.sim.aliens.spawnStep();
    check("wave spawn with a full air list is refused without consuming its entry or incrementing $142A4", fullAir.enemies.airCount === 30 &&
      queuedLong(fullAir) === ENTRY && fullAir.state.byte(GROUP0 + 0x90) === 1 && fullAir.state.word(0x142a4) === 30 &&
      (fullAir.cells[(fx.y + 11) * MAP_WIDTH + fx.x + 11] & AIR) === 0);
  }
}
{
  // defect uses the first free ground slot and respects occupancy-based capacity
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const E = env.enemies;
  const a = spawn(env, false, 22, x, y, 0);
  const b = spawn(env, false, 22, x + 1, y, 0);
  E.destroyGround(a, false);
  const t = env.units.spawn(9, x + 3, y + 3, 4);
  E.defect();
  check("defect takes the first free ground slot (0)", E.groundSlots[0] !== null && E.groundSlots[0].type === 9 && E.groundSlots[1] === b && E.groundCount === 2);
  for (let i = 0; i < 58; i++) spawn(env, false, 22, x + (i % 12), y + 2 + Math.floor(i / 12), 0);
  env.units.spawn(9, x + 8, y + 8, 4);
  check("defect refuses when all 60 slots are occupied", E.groundCount === 60 && E.defect() === null && env.units.units.length === 1);
}
{
  // the missile target / overview / findTarget see slot objects in slot order after holes appear
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const E = env.enemies;
  const a = spawn(env, false, 22, x + 2, y + 2, 0);
  const b = spawn(env, false, 22, x + 4, y + 4, 0);
  const c = spawn(env, true, 26, x + 5, y + 5, 1);
  E.destroyGround(a, false);
  check("overview and drawables follow occupancy, not slots", E.overview().enemyGround.length === 1 && E.overview().enemyGround[0].x === x + 4 && E.drawables().length === 2);
  check("findTarget still finds survivors in the holey lists", E.findTarget(20, x + 3, y + 3)?.enemy === c);
}

if (failed) {
  console.log(`${failed} enemy check(s) FAILED`);
  process.exit(1);
}
console.log("all enemy checks passed");
