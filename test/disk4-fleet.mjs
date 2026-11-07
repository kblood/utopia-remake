// Synthetic coverage of the headless Disk.4 ship/missile continuation: ShipRoster adopted into sim.fleet and the
// EnemySystem by prepareDisk4HeadlessEnemies() / EnemySystem.fromRoster(..., ships). No original data is used.
// Run after `npm run build`.
//
// Expected values are derived from the disassembly of the original (Disk.1 game image), NOT from the port:
//   $4526 (ship step): offset += (+6,+7) (twice for type 17); when it equals table $4C1A[dir] the cell advances; at a cell
//         centre modes 5/6 return 0, a new step clears the mark on the ship's own cell ($4646/$464A) and sets the mark on
//         the next cell ($4654/$465C), stores that cell's flag pointer in +$14 ($4660), velocities come from $4BCA.
//   $42BE/$4378/$4346: mode 7 adds 2 to +$10, at >= $22 the mode becomes +$11 ; every 8th lift unit +5 turns towards +$12;
//         mode 6 at a cell centre becomes +$11.
//   $4408 (missile): mode 4 lift += 4 (> $22 -> $22, mode 1, dir $44DE); mode 1 moves with $4526, on arrival at +B/+C
//         reads the pointed enemy record, within 1 cell ground -> mode 2 / dir 3 / enemy +B = $FF / enemy mode 5, air ->
//         both destroyed; any other mode: lift -= 4, <= 0 destroys the missile (and the enemy when its type byte is not 0).
//   $ACE2 (daily, slot order): type 17 reads the masked 24-bit pointer; type byte 0 -> missile destroyed with bit 5 of
//         $156A9 set (one explosion, no message, no kills/lost count); otherwise +B/+C := the enemy's +1/+2.
//   $4732 (destroy): releases the cell named by +$14.

const { prepareDisk4EnemyLoad, prepareDisk4ShipLoad, prepareDisk4HeadlessEnemies, prepareDisk4Load } = await import("../dist/game/disk4-load.js");
const { EnemySystem } = await import("../dist/game/enemies.js");
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
const SHIP_STRIDE = 0x18;
const ENEMY_STRIDE = 0x1a;
const AIR_LAYER = 0x2000;
const FLAG_SHIP = 8;
const FLAG_OWN = 4;
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
const ptr = (x, y) => CELL_FLAG_BASE + cellFlagIndex(x, y);
const shipAt = (i) => offA(DISK4_ADDR.ownShips) + i * SHIP_STRIDE;
const enemyAt = (list, i) => offA(DISK4_ADDR[list]) + i * ENEMY_STRIDE;
const gndAddr = (i) => DISK4_ADDR.enemyGround + i * ENEMY_STRIDE;
const airAddr = (i) => DISK4_ADDR.enemyAir + i * ENEMY_STRIDE;
const withTop = (top, addr) => ((top * 0x1000000) + addr) >>> 0;
const setWordCell = (a, x, y, v) => put16(a, offA(DISK4_ADDR.mapCells) + (y * 102 + x) * 2, v);
const setFlagCell = (a, x, y, v) => { a[offA(DISK4_ADDR.flags) + cellFlagIndex(x, y)] = v; };
const COUNT_SHIPS = 0x1429e;
const setShipCount = (n) => (b) => put16(b, offB(COUNT_SHIPS), n);

// Ordinary ship record (types 11..16, class = type - 11).
function putShip(a, i, o) {
  const at = shipAt(i);
  a[at] = o.type; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 3] = (o.dx ?? 0) & 0xff; a[at + 4] = (o.dy ?? 0) & 0xff; a[at + 5] = o.dir ?? 0;
  a[at + 6] = (o.vx ?? 0) & 0xff; a[at + 7] = (o.vy ?? 0) & 0xff; a[at + 8] = o.hp ?? 9; a[at + 9] = o.mode ?? 0; a[at + 10] = o.tech ?? 1;
  a[at + 11] = o.tx ?? 0xff; a[at + 12] = o.ty ?? 0xff; a[at + 0x0d] = o.type - 11; put16(a, at + 0x0e, o.fuel ?? 100);
  a[at + 0x10] = o.lift ?? 0; a[at + 0x11] = o.next ?? 0; a[at + 0x12] = o.turn ?? 2;
  put32(a, at + 0x14, o.ptr ?? ptr(o.x, o.y));
}
// Missile record (type 17): the long at +$C is (+C target y << 24) | 24-bit enemy slot address.
function putMissile(a, i, o) {
  const at = shipAt(i);
  a[at] = 17; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 3] = (o.dx ?? 0) & 0xff; a[at + 4] = (o.dy ?? 0) & 0xff; a[at + 5] = o.dir ?? 0;
  a[at + 6] = (o.vx ?? 0) & 0xff; a[at + 7] = (o.vy ?? 0) & 0xff; a[at + 8] = o.hp ?? 40; a[at + 9] = o.mode ?? 4; a[at + 10] = o.tech ?? 1;
  a[at + 11] = o.tx ?? 0;
  put32(a, at + 0x0c, withTop(o.ty ?? 0, o.target));
  a[at + 0x10] = o.lift ?? 0; a[at + 0x11] = o.next ?? 0; a[at + 0x12] = o.turn ?? 2;
  put32(a, at + 0x14, o.ptr ?? ptr(o.x, o.y));
}
function putEnemy(a, list, i, o) {
  const at = enemyAt(list, i);
  a[at] = o.type; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 5] = o.dir ?? 0; a[at + 8] = o.hp ?? 20; a[at + 9] = o.mode ?? 5;
  a[at + 11] = o.tx ?? 0xff; a[at + 12] = o.ty ?? 0xff; a[at + 0x0e] = 30; a[at + 0x0f] = 5;
  put32(a, at + 0x16, o.ptr ?? ptr(o.x, o.y));
}

