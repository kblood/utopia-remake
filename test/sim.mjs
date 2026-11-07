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
  check("new-game $142A6 is zero elapsed years while the displayed date starts in 2090", state.dateText() === "28/06/2090" && state.long(A.year) === 0);
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
  check("year rolls to 2091 at 01/01/2091 while $142A6 counts elapsed years", dates[6] === "01/01/2091" && state.long(A.year) === 1);
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
  const bits = state.long(0x14476);
  sim.research();
  check("research: funds spent", state.long(0x142d2) < 1000000 && state.long(0x142d6) < 1000000);
  check("research: progress made", state.long(0x142de) > 0);
  const mid = state.byte(A.techLevel);
  state.setLong(0x13142, 0);
  state.setLong(0x142de, 1000000);
  sim.research();
  check("research: level rises past threshold", state.byte(A.techLevel) === mid + 1 && mid >= before, `${before} ${mid} ${state.byte(A.techLevel)}`);
  check("research: invention bits queued", state.long(0x14476) !== bits);
  state.setWord(0x133f8, 0);
  const level = state.byte(A.techLevel);
  state.setLong(0x142de, 99999999);
  sim.research();
  check("research: needs a command centre", state.byte(A.techLevel) === level && sim.messages.includes(0xef));
}

// --- tank yard ($A620) ------------------------------------------------------------------------------
{
  const spawned = [];
  const { state, world } = fresh(0, 5);
  const sim = new Sim(world, { rng: createRng(5), spawnUnit: (x, y, adv) => (spawned.push([x, y, adv]), true) });
  const at = world.objectCount * 8;
  world.objects.set([0, 0x45, 0, 0, 20, 30, 0, 0], at);
  world.objectCount++;
  state.setWord(0x133f8, 1);
  state.setByte(0x144c8, 0);
  state.setWord(0x1337a, 1);
  state.setLong(0x143fa, 8);
  state.setLong(0x13156, 100);
  state.setLong(0x1315a, 100); // good 1 and 3 stocks
  state.setLong(0x1315e, 100);
  sim.tankYard();
  check("tank yard: counter advances by workers", world.objects[at + 6] === 8, String(world.objects[at + 6]));
  sim.tankYard();
  sim.tankYard();
  check("tank yard: unit spawned at the yard", spawned.length === 1 && spawned[0][0] === 20 && spawned[0][1] === 30, JSON.stringify(spawned));
  check("tank yard: counter restarts", world.objects[at + 6] === 0);
}

// --- tank yard: observed staffing/ore trace (notes/formats/building.md, 2026-11-06) -------------------------------
// Staged as two separate monthly calls of `tankYard()` ($A620) under hand-set preconditions. The original observation
// is one scenario (index unidentified): yard staffed to 10 (`$143EA + 4*4` = `$143FA`), good-1 stock `$13156` 10 -> 0,
// yard progress (+6) 10, no tank, and later the message "Tank Yards require more ore". The original's call timing,
// the month in which the message appeared and everything about ore supply beyond the empty good-1 stock are NOT
// asserted; this only pins that the existing remake path produces the same end values.
{
  const spawned = [];
  const { state, world } = fresh(0, 5);
  const sim = new Sim(world, { rng: createRng(5), spawnUnit: (x, y, adv) => (spawned.push([x, y, adv]), true) });
  const at = world.objectCount * 8;
  world.objects.set([0, 0x45, 0, 0xff, 52, 36, 0, 0], at); // finished yard record, progress byte +6 = 0
  world.objectCount++;
  state.setWord(0x133f8, 1); // an active Command Centre
  state.setByte(0x144c8, 0); // power level
  state.setWord(0x1337a, 1); // one tank yard (T[22] total)
  state.setLong(0x143fa, 10); // job pool 4 (tank yard) assigned = 10
  state.setLong(0x13156, 10); // good 1 stock = 10
  state.setLong(0x1315e, 100); // good 3 stock, must stay untouched below 20 progress
  const tanks0 = state.word(0x1429c);

  sim.tankYard();
  check("tank yard trace: 10 workers and 10 good-1 give progress 10", world.objects[at + 6] === 10, String(world.objects[at + 6]));
  check("tank yard trace: the good-1 stock is consumed (10 -> 0), good 3 is not touched", state.long(0x13156) === 0 && state.long(0x1315e) === 100);
  check("tank yard trace: no tank and no ore message in the staffed month", spawned.length === 0 && state.word(0x1429c) === tanks0 && !sim.messages.includes(0x96));

  // Next month with the good-1 stock empty: the existing "more ore" warning, progress unchanged, still no tank.
  sim.tankYard();
  check("tank yard trace: empty good-1 stock gives message $96 and no spawned tank", sim.messages.includes(0x96) && spawned.length === 0 && state.word(0x1429c) === tanks0 && world.objects[at + 6] === 10 && state.long(0x13156) === 0);

  // The message index is tied to the observed text through the user's own Disk.1 string table (skipped without it).
  const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
  if (fs.existsSync(disk1Path)) {
    const { GameStrings } = await import("../dist/data/gamestrings.js");
    const text = String.fromCharCode(...new GameStrings(new Uint8Array(fs.readFileSync(disk1Path)), 0).get(0x96));
    check("tank yard trace: message $96 reads as the observed 'Tank Yards require more ore'", /tank yards require more ore/i.test(text), text);
  }
}

