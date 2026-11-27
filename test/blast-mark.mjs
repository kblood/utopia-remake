// Synthetic regression of the `$156A9` bit-5 "blast mark" (Sim.blastMark, Sim.takeBlastMark, ship-control.md 5e). Run after
// `npm run build`. Uses the original Disk.1 / Disk.2 files read at runtime (nothing is copied into the repository).
//
// Static trace (Disk.1, this slice): `$4732` is the only reader of bit 5 (`bclr.b #5,$156A9` and a beq on the old bit): it blasts
// at the victim (a5) when the bit was set and always clears it. Setters are a `bset.b #5` just before each destroy call
// (`$44BA` missile hit, `$ACE2` daily, `$113D0` event 12, `$11E6C`/`$11EBC`/`$11EE6` guns and acid, `$12612`/`$1265A`/`$12714`/
// `$12760` attacks). Only the missile hit on a FREE slot (`$44BA` -> `$44C2` beq -> `$44DC` rts) leaves the bit set.
// Destroy paths that never set it (a missile's own removal `$44AE`, the departure `$4686`, walk-offs `$3C6E`/`$12312`/`$11C24`,
// the kamikaze `$11A42`, the requisition `$1134E`) still reach `$4732` and consume a stale mark.
//
// Expected values come from that trace, not from the implementation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1 = new Uint8Array(fs.readFileSync(path.join(root, "original", "utopia-whdload", "Disk.1")));
const disk2 = new Uint8Array(fs.readFileSync(path.join(root, "original", "utopia-whdload", "Disk.2")));

