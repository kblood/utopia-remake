// Headless checks of the player orders for launched ships and own ground units (src/game/orders.ts,
// EnemySystem.commandShip, Builder.placeLaunchpad): the ship order dispatch of $3F9E, the launchpad of order 4, the
// right-click pick of $3EDC and the group orders of the tank window. Run after `npm run build`.
// Uses the user's own game data in original/utopia-whdload (Disk.1 and Disk.2); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("order tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap, MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { loadCombatTables } = await import("../dist/data/combat.js");
const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { UnitSystem, NO_TARGET } = await import("../dist/game/units.js");
const { EnemySystem, SHIP_ORDER, MSG_NO_FUEL } = await import("../dist/game/enemies.js");
const { Builder } = await import("../dist/game/build.js");
const { pickObject, sortByDistance, orderGroup, stopUnit } = await import("../dist/game/orders.js");
const { SFX } = await import("../dist/audio/sfx.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const tables = loadCombatTables(disk1);
const flagTable = readFlagTable(disk1);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const V = { money: 0x135ba, sites: 0x142c4, objects: 0x142c2 };
const OCCUPIED = 0x4000;
const AIR = 0x2000;
const BLOCKED = 0x1000;
const ACTIVE = 0x0400;

function fresh() {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const said = [];
  const sounds = [];
  const builder = new Builder(world, flagTable, readWeights(disk1), (m) => said.push(m));
  const sim = new Sim(world, { rng: () => 0, onWeek: () => builder.weekly() });
  state.setByte(0x144c8, 0);
  state.setLong(V.money, 5_000_000);
  const units = new UnitSystem(world.cells, () => 1, {});
  const enemies = new EnemySystem(sim, units, tables, {
    explode: () => {},
    sound: (id) => sounds.push(id),
    buildingHeight: () => 20,
    buildPad: (x, y) => builder.placeLaunchpad(x, y),
  });
  const run = (passes) => {
    for (let i = 0; i < passes; i++) {
      units.tick();
      enemies.pass(units.clock);
    }
  };
  return { state, world, sim, units, enemies, builder, said, sounds, run, cells: world.cells };
}

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

function newShip(env, x, y, fuel = 100) {
  const ship = env.sim.fleet.createShip(11, x, y, 8);
  ship.fuel = fuel;
  return ship;
}

// ---- ship orders (dispatch $3F9E) --------------------------------------------------------------------------------
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = newShip(env, x + 2, y + 2, 0);
  const msg = env.enemies.commandShip(ship, SHIP_ORDER.hover, null);
  check("order: a ship without fuel is refused with message $ED, nothing changes", msg === MSG_NO_FUEL && msg === 0xed && ship.mode === 0 && ship.dir === 8);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = newShip(env, x + 2, y + 2, 100);
  const msg = env.enemies.commandShip(ship, SHIP_ORDER.hover, null);
  check("hover: a landed ship takes off (mode 7, direction 2, fuel -8, air mark)", msg === 0 && ship.mode === 7 && ship.dir === 2 && ship.fuel === 92 && (env.cells[(y + 2) * MAP_WIDTH + x + 2] & AIR) !== 0);
  env.run(60);
  check("hover: after the climb it hovers (mode 1) at lift $22", ship.mode === 1 && ship.lift === 0x22, `mode ${ship.mode} lift ${ship.lift}`);
  check("land: a hovering ship comes down at once (mode 8)", env.enemies.commandShip(ship, SHIP_ORDER.land, null) === 0 && ship.mode === 8);
  env.run(60);
  check("land: parked again (mode 0, lift 0, dir 8, fuel -4)", ship.mode === 0 && ship.lift === 0 && ship.dir === 8 && ship.fuel === 88, `fuel ${ship.fuel}`);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = newShip(env, x + 2, y + 2);
  env.enemies.commandShip(ship, SHIP_ORDER.goHover, { x: x + 9, y: y + 6 });
  check("go and hover: takes off towards the pin", ship.mode === 7 && ship.targetX === x + 9 && ship.targetY === y + 6);
  env.run(400);
  check("go and hover: arrives and hovers over the pin", ship.x === x + 9 && ship.y === y + 6 && ship.mode === 1, `${ship.x},${ship.y} mode ${ship.mode}`);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = newShip(env, x + 2, y + 2);
  env.enemies.commandShip(ship, SHIP_ORDER.goLand, { x: x + 8, y: y + 5 });
  env.run(400);
  check("go and land: lands on the pin", ship.x === x + 8 && ship.y === y + 5 && ship.mode === 0 && ship.dir === 8);
  const before = { x: ship.x, mode: ship.mode };
  check("go and land without a pin does nothing", env.enemies.commandShip(ship, SHIP_ORDER.goLand, null) === 0 && ship.mode === before.mode && ship.x === before.x);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = newShip(env, x + 2, y + 2);
  env.enemies.commandShip(ship, SHIP_ORDER.hover, null);
  env.run(60);
  env.enemies.commandShip(ship, SHIP_ORDER.goHover, { x: x + 9, y: y + 8 });
  check("go and hover from hovering: starts flying (mode 3)", ship.mode === 3);
  env.run(10);
  env.enemies.commandShip(ship, SHIP_ORDER.land, null);
  check("land while flying: stops and descends (mode 5)", ship.mode === 5);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  env.state.setByte(0x135c4, 100);
  env.state.setByte(0x135c5, 58);
  const ship = newShip(env, x + 2, y + 2);
  const before = env.state.long(0x1427c);
  check("front: an order 9 sends the ship off the map", env.enemies.commandShip(ship, SHIP_ORDER.front, null) === 0 && ship.targetX === 100 && ship.targetY === 58 && ship.mode === 7);
  env.run(3000);
  check("front: it leaves and joins the front fleet", !env.sim.fleet.ships.includes(ship) && env.state.long(0x1427c) === before + 1);
}