// Synthetic combat tables. The turn table is NOT the identity: a turn from d towards w gives (d+1)&7 unless d == w, so
// an assertion on a turned direction proves which table row was used.
const tables = {
  spiral: Array.from({ length: 48 }, () => [0, 0]),
  arcs: Array.from({ length: 8 }, () => Array.from({ length: 32 }, () => [0, 0])),
  turn: Array.from({ length: 64 }, (_, k) => { const d = k >> 3, w = k & 7; return d === w ? d : (d + 1) & 7; }),
  crusherAnim: Array(8).fill(0),
};

function boot(fillA, fillB, extraOptions = {}) {
  const calls = { rng: 0, effect: 0, explode: [], sound: 0, buildPad: 0, height: 0 };
  const img = makeImage(fillA, fillB);
  const before = img.slice();
  const r = prepareDisk4HeadlessEnemies(img, request(), tables,
    { rng: () => { calls.rng++; return 0; }, effect: () => { calls.effect++; }, ...extraOptions },
    { explode: (x, y, lift, high) => calls.explode.push([x, y, lift, high]), sound: () => { calls.sound++; }, buildPad: () => { calls.buildPad++; return true; }, buildingHeight: () => { calls.height++; return 20; } });
  if (!r.ok) throw new Error(`headless preparation failed: ${JSON.stringify(r.error)}`);
  return { v: r.value, calls, before, img };
}

