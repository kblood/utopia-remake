// Coverage of the Disk.4 scene activation path: the explicit hook-binding APIs (Sim.bindRuntimeHooks,
// UnitSystem.bindHooks, EnemySystem.bindHooks), ObjectLayer adoption of an existing UnitSystem, and (with the user's
// own Disk.1 / Disk.2 in original/utopia-whdload) MapScene.fromPrepared and Game.activateDisk4. Part 1 is fully
// synthetic and always runs; part 2 is skipped without the game data. Run after `npm run build`.
//
// All Disk.4 images are synthetic (built here from the scenario's own new-game state when the game data is present);
// no original data is stored anywhere.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Sim } = await import("../dist/game/sim.js");
const { UnitSystem } = await import("../dist/game/units.js");
const { ObjectLayer } = await import("../dist/game/objects.js");
const { GameState, STATE_BYTES, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { prepareDisk4HeadlessEnemies } = await import("../dist/game/disk4-load.js");
const { CELL_FLAG_BASE, cellFlagIndex } = await import("../dist/game/cell-flags.js");
const { DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT } = await import("../dist/data/disk4.js");
const { DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES } = await import("../dist/data/disk4-state.js");
const { readSavedView, readSavedMarkers, validateSpecialSlots } = await import("../dist/game/disk4-scene.js");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
const put16 = (b, o, v) => { b[o] = v >> 8; b[o + 1] = v & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const sameRefs = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
function captureGraph(graph) {
  const units = graph.tanks ?? graph.objects?.units;
  const enemies = graph.enemySystem ?? graph.enemies;
  return {
    state: graph.state.snapshot(), cells: graph.world.cells.slice(), flags: graph.world.cellFlags.slice(), objects: graph.world.objects.slice(),
    unitSlots: units.slots.slice(), groundSlots: enemies.groundSlots.slice(), airSlots: enemies.airSlots.slice(), fleetSlots: graph.sim.fleet.slots.slice(),
  };
}
function graphUnchanged(graph, before) {
  const after = captureGraph(graph);
  return sameBytes(after.state, before.state) && sameBytes(after.cells, before.cells) && sameBytes(after.flags, before.flags) && sameBytes(after.objects, before.objects) &&
    sameRefs(after.unitSlots, before.unitSlots) && sameRefs(after.groundSlots, before.groundSlots) && sameRefs(after.airSlots, before.airSlots) && sameRefs(after.fleetSlots, before.fleetSlots);
}

const SECTORS = 1920;
const SLOT = 2;
const A_FIRST = 100;
const B_FIRST = 174;
const recOffset = (i) => DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + i * DISK4_RECORD_SIZE;
const ptr = (x, y) => CELL_FLAG_BASE + cellFlagIndex(x, y);

function makeImage(fillA, fillB) {
  const img = new Uint8Array(SECTORS * 512);
  for (let k = 0; k < 8; k++) img[DISK4_HEADER_OFFSET + k] = "UTOPSAVE".charCodeAt(k);
  for (let i = 0; i < DISK4_SLOT_COUNT; i++) {
    const name = i === SLOT ? "SYNTH" : "EMPTY";
    for (let k = 0; k < name.length; k++) img[recOffset(i) + k] = name.charCodeAt(k);
  }
  const rec = recOffset(SLOT);
  put16(img, rec + 0x10, A_FIRST); put16(img, rec + 0x12, A_FIRST + 72);
  put16(img, rec + 0x14, B_FIRST); put16(img, rec + 0x16, B_FIRST + 10);
  fillA?.(img.subarray(A_FIRST * 512, A_FIRST * 512 + DISK4_AREA_A_BYTES));
  fillB?.(img.subarray(B_FIRST * 512, B_FIRST * 512 + DISK4_AREA_B_BYTES));
  return img;
}
const request = (scenario = 0) => ({ slot: SLOT, scenario, scenarioCount: 10 });
const enemyAt = (list, i) => offA(DISK4_ADDR[list]) + i * 0x1a;
const shipAt = (i) => offA(DISK4_ADDR.ownShips) + i * 0x18;
const tankAt = (i) => offA(DISK4_ADDR.ownTanks) + i * 0x18;
const setWordCell = (a, x, y, v) => put16(a, offA(DISK4_ADDR.mapCells) + (y * 102 + x) * 2, v);
const setFlagCell = (a, x, y, v) => { a[offA(DISK4_ADDR.flags) + cellFlagIndex(x, y)] = v; };

function putTank(a, i, o) {
  const at = tankAt(i);
  a[at] = o.type ?? 9; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 5] = o.dir ?? 0; a[at + 8] = o.hp ?? 12; a[at + 9] = o.control ?? 0xff;
  a[at + 10] = 1; a[at + 11] = 0xff; a[at + 12] = 0xff; a[at + 0x10] = 0xff; a[at + 0x11] = 0xff; a[at + 0x12] = 0xff;
  put32(a, at + 0x14, ptr(o.x, o.y));
}
function putShip(a, i, o) {
  const at = shipAt(i);
  a[at] = o.type; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 5] = o.dir ?? 0; a[at + 8] = 9; a[at + 9] = o.mode ?? 0; a[at + 10] = 1;
  a[at + 11] = 0xff; a[at + 12] = 0xff; a[at + 0x0d] = o.type - 11; put16(a, at + 0x0e, 100);
  a[at + 0x12] = 2;
  put32(a, at + 0x14, ptr(o.x, o.y));
}
function putEnemy(a, list, i, o) {
  const at = enemyAt(list, i);
  a[at] = o.type; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 5] = o.dir ?? 0; a[at + 8] = 20; a[at + 9] = 5;
  a[at + 11] = 0xff; a[at + 12] = 0xff; a[at + 0x0e] = 30; a[at + 0x0f] = 5;
  put32(a, at + 0x16, ptr(o.x, o.y));
}

