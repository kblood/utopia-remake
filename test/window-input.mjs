// Input of the traced window loops: the mouse poll `$50B2` (mouse-poll.ts) and what the ship yard order window `$D7D6`, the
// fuel-tank and other read-outs `$BF56` / `$B99C`, and the ship window `$DCFE` do with its events (notes/formats/building-screens.md
// 3.2 and 3.7, ship-control.md 6). Section 2e checks each control of the command centre, hospital, sports complex, missile
// launcher and tank teleporter loops (building-screens.md 3.3-3.6, 3.8). Static trace of Disk.1, 2026-11-10; no emulator run, so
// these are checks of the remake's port with synthetic frames, not an emulator comparison. Section 2f checks the F1-F6 reports
// (`$B99C`), the council-room report click, and the trade, market, staffing and intelligence windows (screens.md 1-6).
// Run after `npm run build`.
//
// The first block needs no game data. The second needs the user's Disk.1 and Disk.2 in original/utopia-whdload and is
// skipped (after the first block) when they are missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");

const { MousePoll } = await import("../dist/game/screens/mouse-poll.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- 1. the poll state machine ($50B2), frame by frame ----------------------------------------------------------------
// poll(left, right) returns true for an event; isLeftHeld tells a press (true) from a release (false) after an event.
{
  const p = new MousePoll();
  p.start(false, false);
  check("poll: nothing held, nothing reported", p.poll(false, false) === false);

  const press = p.poll(true, false);
  check("poll: a left press is an event and a press", press === true && p.isLeftHeld === true);
  check("poll: a held left button is not reported again", p.poll(true, false) === false && p.isLeftHeld === true);

  const release = p.poll(false, false);
  check("poll: the left release is an event and a release", release === true && p.isLeftHeld === false);
  check("poll: after the release nothing is reported", p.poll(false, false) === false);
}
{
  // A right press alone is an event, but with the left button up it is a release-branch event with nothing latched.
  const p = new MousePoll();
  p.start(false, false);
  check("poll: a right press alone is an event", p.poll(false, true) === true && p.isLeftHeld === false);
  check("poll: a held right button is not reported again", p.poll(false, true) === false);
  check("poll: a right release is not an event", p.poll(false, false) === false);
}
{
  // A right press while the left button is held: the press branch runs again at the pointer ($DCFE, $D8AE, $C70E).
  const p = new MousePoll();
  p.start(true, false); // the left button was already held when the window opened
  check("poll: the held left button at open is not a new press", p.poll(true, false) === false);
  check("poll: a right press while the left is held is an event and a press", p.poll(true, true) === true && p.isLeftHeld === true);
  check("poll: a right button that stays down is not reported again", p.poll(true, true) === false);
  check("poll: releasing the right button while the left is held is no event", p.poll(true, false) === false);
  check("poll: the next right press while the left is held is an event again", p.poll(true, true) === true);
}
{
  // A left press while the right button is already down: the left press clears the right bit ($50D0), so the right
  // button counts as a new press on the next poll. One frame carries two events, both presses.
  const p = new MousePoll();
  p.start(false, true);
  const first = p.poll(true, true);
  const second = first && p.poll(true, true);
  const third = second && p.poll(true, true);
  check("poll: left press with the right already down: left press, then a right re-press", first && p.isLeftHeld && second && p.isLeftHeld, `first ${first} second ${second}`);
  check("poll: no third event after the two presses", third === false);
}
{
  // The left button released while the right stays down: the release, then the right button again (left up: no press).
  const p = new MousePoll();
  p.start(true, true);
  const release = p.poll(false, true);
  check("poll: left release with the right still down is an event and a release", release === true && p.isLeftHeld === false);
  check("poll: the still-held right button is reported once more, as a release-branch event", p.poll(false, true) === true && p.isLeftHeld === false);
  check("poll: and then nothing", p.poll(false, true) === false);
}

{
  // The press latch ($156A9 bit 0, mouse-poll.ts): with it set at the window's start, a held left button is a press event on every
  // poll ($50E6 -> $50D0), each a repeat for the caller (one per pass); a poll with the left button up clears it ($50BE).
  const p = new MousePoll();
  p.start(true, false, true);
  check("latch: a held left button with the latch set is a repeated press on the first poll", p.poll(true, false) === true && p.isLeftHeld === true && p.isRepeat === true);
  check("latch: the press repeats on the next poll too", p.poll(true, false) === true && p.isRepeat === true);
  check("latch: a right press while the left is held is a repeat as well (the right bit was cleared)", p.poll(true, true) === true && p.isRepeat === true);
  check("latch: the left release is an event and a release, not a repeat", p.poll(false, true) === true && p.isLeftHeld === false && p.isRepeat === false);
  check("latch: after the release a new left press is a new press (the latch was cleared)", p.poll(true, false) === true && p.isRepeat === false && p.poll(true, false) === false);
}
{
  // Without the latch a held left button stays silent (the earlier cases), and a press that starts with the latch set is a new press first.
  const p = new MousePoll();
  p.start(true, false, false);
  check("latch: without the latch a held left button is silent and not a repeat", p.poll(true, false) === false && p.isRepeat === false);
  const q = new MousePoll();
  q.start(false, false, true);
  check("latch: a press edge with the latch set is an ordinary press (not a repeat)", q.poll(true, false) === true && q.isRepeat === false);
  check("latch: and the next pass repeats it", q.poll(true, false) === true && q.isRepeat === true);
}

if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("window-input scene checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  if (failed > 0) {
    console.log(`${failed} window-input check(s) FAILED`);
    process.exit(1);
  }
  console.log("window-input checks passed");
  process.exit(0);
}

