// Headless checks of the object sprites, marker pins and ground unit movement (src/data/sprites.ts,
// src/game/objects.ts, src/game/units.ts). Run after `npm run build`. Uses the user's own game data in
// original/utopia-whdload (Disk.1 and Disk.2); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("unit tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap, MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { loadSprites, SPRITE_TYPES } = await import("../dist/data/sprites.js");
const { UnitSystem, UNIT_BASIC, UNIT_ADVANCED, NO_TARGET } = await import("../dist/game/units.js");
const { ObjectLayer } = await import("../dist/game/objects.js");
const { Screen } = await import("../dist/gfx/screen.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const OCCUPIED = 0x4000;
const BLOCKED = 0x1000;

// --- sprites ---------------------------------------------------------------------------------
{
  const set = loadSprites(disk1, disk2, records[0]);
  check("27 sprite type slots", set.types.length === SPRITE_TYPES && SPRITE_TYPES === 27);
  const present = set.types.map((t, i) => (t ? i + 1 : 0)).filter(Boolean);
  check("scenario 0 has no sprites for types 24 and 27", !set.has(24) && !set.has(27) && present.length === 25, present.join(","));
  let pinsOk = true;
  for (let t = 1; t <= 8; t++) {
    const f = set.frame(t, 0);
    pinsOk &&= !!f && f.rows === 20 && f.opaque.some((v) => v === 1);
  }
  check("pins 1-8 are 20-row frames with pixels", pinsOk);
  const tank = set.frame(9, 3);
  check(
    "type 9 has 8 distinct facing frames",
    [0, 1, 2, 3, 4, 5, 6, 7].every((i) => set.frame(9, i).index.join() !== set.frame(9, (i + 1) % 8).index.join()),
  );
  check("effect types are 25 rows", [18, 19, 20, 21].every((t) => set.frame(t, 0).rows === 25));
  check("frame decode is cached", set.frame(9, 3) === tank);
  // The first row of a decoded frame is the TOP row (stored last in the data): a pin has its round head
  // above its tip, with transparent padding below.
  const pin = set.frame(1, 0);
  const width = (r) => pin.opaque.slice(r * 32, r * 32 + 32).reduce((n, v) => n + v, 0);
  check("pin image is stored bottom row first", width(7) > width(13) && width(13) > 0 && width(19) === 0 && width(0) === 0, `head ${width(7)} tip ${width(13)}`);
  const other = loadSprites(disk1, disk2, records[3]);
  check("scenario 3 has a 25-row type 24", other.has(24) && other.frame(24, 0).rows === 25);
}

// --- units: movement -------------------------------------------------------------------------
function fresh(scenario = 0, hooks = {}) {
  const cells = loadMap(disk2, records[scenario]).slice();
  return { cells, sys: new UnitSystem(cells, () => 1, hooks) };
}
// Finds a w x h block of free cells.
function freeBlock(sys, w, h) {
  for (let y = 2; y < MAP_HEIGHT - h - 2; y++) {
    for (let x = 2; x < MAP_WIDTH - w - 2; x++) {
      let ok = true;
      for (let j = 0; j < h && ok; j++) for (let i = 0; i < w && ok; i++) ok = sys.cellFree(x + i, y + j);
      if (ok) return { x, y };
    }
  }
  throw new Error("no free block");
}
// Runs movement steps (9 passes each) until the unit has no order any more.
function stepsToArrive(sys, unit, limit = 500) {
  let steps = 0;
  while (unit.hasTarget && steps < limit) {
    for (let i = 0; i < 9; i++) sys.tick();
    steps++;
  }
  return steps;
}

{
  const { cells, sys } = fresh();
  const b = freeBlock(sys, 12, 8);
  const u = sys.spawn(UNIT_BASIC, b.x, b.y, 0);
  check("spawn reserves the cell", (cells[b.y * MAP_WIDTH + b.x] & OCCUPIED) !== 0 && !sys.cellFree(b.x, b.y));
  check("new unit stats", u.hp === 10 && u.targetX === NO_TARGET && u.recent.every((r) => r === 0xff));
  for (let i = 0; i < 9; i++) sys.tick();
  check("a unit without an order stays put", u.x === b.x && u.y === b.y && u.dx === 0 && u.dy === 0);

  sys.order(u, b.x + 5, b.y + 3);
  const steps = stepsToArrive(sys, u);
  // One step to pick the direction, then 8 steps of 2 pixels per cell; 3 diagonal and 2 straight cells.
  check("walks (5,3) in 41 movement steps", steps === 41, `steps ${steps}`);
  check("arrives on the target", u.x === b.x + 5 && u.y === b.y + 3 && u.dx === 0 && u.dy === 0 && !u.moving);
  const marked = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] & OCCUPIED) marked.push(i);
  check("only the unit's cell stays reserved", marked.length === 1 && marked[0] === u.y * MAP_WIDTH + u.x);
  check("flag byte follows", sys.flags[u.y * MAP_WIDTH + u.x] === 4 && sys.flags[b.y * MAP_WIDTH + b.x] === 0);

  // A straight order uses a single direction.
  const dirs = [];
  sys.order(u, u.x - 4, u.y);
  while (u.hasTarget) {
    for (let i = 0; i < 9; i++) sys.tick();
    if (dirs[dirs.length - 1] !== u.dir) dirs.push(u.dir);
  }
  check("straight order uses one direction", dirs.join() === "6", dirs.join());
}

