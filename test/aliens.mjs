// Checks of the ship yard / ship fuel / alien / meteor / intelligence port (src/game/sim-ships.ts, sim-aliens.ts).
// Run after `npm run build`. Needs the game data in original/utopia-whdload/Disk.2 (skipped when missing).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk2Path)) {
  console.log("aliens tests skipped: original/utopia-whdload/Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim, SYS } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");

const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const W = 100;

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A sim whose roll always returns `fixed` (default 0 = every chance roll succeeds), or the seeded generator.
function fresh(options = {}, { scenario = 0, fixed = 0, mutate } = {}) {
  const state = new GameState(disk2, records[scenario].block);
  const world = new World(state, loadMap(disk2, records[scenario]));
  mutate?.(world, state);
  const rng = fixed === null ? createRng(7) : (range) => Math.min(fixed, range - 1);
  const sim = new Sim(world, { rng, ...options });
  state.setByte(0x144c8, 0); // power level 0
  return { state, world, sim };
}

function addRecord(world, tile, x, y, byte3 = 0xff) {
  const slot = world.objectCount++;
  const at = slot * 8;
  world.objects[at] = tile >> 8;
  world.objects[at + 1] = tile & 0xff;
  world.objects[at + 3] = byte3;
  world.objects[at + 4] = x;
  world.objects[at + 5] = y;
  return slot;
}

// ---- ship yard ($AC04) and launch ($4060) ----------------------------------------------------------------
{
  const log = [];
  const { state, world, sim } = fresh({ effect: (k, x, y) => log.push([k, x, y]) });
  state.setWord(0x133f8, 1); // command centre present
  state.setWord(0x133d4, 1); // one ship yard
  state.setLong(0x143f6, 10); // pool 3 workers
  const yard = addRecord(world, 0x36, 20, 20);
  addRecord(world, 0x48, 24, 22); // launchpad within 5 cells
  const goods1 = 0x13152 + 4;
  const goods3 = 0x13152 + 12;
  for (let i = 0; i < 5; i++) state.setLong(0x13152 + 4 * i, 0);
  state.setLong(0x13166, 0);
  sim.addGoods(150, 1);
  sim.addGoods(5, 3);
  check("yard order class 2 stores cost", sim.fleet.orderShip(yard, 2) && world.objects[yard * 8 + 6] === 2 && world.objects[yard * 8 + 7] === 100);
  check("yard class 5 needs invention bit 4", !sim.fleet.orderShip(yard, 5));
  for (let i = 0; i < 9; i++) sim.fleet.shipYard();
  check("yard stage 1 takes 10 good-1 per month", world.objects[yard * 8 + 7] === 10 && state.long(goods1) === 150 - 90, `rest ${world.objects[yard * 8 + 7]}`);
  sim.fleet.shipYard();
  check("yard stage 1 done, stage 2 takes good 3 (class 2 = 2 units) and launches", state.long(goods3) === 3 && world.objects[yard * 8 + 6] === 0);
  const ships = sim.fleet.ships;
  check("ship launched on the first pad cell", ships.length === 1 && ships[0].type === 12 && ships[0].x === 24 && ships[0].y === 22, JSON.stringify(ships[0]));
  check("ship bookkeeping", state.word(0x1429e) === 1 && state.long(0x14254 + 12) === 1 && state.long(0x143b2) === 1 && (world.cells[22 * W + 24] & 0x4000) !== 0);
  check("new ship has empty tank, class and hit points from the table", ships[0].fuel === 0 && ships[0].cls === 1 && ships[0].hp === 0x14 && ships[0].dir === 8);
  check("launch event and effect", sim.events.some((e) => e.kind === "ship" && e.what === "launched") && log.some((l) => l[0] === "launch"));

  // second order: all four pad cells occupied except none free -> message $C7, yard waits with $FF
  world.cells[22 * W + 25] |= 0x4000;
  world.cells[23 * W + 25] |= 0x4000;
  world.cells[23 * W + 24] |= 0x4000;
  sim.fleet.orderShip(yard, 1); // class 1: 50 good 1, no good 3
  sim.addGoods(100, 1);
  for (let i = 0; i < 5; i++) sim.fleet.shipYard();
  check("class 1 needs no good 3 and waits for a free pad", world.objects[yard * 8 + 7] === 0xff && sim.messages.includes(0xc7) && sim.fleet.ships.length === 1);
  world.cells[23 * W + 24] &= ~0x4000;
  sim.fleet.shipYard();
  check("launch retried next month", sim.fleet.ships.length === 2 && world.objects[yard * 8 + 6] === 0);

  // missing goods
  sim.fleet.orderShip(yard, 3);
  state.setLong(goods1, 0);
  state.setLong(0x13166, 0);
  sim.messages.length = 0;
  sim.fleet.shipYard();
  check("no good 1: message $C6", sim.messages.includes(0xc6));
  state.setByte(0x144c8, 9);
  sim.messages.length = 0;
  sim.fleet.shipYard();
  check("power level >= 9 stops the yard", sim.messages.length === 0);
}