// ---- 1. inert adoption, identity, holes, final slots ----------------------------------------------------------------
{
  const fillA = (a) => {
    putEnemy(a, "enemyGround", 59, { type: 22, x: 50, y: 50, mode: 5 });
    putEnemy(a, "enemyAir", 29, { type: 25, x: 70, y: 40, mode: 5 });
    putShip(a, 0, { type: 11, x: 4, y: 5, dir: 8, mode: 0, fuel: 100 });
    putShip(a, 3, { type: 13, x: 10, y: 20, dir: 2, mode: 2, dx: 8, dy: 4, vx: 2, vy: 1, lift: 0x22, next: 3, turn: 4, tx: 14, ty: 20, fuel: 500, ptr: ptr(11, 20) });
    putMissile(a, 7, { x: 20, y: 20, dir: 2, mode: 1, lift: 0x22, tx: 50, ty: 50, target: gndAddr(59), vx: 2, vy: 1, next: 1, turn: 5 });
    putMissile(a, 38, { x: 21, y: 22, dir: 1, mode: 4, lift: 0x10, tx: 70, ty: 40, target: airAddr(29) });
    putShip(a, 39, { type: 16, x: 99, y: 74, dir: 8, mode: 0, ptr: ptr(99, 74) });
    // free slots with stale bytes that would be invalid if occupied
    a.set([0, 250, 250, 1, 2, 99, 3, 4, 5, 77, 7, 8, 9, 99], shipAt(37)); put32(a, shipAt(37) + 0x14, 0xdeadbeef);
    a.set([0, 3, 3, 0, 0, 1], shipAt(1));
    const flags = offA(DISK4_ADDR.flags);
    for (let i = 0; i < 7650; i++) a[flags + i] = (i * 7 + 3) & 0xff;
    const map = offA(DISK4_ADDR.mapCells);
    for (let y = 0; y < 75; y++) for (let x = 0; x < 102; x++) put16(a, map + (y * 102 + x) * 2, x < 100 ? ((y * 100 + x) * 5) & 0xffff : 0x73ff);
  };
  const { v, calls, before, img } = boot(fillA, setShipCount(5));
  const plain = prepareDisk4Load(before, request()).value;
  const fleet = v.sim.fleet;
  const slots = v.ships.slots;

  check("fleet has the 40 fixed slots", fleet.slots.length === 40);
  check("every fleet slot is the roster's very object, holes stay null (incl. final slots 38 and 39)", slots.every((rec, i) => fleet.slots[i] === rec));
  check("occupied slots are exactly 0, 3, 7, 38, 39", fleet.slots.map((r, i) => (r ? i : -1)).filter((i) => i >= 0).join() === "0,3,7,38,39");
  check("restored kinds by slot", fleet.slots[0].kind === "ship" && fleet.slots[7].kind === "missile" && fleet.slots[38].kind === "missile" && fleet.slots[39].kind === "ship");
  check("stale free records stay holes", fleet.slots[37] === null && fleet.slots[1] === null);
  check("controller adopted both rosters (same arrays/objects)", v.enemySystem.groundSlots === v.enemies.ground && v.enemySystem.airSlots === v.enemies.air &&
    v.enemies.ground[59] !== null && v.enemies.air[29] !== null);
  check("fleet.ships lists the adopted records in slot order", fleet.ships.map((r) => r.slot).join() === "0,3,7,38,39");

  check("map words, flag bytes and object records unchanged by adoption", sameBytes(v.world.cells, plain.world.cells) && sameBytes(v.world.cellFlags, plain.world.cellFlags) && sameBytes(v.world.objects, plain.world.objects));
  check("state image (counters incl. $1429E) unchanged by adoption", sameBytes(v.state.snapshot(), plain.state.snapshot()) && v.state.word(COUNT_SHIPS) === 5);
  check("no RNG, effect, explosion, sound, pad or height hook call; no sim events", calls.rng === 0 && calls.effect === 0 && calls.explode.length === 0 &&
    calls.sound === 0 && calls.buildPad === 0 && calls.height === 0 && v.sim.events.length === 0);
  check("the input image was only read", sameBytes(img, before));

  const s3 = fleet.slots[3];
  check("saved ship fields are the live fields until something runs", s3.x === 10 && s3.y === 20 && s3.dx === 8 && s3.dy === 4 && s3.mode === 2 && s3.dir === 2 && s3.lift === 0x22 && s3.cls === 2 && s3.fuel === 500);
  check("saved extra bytes stay in the record, flag pointer raw names another cell", s3.extra.vx === 2 && s3.extra.vy === 1 && s3.extra.next === 3 && s3.extra.turn === 4 &&
    s3.flagPointer.raw === ptr(11, 20) && s3.flagPointer.atOwnCell === false && s3.sourceRaw[0x17] === (ptr(11, 20) & 0xff));
  const m7 = fleet.slots[7];
  check("missile keeps no class/fuel and its saved pointer", !("cls" in m7) && !("fuel" in m7) && !("shipClass" in m7) && m7.target.address === gndAddr(59) &&
    m7.target.ref.list === "enemyGround" && m7.target.ref.index === 59 && m7.target.enemy === v.enemies.ground[59]);
  check("missile in the last-but-one slot targets air slot 29", fleet.slots[38].target.ref.list === "enemyAir" && fleet.slots[38].target.ref.index === 29 && fleet.slots[38].target.enemy === v.enemies.air[29]);
}

// ---- 2. saved ship movement state: $4526 with +6/+7, +$14 differing from x/y ---------------------------------------------
{
  // Ship in mode 2 at (10,20) heading dir 2 (+x), 8/4 pixels into the step, velocity (2,1), flag pointer already on the
  // NEXT cell (11,20) which carries its air mark. Target (14,20).
  const fillA = (a) => {
    putShip(a, 3, { type: 13, x: 10, y: 20, dir: 2, mode: 2, dx: 8, dy: 4, vx: 2, vy: 1, lift: 0x22, tx: 14, ty: 20, ptr: ptr(11, 20) });
    setWordCell(a, 11, 20, AIR_LAYER | 0x0123); setFlagCell(a, 11, 20, FLAG_SHIP | 0x10);
    setWordCell(a, 12, 20, 0x0045); setFlagCell(a, 12, 20, 0x20);
    setWordCell(a, 10, 20, 0x0007); setFlagCell(a, 10, 20, 0x30);
  };
  const { v } = boot(fillA, setShipCount(1));
  const ship = v.sim.fleet.slots[3];
  const cells0 = v.world.cells.slice(), flags0 = v.world.cellFlags.slice();
  const clock = v.tanks.clock;
  for (let n = 1; n <= 3; n++) v.enemySystem.pass(clock);
  check("three passes continue the saved offset with the saved velocity: (8,4) + 3 x (2,1) = (14,7)", ship.dx === 14 && ship.dy === 7 && ship.x === 10 && ship.y === 20 && ship.mode === 2);
  check("a ship in the middle of a step writes no mark", sameBytes(v.world.cells, cells0) && sameBytes(v.world.cellFlags, flags0));
  v.enemySystem.pass(clock);
  check("fourth pass reaches (16,8) = table $4C1A[2]: the cell advances to (11,20) and the offset clears", ship.x === 11 && ship.y === 20 && ship.dx === 0 && ship.dy === 0 && ship.mode === 2 && ship.dir === 2);
  const cells1 = cells0.slice(), flags1 = flags0.slice();
  cells1[mapIndex(11, 20)] &= ~AIR_LAYER; flags1[cellFlagIndex(11, 20)] &= ~FLAG_SHIP;
  cells1[mapIndex(12, 20)] |= AIR_LAYER; flags1[cellFlagIndex(12, 20)] |= FLAG_SHIP;
  check("new step: mark cleared on the ship's own cell (11,20), set on the next cell (12,20), nothing else written", sameBytes(v.world.cells, cells1) && sameBytes(v.world.cellFlags, flags1));
  v.enemySystem.pass(clock);
  check("velocity of the new step is $4BCA[dir 2] = (2,1)", ship.dx === 2 && ship.dy === 1 && ship.x === 11);
}