const tables = {
  spiral: Array.from({ length: 48 }, () => [0, 0]),
  arcs: Array.from({ length: 8 }, () => Array.from({ length: 32 }, () => [0, 0])),
  turn: Array.from({ length: 64 }, (_, k) => { const d = k >> 3, w = k & 7; return d === w ? d : (d + 1) & 7; }),
  crusherAnim: Array(8).fill(0),
};

// ---- 1a. UnitSystem.bindHooks ---------------------------------------------------------------------------------------
{
  const calls = { old: 0, neu: 0 };
  const cells = new Uint16Array(7500);
  const flags = new Uint8Array(7650);
  const units = new UnitSystem(cells, () => 1, { combat: () => { calls.old++; } }, flags);
  const unit = units.spawn(9, 10, 10);
  if (unit === null) throw new Error("spawn failed");
  unit.waiting = false;
  const slots = units.slots;
  const clock = units.clock;
  units.bindHooks({ combat: () => { calls.neu++; } });
  units.tick();
  check("UnitSystem.bindHooks: only the new combat hook runs", calls.old === 0 && calls.neu === 1);
  check("UnitSystem.bindHooks: slots, unit, clock and buffers are untouched", units.slots === slots && units.slots[0] === unit && units.clock === clock && units.usesBuffers(cells, flags));
  check("UnitSystem.usesBuffers is identity based", !units.usesBuffers(new Uint16Array(7500), flags) && !units.usesBuffers(cells, new Uint8Array(7650)));
}

// ---- 1b. Sim.bindRuntimeHooks ---------------------------------------------------------------------------------------
{
  const st = GameState.fromSnapshot(new Uint8Array(STATE_BYTES));
  const wr = World.fromSnapshot(st.value, { cells: new Uint16Array(7500), cellFlags: new Uint8Array(7650), objects: new Uint8Array(8000) });
  const state = st.value;
  let rolls = 0;
  const rng = () => { rolls++; return 0; };
  const old = [];
  const neu = [];
  const fx = [];
  const sim = Sim.fromSnapshot(wr.value, { rng, demolishAt: () => old.push(1) });
  const fleet = sim.fleet, aliens = sim.aliens, alerts = sim.alerts;
  const image = state.snapshot();
  sim.bindRuntimeHooks({ demolishAt: (x, y) => { neu.push([x, y]); return [[x, y]]; }, effect: (kind) => fx.push(kind), interactive: true });
  check("Sim.bindRuntimeHooks: no state write, no RNG draw, helpers kept",
    sameBytes(state.snapshot(), image) && rolls === 0 && sim.fleet === fleet && sim.aliens === aliens && sim.alerts === alerts && sim.pending === null);
  sim.bomb(3, 4);
  check("Sim.bindRuntimeHooks: the new demolish / effect hooks replace the old ones", old.length === 0 && neu.length === 1 && neu[0][0] === 3 && neu[0][1] === 4 && fx[0] === "explosion");
  sim.bindRuntimeHooks({ onDay: () => {} });
  sim.bomb(5, 6);
  check("Sim.bindRuntimeHooks: absent keys keep their callbacks", neu.length === 2 && old.length === 0);
  state.setWord(0x1429c, 20);
  state.setLong(A.money, 100000);
  const before = rolls;
  sim.eventTankRequisition(100);
  check("Sim.bindRuntimeHooks: an interactive offer is queued using the existing RNG", sim.pending !== null && sim.pending.offer.what === "tanks" && rolls > before);
}

