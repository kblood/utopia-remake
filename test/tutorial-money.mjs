// Focused analysis check for the first-pass money gap of the tutorial route (notes/formats/game-proper.md, "Money gap of the first pass";
// notes/HANDOFF-2026-11-12.md, addendum). The one live capture has money 506050 after the first `$99C4` (500000 at the start); the remake's
// route gives 506030. This test pins what the remake does, and what its own first pass would need in order to give the captured value.
// It does NOT claim that the original's draw had any particular value: the capture records each `$2DCC` call's entry D0/D2 and return
// address, but not the result, and not population or births. So the checks below are about the remake's model and its consistency
// with the recorded RNG ranges, not about the original's money.
//
// Checks:
//   1. Decomposition: the exit's first pass adds exactly `$142FA` (pop x tax, copied by finance) plus `$142F2` (the grant copy) to money,
//      with the trade bit `$144C2` bit 0 clear in the held state (static: no trade income in the first month), and population 103.
//   2. Sensitivity: money after the first pass depends on the births draw (`roll(30)` at `$9BCC`, the only RNG draw before `finance`
//      that changes population). A forced draw of 24 gives 506040, 25 gives 506050 (the captured value); the seeded remake draw is 7.
//   3. Recorded ranges: the remake's market table (`$1316A`, 12 entries of 10 bytes, range = max - min) gives the ranges that the
//      capture's `$2DCC` entries show for the entries they reached (19, 19, 9, 290, 29, 29, 100, 200, 4, 60, 100), and the exit update makes
//      one apparition draw (range 10), one births draw (range 30), one crime draw (range 20) and 29 market-walk / supply draws, 32 in total
//      (the capture's count after the icon-6 click).
//
// Uses the user's own Disk.1 / Disk.2 (read-only); skipped when missing. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("tutorial money tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { Screen } = await import("../dist/gfx/screen.js");
const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
const { Sim } = await import("../dist/game/sim.js");
const { A } = await import("../dist/game/state.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- RNG trace and forced draw (wraps Sim.roll only for this process) ------------------------------------------------------------
const origRoll = Sim.prototype.roll;
let trace = null;
let force = null;
Sim.prototype.roll = function (range) {
  let value;
  if (force && range === force.range && !force.used) {
    force.used = true;
    value = force.value;
  } else {
    value = origRoll.call(this, range);
  }
  if (trace) trace.push({ range, value });
  return value;
};

// ---- boot to the tutorial held scene (the same input as test/tutorial-route.mjs) ----------------------------------------------
function bootGame() {
  const game = new Game(disk1, disk2, null, null);
  game.stage = "language";
  game.language = { pointerVisible: true, screen: new Screen(), picturePalette: decodePicture(disk1, PICTURES.language).palette, update: () => ({ state: "chosen", language: 0 }) };
  return game;
}
function passBoot(g, limit = 20000) {
  let inCheck = 0;
  for (let n = 1; g.stage === "boot"; n++) {
    if (n > limit) throw new Error("the boot stages did not finish");
    if (g.boot.currentPhase === "E") inCheck++;
    g.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: inCheck === 50 ? ["Enter"] : [] });
  }
}
const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
let game = null;
const frame = (down, x = 0, y = 0) => {
  input.leftButton = down;
  input.pointerX = x;
  input.pointerY = y;
  game.update({ ...input });
};
const idle = () => frame(false, 0, 0);
const iconClick = (i) => {
  idle();
  const x = DISK_MENU_BUTTONS[i].x0 + 16;
  const y = DISK_MENU_BUTTONS[i].y0 + 16;
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
};

// Runs the route once; `forced` (optional) fixes the first range-30 draw (the births draw) during the first pass. The tutorial now
// enters at icon 6 (`$80C8` ends with `bra $802C`), and that update runs the first pass, so the draws are traced on that click. The
// "before" state is a probe built by the same routine (`tutorialScene`) before the click.
function runRoute(forced = null) {
  game = bootGame();
  idle();
  passBoot(game);
  const probe = game.tutorialScene();
  const heldState = probe.world.state;
  const before = {
    money: heldState.signedLong(A.money),
    tradeBits: heldState.byte(0x144c2),
  };
  force = forced === null ? null : { range: 30, value: forced, used: false };
  trace = [];
  iconClick(DISK_BUTTON.tutorial);
  const calls = trace;
  trace = null;
  force = null;
  if (game.stage !== "map" || game.map === null) throw new Error("the tutorial did not enter the map");
  const state = game.map.world.state;
  return {
    before,
    calls,
    money: state.signedLong(A.money),
    population: state.long(0x1314a),
    income: state.long(0x142fa), // finance: pop x tax (before the grant)
    grant: state.long(0x142f2), // finance: grant copy (the grant added this month)
    births: state.long(0x1432e),
    deaths: state.long(0x14332),
    tax: state.long(0x144f4),
  };
}