// ---- 2b. destroying a restored ship releases the +$14 cell ($4732), not its x/y ------------------------------------------
{
  const fillA = (a) => {
    putShip(a, 3, { type: 13, x: 10, y: 20, dir: 2, mode: 2, dx: 8, dy: 4, vx: 2, vy: 1, lift: 0x22, tx: 14, ty: 20, ptr: ptr(11, 20) });
    setWordCell(a, 11, 20, AIR_LAYER | 0x4000 | 0x0123); setFlagCell(a, 11, 20, FLAG_SHIP | FLAG_OWN | 0x10);
    setWordCell(a, 10, 20, 0x0007); setFlagCell(a, 10, 20, 0x30);
  };
  const { v } = boot(fillA, (b) => { setShipCount(1)(b); put32(b, offB(0x14264), 1); });
  const ship = v.sim.fleet.slots[3];
  v.enemySystem.destroyShip(ship, false);
  const w = (x, y) => v.world.cells[mapIndex(x, y)], f = (x, y) => v.world.cellFlags[cellFlagIndex(x, y)];
  check("$46CC clears only the air/ship bits at the +$14 cell; overlapping ground/own bits survive", w(11, 20) === (0x4000 | 0x0123) && f(11, 20) === (FLAG_OWN | 0x10));
  check("the ship's own cell (10,20) was not the released one", w(10, 20) === 0x0007 && f(10, 20) === 0x30);
  check("fleet slot freed and counts moved by one ($1429E, class count $14264)", v.sim.fleet.slots[3] === null && v.state.word(COUNT_SHIPS) === 0 && v.state.long(0x14264) === 0);
}

// ---- 3. +$11 next mode, +$12 turn, mode 6 / 7 (disassembly $4378, $4346, $438C) --------------------------------------------
{
  const fillA = (a) => {
    putShip(a, 0, { type: 12, x: 10, y: 10, dir: 2, mode: 7, lift: 0x20, next: 3, turn: 2 });
    putShip(a, 1, { type: 13, x: 12, y: 12, dir: 2, mode: 7, lift: 0x16, next: 1, turn: 6 });
    putShip(a, 2, { type: 14, x: 14, y: 14, dir: 0, mode: 6, lift: 0x22, next: 1 });
  };
  const { v } = boot(fillA, setShipCount(3));
  const cells0 = v.world.cells.slice(), flags0 = v.world.cellFlags.slice();
  v.enemySystem.pass(v.tanks.clock);
  const [s0, s1, s2] = [0, 1, 2].map((i) => v.sim.fleet.slots[i]);
  check("mode 7 at lift $20: +2 = $22 -> the mode becomes the saved +$11 (3)", s0.lift === 0x22 && s0.mode === 3);
  check("mode 7 at lift $16: +2 = $18 (multiple of 8) -> turn row of dir 2 towards the saved +$12 (6)", s1.lift === 0x18 && s1.mode === 7 && s1.dir === tables.turn[2 * 8 + 6] && s1.dir === 3);
  check("mode 6 on a cell centre becomes the saved +$11 (1)", s2.mode === 1);
  check("none of that wrote a mark", sameBytes(v.world.cells, cells0) && sameBytes(v.world.cellFlags, flags0));
}