// ---- launchpad (order 4, $771E) ---------------------------------------------------------------------------------
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = newShip(env, x + 2, y + 2);
  const money = env.state.signedLong(V.money);
  const sites = env.state.word(V.sites);
  const objects = env.state.word(V.objects);
  env.enemies.commandShip(ship, SHIP_ORDER.buildPad, null);
  check("launchpad: the ship takes off and is marked as pad builder", ship.mode === 7 && env.enemies.padPending(ship));
  env.run(60);
  check("launchpad: at altitude it waits in mode 4 above its cell", ship.mode === 4 && ship.x === x + 2 && ship.y === y + 2, `mode ${ship.mode}`);
  check("launchpad: money paid, one object record and one site added, no message", env.state.signedLong(V.money) < money && env.state.word(V.sites) === sites + 1 && env.state.word(V.objects) === objects + 1 && env.said.length === 0);
  for (let week = 0; week < 40 && ship.mode === 4; week++) {
    env.builder.weekly();
    env.run(4);
  }
  env.run(60);
  check("launchpad: when the pad is finished the ship lands on it", ship.mode === 0 && (env.world.cell(x + 2, y + 2) & 0x3ff) === 0x48, `mode ${ship.mode} tile ${(env.world.cell(x + 2, y + 2) & 0x3ff).toString(16)}`);
  check("launchpad: the ship is no longer a pad builder", !env.enemies.padPending(ship));
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const ship = newShip(env, x + 2, y + 2);
  env.state.setLong(V.money, 0);
  env.enemies.commandShip(ship, SHIP_ORDER.buildPad, null);
  env.run(60);
  check("launchpad without money: message $EA and the ship lands again", env.said.includes(0xea) && ship.mode !== 4, `said ${env.said.join(",")} mode ${ship.mode}`);
}
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  env.cells[(y + 3) * MAP_WIDTH + x + 3] |= BLOCKED;
  const ship = newShip(env, x + 2, y + 2);
  env.enemies.commandShip(ship, SHIP_ORDER.buildPad, null);
  env.run(60);
  check("launchpad on blocked ground: message $E9, nothing built", env.said.includes(0xe9) && env.state.word(V.sites) === 0 && ship.mode !== 4);
}