// ---- 3. recorded ranges (static table, no RNG) ------------------------------------------------------------------------------------
// The table is copied at boot; the ranges are `max - min` per entry, as walkEntry rolls them. Read once from a tutorial probe.
game = bootGame();
idle();
passBoot(game);
const tableState = game.tutorialScene().world.state;
const ranges = [];
for (let i = 0; i < 12; i++) {
  const a = 0x1316a + 10 * i;
  ranges.push(tableState.word(a + 4) - tableState.word(a + 2));
}
// Entries 1, 2, 4..8, 10..12 (index 0, 1, 3..7, 9..11) appear in the capture as the second draw of a walk step; entry 3 (index 2) shows
// range 9 there. Entry 9 (index 8) was not reached by the capture's branches.
const CAPTURE_WALK_RANGES = { 0: 19, 1: 19, 2: 9, 3: 290, 4: 29, 5: 29, 6: 100, 7: 200, 9: 4, 10: 60, 11: 100 };
for (const [i, r] of Object.entries(CAPTURE_WALK_RANGES)) {
  check(`market entry E${Number(i) + 1} range (max - min) = ${r} (capture second-draw range)`, ranges[Number(i)] === r, `remake ${ranges[Number(i)]}`);
}

// ---- 1 and 2: the seeded route, then forced births draws --------------------------------------------------------------------------
const seeded = runRoute(null);
const delta = seeded.money - seeded.before.money;
check("start money 500000 ($7A120) in the held tutorial scene", seeded.before.money === 500000, `money ${seeded.before.money}`);
check("trade bit 0 of $144C2 clear in the held state (no trade income in the first month)", (seeded.before.tradeBits & 0x01) === 0, `$144C2 ${seeded.before.tradeBits}`);
check("the first pass adds finance pop x tax plus grant, nothing else", delta === seeded.income + seeded.grant, `delta ${delta} = ${seeded.income} + ${seeded.grant}`);
check("tax 10 and grant 5000 at the first pass", seeded.tax === 10 && seeded.grant === 5000, `tax ${seeded.tax} grant ${seeded.grant}`);
check("seeded remake route: population 103 after births and deaths (births 4, deaths 1)", seeded.population === 103 && seeded.births === 4 && seeded.deaths === 1,
  `pop ${seeded.population} births ${seeded.births} deaths ${seeded.deaths}`);
check("seeded remake route: money 506030 (recorded capture 506050)", seeded.money === 506030, `money ${seeded.money}`);

const nApparition = seeded.calls.filter((c) => c.range === 10).length;
const nBirths = seeded.calls.filter((c) => c.range === 30).length;
const nCrime = seeded.calls.filter((c) => c.range === 20).length;
check("exit update makes 32 draws, as the capture counted after the icon-6 click", seeded.calls.length === 32, `draws ${seeded.calls.length}`);
check("the first draw is the apparition (range 10); one births draw (30); one crime draw (20)",
  seeded.calls[0].range === 10 && nBirths === 1 && nCrime === 1, `apparition ${nApparition} births ${nBirths} crime ${nCrime}`);

// The births draw is the only one before finance that can change population. Forcing it: draw 24 gives 5 births (pop 104), draw 25 gives 6
// births (pop 105), which is the population at which the first pass reaches the captured 506050.
const at24 = runRoute(24);
check("births draw forced to 24: 5 births, population 104, money 506040", at24.births === 5 && at24.population === 104 && at24.money === 506040,
  `births ${at24.births} pop ${at24.population} money ${at24.money}`);
const at25 = runRoute(25);
check("births draw forced to 25: 6 births, population 105, money 506050 (the captured value)", at25.births === 6 && at25.population === 105 && at25.money === 506050,
  `births ${at25.births} pop ${at25.population} money ${at25.money}`);

Sim.prototype.roll = origRoll;

console.log("");
console.log("Not established: which births draw the original made (the capture has no result), the original's population at the first pass,");
console.log("and any original trade or grant difference. The 20-unit gap is 2 colonists x tax 10 in this model. See game-proper.md 'Money gap'.");

if (failed) {
  console.log(`${failed} tutorial money check(s) failed`);
  process.exit(1);
}
console.log("all tutorial money checks passed");
