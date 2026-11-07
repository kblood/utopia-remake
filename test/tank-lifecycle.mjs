// Connected regression: tank yard production -> actual UnitSystem spawn -> marker-pin order -> movement and arrival.
// Run after `npm run build`.
//
// Everything below runs through the engine's own paths, with nothing stubbed:
//   - a real MapScene (its own Sim, Builder, ObjectLayer, UnitSystem and EnemySystem) is advanced with `update()`;
//     the monthly period bit is consumed by Sim.loopPass() -> run() -> monthly() -> tankYard() ($A620), whose
//     `spawnUnit` hook is the scene's own `ObjectLayer.units.spawnAtYard()` ($A6D2-$A756 + $37CA);
//   - the pin is placed with the scene's own marker button + cell click handlers (MarkerMode, $311E);
//   - the right-click pick (orders.ts pickObject) and the tank window (screens/orders.ts TankScreen) are driven with
//     synthetic pointer input: click the pin icon, click the exit button -> UnitSystem.order() ($C8B4);
//   - the unit then walks under the scene's own main-loop passes (UnitSystem.tick(), $333A / $38E2).
//
// Evidence level: the production, spawn-cell order, bookkeeping, order and step rules are static disassembly-backed
// ports documented in sim-port.md "Tank yard" and units.md sections 4/5. Section 5 below is a SYNTHETIC route regression
// (a four-cell route shaped like one observed Copperline run, on staged terrain); it is not an original comparison. The
// state-by-state comparison with the player's own external captures is test/tank-original-compare.mjs (optional,
// UTOPIA_TANK_TRACE_DIR). The connected one-month -> tank -> order -> arrival scenario below remains a remake-side staged regression;
// its original timing and production/resource sequence are not claimed as parity. The map area, the yard record and the stocks
// are hand-staged (like sim.mjs), the
// scene's random generator is its fixed default seed and none of the passes below changes the date.
// Uses the user's own Disk.1 / Disk.2 in original/utopia-whdload; skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("tank lifecycle tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap, loadTileSet, MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState, A, PERIOD } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");
const { UnitSystem, UNIT_BASIC, NO_TARGET, OCCUPIED, BLOCKED } = await import("../dist/game/units.js");
const { cellFlagIndex } = await import("../dist/game/cell-flags.js");
const { pickObject } = await import("../dist/game/orders.js");
const { createOrderScreen } = await import("../dist/game/screens/orders.js");
const { Ui } = await import("../dist/game/screens/ui.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const tiles = loadTileSet(disk1, disk2, record).tiles;
const sprites = loadSprites(disk1, disk2, record);
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

check("yard exit table matches the statically documented eight-cell order", UnitSystem.YARD_EXITS.map(([x, y]) => `${x},${y}`).join("|") === "0,-1|1,-1|-1,1|-1,0|1,0|1,1|0,1|-1,-1");

// Addresses (state image / game-state.md): see sim.ts V and the tank yard section of sim-port.md.
const V = {
  power: 0x144c8, // power level; the yard does nothing at >= 10
  commandCentre: 0x133f8, // active Command Centre word
  yardCount: 0x1337a, // T[22].C finished tank yards (job pool 4 requirement = count * 10)
  jobsPool4: 0x143fa, // staffing assigned to pool 4 ($143EA + 4 * 4)
  jobCapPool4: 0x14510, // the player's staffing choice for pool 4 ($14500 + 4 * 4): the monthly job pass fills up to it
  good1: 0x13156,
  good3: 0x1315e,
  tanks: 0x1429c,
  typeCount9: 0x14254,
  made: 0x143b6, // units counted by the yard this month
  invention: 0x14472,
};
const ACTIVE = 0x0400;
const AIR = 0x2000;
const TILE_YARD = 0x45;
const OWN_FLAG = 4; // per-cell flag byte bit 2
const SIDE = 14;

function freeArea(cells) {
  for (let y = 6; y < MAP_HEIGHT - SIDE - 6; y++) {
    for (let x = 6; x < MAP_WIDTH - SIDE - 6; x++) {
      let ok = true;
      for (let dy = 0; dy < SIDE && ok; dy++) {
        for (let dx = 0; dx < SIDE; dx++) {
          if (cells[(y + dy) * MAP_WIDTH + x + dx] & (BLOCKED | OCCUPIED | ACTIVE | AIR)) { ok = false; break; }
        }
      }
      if (ok) return { x, y };
    }
  }
  throw new Error("no free area");
}

const idle = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
const PASS = 4; // video updates per main-loop pass (MainLoop default)
const pass = (scene, n = 1) => { for (let i = 0; i < n * PASS; i++) scene.update(idle); };

// A scene with one staffed yard on a free map area. `exits` maps an exit index of UnitSystem.YARD_EXITS to true when
// that neighbour cell is blocked by a building flag. Returns handles and the yard cell.
function stage(blockedExits, progress = 0) {
  const state = new GameState(disk2, record.block);
  const world = new World(state, loadMap(disk2, record));
  const area = freeArea(world.cells);
  const bx = area.x + 4;
  const by = area.y + 4;
  const scene = new MapScene(disk1, tiles, world, strings, { sprites });
  const s = scene.world.state;
  // the yard: one finished record (tile $45) with its progress byte +6 and a blocked map cell
  const at = world.objectCount * 8;
  world.objects.set([0, TILE_YARD, 0, 0xff, bx, by, progress, 0], at);
  world.objectCount++;
  world.cells[by * MAP_WIDTH + bx] |= BLOCKED | TILE_YARD;
  for (const i of blockedExits) {
    const [ox, oy] = UnitSystem.YARD_EXITS[i];
    world.cells[(by + oy) * MAP_WIDTH + bx + ox] |= BLOCKED;
  }
  s.setWord(V.commandCentre, 1);
  s.setByte(V.power, 0);
  s.setWord(V.yardCount, 1);
  s.setLong(V.jobsPool4, 10); // 10 workers: +10 progress per month
  s.setLong(V.jobCapPool4, 10); // staffed to 10 in the staffing screen; without it the monthly job pass ($9F4A) releases the pool
  s.setLong(V.good1, 100);
  s.setLong(V.good3, 100);
  s.setByte(A.frameCountdown, 200); // no day change inside the staged passes
  s.setByte(A.pending, 0);
  const seen = [];
  const push = scene.sim.messages.push.bind(scene.sim.messages);
  scene.sim.messages.push = (...m) => (seen.push(...m), push(...m));
  const month = () => { s.setByte(A.pending, s.byte(A.pending) | PERIOD.monthly); pass(scene); };
  return { scene, world, state: s, bx, by, at, area, seen, month, units: scene.objects.units, cells: world.cells };
}

// ---- 1. production over two months -> spawn on the first free exit ----------------------------------------------------
const env = stage([0]); // exit 0 (0,-1) is blocked, so the first free exit in the documented order is exit 1 (+1,-1)
const { scene, world, state: s, bx, by, at, cells, units, area } = env;
{
  const date = s.dateText();
  const g1 = s.long(V.good1);
  const g3 = s.long(V.good3);
  check("stage: one yard, no tank yet, no units", units.units.length === 0 && s.word(V.tanks) === 0 && world.objects[at + 6] === 0);

  env.month();
  check("month 1: the yard takes 10 good 1 (progress 10), good 3 untouched, no tank", world.objects[at + 6] === 10 && s.long(V.good1) === g1 - 10 && s.long(V.good3) === g3 && units.units.length === 0 && s.word(V.tanks) === 0, `progress ${world.objects[at + 6]} good1 ${s.long(V.good1)}`);

  env.month();
  const unit = units.units[0];
  check("month 2: counter reached 20, 2 good 3 spent, record restarts at 0", world.objects[at + 6] === 0 && s.long(V.good1) === g1 - 20 && s.long(V.good3) === g3 - 2, `progress ${world.objects[at + 6]} good1 ${s.long(V.good1)} good3 ${s.long(V.good3)}`);
  check("month 2: exactly one real unit exists in slot 0 of the scene's own UnitSystem", units.units.length === 1 && !!unit && unit.slot === 0 && units.slots[0] === unit && scene.objects.units === units);
  // Literal expectation: this catches an accidental reorder in YARD_EXITS.
  const ex = bx + 1;
  const ey = by - 1;
  check("spawn: the blocked exit 0 is skipped, the unit stands on exit 1 (+1,-1) facing 0", unit.x === ex && unit.y === ey && unit.dir === 0 && unit.type === UNIT_BASIC, `${unit.x},${unit.y} type ${unit.type}`);
  check("spawn: initial record (hp 8 + 2 * tech, +9 = $FF waiting, no target, no recent directions)", unit.hp === 8 + 2 * s.byte(A.techLevel) && unit.tech === s.byte(A.techLevel) && unit.control === 0xff && unit.waiting && unit.targetX === NO_TARGET && unit.recent.join() === "255,255,255");
  check("spawn: occupancy is the map word bit 14 plus the own-unit flag byte bit 2, on that cell only", (cells[ey * MAP_WIDTH + ex] & OCCUPIED) !== 0 && (world.cellFlags[cellFlagIndex(ex, ey)] & OWN_FLAG) !== 0 && (cells[by * MAP_WIDTH + bx] & OCCUPIED) === 0);
  check("bookkeeping: $1429C 1, type-9 count 1, yard counter $143B6 1, no type-10 count", s.word(V.tanks) === 1 && s.long(V.typeCount9) === 1 && s.long(V.made) === 1 && s.long(0x14258) === 0);
  check("the staged passes did not change the date and raised no yard warning ($94/$95/$96/$8F)", s.dateText() === date && ![0x94, 0x95, 0x96, 0x8f].some((m) => env.seen.includes(m)), env.seen.join());
  check("the new tank is still waiting for its first move tick (not moved by the spawning pass)", unit.x === ex && unit.y === ey && unit.dx === 0 && unit.dy === 0 && !unit.moving);
}

// ---- 2. marker pin through the scene's own button/click handlers ----------------------------------------------------
const unit = units.units[0];
const spawnAt = { x: unit.x, y: unit.y };
const target = { x: unit.x + 3, y: unit.y + 3 }; // direction 3 (+1,+1) three times: no turn, no blocked cell
{
  check("target cell is on the staged free area", target.x < area.x + SIDE && target.y < area.y + SIDE && cells[target.y * MAP_WIDTH + target.x] === (cells[target.y * MAP_WIDTH + target.x] & ~(BLOCKED | OCCUPIED)));
  check("a click on a cell without the marker button armed is not a pin", scene.controls.cellHook(target.x, target.y) === false && scene.objects.markerCell(1) === null);
  scene.controls.onMarkerButton();
  check("marker button armed, then the cell click places pin 1 there", scene.controls.cellHook(target.x, target.y) === true && JSON.stringify(scene.objects.markerCell(1)) === JSON.stringify(target) && scene.objects.markerCell(2) === null);
  check("the pin did not order anything by itself", unit.targetX === NO_TARGET && unit.targetY === NO_TARGET);
}

// ---- 3. right-click pick and the real tank window ----------------------------------------------------------------
{
  const pick = pickObject(scene.objects, scene.sim.fleet.ships, scene.scrollX, scene.scrollY, 0, 0, { x: unit.x, y: unit.y });
  check("right click on the unit's cell picks that very tank", pick !== null && pick.kind === "tank" && pick.unit === unit);

  const ctx = { disk: disk1, world, sim: scene.sim, strings, objects: scene.objects, say: (m) => env.seen.push(m) };
  const window = createOrderScreen(ctx, pick);
  check("the tank window opens", window !== null);
  const ui = new Ui(disk1, strings);
  const PIN_RECTS = 0xee1e; // tank window pin rectangles $EE1E {x0, x1, y0, y1}, eight entries
  const rect = (n) => ({ x0: ui.image.word(PIN_RECTS + 8 * n), x1: ui.image.word(PIN_RECTS + 8 * n + 2), y0: ui.image.word(PIN_RECTS + 8 * n + 4), y1: ui.image.word(PIN_RECTS + 8 * n + 6) });
  const centre = (r) => ({ pointerX: (r.x0 + r.x1) >> 1, pointerY: (r.y0 + r.y1) >> 1 });
  let exit = null; // the exit button (index 9) of the tank window's button table: found by hit test
  for (let y = 0; y < 256 && !exit; y++) for (let x = 0; x < 320; x++) if (ui.buttonAt(x, y) === 9) { exit = { pointerX: x, pointerY: y }; break; }
  const click = (at) => {
    const frame = (left) => window.update({ leftButton: left, rightButton: false, ...at, keys: [] });
    frame(false);
    frame(true);
    return frame(false);
  };
  window.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
  check("the exit button was found in the button table", exit !== null);

  // an unplaced pin's icon does nothing
  click(centre(rect(1)));
  check("clicking the icon of an unplaced pin 2 chooses nothing", unit.targetX === NO_TARGET);
  // exit with no pin chosen: no order
  check("leaving the window without a pin gives no order", click(exit) === "close" && unit.targetX === NO_TARGET);

  const second = createOrderScreen(ctx, pick);
  const click2 = (at) => {
    const frame = (left) => second.update({ leftButton: left, rightButton: false, ...at, keys: [] });
    frame(false);
    frame(true);
    return frame(false);
  };
  second.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
  click2(centre(rect(0))); // pin 1
  check("choosing pin 1 alone is not yet an order", unit.targetX === NO_TARGET);
  check("the exit button closes the window and orders the tank to pin 1", click2(exit) === "close" && unit.targetX === target.x && unit.targetY === target.y && unit.recent.join() === "255,255,255", `${unit.targetX},${unit.targetY}`);
  check("the order itself moved nothing (the tank is still waiting on its cell)", unit.x === spawnAt.x && unit.y === spawnAt.y && unit.dx === 0 && unit.dy === 0 && !unit.moving && unit.waiting);
}

// ---- 4. walking under the main-loop passes ---------------------------------------------------------------------------
{
  const start = { x: unit.x, y: unit.y };
  const startIndex = start.y * MAP_WIDTH + start.x;
  const sub = units.clock.sub; // $144C9 after the last pass; the unit is released on the pass that wraps it to 0
  const releasePass = 9 - sub; // passes until the move tick (the pass that wraps sub 8 -> 0)
  const per = 8; // direction 3 (0,+2 per pass, 16 pixels per cell): $4C1A / $4BCA, units.md section 5
  const expected = releasePass + 3 * per; // release pass doubles as the direction-selection pass; 3 cells follow
  let arrivedAt = -1;
  let movedBeforeRelease = false;
  const trail = [];
  for (let n = 1; n <= expected + 20 && arrivedAt < 0; n++) {
    pass(scene);
    if (n < releasePass && (unit.x !== start.x || unit.y !== start.y || unit.dx !== 0 || unit.dy !== 0 || unit.moving)) movedBeforeRelease = true;
    if (n === releasePass) trail.push(`release dir ${unit.dir} v ${unit.vx},${unit.vy}`);
    if (unit.targetX === NO_TARGET) arrivedAt = n;
  }
  check("the tank does not move before its move tick", !movedBeforeRelease, `release pass ${releasePass}`);
  check("on the move-tick pass it picks direction 3 and starts moving at (0,+2) per pass", trail[0] === "release dir 3 v 0,2", trail[0]);
  check(`it arrives after ${expected} passes (${releasePass} to release + 3 cells x ${per}); port-derived, not measured`, arrivedAt === expected, `arrived at pass ${arrivedAt}`);
  check("arrival: on the pin cell, +B = $FF (order cleared; +C keeps the old y, as in the observed original), no speed, centred", unit.x === target.x && unit.y === target.y && unit.targetX === NO_TARGET && unit.targetY === target.y && unit.vx === 0 && unit.vy === 0 && unit.dx === 0 && unit.dy === 0);
  const occupied = [];
  for (let y = area.y; y < area.y + SIDE; y++) for (let x = area.x; x < area.x + SIDE; x++) if (cells[y * MAP_WIDTH + x] & OCCUPIED) occupied.push(`${x},${y}`);
  const flagged = [];
  for (let y = area.y; y < area.y + SIDE; y++) for (let x = area.x; x < area.x + SIDE; x++) if (world.cellFlags[cellFlagIndex(x, y)] & OWN_FLAG) flagged.push(`${x},${y}`);
  check("occupancy follows the tank: only the pin cell holds bit 14 / flag bit 2; spawn and path cells are released", occupied.join("|") === `${target.x},${target.y}` && flagged.join("|") === `${target.x},${target.y}` && (cells[startIndex] & OCCUPIED) === 0, `${occupied.join("|")} / ${flagged.join("|")}`);
  check("the reservation is the pin cell and the unit is still one live unit in slot 0", unit.reserveX === target.x && unit.reserveY === target.y && units.units.length === 1 && units.slots[0] === unit);
  check("counters unchanged by the walk ($1429C 1, type-9 count 1)", s.word(V.tanks) === 1 && s.long(V.typeCount9) === 1);
  pass(scene, 12);
  check("an arrived tank stays put (no target, no drift) over further passes", unit.x === target.x && unit.y === target.y && unit.dx === 0 && unit.dy === 0 && !unit.moving);
  check("a third month does not make a second tank without progress (record restarts: counter 10 only)", (() => { env.month(); return units.units.length === 1 && world.objects[at + 6] === 10; })());
}

// ---- 5. synthetic route regression (route shape taken from one observed run; NOT an original comparison) ---------------
{
  // Route shape of one Copperline run: (48,48)->(49,49)->(50,49)->(51,49)->(52,49), directions 3,2,2,2, eight passes per cell.
  // The clock is staged to $144C9 = 3 (the value of the original's first captured pass after the order; see
  // tank-original-compare.mjs), so the move tick comes on pass 6. The terrain, route and yard here are hand-staged.
  const e = stage([]);
  const routeCells = [[48, 48], [49, 49], [50, 49], [51, 49], [52, 49]];
  // The original route followed placement of a mine and yard, so this test clears only the movement blockers in its
  // small route fixture; it does not claim the untouched scenario map has the same terrain as the observed run.
  for (const [x, y] of routeCells) {
    e.cells[y * MAP_WIDTH + x] &= ~(BLOCKED | OCCUPIED);
    e.world.cellFlags[cellFlagIndex(x, y)] &= ~OWN_FLAG;
  }
  const routeOpen = routeCells.every(([x, y]) => (e.cells[y * MAP_WIDTH + x] & (BLOCKED | OCCUPIED)) === 0);
  check("synthetic-route movement fixture is clear after staging terrain blockers", routeOpen, routeCells.map(([x, y]) => `${x},${y}`).join(" "));
  const u = routeOpen ? e.units.spawn(UNIT_BASIC, 48, 48, 0) : null;
  if (u && routeOpen) {
    e.units.clock.sub = 3;
    e.units.order(u, 52, 49);
    const atPass = new Map();
    for (let n = 1; n <= 38; n++) {
      pass(e.scene);
      if ([6, 14, 22, 30, 38].includes(n)) atPass.set(n, { x: u.x, y: u.y, dir: u.dir, dx: u.dx, dy: u.dy, reserveX: u.reserveX, reserveY: u.reserveY, targetX: u.targetX, targetY: u.targetY });
    }
    check("synthetic route chooses direction 3 on the move-tick pass (6) and reserves (49,49)", (() => { const p = atPass.get(6); return p?.x === 48 && p.y === 48 && p.dir === 3 && p.reserveX === 49 && p.reserveY === 49; })());
    check("synthetic route reaches (49,49) on pass 14, then turns east", (() => { const p = atPass.get(14); return p?.x === 49 && p.y === 49 && p.dir === 2 && p.reserveX === 50 && p.reserveY === 49; })(), JSON.stringify(atPass.get(14)));
    check("synthetic route makes the remaining eastward cells on passes 22 and 30", (() => { const a = atPass.get(22), b = atPass.get(30); return a?.x === 50 && a.y === 49 && b?.x === 51 && b.y === 49 && a.dir === 2 && b.dir === 2; })(), JSON.stringify([atPass.get(22), atPass.get(30)]));
    check("synthetic route arrives on pass 38: +B = $FF, +C kept, velocity cleared", (() => { const p = atPass.get(38); return p?.x === 52 && p.y === 49 && p.targetX === NO_TARGET && p.targetY === 49 && u.vx === 0 && u.vy === 0; })(), JSON.stringify({ at: atPass.get(38), vx: u.vx, vy: u.vy }));
    check("synthetic route leaves occupancy and flag bit only on its final reservation", (() => {
      const occupied = routeCells.filter(([x, y]) => e.cells[y * MAP_WIDTH + x] & OCCUPIED).map(([x, y]) => `${x},${y}`).join();
      const own = routeCells.filter(([x, y]) => e.world.cellFlags[cellFlagIndex(x, y)] & OWN_FLAG).map(([x, y]) => `${x},${y}`).join();
      return occupied === "52,49" && own === "52,49" && u.reserveX === 52 && u.reserveY === 49;
    })());
  }
}

// ---- 6. blocked exits: retry, then the last exit in the documented order -------------------------------------------
{
  // The yard record is staged at $FF progress to exercise the statically ported no-free-neighbour branch ($A6D2:
  // message $95, keep the counter and retry next month); this failure state was not captured in the original.
  const e = stage([0, 1, 2, 3, 4, 5, 6], 0xff); // exits 0..6 blocked, exit 7 (-1,-1) free
  const exit7 = { x: e.bx - 1, y: e.by - 1 };
  // occupy the last free exit with a foreign reservation: the yard is completely surrounded
  e.cells[exit7.y * MAP_WIDTH + exit7.x] |= OCCUPIED;
  e.month();
  check("all eight neighbours unusable: no unit, message $95, counter stays $FF, nothing counted", e.units.units.length === 0 && e.seen.includes(0x95) && e.world.objects[e.at + 6] === 0xff && e.state.word(V.tanks) === 0 && e.state.long(V.made) === 0, e.seen.join());
  e.cells[exit7.y * MAP_WIDTH + exit7.x] &= ~OCCUPIED;
  e.month();
  const u = e.units.units[0];
  check("one exit becomes free: the retry puts the unit on exit 7 (-1,-1), the last in the order", e.units.units.length === 1 && u.x === exit7.x && u.y === exit7.y && e.world.objects[e.at + 6] === 0 && e.state.word(V.tanks) === 1 && e.state.long(V.made) === 1, u ? `${u.x},${u.y}` : "none");
  check("retry consumed no extra goods ($FF skips the stock steps)", e.state.long(V.good1) === 100 && e.state.long(V.good3) === 100);
}

// ---- 6. the advanced tank (invention bit 2) --------------------------------------------------------------------------
{
  const e = stage([], 0xff);
  e.state.setLong(V.invention, e.state.long(V.invention) | 4);
  e.month();
  const u = e.units.units[0];
  check("invention bit 2 set: the yard makes the advanced type 10 on exit 0 (0,-1) and counts it in $14258", !!u && u.type === 10 && u.x === e.bx && u.y === e.by - 1 && e.state.long(0x14258) === 1 && e.state.long(V.typeCount9) === 0);
}

if (failed > 0) {
  console.error(`${failed} tank lifecycle check(s) failed`);
  process.exit(1);
}
console.log("tank lifecycle checks passed");
