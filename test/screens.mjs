// Headless checks of the window screens (src/game/screens): drawing, leaving, and the state
// write-backs of the interactive ones (staffing, trade, market, intelligence). Run after
// `npm run build`. Needs the user's own game data (Disk.1 and Disk.2 in original/utopia-whdload);
// skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("screen tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { createScreen } = await import("../dist/game/screens/index.js");
const { Ui } = await import("../dist/game/screens/ui.js");
const { setStaffLevel, poolOfRow } = await import("../dist/game/screens/staff.js");
const { updateTradable, removeFuel, addToGrant, marketRefusal } = await import("../dist/game/screens/trade.js");
const { intelLevel, fundIntelligence } = await import("../dist/game/screens/intel.js");
const { ColonyScreen, FinanceScreen, ResearchScreen } = await import("../dist/game/screens/reports.js");

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

function fresh() {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const sim = new Sim(world, { rng: createRng(1) });
  const said = [];
  const ctx = { disk: disk1, world, sim, strings, say: (i) => said.push(i) };
  return { state, world, sim, ctx, said };
}

const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };

function click(scene, x, y) {
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

function type(scene, text) {
  for (const c of text) {
    input.keys.push(c);
    scene.update(input);
  }
  input.keys.push("Enter");
  scene.update(input);
}

function frames(scene, n) {
  let result = "running";
  for (let i = 0; i < n; i++) result = scene.update(input);
  return result;
}

const rowY = (first, row) => first + 9 * row + 3;

// --- every screen draws and leaves ------------------------------------------------------------
for (const kind of ["f1", "f2", "f3", "f4", "f5", "f6", "trade", "market", "staff", "intel"]) {
  const { ctx } = fresh();
  const scene = createScreen(kind, ctx);
  const screen = new Screen();
  scene.draw(screen);
  check(`${kind}: draws something`, screen.pixels.some((p) => p !== 0));
  scene.update(input); // the first frame must not close it
  check(`${kind}: exit button closes`, clickButton(scene, 9) === "close");
}
{
  // The F1-F6 reports end in `$B99C` -> `$58F8`, which reads the mouse only (window-input.mjs, section 2f): Escape does nothing.
  const { ctx } = fresh();
  const scene = createScreen("f1", ctx);
  scene.update(input);
  input.keys.push("Escape");
  check("f1: Escape does not close (no key leaves a report)", scene.update(input) === "running");
}

// --- report screens: derived strings and sums ---------------------------------------------------
check("birth-rate string by difficulty", ColonyScreen.rateString(0) === 46 && ColonyScreen.rateString(0x14) === 47 && ColonyScreen.rateString(0x1e) === 48 && ColonyScreen.rateString(5) === 49);
check("population density", ColonyScreen.density(113, 3) === 75 && ColonyScreen.density(10, 0) === 100);
check("morale and crime strings", ColonyScreen.moraleString(5000) === 0x5c && ColonyScreen.moraleString(4000) === 0x5b && ColonyScreen.moraleString(-6000) === 0x59 && ColonyScreen.crimeString(0x15) === 0x6a);
check("finance warning priority", FinanceScreen.warning(1, 0, 10, 0) === 0xdb && FinanceScreen.warning(0, 100, 10, 0) === 0xeb && FinanceScreen.warning(0, 0, 1, 5) === 0x3f && FinanceScreen.warning(0, 0, 5, 1) === -1);
check("research status string", ResearchScreen.message(1, 1000, 950, 0, 0, 0, 0) === 0xb8 && ResearchScreen.message(1, 1000, 0, 0, 0, 0, 0) === 0xb7 && ResearchScreen.message(1, 1000, 0, 5, 0, 2, 2) === 0xb9);
{
  // F3 stores the month and year sums where the original keeps them.
  const { state, ctx } = fresh();
  state.setLong(0x142e2, 100);
  state.setLong(0x142e6, 20);
  state.setLong(0x142ea, 3);
  const scene = createScreen("f3", ctx);
  scene.draw(new Screen());
  check("f3: month sum written to $142EE", state.long(0x142ee) === 123);
}

// --- staffing ---------------------------------------------------------------------------------------
check("staffing: rows above the spacer shift", poolOfRow(5) === 5 && poolOfRow(7) === 6 && poolOfRow(9) === 8);
{
  const { state } = fresh();
  state.setLong(0x143c6, 10); // required
  state.setLong(0x143ea, 0);
  setStaffLevel(state, 0, 3);
  check("staffing: level stored, vacancies = level - employed", state.long(0x14500) === 3 && state.long(0x1440e) === 3);
  setStaffLevel(state, 0, 50);
  check("staffing: vacancies capped by requirement", state.long(0x1440e) === 10);
  state.setLong(0x143ea, 8);
  state.setLong(0x1313a, 20);
  state.setLong(0x13136, 5);
  setStaffLevel(state, 0, 2);
  check("staffing: excess staff goes back to the free pool", state.long(0x143ea) === 2 && state.long(0x1313a) === 14 && state.long(0x13136) === 11 && state.long(0x1440e) === 0);
}
{
  const { state, ctx } = fresh();
  state.setLong(0x143c6 + 4, 40);
  state.setLong(0x143ea + 24, 7); // medics pool
  const scene = createScreen("staff", ctx);
  scene.update(input);
  click(scene, 100, rowY(40, 1)); // row 1 = pool 1
  type(scene, "12");
  check("staffing screen: click row, typed level lands in $14500[1]", state.long(0x14504) === 12 && state.long(0x14500) === 0);
  check("staffing screen: vacancies follow", state.long(0x1440e + 4) === 12);
  click(scene, 100, rowY(40, 6)); // spacer row: nothing
  click(scene, 100, rowY(40, 8)); // pool 7
  type(scene, "4");
  check("staffing screen: row 8 is pool 7", state.long(0x14500 + 28) === 4);
  clickButton(scene, 9);
  check("staffing screen: leaving copies medics", state.long(0x1313e) === 7);
}

// --- trade --------------------------------------------------------------------------------------------
{
  const { state } = fresh();
  state.setLong(0x1314e, 200);
  state.setLong(0x13152, 50);
  state.setLong(A.retainPercent, 25);
  updateTradable(state);
  check("tradable = stock - stock * retain / 100", state.long(0x14234) === 150 && state.long(0x14238) === 0);
  state.setLong(0x14342, 100);
  removeFuel(state, 30);
  check("removeFuel lowers the fuel total and raises consumption", state.long(0x14342) === 70 && state.long(0x14376) >= 30);
}
{
  const { state, ctx } = fresh();
  state.setLong(A.money, 200000);
  const scene = createScreen("trade", ctx);
  scene.update(input);
  click(scene, 165, rowY(0x36, 2));
  type(scene, "40");
  check("trade: retain percentage typed", state.long(A.retainPercent + 8) === 40);
  click(scene, 165, rowY(0x36, 3));
  type(scene, "250");
  check("trade: retain percentage capped at 100", state.long(A.retainPercent + 12) === 100);
  state.setLong(0x13152 + 8, 1000); // ore stock
  click(scene, 165, rowY(0x36, 2));
  type(scene, "50");
  check("trade: tradable follows the retain percentage", state.long(0x14234 + 8) === state.long(0x1314e + 8) - Math.floor((state.long(0x1314e + 8) * 50) / 100));
  click(scene, 60, 133);
  type(scene, "15");
  check("trade: next-year tax", state.long(A.nextTax) === 15 && state.long(A.tax) !== 15);
  click(scene, 60, 133);
  type(scene, "99");
  check("trade: next-year tax capped at 20", state.long(A.nextTax) === 20);
  const money = state.long(A.money);
  click(scene, 200, 125);
  type(scene, "500");
  check("trade: military grant raised, money paid", state.long(0x142d2) === 500 && state.long(A.money) === money - 500);
  click(scene, 200, 138);
  type(scene, "300");
  check("trade: civilian grant raised", state.long(0x142d6) === 300 && state.long(A.money) === money - 800);
  click(scene, 200, 125);
  type(scene, "99999");
  check("trade: grant stops at 99999 and only that is paid", state.long(0x142d2) === 99999 && state.long(A.money) === money - 800 - (99999 - 500));
  check("trade: button 9 closes", clickButton(scene, 9) === "close");
}
{
  const { state } = fresh();
  state.setLong(A.money, 100);
  addToGrant(state, false, 1000);
  check("grants: cannot pay more than the funds", state.long(0x142d6) === 100 && state.long(A.money) === 0);
}

// --- market ---------------------------------------------------------------------------------------------
{
  const { state, ctx, said } = fresh();
  state.setByte(0x144c2, 2);
  const scene = createScreen("market", ctx);
  check("market: refused after trading this month", said.includes(0xa5) && scene.update(input) === "close");
  state.setByte(0x144c2, 0);
  state.setByte(0x144ba, 1);
  check("market refusal order", marketRefusal(state) === 0x117);
  state.setByte(0x144ba, 0);
  state.setWord(0x133f8, 0);
  check("market refused without commander", marketRefusal(state) === 0xb2);
}
{
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  const price = state.word(0x1316a + 10 * 2); // ore
  const money = state.signedLong(A.money);
  const scene = createScreen("market", ctx);
  scene.update(input);
  state.setLong(0x1443a + 8, 50); // ore supply
  clickButton(scene, 4); // item 2 (buttons 2-7 select items 0-5)
  clickButton(scene, 1); // buy
  type(scene, "7");
  check("market: buy raises stock, pays, lowers supply", state.long(0x13152 + 4) >= 7 && state.long(0x1443a + 8) === 43 && state.signedLong(A.money) === money - price * 7);
  check("market: buying marks the month as traded", (state.byte(0x144c2) & 2) !== 0);
  frames(scene, 80);
  clickButton(scene, 9);
  check("market: leaving copies the food stock", state.long(0x1434a) === state.long(0x13156));
}
{
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  const price = state.word(0x1316a + 10 * 2);
  state.setLong(0x13152 + 4, 10); // ore stock (good 1)
  state.setLong(0x1314e + 8, 10);
  state.setLong(0x14452 + 8, 20); // ore demand
  const money = state.signedLong(A.money);
  const income = state.long(0x142f6);
  const scene = createScreen("market", ctx);
  scene.update(input);
  clickButton(scene, 4);
  clickButton(scene, 0); // sell
  type(scene, "4");
  check("market: sell lowers stock and demand, pays", state.long(0x13152 + 4) === 6 && state.long(0x14452 + 8) === 16 && state.signedLong(A.money) === money + price * 4 && state.long(0x142f6) === income + price * 4);
}
{
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  state.setLong(0x13152 + 4, 5);
  state.setLong(0x1314e + 8, 5);
  const money = state.signedLong(A.money);
  const scene = createScreen("market", ctx);
  scene.update(input);
  clickButton(scene, 4);
  clickButton(scene, 8); // dump
  type(scene, "99");
  check("market: dump removes everything it can, no money", state.long(0x13152 + 4) === 0 && state.signedLong(A.money) === money);
}
{
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  const scene = createScreen("market", ctx);
  scene.update(input);
  const money = state.signedLong(A.money);
  clickButton(scene, 4);
  clickButton(scene, 0); // sell with no demand/stock: refused, nothing changes
  check("market: refusals change nothing", state.signedLong(A.money) === money && (state.byte(0x144c2) & 2) === 0);
}

// --- intelligence -----------------------------------------------------------------------------------------
check("intel level thresholds", intelLevel(0) === 0 && intelLevel(1) === 1 && intelLevel(4999) === 1 && intelLevel(5000) === 2 && intelLevel(20000) === 3);
{
  const { state, ctx } = fresh();
  const money = state.signedLong(A.money);
  fundIntelligence(state, 6000);
  check("intel: funding moves money and sets the level", state.long(0x1446a) === 6000 && state.signedLong(A.money) === money - 6000 && state.byte(0x144ca) === 2);
  const scene = createScreen("intel", ctx);
  scene.update(input);
  click(scene, 100, 32);
  type(scene, "500");
  check("intel screen: typed amount is added", state.long(0x1446a) === 6500);
  click(scene, 100, 60); // outside the grant row
  check("intel screen: other clicks are ignored", state.long(0x1446a) === 6500);
}

// --- button sound ($5756/$5948 request SFX id 4 on the press; $57FA/$59C8 release are silent) ----------
{
  const { SFX } = await import("../dist/audio/sfx.js");
  const press = (scene, x, y) => {
    input.pointerX = x;
    input.pointerY = y;
    input.leftButton = true;
    return scene.update(input);
  };
  const release = (scene) => {
    input.leftButton = false;
    return scene.update(input);
  };
  const { ctx } = fresh();
  const played = [];
  ctx.sound = (id) => played.push(id);
  const scene = createScreen("f1", ctx);
  scene.update(input); // first frame
  const { x, y } = ui.buttonPosition(9);
  press(scene, x + 4, y + 4);
  check("button sound: one SFX.CLICK on the press edge", played.length === 1 && played[0] === SFX.CLICK && SFX.CLICK === 4);
  press(scene, x + 4, y + 4); // button held: no new edge
  check("button sound: holding the button adds nothing", played.length === 1);
  const result = release(scene);
  check("button sound: release is silent (and still leaves)", played.length === 1 && result === "close");

  const blank = createScreen("f1", ctx);
  blank.update(input);
  played.length = 0;
  press(blank, 2, 2); // outside every button
  release(blank);
  check("button sound: blank-area click is silent", played.length === 0);

  input.rightButton = true;
  const rightResult = blank.update(input);
  input.rightButton = false;
  const esc = createScreen("f1", ctx);
  esc.update(input);
  input.keys.push("Escape");
  const escapeResult = esc.update(input);
  check("button sound: a right click and Escape stay silent and do not close a report", played.length === 0 && rightResult === "running" && escapeResult === "running");

  const council = createScreen("f1", ctx);
  council.setCouncilMode();
  council.update(input);
  const councilPress = press(council, x + 4, y + 4); // same coordinate, but council has no button column
  const councilResult = release(council); // the council report leaves on the click's release ($2E48), not on the press
  check("button sound: council mode (no button column) is silent and closes on the release", played.length === 0 && councilPress === "running" && councilResult === "close");

  const quiet = fresh().ctx; // no sound hook: unchanged behaviour
  const silent = createScreen("f1", quiet);
  silent.update(input);
  check("button sound: absent hook is harmless", clickButton(silent, 9) === "close");

  // $5110 (number entry) reads keys only and never reaches $5730/$5756: a button press while one is open is silent.
  const staff = createScreen("staff", ctx);
  staff.update(input);
  played.length = 0;
  click(staff, 100, rowY(40, 1)); // opens the number entry (not a button)
  check("button sound: opening a number entry from a row click is silent", played.length === 0);
  press(staff, x + 4, y + 4);
  check("button sound: a button press during a number entry is silent", played.length === 0);
  release(staff);
  const staffAfter = createScreen("staff", ctx);
  staffAfter.update(input);
  click(staffAfter, 100, rowY(40, 1));
  type(staffAfter, "3");
  played.length = 0;
  press(staffAfter, x + 4, y + 4);
  check("button sound: after the entry is confirmed the same button clicks again", played.length === 1 && played[0] === SFX.CLICK);
  release(staffAfter);
}

// --- number entry ($5110) ignores the mouse -------------------------------------------------------------------
// `$5110` never polls `$50B2`, so no press highlights a button, none leaves a release pending, and none can close the parent window
// or start a second action (notes/formats/screens.md section 1).
{
  const { SFX } = await import("../dist/audio/sfx.js");
  const { ctx } = fresh();
  const played = [];
  ctx.sound = (id) => played.push(id);
  const staff = createScreen("staff", ctx);
  staff.update(input);
  click(staff, 100, rowY(40, 1)); // opens the entry
  played.length = 0;
  const exit = ui.buttonPosition(9);
  const flipped = new Screen();
  staff.draw(flipped);
  const idle = flipped.pixels.slice();
  check("number entry: clicking the exit button neither closes the window nor clicks", clickButton(staff, 9) === "running" && played.length === 0);
  check("number entry: clicking a blank command button is silent and keeps the window", clickButton(staff, 0) === "running" && played.length === 0);
  // A button pressed during the entry is not highlighted either.
  input.pointerX = exit.x + 4;
  input.pointerY = exit.y + 4;
  input.leftButton = true;
  staff.update(input);
  const during = new Screen();
  staff.draw(during);
  check("number entry: a button pressed during the entry is not drawn pressed", during.pixels.every((p, i) => p === idle[i]));
  // Held through the confirming Return: the release afterwards must not be taken as a deferred exit.
  input.keys.push("5", "Enter");
  const confirmed = staff.update(input);
  input.leftButton = false;
  const afterRelease = staff.update(input);
  check("number entry: a press held across Return does not close the window on its release", confirmed === "running" && afterRelease === "running" && played.length === 0);
  check("number entry: with the entry finished the exit button works and clicks once", clickButton(staff, 9) === "close" && played.length === 1 && played[0] === SFX.CLICK);

  // A row click during the entry must not start a second entry or move the typed digits.
  const trade = createScreen("trade", ctx);
  trade.update(input);
  click(trade, 100, 0x36 + 3); // retain row 0 opens an entry
  played.length = 0;
  click(trade, 100, 0x36 + 9 * 2 + 3);
  type(trade, "9");
  check("number entry: a row click during an entry is ignored", played.length === 0 && clickButton(trade, 9) === "close");
}
{
  // The market opens its entry from a button release: its own buttons must not restart the entry or leave while it is open.
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  const scene = createScreen("market", ctx);
  scene.update(input);
  state.setLong(0x1443a + 8, 50);
  clickButton(scene, 4);
  clickButton(scene, 1); // buy: opens the entry
  const stockBefore = state.long(0x13152 + 4);
  check("market entry: clicking the exit button does not close the window", clickButton(scene, 9) === "running");
  check("market entry: clicking sell does not restart the entry", clickButton(scene, 0) === "running");
  type(scene, "3");
  check("market entry: the original buy entry is still the one confirmed", state.long(0x13152 + 4) >= stockBefore + 3 && state.long(0x1443a + 8) === 47);
}

// --- pressed-button flip (`$57D6`: plane 3 only, colour bit 3) --------------------------------------------------------
{
  const { flipButtonPixels, BUTTON_FLIP } = await import("../dist/game/screens/ui.js");
  const screen = new Screen();
  ui.drawButtons(screen, ui.readButtonTable(0xe930));
  const before = screen.pixels.slice();
  ui.invertButton(screen, 9);
  const { x, y } = ui.buttonPosition(9);
  let exact = BUTTON_FLIP === 8;
  let outside = true;
  for (let i = 0; i < before.length; i++) {
    const px = i % 320;
    const py = Math.floor(i / 320);
    const inside = px >= x && px < x + 16 && py >= y && py < y + 16;
    if (inside ? screen.pixels[i] !== (before[i] ^ 8) : screen.pixels[i] !== before[i]) {
      if (inside) exact = false;
      else outside = false;
    }
  }
  check("pressed flip: inside the 16x16 button every pixel is colour ^ 8 (plane 3 only)", exact);
  check("pressed flip: nothing outside the button changes", outside);
  flipButtonPixels(screen, x, y);
  check("pressed flip: running it again ($57FA) restores the button", screen.pixels.every((p, i) => p === before[i]));
}

// ---- 2g. F1-F6 without an online command centre ($15B4A tests word $133F8 before each report; zero branches to `$15B3E`,
// which posts message $B2 and opens nothing). Static trace of Disk.1 (screens.md section 7). The Game-level part drives the key
// path: with no power supply the monthly pass reaches shortage level 21 ($A0D4 -> $A1C2), which clears $133F8 (the command centre
// goes offline), so F1 is refused; with the gate restored F1 opens its report.
{
  const { reportRefusal } = await import("../dist/game/screens/index.js");
  const { REPORT_REFUSAL } = await import("../dist/game/screens/reports.js");
  const { PERIOD } = await import("../dist/game/state.js");
  const { T } = await import("../dist/game/world.js");
  const { state } = fresh();
  state.setWord(0x133f8, 0);
  check("report gate: zero $133F8 refuses with message $B2", reportRefusal(state) === REPORT_REFUSAL && REPORT_REFUSAL === 0xb2);
  state.setWord(0x133f8, 1);
  check("report gate: an online command centre lets the reports open", reportRefusal(state) === -1);

  // Game-level: the real key path. localStorage is a plain shim here (the game module reads it only when used).
  const store = new Map();
  globalThis.localStorage ??= { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
  const { Game } = await import("../dist/game/game.js");
  const idle = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  const newGame = () => {
    const game = new Game(disk1, disk2, null, null);
    game.strings = strings;
    game.bootMenuOpen = false;
    game.startScenario(0);
    game.update(idle); // consumes the opening-click guard of the scene (as game-over.mjs does)
    return game;
  };
  // A window key is folded into the map's key cell on arrival and dispatched by the first completed pass's poll ($15B4A after the
  // press, MapScene.poll), so it is taken at most one pass (4 updates) after arrival. `arrival` says what the arrival update did:
  // "pass" (the arrival update was the pass), "taken" (the update reacted: a window opened or a line was posted), or "queued".
  const pressKey = (g, key) => {
    const keys = [key];
    const passes = g.map.loop.passes;
    let arrival = null;
    for (let n = 0; n < 8 && g.map.loop.passes === passes; n++) {
      const stage = g.stage;
      const line = g.map.messages.inspect().lineFramesLeft;
      g.update({ ...idle, keys });
      if (arrival === null) {
        const reacted = g.stage !== stage || g.map.messages.inspect().lineFramesLeft !== line;
        arrival = g.map.loop.passes !== passes ? "pass" : reacted ? "taken" : "queued";
      }
    }
    return { taken: g.map.loop.passes !== passes, arrival };
  };

  const control = newGame();
  check("F1 with an online command centre opens the report (control)", control.map.world.state.word(0x133f8) === 1 && (pressKey(control, "F1"), control.stage === "screen"));

  const game = newGame();
  const map = game.map;
  const said = [];
  const say = map.say.bind(map);
  map.say = (n) => {
    said.push(n);
    say(n);
  };
  const state2 = map.world.state;
  for (const ty of [0, 11, 12, 31]) {
    const a = map.world.typeAddress(ty); // no supply: power store, solar A and B, power station
    state2.setWord(a + T.total, 0);
    state2.setLong(a + T.stored, 0);
  }
  state2.setByte(A.pending, PERIOD.monthly);
  map.sim.run();
  check("monthly shortage with no supply reaches level 21 and clears $133F8", state2.byte(0x144c8) >= 0xe && state2.word(0x133f8) === 0, `level ${state2.byte(0x144c8)} gate ${state2.word(0x133f8)}`);
  const refused = pressKey(game, "F1");
  check("F1 without an online command centre: message $B2, no report, stage stays on the map", game.stage === "map" && game.window === null && said.includes(0xb2), `stage ${game.stage} said ${said.map((n) => n.toString(16))}`);
  check("F1 is taken by the completed pass's poll, not on arrival (queued while the update is not a pass)", refused.taken && refused.arrival !== "taken", `arrival ${refused.arrival}`);
  check("F1 refusal: the line timer reads 200 in the pass update that took the key (drawn there, first tick on the next update)", map.messages.inspect().lineFramesLeft === 200, `timer ${map.messages.inspect().lineFramesLeft}`);
  game.update(idle);
  check("the refused key is used up: the next idle update does not reopen the report", game.stage === "map" && game.window === null);
  check("F1 refusal: the next update ticks the line to 199", map.messages.inspect().lineFramesLeft === 199, `timer ${map.messages.inspect().lineFramesLeft}`);
  state2.setWord(0x133f8, 1); // the command centre is back online ($9B90)
  pressKey(game, "F1");
  check("F1 with the gate restored opens the report", game.stage === "screen");
}

// ---- 2h. Number entry and keypad digits (intro.ts keypadToken / typedDigit). The count entry's key table $650A (Disk.1) maps raw
// $0F, $1D-$1F, $2D-$2F, $3D-$3F to the digits 0-9 besides the top row $0A-$01, so a keypad digit is typed like a top-row digit.
// Releases type nothing (the original's release bytes have bit 7 set and are not in the table).
{
  const { NumberEntry } = await import("../dist/game/screens/ui.js");
  const { keypadToken, keyUpToken, typedDigit, isKeypadToken } = await import("../dist/game/intro.js");
  check("typedDigit: top-row and keypad digits give the digit; names, Enter and releases give none", typedDigit("7") === "7" && typedDigit(keypadToken("7")) === "7" && typedDigit("Enter") === undefined && typedDigit(keyUpToken("7")) === undefined && typedDigit(keypadToken("Enter")) === undefined);
  check("keypadToken is recognised only by its prefix", isKeypadToken(keypadToken("1")) && !isKeypadToken("1") && !isKeypadToken(keyUpToken("1")));
  const entry = new NumberEntry(0, 0, 4, 4);
  entry.feed([keypadToken("4"), "2", keyUpToken("2"), keypadToken("9"), "Enter"]);
  check("number entry: keypad and top-row digits are kept in order; a release adds no digit; Enter confirms 429", entry.done === 429 && entry.digits === "429", `digits=${entry.digits} done=${entry.done}`);
}

console.log(failed === 0 ? "all screen checks passed" : `${failed} screen check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