// ---- fuel burn ($ACE2), destruction ($46CC) ------------------------------------------------------------------
{
  const { state, world, sim } = fresh();
  const a = sim.fleet.createShip(12, 30, 30);
  const b = sim.fleet.createShip(15, 32, 30);
  const c = sim.fleet.createShip(13, 34, 30);
  a.mode = 1;
  a.fuel = 3;
  b.mode = 1;
  b.fuel = 1;
  c.mode = 2;
  c.fuel = 3;
  const morale = state.signedLong(A.morale);
  sim.fleet.dailyFuel();
  check("hovering ship burns 1, flying burns 2, type 15 none", a.fuel === 2 && b.fuel === 1 && c.fuel === 1);
  sim.fleet.dailyFuel();
  check("flying ship out of fuel is destroyed", sim.fleet.ships.length === 2 && !sim.fleet.ships.includes(c) && sim.messages.includes(0x40));
  check("destroyed ship: counters, morale, cell freed", state.word(0x1429e) === 2 && state.long(0x14294) === 1 && state.signedLong(A.morale) < morale && (world.cells[30 * W + 34] & 0x4000) === 0);
  a.fuel = 1;
  sim.fleet.dailyFuel();
  check("fuel 1 hovering also lost (result <= 0)", !sim.fleet.ships.includes(a));
}

// ---- weekly refuel ($4798), $A5A6 --------------------------------------------------------------------------
{
  const { state, world, sim } = fresh();
  const ship = sim.fleet.createShip(14, 40, 40);
  ship.mode = 0;
  world.cells[40 * W + 40] = (world.cells[40 * W + 40] & ~0x3ff) | 0x48; // launchpad tile
  world.cells[38 * W + 42] = (world.cells[38 * W + 42] & ~0x3ff) | 0x3f; // fuel tank nearby
  state.setWord(0x1330e, 1); // T[16].C = 1 -> $13302 + $C
  state.setWord(0x13310, 700); // tank stored
  sim.fleet.weeklyRefuel();
  check("landed ship takes fuel from the tanks", ship.fuel === 700 && state.word(0x13310) === 0 && state.long(0x14376) === 700);
  state.setWord(0x13310, 800);
  sim.fleet.weeklyRefuel();
  check("second refuel tops up to 1200 only as far as stock allows (800)", ship.fuel === 1200 && state.word(0x13310) === 300 && sim.messages.filter((m) => m === 0xee).length === 1, `fuel ${ship.fuel} stock ${state.word(0x13310)}`);
  ship.fuel = 0;
  state.setWord(0x13310, 0);
  sim.messages.length = 0;
  sim.fleet.fuelWarned = false;
  sim.fleet.weeklyRefuel();
  sim.fleet.weeklyRefuel();
  check("empty tanks: message $EE only once a month", sim.messages.filter((m) => m === 0xee).length === 1);
  world.cells[38 * W + 42] &= ~0x3ff;
  state.setWord(0x13310, 500);
  sim.fleet.weeklyRefuel();
  check("no tank within 7 cells: no refuelling", ship.fuel === 0);
}

// ---- event 15: fuel beaming ($114AC) ---------------------------------------------------------------------
{
  const { state, sim } = fresh();
  const ship = sim.fleet.createShip(12, 40, 40);
  state.setWord(0x132d8, 1); // T[13].C
  state.setWord(0x1330e, 1);
  state.setWord(0x13310, 800);
  sim.fleet.eventFuelBeam();
  check("beaming: 400 taken, half lost, 20 per round until used up", ship.fuel === 200 && state.word(0x13310) === 400 && sim.messages.includes(0x52), `fuel ${ship.fuel}`);
  ship.fuel = 590;
  state.setWord(0x13310, 800);
  sim.fleet.eventFuelBeam();
  check("beaming: ship full, the rest returns to the tanks", ship.fuel === 600 && state.word(0x13310) === 780, `stored ${state.word(0x13310)}`);
  state.setByte(0x144c8, 6);
  state.setWord(0x13310, 800);
  ship.fuel = 0;
  sim.fleet.eventFuelBeam();
  check("beaming: power level 6 blocks it", ship.fuel === 0);
}