// ---- 2. the scenes on the traced loops ----------------------------------------------------------------------------------
const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Ui } = await import("../dist/game/screens/ui.js");
const { createOrderScreen } = await import("../dist/game/screens/orders.js");
const b = await import("../dist/game/screens/buildings.js");
const { UnitSystem } = await import("../dist/game/units.js");
const { readOrderByte } = await import("../dist/game/screens/order-byte.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const strings = new GameStrings(disk1, 0);
const ui = new Ui(disk1, strings);
const W = 100;

// A world with an empty object list (as in test/buildings.mjs).
function fresh(sound) {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  world.objects.fill(0);
  world.objectCount = 0;
  world.state.setWord(0x142c2, 0);
  const sim = new Sim(world, { rng: createRng(1) });
  const ctx = { disk: disk1, world, sim, strings, say: () => {}, sound };
  return { state, world, ctx };
}

function plant(world, tile, x, y) {
  const at = world.objectCount * 8;
  world.objectCount++;
  world.state.setWord(0x142c2, world.objectCount);
  world.objects[at] = tile >> 8;
  world.objects[at + 1] = tile & 255;
  world.objects[at + 3] = 0;
  world.objects[at + 4] = x;
  world.objects[at + 5] = y;
  world.cells[y * W + x] = (world.cells[y * W + x] & 0x8000) | tile;
  return at;
}
const setTypeC = (world, type, v) => world.state.setWord(world.typeAddress(type) + 0xc, v);

// One frame of input. `at` is the pointer position of the frame.
function frame(scene, { left = false, right = false, at = null } = {}) {
  const p = at ?? { x: 0, y: 0 };
  return scene.update({ leftButton: left, rightButton: right, pointerX: p.x, pointerY: p.y, keys: [] });
}
const escape = (scene) => scene.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: ["Escape"] });
const centre = (x0, y0) => ({ x: x0 + 8, y: y0 + 8 });
const buttonAt = (index) => {
  const { x, y } = ui.buttonPosition(index);
  return { x: x + 4, y: y + 4 };
};
const ICON_CENTRE = (k) => centre(ui.image.word(0xefe0 + 8 * k), ui.image.word(0xefe0 + 8 * k + 4));
const PIN_CENTRE = (n) => centre(ui.image.word(0xf056 + 8 * n), ui.image.word(0xf056 + 8 * n + 4));
const ORDER_BUTTON = 8;
const EXIT_BUTTON = 9;
const BUTTON_BLANK = 0;
const WORK = (k) => ui.image.word(0xf012 + 2 * k);

// ---- 2a. ship yard order window $D886 ----------------------------------------------------------------------------------
{
  // Icon 1 is picked with the left button, then a right press over the order button while the left is still held runs the
  // press at the pointer again: button 8 is latched, and its release (the left button, anywhere) orders icon 1.
  let sounds = 0;
  const { world, state, ctx } = fresh(() => sounds++);
  const yard = plant(world, 0x36, 37, 20);
  setTypeC(world, 29, 1);
  setTypeC(world, 27, 1);
  state.setLong(0x14472, 0);
  const scene = b.createBuildingScreen(ctx, 37, 20);
  frame(scene); // the window opens with the buttons up
  check("yard: a left press on an icon selects it and is silent", frame(scene, { left: true, at: ICON_CENTRE(1) }) === "running" && sounds === 0);
  check("yard: the left button still held over the icon is nothing new", frame(scene, { left: true, at: ICON_CENTRE(1) }) === "running" && sounds === 0);
  // The left button stays down; a right press over button 8 is a press at the pointer (click), then the left release orders.
  check("yard: a right press over button 8 with the left held latches it and clicks", frame(scene, { left: true, right: true, at: buttonAt(ORDER_BUTTON) }) === "running" && sounds === 1);
  check("yard: the release of the left button (anywhere) orders icon 1 and closes", frame(scene, { right: true, at: ICON_CENTRE(0) }) === "close");
  check("yard: the order is type 1 + 1 with the work of icon 1", world.objects[yard + 6] === 2 && world.objects[yard + 7] === WORK(1), `order ${world.objects[yard + 6]}`);
}
{
  // Right press alone over the order button: nothing latched, nothing ordered, no click. The exit button then closes it
  // without an order, and Escape does nothing at any time.
  let sounds = 0;
  const { world, state, ctx } = fresh(() => sounds++);
  const yard = plant(world, 0x36, 37, 20);
  setTypeC(world, 29, 1);
  setTypeC(world, 27, 1);
  state.setLong(0x14472, 0);
  const scene = b.createBuildingScreen(ctx, 37, 20);
  frame(scene);
  check("yard: Escape does nothing", escape(scene) === "running");
  check("yard: a right press alone over button 8 does nothing and is silent", frame(scene, { right: true, at: buttonAt(ORDER_BUTTON) }) === "running" && sounds === 0);
  check("yard: its release does nothing", frame(scene, { at: buttonAt(ORDER_BUTTON) }) === "running" && world.objects[yard + 6] === 0);
  check("yard: a click on the exit button closes without an order", (frame(scene, { left: true, at: buttonAt(EXIT_BUTTON) }), frame(scene, { at: buttonAt(EXIT_BUTTON) })) === "close" && world.objects[yard + 6] === 0);
}
{
  // A press on a blank button and a right re-press over the order button, both with the left held: the last press decides
  // the latch (button 8), and no icon is chosen, so the release leaves without an order.
  const { world, state, ctx } = fresh(() => {});
  const yard = plant(world, 0x36, 37, 20);
  setTypeC(world, 29, 1);
  setTypeC(world, 27, 1);
  state.setLong(0x14472, 0);
  const scene = b.createBuildingScreen(ctx, 37, 20);
  frame(scene);
  check("yard: a left press on a blank button latches it", frame(scene, { left: true, at: buttonAt(BUTTON_BLANK) }) === "running");
  check("yard: a right press over button 8 re-latches button 8 (last press wins)", frame(scene, { left: true, right: true, at: buttonAt(ORDER_BUTTON) }) === "running");
  check("yard: the release orders nothing (no icon chosen) and closes", frame(scene, { right: true, at: buttonAt(ORDER_BUTTON) }) === "close" && world.objects[yard + 6] === 0);
}

