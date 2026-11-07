// Checks of the opt-in runtime checkpoints (src/game/checkpoint.ts, notes/formats/runtime-checkpoints.md):
// stable and copy-safe JSON snapshots, correct field mapping at the documented boundary, and the guarantee that
// enabling capture does not change loop results. Run after `npm run build`.
//
// Parts 1-3 are fully synthetic (no original data): a zeroed state image, an empty map and hand-placed tanks, enemies,
// ships and object records. Part 4 drives a real MapScene and needs the user's own Disk.1 / Disk.2 in
// original/utopia-whdload; it is skipped when they are missing. These tests pin the remake's own snapshot contract;
// they do not compare anything with the running original.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { CheckpointRecorder, captureCheckpoint, CHECKPOINT_SCHEMA } = await import("../dist/game/checkpoint.js");
const { GameState, A, STATE_BYTES } = await import("../dist/game/state.js");
const { World, T, OBJECT_SIZE } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { UnitSystem, UNIT_BASIC } = await import("../dist/game/units.js");
const { EnemySystem } = await import("../dist/game/enemies.js");
const { MainLoop } = await import("../dist/game/main-loop.js");
const { CELL_FLAG_BASE, cellFlagIndex, mapIndex } = await import("../dist/game/cell-flags.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}
function equal(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    check(name, true);
  } catch (error) {
    check(name, false, String(error.message).split("\n").slice(0, 6).join(" | "));
  }
}
const json = (v) => JSON.parse(JSON.stringify(v));

// ---- a synthetic runtime ------------------------------------------------------------------------------------------
// The synthetic run now advances enemies in MapScene order, so air movement needs a complete 8 x 8 turn map.
// Choosing the requested direction directly is sufficient here; combat arcs remain unused in this fixture.
const TABLES = { spiral: [], arcs: [], turn: Array.from({ length: 64 }, (_, i) => i & 7), crusherAnim: [0, 1, 2, 2, 1, 0, 0, 0] };
const OCCUPIED = 0x4000;
const AIR = 0x2000;

function makeRig() {
  const state = GameState.fromSnapshot(new Uint8Array(STATE_BYTES)).value;
  const world = World.fromSnapshot(state, { cells: new Uint16Array(100 * 75), cellFlags: new Uint8Array(75 * 102), objects: new Uint8Array(1000 * OBJECT_SIZE) }).value;
  const sim = Sim.fromSnapshot(world, { rng: createRng(7) });
  const units = new UnitSystem(world.cells, () => 1, {}, world.cellFlags);
  const enemies = new EnemySystem(sim, units, TABLES, {});
  const loop = new MainLoop();
  // A little of everything the checkpoint reads.
  state.setByte(A.frameCountdown, 90);
  state.setByte(A.day, 3);
  state.setByte(A.month, 4);
  state.setByte(A.weekday, 2);
  state.setLong(A.year, 1);
  state.setLong(A.money, 123456);
  state.setLong(0x135b6, 4242); // spent last month: a different cell from the current expenditure below
  state.setLong(0x142ca, 6000); // current expenditure
  state.setLong(A.population, 2400);
  state.setLong(A.freeColonists, 321);
  state.setLong(0x1313a, 777);
  state.setLong(0x1432a, 40);
  state.setLong(0x143c6 + 4 * 2, 60); // job pool 2 required
  state.setLong(0x143ea + 4 * 2, 50); // assigned
  state.setLong(0x1440e + 4 * 2, 0xfffffff6); // shortage -10 (signed)
  state.setLong(0x13152 + 4 * 1, 9000); // goods stock 1
  state.setByte(0x144c8, 2); // power level
  state.setWord(0x142c4, 1); // one construction site
  state.setWord(world.typeAddress(7) + T.active, 4);
  state.setWord(world.typeAddress(7) + T.total, 5);
  // Object records: a finished building (slot 7) and a construction site (slot 3).
  const o = world.objects;
  const rec = (slot, bytes) => bytes.forEach((b, i) => { o[slot * OBJECT_SIZE + i] = b; });
  rec(7, [0x00, 0x41, 1, 0, 30, 20, 0, 0]);
  rec(3, [0x00, 0x32, 0x00, 0x44, 12, 9, 5, 0]);
  // Own tanks in slots 0 and 1, one ordered; an enemy walker, a crusher and a bomber; a ship.
  const t0 = units.spawn(UNIT_BASIC, 10, 10, 2);
  const t1 = units.spawn(UNIT_BASIC, 14, 12, 0);
  units.order(t0, 20, 10);
  enemies.spawn({ air: false, type: 22, x: 40, y: 30, dir: 3, entry: [22, 5, 0, 3, 1, 0, 40, 0] });
  enemies.spawn({ air: false, type: 24, x: 42, y: 31, dir: 1, entry: [24, 9, 0, 4, 1, 0x83, 1, 0] });
  enemies.spawn({ air: true, type: 25, x: 44, y: 32, dir: 5, entry: [25, 4, 0, 2, 1, 0xff, 30, 1] });
  const shipRecord = sim.fleet.createShip(15, 20, 20);
  enemies.orderShip(shipRecord, 30, 30, false);
  sim.msg(0x8f);
  sim.events.push({ kind: "announce", id: 2 });
  return { state, world, sim, units, enemies, loop, t0, t1, shipRecord };
}
const sourceOf = (rig, extra = {}) => ({ loop: rig.loop, sim: rig.sim, units: rig.units, enemies: rig.enemies, ...extra });

