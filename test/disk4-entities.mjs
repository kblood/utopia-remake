// Synthetic coverage of the Disk.4 entity-list decoder (src/data/disk4-entities.ts). No original data is used.

const { decodeDisk4Entities, DISK4_FLAG_POINTER_OFFSET } = await import("../dist/data/disk4-entities.js");
const {
  decodeDisk4State, DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES, DISK4_ENTITY_SPECS,
} = await import("../dist/data/disk4-state.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
function put16(b, o, v) { b[o] = v >> 8; b[o + 1] = v & 0xff; }
function put32(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; }
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const code = (r) => (r.ok ? null : r.error.code);

const LISTS = ["enemyAir", "enemyGround", "ownShips", "ownTanks"];
const COUNT_ADDR = { enemyAir: DISK4_ADDR.countEnemyAir, enemyGround: DISK4_ADDR.countEnemyGround, ownShips: DISK4_ADDR.countOwnShips, ownTanks: DISK4_ADDR.countOwnTanks };

function areas() {
  return { name: "T", areaA: new Uint8Array(DISK4_AREA_A_BYTES), areaB: new Uint8Array(DISK4_AREA_B_BYTES) };
}
/** Writes bytes at record `index` of `list` (offset inside the record) into area A. */
function poke(a, list, index, off, bytes) {
  const base = offA(DISK4_ADDR[list]) + index * DISK4_ENTITY_SPECS[list].recordSize + off;
  for (let i = 0; i < bytes.length; i++) a.areaA[base + i] = bytes[i];
}
function setCount(a, list, n) { put16(a.areaB, offB(COUNT_ADDR[list]), n); }
function decode(a) {
  const st = decodeDisk4State(a);
  if (!st.ok) throw new Error("state failed: " + st.error.message);
  const r = decodeDisk4Entities(st.value);
  return { state: st.value, result: r };
}

// ---- Blank state: fixed arrays, all free, addresses per slot ---------------------------------
{
  const { result } = decode(areas());
  check("blank decodes", result.ok);
  const v = result.value;
  check("fixed capacities", v.enemyAir.slots.length === 30 && v.enemyGround.slots.length === 60 && v.ownShips.slots.length === 40 && v.ownTanks.slots.length === 99);
  check("record sizes", v.enemyAir.recordSize === 0x1a && v.enemyGround.recordSize === 0x1a && v.ownShips.recordSize === 0x18 && v.ownTanks.recordSize === 0x18);
  check("list base addresses", v.enemyAir.address === 0x39e3a && v.enemyGround.address === 0x3a146 && v.ownShips.address === 0x3a75e && v.ownTanks.address === 0x3ab1e);
  let ok = true;
  for (const name of LISTS) {
    const l = v[name];
    l.slots.forEach((s, i) => {
      if (s.list !== name || s.index !== i || s.status !== "free" || s.raw.length !== l.recordSize ||
        s.address !== DISK4_ADDR[name] + i * l.recordSize || s.flagPointer !== 0 || s.type !== 0) ok = false;
    });
    if (l.storedCount !== 0 || l.occupiedCount !== 0 || !l.countMatchesOccupied) ok = false;
  }
  check("blank: list name, index, address, free status on every slot", ok);
  check("last slot addresses", v.enemyAir.slots[29].address === 0x39e3a + 29 * 0x1a && v.ownTanks.slots[98].address === 0x3ab1e + 98 * 0x18);
}

// ---- Sparse slots: no compaction, counts are not bounds --------------------------------------
{
  const a = areas();
  poke(a, "enemyAir", 0, 0, [25]);
  poke(a, "enemyAir", 5, 0, [26]);
  poke(a, "enemyAir", 29, 0, [27]);
  setCount(a, "enemyAir", 1); // deliberately inconsistent with the 3 occupied slots
  poke(a, "ownTanks", 3, 0, [9]);
  poke(a, "ownTanks", 98, 0, [10]);
  setCount(a, "ownTanks", 0); // zero count, occupied slots still decoded
  setCount(a, "ownShips", 40); // full count, all slots free
  const { result } = decode(a);
  const v = result.value;
  check("sparse air: still 30 slots", v.enemyAir.slots.length === 30);
  const occIdx = v.enemyAir.slots.filter((s) => s.status === "occupied").map((s) => s.index);
  check("sparse air: occupied indexes kept in place", JSON.stringify(occIdx) === "[0,5,29]");
  check("sparse air: types per slot", v.enemyAir.slots[0].type === 25 && v.enemyAir.slots[5].type === 26 && v.enemyAir.slots[29].type === 27 && v.enemyAir.slots[1].type === 0);
  check("sparse air: addresses of occupied slots", v.enemyAir.slots[5].address === 0x39e3a + 5 * 0x1a && v.enemyAir.slots[29].address === 0x39e3a + 29 * 0x1a);
  check("sparse air: stored count vs occupied reported", v.enemyAir.storedCount === 1 && v.enemyAir.occupiedCount === 3 && v.enemyAir.countMatchesOccupied === false);
  check("zero count does not hide tanks", v.ownTanks.storedCount === 0 && v.ownTanks.occupiedCount === 2 && v.ownTanks.slots[3].status === "occupied" && v.ownTanks.slots[98].status === "occupied" && v.ownTanks.slots.length === 99);
  check("full count does not invent ships", v.ownShips.storedCount === 40 && v.ownShips.occupiedCount === 0 && v.ownShips.slots.every((s) => s.status === "free"));
  // matching count
  const b = areas();
  poke(b, "enemyGround", 7, 0, [22]);
  poke(b, "enemyGround", 40, 0, [24]);
  setCount(b, "enemyGround", 2);
  const g = decode(b).result.value.enemyGround;
  check("matching count flagged", g.countMatchesOccupied && g.occupiedCount === 2);
}

// ---- Free slot retention: stale bytes stay exactly as stored ---------------------------------
{
  const a = areas();
  const stale = [0, 0x12, 0x00, 0x05, 0xfb, 6, 0xfe, 0x01, 0x07, 0x81, 3, 0x20, 0x21, 0x09, 0x0a, 0x0b, 1, 2, 3, 0x44, 0xaa, 0xbb, 0x00, 0x03, 0xd3, 0xa6];
  poke(a, "enemyGround", 12, 0, stale); // type word cleared, rest stale
  const s = decode(a).result.value.enemyGround.slots[12];
  check("free slot with stale bytes", s.status === "free" && s.type === 0);
  check("free slot raw bytes exact", sameBytes(s.raw, Uint8Array.from(stale)));
  check("free slot pointer retained", s.flagPointer === 0x0003d3a6);
  check("free slot fields reported as stored", s.x === 0x12 && s.dx === 5 && s.dy === -5 && s.vx === -2 && s.hp === 7 && s.waiting === true);
  const t = areas();
  poke(t, "ownTanks", 20, 0x14, [0x00, 0x03, 0xd3, 0xa6]);
  const ts = decode(t).result.value.ownTanks.slots[20];
  check("free tank slot keeps its pointer", ts.status === "free" && ts.flagPointer === 0x0003d3a6);
}

// ---- Signed values and unsigned bytes --------------------------------------------------------
{
  const a = areas();
  //            type x    y    dx   dy   dir  vx   vy   hp   ctl  tech tx   ty
  poke(a, "ownTanks", 0, 0, [9, 0xff, 0x80, 0xf0, 0xf8, 7, 0xfe, 0xff, 0xff, 0xff, 0x7f, 0xff, 0x80]);
  poke(a, "ownTanks", 1, 0, [10, 0, 0, 0x7f, 0x80, 0, 2, 1, 8, 0x7f, 0, 0, 0]);
  const t = decode(a).result.value.ownTanks.slots;
  check("tank unsigned bytes stay unsigned", t[0].x === 255 && t[0].y === 128 && t[0].hp === 255 && t[0].targetX === 255 && t[0].targetY === 128 && t[0].tech === 127 && t[0].direction === 7);
  check("tank signed dx/dy/vx/vy", t[0].dx === -16 && t[0].dy === -8 && t[0].vx === -2 && t[0].vy === -1);
  check("tank signed extremes", t[1].dx === 127 && t[1].dy === -128 && t[1].vx === 2 && t[1].vy === 1);
  check("tank control raw + waiting bit", t[0].control === 0xff && t[0].waiting === true && t[1].control === 0x7f && t[1].waiting === false);
  // the same signed rule on the other lists
  const b = areas();
  poke(b, "ownShips", 2, 0, [11, 3, 4, 0xe0, 0x20, 8, 0xfe, 0x02, 10, 1, 0, 0xff, 0xff]);
  poke(b, "enemyAir", 2, 0, [25, 3, 4, 0x81, 0x7e, 3, 0x00, 0xfe, 5, 6, 0, 0xff, 0xff]);
  const d = decode(b).result.value;
  check("ship signed fields and raw dir 8", d.ownShips.slots[2].dx === -32 && d.ownShips.slots[2].dy === 32 && d.ownShips.slots[2].vx === -2 && d.ownShips.slots[2].vy === 2 && d.ownShips.slots[2].direction === 8);
  check("air signed fields", d.enemyAir.slots[2].dx === -127 && d.enemyAir.slots[2].dy === 126 && d.enemyAir.slots[2].vy === -2);
  check("target $FF kept raw", d.ownShips.slots[2].targetX === 255 && d.enemyAir.slots[2].targetY === 255);
}

// ---- Exact pointer offset / slot provenance --------------------------------------------------
{
  check("pointer offsets", DISK4_FLAG_POINTER_OFFSET.ownTanks === 0x14 && DISK4_FLAG_POINTER_OFFSET.ownShips === 0x14 && DISK4_FLAG_POINTER_OFFSET.enemyAir === 0x16 && DISK4_FLAG_POINTER_OFFSET.enemyGround === 0x16);
  const a = areas();
  const ptr = 0x0003d3a6 + 5 * 0x66 + 7;
  const tank = new Uint8Array(0x18); tank[0] = 9; put32(tank, 0x14, ptr);
  poke(a, "ownTanks", 4, 0, tank);
  const ship = new Uint8Array(0x18); ship[0] = 12; put32(ship, 0x14, ptr + 1);
  poke(a, "ownShips", 9, 0, ship);
  // enemy record: distinct bytes at +$14/+$15 so a wrong pointer offset is caught; pointer at +$16
  const en = new Uint8Array(0x1a); en[0] = 22; en[0x14] = 0xee; en[0x15] = 0xdd; put32(en, 0x16, 0x80000001);
  poke(a, "enemyGround", 33, 0, en);
  const air = new Uint8Array(0x1a); air[0] = 26; air[0x14] = 0x11; air[0x15] = 0x22; put32(air, 0x16, ptr + 2);
  poke(a, "enemyAir", 6, 0, air);
  const v = decode(a).result.value;
  check("tank pointer at +$14", v.ownTanks.slots[4].flagPointer === ptr);
  check("ship pointer at +$14", v.ownShips.slots[9].flagPointer === ptr + 1);
  check("enemy ground pointer at +$16, unsigned", v.enemyGround.slots[33].flagPointer === 0x80000001 && v.enemyGround.slots[33].byte14 === 0xee && v.enemyGround.slots[33].byte15 === 0xdd);
  check("enemy air pointer at +$16", v.enemyAir.slots[6].flagPointer === ptr + 2 && v.enemyAir.slots[6].byte14 === 0x11 && v.enemyAir.slots[6].byte15 === 0x22);
  check("pointer is a raw number, not resolved", typeof v.ownTanks.slots[4].flagPointer === "number");
  check("pointer neighbours do not leak", v.ownTanks.slots[3].flagPointer === 0 && v.ownTanks.slots[5].flagPointer === 0 && v.ownShips.slots[8].flagPointer === 0);
  // provenance: raw is exactly the stored bytes at address - area base
  const st = decodeDisk4State(a).value;
  const s = v.ownTanks.slots[4];
  const from = s.address - DISK4_AREA_A_BASE;
  check("raw matches area A at slot address", sameBytes(s.raw, st.areaA.subarray(from, from + 0x18)) && s.address === 0x3ab1e + 4 * 0x18);
  const e = v.enemyGround.slots[33];
  const ef = e.address - DISK4_AREA_A_BASE;
  check("enemy raw matches area A at slot address", sameBytes(e.raw, st.areaA.subarray(ef, ef + 0x1a)) && e.address === 0x3a146 + 33 * 0x1a);
}

// ---- Own ship vs own tank overlap on the same bytes ------------------------------------------
{
  const a = areas();
  const rec = Uint8Array.from([11, 5, 6, 0, 0, 8, 0, 0, 20, 0x03, 4, 0xff, 0xff, 0x04, 0x01, 0x90, 0x22, 0x04, 0x02, 0x77, 0, 0, 0, 0]);
  poke(a, "ownShips", 0, 0, rec);
  poke(a, "ownTanks", 0, 0, Uint8Array.from([9, 5, 6, 0, 0, 2, 0, 0, 8, 0xff, 4, 0xff, 0xff, 0x00, 0xff, 0xff, 0x01, 0x02, 0x03, 0x99, 0, 0, 0, 0]));
  const v = decode(a).result.value;
  const sh = v.ownShips.slots[0];
  check("ship class/fuel word/lift/next/turn", sh.shipClass === 4 && sh.fuel === 0x0190 && sh.lift === 0x22 && sh.nextMode === 4 && sh.turn === 2);
  check("ship control is the raw mode byte", sh.control === 3 && !("waiting" in sh));
  check("ship has no tank-only fields", !("recentDirections" in sh));
  const tk = v.ownTanks.slots[0];
  check("tank recent directions from +$10..+$12", JSON.stringify(tk.recentDirections) === "[1,2,3]");
  check("tank has no ship fields", !("shipClass" in tk) && !("fuel" in tk) && !("lift" in tk) && !("nextMode" in tk) && !("turn" in tk));
  check("tank undocumented bytes only in raw", tk.raw[0x0d] === 0 && tk.raw[0x0e] === 0xff && tk.raw[0x13] === 0x99);
  check("ship +$13 stays opaque in raw", sh.raw[0x13] === 0x77);
}

// ---- Missile (ship list type 17): +$C..+$F is a masked long, no class/fuel ---------------------------------------------------
{
  const a = areas();
  // x=7 y=8; +B=9 +C=$2A; long at +$C = $2A03A12C -> address $03A12C; +$10..+$12 = $22,3,4; +$13 undocumented; +$14 flag pointer
  poke(a, "ownShips", 1, 0, Uint8Array.from([17, 7, 8, 0xfd, 2, 3, 1, 0xff, 40, 4, 5, 9, 0x2a, 0x03, 0xa1, 0x2c, 0x22, 3, 4, 0x77, 0, 0x03, 0xd4, 0x10]));
  poke(a, "ownShips", 2, 0, Uint8Array.from([11, 7, 8, 0, 0, 3, 0, 0, 40, 4, 5, 9, 0x2a, 0x03, 0xa1, 0x2c, 0x22, 3, 4, 0x77, 0, 0, 0, 0])); // same bytes as a type-11 ship
  poke(a, "ownShips", 3, 0, Uint8Array.from([0, 7, 8, 0, 0, 3, 0, 0, 40, 4, 5, 9, 0x2a, 0x03, 0xa1, 0x2c])); // free slot with stale missile-like bytes
  poke(a, "ownShips", 4, 0, Uint8Array.from([18, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])); // undocumented type
  poke(a, "ownShips", 5, 0, Uint8Array.from([17, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])); // address $FFFFFF
  const v = decode(a).result.value;
  const m = v.ownShips.slots[1];
  check("missile layout discriminant and kept common fields", m.layout === "missile" && m.type === 17 && m.status === "occupied" && m.x === 7 && m.y === 8 && m.dx === -3 && m.vy === -1 && m.hp === 40 && m.control === 4 && m.tech === 5);
  check("missile +B/+C are the base target bytes", m.targetX === 9 && m.targetY === 0x2a);
  check("missile raw long at +$C and the 24-bit masked address (+$D..+$F)", m.targetLong === 0x2a03a12c && m.targetAddress === 0x03a12c);
  check("missile has no class or fuel field", !("shipClass" in m) && !("fuel" in m));
  check("missile +$10..+$12 and +$14 pointer decoded as for ships", m.lift === 0x22 && m.nextMode === 3 && m.turn === 4 && m.flagPointer === 0x0003d410);
  check("missile +$13 stays raw only", m.raw[0x13] === 0x77);
  const sh = v.ownShips.slots[2];
  check("the same bytes under type 11 are a ship (class $03, fuel word $A12C) with no target fields", sh.layout === "ship" && sh.shipClass === 0x03 && sh.fuel === 0xa12c && !("targetLong" in sh) && !("targetAddress" in sh));
  check("free slot keeps the ordinary layout and stale bytes", v.ownShips.slots[3].status === "free" && v.ownShips.slots[3].layout === "ship" && v.ownShips.slots[3].x === 7);
  check("undocumented type keeps the ordinary layout, unvalidated", v.ownShips.slots[4].layout === "ship" && v.ownShips.slots[4].type === 18 && v.ownShips.slots[4].shipClass === 0xff);
  check("mask keeps 24 bits only", v.ownShips.slots[5].targetLong === 0xffffffff && v.ownShips.slots[5].targetAddress === 0xffffff);
  check("blank ship slots are ordinary layout", v.ownShips.slots[0].layout === "ship" && v.ownShips.slots[39].layout === "ship");
}

// ---- Enemy type-specific overlap -------------------------------------------------------------
{
  const a = areas();
  const mk = (type, aux, b14, b15) => {
    const r = new Uint8Array(0x1a);
    r[0] = type; r[0x0d] = 3; r[0x0e] = 40; r[0x0f] = 7; r[0x10] = 0x22; r[0x11] = 0x33; r[0x12] = 0x44; r[0x13] = aux; r[0x14] = b14; r[0x15] = b15;
    return r;
  };
  poke(a, "enemyGround", 0, 0, mk(22, 0x05, 0x10, 0x20)); // walker
  poke(a, "enemyGround", 1, 0, mk(23, 0x05, 0x10, 0x20)); // walker
  poke(a, "enemyGround", 2, 0, mk(24, 0x01, 0x10, 0x20)); // crusher
  poke(a, "enemyGround", 3, 0, mk(9, 0, 0, 0)); // defected tank
  poke(a, "enemyGround", 4, 0, mk(10, 0, 0, 0));
  poke(a, "enemyGround", 5, 0, mk(99, 0xff, 0, 0)); // undocumented type
  poke(a, "enemyAir", 0, 0, mk(25, 0xff, 30, 0)); // bomber, +$13 = -1
  poke(a, "enemyAir", 1, 0, mk(26, 0x0e, 30, 1)); // kamikaze
  poke(a, "enemyAir", 2, 0, mk(27, 0x0e, 30, 1));
  const v = decode(a).result.value;
  const g = v.enemyGround.slots, ar = v.enemyAir.slots;
  check("walker kinds", g[0].overlap.kind === "walker" && g[1].overlap.kind === "walker" && g[0].overlap.aux === "unknown");
  check("crusher +$13 is toggle + counter, +$14 the animation", g[2].overlap.kind === "crusher" && g[2].overlap.aux === "crusher-toggle-counter" && g[2].overlap.byte14 === "crusher-animation" && g[2].overlap.byte15 === "unknown" && g[2].aux === 1 && g[2].byte14 === 0x10);
  check("defected tank kinds 9/10", g[3].overlap.kind === "defected-tank" && g[4].overlap.kind === "defected-tank");
  check("unknown type annotated unknown", g[5].overlap.kind === "unknown" && g[5].overlap.aux === "unknown" && g[5].overlap.byte14 === "unknown");
  check("bomber aux = bomb count, +$14/+$15 documented", ar[0].overlap.kind === "bomber" && ar[0].overlap.aux === "bomb-count" && ar[0].overlap.byte14 === "bomb-run-chance" && ar[0].overlap.byte15 === "bomb-run-gate");
  check("bomber +$13 raw and signed", ar[0].aux === 0xff && ar[0].auxSigned === -1);
  check("kamikaze aux = dive height (26 and 27)", ar[1].overlap.aux === "dive-height" && ar[2].overlap.aux === "dive-height" && ar[1].overlap.kind === "kamikaze" && ar[2].overlap.kind === "kamikaze");
  check("non-bomber +$14/+$15 stay unknown but raw", ar[1].overlap.byte14 === "unknown" && ar[1].byte14 === 30 && ar[1].byte15 === 1);
  check("step/bomb chance/damage", g[0].stepCounter === 3 && g[0].bombChance === 40 && g[0].damage === 7);
  // +$10: lift in the air list, recent directions in the ground list, same bytes
  check("air +$10 is lift", ar[0].lift === 0x22 && !("recentDirections" in ar[0]) && !("waiting" in ar[0]));
  check("ground +$10..+$12 are recent directions", JSON.stringify(g[0].recentDirections) === "[34,51,68]" && !("lift" in g[0]));
  check("air +$11/+$12 only in raw", ar[0].raw[0x11] === 0x33 && ar[0].raw[0x12] === 0x44);
  // waiting bit on ground enemies
  const b = areas();
  poke(b, "enemyGround", 0, 0, [22, 0, 0, 0, 0, 0, 0, 0, 5, 0x80]);
  poke(b, "enemyGround", 1, 0, [22, 0, 0, 0, 0, 0, 0, 0, 5, 0x7f]);
  const w = decode(b).result.value.enemyGround.slots;
  check("enemy ground waiting bit", w[0].waiting === true && w[0].control === 0x80 && w[1].waiting === false && w[1].control === 0x7f);
}

// ---- Counts and shape validation (hand-built states) -----------------------------------------
{
  const st = decodeDisk4State(areas()).value;
  const withList = (name, patch) => ({ ...st, [name]: { ...st[name], ...patch } });
  for (const name of LISTS) {
    const cap = DISK4_ENTITY_SPECS[name].capacity;
    check(`${name} count ${cap} accepted`, decodeDisk4Entities(withList(name, { count: cap })).ok);
    check(`${name} count 0 accepted`, decodeDisk4Entities(withList(name, { count: 0 })).ok);
    const over = decodeDisk4Entities(withList(name, { count: cap + 1 }));
    check(`${name} count ${cap + 1} rejected with list name`, code(over) === "count-range" && over.error.list === name);
    check(`${name} negative count rejected`, code(decodeDisk4Entities(withList(name, { count: -1 }))) === "count-range");
    check(`${name} fractional count rejected`, code(decodeDisk4Entities(withList(name, { count: 1.5 }))) === "count-range");
    check(`${name} NaN count rejected`, code(decodeDisk4Entities(withList(name, { count: NaN }))) === "count-range");
    check(`${name} short records rejected`, code(decodeDisk4Entities(withList(name, { records: new Uint8Array(10) }))) === "list-shape");
    check(`${name} wrong record size rejected`, code(decodeDisk4Entities(withList(name, { recordSize: 8 }))) === "list-shape");
    check(`${name} wrong capacity rejected`, code(decodeDisk4Entities(withList(name, { capacity: cap - 1 }))) === "list-shape");
    check(`${name} missing list rejected`, code(decodeDisk4Entities({ ...st, [name]: undefined })) === "list-shape");
  }
  for (const bad of [null, undefined, 5, "x"]) {
    let threw = false, r = null;
    try { r = decodeDisk4Entities(bad); } catch { threw = true; }
    check(`bad input ${String(bad)} gives typed error`, !threw && code(r) === "not-state");
  }
  // a rejected list yields no partial result
  const r = decodeDisk4Entities(withList("ownTanks", { count: 100 }));
  check("no partial result on error", !r.ok && !("value" in r));
}

// ---- Immutability and copies -----------------------------------------------------------------
{
  const a = areas();
  poke(a, "ownTanks", 1, 0, [9, 1, 2, 3, 4, 5]);
  poke(a, "enemyAir", 1, 0, [25, 1, 2]);
  const st = decodeDisk4State(a).value;
  const snap = {
    areaA: st.areaA.slice(), areaB: st.areaB.slice(),
    lists: LISTS.map((n) => st[n].records.slice()), counts: LISTS.map((n) => st[n].count),
  };
  const r = decodeDisk4Entities(st);
  const same = sameBytes(snap.areaA, st.areaA) && sameBytes(snap.areaB, st.areaB) &&
    LISTS.every((n, i) => sameBytes(snap.lists[i], st[n].records) && snap.counts[i] === st[n].count);
  check("decoding leaves the state untouched", r.ok && same);
  // result raw is a copy: changing it does not touch the state
  r.value.ownTanks.slots[1].raw[1] = 0xee;
  check("mutating result raw does not change state", st.ownTanks.records[0x18 + 1] === 1 && st.areaA[offA(DISK4_ADDR.ownTanks) + 0x18 + 1] === 1);
  // changing the state afterwards does not change the result
  const before = r.value.enemyAir.slots[1].x;
  st.enemyAir.records[0x1a + 1] = 0x55;
  check("state changes after decode do not leak in", r.value.enemyAir.slots[1].x === before && r.value.enemyAir.slots[1].raw[1] === 1);
  // slot raw arrays are independent from each other
  check("slot raw buffers are distinct", r.value.ownTanks.slots[0].raw.buffer !== r.value.ownTanks.slots[1].raw.buffer || r.value.ownTanks.slots[0].raw.byteOffset !== r.value.ownTanks.slots[1].raw.byteOffset);
  // decoding twice is deterministic
  const st2 = decodeDisk4State(a).value;
  const x = decodeDisk4Entities(st2).value, y = decodeDisk4Entities(st2).value;
  check("repeat decode equal", LISTS.every((n) => x[n].slots.every((s, i) => sameBytes(s.raw, y[n].slots[i].raw) && s.status === y[n].slots[i].status)));
}

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall disk4-entities checks passed");