// ---- 3b. restored ship descent completes at its saved cell ($43BC-$4406) ----------------------------------------------
{
  const fillA = (a) => {
    // A mode-8 save has no serialized $1424C pointer pair. Keep +$14 deliberately stale/different to prove landing
    // derives the completion cell from the saved x/y, then replaces the live reservation with that cell.
    putShip(a, 6, { type: 13, x: 10, y: 10, dir: 2, mode: 8, lift: 2, fuel: 100, ptr: ptr(11, 10) });
    setWordCell(a, 10, 10, 0x6123); setFlagCell(a, 10, 10, 0x38);
    setWordCell(a, 11, 10, AIR_LAYER | 0x0123); setFlagCell(a, 11, 10, FLAG_SHIP | 0x20);
  };
  const { v } = boot(fillA, setShipCount(1));
  const ship = v.sim.fleet.slots[6];
  v.enemySystem.pass(v.tanks.clock);
  check("restored mode 8 descends from lift 2 to 0 and lands in one pass ($43AC/$43BC)", ship.mode === 0 && ship.lift === 0 && ship.dir === 8);
  check("landing sets occupied, clears air, sets own flag, clears ship flag, and preserves unrelated bits ($43E2-$43F2)",
    v.world.cells[mapIndex(10, 10)] === 0x4123 && v.world.cellFlags[cellFlagIndex(10, 10)] === 0x34);
  check("landing burns 4 fuel and leaves the prior +$14 cell untouched ($43EE-$4402)",
    ship.fuel === 96 &&
    v.world.cells[mapIndex(11, 10)] === (AIR_LAYER | 0x0123) && v.world.cellFlags[cellFlagIndex(11, 10)] === (FLAG_SHIP | 0x20));
  v.enemySystem.destroyShip(ship, false);
  check("after landing, $4732 releases the landing cell rather than the stale saved +$14 cell",
    v.world.cells[mapIndex(10, 10)] === 0x0123 && v.world.cellFlags[cellFlagIndex(10, 10)] === 0x30 &&
    v.world.cells[mapIndex(11, 10)] === (AIR_LAYER | 0x0123) && v.world.cellFlags[cellFlagIndex(11, 10)] === (FLAG_SHIP | 0x20));
}

