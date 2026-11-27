// Strict input of the order windows and of the number entry, and the build menu's right button (remake behaviour as traced
// in Disk.1; notes/formats/ship-control.md section 6, screens.md section 1, building.md step 3). Run after `npm run build`.
//
// Static trace (2026-11-10): the ship loop `$DCDC` and the tank loop `$C6EC` poll the mouse only through `$50B2` and never
// read a key; the build-menu loop `$B3D8` polls the same way and its right-button branches are section 4. The count entry `$5110` accepts digits, Backspace (raw `$41`),
// and Return / keypad Enter (`$44` / `$43`, with a digit) and nothing else, so Escape and Delete are ignored. These checks
// test the remake's port of those branches with synthetic input. They are not an emulator comparison.
//
// Needs the user's own Disk.1 and Disk.2 in original/utopia-whdload; skipped when they are missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("order-input tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");
const { Ui, NumberEntry } = await import("../dist/game/screens/ui.js");
const { createOrderScreen } = await import("../dist/game/screens/orders.js");
const { Builder } = await import("../dist/game/build.js");
const { Controls } = await import("../dist/game/controls.js");
const { Screen } = await import("../dist/gfx/screen.js");

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

const FRONT_KNOWN = 0x13ee6; // bit 7: the first alien report has come in (button 5 is live)
const BUTTON_EXIT = 9;
const BUTTON_FRONT = 5;
const BUTTON_STOP = 8;
const BUTTON_HOVER = 6;
const TANK_RECTS = 0xee1e;

function fresh() {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  world.objects.fill(0);
  world.objectCount = 0;
  state.setWord(0x142c2, 0);
  const sim = new Sim(world, { rng: createRng(1) });
  const ctx = { disk: disk1, world, sim, strings, say: () => {} };
  return { state, world, ctx };
}