const { readScenarioRecords, loadMap, MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { loadCombatTables } = await import("../dist/data/combat.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { UnitSystem } = await import("../dist/game/units.js");
const { EnemySystem } = await import("../dist/game/enemies.js");
const { cellFlagIndex } = await import("../dist/game/cell-flags.js");

const records = readScenarioRecords(disk2);
const tables = loadCombatTables(disk1);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const BLOCKED = 0x1000;
const OCCUPIED = 0x4000;
const ACTIVE = 0x0400;
const AIR = 0x2000;
const KILLS = 0x14298;

// The enemies.mjs fixture: a real Sim, UnitSystem and EnemySystem on scenario 0; explosions are recorded, not drawn.
function fresh() {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const explosions = [];
  const sim = new Sim(world, {
    rng: (range) => Math.min(0, range - 1),
    hardware: { todLow: () => 0, rasterParity: () => 0 },
    demolishAt: () => [],
    spawnEnemy: (s) => enemies.spawn(s),
    defectUnit: () => enemies.defect(),
    repairUnits: (n) => enemies.repair(n),
    // the fleet-level blast ($4732 of a Fleet removal) is the same cell blast as the enemy hook (MapScene binds both)
    blast: (x, y, lift, high) => {
      explosions.push({ x, y, lift, high });
      return false;
    },
  });
  state.setByte(0x144c8, 0); // power level 0: the guns work
  const units = new UnitSystem(world.cells, () => 1, {
    lost: (u) => enemies.tankLeft(u),
    combat: (u, t) => enemies.tankCombat(u, t),
  }, world.cellFlags);
  const enemies = new EnemySystem(sim, units, tables, {
    explode: (x, y, lift, high) => {
      explosions.push({ x, y, lift, high });
      return undefined;
    },
    sound: () => {},
    buildingHeight: () => 20,
  });
  const run = (passes) => {
    for (let i = 0; i < passes; i++) {
      units.tick();
      enemies.pass(units.clock);
    }
  };
  return { state, world, sim, units, enemies, explosions, run, cells: world.cells };
}

// A free 12x12 area of plain ground (no blocked, occupied, active or air cell), as in test/enemies.mjs.
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

function spawn(env, air, type, x, y, dir) {
  const slots = air ? env.enemies.airSlots : env.enemies.groundSlots;
  const known = new Set(slots);
  const spawned = env.enemies.spawn({ air, type, x, y, dir, entry: [0, 6, 0, 3, 0, 5, 50, 0] });
  if (!spawned) throw new Error("spawn failed");
  return slots.find((e) => e !== null && !known.has(e));
}

const passesUntil = (env, done, limit) => {
  let n = 0;
  while (!done() && n < limit) {
    env.run(1);
    n++;
  }
  return n;
};

// ---- 1. the mark itself --------------------------------------------------------------------------------------------------

{
  const env = fresh();
  const sim = env.sim;
  check("the mark starts clear (a new game, Disk.4 reset: `$87C2` writes $02)", sim.blastMark === false);
  check("a destroy without its own bset and without a mark is silent", sim.takeBlastMark(false) === false && sim.blastMark === false);
  check("a destroy with its own bset is due (and leaves no mark)", sim.takeBlastMark(true) === true && sim.blastMark === false);
  sim.blastMark = true;
  check("a set mark is due for a destroy with no bset of its own, and is consumed once", sim.takeBlastMark(false) === true && sim.blastMark === false && sim.takeBlastMark(false) === false);
  sim.blastMark = true;
  check("a set mark and the caller's bset give ONE due blast (the bit is a single bit)", sim.takeBlastMark(true) === true && sim.blastMark === false && sim.takeBlastMark(false) === false);
}

// ---- 2. a missile hit on a free slot leaves the mark; it persists across passes; the next $4732 blasts once -------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const target = spawn(env, false, 22, x + 10, y + 2, 0);
  target.mode = 5;
  const found = env.enemies.findTarget(20, x + 2, y + 2);
  env.enemies.launchMissile({ x: x + 2, y: y + 2 }, found);
  passesUntil(env, () => env.sim.fleet.ships.length === 0 || env.sim.fleet.ships[0].mode === 2, 400);
  const missile = env.sim.fleet.ships[0];
  check("free-slot setup: the missile has frozen on the ground target (mode 2)", missile !== undefined && missile.mode === 2);
  // A gun kill while the missile waits: its own `bset` and `$4732` -> exactly one explosion, mark consumed.
  env.enemies.destroyGround(target, true);
  const afterGun = env.explosions.length;
  const killsAfterGun = env.state.long(KILLS);
  check("the gun kill blasts once and leaves no mark", afterGun === 1 && env.sim.blastMark === false);
  passesUntil(env, () => env.sim.fleet.ships.length === 0, 200);
  check("the missile ends on the free slot: removed, no kill counted, no second explosion", env.sim.fleet.ships.length === 0 &&
    env.state.long(KILLS) === killsAfterGun && env.explosions.length === afterGun,
    `ships ${env.sim.fleet.ships.length} kills ${env.state.long(KILLS)} vs ${killsAfterGun} explosions ${env.explosions.length} vs ${afterGun}`);
  check("the free-slot hit leaves bit 5 SET (`$44BA` bset, `$44C2` beq -> `$44DC` rts)", env.sim.blastMark === true);
  env.run(40);
  check("the mark persists across 40 further passes with no destroy", env.sim.blastMark === true && env.explosions.length === afterGun);
  const victim = spawn(env, false, 22, x + 5, y + 8, 0);
  env.enemies.destroyGround(victim, false); // a walk-off-style $11C5C with no bset of its own
  const boom = env.explosions.at(-1);
  check("the next $4732 (a walk-off kill) blasts once at ITS victim, high volume, and clears the mark",
    env.explosions.length === afterGun + 1 && boom.x === victim.x && boom.y === victim.y && boom.high === true && env.sim.blastMark === false,
    JSON.stringify(boom));
  env.enemies.destroyGround(spawn(env, false, 22, x + 3, y + 9, 0), false);
  check("a second destroy without a mark is silent", env.explosions.length === afterGun + 1);
}

// ---- 3. a stale mark is consumed by the next missile's own removal, and that hit's own blast follows it ------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const target = spawn(env, false, 22, x + 10, y + 2, 0);
  target.mode = 5;
  env.enemies.launchMissile({ x: x + 2, y: y + 2 }, env.enemies.findTarget(20, x + 2, y + 2));
  passesUntil(env, () => env.sim.fleet.ships.length === 0 || env.sim.fleet.ships[0].mode === 2, 400);
  const frozen = { x: env.sim.fleet.ships[0].x, y: env.sim.fleet.ships[0].y };
  env.sim.blastMark = true; // a stale mark, as left by an earlier free-slot hit
  passesUntil(env, () => env.sim.fleet.ships.length === 0, 200);
  // $44AE: the missile's own $46CC consumes the stale mark (a blast at the missile's cell), then $44BA sets bit 5 for the
  // occupant's kill, which consumes it again (a blast at the occupant). Two explosions in that order.
  check("stale mark + occupied ground hit: blast at the missile (its frozen cell), then at the occupant",
    env.explosions.length === 2 && env.explosions[0].x === frozen.x && env.explosions[0].y === frozen.y &&
    env.explosions[1].x === target.x && env.explosions[1].y === target.y, JSON.stringify(env.explosions));
  check("stale mark + occupied hit: the mark is consumed and none is left behind", env.sim.blastMark === false);
}