{
  // Direction 1 moves 2 px right per step; the cell changes after 16 steps (32 px).
  const { sys } = fresh();
  const b = freeBlock(sys, 6, 6);
  const u = sys.spawn(UNIT_BASIC, b.x, b.y + 3, 0);
  sys.order(u, b.x + 1, b.y + 2);
  const seen = [];
  for (let i = 0; i < 18; i++) {
    for (let k = 0; k < 9; k++) sys.tick();
    seen.push(`${u.dx},${u.dy}`);
  }
  const expected = Array.from({ length: 15 }, (_, i) => `${2 * (i + 1)},0`).join(";");
  check("direction 1 offsets run 2,4..30, then the cell changes", seen.slice(1, 16).join(";") === expected && u.x === b.x + 1 && u.y === b.y + 2, seen.join(";"));
  check("target reached ends the order", !u.hasTarget && u.vx === 0 && u.vy === 0);
}

{
  // Obstacles: a wall of blocked cells across the straight way; the unit never enters blocked cells.
  const { cells, sys } = fresh();
  const b = freeBlock(sys, 12, 8);
  for (let j = 0; j < 5; j++) cells[(b.y + j) * MAP_WIDTH + b.x + 4] |= BLOCKED;
  const u = sys.spawn(UNIT_BASIC, b.x + 1, b.y + 2, 0);
  sys.order(u, b.x + 8, b.y + 2);
  const steps = stepsToArrive(sys, u, 800);
  check("blocked way ends the order without entering blocked cells", !u.hasTarget && (cells[u.y * MAP_WIDTH + u.x] & BLOCKED) === 0, `ended at (${u.x - b.x},${u.y - b.y}) after ${steps} steps`);
}

{
  // A wall with a gap on the straight line: the unit goes through it.
  const { cells, sys } = fresh();
  const b = freeBlock(sys, 12, 8);
  for (let j = 0; j < 8; j++) if (j !== 3) cells[(b.y + j) * MAP_WIDTH + b.x + 4] |= BLOCKED;
  const u = sys.spawn(UNIT_BASIC, b.x + 1, b.y + 3, 0);
  sys.order(u, b.x + 8, b.y + 3);
  stepsToArrive(sys, u, 800);
  check("passes through a one-cell gap on the straight line", u.x === b.x + 8 && u.y === b.y + 3, `ended at (${u.x - b.x},${u.y - b.y})`);
}