// ---- events 12 and 17 -------------------------------------------------------------------------------------
{
  const log = [];
  const { state, sim } = fresh({ effect: (k, x, y) => log.push([k, x, y]), defectUnit: () => ({ x: 5, y: 6 }) });
  const a = sim.fleet.createShip(12, 30, 30);
  sim.fleet.eventShipExplosion(100);
  check("ship explosion needs an airborne ship", sim.fleet.ships.length === 1 && !sim.messages.includes(0x109));
  a.lift = 1;
  sim.fleet.eventShipExplosion(100);
  check("airborne first ship explodes", sim.fleet.ships.length === 0 && sim.messages.includes(0x109) && log.some((l) => l[0] === "explosion") && log.some((l) => l[0] === "focus"));
  state.setWord(0x1429c, 3);
  sim.aliens.eventTankDefect(100);
  check("tank defects to the enemy", state.word(0x1429c) === 2 && state.word(0x142a2) === 1 && sim.messages.includes(0x181));
  state.setWord(0x142a2, 60);
  sim.aliens.eventTankDefect(100);
  check("enemy list full: nothing happens", state.word(0x1429c) === 2);
}

// ---- alien appearance (event 1) -----------------------------------------------------------------------------
{
  const log = [];
  const { state, world, sim } = fresh({ effect: (k, x, y) => log.push([k, x, y]) }, { mutate: (w, st) => ((w.cells[10 * W + 11] = 0x7f), (w.cells[12 * W + 13] = 0x7f), st.setWord(0x144a6, 0)) });
  const firstMarker = [...world.cells].findIndex((c) => (c & 0x3ff) === 0x7f);
  check("marker cells registered in row-major order", state.word(0x144a6) >= 2 && state.byte(0x14524) === firstMarker % W && state.byte(0x14525) === Math.floor(firstMarker / W));
  sim.aliens.eventAlienAppears(40);
  check("alien appears at a marker cell", sim.aliens.alien !== null && log.some((l) => l[0] === "alienAppear"));
}

// ---- meteor (event 8, $11676) -------------------------------------------------------------------------------
{
  const log = [];
  const bombed = [];
  const { state, world, sim } = fresh({ effect: (k, x, y) => log.push(k), demolishAt: (x, y) => bombed.push([x, y]) });
  state.setLong(0x14472, 0);
  sim.aliens.eventMeteor(3);
  const m = sim.aliens.meteor;
  check("meteor starts with timer $78 and message $182", m !== null && m.timer === 0x78 && sim.messages.includes(0x182));
  world.cells[m.y * W + m.x] |= 0x0400;
  sim.aliens.eventMeteor(3);
  check("only one meteor at a time", sim.aliens.meteor === m);
  const morale = state.signedLong(A.morale);
  for (let i = 0; i < 29; i++) sim.aliens.meteorStep();
  check("meteor still falling after 29 passes", sim.aliens.meteor !== null && bombed.length === 0);
  sim.aliens.meteorStep();
  check("impact after 30 passes bombs flagged cells, counter and morale", sim.aliens.meteor === null && bombed.length >= 1 && state.word(0x1346a) >= 1 && state.signedLong(A.morale) < morale && log.includes("meteorImpact"));
  state.setLong(0x14472, 0x100);
  sim.aliens.eventMeteor(3);
  check("invention bit 8 stops meteors", sim.aliens.meteor === null);
}

// ---- alien attack waves (event 9) and spawner ---------------------------------------------------------------
{
  const spawned = [];
  const { state, sim } = fresh({ spawnEnemy: (e) => (spawned.push(e), true) });
  state.setByte(0x141b2, 0); // no countdown
  state.setByte(0x13456 + 0x10, 5);
  state.setByte(0x13456 + 0x11, 1);
  state.setByte(0x13456 + 0x18, 100); // strength: the 0..99 roll always passes
  state.setByte(0x13456 + 0x1d, 0);
  state.setByte(0x13456 + 0x1f, 10);
  state.setByte(0x144ca, 0);
  // wave table of level 1 (entry 0 of the row at $13476): type 5, base count 3 (+-2 per entry)
  for (let i = 0; i < 64; i++) state.setByte(0x13476 + i, 0);
  state.setByte(0x13476, 5);
  state.setByte(0x13476 + 4, 3);
  sim.aliens.eventWave();
  check("wave warning sets the pending flag and lowers strength", (sim.sysFlags & SYS.attackPending) !== 0 && state.byte(0x13456 + 0x18) === 90);
  sim.aliens.eventWave();
  let queued = 0;
  for (let g = 0; g < 16; g++) queued += state.byte(0x135c6 + g * 0x92 + 0x90);
  check("second call queues wave entries into a group", (sim.sysFlags & SYS.attackPending) === 0 && queued === 5, `queued ${queued}`); // roll 0 = +2 -> 3 + 2
  // give every group a spawn cell and run the spawner over all groups
  for (let g = 0; g < 16; g++) {
    const base = 0x135c6 + g * 0x92;
    state.setByte(base, 50 + g);
    state.setByte(base + 1, 50);
    for (let c = 1; c < 8; c++) {
      state.setByte(base + 2 * c, 50 + g);
      state.setByte(base + 2 * c + 1, 51 + c);
    }
  }
  for (let i = 0; i < 16 * 12; i++) sim.aliens.spawnStep();
  queued = 0;
  for (let g = 0; g < 16; g++) queued += state.byte(0x135c6 + g * 0x92 + 0x90);
  check("spawner creates the queued enemies (ground type 5)", spawned.length === 5 && queued === 0 && state.word(0x142a2) === 5 && spawned.every((e) => !e.air && e.type === 5), `spawned ${spawned.length}`);
}

