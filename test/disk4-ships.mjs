// Synthetic coverage of detached Disk.4 own-ship hydration (ShipRoster.fromDisk4, prepareDisk4ShipLoad):
// ship types 11-16 and distinct missile (type 17) records with a typed enemy-slot target ref.
// No original data is used. Run after `npm run build`.

const { prepareDisk4ShipLoad, prepareDisk4EnemyLoad, prepareDisk4Load } = await import("../dist/game/disk4-load.js");
const { ShipRoster, resolveEnemyRecordPointer, ENEMY_AIR_HEADER } = await import("../dist/game/ship-roster.js");
const { CELL_FLAG_BASE, cellFlagIndex, mapIndex } = await import("../dist/game/cell-flags.js");
const { DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT } = await import("../dist/data/disk4.js");
const { DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES } = await import("../dist/data/disk4-state.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
const put16 = (b, o, v) => { b[o] = v >> 8; b[o + 1] = v & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

const SECTORS = 1920;
const SLOT = 2;
const A_FIRST = 100;
const B_FIRST = 174;
const STRIDE = 0x18;
const PTR = 0x14;
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
const shipAt = (i) => offA(DISK4_ADDR.ownShips) + i * STRIDE;
const ptr = (x, y) => CELL_FLAG_BASE + cellFlagIndex(x, y);
// Minimal valid occupied ship: type, cell, direction, class = type - 11, mode, candidate pointer (default: its cell).
function put(a, at, type, x, y, dir, mode = 0, pointer = ptr(x, y), cls = type - 11) {
  a[at] = type; a[at + 1] = x; a[at + 2] = y; a[at + 5] = dir; a[at + 9] = mode; a[at + 0x0d] = cls;
  put32(a, at + PTR, pointer);
}

// ---- sparse hydration, slot identity, exact fields -------------------------------------------------------------
{
  const fillA = (a) => {
    // slot 3: class 4 ship, flying, every documented field distinct, candidate pointer names ANOTHER cell
    let at = shipAt(3);
    put(a, at, 15, 7, 8, 3, 2, ptr(11, 12));
    a[at + 3] = 0xfd; a[at + 4] = 2; a[at + 6] = 0xff; a[at + 7] = 0x7f; a[at + 8] = 0x33; a[at + 10] = 6;
    a[at + 11] = 20; a[at + 12] = 21; put16(a, at + 0x0e, 0xfedc); a[at + 0x10] = 0x1c; a[at + 0x11] = 4; a[at + 0x12] = 2;
    a[at + 0x13] = 0xaa; // +$13 is not a documented ship field: raw only
    // slot 0: class 0, parked frame (direction 8), mode 0, zero fuel, target none ($FF), pointer = own cell
    at = shipAt(0);
    put(a, at, 11, 4, 5, 8, 0);
    a[at + 11] = 0xff; a[at + 12] = 0xff; a[at + 8] = 9;
    // slot 39 (last): class 5, mode 8 (landing), map corner, pointer in padding column 100 (not rejected)
    at = shipAt(39);
    put(a, at, 16, 99, 74, 0, 8, CELL_FLAG_BASE + 74 * 102 + 100);
    // slot 17: class 1, pointer beyond the array and mode at its upper bound
    at = shipAt(17);
    put(a, at, 12, 0, 0, 1, 8, 0xdeadbeef);
    // slot 20: class 2, pointer zero (out-of-range)
    put(a, shipAt(20), 13, 50, 60, 6, 3, 0);
    // slot 5: FREE with stale bytes, including values that would be invalid if occupied (and a type-17-like layout)
    at = shipAt(5);
    a.set([0, 200, 200, 1, 2, 99, 3, 4, 5, 77, 7, 8, 9, 99], at); put32(a, at + PTR, 0xdeadbeef);
    // slot 6: FREE, type 0, otherwise a perfectly valid record
    put(a, shipAt(6), 0, 3, 3, 1);
    // noisy flags and map so any write by hydration would show
    const flags = offA(DISK4_ADDR.flags);
    for (let i = 0; i < 7650; i++) a[flags + i] = (i * 7 + 3) & 0xff;
    const map = offA(DISK4_ADDR.mapCells);
    for (let y = 0; y < 75; y++) for (let x = 0; x < 102; x++) put16(a, map + (y * 102 + x) * 2, x < 100 ? ((y * 100 + x) * 5) & 0xffff : 0x73ff);
  };
  // Saved count disagrees with occupancy (5 occupied, count 1): reported, never an iteration bound.
  const fillB = (b) => { put16(b, offB(DISK4_ADDR.countOwnShips), 1); };
  const img = makeImage(fillA, fillB);
  const before = img.slice();
  const areaB0 = img.slice(B_FIRST * 512, B_FIRST * 512 + DISK4_AREA_B_BYTES);
  let rngCalls = 0;
  const r = prepareDisk4ShipLoad(img, request(), { rng: () => { rngCalls++; return 0; } });
  check("ship preparation succeeds", r.ok);
  if (!r.ok) throw new Error(`ship preparation failed: ${JSON.stringify(r.error)}`);
  const v = r.value;
  const s = v.ships.slots;

  check("fixed 40-slot array", s.length === 40);
  check("occupied slots keep their indices, others stay null", s.map((e, i) => (e ? i : -1)).filter((i) => i >= 0).join() === "0,3,17,20,39");
  check("occupied accessor lists stable slot order", v.ships.ships.map((e) => e.slot).join() === "0,3,17,20,39");
  check("slot identity and addresses", s[3].slot === 3 && s[39].slot === 39 &&
    s[3].sourceAddress === DISK4_ADDR.ownShips + 3 * STRIDE && s[39].sourceAddress === DISK4_ADDR.ownShips + 39 * STRIDE);
  check("saved count that disagrees with occupancy does not affect hydration", v.entities.ownShips.storedCount === 1 && v.entities.ownShips.occupiedCount === 5);

  const w = s[3];
  check("exact documented fields", w.type === 15 && w.x === 7 && w.y === 8 && w.dx === -3 && w.dy === 2 && w.dir === 3 && w.hp === 0x33 &&
    w.tech === 6 && w.targetX === 20 && w.targetY === 21 && w.cls === 4 && w.lift === 0x1c);
  check("fuel word is the unsigned big-endian word, unclamped", w.fuel === 0xfedc);
  check("full +9 byte kept as mode and savedControl", w.mode === 2 && w.savedControl === 2);
  check("typed extra record: signed velocities, next, turn", w.extra.vx === -1 && w.extra.vy === 0x7f && w.extra.next === 4 && w.extra.turn === 2);
  check("exact raw record kept (copy, full length, undocumented bytes inside)", w.sourceRaw.length === STRIDE &&
    sameBytes(w.sourceRaw, v.entities.ownShips.slots[3].raw) && w.sourceRaw !== v.entities.ownShips.slots[3].raw &&
    w.sourceRaw[0x13] === 0xaa && w.sourceRaw[0x14] === (ptr(11, 12) >>> 24) && (((w.sourceRaw[0x14] << 24) | (w.sourceRaw[0x15] << 16) | (w.sourceRaw[0x16] << 8) | w.sourceRaw[0x17]) >>> 0) === ptr(11, 12));
  check("ship has no tank/enemy-only derived fields", !("waiting" in w) && !("reserveX" in w) && !("recent" in w));

  // +$14 flag pointer (VERIFIED as a per-cell flag-byte pointer at creation): raw preserved, classified, never rejected or repaired
  const p = w.flagPointer;
  check("flag pointer raw kept and labelled VERIFIED", p.semantics === "VERIFIED" && p.raw === ptr(11, 12) && w.kind === "ship");
  check("flag pointer classified at the cell it names, not at x/y", p.target.kind === "playable" && p.target.x === 11 && p.target.y === 12 &&
    p.target.index === cellFlagIndex(11, 12) && !(p.target.x === w.x && p.target.y === w.y) && p.atOwnCell === false);
  check("flag pointer at the ship's own cell classifies there", s[0].flagPointer.target.kind === "playable" && s[0].flagPointer.target.x === 4 && s[0].flagPointer.target.y === 5 && s[0].flagPointer.atOwnCell === true);
  check("padding pointer kept, classified padding, not rejected", s[39].flagPointer.target.kind === "padding" && s[39].flagPointer.target.x === 100 && s[39].flagPointer.target.y === 74 && s[39].flagPointer.atOwnCell === false);
  check("out-of-range pointers kept raw, not rejected", s[17].flagPointer.raw === 0xdeadbeef && s[17].flagPointer.target.kind === "out-of-range" &&
    s[20].flagPointer.raw === 0 && s[20].flagPointer.target.kind === "out-of-range");
  check("no leftover pointerCandidate field", !("pointerCandidate" in w));

  // boundary values accepted unchanged
  check("parked frame direction 8, mode 0, no-target $FF kept as stored", s[0].dir === 8 && s[0].mode === 0 && s[0].targetX === 0xff && s[0].targetY === 0xff && s[0].fuel === 0 && s[0].hp === 9);
  check("edge cell, class 5, mode 8 accepted", s[39].type === 16 && s[39].cls === 5 && s[39].mode === 8 && s[39].x === 99 && s[39].y === 74);
  check("origin cell, class 1, mode 8 accepted", s[17].type === 12 && s[17].cls === 1 && s[17].x === 0 && s[17].y === 0 && s[17].mode === 8);

  // free slots: runtime null, decoded data retains stale bytes
  check("free stale slot stays null while the decoded slot keeps stale bytes", s[5] === null && v.entities.ownShips.slots[5].status === "free" &&
    v.entities.ownShips.slots[5].x === 200 && v.entities.ownShips.slots[5].direction === 99 && v.entities.ownShips.slots[5].flagPointer === 0xdeadbeef);
  check("free slot with otherwise valid fields stays null", s[6] === null && v.entities.ownShips.slots[6].x === 3);

  // zero side effects: earlier layers equal a plain load of the same bytes
  const plain = prepareDisk4Load(before, request());
  check("map words and all flag bytes unchanged by ship hydration", plain.ok && sameBytes(v.world.cellFlags, plain.value.world.cellFlags) && sameBytes(v.world.cells, plain.value.world.cells));
  check("no occupancy bit written at saved cells or candidate-pointer cells", [[7, 8], [11, 12], [4, 5], [99, 74], [0, 0], [50, 60]].every(([x, y]) =>
    v.world.cellFlags[cellFlagIndex(x, y)] === plain.value.world.cellFlags[cellFlagIndex(x, y)] && v.world.cells[mapIndex(x, y)] === plain.value.world.cells[mapIndex(x, y)]));
  check("state image, saved ship count and RNG untouched", sameBytes(v.state.snapshot(), areaB0) && rngCalls === 0 && v.sim.events.length === 0 &&
    v.disk4.ownShips.count === 1);
  check("roster holds no map/flag buffers or hooks", !("cells" in v.ships) && !("flags" in v.ships) && !("sim" in v.ships) && !("hooks" in v.ships));
  check("tanks and enemy rosters still built by the underlying layers", v.tanks.slots.length === 99 && v.enemies.ground.length === 60 && v.enemies.air.length === 30);

  // immutability / detachment
  check("input image not modified", sameBytes(img, before));
  img.fill(0);
  const at3 = A_FIRST * 512 + shipAt(3);
  check("result independent of the input image", s[3].x === 7 && sameBytes(s[3].sourceRaw, before.subarray(at3, at3 + STRIDE)));
  s[3].sourceRaw[0] ^= 0xff;
  check("mutating a restored ship's raw copy leaves the decoded slot alone", v.entities.ownShips.slots[3].raw[0] === 15);
  const again = prepareDisk4ShipLoad(before, request());
  check("a later preparation is unaffected and slot-stable", again.ok && again.value.ships.slots[3].sourceRaw[0] === 15 && again.value.ships.slots.every((e, i) => (e === null) === (s[i] === null)));
  check("each ship owns a distinct extra record", s[3].extra !== s[0].extra && again.ok && again.value.ships.slots[3].extra !== s[3].extra);
}

// ---- unsupported and invalid occupied records -------------------------------------------------------------------
{
  const cases = [
    ["missile in the last slot, off the map", (a) => { a.set([17, 250, 250, 0, 0, 99], shipAt(39)); }, 39, "position"],
    ["missile direction 9", (a) => put(a, shipAt(4), 17, 5, 5, 9, 4, ptr(5, 5), 0), 4, "direction"],
    ["missile mode 9", (a) => put(a, shipAt(4), 17, 5, 5, 0, 9, ptr(5, 5), 0), 4, "mode"],
    ["tank type 9", (a) => put(a, shipAt(4), 9, 5, 5, 0), 4, "ship-type"],
    ["tank type 10", (a) => put(a, shipAt(4), 10, 5, 5, 0), 4, "ship-type"],
    ["enemy type 22", (a) => put(a, shipAt(4), 22, 5, 5, 0), 4, "ship-type"],
    ["unknown type 99", (a) => put(a, shipAt(4), 99, 5, 5, 0), 4, "ship-type"],
    ["type 18", (a) => put(a, shipAt(4), 18, 5, 5, 0), 4, "ship-type"],
    ["x off the map", (a) => put(a, shipAt(10), 11, 100, 5, 0), 10, "position"],
    ["y off the map", (a) => put(a, shipAt(10), 11, 5, 75, 0), 10, "position"],
    ["x = $FF", (a) => put(a, shipAt(10), 14, 0xff, 5, 0), 10, "position"],
    ["direction 9", (a) => put(a, shipAt(0), 12, 5, 5, 9), 0, "direction"],
    ["direction $FF", (a) => put(a, shipAt(0), 12, 5, 5, 0xff), 0, "direction"],
    ["class above 5", (a) => put(a, shipAt(1), 16, 5, 5, 0, 0, ptr(5, 5), 6), 1, "class"],
    ["class not matching type", (a) => put(a, shipAt(1), 13, 5, 5, 0, 0, ptr(5, 5), 3), 1, "class"],
    ["class byte left zero for a class 3 type", (a) => put(a, shipAt(1), 14, 5, 5, 0, 0, ptr(5, 5), 0), 1, "class"],
    ["mode 9", (a) => put(a, shipAt(2), 11, 5, 5, 0, 9), 2, "mode"],
    ["mode with bit 7 set (no waiting bit for ships)", (a) => put(a, shipAt(2), 11, 5, 5, 0, 0x82), 2, "mode"],
  ];
  for (const [label, fill, slot, code] of cases) {
    const img = makeImage(fill);
    const before = img.slice();
    const r = prepareDisk4ShipLoad(img, request());
    check(`${label} -> ships/${code} (slot ${slot}), no partial value`, !r.ok && r.error.stage === "ships" && r.error.error.code === code &&
      r.error.error.list === "ownShips" && r.error.error.slot === slot && typeof r.error.error.message === "string" && !("value" in r));
    check(`${label}: input untouched`, sameBytes(img, before));
  }
  // The first failing slot (in slot order) is the one reported.
  const two = prepareDisk4ShipLoad(makeImage((a) => { put(a, shipAt(8), 11, 5, 5, 9); put(a, shipAt(2), 18, 5, 5, 0); }), request());
  check("lowest bad slot is reported", !two.ok && two.error.stage === "ships" && two.error.error.slot === 2 && two.error.error.code === "ship-type");

  // The same invalid fields in a FREE slot (type 0) are decoded, not rejected.
  const free = makeImage((a) => {
    a.set([0, 250, 250, 0, 0, 77, 0, 0, 0, 55, 0, 0, 0, 9], shipAt(4)); put32(a, shipAt(4) + PTR, 1);
  });
  const fr = prepareDisk4ShipLoad(free, request());
  check("invalid fields in a free slot do not fail the load", fr.ok && fr.value.ships.slots[4] === null && fr.value.entities.ownShips.slots[4].direction === 77);
  check("an empty save hydrates an all-null roster", (() => {
    const e = prepareDisk4ShipLoad(makeImage(), request());
    return e.ok && e.value.ships.slots.length === 40 && e.value.ships.ships.length === 0;
  })());
  check("earlier-stage errors pass through unchanged", (() => {
    const e = prepareDisk4ShipLoad(makeImage(), { slot: 0, scenario: 4, scenarioCount: 10 });
    return !e.ok && e.error.stage === "slot";
  })());
  check("an invalid enemy record still fails at the enemies stage before ships", (() => {
    const bad = makeImage((a) => { a[offA(DISK4_ADDR.enemyGround)] = 25; a[offA(DISK4_ADDR.enemyGround) + 1] = 1; });
    const e = prepareDisk4ShipLoad(bad, request());
    return !e.ok && e.error.stage === "enemies";
  })());
}

// ---- missiles (type 17): distinct record, 24-bit enemy-record pointer in +$D..+$F -------------------------------------
const airAddr = (i) => DISK4_ADDR.enemyAir + i * 0x1a;
const gndAddr = (i) => DISK4_ADDR.enemyGround + i * 0x1a;
const enemyAt = (list, i) => offA(DISK4_ADDR[list]) + i * 0x1a;
function putEnemy(a, list, i, type, x, y) {
  const at = enemyAt(list, i);
  a[at] = type; a[at + 1] = x; a[at + 2] = y; a[at + 5] = 0; put32(a, at + 0x16, ptr(x, y));
}
// Missile record: the long at +$C is `rawLong` (top byte = +$C = saved target y, low 24 bits = enemy address).
function putMissile(a, at, x, y, dir, mode, rawLong, pointer = ptr(x, y)) {
  a[at] = 17; a[at + 1] = x; a[at + 2] = y; a[at + 5] = dir; a[at + 9] = mode;
  put32(a, at + 0x0c, rawLong >>> 0);
  put32(a, at + PTR, pointer);
}
const withTop = (top, addr) => ((top * 0x1000000) + addr) >>> 0;

{
  const res = resolveEnemyRecordPointer;
  check("air header constant is $39E20 and records follow $1A later", ENEMY_AIR_HEADER === 0x39e20 && DISK4_ADDR.enemyAir === ENEMY_AIR_HEADER + 0x1a);
  check("resolver: first air slot", JSON.stringify(res(airAddr(0))) === JSON.stringify({ kind: "record", list: "enemyAir", index: 0, address: 0x39e3a }));
  check("resolver: $3A12C is air slot 29 (also the ground scan base), not a header", JSON.stringify(res(0x3a12c)) === JSON.stringify({ kind: "record", list: "enemyAir", index: 29, address: 0x3a12c }) && airAddr(29) === 0x3a12c);
  check("resolver: air slots end where ground slot 0 starts", res(0x3a145).kind === "misaligned" && JSON.stringify(res(0x3a146)) === JSON.stringify({ kind: "record", list: "enemyGround", index: 0, address: 0x3a146 }));
  check("resolver: last ground slot start accepted, its end is out of range", res(gndAddr(59)).index === 59 && res(gndAddr(60)).kind === "out-of-range" && gndAddr(60) === DISK4_ADDR.ownShips);
  check("resolver: air header bytes", res(0x39e20).kind === "header" && res(0x39e39).kind === "header" && res(0x39e1f).kind === "out-of-range");
  check("resolver: inside a slot is misaligned for the right list", res(airAddr(3) + 1).kind === "misaligned" && res(airAddr(3) + 1).list === "enemyAir" && res(gndAddr(7) + 0x19).list === "enemyGround");
  check("resolver: null, huge and non-integer addresses are out of range", res(0).kind === "out-of-range" && res(0xffffff).kind === "out-of-range" && res(NaN).kind === "out-of-range" && res(-1).kind === "out-of-range");

  const fillA = (a) => {
    putEnemy(a, "enemyAir", 29, 25, 30, 31);
    putEnemy(a, "enemyAir", 0, 26, 10, 12);
    putEnemy(a, "enemyGround", 5, 22, 40, 41);
    // free ground slots with stale bytes (type 0): still valid targets, reported as free
    a[enemyAt("enemyGround", 0) + 1] = 77; a[enemyAt("enemyGround", 0) + 2] = 99;
    // slot 0: an ordinary ship next to the missiles
    put(a, shipAt(0), 13, 8, 9, 1, 1);
    // slot 1: missile on air slot 29; saved target y byte $2A (+$C) is masked away
    let at = shipAt(1);
    putMissile(a, at, 5, 6, 2, 1, withTop(0x2a, 0x3a12c));
    a[at + 3] = 0xfd; a[at + 4] = 2; a[at + 6] = 1; a[at + 7] = 0xff; a[at + 8] = 40; a[at + 10] = 5; a[at + 11] = 9;
    a[at + 0x10] = 0x22; a[at + 0x11] = 3; a[at + 0x12] = 4; a[at + 0x13] = 0xcd;
    // slot 2: missile on occupied ground slot 5, flag pointer names another cell, top byte $FF
    putMissile(a, shipAt(2), 20, 21, 7, 4, withTop(0xff, gndAddr(5)), ptr(1, 1));
    // slot 3: missile on FREE ground slot 0
    putMissile(a, shipAt(3), 22, 23, 0, 5, withTop(0, gndAddr(0)));
    // slot 4: missile on the first air slot; slot 6 on the last ground slot (free)
    putMissile(a, shipAt(4), 0, 0, 8, 8, withTop(0x01, airAddr(0)), 0xdeadbeef);
    putMissile(a, shipAt(6), 99, 74, 3, 2, withTop(0, gndAddr(59)));
    // slot 7: FREE record with missile-looking stale bytes and a bad pointer
    a.set([0, 250, 250, 0, 0, 99, 0, 0, 0, 77, 0, 0, 0, 0xff, 0xff, 0xff], shipAt(7));
    const flags = offA(DISK4_ADDR.flags);
    for (let i = 0; i < 7650; i++) a[flags + i] = (i * 5 + 1) & 0xff;
  };
  const img = makeImage(fillA);
  const before = img.slice();
  let rngCalls = 0;
  const r = prepareDisk4ShipLoad(img, request(), { rng: () => { rngCalls++; return 0; } });
  check("missile preparation succeeds", r.ok);
  if (!r.ok) throw new Error(`missile preparation failed: ${JSON.stringify(r.error)}`);
  const v = r.value;
  const s = v.ships.slots;
  const dec = v.entities.ownShips.slots;

  check("decoder: type 17 uses the missile layout without class/fuel", dec[1].layout === "missile" && !("shipClass" in dec[1]) && !("fuel" in dec[1]) &&
    dec[1].targetLong === withTop(0x2a, 0x3a12c) && dec[1].targetAddress === 0x3a12c && dec[0].layout === "ship" && dec[0].shipClass === 2);
  check("slot kinds and stable order", s.map((e) => (e ? e.kind[0] : "-")).join("") === "smmmm-m" + "-".repeat(33));
  check("ships / missiles / records accessors", v.ships.ships.map((e) => e.slot).join() === "0" && v.ships.missiles.map((e) => e.slot).join() === "1,2,3,4,6" &&
    v.ships.records.map((e) => e.slot).join() === "0,1,2,3,4,6");

  const m = s[1];
  check("missile has no ship-only fields", m.kind === "missile" && m.type === 17 && !("cls" in m) && !("fuel" in m) && !("shipClass" in m));
  check("missile common fields as stored", m.x === 5 && m.y === 6 && m.dx === -3 && m.dy === 2 && m.dir === 2 && m.hp === 40 && m.mode === 1 && m.savedControl === 1 && m.tech === 5 && m.slot === 1 &&
    m.sourceAddress === DISK4_ADDR.ownShips + STRIDE && m.lift === 0x22);
  check("missile +B/+C kept as stored (stale, not refreshed)", m.targetX === 9 && m.targetY === 0x2a);
  check("missile extra record", m.extra.vx === 1 && m.extra.vy === -1 && m.extra.next === 3 && m.extra.turn === 4);
  check("missile target: raw long kept, 24-bit address masked", m.target.semantics === "VERIFIED" && m.target.rawLong === withTop(0x2a, 0x3a12c) && m.target.address === 0x3a12c);
  check("missile target ref: air slot 29 occupied", JSON.stringify(m.target.ref) === JSON.stringify({ list: "enemyAir", index: 29, address: 0x3a12c, status: "occupied" }));
  check("missile raw copy owned and complete", m.sourceRaw.length === STRIDE && sameBytes(m.sourceRaw, dec[1].raw) && m.sourceRaw !== dec[1].raw && m.sourceRaw[0x13] === 0xcd);
  check("missile flag pointer at +$14 is separate and VERIFIED", m.flagPointer.semantics === "VERIFIED" && m.flagPointer.raw === ptr(5, 6) && m.flagPointer.atOwnCell === true &&
    m.flagPointer.target.kind === "playable");

  check("top byte $FF masked away, ground slot 5 occupied", s[2].target.rawLong === withTop(0xff, gndAddr(5)) && s[2].target.address === gndAddr(5) &&
    JSON.stringify(s[2].target.ref) === JSON.stringify({ list: "enemyGround", index: 5, address: gndAddr(5), status: "occupied" }) && s[2].targetY === 0xff);
  check("flag pointer of a missile may name another cell (not an error)", s[2].flagPointer.atOwnCell === false && s[2].flagPointer.target.x === 1 && s[2].flagPointer.target.y === 1);
  check("free enemy slot is a legal target with status free", s[3].target.ref.list === "enemyGround" && s[3].target.ref.index === 0 && s[3].target.ref.status === "free" && s[3].target.ref.address === 0x3a146);
  check("first air slot and last ground slot resolve", s[4].target.ref.list === "enemyAir" && s[4].target.ref.index === 0 && s[4].target.ref.status === "occupied" &&
    s[6].target.ref.list === "enemyGround" && s[6].target.ref.index === 59 && s[6].target.ref.status === "free");
  check("out-of-range flag pointer on a missile is kept raw, not rejected", s[4].flagPointer.raw === 0xdeadbeef && s[4].flagPointer.target.kind === "out-of-range");
  check("free stale record next to missiles stays null", s[7] === null && dec[7].status === "free");

  // identity: refs line up with the already-built EnemyRoster slots; nothing is bound
  check("occupied refs match EnemyRoster slot/list/address", v.enemies.air[29] !== null && v.enemies.air[29].slot === 29 && v.enemies.air[29].sourceAddress === m.target.ref.address &&
    v.enemies.ground[5] !== null && v.enemies.ground[5].slot === s[2].target.ref.index && v.enemies.ground[5].sourceAddress === s[2].target.ref.address &&
    v.enemies.air[0] !== null && v.enemies.air[0].sourceAddress === s[4].target.ref.address);
  check("free refs have no EnemyRoster object", v.enemies.ground[0] === null && v.enemies.ground[59] === null);
  check("prepared missile targets share the EnemyRoster objects by identity (null for free)", m.target.enemy === v.enemies.air[29] && s[2].target.enemy === v.enemies.ground[5] &&
    s[4].target.enemy === v.enemies.air[0] && s[3].target.enemy === null && s[6].target.enemy === null && !("enemy" in m.target.ref));
  check("restored Enemy objects were not touched (still at their saved cells)", m.target.enemy.x === 30 && m.target.enemy.y === 31 && s[2].target.enemy.x === 40);

  // side effects: none
  const plain = prepareDisk4Load(before, request());
  check("map words and flag bytes untouched by missile hydration", plain.ok && sameBytes(v.world.cellFlags, plain.value.world.cellFlags) && sameBytes(v.world.cells, plain.value.world.cells));
  check("enemy records, RNG, sim events untouched", rngCalls === 0 && v.sim.events.length === 0 && v.enemies.groundEnemies.length === 1 && v.enemies.airEnemies.length === 2 &&
    v.entities.enemyGround.slots[0].status === "free" && v.entities.enemyGround.slots[0].x === 77);
  check("input image not modified", sameBytes(img, before));
  img.fill(0);
  check("missiles independent of the input image", s[1].target.address === 0x3a12c && s[1].sourceRaw[0] === 17);
}

// ---- invalid missile target pointers -> typed missile-target error ----------------------------------------------------
{
  const cases = [
    ["air header start", ENEMY_AIR_HEADER, "header"],
    ["air header last byte", ENEMY_AIR_HEADER + 0x19, "header"],
    ["header via masked top byte", 0xff000000 + ENEMY_AIR_HEADER + 4, "header"],
    ["inside air slot 0", airAddr(0) + 1, "misaligned"],
    ["inside air slot 29 (last byte)", airAddr(29) + 0x19, "misaligned"],
    ["inside ground slot 0", gndAddr(0) + 1, "misaligned"],
    ["inside last ground slot", gndAddr(59) + 0x19, "misaligned"],
    ["null pointer", 0, "out-of-range"],
    ["one below the air header", ENEMY_AIR_HEADER - 1, "out-of-range"],
    ["end of the ground list (ship list start)", gndAddr(60), "out-of-range"],
    ["24-bit maximum", 0xffffff, "out-of-range"],
    ["low address used as a class/fuel pair would be", 0x00000190, "out-of-range"],
  ];
  for (const [label, raw, reason] of cases) {
    const addr = (raw & 0xffffff) >>> 0;
    const img = makeImage((a) => { putEnemy(a, "enemyAir", 29, 25, 30, 31); putMissile(a, shipAt(11), 5, 5, 0, 4, raw >>> 0); });
    const before = img.slice();
    const r = prepareDisk4ShipLoad(img, request());
    check(`${label} -> ships/missile-target/${reason} (slot 11)`, !r.ok && r.error.stage === "ships" && r.error.error.code === "missile-target" && r.error.error.reason === reason &&
      r.error.error.slot === 11 && r.error.error.address === addr && r.error.error.list === "ownShips" && typeof r.error.error.message === "string" && !("value" in r));
    check(`${label}: input untouched`, sameBytes(img, before));
  }
  // class/fuel-style validation does not apply to a missile: bytes +$D..+$F are the address
  const ok = prepareDisk4ShipLoad(makeImage((a) => { putMissile(a, shipAt(0), 5, 5, 0, 4, withTop(0, gndAddr(1))); }), request());
  check("missile with class-looking byte 0 / fuel-looking bytes is accepted", ok.ok && ok.value.ships.slots[0].target.ref.index === 1 && ok.value.ships.slots[0].target.ref.status === "free");
  // field checks come before the pointer, and the lowest failing slot wins
  const bad = prepareDisk4ShipLoad(makeImage((a) => { putMissile(a, shipAt(3), 5, 5, 0, 4, 0); putMissile(a, shipAt(2), 5, 5, 9, 4, 0); }), request());
  check("direction error of a missile precedes its pointer check; lowest slot wins", !bad.ok && bad.error.error.slot === 2 && bad.error.error.code === "direction");
  const posFirst = prepareDisk4ShipLoad(makeImage((a) => { putMissile(a, shipAt(2), 100, 5, 0, 4, 0); }), request());
  check("missile position error precedes the pointer", !posFirst.ok && posFirst.error.error.code === "position");

  // ShipRoster.fromDisk4 directly: enemy slot lists
  const prep = prepareDisk4Load(makeImage((a) => { putMissile(a, shipAt(0), 5, 5, 0, 4, withTop(0, gndAddr(1))); putEnemy(a, "enemyAir", 3, 25, 4, 4); }), request()).value.entities;
  const code = (res) => (res.ok ? "ok" : res.error.code);
  const lists = { ground: prep.enemyGround.slots, air: prep.enemyAir.slots };
  check("roster with decoded enemy slots builds", ShipRoster.fromDisk4(prep.ownShips.slots, lists).ok);
  check("missile without enemy slots -> enemy-slots", code(ShipRoster.fromDisk4(prep.ownShips.slots)) === "enemy-slots");
  const noMissile = prepareDisk4Load(makeImage((a) => put(a, shipAt(0), 11, 5, 5, 0)), request()).value.entities;
  check("ships only need no enemy slots", ShipRoster.fromDisk4(noMissile.ownShips.slots).ok && ShipRoster.fromDisk4(noMissile.ownShips.slots, lists).ok);
  check("short air list -> enemy-slots", code(ShipRoster.fromDisk4(prep.ownShips.slots, { ground: lists.ground, air: lists.air.slice(0, 29) })) === "enemy-slots");
  check("short ground list -> enemy-slots even without a missile", code(ShipRoster.fromDisk4(noMissile.ownShips.slots, { ground: lists.ground.slice(1), air: lists.air })) === "enemy-slots");
  check("lists swapped -> enemy-slots", code(ShipRoster.fromDisk4(prep.ownShips.slots, { ground: lists.air, air: lists.ground })) === "enemy-slots");
  const reindexed = lists.air.slice(); reindexed[5] = lists.air[6];
  check("wrong slot index -> enemy-slots", code(ShipRoster.fromDisk4(prep.ownShips.slots, { ground: lists.ground, air: reindexed })) === "enemy-slots");
  const wrongAddr = lists.ground.slice(); wrongAddr[2] = { ...lists.ground[2], address: lists.ground[2].address + 1 };
  check("wrong slot address -> enemy-slots", code(ShipRoster.fromDisk4(prep.ownShips.slots, { ground: wrongAddr, air: lists.air })) === "enemy-slots");
  const statusLie = lists.air.slice(); statusLie[3] = { ...lists.air[3], status: "free" };
  check("status that disagrees with the type byte -> enemy-slots", code(ShipRoster.fromDisk4(prep.ownShips.slots, { ground: lists.ground, air: statusLie })) === "enemy-slots");
  check("null enemy lists -> enemy-slots", code(ShipRoster.fromDisk4(noMissile.ownShips.slots, null)) === "enemy-slots");
  const layoutLie = prep.ownShips.slots.slice(); layoutLie[0] = { ...prep.ownShips.slots[0], layout: "ship" };
  check("layout that disagrees with the type byte -> slot-index", code(ShipRoster.fromDisk4(layoutLie, lists)) === "slot-index");
  const longLie = prep.ownShips.slots.slice(); longLie[0] = { ...prep.ownShips.slots[0], targetAddress: gndAddr(2) };
  check("decoded target address that disagrees with the raw record -> slot-index", code(ShipRoster.fromDisk4(longLie, lists)) === "slot-index");
  const before = prep.enemyGround.slots.map((e) => e.raw.slice());
  ShipRoster.fromDisk4(prep.ownShips.slots, lists);
  check("enemy slots are not modified by resolution", prep.enemyGround.slots.every((e, i) => sameBytes(e.raw, before[i])));

  // Enemy object identity (optional `objects`): agreeing arrays bind, any disagreement is "enemy-object"
  const img2 = makeImage((a) => {
    putEnemy(a, "enemyAir", 3, 25, 4, 4);
    putMissile(a, shipAt(0), 5, 5, 0, 4, withTop(0, airAddr(3)));
    putMissile(a, shipAt(1), 6, 6, 0, 4, withTop(0, gndAddr(1)));
  });
  const en = prepareDisk4EnemyLoad(img2, request());
  const ent = en.value.entities;
  const objs = { ground: en.value.enemies.ground, air: en.value.enemies.air };
  const listsO = { ground: ent.enemyGround.slots, air: ent.enemyAir.slots, objects: objs };
  const bound = ShipRoster.fromDisk4(ent.ownShips.slots, listsO);
  check("objects bind: occupied -> same Enemy, free -> null", bound.ok && bound.value.slots[0].target.enemy === objs.air[3] && objs.air[3] !== null && bound.value.slots[1].target.enemy === null);
  const plainBound = ShipRoster.fromDisk4(ent.ownShips.slots, { ground: listsO.ground, air: listsO.air });
  check("without objects the target has only the typed ref", plainBound.ok && !("enemy" in plainBound.value.slots[0].target) && plainBound.value.slots[0].target.ref.status === "occupied");
  const noEnemy = { ground: objs.ground, air: objs.air.map((e, i) => (i === 3 ? null : e)) };
  const e1 = ShipRoster.fromDisk4(ent.ownShips.slots, { ...listsO, objects: noEnemy });
  check("occupied slot with a null object -> enemy-object", !e1.ok && e1.error.code === "enemy-object" && e1.error.slot === 3 && e1.error.list === "enemyAir");
  const ghost = { ground: objs.ground.map((e, i) => (i === 1 ? objs.air[3] : e)), air: objs.air };
  const e2 = ShipRoster.fromDisk4(ent.ownShips.slots, { ...listsO, objects: ghost });
  check("free slot with an object -> enemy-object", !e2.ok && e2.error.code === "enemy-object" && e2.error.list === "enemyGround" && e2.error.slot === 1);
  const other = prepareDisk4EnemyLoad(makeImage((a) => putEnemy(a, "enemyAir", 7, 25, 4, 4)), request()).value.enemies;
  const e3 = ShipRoster.fromDisk4(ent.ownShips.slots, { ...listsO, objects: { ground: objs.ground, air: objs.air.map((e, i) => (i === 3 ? other.air[7] : e)) } });
  check("object from another slot/address -> enemy-object", !e3.ok && e3.error.code === "enemy-object" && e3.error.slot === 3);
  check("object arrays of the wrong length -> enemy-object", ((x) => !x.ok && x.error.code === "enemy-object")(ShipRoster.fromDisk4(ent.ownShips.slots, { ...listsO, objects: { ground: objs.ground, air: objs.air.slice(1) } })));
  check("end-to-end prepare agrees with the roster built by hand", (() => {
    const p = prepareDisk4ShipLoad(img2, request());
    return p.ok && p.value.ships.slots[0].target.enemy === p.value.enemies.air[3] && p.value.ships.slots[1].target.enemy === null;
  })());
}

// ---- ShipRoster.fromDisk4 shape errors ---------------------------------------------------------------------------
{
  const r = prepareDisk4Load(makeImage((a) => put(a, shipAt(0), 11, 5, 5, 0)), request());
  const ships = r.value.entities.ownShips.slots;
  const code = (res) => (res.ok ? "ok" : res.error.code);
  check("roster builds from decoded slots", ShipRoster.fromDisk4(ships).ok);
  check("short list -> slot-count", code(ShipRoster.fromDisk4(ships.slice(0, 39))) === "slot-count");
  check("long list -> slot-count", code(ShipRoster.fromDisk4([...ships, ships[0]])) === "slot-count");
  check("non-array -> slot-count", code(ShipRoster.fromDisk4(null)) === "slot-count");
  const swapped = ships.slice(); swapped[3] = ships[4];
  check("swapped slot -> slot-index", code(ShipRoster.fromDisk4(swapped)) === "slot-index");
  const wrongAddress = ships.slice(); wrongAddress[3] = { ...ships[3], address: ships[3].address + STRIDE };
  check("inconsistent source address -> slot-index", code(ShipRoster.fromDisk4(wrongAddress)) === "slot-index");
  const wrongType = ships.slice(); wrongType[3] = { ...ships[3], type: 16 };
  check("type that disagrees with raw record -> slot-index", code(ShipRoster.fromDisk4(wrongType)) === "slot-index");
  const tankSlots = prepareDisk4Load(makeImage(), request()).value.entities.ownTanks.slots.slice(0, 40);
  check("tank slots in the ship list -> slot-index", code(ShipRoster.fromDisk4(tankSlots)) === "slot-index");
  const short = ships.slice(); short[0] = { ...ships[0], raw: ships[0].raw.slice(0, 0x10) };
  check("short raw record -> slot-index", code(ShipRoster.fromDisk4(short)) === "slot-index");
  const hole = ships.slice(); hole[7] = undefined;
  check("missing slot -> slot-index", code(ShipRoster.fromDisk4(hole)) === "slot-index");
  const before = ships.map((s) => s.raw.slice());
  ShipRoster.fromDisk4(ships);
  check("decoded slots are not modified by hydration", ships.every((s, i) => sameBytes(s.raw, before[i])));
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall disk4-ships checks passed");
