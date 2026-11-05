// Deterministic checks of the simulation port (src/game/sim.ts). Run after `npm run build`.
// Uses the game data in original/utopia-whdload/Disk.2 (the user's own copy); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk2Path)) {
  console.log("sim tests skipped: original/utopia-whdload/Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState, A, PERIOD } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng, mulu, divuQ, divsQ, s16 } = await import("../dist/game/sim-math.js");

const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

function fresh(scenario = 0, seed = 1) {
  const state = new GameState(disk2, records[scenario].block);
  const world = new World(state, loadMap(disk2, records[scenario]));
  const sim = new Sim(world, { rng: createRng(seed) });
  return { state, world, sim };
}

// --- arithmetic helpers -----------------------------------------------------------------
check("mulu is low-word", mulu(0x10005, 3) === 15);
check("divuQ", divuQ(1000, 7) === 142);
check("divsQ truncates toward zero", divsQ(-250, 100) === -2);
check("s16", s16(0xffff) === -1);
{
  const a = createRng(5);
  const b = createRng(5);
  let same = true;
  let inRange = true;
  for (let i = 0; i < 1000; i++) {
    const x = a(30);
    if (x !== b(30)) same = false;
    if (x < 0 || x > 29) inRange = false;
  }
  check("rng deterministic and in range", same && inRange);
}

// --- date chain ---------------------------------------------------------------------------
{
  const { state } = fresh();
  check("start date", state.dateText() === "28/06/2090");
  const seen = { daily: 0, weekly: 0, monthly: 0, yearly: 0 };
  const dates = [];
  const frames = 336 * 90;
  for (let i = 0; i < frames; i++) {
    const due = state.tickFrame();
    if (due & PERIOD.daily) seen.daily++;
    if (due & PERIOD.weekly) seen.weekly++;
    if (due & PERIOD.monthly) {
      seen.monthly++;
      dates.push(state.dateText());
    }
    if (due & PERIOD.yearly) seen.yearly++;
    state.setByte(A.pending, 0);
  }
  check("one year = 336 days", seen.daily === 336);
  check("48 weeks per year", seen.weekly === 48);
  check("12 months, 1 year", seen.monthly === 12 && seen.yearly === 1);
  check("first month roll is 01/07/2090", dates[0] === "01/07/2090");
  check("year rolls to 2091 at 01/01/2091", dates[6] === "01/01/2091" && state.long(A.year) === 2091);
}

// --- first month: income = pop * tax (+ grant) ------------------------------------------------
{
  const { state, sim } = fresh();
  const money = state.signedLong(A.money);
  const grant = state.long(0x135be);
  sim.monthly();
  const pop = state.long(A.population);
  const delta = state.signedLong(A.money) - money;
  check("month income = pop*tax + grant", delta === pop * state.long(A.tax) + grant, `pop=${pop} delta=${delta}`);
  check("grant counts down by 100", state.long(0x135be) === grant - 100);
  check("first month has no trade income", state.long(0x142f6) === 0);
  check("income registers", state.long(0x142fa) === pop * 10 && state.long(0x142f2) === grant);
  check("no starvation at start", state.byte(0x144b4) === 0 && state.byte(0x144b5) === 0);
  check("no shortage messages", sim.messages.length === 0, JSON.stringify(sim.messages));
  check("power fully available at start", state.byte(0x144c8) === 0);
  check("food balance stored back", state.long(0x13152) > 0);
}

// --- food and air at the starting state of every scenario -----------------------------------
for (let sc = 0; sc < records.length; sc++) {
  const { state, sim } = fresh(sc);
  sim.monthly();
  check(`scenario ${sc}: no shortage after first month`, state.byte(0x144b4) === 0 && state.byte(0x144b5) === 0 && state.byte(0x144c8) === 0 && state.byte(0x144c4) === 0);
}

// --- shortage behaviour ---------------------------------------------------------------------
{
  const { state, sim } = fresh();
  state.setLong(0x13166, state.long(0x13166) - state.long(0x13152) * 100);
  state.setLong(0x13152, 0); // empty food store
  state.setLong(0x143be, 0);
  state.setLong(A.population, 1000);
  const morale = state.signedLong(A.morale);
  sim.monthly();
  check("food shortage sets starvation level", state.byte(0x144b4) > 0);
  check("food shortage lowers morale", state.signedLong(A.morale) < morale);
}
{
  const { state, sim } = fresh();
  state.setLong(A.population, 3000);
  sim.monthly();
  check("air shortage flag", state.byte(0x144b5) === 10);
}

// --- jobs: staffing caps move colonists into pools ----------------------------------------------
{
  const { state, sim } = fresh();
  sim.setJobCap(7, 50);
  sim.monthly();
  const employed = state.long(0x1313a);
  const total = employed + state.long(0x13136) + state.long(0x143be) + state.long(0x143c2);
  check("job allocation conserves colonists", total === state.long(A.population), `employed=${employed} total=${total} pop=${state.long(A.population)}`);
}

// --- production: a workshop (pool 5) with staff makes good 4; weights stay consistent ----------------
{
  const { state, world, sim } = fresh();
  const t23 = world.typeAddress(23);
  state.setWord(t23 + 0x0c, 2); // two workshops
  sim.setJobCap(5, 20);
  for (let m = 0; m < 6; m++) sim.monthly();
  const weights = [100, 200, 1, 2000, 1000];
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += state.long(0x13152 + 4 * i) * weights[i];
  check("workshop staffed from free colonists", state.long(0x143ea + 4 * 5) === 20, String(state.long(0x143ea + 4 * 5)));
  check("workshop output stored as good 4", state.long(0x13152 + 16) > 0, String(state.long(0x13152 + 16)));
  check("stored weight equals sum of goods", sum === state.long(0x13166), sum + " vs " + state.long(0x13166));
}

// --- game over -------------------------------------------------------------------------------
{
  const { state, sim } = fresh();
  state.setLong(A.population, 10);
  state.setByte(A.pending, PERIOD.daily);
  sim.run();
  check("game over when the population dies out", sim.gameOver && sim.events.some((e) => e.kind === "announce" && e.id === 1));
}

// --- five years without player action --------------------------------------------------------------
{
  const { state, sim } = fresh(0, 12345);
  const frames = 5 * 336 * 90;
  let minQol = 1e9;
  let maxQol = -1;
  let minMorale = 1e9;
  let maxMorale = -1e9;
  let over = false;
  for (let i = 0; i < frames; i++) {
    sim.tick();
    if (sim.gameOver) {
      over = true;
      break;
    }
    const q = state.long(A.qualityOfLife);
    if (q !== 0) {
      minQol = Math.min(minQol, q);
      maxQol = Math.max(maxQol, q);
    }
    const m = state.signedLong(A.morale);
    minMorale = Math.min(minMorale, m);
    maxMorale = Math.max(maxMorale, m);
  }
  const money = state.signedLong(A.money);
  console.log(
    `    5y: date ${state.dateText()} pop ${state.long(A.population)} free ${state.long(0x13136)} money ${money} qol ${state.long(A.qualityOfLife)} (${minQol}..${maxQol}) morale ${state.signedLong(A.morale)} (${minMorale}..${maxMorale}) crime ${state.signedLong(0x142ce)} food ${state.long(0x13152)} starve ${state.byte(0x144b4)} air ${state.byte(0x144b5)} crowd ${state.byte(0x144c4)} power ${state.byte(0x144c8)} msgs ${sim.messages.length}`,
  );
  check("5y: reached 28/06/2095", state.dateText() === "28/06/2095" || over, state.dateText());
  check("5y: colony survived", !over);
  check("5y: QoL in 10..98", minQol >= 10 && maxQol <= 98, `${minQol}..${maxQol}`);
  check("5y: morale within +-10000", minMorale >= -10000 && maxMorale <= 10000, `${minMorale}..${maxMorale}`);
  check("5y: money is an integer", Number.isInteger(money) && Math.abs(money) < 2 ** 31);
  const pop = state.long(A.population);
  check("5y: population plausible", pop > 0 && pop < 20000, String(pop));
  const words = [0x13136, 0x1313a, 0x1314a, 0x13152, 0x13166, 0x14234, 0x142ce, 0x144ec].every((a) => Number.isFinite(state.long(a)));
  check("5y: state words finite", words);
  check("5y: weight within capacity", state.long(0x13166) <= state.long(0x14432));
}

// --- research ($AB0C) -------------------------------------------------------------------------------
{
  const { state, sim } = fresh(0, 3);
  state.setWord(0x133f8, 1);
  state.setByte(0x144c8, 0);
  state.setLong(0x13142, 200);
  state.setLong(0x142d2, 1000000);
  state.setLong(0x142d6, 1000000);
  state.setLong(0x142de, 0);
  const before = state.byte(A.techLevel);
  const bits = state.long(0x14472);
  sim.research();
  check("research: funds spent", state.long(0x142d2) < 1000000 && state.long(0x142d6) < 1000000);
  check("research: progress made", state.long(0x142de) > 0);
  const mid = state.byte(A.techLevel);
  state.setLong(0x13142, 0);
  state.setLong(0x142de, 1000000);
  sim.research();
  check("research: level rises past threshold", state.byte(A.techLevel) === mid + 1 && mid >= before, `${before} ${mid} ${state.byte(A.techLevel)}`);
  check("research: invention bits set", state.long(0x14472) !== bits);
  state.setWord(0x133f8, 0);
  const level = state.byte(A.techLevel);
  state.setLong(0x142de, 99999999);
  sim.research();
  check("research: needs a command centre", state.byte(A.techLevel) === level && sim.messages.includes(0xef));
}

// --- determinism ------------------------------------------------------------------------------------
{
  const run = (seed) => {
    const { state, sim } = fresh(0, seed);
    for (let i = 0; i < 2 * 336 * 90; i++) sim.tick();
    return [state.long(A.population), state.signedLong(A.money), state.signedLong(A.morale), sim.messages.length].join(",");
  };
  check("same seed, same result", run(7) === run(7));
}

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all sim checks passed");
