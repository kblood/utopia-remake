// Remake save (src/game/save-session.ts, src/game/save.ts, Game save/load wiring). Part 1 is fully synthetic (no original
// data): schema, capture, validation, atomic restore, slot storage, legacy handling and continuation round trips over a
// hand-built graph (GameState/World/Sim/UnitSystem/EnemySystem/MainLoop). Part 2 needs the user's Disk.1 / Disk.2 in
// original/utopia-whdload and exercises the Game wiring; it is skipped without them. Run after `npm run build`.
//
// Expected values come from the documented format (notes/formats/remake-save.md) and from the live objects the test builds,
// never from files of the original game. The save is the REMAKE's own record: nothing here touches Disk.4.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A stand-in for localStorage. `failWrites` makes setItem throw like a full quota.
const store = new Map();
let failWrites = false;
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { if (failWrites) throw new Error("QuotaExceededError"); store.set(k, String(v)); },
};

const { GameState, STATE_BYTES, A: ADDR, START_YEAR } = await import("../dist/game/state.js");
const { World, OBJECT_SLOTS, OBJECT_SIZE } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { UnitSystem, Unit, MAX_UNITS } = await import("../dist/game/units.js");
const { EnemySystem, Enemy, ENEMY_AIR_TYPES, MAX_GROUND, MAX_AIR } = await import("../dist/game/enemies.js");
const { MainLoop } = await import("../dist/game/main-loop.js");
const { ObjectLayer } = await import("../dist/game/objects.js");
const { EffectPool } = await import("../dist/game/effect-pool.js");
const { CELL_FLAG_BYTES, cellFlagPointer, resolveCellFlagPointer } = await import("../dist/game/cell-flags.js");
const { isMissile, MAX_SHIPS } = await import("../dist/game/sim-ships.js");
const { SESSION_VERSION, captureSession, restoreSession, validateSession } = await import("../dist/game/save-session.js");
const { SAVE_SLOTS, encodeSave, decodeSave, readSlot, writeSlot, slotSummaries, slotWarning } = await import("../dist/game/save.js");

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`); if (!ok) failed++; };

// ---- a hand-built graph ---------------------------------------------------------------------------------------------------

// Synthetic combat tables (same geometry as test/missile-runtime.mjs): one octant towards the requested bearing.
const tables = {
  spiral: Array.from({ length: 48 }, () => [0, 0]),
  arcs: Array.from({ length: 8 }, () => Array.from({ length: 32 }, () => [0, 0])),
  turn: Array.from({ length: 64 }, (_, k) => { const d = k >> 3, w = k & 7, delta = (w - d + 8) & 7; return d === w ? d : (d + (delta <= 4 ? 1 : 7)) & 7; }),
  crusherAnim: Array(8).fill(0),
};
const enemyHooks = { explode: () => {}, sound: () => {}, buildPad: () => true, buildingHeight: () => 20 };

function make({ vblPerPass, rng } = {}) {
  const state = GameState.fromSnapshot(new Uint8Array(STATE_BYTES)).value;
  const world = World.fromSnapshot(state, { cells: new Uint16Array(7500), cellFlags: new Uint8Array(CELL_FLAG_BYTES), objects: new Uint8Array(OBJECT_SLOTS * OBJECT_SIZE) }).value;
  const sim = Sim.fromSnapshot(world, rng ? { rng } : {});
  const units = new UnitSystem(world.cells, () => 1, {}, world.cellFlags);
  const enemies = new EnemySystem(sim, units, tables, enemyHooks);
  units.bindHooks({ lost: (u) => enemies.tankLeft(u), combat: (u, moveTick) => enemies.tankCombat(u, moveTick) });
  const loop = new MainLoop(vblPerPass);
  const markers = Array.from({ length: 8 }, (_, i) => ({ type: i + 1, x: 0, y: 255 }));
  const scroll = { x: 47, y: 33 };
  const effectPool = new EffectPool(); // the ObjectLayer's 30 fixed effect slots (effect-pool.ts)
  return { world, sim, loop, units, enemies, markers, effectPool, scroll, restoredFromDisk4: false };
}

// The same graph, but with the REAL ObjectLayer (headless: no sprites, no tiles, no drawing) so that the effect pool, `spawnEffect`
// (30 fixed slots, first free slot) and `update()` (the countdown) are the live code. The explosion hook mirrors map.ts `enemyExplosion`:
// inside the 8x8 view a blast takes a free effect slot at the victim's altitude (type $14 when airborne, else $12); with the
// list full it returns false (no sprite, A6 intact: the map occupancy bit is cleared); outside the view it only plays a
// sound (true). Sound is not modelled here.
function makeLayered(options) {
  const state = GameState.fromSnapshot(new Uint8Array(STATE_BYTES)).value;
  const world = World.fromSnapshot(state, { cells: new Uint16Array(7500), cellFlags: new Uint8Array(CELL_FLAG_BYTES), objects: new Uint8Array(OBJECT_SLOTS * OBJECT_SIZE) }).value;
  const sim = Sim.fromSnapshot(world, {});
  const layer = new ObjectLayer({}, [], world.cells, () => {}, () => 1, {}, world.cellFlags);
  const scroll = { x: 40, y: 30 };
  const enemies = new EnemySystem(sim, layer.units, tables, {
    ...enemyHooks,
    explode: (x, y, lift) => {
      const inside = x >= scroll.x && x < scroll.x + 8 && y >= scroll.y && y < scroll.y + 8;
      if (inside && !layer.spawnEffect(lift !== 0 ? 0x14 : 0x12, x, y, lift)) return false;
      return true;
    },
  });
  layer.enemies = enemies;
  layer.units.bindHooks({ lost: (u) => enemies.tankLeft(u), combat: (u, moveTick) => enemies.tankCombat(u, moveTick) });
  return { world, sim, loop: new MainLoop(options?.vblPerPass), units: layer.units, enemies, markers: layer.markers, effectPool: layer.pool, extras: layer.extra, scroll, restoredFromDisk4: false, layer };
}

const ENEMY_ENTRY = [0, 6, 0, 3, 0, 5, 50, 0];
function populate(g) {
  const tanks = [];
  for (let i = 0; i < 5; i++) tanks.push(g.units.spawn(i === 4 ? 10 : 9, 10 + 2 * i, 20));
  g.units.order(tanks[0], 14, 24);
  g.units.order(tanks[2], 3, 20);
  g.units.remove(tanks[1]); // free slot 1
  g.units.remove(tanks[3]); // free slot 3
  for (let n = 0; n < 3; n++) g.units.tick(); // gives the survivors velocity, reservations, recent directions, a sub-tick
  // enemies: ground slots 0, 1, 2 (slot 1 freed later), two aircraft
  for (const [x, y] of [[50, 50], [60, 60], [30, 30]]) {
    if (!g.enemies.spawn({ air: false, type: 22, x, y, dir: 0, entry: ENEMY_ENTRY })) throw new Error("ground spawn failed");
  }
  for (const [x, y] of [[70, 20], [72, 22]]) {
    if (!g.enemies.spawn({ air: true, type: ENEMY_AIR_TYPES[0], x, y, dir: 2, entry: ENEMY_ENTRY })) throw new Error("air spawn failed");
  }
  // ships, then a missile aimed at the enemy in ground slot 2
  for (const [type, x, y] of [[12, 40, 40], [13, 41, 40], [15, 42, 40]]) {
    if (!g.sim.fleet.createShip(type, x, y, 8)) throw new Error("ship failed");
  }
  const t = g.enemies.findTarget(10, 24, 30);
  if (!t || !g.enemies.launchMissile({ x: 24, y: 30 }, t)) throw new Error("missile launch failed");
  g.enemies.pass(g.units.clock); // gives ships and the missile their extras
  g.sim.fleet.createShip(11, 44, 40, 8); // created after the pass: no extra yet (lazy)
  g.enemies.groundSlots[1] = null; // a freed enemy slot between two occupied ones
  g.sim.fleet.slots[1] = null; // a freed ship slot between two occupied ones
  // flags, clocks, lights, aliens, markers, view
  g.world.cellFlags[100] = 0x5a; // a padding column byte is kept too
  g.sim.sysFlags = 0x41;
  g.sim.dayQueued = true;
  g.sim.fleet.fuelWarned = true;
  g.sim.alerts.set(1, true);
  g.sim.alerts.set(3, true);
  g.sim.aliens.alien = { x: 3, y: 4 };
  g.sim.aliens.meteor = { x: 50, y: 40, timer: 0x70 };
  g.markers[2].x = 10; g.markers[2].y = 12;
  g.scroll.x = 20; g.scroll.y = 11;
  g.loop.restoreAt(17);
  g.world.state.setWord(0x142c2, 3);
  g.world.objectCount = 3;
  g.world.objects.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
  return tanks;
}

// One main-loop pass, in the order MapScene.loopPass uses for the parts a synthetic graph has.
function step(g, passes = 1) {
  for (let n = 0; n < passes; n++) {
    for (let v = 0; v < g.loop.vblPerPass; v++) g.loop.vbl();
    g.enemies.frame();
    g.sim.pass();
    g.units.tick();
    g.enemies.pass(g.units.clock);  }
}

const cap = (g, scenario = 2) => { const r = captureSession(g, scenario); if (!r.ok) throw new Error(`capture failed: ${r.error.code} ${r.error.message}`); return r.value; };
const print = (g) => encodeSave(cap(g)); // canonical text of the whole live session
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const slotsOf = (g) => [...g.units.slots, ...g.enemies.groundSlots, ...g.enemies.airSlots, ...g.sim.fleet.slots];
const sameRefs = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

// ---- 1. capture ----------------------------------------------------------------------------------------------------------------

const A = make();
const tanks = populate(A);
const S = cap(A);
check("capture: validates, version constant is 9", validateSession(S) === null && SESSION_VERSION === 9);
check("capture: an object layer with an empty effect pool saves 30 free slots (not null) and no slot assumption", Array.isArray(S.effectSlots) && S.effectSlots.length === 30 && S.effectSlots.every((e) => e === null) && S.effectSlotsAssumed === false);
check("capture: tanks keep their slots, freed slots 1 and 3 are null", S.tanks.length === MAX_UNITS && S.tanks[1] === null && S.tanks[3] === null && S.tanks[0] !== null && S.tanks[2] !== null && S.tanks[4] !== null && S.tanks[4].type === 10 && S.tanks[5] === null);
check("capture: tank fields are the live ones (target, reservation, velocity, control, recent)", S.tanks[0].targetX === 14 && S.tanks[0].targetY === 24 && S.tanks[0].reserveX === tanks[0].reserveX && S.tanks[0].vx === tanks[0].vx && S.tanks[0].control === tanks[0].control && S.tanks[0].recent.join() === tanks[0].recent.join());
check("capture: enemy lists keep slot numbers, the freed ground slot 1 is null", S.enemies.ground.length === MAX_GROUND && S.enemies.air.length === MAX_AIR && S.enemies.ground[0] !== null && S.enemies.ground[1] === null && S.enemies.ground[2] !== null && S.enemies.air[0] !== null && S.enemies.air[1] !== null && S.enemies.air[2] === null);
check("capture: ship list has 40 slots, freed slot 1 is null, a missile is saved as such", S.ships.length === MAX_SHIPS && S.ships[1] === null && S.ships[0].kind === "ship" && S.ships.some((s) => s && s.kind === "missile"));
const missileAt = S.ships.findIndex((s) => s && s.kind === "missile");
check("capture: the missile keeps no class/fuel and follows enemy slot ground/2 by index (a reference, not a copy)", S.ships[missileAt].cls === null && S.ships[missileAt].fuel === null && S.ships[missileAt].extra.target.air === false && S.ships[missileAt].extra.target.index === 2);
check("capture: a ship created after the last pass has no extra yet (lazy default is kept lazy)", S.ships.some((s) => s && s.kind === "ship" && s.extra === null) && S.ships[0].extra !== null);
check("capture: legacy gun-countdown field and remembered launch target ($E904) are saved", typeof S.enemies.lastCountdown === "number" && S.enemies.lastTarget !== null && S.enemies.lastTarget.index === 2 && S.enemies.lastTarget.air === false);
check("capture: cell flags saved byte for byte (own unit / enemy bits and the padding column)", sameBytes(S.cellFlags, A.world.cellFlags) && S.cellFlags[100] === 0x5a && S.cellFlags.some((b) => b !== 0 && b !== 0x5a));
check("capture: map words, object records and the state image saved verbatim; object count kept", sameBytes(S.cells, A.world.cells) && sameBytes(S.objects, A.world.objects) && sameBytes(S.state, A.world.state.snapshot()) && S.world.objectCount === 3 && S.objects[16] === 1);
check("capture: the independent solar-phase RNG state is included", S.world.solarPhaseRng === A.world.solarPhaseRngState);
check("capture: simulation flags, lights, alien, meteor, markers, view and loop position", S.sim.sysFlags === 0x41 && S.sim.dayQueued && S.sim.fuelWarned && S.sim.lights.join() === "0,255,0,255" && S.sim.aliens.alien.x === 3 && S.sim.aliens.meteor.timer === 0x70 &&
  S.markers[2].x === 10 && S.markers[2].y === 12 && S.markers[0].y === 255 && S.scroll.x === 20 && S.scroll.y === 11 && S.loop.vbls === 17 && S.loop.passes === 4 && S.loop.vblPerPass === 4);
check("capture: pass clock and the RNG counter are saved", S.passClock.sub === A.units.clock.sub && S.passClock.moveTick === A.units.clock.moveTick && typeof S.sim.rng === "number");
check("capture: CIA/raster approximation counters are saved separately", S.sim.hardware?.tod === A.sim.hardwareState.tod && S.sim.hardware?.raster === A.sim.hardwareState.raster && S.sim.rng !== S.sim.hardware.tod);
check("capture: scenario index is the caller's", S.scenario === 2);

{ // reads only, shares nothing
  const before = print(A);
  const refs = slotsOf(A);
  const again = cap(A);
  S.cells[0] ^= 0x1111; S.cellFlags[3] ^= 0xff; S.tanks[0].x = 99; S.tanks[0].recent[0] = 1; S.markers[2].x = 99;
  check("capture: reads only (live bytes, slots and counters unchanged)", print(A) === before && sameRefs(slotsOf(A), refs));
  check("capture: the result shares no array or object with the live graph", again.cells !== A.world.cells && again.cellFlags !== A.world.cellFlags && again.tanks[0] !== A.units.slots[0] && A.world.cells[0] !== S.cells[0] && A.units.slots[0].x !== 99 && A.markers[2].x === 10);
  S.cells[0] ^= 0x1111; S.cellFlags[3] ^= 0xff; S.tanks[0].x = again.tanks[0].x; S.tanks[0].recent[0] = again.tanks[0].recent[0]; S.markers[2].x = 10;
  check("capture: the manual mutations of this check were undone", encodeSave(S) === encodeSave(again));
}

// ---- 2. text form ------------------------------------------------------------------------------------------------------------

const text = encodeSave(S);
const parsed = JSON.parse(text);
check("text: JSON with format and version 9, binary parts as base64 strings", parsed.format === "utopia-remake-session" && parsed.version === 9 && typeof parsed.cells === "string" && typeof parsed.cellFlags === "string" && typeof parsed.state === "string" && typeof parsed.objects === "string");
check("text: map words are explicit little-endian (first word's low byte comes first)", (() => { const c = new Uint16Array(7500); c[0] = 0x1234; const t = JSON.parse(encodeSave({ ...S, cells: c })); return atob(t.cells).charCodeAt(0) === 0x34 && atob(t.cells).charCodeAt(1) === 0x12; })());
{
  const back = decodeSave(text);
  check("text: decode returns an equal, validated session (not legacy)", back.ok && !back.legacy && encodeSave(back.save) === text && back.save.cells instanceof Uint16Array && back.save.cellFlags instanceof Uint8Array);
}
check("text: nothing of the original game is stored (only the listed keys)", Object.keys(parsed).sort().join() === "cellFlags,cells,effectSlots,effectSlotsAssumed,enemies,format,loop,markers,objects,passClock,scenario,scroll,ships,sim,state,tanks,version,world");

// ---- 3. restore: occupied / freed slots, references, buffers, flags -------------------------------------------------------------

const B = make();
const bufs = [B.world.cells, B.world.cellFlags, B.world.objects];
const bTank = B.units.spawn(9, 80, 70); // junk that the restore must replace
B.enemies.spawn({ air: false, type: 22, x: 81, y: 70, dir: 0, entry: ENEMY_ENTRY });
B.sim.fleet.createShip(14, 82, 70, 8);
B.markers[5].x = 1; B.markers[5].y = 1;
const restored = restoreSession(S, B);
check("restore: ok", restored.ok, restored.ok ? "" : JSON.stringify(restored.error));
check("restore: the restored session prints exactly like the saved one", print(B) === print(A));
check("restore: future solar phases continue from the saved independent stream", (() => { const left = make(); const right = make(); restoreSession(S, left); restoreSession(S, right); const expected = left.world.nextSolarPhase(); return right.world.nextSolarPhase() === expected; })());
check("restore: hardware approximation continues from the saved counters", (() => { const left = make(); const right = make(); restoreSession(S, left); restoreSession(S, right); return left.sim.todLow() === right.sim.todLow() && left.sim.rasterParity() === right.sim.rasterParity(); })());
check("restore: buffers keep their identity (units, enemies and world still share cells and flags)", B.world.cells === bufs[0] && B.world.cellFlags === bufs[1] && B.world.objects === bufs[2] && B.units.usesBuffers(B.world.cells, B.world.cellFlags) && B.enemies.isComposedOf(B.sim, B.units));
check("restore: occupied tank slots hold new objects, freed slots 1 and 3 are null", B.units.slots[0] !== null && B.units.slots[0] !== A.units.slots[0] && B.units.slots[1] === null && B.units.slots[3] === null && B.units.slots[0].slot === 0 && B.units.slots[2].slot === 2 && B.units.slots[4].type === 10 && B.units.slots[5] === null);
check("restore: the junk tank / enemy / ship that was there is gone", !B.units.slots.includes(bTank) && B.enemies.groundSlots[3] === null && B.markers[5].y === 255);
check("restore: enemy and ship holes stay holes; the next spawn takes the first free slot", B.enemies.groundSlots[1] === null && B.sim.fleet.slots[1] === null && (() => {
  const n = B.units.spawn(9, 90, 60);
  const ok = n !== null && n.slot === 1;
  B.enemies.spawn({ air: false, type: 22, x: 91, y: 60, dir: 0, entry: ENEMY_ENTRY });
  const okEnemy = B.enemies.groundSlots[1] !== null;
  const ship = B.sim.fleet.createShip(11, 92, 60, 8);
  const okShip = B.sim.fleet.slots[1] === ship;
  return ok && okEnemy && okShip;
})());
{
  const C = make();
  restoreSession(S, C);
  const m = C.sim.fleet.slots[missileAt];
  const i = C.enemies.inspectShip(m);
  check("restore: the missile is a launched-shape MissileRecord that follows ground slot 2 and resolves the RESTORED occupant", isMissile(m) && !("sourceRaw" in m) && i.targetSlot.air === false && i.targetSlot.index === 2 && i.targetOccupied === true && C.enemies.groundSlots[2] !== A.enemies.groundSlots[2]);
  check("restore: ship extras (velocity, next, turn, reservation cell) and the ship without extra come back", (() => {
    const orig = A.sim.fleet.slots.map((r) => (r ? A.enemies.inspectShip(r) : "-")).map((x) => JSON.stringify(x));
    const back = C.sim.fleet.slots.map((r) => (r ? C.enemies.inspectShip(r) : "-")).map((x) => JSON.stringify(x));
    return orig.join("|") === back.join("|") && back.includes("null");
  })());
  check("restore: cell flags incl. the padding column, map words, objects, state image and object count", sameBytes(C.world.cellFlags, A.world.cellFlags) && C.world.cellFlags[100] === 0x5a && sameBytes(C.world.cells, A.world.cells) && sameBytes(C.world.objects, A.world.objects) && sameBytes(C.world.state.snapshot(), A.world.state.snapshot()) && C.world.objectCount === 3);
  check("restore: loop position, pass clock, flags, lights, alien, meteor, markers and view", C.loop.vbls === 17 && C.loop.passes === 4 && C.units.clock.sub === A.units.clock.sub && C.units.clock.moveTick === A.units.clock.moveTick && C.sim.sysFlags === 0x41 && C.sim.dayQueued && C.sim.fleet.fuelWarned &&
    C.sim.alerts.lit(1) && C.sim.alerts.lit(3) && !C.sim.alerts.lit(0) && C.sim.aliens.alien.x === 3 && C.sim.aliens.meteor.timer === 0x70 && C.markers[2].x === 10 && C.markers[2].y === 12 && C.scroll.x === 20 && C.scroll.y === 11 && C.sim.rngState === A.sim.rngState);
  check("restore: loop phase continues inside the pass (17 video updates = 4 passes + 1)", (() => { const l = new MainLoop(4); l.restoreAt(17); return [l.vbl(), l.vbl(), l.vbl()].join() === "false,false,true" && l.passes === 5; })());
}

// ---- 4. continuation round trips -----------------------------------------------------------------------------------------------

{
  const X = make();
  populate(X);
  const Y = make();
  restoreSession(cap(X), Y);
  const s0 = print(X);
  step(X, 14);
  step(Y, 14);
  check("continuation: the session actually moved on (not a vacuous comparison)", print(X) !== s0 && X.loop.vbls === 17 + 56);
  check("continuation: a restored copy and the original stay identical after 14 passes (tanks, enemies, ships, missile, flags, state, RNG, clock)", print(X) === print(Y));
  const moved = print(X);
  restoreSession(decodeSave(s0).save, X); // rewind the running graph to the saved moment
  check("continuation: loading into the running graph rewinds it exactly (text of the save)", print(X) === s0);
  step(X, 14);
  check("continuation: after the rewind the same 14 passes lead to the same session again", print(X) === moved);
}

// ---- 5. refusals at capture -------------------------------------------------------------------------------------------------------

{
  const g = make();
  populate(g);
  const ok = captureSession({ ...g, restoredFromDisk4: true }, 0);
  check("capture refuses a Disk.4 continuation scene (typed disk4-session, nothing returned)", !ok.ok && ok.error.code === "disk4-session");
  g.sim.pending = { offer: { what: "tanks", count: 1, price: 1 }, apply: () => {} };
  const off = captureSession(g, 0);
  check("capture refuses while an Earth offer waits (offer-pending: the continuation is a closure)", !off.ok && off.error.code === "offer-pending");
  g.sim.pending = null;
  const keep = g.units.slots[0];
  g.units.slots[0] = new Unit(9, 5, 5, 1, 0, { dx: 0, dy: 0, dir: 0, vx: 0, vy: 0, hp: 9, control: 0xff, targetX: 255, targetY: 255, recent: [255, 255, 255], reserveX: 5, reserveY: 5, raw: new Uint8Array(0x18), address: 1, flagPointer: 1 });
  const tankProv = captureSession(g, 0);
  g.units.slots[0] = keep;
  check("capture refuses a tank with Disk.4 provenance (disk4-provenance)", !tankProv.ok && tankProv.error.code === "disk4-provenance");
  const keepE = g.enemies.groundSlots[0];
  g.enemies.groundSlots[0] = new Enemy(22, 50, 50, 0, 10, 1, 1, false, { slot: 0, raw: new Uint8Array(0x1a), address: 1, flagPointer: 1, control: 5 });
  const enemyProv = captureSession(g, 0);
  g.enemies.groundSlots[0] = keepE;
  check("capture refuses an enemy with Disk.4 provenance (disk4-provenance)", !enemyProv.ok && enemyProv.error.code === "disk4-provenance");
  const keepShip = g.sim.fleet.slots[0];
  g.sim.fleet.slots[0] = { ...keepShip, sourceRaw: new Uint8Array(0x18) };
  const shipProv = captureSession(g, 0);
  g.sim.fleet.slots[0] = keepShip;
  check("capture refuses a ship record with Disk.4 provenance (disk4-provenance)", !shipProv.ok && shipProv.error.code === "disk4-provenance");
  const other = make();
  const wrongGraph = captureSession({ ...g, sim: other.sim }, 0);
  check("capture refuses a graph whose Sim runs over another world (graph)", !wrongGraph.ok && wrongGraph.error.code === "graph");
  check("capture works again once the refusing condition is gone (nothing was changed)", captureSession(g, 0).ok);
  g.units.slots[0].x = 120;
  const outside = captureSession(g, 0);
  g.units.slots[0].x = 10;
  check("capture writes nothing for live state outside the loadable domain (unsupported-state)", !outside.ok && outside.error.code === "unsupported-state");
}

// ---- 6. atomic rejection ----------------------------------------------------------------------------------------------------------

{
  const T = make();
  const junk = T.units.spawn(9, 33, 33);
  T.enemies.spawn({ air: false, type: 22, x: 34, y: 33, dir: 0, entry: ENEMY_ENTRY });
  T.sim.fleet.createShip(12, 35, 33, 8);
  T.markers[1].x = 5; T.markers[1].y = 6;
  T.scroll.x = 7; T.scroll.y = 8;
  const unchanged = (before, refs) => print(T) === before && sameRefs(slotsOf(T), refs) && T.scroll.x === 7 && T.units.slots[0] === junk;
  const before = print(T);
  const refs = slotsOf(T);
  const bad = (name, mutate, code = "invalid", target = T) => {
    const c = structuredClone(S);
    mutate(c);
    const own = validateSession(c);
    const r = restoreSession(c, target);
    check(`atomic: ${name} -> ${code}${own ? "" : " (validateSession accepted it)"}`, !r.ok && r.error.code === code && unchanged(before, refs), r.ok ? "restore succeeded" : `${r.error.code}: ${r.error.message}`);
  };
  bad("state image one byte short", (c) => { c.state = c.state.slice(1); });
  bad("map words one short", (c) => { c.cells = c.cells.slice(1); });
  bad("map words not a Uint16Array", (c) => { c.cells = new Uint8Array(15000); });
  bad("cell flags too long", (c) => { c.cellFlags = new Uint8Array(CELL_FLAG_BYTES + 1); });
  bad("object records too short", (c) => { c.objects = c.objects.slice(8); });
  bad("object count 1001", (c) => { c.world.objectCount = 1001; });
  bad("tank list with 98 slots", (c) => { c.tanks.pop(); });
  bad("tank of type 11", (c) => { c.tanks[0].type = 11; });
  bad("tank outside the map", (c) => { c.tanks[2].x = 100; });
  bad("tank with a two-entry recent list", (c) => { c.tanks[0].recent = [1, 2]; });
  bad("tank with a non-integer hp", (c) => { c.tanks[0].hp = 1.5; });
  bad("ground list holding an aircraft type", (c) => { c.enemies.ground[0].type = ENEMY_AIR_TYPES[0]; });
  bad("air list holding a ground type", (c) => { c.enemies.air[0].type = 22; });
  bad("ground list with 59 slots", (c) => { c.enemies.ground.pop(); });
  bad("air list with 31 slots", (c) => { c.enemies.air.push(null); });
  bad("crusher bits on a walker", (c) => { c.enemies.ground[0].toggle = true; });
  bad("crusher counter 9", (c) => { c.enemies.ground[0].type = 24; c.enemies.ground[0].counter = 9; });
  bad("last launch target pointing past the air list", (c) => { c.enemies.lastTarget = { air: true, index: 30 }; });
  bad("ship list with 39 slots", (c) => { c.ships.pop(); });
  bad("ship class not type - 11", (c) => { c.ships[0].cls = 5; });
  bad("ship that is a missile in disguise (type 17 without kind)", (c) => { c.ships[0].type = 17; });
  bad("missile following ground slot 60", (c) => { c.ships[missileAt].extra.target = { air: false, index: 60 }; });
  bad("missile following air slot 30", (c) => { c.ships[missileAt].extra.target = { air: true, index: 30 }; });
  bad("missile without its target slot", (c) => { c.ships[missileAt].extra = null; });
  bad("missile in mode 3", (c) => { c.ships[missileAt].mode = 3; });
  bad("ordinary ship that follows an enemy slot", (c) => { c.ships[0].extra.target = { air: false, index: 0 }; });
  bad("reservation cell with only one coordinate", (c) => { c.ships[0].extra.rx = -1; c.ships[0].extra.ry = 5; });
  bad("loop pass count exceeds video updates", (c) => { c.loop.passes = c.loop.vbls + 1; });
  bad("move tick on sub-tick 3", (c) => { c.passClock = { sub: 3, moveTick: true, enemyTick: false }; });
  bad("pass clock sub-tick 9", (c) => { c.passClock.sub = 9; });
  bad("view origin outside the map", (c) => { c.scroll.x = 93; });
  bad("negative scenario", (c) => { c.scenario = -1; });
  bad("marker pin on a cell outside the map", (c) => { c.markers[0] = { x: 200, y: 10 }; });
  bad("seven marker pins", (c) => { c.markers.pop(); });
  bad("light value 7", (c) => { c.sim.lights[0] = 7; });
  bad("RNG counter 2^32", (c) => { c.sim.rng = 2 ** 32; });
  bad("spawner cursor $81", (c) => { c.sim.aliens.cursor = 0x81; });
  bad("meteor with timer 0", (c) => { c.sim.aliens.meteor.timer = 0; });
  bad("enemies without tanks", (c) => { c.tanks = null; });
  // valid saves that do not fit the target
  const slow = make({ vblPerPass: 5 });
  const slowBefore = print(slow);
  const slowRes = restoreSession(S, slow);
  check("atomic: a save made with 4 video updates per pass is refused by a scene that runs 5 (mismatch)", !slowRes.ok && slowRes.error.code === "mismatch" && print(slow) === slowBefore);
  const bare = { ...make(), units: null, enemies: null, markers: null, effectPool: null };
  const bareBefore = bare.world.cells.slice();
  const bareRes = restoreSession(S, bare);
  check("atomic: a save with tanks is refused by a scene without object layer (mismatch)", !bareRes.ok && bareRes.error.code === "mismatch" && sameBytes(bare.world.cells, bareBefore) && bare.scroll.x === 47);
  const d4 = make();
  const d4Before = print(d4);
  const d4Res = restoreSession(S, { ...d4, restoredFromDisk4: true });
  check("atomic: a remake save cannot be loaded into a Disk.4 continuation scene (disk4-session)", !d4Res.ok && d4Res.error.code === "disk4-session" && print(d4) === d4Before);
  const custom = make({ rng: () => 0 });
  const customRes = restoreSession(S, custom);
  check("atomic: an RNG counter cannot be loaded into a Sim with a custom generator (mismatch)", !customRes.ok && customRes.error.code === "mismatch" && custom.units.slots.every((s) => s === null));
  const foreign = make();
  const foreignRes = restoreSession(S, { ...foreign, sim: make().sim });
  check("atomic: parts of different worlds are refused (graph)", !foreignRes.ok && foreignRes.error.code === "graph" && foreign.units.slots.every((s) => s === null));
  const notSave = restoreSession({}, T);
  check("atomic: an empty object is refused", !notSave.ok && notSave.error.code === "invalid" && unchanged(before, refs));
  check("atomic: the failed attempts left the target usable (the real save then restores)", restoreSession(S, T).ok && print(T) === print(A));
}

// ---- 7. smaller state that a main scenario would not reach ------------------------------------------------------------------------

{
  const a = make();
  a.units.spawn(9, 12, 12);
  a.sim.paused = true;
  a.sim.aliens.restoreSpawner(5, 0x40);
  a.sim.aliens.meteor = null;
  const s = cap(a);
  const b = make();
  const r = restoreSession(s, b);
  check("small: pause, spawner position and an empty alien/meteor roundtrip", r.ok && b.sim.paused === true && b.sim.aliens.spawner.groupIndex === 5 && b.sim.aliens.spawner.cursor === 0x40 && b.sim.aliens.meteor === null && b.sim.aliens.alien === null);
  check("small: a section without enemies is possible only with its tanks (enemies null + tanks present validates)", (() => { const c = structuredClone(s); c.enemies = null; return validateSession(c) === null; })());
}

// ---- 8. slots (save.ts) ------------------------------------------------------------------------------------------------------------

store.clear();
check("slots: 8 slots, all empty at the start", SAVE_SLOTS === 8 && slotSummaries().every((x) => x === null));
{
  const w = writeSlot(3, S);
  check("slots: write ok", w.ok);
  const rd = readSlot(3);
  check("slots: read returns the same session, not legacy", rd.ok && !rd.legacy && encodeSave(rd.save) === text);
  const sums = slotSummaries();
  check("slots: summary has scenario and a date, other slots stay empty", sums[3].status === "ok" && sums[3].scenario === 2 && /^\d\d\/\d\d\/\d+$/.test(sums[3].date) && sums[3].legacy === false && sums.filter((x) => x === null).length === 7);
  const fresh = make();
  check("slots: a stored save restores into a fresh graph and prints identically", restoreSession(rd.save, fresh).ok && print(fresh) === print(A));
}
{
  const first = store.get("utopia-remake-save-3");
  const badSlot = writeSlot(8, S);
  check("slots: slot 8 and -1 and 1.5 are typed bad-slot errors", !badSlot.ok && badSlot.error.code === "bad-slot" && !writeSlot(-1, S).ok && !readSlot(1.5).ok && readSlot(1.5).error.code === "bad-slot");
  const broken = structuredClone(S);
  broken.tanks[0].type = 11;
  const w = writeSlot(3, broken);
  check("slots: an invalid save is refused before any write (invalid) and the slot is unchanged", !w.ok && w.error.code === "invalid" && store.get("utopia-remake-save-3") === first);
  failWrites = true;
  const q = writeSlot(3, S);
  failWrites = false;
  check("slots: a storage that refuses the write gives write-failed and keeps the old text", !q.ok && q.error.code === "write-failed" && store.get("utopia-remake-save-3") === first);
}
{
  const cases = [
    ["text that is not JSON", "{oops", "corrupt"],
    ["JSON that is not an object", "[1,2]", "corrupt"],
    ["a version-99 save", JSON.stringify({ ...JSON.parse(text), version: 99 }), "unsupported-version"],
    ["a malformed hardware approximation counter", (() => { const j = JSON.parse(text); j.sim.hardware.raster = -1; return JSON.stringify(j); })(), "invalid"],
    ["a version-less object that is not the old format", JSON.stringify({ hello: 1 }), "corrupt"],
    ["wrong format name", JSON.stringify({ ...JSON.parse(text), format: "other" }), "corrupt"],
    ["base64 that is not base64", JSON.stringify({ ...JSON.parse(text), state: "!!!!" }), "corrupt"],
    ["map words of odd length", JSON.stringify({ ...JSON.parse(text), cells: JSON.parse(text).cells.slice(4) }), "invalid"],
    ["a tank of an unknown type", (() => { const j = JSON.parse(text); j.tanks[0].type = 77; return JSON.stringify(j); })(), "invalid"],
    ["a missing section", (() => { const j = JSON.parse(text); delete j.ships; return JSON.stringify(j); })(), "invalid"],
  ];
  for (const [name, body, code] of cases) {
    store.set("utopia-remake-save-5", body);
    const r = readSlot(5);
    const sum = slotSummaries()[5];
    check(`slots: ${name} -> ${code}, never an exception, listed as unusable`, !r.ok && r.error.code === code && sum.status === "unusable" && sum.error.code === code, r.ok ? "read succeeded" : `${r.error.code}: ${r.error.message}`);
  }
  store.delete("utopia-remake-save-5");
  check("slots: an empty slot reads as empty", readSlot(5).error.code === "empty");
}
{
  const b64 = (bytes) => { let t = ""; for (const b of bytes) t += String.fromCharCode(b); return btoa(t); };
  const v4 = JSON.parse(text);
  v4.version = 4;
  delete v4.sim.hardware;
  const decodedV4 = decodeSave(JSON.stringify(v4));
  check("version 4 session migrates with no hardware approximation state and retains solar phase", decodedV4.ok && decodedV4.save.sim.hardware === null && decodedV4.save.world.solarPhaseRng === S.world.solarPhaseRng);
  const v3 = JSON.parse(text);
  v3.version = 3;
  delete v3.world.solarPhaseRng;
  delete v3.sim.hardware;
  const decodedV3 = decodeSave(JSON.stringify(v3));
  check("version 3 save keeps elapsed year and migrates without solar-phase or hardware streams", decodedV3.ok && decodedV3.save.world.solarPhaseRng === null && decodedV3.save.sim.hardware === null && new DataView(decodedV3.save.state.buffer).getUint32(ADDR.year - 0x13034) === new DataView(S.state.buffer).getUint32(ADDR.year - 0x13034));
  check("versions 4 and 3 migrate with an empty effect pool (they never stored effects; lossy assumption flagged)", decodedV4.ok && decodedV3.ok && decodedV4.save.effectSlots.every((e) => e === null) && decodedV3.save.effectSlots.every((e) => e === null) && decodedV4.effectsAssumedEmpty === true && decodedV3.effectsAssumedEmpty === true);
  const old = JSON.parse(text);
  const oldState = Uint8Array.from(atob(old.state), (c) => c.charCodeAt(0));
  new DataView(oldState.buffer).setUint32(ADDR.year - 0x13034, START_YEAR + 4);
  old.state = b64(oldState);
  old.version = 2;
  delete old.sim.hardware;
  const decoded = decodeSave(JSON.stringify(old));
  const restoredState = decoded.ok ? GameState.fromSnapshot(decoded.save.state) : null;
  check("version 2 save converts absolute $142A6 year 2094 to four elapsed years and keeps the displayed date", decoded.ok && !decoded.legacy && new DataView(decoded.save.state.buffer).getUint32(ADDR.year - 0x13034) === 4 && restoredState?.ok && restoredState.value.dateText() === `${String(decoded.save.state[ADDR.day - 0x13034]).padStart(2, "0")}/${String(decoded.save.state[ADDR.month - 0x13034] + 1).padStart(2, "0")}/2094`);
  check("version 2 save migrates with an empty effect pool too (lossy assumption flagged)", decoded.ok && Array.isArray(decoded.save.effectSlots) && decoded.save.effectSlots.every((e) => e === null) && decoded.effectsAssumedEmpty === true);
  oldState.set(new Uint8Array(STATE_BYTES));
  new DataView(oldState.buffer).setUint32(ADDR.year - 0x13034, START_YEAR - 1);
  old.state = b64(oldState);
  const invalid = decodeSave(JSON.stringify(old));
  check("version 2 save with a pre-baseline year is rejected explicitly", !invalid.ok && invalid.error.code === "invalid" && invalid.error.message.includes("$142A6"));
}

// ---- 9. old (version-less) saves ---------------------------------------------------------------------------------------------------

{
  const b64 = (bytes) => { let t = ""; for (const b of bytes) t += String.fromCharCode(b); return btoa(t); };
  const oldState = new Uint8Array(STATE_BYTES);
  new DataView(oldState.buffer).setUint32(ADDR.year - 0x13034, START_YEAR);
  oldState[0x145a0 - 0x13034] = 5; // month 6
  const oldCells = new Uint8Array(15000);
  const oldText = (cells, state = oldState) => JSON.stringify({ scenario: 2, sysFlags: 1, scrollX: 40, scrollY: 30, state: b64(state), cells: b64(cells), objects: b64(new Uint8Array(OBJECT_SLOTS * OBJECT_SIZE)) });
  store.set("utopia-remake-save-6", oldText(oldCells));
  const r = readSlot(6);
  check("legacy: an old save made without units, ships or marks migrates and is flagged legacy", r.ok && r.legacy === true && r.save.scenario === 2 && r.save.scroll.x === 40 && r.save.sim.sysFlags === 1 && r.save.tanks === null && r.save.enemies === null && r.save.ships.every((s) => s === null) && r.save.cellFlags.every((b) => b === 0));
  check("legacy: a version-less save has no object layer, so no effect list (null) and nothing is assumed about effects", r.save.effectSlots === null && r.effectsAssumedEmpty === false && r.effectSlotsAssumed === false);
  const label = slotSummaries()[6];
  check("legacy: the summary says so and keeps the old displayed baseline year", label.status === "ok" && label.legacy === true && label.date === "00/06/2090" && label.scenario === 2 && new DataView(r.save.state.buffer).getUint32(ADDR.year - 0x13034) === 0);
  const target = make();
  junkInto(target);
  const lr = restoreSession(r.save, target);
  check("legacy: it restores (units / enemies / ships start empty, view and flags come from the old save)", lr.ok && target.scroll.x === 40 && target.scroll.y === 30 && target.units.slots.every((s) => s === null) && target.enemies.groundSlots.every((s) => s === null) && target.sim.fleet.slots.every((s) => s === null) && target.markers.every((m) => m.y === 255));
  const marked = new Uint8Array(15000);
  marked[2 * 5 + 1] = 0x40; // cell 5 has the ground-layer mark (bit 14), little-endian
  store.set("utopia-remake-save-6", oldText(marked));
  const m = readSlot(6);
  check("legacy: an old save with a unit mark in the map is rejected (legacy-incomplete), not loaded inconsistent", !m.ok && m.error.code === "legacy-incomplete" && slotSummaries()[6].error.code === "legacy-incomplete");
  const air = new Uint8Array(15000);
  air[2 * 9 + 1] = 0x20;
  store.set("utopia-remake-save-6", oldText(air));
  check("legacy: an air mark is rejected too", readSlot(6).error?.code === "legacy-incomplete");
  const shipsState = new Uint8Array(STATE_BYTES);
  new DataView(shipsState.buffer).setUint32(ADDR.year - 0x13034, START_YEAR);
  shipsState[0x1429e - 0x13034 + 1] = 2;
  store.set("utopia-remake-save-6", oldText(oldCells, shipsState));
  check("legacy: an old save with own ships counted is rejected (legacy-incomplete)", readSlot(6).error?.code === "legacy-incomplete");
  store.set("utopia-remake-save-6", JSON.stringify({ scenario: 2, sysFlags: 1, scrollX: 400, scrollY: 30, state: b64(oldState), cells: b64(oldCells), objects: b64(new Uint8Array(8000)) }));
  check("legacy: an old save with a view outside the map is rejected (invalid)", readSlot(6).error?.code === "invalid");
  store.set("utopia-remake-save-6", JSON.stringify({ scenario: 2, sysFlags: 1, scrollX: 40, scrollY: 30, state: b64(oldState.slice(1)), cells: b64(oldCells), objects: b64(new Uint8Array(8000)) }));
  check("legacy: an old save with a truncated state is rejected (corrupt)", readSlot(6).error?.code === "corrupt");
  store.delete("utopia-remake-save-6");
}
function junkInto(g) {
  g.units.spawn(9, 33, 33);
  g.enemies.spawn({ air: false, type: 22, x: 34, y: 33, dir: 0, entry: ENEMY_ENTRY });
  g.sim.fleet.createShip(12, 35, 33, 8);
  g.markers[1].x = 5; g.markers[1].y = 6;
}

// ---- 9b. effects: the 30 FIXED explosion slots (schema version 8; versions 6 and 7 stored a dense list) -------------------------------------------
// Effects are gameplay-relevant: MapScene.enemyExplosion returns false when all 30 slots are taken, and that outcome decides whether
// a killed enemy's occupancy bit is cleared; the first-free-slot allocation and the slot order also decide the draw-list order of
// effects. Static trace of $1237C/$333A: first free slot, an expiry frees only its slot, survivors keep their index. Everything
// below runs over the real ObjectLayer / EffectPool (headless), no original data.

{
  const NONE = () => Array.from({ length: 30 }, () => null);
  const sameRec = (a, b) => (a === null) === (b === null) && (a === null || (a.type === b.type && a.x === b.x && a.y === b.y && a.frame === b.frame && a.lift === b.lift));
  const eqSlots = (a, b) => a.length === b.length && a.every((e, i) => sameRec(e, b[i])); // 30 fixed slots, holes compared
  const eq = (a, b) => a.length === b.length && a.every((e, i) => sameRec(e, b[i])); // dense lists of records (the `effects` getter)
  const planted = { 0: { type: 0x12, x: 21, y: 12, frame: 4, lift: 0 }, 3: { type: 0x14, x: 22, y: 13, frame: 2, lift: 34 }, 6: { type: 0x12, x: 23, y: 14, frame: 0, lift: 0 }, 17: { type: 0x14, x: 24, y: 15, frame: 3, lift: 127 } };
  const expected = NONE().map((_, i) => (planted[i] ? { ...planted[i] } : null));
  const plant = (g, list = planted) => { for (const [slot, e] of Object.entries(list)) g.effectPool.slots[Number(slot)] = { ...e }; };

  // ---- the pool itself: first free slot, holes, expiry, capacity ----
  {
    const G = makeLayered();
    check("pool: 30 fixed slots, all free at the start, count 0", G.effectPool.slots.length === 30 && G.effectPool.slots.every((s) => s === null) && G.effectPool.count === 0 && G.layer.effects.length === 0 && G.layer.effectSlots === G.effectPool.slots);
    plant(G, { 0: planted[0], 1: planted[3], 3: planted[6] });
    check("pool: a new effect takes the FIRST free slot (the hole at 2), the next one slot 4", G.layer.spawnEffect(0x12, 30, 30) && G.effectPool.slots[2] !== null && G.effectPool.slots[2].x === 30 && G.layer.spawnEffect(0x14, 31, 31, 9) && G.effectPool.slots[4] !== null && G.effectPool.slots[4].lift === 9 && G.effectPool.slots[5] === null && G.effectPool.count === 5);
    G.effectPool.slots[0] = null;
    check("pool: a freed LOWER slot is reused before any later free one", G.layer.spawnEffect(0x12, 32, 32) && G.effectPool.slots[0] !== null && G.effectPool.slots[0].x === 32 && G.effectPool.slots[5] === null);
    check("pool: the effects getter lists occupied slots in ascending slot order", G.layer.effects.map((e) => e.x).join() === "32,22,30,23,31");

    const H = makeLayered();
    plant(H, { 5: { type: 0x12, x: 40, y: 31, frame: 0, lift: 0 }, 6: { type: 0x12, x: 41, y: 31, frame: 3, lift: 0 }, 9: { type: 0x14, x: 42, y: 31, frame: 1, lift: 5 } });
    const keep6 = H.effectPool.slots[6];
    const keep9 = H.effectPool.slots[9];
    H.layer.update();
    check("pool: expiry frees ONLY its own slot; the survivors keep their slot index and identity (no compaction)", H.effectPool.slots[5] === null && H.effectPool.slots[6] === keep6 && H.effectPool.slots[9] === keep9 && keep6.frame === 2 && keep9.frame === 0 && H.effectPool.count === 2);
    H.layer.update();
    check("pool: a second pass frees slot 9 (frame 0 -> -1) and leaves slot 6", H.effectPool.slots[9] === null && H.effectPool.slots[6] === keep6 && keep6.frame === 1);
    H.layer.spawnEffect(0x12, 43, 31);
    check("pool: after those expiries the next spawn reuses the lowest hole (slot 0), not the freed higher ones", H.effectPool.slots[0] !== null && H.effectPool.slots[0].x === 43 && H.effectPool.slots[5] === null);

    const P = makeLayered();
    for (let i = 0; i < 30; i++) P.layer.spawnEffect(0x12, 41 + (i % 5), 31 + (i % 3));
    check("pool capacity: 30 spawns fill every slot, the 31st spawn returns false and changes nothing", P.effectPool.count === 30 && P.effectPool.slots.every((s) => s !== null) && P.layer.spawnEffect(0x12, 45, 35) === false && P.effectPool.count === 30);
    P.effectPool.slots[12] = null;
    check("pool capacity: freeing slot 12 makes room for exactly one effect, which lands in slot 12", P.layer.spawnEffect(0x14, 46, 36, 7) === true && P.effectPool.slots[12].x === 46 && P.effectPool.slots[12].lift === 7 && P.layer.spawnEffect(0x12, 47, 37) === false);
    const sums = P.effectPool.count;
    P.effectPool.assumedSlots = true;
    P.layer.update();
    check("pool: tick keeps the assumption flag while effects remain", P.effectPool.count === sums && P.effectPool.assumedSlots === true);
    for (let i = 0; i < 6; i++) P.layer.update();
    check("pool: the assumption flag clears itself when the pool drains (an empty pool is exact)", P.effectPool.count === 0 && P.effectPool.assumedSlots === false);
  }

  // ---- capture ----
  const E = makeLayered();
  E.units.spawn(9, 10, 20); // something else in the session
  plant(E);
  const liveRefs = [...E.effectPool.slots];
  const SE = cap(E);
  check("effects capture: validates; 30 slots with the live records in THEIR slots and null holes", validateSession(SE) === null && SE.effectSlots.length === 30 && eqSlots(SE.effectSlots, expected) && SE.effectSlots[1] === null && SE.effectSlots[5] === null && SE.effectSlots[17].type === 0x14 && SE.effectSlotsAssumed === false);
  check("effects capture: detached copies (changes on either side do not leak)", SE.effectSlots.every((e, i) => e === null || e !== E.effectPool.slots[i]) && (() => {
    E.effectPool.slots[0].frame = 1; SE.effectSlots[3].x = 99;
    const ok = SE.effectSlots[0].frame === 4 && E.effectPool.slots[3].x === 22;
    E.effectPool.slots[0].frame = 4; SE.effectSlots[3].x = 22;
    return ok;
  })());
  check("effects capture: reads only (same slots, same objects, same fields)", E.effectPool.slots.every((e, i) => e === liveRefs[i]) && eqSlots(E.effectPool.slots, expected));

  // text form
  const textE = encodeSave(SE);
  const jsonE = JSON.parse(textE);
  const backE = decodeSave(textE);
  check("effects text: version 9 JSON carries the 30 slots with null holes, the assumption flag, and no dense `effects` key", jsonE.version === 9 && Array.isArray(jsonE.effectSlots) && jsonE.effectSlots.length === 30 && jsonE.effectSlots[1] === null && jsonE.effectSlots[3].type === 0x14 && jsonE.effectSlots[3].lift === 34 && jsonE.effectSlots[17].frame === 3 && jsonE.effectSlotsAssumed === false && !("effects" in jsonE));
  check("effects text: decode returns an equal validated session, not migrated, no assumption", backE.ok && !backE.legacy && backE.effectsAssumedEmpty === false && backE.effectSlotsAssumed === false && eqSlots(backE.save.effectSlots, expected) && encodeSave(backE.save) === textE);

  // restore: new objects, equal fields, same slots array, holes kept, junk gone
  const F = makeLayered();
  F.effectPool.slots[2] = { type: 0x12, x: 1, y: 2, frame: 3, lift: 0 }; // junk that the restore must replace
  const farr = F.effectPool.slots;
  const rr = restoreSession(backE.save, F);
  check("effects restore: ok; the pool keeps its slots array and holds NEW effect objects with equal fields in the SAME slots", rr.ok && F.effectPool.slots === farr && eqSlots(F.effectPool.slots, expected) && F.effectPool.slots.every((e, i) => e === null || (!E.effectPool.slots.includes(e) && e !== backE.save.effectSlots[i])), rr.ok ? "" : JSON.stringify(rr.error));
  check("effects restore: holes stay holes (the junk slot 2 is free again) and the whole session prints identically", F.effectPool.slots[2] === null && print(F) === print(E));
  const s0 = print(E);
  const frames = [];
  let same = true;
  let identity = true;
  for (let n = 0; n < 6; n++) {
    E.layer.update();
    F.layer.update();
    if (n === 0) identity = E.effectPool.slots[17] !== null && E.effectPool.slots[6] === null && F.effectPool.slots[17] !== null && F.effectPool.slots[6] === null;
    frames.push(E.layer.effects.map((e) => e.frame).join("/"));
    if (print(E) !== print(F)) same = false;
  }
  check("effects continuation: original and reloaded copy stay identical every pass while the counters run down and expire", same && print(E) !== s0 && frames.join("|") === "3/1/2|2/0/1|1/0|0||", frames.join("|"));
  check("effects continuation: the survivor of the first expiry keeps slot 17 on both sides", identity);

  // empty pool vs no object layer
  const SEmpty = cap(makeLayered());
  const bareParts = () => ({ ...make(), units: null, enemies: null, markers: null, effectPool: null });
  const SBare = cap(bareParts());
  check("effects empty vs absent: an empty pool saves 30 nulls and a session without object layer saves null (outer null = no layer)", Array.isArray(SEmpty.effectSlots) && SEmpty.effectSlots.length === 30 && SEmpty.effectSlots.every((e) => e === null) && SBare.effectSlots === null && SBare.tanks === null && JSON.parse(encodeSave(SEmpty)).effectSlots.length === 30 && JSON.parse(encodeSave(SBare)).effectSlots === null && SEmpty.effectSlotsAssumed === false && SBare.effectSlotsAssumed === false);
  check("effects empty vs absent: both survive a text round trip distinguished", (() => { const a = decodeSave(encodeSave(SEmpty)); const b = decodeSave(encodeSave(SBare)); return a.ok && b.ok && Array.isArray(a.save.effectSlots) && a.save.effectSlots.length === 30 && b.save.effectSlots === null; })());
  const J = makeLayered();
  J.units.spawn(9, 5, 5);
  J.effectPool.slots[4] = { type: 0x14, x: 3, y: 4, frame: 1, lift: 9 };
  const rb = restoreSession(SBare, J);
  check("effects absent: a save without object layer clears the target's effects, like tanks and pins", rb.ok && J.effectPool.count === 0 && J.effectPool.slots.length === 30 && J.units.slots.every((s) => s === null));
  const J2 = makeLayered();
  J2.effectPool.slots[4] = { type: 0x14, x: 3, y: 4, frame: 1, lift: 9 };
  check("effects empty: an empty saved pool empties the target's pool", restoreSession(SEmpty, J2).ok && J2.effectPool.count === 0);
  const bareT = bareParts();
  const bareCells = bareT.world.cells.slice();
  const noLayer = restoreSession(SE, bareT);
  check("effects mismatch: a save with an object layer (tanks, pins, effects) is refused by a scene without one", !noLayer.ok && noLayer.error.code === "mismatch" && sameBytes(bareT.world.cells, bareCells) && restoreSession(SBare, bareT).ok);
  const gr1 = captureSession({ ...make(), effectPool: null }, 0);
  const gr2 = captureSession({ ...bareParts(), effectPool: new EffectPool() }, 0);
  check("effects graph: an object layer without its effect pool (or the reverse) is refused at capture (graph)", !gr1.ok && gr1.error.code === "graph" && !gr2.ok && gr2.error.code === "graph");

  // untagged extras are outside the traced list and have no saved form: capture refuses instead of losing them
  {
    const X = makeLayered();
    X.layer.extra.push({ type: 9, x: 45, y: 35 });
    const refused = captureSession(X, 0);
    X.layer.extra.length = 0;
    check("extras: capture refuses a non-empty ObjectLayer.extra (unsupported-state, nothing returned) and works again when it is empty", !refused.ok && refused.error.code === "unsupported-state" && /extra/.test(refused.error.message) && captureSession(X, 0).ok);
    check("extras: a scene without an object layer, or an empty list, captures", captureSession({ ...bareParts(), extras: null }, 0).ok && captureSession({ ...makeLayered(), extras: [] }, 0).ok);
  }

  // validation before commit: nothing changes on any refusal
  const T = makeLayered();
  T.units.spawn(9, 33, 33);
  T.effectPool.slots[1] = { type: 0x12, x: 1, y: 2, frame: 3, lift: 0 };
  T.effectPool.slots[8] = { type: 0x14, x: 3, y: 4, frame: 1, lift: 9 };
  const tPrint = print(T);
  const tRefs = [...T.effectPool.slots];
  const tArr = T.effectPool.slots;
  const badFx = (name, mutate, path) => {
    const c = structuredClone(SE);
    mutate(c);
    const own = validateSession(c);
    const r = restoreSession(c, T);
    check(`effects atomic: ${name} -> invalid at ${path}`, own?.code === "invalid" && own.path === path && !r.ok && r.error.code === "invalid" && print(T) === tPrint && T.effectPool.slots === tArr && T.effectPool.slots.length === 30 && T.effectPool.slots.every((e, i) => e === tRefs[i]), own ? own.path : "validateSession accepted it");
  };
  badFx("29 slots", (c) => { c.effectSlots.pop(); }, "effectSlots");
  badFx("31 slots", (c) => { c.effectSlots.push(null); }, "effectSlots");
  badFx("type $13", (c) => { c.effectSlots[3].type = 0x13; }, "effectSlots[3].type");
  badFx("type as a string", (c) => { c.effectSlots[3].type = "18"; }, "effectSlots[3].type");
  badFx("x = 100", (c) => { c.effectSlots[0].x = 100; }, "effectSlots[0].x");
  badFx("x = -1", (c) => { c.effectSlots[0].x = -1; }, "effectSlots[0].x");
  badFx("y = 75", (c) => { c.effectSlots[6].y = 75; }, "effectSlots[6].y");
  badFx("frame 5 (a new effect starts at 4)", (c) => { c.effectSlots[0].frame = 5; }, "effectSlots[0].frame");
  badFx("frame -1 (an expired effect is freed, never kept)", (c) => { c.effectSlots[0].frame = -1; }, "effectSlots[0].frame");
  badFx("frame 1.5", (c) => { c.effectSlots[0].frame = 1.5; }, "effectSlots[0].frame");
  badFx("lift 256", (c) => { c.effectSlots[17].lift = 256; }, "effectSlots[17].lift");
  badFx("lift -129", (c) => { c.effectSlots[17].lift = -129; }, "effectSlots[17].lift");
  badFx("lift as a string", (c) => { c.effectSlots[17].lift = "0"; }, "effectSlots[17].lift");
  badFx("a record that is not an object (a number in a hole)", (c) => { c.effectSlots[1] = 5; }, "effectSlots[1]");
  badFx("undefined in a hole (a sparse JSON slot)", (c) => { c.effectSlots[2] = undefined; }, "effectSlots[2]");
  badFx("effectSlots that is not an array", (c) => { c.effectSlots = {}; }, "effectSlots");
  badFx("effectSlots missing altogether", (c) => { delete c.effectSlots; }, "effectSlots");
  badFx("effectSlots null although the session has tanks (object layer)", (c) => { c.effectSlots = null; }, "effectSlots");
  badFx("the old dense `effects` list is not a version-9 field: effectSlots missing", (c) => { c.effects = c.effectSlots.filter(Boolean); delete c.effectSlots; }, "effectSlots");
  badFx("effect slots without an object layer (no tanks)", (c) => { c.tanks = null; c.enemies = null; c.markers = null; c.ships = new Array(40).fill(null); c.effectSlots = NONE(); }, "effectSlots");
  badFx("assumption flag as a string", (c) => { c.effectSlotsAssumed = "yes"; }, "effectSlotsAssumed");
  badFx("assumption flag missing", (c) => { delete c.effectSlotsAssumed; }, "effectSlotsAssumed");
  badFx("assumption flag true on an empty pool (an empty pool is exact)", (c) => { c.effectSlots = NONE(); c.effectSlotsAssumed = true; }, "effectSlotsAssumed");
  badFx("assumption flag true without an object layer", (c) => { c.tanks = null; c.enemies = null; c.markers = null; c.ships = new Array(40).fill(null); c.effectSlots = null; c.effectSlotsAssumed = true; }, "effectSlotsAssumed");
  const okEdge = structuredClone(SE);
  okEdge.effectSlots = [{ type: 0x12, x: 0, y: 0, frame: 0, lift: -128 }, { type: 0x14, x: 99, y: 74, frame: 4, lift: 255 }, ...Array.from({ length: 28 }, () => ({ type: 0x12, x: 50, y: 40, frame: 2, lift: 0 }))];
  const edgeTarget = makeLayered();
  check("effects domain: 30 full slots, frames 0 and 4, corner cells and the byte extremes of lift are accepted and restore", validateSession(okEdge) === null && restoreSession(okEdge, edgeTarget).ok && edgeTarget.effectPool.count === 30 && eqSlots(edgeTarget.effectPool.slots, okEdge.effectSlots));

  // capture refuses live effects the format could not load back (nothing written)
  const U = makeLayered();
  for (const [name, fx] of [["unknown type", { type: 0x13, x: 5, y: 5, frame: 1, lift: 0 }], ["frame -1", { type: 0x12, x: 5, y: 5, frame: -1, lift: 0 }], ["frame 5", { type: 0x12, x: 5, y: 5, frame: 5, lift: 0 }], ["cell off the map", { type: 0x12, x: 5, y: 75, frame: 1, lift: 0 }]]) {
    U.effectPool.slots[0] = fx;
    const r = captureSession(U, 0);
    U.effectPool.slots[0] = null;
    check(`effects capture refuses ${name} (unsupported-state)`, !r.ok && r.error.code === "unsupported-state" && /effectSlots\[0\]/.test(r.error.message));
  }
  U.effectPool.slots.push({ type: 0x12, x: 5, y: 5, frame: 1, lift: 0 }); // a 31st slot: the layout is fixed at 30
  const tooMany = captureSession(U, 0);
  U.effectPool.slots.pop();
  check("effects capture refuses a pool that grew beyond 30 slots (unsupported-state) and works again on the fixed layout", !tooMany.ok && tooMany.error.code === "unsupported-state" && captureSession(U, 0).ok);

  // the real spawn / countdown stay inside the saved domain
  const Rl = makeLayered();
  Rl.layer.spawnEffect(0x12, 41, 31);
  Rl.layer.spawnEffect(0x14, 42, 32, 20);
  const seen = [];
  const lengths = [];
  let always = true;
  for (let n = 0; n < 6; n++) {
    always = always && captureSession(Rl, 0).ok;
    lengths.push(Rl.effectPool.count);
    for (const e of Rl.layer.effects) seen.push(e.frame);
    Rl.layer.update();
  }
  check("effects domain: frames of the real spawnEffect / update are 0..4 on every pass (each pass captures) and the effect is freed after frame 0", always && Math.min(...seen) === 0 && Math.max(...seen) === 4 && lengths.join() === "2,2,2,2,2,0");

  // a full pool: capacity and refusal are saved with it
  const P = makeLayered();
  for (let i = 0; i < 30; i++) P.layer.spawnEffect(0x12, 41 + (i % 5), 31 + (i % 3));
  const SP = cap(P);
  const Q = makeLayered();
  const full = restoreSession(SP, Q);
  check("effects full pool: 30 effects save and restore; both layers refuse the 31st effect and keep 30", full.ok && SP.effectSlots.every((e) => e !== null) && Q.effectPool.count === 30 && eqSlots(Q.effectPool.slots, P.effectPool.slots) && P.layer.spawnEffect(0x12, 41, 31) === false && Q.layer.spawnEffect(0x12, 41, 31) === false && P.effectPool.count === 30 && Q.effectPool.count === 30);

  // combat continuation: 29 effects -> a combat explosion takes the last free slot; with 30 the next one is refused (map bit cleared)
  const OCC = 0x4000;
  const bit = (g, x, y) => (g.world.cells[y * 100 + x] & OCC) !== 0;
  const stage = (g, holeAt = 29) => {
    g.enemies.spawn({ air: false, type: 22, x: 42, y: 32, dir: 0, entry: ENEMY_ENTRY });
    g.enemies.spawn({ air: false, type: 22, x: 43, y: 33, dir: 0, entry: ENEMY_ENTRY });
    for (let i = 0; i < 30; i++) if (i !== holeAt) g.effectPool.slots[i] = { type: 0x12, x: 41 + (i % 3), y: 31 + (i % 2), frame: 1 + (i % 4), lift: 0 };
  };
  const U1 = makeLayered();
  stage(U1);
  const S29 = cap(U1);
  const R1 = makeLayered();
  const load29 = restoreSession(decodeSave(encodeSave(S29)).save, R1); // through the stored text
  check("effects continuation setup: 29 effects and both enemies (with their occupancy bits) on both sides", load29.ok && U1.effectPool.count === 29 && R1.effectPool.count === 29 && eqSlots(U1.effectPool.slots, R1.effectPool.slots) && bit(U1, 42, 32) && bit(R1, 42, 32) && bit(U1, 43, 33) && bit(R1, 43, 33) && print(U1) === print(R1));
  U1.enemies.destroyGround(U1.enemies.groundSlots[0], true);
  R1.enemies.destroyGround(R1.enemies.groundSlots[0], true);
  check("effects continuation: with 29 effects the combat explosion allocates the last free slot (29; hook true: the bit stays); uninterrupted and reloaded agree", U1.effectPool.count === 30 && R1.effectPool.count === 30 && U1.effectPool.slots[29].frame === 4 && U1.effectPool.slots[29].type === 0x12 && bit(U1, 42, 32) && bit(R1, 42, 32) && eqSlots(U1.effectPool.slots, R1.effectPool.slots) && print(U1) === print(R1));
  const S30 = cap(U1);
  const R2 = makeLayered();
  restoreSession(decodeSave(encodeSave(S30)).save, R2);
  U1.enemies.destroyGround(U1.enemies.groundSlots[1], true);
  R2.enemies.destroyGround(R2.enemies.groundSlots[1], true);
  check("effects continuation: with the pool full the next combat explosion is refused (no effect, hook false: the bit is cleared); uninterrupted and reloaded agree", U1.effectPool.count === 30 && R2.effectPool.count === 30 && !bit(U1, 43, 33) && !bit(R2, 43, 33) && eqSlots(U1.effectPool.slots, R2.effectPool.slots) && print(U1) === print(R2));
  const R0 = makeLayered();
  restoreSession(S30, R0);
  R0.effectPool.slots.fill(null); // what a save that forgot the pool (versions 2..5) would give
  R0.enemies.destroyGround(R0.enemies.groundSlots[1], true);
  check("effects control: dropping the pool changes that outcome (the explosion is allocated and the bit stays), so the pool is saved", R0.effectPool.count === 1 && bit(R0, 43, 33) && print(R0) !== print(U1));
  for (let n = 0; n < 6; n++) {
    U1.layer.update();
    R2.layer.update();
  }
  check("effects continuation: after 6 more passes both pools have expired identically", U1.effectPool.count === 0 && R2.effectPool.count === 0 && print(U1) === print(R2));
  // the same with the one free slot in the MIDDLE: the new effect must land in slot 10 on both sides (a dense list would append)
  const M1 = makeLayered();
  stage(M1, 10);
  const M2 = makeLayered();
  restoreSession(decodeSave(encodeSave(cap(M1))).save, M2);
  M1.enemies.destroyGround(M1.enemies.groundSlots[0], true);
  M2.enemies.destroyGround(M2.enemies.groundSlots[0], true);
  check("effects continuation: the combat explosion fills the free slot in the middle (10), not the end; uninterrupted and reloaded agree", M1.effectPool.slots[10] !== null && M1.effectPool.slots[10].frame === 4 && M2.effectPool.slots[10] !== null && M2.effectPool.slots[10].frame === 4 && eqSlots(M1.effectPool.slots, M2.effectPool.slots) && print(M1) === print(M2));

  // older versions never stored effects: documented lossy assumption (empty pool when an object layer exists)
  const older = (body, version, mutate = () => {}) => {
    const j = JSON.parse(body);
    j.version = version;
    const dense = j.effectSlots === null ? null : j.effectSlots.filter((e) => e !== null); // what versions 6 and 7 wrote
    delete j.effectSlots;
    delete j.effectSlotsAssumed;
    if (version >= 6) j.effects = dense;
    mutate(j);
    return JSON.stringify(j);
  };
  const m5 = decodeSave(older(textE, 5));
  check("effects migration: a version 5 save with an object layer decodes with an EMPTY pool (30 free slots), flagged as a lossy assumption", m5.ok && !m5.legacy && Array.isArray(m5.save.effectSlots) && m5.save.effectSlots.length === 30 && m5.save.effectSlots.every((e) => e === null) && m5.effectsAssumedEmpty === true && m5.effectSlotsAssumed === false && m5.save.tanks !== null);
  check("effects migration: versions 4 and 3 do the same", [4, 3].every((v) => { const r = decodeSave(older(textE, v, (j) => { if (v === 3) delete j.world.solarPhaseRng; delete j.sim.hardware; })); return r.ok && r.save.effectSlots.every((e) => e === null) && r.effectsAssumedEmpty === true; }));
  check("effects migration: an effects key in an older version is not trusted (ignored)", (() => { const r = decodeSave(older(textE, 5, (j) => { j.effects = [{ ...planted[0] }]; })); return r.ok && r.save.effectSlots.every((e) => e === null) && r.effectsAssumedEmpty === true; })());
  const m5bare = decodeSave(older(encodeSave(SBare), 5));
  check("effects migration: an older save without object layer keeps effectSlots null and assumes nothing", m5bare.ok && m5bare.save.effectSlots === null && m5bare.save.tanks === null && m5bare.effectsAssumedEmpty === false && m5bare.effectSlotsAssumed === false);
  store.set("utopia-remake-save-5", older(textE, 5));
  const summary = slotSummaries()[5];
  check("effects migration: slot summary carries the lossy empty-pool warning", summary?.status === "ok" && summary.effectsAssumedEmpty === true);
  store.delete("utopia-remake-save-5");
  const J3 = makeLayered();
  J3.effectPool.slots[4] = { type: 0x12, x: 3, y: 4, frame: 1, lift: 0 };
  check("effects migration: a migrated save restores and empties the target pool (no claim of exact continuation)", m5.ok && restoreSession(m5.save, J3).ok && J3.effectPool.count === 0);

  // ---- version 6 / 7: the dense list converts to slots 0..n-1 with an EXPLICIT, durable assumption ----
  const v7 = decodeSave(older(textE, 7));
  const denseRecords = Object.keys(planted).map(Number).sort((a, b) => a - b).map((k) => planted[k]);
  check("v7 migration: every record is kept, in slots 0..n-1 in list order, the rest free", v7.ok && !v7.legacy && v7.save.effectSlots.length === 30 && eqSlots(v7.save.effectSlots.slice(0, 4), denseRecords) && v7.save.effectSlots.slice(4).every((e) => e === null));
  check("v7 migration: the slot numbers are flagged as an ASSUMPTION (not exact), distinct from the empty-pool assumption", v7.ok && v7.effectSlotsAssumed === true && v7.save.effectSlotsAssumed === true && v7.effectsAssumedEmpty === false && v7.enemyPointersAssumed === false);
  const v6 = decodeSave(older(textE, 6));
  check("v6 migration: the dense list converts the same way and carries the same assumption", v6.ok && v6.effectSlotsAssumed === true && eqSlots(v6.save.effectSlots, v7.save.effectSlots) && v6.effectsAssumedEmpty === false);
  const v7empty = decodeSave(older(encodeSave(SEmpty), 7));
  check("v7 migration: an EMPTY dense list converts cleanly (30 free slots, no warning)", v7empty.ok && v7empty.effectSlotsAssumed === false && v7empty.effectsAssumedEmpty === false && v7empty.save.effectSlotsAssumed === false && v7empty.save.effectSlots.length === 30 && v7empty.save.effectSlots.every((e) => e === null) && slotWarning(v7empty) === "");
  const v7bare = decodeSave(older(encodeSave(SBare), 7));
  check("v7 migration: a session without object layer keeps effectSlots null and assumes nothing", v7bare.ok && v7bare.save.effectSlots === null && v7bare.effectSlotsAssumed === false);
  const v7missing = decodeSave(older(textE, 7, (j) => { delete j.effects; }));
  check("v7 text without its effects section is invalid", !v7missing.ok && v7missing.error.code === "invalid" && /effects/.test(v7missing.error.message));
  const v7nullFx = decodeSave(older(textE, 7, (j) => { j.effects = null; }));
  check("v7 text with effects null although it has an object layer is invalid", !v7nullFx.ok && v7nullFx.error.code === "invalid" && /effects/.test(v7nullFx.error.message));
  const v7many = decodeSave(older(textE, 7, (j) => { j.effects = Array.from({ length: 31 }, () => ({ ...planted[0] })); }));
  check("v7 text with 31 effects is invalid", !v7many.ok && v7many.error.code === "invalid" && /effects/.test(v7many.error.message));
  const v7badRec = decodeSave(older(textE, 7, (j) => { j.effects[0].type = 0x13; }));
  check("v7 text with a malformed record is invalid and names the record", !v7badRec.ok && v7badRec.error.code === "invalid" && /effects\[0\]\.type/.test(v7badRec.error.message));
  const v7nullRec = decodeSave(older(textE, 7, (j) => { j.effects[1] = null; }));
  check("v7 text with a null record in the dense list is invalid (a dense list has no holes)", !v7nullRec.ok && v7nullRec.error.code === "invalid" && /effects\[1\]/.test(v7nullRec.error.message));
  const v7layerless = decodeSave(older(encodeSave(SBare), 7, (j) => { j.effects = []; }));
  check("v7 text with an effect list but no object layer is invalid", !v7layerless.ok && v7layerless.error.code === "invalid" && /effects/.test(v7layerless.error.message));

  // restore of the migrated save: all records live, the warning survives later saves until the pool drains
  const V7 = makeLayered();
  const v7r = v7.ok ? restoreSession(v7.save, V7) : { ok: false };
  check("v7 restore: all four records are live in slots 0..3 and the pool remembers that the slots are assumed", v7r.ok && V7.effectPool.count === 4 && eqSlots(V7.effectPool.slots.slice(0, 4), denseRecords) && V7.effectPool.assumedSlots === true);
  const v7again = cap(V7);
  check("v7 durability: capturing the restored session keeps effectSlotsAssumed = true and the next first-free slot is 4", v7again.effectSlotsAssumed === true && v7again.effectSlots.slice(0, 4).every((e) => e !== null) && V7.layer.spawnEffect(0x12, 30, 30) && V7.effectPool.slots[4] !== null && V7.effectPool.slots[4].x === 30);
  const v9text = encodeSave(v7again);
  const v9back = decodeSave(v9text);
  check("v7 durability: the version 9 text carries the flag and decoding reports the assumption again (no silent exactness)", JSON.parse(v9text).effectSlotsAssumed === true && v9back.ok && v9back.effectSlotsAssumed === true && v9back.effectsAssumedEmpty === false && JSON.parse(v9text).version === 9);
  const V7b = makeLayered();
  check("v7 durability: a second generation (restore of the version 9 text, capture again) still says assumed", v9back.ok && restoreSession(v9back.save, V7b).ok && V7b.effectPool.assumedSlots === true && cap(V7b).effectSlotsAssumed === true && encodeSave(cap(V7b)) === encodeSave(cap(V7b)));
  for (let n = 0; n < 6; n++) V7b.layer.update();
  check("v7 durability: once the pool has drained the live pool clears the flag and the next save is exact again", V7b.effectPool.count === 0 && V7b.effectPool.assumedSlots === false && cap(V7b).effectSlotsAssumed === false);
  const stale = makeLayered();
  stale.effectPool.assumedSlots = true; // a flag left over in the target is replaced by what the save says
  check("v7 durability: restoring an exact save into a target that carried the flag clears it", restoreSession(SE, stale).ok && stale.effectPool.assumedSlots === false);
  store.set("utopia-remake-save-5", older(textE, 7));
  const sum7 = slotSummaries()[5];
  check("v7 migration: slot summary carries the slot assumption and the label names it within 31 columns", sum7?.status === "ok" && sum7.effectSlotsAssumed === true && sum7.effectsAssumedEmpty === false && slotWarning(sum7).includes("SLOT") && ("SLOT 6  31/12/2099" + slotWarning(sum7)).length <= 31, sum7?.status === "ok" ? slotWarning(sum7) : "");
  store.delete("utopia-remake-save-5");

  // text of version 9 with the flag but no records (or other malformed v9 text) is invalid, never guessed
  const v8flagEmpty = (() => { const j = JSON.parse(encodeSave(SEmpty)); j.effectSlotsAssumed = true; return decodeSave(JSON.stringify(j)); })();
  check("effects v9: a text that assumes slot numbers for an empty pool is invalid (effectSlotsAssumed)", !v8flagEmpty.ok && v8flagEmpty.error.code === "invalid" && /effectSlotsAssumed/.test(v8flagEmpty.error.message));
  const v8short = (() => { const j = JSON.parse(textE); j.effectSlots.pop(); return decodeSave(JSON.stringify(j)); })();
  check("effects v9: a text with 29 effect slots is invalid", !v8short.ok && v8short.error.code === "invalid" && /effectSlots/.test(v8short.error.message));
  const v10 = decodeSave(older(textE, 10));
  check("effects versions: version 10 is unsupported and the message lists versions 2 through 9", !v10.ok && v10.error.code === "unsupported-version" && v10.error.message.includes("2 through 9"));
}

// ---- 9c. per-slot enemy +$16 flag pointers (schema version 7) -----------------------------------------------------------------
// Static Disk.1 trace: the spawn allocators leave +$16 untouched and the death routine never clears it. Everything below is
// synthetic; it checks the remake's model and the save format, not parity with the original.

{
  const { cellFlagPointer, cellFlagIndex, mapIndex } = await import("../dist/game/cell-flags.js");
  const { slotWarning } = await import("../dist/game/save.js");
  const OCC = 0x4000;
  const wave = (g, air, x, y, type = air ? 25 : 22) => g.enemies.spawn({ air, type, x, y, dir: 0, entry: ENEMY_ENTRY, origin: "wave" });
  const mapBit = (g, x, y) => (g.world.cells[mapIndex(x, y)] & OCC) !== 0;
  const flagBit = (g, x, y) => (g.world.cellFlags[cellFlagIndex(x, y)] & 1) !== 0;
  const claim = (g, e, x, y) => { // what the first walker step does: occupancy, flag and the slot pointer on the claimed cell
    g.world.cells[mapIndex(x, y)] |= OCC;
    g.world.cellFlags[cellFlagIndex(x, y)] |= 1;
    e.reserveX = x; e.reserveY = y;
    g.enemies.groundFlagPointers[g.enemies.groundSlots.indexOf(e)] = cellFlagPointer(x, y);
  };

  const Z = make();
  check("pointers: a fresh system holds 60 + 30 zero longs (initial zero is one captured scenario, not proven universal)", Z.enemies.groundFlagPointers.length === 60 && Z.enemies.airFlagPointers.length === 30 && Z.enemies.groundFlagPointers.every((p) => p === 0) && Z.enemies.airFlagPointers.every((p) => p === 0));
  wave(Z, false, 20, 20);
  const w0 = Z.enemies.groundSlots[0];
  check("pointers: a wave spawn with the initial zero pointer makes no flag reservation (map bit only, reserve -1/-1, pointer untouched)", mapBit(Z, 20, 20) && !flagBit(Z, 20, 20) && w0.reserveX === -1 && w0.reserveY === -1 && Z.enemies.groundFlagPointers[0] === 0);
  Z.enemies.destroyGround(w0, false);
  check("pointers: death before the first move with a zero pointer releases no cell; the spawn cell's map bit leaks", mapBit(Z, 20, 20) && Z.enemies.groundFlagPointers[0] === 0 && Z.enemies.groundSlots[0] === null);

  // claim, die, keep the raw pointer, respawn into the same slot, die before moving
  const C = make();
  wave(C, false, 30, 30);
  const c0 = C.enemies.groundSlots[0];
  claim(C, c0, 31, 30);
  C.enemies.destroyGround(c0, false);
  check("pointers: after a claim and death the freed slot keeps the raw pointer of the claimed cell, whose bits were released", C.enemies.groundFlagPointers[0] === cellFlagPointer(31, 30) && !flagBit(C, 31, 30) && !mapBit(C, 31, 30) && mapBit(C, 30, 30));
  wave(C, false, 40, 40);
  const c1 = C.enemies.groundSlots[0];
  check("pointers: respawn into the same slot preserves the pointer (no overwrite); the reserve mirrors the stale cell", C.enemies.groundFlagPointers[0] === cellFlagPointer(31, 30) && c1.reserveX === 31 && c1.reserveY === 30 && mapBit(C, 40, 40) && !flagBit(C, 40, 40));
  C.world.cells[mapIndex(31, 30)] |= OCC; C.world.cellFlags[cellFlagIndex(31, 30)] |= 1; // something else now stands on the stale cell
  C.enemies.destroyGround(c1, false);
  check("pointers: a pre-move death clears ONLY the stale cell and leaves its own spawn cell's map bit", !mapBit(C, 31, 30) && !flagBit(C, 31, 30) && mapBit(C, 40, 40) && C.enemies.groundFlagPointers[0] === cellFlagPointer(31, 30));

  // first real movement updates the pointer (walker step through the live system)
  const M = make();
  M.enemies.spawn({ air: false, type: 22, x: 50, y: 50, dir: 2, entry: ENEMY_ENTRY, origin: "wave" });
  const m0 = M.enemies.groundSlots[0];
  m0.mode = 1; m0.targetX = 55; m0.targetY = 50;
  for (let i = 0; i < 60 && M.enemies.groundFlagPointers[0] === 0; i++) { M.units.tick(); M.enemies.pass(M.units.clock); }
  const ptr = M.enemies.groundFlagPointers[0];
  check("pointers: the first movement claim sets the slot pointer to the claimed cell and the reserve mirrors it", ptr !== 0 && ptr === cellFlagPointer(m0.reserveX, m0.reserveY) && flagBit(M, m0.reserveX, m0.reserveY) && (m0.reserveX !== 50 || m0.reserveY !== 50));
  // air list: same rules
  const R = make();
  wave(R, true, 60, 20);
  const r0 = R.enemies.airSlots[0];
  check("pointers: an air wave spawn leaves the air slot pointer at 0 (no flag, air layer bit set)", R.enemies.airFlagPointers[0] === 0 && r0.reserveX === -1 && (R.world.cells[mapIndex(60, 20)] & 0x2000) !== 0 && (R.world.cellFlags[cellFlagIndex(60, 20)] & 2) === 0);
  // defection
  const D = make();
  D.units.spawn(9, 12, 13);
  D.enemies.defect();
  const d0 = D.enemies.groundSlots[0];
  check("pointers: event tank defection sets the slot pointer to the tank's current cell", D.enemies.groundFlagPointers[0] === cellFlagPointer(12, 13) && d0.reserveX === 12 && d0.reserveY === 13);
  // staging spawn without origin keeps the historical behaviour
  const G = make();
  G.enemies.spawn({ air: false, type: 22, x: 70, y: 40, dir: 0, entry: ENEMY_ENTRY });
  check("pointers: a staged spawn (no origin) keeps flag byte, pointer and reserve on the spawn cell", flagBit(G, 70, 40) && G.enemies.groundFlagPointers[0] === cellFlagPointer(70, 40) && G.enemies.groundSlots[0].reserveX === 70);

  // native v7 text roundtrip / continuation, free-slot tails included
  const P = make();
  wave(P, false, 30, 30); wave(P, false, 32, 30);
  P.enemies.spawn({ air: true, type: 25, x: 60, y: 20, dir: 0, entry: ENEMY_ENTRY }); // staged: its reservation is a map cell (v6 texts can hold it)
  const p0 = P.enemies.groundSlots[0], p1 = P.enemies.groundSlots[1];
  claim(P, p0, 31, 30);
  P.enemies.destroyGround(p0, false);   // slot 0 free, stale pointer (31,30)
  claim(P, p1, 33, 30);                 // slot 1 live, pointer (33,30)
  const SP = cap(P);
  check("v7 capture: free-slot pointer tails and occupied pointers are saved (60 + 30, raw longs)", SP.enemies.groundPointers.length === 60 && SP.enemies.airPointers.length === 30 && SP.enemies.groundPointers[0] === cellFlagPointer(31, 30) && SP.enemies.groundPointers[1] === cellFlagPointer(33, 30) && SP.enemies.groundPointers[2] === 0 && SP.enemies.airPointers[0] === cellFlagPointer(60, 20) && SP.enemies.ground[0] === null && validateSession(SP) === null);
  P.enemies.groundFlagPointers[5] = 7;
  check("v7 capture: the saved pointer arrays are detached copies", SP.enemies.groundPointers[5] === 0 && SP.enemies.groundPointers !== P.enemies.groundFlagPointers);
  P.enemies.groundFlagPointers[5] = 0;
  const textP = encodeSave(SP);
  const backP = decodeSave(textP);
  check("v9 text: decodes equal with no assumption flags and no migration", backP.ok && !backP.legacy && backP.enemyPointersAssumed === false && backP.effectsAssumedEmpty === false && encodeSave(backP.save) === textP && JSON.parse(textP).version === 9 && backP.effectSlotsAssumed === false);
  const Q = make();
  check("v9 reload: restore ok and the whole session prints identically", backP.ok && restoreSession(backP.save, Q).ok && print(Q) === print(P) && Q.enemies.groundFlagPointers[0] === cellFlagPointer(31, 30) && Q.enemies.groundFlagPointers.join() === P.enemies.groundFlagPointers.join());
  // continuation: respawn into free slot 0 and die pre-move on both sides
  wave(P, false, 40, 40); wave(Q, false, 40, 40);
  for (const g of [P, Q]) { g.world.cells[mapIndex(31, 30)] |= OCC; g.world.cellFlags[cellFlagIndex(31, 30)] |= 1; }
  P.enemies.destroyGround(P.enemies.groundSlots[0], false);
  Q.enemies.destroyGround(Q.enemies.groundSlots[0], false);
  check("v9 continuation: uninterrupted and reloaded copy agree after reuse of the free slot and a pre-move death on the stale cell", !mapBit(Q, 31, 30) && mapBit(Q, 40, 40) && print(P) === print(Q));

  // validation, atomic refusal
  const T = make();
  junkInto(T);
  const tPrint = print(T);
  const badP = (name, mutate, path) => {
    const c = structuredClone(SP);
    mutate(c);
    const own = validateSession(c);
    const r = restoreSession(c, T);
    check(`v7 atomic: ${name} -> invalid at ${path}`, own?.code === "invalid" && own.path.startsWith(path) && !r.ok && r.error.code === "invalid" && print(T) === tPrint, own ? own.path : "accepted");
  };
  badP("59 ground pointers", (c) => { c.enemies.groundPointers.pop(); }, "enemies.groundPointers");
  badP("31 air pointers", (c) => { c.enemies.airPointers.push(0); }, "enemies.airPointers");
  badP("pointers missing", (c) => { delete c.enemies.groundPointers; }, "enemies.groundPointers");
  badP("a negative pointer", (c) => { c.enemies.groundPointers[4] = -1; }, "enemies.groundPointers[4]");
  badP("a pointer above 32 bits", (c) => { c.enemies.groundPointers[4] = 0x100000000; }, "enemies.groundPointers[4]");
  badP("a fractional pointer", (c) => { c.enemies.airPointers[3] = 1.5; }, "enemies.airPointers[3]");
  badP("a string pointer", (c) => { c.enemies.groundPointers[9] = "0"; }, "enemies.groundPointers[9]");
  badP("an occupied slot whose reserve disagrees with its pointer", (c) => { c.enemies.groundPointers[1] = cellFlagPointer(5, 5); }, "enemies.groundPointers[1]");
  badP("reserveX -1 without reserveY", (c) => { c.enemies.ground[1].reserveX = -1; }, "enemies.ground[1].reserveX");
  const edge = structuredClone(SP);
  edge.enemies.groundPointers[0] = 0xffffffff; edge.enemies.groundPointers[7] = 5; // free slots may hold ANY unsigned long (stale, unresolvable)
  check("v7 domain: free-slot pointers may be any unsigned 32-bit value (0xFFFFFFFF, off the flag array)", validateSession(edge) === null && restoreSession(edge, make()).ok);

  // migration of version 6 (and 2..5): occupied from the reservation cell, free = 0, flagged
  const olderText = (body, version = 6) => { const j = JSON.parse(body); j.version = version; delete j.enemies.groundPointers; delete j.enemies.airPointers; if (version >= 6) j.effects = j.effectSlots === null ? null : j.effectSlots.filter((e) => e !== null); delete j.effectSlots; delete j.effectSlotsAssumed; return JSON.stringify(j); };
  const m6 = decodeSave(olderText(textP));
  check("v6 migration: occupied pointers derive from the reservation cell, free slots are 0, assumption flagged (not exact)", m6.ok && m6.enemyPointersAssumed === true && m6.effectsAssumedEmpty === false && m6.save.enemies.groundPointers[1] === cellFlagPointer(33, 30) && m6.save.enemies.groundPointers[0] === 0 && m6.save.enemies.airPointers[0] === cellFlagPointer(60, 20) && m6.save.enemies.groundPointers[2] === 0);
  const m5p = decodeSave(olderText(textP, 5));
  check("v5 migration flags both the effect pool and the enemy pointers", m5p.ok && m5p.enemyPointersAssumed === true && m5p.effectsAssumedEmpty === true);
  const exitingAirText = (() => {
    const j = JSON.parse(olderText(textP));
    const e = j.enemies.air[0];
    e.x = 99; e.y = 20; e.dir = 2; // east into the 102-byte row's first padding column
    e.reserveX = -1; e.reserveY = -1; // old runtime: outbound next-cell pointer is off-map for this still-live aircraft
    return JSON.stringify(j);
  })();
  const exitingAir = decodeSave(exitingAirText);
  const oldAir = JSON.parse(exitingAirText).enemies.air[0];
  const expectedExitPointer = 0x3dc02; // $3D3A6 + 20 * $66 + 100: eastward into the row's first padding byte
  check("v6 migration: an aircraft with an off-map next-cell reservation reconstructs its raw pointer from x/y/direction and stays flagged assumed",
    exitingAir.ok && exitingAir.enemyPointersAssumed === true && exitingAir.save.enemies.airPointers[0] === expectedExitPointer &&
    resolveCellFlagPointer(expectedExitPointer).kind === "padding" &&
    exitingAir.save.enemies.air[0].reserveX === -1 && exitingAir.save.enemies.air[0].reserveY === -1);
  const exitingTarget = make();
  junkInto(exitingTarget);
  const exitingRestore = exitingAir.ok ? restoreSession(exitingAir.save, exitingTarget) : { ok: false };
  check("v6 outbound-air migration restores the reconstructed raw pointer and -1 reserve mirror", exitingRestore.ok &&
    exitingTarget.enemies.airFlagPointers[0] === expectedExitPointer &&
    exitingTarget.enemies.airSlots[0].reserveX === -1 && exitingTarget.enemies.airSlots[0].reserveY === -1);
  check("a version 6 text that carries pointer keys does not trust them", (() => { const j = JSON.parse(textP); j.version = 6; j.effects = []; delete j.effectSlots; delete j.effectSlotsAssumed; j.enemies.groundPointers[3] = 999; const r = decodeSave(JSON.stringify(j)); return r.ok && r.save.enemies.groundPointers[3] === 0; })());
  const bareText = JSON.parse(encodeSave(cap({ ...make(), units: null, enemies: null, markers: null, effectPool: null })));
  bareText.version = 6;
  bareText.effects = null; // what a version 6 text without an object layer carried
  delete bareText.effectSlots;
  delete bareText.effectSlotsAssumed;
  const bareP = decodeSave(JSON.stringify(bareText));
  check("v6 migration: a session without an enemy system assumes nothing about pointers", bareP.ok && bareP.save.enemies === null && bareP.enemyPointersAssumed === false);
  const badRes = decodeSave(olderText((() => { const j = JSON.parse(textP); j.enemies.ground[1].reserveX = 100; return JSON.stringify(j); })()));
  check("v6 migration: an occupied record whose reservation is not a map cell is rejected (invalid), nothing is guessed", !badRes.ok && badRes.error.code === "invalid" && /enemies\.ground\[1\]/.test(badRes.error.message));
  const V = make();
  junkInto(V);
  const vPrint = print(V);
  const refused = decodeSave(olderText((() => { const j = JSON.parse(textP); j.enemies.air[0].reserveY = 75; return JSON.stringify(j); })()));
  check("v6 migration is atomic: a refused text is a typed error and the live session is untouched", !refused.ok && refused.error.code === "invalid" && print(V) === vPrint);
  check("v6 migrated save restores through the same validated path; free-slot pointers are then the assumed zeros", m6.ok && restoreSession(m6.save, V).ok && V.enemies.groundFlagPointers[0] === 0 && V.enemies.groundFlagPointers[1] === cellFlagPointer(33, 30));
  const refusedInstall = make();
  junkInto(refusedInstall);
  const refusedInstallBefore = print(refusedInstall);
  refusedInstall.enemies.installSession = () => false;
  const refusedInstallResult = restoreSession(SP, refusedInstall);
  check("restore preflights an enemy installer refusal before writing world or sim state", !refusedInstallResult.ok && refusedInstallResult.error.code === "mismatch" && print(refusedInstall) === refusedInstallBefore);
  store.set("utopia-remake-save-5", olderText(textP));
  const sum6 = slotSummaries()[5];
  check("v6 migration: the slot summary carries the pointer assumption", sum6?.status === "ok" && sum6.enemyPointersAssumed === true && sum6.effectsAssumedEmpty === false);
  store.delete("utopia-remake-save-5");

  // player-visible warning, width <= 31 for "SLOT n  dd/mm/yyyy" + warning
  const slotVariant = { legacy: false, effectsAssumedEmpty: false, effectSlotsAssumed: true, enemyPointersAssumed: false };
  const variants = [slotVariant, { legacy: false, effectsAssumedEmpty: false, effectSlotsAssumed: true, enemyPointersAssumed: true }, { legacy: false, effectsAssumedEmpty: true, enemyPointersAssumed: true }, { legacy: false, effectsAssumedEmpty: true, enemyPointersAssumed: false }, { legacy: false, effectsAssumedEmpty: false, enemyPointersAssumed: true }, { legacy: true, effectsAssumedEmpty: false, enemyPointersAssumed: false }];
  check("slot warning: variants name the unknown state and the longest label fits 31 columns", Math.max(...variants.map((s) => ("SLOT 8  31/12/2099" + slotWarning(s)).length)) <= 31 && slotWarning(variants[2]).includes("PTR") && slotWarning(variants[0]).includes("FX") && slotWarning({ legacy: false, effectsAssumedEmpty: false, enemyPointersAssumed: false }) === "");
}

// ---- 10. Game wiring (needs the user's Disk.1 / Disk.2)-------------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
const haveData = fs.existsSync(disk1Path) && fs.existsSync(disk2Path);
if (haveData) {
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const { Game } = await import("../dist/game/game.js");
  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const strings = new GameStrings(disk1, 0);
  const partsOf = (map) => ({ world: map.world, sim: map.sim, loop: map.loop, units: map.objects?.units ?? null, enemies: map.enemies, markers: map.objects?.markers ?? null, effectPool: map.objects?.pool ?? null, extras: map.objects?.extra ?? null, scroll: map.scrollRef, restoredFromDisk4: map.restoredFromDisk4 });
  const gprint = (game) => encodeSave(captureSession(partsOf(game.map), game.scenario).value);
  const newGame = (scenario) => { const g = new Game(disk1, disk2); g.strings = strings; g.stage = "scenario"; g.startScenario(scenario); return g; };
  store.clear();

  const game = newGame(2);
  const map = game.map;
  check("game: a new scenario has the object layer and the enemy system (full save applies)", map.objects !== null && map.enemies !== null);
  // put something into the running session: tanks (with one hole), an enemy, a ship, markers, view
  const free = [];
  for (let y = 5; y < 70 && free.length < 6; y++) for (let x = 5; x < 95 && free.length < 6; x++) if ((map.world.cells[y * 100 + x] & 0x5000) === 0 && free.every(([fx, fy]) => Math.abs(fx - x) > 3 || Math.abs(fy - y) > 3)) free.push([x, y]);
  const units = map.objects.units;
  const spawned = free.slice(0, 4).map(([x, y]) => units.spawn(9, x, y));
  const hole = spawned[1].slot;
  units.remove(spawned[1]);
  map.enemies.spawn({ air: false, type: 22, x: free[4][0], y: free[4][1], dir: 0, entry: ENEMY_ENTRY });
  map.sim.fleet.createShip(12, free[5][0], free[5][1], 8);
  map.objects.markers[0].x = 12; map.objects.markers[0].y = 14;
  map.scrollX = 21; map.scrollY = 17;
  for (let i = 0; i < 12; i++) map.loop.vbl();
  const savedText = gprint(game);

  check("game: save to slot 2 succeeds and records no error", game.saveToSlot(2) === true && game.lastSaveError === null && store.has("utopia-remake-save-2"));
  check("game: the stored save is a complete session (version 9, holes kept, 30 effect slots present)", (() => { const r = readSlot(2); return r.ok && !r.legacy && r.save.scenario === 2 && r.save.tanks[hole] === null && r.save.tanks[spawned[0].slot] !== null && r.save.enemies.ground.some((e) => e) && r.save.ships.some((s) => s) && Array.isArray(r.save.effectSlots) && r.save.effectSlots.length === 30 && encodeSave(r.save) === savedText; })());
  check("game: the slot list names it", game.slotLabels()[2].label.startsWith("SLOT 3  ") && !/EMPTY|UNUSABLE|V1/.test(game.slotLabels()[2].label) && /EMPTY/.test(game.slotLabels()[0].label));
  {
    const old = JSON.parse(savedText);
    old.version = 5;
    delete old.effectSlots;
    delete old.effectSlotsAssumed;
    store.set("utopia-remake-save-3", JSON.stringify(old));
    check("game: a migrated v5 slot visibly marks its effect and enemy-pointer state unknown", game.slotLabels()[3].label.includes("FX/PTR UNK") && game.slotLabels()[3].label.length <= 31);
    const v6 = JSON.parse(savedText);
    v6.version = 6;
    v6.effects = v6.effectSlots.filter((e) => e !== null);
    delete v6.effectSlots;
    delete v6.effectSlotsAssumed;
    delete v6.enemies.groundPointers;
    delete v6.enemies.airPointers;
    store.set("utopia-remake-save-3", JSON.stringify(v6));
    check("game: a migrated v6 slot marks only the enemy-pointer state unknown", game.slotLabels()[3].label.includes("PTR UNKNOWN") && game.slotLabels()[3].label.length <= 31);
    store.delete("utopia-remake-save-3");
  }

  // diverge, then load: a different scenario is running, the load switches back and restores everything
  game.startScenario(1);
  const other = game.map;
  check("game: load restores the scenario, a NEW scene and the complete session", game.loadFromSlot(2) === true && game.lastLoadError === null && game.scenario === 2 && game.map !== other && game.map !== map && game.stage === "map" && gprint(game) === savedText);
  check("game: view origin, markers and unit holes are back", game.map.scrollX === 21 && game.map.scrollY === 17 && game.map.objects.markers[0].x === 12 && game.map.objects.units.slots[hole] === null && game.map.objects.units.slots[spawned[0].slot] !== null && game.disk4Session === null);

  // atomic failure: the active session is untouched
  const active = game.map;
  const activePrint = gprint(game);
  const stageBefore = game.stage;
  const corrupt = JSON.parse(store.get("utopia-remake-save-2"));
  corrupt.tanks[0].type = 11;
  store.set("utopia-remake-save-4", JSON.stringify(corrupt));
  check("game: a save that fails validation is refused; scene, scenario, stage and bytes stay as they were", game.loadFromSlot(4) === false && game.lastLoadError?.code === "invalid" && game.map === active && gprint(game) === activePrint && game.stage === stageBefore && game.scenario === 2);
  const wrongScenario = JSON.parse(store.get("utopia-remake-save-2"));
  wrongScenario.scenario = 99;
  store.set("utopia-remake-save-4", JSON.stringify(wrongScenario));
  check("game: a scenario the game files do not have is refused (invalid), session untouched", game.loadFromSlot(4) === false && game.lastLoadError?.code === "invalid" && game.map === active && gprint(game) === activePrint);
  check("game: an empty slot is refused with the typed 'empty' error, session untouched", game.loadFromSlot(7) === false && game.lastLoadError?.code === "empty" && game.map === active && gprint(game) === activePrint);
  store.set("utopia-remake-save-4", "{oops");
  check("game: an unreadable slot is labelled UNUSABLE and loading it is refused (corrupt)", game.slotLabels()[4].label.includes("UNUSABLE") && game.loadFromSlot(4) === false && game.lastLoadError?.code === "corrupt" && game.map === active && gprint(game) === activePrint);

  // save refusals
  const slot2 = store.get("utopia-remake-save-2");
  game.map.sim.pending = { offer: { what: "tanks", count: 1, price: 1 }, apply: () => {} };
  check("game: saving while an Earth offer waits is refused (offer-pending) and writes nothing", game.saveToSlot(2) === false && game.lastSaveError?.code === "offer-pending" && store.get("utopia-remake-save-2") === slot2);
  game.map.sim.pending = null;
  game.disk4Session = { slot: 0, name: "X", scenario: 2, scenarioName: "X", scenarioBy: "caller", diskSource: {}, sourceLabel: "x", view: { x: 0, y: 0, clamped: false } };
  check("game: saving a Disk.4 session is refused (disk4-session), writes nothing, the menu entry stays disabled", game.saveToSlot(2) === false && game.lastSaveError?.code === "disk4-session" && store.get("utopia-remake-save-2") === slot2 && (game.openRemakeMenu(), game.menu.entries[0].enabled === false));
  game.menu = null; game.stage = "map"; game.disk4Session = null;
  check("game: a successful save clears the last save error", game.saveToSlot(5) === true && game.lastSaveError === null);

  // an old version-less slot: loads when it holds no units, is labelled V1
  const b64 = (bytes) => { let t = ""; for (let i = 0; i < bytes.length; i += 0x8000) t += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(t); };
  const fresh = newGame(3);
  const freshState = fresh.map.world.state.snapshot();
  new DataView(freshState.buffer).setUint32(ADDR.year - 0x13034, START_YEAR); // version-less saves stored the absolute display year
  const cleared = new Uint16Array(fresh.map.world.cells).map((w) => w & ~0x6000); // an old save "without units": no ground or air marks
  const freshCells = new Uint8Array(cleared.buffer);
  freshState[0x1429e - 0x13034] = 0; freshState[0x1429e - 0x13034 + 1] = 0; // and no own ships counted
  store.set("utopia-remake-save-6", JSON.stringify({ scenario: 3, sysFlags: 1, scrollX: 30, scrollY: 20, state: b64(freshState), cells: b64(freshCells), objects: b64(fresh.map.world.objects.slice()) }));
  const lv = game.loadFromSlot(6);
  check("game: an old version-less slot made without units loads, with a V1 label", lv === true && game.scenario === 3 && game.map.scrollX === 30 && /V1$/.test(game.slotLabels()[6].label), game.lastLoadError ? `${game.lastLoadError.code}: ${game.lastLoadError.message}` : "");

  // ---- the disk menu itself: failed save / load show an error screen (real Game.update clicks, not direct method calls) ----
  const press = (g, row, extra = {}) => { // one fresh left click on a menu row (the menu ignores the press that opened it)
    const at = { pointerX: 50, pointerY: 40 + 16 + row * 12 + 4, rightButton: false, ...extra };
    g.update({ ...at, leftButton: false });
    g.update({ ...at, leftButton: true });
    if (g.stage !== "map") g.update({ ...at, leftButton: false }); // never tick a map scene: the tests compare its bytes
  };
  const rightClick = (g) => { g.update({ pointerX: 0, pointerY: 0, leftButton: false, rightButton: false }); g.update({ pointerX: 0, pointerY: 0, leftButton: false, rightButton: true }); g.update({ pointerX: 0, pointerY: 0, leftButton: false, rightButton: false }); };
  const labels = (g) => g.menu.entries.map((e) => e.label);
  const rowOf = (g, text) => labels(g).findIndex((l) => l.startsWith(text));
  const pressLabel = (g, text) => press(g, rowOf(g, text));
  const toDiskMenu = (g) => { g.openRemakeMenu(); }; // the remake submenu: save / load / new scenario / Disk.4 rows (the original disk menu is the icon picture)
  const intact = (g, scene, print, scenario) => g.map === scene && gprint(g) === print && g.scenario === scenario;

  // start from a known-good session (slot 2 as saved above)
  check("menu setup: slot 2 loads into a clean running session", game.loadFromSlot(2) === true && game.stage === "map" && gprint(game) === savedText);

  // failed LOAD from a corrupt slot
  store.set("utopia-remake-save-4", "{oops");
  let live = game.map, livePrint = gprint(game), liveScenario = game.scenario;
  toDiskMenu(game);
  press(game, 1);
  check("menu: LOAD GAME opens the slot list", game.stage === "load" && labels(game)[4].includes("UNUSABLE"));
  press(game, 4);
  check("menu load: a corrupt slot opens an error screen instead of silently closing", game.stage === "sloterror" && game.menu !== null && game.screen === game.menu.screen);
  check("menu load: the screen names the operation, slot, typed code and message", /^LOAD FAILED - SLOT 5$/.test(game.menu.title) && labels(game).includes("CODE: corrupt") && labels(game).some((l) => /JSON/i.test(l)) && game.menu.entries.filter((e) => e.enabled !== false).map((e) => e.label).join("|") === "RETRY SLOT 5|CHOOSE ANOTHER SLOT|DISK MENU|BACK TO GAME");
  check("menu load: error fields are kept and the active map, scenario and bytes are untouched", game.lastLoadError?.code === "corrupt" && intact(game, live, livePrint, liveScenario));
  pressLabel(game, "RETRY SLOT");
  check("menu load: retrying the same bad slot fails again with the same visible error", game.stage === "sloterror" && game.lastLoadError?.code === "corrupt" && labels(game).includes("CODE: corrupt") && intact(game, live, livePrint, liveScenario));
  pressLabel(game, "CHOOSE ANOTHER SLOT");
  check("menu load: CHOOSE ANOTHER SLOT returns to the load slot list with the map kept", game.stage === "load" && intact(game, live, livePrint, liveScenario));
  press(game, 7);
  check("menu load: an empty slot is also explained (empty), not ignored", game.stage === "sloterror" && game.lastLoadError?.code === "empty" && labels(game).includes("CODE: empty") && /SLOT 8$/.test(game.menu.title) && intact(game, live, livePrint, liveScenario));
  pressLabel(game, "BACK TO GAME");
  check("menu load: BACK TO GAME closes the screen on the untouched map; the error stays readable", game.stage === "map" && game.menu === null && game.lastLoadError?.code === "empty" && intact(game, live, livePrint, liveScenario));
  toDiskMenu(game); press(game, 1); press(game, 4);
  rightClick(game);
  check("menu load: right click on the error screen goes back to the disk menu (the original picture scene)", game.stage === "disk" && game.diskMenu !== null && game.menu === null && intact(game, live, livePrint, liveScenario));
  toDiskMenu(game); press(game, 1); press(game, 4);
  store.set("utopia-remake-save-4", store.get("utopia-remake-save-2")); // the problem is fixed while the screen is open
  pressLabel(game, "RETRY SLOT");
  check("menu load: retry after the cause is gone loads the save (new scene, map stage, error cleared)", game.stage === "map" && game.menu === null && game.lastLoadError === null && game.scenario === 2 && game.map !== live && gprint(game) === savedText);

  // failed SAVE: the storage refuses the write
  live = game.map; livePrint = gprint(game); liveScenario = game.scenario;
  store.delete("utopia-remake-save-7");
  failWrites = true;
  toDiskMenu(game);
  check("menu: the SAVE GAME entry is enabled for an ordinary session", game.menu.entries[0].enabled !== false);
  press(game, 0);
  check("menu: SAVE GAME opens the slot list", game.stage === "save");
  press(game, 7);
  check("menu save: a refused write opens an error screen instead of silently closing", game.stage === "sloterror" && /^SAVE FAILED - SLOT 8$/.test(game.menu.title) && labels(game).includes("CODE: write-failed") && labels(game).some((l) => /REFUSED|STORE/i.test(l)));
  check("menu save: error kept; nothing was written; the active map is untouched", game.lastSaveError?.code === "write-failed" && !store.has("utopia-remake-save-7") && intact(game, live, livePrint, liveScenario));
  pressLabel(game, "RETRY SLOT");
  check("menu save: retry while the storage still refuses stays on the error screen", game.stage === "sloterror" && game.lastSaveError?.code === "write-failed" && !store.has("utopia-remake-save-7"));
  failWrites = false;
  pressLabel(game, "RETRY SLOT");
  check("menu save: retry after the storage recovers saves, closes to the map and clears the error", game.stage === "map" && game.menu === null && game.lastSaveError === null && readSlot(7).ok && intact(game, live, livePrint, liveScenario));
  failWrites = true;
  toDiskMenu(game); press(game, 0); press(game, 6);
  pressLabel(game, "DISK MENU");
  check("menu save: DISK MENU leaves the error screen for the disk menu scene", game.stage === "disk" && game.menu === null && game.diskMenu !== null && intact(game, live, livePrint, liveScenario));
  toDiskMenu(game); press(game, 0); press(game, 6);
  pressLabel(game, "CHOOSE ANOTHER SLOT");
  failWrites = false;
  check("menu save: CHOOSE ANOTHER SLOT returns to the save slot list", game.stage === "save" && game.menu.title === "SAVE GAME - REMAKE SLOTS");
  press(game, 6);
  check("menu save: a successful save from the menu still closes to the map without an error screen", game.stage === "map" && game.lastSaveError === null && readSlot(6).ok);

  // a refused save that comes from the session (pending Earth offer): the same screen, typed offer-pending
  game.map.sim.pending = { offer: { what: "tanks", count: 1, price: 1 }, apply: () => {} };
  const before2 = store.get("utopia-remake-save-2");
  toDiskMenu(game); press(game, 0); press(game, 2);
  check("menu save: a pending Earth offer is explained on the error screen and nothing is written", game.stage === "sloterror" && labels(game).includes("CODE: offer-pending") && store.get("utopia-remake-save-2") === before2);
  game.map.sim.pending = null;
  pressLabel(game, "BACK TO GAME");

  // very long messages are wrapped and truncated, never wider than the panel
  game.openSlotErrorMenu("load", 0, { code: "invalid", message: `tanks[0].${"x".repeat(80)} ${"word ".repeat(60)}` });
  check("menu: a long message is cut to a bounded, wrapped screen", labels(game).every((l) => l.length <= 31) && labels(game).length <= 12 && labels(game).some((l) => l.endsWith("...")));
  pressLabel(game, "BACK TO GAME");

  // storage unavailable: the slot list must not claim EMPTY
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = undefined;
  check("storage off: slot summaries say unavailable (not null/empty) for every slot", slotSummaries().every((s) => s && s.status === "unavailable" && s.error.code === "no-storage"));
  check("storage off: no slot label says EMPTY and each says STORAGE OFF", game.slotLabels().every((s, i) => /STORAGE OFF/.test(s.label) && !/EMPTY/.test(s.label) && s.label.startsWith(`SLOT ${i + 1}`)));
  live = game.map; livePrint = gprint(game); liveScenario = game.scenario;
  toDiskMenu(game); press(game, 1);
  check("storage off: the load list shows STORAGE OFF", game.stage === "load" && labels(game).every((l) => /STORAGE OFF/.test(l)));
  press(game, 0);
  check("storage off: loading explains no-storage and keeps the map", game.stage === "sloterror" && game.lastLoadError?.code === "no-storage" && labels(game).includes("CODE: no-storage") && intact(game, live, livePrint, liveScenario));
  pressLabel(game, "DISK MENU");
  toDiskMenu(game); press(game, 0); press(game, 0);
  check("storage off: saving explains no-storage and keeps the map", game.stage === "sloterror" && game.lastSaveError?.code === "no-storage" && /^SAVE FAILED/.test(game.menu.title) && intact(game, live, livePrint, liveScenario));
  globalThis.localStorage = realStorage;
  pressLabel(game, "RETRY SLOT");
  check("storage off: after the storage returns, retry saves", game.stage === "map" && game.lastSaveError === null && readSlot(0).ok);
  check("storage back: slot 1 is a real save and an untouched slot is EMPTY again", !/EMPTY|STORAGE OFF/.test(game.slotLabels()[0].label) && /EMPTY/.test(game.slotLabels()[3].label));

  // the Disk.4 restriction stays: the SAVE entry cannot be activated from the menu at all
  game.disk4Session = { slot: 0, name: "X", scenario: 2, scenarioName: "X", scenarioBy: "caller", diskSource: {}, sourceLabel: "x", view: { x: 0, y: 0, clamped: false } };
  const slot1Before = store.get("utopia-remake-save-1");
  toDiskMenu(game);
  press(game, 0);
  check("menu: with a Disk.4 session the SAVE entry is disabled and a click opens neither the slot list nor a save", game.stage === "remake" && game.menu.entries[0].enabled === false && /DISK\.4/.test(game.menu.entries[0].label) && store.get("utopia-remake-save-1") === slot1Before);
  game.disk4Session = null; game.menu = null; game.stage = "map";
} else {
  console.log("skip game wiring checks: original data not found");
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log(haveData ? "\nall save checks passed" : "\nall synthetic save checks passed; Game wiring checks skipped");
