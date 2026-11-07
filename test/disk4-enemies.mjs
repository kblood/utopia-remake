// Synthetic coverage of detached Disk.4 enemy ground/air hydration (EnemyRoster.fromDisk4,
// prepareDisk4EnemyLoad). No original data is used. Run after `npm run build`.

const { prepareDisk4EnemyLoad, prepareDisk4HeadlessEnemies, prepareDisk4Load } = await import("../dist/game/disk4-load.js");
const { Enemy, EnemyRoster, EnemySystem } = await import("../dist/game/enemies.js");
const { CELL_FLAG_BASE, cellFlagIndex, mapIndex } = await import("../dist/game/cell-flags.js");
const { DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT } = await import("../dist/data/disk4.js");
const { DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES } = await import("../dist/data/disk4-state.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
const put16 = (b, o, v) => { b[o] = v >> 8; b[o + 1] = v & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
const b0Defaults = (e) => e.toggle === false && e.counter === 0 && e.anim === 0;
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

const SECTORS = 1920;
const SLOT = 2;
const A_FIRST = 100;
const B_FIRST = 174;
const STRIDE = 0x1a;
const PTR = 0x16;
const recOffset = (i) => DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + i * DISK4_RECORD_SIZE;

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
const request = () => ({ slot: SLOT, scenario: 4, scenarioCount: 10 });
const groundAt = (i) => offA(DISK4_ADDR.enemyGround) + i * STRIDE;
const airAt = (i) => offA(DISK4_ADDR.enemyAir) + i * STRIDE;
const ptr = (x, y) => CELL_FLAG_BASE + cellFlagIndex(x, y);
// Minimal valid occupied record: type, cell, direction, flag pointer (default: the cell itself).
function put(a, at, type, x, y, dir, pointer = ptr(x, y)) {
  a[at] = type; a[at + 1] = x; a[at + 2] = y; a[at + 5] = dir;
  put32(a, at + PTR, pointer);
}

// ---- sparse hydration, slot identity, field fidelity ------------------------------------------------------------
{
  const fillA = (a) => {
    // ground slot 2: walker, mid-step, reservation (11, 12) differs from the cell (7, 8)
    let at = groundAt(2);
    put(a, at, 22, 7, 8, 3, ptr(11, 12));
    a[at + 3] = 0xfd; a[at + 4] = 2; a[at + 6] = 0xff; a[at + 7] = 1; a[at + 8] = 0x33; a[at + 9] = 0x85; a[at + 10] = 6;
    a[at + 11] = 20; a[at + 12] = 21; a[at + 0x0d] = 9; a[at + 0x0e] = 40; a[at + 0x0f] = 5;
    a[at + 0x10] = 0xff; a[at + 0x11] = 1; a[at + 0x12] = 3; a[at + 0x13] = 0xaa; a[at + 0x14] = 0x77; a[at + 0x15] = 0x66;
    // ground slot 41: crusher with +$13 = toggle (bit 7) + counter 3 and +$14 = 5 (decoded by hydration, rejected only at adoption)
    at = groundAt(41);
    put(a, at, 24, 50, 60, 6);
    a[at + 9] = 0x01; a[at + 0x13] = 0x83; a[at + 0x14] = 0x05; a[at + 0x15] = 0xee;
    // ground slot 59 (last): defected tank type 10 on the last map cell
    put(a, groundAt(59), 10, 99, 74, 0);
    // ground slot 5: FREE with stale bytes, including a pointer that would be invalid if occupied
    at = groundAt(5);
    a.set([0, 200, 200, 1, 2, 9, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], at); put32(a, at + PTR, 0xdeadbeef);
    // air slot 0: bomber, signed +$13, lift $22
    at = airAt(0);
    put(a, at, 25, 3, 4, 5, ptr(4, 4));
    a[at + 8] = 12; a[at + 9] = 0x06; a[at + 0x0d] = 2; a[at + 0x0e] = 30; a[at + 0x0f] = 4; a[at + 0x10] = 0x22;
    a[at + 0x11] = 0x5a; a[at + 0x12] = 0xa5; a[at + 0x13] = 0xfe; a[at + 0x14] = 55; a[at + 0x15] = 1;
    // air slot 29 (last): fast kamikaze
    at = airAt(29);
    put(a, at, 27, 20, 30, 7); a[at + 9] = 0x87; a[at + 0x10] = 0x1c; a[at + 0x13] = 0x10;
    // air slot 7: free, stale
    a.set([0, 9, 9, 9, 9, 9, 9, 9, 9, 9], airAt(7));
    // Noisy flags and map so any write by hydration would show.
    const flags = offA(DISK4_ADDR.flags);
    for (let i = 0; i < 7650; i++) a[flags + i] = (i * 7 + 3) & 0xff;
    const map = offA(DISK4_ADDR.mapCells);
    for (let y = 0; y < 75; y++) for (let x = 0; x < 102; x++) put16(a, map + (y * 102 + x) * 2, x < 100 ? ((y * 100 + x) * 5) & 0xffff : 0x73ff);
  };
  // Saved counts deliberately disagree with the occupied records: they are reported, never iteration bounds.
  const fillB = (b) => { put16(b, offB(DISK4_ADDR.countEnemyGround), 1); put16(b, offB(DISK4_ADDR.countEnemyAir), 9); };
  const img = makeImage(fillA, fillB);
  const before = img.slice();
  const areaB0 = img.slice(B_FIRST * 512, B_FIRST * 512 + DISK4_AREA_B_BYTES);
  let rngCalls = 0;
  const r = prepareDisk4EnemyLoad(img, request(), { rng: () => { rngCalls++; return 0; } });
  check("enemy preparation succeeds", r.ok);
  if (!r.ok) throw new Error(`enemy preparation failed: ${JSON.stringify(r.error)}`);
  const v = r.value;
  const g = v.enemies.ground;
  const a = v.enemies.air;

  check("fixed slot arrays 60/30", g.length === 60 && a.length === 30);
  check("occupied ground slots keep their indices, others stay null", g.map((e, i) => (e ? i : -1)).filter((i) => i >= 0).join() === "2,41,59");
  check("occupied air slots keep their indices, others stay null", a.map((e, i) => (e ? i : -1)).filter((i) => i >= 0).join() === "0,29");
  check("slot identity and addresses", g[2].slot === 2 && g[41].slot === 41 && g[59].slot === 59 && a[0].slot === 0 && a[29].slot === 29 &&
    g[41].sourceAddress === DISK4_ADDR.enemyGround + 41 * STRIDE && a[29].sourceAddress === DISK4_ADDR.enemyAir + 29 * STRIDE);
  check("occupied accessors list stable slot order", v.enemies.groundEnemies.map((e) => e.slot).join() === "2,41,59" && v.enemies.airEnemies.map((e) => e.slot).join() === "0,29");
  check("counts that disagree with occupancy do not affect hydration", v.entities.enemyGround.storedCount === 1 && v.entities.enemyAir.storedCount === 9 &&
    v.entities.enemyGround.occupiedCount === 3 && v.entities.enemyAir.occupiedCount === 2);

  // free slots: runtime null, decoded data retains stale bytes
  check("free ground slot stays null while the decoded slot keeps stale bytes", g[5] === null &&
    v.entities.enemyGround.slots[5].status === "free" && v.entities.enemyGround.slots[5].x === 200 && v.entities.enemyGround.slots[5].flagPointer === 0xdeadbeef);
  check("free air slot stays null while the decoded slot keeps stale bytes", a[7] === null && v.entities.enemyAir.slots[7].raw[1] === 9);

  const w = g[2];
  check("ground walker fields exact", w.type === 22 && w.air === false && w.x === 7 && w.y === 8 && w.dx === -3 && w.dy === 2 && w.dir === 3 &&
    w.vx === -1 && w.vy === 1 && w.hp === 0x33 && w.tech === 6 && w.targetX === 20 && w.targetY === 21 && w.steps === 9 && w.bombPct === 40 && w.dmg === 5);
  check("control byte kept whole, split into mode and waiting", w.savedControl === 0x85 && w.mode === 5 && w.waiting === true);
  check("ground recent directions, aux (unsigned), +$14/+$15 kept", sameBytes(w.recent, [0xff, 1, 3]) && w.aux === 0xaa && w.p14 === 0x77 && w.p15 === 0x66 && w.lift === 0);
  check("reservation comes from the pointer, not x/y", w.reserveX === 11 && w.reserveY === 12 && w.flagPointer === ptr(11, 12));
  check("raw record bytes kept (copy)", w.sourceRaw.length === STRIDE && sameBytes(w.sourceRaw, v.entities.enemyGround.slots[2].raw) && w.sourceRaw !== v.entities.enemyGround.slots[2].raw);

  const c = g[41];
  check("crusher raw bytes preserved and +$13/+$14 decoded as toggle/counter/animation", c.type === 24 && c.aux === 0x83 && c.p14 === 0x05 &&
    c.sourceRaw[0x13] === 0x83 && c.sourceRaw[0x14] === 5 && c.sourceRaw[0x15] === 0xee && c.toggle === true && c.counter === 3 && c.anim === 5);
  check("non-crushers keep the constructor defaults for the crusher fields", w.toggle === false && w.counter === 0 && w.anim === 0 && b0Defaults(a[0]));
  check("not waiting when bit 7 is clear", c.waiting === false && c.mode === 1 && c.savedControl === 0x01);
  check("edge cell and defected tank type accepted", g[59].type === 10 && g[59].x === 99 && g[59].y === 74 && g[59].reserveX === 99 && g[59].reserveY === 74);

  const b = a[0];
  check("air bomber fields exact", b.type === 25 && b.air === true && b.lift === 0x22 && b.mode === 6 && b.waiting === false && b.aux === -2 &&
    b.p14 === 55 && b.p15 === 1 && b.steps === 2 && b.bombPct === 30 && b.dmg === 4 && b.hp === 12 && b.reserveX === 4 && b.reserveY === 4);
  check("air +$11/+$12 stay raw only", sameBytes(b.recent, [0xff, 0xff, 0xff]) && b.sourceRaw[0x11] === 0x5a && b.sourceRaw[0x12] === 0xa5);
  check("air fast kamikaze keeps lift and raw +9 mode byte", a[29].type === 27 && a[29].lift === 0x1c && a[29].aux === 0x10 && a[29].dir === 7 &&
    a[29].savedControl === 0x87 && a[29].mode === 0x87 && a[29].waiting === false);

  // pointer stride is 102, not the 100-word map stride
  const wrongStride = CELL_FLAG_BASE + 12 * 100 + 11;
  check("102-byte row stride differs from the 100-cell map stride", wrongStride !== ptr(11, 12) && cellFlagIndex(11, 12) === 12 * 102 + 11 && mapIndex(11, 12) === 12 * 100 + 11);

  // buffers: same objects, untouched, equal to a plain load of the same bytes
  const plain = prepareDisk4Load(before, request());
  check("roster shares the world map and flag buffers", v.enemies.cells === v.world.cells && v.enemies.flags === v.world.cellFlags &&
    v.sim.world === v.world && v.tanks.flags === v.world.cellFlags);
  check("map words and all flag bytes unchanged by hydration", plain.ok && sameBytes(v.world.cellFlags, plain.value.world.cellFlags) && sameBytes(v.world.cells, plain.value.world.cells));
  check("no occupancy bit written at saved cells or reservations", [[7, 8], [11, 12], [50, 60], [3, 4], [4, 4]].every(([x, y]) =>
    v.world.cellFlags[cellFlagIndex(x, y)] === plain.value.world.cellFlags[cellFlagIndex(x, y)] && v.world.cells[mapIndex(x, y)] === plain.value.world.cells[mapIndex(x, y)]));
  check("state image, counts and RNG untouched", sameBytes(v.state.snapshot(), areaB0) && rngCalls === 0 && v.sim.events.length === 0);

  // immutability / detachment
  check("input image not modified", sameBytes(img, before));
  img.fill(0);
  const g2 = A_FIRST * 512 + groundAt(2);
  check("result independent of the input image", g[2].x === 7 && sameBytes(g[2].sourceRaw, before.subarray(g2, g2 + STRIDE)));
  g[2].sourceRaw[0] ^= 0xff;
  check("mutating an enemy leaves the decoded slot alone", v.entities.enemyGround.slots[2].raw[0] === 22);
  g[2].hp = 1; g[2].x = 9;
  const again = prepareDisk4EnemyLoad(before, request());
  check("a later preparation is unaffected", again.ok && again.value.enemies.ground[2].hp === 0x33 && again.value.enemies.ground[2].x === 7);
  check("preparation is repeatable and slot-stable", again.ok && again.value.enemies.ground.every((e, i) => (e === null) === (g[i] === null)));
}

// ---- invalid occupied records ------------------------------------------------------------------------------------
{
  const cases = [
    ["ground record with an air type", (a) => put(a, groundAt(4), 25, 5, 5, 0), "enemyGround", 4, "enemy-type"],
    ["ground record with unknown type", (a) => put(a, groundAt(4), 99, 5, 5, 0), "enemyGround", 4, "enemy-type"],
    ["ground record with own ship type", (a) => put(a, groundAt(4), 11, 5, 5, 0), "enemyGround", 4, "enemy-type"],
    ["air record with a ground type", (a) => put(a, airAt(3), 22, 5, 5, 0), "enemyAir", 3, "enemy-type"],
    ["air record with a defected tank type", (a) => put(a, airAt(3), 9, 5, 5, 0), "enemyAir", 3, "enemy-type"],
    ["ground x off the map", (a) => put(a, groundAt(10), 22, 100, 5, 0, ptr(5, 5)), "enemyGround", 10, "position"],
    ["ground y off the map", (a) => put(a, groundAt(10), 22, 5, 75, 0, ptr(5, 5)), "enemyGround", 10, "position"],
    ["air x off the map", (a) => put(a, airAt(1), 26, 0xff, 5, 0, ptr(5, 5)), "enemyAir", 1, "position"],
    ["ground direction 8", (a) => put(a, groundAt(0), 23, 5, 5, 8), "enemyGround", 0, "direction"],
    ["air direction 0xff", (a) => put(a, airAt(0), 25, 5, 5, 0xff), "enemyAir", 0, "direction"],
  ];
  for (const [label, fill, list, slot, code] of cases) {
    const img = makeImage(fill);
    const before = img.slice();
    const r = prepareDisk4EnemyLoad(img, request());
    check(`${label} -> enemies/${code} (${list} slot ${slot}), no partial value`, !r.ok && r.error.stage === "enemies" &&
      r.error.error.code === code && r.error.error.list === list && r.error.error.slot === slot && !("value" in r));
    check(`${label}: input untouched`, sameBytes(img, before));
  }
  // The same invalid fields in a FREE slot (type 0) are decoded, not rejected.
  const free = makeImage((a) => {
    a.set([0, 250, 250, 0, 0, 77], groundAt(4)); put32(a, groundAt(4) + PTR, 1);
    a.set([0, 250, 250, 0, 0, 77], airAt(4));
  });
  const fr = prepareDisk4EnemyLoad(free, request());
  check("invalid fields in free slots do not fail the load", fr.ok && fr.value.enemies.ground[4] === null && fr.value.enemies.air[4] === null &&
    fr.value.entities.enemyGround.slots[4].direction === 77);
  check("an empty save hydrates all-null rosters", (() => {
    const e = prepareDisk4EnemyLoad(makeImage(), request());
    return e.ok && e.value.enemies.groundEnemies.length === 0 && e.value.enemies.airEnemies.length === 0;
  })());
  check("earlier-stage errors pass through unchanged", (() => {
    const e = prepareDisk4EnemyLoad(makeImage(), { slot: 0, scenario: 4, scenarioCount: 10 });
    return !e.ok && e.error.stage === "slot";
  })());
}

// ---- EnemyRoster.fromDisk4 shape errors ------------------------------------------------------------------------
{
  const r = prepareDisk4Load(makeImage((a) => put(a, groundAt(0), 22, 5, 5, 0)), request());
  const { world, entities } = r.value;
  const ground = entities.enemyGround.slots;
  const air = entities.enemyAir.slots;
  const code = (res) => (res.ok ? "ok" : res.error.code);
  check("roster builds from decoded slots", EnemyRoster.fromDisk4(world.cells, world.cellFlags, ground, air).ok);
  check("short ground list -> slot-count", code(EnemyRoster.fromDisk4(world.cells, world.cellFlags, ground.slice(0, 59), air)) === "slot-count");
  check("long air list -> slot-count", code(EnemyRoster.fromDisk4(world.cells, world.cellFlags, ground, [...air, air[0]])) === "slot-count");
  const shifted = ground.slice(); shifted[3] = ground[4];
  check("swapped slot -> slot-index", code(EnemyRoster.fromDisk4(world.cells, world.cellFlags, shifted, air)) === "slot-index");
  check("air slots in the ground list -> slot-index", code(EnemyRoster.fromDisk4(world.cells, world.cellFlags, air.concat(air).slice(0, 60), air)) === "slot-index");
  const short = ground.slice(); short[0] = { ...ground[0], raw: ground[0].raw.slice(0, 0x18) };
  check("short raw record -> slot-index", code(EnemyRoster.fromDisk4(world.cells, world.cellFlags, short, air)) === "slot-index");
  check("100-column flag plane -> buffers", code(EnemyRoster.fromDisk4(world.cells, new Uint8Array(7500), ground, air)) === "buffers");
  check("short cells -> buffers", code(EnemyRoster.fromDisk4(new Uint16Array(7499), world.cellFlags, ground, air)) === "buffers");
  check("wrong buffer type -> buffers", code(EnemyRoster.fromDisk4(new Uint8Array(7500), world.cellFlags, ground, air)) === "buffers");
  check("Enemy built directly stays a plain spawn-style object", (() => {
    const e = new Enemy(22, 1, 2, 3, 8, 1, 0, false);
    return e.slot === -1 && e.sourceRaw === null && e.sourceAddress === null && e.flagPointer === null && e.savedControl === null && e.tech === 0;
  })());
}

// ---- inert headless EnemySystem adoption ----------------------------------------------------------------------
{
  const tables = {
    spiral: Array.from({ length: 48 }, () => [0, 0]),
    arcs: Array.from({ length: 8 }, () => Array.from({ length: 32 }, () => [0, 0])),
    turn: Array(64).fill(0), crusherAnim: Array(8).fill(0),
  };
  const img = makeImage((a) => {
    put(a, groundAt(0), 22, 5, 5, 0); put(a, groundAt(59), 23, 7, 8, 3);
    put(a, airAt(0), 25, 9, 9, 2); put(a, airAt(29), 26, 11, 12, 6);
    // Preserve runtime fields that differ from defaults; reservation is deliberately not x/y.
    const g = groundAt(59);
    a[g + 3] = 0xff; a[g + 4] = 0xfe; a[g + 6] = 0x7f; a[g + 7] = 0x80; a[g + 9] = 0x81;
    put32(a, g + PTR, ptr(14, 15));
  }, (b) => { b[offB(0x144c9)] = 3; });
  const prepared = prepareDisk4EnemyLoad(img, request());
  const { sim, tanks, enemies, world, state } = prepared.value;
  const cellsBefore = world.cells.slice(), flagsBefore = world.cellFlags.slice(), objectsBefore = world.objects.slice();
  const stateBefore = state.bytes.slice();
  let rngCalls = 0, hookCalls = 0;
  sim.rng = (range) => { rngCalls++; return range - 1; };
  const adopted = EnemySystem.fromRoster(sim, tanks, tables, enemies, { sound: () => hookCalls++ });
  check("adoption succeeds without initializing enemies", adopted.ok && adopted.value.groundSlots === enemies.ground && adopted.value.airSlots === enemies.air);
  check("sparse edge slots retain identity", adopted.ok && adopted.value.groundSlots[59] === enemies.ground[59] && adopted.value.airSlots[29] === enemies.air[29]);
  check("saved runtime fields and reservation survive adoption", adopted.ok && enemies.ground[59].mode === 1 && enemies.ground[59].waiting &&
    enemies.ground[59].dx === -1 && enemies.ground[59].dy === -2 && enemies.ground[59].vx === 127 &&
    enemies.ground[59].reserveX === 14 && enemies.ground[59].reserveY === 15);
  check("adoption leaves state, map, flags and object bytes unchanged", sameBytes(state.bytes, stateBefore) && sameBytes(world.cells, cellsBefore) &&
    sameBytes(world.cellFlags, flagsBefore) && sameBytes(world.objects, objectsBefore));
  check("adoption consumes no RNG and calls no hooks", rngCalls === 0 && hookCalls === 0);
  if (adopted.ok) {
    const again = EnemySystem.fromRoster(sim, tanks, tables, enemies);
    check("a roster cannot be adopted into a second live controller", !again.ok && again.error.code === "already-adopted");
    const savedEnemy = enemies.ground[59];
    check("adoption preserves the saved tank pass-clock sub-tick", tanks.clock.sub === 3);
    adopted.value.pass(tanks.clock);
    check("saved waiting state gates a non-enemy pass", savedEnemy.waiting && savedEnemy.mode === 1);
    tanks.clock.advance();
    adopted.value.pass(tanks.clock);
    check("explicit enemy pass resumes the saved walker", !savedEnemy.waiting && savedEnemy.mode === 1);
  }

  const crusherImage = makeImage((a) => put(a, groundAt(4), 24, 6, 6, 0));
  const composed = prepareDisk4HeadlessEnemies(img, request(), tables);
  check("headless preparation returns the adopted enemy system", composed.ok && composed.value.enemySystem.groundSlots === composed.value.enemies.ground);
  const crusherLoad = prepareDisk4EnemyLoad(crusherImage, request());
  const { sim: csim, tanks: ctanks, enemies: cenemies, world: cworld, state: cstate } = crusherLoad.value;
  const cCells = cworld.cells.slice(), cFlags = cworld.cellFlags.slice(), cState = cstate.bytes.slice();
  const crusher = EnemySystem.fromRoster(csim, ctanks, tables, cenemies);
  check("a crusher with +$13 = 0 and +$14 = 0 is adopted (supported state)", crusher.ok && crusher.value.groundSlots[4] === cenemies.ground[4] && cenemies.ground[4].type === 24);
  check("crusher adoption is inert", sameBytes(cworld.cells, cCells) && sameBytes(cworld.cellFlags, cFlags) && sameBytes(cstate.bytes, cState));
  const composedCrusher = prepareDisk4HeadlessEnemies(crusherImage, request(), tables);
  check("headless preparation composes a crusher", composedCrusher.ok && composedCrusher.value.enemySystem.groundSlots[4]?.type === 24);
  // Out-of-domain crusher bytes stay typed, atomic refusals (details: test/disk4-crusher.mjs).
  const badCounter = makeImage((a) => { put(a, groundAt(4), 24, 6, 6, 0); a[groundAt(4) + 0x13] = 0x09; });
  const bc = prepareDisk4HeadlessEnemies(badCounter, request(), tables);
  check("crusher counter 9 -> typed unsupported-state crusher-counter at the enemy-system stage", !bc.ok && bc.error.stage === "enemy-system" &&
    bc.error.error.code === "unsupported-state" && bc.error.error.reason === "crusher-counter" && bc.error.error.slot === 4);
  const badAnim = makeImage((a) => { put(a, groundAt(4), 24, 6, 6, 0); a[groundAt(4) + 0x14] = 0x01; }); // the table above is all 0
  const ba = prepareDisk4HeadlessEnemies(badAnim, request(), tables);
  check("crusher animation above the table maximum -> crusher-anim", !ba.ok && ba.error.error.reason === "crusher-anim");
}

// ---- raw +$16 of every slot: any unsigned long survives hydration and adoption (free AND occupied) --------------------
// Static Disk.1 trace: the allocators leave +$16 untouched, so an occupied record can hold zero, a padding byte, an
// out-of-range long or a stale cell. Nothing is rejected on the pointer; only a playable cell becomes the reserve mirror.
{
  const tables = {
    spiral: Array.from({ length: 48 }, () => [0, 0]),
    arcs: Array.from({ length: 8 }, () => Array.from({ length: 32 }, () => [0, 0])),
    turn: Array(64).fill(0), crusherAnim: Array(8).fill(0),
  };
  const PAD = CELL_FLAG_BASE + 3 * 102 + 100;
  const stale = ptr(20, 21);
  const img = makeImage((a) => {
    put(a, groundAt(0), 22, 5, 5, 0, 0);                    // occupied, zero (a wave enemy before its first claim)
    put(a, groundAt(1), 22, 6, 6, 0, PAD);                  // occupied, padding column 100
    put(a, groundAt(2), 23, 7, 7, 0, CELL_FLAG_BASE - 1);   // occupied, below the flag array
    put(a, groundAt(3), 22, 8, 8, 0, 0xdeadbeef);           // occupied, far outside
    put(a, groundAt(4), 22, 9, 9, 0, ptr(11, 12));          // occupied, playable and different from x/y
    put32(a, groundAt(5) + PTR, stale);                     // FREE slot 5 with a stale playable pointer
    put32(a, groundAt(7) + PTR, 0xffffffff);                // FREE slot 7 with an unresolvable long
    put(a, airAt(0), 25, 3, 4, 2, CELL_FLAG_BASE + 7650);   // occupied air, one past the array
    put32(a, airAt(5) + PTR, ptr(30, 31));                  // FREE air slot 5
  });
  const p = prepareDisk4HeadlessEnemies(img, request(), tables);
  check("occupied records with zero / padding / out-of-range +$16 are NOT rejected", p.ok);
  if (!p.ok) throw new Error(`headless preparation failed: ${JSON.stringify(p.error)}`);
  const { enemies: roster, enemySystem: sys, world } = p.value;
  const gp = roster.groundPointers, ap = roster.airPointers;
  check("raw pointer arrays hold 60 + 30 unsigned longs, occupied and free alike", gp.length === 60 && ap.length === 30 && gp[0] === 0 && gp[1] === PAD && gp[2] === CELL_FLAG_BASE - 1 && gp[3] === 0xdeadbeef &&
    gp[4] === ptr(11, 12) && gp[5] === stale && gp[7] === 0xffffffff && gp[6] === 0 && ap[0] === CELL_FLAG_BASE + 7650 && ap[5] === ptr(30, 31) && ap[1] === 0);
  const g = roster.ground, a = roster.air;
  check("reserve mirror is -1/-1 unless the pointer names a playable cell (not x/y)", [0, 1, 2, 3].every((i) => g[i].reserveX === -1 && g[i].reserveY === -1) && g[4].reserveX === 11 && g[4].reserveY === 12 &&
    a[0].reserveX === -1 && a[0].reserveY === -1 && g[0].flagPointer === 0 && g[3].flagPointer === 0xdeadbeef);
  check("free slots stay null with their raw pointer retained", g[5] === null && g[7] === null && a[5] === null);
  check("adoption works directly on the roster's pointer arrays and keeps every value", sys.groundFlagPointers === gp && sys.airFlagPointers === ap && sys.groundFlagPointers[5] === stale && sys.groundFlagPointers[7] === 0xffffffff && sys.airFlagPointers[5] === ptr(30, 31));
  check("a non-unsigned-long pointer in a free record is still a typed refusal", (() => {
    const fake = { ...p.value.entities.enemyGround.slots[5], flagPointer: -1 };
    const slots = p.value.entities.enemyGround.slots.map((s, i) => (i === 5 ? fake : s));
    const r = EnemyRoster.fromDisk4(world.cells, world.cellFlags, slots, p.value.entities.enemyAir.slots);
    return !r.ok && r.error.code === "flag-pointer" && r.error.slot === 5;
  })());

  // death: only a playable named cell is released; the raw pointer stays in the freed slot
  const OCC = 0x4000;
  world.cells[mapIndex(5, 5)] |= OCC;                         // slot 0: zero pointer -> nothing released, its own bit leaks
  world.cellFlags[3 * 102 + 100] = 1;                         // slot 1: padding byte -> released by nothing in this port
  world.cells[mapIndex(11, 12)] |= OCC; world.cellFlags[cellFlagIndex(11, 12)] |= 1; // slot 4: the named cell
  sys.destroyGround(g[0], false); sys.destroyGround(g[1], false); sys.destroyGround(g[4], false);
  check("death of a zero / padding pointer releases nothing; a playable pointer releases exactly its cell", (world.cells[mapIndex(5, 5)] & OCC) !== 0 && world.cellFlags[3 * 102 + 100] === 1 &&
    (world.cells[mapIndex(11, 12)] & OCC) === 0 && (world.cellFlags[cellFlagIndex(11, 12)] & 1) === 0);
  check("raw pointers survive death (zero, padding, the claimed cell)", sys.groundFlagPointers[0] === 0 && sys.groundFlagPointers[1] === PAD && sys.groundFlagPointers[4] === ptr(11, 12));
  // reuse of the free slot with the stale pointer: slots 0, 1 and 4 are free again, so the 4th spawn reaches free slot 5
  for (let i = 0; i < 3; i++) {
    if (!sys.spawn({ air: false, type: 22, x: 60 + i, y: 60, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0], origin: "wave" })) throw new Error("refill failed");
  }
  const reuse = { air: false, type: 22, x: 40, y: 40, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0], origin: "wave" };
  check("wave spawn into free slot 5 keeps the stale pointer; the mirror shows the stale cell", sys.spawn(reuse) && sys.groundSlots[5] !== null && sys.groundFlagPointers[5] === stale && sys.groundSlots[5].reserveX === 20 && sys.groundSlots[5].reserveY === 21);
  world.cells[mapIndex(20, 21)] |= OCC; world.cellFlags[cellFlagIndex(20, 21)] |= 1;
  sys.destroyGround(sys.groundSlots[5], false);
  check("its pre-move death clears only the stale cell and leaves the spawn cell's map bit; pointer unchanged", (world.cells[mapIndex(20, 21)] & OCC) === 0 && (world.cells[mapIndex(40, 40)] & OCC) !== 0 && sys.groundFlagPointers[5] === stale);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall disk4-enemies checks passed");
