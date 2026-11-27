// Ship and tank lifecycle through the real Game (src/game/game.ts), driven by Game.update clicks and keys: the chain a player follows to get
// ships and tanks, and the alien defeat that the front fleet reaches through the weekly battle (sim-aliens.ts weeklyBattle, sim.ts weekly).
//
// Chain (scenario 1 of the disk, the first scenario; every scenario starts with one launch pad, tile $48, active flag $FF):
//   1. staffing window (button 6): the ship yard's pool (job pool 3) and the tank yard's pool (pool 4) are capped by the player's number entry;
//   2. intelligence window (button 7): the grant is funded by a number entry (level 3 needs 20000 or more);
//   3. market (trade button 4, then the market button 8): ore is bought with a number entry, one trade a month;
//   4. the build menu places a ship yard within 5 cells of the pad (the launch search $4060) and near the command centre (nearBase);
//   5. the yard window (left click on the yard) orders a ship class (icon k, then button 8);
//   6. the yard finishes its ore and weapons stages, and the launch takes the free pad cell (sim-ships.ts shipYard / launch);
//   7. the new ship has NO fuel (sim-ships.ts createShip, notes/formats/building-screens.md 4): it refuses orders with message $ED
//      until the weekly refuelling ($4798, sim-ships.ts weeklyRefuel) fills it on a pad tile with a fuel tank within reach;
//   8. the fuel tank is built from the build menu next to the pad, and the stock is given by Sim.storeFuel (declared poke);
//   9. the ship window (right click on the ship): pin 1 (marker placed with the pin key), order "land at the pin", then "to the front".
//  10. the market dump (trade button 4, market button 8, the food row, dump button 8) sells the food surplus out of the warehouses, so
//      the goods of the yards fit under the weight capacity (sim.ts addGoods, $A2DE); one trade a month, as the original.
//  11. a tank yard (build menu page 2, index 5 = tile $45) is placed and staffed (pool 4); the yard turns ore and weapons into a tank
//      (sim.ts tankYard, $A620) on a free cell next to it; the tank window (right click on the tank: icon 5 "to the front", the count
//      and Return, then the exit button) sends it off the map to the front (sim-aliens.ts sendToFront).
//
// Declared pokes (state written outside the UI; each is a resource, staff, invention or random-event supply, never the tested step):
//   P-events           the chance bytes $13118+k of the daily events that bomb, wreck or requisition (slots 1, 4, 6-12, 14-19) are set to 0
//                      (sim.ts eventScheduler: a zero byte skips the slot). Slots 0 (colonist offers), 2 (invention), 3 (battle report) and
//                      13 (intelligence step) are kept. Without this, a random bombing destroys the yard, the warehouses and the command centre.
//   P-ore / P-weapons  Sim.addGoods(units, good) to top the stock up to the need of the next order (the market's own write, capacity-bounded;
//                      the call's `added` is checked, so a refused top-up fails the test).
//   P-fuel             Sim.storeFuel(units) to fill the tanks (the fuel plant's own write; no fuel plant is built).
//   P-invention        $14472 bit 4 (the fusion invention, class 5 / ship type 15), which the research would normally reach at tech 10.
// The ship, the tank, the pad, the yard and tank-yard orders, the build countdowns, the front orders and the alien battle are never poked.
// The save and the load go through Game's own saveToSlot / loadFromSlot (private methods, called by the save and load pages).
//
// Alien defeat: with the ships and tanks at the front, the weekly battle runs in the simulation until the victory flag ($156AA bit 2 =
// noUnitBonus) and $14132 = $FF are set. The test then checks the victory message, a game year of play, and a save and load.
//
// Uses the user's own Disk.1 / Disk.2 (read-only); skipped when they are missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("ship-lifecycle tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const dist = (p) => import(pathToFileURL(path.join(root, "dist", p)).href);
const { Game } = await dist("game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await dist("game/disk-menu.js");
const { Ui } = await dist("game/screens/ui.js");
const { GameImage } = await dist("game/screens/image.js");
const { BUILD_MENU_HITBOXES } = await dist("game/build-menu.js");
const { A } = await dist("game/state.js");
const { SYS } = await dist("game/sim.js");
const { isMissile } = await dist("game/sim-ships.js");
const { NO_TARGET, BLOCKED, OCCUPIED, TURNS, DIR_STEP, inMap } = await dist("game/units.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

// ---- bookkeeping -----------------------------------------------------------------------------------------------------------------
const started = Date.now();
const counts = { ok: 0, failed: 0 };
const failedNames = [];
const pokes = [];
const notes = [];
const messageLog = [];
let updates = 0;

function check(name, ok, detail = "") {
  if (ok) {
    counts.ok++;
    console.log(`ok   ${name}`);
  } else {
    counts.failed++;
    failedNames.push(name);
    console.log(`FAIL ${name}${detail ? "  " + detail : ""}`);
  }
  return ok;
}
const note = (text) => {
  notes.push(text);
  console.log(`note ${text}`);
};
const poke = (text) => {
  pokes.push(text);
  console.log(`poke ${text}`);
};

// ---- the game and the driver -----------------------------------------------------------------------------------------------------
const music = {
  trackCount: 4, current: -1, paused: false,
  get active() { return false; }, setActive() { return false; }, play() {}, stop() {}, fadeOut() {},
  setVolume() {}, setChannelMuted() {}, resume() {}, title: () => "", dispose() {},
};
const NONE = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const at = (left, x = 0, y = 0, right = false, keys = []) => ({ leftButton: left, rightButton: right, pointerX: x, pointerY: y, keys });

let game = null;
let map = null;
let ui = null;
let img = null;

function upd(input = NONE) {
  try {
    game.update({ ...NONE, ...input, keys: input.keys ?? [] });
  } catch (error) {
    throw new Error(`update crashed at stage ${game.stage}: ${error?.stack ?? error}`);
  }
  updates++;
}
const idle = (n = 1) => { for (let i = 0; i < n; i++) upd(NONE); };
function settle() {
  for (let n = 0; n < 40; n++) {
    if (game.stage === "announce") {
      upd(at(false, 279, 146)); upd(at(true, 279, 146)); upd(at(false, 279, 146));
    } else if (game.stage === "offer") {
      const accept = game.map?.sim.pending?.offer?.price * 2 < game.map.world.state.signedLong(A.money);
      const x = accept ? 111 : 207;
      upd(at(false, x, 148)); upd(at(true, x, 148)); upd(at(false, x, 148));
    } else return;
  }
}
// A left click: held for 5 updates, released for 5, then idle so the map reads it on a completed pass (playthrough.mjs click).
function click(x, y) {
  settle();
  for (let i = 0; i < 5; i++) upd(at(true, x, y));
  for (let i = 0; i < 5; i++) upd(at(false, x, y));
  idle(4);
}
// A right click at a screen point (the pick uses the pointer: a point with no cell picks nothing).
function rightClickAt(x, y) {
  settle();
  for (let i = 0; i < 5; i++) upd(at(false, x, y, true));
  for (let i = 0; i < 5; i++) upd(at(false, x, y));
  idle(4);
}
// Runs the map for n updates (dialogs answered as they come). Returns false when the stage leaves the map.
function runMap(n) {
  for (let i = 0; i < n; i++) {
    settle();
    if (game.stage !== "map") return false;
    upd(NONE);
  }
  return true;
}
// Leaves every window and the build mode: a right click on the map, then EXIT (button 9) for windows that are still open.
function closeWindows() {
  for (let i = 0; i < 6 && game.stage === "screen"; i++) click(...cmd(9));
  if (game.stage === "map" && map.controls.mode !== "select") rightClickAt(0, 0);
}
// Map button centres: the command column rectangles (`Ui.buttonPosition`, `$5E06`), used by every window's buttons 0-9.
const cmd = (i) => { const p = ui.buttonPosition(i); return [p.x + 8, p.y + 8]; };
// Window rectangles of 8 bytes {x0, x1, y0, y1} at an image address (the yard's icons `$EFE0`, the pins `$F056`).
const rectCentre = (table, k) => {
  const a = table + 8 * k;
  return [(img.word(a) + img.word(a + 2)) >> 1, (img.word(a + 4) + img.word(a + 6)) >> 1];
};
// Scroll arrows (map.ts ARROWS): a right press on an arrow scrolls the view 6 cells and is never a pick.
const ARROW_CENTRE = { left: [226, 127], up: [250, 127], down: [226, 141], right: [250, 141] };
// Brings cell (x, y) into the 8 x 8 view by pressing the scroll arrows (the view moves on its own after bombings and launches).
function ensureView(x, y) {
  for (let i = 0; i < 12 && !inView(x, y); i++) {
    const [vx, vy] = viewOf(x, y);
    if (vx < 0) rightClickAt(...ARROW_CENTRE.left);
    else if (vx >= 8) rightClickAt(...ARROW_CENTRE.right);
    else if (vy < 0) rightClickAt(...ARROW_CENTRE.up);
    else rightClickAt(...ARROW_CENTRE.down);
  }
  return inView(x, y);
}
// Map view cell (vx, vy) centre (controls.pickCell: x0 = 112 + 16 (vx - vy), y0 = 24 + 8 (vx + vy), 32 x 15).
const viewPoint = (vx, vy) => [112 + 16 * (vx - vy) + 15, 24 + 8 * (vx + vy) + 7];
const viewOf = (x, y) => [x - map.scrollX, y - map.scrollY];
const pointOfCell = (x, y) => viewPoint(...viewOf(x, y));

function inView(x, y) {
  const [vx, vy] = viewOf(x, y);
  return vx >= 0 && vy >= 0 && vx < 8 && vy < 8;
}

// Words of the object records (8 bytes: tile word at +0, x at +4, y at +5, record bytes as in build.ts place).
const objects = () => map.world.objects;
const recordTile = (s) => (objects()[s * 8] << 8) | objects()[s * 8 + 1];
function findRecord(tile, x, y) {
  for (let s = 0; s < 1000; s++) {
    if (recordTile(s) === tile && objects()[s * 8 + 4] === x && objects()[s * 8 + 5] === y) return s * 8;
  }
  return -1;
}
const state = () => map.world.state;
const cellWord = (x, y) => map.world.cells[y * 100 + x];
const cellTile = (x, y) => cellWord(x, y) & 0x3ff;
const fleetShips = () => map.sim.fleet.ships.filter((s) => !isMissile(s));
const ownTanks = () => map.objects.units.units.filter((u) => u.type === 9 || u.type === 10);
const dateKey = () => `${state().byte(A.day)}/${state().byte(A.month)}/${state().long(A.year)}`;

// Word addresses of the goods stock (sim.ts V.stock, $13152 + 4 good) and the other values the test reads.
const STOCK = 0x13152;
const GOOD = { food: 0, ore: 1, weapons: 3 };
const TRADE_FLAGS = 0x144c2; // bit 1: has traded this month (trade.ts marketRefusal, $A5)
const FOOD_KEEP = 500; // the food the dump leaves in the stores (a population's month of food, and a margin)

// ---- the player's actions, each through the UI ------------------------------------------------------------------------------------

// Staffing window (button 6): the row of job pool `pool` (rows 0-8, the spacer row 6 skipped: poolOfRow), then a number and Return.
function setStaff(pool, level) {
  click(...cmd(6));
  check(`staffing window opens (pool ${pool + 1} to ${level})`, game.stage === "screen");
  const row = pool >= 6 ? pool + 1 : pool;
  click(115, 40 + 9 * row + 4);
  const digits = String(level).split("");
  upd({ keys: [...digits, "Enter"] });
  idle(2);
  closeWindows();
  return state().long(0x14500 + 4 * pool) === level;
}

// Intelligence window (button 7): the grant line, a number and Return (intel.ts IntelScreen; level 3 from 20000).
function fundIntelligence(amount) {
  const before = state().signedLong(A.money);
  click(...cmd(7));
  check("intelligence window opens", game.stage === "screen");
  click(120, 0x1e);
  upd({ keys: [...String(amount).split(""), "Enter"] });
  idle(2);
  closeWindows();
  return before - state().signedLong(A.money) === amount;
}

// Market (trade button 4, market button 8): the row (`index` = 2 + item; item 0 fuel, 1 food, 2 ore, 4 weapons), buy (button 1),
// a number and Return. One trade a month: the trade window refuses while the month's flag is set (trade.ts marketRefusal).
const MARKET_ITEM = { ore: 2, weapons: 4, fuel: 0 };
function buyGoods(item, units) {
  const good = item - 1;
  const before = state().long(STOCK + 4 * good);
  click(...cmd(4));
  click(...cmd(8));
  click(...cmd(item + 2));
  click(...cmd(1));
  upd({ keys: [...String(units).split(""), "Enter"] });
  idle(100); // a result line holds the window for 76 updates (trade.ts WAIT_FRAMES)
  closeWindows();
  return state().long(STOCK + 4 * good) - before;
}

// Market dump (button 8 with the food row selected): the food above `keep` leaves the warehouses (trade.ts dump, $D56C). It is a trade,
// so it waits for a month with no trade yet. Returns true when the food stock is at most `keep` afterwards.
function dumpFood(keep) {
  const s = state();
  const excess = s.long(STOCK + 4 * GOOD.food) - keep;
  if (excess <= 0) return true;
  if (!waitFor(() => (s.byte(TRADE_FLAGS) & 2) === 0, 200000, "a month without a trade")) return false;
  click(...cmd(4));
  click(...cmd(8));
  click(...cmd(3)); // the food row (index 3 = item 1)
  click(...cmd(8)); // dump
  upd({ keys: [...String(excess).split(""), "Enter"] });
  idle(100);
  closeWindows();
  return s.long(STOCK + 4 * GOOD.food) <= keep;
}

// Build menu: page `page`, item `index` (playthrough's chooseBuildItem), then the cell on the map. Returns the cell's site record.
function placeBuilding(page, index, x, y) {
  // A clean start: no window open and no build mode left from the last placement (build mode persists, see closeWindows).
  closeWindows();
  click(...cmd(0));
  // The menu keeps the page it was left on: button 8 turns the page until the wanted one shows (playthrough.mjs chooseBuildItem).
  for (let n = 0; n < 4 && map.controls.menuState.page !== page; n++) click(...cmd(8));
  if (map.controls.menuState.page !== page) return null;
  const r = BUILD_MENU_HITBOXES[page][index];
  click((r.x0 + r.x1) >> 1, (r.y0 + r.y1) >> 1);
  click(...cmd(9));
  if (map.controls.mode !== "build") return null;
  const sites = state().word(0x142c4);
  if (!ensureView(x, y)) return null;
  const [px, py] = pointOfCell(x, y);
  click(px, py);
  const placed = state().word(0x142c4) === sites + 1;
  rightClickAt(0, 0);
  return placed ? findRecord(0x32, x, y) : null;
}

// Places `count` buildings of one menu entry on the first free sites of a grid around the base. A failed site costs no game time.
function placeAround(page, index, count) {
  const placed = [];
  for (let y = 24; y <= 52 && placed.length < count; y += 2) {
    for (let x = 34; x <= 68 && placed.length < count; x += 2) {
      const r = placeBuilding(page, index, x, y);
      if (r) placed.push(r);
    }
  }
  return placed;
}

// The yard window (left click on the yard): icon k is the ship class k (type 11 + k), button 8 orders it, 9 leaves.
function orderClass(x, y, k) {
  if (!ensureView(x, y)) return false;
  const [px, py] = pointOfCell(x, y);
  click(px, py);
  if (game.stage !== "screen") return false;
  click(...rectCentre(0xefe0, k));
  click(...cmd(8));
  return game.stage === "map";
}

// The ship window (right click on the ship's cell): pin k (rectangle 0xF056), then "to the front" (5), hover (6), land (7), exit (9).
function shipOrder(ship, { pin = null, icon = null, exit = true }) {
  if (!ensureView(ship.x, ship.y)) return false;
  const [sx, sy] = pointOfCell(ship.x, ship.y);
  rightClickAt(sx, sy);
  if (game.stage !== "screen" || game.window?.constructor?.name !== "ShipScreen") return false;
  if (pin !== null) click(...rectCentre(0xf056, pin));
  if (icon !== null) click(...cmd(icon));
  if (exit) click(...cmd(9));
  return game.stage === "map";
}

// The tank window (right click on the tank): "to the front" (icon 5, offered after the first alien report), the count and Return,
// then the exit button, which gives the order (screens/orders.ts TankScreen; a group order of `count` tanks nearest to the tank).
function tankToFront(tank) {
  if (!ensureView(tank.x, tank.y)) return false;
  const [sx, sy] = pointOfCell(tank.x, tank.y);
  rightClickAt(sx, sy);
  if (game.stage !== "screen" || game.window?.constructor?.name !== "TankScreen") return false;
  click(...cmd(5));
  upd({ keys: ["1", "Enter"] });
  idle(2);
  click(...cmd(9));
  return game.stage === "map";
}

// Runs the map until `ready()` holds or `limit` updates pass. Returns true when it held.
function waitFor(ready, limit, label) {
  const from = updates;
  while (!ready()) {
    if (updates - from > limit) {
      note(`${label}: not reached within ${limit} updates`);
      return false;
    }
    // Announcements and Earth offers are dismissed by settle(); a window that a message opened is closed, and the wait goes on.
    settle();
    if (game.stage === "screen") closeWindows();
    upd(NONE);
  }
  return true;
}

// Declared top-up: the stock of `good` is raised to `need` by Sim.addGoods (the market's own write). The call's `added` must reach the
// missing units; a warehouse that is still full adds less, and the check fails.
function topUp(good, need, label) {
  const have = state().long(STOCK + 4 * good);
  if (have >= need) return true;
  const missing = need - have;
  const r = map.sim.addGoods(missing, good);
  poke(`${label}: Sim.addGoods(${missing}, good ${good}) to reach ${need}`);
  const stocks = [0, 1, 2, 3, 4].map((g) => state().long(STOCK + 4 * g)).join("/");
  return check(`${label}: the warehouses take the ${missing} units (capacity ${state().long(0x14432)}, weight ${state().long(0x13166)})`, r.added === missing && !r.overflow, `added ${r.added}, stocks food/ore/fuel-2/weapons/4 ${stocks}`);
}

// ---- the run ---------------------------------------------------------------------------------------------------------------------
async function boot(index) {
  game = new Game(disk1, disk2, music, null);
  for (let n = 0; n < 20000 && game.stage === "intro"; n++) upd(at(true, 100, 16));
  upd(at(false, 100, 16));
  for (let n = 0; n < 400 && !game.language?.pointerVisible; n++) upd(NONE);
  upd(at(true, 160, 16)); upd(at(false, 160, 16));
  for (let n = 0; n < 300 && game.stage === "language"; n++) upd(NONE);
  let inCheck = 0;
  for (let n = 1; game.stage === "boot"; n++) {
    if (n > 30000) throw new Error("the boot stages did not finish");
    if (game.boot?.currentPhase === "E") inCheck++;
    upd({ keys: inCheck === 50 ? ["Enter"] : [] });
  }
  if (game.stage !== "disk") throw new Error(`after boot: expected the disk menu, got ${game.stage}`);
  ui = new Ui(disk1, game.strings);
  img = new GameImage(disk1);
  idle(1);
  const icon = DISK_MENU_BUTTONS[DISK_BUTTON.scenario];
  click(icon.x0 + 16, icon.y0 + 16);
  upd(at(true, 0, 0)); upd(at(false, 0, 0));
  click(100, 0x20 + index * 9 + 4);
  if (game.heldScene?.index !== index) throw new Error(`scenario ${index + 1} did not hold`);
  const exit = DISK_MENU_BUTTONS[DISK_BUTTON.exit];
  click(exit.x0 + 16, exit.y0 + 16);
  if (game.stage !== "map" || game.scenario !== index) throw new Error(`entry failed: stage ${game.stage}, scenario ${game.scenario}`);
  map = game.map;
  settle();
}

// Passive record of the messages (Messages.observer: told each string index before it is handled, never changes what is shown).
function recordMessages() {
  map.messages.observer = (index) => messageLog.push(index);
}

function main() {
  return (async () => {
    await boot(0);
    recordMessages();
    const s = state();
    const pad = findRecord(0x48, 53, 36);
    check("the scenario starts with a launch pad (tile $48, active flag $FF) at (53,36)", pad >= 0 && objects()[pad + 3] === 0xff);
    check("the scenario starts with a command centre online and no ship", s.word(0x133f8) === 1 && s.word(0x1429e) === 0);
    check("the scenario starts with no ship yard", s.word(0x133d4) === 0);

    // Declared: the daily events that bomb, wreck or requisition are switched off (sim.ts eventScheduler reads the chance bytes).
    const quiet = [1, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19];
    for (const k of quiet) s.setByte(0x13118 + k, 0);
    poke(`P-events: chance bytes $13118+k set to 0 for event slots ${quiet.join(",")} (bombings, meteors, requisitions, waves; sim.ts eventScheduler)`);

    // 1-3. Staffing, intelligence grant, ore from the market.
    check("staffing: the ship yard pool (job pool 3) is capped at 40 in the staffing window", setStaff(3, 40));
    check("intelligence: a grant of 25000 is paid from the window (level 3)", fundIntelligence(25000) && s.byte(0x144ca) === 3);
    const oreBought = buyGoods(MARKET_ITEM.ore, 50);
    check("market: 50 ore bought from the market window (one trade)", oreBought === 50, `bought ${oreBought}`);

    // 4. The ship yard: near the pad (|dx|, |dy| <= 5), inside the command centre's reach (nearBase).
    let yardAt = [50, 38];
    // Rebuild sites: each within 5 cells of the pad (53,36), the launch search radius (yard launch, sim-ships.ts launch).
    const yard = placeBuilding(1, 7, ...yardAt); // page 2 (index 1 of the menu), item 7 = tile $36
    check("build menu: a ship yard (tile $36) is placed on (50,38), 5 cells from the pad", yard !== null && yard >= 0, yard === null ? "placement refused" : "");
    if (yard === null) return finish();
    const yardReady = waitFor(() => s.word(0x133d4) >= 1, 60000, "ship yard built");
    check("the ship yard finishes its construction (weeks run down in the simulation)", yardReady, `yards ${s.word(0x133d4)}`);
    if (!yardReady) return finish();
    const yardRecord = () => findRecord(0x36, yardAt[0], yardAt[1]);
    check("the finished yard is the tile $36 record on (50,38)", yardRecord() >= 0);

    // 5-6. Class 0 (Explorer, type 11) from the yard window; the launch takes the free pad cell.
    const ordered = orderClass(...yardAt, 0);
    check("yard window: class 0 is ordered (+6 = 1, +7 = frame cost 50)", ordered && objects()[yardRecord() + 6] === 1 && objects()[yardRecord() + 7] === 50, `+6 ${objects()[yardRecord() + 6]} +7 ${objects()[yardRecord() + 7]}`);
    closeWindows();
    const landed = waitFor(() => fleetShips().length >= 1, 60000, "first ship");
    check("the yard launches the ordered class: a type 11 ship appears on the pad", landed && fleetShips()[0].type === 11 && fleetShips()[0].mode === 0, landed ? `type ${fleetShips()[0]?.type} mode ${fleetShips()[0]?.mode}` : "no ship");
    if (!landed) return finish();
    const explorer = fleetShips()[0];
    check("the new ship stands on the pad cell it was launched from", explorer.x === 53 && explorer.y === 36 || (cellTile(explorer.x, explorer.y) >= 0x48 && cellTile(explorer.x, explorer.y) <= 0x4b), `(${explorer.x},${explorer.y})`);
    note(`first ship type ${explorer.type} class ${explorer.cls} fuel ${explorer.fuel} at (${explorer.x},${explorer.y}) on ${state().dateText()}`);

    // 7. A new ship has no fuel and refuses orders (createShip clears the fuel word for class 0-3, 5; the $ED refusal).
    check("the new Explorer has no fuel word (class 0 starts empty: refuel is its only fuel)", explorer.fuel === 0, `fuel ${explorer.fuel}`);
    const refused = shipOrder(explorer, { icon: 6 });
    check("a fuel-less ship refuses a hover order: it stays on the pad (mode 0)", refused && explorer.mode === 0 && explorer.fuel === 0, `mode ${explorer.mode}`);

    // 8. Fuel tank next to the pad (tankNear: tile $3F/$40 within 7 left/up, 6 right/down), stock from the tanks' poke.
    const tank = placeBuilding(1, 2, 52, 40);
    check("build menu: a fuel tank (tile $3F) is placed next to the pad at (52,40)", tank !== null);
    const tankReady = waitFor(() => s.word(0x13302 + 0xc) >= 1 || s.word(0x13314 + 0xc) >= 1, 60000, "fuel tank built");
    check("the fuel tank finishes its construction", tankReady);
    map.sim.storeFuel(800);
    poke("P-fuel: Sim.storeFuel(800) fills the tanks (the fuel plant's own write; no fuel plant is built)");
    const refueled = waitFor(() => explorer.fuel > 0, 30000, "weekly refuel");
    check("weekly refuelling fills the landed ship on the pad from the tank (mode 0, tank in reach)", refueled && explorer.fuel === 400, `fuel ${explorer.fuel}`);

    // 9. Pin 1 on a free cell in view; the ship lands there.
    const pin = freePinCell();
    check("a free cell in view is found for pin 1 (no building, not blocked)", pin !== null);
    const [pxp, pyp] = pointOfCell(pin.x, pin.y);
    // The pin key reads the cell under the pointer on the pass that takes it, so the pointer stays on the cell while the pass runs.
    for (let i = 0; i < 2; i++) upd({ pointerX: pxp, pointerY: pyp });
    upd({ pointerX: pxp, pointerY: pyp, keys: ["1"] });
    for (let i = 0; i < 8; i++) upd({ pointerX: pxp, pointerY: pyp });
    check("pin 1 is placed on the chosen cell with the pin key", map.objects.markerCell(1)?.x === pin.x && map.objects.markerCell(1)?.y === pin.y, JSON.stringify(map.objects.markerCell(1)));
    closeWindows();

    const fuelBeforeFlight = explorer.fuel;
    const pinOrder = shipOrder(explorer, { pin: 0, icon: null });
    check("ship window: pin 1 chosen and the order applied with exit (go to pin and land)", pinOrder && explorer.mode !== 0 && explorer.mode !== undefined, `mode ${explorer.mode}`);
    const landedAtPin = waitFor(() => explorer.mode === 0 && explorer.x === pin.x && explorer.y === pin.y, 60000, "landing at the pin");
    check("the ship flies to the pin and lands on it (mode 0 at the pin cell)", landedAtPin, `mode ${explorer.mode} at (${explorer.x},${explorer.y}) pin (${pin.x},${pin.y})`);
    check("flying burns fuel (2 a day while flying): the fuel word is below its start", explorer.fuel < fuelBeforeFlight, `${fuelBeforeFlight} -> ${explorer.fuel}`);
    if (!landedAtPin) return finish();

    // Hover: from the pin the ship climbs to hover (mode 1) and burns 1 a day.
    closeWindows();
    const hoverOk = shipOrder(explorer, { icon: 6 });
    check("ship window: hover ordered from the landed ship (mode 1 after the climb)", hoverOk && waitFor(() => explorer.mode === 1, 3000, "hover"));
    const hoverFuel = explorer.fuel;
    waitFor(() => explorer.fuel < hoverFuel - 1, 6000, "hover burn");
    check("a hovering ship burns fuel while it hovers", explorer.fuel < hoverFuel, `${hoverFuel} -> ${explorer.fuel}`);

    // The Explorer is the first ship of the force: "to the front" needs the first intelligence report (window icon 5 is gated by
    // $13EE6 bit 7, orders.ts / screens/orders.ts ICON_FRONT), so the grant funded above has to bring that report first.
    const reported = waitFor(() => (s.byte(0x13ee6) & 0x80) !== 0, 200000, "first intelligence report");
    check("the first intelligence report comes in from the funded grant (front button enabled, $13EE6 bit 7)", reported, `$13EE6 ${s.byte(0x13ee6).toString(16)} level ${s.byte(0x144ca)}`);
    if (!reported) return finish();
    // Alien-battle counts per type 9..16 ($14274, sim-aliens.ts sendToFront); own ships that reached the front per class ($1427C).
    const frontOf = (type) => s.long(0x14274 + 4 * (type - 9));
    const shipFront = (type) => s.long(0x1427c + 4 * (type - 11));
    const explorerToFront = shipToFront(explorer, 11);
    check("ship window: to the front (icon 5) is accepted by the Explorer and it leaves the map", explorerToFront === true);

    // Classes 1-5 from the one ship yard. Each order: the food surplus is dumped (the market, one trade a month), the ore and the weapons
    // of the class are topped up (declared), the fusion invention for class 5 (declared), the yard runs its ore and weapons stages on
    // its own (10 workers per yard, sim-ships.ts shipYard), the launch takes the free pad cell, then the refuel and the front order.
    const need = { ore: [50, 100, 180, 240, 80, 50], weapons: [0, 2, 4, 2, 3, 1] };
    const SHIP_CAP = [400, 600, 600, 1200, 0xffff, 400]; // the fuel word capacity by class (sim-tables.ts SHIP_FUEL_CAP)
    const warehouses = placeAround(0, 3, 2);
    check("build menu: two warehouses (tile $44) are placed on free cells", warehouses.length === 2);
    if (warehouses.length < 2) return finish();
    const housing = placeAround(0, 0, 3);
    // Food: five farms (autoplay: 2 + pop/80 for a population of 240), since two farms starved the colony within a year.
    const farms = placeAround(0, 2, 5);
    check("build menu: three housing blocks (tile $2F) and five farms (tile $41) are placed", housing.length === 3 && farms.length === 5, `housing ${housing.length} farms ${farms.length} money ${s.signedLong(A.money)}`);
    if (housing.length < 3 || farms.length < 5) return finish();
    const stored = waitFor(() => s.long(0x14432) === 240000, 300000, "warehouse construction");
    check("the warehouses finish construction and the goods capacity is 240000", stored, `capacity ${s.long(0x14432)} weight ${s.long(0x13166)}`);
    if (!stored) return finish();
    // Security against sabotage: a security post (type 20, tile $43, build-menu page 1 index 4, job pool 8) staffed in the staffing
    // window. Its share raises security_pct, which lowers the chance of the bombing event (sim.ts $10D60, roll against 2 x pct).
    const post = placeAround(1, 4, 1);
    check("build menu: a security post (tile $43, job pool 8) is placed", post.length === 1);
    const postBuilt = waitFor(() => s.word(0x131e2 + 18 * 20 + 10) >= 1, 120000, "security post built");
    check("the security post finishes construction", postBuilt);
    setStaff(8, 40);
    // A second fuel tank beside the pad: one small tank holds 800, and class 3 (cap 1200) refuels from the stock of all tanks in reach.
    // Sites within tankNear of the pad (53,36): x 46..59, y 29..42 (sim-ships.ts tankNear); the grid above has taken the even cells.
    let tank2 = null;
    for (const [x, y] of [[47, 41], [49, 41], [45, 37], [57, 31], [59, 33], [47, 33]]) {
      if (tank2 === null) tank2 = placeBuilding(1, 2, x, y);
    }
    check("build menu: a second fuel tank (tile $3F) is placed in reach of the pad", tank2 !== null);
    const tanksBuilt = waitFor(() => s.word(0x13302 + 0xc) + s.word(0x13314 + 0xc) >= 2, 60000, "second fuel tank built");
    check("the second fuel tank finishes its construction", tanksBuilt, `count ${s.word(0x13302 + 0xc)} + ${s.word(0x13314 + 0xc)}`);

    let shipsOk = tanksBuilt;
    for (let k = 1; k <= 5 && shipsOk; k++) {
      const type = 11 + k;
      if (!dumpFood(FOOD_KEEP)) {
        check(`class ${k}: the food surplus is dumped at the market`, false, `food ${s.long(STOCK)}`);
        shipsOk = false;
        break;
      }
      note(`class ${k}: food ${s.long(STOCK)} weight ${s.long(0x13166)} capacity ${s.long(0x14432)} on ${s.dateText()}`);
      if (k === 4) {
        poke("P-invention: $14472 bit 4 (the fusion invention; class 5 / type 15 is unlocked only by it, sim-ships.ts orderShip)");
        s.setLong(0x14472, s.long(0x14472) | 0x10);
      }
      const oreOk = topUp(GOOD.ore, need.ore[k], `P-ore class ${k}`);
      const wpnOk = need.weapons[k] === 0 || topUp(GOOD.weapons, need.weapons[k], `P-weapons class ${k}`);
      if (!oreOk || !wpnOk) {
        shipsOk = false;
        break;
      }
      // The order is given while the yard is idle (+6 = 0): the first order of class k starts its frame cost.
      const ordered = orderClass(...yardAt, k);
      closeWindows();
      check(`yard window: class ${k} (type ${type}) is ordered (+6 = ${k + 1}, +7 = frame cost ${need.ore[k]})`, ordered && objects()[yardRecord() + 6] === k + 1 && objects()[yardRecord() + 7] === [50, 100, 180, 240, 80, 50][k], `+6 ${objects()[yardRecord() + 6]} +7 ${objects()[yardRecord() + 7]}`);
      if (!ordered) {
        shipsOk = false;
        break;
      }
      const made = waitFor(() => fleetShips().some((sh) => sh.type === type), 150000, `class ${k} launch`);
      note(`class ${k} launch: launched ${made} yard ${yardRecord() >= 0 ? "standing" : "gone"} ore ${s.long(0x13156)} weapons ${s.long(0x1315e)} +7 ${objects()[yardRecord() + 7]} date ${s.dateText()}`);
      check(`the yard launches class ${k}: a type ${type} ship appears on the pad`, made, `yard count $133d4 ${s.word(0x133d4)} +7 ${objects()[yardRecord() + 7]} ore ${s.long(0x13156)} weapons ${s.long(0x1315e)}`);
      if (!made) {
        shipsOk = false;
        break;
      }
      const ship = fleetShips().find((sh) => sh.type === type);
      if (k !== 4) {
        check(`class ${k} (type ${type}) starts with no fuel and an empty refuel: it stays on the pad`, ship.fuel === 0 && ship.mode === 0, `fuel ${ship.fuel}`);
        map.sim.storeFuel(SHIP_CAP[k]);
        poke(`P-fuel: Sim.storeFuel(${SHIP_CAP[k]}) fills the tanks for class ${k} (no fuel plant)`);
        const fuelled = waitFor(() => ship.fuel === SHIP_CAP[k], 60000, `class ${k} refuel`);
        check(`class ${k}: the weekly refuel fills it to its capacity ${SHIP_CAP[k]}`, fuelled, `fuel ${ship.fuel}`);
        if (!fuelled) {
          shipsOk = false;
          break;
        }
      } else {
        check("class 4 (type 15) has no fuel burn and no refuel (fuel word $FFFF)", ship.fuel === 0xffff, `fuel ${ship.fuel.toString(16)}`);
      }
      const sent = shipToFront(ship, type);
      check(`class ${k} (type ${type}): to the front, it leaves the map and joins the front fleet ($1427C + 4*cls)`, sent && shipFront(type) >= 1, `ship front ${shipFront(type)}`);
      if (!sent) shipsOk = false;
    }
    note(`ships at the front per class ($1427C): ${[11, 12, 13, 14, 15, 16].map((t) => `${t}:${shipFront(t)}`).join(" ")}`);

    // Tanks: a tank yard (build menu page 2, index 6, tile $45) staffed in pool 4 turns 20 ore and 2 weapons into a tank on a free cell
    // beside it (sim.ts tankYard). Three tanks go to the front, each by the tank window.
    const TANKS = 3;
    let tankYardOk = false;
    if (shipsOk) {
      const tankYard = placeAround(1, 5, 1);
      check("build menu: a tank yard (tile $45) is placed on a free site", tankYard.length === 1);
      tankYardOk = tankYard.length === 1;
      if (tankYardOk) {
        setStaff(4, 40);
        dumpFood(FOOD_KEEP); // the tank step is a month of its own at the market, after the ship stages filled the stores
        const built = waitFor(() => s.word(0x1337a) >= 1, 60000, "tank yard built");
        check("the tank yard finishes its construction (count $1337A = 1)", built, `count ${s.word(0x1337a)}`);
        tankYardOk = built;
      }
    }
    for (let t = 1; t <= TANKS && tankYardOk; t++) {
      const have = ownTanks().length;
      if (!topUp(GOOD.ore, 20, `P-ore tank ${t}`) || !topUp(GOOD.weapons, 2, `P-weapons tank ${t}`)) {
        tankYardOk = false;
        break;
      }
      const made = waitFor(() => ownTanks().length > have, 150000, `tank ${t} built`);
      check(`the tank yard builds tank ${t}: a type 9 or 10 unit appears by the yard`, made, `tanks ${ownTanks().length} workers ${s.long(0x143fa)}`);
      if (!made) {
        tankYardOk = false;
        break;
      }
      const tank1 = ownTanks().at(-1);
      const frontBefore = frontOf(tank1.type);
      const sentTank = tankToFront(tank1);
      check(`tank ${t}: the tank window sends it to the front (icon 5, count 1, exit)`, sentTank, `window ${game.window?.constructor?.name} stage ${game.stage}`);
      if (!sentTank) {
        tankYardOk = false;
        break;
      }
      const gone = waitFor(() => !ownTanks().includes(tank1), 200000, `tank ${t} to the front`);
      check(`tank ${t}: it leaves the map and joins the front fleet (type ${tank1.type} count ${frontBefore} -> ${frontOf(tank1.type)})`, gone && frontOf(tank1.type) === frontBefore + 1, `gone ${gone}`);
      if (!gone) {
        tankYardOk = false;
        break;
      }
    }
    closeWindows();
    check("the front fleet holds the ships of classes 0-5 and three tanks", shipsOk && tankYardOk, `ships ${shipsOk} tanks ${tankYardOk}`);
    if (!shipsOk || !tankYardOk) return finish();

    // The front fleet of the chain (classes 0-5 and three tanks) is at the front (checked above). The weekly battle (sim.ts weekly ->
    // sim-aliens.ts weeklyBattle) is fought by the units present at each weekly pass; the defeat is checked in phase B.
    note(`front fleet of the chain at ${state().dateText()}: tanks ${[9, 10].map((t) => state().long(0x14274 + 4 * (t - 9))).join(",")} ships ${[12, 13, 14, 15, 16].map((t) => state().long(0x14274 + 4 * (t - 9))).join(",")}; the alien age is ${state().word(0x13456 + 0x14)} (phase B checks the defeat)`);
    return alienDefeat();
  })();
}

// Phase B: the alien defeat. The weekly battle is fought with the front fleet: victory needs the alien's age to run out, the battle's
// strength (weights of the front fleet, 1 per tank, times ceil(tech/2)) halved (sim-aliens.ts weeklyBattle), and the age grows by one
// every ten days (sim-aliens.ts dailyIntel). The classes of phase A reach the front only in 2097, when the age is about 250, and the
// weekly battle wipes out the units that arrive one at a time; so phase B uses a force gathered early on the map and sent together.
// The research level is declared (P-tech): the tech byte $14592 is the research result that the battle strength reads.
// Runs the map until the victory flag is set or the limit passes; each weekly battle is logged (the age word, the front counts, the losses).
function waitBattle(limit) {
  const s = state();
  const from = updates;
  let lastAge = s.word(0x13456 + 0x14);
  let logged = 0;
  while ((map.sim.sysFlags & SYS.noUnitBonus) === 0) {
    if (updates - from > limit) {
      note("alien defeat: not reached within " + limit + " updates");
      return false;
    }
    settle();
    if (game.stage === "screen") closeWindows();
    upd(NONE);
    const age = s.word(0x13456 + 0x14);
    if (age !== lastAge && logged < 40) {
      logged++;
      note(`battle ${s.dateText()}: age ${lastAge} -> ${age}, front tanks ${s.long(0x14274)} + ${s.long(0x14278)}, lost ${s.long(0x14294)}`);
      lastAge = age;
    }
  }
  return true;
}

async function alienDefeat() {
  await boot(0);
  recordMessages();
  const s = state();
  const quiet = [1, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19];
  for (const k of quiet) s.setByte(0x13118 + k, 0);
  poke(`P-events (phase B): chance bytes $13118+k set to 0 for event slots ${quiet.join(",")}`);
  const frontOf = (type) => s.long(0x14274 + 4 * (type - 9));
  check("phase B: intelligence grant of 25000 is paid (the front report comes in)", fundIntelligence(25000));
  const warehouses = placeAround(0, 3, 2);
  check("phase B: two warehouses (tile $44) are placed", warehouses.length === 2);
  const housing = placeAround(0, 0, 3);
  const farms = placeAround(0, 2, 5);
  check("phase B: three housing blocks and five farms are placed", housing.length === 3 && farms.length === 5, `housing ${housing.length} farms ${farms.length}`);
  if (warehouses.length < 2 || housing.length < 3 || farms.length < 5) return finish();
  const stored = waitFor(() => s.long(0x14432) >= 160000, 300000, "phase B warehouses");
  check("phase B: the warehouses finish construction (goods capacity 160000 or more)", stored, `capacity ${s.long(0x14432)}`);
  if (!stored) return finish();
  // Four tank yards: 10 workers each (job pool 4), so 2 tanks a month in all.
  const TANK_YARDS = 4;
  const yards = placeAround(1, 5, TANK_YARDS);
  check(`phase B: ${TANK_YARDS} tank yards (tile $45) are placed`, yards.length === TANK_YARDS, `placed ${yards.length}`);
  if (yards.length < TANK_YARDS) return finish();
  setStaff(4, 40);
  const yardsBuilt = waitFor(() => s.word(0x1337a) >= TANK_YARDS, 200000, "phase B tank yards built");
  check(`phase B: the ${TANK_YARDS} tank yards finish construction (count $1337A)`, yardsBuilt, `count ${s.word(0x1337a)}`);
  if (!yardsBuilt) return finish();
  const TECH = 10;
  s.setByte(0x14592, TECH);
  poke(`P-tech: $14592 (tech level) set to ${TECH} as the research result (the battle strength is weights x ceil(tech/2))`);
  const TANKS = 20;
  // Stated minimum: 16 of the 20 tanks join the front (or are destroyed after joining; see the check below). Not tuned to a run: a
  // tank that stops for good is reported with its blocked candidates instead of being counted.
  const MIN_FRONT = 16;
  check("phase B: the food surplus is dumped at the market (one trade)", dumpFood(FOOD_KEEP), `food ${s.long(STOCK)}`);
  const stocked = topUp(GOOD.ore, TANKS * 20, `P-ore ${TANKS} tanks`) && topUp(GOOD.weapons, TANKS * 2, `P-weapons ${TANKS} tanks`);
  check(`phase B: ore and weapons for ${TANKS} tanks (20 ore and 2 weapons each) are in stock`, stocked);
  if (!stocked) return finish();
  const gathered = waitFor(() => ownTanks().length >= TANKS, 400000, `${TANKS} tanks built`);
  check(`phase B: the tank yards build ${TANKS} tanks on the map (no orders yet)`, gathered, `tanks ${ownTanks().length} age ${s.word(0x13456 + 0x14)}`);
  if (!gathered) return finish();
  note(`phase B: ${TANKS} tanks gathered at ${s.dateText()}, the alien age ${s.word(0x13456 + 0x14)}, tech ${s.byte(0x14592)}`);
  // The order with count 1 takes the unit nearest the clicked tank (orders.ts orderGroup), so tanks on the same cell can take each
  // other's order. Each round re-clicks the tanks that still have no target (targetX 255, NO_TARGET) until every tank is ordered.
  let sent = 0;
  for (let round = 0; round < 4 && ownTanks().some((u) => u.targetX === NO_TARGET); round++) {
    for (const tk of ownTanks().filter((u) => u.targetX === NO_TARGET)) {
      if (tankToFront(tk)) sent++;
    }
  }
  closeWindows();
  const unordered = ownTanks().filter((u) => u.targetX === NO_TARGET).length;
  note(`phase B: tanks after the orders ${ownTanks().map((u) => `${u.x},${u.y}->${u.targetX}`).join(" ")}`);
  check(`phase B: the tank window orders all ${TANKS} tanks to the front (icon 5, count 1, exit each)`, unordered === 0 && ownTanks().length + frontOf(9) + frontOf(10) + (s.long(0x14294) - 0) >= TANKS, `orders ${sent} unordered ${unordered}`);
  // A tank whose way is blocked ends its order with no target (units.ts walkerStep, arrive = $3C7C): it stops on the map, where a
  // player sees it and orders it again. Each round waits (bounded) until no tank is walking, then orders every tank still on the map.
  // The rounds are bounded; whatever is still stopped at the end is reported with its reason below.
  // The battle may already run while the tanks walk: a tank is at the front, lost in a battle ($14294), or still on the map.
  const lostAtStart = s.long(0x14294);
  const ROUNDS = 6;
  const walking = () => ownTanks().some((u) => u.targetX !== NO_TARGET);
  let reorders = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    if (!waitFor(() => !walking(), 300000, `phase B round ${round}: tanks settle`)) break;
    if (ownTanks().length === 0 || round === ROUNDS) break;
    for (const tk of ownTanks()) {
      note(`phase B round ${round}: stopped ${stuckReason(tk).text}`);
      if (tankToFront(tk)) reorders++;
    }
    closeWindows();
  }
  closeWindows();
  const stragglers = ownTanks();
  const lost = s.long(0x14294) - lostAtStart;
  const arrived = frontOf(9) + frontOf(10);
  const reasons = stragglers.map((u) => stuckReason(u));
  note(`phase B: ${reorders} re-orders of stopped tanks; ${arrived} at the front, ${lost} lost, ${stragglers.length} on the map at ${s.dateText()}`);
  for (const r of reasons) note(`phase B straggler: ${r.text}`);
  check(`phase B: at least ${MIN_FRONT} of the ${TANKS} tanks reach the front (alive at the front ${arrived}, destroyed since the orders ${lost}, on the map ${stragglers.length})`, arrived + lost >= MIN_FRONT && arrived + lost + stragglers.length === TANKS, `front ${frontOf(9)} + ${frontOf(10)} lost ${lost} on map ${stragglers.length}`);
  check("phase B: every tank still on the map is stopped, and each of its candidate steps is blocked (terrain, buildings or the no-U-turn list)", stragglers.every((u) => u.targetX === NO_TARGET) && reasons.every((r) => r.free === 0), reasons.map((r) => r.text).join(" | "));
  if (arrived === 0) return finish();
  const won = waitBattle(200000);
  check("the weekly battle ends in victory through the simulation (flag $156AA bit 2 set, $14132 = $FF)", won && s.byte(0x14132) === 0xff, `flags ${map.sim.sysFlags.toString(16)} $14132 ${s.byte(0x14132)} age ${s.word(0x13456 + 0x14)}`);
  if (!won) return finish();
  const VICTORY_MESSAGE = 0x186; // sim-aliens.ts weeklyBattle: sim.msg(0x186)
  check("the victory message (string $186) is shown when the aliens are beaten", messageLog.includes(VICTORY_MESSAGE), `messages ${messageLog.slice(-5).map((m) => m.toString(16)).join(",")}`);
  note(`alien defeat on ${s.dateText()}: front ${frontOf(9)} + ${frontOf(10)} tanks, age ${s.word(0x13456 + 0x14)}, $14132 ${s.byte(0x14132)}`);
  return gameAfterVictory();
}

// Why a stopped tank cannot step (units.ts walkerStep): the greedy direction towards the front (x = $135C4, y kept in +C) and its seven
// candidates. A candidate is blocked by BLOCKED (building or rock, with its tile id), by the no-U-turn list (recent), or is OCCUPIED.
// `free` counts candidates that would be taken; a stopped tank with a free candidate would be a game defect.
function stuckReason(u) {
  const tx = state().byte(0x135c4);
  const ty = u.targetY;
  let want;
  if (u.x === tx) want = u.y < ty ? 4 : 0;
  else if (u.x < tx) want = u.y === ty ? 2 : u.y < ty ? 3 : 1;
  else want = u.y === ty ? 6 : u.y < ty ? 5 : 7;
  let free = 0;
  const parts = [];
  for (const turn of TURNS) {
    const dir = (want + turn + 8) & 7;
    const nx = u.x + DIR_STEP[dir][0];
    const ny = u.y + DIR_STEP[dir][1];
    if (!inMap(nx, ny)) { free++; parts.push(`d${dir} border`); continue; }
    const word = cellWord(nx, ny);
    const why = u.recent.includes(dir) ? "no-U-turn" : word & BLOCKED ? `blocked tile $${(word & 0x3ff).toString(16)}` : word & OCCUPIED ? "occupied" : null;
    if (!why) free++;
    parts.push(`d${dir} ${why ?? "free"}`);
  }
  return { free, text: `tank type ${u.type} at ${u.x},${u.y} towards ${tx},${ty} (want ${want}): ${parts.join(", ")}` };
}

// After the victory: a game year on the map, the windows, and a save and load (Game's saveToSlot / loadFromSlot, the calls behind the
// save and load pages). The saved state is read back.
function gameAfterVictory() {
  const s = state();
  const frontOf = (type) => s.long(0x14274 + 4 * (type - 9));
  const dayStart = dateKey();
  let days = 0;
  let last = dayStart;
  while (days < 365 && game.stage === "map") {
    settle();
    if (game.stage !== "map") break;
    upd(NONE);
    if (dateKey() !== last) {
      days++;
      last = dateKey();
    }
  }
  check("after the victory the game runs a game year (365 days) on the map, not over", days >= 365 && game.stage === "map" && !map.sim.gameOver, `days ${days} from ${dayStart} to ${dateKey()} stage ${game.stage}`);
  check("after the game year the victory still holds (flag $156AA bit 2, $14132 = $FF, the aliens do not return)", (map.sim.sysFlags & SYS.noUnitBonus) !== 0 && s.byte(0x14132) === 0xff && s.word(0x13456 + 0x14) === 0, `flags ${map.sim.sysFlags.toString(16)} $14132 ${s.byte(0x14132)} age ${s.word(0x13456 + 0x14)}`);
  check("after the victory the money is a finite integer", Number.isInteger(s.signedLong(A.money)), `${s.signedLong(A.money)}`);
  check("after the victory the build menu opens and closes", (click(...cmd(0)), map.controls.menuVisible === true) && (click(...cmd(9)), map.controls.menuVisible === false));
  click(...cmd(4));
  check("after the victory the trade window opens", game.stage === "screen");
  closeWindows();

  const savedDate = dateKey();
  const savedFront = [9, 10].map(frontOf).join(",");
  const savedMoney = s.signedLong(A.money);
  const saved = game["saveToSlot"](0, null);
  check("save: the game saves to slot 1 after the victory", saved === true, game.lastSaveError?.message ?? "");
  runMap(2000);
  const loaded = saved && game["loadFromSlot"](0);
  check("load: slot 1 loads into a new map scene", loaded === true, game.lastLoadError?.message ?? "");
  if (loaded) {
    map = game.map;
    map.messages.observer = null;
    const t = state();
    check("load: the saved date, money, front fleet and victory flag come back", dateKey() === savedDate && t.signedLong(A.money) === savedMoney && [9, 10].map(frontOf).join(",") === savedFront && (map.sim.sysFlags & SYS.noUnitBonus) !== 0, `date ${dateKey()} vs ${savedDate}`);
    check("load: the loaded map runs 1,000 updates", runMap(1000) && game.stage === "map");
  }
  return finish();
}

// Ship capacities of the fuel word (sim-tables.ts SHIP_FUEL_CAP, $4A98) for classes 0..5; class 4 never burns.
// The ship window's "to the front" (icon 5) with its exit: the ship goes off the map to the front (enemies.ts sendShipToFront).
function shipToFront(ship, type) {
  const before = map.sim.fleet.ships.length;
  closeWindows();
  const modeBefore = map.controls.mode;
  const ok = shipOrder(ship, { icon: 5 });
  if (!ok) {
    note(`ship ${type} at ${ship.x},${ship.y} mode ${ship.mode}: the ship window did not take the front order (map mode before ${modeBefore}, stage ${game.stage}, window ${game.window?.constructor?.name}, scroll ${map.scrollX},${map.scrollY} in view ${inView(ship.x, ship.y)} point ${pointOfCell(ship.x, ship.y)})`);
    return false;
  }
  // The ship joins the front fleet of its class: $1427C + 4 * cls, cls = type - 11 (enemies.ts $4672 path, sim-ships.ts createShip).
  const before_front = state().long(0x1427c + 4 * (type - 11));
  const lostBefore = state().long(0x14294);
  const gone = waitFor(() => !fleetShips().includes(ship), 200000, `ship ${type} to the front`);
  note(`ship ${type} to the front: gone ${gone} front ${before_front} -> ${state().long(0x1427c + 4 * (type - 11))} lost ${lostBefore} -> ${state().long(0x14294)} at ${ship.x},${ship.y} mode ${ship.mode}`);
  return gone && before >= 1 && state().long(0x1427c + 4 * (type - 11)) === before_front + 1;
}

// A free view cell for a pin: no record on it, no blocking bits ($5000 = bits 12 and 14), not a pad, yard, tank or site.
function freePinCell() {
  for (let vy = 1; vy < 7; vy++) {
    for (let vx = 1; vx < 7; vx++) {
      const x = map.scrollX + vx;
      const y = map.scrollY + vy;
      if ((cellWord(x, y) & 0x5000) !== 0) continue;
      const t = cellTile(x, y);
      if (t >= 0x30 && t <= 0x6f) continue; // buildings, pads and sites
      if (Math.abs(x - 53) <= 2 && Math.abs(y - 36) <= 2) continue;
      return { x, y };
    }
  }
  return null;
}

function finish() {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`ship-lifecycle summary: ${counts.ok} ok, ${counts.failed} failed, ${updates} updates, ${pokes.length} declared pokes, ${seconds} s`);
  if (failedNames.length) console.log(`failed: ${failedNames.join(" | ")}`);
  if (counts.failed > 0) {
    console.log("ship-lifecycle FAILED");
    process.exit(1);
  }
  console.log("all ship-lifecycle checks passed");
  process.exit(0);
}

main().catch((error) => {
  check("ship lifecycle runs without a crash", false, String(error?.stack ?? error).split("\n").slice(0, 4).join(" | "));
  finish();
});