// ---- 1. shape, field mapping, JSON ------------------------------------------------------------------------------
{
  const rig = makeRig();
  // A freed slot's raw +$16 survives its death. Put non-default values in free tails as well as keeping
  // the occupied records' pointers populated, so this snapshot proves the complete fixed arrays are copied.
  rig.enemies.groundFlagPointers[59] = 0xffffffff;
  rig.enemies.airFlagPointers[29] = 0x3d3a6 + 100; // row-0 padding byte, retained raw
  const cp = captureCheckpoint(sourceOf(rig, { view: { x: 47, y: 33 } }), "manual");
  check("schema and boundary", cp.schema === CHECKPOINT_SCHEMA && cp.boundary === "manual" && cp.sequence === -1);
  equal("JSON round trip is lossless (plain data only)", json(cp), cp);
  check("deep-frozen", Object.isFrozen(cp) && Object.isFrozen(cp.tanks) && Object.isFrozen(cp.tanks[0]) && Object.isFrozen(cp.tanks[0].recent) && Object.isFrozen(cp.queues.simEvents[0]));
  let threw = false;
  try { cp.economy.money = 1; } catch (e) { threw = e instanceof TypeError; }
  check("a write to a checkpoint throws instead of changing it", threw && cp.economy.money === 123456);

  check("time block", cp.time.frameCountdown === 90 && cp.time.day === 3 && cp.time.month === 4 && cp.time.weekday === 2 && cp.time.year === 1 && cp.time.dateText === "03/05/2091");
  check("video block at a fresh loop", cp.video.updates === 0 && cp.video.passes === 0 && cp.video.updatesPerPass === 4 && cp.video.updatesIntoPass === 0);
  check("pass clock from the unit system", cp.passClock && cp.passClock.sub === 0 && cp.passClock.moveTick === false && cp.passClock.enemyTick === false);
  check("hardware stand-in counters are identified as approximations", cp.approximations.hardware?.tod === rig.sim.hardwareState.tod && cp.approximations.hardware?.raster === rig.sim.hardwareState.raster);
  check("economy, population, jobs, stock, power, buildings", cp.economy.money === 123456 && cp.population.total === 2400 && cp.population.freeColonists === 321 && cp.population.employed === 777 &&
    cp.population.constructionWorkers === 40 && cp.population.jobRequired.length === 9 && cp.population.jobRequired[2] === 60 && cp.population.jobAssigned[2] === 50 &&
    cp.population.jobShortage[2] === -10 && cp.resources.stock.length === 6 && cp.resources.stock[1] === 9000 && cp.status.powerLevel === 2 &&
    cp.buildingTypes.active.length === 34 && cp.buildingTypes.active[7] === 4 && cp.buildingTypes.total[7] === 5);
  // $142CA (current expenditure) and $135B6 (spent last month) are separate cells and separate fields; the checkpoint
  // reads both without writing either. Remake instrumentation only: no claim about the original beyond building.md.
  check("economy: currentExpenditure is $142CA, spentLastMonth stays $135B6", cp.economy.currentExpenditure === 6000 && cp.economy.spentLastMonth === 4242 &&
    rig.state.long(0x142ca) === 6000 && rig.state.long(0x135b6) === 4242);
  {
    // A passive before/after pair around a charge: money -6000 and currentExpenditure +6000 in the live state, spentLastMonth untouched.
    const before = captureCheckpoint(sourceOf(makeRig()), "manual");
    const r2 = makeRig();
    r2.state.setLong(A.money, 506030);
    r2.state.setLong(0x142ca, 0);
    const a = captureCheckpoint(sourceOf(r2), "manual");
    r2.state.setLong(A.money, 500030);
    r2.state.setLong(0x142ca, 6000);
    const b = captureCheckpoint(sourceOf(r2), "manual");
    check("economy: a 6000 charge shows as money -6000 and currentExpenditure +6000, spentLastMonth unchanged",
      before.economy.currentExpenditure === 6000 && a.economy.currentExpenditure === 0 && b.economy.currentExpenditure === 6000 &&
      a.economy.money - b.economy.money === 6000 && a.economy.spentLastMonth === 4242 && b.economy.spentLastMonth === 4242);
    check("economy: capturing leaves $142CA, $135B6 and money as they were", r2.state.long(0x142ca) === 6000 && r2.state.long(0x135b6) === 4242 && r2.state.signedLong(A.money) === 500030);
  }
  check("counters words", cp.counters.sitesWord === 1 && cp.counters.ships === 1 && cp.counters.ownUnitsByType.length === 8 && cp.counters.ownUnitsByType[6] === 1);

  check("fixed slot arrays keep their length", cp.tanks.length === 99 && cp.enemies.ground.length === 60 && cp.enemies.air.length === 30 && cp.ships.length === 40);
  const [c0, c1] = cp.tanks;
  check("tank slots 0 and 1, rest free (null)", c0.slot === 0 && c1.slot === 1 && cp.tanks.slice(2).every((x) => x === null));
  check("tank fields", c0.type === 9 && c0.x === 10 && c0.y === 10 && c0.dir === 2 && c0.targetX === 20 && c0.targetY === 10 && c0.hp === rig.t0.hp && c0.control === 0xff &&
    c0.recent.join() === "255,255,255" && c0.reservation.x === 10 && c0.reservation.pointer === CELL_FLAG_BASE + cellFlagIndex(10, 10) && c1.targetX === 255);

  const g = cp.enemies.ground;
  check("enemy ground slots 0 (walker) and 1 (crusher), rest free", g[0].type === 22 && g[1].type === 24 && g.slice(2).every((x) => x === null));
  check("raw enemy +$16 pointers include occupied and free slots", cp.enemies.groundFlagPointers.length === 60 && cp.enemies.airFlagPointers.length === 30 &&
    g[0].flagPointer === CELL_FLAG_BASE + cellFlagIndex(40, 30) && cp.enemies.groundFlagPointers[59] === 0xffffffff &&
    cp.enemies.airFlagPointers[29] === CELL_FLAG_BASE + 100 && Object.isFrozen(cp.enemies.groundFlagPointers) && Object.isFrozen(cp.enemies.airFlagPointers) &&
    rig.enemies.groundFlagPointers[59] === 0xffffffff && rig.enemies.airFlagPointers[29] === CELL_FLAG_BASE + 100);
  check("enemy fields", g[0].list === "ground" && g[0].x === 40 && g[0].y === 30 && g[0].hp === 5 && g[0].damage === 3 && g[0].bombChance === 40 && g[0].mode === 6 && g[0].crusher === null &&
    g[0].reservation.pointer === CELL_FLAG_BASE + cellFlagIndex(40, 30));
  check("crusher toggle / counter / animation", g[1].crusher && g[1].crusher.toggle === true && g[1].crusher.counter === 3 && g[1].crusher.anim === 1);
  const a0 = cp.enemies.air[0];
  check("air enemy: lift, bomb chance byte, +$15", a0.list === "air" && a0.type === 25 && a0.lift === rig.enemies.airSlots[0].lift && a0.byte14 === 30 && a0.byte15 === 1 && a0.aux === -1 && a0.crusher === null);

  const s0 = cp.ships[0];
  check("ship slot 0: class, fuel, mode, reservation pointer", s0.kind === "ship" && s0.type === 15 && s0.cls === 4 && s0.fuel === rig.shipRecord.fuel && s0.mode === rig.shipRecord.mode && cp.ships.slice(1).every((x) => x === null));
  const inspected = rig.enemies.inspectShip(rig.shipRecord);
  check("ordered ship has an extra and the checkpoint maps it", inspected !== null && s0.extra !== null && s0.extra.vx === inspected.vx && s0.extra.vy === inspected.vy && s0.extra.next === inspected.next && s0.extra.turn === inspected.turn &&
    (inspected.rx < 0 ? s0.extra.reservation === null : s0.extra.reservation.pointer === CELL_FLAG_BASE + cellFlagIndex(inspected.rx, inspected.ry)));
  const fresh = rig.sim.fleet.createShip(11, 22, 22);
  check("a ship nobody has stepped or ordered has no extra yet, and capturing does not create one", rig.enemies.inspectShip(fresh) === null && captureCheckpoint(sourceOf(rig)).ships[1].extra === null && rig.enemies.inspectShip(fresh) === null);

  check("object records: occupied only, with the site annotated", cp.objectRecords.occupied === 2 && cp.objectRecords.records.map((r) => r.slot).join() === "3,7" &&
    cp.objectRecords.records[1].tile === 0x41 && cp.objectRecords.records[1].x === 30 && cp.objectRecords.records[1].y === 20 && cp.objectRecords.records[1].b2 === 1);
  equal("construction site list", cp.objectRecords.sites, [{ slot: 3, x: 12, y: 9, targetTile: 0x44, weeksLeft: 5 }]);

  const byCell = (x, y) => cp.cells.find((c) => c.x === x && c.y === y);
  check("occupied cells carry only the layer bits and the flag byte", byCell(10, 10).layers === OCCUPIED && byCell(10, 10).flagByte === 4 && byCell(44, 32).layers === AIR && byCell(44, 32).flagByte === 2 &&
    byCell(40, 30).layers === OCCUPIED && byCell(40, 30).flagByte === 1 && cp.cells.every((c) => (c.layers & ~(OCCUPIED | AIR)) === 0 && (c.layers !== 0 || c.flagByte !== 0)));

  check("queues: sim messages and events are copied", cp.queues.simMessages.join() === "143" && cp.queues.simEvents.length === 1 && cp.queues.simEvents[0].kind === "announce" && cp.queues.simEvents[0].id === 2);
  check("view and optional parts default to empty", cp.view.x === 47 && cp.view.y === 33 && cp.markers.length === 0 && cp.queues.effectSlots === null && cp.queues.effectCount === 0 && cp.queues.messageLog === null && cp.watchedCells.length === 0 && cp.aliens.alien === null && cp.aliens.meteor === null);
  const fxSlots = Array.from({ length: 30 }, () => null);
  fxSlots[4] = { type: 0x12, x: 3, y: 4, frame: 2, lift: 0 };
  fxSlots[9] = { type: 0x14, x: 5, y: 6, frame: 0, lift: 12 };
  const fxCp = captureCheckpoint(sourceOf(rig, { effectSlots: fxSlots }));
  check("schema 4 pass boundary and schema 3 effect slots: 30 fixed slots with null holes, occupied ones in THEIR slots, count word, detached and frozen", CHECKPOINT_SCHEMA === 4 && fxCp.schema === 4 && fxCp.queues.effectSlots.length === 30 && fxCp.queues.effectSlots[0] === null && fxCp.queues.effectSlots[8] === null && fxCp.queues.effectSlots[4].x === 3 && fxCp.queues.effectSlots[9].lift === 12 && fxCp.queues.effectCount === 2 && Object.isFrozen(fxCp.queues.effectSlots) && fxCp.queues.effectSlots[4] !== fxSlots[4] && !("effects" in fxCp.queues));
  const emptyFxCp = captureCheckpoint(sourceOf(rig, { effectSlots: Array.from({ length: 30 }, () => null) }));
  check("an empty pool (30 holes, count 0) is distinct from no effect pool (null)", emptyFxCp.queues.effectSlots.length === 30 && emptyFxCp.queues.effectSlots.every((e) => e === null) && emptyFxCp.queues.effectCount === 0 && cp.queues.effectSlots === null);
  check("no raw buffers anywhere (every number is a small scalar, no typed arrays)", !JSON.stringify(cp).includes("{\"0\":"));

  // pending flags, pause, offer, alien, meteor, lights
  rig.state.setByte(A.pending, 0x05);
  rig.sim.paused = true;
  rig.sim.dayQueued = true;
  rig.sim.pending = { offer: { what: "colonists", count: 12, price: 30 }, apply() {} };
  rig.sim.aliens.alien = { x: 5, y: 6 };
  rig.sim.aliens.meteor = { x: 7, y: 8, timer: 9 };
  rig.sim.alerts.set(0, true);
  const flagged = captureCheckpoint(sourceOf(rig));
  check("pending bits, pause, queued day, offer, alien, meteor, light", flagged.time.pendingBits === 5 && flagged.time.pending.daily && !flagged.time.pending.weekly && flagged.time.pending.monthly && !flagged.time.pending.special &&
    flagged.time.paused && flagged.time.dayQueued && flagged.time.offer.what === "colonists" && flagged.time.offer.count === 12 && flagged.time.offer.price === 30 &&
    flagged.aliens.alien.x === 5 && flagged.aliens.meteor.timer === 9 && flagged.alerts.lights[0] === 0xff);
  rig.sim.pending = null;

  const opts = captureCheckpoint(sourceOf(rig), "manual", { includeObjectRecords: false, includeCells: false, watchCells: [{ x: 10, y: 10 }, { x: 200, y: 3 }, { x: 5, y: -1 }] });
  check("options: records and cells off, watched cells filtered to the map and given in full",
    opts.objectRecords === null && opts.cells === null && opts.watchedCells.length === 1 && opts.watchedCells[0].word === rig.world.cells[mapIndex(10, 10)] && (opts.watchedCells[0].word & OCCUPIED) !== 0 && opts.watchedCells[0].flagByte === 4);
}