{
  // Two units head-on: the reserved cells ahead keep them from sharing a cell.
  const { cells, sys } = fresh();
  const b = freeBlock(sys, 12, 8);
  const a = sys.spawn(UNIT_BASIC, b.x, b.y + 2, 0);
  const c = sys.spawn(UNIT_BASIC, b.x + 6, b.y + 2, 0);
  sys.order(a, b.x + 8, b.y + 2);
  sys.order(c, b.x, b.y + 2);
  let shared = false;
  for (let i = 0; i < 9 * 400; i++) {
    sys.tick();
    if (a.x === c.x && a.y === c.y) shared = true;
    if (a.reserveX === c.reserveX && a.reserveY === c.reserveY) shared = true;
  }
  check("units never share a cell", !shared);
  const reserved = Array.from(cells).filter((w) => w & OCCUPIED).length;
  check("exactly one reserved cell per unit when idle", reserved === 2, `${reserved}`);
}

{
  // Border: a unit ordered beyond the map edge walks off it and is removed.
  const lost = [];
  const { cells, sys } = fresh(0, { lost: (u) => lost.push(u) });
  let y = 2;
  while (!sys.cellFree(MAP_WIDTH - 1, y)) y++;
  const u = sys.spawn(UNIT_BASIC, MAP_WIDTH - 1, y, 0);
  sys.order(u, 120, y);
  stepsToArrive(sys, u, 100);
  check("walking off the map removes the unit and calls the hook", sys.units.length === 0 && lost.length === 1, `units ${sys.units.length}`);
  check("its reserved cell is released", (cells[y * MAP_WIDTH + MAP_WIDTH - 1] & OCCUPIED) === 0);
}

{
  // The advanced unit may enter blocked cells with a tile id >= $88; the basic one may not.
  const { cells, sys } = fresh();
  const b = freeBlock(sys, 6, 3);
  const wall = b.x + 3;
  for (let y = 0; y < MAP_HEIGHT; y++) cells[y * MAP_WIDTH + wall] = 0x90 | BLOCKED; // a rock wall across the map
  const basic = sys.spawn(UNIT_BASIC, b.x + 1, b.y + 1, 0);
  sys.order(basic, b.x + 5, b.y + 1);
  let crossed = false;
  for (let i = 0; i < 9 * 500 && sys.units.includes(basic); i++) {
    sys.tick();
    if (basic.x >= wall) crossed = true;
  }
  check("basic unit cannot cross a rock wall", !crossed);
  sys.remove(basic);
  const adv = sys.spawn(UNIT_ADVANCED, b.x + 1, b.y + 1, 0);
  sys.order(adv, b.x + 5, b.y + 1);
  stepsToArrive(sys, adv, 300);
  check("advanced unit crosses rocks", adv.x === b.x + 5 && adv.y === b.y + 1, `x ${adv.x - b.x}`);
}

{
  // The building that makes units puts them on the first free neighbour.
  const { cells, sys } = fresh();
  const b = freeBlock(sys, 6, 6);
  const bx = b.x + 2;
  const by = b.y + 2;
  const first = sys.spawnAtYard(bx, by, false);
  check("first unit goes to the cell above the building", first.x === bx && first.y === by - 1 && first.type === UNIT_BASIC);
  const second = sys.spawnAtYard(bx, by, true);
  check("second goes up-right", second.x === bx + 1 && second.y === by - 1 && second.type === UNIT_ADVANCED);
  cells[(by + 1) * MAP_WIDTH + bx - 1] |= BLOCKED;
  const third = sys.spawnAtYard(bx, by, false);
  check("blocked exits are skipped", third.x === bx - 1 && third.y === by, `${third.x - bx},${third.y - by}`);
  let full = 0;
  for (let i = 0; i < 120; i++) if (sys.spawn(UNIT_BASIC, 1 + (i % 90), 1 + Math.floor(i / 90), 0) === null) full++;
  check("the list holds at most 99 units", sys.units.length === 99 && full > 0, `${sys.units.length}`);
}

