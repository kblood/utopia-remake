// Headless checks of the shared order byte $F173 (src/game/screens/order-byte.ts) across the windows that write it:
// the ship window ($DA94), the tank window ($C5BE), the tank teleporter ($CAAE) and the ship yard ($D7D6, whose
// launch $D8DE reads the byte). Run after `npm run build`. Needs the user's own Disk.1 and Disk.2 in
// original/utopia-whdload; skipped when they are missing.
//
// Static trace (2026-11-10, see notes/formats/building-screens.md 3.7 and ship-control.md 2): every byte write of $F173 in
// Disk.1 is listed in order-byte.ts; nothing here claims emulator parity.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("order-byte tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { Ui } = await import("../dist/game/screens/ui.js");
const { UnitSystem } = await import("../dist/game/units.js");
const { createBuildingScreen } = await import("../dist/game/screens/buildings.js");
const { createOrderScreen } = await import("../dist/game/screens/orders.js");
const { readOrderByte, writeOrderByte } = await import("../dist/game/screens/order-byte.js");

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

const W = 100;
const OCCUPIED = 0x4000;
const TILE_YARD = 0x36;
const TILE_TELEPORT = 0x47;
const TYPE_COMMAND_CENTRE = 29;
const TYPE_SHIP_YARD = 27;
const INVENTION = 0x14472;
const WORK_TABLE = 0xf012; // $F012 word table {50, 100, 180, 240, 80, 50}
const PIN_RECTS_TELE = 0xee1e;

// A world with an empty object list (the same staging as test/buildings.mjs).
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