// ---- 4. a ship removed with no bset of its own (the missile removal path) consumes a stale mark --------------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = env.sim.fleet.createShip(11, x + 2, y + 2, 8);
  env.sim.blastMark = true;
  env.enemies.destroyShip(ship, false);
  check("a ship removed with no bset blasts once at its cell while a mark is set, and the mark is consumed",
    env.explosions.length === 1 && env.explosions[0].x === x + 2 && env.explosions[0].y === y + 2 && env.explosions[0].high === true && env.sim.blastMark === false);
  const quiet = env.sim.fleet.createShip(11, x + 6, y + 6, 8);
  env.enemies.destroyShip(quiet, false);
  check("a ship removed with no mark is silent", env.explosions.length === 1 && env.sim.fleet.ships.length === 0);
}

// ---- 4b. a ship that leaves the map ($4672 -> $46CC -> $4732, no bset) consumes a stale mark at its clamped cell ----------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = env.sim.fleet.createShip(11, x + 2, y + 2, 8);
  ship.mode = 3; // a moving mode: $4408-like `shipMove` runs; zero velocity and off the map -> the departure branch
  ship.x = -1;
  env.sim.blastMark = true;
  env.run(1);
  check("a ship that leaves the map with a stale mark blasts once at its clamped cell and clears the mark",
    env.sim.fleet.ships.length === 0 && env.explosions.length === 1 && env.explosions[0].x === 0 && env.explosions[0].y === y + 2 && env.sim.blastMark === false,
    JSON.stringify({ ships: env.sim.fleet.ships.length, explosions: env.explosions }));
}

// ---- 5. a tank that walks off the map ($3C40 -> $4692 -> $4732, no bset) consumes a stale mark at its last cell -----------

{
  const env = fresh();
  env.sim.blastMark = true;
  env.enemies.tankLeft({ type: 9, x: 20, y: 30 });
  check("a walk-off with a stale mark blasts at the tank's last cell and clears the mark",
    env.explosions.length === 1 && env.explosions[0].x === 20 && env.explosions[0].y === 30 && env.sim.blastMark === false);
  env.enemies.tankLeft({ type: 10, x: 21, y: 30 });
  check("a walk-off with no mark is silent", env.explosions.length === 1);
}

// ---- 6. the Earth requisition ($11280 -> $4692 -> $4732) blasts at each removed tank only while a mark is set -------------

function requisitionSim(markBefore) {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const blasts = [];
  const sim = new Sim(world, {
    rng: () => 0,
    hardware: { todLow: () => 0, rasterParity: () => 0 },
    decide: () => true, // the Earth offer is accepted (non-interactive: the decision is asked at once)
    destroyUnit: () => ({ type: 9, x: 5, y: 6 }),
    blast: (x, y, lift, high) => {
      blasts.push({ x, y, lift, high });
      return false;
    },
  });
  state.setWord(0x1429c, 20);
  state.setLong(0x14254, 20);
  state.setLong(0x14258, 0);
  state.setLong(0x135ba, 0); // money (the fine is computed from it)
  sim.blastMark = markBefore;
  sim.eventTankRequisition(100);
  return { sim, blasts };
}
{
  const marked = requisitionSim(true);
  check("requisition with a mark: one blast at the removed tank (lift 0, high volume) and the mark is consumed",
    marked.blasts.length === 1 && marked.blasts[0].x === 5 && marked.blasts[0].y === 6 && marked.blasts[0].high === true && marked.sim.blastMark === false,
    JSON.stringify(marked.blasts));
  const clean = requisitionSim(false);
  check("requisition without a mark stays silent", clean.blasts.length === 0 && clean.sim.blastMark === false);
}

// ---- 7. the free-slot hit is not taken when the slot is still occupied (no mark from a live hit) ---------------------------

{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const target = spawn(env, false, 22, x + 10, y + 2, 0);
  target.mode = 5;
  env.enemies.launchMissile({ x: x + 2, y: y + 2 }, env.enemies.findTarget(20, x + 2, y + 2));
  passesUntil(env, () => env.sim.fleet.ships.length === 0, 400);
  check("a live ground hit kills the occupant and leaves no mark", env.enemies.ground.length === 0 && env.sim.blastMark === false && env.explosions.length === 1);
}

if (failed > 0) {
  console.log(`${failed} blast-mark check(s) FAILED`);
  process.exit(1);
}
console.log("all blast-mark tests passed");
