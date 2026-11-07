// Synthetic regression of the ONE missile runtime shared by launched (`EnemySystem.launchMissile`, $49E8) and Disk.4-restored
// missiles (type 17, `MissileRecord`): fixed enemy-slot identity, the $4408 step, the daily $ACE2 refresh / destruction and
// the departure bookkeeping. No original data is used. Run after `npm run build`.
//
// Expected values come from the static traces recorded in notes/formats/ship-control.md 5c and enemies.md 5 (NOT from the
// implementation), the same ones test/disk4-fleet.mjs encodes for restored missiles:
//   $49E8      creates type 17 with a pointer in +$C..+$F (24-bit enemy slot address), own-cell flag pointer in +$14,
//              +$1429E + 1, no per-type count ($381E skips type 17), no message $C8 (its own free-slot check says $12B).
//   $4408      mode 4: lift += 4 (> $22 -> $22, mode 1, dir $44DE = 6 on the target cell); mode 1: $4526 moves it, on arrival the
//              POINTED slot's occupant decides (within 1 cell: ground -> mode 2 / dir 3 / enemy +B = $FF / enemy mode 5, air ->
//              hit at once); mode 2: lift -= 4, <= 0 destroys missile and occupant. NO target-gone check, NO +B/+C refresh here.
//   $ACE2      daily: type byte 0 at the pointed slot -> missile destroyed (one explosion, no kill/lost/type count, no morale);
//              else +B/+C := the occupant's +1/+2. No fuel for type 17.
//   $4672/$4526 leaving the map: $1427C + 4 * byte(+$D) ++ where byte +$D is the top byte of the 24-bit slot address (3).
// [H] tagged below: the net effect on $14294 when a missile leaves the map ($46CC skipping the whole statistics block for type 17
// and $4672 then decrementing unconditionally) is the port's reading, not a traced fact; the test only pins that launched and
// restored missiles end up in exactly the same state.

