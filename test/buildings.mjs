// Headless checks of the building click windows (src/game/screens/buildings.ts): the record lookup, which
// click opens which window, the write-backs of every control and the instant actions. Run after
// `npm run build`. Needs the user's own game data (Disk.1 and Disk.2 in original/utopia-whdload);
// skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("building tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { loadBuiltinSprites } = await import("../dist/data/sprites.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { Ui } = await import("../dist/game/screens/ui.js");
const { UnitSystem } = await import("../dist/game/units.js");
const { cellFlagIndex } = await import("../dist/game/cell-flags.js");
const b = await import("../dist/game/screens/buildings.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const strings = new GameStrings(disk1, 0);
const ui = new Ui(disk1, strings);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A world with an empty object list: tests plant the records they need.
function fresh() {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  world.objects.fill(0);
  world.objectCount = 0;
  world.state.setWord(0x142c2, 0);
  const sim = new Sim(world, { rng: createRng(1) });
  const said = [];
  const ctx = { disk: disk1, world, sim, strings, say: (i) => said.push(i) };
  return { state, world, sim, ctx, said };
}

const W = 100;
const typeC = (world, type) => world.state.word(world.typeAddress(type) + 0xc);
const setTypeC = (world, type, v) => world.state.setWord(world.typeAddress(type) + 0xc, v);
const typeA = (world, type) => world.state.word(world.typeAddress(type) + 0xa);

// Puts a building record and its map tiles on the map; returns the record's byte offset.
function plant(world, tile, x, y, size = 1) {
  const at = world.objectCount * 8;
  world.objectCount++;
  world.state.setWord(0x142c2, world.objectCount);
  world.objects[at] = tile >> 8;
  world.objects[at + 1] = tile & 255;
  world.objects[at + 3] = 0;
  world.objects[at + 4] = x;
  world.objects[at + 5] = y;
  const parts = size === 1 ? [[0, 0]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
  parts.forEach(([dx, dy], n) => {
    const i = (y + dy) * W + x + dx;
    world.cells[i] = (world.cells[i] & 0x8000) | (tile + n);
  });
  return at;
}

const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };

const primed = new WeakSet();

function click(scene, x, y) {
  // The first frame of a scene must see the buttons up (a press held at open does not count).
  if (!primed.has(scene)) {
    primed.add(scene);
    input.leftButton = false;
    scene.update(input);
  }
  input.pointerX = x;
  input.pointerY = y;
  input.leftButton = true;
  scene.update(input);
  input.leftButton = false;
  return scene.update(input);
}

function clickButton(scene, index) {
  const { x, y } = ui.buttonPosition(index);
  return click(scene, x + 4, y + 4);
}

function drawn(scene) {
  const screen = new Screen();
  scene.draw(screen);
  return screen.pixels.slice();
}

const differs = (a, b2) => a.some((v, i) => v !== b2[i]);

// --- record lookup ($72C0) ------------------------------------------------------------------
{
  const { world } = fresh();
  const cc = plant(world, 0x4c, 20, 20, 4);
  const yard = plant(world, 0x36, 30, 30);
  const mine = plant(world, 0x60, 40, 40);
  check("lookup: every cell of a 2x2 building finds its record", [[20, 20], [21, 20], [20, 21], [21, 21]].every(([x, y]) => b.findRecord(world, x, y) === cc));
  check("lookup: single-cell building", b.findRecord(world, 30, 30) === yard && b.findRecord(world, 40, 40) === mine);
  check("lookup: empty ground has no record", b.findRecord(world, 50, 50) === -1);
  const count = world.state.word(0x142c2);
  const savedObjects = world.objects.slice();
  const offPrefix = 20 * 8;
  world.objects.set(world.objects.slice(cc, cc + 8), offPrefix);
  world.objects[cc] = 0;
  world.objects[cc + 1] = 0;
  world.state.setWord(0x142c2, count - 1);
  check("lookup ignores a matching record after the counted non-empty prefix", b.findRecord(world, 20, 20) === -1);
  world.state.setWord(0x142c2, count);
  check("lookup reaches the sparse matching record when count includes it", b.findRecord(world, 20, 20) === offPrefix);
  world.objects.set(savedObjects);
  world.state.setWord(0x142c2, count);
  world.cells[20 * W + 21] = (world.cells[20 * W + 21] & 0xfc00) | 0x51; // an offline centre's second tile
  check("lookup: offline centre tiles belong to the same record", b.findRecord(world, 21, 20) === cc);
  world.cells[30 * W + 30] = 0x32;
  check("lookup: scaffold tile never finds a record", b.findRecord(world, 30, 30) === -1);
}

// --- messages and refusals ---------------------------------------------------------------------
{
  const { world, ctx, said } = fresh();
  world.cells[10 * W + 10] = 0x32;
  check("scaffold: message $7D, no window", b.createBuildingScreen(ctx, 10, 10) === null && said.at(-1) === 0x7d);
  world.cells[10 * W + 11] = 0x61;
  check("mine without record: message $89", b.createBuildingScreen(ctx, 11, 10) === null && said.at(-1) === 0x89);
  said.length = 0;
  world.cells[10 * W + 12] = 0x10; // plain ground tile: nothing
  check("bare ground: nothing", b.createBuildingScreen(ctx, 12, 10) === null && said.length === 0);
  check("outside the map: nothing", b.createBuildingScreen(ctx, -1, 5) === null && b.createBuildingScreen(ctx, 100, 5) === null);
}
{
  const { world, state, ctx, said } = fresh();
  plant(world, 0x4c, 20, 20, 4);
  plant(world, 0x0e, 24, 20);
  plant(world, 0x5c, 28, 20, 4);
  plant(world, 0x47, 33, 20);
  for (const [power, x, y, expectWindow] of [[1, 20, 20, true], [14, 20, 20, false], [14, 24, 20, true], [15, 24, 20, false], [1, 28, 20, true], [2, 28, 20, false]]) {
    state.setByte(0x144c8, power);
    said.length = 0;
    const scene = b.createBuildingScreen(ctx, x, y);
    check(`power ${power} at tile ${world.cell(x, y) & 0x3ff}: ${expectWindow ? "window" : "refused with $12E"}`, expectWindow ? scene !== null && said.length === 0 : scene === null && said.at(-1) === 0x12e);
  }
  state.setByte(0x144c8, 1);
  said.length = 0;
  check("teleporter refuses on any power shortage", b.createBuildingScreen(ctx, 33, 20) === null && said.at(-1) === 0x12e);
}
{
  const { world, state, ctx, said } = fresh();
  plant(world, 0x48, 20, 20, 4);
  const scene = b.createBuildingScreen(ctx, 20, 20);
  const type = world.findType(0x48);
  check("other buildings: only their name is said", scene === null && said.at(-1) === state.word(world.typeAddress(type) + 0x10));
}

// --- every window draws and leaves ---------------------------------------------------------------
{
  const { world, state, ctx } = fresh();
  state.setByte(0x144c8, 0);
  setTypeC(world, 29, 1);
  plant(world, 1, 10, 10);
  plant(world, 0x3f, 12, 10);
  plant(world, 0x40, 14, 10);
  plant(world, 0x4c, 20, 20, 4);
  plant(world, 0x0e, 24, 20);
  plant(world, 0x5c, 28, 20, 4);
  plant(world, 0x30, 33, 20);
  plant(world, 0x31, 35, 20);
  plant(world, 0x36, 37, 20);
  for (const [name, x, y] of [["power storage", 10, 10], ["fuel tank", 12, 10], ["large fuel tank", 14, 10], ["command centre", 20, 20], ["hospital", 24, 20], ["sports", 28, 20], ["missile launcher", 33, 20], ["large launcher", 35, 20], ["ship yard order", 37, 20]]) {
    const scene = b.createBuildingScreen(ctx, x, y);
    if (!scene) {
      check(`${name}: window opens`, false);
      continue;
    }
    scene.update(input); // the first frame never closes it
    const pixels = drawn(scene);
    check(`${name}: draws`, pixels.some((p) => p !== 0));
    check(`${name}: exit button closes`, clickButton(scene, 9) === "close");
    const again = b.createBuildingScreen(ctx, x, y);
    input.keys.push("Escape");
    check(`${name}: Escape closes`, again.update(input) === "close");
  }
}

// --- numbers on the read-out windows follow the state ----------------------------------------
{
  const { world, state, ctx } = fresh();
  plant(world, 1, 10, 10);
  plant(world, 0x3f, 12, 10);
  const a = drawn(b.createBuildingScreen(ctx, 10, 10));
  state.setWord(world.typeAddress(0) + 0xe, 500);
  check("storage window shows the stored power", differs(a, drawn(b.createBuildingScreen(ctx, 10, 10))));
  const f = drawn(b.createBuildingScreen(ctx, 12, 10));
  state.setWord(world.typeAddress(16) + 0xe, 300);
  check("fuel window shows the stored fuel", differs(f, drawn(b.createBuildingScreen(ctx, 12, 10))));
}

// --- command centre ------------------------------------------------------------------------------
{
  const { world, ctx } = fresh();
  const first = plant(world, 0x4c, 20, 20, 4);
  const second = plant(world, 0x4c, 30, 20, 4);
  world.objects[first + 3] = 0xff;
  setTypeC(world, 29, 1);
  const scene = b.createBuildingScreen(ctx, 31, 21); // any cell of the second centre
  clickButton(scene, 8);
  check("command centre: switching a second one on makes it the only online one", world.objects[second + 3] === 0xff && world.objects[first + 3] === 0 && typeC(world, 29) === 1);
  check("command centre: the first one shows offline tiles", (world.cell(20, 20) & 0x3ff) === 0x50 && (world.cell(21, 21) & 0x3ff) === 0x53);
  clickButton(scene, 8);
  check("command centre: switching the only one off", world.objects[second + 3] === 0 && typeC(world, 29) === 0 && (world.cell(30, 20) & 0x3ff) === 0x50);
  clickButton(scene, 8);
  check("command centre: switching it on again", world.objects[second + 3] === 0xff && typeC(world, 29) === 1 && (world.cell(30, 20) & 0x3ff) === 0x4c);
  check("command centre: a blank button does nothing", clickButton(scene, 3) === "running" && typeC(world, 29) === 1);
  const online = drawn(scene);
  clickButton(scene, 8);
  check("command centre: the window shows the new state", differs(online, drawn(scene)));
}

// --- hospital ------------------------------------------------------------------------------------
{
  check("birth rate cycle", [0, 0x14, 0x1e, 0x3c, 0x3c + 1, 7].map(b.nextBirthRate).join() === "20,30,60,0,0,0");
  check("birth rate strings", [0, 0x14, 0x1e, 0x3c, 9].map(b.birthRateLabel).join() === "46,47,48,49,49");
  const { world, state, ctx } = fresh();
  plant(world, 0x0e, 24, 20);
  const scene = b.createBuildingScreen(ctx, 24, 20);
  state.setByte(0x145a2, 0);
  const seen = [];
  for (let i = 0; i < 5; i++) {
    clickButton(scene, 8);
    seen.push(state.byte(0x145a2));
  }
  check("hospital: button 8 steps through the birth rates", seen.join() === "20,30,60,0,20");
}

// --- sports complex --------------------------------------------------------------------------------
{
  const { world, state, ctx } = fresh();
  plant(world, 0x5c, 28, 20, 4);
  state.setByte(0x144b2, 0);
  state.setByte(0x144b1, 0);
  const scene = b.createBuildingScreen(ctx, 29, 21);
  const idle = drawn(scene);
  clickButton(scene, 8);
  check("sports: calling an event sets 12 weeks and the event flag", state.byte(0x144b2) === 12 && (state.byte(0x144b1) & 1) === 1);
  const called = drawn(scene);
  check("sports: the window then announces the event", differs(idle, called));
  state.setByte(0x144b2, 7);
  state.setByte(0x144b1, 0);
  clickButton(scene, 8);
  check("sports: no second event while the countdown runs", state.byte(0x144b2) === 7 && state.byte(0x144b1) === 0);
  const reopened = b.createBuildingScreen(ctx, 29, 21);
  const waiting = drawn(reopened);
  state.setByte(0x144b2, 6);
  check("sports: the countdown is shown with its number", differs(waiting, drawn(b.createBuildingScreen(ctx, 29, 21))) && differs(idle, waiting));
}

// --- missile launchers ------------------------------------------------------------------------------
{
  const { world, state, ctx, said } = fresh();
  setTypeC(world, 8, 3);
  const at = plant(world, 0x30, 33, 20);
  world.objects[at + 3] = 0xff;
  state.setWord(world.typeAddress(8) + 0xa, 3);
  state.setWord(0x142c2, 7);
  let scene = b.createBuildingScreen(ctx, 33, 20);
  const noTarget = drawn(scene);
  clickButton(scene, 8);
  check("missile: without a target button 8 does nothing", world.objects[at + 1] === 0x30 && said.length === 0);
  const ranges = [];
  const hooks = {
    findTarget: (range, x, y) => {
      ranges.push([range, x, y]);
      return { x: 60, y: 40 };
    },
    launchMissile: (from, target) => {
      hooks.fired = [from, target];
      return true;
    },
  };
  scene = b.createBuildingScreen(ctx, 33, 20, hooks);
  check("missile: the search uses range 20 for the small launcher", ranges.length === 1 && ranges[0].join() === "20,33,20");
  check("missile: with a target the window differs (armed text, fire icon)", differs(noTarget, drawn(scene)));
  check("missile: firing closes the window", clickButton(scene, 8) === "close");
  check("missile: the target and origin reach the hook", hooks.fired[0].x === 33 && hooks.fired[1].x === 60 && hooks.fired[1].y === 40);
  check("missile: the launcher is gone (record, counters, rubble tile)", world.objects[at] === 0 && world.objects[at + 1] === 0 && typeC(world, 8) === 2 && typeA(world, 8) === 2 && state.word(0x142c2) === 6 && (world.cell(33, 20) & 0x3ff) === 0x9e);
  const big = plant(world, 0x31, 35, 20);
  ranges.length = 0;
  b.createBuildingScreen(ctx, 35, 20, hooks);
  check("missile: range 100 for the large launcher", ranges[0][0] === 100 && big > 0);
  said.length = 0;
  const failing = b.createBuildingScreen(ctx, 35, 20, { findTarget: () => ({ x: 1, y: 1 }), launchMissile: () => false });
  check("missile: a full ship list says $12B, closes and keeps the launcher", clickButton(failing, 8) === "close" && said.at(-1) === 0x12b && world.objects[big + 1] === 0x31);
}

// --- ship yard -------------------------------------------------------------------------------------
{
  check("ship months", b.shipMonths(50, 10, 2) === 9 && b.shipMonths(240, 0, 0) === 241 && b.shipMonths(0, 100, 1) === 1);
  const { world, state, ctx, said } = fresh();
  const yard = plant(world, 0x36, 37, 20);
  setTypeC(world, 29, 0);
  check("ship yard: refused without an active command centre ($B3)", b.createBuildingScreen(ctx, 37, 20) === null && said.at(-1) === 0xb3);
  setTypeC(world, 29, 1);
  setTypeC(world, 27, 1);
  state.setLong(0x14472, 0);
  const rects = Array.from({ length: 6 }, (_, k) => ({ x: ui.image.word(0xefe0 + 8 * k) + 8, y: ui.image.word(0xefe0 + 8 * k + 4) + 8 }));
  let scene = b.createBuildingScreen(ctx, 37, 20);
  const empty = drawn(scene);
  clickButton(scene, 8);
  check("ship yard: confirming without a choice changes nothing", world.objects[yard + 6] === 0 && world.objects[yard + 7] === 0);
  click(scene, rects[4].x, rects[4].y);
  check("ship yard: the locked fifth type cannot be chosen", !differs(empty, drawn(scene)));
  clickButton(scene, 8);
  check("ship yard: a locked type is not stored", world.objects[yard + 6] === 0);
  click(scene, rects[1].x, rects[1].y);
  check("ship yard: choosing a type shows its name and estimate", differs(empty, drawn(scene)));
  check("ship yard: confirming closes", clickButton(scene, 8) === "close");
  check("ship yard: the order is type + 1 and the work value of the table", world.objects[yard + 6] === 2 && world.objects[yard + 7] === ui.image.word(0xf012 + 2));
  const status = b.createBuildingScreen(ctx, 37, 20);
  check("ship yard: a yard with an order opens the status window", status !== null && differs(empty, drawn(status)));
  check("ship yard: the status window leaves on any button", clickButton(status, 9) === "close");
  world.objects[yard + 6] = 0;
  world.objects[yard + 7] = 0;
  state.setLong(0x14472, 0x10);
  scene = b.createBuildingScreen(ctx, 37, 20);
  const open = drawn(scene);
  check("ship yard: the fifth icon appears with its invention", differs(empty, open));
  click(scene, rects[4].x, rects[4].y);
  clickButton(scene, 8);
  check("ship yard: with the invention the fifth type can be ordered", world.objects[yard + 6] === 5 && world.objects[yard + 7] === ui.image.word(0xf012 + 8));
  // button 9 leaves the order untouched
  world.objects[yard + 6] = 0;
  scene = b.createBuildingScreen(ctx, 37, 20);
  click(scene, rects[0].x, rects[0].y);
  clickButton(scene, 9);
  check("ship yard: exit keeps the yard idle", world.objects[yard + 6] === 0);
}

// --- tank teleporter ---------------------------------------------------------------------------------
{
  const { world, state, ctx, said } = fresh();
  state.setByte(0x144c8, 0);
  plant(world, 0x47, 33, 20);
  const units = new UnitSystem(world.cells);
  let pins = Array.from({ length: 8 }, () => null);
  const hooks = { units, pin: (n) => pins[n] };
  check("teleporter: no tank, message $10A", b.createBuildingScreen(ctx, 33, 20, hooks) === null && said.at(-1) === 0x10a);
  const unit = units.spawn(9, 33, 20);
  const x = 33;
  said.length = 0;
  check("teleporter: a unit near a different cell is not found", b.unitNear(units, 35, 20) === null && b.unitNear(units, 34, 21) === unit);
  let scene = b.createBuildingScreen(ctx, x, 20, hooks);
  const none = drawn(scene);
  check("teleporter: without pins the window opens and leaves", scene !== null && clickButton(scene, 9) === "close" && unit.x === 33);
  pins = [null, null, { x: 60, y: 30 }, null, { x: 62, y: 32 }, null, null, null];
  world.cells[30 * W + 60] &= ~0x7400;
  world.cells[32 * W + 62] |= 0x1000; // a blocked destination
  scene = b.createBuildingScreen(ctx, x, 20, hooks);
  const withPins = drawn(scene);
  check("teleporter: placed pins show their icons", differs(none, withPins));
  const rect = (n) => ({ x: ui.image.word(0xee1e + 8 * n) + 8, y: ui.image.word(0xee1e + 8 * n + 4) + 10 });
  click(scene, rect(0).x, rect(0).y); // pin 1 is not placed: ignored
  check("teleporter: an unplaced pin cannot be selected", !differs(withPins, drawn(scene)));
  click(scene, rect(2).x, rect(2).y);
  check("teleporter: selecting a pin shows its number", differs(withPins, drawn(scene)));
  const spare = units.units.length;
  check("teleporter: confirming closes", clickButton(scene, 8) === "close");
  const to = 30 * W + 60;
  check("teleporter: the tank is on the pin, cell marks moved", unit.x === 60 && unit.y === 30 && (world.cells[to] & 0x4000) !== 0 && units.flags[cellFlagIndex(60, 30)] === 4 && (world.cells[20 * W + 33] & 0x4000) === 0 && units.flags[cellFlagIndex(33, 20)] === 0 && unit.reserveX === 60);
  check("teleporter: success message $10D", said.at(-1) === 0x10d && units.units.length === spare);
  world.cells[20 * W + 60] |= 0x4000;
  units.units[0].x = 33;
  units.units[0].y = 20;
  world.cells[20 * W + 33] |= 0x4000;
  scene = b.createBuildingScreen(ctx, x, 20, hooks);
  click(scene, rect(4).x, rect(4).y);
  clickButton(scene, 8);
  check("teleporter: a blocked destination aborts with $10E", said.at(-1) === 0x10e && unit.x === 33 && unit.y === 20);
  scene = b.createBuildingScreen(ctx, x, 20, hooks);
  clickButton(scene, 8);
  check("teleporter: confirming without a pin does nothing", unit.x === 33);
  world.cells[20 * W + 33] &= ~0x4000;
  said.length = 0;
  check("teleporter: the cell must hold a unit ($4000)", b.createBuildingScreen(ctx, x, 20, hooks) === null && said.at(-1) === 0x10a);
}

// --- gun turrets ------------------------------------------------------------------------------------
{
  const { world, state, ctx, said } = fresh();
  const at = plant(world, 0x1f, 20, 20);
  const cell = () => world.cells[20 * W + 20] & 0xff;
  const name = state.word(world.typeAddress(world.findType(0x1f)) + 0x10);
  world.objects[at + 2] = 3;
  world.objects[at + 6] = 1;
  world.cells[20 * W + 20] = (world.cells[20 * W + 20] & 0xff00) | 0x22;
  check("gun: a click returns no window", b.createBuildingScreen(ctx, 20, 20) === null);
  check("gun: it only stops an automatic turn and says the name", world.objects[at + 6] === 0 && cell() === 0x22 && world.objects[at + 2] === 3 && said.at(-1) === name);
  b.createBuildingScreen(ctx, 20, 20);
  check("gun: a stopped turret steps one facing", cell() === 0x23 && world.objects[at + 2] === 4);
  for (let i = 0; i < 3; i++) b.createBuildingScreen(ctx, 20, 20);
  check("gun: facing 7 is reached", cell() === 0x26 && world.objects[at + 2] === 7);
  b.createBuildingScreen(ctx, 20, 20);
  check("gun: the eighth step wraps to the base tile", cell() === 0x1f && world.objects[at + 2] === 0);
  world.cells[20 * W + 20] = (world.cells[20 * W + 20] & 0xff00) | 0x2a; // a firing frame
  world.objects[at + 7] = 9;
  world.objects[at + 2] = 3;
  b.createBuildingScreen(ctx, 20, 20);
  check("gun: a firing frame returns to the facing frame first", cell() === 0x23 && world.objects[at + 7] === 0 && world.objects[at + 2] === 4);
  const plasma = plant(world, 0x0f, 22, 20);
  world.cells[20 * W + 22] = (world.cells[20 * W + 22] & 0xff00) | 0x19;
  world.objects[plasma + 2] = 1;
  b.createBuildingScreen(ctx, 22, 20);
  check("gun: plasma firing frames are $17-$1E", (world.cells[20 * W + 22] & 0xff) === 0x12 && world.objects[plasma + 2] === 2);
}

// --- built-in sprites (window icons) --------------------------------------------------------------------
{
  const sprites = loadBuiltinSprites(disk1);
  check("sprites: the 14 icon types exist with 20 rows", [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16].every((t) => sprites.frame(t, 0) && sprites.frame(t, 0).rows >= 20));
  check("sprites: the set is cached", loadBuiltinSprites(disk1) === sprites);
}

console.log(failed === 0 ? "building tests passed" : `${failed} building test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