// ---- sound ids ---------------------------------------------------------------------------------------------------
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const target = { x: x + 8, y: y + 8 };
  env.enemies.spawn({ air: false, type: 22, x: target.x, y: target.y, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0] });
  const launched = env.enemies.launchMissile({ x: x + 2, y: y + 2 }, env.enemies.findTarget(20, x + 6, y + 6));
  check("missile launch plays the launch sound once", launched && env.sounds.filter((id) => id === SFX.LAUNCH).length === 1);
}
check("sound ids used by the orders exist", typeof SFX.CLICK === "number" && typeof SFX.HIT === "number" && typeof SFX.LAUNCH === "number");

// ---- right click pick ($3EDC) -----------------------------------------------------------------------------------
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const unit = env.units.spawn(9, x + 3, y + 3);
  const ship = newShip(env, x + 5, y + 5);
  env.enemies.spawn({ air: false, type: 22, x: x + 10, y: y + 10, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0] });
  env.enemies.launchMissile({ x: x + 7, y: y + 7 }, env.enemies.findTarget(20, x + 7, y + 7)); // createShip no longer makes missiles
  const missile = env.sim.fleet.ships.find((r) => r.type === 17);
  const layer = { units: env.units, pickables: () => [{ x: 100, y: 100, ref: unit }, { x: 300, y: 100, ref: ship }, { x: 150, y: 50, ref: missile }] };
  const ships = env.sim.fleet.ships;
  const p1 = pickObject(layer, ships, 0, 0, 0, 0, { x: x + 3, y: y + 3 });
  check("pick: a cell with an own tank gives the tank", p1 && p1.kind === "tank" && p1.unit === unit);
  const p2 = pickObject(layer, ships, 0, 0, 0, 0, { x: x + 5, y: y + 5 });
  check("pick: a cell with a ship gives the ship", p2 && p2.kind === "ship" && p2.ship === ship);
  check("pick: a missile has no window", pickObject(layer, ships, 0, 0, 0, 0, { x: x + 7, y: y + 7 }) === null);
  check("pick: an empty cell far from every sprite gives nothing", pickObject(layer, ships, 0, 0, 5, 5, { x: x + 1, y: y + 1 }) === null);
  const p4 = pickObject(layer, ships, 0, 0, 110, 90, null);
  check("pick: without a cell the sprite box of the tank is hit (20 x 20)", p4 && p4.kind === "tank" && p4.unit === unit);
  check("pick: just outside the box misses", pickObject(layer, ships, 0, 0, 121, 90, null) === null && pickObject(layer, ships, 0, 0, 110, 101, null) === null);
}

// ---- tank window orders -----------------------------------------------------------------------------------------
{
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const a = env.units.spawn(9, x + 1, y + 1);
  const b = env.units.spawn(9, x + 4, y + 1);
  const c = env.units.spawn(9, x + 8, y + 8);
  const d = env.units.spawn(10, x + 2, y + 6);
  const sorted = sortByDistance([c, a, d, b], x + 1, y + 1);
  check("sort: nearest first by Chebyshev distance", sorted[0] === a && sorted[1] === b && sorted[3] === c, sorted.map((u) => `${u.x - x},${u.y - y}`).join(" "));
  const target = { x: x + 10, y: y + 10 };
  check("group: a count of 0 orders nothing", orderGroup(env.units, a, "nearTank", 0, target).length === 0 && a.targetX === NO_TARGET);
  const two = orderGroup(env.units, a, "nearTank", 2, target);
  check("group: the 2 nearest tanks (the window's tank first) walk to the pin", two.length === 2 && two[0] === a && two[1] === b && a.targetX === target.x && b.targetY === target.y && c.targetX === NO_TARGET);
  const all = orderGroup(env.units, a, "front", 99, target);
  check("group: a count above the number of tanks means all", all.length === 4 && all.every((u) => u.targetX === target.x));
  const near = orderGroup(env.units, a, "nearPin", 1, { x: x + 9, y: y + 9 });
  check("group: near-pin counts from the pin", near.length === 1 && near[0] === c);
  stopUnit(a);
  check("stop: no target, no speed, no pixel offset", a.targetX === NO_TARGET && a.vx === 0 && a.vy === 0 && a.dx === 0 && a.dy === 0);
}

if (failed) {
  console.log(`${failed} order check(s) FAILED`);
  process.exit(1);
}
console.log("all order checks passed");