// ---- 1c. prepared graph: EnemySystem.bindHooks and ObjectLayer adoption ---------------------------------------------
{
  const mark = (a) => {
    putTank(a, 3, { x: 50, y: 40 });
    putEnemy(a, "enemyGround", 5, { type: 22, x: 60, y: 50 });
    putEnemy(a, "enemyGround", 6, { type: 22, x: 62, y: 50 });
    putShip(a, 0, { type: 11, x: 70, y: 30, mode: 0 });
    setWordCell(a, 70, 30, 0x4000);
    setFlagCell(a, 70, 30, 4); // FLAG_OWN: a landed ship's mark
  };
  const calls = { old: 0, rng: 0 };
  const img = makeImage(mark, (b) => put16(b, offB(0x1429e), 1));
  const r = prepareDisk4HeadlessEnemies(img, request(), tables, { rng: () => { calls.rng++; return 0; } }, { explode: () => { calls.old++; } });
  if (!r.ok) throw new Error(`preparation failed: ${JSON.stringify(r.error)}`);
  const v = r.value;
  const sys = v.enemySystem;
  const ground = sys.groundSlots, air = sys.airSlots, g5 = ground[5], g6 = ground[6];
  const ship = v.sim.fleet.slots[0];
  const image = v.state.snapshot();
  const cellsBefore = v.world.cells.slice();
  const flagsBefore = v.world.cellFlags.slice();
  const neu = [];
  sys.bindHooks({ explode: (x, y, lift, high) => neu.push([x, y, lift, high]) });
  check("EnemySystem.bindHooks: slots, objects, fleet and saved bytes are untouched",
    sys.groundSlots === ground && sys.airSlots === air && sys.groundSlots[5] === g5 && sys.groundSlots[6] === g6 && v.sim.fleet.slots[0] === ship &&
    sameBytes(v.state.snapshot(), image) && sameBytes(v.world.cells, cellsBefore) && sameBytes(v.world.cellFlags, flagsBefore) && calls.rng === 0 && calls.old === 0);
  check("EnemySystem.isComposedOf is identity based", sys.isComposedOf(v.sim, v.tanks) && !sys.isComposedOf(v.sim, new UnitSystem(v.world.cells, () => 1, {}, v.world.cellFlags)));
  sys.destroyGround(g5, true);
  check("EnemySystem.bindHooks: the new explode hook runs, the old one does not, the other slot stays",
    neu.length === 1 && neu[0][0] === 60 && neu[0][1] === 50 && neu[0][3] === true && calls.old === 0 && sys.groundSlots[5] === null && sys.groundSlots[6] === g6);
  v.sim.fleet.destroyShip(ship, 0, false);
  check("Fleet reservation release (installed at adoption) survives bindHooks",
    v.sim.fleet.slots[0] === null && (v.world.cells[30 * 100 + 70] & 0x4000) === 0 && (v.world.cellFlags[cellFlagIndex(70, 30)] & 4) === 0);

  const boundary = prepareDisk4HeadlessEnemies(makeImage(), request(), tables).value;
  const shots = [];
  boundary.enemySystem.fireGuns = (tile) => shots.push(tile);
  const boundaryImage = boundary.state.snapshot();
  boundary.enemySystem.primeRestoredFrame();
  check("legacy gun-baseline compatibility call is inert on a restored graph", sameBytes(boundary.state.snapshot(), boundaryImage) && shots.length === 0);
  boundary.state.setByte(A.pending, boundary.state.byte(A.pending) | 0x10);
  boundary.sim.loopPass();
  check("restored graph consumes a saved special-period latch", shots.length === 1 && shots[0] === 0x1f && (boundary.state.byte(A.pending) & 0x10) === 0);
  const noEdge = prepareDisk4HeadlessEnemies(makeImage(), request(), tables).value;
  const noEdgeShots = [];
  noEdge.enemySystem.fireGuns = (tile) => noEdgeShots.push(tile);
  noEdge.sim.paused = true;
  noEdge.state.setByte(A.pending, noEdge.state.byte(A.pending) | 0x10);
  noEdge.sim.loopPass();
  check("paused restored graph preserves the saved special-period latch", noEdgeShots.length === 0 && (noEdge.state.byte(A.pending) & 0x10) !== 0);

  // ObjectLayer adoption (a fresh graph; the one above is used up)
  const r2 = prepareDisk4HeadlessEnemies(makeImage(mark, (b) => put16(b, offB(0x1429e), 1)), request(), tables);
  const w = r2.value;
  const stub = { frame: () => null };
  const layer = new ObjectLayer(stub, [], w.world.cells, () => {}, () => 1, {}, w.world.cellFlags, w.tanks);
  check("ObjectLayer adopts the prepared UnitSystem (same object, saved slot kept)", layer.units === w.tanks && layer.units.slots[3] !== null && layer.units.slots[3].slot === 3);
  let threw = false;
  try { new ObjectLayer(stub, [], new Uint16Array(7500), () => {}, () => 1, {}, w.world.cellFlags, w.tanks); } catch { threw = true; }
  check("ObjectLayer refuses an adopted UnitSystem that runs over other buffers", threw);
  layer.restoreMarkers([{ x: 5, y: 6 }, null, null, { x: 99, y: 74 }, null, null, null, null]);
  check("ObjectLayer.restoreMarkers sets pins without toggling", layer.markerCell(1)?.x === 5 && layer.markerCell(1)?.y === 6 && layer.markerCell(2) === null && layer.markerCell(4)?.x === 99);
  layer.restoreMarkers([{ x: 5, y: 6 }, { x: 5, y: 6 }, null, null, null, null, null, null]);
  check("ObjectLayer.restoreMarkers keeps two pins on one cell exactly as saved", layer.markerCell(1) !== null && layer.markerCell(2) !== null && layer.markerCell(4) === null);
}

// ---- 1d. disk4-scene readers ----------------------------------------------------------------------------------------
{
  const image = new Uint8Array(STATE_BYTES);
  const state = GameState.fromSnapshot(image).value;
  for (let i = 0; i < 8; i++) state.setByte(0x14540 + 10 * i + 2, 0xff);
  state.setWord(A.scrollX, 200);
  state.setWord(A.scrollY, 3);
  const view = readSavedView(state);
  check("readSavedView clamps for display and reports it, without writing", view.x === 92 && view.y === 3 && view.savedX === 200 && view.clamped && state.word(A.scrollX) === 200);
  state.setByte(0x14540 + 10 * 2 + 1, 7);
  state.setByte(0x14540 + 10 * 2 + 2, 9);
  const pins = readSavedMarkers(state);
  check("readSavedMarkers: y = $FF is unplaced, others are cells", pins.ok && pins.value[2]?.x === 7 && pins.value[2]?.y === 9 && pins.value.filter((p) => p !== null).length === 1);
  state.setByte(0x14540 + 10 * 5 + 1, 100);
  state.setByte(0x14540 + 10 * 5 + 2, 3);
  const bad = readSavedMarkers(state);
  check("readSavedMarkers rejects a pin outside the map with the pin index", !bad.ok && bad.error.code === "marker-record" && bad.error.marker === 5);
  // Special slots: free and traced active layouts pass; anything outside the traced domain is a typed "special-state".
  const special = (mutate) => { mutate(); const e = validateSpecialSlots(state); return e; };
  check("validateSpecialSlots: free slots pass", validateSpecialSlots(state) === null);
  state.setByte(0x144a8, 0x13);
  state.setByte(0x144a9, 99); state.setByte(0x144aa, 74); state.setWord(0x144a4, 10); state.setByte(0x144ad, 3);
  check("validateSpecialSlots: an active alien on the last cell with phase 10 / frame 3 is accepted", validateSpecialSlots(state) === null);
  const validated = state.snapshot();
  validateSpecialSlots(state);
  check("validateSpecialSlots: validation only reads", sameBytes(state.snapshot(), validated));
  const alienCases = [
    ["an unknown type at $144A8", () => state.setByte(0x144a8, 0x14), /type \$14/],
    ["an alien x outside the map", () => { state.setByte(0x144a8, 0x13); state.setByte(0x144a9, 100); }, /position/],
    ["an alien y outside the map", () => { state.setByte(0x144a9, 5); state.setByte(0x144aa, 75); }, /position/],
    ["an alien phase word above 10", () => { state.setByte(0x144aa, 5); state.setWord(0x144a4, 11); }, /phase/],
    ["an alien phase word with a nonzero high byte", () => state.setWord(0x144a4, 0x0100), /phase/],
    ["an alien frame above 3", () => { state.setWord(0x144a4, 0); state.setByte(0x144ad, 4); }, /frame/],
  ];
  for (const [label, mutate, pattern] of alienCases) {
    const e = special(mutate);
    check(`validateSpecialSlots: ${label} is rejected as special-state`, e?.code === "special-state" && pattern.test(e.message), e ? e.message : "accepted");
  }
  state.setByte(0x144a8, 0);
  state.setByte(0x144ad, 0);
  check("validateSpecialSlots: a freed alien slot passes again whatever its leftover fields", validateSpecialSlots(state) === null);
  state.setByte(0x1449c, 0x15);
  state.setByte(0x1449d, 99); state.setByte(0x1449e, 74); state.setByte(0x144a2, 0x78);
  check("validateSpecialSlots: a fresh meteor (countdown $78) on the last cell is accepted", validateSpecialSlots(state) === null);
  state.setByte(0x144a2, 4);
  check("validateSpecialSlots: a meteor one pass from impact (countdown 4) is accepted", validateSpecialSlots(state) === null);
  const meteorCases = [
    ["an unknown type at $1449C", () => state.setByte(0x1449c, 0x16), /type \$16/],
    ["a meteor x outside the map", () => { state.setByte(0x1449c, 0x15); state.setByte(0x1449d, 100); }, /position/],
    ["a meteor y outside the map", () => { state.setByte(0x1449d, 5); state.setByte(0x1449e, 75); }, /position/],
    ["a meteor frame other than 0", () => { state.setByte(0x1449e, 5); state.setByte(0x144a1, 1); }, /frame/],
    ["a meteor countdown above $78", () => { state.setByte(0x144a1, 0); state.setByte(0x144a2, 0x7c); }, /countdown/],
    ["a meteor countdown that is not a multiple of 4", () => state.setByte(0x144a2, 6), /countdown/],
    ["a meteor countdown of 0 (impact clears the record in the same pass)", () => state.setByte(0x144a2, 0), /countdown/],
  ];
  for (const [label, mutate, pattern] of meteorCases) {
    const e = special(mutate);
    check(`validateSpecialSlots: ${label} is rejected as special-state`, e?.code === "special-state" && pattern.test(e.message), e ? e.message : "accepted");
  }
}