// ---- 4. restored missiles: current occupant, daily $ACE2 ------------------------------------------------------------------
{
  // 4a. main pass vs daily; slot reuse; contrast with a missile made by launchMissile
  const fillA = (a) => {
    putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30, mode: 5 });
    putMissile(a, 4, { x: 25, y: 30, dir: 6, mode: 4, lift: 0x20, tx: 31, ty: 33, target: gndAddr(0) });
  };
  const { v, calls } = boot(fillA, setShipCount(1));
  const fleet = v.sim.fleet, sys = v.enemySystem;
  const m = fleet.slots[4];
  const keys0 = Object.keys(m).join();
  const rawLong0 = m.target.rawLong;
  sys.pass(v.tanks.clock);
  check("mode 4: lift 4 per call to $22, then mode 1 and $44DE direction towards the (stale) +B/+C", m.lift === 0x22 && m.mode === 1 && m.dir === 3);
  check("the main pass does not refresh +B/+C from the enemy ($ACE2 does, once a day)", m.targetX === 31 && m.targetY === 33);
  fleet.dailyFuel();
  check("daily $ACE2: +B/+C := the pointed enemy's x/y; the missile stays", m.targetX === 30 && m.targetY === 30 && fleet.slots[4] === m);

  const enemy0 = sys.groundSlots[0];
  sys.destroyGround(enemy0, false);
  sys.pass(v.tanks.clock);
  check("target dead: the restored missile is NOT destroyed by the main pass (only $ACE2 notices a free slot)", fleet.slots[4] === m && v.state.word(COUNT_SHIPS) === 1);
  // launched missiles share this shape and step: see test/missile-runtime.mjs

  check("slot 0 is free for the next enemy", sys.groundSlots[0] === null);
  const spawned = sys.spawn({ air: false, type: 22, x: 44, y: 30, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0] });
  const reused = sys.groundSlots[0];
  check("a new enemy takes the freed slot 0 (the old object is gone)", spawned && reused !== null && reused !== enemy0 && reused.x === 44);
  fleet.dailyFuel();
  check("daily: the missile follows the CURRENT occupant of its slot (44,30), not the dead object", m.targetX === 44 && m.targetY === 30 && fleet.slots[4] === m);
  check("missile saved fields and pointer unchanged, no fabricated class/fuel", Object.keys(m).join() === keys0 && m.target.rawLong === rawLong0 && !("cls" in m) && !("fuel" in m) && !("shipClass" in m));

  const lost0 = v.state.long(0x14294), count17 = v.state.long(0x14254 + 4 * (17 - 9));
  const mx = m.x, my = m.y;
  sys.destroyGround(reused, false);
  check("killing the occupant does not touch the missile by itself", fleet.slots[4] === m);
  fleet.dailyFuel();
  check("daily with a free slot: the missile is destroyed, slot freed, count word consistent", fleet.slots[4] === null && v.state.word(COUNT_SHIPS) === 0 && fleet.ships.length === 0);
  check("exactly one explosion at the missile (bit 5 of $156A9 -> $1237C); no lost-unit or class count for type 17", calls.explode.length === 1 &&
    calls.explode[0][0] === mx && calls.explode[0][1] === my && calls.explode[0][2] === 0x22 && v.state.long(0x14294) === lost0 && v.state.long(0x14254 + 4 * (17 - 9)) === count17);
}
{
  // 4b. free-at-save target: not destroyed by the main pass, destroyed by the next daily step; slot order with ordinary ships
  const fillA = (a) => {
    putShip(a, 2, { type: 13, x: 10, y: 10, dir: 0, mode: 1, lift: 0x22, fuel: 100 });
    putMissile(a, 5, { x: 20, y: 20, dir: 2, mode: 1, lift: 0x22, tx: 20, ty: 20, target: gndAddr(7) });
  };
  const { v, calls } = boot(fillA, setShipCount(2));
  const fleet = v.sim.fleet;
  const m = fleet.slots[5];
  check("saved target slot is free (legal)", m.target.ref.status === "free" && v.enemies.ground[7] === null);
  v.enemySystem.pass(v.tanks.clock);
  check("main pass: arrival on a free slot does nothing and the missile is still there", fleet.slots[5] === m && v.state.word(COUNT_SHIPS) === 2 && calls.explode.length === 0);
  fleet.dailyFuel();
  check("first daily: the missile is destroyed, the hovering ship burned 1 fuel (100 -> 99)", fleet.slots[5] === null && fleet.slots[2].fuel === 99 && v.state.word(COUNT_SHIPS) === 1);
  check("one explosion, at the missile's cell with lift $22", calls.explode.length === 1 && calls.explode[0].join() === "20,20,34,true");
  fleet.dailyFuel();
  check("second daily: only the ship burns (98); no second destruction", fleet.slots[2].fuel === 98 && calls.explode.length === 1 && v.state.word(COUNT_SHIPS) === 1);
}
{
  // 4c. arrival at +B/+C: the POINTED slot decides, never a unit that stands on the coordinates
  const fillA = (a) => {
    putEnemy(a, "enemyGround", 3, { type: 22, x: 31, y: 31, mode: 1, tx: 20, ty: 20 });
    putEnemy(a, "enemyGround", 9, { type: 23, x: 30, y: 30, mode: 5, tx: 7, ty: 8, hp: 21 });
    putMissile(a, 1, { x: 30, y: 30, dir: 2, mode: 1, lift: 0x22, tx: 30, ty: 30, target: gndAddr(3) });
  };
  const { v, calls } = boot(fillA, (b) => { setShipCount(1)(b); put16(b, offB(0x142a2), 2); });
  const fleet = v.sim.fleet, sys = v.enemySystem;
  const m = fleet.slots[1];
  const target = sys.groundSlots[3], decoy = sys.groundSlots[9];
  const kills0 = v.state.long(0x14298);
  sys.pass(v.tanks.clock);
  check("on +B/+C the pointed ground enemy (31,31) is within one cell: missile mode 2, dir 3", m.mode === 2 && m.dir === 3 && m.lift === 0x22);
  check("pointed enemy froze (+B = $FF, mode 5); the decoy on the target coordinates was ignored", target.targetX === 0xff && target.mode === 5 &&
    decoy.hp === 21 && decoy.targetX === 7 && decoy.targetY === 8 && decoy.mode === 5 && sys.groundSlots[9] === decoy);
  for (let n = 0; n < 8; n++) sys.pass(v.tanks.clock);
  check("mode 2 loses 4 lift per call: $22 -> 2 after eight calls, still alive", m.lift === 2 && fleet.slots[1] === m && sys.groundSlots[3] === target);
  sys.pass(v.tanks.clock);
  check("next call (2 - 4 <= 0): missile and pointed enemy are destroyed together, decoy survives", fleet.slots[1] === null && sys.groundSlots[3] === null && sys.groundSlots[9] === decoy);
  check("counts: ship word 0, ground word 2 -> 1, one kill", v.state.word(COUNT_SHIPS) === 0 && v.state.word(0x142a2) === 1 && v.state.long(0x14298) === kills0 + 1 && calls.explode.length >= 1);
}
{
  // 4d. air target: hit at once on arrival
  const fillA = (a) => {
    putEnemy(a, "enemyAir", 5, { type: 25, x: 30, y: 31, mode: 5 });
    putMissile(a, 0, { x: 30, y: 30, dir: 2, mode: 1, lift: 0x22, tx: 30, ty: 30, target: airAddr(5) });
  };
  const { v } = boot(fillA, (b) => { setShipCount(1)(b); put16(b, offB(0x142a4), 1); });
  const kills0 = v.state.long(0x14298);
  v.enemySystem.pass(v.tanks.clock);
  check("air target within one cell: missile and aircraft are both gone", v.sim.fleet.slots[0] === null && v.enemySystem.airSlots[5] === null &&
    v.state.word(COUNT_SHIPS) === 0 && v.state.word(0x142a4) === 0 && v.state.long(0x14298) === kills0 + 1);
}