// ---- intelligence and weekly battle ---------------------------------------------------------------------------
{
  const { state, sim } = fresh();
  state.setLong(0x1446a, 6000);
  state.setByte(0x144ca, 0);
  state.setByte(0x13ee6, 0xff);
  state.setByte(0x13f10, 0xff);
  state.setByte(0x13f3a, 0xff);
  state.setByte(0x13f64, 0xff);
  state.setByte(0x141b3, 0);
  sim.aliens.eventIntelStep();
  check("intelligence level from funds (>= 5000 gives 2), funds decay", state.byte(0x144ca) === 2 || state.byte(0x144ca) === 1);
  state.setLong(0x1446a, 25000);
  sim.aliens.eventIntelStep();
  check("funds >= 20000 give level 3", state.byte(0x144ca) === 3);
  state.setLong(0x1446a, 0);
  sim.aliens.eventIntelStep();
  check("no funds, level 0", state.byte(0x144ca) === 0);

  // age -> level: every 10th call, age/100+1
  state.setByte(0x144c0, 9);
  state.setWord(0x13456 + 0x14, 99);
  state.setByte(0x13456 + 0x11, 1);
  state.setByte(0x13456 + 0x1b, 5);
  state.setByte(0x13456 + 0x1e, 50);
  state.setByte(0x13456 + 0x18, 10);
  sim.aliens.dailyIntel();
  check("alien ages, level 2, strength +$1B", state.byte(0x13456 + 0x11) === 2 && state.byte(0x13456 + 0x18) === 15 && state.byte(0x144c0) === 0);
}
{
  const { state, sim } = fresh();
  const morale0 = state.signedLong(A.morale);
  // battle: 10 tanks + 2 heavy ships at the front, tech 4 -> strength (10 + 2*... ) * 2 / 2
  state.setLong(0x14274, 10);
  state.setLong(0x14284, 2); // type 13 x4
  state.setByte(0x14592, 4);
  state.setByte(0x13456 + 0x1a, 0);
  state.setByte(0x13456 + 0x1e, 99);
  state.setWord(0x13456 + 0x14, 1000);
  sim.aliens.weeklyBattle();
  const age = state.word(0x13456 + 0x14);
  check("battle wears the alien age down by strength * tech/2 / 2", age === 1000 - ((18 * 2) >> 1), `age ${age}`);
  check("battle casualties are counted as lost", state.long(0x14294) > 0 && state.byte(0x144cb) === 1 && state.long(0x1446e) > 0);
  // victory
  state.setLong(0x14274, 1000);
  state.setWord(0x13456 + 0x14, 50);
  state.setLong(0x1446a, 777);
  const money = state.long(0x135ba);
  sim.aliens.weeklyBattle();
  check("victory: flag, morale, funds go to the treasury", (sim.sysFlags & SYS.noUnitBonus) !== 0 && state.signedLong(A.morale) > morale0 && state.long(0x135ba) === money + 777 && state.byte(0x144ca) === 4 && sim.events.some((e) => e.kind === "aliensDefeated"));
  check("victory message $186", sim.messages.includes(0x186));
  // event 3 after four battles
  state.setByte(0x144cb, 4);
  state.setLong(0x1446e, 50);
  sim.aliens.eventBattleReport();
  check("battle report resets the tallies", state.byte(0x144cb) === 0 && state.long(0x1446e) === 0);
}

// ---- the daily/weekly/monthly drivers call the new code ------------------------------------------------------
{
  const { state, sim } = fresh({}, { fixed: null });
  const ship = sim.fleet.createShip(12, 40, 40);
  ship.mode = 1;
  ship.fuel = 3;
  for (let i = 0; i < 4 * 90; i++) sim.tick();
  check("daily driver burns ship fuel (destroyed after 3 days)", sim.fleet.ships.length === 0 && sim.messages.includes(0x40));
  check("years pass without non-finite values", Number.isFinite(state.signedLong(A.morale)));
}

if (failed) {
  console.log(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("all aliens checks passed");
