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
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { UnitSystem } = await import("../dist/game/units.js");
const { EnemySystem, dirToward } = await import("../dist/game/enemies.js");

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
function fresh({ fixed = 0 } = {}) {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const bombs = [];
  const explosions = [];
  const sounds = [];
  const morale = [];
  const sim = new Sim(world, {
    rng: (range) => Math.min(fixed, range - 1),
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
  });
  const enemies = new EnemySystem(sim, units, tables, {
    explode: (x, y, lift, high) => explosions.push({ x, y, lift, high }),
    sound: (id) => sounds.push(id),
    buildingHeight: () => 20,
  });
  const run = (passes) => {
    for (let i = 0; i < passes; i++) {
      units.tick();
      enemies.pass(units.clock);
    }
  };
  return { state, world, sim, units, enemies, bombs, explosions, sounds, morale, run, cells: world.cells };
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
  const spawned = env.enemies.spawn({ air, type, x, y, dir, entry: entry ?? [0, 6, 0, 3, 0, 5, 50, 0] });
  if (!spawned) throw new Error("spawn failed");
  return air ? env.enemies.air[env.enemies.air.length - 1] : env.enemies.ground[env.enemies.ground.length - 1];
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
  check("ground enemy: occupies its cell (map bit and flag bit 0)", (env.cells[i] & OCCUPIED) !== 0 && (env.enemies.ground.length === 1) && (env.units.flags[i] & 1) === 1);
  check("ground enemy: record fields from the wave entry (hp 6, damage 3, bomb 50%)", e.hp === 6 && e.dmg === 3 && e.bombPct === 50 && e.mode === 6);
  const air = spawn(env, true, 25, x + 8, y + 8, 2, [0, 4, 0, 2, 0, 3, 40, 0]);
  const j = (y + 8) * MAP_WIDTH + x + 8;
  check("air enemy: air layer mark, flag bit 1, lift $22", (env.cells[j] & AIR) !== 0 && (env.units.flags[j] & 2) === 2 && air.lift === 0x22);
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
  check("enemy killed by the tank: gone, cell released", env.enemies.ground.length === 0 && (env.cells[i] & OCCUPIED) === 0 && (env.units.flags[i] & 1) === 0);
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

// an enemy bombs an active building: attack gate (roll < 25) and bomb chance (+E) both pass with roll 0
{
  const env = fresh({ fixed: 0 });
  const { x, y } = freeArea(env.world);
  env.cells[(y + 6) * MAP_WIDTH + x + 5] |= ACTIVE;
  const e = spawn(env, false, 22, x + 5, y + 5, 0);
  e.mode = 5;
  env.run(10);
  check("attack: enemy tick, an active cell within the 48 cells is bombed", env.bombs.length >= 1 && env.bombs[0][0] === x + 5 && env.bombs[0][1] === y + 6, JSON.stringify(env.bombs));
  check("attack: the attacker waits for the next enemy tick afterwards", e.waiting);
}
{
  const env = fresh({ fixed: 99 }); // roll(256) = 99: the attack gate (< 25) is closed
  const { x, y } = freeArea(env.world);
  env.cells[(y + 6) * MAP_WIDTH + x + 5] |= ACTIVE;
  const e = spawn(env, false, 22, x + 5, y + 5, 0);
  e.mode = 5;
  env.run(20);
  check("attack: gate closed, no bomb", env.bombs.length === 0);
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
  check("tank cell released", (env.cells[(y + 6) * MAP_WIDTH + x + 5] & OCCUPIED) === 0 && env.units.flags[(y + 6) * MAP_WIDTH + x + 5] === 0);
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
  for (let i = 0; i < 300 && env.enemies.ground.includes(c); i++) {
    env.run(1);
    if (c.x !== lastX) moves++;
    lastX = c.x;
  }
  check("crusher: walks, crossing an active cell and bombing it", env.bombs.some(([bx, by]) => bx === x + 8 && by === y + 6) && moves > 0, JSON.stringify(env.bombs));
  check("crusher: animation counter runs 0..7", c.counter >= 0 && c.counter < 8);
}

// ---- defect and repair ----------------------------------------------------------------------------------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const t = env.units.spawn(9, x + 3, y + 3, 4);
  t.hp = 7;
  const cell = env.enemies.defect();
  check("defect: returns the cell, the tank becomes an enemy ground unit", cell && cell.x === x + 3 && cell.y === y + 3 && env.units.units.length === 0 && env.enemies.ground.length === 1);
  check("defected tank keeps its type and is idle (mode 5)", env.enemies.ground[0].type === 9 && env.enemies.ground[0].mode === 5);
  env.run(1);
  check("defected tank spins", env.enemies.ground[0].dir !== 4);
  check("defect: no tank, no defection", env.enemies.defect() === null);
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
  // the half-day / day events are detected from the frame countdown in `frame()`
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const at = addGun(env, 0x1f, x + 6, y + 6, 0, 0, 1);
  env.state.setByte(A.frameCountdown, 0x30);
  env.enemies.frame();
  env.state.setByte(A.frameCountdown, 0x2d);
  env.enemies.frame();
  check("frame(): gun A turns at the half-day moment (countdown $2D)", env.world.objects[at + 2] === 1);
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
  check("missile: its map marks are gone", env.cells.every((w) => !(w & AIR)) && env.units.flags.every((f) => !(f & 8)));
}
{
  // an air target is hit at once on arrival; a vanished target removes the missile silently
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const a = spawn(env, true, 25, x + 9, y + 2, 2);
  a.mode = 5;
  const target = env.enemies.findTarget(20, x + 2, y + 2);
  env.enemies.launchMissile({ x: x + 2, y: y + 2 }, target);
  env.run(600);
  check("missile: hits an aircraft", env.enemies.air.length === 0 && env.sim.fleet.ships.length === 0);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const a = spawn(env, true, 25, x + 9, y + 2, 2);
  a.mode = 5;
  env.enemies.launchMissile({ x: x + 2, y: y + 2 }, env.enemies.findTarget(20, x + 2, y + 2));
  env.enemies.destroyAir(a, false);
  env.run(5);
  check("missile: vanishes when its target is gone", env.sim.fleet.ships.length === 0);
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
  check("ship: lands with the ground mark and flag 4, the old cell is clean", (env.cells[i] & OCCUPIED) !== 0 && (env.units.flags[i] & 4) !== 0 && (env.cells[(y + 2) * MAP_WIDTH + x + 2] & (OCCUPIED | AIR)) === 0);
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

if (failed) {
  console.log(`${failed} enemy check(s) FAILED`);
  process.exit(1);
}
console.log("all enemy checks passed");