const primed = new WeakSet();
const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
function click(scene, x, y) {
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
const clickButton = (scene, index) => {
  const { x, y } = ui.buttonPosition(index);
  return click(scene, x + 4, y + 4);
};
const yardRect = (k) => ({ x: ui.image.word(0xefe0 + 8 * k) + 8, y: ui.image.word(0xefe0 + 8 * k + 4) + 8 });
const workOf = (k) => ui.image.word(WORK_TABLE + 2 * k);
const clearYard = (world, at) => {
  world.objects[at + 6] = 0;
  world.objects[at + 7] = 0;
};

// Sets up a ship yard at (37, 20) with an active command centre and staff, and no fifth type.
function stageYard(world, state) {
  const at = plant(world, TILE_YARD, 37, 20);
  world.state.setWord(world.typeAddress(TYPE_COMMAND_CENTRE) + 0xc, 1);
  world.state.setWord(world.typeAddress(TYPE_SHIP_YARD) + 0xc, 1);
  state.setLong(INVENTION, 0);
  return at;
}

// ---- 1. the ship yard alone: unknown, reopened, and a later unlock ----------------------------------------------------
{
  const { world, state, ctx } = fresh();
  const at = stageYard(world, state);
  check("order byte starts unknown in a new world", readOrderByte(world) === null);

  // A locked click (fifth type, index 4) with no earlier writer: the byte is unknown, so nothing is ordered.
  let scene = createBuildingScreen(ctx, 37, 20);
  click(scene, yardRect(4).x, yardRect(4).y);
  clickButton(scene, 8);
  check("unknown byte: a locked click orders nothing", world.objects[at + 6] === 0 && world.objects[at + 7] === 0);

  // An unlocked choice (index 1) writes its work value to the byte and orders type 2 with it.
  scene = createBuildingScreen(ctx, 37, 20);
  click(scene, yardRect(1).x, yardRect(1).y);
  check("an unlocked choice writes its table work value", readOrderByte(world) === workOf(1));
  check("the write does not order anything before the launch button", world.objects[at + 6] === 0);
  check("the unlocked choice closes with type 2 and its work value", clickButton(scene, 8) === "close" && world.objects[at + 6] === 2 && world.objects[at + 7] === workOf(1));

  // Reopened window ($F174 is reset, $F173 is kept): the locked click orders type 5 with the stale work value.
  clearYard(world, at);
  scene = createBuildingScreen(ctx, 37, 20);
  click(scene, yardRect(4).x, yardRect(4).y);
  check("reopened: the byte still holds the earlier choice", readOrderByte(world) === workOf(1));
  check("reopened: a locked click is ordered with the earlier unlocked work value", clickButton(scene, 8) === "close" && world.objects[at + 6] === 5 && world.objects[at + 7] === workOf(1));

  // A reopened window that makes a locked click and then an unlocked one: the launch uses the newest value.
  clearYard(world, at);
  scene = createBuildingScreen(ctx, 37, 20);
  click(scene, yardRect(0).x, yardRect(0).y);
  click(scene, yardRect(4).x, yardRect(4).y);
  click(scene, yardRect(2).x, yardRect(2).y);
  check("reopened: the last unlocked choice replaces the byte, and the last press decides the type", clickButton(scene, 8) === "close" && world.objects[at + 6] === 3 && world.objects[at + 7] === workOf(2));

  // Leaving with exit (9) writes nothing and orders nothing, even after a choice.
  clearYard(world, at);
  scene = createBuildingScreen(ctx, 37, 20);
  click(scene, yardRect(3).x, yardRect(3).y);
  const before = readOrderByte(world);
  check("exit keeps the byte as the choice left it and orders nothing", clickButton(scene, 9) === "close" && readOrderByte(world) === workOf(3) && world.objects[at + 6] === 0 && before === workOf(3));
}

// ---- 2. a native save: the byte is session RAM and a loaded world starts unknown -------------------------------------
{
  const { world, state, ctx } = fresh();
  const at = stageYard(world, state);
  const scene = createBuildingScreen(ctx, 37, 20);
  click(scene, yardRect(1).x, yardRect(1).y);
  clickButton(scene, 8);
  check("native save: the byte was written before the save", readOrderByte(world) === workOf(1));
  const loadedState = GameState.fromSnapshot(state.snapshot()).value;
  const loaded = World.fromSnapshot(loadedState, { cells: world.cells.slice(), cellFlags: world.cellFlags.slice(), objects: world.objects.slice() }).value;
  check("native save: a loaded world starts with the byte unknown", readOrderByte(loaded) === null);
  const loadedCtx = { ...ctx, world: loaded };
  clearYard(loaded, at);
  const again = createBuildingScreen(loadedCtx, 37, 20);
  click(again, yardRect(4).x, yardRect(4).y);
  check("native save: a locked click after a load orders nothing", clickButton(again, 8) === "close" && loaded.objects[at + 6] === 0);
}

// ---- 3. the tank teleporter: each button event sets $FF; button 8 copies the selected pin ----------------------------
{
  const { world, state, ctx } = fresh();
  const at = stageYard(world, state);
  state.setByte(0x144c8, 0); // power
  plant(world, TILE_TELEPORT, 33, 20);
  const units = new UnitSystem(world.cells);
  const pins = Array.from({ length: 8 }, () => null);
  const hooks = { units, pin: (n) => pins[n] };
  units.spawn(9, 33, 20);

  // Exit (9) without a pin: $FF. A yard reading it then orders its locked type with work $FF.
  let scene = createBuildingScreen(ctx, 33, 20, hooks);
  writeOrderByte(world, 0x42); // a value from an earlier window, overwritten by the teleporter
  check("teleporter: exit without a pin writes $FF", clickButton(scene, 9) === "close" && readOrderByte(world) === 0xff);
  clearYard(world, at);
  scene = createBuildingScreen(ctx, 37, 20);
  click(scene, yardRect(4).x, yardRect(4).y);
  check("the yard then orders the locked type with the $FF work value", clickButton(scene, 8) === "close" && world.objects[at + 6] === 5 && world.objects[at + 7] === 0xff);

  // Button 8 with a pin chosen writes the pin number.
  pins[2] = { x: 60, y: 30 };
  pins[4] = { x: 62, y: 32 };
  world.cells[30 * W + 60] &= ~0x7400;
  world.cells[32 * W + 62] &= ~0x7400;
  scene = createBuildingScreen(ctx, 33, 20, hooks);
  click(scene, ui.image.word(PIN_RECTS_TELE + 8 * 2) + 8, ui.image.word(PIN_RECTS_TELE + 8 * 2 + 4) + 10);
  check("teleporter: a pin chosen and confirmed writes the pin number", clickButton(scene, 8) === "close" && readOrderByte(world) === 2);
  check("teleporter: the same window's order moved the tank to the pin", units.units[0].x === 60 && units.units[0].y === 30);

  // Button 8 without a pin writes $FF (the selected pin $F172 is $FF).
  writeOrderByte(world, 0x10);
  units.units[0].x = 33;
  units.units[0].y = 20;
  world.cells[20 * W + 33] |= OCCUPIED;
  scene = createBuildingScreen(ctx, 33, 20, hooks);
  check("teleporter: confirming without a pin writes $FF", clickButton(scene, 8) === "close" && readOrderByte(world) === 0xff);
}

// ---- 4. the ship window: the mode at open, changes, and the refused window ----------------------------------------
{
  const { world, ctx } = fresh();
  const ships = [];
  const enemies = {
    padPending: () => false,
    commandShip: (ship, cmd) => {
      ships.push(cmd);
      return null;
    },
  };
  const objects = { units: { units: [] }, enemies, markerCell: () => null };
  const shipCtx = { ...ctx, objects };
  const ship = { mode: 6, cls: 0, tech: 0, hp: 0, fuel: 100, x: 0, y: 0 };

  // A refused window ($D6, +$11 == 4 in the original) still writes the mode first.
  const refusing = { ...shipCtx, objects: { ...objects, enemies: { ...enemies, padPending: () => true } } };
  writeOrderByte(world, 0x33);
  check("ship window refused for a pad: no window, and the mode is written first", createOrderScreen(refusing, { kind: "ship", ship }) === null && readOrderByte(world) === 6);

  // An open window writes the mode ($DA98); exit without a change keeps it.
  writeOrderByte(world, 0x33);
  let window = createOrderScreen(shipCtx, { kind: "ship", ship });
  check("ship window opens with the ship's mode in the byte", window !== null && readOrderByte(world) === 6);
  // A mode above 4 is not an order (apply returns at once), so nothing is sent to the ship.
  check("ship window exit without a change keeps the mode and sends nothing", clickButton(window, 9) === "close" && readOrderByte(world) === 6 && ships.length === 0);

  // Hover (6) on a mode-6 ship: hover (1) is written, then land (7) makes land (0).
  window = createOrderScreen(shipCtx, { kind: "ship", ship: { ...ship, mode: 0 } });
  check("ship window: a fresh land order (mode 0) is in the byte", readOrderByte(world) === 0);
  clickButton(window, 6);
  check("ship window: hover writes 1", readOrderByte(world) === 1);
  clickButton(window, 7);
  check("ship window: land after hover writes 0", readOrderByte(world) === 0);
  clickButton(window, 6);
  check("ship window: hover again writes 1 before the exit", readOrderByte(world) === 1);
  check("ship window: exit closes with the order of the byte", clickButton(window, 9) === "close" && ships.at(-1) === 1 && readOrderByte(world) === 1);

  // Ship yard after a ship window: the locked launch uses the ship window's byte.
  const { state: yardState, world: yardWorld, ctx: yardCtx } = (() => {
    const f = fresh();
    return { state: f.state, world: f.world, ctx: f.ctx };
  })();
  const at = stageYard(yardWorld, yardState);
  writeOrderByte(yardWorld, 0);
  const shipWindow = createOrderScreen({ ...yardCtx, objects: { ...objects } }, { kind: "ship", ship: { ...ship, mode: 3 } });
  clickButton(shipWindow, 9);
  const yard = createBuildingScreen(yardCtx, 37, 20);
  click(yard, yardRect(4).x, yardRect(4).y);
  check("ship window (mode 3) then a locked yard click orders type 5 with work 3", clickButton(yard, 8) === "close" && yardWorld.objects[at + 6] === 5 && yardWorld.objects[at + 7] === 3);
}

// ---- 5. the tank window: opens with 0, a placed pin writes 9 --------------------------------------------------------
{
  const { world, ctx } = fresh();
  const pin = { x: 60, y: 30 };
  const orders = [];
  const unit = { x: 33, y: 20, tech: 0, hp: 0 };
  const objects = { units: { order: (u, x, y) => orders.push([x, y]) }, enemies: null, markerCell: (n) => (n === 1 ? pin : null) };
  const tankCtx = { ...ctx, objects };
  writeOrderByte(world, 0x77);
  const tank = createOrderScreen(tankCtx, { kind: "tank", unit });
  check("tank window opens and clears the byte to 0", tank !== null && readOrderByte(world) === 0);

  // Pin 1 is placed: its icon (rect 0) sets the single-pin order 9.
  const PIN_RECTS = 0xee1e;
  const centre = { pointerX: (ui.image.word(PIN_RECTS) + ui.image.word(PIN_RECTS + 2)) >> 1, pointerY: (ui.image.word(PIN_RECTS + 4) + ui.image.word(PIN_RECTS + 6)) >> 1 };
  click(tank, centre.pointerX, centre.pointerY);
  check("tank window: a placed pin writes 9", readOrderByte(world) === 9);
  check("tank window: exit orders the unit to the pin and keeps 9", clickButton(tank, 9) === "close" && orders.length === 1 && readOrderByte(world) === 9);

  // The next window opening clears the byte again, even when it is left at once.
  const again = createOrderScreen(tankCtx, { kind: "tank", unit });
  check("the next tank window clears the byte again", readOrderByte(world) === 0 && clickButton(again, 9) === "close");
}

if (failed > 0) {
  console.log(`${failed} order-byte check(s) FAILED`);
  process.exit(1);
}
console.log("order-byte checks passed");