// ---- 2. stable and copy-safe ------------------------------------------------------------------------------------
{
  const rig = makeRig();
  const a = captureCheckpoint(sourceOf(rig));
  const b = captureCheckpoint(sourceOf(rig));
  equal("two captures of an unchanged runtime are identical", a, b);
  check("captures share no object with each other", a !== b && a.tanks !== b.tanks && a.tanks[0] !== b.tanks[0] && a.tanks[0].recent !== b.tanks[0].recent);
  const before = json(a);
  // Mutate every live source the checkpoint copied from.
  rig.t0.x += 3; rig.t0.recent[0] = 4; rig.t0.hp = 1;
  rig.enemies.groundSlots[0].hp = 1; rig.enemies.groundSlots[0].recent[1] = 2;
  rig.enemies.groundFlagPointers[0] = 17; rig.enemies.airFlagPointers[0] = 23;
  rig.enemies.groundFlagPointers[59] = 19; rig.enemies.airFlagPointers[29] = 29;
  rig.enemies.airSlots[0].lift = 99;
  rig.shipRecord.hp = 1; rig.shipRecord.mode = 3;
  rig.state.setLong(A.money, 5); rig.state.setByte(A.day, 9);
  rig.world.objects[7 * OBJECT_SIZE + 4] = 99;
  rig.world.cellFlags[cellFlagIndex(10, 10)] = 0;
  rig.world.cells[mapIndex(10, 10)] = 0;
  rig.sim.messages.push(1, 2, 3);
  rig.sim.events.length = 0;
  rig.sim.alerts.set(1, true);
  equal("a checkpoint does not follow later changes of the live runtime", json(a), before);
  const c = captureCheckpoint(sourceOf(rig));
  check("a new capture does see them", c.economy.money === 5 && c.time.day === 9 && c.tanks[0].x === 13 && c.queues.simMessages.length === 4 && c.queues.simEvents.length === 0 &&
    c.objectRecords.records[1].x === 99 && c.enemies.groundFlagPointers[0] === 17 && c.enemies.airFlagPointers[0] === 23 &&
    c.enemies.groundFlagPointers[59] === 19 && c.enemies.airFlagPointers[29] === 29);
}