const { prepareDisk4HeadlessEnemies } = await import("../dist/game/disk4-load.js");
const { enemySlotAddress } = await import("../dist/game/enemies.js");
const { isMissile, isRestoredMissile } = await import("../dist/game/sim-ships.js");
const { CELL_FLAG_BASE, cellFlagIndex, mapIndex } = await import("../dist/game/cell-flags.js");
const { DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT } = await import("../dist/data/disk4.js");
const { DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES } = await import("../dist/data/disk4-state.js");

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`); if (!ok) failed++; };

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
const put16 = (b, o, v) => { b[o] = v >> 8; b[o + 1] = v & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

const SECTORS = 1920, SLOT = 2, A_FIRST = 100, B_FIRST = 174;
const SHIP_STRIDE = 0x18, ENEMY_STRIDE = 0x1a;
const AIR_LAYER = 0x2000, FLAG_SHIP = 8;
const COUNT_SHIPS = 0x1429e, LOST = 0x14294, KILLS = 0x14298, FRONT3 = 0x1427c + 12, COUNT17 = 0x14254 + 4 * (17 - 9), MORALE = 0x144ec;
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
const setWordCell = (a, x, y, v) => put16(a, offA(DISK4_ADDR.mapCells) + (y * 102 + x) * 2, v);
const setFlagCell = (a, x, y, v) => { a[offA(DISK4_ADDR.flags) + cellFlagIndex(x, y)] = v; };

function putShip(a, i, o) {
  const at = shipAt(i);
  a[at] = o.type; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 5] = o.dir ?? 0;
  a[at + 8] = o.hp ?? 9; a[at + 9] = o.mode ?? 0; a[at + 10] = o.tech ?? 1; a[at + 0x0d] = o.type - 11; put16(a, at + 0x0e, o.fuel ?? 100);
  a[at + 0x10] = o.lift ?? 0; a[at + 0x12] = 2;
  put32(a, at + 0x14, ptr(o.x, o.y));
}
function putMissile(a, i, o) {
  const at = shipAt(i);
  a[at] = 17; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 5] = o.dir ?? 0;
  a[at + 8] = o.hp ?? 40; a[at + 9] = o.mode ?? 4; a[at + 10] = o.tech ?? 1;
  a[at + 11] = o.tx;
  put32(a, at + 0x0c, ((o.ty * 0x1000000) + o.target) >>> 0);
  a[at + 0x10] = o.lift ?? 0; a[at + 0x12] = 2;
  put32(a, at + 0x14, ptr(o.x, o.y));
}
function putEnemy(a, list, i, o) {
  const at = enemyAt(list, i);
  a[at] = o.type; a[at + 1] = o.x; a[at + 2] = o.y; a[at + 5] = 0; a[at + 8] = o.hp ?? 20; a[at + 9] = o.mode ?? 5;
  a[at + 11] = o.tx ?? 0xff; a[at + 12] = o.ty ?? 0xff; a[at + 0x0e] = 30; a[at + 0x0f] = 5;
  put32(a, at + 0x16, ptr(o.x, o.y));
}

// Synthetic turn table. Rows use the observed table's geometry: one octant towards the requested bearing, clockwise
// for the 180-degree tie. This keeps lockstep paths realistic without loading original game bytes.
const tables = {
  spiral: Array.from({ length: 48 }, () => [0, 0]),
  arcs: Array.from({ length: 8 }, () => Array.from({ length: 32 }, () => [0, 0])),
  turn: Array.from({ length: 64 }, (_, k) => { const d = k >> 3, w = k & 7, delta = (w - d + 8) & 7; return d === w ? d : (d + (delta <= 4 ? 1 : 7)) & 7; }),
  crusherAnim: Array(8).fill(0),
};

function boot(fillA, fillB) {
  const calls = { explode: [], sound: [] };
  const r = prepareDisk4HeadlessEnemies(makeImage(fillA, fillB), request(), tables, { rng: () => 0, effect: () => {} },
    { explode: (x, y, lift, high) => calls.explode.push([x, y, lift, high]), sound: (id) => calls.sound.push(id), buildPad: () => true, buildingHeight: () => 20 });
  if (!r.ok) throw new Error(`headless preparation failed: ${JSON.stringify(r.error)}`);
  const v = r.value;
  return { v, sim: v.sim, calls, msg0: v.sim.messages.length, sys: v.enemySystem, fleet: v.sim.fleet, state: v.state, cells: v.world.cells, flags: v.world.cellFlags, pass: () => v.enemySystem.pass(v.tanks.clock) };
}
const cell = (e, x, y) => e.cells[mapIndex(x, y)];
const flag = (e, x, y) => e.flags[cellFlagIndex(x, y)];
const airMarks = (e) => e.cells.reduce((n, w) => n + ((w & AIR_LAYER) !== 0 ? 1 : 0), 0) + e.flags.reduce((n, f) => n + ((f & FLAG_SHIP) !== 0 ? 1 : 0), 0);
const ENEMY_ENTRY = [0, 6, 0, 3, 0, 5, 50, 0];
const spawnGround = (e, x, y) => {
  const index = e.sys.groundSlots.indexOf(null);
  if (!e.sys.spawn({ air: false, type: 22, x, y, dir: 0, entry: ENEMY_ENTRY })) throw new Error("spawn failed");
  return e.sys.groundSlots[index];
};

// ---- shared shape -------------------------------------------------------------------------------------------------------
{
  const e = boot((a) => putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30 }), (b) => put16(b, offB(0x142a2), 1));
  const ships0 = e.state.word(COUNT_SHIPS);
  check("createShip no longer makes missiles: type 17 gives null and writes nothing", e.fleet.createShip(17, 5, 5, 0) === null && e.state.word(COUNT_SHIPS) === ships0 && e.fleet.slots.every((s) => s === null) && airMarks(e) === 0);
  const t = e.sys.findTarget(20, 24, 30);
  check("launch from (24,30) at the walker succeeds", t !== null && e.sys.launchMissile({ x: 24, y: 30 }, t));
  const m = e.fleet.slots[0];
  check("launched missile is the shared MissileRecord: kind missile, type 17, no class, no fuel, no fabricated provenance", isMissile(m) && !isRestoredMissile(m) && m.kind === "missile" && m.type === 17 &&
    !("cls" in m) && !("fuel" in m) && !("shipClass" in m) && !("target" in m) && !("sourceRaw" in m));
  check("$49E8/$381E initial state: mode 4, lift 0, dir 0, +B/+C = the enemy's cell, hp from the type 17 row", m.mode === 4 && m.lift === 0 && m.dir === 0 && m.x === 24 && m.y === 30 && m.targetX === 30 && m.targetY === 30 && m.hp === 40);
  const i = e.sys.inspectShip(m);
  check("its enemy pointer is the fixed ground slot 0 (address $3A146), not an object or a coordinate", i.targetSlot.air === false && i.targetSlot.index === 0 && i.targetOccupied === true && enemySlotAddress(i.targetSlot) === gndAddr(0));
  check("count word +1, no type 17 count, no lost/morale change, no message (no $C8)", e.state.word(COUNT_SHIPS) === ships0 + 1 && e.state.long(COUNT17) === 0 && e.state.long(LOST) === 0 && e.sim.messages.length === e.msg0);
  check("reservation = launcher cell: air mark + ship flag set there, nowhere else, extra record is the default", cell(e, 24, 30) & AIR_LAYER && flag(e, 24, 30) & FLAG_SHIP && airMarks(e) === 2 &&
    i.rx === 24 && i.ry === 30 && i.vx === 0 && i.vy === 0 && i.next === 0 && i.turn === 2);
  check("the launch sound is played once", e.calls.sound.length === 1);
}

// ---- fresh vs restored: identical transitions pass by pass -----------------------------------------------------------------
const enemyKey = (e) => JSON.stringify([e.sys.groundSlots, e.sys.airSlots].map((l) => l.map((x) => x && [x.x, x.y, x.hp, x.mode, x.targetX, x.targetY])));
const fieldKey = (r) => (r ? [r.x, r.y, r.dx, r.dy, r.dir, r.hp, r.mode, r.tech, r.targetX, r.targetY, r.lift].join() : "gone");
function difference(f, r) {
  const mf = f.fleet.slots[0], mr = r.fleet.slots[0];
  if (fieldKey(mf) !== fieldKey(mr)) return `record ${fieldKey(mf)} vs ${fieldKey(mr)}`;
  if ((mf ? JSON.stringify(f.sys.inspectShip(mf)) : "-") !== (mr ? JSON.stringify(r.sys.inspectShip(mr)) : "-")) return "extra state / enemy slot";
  if (!sameBytes(f.cells, r.cells)) return "map words";
  if (!sameBytes(f.flags, r.flags)) return "flag bytes";
  if (!sameBytes(f.state.snapshot(), r.state.snapshot())) return "state image (counters, morale)";
  if (JSON.stringify(f.calls.explode) !== JSON.stringify(r.calls.explode)) return "explosions";
  if (enemyKey(f) !== enemyKey(r)) return "enemy slots";
  if (f.sim.messages.join() !== r.sim.messages.join()) return "messages";
  return null;
}
// One launched and one restored missile in the same situation: the launcher cell `from`, the target enemy in `list` slot `index`.
function pair({ air = false, type = 22, index = 0, from, at, extraA = () => {}, tailB = () => {} }) {
  const list = air ? "enemyAir" : "enemyGround";
  const countAddr = air ? 0x142a4 : 0x142a2;
  // Keep aircraft at the aimed-at cell so this fixture isolates projectile collision; an aircraft that is free to fly
  // needs the daily $ACE2 refresh, tested separately below.
  const fillEnemy = (a) => { putEnemy(a, list, index, { type, x: at[0], y: at[1], ...(air ? { tx: at[0], ty: at[1] } : {}) }); extraA(a); };
  const f = boot(fillEnemy, (b) => { put16(b, offB(countAddr), 1); tailB(b); });
  const t = f.sys.findTarget(100, from[0], from[1]);
  if (!t || !f.sys.launchMissile({ x: from[0], y: from[1] }, t)) throw new Error("launch failed");
  const tech = f.state.byte(0x14592);
  const r = boot((a) => {
    fillEnemy(a);
    putMissile(a, 0, { x: from[0], y: from[1], dir: 0, mode: 4, lift: 0, tx: at[0], ty: at[1], tech, target: air ? airAddr(index) : gndAddr(index) });
    setWordCell(a, from[0], from[1], AIR_LAYER); setFlagCell(a, from[0], from[1], FLAG_SHIP);
  }, (b) => { put16(b, offB(COUNT_SHIPS), 1); put16(b, offB(countAddr), 1); tailB(b); });
  return { f, r };
}
function lockstep(name, { f, r }, passes, before = () => {}) {
  const start = difference(f, r);
  if (start) { check(`${name}: launched and restored start identical (${start})`, false); return false; }
  for (let n = 0; n < passes; n++) {
    before(n, f, r);
    f.pass(); r.pass();
    const d = difference(f, r);
    if (d) { check(`${name}: pass ${n} differs: ${d}`, false); return false; }
  }
  check(`${name}: ${passes} passes identical (record, extra, map words, flags, state image, explosions, enemies)`, true);
  return true;
}

{
  // ground target: climb, fly, freeze (mode 2 / dir 3 / enemy +B = $FF, mode 5), descend, both destroyed
  const p = pair({ from: [24, 30], at: [30, 30] });
  const kills0 = p.f.state.long(KILLS), morale0 = p.f.state.long(MORALE);
  const seen = new Set();
  const ok = lockstep("ground target", p, 120, (n, f) => { const m = f.fleet.slots[0]; if (m) seen.add(m.mode); });
  check("ground target: the missile went through modes 4, 1 and 2 and is gone with its enemy", ok && [4, 1, 2].every((m) => seen.has(m)) && p.f.fleet.slots[0] === null && p.f.sys.groundSlots[0] === null);
  check("ground target counters: ship word 0, ground word 0, one kill, no type 17 count, no lost units, no morale change", p.f.state.word(COUNT_SHIPS) === 0 && p.f.state.word(0x142a2) === 0 &&
    p.f.state.long(KILLS) === kills0 + 1 && p.f.state.long(COUNT17) === 0 && p.f.state.long(LOST) === 0 && p.f.state.long(MORALE) === morale0);
  check("ground target: no air mark or ship flag left (the +$14 cell was released on the way)", airMarks(p.f) === 0 && airMarks(p.r) === 0);
}
{
  // air target: hit at once on arrival; $11C30 gives the colony morale
  const p = pair({ air: true, type: 25, index: 5, from: [24, 30], at: [30, 31] });
  const morale0 = p.f.state.signedLong(MORALE);
  const ok = lockstep("air target", p, 80);
  check("air target: missile and aircraft gone, one kill, morale gained (the same value on both paths), no lost units", ok && p.f.fleet.slots[0] === null && p.f.sys.airSlots[5] === null && p.f.state.word(0x142a4) === 0 &&
    p.f.state.signedLong(MORALE) > morale0 && p.f.state.long(LOST) === 0,
    JSON.stringify({ missile: fieldKey(p.f.fleet.slots[0]), air: p.f.sys.airSlots[5] && [p.f.sys.airSlots[5].x, p.f.sys.airSlots[5].y, p.f.sys.airSlots[5].mode], kills: p.f.state.long(KILLS), morale: p.f.state.signedLong(MORALE), morale0 }));
}
{
  // equal cell: launcher and enemy on the same cell. $44DE gives 6 (not 0) when the missile is on +B/+C; a later turn proves the row
  const p = pair({ from: [30, 30], at: [30, 30] });
  const { f, r } = p;
  let ok = lockstep("equal cell climb", p, 9);
  check("equal cell: climb done, mode 1 with direction 6 on both paths", ok && f.fleet.slots[0].mode === 1 && f.fleet.slots[0].dir === 6 && r.fleet.slots[0].mode === 1 && r.fleet.slots[0].dir === 6);
  // the enemy walks away; only the daily $ACE2 tells the missile
  for (const e of [f, r]) { e.sys.groundSlots[0].x = 34; e.fleet.dailyFuel(); }
  check("daily refresh on both paths: +B/+C = (34,30)", f.fleet.slots[0].targetX === 34 && r.fleet.slots[0].targetX === 34 && f.fleet.slots[0].targetY === 30);
  ok = lockstep("equal cell turn", p, 1);
  check("the next step turns from direction 6 towards 2: table row 6 (= 7), not row 0 (= 1)", ok && f.fleet.slots[0].dir === tables.turn[6 * 8 + 2] && f.fleet.slots[0].dir === 7 && r.fleet.slots[0].dir === 7);
  lockstep("equal cell, then the chase", p, 90);
}
{
  // daily refresh only: the main pass never re-aims. The missile continues using stale +B/+C even after the pointed occupant
  // moves away; its exact route depends on the game's turn table. $ACE2 then refreshes the target to the current slot occupant.
  const p = pair({ from: [24, 30], at: [30, 30] });
  const { f, r } = p;
  lockstep("approach", p, 30);
  const m = f.fleet.slots[0];
  check("approach: in flight (mode 1) towards the stale cell", m && m.mode === 1);
  for (const e of [f, r]) e.sys.groundSlots[0].x = 40;
  lockstep("stale target", p, 60);
  check("the enemy moved away: +B/+C stay stale at (30,30) in mode 1; main passes do not re-aim or destroy the missile", f.fleet.slots[0] === m && m.mode === 1 && m.targetX === 30 && m.targetY === 30 &&
    f.sys.groundSlots[0].x === 40 && f.sys.groundSlots[0].y === 30 && f.sys.groundSlots[0].mode === 5 && f.sys.groundSlots[0].targetX === 0xff,
    JSON.stringify({ missile: fieldKey(m), extra: f.sys.inspectShip(m), enemy: [f.sys.groundSlots[0].x, f.sys.groundSlots[0].y, f.sys.groundSlots[0].mode, f.sys.groundSlots[0].targetX, f.sys.groundSlots[0].targetY] }));
  for (const e of [f, r]) e.fleet.dailyFuel();
  check("daily $ACE2 refresh: +B/+C = (40,30) on both paths", m.targetX === 40 && r.fleet.slots[0].targetX === 40);
  const ok = lockstep("after the refresh", p, 120);
  check("after the refresh it flies on, hits and both are gone", ok && f.fleet.slots[0] === null && f.sys.groundSlots[0] === null,
    JSON.stringify({ missile: fieldKey(f.fleet.slots[0]), enemy: f.sys.groundSlots[0] && [f.sys.groundSlots[0].x, f.sys.groundSlots[0].y, f.sys.groundSlots[0].mode], kills: f.state.long(KILLS) }));
}

// ---- target death and slot reuse (launched missile) -----------------------------------------------------------------------
{
  // slots 0..2 are filler enemies far away, the target is slot 3, a decoy in slot 9 stands on the target's coordinates
  const fill = (a) => {
    for (let i = 0; i < 3; i++) putEnemy(a, "enemyGround", i, { type: 22, x: 70 + i, y: 60 });
    putEnemy(a, "enemyGround", 3, { type: 22, x: 31, y: 31 });
    putEnemy(a, "enemyGround", 9, { type: 23, x: 31, y: 31, hp: 21, tx: 7, ty: 8 });
  };
  const e = boot(fill, (b) => put16(b, offB(0x142a2), 5));
  const A = e.sys.groundSlots[3], D = e.sys.groundSlots[9];
  check("launch at an explicit target resolves its CURRENT slot (3)", e.sys.launchMissile({ x: 26, y: 30 }, { x: 31, y: 31, enemy: A }) && e.sys.inspectShip(e.fleet.slots[0]).targetSlot.index === 3);
  const m = e.fleet.slots[0];
  e.sys.destroyGround(A, false);
  for (let n = 0; n < 12; n++) e.pass();
  check("target killed: the main pass does not notice (no target-gone check), missile still flying, no explosion", e.fleet.slots[0] === m && m.mode === 1 && e.calls.explode.length === 0 && e.state.word(COUNT_SHIPS) === 1);
  check("launching at the dead target is refused (nothing written, no message)", e.sys.launchMissile({ x: 26, y: 30 }, { x: 31, y: 31, enemy: A }) === false && e.state.word(COUNT_SHIPS) === 1 && e.fleet.slots[1] === null && e.sim.messages.length === e.msg0);
  const N = spawnGround(e, 36, 31);
  N.mode = 5; // keep the reused slot's occupant at its cell while testing that the missile resolves by slot, not by old object
  check("a new enemy takes the freed slot 3 (first free), the old object is gone", e.sys.groundSlots[3] === N && N !== A);
  e.fleet.dailyFuel();
  check("daily: the missile follows the CURRENT occupant (36,31), not the dead object and not the old coordinates", m.targetX === 36 && m.targetY === 31 && e.fleet.slots[0] === m);
  let n = 0;
  while (e.fleet.slots[0] !== null && n++ < 300) e.pass();
  check("it arrives, freezes and destroys the NEW occupant of slot 3; the decoy on the dead target's old coordinates is untouched", e.fleet.slots[0] === null && e.sys.groundSlots[3] === null &&
    e.sys.groundSlots[9] === D && D.hp === 21 && D.mode === 5 && D.targetX === 7 && D.targetY === 8 && e.state.word(COUNT_SHIPS) === 0,
    JSON.stringify({ missile: fieldKey(e.fleet.slots[0]), occupant: e.sys.groundSlots[3] && [e.sys.groundSlots[3].x, e.sys.groundSlots[3].y, e.sys.groundSlots[3].mode], decoy: [D.hp, D.mode, D.targetX, D.targetY], ships: e.state.word(COUNT_SHIPS), kills: e.state.long(KILLS) }));
  check("hit bookkeeping: kills +1 for the occupant only, no lost units, no type 17 count, no air mark left", e.state.long(KILLS) === 2 && e.state.long(LOST) === 0 && e.state.long(COUNT17) === 0 && airMarks(e) === 0);
}
{
  // the remembered target of findTarget is a slot ($E904 is a pointer): a launch without an explicit target takes whoever stands there
  const e = boot((a) => { putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30 }); }, (b) => put16(b, offB(0x142a2), 1));
  const first = e.sys.groundSlots[0];
  const t = e.sys.findTarget(20, 28, 30);
  e.sys.destroyGround(first, false);
  spawnGround(e, 44, 30);
  const ok = e.sys.launchMissile({ x: 28, y: 30 });
  const m = e.fleet.slots[0];
  check("launch without a target after the slot was reused: the missile aims at the new occupant", t.enemy === first && ok && m.targetX === 44 && m.targetY === 30 && e.sys.inspectShip(m).targetSlot.index === 0);
  const g = boot(() => {}, () => {});
  check("coordinates alone never identify a target: no remembered slot and no enemy refuses the launch", g.sys.launchMissile({ x: 28, y: 30 }, { x: 30, y: 30 }) === false && g.state.word(COUNT_SHIPS) === 0);
  const h = boot((a) => putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30 }), (b) => put16(b, offB(0x142a2), 1));
  h.sys.findTarget(20, 28, 30); h.sys.findTarget(2, 80, 60); // the second search finds nothing and forgets the slot
  check("a search that finds nothing forgets the remembered slot", h.sys.launchMissile({ x: 28, y: 30 }) === false);
}
{
  // a full list is refused by the $1429E word without message $C8 (the launcher screen says $12B)
  const e = boot((a) => putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30 }), (b) => put16(b, offB(0x142a2), 1));
  e.state.setWord(COUNT_SHIPS, 40);
  check("full ship list: no launch, no mark, no message $C8, count word kept", e.sys.launchMissile({ x: 28, y: 30 }, e.sys.findTarget(20, 28, 30)) === false && e.state.word(COUNT_SHIPS) === 40 && e.sim.messages.length === e.msg0 && airMarks(e) === 0 && e.calls.sound.length === 0);
}

// ---- reservation (+$14) of a launched missile ----------------------------------------------------------------------------------
{
  const e = boot((a) => putEnemy(a, "enemyGround", 0, { type: 22, x: 40, y: 30 }), (b) => put16(b, offB(0x142a2), 1));
  e.sys.launchMissile({ x: 26, y: 30 }, e.sys.findTarget(20, 26, 30));
  const m = e.fleet.slots[0];
  let n = 0;
  while (m.mode !== 1 && n++ < 30) e.pass();
  check("climbed to mode 1 on the launcher cell, still reserved there", m.mode === 1 && m.lift === 0x22 && m.x === 26 && m.dir === 2 && e.sys.inspectShip(m).rx === 26);
  e.pass();
  const i = e.sys.inspectShip(m);
  check("the first step ($4646-$4660) moved the reservation to the next cell (27,30): mark cleared at (26,30), set at (27,30)", i.rx === 27 && i.ry === 30 && !(cell(e, 26, 30) & AIR_LAYER) && !(flag(e, 26, 30) & FLAG_SHIP) &&
    (cell(e, 27, 30) & AIR_LAYER) !== 0 && (flag(e, 27, 30) & FLAG_SHIP) !== 0 && airMarks(e) === 2);
  // a foreign mark on the missile's own cell must survive the destruction: $4732 releases the cell +$14 names, not x/y
  e.cells[mapIndex(26, 30)] |= AIR_LAYER; e.flags[cellFlagIndex(26, 30)] |= FLAG_SHIP;
  e.sys.destroyShip(m, false);
  check("destroying it releases the +$14 cell (27,30), not the cell at x/y (the foreign mark at (26,30) stays)", !(cell(e, 27, 30) & AIR_LAYER) && !(flag(e, 27, 30) & FLAG_SHIP) &&
    (cell(e, 26, 30) & AIR_LAYER) !== 0 && (flag(e, 26, 30) & FLAG_SHIP) !== 0 && e.fleet.slots[0] === null && e.state.word(COUNT_SHIPS) === 0);
}

// ---- daily step for launched missiles next to ordinary ships -----------------------------------------------------------------------
{
  const e = boot((a) => { putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30 }); putShip(a, 2, { type: 13, x: 10, y: 10, mode: 1, lift: 0x22, fuel: 100 }); }, (b) => { put16(b, offB(0x142a2), 1); put16(b, offB(COUNT_SHIPS), 1); });
  e.sys.launchMissile({ x: 28, y: 30 }, e.sys.findTarget(20, 28, 30));
  const m = e.fleet.slots[0], ship = e.fleet.slots[2];
  check("the launched missile took the first free slot (0), the ship keeps slot 2", isMissile(m) && ship.type === 13 && e.state.word(COUNT_SHIPS) === 2);
  e.sys.groundSlots[0].x = 33; e.sys.groundSlots[0].y = 34;
  e.fleet.dailyFuel();
  check("daily: +B/+C refreshed from the occupant (33,34); the hovering ship burns 1; the missile has no fuel to burn", m.targetX === 33 && m.targetY === 34 && ship.fuel === 99 && !("fuel" in m) && e.fleet.slots[0] === m);
  const lost0 = e.state.long(LOST), morale0 = e.state.long(MORALE);
  e.sys.destroyGround(e.sys.groundSlots[0], false);
  e.calls.explode.length = 0;
  e.fleet.dailyFuel();
  check("daily with a free slot: missile destroyed (one explosion at its cell with lift 0, no message), ship burned again (98)", e.fleet.slots[0] === null && ship.fuel === 98 && e.calls.explode.length === 1 &&
    e.calls.explode[0].join() === "28,30,0,true" && e.state.word(COUNT_SHIPS) === 1 && e.sim.messages.length === e.msg0);
  check("no lost-unit, type 17 count or morale change from the daily destruction", e.state.long(LOST) === lost0 && e.state.long(COUNT17) === 0 && e.state.long(MORALE) === morale0);
  check("its reservation was released with it", airMarks(e) === 0);
  e.fleet.dailyFuel();
  check("the next day only the ship burns (97)", ship.fuel === 97 && e.calls.explode.length === 1);
}

// ---- leaving the map ($4672 / $4526) --------------------------------------------------------------------------------------------------
{
  // launched and restored missile pushed one cell off the map from mode 1: same counters, same release
  const f = boot((a) => putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30 }), (b) => put16(b, offB(0x142a2), 1));
  f.sys.launchMissile({ x: 98, y: 30 }, f.sys.findTarget(100, 98, 30));
  const tech = f.state.byte(0x14592);
  while (f.fleet.slots[0].mode !== 1) f.pass();
  const r = boot((a) => {
    putEnemy(a, "enemyGround", 0, { type: 22, x: 30, y: 30 });
    putMissile(a, 0, { x: 98, y: 30, dir: 6, mode: 1, lift: 0x22, tx: 30, ty: 30, tech, target: gndAddr(0) });
    setWordCell(a, 98, 30, AIR_LAYER); setFlagCell(a, 98, 30, FLAG_SHIP);
  }, (b) => { put16(b, offB(COUNT_SHIPS), 1); put16(b, offB(0x142a2), 1); });
  for (const e of [f, r]) { e.fleet.slots[0].x = 100; e.fleet.slots[0].dx = 0; e.fleet.slots[0].dy = 0; }
  const front0 = f.state.long(FRONT3), frontR0 = r.state.long(FRONT3);
  f.pass(); r.pass();
  check("launched missile leaving the map counts in front fleet slot 3 ($1427C + 4 * byte(+$D) with +$D = $03), exactly like the restored one", f.state.long(FRONT3) === front0 + 1 && r.state.long(FRONT3) === frontR0 + 1);
  check("both are gone, count word 0, reservation released, no explosion", f.fleet.slots[0] === null && r.fleet.slots[0] === null && f.state.word(COUNT_SHIPS) === 0 && r.state.word(COUNT_SHIPS) === 0 &&
    airMarks(f) === 0 && airMarks(r) === 0 && f.calls.explode.length === 0 && r.calls.explode.length === 0);
  check("[H] whatever $14294 does on a missile's departure it does identically for launched and restored (no class-6 index into $14294)", sameBytes(f.state.snapshot(), r.state.snapshot()));
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall missile runtime checks passed");
