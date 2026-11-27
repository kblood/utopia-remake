// Checks of the warehouse goods arithmetic ($A2DE add with capacity overflow, $A32C remove) in src/game/sim.ts,
// and the two November endpoints of the production captures it explains (notes/formats/sim-port.md "Observed original
// production", notes/formats/game-state.md 5.17). Run after `npm run build`. Needs original/utopia-whdload/Disk.2 for the
// scenario block; the arithmetic checks use only the remake's own tables and are skipped when the file is missing.
//
// Original routine ($A2DE, Disk.1 $A2DE-$A32A): d2 = units * weight (mulu.w); if stored weight + d2 > capacity (signed),
// d2 becomes capacity - stored weight and d0 becomes that leftover divided by the unit weight (divu.w, low word); the stored
// weight then gains d2 (the leftover, so it reaches the capacity exactly), and the stock gains d0. The stock therefore
// receives whole units while the stored weight receives the leftover kilograms. The difference (leftover mod unit
// weight) stays in the stored weight, and later removals subtract whole units only. d1 = $FF on overflow.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk2Path)) {
  console.log("goods-capacity tests skipped: original/utopia-whdload/Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { GOOD_WEIGHT } = await import("../dist/game/sim-tables.js");

const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const WEIGHT = 0x13166;
const CAPACITY = 0x14432;
const STOCK = 0x13152; // goods 0..4, 4 bytes each
const MONEY = 0x135ba;

function fresh() {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const sim = new Sim(world, { rng: (range) => Math.min(0, range - 1), hardware: { todLow: () => 0, rasterParity: () => 0 } });
  state.setByte(0x144c8, 0);
  return { state, sim };
}

// Sets stock (goods 0..4) and the stored weight directly, as the November captures show them.
function setGoods(state, stock, weight) {
  for (let i = 0; i < 5; i++) state.setLong(STOCK + 4 * i, stock[i]);
  state.setLong(WEIGHT, weight);
}

// Stock x unit weight summed over goods 0..4 (the table of $B0EC).
const summed = (stock) => stock.reduce((sum, units, good) => sum + units * GOOD_WEIGHT[good], 0);

check("unit weights are the $B0EC table", JSON.stringify(GOOD_WEIGHT) === JSON.stringify([100, 200, 1, 2000, 1000]));

// ---- ordinary add and remove -------------------------------------------------------------------------------------
{
  const { state, sim } = fresh();
  setGoods(state, [0, 0, 0, 0, 0], 1000);
  const r = sim.addGoods(5, 1);
  check("add without overflow: stock and weight move by whole units", r.added === 5 && !r.overflow && state.long(STOCK + 4) === 5 && state.long(WEIGHT) === 2000, JSON.stringify(r));
  const removed = sim.removeGoods(3, 1);
  check("remove: returns the units taken and subtracts units x weight", removed === 3 && state.long(STOCK + 4) === 2 && state.long(WEIGHT) === 1400);
  const clamped = sim.removeGoods(10, 1);
  check("remove is capped by the stock ($A32C)", clamped === 2 && state.long(STOCK + 4) === 0 && state.long(WEIGHT) === 1000);
}

// ---- overflow keeps the leftover kilograms in the stored weight --------------------------------------------------
{
  const { state, sim } = fresh();
  setGoods(state, [0, 0, 0, 0, 0], 79999);
  const r = sim.addGoods(10, 1); // 2000 kg wanted, 1 kg left
  check("overflow: the stock takes the whole units that fit (leftover / unit weight)", r.overflow && r.added === 0 && state.long(STOCK + 4) === 0, JSON.stringify(r));
  check("overflow: the stored weight reaches the capacity exactly (leftover kilograms added)", state.long(WEIGHT) === 80000);

  setGoods(state, [0, 0, 0, 0, 0], 70000);
  const s = sim.addGoods(101, 0); // 10100 kg wanted, 10000 kg left: exactly 100 units of 100 kg fit
  check("overflow: the units that fit are stored and the weight reaches the capacity", s.overflow && s.added === 100 && state.long(STOCK) === 100 && state.long(WEIGHT) === 80000, JSON.stringify(s));

  setGoods(state, [0, 0, 0, 0, 0], 71501);
  const t = sim.addGoods(90, 0); // 9000 kg wanted, 8499 kg left: 84 units of 100 kg fit, 99 kg remain in the stored weight
  check("overflow remainder: 84 units stored, weight set to the capacity", t.overflow && t.added === 84 && state.long(STOCK) === 84 && state.long(WEIGHT) === 80000, JSON.stringify(t));
  check("overflow remainder: the stored weight rose by the leftover (8499), not by the 8400 kg of units stored", state.long(WEIGHT) - 71501 === 8499 && state.long(WEIGHT) - 71501 - 84 * 100 === 99);
}

// ---- the November endpoint of the RNG-tape capture (state_pre_nov_pass560 -> state_post_nov_pass561) ---------------
// Stock [483, 76, 1, 4, 0] with stored weight 71501. One order that reproduces the captured endpoint: food +90 asked
// (overflow, 84 units, 99 kg remain), ore -1, good 3 -2 ($A32C). Captured endpoint: stock [567, 75, 1, 2, 0], weight
// 75800, summed 75701 (difference 99). Only this order is shown; the capture does not record the sequence.
{
  const { state, sim } = fresh();
  setGoods(state, [483, 76, 1, 4, 0], 71501);
  sim.addGoods(90, 0);
  sim.removeGoods(1, 1);
  sim.removeGoods(2, 3);
  const stock = [0, 1, 2, 3, 4].map((g) => state.long(STOCK + 4 * g));
  check("RNG-tape endpoint: stock matches the capture", JSON.stringify(stock) === JSON.stringify([567, 75, 1, 2, 0]), JSON.stringify(stock));
  check("RNG-tape endpoint: stored weight 75800 and difference 99 to the summed stock", state.long(WEIGHT) === 75800 && state.long(WEIGHT) - summed(stock) === 99, `${state.long(WEIGHT)} vs ${summed(stock)}`);
}

// ---- the November endpoint of the production capture (cap_008 -> cap_009; difference 196) -------------------------
// Stock [476, 76, 1, 4, 0] with stored weight 70801. One order consistent with the endpoint: food +86 (79401 kg), good 2 +3
// (79404 kg), ore asked for 3 units: 596 kg left, 2 ore stored (the captured $143AE = 2), 196 kg remain; then good 3 -2 and
// ore -1 (captured ore 77 and good 3 2). Endpoint: stock [562, 77, 4, 2, 0], weight 75800, summed 75604 (difference 196).
{
  const { state, sim } = fresh();
  setGoods(state, [476, 76, 1, 4, 0], 70801);
  sim.addGoods(86, 0);
  sim.addGoods(3, 2);
  const ore = sim.addGoods(3, 1);
  sim.removeGoods(2, 3);
  sim.removeGoods(1, 1);
  const stock = [0, 1, 2, 3, 4].map((g) => state.long(STOCK + 4 * g));
  check("production endpoint: ore overflow stores 2 units and reports it", ore.overflow && ore.added === 2, JSON.stringify(ore));
  check("production endpoint: stock matches the capture", JSON.stringify(stock) === JSON.stringify([562, 77, 4, 2, 0]), JSON.stringify(stock));
  check("production endpoint: stored weight 75800 and difference 196 to the summed stock", state.long(WEIGHT) === 75800 && state.long(WEIGHT) - summed(stock) === 196, `${state.long(WEIGHT)} vs ${summed(stock)}`);
}

// Money is not touched by the goods routines (trade pays separately).
{
  const { state, sim } = fresh();
  setGoods(state, [0, 0, 0, 0, 0], 0);
  const before = state.long(MONEY);
  sim.addGoods(7, 1);
  sim.removeGoods(2, 1);
  check("goods add and remove leave money alone", state.long(MONEY) === before && state.long(A.money) === before);
}

if (failed) {
  console.log(`${failed} goods capacity check(s) failed`);
  process.exit(1);
}
console.log("all goods capacity checks passed");