// ---- 3. enabling capture does not change loop results (synthetic loop, same order as MapScene.update) -----------
{
  function runLoop(withCapture, updates) {
    const rig = makeRig();
    const recorder = withCapture ? new CheckpointRecorder({ capacity: 20 }) : null;
    const seen = [];
    for (let i = 0; i < updates; i++) {
      // A day change needs real scenario state (daily work); keep the synthetic timer from running out.
      if (rig.state.byte(A.frameCountdown) < 10) rig.state.setByte(A.frameCountdown, 90);
      if (i === 90) rig.sim.paused = true;
      if (i === 130) rig.sim.paused = false;
      if (i === 100) rig.units.order(rig.t1, 30, 14);
      rig.sim.countFrame();
      if (rig.loop.vbl()) {
        if (rig.sim.paused) rig.units.clock.advance();
        else {
          rig.units.tick();
          rig.enemies.pass(rig.units.clock);
        }
        // Synthetic headless sequence: cell/unit/enemy work precedes alien/spawn and periodic work; MapScene also draws
        // between its traced `$333A`/`$6936` work and the date/periodic/input phases.
        rig.sim.pass();
        rig.sim.periodicPass();
        const cp = recorder?.record(sourceOf(rig), "pass-end");
        if (cp) seen.push(cp);
      }
    }
    return { rig, recorder, seen };
  }
  const fingerprint = (r) => ({
    state: Buffer.from(r.rig.state.snapshot()).toString("base64"),
    cells: Buffer.from(r.rig.world.cells.buffer).toString("base64"),
    flags: Buffer.from(r.rig.world.cellFlags).toString("base64"),
    objects: Buffer.from(r.rig.world.objects).toString("base64"),
    tanks: r.rig.units.slots.map((u) => u && [u.x, u.y, u.dx, u.dy, u.dir, u.vx, u.vy, u.hp, u.control, u.targetX, u.targetY, u.reserveX, u.reserveY, ...u.recent]),
    enemies: [...r.rig.enemies.groundSlots, ...r.rig.enemies.airSlots].map((e) => e && [e.x, e.y, e.hp, e.mode, e.lift]),
    ships: r.rig.sim.fleet.slots.map((s) => s && [s.x, s.y, s.mode, s.hp, s.lift, s.fuel]),
    loop: [r.rig.loop.vbls, r.rig.loop.passes],
    clock: [r.rig.units.clock.sub, r.rig.units.clock.moveTick, r.rig.units.clock.enemyTick],
    rng: [r.rig.sim.roll(1000), r.rig.sim.roll(1000), r.rig.sim.roll(65535)],
    queues: [[...r.rig.sim.messages], r.rig.sim.events.map((e) => ({ ...e }))],
    paused: r.rig.sim.paused,
  });
  const plain = runLoop(false, 200);
  const watched = runLoop(true, 200);
  equal("200 updates with capture on end in exactly the state of 200 without (state, map, flags, objects, slots, clock, RNG, queues)", fingerprint(watched), fingerprint(plain));
  check("the loop actually did something (tanks moved, passes counted)", plain.rig.loop.passes === 50 && plain.rig.t0.x > 10);
  check("the MapScene-order synthetic loop steps ground and air enemies", plain.rig.enemies.groundSlots[0].x !== 40 && plain.rig.enemies.airSlots[0].x !== 44);
  check("one checkpoint per pass, 20 kept of 50, 30 dropped", watched.recorder.captured === 50 && watched.recorder.dropped === 30 && watched.recorder.checkpoints.length === 20 && watched.recorder.failures === 0);
  check("sequence numbers and pass counters are consecutive", watched.recorder.checkpoints.every((cp, i) => cp.sequence === 30 + i && cp.video.passes === 31 + i && cp.video.updates === 4 * cp.video.passes && cp.video.updatesIntoPass === 0));
  const frozenRun = watched.seen.filter((cp) => cp.time.paused);
  check("pause is visible, the pass clock still moves while paused and the countdown is frozen", frozenRun.length >= 8 && frozenRun[1].time.frameCountdown === frozenRun[0].time.frameCountdown && frozenRun[1].passClock.sub !== frozenRun[0].passClock.sub);
  const moved = watched.seen.map((cp) => cp.tanks[0].x);
  check("tank positions in the sequence follow the live unit (monotonic walk east)", moved.every((x, i) => i === 0 || x >= moved[i - 1]) && moved.at(-1) === plain.rig.t0.x);

  // a capture failure or a throwing callback never reaches the loop
  const rig = makeRig();
  let calls = 0;
  const r = new CheckpointRecorder({ onCheckpoint: () => { calls++; throw new Error("callback boom"); } });
  let escaped = false;
  try { r.record(sourceOf(rig), "pass-end"); } catch { escaped = true; }
  check("a throwing onCheckpoint is caught and counted", !escaped && calls === 1 && r.failures === 1 && r.lastError === "callback boom" && r.checkpoints.length === 1);
  const broken = new CheckpointRecorder();
  let escaped2 = false;
  let result;
  try { result = broken.record({ ...sourceOf(rig), sim: null }, "pass-end"); } catch { escaped2 = true; }
  check("a failing capture is caught and counted", !escaped2 && result === null && broken.failures === 1 && broken.captured === 0 && broken.checkpoints.length === 0);
}

