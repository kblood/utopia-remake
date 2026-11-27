// Synthetic coverage of the Disk.4 restore preparation (src/game/disk4-load.ts) and the snapshot
// constructors GameState.fromSnapshot / World.fromSnapshot. No original data is used. Run after `npm run build`.

const { prepareDisk4Load, prepareDisk4TankLoad, prepareDisk4SimLoad } = await import("../dist/game/disk4-load.js");
const { CELL_FLAG_BASE, cellFlagIndex, mapIndex } = await import("../dist/game/cell-flags.js");
const { GameState, A, STATE_BYTES } = await import("../dist/game/state.js");
const { World, OBJECT_SLOTS, OBJECT_SIZE, CELL_FLAG_BYTES, OBJECT_COUNT_ADDRESS } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { findRecord } = await import("../dist/game/screens/buildings.js");
const { DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT } = await import("../dist/data/disk4.js");
const { decodeDisk4Entities } = await import("../dist/data/disk4-entities.js");
const { DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES } = await import("../dist/data/disk4-state.js");
const { applyDisk4LoadReset, applyDisk4ScenarioPointer, DISK4_LOAD_AREA_B_POINTER, DISK4_LOAD_RESET, DISK4_SAVED_RANGES, expandDisk4LoadReset } = await import("../dist/game/disk4-reset.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
const put16 = (b, o, v) => { b[o] = v >> 8; b[o + 1] = v & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

const SECTORS = 1920;
const SLOT = 2;
const A_FIRST = 100; // 73 sectors
const B_FIRST = 174; // 11 sectors
const recOffset = (i) => DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + i * DISK4_RECORD_SIZE;

// A raw Disk.4 image with one populated slot (SLOT, name "SYNTH") and EMPTY elsewhere. `fillA`/`fillB`
// receive the slot's area views (live subarrays of the image) before the image is returned.
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
  const areaA = img.subarray(A_FIRST * 512, A_FIRST * 512 + DISK4_AREA_A_BYTES);
  const areaB = img.subarray(B_FIRST * 512, B_FIRST * 512 + DISK4_AREA_B_BYTES);
  fillA?.(areaA);
  fillB?.(areaB);
  return img;
}
const request = (over = {}) => ({ slot: SLOT, scenario: 4, scenarioCount: 10, ...over });
const stageOf = (r) => (r.ok ? null : r.error.stage);
const codeOf = (r) => (r.ok ? null : (r.error.code ?? r.error.error.code));

check("sizes agree", STATE_BYTES === DISK4_AREA_B_BYTES && OBJECT_SLOTS * OBJECT_SIZE === 8000 && CELL_FLAG_BYTES === 7650 &&
  OBJECT_COUNT_ADDRESS === DISK4_ADDR.countObjects);

// ---- detached own-tank hydration -----------------------------------------------------------------------------
{
  const x = 7, y = 8, reserveX = 11, reserveY = 12;
  const pointer = CELL_FLAG_BASE + cellFlagIndex(reserveX, reserveY);
  const img = makeImage((a) => {
    const at = offA(DISK4_ADDR.ownTanks) + 3 * 0x18;
    a[at] = 9; a[at + 1] = x; a[at + 2] = y;
    a[at + 3] = 0xfe; a[at + 4] = 1; a[at + 5] = 2; a[at + 6] = 2; a[at + 7] = 1;
    a[at + 8] = 15; a[at + 9] = 0x91; a[at + 10] = 4; a[at + 11] = 9; a[at + 12] = 10;
    a[at + 0x10] = 0xff; a[at + 0x11] = 1; a[at + 0x12] = 3;
    put32(a, at + 0x14, pointer);
    const flags = offA(DISK4_ADDR.flags);
    a[flags + cellFlagIndex(reserveX, reserveY)] = 0xa0;
    a[flags + cellFlagIndex(x, y)] = 0x40;
  }, (b) => { b[offB(0x144c9)] = 6; b[offB(0x14592)] = 5; });
  const before = img.slice();
  const r = prepareDisk4TankLoad(img, request());
  check("tank preparation succeeds and keeps slot 3", r.ok && r.value.tanks.slots[3]?.slot === 3 && r.value.tanks.units.length === 1);
  if (r.ok) {
    const unit = r.value.tanks.slots[3];
    check("tank fields and raw provenance hydrate exactly", unit.x === x && unit.y === y && unit.dx === -2 && unit.dy === 1 && unit.dir === 2 &&
      unit.vx === 2 && unit.vy === 1 && unit.hp === 15 && unit.control === 0x91 && unit.waiting && unit.tech === 4 &&
      unit.targetX === 9 && unit.targetY === 10 && unit.sourceAddress === DISK4_ADDR.ownTanks + 3 * 0x18 && unit.sourceRaw.length === 0x18);
    check("reservation comes from saved flag pointer, not current position", unit.reserveX === reserveX && unit.reserveY === reserveY);
    check("hydration preserves map and flag occupancy bytes", r.value.world.cells[mapIndex(x, y)] === 0 &&
      r.value.world.cellFlags[cellFlagIndex(x, y)] === 0x40 && r.value.world.cellFlags[cellFlagIndex(reserveX, reserveY)] === 0xa0);
    check("saved pass clock and tech source are applied", r.value.tanks.clock.sub === 6);
    r.value.tanks.remove(unit);
    check("remove releases only the saved reservation bit", r.value.world.cellFlags[cellFlagIndex(reserveX, reserveY)] === 0xa0 &&
      r.value.world.cells[mapIndex(reserveX, reserveY)] === 0);
  }
  check("tank preparation never mutates input bytes", sameBytes(img, before));
  const bad = makeImage((a) => {
    const at = offA(DISK4_ADDR.ownTanks);
    a[at] = 9; a[at + 1] = 4; a[at + 2] = 4;
    put32(a, at + 0x14, 0xdeadbeef);
  });
  const failedTank = prepareDisk4TankLoad(bad, request());
  check("invalid occupied reservation reports tanks stage without partial result", !failedTank.ok && failedTank.error.stage === "tanks" &&
    failedTank.error.error.code === "flag-pointer" && !("value" in failedTank));
}

// ---- byte-preserving core restore ------------------------------------------------------------------------------
{
  const noisyB = (b) => {
    for (let i = 0; i < b.length; i++) b[i] = (i * 17 + 9) & 0xff;
    put16(b, offB(DISK4_ADDR.countEnemyAir), 3);
    put16(b, offB(DISK4_ADDR.countEnemyGround), 4);
    put16(b, offB(DISK4_ADDR.countOwnShips), 5);
    put16(b, offB(DISK4_ADDR.countOwnTanks), 6);
    put16(b, offB(DISK4_ADDR.countObjects), 5);
    // Values that differ from the new-game defaults ($866E), so applied defaults would show.
    b[offB(A.day)] = 0x07; b[offB(A.month)] = 0x09; b[offB(A.difficulty)] = 0x55; b[offB(A.techLevel)] = 0x0c;
    put32(b, offB(A.year), 3000); put32(b, offB(A.money), 1234567); put32(b, offB(A.morale), 0xfffff000);
    put16(b, offB(A.scrollX), 0x1234);
  };
  const fillA = (a) => {
    for (let i = 0; i < a.length; i++) a[i] = (i * 31 + 5) & 0xff;
    const map = offA(DISK4_ADDR.mapCells);
    for (let y = 0; y < 75; y++) {
      for (let x = 0; x < 102; x++) put16(a, map + (y * 102 + x) * 2, x < 100 ? (y * 100 + x) & 0xffff : 0x73ff);
    }
    // Solar tile $0F with flag bits and no $300 bits: the new-game builder would rewrite this cell.
    put16(a, map + (10 * 102 + 20) * 2, 0x8c0f);
    // A building tile whose type the (noise) type table does not know: buildObjects() would throw on it.
    put16(a, map + (11 * 102 + 20) * 2, 0x0060);
    const flags = offA(DISK4_ADDR.flags);
    for (let i = 0; i < CELL_FLAG_BYTES; i++) a[flags + i] = (i * 7 + 3) & 0xff;
  };
  const img = makeImage(fillA, noisyB);
  const before = img.slice();
  const areaA0 = img.slice(A_FIRST * 512, A_FIRST * 512 + DISK4_AREA_A_BYTES);
  const areaB0 = img.slice(B_FIRST * 512, B_FIRST * 512 + DISK4_AREA_B_BYTES);

  const r = prepareDisk4Load(img, request());
  check("restore ok", r.ok);
  const v = r.value;
  check("metadata echoed", v.slot === SLOT && v.name === "SYNTH" && v.scenario === 4 && v.source === "raw");
  check("state image byte for byte", sameBytes(v.state.snapshot(), areaB0));
  check("no new-game defaults applied", v.state.byte(A.day) === 0x07 && v.state.byte(A.month) === 0x09 &&
    v.state.byte(A.difficulty) === 0x55 && v.state.byte(A.techLevel) === 0x0c && v.state.long(A.year) === 3000 &&
    v.state.long(A.money) === 1234567 && v.state.word(A.scrollX) === 0x1234 && v.state.long(A.morale) === 0xfffff000);
  let cellsOk = v.world.cells.length === 7500;
  for (let y = 0; y < 75; y++) for (let x = 0; x < 100; x++) {
    const want = y === 10 && x === 20 ? 0x8c0f : y === 11 && x === 20 ? 0x0060 : (y * 100 + x) & 0xffff;
    if (v.world.cells[y * 100 + x] !== want) cellsOk = false;
  }
  check("all map cells preserved (flag bits, pad words dropped, solar cell not normalised)", cellsOk);
  const flagsStart = offA(DISK4_ADDR.flags);
  check("all 7650 cell flag bytes preserved", v.world.cellFlags !== null && sameBytes(v.world.cellFlags, areaA0.subarray(flagsStart, flagsStart + CELL_FLAG_BYTES)));
  const objStart = offA(DISK4_ADDR.objects);
  check("all 1000 object records preserved", v.world.objects.length === 8000 && sameBytes(v.world.objects, areaA0.subarray(objStart, objStart + 8000)));
  check("saved counts preserved", v.world.objectCount === 5 && v.state.word(OBJECT_COUNT_ADDRESS) === 5 &&
    v.disk4.enemyAir.count === 3 && v.disk4.enemyGround.count === 4 && v.disk4.ownShips.count === 5 && v.disk4.ownTanks.count === 6);
  check("no warehouse capacity injected", v.world.warehouseCapacity === 0);
  check("entity lists decoded but not restored", v.disk4.enemyAir.records.length === 780 && v.disk4.ownTanks.records.length === 2376);

  // Typed entity arrays: composed from the same decoded state, fixed slots, bytes preserved.
  const e = v.entities;
  check("entities: fixed slot counts 30/60/40/99", e.enemyAir.slots.length === 30 && e.enemyGround.slots.length === 60 &&
    e.ownShips.slots.length === 40 && e.ownTanks.slots.length === 99);
  check("entities: stored counts echo the saved count words", e.enemyAir.storedCount === 3 && e.enemyGround.storedCount === 4 &&
    e.ownShips.storedCount === 5 && e.ownTanks.storedCount === 6);
  const direct = decodeDisk4Entities(v.disk4);
  check("entities equal a direct decodeDisk4Entities(disk4)", direct.ok && JSON.stringify(direct.value) === JSON.stringify(e));
  check("entities: slot raw bytes match the Disk4State records", ["enemyAir", "enemyGround", "ownShips", "ownTanks"].every((k) => {
    const list = v.disk4[k];
    return e[k].slots.every((sl, i) => sl.index === i && sameBytes(sl.raw, list.records.subarray(i * list.recordSize, (i + 1) * list.recordSize)));
  }));
  check("entities: last slot keeps its index and original address (no compaction)", e.ownTanks.slots[98].index === 98 && e.ownTanks.slots[98].address === DISK4_ADDR.ownTanks + 98 * 0x18);
  const tank0 = Array.from(e.ownTanks.slots[0].raw);
  v.disk4.ownTanks.records[0] ^= 0xff;
  check("entities detached from the disk4 record buffers", sameBytes(e.ownTanks.slots[0].raw, tank0));

  check("input image not modified", sameBytes(img, before));
  img.fill(0);
  check("result independent of the input image", sameBytes(v.state.snapshot(), areaB0) && v.world.cells[1] === 1);
  v.state.setByte(A.day, 0x01);
  v.world.objects[0] ^= 0xff;
  v.world.cellFlags[0] ^= 0xff;
  const again = prepareDisk4Load(before, request());
  check("mutating a result leaves the source and later loads untouched", again.ok && again.value.state.byte(A.day) === 0x07 &&
    sameBytes(again.value.world.objects, areaA0.subarray(objStart, objStart + 8000)) && again.value.world.cellFlags[0] === areaA0[flagsStart]);
}

// ---- snapshot simulation construction -------------------------------------------------------------------------
{
  const image = new Uint8Array(STATE_BYTES);
  const restored = GameState.fromSnapshot(image);
  const cells = new Uint16Array(7500);
  cells[3 * 100 + 2] = 0x007f;
  cells[8 * 100 + 7] = 0x007f;
  const restoredWorld = World.fromSnapshot(restored.value, {
    cells,
    cellFlags: new Uint8Array(CELL_FLAG_BYTES),
    objects: new Uint8Array(8000),
  });
  restoredWorld.value.warehouseCapacity = 80000;
  restored.value.setByte(0x14524, 0xa5);
  restored.value.setByte(0x14525, 0x5a);
  restored.value.setByte(0x14526, 0x3c);
  restored.value.setByte(0x14527, 0xc3);
  const before = restored.value.snapshot();
  let rngCalls = 0;
  const detached = Sim.fromSnapshot(restoredWorld.value, { rng: () => { rngCalls++; return 0; } });
  check("snapshot Sim construction preserves the complete saved state", sameBytes(restored.value.snapshot(), before));
  check("snapshot Sim skips capacity fallback and marker-table reconstruction", restored.value.long(0x14432) === 0 &&
    restored.value.word(0x144a6) === 0 && restored.value.byte(0x14524) === 0xa5 && restored.value.byte(0x14525) === 0x5a &&
    restored.value.byte(0x14526) === 0x3c && restored.value.byte(0x14527) === 0xc3);
  check("snapshot Sim construction leaves transient effects, messages and RNG untouched", detached.initialization === "snapshot" &&
    detached.events.length === 0 && detached.messages.length === 0 && rngCalls === 0);

  const fresh = GameState.fromSnapshot(new Uint8Array(STATE_BYTES));
  const freshWorld = World.fromSnapshot(fresh.value, {
    cells,
    cellFlags: new Uint8Array(CELL_FLAG_BYTES),
    objects: new Uint8Array(8000),
  });
  freshWorld.value.warehouseCapacity = 80000;
  const newGame = new Sim(freshWorld.value, { rng: () => 0 });
  check("ordinary Sim construction retains new-game capacity and marker initialization", newGame.initialization === "new-game" &&
    fresh.value.long(0x14432) === 80000 && fresh.value.word(0x144a6) === 2 &&
    fresh.value.byte(0x14524) === 2 && fresh.value.byte(0x14525) === 3 &&
    fresh.value.byte(0x14526) === 7 && fresh.value.byte(0x14527) === 8);
  const newGameBeforeReset = { flags: newGame.sysFlags, paused: newGame.paused, dayQueued: newGame.dayQueued, lights: newGame.alerts.flags.slice() };
  const refusedReset = applyDisk4LoadReset({ sim: newGame });
  check("load reset refuses a new-game Sim without changing any runtime field", !refusedReset.ok && refusedReset.error.code === "not-snapshot-graph" &&
    newGame.sysFlags === newGameBeforeReset.flags && newGame.paused === newGameBeforeReset.paused && newGame.dayQueued === newGameBeforeReset.dayQueued &&
    newGame.alerts.flags.every((v, i) => v === newGameBeforeReset.lights[i]));

  let preparedRngCalls = 0;
  const diskImage = makeImage((a) => {
    put16(a, offA(DISK4_ADDR.mapCells) + (3 * 102 + 2) * 2, 0x007f);
    put16(a, offA(DISK4_ADDR.mapCells) + (8 * 102 + 7) * 2, 0x007f);
  }, (b) => {
    put32(b, offB(0x14432), 0);
    put16(b, offB(0x144a6), 0);
    b[offB(0x14524)] = 0xa5; b[offB(0x14525)] = 0x5a;
    b[offB(0x14526)] = 0x3c; b[offB(0x14527)] = 0xc3;
  });
  const diskImageBefore = diskImage.slice();
  const areaBBefore = diskImage.slice(B_FIRST * 512, B_FIRST * 512 + DISK4_AREA_B_BYTES);
  const composed = prepareDisk4SimLoad(diskImage, request(), { rng: () => { preparedRngCalls++; return 0; } });
  check("Disk.4 Sim preparation composes tanks and inert Sim", composed.ok && composed.value.tanks.slots.length === 99 && composed.value.sim.initialization === "snapshot");
  if (composed.ok) check("Disk.4 Sim preparation preserves saved capacity, marker bytes and state image", composed.value.state.long(0x14432) === 0 &&
    composed.value.state.word(0x144a6) === 0 && composed.value.state.byte(0x14524) === 0xa5 && composed.value.state.byte(0x14525) === 0x5a &&
    composed.value.state.byte(0x14526) === 0x3c && composed.value.state.byte(0x14527) === 0xc3 &&
    sameBytes(composed.value.state.snapshot(), areaBBefore));
  check("Disk.4 Sim preparation keeps caller input and RNG untouched", sameBytes(diskImage, diskImageBefore) && preparedRngCalls === 0);

  if (composed.ok) {
    const graph = composed.value;
    const rawAreaBBeforePointer = graph.disk4.areaB.slice();
    const pointer = applyDisk4ScenarioPointer(graph, graph.scenario, 10);
    const expectedHeaderPointer = DISK4_LOAD_AREA_B_POINTER.headerTable + graph.scenario * DISK4_LOAD_AREA_B_POINTER.recordSize;
    check("original load writes the chosen scenario header pointer at $1453A in runtime state", pointer.ok && pointer.address === expectedHeaderPointer &&
      graph.state.long(DISK4_LOAD_AREA_B_POINTER.address) === expectedHeaderPointer);
    check("scenario pointer write leaves raw Disk.4 bytes and decoded area-B provenance unchanged",
      sameBytes(diskImage, diskImageBefore) && sameBytes(graph.disk4.areaB, rawAreaBBeforePointer));
    const beforeBadPointer = graph.state.snapshot();
    const badPointer = applyDisk4ScenarioPointer(graph, 10, 10);
    check("invalid scenario pointer request returns typed error without mutation", !badPointer.ok && badPointer.error.code === "scenario-index" &&
      sameBytes(graph.state.snapshot(), beforeBadPointer));
    graph.sim.sysFlags = 0xff;
    graph.sim.paused = true;
    graph.sim.dayQueued = false;
    graph.sim.blastMark = true;
    graph.sim.alerts.flags.fill(0xff);
    const stateBeforeReset = graph.state.snapshot();
    const mapBeforeReset = graph.world.cells.slice();
    const flagsBeforeReset = graph.world.cellFlags.slice();
    const objectsBeforeReset = graph.world.objects.slice();
    const reset = applyDisk4LoadReset(graph);
    check("traced Disk.4 reset applies its runtime flags to a detached snapshot graph", reset.ok && graph.sim.sysFlags === 0 &&
      !graph.sim.paused && graph.sim.dayQueued && graph.sim.alerts.flags.every((v) => v === 0));
    check("traced Disk.4 reset clears the blast mark (`$87C2` writes $02 to $156A9, bit 5 included)", reset.ok && graph.sim.blastMark === false);
    check("load reset leaves saved state, map, cell flags and object records byte-for-byte unchanged",
      sameBytes(graph.state.snapshot(), stateBeforeReset) && graph.world.cells.every((v, i) => v === mapBeforeReset[i]) &&
      sameBytes(graph.world.cellFlags, flagsBeforeReset) && sameBytes(graph.world.objects, objectsBeforeReset));
    const writes = expandDisk4LoadReset();
    const inSavedRange = (address) => DISK4_SAVED_RANGES.some(([start, end]) => address >= start && address < end);
    check("static reset write table matches the sentinels, cleared runtime bytes, lights and effect pool",
      writes.get(0x14634) === 0xff && writes.get(0x14635) === 0xff && writes.get(0x14636) === 0xff && writes.get(0x14637) === 0xff &&
      Array.from({ length: 8 }, (_, i) => writes.get(0x156ac + i)).every((v) => v === 0) &&
      [0x15634, 0x15644, 0x15654, 0x15664].every((address) => writes.get(address) === 0 && writes.get(address + 1) === 0) &&
      Array.from({ length: 240 }, (_, i) => writes.get(0x39d4a + i)).every((v) => v === 0));
    check("shared reset and effect-clear writes do not overwrite either saved Disk.4 area", [...writes.keys()].every((address) => !inSavedRange(address)));
    check("reset write table records instruction provenance for each write", DISK4_LOAD_RESET.every((write) => write.at.startsWith("$")));
  }
}

// ---- sparse building records -----------------------------------------------------------------------------------
{
  const put8 = (a, slot, bytes) => a.set(bytes, offA(DISK4_ADDR.objects) + slot * 8);
  const img = makeImage(
    (a) => {
      put8(a, 3, [0, 0x45, 0, 0xff, 20, 30, 7, 0]); // tank yard
      put8(a, 5, [0, 0, 9, 9, 9, 9, 9, 9]); // free slot with leftover bytes
      put8(a, 700, [0, 0x60, 2, 0xff, 33, 44, 5, 0]); // mine, far beyond the saved count
      put8(a, 999, [0, 0x4c, 3, 0xff, 50, 40, 0, 0]); // last slot
      put16(a, offA(DISK4_ADDR.mapCells) + (44 * 102 + 33) * 2, 0x0060);
    },
    (b) => {
      put16(b, offB(DISK4_ADDR.countObjects), 3); // counts the records the game would count, not the highest slot
      put16(b, offB(0x133c2), 1); // one mine
    },
  );
  const r = prepareDisk4Load(img, request());
  check("sparse restore ok", r.ok);
  const { world, state } = r.value;
  const rec = (slot) => Array.from(world.objects.subarray(slot * 8, slot * 8 + 8));
  check("records stay in their original slots", rec(3)[1] === 0x45 && rec(700)[1] === 0x60 && rec(700)[4] === 33 && rec(999)[1] === 0x4c);
  check("free slots are not compacted or cleaned", rec(0).every((x) => x === 0) && sameBytes(rec(5), [0, 0, 9, 9, 9, 9, 9, 9]));
  check("saved count is the word, not the highest slot", world.objectCount === 3 && state.word(OBJECT_COUNT_ADDRESS) === 3);

  // Consumers find records beyond objectCount and between holes.
  check("findRecord finds a mine at slot 700 (> objectCount)", findRecord(world, 33, 44) === 700 * 8);
  const hit = [];
  const sim = new Sim(world, { rng: createRng(9), demolishAt: (x, y) => hit.push([x, y]) });
  sim.eventMineCollapse(100);
  check("mine collapse reaches slot 700", hit.length === 1 && hit[0][0] === 33 && hit[0][1] === 44);
  check("randomBuilding skips holes and ignores slots only by emptiness", (() => {
    const seen = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      const s = new Sim(world, { rng: createRng(seed) });
      const spot = s.randomBuilding();
      if (spot) seen.add(`${spot[0]},${spot[1]}`);
    }
    return [...seen].every((k) => ["20,30", "33,44", "50,40"].includes(k)) && seen.size > 0;
  })());
  check("sparse records untouched by the simulation constructor", sameBytes(rec(5), [0, 0, 9, 9, 9, 9, 9, 9]) && rec(700)[6] === 5);
}