// ---- 2. scene and Game activation with the user's own data ------------------------------------------------------------
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("scene activation checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
} else {
  const { readScenarioRecords, readScenarioDiskId, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
  const { loadSprites } = await import("../dist/data/sprites.js");
  const { loadCombatTables } = await import("../dist/data/combat.js");
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const { MapScene } = await import("../dist/game/map.js");
  const { Game, describeDisk4Error } = await import("../dist/game/game.js");
  const { identifyDisk4Scenario } = await import("../dist/data/disk4-scenario.js");

  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const records = readScenarioRecords(disk2);
  const record = records[0];
  const realTables = loadCombatTables(disk1);
  const strings = new GameStrings(disk1, 0);
  const tiles = loadTileSet(disk1, disk2, record).tiles;
  const sprites = loadSprites(disk1, disk2, record);

  // The new-game world of scenario 0 is the base of every image: state block, map words, object records.
  const baseState = new GameState(disk2, record.block);
  const baseWorld = new World(baseState, loadMap(disk2, record));
  const baseImage = baseState.snapshot();
  const baseCells = baseWorld.cells.slice();
  const baseObjects = baseWorld.objects.slice();

  const sceneImage = (mutateA, mutateB, cells = baseCells, metadata = {}) =>
    makeImage((a) => {
      for (let y = 0; y < 75; y++) for (let x = 0; x < 100; x++) setWordCell(a, x, y, cells[y * 100 + x]);
      a.set(baseObjects, offA(DISK4_ADDR.objects));
      putTank(a, 3, { x: 50, y: 40 });
      putEnemy(a, "enemyGround", 5, { type: 22, x: 60, y: 50 });
      mutateA?.(a);
    }, (b) => {
      b.set(baseImage);
      // Disk.4's loader reads the saved disk id ($1453E) and scenario index ($135C2) before loading graphics.
      put16(b, offB(0x1453e), metadata.diskId ?? readScenarioDiskId(disk2));
      put16(b, offB(0x135c2), metadata.scenarioIndex ?? record.index);
      for (let i = 0; i < 8; i++) b[offB(0x14540 + 10 * i + 2)] = 0xff;
      mutateB?.(b);
    });
  const prepare = (img, over = {}) => {
    const rngCalls = { n: 0 };
    const r = prepareDisk4HeadlessEnemies(img, request(), realTables, { rng: () => { rngCalls.n++; return 0; }, ...over });
    if (!r.ok) throw new Error(`preparation failed: ${JSON.stringify(r.error)}`);
    return { v: r.value, rngCalls };
  };
  const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  // Input is polled once per main-loop pass (4 video updates by default): run one whole pass with this input.
  const runPass = (scene, inp) => { for (let i = 0; i < scene.loop.vblPerPass; i++) scene.update(inp); };

  // ---- 2a. MapScene.fromPrepared
  {
    const img = sceneImage(undefined, (b) => {
      put16(b, offB(0x144e4), 30); put16(b, offB(0x144e6), 20);
      b[offB(0x14540 + 1)] = 10; b[offB(0x14540 + 2)] = 20; // pin 1
      b[offB(0x14540 + 40 + 1)] = 99; b[offB(0x14540 + 40 + 2)] = 74; // pin 5
    });
    const { v, rngCalls } = prepare(img);
    const noSpriteBefore = captureGraph(v);
    const noSprites = MapScene.fromPrepared(disk1, tiles, v, strings, {});
    check("fromPrepared: refuses without sprite sheets without claiming or mutating the graph",
      !noSprites.ok && noSprites.error.code === "sprites-required" && graphUnchanged(v, noSpriteBefore));

    const stateBefore = v.state.snapshot();
    const cellsBefore = v.world.cells.slice();
    const flagsBefore = v.world.cellFlags.slice();
    const objectsBefore = v.world.objects.slice();
    const tank = v.tanks.slots[3];
    const groundEnemy = v.enemySystem.groundSlots[5];
    const clockSub = v.tanks.clock.sub;
    let selectedCells = 0;
    const sceneSounds = [];
    const result = MapScene.fromPrepared(disk1, tiles, v, strings, { sprites, onSelect: () => { selectedCells++; }, sfx: (id, volume) => sceneSounds.push({ id, volume }) });
    check("fromPrepared: builds a scene from the prepared graph", result.ok, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) throw new Error("scene failed");
    const scene = result.value;
    check("fromPrepared: keeps the prepared identities", scene.world === v.world && scene.sim === v.sim && scene.objects.units === v.tanks && scene.enemies === v.enemySystem && scene.restoredFromDisk4);
    check("fromPrepared: tank and enemy objects and slots are the prepared ones", v.tanks.slots[3] === tank && scene.objects.units.slots[3] === tank && v.enemySystem.groundSlots[5] === groundEnemy && v.tanks.clock.sub === clockSub);
    check("fromPrepared: construction and the first frame write no saved byte and use no RNG",
      sameBytes(v.state.snapshot(), stateBefore) && sameBytes(v.world.cells, cellsBefore) && sameBytes(v.world.cellFlags, flagsBefore) && sameBytes(v.world.objects, objectsBefore) && rngCalls.n === 0);
    check("fromPrepared: view origin comes from $144E4/$144E6", scene.scrollX === 30 && scene.scrollY === 20 && result.view.x === 30 && !result.view.clamped);
    check("fromPrepared: pins restored from the marker records (raw state retained)",
      scene.objects.markerCell(1)?.x === 10 && scene.objects.markerCell(1)?.y === 20 && scene.objects.markerCell(5)?.x === 99 && scene.objects.markerCell(2) === null &&
      v.state.byte(0x14540 + 1) === 10);
    check("fromPrepared: the initial map frame is drawn over the title backdrop",
      scene.screen.pixels.some((p, i) => p !== scene.background[i]));
    runPass(scene, { leftButton: true, rightButton: false, pointerX: 112, pointerY: 25, keys: [] });
    check("fromPrepared: a held slot-selection click is consumed before it can select a map cell", selectedCells === 0);
    runPass(scene, input); // release clears the barrier before subsequent input
    runPass(scene, { leftButton: true, rightButton: false, pointerX: 112, pointerY: 25, keys: [] });
    check("fromPrepared: the same map cell can be selected after the held click is released", selectedCells === 1);
    runPass(scene, input);
    const again = MapScene.fromPrepared(disk1, tiles, v, strings, { sprites });
    check("fromPrepared: a graph drives only one scene (already-activated)", !again.ok && again.error.code === "already-activated");

    // Callbacks are bound: interactive offers, enemy explosions through the scene's effect layer.
    v.state.setWord(0x1429c, 20);
    v.state.setLong(A.money, 100000);
    v.sim.eventTankRequisition(100);
    check("fromPrepared: Sim callbacks are bound (interactive offer pending)", v.sim.pending !== null);
    v.sim.pending = null;
    // The saved view is (30,20) and this fixture enemy is at (60,50): the original $1237C off-view path is
    // sound-only. Move the viewport for this callback check so the in-view effect allocation is exercised.
    const savedView = [scene.scrollX, scene.scrollY];
    scene.scrollX = groundEnemy.x;
    scene.scrollY = groundEnemy.y;
    v.enemySystem.destroyGround(groundEnemy, true);
    check("fromPrepared: EnemySystem callbacks are bound (in-view ground explosion effect uses lift-selected type $12)",
      scene.objects.effects.length === 1 && scene.objects.effects[0].type === 0x12 && sceneSounds.at(-1)?.volume === 64);
    scene.scrollX = savedView[0];
    scene.scrollY = savedView[1];

    const findClearCell = (offView = false) => {
      for (let y = 4; y < 72; y++) for (let x = 4; x < 96; x++) {
        if (offView && x >= savedView[0] && x < savedView[0] + 8 && y >= savedView[1] && y < savedView[1] + 8) continue;
        const idx = y * 100 + x;
        if ((v.world.cells[idx] & 0x7000) === 0 && v.world.cellFlags[cellFlagIndex(x, y)] === 0) return { x, y, idx };
      }
      throw new Error("no free cell for effect-path check");
    };
    const spawnAt = (air, cell) => {
      const type = air ? 25 : 22;
      const ok = v.enemySystem.spawn({ air, type, level: 1, x: cell.x, y: cell.y, dir: 0, entry: [type, 6, 0, 3, 1, 0, 50, 0] });
      if (!ok) throw new Error(`could not stage ${air ? "air" : "ground"} effect-path enemy`);
      return (air ? v.enemySystem.airSlots : v.enemySystem.groundSlots).find((e) => e && e.x === cell.x && e.y === cell.y);
    };

    const airCell = findClearCell();
    const airEnemy = spawnAt(true, airCell);
    airEnemy.lift = 0x22;
    const beforeAirEffect = scene.objects.effects.length;
    scene.scrollX = airCell.x;
    scene.scrollY = airCell.y;
    v.enemySystem.destroyAir(airEnemy, true);
    check("fromPrepared: in-view airborne explosion uses lift-selected type $14 and leaves the air map bit",
      scene.objects.effects.length === beforeAirEffect + 1 && scene.objects.effects.at(-1).type === 0x14 && scene.objects.effects.at(-1).lift === 0x22 &&
      (v.world.cells[airCell.idx] & 0x2000) !== 0 && (v.world.cellFlags[cellFlagIndex(airCell.x, airCell.y)] & 2) === 0 && sceneSounds.at(-1)?.volume === 64);

    const fullCell = findClearCell();
    const fullEnemy = spawnAt(false, fullCell);
    while (scene.objects.pool.count < 30) scene.objects.spawnEffect(0x12, fullCell.x, fullCell.y); // fixed slots: first free slot each time
    scene.scrollX = fullCell.x;
    scene.scrollY = fullCell.y;
    const beforeFullSounds = sceneSounds.length;
    v.enemySystem.destroyGround(fullEnemy, true);
    check("fromPrepared: an in-view full effect list adds no sprite or sound and clears both map and flag bits",
      scene.objects.effects.length === 30 && sceneSounds.length === beforeFullSounds && (v.world.cells[fullCell.idx] & 0x4000) === 0 &&
      (v.world.cellFlags[cellFlagIndex(fullCell.x, fullCell.y)] & 1) === 0);

    const outsideCell = findClearCell(true);
    const outsideEnemy = spawnAt(false, outsideCell);
    scene.scrollX = savedView[0];
    scene.scrollY = savedView[1];
    const beforeOutsideSounds = sceneSounds.length;
    v.enemySystem.destroyGround(outsideEnemy, true);
    check("fromPrepared: an off-view blast is sound-only and leaves the map bit even when the effect list is full",
      scene.objects.effects.length === 30 && sceneSounds.length === beforeOutsideSounds + 1 && sceneSounds.at(-1).volume === 32 &&
      (v.world.cells[outsideCell.idx] & 0x4000) !== 0 && (v.world.cellFlags[cellFlagIndex(outsideCell.x, outsideCell.y)] & 1) === 0);
    const countdownBefore = v.state.byte(A.frameCountdown);
    let threw = null, updates = 0;
    try { for (; updates < 200; updates++) scene.update(input); } catch (e) { threw = e; }
    check("fromPrepared: 200 map updates complete and saved simulation time advances", threw === null && updates === 200 && v.state.byte(A.frameCountdown) !== countdownBefore, threw ? String(threw) : `updates=${updates}`);
  }

  // ---- 2b. refusals
  {
    const clampImg = sceneImage(undefined, (b) => { put16(b, offB(0x144e4), 200); put16(b, offB(0x144e6), 90); });
    const { v } = prepare(clampImg);
    const r = MapScene.fromPrepared(disk1, tiles, v, strings, { sprites });
    check("fromPrepared: an out-of-range saved view is clamped for display only", r.ok && r.value.scrollX === 92 && r.value.scrollY === 67 && r.view.clamped && v.state.word(0x144e4) === 200);

    const refuse = (mutateB) => {
      const { v: g } = prepare(sceneImage(undefined, mutateB));
      const before = captureGraph(g);
      const res = MapScene.fromPrepared(disk1, tiles, g, strings, { sprites });
      return { res, untouched: graphUnchanged(g, before), g };
    };
    // Malformed active special records are refused with the typed "special-state" error, before any scene exists.
    const badSpecial = [
      ["an unknown record type at $144A8", (b) => { b[offB(0x144a8)] = 0x14; }],
      ["an alien outside the map", (b) => { b[offB(0x144a8)] = 0x13; b[offB(0x144a9)] = 100; }],
      ["an alien phase word above 10", (b) => { b[offB(0x144a8)] = 0x13; put16(b, offB(0x144a4), 11); }],
      ["an alien frame above 3", (b) => { b[offB(0x144a8)] = 0x13; b[offB(0x144ad)] = 4; }],
      ["an unknown record type at $1449C", (b) => { b[offB(0x1449c)] = 0x16; }],
      ["a meteor outside the map", (b) => { b[offB(0x1449c)] = 0x15; b[offB(0x1449e)] = 75; b[offB(0x144a2)] = 0x78; }],
      ["a meteor with a non-zero frame", (b) => { b[offB(0x1449c)] = 0x15; b[offB(0x144a1)] = 2; b[offB(0x144a2)] = 0x78; }],
      ["a meteor countdown off the 4-step grid", (b) => { b[offB(0x1449c)] = 0x15; b[offB(0x144a2)] = 0x77; }],
      ["an active meteor with countdown 0", (b) => { b[offB(0x1449c)] = 0x15; b[offB(0x144a2)] = 0; }],
    ];
    for (const [label, mutate] of badSpecial) {
      const r = refuse(mutate);
      check(`fromPrepared: ${label} is refused as special-state without touching the graph`, !r.res.ok && r.res.error.code === "special-state" && r.untouched);
    }
    {
      const r = refuse((b) => { b[offB(0x1449c)] = 0x15; b[offB(0x144a2)] = 6; });
      r.g.state.setByte(0x144a2, 8);
      const retry = MapScene.fromPrepared(disk1, tiles, r.g, strings, { sprites });
      check("fromPrepared: a special-state refusal leaves the graph unclaimed (the repaired graph then activates)", retry.ok, retry.ok ? "" : JSON.stringify(retry.error));
    }

    // Valid active records are accepted: construction and the first draw are inert, the runtime handles are hydrated
    // from the saved bytes, and the drawable adapters see the same bytes.
    {
      const { v, rngCalls } = prepare(sceneImage(undefined, (b) => {
        b[offB(0x144a8)] = 0x13; b[offB(0x144a9)] = 31; b[offB(0x144aa)] = 21; b[offB(0x144ab)] = 0xfe; b[offB(0x144ac)] = 3; b[offB(0x144ad)] = 2;
        put16(b, offB(0x144a4), 6);
        b[offB(0x1449c)] = 0x15; b[offB(0x1449d)] = 33; b[offB(0x1449e)] = 22; b[offB(0x1449f)] = 0; b[offB(0x144a0)] = 0; b[offB(0x144a1)] = 0; b[offB(0x144a2)] = 0x40;
      }));
      const before = captureGraph(v);
      const clock = v.tanks.clock.sub;
      const res = MapScene.fromPrepared(disk1, tiles, v, strings, { sprites });
      check("fromPrepared: valid active alien and meteor records are accepted", res.ok, res.ok ? "" : JSON.stringify(res.error));
      if (!res.ok) throw new Error("active special scene failed");
      const sc = res.value;
      check("fromPrepared: activation with active special records is inert (same saved bytes, no RNG, no clock tick, same slots)",
        graphUnchanged(v, before) && rngCalls.n === 0 && v.tanks.clock.sub === clock);
      const alienRef = v.sim.aliens.alien;
      const meteorRef = v.sim.aliens.meteor;
      check("fromPrepared: Aliens handles are hydrated from the saved bytes", alienRef?.x === 31 && alienRef?.y === 21 && meteorRef?.x === 33 && meteorRef?.y === 22 && meteorRef?.timer === 0x40);
      const apparition = sc.objects.apparition();
      const falling = sc.objects.meteor();
      check("fromPrepared: the drawable adapters read the saved records", apparition?.x === 31 && apparition?.y === 21 && apparition?.frame === 2 && falling?.x === 33 && falling?.y === 22 && falling?.lift === 0x40);
      runPass(sc, input);
      check("fromPrepared: the next main-loop pass advances the hydrated alien phase ($144A4 6 -> 7, frame 3) and meteor countdown ($40 -> $3C)",
        v.state.word(0x144a4) === 7 && v.state.byte(0x144ad) === 3 && v.state.byte(0x144a2) === 0x3c && v.sim.aliens.meteor?.timer === 0x3c);
    }

    // A restored meteor one step from impact is released by the same traced step (record freed, handle cleared).
    {
      const { v } = prepare(sceneImage(undefined, (b) => { b[offB(0x1449c)] = 0x15; b[offB(0x1449d)] = 5; b[offB(0x1449e)] = 5; b[offB(0x144a2)] = 4; }));
      const res = MapScene.fromPrepared(disk1, tiles, v, strings, { sprites });
      check("fromPrepared: a meteor with countdown 4 is accepted", res.ok && v.sim.aliens.meteor?.timer === 4);
      if (res.ok) {
        runPass(res.value, input);
        check("fromPrepared: the hydrated meteor impacts on the next pass and frees its record", v.sim.aliens.meteor === null && v.state.byte(0x1449c) === 0);
      }
    }
    const pin = refuse((b) => { b[offB(0x14540 + 20 + 1)] = 5; b[offB(0x14540 + 20 + 2)] = 80; });
    check("fromPrepared: a saved pin outside the map is refused (pin 3)", !pin.res.ok && pin.res.error.code === "marker-record" && pin.res.error.marker === 2 && pin.untouched);
    // a refusal does not claim the graph: after repairing the saved byte the same graph still activates
    pin.g.state.setByte(0x14540 + 20 + 2, 0xff);
    const retry = MapScene.fromPrepared(disk1, tiles, pin.g, strings, { sprites });
    check("fromPrepared: a refusal leaves the graph unclaimed (a repaired graph then activates)", retry.ok, retry.ok ? "" : JSON.stringify(retry.error));
  }

  // ---- 2c. Game.activateDisk4
  {
    const game = new Game(disk1, disk2);
    const img = sceneImage();
    const early = game.activateDisk4({ bytes: img, slot: SLOT });
    check("Game.activateDisk4: not ready before the language is chosen", !early.ok && early.error.stage === "not-ready" && game.lastDisk4Error?.stage === "not-ready");
    // The test jumps straight to the scenario menu stage (private fields are plain properties at runtime).
    game.strings = strings;
    game.stage = "scenario";
    const expected = identifyDisk4Scenario(baseCells, disk2);
    check("scenario-0 fixture independently identifies as scenario 0", expected.ok && expected.value.status === "identified" && expected.value.scenario === 0);
    const inputBeforeActivation = img.slice();
    const first = game.activateDisk4({ bytes: img, slot: SLOT, source: "synthetic" });
    check("Game.activateDisk4: saved metadata selects scenario 0", first.ok && first.value.scenario === 0 && first.value.scenarioBy === "saved" &&
      first.value.savedMetadata.diskId === readScenarioDiskId(disk2) && first.value.savedMetadata.scenarioIndex === 0 && first.value.name === "SYNTH" &&
      first.value.sourceLabel === "synthetic", JSON.stringify(first.ok ? first.value : first.error));
    const forced = game.activateDisk4({ bytes: img, slot: SLOT, recoverScenario: 0 });
    check("Game.activateDisk4: a recovery choice equal to valid saved metadata leaves it authoritative", forced.ok && forced.value.scenario === 0 &&
      forced.value.scenarioBy === "saved" && game.importedDisk4 === forced.value);
    const scene = game.map;
    check("Game.activateDisk4: commits a restored scene and shows its screen", scene !== null && scene.restoredFromDisk4 && game.stage === "map" && game.screen === scene.screen && game.menu === null);
    check("Game.activateDisk4: applies the traced reset to runtime flags and starts with empty effects", scene.sim.initialization === "snapshot" &&
      scene.sim.sysFlags === 0 && !scene.sim.paused && scene.sim.dayQueued && scene.sim.alerts.flags.every((v) => v === 0) &&
      scene.objects?.pool.slots.every((slot) => slot === null));
    check("Game.activateDisk4: metadata, preparation and load reset never modify the source Disk.4 bytes",
      sameBytes(img, inputBeforeActivation));
    check("Game.activateDisk4: runtime state carries the selected scenario-header pointer from the original load path",
      scene.state.long(0x1453a) === 0x8f96 + first.value.scenario * 0x40);

    game.openRemakeMenu();
    check("remake submenu: Save is disabled for an imported session", game.menu.entries[0].enabled === false && /DISK\.4/.test(game.menu.entries[0].label));
    game.menu = null; game.stage = "map";

    // Music: activation neither starts nor stops anything. The original load path has no music code (the only caller of the
    // track loader $110A is the music-select handler $8A42), so the selected track and the playing module are left alone.
    {
      const played = [];
      const music = { trackCount: 4, current: 2, active: true, setActive() { return false; }, play(t) { played.push(t); if (t >= 0 && t < 4) music.current = t; }, stop() { music.current = -1; }, fadeOut() {}, setVolume() {}, setChannelMuted() {}, resume() {}, title: () => "", dispose() {} };
      const mgame = new Game(disk1, disk2, music, null);
      mgame.strings = strings;
      mgame.stage = "scenario";
      const res = mgame.activateDisk4({ bytes: img, slot: SLOT });
      check("Game.activateDisk4: the playing track continues untouched (no play call)", res.ok && music.current === 2 && played.length === 0);
      music.stop();
      const res2 = mgame.activateDisk4({ bytes: img, slot: SLOT });
      check("Game.activateDisk4: with nothing playing it stays silent (no default track is started)", res2.ok && music.current === -1 && played.length === 0);
    }

    // Failures keep the active scene and session.
    const previous = captureGraph(scene);
    const crusher = sceneImage((a) => { putEnemy(a, "enemyGround", 7, { type: 24, x: 62, y: 52 }); a[enemyAt("enemyGround", 7) + 0x13] = 0x0c; });
    const bad = game.activateDisk4({ bytes: crusher, slot: SLOT, scenario: 0 });
    check("Game.activateDisk4: a crusher with counter 12 is rejected as unsupported-state", !bad.ok && bad.error.stage === "prepare" && bad.error.error.stage === "enemy-system" && bad.error.error.error.code === "unsupported-state" && bad.error.error.error.reason === "crusher-counter");
    check("Game.activateDisk4: a failure preserves the previous scene, graph and session", game.map === scene && game.importedDisk4 === forced.value && game.stage === "map" && game.lastDisk4Error === bad.error && graphUnchanged(scene, previous));
    const beforeBadScenario = captureGraph(scene);
    const badScenario = game.activateDisk4({ bytes: img, slot: SLOT, recoverScenario: 99 });
    check("Game.activateDisk4: an out-of-range recovery choice returns a typed metadata error without mutating the scene", !badScenario.ok &&
      badScenario.error.stage === "metadata" && badScenario.error.error.code === "recovery-index" && graphUnchanged(scene, beforeBadScenario));
    const beforeBadSlot = captureGraph(scene);
    const previousMapBeforeBadSlot = game.map;
    const previousSessionBeforeBadSlot = game.importedDisk4;
    const previousStageBeforeBadSlot = game.stage;
    const previousErrorBeforeBadSlot = game.lastDisk4Error;
    const badSlot = game.activateDisk4({ bytes: img, slot: 0, scenario: 0 });
    check("Game.activateDisk4: an EMPTY slot returns the typed slot-empty error", !badSlot.ok && badSlot.error.stage === "inspect" &&
      badSlot.error.error.stage === "slot" && badSlot.error.error.error.code === "slot-empty");
    check("Game.activateDisk4: EMPTY-slot refusal preserves the active scene and session", game.map === previousMapBeforeBadSlot && game.importedDisk4 === previousSessionBeforeBadSlot && game.stage === previousStageBeforeBadSlot && game.lastDisk4Error === badSlot.error && previousErrorBeforeBadSlot !== badSlot.error && graphUnchanged(scene, beforeBadSlot));

    // Valid saved metadata wins even if the mutable map looks like no scenario.
    const blank = new Uint16Array(7500).fill(0x3ff);
    const metadataGame = new Game(disk1, disk2);
    metadataGame.strings = strings; metadataGame.stage = "scenario";
    const editedMap = metadataGame.activateDisk4({ bytes: sceneImage(undefined, undefined, blank), slot: SLOT });
    check("Game.activateDisk4: valid saved scenario metadata wins when the mutable map matches no scenario",
      editedMap.ok && editedMap.value.scenario === 0 && editedMap.value.scenarioBy === "saved");

    // Only an invalid saved index enters the deliberate recovery flow; map ranking remains advisory.
    const invalidMetadataImage = sceneImage(undefined, undefined, blank, { scenarioIndex: 0xffff });
    const unclear = game.activateDisk4({ bytes: invalidMetadataImage, slot: SLOT });
    check("Game.activateDisk4: invalid saved index returns typed recovery error with advisory candidates",
      !unclear.ok && unclear.error.stage === "metadata" && unclear.error.error.code === "scenario-index" &&
      unclear.error.candidates?.length === records.length && game.map === scene);
    const chosen = game.activateDisk4({ bytes: invalidMetadataImage, slot: SLOT, recoverScenario: 3 });
    check("Game.activateDisk4: explicit recovery resolves only the invalid saved index",
      chosen.ok && chosen.value.scenario === 3 && chosen.value.scenarioBy === "recovery" && chosen.value.savedMetadata.scenarioIndex === 0xffff && game.map !== scene);
    check("recovery writes the selected header pointer while retaining invalid raw save metadata",
      chosen.ok && game.map.state.long(0x1453a) === 0x8f96 + 3 * 0x40 && game.map.state.word(0x135c2) === 0xffff);

    const beforeConflict = captureGraph(game.map);
    const previousAfterRecovery = game.map;
    const conflicting = game.activateDisk4({ bytes: img, slot: SLOT, recoverScenario: 3 });
    check("Game.activateDisk4: valid saved metadata conflict is refused atomically",
      !conflicting.ok && conflicting.error.stage === "metadata" && conflicting.error.error.code === "scenario-conflict" &&
      game.map === previousAfterRecovery && graphUnchanged(previousAfterRecovery, beforeConflict));
    const wrongDiskImage = sceneImage(undefined, undefined, baseCells, { diskId: (readScenarioDiskId(disk2) + 1) & 0xffff });
    const wrongDisk = game.activateDisk4({ bytes: wrongDiskImage, slot: SLOT, recoverScenario: 3 });
    check("Game.activateDisk4: scenario choice cannot override a mismatching saved disk id",
      !wrongDisk.ok && wrongDisk.error.stage === "metadata" && wrongDisk.error.error.code === "unsupported-disk-id");

    game.startScenario(0);
    check("a new game clears the Disk.4 session (Save is available again)", game.importedDisk4 === null && !game.map.restoredFromDisk4);
  }
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
if (fs.existsSync(disk1Path) && fs.existsSync(disk2Path)) console.log("\nall disk4-scene checks passed");
else console.log("\nall synthetic disk4-scene checks passed; original-data scene checks skipped");