// ---- 5. unsupported / invalid saved state fails before anything is installed ---------------------------------------------
{
  const base = (a) => {
    putEnemy(a, "enemyGround", 3, { type: 22, x: 31, y: 31, mode: 5 });
    putShip(a, 6, { type: 12, x: 6, y: 6, mode: 0 });
  };
  const cases = [
    ["missile in mode 3", (a) => { base(a); putMissile(a, 9, { x: 9, y: 9, mode: 3, lift: 0x22, target: gndAddr(3) }); }, 2, { code: "unsupported-state", reason: "missile-mode", slot: 9 }],
    ["missile in mode 0", (a) => { base(a); putMissile(a, 9, { x: 9, y: 9, mode: 0, target: gndAddr(3) }); }, 2, { code: "unsupported-state", reason: "missile-mode", slot: 9 }],
    ["ship with lift above $7F", (a) => { base(a); putShip(a, 9, { type: 13, x: 9, y: 9, mode: 2, lift: 0x90 }); }, 2, { code: "unsupported-state", reason: "lift", slot: 9 }],
    ["ship flag pointer in the padding columns", (a) => { base(a); putShip(a, 9, { type: 13, x: 99, y: 74, mode: 0, ptr: CELL_FLAG_BASE + 74 * 102 + 100 }); }, 2, { code: "flag-pointer", slot: 9 }],
    ["ship flag pointer zero", (a) => { base(a); putShip(a, 9, { type: 13, x: 9, y: 9, mode: 0, ptr: 0 }); }, 2, { code: "flag-pointer", slot: 9 }],
    ["missile flag pointer out of range", (a) => { base(a); putMissile(a, 9, { x: 9, y: 9, mode: 1, lift: 0x22, target: gndAddr(3), ptr: 0xdeadbeef }); }, 2, { code: "flag-pointer", slot: 9 }],
    ["saved $1429E differs from the occupied slots", (a) => { base(a); }, 3, { code: "ship-count" }],
    ["crusher with counter 9 beside valid ships", (a) => { base(a); putEnemy(a, "enemyGround", 41, { type: 24, x: 50, y: 60, mode: 1 }); a[enemyAt("enemyGround", 41) + 0x13] = 0x09; }, 1, { code: "unsupported-state", reason: "crusher-counter", slot: 41 }],
    ["crusher with animation 1 against an all-zero table", (a) => { base(a); putEnemy(a, "enemyGround", 41, { type: 24, x: 50, y: 60, mode: 1 }); a[enemyAt("enemyGround", 41) + 0x14] = 0x01; }, 1, { code: "unsupported-state", reason: "crusher-anim", slot: 41 }],
    ["lowest bad slot is reported", (a) => { base(a); putMissile(a, 9, { x: 9, y: 9, mode: 3, target: gndAddr(3) }); putShip(a, 12, { type: 13, x: 9, y: 9, mode: 2, lift: 0x90 }); }, 3, { code: "unsupported-state", reason: "missile-mode", slot: 9 }],
  ];
  for (const [label, fill, count, want] of cases) {
    const img = makeImage(fill, setShipCount(count));
    const before = img.slice();
    const w = prepareDisk4HeadlessEnemies(img, request(), tables);
    check(`${label}: headless preparation fails at the enemy-system stage with ${want.code}${want.reason ? "/" + want.reason : ""}`,
      !w.ok && w.error.stage === "enemy-system" && w.error.error.code === want.code && w.error.error.reason === want.reason &&
      (want.slot === undefined || w.error.error.slot === want.slot) && typeof w.error.error.message === "string" && !("value" in w));
    check(`${label}: input untouched`, sameBytes(img, before));
    // direct adoption: nothing installed, nothing written, the rosters stay adoptable
    const p = prepareDisk4ShipLoad(img, request());
    const cells0 = p.value.world.cells.slice(), flags0 = p.value.world.cellFlags.slice(), state0 = p.value.state.snapshot();
    const r = EnemySystem.fromRoster(p.value.sim, p.value.tanks, tables, p.value.enemies, {}, p.value.ships);
    const untouched = p.value.sim.fleet.slots.every((s) => s === null) && sameBytes(p.value.world.cells, cells0) && sameBytes(p.value.world.cellFlags, flags0) && sameBytes(p.value.state.snapshot(), state0);
    check(`${label}: nothing installed or written`, !r.ok && untouched);
    {
      // a failed attempt must not mark the roster adopted; a roster that is itself invalid fails again, a valid one adopts
      const again = EnemySystem.fromRoster(p.value.sim, p.value.tanks, tables, p.value.enemies);
      const crusherCase = want.reason === "crusher-counter" || want.reason === "crusher-anim";
      check(`${label}: the enemy roster was not marked adopted by the failed attempt`, crusherCase ? (!again.ok && again.error.code === "unsupported-state") : again.ok);
    }
  }
  const empty = prepareDisk4HeadlessEnemies(makeImage(), request(), tables);
  check("a save without ships still composes (count 0, empty fleet)", empty.ok && empty.value.sim.fleet.slots.every((s) => s === null));
}
{
  // tampered rosters and fleets
  const fillA = (a) => {
    putEnemy(a, "enemyGround", 3, { type: 22, x: 31, y: 31, mode: 5 });
    putEnemy(a, "enemyGround", 4, { type: 22, x: 33, y: 33, mode: 5 });
    putShip(a, 3, { type: 12, x: 6, y: 6, mode: 0 });
    putShip(a, 4, { type: 13, x: 8, y: 8, mode: 0 });
    putMissile(a, 5, { x: 9, y: 9, mode: 1, lift: 0x22, tx: 31, ty: 31, target: gndAddr(3) });
  };
  const fresh = () => {
    const p = prepareDisk4ShipLoad(makeImage(fillA, setShipCount(3)), request());
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    return p.value;
  };
  const adopt = (p, ships = p.ships) => EnemySystem.fromRoster(p.sim, p.tanks, tables, p.enemies, {}, ships);
  const code = (r) => (r.ok ? "ok" : `${r.error.code}${r.error.reason ? "/" + r.error.reason : ""}`);
  const notInstalled = (p) => p.sim.fleet.slots.every((s) => s === null);

  check("untampered roster adopts", code(adopt(fresh())) === "ok");
  let p = fresh();
  p.ships.slots[3] = p.ships.slots[4];
  check("the same record in two slots -> ship-roster", code(adopt(p)) === "ship-roster" && notInstalled(p));
  p = fresh();
  p.ships.slots[3] = { ...p.ships.slots[3], kind: "tank" };
  check("unknown record kind -> ship-roster", code(adopt(p)) === "ship-roster" && notInstalled(p));
  p = fresh();
  p.ships.slots[3] = { ...p.ships.slots[3], cls: 5 };
  check("class that disagrees with the type -> ship-roster", code(adopt(p)) === "ship-roster" && notInstalled(p));
  p = fresh();
  check("something that is not a ShipRoster -> ship-roster", code(adopt(p, { slots: new Array(40).fill(null) })) === "ship-roster" && notInstalled(p));
  p = fresh();
  const m = p.ships.slots[5];
  p.ships.slots[5] = { ...m, target: { ...m.target, ref: { ...m.target.ref, status: "free" } } };
  check("missile target status that disagrees with the adopted slot -> ship-roster", code(adopt(p)) === "ship-roster" && notInstalled(p));
  p = fresh();
  p.ships.slots[5] = { ...m, target: { ...m.target, enemy: p.enemies.ground[4] } };
  check("missile target Enemy that is not the occupant of its slot -> ship-roster", code(adopt(p)) === "ship-roster" && notInstalled(p));
  p = fresh();
  p.ships.slots[5] = { ...m, target: { ...m.target, ref: { ...m.target.ref, index: 4, address: gndAddr(4) } } };
  check("missile ref that disagrees with its 24-bit address -> ship-roster", code(adopt(p)) === "ship-roster" && notInstalled(p));

  p = fresh();
  p.sim.fleet.createShip(11, 2, 2, 8);
  const own = p.sim.fleet.slots[0];
  check("a Fleet that already holds a ship refuses the adoption, the ship stays", code(adopt(p)) === "ship-roster" && p.sim.fleet.slots[0] === own && p.sim.fleet.slots.filter(Boolean).length === 1);
  check("Fleet.adoptRestored itself refuses a non-empty fleet", p.sim.fleet.adoptRestored(new Array(40).fill(null)) === false);

  p = fresh();
  check("first adoption of the ship roster works", code(adopt(p)) === "ok");
  const q = prepareDisk4ShipLoad(makeImage(fillA, setShipCount(3)), request()).value;
  check("the same ShipRoster cannot be adopted a second time (even into another controller)", code(adopt(q, p.ships)) === "already-adopted" && notInstalled(q));
  check("adopting the same enemy roster twice is still rejected", code(EnemySystem.fromRoster(p.sim, p.tanks, tables, p.enemies, {}, undefined)) === "already-adopted");
  check("adopted fleet slot is the roster record itself", p.sim.fleet.slots[3] === p.ships.slots[3] && p.sim.fleet.slots[5] === p.ships.slots[5]);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall disk4-fleet checks passed");