// ---- 2b. read-outs $B99C (fuel tanks and storage, the ship status window): any button leaves; no key, no right-click leave ---
for (const [name, tile, x, y] of [["fuel tank", 0x3f, 12, 10], ["power storage", 1, 10, 10]]) {
  const { world, ctx } = fresh(() => {});
  setTypeC(world, 29, 1);
  plant(world, tile, x, y);
  const scene = b.createBuildingScreen(ctx, x, y);
  frame(scene);
  check(`${name}: Escape does nothing`, escape(scene) === "running");
  check(`${name}: a right press alone does nothing`, frame(scene, { right: true, at: buttonAt(BUTTON_BLANK) }) === "running" && frame(scene, { at: buttonAt(BUTTON_BLANK) }) === "running");
  check(`${name}: a press on a blank button leaves on its release`, frame(scene, { left: true, at: buttonAt(BUTTON_BLANK) }) === "running" && frame(scene, { at: buttonAt(BUTTON_BLANK) }) === "close");
}
{
  // A right press over a blank button while the left is held re-latches it, and the release closes the window too.
  const { world, ctx } = fresh(() => {});
  setTypeC(world, 29, 1);
  plant(world, 0x3f, 12, 10);
  const scene = b.createBuildingScreen(ctx, 12, 10);
  frame(scene);
  frame(scene, { left: true, at: buttonAt(3) });
  check("fuel tank: a right press over another button while the left is held does not leave", frame(scene, { left: true, right: true, at: buttonAt(BUTTON_BLANK) }) === "running");
  check("fuel tank: the release of the latched button leaves", frame(scene, { left: false, right: true, at: buttonAt(BUTTON_BLANK) }) === "close");
}

// ---- 2c. ship window $DCFE: a right press while the left is held picks a pin at the pointer ----------------------------
{
  const sent = [];
  let sounds = 0;
  const { ctx } = fresh(() => sounds++);
  const enemies = { padPending: () => false, commandShip: (_ship, cmd, target) => (sent.push({ cmd, target }), null) };
  const objects = { units: { units: [], order() {} }, enemies, markerCell: (n) => (n === 1 ? { x: 10, y: 10 } : null) };
  const shipCtx = { ...ctx, objects };
  const ship = { mode: 0, cls: 0, tech: 0, hp: 0, fuel: 100, x: 0, y: 0 };
  const window = createOrderScreen(shipCtx, { kind: "ship", ship });
  frame(window);
  check("ship: a left press on empty window space picks nothing", frame(window, { left: true, at: { x: 2, y: 2 } }) === "running");
  check("ship: that release picks nothing", frame(window, { at: { x: 2, y: 2 } }) === "running");
  check("ship: a right press over pin 1 while the left is up picks nothing", frame(window, { right: true, at: PIN_CENTRE(0) }) === "running");
  check("ship: its release picks nothing", frame(window, { at: PIN_CENTRE(0) }) === "running");
  check("ship: Escape and a right press did not leave the window", escape(window) === "running");
  check("ship: no sound for pin picks", sounds === 0);
  // Now the left button goes down on the window, and a right press over pin 1 while it is held picks it.
  frame(window, { left: true, at: { x: 2, y: 2 } });
  check("ship: a right press over pin 1 while the left is held picks it", frame(window, { left: true, right: true, at: PIN_CENTRE(0) }) === "running");
  check("ship: the release (anywhere) leaves no latch", frame(window, { right: true, at: { x: 2, y: 2 } }) === "running" && sounds === 0);
  check("ship: the exit button applies the order with the picked pin", (frame(window, { left: true, at: buttonAt(EXIT_BUTTON) }), frame(window, { at: buttonAt(EXIT_BUTTON) })) === "close");
  check("ship: the order is goLand (2) to pin 1", sent.length === 1 && sent[0].cmd === 2 && sent[0].target?.x === 10 && sent[0].target?.y === 10, JSON.stringify(sent));
}
{
  // Without any right press a pin is only picked by a left press on it.
  const sent = [];
  const { ctx } = fresh(() => {});
  const enemies = { padPending: () => false, commandShip: (_ship, cmd, target) => (sent.push({ cmd, target }), null) };
  const objects = { units: { units: [], order() {} }, enemies, markerCell: (n) => (n === 1 ? { x: 10, y: 10 } : null) };
  const ship = { mode: 0, cls: 0, tech: 0, hp: 0, fuel: 100, x: 0, y: 0 };
  const window = createOrderScreen({ ...ctx, objects }, { kind: "ship", ship });
  frame(window);
  frame(window, { left: true, at: PIN_CENTRE(0) });
  frame(window, { at: PIN_CENTRE(0) });
  frame(window, { left: true, at: buttonAt(EXIT_BUTTON) });
  frame(window, { at: buttonAt(EXIT_BUTTON) });
  check("ship: a left press on pin 1 picks it, the exit applies goLand to it", sent.length === 1 && sent[0].cmd === 2 && sent[0].target?.x === 10);
}