// ---- recorder policies ----------------------------------------------------------------------------------------------
{
  const rig = makeRig();
  const every = new CheckpointRecorder({ everyPasses: 3, capacity: 0, onCheckpoint: () => {} });
  for (let i = 0; i < 12; i++) { if (rig.loop.vbl()) every.atPass(sourceOf(rig), "pass-end"); }
  check("everyPasses: only passes 3 of 3, capacity 0 keeps nothing but still counts", every.captured === 1 && every.dropped === 1 && every.checkpoints.length === 0);
  const plain = new CheckpointRecorder();
  plain.noteMessage(0x71);
  plain.noteMessage(-1);
  const first = plain.record(sourceOf(rig), "pass-end");
  const second = plain.record(sourceOf(rig), "pass-end");
  check("message requests since the previous checkpoint are reported once", first.queues.messagesPushed.join() === "113,-1" && second.queues.messagesPushed.length === 0 && second.sequence === 1);
  const copy = plain.checkpoints;
  copy.length = 0;
  check("the checkpoints getter returns a copy", plain.checkpoints.length === 2);
  plain.clear();
  check("clear forgets the buffer, not the counters", plain.checkpoints.length === 0 && plain.captured === 2);
  let bad = 0;
  for (const o of [{ capacity: -1 }, { capacity: 1.5 }, { everyPasses: 0 }, { everyPasses: 2.5 }]) { try { new CheckpointRecorder(o); } catch { bad++; } }
  check("bad recorder options are refused", bad === 4);
}