// --- objects: markers, effects, drawing ----------------------------------------------------------
{
  const set = loadSprites(disk1, disk2, records[0]);
  const cells = loadMap(disk2, records[0]).slice();
  const layer = new ObjectLayer(set, [], cells, () => {});
  check("toggleMarker places", layer.toggleMarker(3, 50, 40) === "placed" && layer.markerCell(3).x === 50);
  check("a pin on a cell is removed by any key", layer.toggleMarker(5, 50, 40) === "removed" && layer.markerCell(3) === null && layer.markerCell(5) === null);
  layer.toggleMarker(2, 50, 40);
  layer.toggleMarker(2, 52, 41);
  check("the same pin moves", layer.markerCell(2).x === 52 && layer.markers.filter((m) => m.y !== 0xff).length === 1);
  layer.clearMarkers();
  check("clear removes all pins", layer.markers.every((m) => m.y === 0xff));

  const screen = new Screen();
  layer.toggleMarker(1, 50, 40); // scroll (47, 33) -> view cell (3, 7)
  layer.drawMarkers(screen, 47, 33);
  const touched = screen.pixels.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
  check("a visible pin draws pixels", touched > 20, `${touched}`);
  const ax = 112 + 16 * (3 - 7);
  const ay = 39 + 8 * (3 + 7) - 1; // bottom row of the cell box
  let inside = true;
  for (let i = 0; i < screen.pixels.length; i++) {
    if (screen.pixels[i] === 0) continue;
    const x = i % 320;
    const y = Math.floor(i / 320);
    if (x < ax || x >= ax + 32 || y > ay || y <= ay - 20) inside = false;
  }
  check("pin sits in its 32 x 20 box on the cell's bottom row", inside);
  const none = new Screen();
  layer.drawMarkers(none, 60, 33); // pin is outside the window
  check("pins outside the window are not drawn", none.pixels.every((v) => v === 0));

  layer.units.spawn(UNIT_BASIC, 49, 35, 2);
  const s2 = new Screen();
  layer.drawAfterCell(s2, 47, 33, 2, 2);
  check("a unit is drawn on its own cell", s2.pixels.some((v) => v !== 0));
  const s3 = new Screen();
  layer.drawAfterCell(s3, 47, 33, 3, 2);
  check("and only there", s3.pixels.every((v) => v === 0));

  // Window edge rule: a unit leaving the last column to the right is hidden.
  const edge = new ObjectLayer(set, [], cells, () => {});
  const e = edge.units.spawn(UNIT_BASIC, 47 + 7, 33 + 2, 2);
  e.dx = 4;
  e.dy = 2;
  const s4 = new Screen();
  edge.drawAfterCell(s4, 47, 33, 7, 2);
  check("a unit moving out of the last column is hidden", s4.pixels.every((v) => v === 0));

  // Effects: created with frame 4, freed after it counts below 0 (one pass = 2 frames here).
  const fx = new ObjectLayer(set, [], cells, () => {});
  fx.spawnEffect(0x12, 50, 40);
  let frames = 0;
  while (fx.effects.length > 0 && frames < 100) {
    fx.update();
    frames++;
  }
  check("an effect lives 5 passes", frames === 10, `${frames} frames`);

  // Neighbour tiles in front of a moving unit are drawn first, and only once.
  const flat = [{ rows: 15, planes: new Uint8Array(24 * 15) }];
  const cells2 = new Uint16Array(MAP_WIDTH * MAP_HEIGHT).fill(1);
  const calls = [];
  const nb = new ObjectLayer(set, flat, cells2, (t, x, y) => calls.push([x, y]));
  const m = nb.units.spawn(UNIT_BASIC, 49, 36, 3);
  m.dx = 2;
  m.dy = 2;
  nb.drawAfterCell(new Screen(), 47, 33, 2, 3);
  check("facing 3 draws (vx+1,vy), (vx,vy+1), (vx+1,vy+1) in advance", calls.length === 3, `${calls.length}`);
  check("each is skipped by the cell loop later, once", nb.claimed(3, 3) && !nb.claimed(3, 3) && nb.claimed(2, 4) && nb.claimed(3, 4));
  const standing = new ObjectLayer(set, flat, cells2, (t, x, y) => calls.push([x, y]));
  calls.length = 0;
  standing.units.spawn(UNIT_BASIC, 49, 36, 3);
  standing.drawAfterCell(new Screen(), 47, 33, 2, 3);
  check("a unit without pixel offset draws no neighbours", calls.length === 0);
}

console.log(failed === 0 ? "all unit tests passed" : `${failed} unit test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