// ---- error handling ---------------------------------------------------------------------------------------------
{
  const img = makeImage();
  const before = img.slice();

  for (const [label, scenario] of [["negative", -1], ["== scenarioCount", 10], ["fractional", 1.5], ["NaN", NaN], ["string", "3"], ["undefined", undefined]]) {
    const r = prepareDisk4Load(img, request({ scenario }));
    check(`scenario ${label} -> request/scenario-index`, stageOf(r) === "request" && codeOf(r) === "scenario-index");
  }
  for (const [label, scenarioCount] of [["zero", 0], ["fractional", 2.5], ["missing", undefined]]) {
    const r = prepareDisk4Load(img, request({ scenarioCount }));
    check(`scenarioCount ${label} -> request/scenario-count`, stageOf(r) === "request" && codeOf(r) === "scenario-count");
  }
  check("scenario at the last valid index accepted", prepareDisk4Load(img, request({ scenario: 9 })).ok);
  check("null request -> request/bad-request", codeOf(prepareDisk4Load(img, null)) === "bad-request");

  for (const [label, bytes, code] of [
    ["not bytes", [1, 2, 3], "not-bytes"],
    ["null", null, "not-bytes"],
    ["too short", new Uint8Array(100), "too-short"],
    ["no signature", new Uint8Array(SECTORS * 512), "bad-signature"],
  ]) {
    const r = prepareDisk4Load(bytes, request());
    check(`${label} -> input/${code}`, stageOf(r) === "input" && r.error.error.stage === "disk4" && r.error.error.error.code === code);
  }
  const xpk = new Uint8Array(64); xpk.set([0x58, 0x50, 0x4b, 0x46]);
  check("truncated XPK -> input/decode", (() => { const r = prepareDisk4Load(xpk, request()); return stageOf(r) === "input" && r.error.error.stage === "decode"; })());

  check("empty slot -> slot/slot-empty", (() => { const r = prepareDisk4Load(img, request({ slot: 0 })); return stageOf(r) === "slot" && codeOf(r) === "slot-empty"; })());
  for (const slot of [-1, 10, 1.5, NaN]) {
    const r = prepareDisk4Load(img, request({ slot }));
    check(`slot ${slot} -> slot/slot-index`, stageOf(r) === "slot" && codeOf(r) === "slot-index");
  }
  const badExtent = img.slice();
  put16(badExtent, recOffset(SLOT) + 0x12, A_FIRST + 71); // area A: 72 sectors
  check("wrong area size -> slot/extent-size", (() => { const r = prepareDisk4Load(badExtent, request()); return stageOf(r) === "slot" && codeOf(r) === "extent-size"; })());

  for (const [label, addr, bad] of [["objects", DISK4_ADDR.countObjects, 1001], ["own tanks", DISK4_ADDR.countOwnTanks, 100], ["enemy air", DISK4_ADDR.countEnemyAir, 0xffff]]) {
    const o = makeImage(undefined, (b) => put16(b, offB(addr), bad));
    const r = prepareDisk4Load(o, request());
    check(`${label} count ${bad} -> state/count-range, no value`, stageOf(r) === "state" && codeOf(r) === "count-range" && !("value" in r));
  }
  check("max object count 1000 accepted", prepareDisk4Load(makeImage(undefined, (b) => put16(b, offB(DISK4_ADDR.countObjects), 1000)), request()).ok);
  check("failed loads left the input untouched", sameBytes(img, before));

  // Snapshot constructors on their own.
  const image = new Uint8Array(STATE_BYTES);
  const gs = GameState.fromSnapshot(image);
  check("GameState.fromSnapshot accepts exactly STATE_BYTES", gs.ok && sameBytes(gs.value.snapshot(), image));
  for (const [label, input, code] of [
    ["one byte short", new Uint8Array(STATE_BYTES - 1), "state-size"],
    ["one byte long", new Uint8Array(STATE_BYTES + 1), "state-size"],
    ["empty", new Uint8Array(0), "state-size"],
    ["plain array", new Array(STATE_BYTES).fill(0), "not-bytes"],
    ["null", null, "not-bytes"],
  ]) {
    let r, threw = false;
    try { r = GameState.fromSnapshot(input); } catch { threw = true; }
    check(`GameState.fromSnapshot ${label} -> ${code}`, !threw && !r.ok && r.error.code === code && !("value" in r));
  }

  const good = () => ({ cells: new Uint16Array(7500), cellFlags: new Uint8Array(CELL_FLAG_BYTES), objects: new Uint8Array(8000) });
  const stateOf = (count) => { const im = new Uint8Array(STATE_BYTES); put16(im, OBJECT_COUNT_ADDRESS - 0x13034, count); return GameState.fromSnapshot(im).value; };
  const base = stateOf(0);
  check("World.fromSnapshot accepts exact sizes", World.fromSnapshot(base, good()).ok);
  check("World.fromSnapshot: count 1000 ok, 1001 rejected", World.fromSnapshot(stateOf(1000), good()).ok &&
    (() => { const r = World.fromSnapshot(stateOf(1001), good()); return !r.ok && r.error.code === "object-count"; })());
  for (const [label, patch, code] of [
    ["cells short", { cells: new Uint16Array(7499) }, "map-size"],
    ["cells long", { cells: new Uint16Array(7501) }, "map-size"],
    ["flags short", { cellFlags: new Uint8Array(CELL_FLAG_BYTES - 1) }, "flags-size"],
    ["flags 100-column stride", { cellFlags: new Uint8Array(7500) }, "flags-size"],
    ["objects short", { objects: new Uint8Array(7999) }, "object-size"],
    ["objects long", { objects: new Uint8Array(8001) }, "object-size"],
    ["cells wrong type", { cells: new Uint8Array(7500) }, "not-bytes"],
    ["objects wrong type", { objects: new Array(8000).fill(0) }, "not-bytes"],
  ]) {
    let r, threw = false;
    try { r = World.fromSnapshot(base, { ...good(), ...patch }); } catch { threw = true; }
    check(`World.fromSnapshot ${label} -> ${code}`, !threw && !r.ok && r.error.code === code && !("value" in r));
  }
  check("World.fromSnapshot rejects a non-state and a null snapshot", (() => {
    const a = World.fromSnapshot({}, good());
    const b = World.fromSnapshot(base, null);
    return !a.ok && a.error.code === "not-bytes" && !b.ok && b.error.code === "not-bytes";
  })());
  const stateBefore = base.snapshot();
  const input = good(); input.objects[8] = 1; input.cells[0] = 0x1234;
  const w = World.fromSnapshot(base, input);
  input.objects.fill(0); input.cells.fill(0);
  check("World.fromSnapshot leaves the state alone and copies its inputs", sameBytes(base.snapshot(), stateBefore) &&
    w.ok && w.value.objects[8] === 1 && w.value.cells[0] === 0x1234);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall disk4-load checks passed");