// ---- 4. MapScene (needs the user's own Disk.1 / Disk.2) ----------------------------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("checkpoint MapScene checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
} else {
  const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
  const { loadSprites } = await import("../dist/data/sprites.js");
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const { MapScene } = await import("../dist/game/map.js");
  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const record = readScenarioRecords(disk2)[0];
  const sprites = loadSprites(disk1, disk2, record);
  const tiles = loadTileSet(disk1, disk2, record).tiles;
  const strings = new GameStrings(disk1, 0);

  // Builder and world use Math.random for solar phases; fix it so two runs are comparable.
  const realRandom = Math.random;
  const seeded = () => { let s = 12345; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
  const idle = () => ({ leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] });
  const scene = () => {
    const m = new MapScene(disk1, tiles, new World(new GameState(disk2, record.block), loadMap(disk2, record)), strings, { sprites });
    m.world.state.setByte(A.pending, 0);
    m.objects.units.spawn(UNIT_BASIC, 46, 34, 0);
    m.objects.units.order(m.objects.units.units[0], 52, 36);
    m.enemies.spawn({ air: false, type: 22, x: 50, y: 40, dir: 3, entry: [22, 5, 0, 3, 1, 0, 40, 0] });
    return m;
  };
  function drive(m, updates) {
    for (let i = 0; i < updates; i++) {
      const input = idle();
      if (i === 23 || i === 203) input.keys.push(" "); // pause, resume: keys are polled once per four-update pass
      if (i >= 100 && i < 140) Object.assign(input, { leftButton: true, pointerX: 250, pointerY: 141 }); // held scroll arrow
      m.update(input);
    }
  }
  const fingerprint = (m) => ({
    state: Buffer.from(m.world.state.snapshot()).toString("base64"),
    cells: Buffer.from(m.world.cells.buffer).toString("base64"),
    flags: Buffer.from(m.world.cellFlags).toString("base64"),
    objects: Buffer.from(m.world.objects).toString("base64"),
    tanks: m.objects.units.slots.map((u) => u && [u.x, u.y, u.dx, u.dy, u.dir, u.vx, u.vy, u.hp, u.control, u.targetX, u.targetY, u.reserveX, u.reserveY]),
    enemies: [...m.enemies.groundSlots, ...m.enemies.airSlots].map((e) => e && [e.x, e.y, e.dx, e.dy, e.hp, e.mode, e.lift, e.reserveX, e.reserveY]),
    enemyPointers: [m.enemies.groundFlagPointers.slice(), m.enemies.airFlagPointers.slice()],
    ships: m.sim.fleet.slots.map((s) => s && [s.x, s.y, s.mode, s.hp]),
    view: [m.scrollX, m.scrollY],
    loop: [m.loop.vbls, m.loop.passes],
    clock: [m.objects.units.clock.sub, m.objects.units.clock.moveTick, m.objects.units.clock.enemyTick],
    paused: m.sim.paused,
    rng: [m.sim.roll(1000), m.sim.roll(1000), m.sim.roll(65535)],
    pixels: Buffer.from(m.screen.pixels).toString("base64"),
  });

  try {
    seeded();
    const plain = scene();
    drive(plain, 400);
    const plainPrint = fingerprint(plain);

    seeded();
    const watched = scene();
    const received = [];
    const recorder = watched.enableCheckpoints({ capacity: 1000, onCheckpoint: (cp) => received.push(cp) });
    drive(watched, 400);
    const watchedPrint = fingerprint(watched);
    equal("MapScene: 400 updates with checkpoints enabled give the same state, map, flags, objects, slots, view, clock, RNG and screen as without", watchedPrint, plainPrint);

    const cps = recorder.checkpoints;
    check("one checkpoint per completed pass, all at a pass boundary, callback saw the same ones", cps.length === 100 && received.length === 100 && recorder.failures === 0 &&
      cps.every((cp, i) => cp.sequence === i && cp.video.passes === i + 1 && cp.video.updates === 4 * (i + 1) && cp.video.updatesIntoPass === 0 && cp.boundary === "pass-end" && received[i] === cp));
    equal("every checkpoint survives a JSON round trip", cps.map(json), cps);
    const last = cps.at(-1);
    check("the last checkpoint matches the live scene", last.time.dateText === watched.world.state.dateText() && last.economy.money === watched.world.state.signedLong(A.money) &&
      last.passClock.sub === watched.objects.units.clock.sub && last.time.paused === watched.sim.paused && last.view.x === watched.scrollX && last.view.y === watched.scrollY &&
      last.counters.tanks === watched.world.state.word(0x1429c));
    const pos = (list) => list.map((u) => u && [u.x, u.y]);
    equal("tank and enemy slots of the last checkpoint equal the live slots (indices, holes and positions)", [pos(last.tanks), pos(last.enemies.ground), pos(last.enemies.air)],
      [pos(watched.objects.units.slots), pos(watched.enemies.groundSlots), pos(watched.enemies.airSlots)]);
    check("the day timer is visible and the date moved during the run", cps[0].time.dateText !== last.time.dateText,
      `${cps[0].time.dateText} -> ${last.time.dateText}`);
    check("the checkpoint sequence includes paused passes", cps.some((cp) => cp.time.paused), `${cps.filter((cp) => cp.time.paused).length} paused checkpoints`);
    check("the checkpoint sequence includes unpaused passes", cps.some((cp) => !cp.time.paused));
    check("the eight marker pins are listed", last.markers.length === 8 && last.markers.every((pin, i) => pin.type === i + 1));
    check("manual capture on a scene without a recorder is available", plain.captureCheckpoint().boundary === "manual" && plain.captureCheckpoint({ includeCells: false }).cells === null);

    // queued messages and message requests around one pass boundary
    seeded();
    const m = scene();
    const r = m.enableCheckpoints();
    for (let i = 0; i < 3; i++) m.update(idle());
    m.say(0x71);
    const runAfterVblWait = m.sim.runAfterVblWait.bind(m.sim);
    let queuedAfterDrain = false;
    m.sim.runAfterVblWait = () => {
      if (!queuedAfterDrain) {
        queuedAfterDrain = true;
        m.sim.msg(0x8f);
      }
      runAfterVblWait();
    };
    m.update(idle()); // update 4: the pass; $99C4 queues after this update's message drain
    for (let i = 0; i < 4; i++) m.update(idle());
    const [first, second] = r.checkpoints;
    check("queued Sim messages are seen before the drain, message requests are listed once", first.queues.simMessages.join() === "143" && first.queues.messagesPushed.join() === "113" &&
      second.queues.simMessages.length === 0 && second.queues.messagesPushed.join() === "143" && first.queues.messageLog !== null);

    // the modal build-menu pass
    seeded();
    const menu = scene();
    const mr = menu.enableCheckpoints();
    const down = { leftButton: true, rightButton: false, pointerX: 272, pointerY: 63, keys: [] };
    for (let i = 0; i < 4; i++) menu.update({ ...down, keys: [] }); // the press: `$5756` only
    for (let i = 0; i < 12; i++) menu.update(idle()); // the release in pass 2 opens the menu (`$15A74` -> `$6BA2`); passes 3 and 4 are modal
    const boundaries = mr.checkpoints.map((cp) => cp.boundary).join();
    check("the modal menu passes are labelled and freeze the pass clock while video counters move", boundaries === "pass-end,pass-end,pass-end-modal,pass-end-modal" &&
      mr.checkpoints[2].passClock.sub === mr.checkpoints[3].passClock.sub && mr.checkpoints[3].video.updates === 16);

    watched.disableCheckpoints();
    drive(watched, 8);
    check("disableCheckpoints stops recording but keeps what was stored", recorder.captured === 100 && recorder.checkpoints.length === 100);
  } finally {
    Math.random = realRandom;
  }
}

if (failed) {
  console.log(`${failed} checkpoint check(s) failed`);
  process.exit(1);
}
console.log("all checkpoint checks passed");