// One frame of input. Scenes keep their own edge state, so a fresh scene is primed with an idle frame first.
const idle = () => ({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
function step(scene, patch = {}) {
  return scene.update({ ...idle(), ...patch, keys: [...(patch.keys ?? [])] });
}
function prime(scene) {
  step(scene);
  return scene;
}
function clickAt(scene, x, y) {
  step(scene, { leftButton: true, pointerX: x, pointerY: y });
  return step(scene, { pointerX: x, pointerY: y });
}
const clickButton = (scene, index) => {
  const { x, y } = ui.buttonPosition(index);
  return clickAt(scene, x + 4, y + 4);
};
const rightClick = (scene) => {
  step(scene, { rightButton: true });
  return step(scene, {});
};
const typeKeys = (scene, keys) => step(scene, { keys });

// ---- 1. the number entry itself (port of $5110) ---------------------------------------------------------------------
{
  const e = new NumberEntry(0, 0, 2, 4);
  e.feed(["Escape"]);
  check("entry: Escape is not a key of the entry (no cancel, nothing typed)", e.done === null && e.digits === "");
  e.feed(["1", "Escape", "2", "Enter"]);
  check("entry: Escape between digits is dropped and Enter confirms 12", e.done === 12);

  const d = new NumberEntry(0, 0, 3, 4);
  d.feed(["5", "Delete"]);
  check("entry: Delete is not a key of the entry (the digit stays)", d.digits === "5" && d.done === null);
  d.feed(["Backspace"]);
  check("entry: Backspace deletes the last digit", d.digits === "");

  const full = new NumberEntry(0, 0, 2, 4);
  full.feed(["1", "2", "3"]);
  check("entry: a third digit is ignored at the two-digit limit", full.digits === "12");

  const empty = new NumberEntry(0, 0, 2, 4);
  empty.feed(["Enter"]);
  check("entry: Enter with no digit does nothing ($51B8 needs one digit)", empty.done === null);
  empty.feed(["0", "Enter"]);
  check("entry: zero typed and confirmed is a value (the window then does nothing for N = 0)", empty.done === 0);
}

// ---- 2. the ship window ($DA94): no Escape or right-button close; the exit button closes and sends the order -----------
{
  const { state, world, ctx } = fresh();
  state.setByte(FRONT_KNOWN, 0x00);
  const sent = [];
  const enemies = { padPending: () => false, commandShip: (_ship, cmd) => (sent.push(cmd), null) };
  const shipCtx = { ...ctx, objects: { units: { units: [], order() {} }, enemies, markerCell: () => null } };
  const ship = { mode: 0, cls: 0, tech: 0, hp: 0, fuel: 100, x: 0, y: 0 };

  const window = prime(createOrderScreen(shipCtx, { kind: "ship", ship }));
  check("ship window opens", window !== null);
  check("ship window: Escape does not close it", typeKeys(window, ["Escape"]) === "running");
  check("ship window: a right click does not close it", rightClick(window) === "running");
  check("ship window: Escape and right click repeated still leave it open", typeKeys(window, ["Escape"]) === "running" && rightClick(window) === "running");
  check("ship window: a hover order does not close it on its own", clickButton(window, BUTTON_HOVER) === "running");
  check("ship window: Escape after an order change still does not close", typeKeys(window, ["Escape"]) === "running");
  check("ship window: the exit button closes it", clickButton(window, BUTTON_EXIT) === "close");
  check("ship window: the exit button applies the chosen order (hover = 1)", sent.at(-1) === 1, `sent ${sent}`);
}

// ---- 3. the tank window ($C5BE): no Escape / right close; the count entry is modal and only Return ends it ---------------
{
  const { state, world, ctx } = fresh();
  state.setByte(FRONT_KNOWN, 0x80);
  const unit = { x: 33, y: 20, tech: 0, hp: 0 };
  const orders = [];
  const objects = { units: { units: [unit], order: (u, x, y) => orders.push([x, y]) }, enemies: null, markerCell: () => null };
  const tankCtx = { ...ctx, objects };

  const tank = prime(createOrderScreen(tankCtx, { kind: "tank", unit }));
  check("tank window opens", tank !== null);
  check("tank window: Escape does not close it", typeKeys(tank, ["Escape"]) === "running");
  check("tank window: a right click does not close it", rightClick(tank) === "running");

  // Front (button 5) asks for a count: the number entry is open.
  clickButton(tank, BUTTON_FRONT);
  check("tank window: the front order opens the count entry", tank.entry !== null);
  check("tank window: Escape does not cancel the count entry", typeKeys(tank, ["Escape"]) === "running" && tank.entry !== null);
  check("tank window: Delete does not change the count entry", (typeKeys(tank, ["3", "Delete"]), tank.entry.digits === "3"));
  check("tank window: the exit button does nothing while the count is open", clickButton(tank, BUTTON_EXIT) === "running" && tank.entry !== null);
  check("tank window: a right click does nothing while the count is open", rightClick(tank) === "running" && tank.entry !== null);
  typeKeys(tank, ["Backspace", "Enter"]);
  check("tank window: Enter with no digit does not end the count", tank.entry !== null && tank.entry.digits === "");
  typeKeys(tank, ["4", "9", "9", "Enter"]);
  check("tank window: Return ends the count, typed digits cap at two (49)", tank.entry === null && tank.count === 49, `count ${tank.count}`);
  check("tank window: after the count, Escape still leaves the window open", typeKeys(tank, ["Escape"]) === "running");
  check("tank window: the exit button closes it", clickButton(tank, BUTTON_EXIT) === "close");

  // Stop (button 8) closes the window as it always did; a zero count is a value that orders nothing.
  const again = prime(createOrderScreen(tankCtx, { kind: "tank", unit }));
  clickButton(again, BUTTON_FRONT);
  typeKeys(again, ["0", "Enter"]);
  check("tank window: a typed zero is a count and the window stays open for the exit", again.entry === null && again.count === 0 && typeKeys(again, ["Escape"]) === "running");
  const ordersBefore = orders.length;
  check("tank window: a zero count front order sends nothing", clickButton(again, BUTTON_EXIT) === "close" && orders.length === ordersBefore);
  const stopper = prime(createOrderScreen(tankCtx, { kind: "tank", unit }));
  check("tank window: stop (button 8) still closes the window", clickButton(stopper, BUTTON_STOP) === "close");
}

// ---- 4. the build menu ($B3D8): one $50B2 pass per video update, the original's branches ----------------------------------
// Static trace of Disk.1 (no emulator run). The left bit after each poll event picks the branch ($B3E8): left held is a press
// at the pointer ($B41A), which a right press also makes while the left stays down; left up is the release branch ($B3F2),
// which acts only on a pending command button ($5DD4 >= 0, which $57FA clears). $5756 requests id 4 (the click) and flips the
// button image on every press, a repeated press included; $57FA flips the image back. Item presses never touch $5DD4.
function menuRig() {
  const rec = records[0];
  const world = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
  const builder = new Builder(world, readFlagTable(disk1), readWeights(disk1), () => {});
  const controls = new Controls(disk1, world, builder, new GameStrings(disk1, 0), () => {}, () => ({ x: 47, y: 33 }));
  const rig = { controls, clicks: 0 };
  controls.onClick = () => {
    rig.clicks++;
  };
  rig.update = (leftButton, rightButton, x, y) => controls.update({ leftButton, rightButton, pointerX: x, pointerY: y, keys: [] });
  return rig;
}
function openMenu() {
  const rig = menuRig();
  rig.update(true, false, 272, 63); // build command: the menu opens on the release
  rig.update(false, false, 272, 63);
  rig.clicks = 0;
  return rig;
}
const screenOf = (rig) => {
  const screen = new Screen();
  rig.controls.draw(screen);
  return screen;
};
// The 16 x 16 rectangle of command button 8 (page) and 9 (exit) in the menu column.
const PAGE_BOX = { x0: 296, x1: 311, y0: 139, y1: 154 };
// "flipped": every pixel of the box is the idle pixel XOR 8 (plane 3); "same": no change in the box.
function boxState(now, idle, box) {
  let flipped = true;
  let same = true;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const at = y * 320 + x;
    if (now.pixels[at] !== (idle.pixels[at] ^ 8)) flipped = false;
    if (now.pixels[at] !== idle.pixels[at]) same = false;
  }
  return flipped && !same ? "flipped" : same ? "same" : "other";
}

{
  // A right press alone ($50B2 event with the left up): the release branch, nothing pending, so nothing happens. This is
  // also true over the exit button, the page button and an item.
  const rig = openMenu();
  const before = JSON.stringify(rig.controls.menuState);
  rig.update(false, true, 272, 139); // right over exit
  rig.update(false, true, 296, 139); // right over page, still held: no second event
  rig.update(false, true, 30, 60); // right over an item
  rig.update(false, false, 30, 60);
  check("build menu: a right press alone does nothing (menu open, no sound, no mode change)", rig.controls.menuVisible && rig.clicks === 0 && rig.controls.mode === "select");
  check("build menu: a right press alone selects no item and flips no button", JSON.stringify(rig.controls.menuState) === before);
  rig.update(true, false, 296, 139);
  rig.update(false, false, 296, 139);
  check("build menu: the page button still works after the right press (one click, one page)", rig.controls.menuState.page === 1 && rig.clicks === 1);
}

{
  // Left press, then the right button goes down while the left is held: the second event is a press again at the same
  // pointer. The page button is pressed twice ($5756 twice: two clicks, the image flipped back); the release dispatches
  // once and leaves the XOR state of the two flips (the image stays inverted, $57FA flips once).
  const rig = openMenu();
  const idle = screenOf(rig);
  rig.update(true, false, 296, 139);
  rig.update(true, true, 296, 139);
  const heldBoth = rig.controls.menuState;
  rig.update(true, true, 296, 139); // held: no further event
  rig.update(true, false, 296, 139); // right released while the left is held: no event
  check("build menu: a right press while the left is held is a second press at the pointer (two clicks, image back to plain)", rig.clicks === 2 && heldBoth.flipped.length === 0 && boxState(screenOf(rig), idle, PAGE_BOX) === "same");
  rig.update(false, false, 296, 139);
  check("build menu: the release dispatches the page button exactly once (page 1, not 2)", rig.controls.menuState.page === 1 && rig.controls.menuVisible);
  check("build menu: the repeated press leaves the page image inverted after the release ($57FA flips once)", JSON.stringify(rig.controls.menuState.flipped) === "[8]" && boxState(screenOf(rig), idle, PAGE_BOX) === "flipped");
  rig.update(false, true, 272, 139);
  rig.update(false, false, 272, 139);
  check("build menu: afterwards a right press alone neither advances the page nor exits", rig.controls.menuState.page === 1 && rig.controls.menuVisible && rig.clicks === 2);
}

{
  // The right button already down, then the left press: one frame carries the left press and the right re-press (two events).
  const rig = openMenu();
  const idle = screenOf(rig);
  rig.update(false, true, 296, 139); // right alone: nothing
  rig.update(true, true, 296, 139); // left press with the right already held
  check("build menu: a left press with the right already held gives two presses (two clicks), the image is back to plain", rig.clicks === 2 && rig.controls.menuState.page === 0 && JSON.stringify(rig.controls.menuState.flipped) === "[]");
  rig.update(false, false, 296, 139);
  check("build menu: that release advances the page once and leaves the image inverted", rig.controls.menuState.page === 1 && boxState(screenOf(rig), idle, PAGE_BOX) === "flipped");
}

{
  // A single press and release: one click, one dispatch, no residue.
  const rig = openMenu();
  const idle = screenOf(rig);
  rig.update(true, false, 296, 139);
  check("build menu: a press on the page button flips it while held", JSON.stringify(rig.controls.menuState.flipped) === "[8]" && boxState(screenOf(rig), idle, PAGE_BOX) === "flipped");
  rig.update(false, false, 296, 139);
  check("build menu: a single press and release leaves no inverted button and one click", rig.clicks === 1 && JSON.stringify(rig.controls.menuState.flipped) === "[]" && rig.controls.menuState.page === 1);
}

{
  // Left press on one item, right press on another while the left is held: the last press wins, exactly as a single click on
  // that second item; the release adds nothing.
  const a = openMenu();
  a.update(true, false, 30, 60);
  a.update(false, false, 30, 60);
  a.update(true, false, 60, 60);
  a.update(true, true, 60, 60);
  a.update(false, false, 60, 60);
  const b = openMenu();
  b.update(true, false, 60, 60);
  b.update(false, false, 60, 60);
  check("build menu: a right press on a second item while the left is held selects it (as a single click does)", a.controls.menuState.pending?.tile === 1 && JSON.stringify(a.controls.menuState) === JSON.stringify(b.controls.menuState));
  check("build menu: the release of that press adds no item click and no sound", a.controls.menuVisible && a.clicks === 0);
  const same = openMenu();
  same.update(true, false, 30, 60);
  same.update(true, true, 30, 60);
  same.update(false, false, 30, 60);
  const once = openMenu();
  once.update(true, false, 30, 60);
  once.update(false, false, 30, 60);
  check("build menu: a right re-press on the same item selects the same item once (no double selection)", JSON.stringify(same.controls.menuState) === JSON.stringify(once.controls.menuState));
}

{
  // Release with the right button still down: one dispatch (page), then the right button is a release-branch event with nothing
  // pending: no second dispatch.
  const rig = openMenu();
  rig.update(true, false, 296, 139);
  rig.update(false, true, 20, 20);
  rig.update(false, true, 20, 20);
  rig.update(false, false, 20, 20);
  check("build menu: a release with the right still held dispatches once and the held right adds nothing", rig.controls.menuState.page === 1 && rig.clicks === 1 && rig.controls.menuVisible);
}

{
  // Exit with the right button still held. The exit release clears the right bit ($50D0), so the map's next pass sees the
  // still-held right button as a new press, and build mode ends through $15F44 (`Controls.update` right-click branch).
  const rig = openMenu();
  rig.update(true, false, 30, 60);
  rig.update(false, false, 30, 60);
  rig.update(true, false, 272, 139);
  rig.update(false, true, 272, 139);
  check("build menu: exit with the right held closes the menu and commits the pending item", rig.controls.menuVisible === false && rig.controls.mode === "build");
  rig.update(false, true, 272, 139);
  check("build menu: the map's next pass takes the still-held right button as a right click (leaves build mode)", rig.controls.mode === "select" && rig.controls.selection === null);
}

{
  // The exit button still closes the menu when nothing is pending, and a plain exit selects nothing.
  const rig = openMenu();
  rig.update(true, false, 272, 139);
  rig.update(false, false, 272, 139);
  check("build menu: the exit button closes it (nothing pending: select mode)", rig.controls.menuVisible === false && rig.controls.mode === "select");
}

{
  // Left press and right press in the same video update, both new (from idle). $50DC/$50D0 report the left press first and
  // clear the right bit, so the next $50B2 call reports the right press at the same pointer: two presses in one pass.
  const rig = openMenu();
  const idle = screenOf(rig);
  rig.update(true, true, 296, 139);
  check("build menu: a simultaneous left and right press from idle is two presses (two clicks, image plain while both are held)", rig.clicks === 2 && rig.controls.menuState.page === 0 && JSON.stringify(rig.controls.menuState.flipped) === "[]");
  rig.update(false, false, 296, 139);
  check("build menu: the release after a simultaneous press dispatches the page button once (page 1, image inverted)", rig.controls.menuState.page === 1 && rig.controls.menuVisible && boxState(screenOf(rig), idle, PAGE_BOX) === "flipped");
}

{
  // Left release and right press in the same video update (left held on the page button, right goes down as it lets go).
  // The release event dispatches the page once ($B3F2 branch); the right press that follows is a release-branch event with
  // nothing pending ($5DD4 cleared by $57FA), so it adds nothing. A held right button then stays quiet.
  const rig = openMenu();
  rig.update(true, false, 296, 139);
  rig.update(false, true, 296, 139);
  check("build menu: a left release with a right press in the same update dispatches the page once and the right press adds nothing", rig.controls.menuState.page === 1 && rig.clicks === 1 && rig.controls.menuVisible && JSON.stringify(rig.controls.menuState.flipped) === "[]");
  rig.update(false, true, 296, 139);
  rig.update(false, false, 296, 139);
  check("build menu: after that update the held and then released right button add no page or exit", rig.controls.menuState.page === 1 && rig.clicks === 1 && rig.controls.menuVisible);
}

if (failed > 0) {
  console.log(`${failed} order-input check(s) FAILED`);
  process.exit(1);
}
console.log("order-input checks passed");