// --- mine collapse ($11090) -----------------------------------------------------------------------
{
  const hit = [];
  const { state, world } = fresh(0, 9);
  const sim = new Sim(world, { rng: createRng(9), demolishAt: (x, y) => hit.push([x, y]) });
  const at = world.objectCount * 8;
  world.objects.set([0, 0x60, 0, 0, 33, 44, 0, 0], at);
  world.objectCount++;
  state.setWord(0x133c2, 1);
  const morale = state.signedLong(A.morale);
  sim.eventMineCollapse(100);
  const last = hit[hit.length - 1];
  check("mine collapse: a mine is demolished", hit.length === 1 && state.word(0x133c2) === 1 && last !== undefined);
  check("mine collapse: morale drops", state.signedLong(A.morale) < morale);
  check("mine collapse: message", sim.messages.includes(0xdf));
}

// --- tank requisition ($11280) --------------------------------------------------------------------
{
  const mk = () => {
    const { state, world } = fresh(0, 11);
    const sim = new Sim(world, { rng: createRng(11), interactive: true });
    state.setWord(0x1429c, 20);
    state.setLong(0x14254, 20);
    return { state, sim };
  };
  const a = mk();
  const money = a.state.signedLong(A.money);
  a.sim.eventTankRequisition(100);
  check("tank requisition: dialog pending", a.sim.pending !== null && a.sim.pending.offer.what === "tanks");
  const n = a.sim.pending.offer.count;
  a.sim.resolveOffer(true);
  check("tank requisition: tanks handed over", a.state.word(0x1429c) === 20 - n && a.state.long(0x14254) === 20 - n, `${n}`);
  const b = mk();
  b.sim.eventTankRequisition(100);
  const fine = b.sim.pending.offer.price;
  b.sim.resolveOffer(false);
  check("tank requisition: refusal costs the fine", b.state.word(0x1429c) === 20 && b.state.signedLong(A.money) === money - fine);
}

// --- crime consequences ($10D00, $10D9E) ---------------------------------------------------------
{
  const { state, sim } = fresh();
  state.setLong(A.morale, 0);
  state.setLong(A.population, 100);
  state.setLong(0x13146, 0); // no security workers
  sim.rng = (range) => range === 20 ? 10 : 0;
  sim.crimeMonthly();
  const yearZeroCrime = state.signedLong(0x142ce);
  state.setLong(A.year, 5);
  sim.crimeMonthly();
  const yearFiveCrime = state.signedLong(0x142ce);
  check("early crime bonus uses elapsed $142A6 years (40 points at year 0, none at year 5)", yearZeroCrime === 10 && yearFiveCrime === 50, `${yearZeroCrime}/${yearFiveCrime}`);
}
{
  const hit = [];
  const { state, world } = fresh(0, 13);
  const sim = new Sim(world, { rng: createRng(13), demolishAt: (x, y) => hit.push([x, y]) });
  state.setLong(0x142ce, 55);
  state.setByte(0x144c6, 0); // no security: arson cannot be stopped
  state.setByte(0x144bc, 6);
  state.setLong(0x14472, state.long(0x14472) & ~8);
  const morale = state.signedLong(A.morale);
  sim.eventCrime();
  check("crime 55: a building is bombed", hit.length === 1 && sim.messages.includes(0x119), JSON.stringify(sim.messages));
  check("crime 55: morale falls", state.signedLong(A.morale) < morale);
  state.setLong(0x142ce, 70);
  state.setByte(0x144be, 1);
  sim.sysFlags = 1;
  sim.eventCrime();
  check("crime 70: colony falls", sim.gameOver && sim.events.some((e) => e.kind === "announce" && e.id === 0));
}

// --- $9C80 fractional death roll: range 100, not the death percent -------------------------------------------
// Regression for a divergence found by the optional 01/11/2090 comparison (test/production-original-compare.mjs):
// the original draws the fractional-colonist roll with range 100 (the remainder of the divide by 100 is a percentage),
// the port used the death percent, so with percent 1-2 every fraction killed a colonist. Synthetic, not an original replay.
{
  const run = (roll) => {
    const { state, sim } = fresh();
    const ranges = [];
    sim.rng = (range) => { ranges.push(range); return roll; }; // test seam: the field is readonly only in TypeScript
    for (let i = 0; i < 9; i++) state.setLong(0x143ea + 4 * i, 0);
    state.setLong(0x143ea, 6); // pool 0: 6 assigned, percent 2 -> 12 / 100 = 0 colonists + remainder 12
    state.setLong(0x1313a, 6); // employed
    state.setLong(0x13136, 0); // no free colonists, so only the pool fraction is decided
    state.setLong(A.population, 100);
    const removed = sim.deaths(2);
    return { ranges, removed, assigned: state.long(0x143ea), employed: state.long(0x1313a), pop: state.long(A.population) };
  };
  const high = run(50); // 50 > remainder 12: no death
  check("fraction roll: range is 100, not the percent", high.ranges.length === 1 && high.ranges[0] === 100, JSON.stringify(high.ranges));
  check("fraction roll above the remainder: nobody dies", high.removed === 0 && high.assigned === 6 && high.employed === 6 && high.pop === 100);
  const equal = run(12); // roll <= remainder: one death
  check("fraction roll at the remainder: one death", equal.removed === 1 && equal.assigned === 5 && equal.employed === 5 && equal.pop === 99, JSON.stringify(equal));
  const low = run(0);
  check("fraction roll 0: one death", low.removed === 1 && low.assigned === 5);
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