// ---- 2d. tank window $C6EC: the count entry ($5110) owns the loop and does not poll; $50B2 then sees the old state -------
{
  let sounds = 0;
  const { state, ctx } = fresh(() => sounds++);
  state.setByte(0x13ee6, 0x80); // the front button is live (bit 7 of the first-report byte)
  const unit = { x: 33, y: 20, tech: 0, hp: 0 };
  const objects = { units: { units: [unit], order() {} }, enemies: null, markerCell: () => null };
  const tank = createOrderScreen({ ...ctx, objects }, { kind: "tank", unit });
  frame(tank);
  frame(tank, { left: true, at: buttonAt(5) });
  frame(tank, { at: buttonAt(5) }); // the release asks for a count
  check("tank: the front order opens the count entry", tank.entry !== null);
  const before = sounds;
  frame(tank, { left: true, at: buttonAt(EXIT_BUTTON) }); // no poll while the entry is open
  check("tank: a press during the count entry is silent and does nothing", sounds === before && tank.entry !== null);
  // Return ends the entry in this frame, and the left button is still down over the exit button: the next poll sees it as a press.
  tank.update({ leftButton: true, rightButton: false, pointerX: buttonAt(EXIT_BUTTON).x, pointerY: buttonAt(EXIT_BUTTON).y, keys: ["5", "Enter"] });
  check("tank: the entry ends, and a button still held then is a new press (one click)", tank.entry === null && sounds === before + 1, `sounds ${sounds - before}`);
  check("tank: its release runs the exit button and closes", frame(tank, { at: buttonAt(EXIT_BUTTON) }) === "close");
}

// ---- 2e. building windows on the traced loops (building-screens.md 3.3-3.8) ---------------------------------------------
// Each window: Escape and a right press alone change nothing; the exit button (9) leaves on its release; the action
// button (8) acts on its release; the other buttons are blank. A latched press is run wherever the pointer is when the
// button comes up (`$57FA`), so a release off the button still counts. OFF is a point over no button.
const OFF = { x: 2, y: 2 };
const countOf = (world, type) => world.state.word(world.typeAddress(type) + 0xc);
const press = (scene, index) => frame(scene, { left: true, at: buttonAt(index) });
const releaseAt = (scene, p) => frame(scene, { at: p });
{
  // Command centre $C0C6: `$58F8` on $E95C. Button 8 switches the centre; 9 leaves.
  let sounds = 0;
  const { state, world, ctx } = fresh(() => sounds++);
  state.setByte(0x144c8, 0);
  setTypeC(world, 29, 0);
  const at = plant(world, 0x4c, 20, 20);
  const scene = b.createBuildingScreen(ctx, 20, 20);
  frame(scene);
  check("command centre: Escape does nothing", escape(scene) === "running");
  check("command centre: a right press alone over button 8 does nothing and is silent", frame(scene, { right: true, at: buttonAt(8) }) === "running" && releaseAt(scene, buttonAt(8)) === "running" && world.objects[at + 3] === 0 && sounds === 0);
  check("command centre: a blank button latches (one click) and its release does nothing", press(scene, 3) === "running" && sounds === 1 && releaseAt(scene, buttonAt(3)) === "running" && world.objects[at + 3] === 0);
  check("command centre: button 8 switches the centre on at its release", press(scene, 8) === "running" && world.objects[at + 3] === 0 && releaseAt(scene, buttonAt(8)) === "running" && world.objects[at + 3] === 0xff && countOf(world, 29) === 1);
  check("command centre: a release off the button still switches it off", press(scene, 8) === "running" && releaseAt(scene, OFF) === "running" && world.objects[at + 3] === 0 && countOf(world, 29) === 0);
  check("command centre: the exit button leaves on its release", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
  const left = b.createBuildingScreen(ctx, 20, 20);
  frame(left);
  check("command centre: the exit still leaves when released off the button", press(left, 9) === "running" && releaseAt(left, OFF) === "close");
}
{
  // Hospital $C280: button 8 steps the birth rate ($145A2); 9 leaves.
  let sounds = 0;
  const { state, world, ctx } = fresh(() => sounds++);
  state.setByte(0x144c8, 0);
  plant(world, 0x0e, 24, 20);
  state.setByte(0x145a2, 0);
  const scene = b.createBuildingScreen(ctx, 24, 20);
  frame(scene);
  check("hospital: Escape and a right press alone do nothing", escape(scene) === "running" && frame(scene, { right: true, at: buttonAt(8) }) === "running" && releaseAt(scene, buttonAt(8)) === "running" && state.byte(0x145a2) === 0);
  check("hospital: button 8 steps the birth rate on its release", press(scene, 8) === "running" && state.byte(0x145a2) === 0 && releaseAt(scene, buttonAt(8)) === "running" && state.byte(0x145a2) === 0x14);
  check("hospital: a blank button changes nothing", press(scene, 2) === "running" && releaseAt(scene, buttonAt(2)) === "running" && state.byte(0x145a2) === 0x14);
  check("hospital: the exit button leaves on its release", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
}
{
  // Sports complex $C3DE: button 8 calls an event only while the countdown $144B2 is 0 (`$C41C`); 9 leaves.
  const { state, world, ctx } = fresh(() => {});
  state.setByte(0x144c8, 0);
  plant(world, 0x5c, 28, 20, 1);
  state.setByte(0x144b2, 0);
  state.setByte(0x144b1, 0);
  const scene = b.createBuildingScreen(ctx, 28, 20);
  frame(scene);
  check("sports: Escape does nothing", escape(scene) === "running" && state.byte(0x144b2) === 0);
  check("sports: button 8 calls the event on its release and the window stays open", press(scene, 8) === "running" && releaseAt(scene, buttonAt(8)) === "running" && state.byte(0x144b2) === 12 && (state.byte(0x144b1) & 1) === 1);
  state.setByte(0x144b1, 0);
  check("sports: while the countdown runs button 8 does nothing", press(scene, 8) === "running" && releaseAt(scene, buttonAt(8)) === "running" && state.byte(0x144b2) === 12 && state.byte(0x144b1) === 0);
  check("sports: the exit button leaves on its release", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
}
{
  // Missile launcher $E122: button 8 fires only with a target ($E158); a fire, or a refused one, closes ($E14A); 9 leaves.
  const said = [];
  const { state, world, ctx } = fresh(() => {});
  const sayCtx = { ...ctx, say: (i) => said.push(i) };
  state.setByte(0x144c8, 0);
  setTypeC(world, 8, 1);
  const at = plant(world, 0x30, 33, 20);
  world.objects[at + 3] = 0xff;
  const noTarget = b.createBuildingScreen(sayCtx, 33, 20, {});
  frame(noTarget);
  check("missile: Escape does nothing", escape(noTarget) === "running");
  check("missile: without a target button 8 does nothing and says nothing", press(noTarget, 8) === "running" && releaseAt(noTarget, buttonAt(8)) === "running" && world.objects[at + 1] === 0x30 && said.length === 0);
  check("missile: the exit button leaves on its release", press(noTarget, 9) === "running" && releaseAt(noTarget, buttonAt(9)) === "close");
  const refused = b.createBuildingScreen(sayCtx, 33, 20, { findTarget: () => ({ x: 60, y: 40 }), launchMissile: () => false });
  frame(refused);
  check("missile: a target arms button 8; a refused launch says $12B and closes with the launcher kept", press(refused, 8) === "running" && releaseAt(refused, buttonAt(8)) === "close" && said.at(-1) === 0x12b && world.objects[at + 1] === 0x30);
  let fired = 0;
  const ok = b.createBuildingScreen(sayCtx, 33, 20, { findTarget: () => ({ x: 60, y: 40 }), launchMissile: () => (fired++, true) });
  frame(ok);
  check("missile: a launch closes on the release and removes the launcher", press(ok, 8) === "running" && releaseAt(ok, OFF) === "close" && fired === 1 && world.objects[at] === 0);
}
{
  // Tank teleporter $CBB4 (polls $50B2 itself): a press on a placed pin selects it (a press elsewhere, or on an unplaced pin,
  // does nothing); a release runs the latch: 8 returns the selected pin (`$CC22`) and then teleports, 9 leaves. A latched
  // release first writes $FF to the order byte (`$CC0E`).
  const setup = () => {
    let sounds = 0;
    const said = [];
    const { state, world, ctx } = fresh(() => sounds++);
    state.setByte(0x144c8, 0);
    plant(world, 0x47, 33, 20);
    const units = new UnitSystem(world.cells);
    const unit = units.spawn(9, 33, 20);
    const pins = [null, { x: 60, y: 30 }, null, null, { x: 62, y: 32 }, null, null, null];
    world.cells[30 * W + 60] &= ~0x7400;
    world.cells[32 * W + 62] &= ~0x7400;
    const hooks = { units, pin: (n) => pins[n] };
    const sayCtx = { ...ctx, say: (i) => said.push(i) };
    const open = () => {
      const s = b.createBuildingScreen(sayCtx, 33, 20, hooks);
      frame(s);
      return s;
    };
    const pinAt = (n) => ({ x: ui.image.word(0xee1e + 8 * n) + 8, y: ui.image.word(0xee1e + 8 * n + 4) + 10 });
    return { world, unit, said, open, pinAt, sounds: () => sounds };
  };
  {
    const t = setup();
    const scene = t.open();
    check("teleporter: Escape does nothing", escape(scene) === "running");
    check("teleporter: a right press alone over a placed pin selects nothing and is silent", frame(scene, { right: true, at: t.pinAt(1) }) === "running" && releaseAt(scene, t.pinAt(1)) === "running" && t.sounds() === 0);
    check("teleporter: button 8 with no pin selected closes without moving the tank", press(scene, 8) === "running" && releaseAt(scene, buttonAt(8)) === "close" && t.unit.x === 33 && readOrderByte(t.world) === 0xff && t.said.length === 0);
  }
  {
    const t = setup();
    const scene = t.open();
    check("teleporter: a press on an unplaced pin selects nothing and is silent", frame(scene, { left: true, at: t.pinAt(0) }) === "running" && releaseAt(scene, OFF) === "running" && t.sounds() === 0);
    check("teleporter: button 8 after that still moves nothing", press(scene, 8) === "running" && releaseAt(scene, buttonAt(8)) === "close" && t.unit.x === 33);
  }
  {
    const t = setup();
    const scene = t.open();
    check("teleporter: a press on a placed pin selects it and its release off the pin does not leave", frame(scene, { left: true, at: t.pinAt(1) }) === "running" && releaseAt(scene, OFF) === "running" && t.sounds() === 0);
    // `$CC22` copies the selected pin ($F172 = 1) into the order byte, so a confirmed pick leaves 1 there (not $FF).
    check("teleporter: button 8 then teleports the tank to that pin and closes", press(scene, 8) === "running" && releaseAt(scene, buttonAt(8)) === "close" && t.unit.x === 60 && t.unit.y === 30 && t.said.at(-1) === 0x10d && readOrderByte(t.world) === 1);
  }
  {
    const t = setup();
    const scene = t.open();
    frame(scene, { left: true, at: t.pinAt(4) });
    releaseAt(scene, OFF);
    check("teleporter: the exit button closes without a move even after a pin is selected", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close" && t.unit.x === 33 && readOrderByte(t.world) === 0xff);
  }
}

// ---- 2f. report, trade, market, staffing and intelligence windows (F1-F6 `$B99C`, trade `$CC8E`, market `$D106`, staffing
// `$BAAE`, intelligence `$E2D2`; static trace of Disk.1, notes/formats/screens.md "Input"). Each one polls the mouse through
// `$50B2` (or `$58F8`, which polls it): a release of its latched button runs the button's action, a release off the buttons
// does nothing, and no key or right button leaves. Escape reaches only the number entry `$5110`, which ignores it, so it
// never cancels an entry. The exit button closes; the market's result hold (`$D33C`) ignores the mouse for 76 frames.
{
  const { createScreen, MarketScreen, TradeScreen, StaffingScreen, IntelScreen } = await import("../dist/game/screens/index.js");
  const { TRADE } = await import("../dist/game/screens/trade.js");
  const { STAFF } = await import("../dist/game/screens/staff.js");
  const { INTEL } = await import("../dist/game/screens/intel.js");
  const { A } = await import("../dist/game/state.js");
  const marketReady = (state) => {
    state.setByte(TRADE.flags, 0); // not traded this month
    state.setByte(TRADE.tradeFailure, 0);
    state.setWord(TRADE.tradeAllowed, 1); // a commander exists
  };

  // -- the six F-key reports: `$B99C` leaves on the release of any command button (the default `onButton`), nothing else.
  for (const kind of ["f1", "f2", "f3", "f4", "f5", "f6"]) {
    let sounds = 0;
    const { ctx } = fresh(() => sounds++);
    const scene = createScreen(kind, ctx);
    frame(scene);
    check(`${kind} report: Escape does nothing`, escape(scene) === "running");
    check(`${kind} report: a right press alone over a button does nothing and is silent`, frame(scene, { right: true, at: buttonAt(0) }) === "running" && sounds === 0);
    check(`${kind} report: a press off every button and its release do nothing`, frame(scene, { left: true, at: OFF }) === "running" && releaseAt(scene, OFF) === "running" && sounds === 0);
    check(`${kind} report: a press on a button clicks, and its release leaves wherever the pointer is`, press(scene, 4) === "running" && sounds === 1 && releaseAt(scene, OFF) === "close");
  }
  {
    // An F-key report opened while the map's scroll latch is set ($15B4A runs during a held arrow, screens.md "Window loops"): the
    // held left button repeats its press on every poll of `$58F8`, which polls `$50B2` with no VBL wait between repeats (only the
    // entry waits, `$5908`), so the port's one repeat per update is a documented limit, not the original's rate. Its release leaves.
    let sounds = 0;
    const { ctx } = fresh(() => sounds++);
    ctx.pressLatch = () => true;
    const scene = createScreen("f2", ctx);
    check("f2 report with the latch: the held left button over button 4 clicks on the first pass", frame(scene, { left: true, at: buttonAt(4) }) === "running" && sounds === 1);
    check("f2 report with the latch: the next update repeats the press (one more click; documented limit)", frame(scene, { left: true, at: buttonAt(4) }) === "running" && sounds === 2);
    check("f2 report with the latch: the release leaves wherever the pointer is", releaseAt(scene, OFF) === "close" && sounds === 2);
  }
  {
    // Rendering of the latched button (`$5756` flips plane 3 of the button; `$57FA` flips it back once). The port draws the latched
    // button inverted and keeps it steady across repeats: the original's repeats each flip it again at poll rate (documented limit),
    // so the repeat frames here are pinned to the steady look. Without the latch, press and release change nothing else.
    const { Screen } = await import("../dist/gfx/screen.js");
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const snap = (scene) => {
      const s = new Screen();
      scene.draw(s);
      return s.pixels.slice();
    };
    {
      const { ctx } = fresh(() => {});
      ctx.pressLatch = () => true;
      const scene = createScreen("f2", ctx);
      frame(scene);
      const idle = snap(scene);
      frame(scene, { left: true, at: buttonAt(4) });
      const first = snap(scene);
      frame(scene, { left: true, at: buttonAt(4) });
      const second = snap(scene);
      frame(scene, { left: true, at: buttonAt(4) });
      const third = snap(scene);
      check("f2 report latch render: the first press inverts the latched button", !same(first, idle));
      check("f2 report latch render: repeated presses keep the steady look (documented limit)", same(first, second) && same(second, third));
      releaseAt(scene, OFF);
      check("f2 report latch render: the release restores the idle look", same(snap(scene), idle));
    }
    {
      // The button is already held when the report opens: that is not a new press, so the look stays idle (as before).
      const { ctx } = fresh(() => {});
      const scene = createScreen("f2", ctx);
      const idle = snap(scene);
      frame(scene, { left: true, at: buttonAt(4) });
      frame(scene, { left: true, at: buttonAt(4) });
      check("f2 report without the latch: a button held at opening draws as idle (unchanged)", same(snap(scene), idle));
    }
  }
  {
    // The same report without the latch: the button held when it opens is not a new press, so nothing clicks.
    let sounds = 0;
    const { ctx } = fresh(() => sounds++);
    const scene = createScreen("f2", ctx);
    check("f2 report without the latch: a held left button over button 4 is silent", frame(scene, { left: true, at: buttonAt(4) }) === "running" && frame(scene, { left: true, at: buttonAt(4) }) === "running" && sounds === 0);
  }
  {
    // Static pins of the Disk.1 bytes behind the latch repeat (screens.md "Window loops", 2026-11-10; no emulator run). The loop
    // `$58F8` waits for a VBL only on entry (`$5900`-`$5908`); its poll `$590A` (`bsr $50B2`) and the no-event branch `bmi $590A`
    // (`$590E`) have no wait, and a press over a button returns with `bra $590A` (`$5946`). `$5756` selects one buffer when bit 4 of
    // `$156A8` is set (`$579A` btst, `beq $57A8` at `$57A2` not taken) and `$B680`, called by the F-key handlers, sets bit 4.
    const at = (a) => a + 0x28800; // Disk.1 file offset of game-image address a (disk1-disassembly-howto)
    const hex = (a, n) => Buffer.from(disk1.subarray(at(a), at(a) + n)).toString("hex");
    check("trace: the VBL wait is on entry only: $5900 bclr #0, $5908 beq $5900", hex(0x5900, 8) === "08b90000000156a8" && hex(0x5908, 2) === "67f6");
    check("trace: the repeat poll $590A is bsr $50B2, and the no-event branch $590E returns to it", hex(0x590a, 6) === "6100f7a66bfa");
    check("trace: a press over a button returns to the poll with no VBL wait (bra $590a at $5946)", hex(0x5946, 2) === "60c2");
    const window = disk1.subarray(at(0x590a), at(0x5946));
    check("trace: no $156A8 bit-0 operation between the poll and the press branch", !Buffer.from(window).includes(Buffer.from("08b90000000156a8", "hex")) && !Buffer.from(window).includes(Buffer.from("08390000000156a8", "hex")));
    check("trace: $5756 tests bit 4 of $156A8 and takes the one-buffer path when it is set", hex(0x579a, 8) === "08390004000156a8" && hex(0x57a2, 2) === "6704");
    check("trace: $B680 (F-key handler entry) sets bit 4 of $156A8", hex(0xb680, 8) === "08f90004000156a8");
  }
  {
    // Any button leaves, not only the exit: button 0 (blank) as the first.
    const { ctx } = fresh(() => {});
    const scene = createScreen("f5", ctx);
    frame(scene);
    check("f5 report: button 0 leaves on its release", press(scene, 0) === "running" && releaseAt(scene, buttonAt(0)) === "close");
  }

  // -- council-room reports (`$B99C` with bit 5 of $156A8 set): `$2E48` waits for a left click; Escape and the right button do not leave.
  {
    let sounds = 0;
    const { ctx } = fresh(() => sounds++);
    const report = createScreen("f3", ctx);
    report.setCouncilMode();
    check("council report: the first frame with the button up waits for a press", frame(report) === "running");
    check("council report: Escape and a right press do not leave", escape(report) === "running" && frame(report, { right: true }) === "running");
    check("council report: a press over the button column does not leave and is silent (no button column)", press(report, 9) === "running" && sounds === 0);
    check("council report: the release of that click leaves", releaseAt(report, buttonAt(9)) === "close");
  }
  {
    // The room opens a report on its own release (council.ts), so the button is up when the report starts: the wait is a
    // press and then its release, as `$2E48` does. A button already held when the report opens counts as that press.
    const { ctx } = fresh(() => {});
    const report = createScreen("f2", ctx);
    report.setCouncilMode();
    check("council report opened after a release: an idle frame waits", frame(report) === "running");
    check("council report: a press alone does not leave", frame(report, { left: true }) === "running");
    check("council report: its release leaves", frame(report) === "close");
    const held = createScreen("f2", fresh(() => {}).ctx);
    held.setCouncilMode();
    check("council report: a button held at its start is the press, so its release leaves", frame(held, { left: true }) === "running" && frame(held) === "close");
  }

  // -- trade ($CC8E): buttons 0-7 inactive, 8 opens the market, 9 leaves; a click off the buttons on a retain row opens the entry.
  {
    let sounds = 0;
    const { state, ctx } = fresh(() => sounds++);
    const scene = createScreen("trade", ctx);
    frame(scene);
    check("trade: Escape does nothing", escape(scene) === "running");
    check("trade: a right press alone does nothing and is silent", frame(scene, { right: true, at: buttonAt(9) }) === "running" && sounds === 0);
    check("trade: inactive buttons 0-7 click and release without leaving", press(scene, 3) === "running" && releaseAt(scene, buttonAt(3)) === "running" && press(scene, 7) === "running" && releaseAt(scene, OFF) === "running");
    check("trade: a click on retain row 2 opens the entry; Escape does not cancel it", frame(scene, { left: true, at: { x: 100, y: 54 + 9 * 2 + 3 } }) === "running" && releaseAt(scene, OFF) === "running" && scene.entry !== null && escape(scene) === "running" && scene.entry !== null);
    check("trade: a right press while the entry is open does nothing", frame(scene, { right: true, at: buttonAt(9) }) === "running" && scene.entry !== null);
    scene.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: ["5", "Enter"] });
    check("trade: the typed retain percentage is stored in row 2 and the entry closes", scene.entry === null && state.long(A.retainPercent + 8) === 5);
  }
  {
    const { state, ctx } = fresh(() => {});
    marketReady(state);
    const scene = createScreen("trade", ctx);
    frame(scene);
    check("trade: button 8 opens the market (the trade window hands over)", press(scene, 8) === "running" && releaseAt(scene, buttonAt(8)) === "running" && scene.child instanceof MarketScreen);
    check("trade: Escape in the market does nothing", escape(scene) === "running" && scene.child !== null);
    check("trade: the market's exit (9) closes the trade window too", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
  }
  {
    const { ctx } = fresh(() => {});
    const scene = createScreen("trade", ctx);
    frame(scene);
    check("trade: button 9 leaves on its release", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
  }

  // -- market ($D106): sell 0, buy 1, select 2-7, dump 8, exit 9; the result hold ignores the mouse for 76 frames.
  {
    let sounds = 0;
    const { state, ctx } = fresh(() => sounds++);
    marketReady(state);
    const scene = createScreen("market", ctx);
    check("market: opens when no refusal applies", scene instanceof MarketScreen);
    frame(scene);
    check("market: Escape does nothing", escape(scene) === "running");
    check("market: a right press alone does nothing and is silent", frame(scene, { right: true, at: buttonAt(9) }) === "running" && sounds === 0);
    check("market: selecting item 0 (button 2) leaves nothing", press(scene, 2) === "running" && releaseAt(scene, buttonAt(2)) === "running" && scene.selected === 0);
    state.setLong(TRADE.supply, 0); // item 0 has no supply: buy is refused and held
    check("market: buy with no supply is refused and holds the window", press(scene, 1) === "running" && releaseAt(scene, buttonAt(1)) === "running" && scene.wait > 0);
    check("market: during the hold the exit press does nothing", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "running");
    for (let i = 0; i < 80; i++) frame(scene);
    check("market: after the hold the exit button leaves", scene.wait === 0 && press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
  }
  {
    const { state, ctx } = fresh(() => {});
    marketReady(state);
    state.setLong(TRADE.supply, 10); // buy can take 10 units: the quantity entry opens
    state.setLong(TRADE.fuelCopy, 0);
    const scene = createScreen("market", ctx);
    frame(scene);
    press(scene, 2);
    releaseAt(scene, buttonAt(2));
    press(scene, 1);
    releaseAt(scene, buttonAt(1));
    check("market: buy opens its quantity entry", scene.entry !== null);
    check("market: Escape does not cancel the entry and a right press does not leave", escape(scene) === "running" && frame(scene, { right: true, at: buttonAt(9) }) === "running" && scene.entry !== null);
    scene.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: ["0", "Enter"] });
    check("market: the entry ends on Return", scene.entry === null);
  }

  // -- staffing ($BAAE): only the exit button (9) leaves; a click on a row (not a button) asks for the level of that pool.
  {
    let sounds = 0;
    const { state, ctx } = fresh(() => sounds++);
    const scene = createScreen("staff", ctx);
    frame(scene);
    check("staffing: Escape does nothing", escape(scene) === "running");
    check("staffing: a right press alone does nothing", frame(scene, { right: true, at: buttonAt(9) }) === "running" && sounds === 0);
    check("staffing: buttons 0, 3 and 8 release without leaving", [0, 3, 8].every((i) => press(scene, i) === "running" && releaseAt(scene, buttonAt(i)) === "running"));
    check("staffing: a click on row 0 opens its entry; Escape keeps it open", frame(scene, { left: true, at: { x: 100, y: 43 } }) === "running" && releaseAt(scene, OFF) === "running" && scene.entry !== null && escape(scene) === "running" && scene.entry !== null);
    scene.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: ["5", "Enter"] });
    check("staffing: the typed level is stored for pool 0 and the entry closes", scene.entry === null && state.long(STAFF.cap) === 5);
    check("staffing: the spacer row (6) opens nothing", frame(scene, { left: true, at: { x: 100, y: 40 + 9 * 6 + 3 } }) === "running" && releaseAt(scene, OFF) === "running" && scene.entry === null);
    check("staffing: the exit button leaves on its release", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
  }

  // -- intelligence ($E2D2): buttons 0-7 inactive, 8 and 9 leave; a click in the grant band (y 29-37) opens the entry.
  {
    let sounds = 0;
    const { ctx } = fresh(() => sounds++);
    const scene = createScreen("intel", ctx);
    frame(scene);
    check("intelligence: Escape does nothing", escape(scene) === "running");
    check("intelligence: a right press alone does nothing", frame(scene, { right: true, at: buttonAt(8) }) === "running" && sounds === 0);
    check("intelligence: buttons 0 and 7 release without leaving", press(scene, 0) === "running" && releaseAt(scene, buttonAt(0)) === "running" && press(scene, 7) === "running" && releaseAt(scene, OFF) === "running");
    check("intelligence: a click on the grant band opens the entry; Escape keeps it", frame(scene, { left: true, at: { x: 100, y: 0x1d + 3 } }) === "running" && releaseAt(scene, OFF) === "running" && scene.entry !== null && escape(scene) === "running" && scene.entry !== null);
    check("intelligence: while the entry is open a press on button 9 is ignored", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "running" && scene.entry !== null);
    scene.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: ["1", "Enter"] });
    check("intelligence: the entry ends on Return", scene.entry === null);
    check("intelligence: button 8 leaves on its release", press(scene, 8) === "running" && releaseAt(scene, buttonAt(8)) === "close");
  }
  {
    const { ctx } = fresh(() => {});
    const scene = createScreen("intel", ctx);
    frame(scene);
    check("intelligence: a click outside the grant band (y 40) opens nothing", frame(scene, { left: true, at: { x: 100, y: 40 } }) === "running" && releaseAt(scene, OFF) === "running" && scene.entry === null);
    check("intelligence: button 9 leaves on its release", press(scene, 9) === "running" && releaseAt(scene, buttonAt(9)) === "close");
  }
  check("intelligence: StaffingScreen, IntelScreen and TradeScreen are the classes behind their windows", createScreen("staff", fresh(() => {}).ctx) instanceof StaffingScreen && createScreen("intel", fresh(() => {}).ctx) instanceof IntelScreen && createScreen("trade", fresh(() => {}).ctx) instanceof TradeScreen);
}

if (failed > 0) {
  console.log(`${failed} window-input check(s) FAILED`);
  process.exit(1);
}
console.log("window-input checks passed");
