// Synthetic coverage of the Disk.4 area A/B decoder (src/data/disk4-state.ts). No original data is used.

const {
  decodeDisk4State, DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES,
  DISK4_ENTITY_SPECS, DISK4_MAP_WIDTH, DISK4_MAP_HEIGHT, DISK4_MAP_ROW_WORDS, DISK4_FLAG_ROW_BYTES,
} = await import("../dist/data/disk4-state.js");
const { parseDisk4, readDisk4Slot, DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT } = await import("../dist/data/disk4.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
function put16(b, o, v) { b[o] = v >> 8; b[o + 1] = v & 0xff; }
function areas(name = "T") {
  return { name, areaA: new Uint8Array(DISK4_AREA_A_BYTES), areaB: new Uint8Array(DISK4_AREA_B_BYTES) };
}
const code = (r) => (r.ok ? null : r.error.code);
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

check("constants", DISK4_AREA_A_BYTES === 37376 && DISK4_AREA_B_BYTES === 5632 && DISK4_MAP_ROW_WORDS === 102 &&
  DISK4_FLAG_ROW_BYTES === 102 && DISK4_MAP_WIDTH === 100 && DISK4_MAP_HEIGHT === 75);

// Documented regions are contiguous and fit inside area A (addresses from game-state.md).
check("address layout", DISK4_ADDR.enemyAir + 30 * 0x1a === DISK4_ADDR.enemyGround &&
  DISK4_ADDR.enemyGround + 60 * 0x1a === DISK4_ADDR.ownShips && DISK4_ADDR.ownShips + 40 * 0x18 === DISK4_ADDR.ownTanks &&
  DISK4_ADDR.ownTanks + 99 * 0x18 === DISK4_ADDR.objects && DISK4_ADDR.objects + 1000 * 8 === DISK4_ADDR.flags &&
  DISK4_ADDR.flags + 75 * 102 === 0x3f188 &&
  offA(DISK4_ADDR.mapCells) + 74 * 204 + 200 <= DISK4_AREA_A_BYTES);
check("counts live in area B", [DISK4_ADDR.countEnemyAir, DISK4_ADDR.countEnemyGround, DISK4_ADDR.countOwnShips,
  DISK4_ADDR.countOwnTanks, DISK4_ADDR.countObjects].every((a) => offB(a) >= 0 && offB(a) + 2 <= DISK4_AREA_B_BYTES));

// Blank areas decode to zeros with correct shapes.
{
  const r = decodeDisk4State(areas("BLANK"));
  check("blank decodes", r.ok && r.value.name === "BLANK");
  const v = r.value;
  check("blank shapes", v.mapCells.length === 7500 && v.cellFlags.length === 75 * 102 && v.objects.records.length === 8000 &&
    v.objects.count === 0 && v.enemyAir.records.length === 780 && v.enemyGround.records.length === 1560 &&
    v.ownShips.records.length === 960 && v.ownTanks.records.length === 2376 && v.areaA.length === 37376 && v.areaB.length === 5632);
  check("blank all zero", v.mapCells.every((x) => x === 0) && v.enemyAir.count === 0 && v.ownTanks.count === 0);
  check("entity specs", v.enemyAir.recordSize === 0x1a && v.enemyAir.capacity === 30 && v.enemyGround.capacity === 60 &&
    v.ownShips.recordSize === 0x18 && v.ownShips.capacity === 40 && v.ownTanks.capacity === 99 &&
    v.objects.recordSize === 8 && v.objects.slots === 1000);
}

// Absolute-address extraction and endianness: each region gets distinct markers at its first and last byte.
{
  const a = areas();
  const mark = (addr, bytes) => { for (let i = 0; i < bytes.length; i++) a.areaA[offA(addr) + i] = bytes[i]; };
  const spec = DISK4_ENTITY_SPECS;
  mark(DISK4_ADDR.enemyAir, [0x11, 0x12]);
  mark(DISK4_ADDR.enemyAir + 30 * spec.enemyAir.recordSize - 1, [0x13]);
  mark(DISK4_ADDR.enemyGround, [0x21]);
  mark(DISK4_ADDR.enemyGround + 60 * spec.enemyGround.recordSize - 1, [0x22]);
  mark(DISK4_ADDR.ownShips, [0x31]);
  mark(DISK4_ADDR.ownShips + 40 * spec.ownShips.recordSize - 1, [0x32]);
  mark(DISK4_ADDR.ownTanks, [0x41]);
  mark(DISK4_ADDR.ownTanks + 99 * spec.ownTanks.recordSize - 1, [0x42]);
  mark(DISK4_ADDR.objects, [0x51, 0x52]);
  mark(DISK4_ADDR.objects + 7999, [0x53]);
  mark(DISK4_ADDR.flags, [0x61]);
  mark(DISK4_ADDR.flags + 75 * 102 - 1, [0x62]);
  mark(DISK4_ADDR.mapCells, [0x12, 0x34]); // word $1234 big-endian at cell (0,0)
  put16(a.areaB, offB(DISK4_ADDR.countEnemyAir), 0x0007);
  put16(a.areaB, offB(DISK4_ADDR.countEnemyGround), 0x0021);
  put16(a.areaB, offB(DISK4_ADDR.countOwnShips), 0x0003);
  put16(a.areaB, offB(DISK4_ADDR.countOwnTanks), 0x0063); // 99 = max
  put16(a.areaB, offB(DISK4_ADDR.countObjects), 0x0102); // 258: both bytes non-zero to catch swapped endianness
  const r = decodeDisk4State(a);
  check("markers decode", r.ok);
  const v = r.value;
  check("enemy air extraction", v.enemyAir.records[0] === 0x11 && v.enemyAir.records[1] === 0x12 && v.enemyAir.records[779] === 0x13);
  check("enemy ground extraction", v.enemyGround.records[0] === 0x21 && v.enemyGround.records[1559] === 0x22);
  check("own ships extraction", v.ownShips.records[0] === 0x31 && v.ownShips.records[959] === 0x32);
  check("own tanks extraction", v.ownTanks.records[0] === 0x41 && v.ownTanks.records[2375] === 0x42);
  check("object extraction", v.objects.records[0] === 0x51 && v.objects.records[1] === 0x52 && v.objects.records[7999] === 0x53);
  check("flag extraction", v.cellFlags[0] === 0x61 && v.cellFlags[75 * 102 - 1] === 0x62);
  check("map word big-endian", v.mapCells[0] === 0x1234);
  check("counts big-endian", v.enemyAir.count === 7 && v.enemyGround.count === 33 && v.ownShips.count === 3 &&
    v.ownTanks.count === 99 && v.objects.count === 258);
  check("no cross-region bleed", v.enemyAir.records[26] === 0 && v.enemyGround.records[26] === 0 && v.ownShips.records[1] === 0 && v.objects.records[8] === 0);
}

// Map row stride (102 words) and padding: pad words never appear in cells; cell values land in the right row.
{
  const a = areas();
  const base = offA(DISK4_ADDR.mapCells);
  for (let y = 0; y < 75; y++) {
    for (let x = 0; x < 102; x++) put16(a.areaA, base + (y * 102 + x) * 2, x < 100 ? y * 100 + x : 0x73ff);
  }
  const r = decodeDisk4State(a);
  check("map decodes", r.ok);
  const m = r.value.mapCells;
  let ok = true;
  for (let i = 0; i < 7500; i++) if (m[i] !== i) ok = false;
  check("map row-major, pad words dropped", ok);
  check("map corners and row boundary", m[0] === 0 && m[99] === 99 && m[100] === 100 && m[74 * 100 + 99] === 7499);
  check("no pad word leaked", !m.includes(0x73ff));
}

// Flag rows keep all 102 columns, including the two padding bytes.
{
  const a = areas();
  const base = offA(DISK4_ADDR.flags);
  for (let i = 0; i < 75 * 102; i++) a.areaA[base + i] = (i * 7 + 3) & 0xff;
  const r = decodeDisk4State(a);
  check("flags decode", r.ok);
  check("flags stride 102 incl. padding", r.ok && r.value.cellFlags.length === 7650 && r.value.cellFlags[100] === ((100 * 7 + 3) & 0xff) &&
    r.value.cellFlags[101] === ((101 * 7 + 3) & 0xff) && r.value.cellFlags[102] === ((102 * 7 + 3) & 0xff));
}

// Source bytes are preserved (including undocumented ranges) and the DTO owns copies.
{
  const a = areas("KEEP");
  for (let i = 0; i < a.areaA.length; i++) a.areaA[i] = (i * 31 + 5) & 0xff;
  for (let i = 0; i < a.areaB.length; i++) a.areaB[i] = (i * 17 + 9) & 0xff;
  for (const c of [DISK4_ADDR.countEnemyAir, DISK4_ADDR.countEnemyGround, DISK4_ADDR.countOwnShips, DISK4_ADDR.countOwnTanks, DISK4_ADDR.countObjects]) {
    put16(a.areaB, offB(c), 1);
  }
  const srcA = a.areaA.slice();
  const srcB = a.areaB.slice();
  const r = decodeDisk4State(a);
  check("noisy input decodes", r.ok);
  check("areaA preserved", sameBytes(r.value.areaA, srcA));
  check("areaB preserved untouched", sameBytes(r.value.areaB, srcB));
  check("input not modified", sameBytes(a.areaA, srcA) && sameBytes(a.areaB, srcB));
  a.areaA.fill(0); a.areaB.fill(0);
  check("result owns copies", sameBytes(r.value.areaA, srcA) && sameBytes(r.value.areaB, srcB) && r.value.mapCells.some((x) => x !== 0));
  check("record copies detached", r.value.objects.records.buffer !== r.value.areaA.buffer && r.value.enemyAir.records.buffer !== r.value.areaA.buffer);
}

// Count bounds: max accepted, max + 1 rejected, 0xFFFF rejected, no partial result.
{
  const lists = [
    ["enemy air", DISK4_ADDR.countEnemyAir, 30],
    ["enemy ground", DISK4_ADDR.countEnemyGround, 60],
    ["own ships", DISK4_ADDR.countOwnShips, 40],
    ["own tanks", DISK4_ADDR.countOwnTanks, 99],
    ["objects", DISK4_ADDR.countObjects, 1000],
  ];
  for (const [label, addr, max] of lists) {
    const okA = areas(); put16(okA.areaB, offB(addr), max);
    check(`${label} count ${max} accepted`, decodeDisk4State(okA).ok);
    for (const bad of [max + 1, 0xffff, 0x8000 | max]) {
      const a = areas(); put16(a.areaB, offB(addr), bad);
      const r = decodeDisk4State(a);
      check(`${label} count ${bad} rejected`, code(r) === "count-range" && !("value" in r) && r.error.message.length > 0);
    }
  }
  // A low-byte-only bounds check would accept $0100 + 0; the high byte must count.
  const a = areas(); put16(a.areaB, offB(DISK4_ADDR.countOwnTanks), 0x0100);
  check("high byte counts toward bound", code(decodeDisk4State(a)) === "count-range");
}

// Wrong shapes and sizes return typed errors without throwing and without a value.
{
  const sized = (la, lb) => ({ name: "X", areaA: new Uint8Array(la), areaB: new Uint8Array(lb) });
  for (const [label, input, expected] of [
    ["A one byte short", sized(DISK4_AREA_A_BYTES - 1, DISK4_AREA_B_BYTES), "area-a-size"],
    ["A one byte long", sized(DISK4_AREA_A_BYTES + 1, DISK4_AREA_B_BYTES), "area-a-size"],
    ["A empty", sized(0, DISK4_AREA_B_BYTES), "area-a-size"],
    ["B one byte short", sized(DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES - 1), "area-b-size"],
    ["B one byte long", sized(DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES + 1), "area-b-size"],
    ["A and B swapped", { name: "X", areaA: new Uint8Array(DISK4_AREA_B_BYTES), areaB: new Uint8Array(DISK4_AREA_A_BYTES) }, "area-a-size"],
    ["null", null, "not-areas"],
    ["undefined", undefined, "not-areas"],
    ["number", 5, "not-areas"],
    ["missing areaB", { name: "X", areaA: new Uint8Array(DISK4_AREA_A_BYTES) }, "not-areas"],
    ["plain array area", { name: "X", areaA: new Array(DISK4_AREA_A_BYTES).fill(0), areaB: new Uint8Array(DISK4_AREA_B_BYTES) }, "not-areas"],
    ["Uint16Array area", { name: "X", areaA: new Uint16Array(DISK4_AREA_A_BYTES), areaB: new Uint8Array(DISK4_AREA_B_BYTES) }, "not-areas"],
  ]) {
    let r, threw = false;
    try { r = decodeDisk4State(input); } catch { threw = true; }
    check(`${label} -> ${expected}`, !threw && code(r) === expected && !("value" in r));
  }
}

// Composes with readDisk4Slot: absolute addresses hold for areas read from a synthetic raw Disk.4 image.
{
  const SECTORS = 1920;
  const img = new Uint8Array(SECTORS * 512);
  const sig = "UTOPSAVE";
  for (let k = 0; k < 8; k++) img[DISK4_HEADER_OFFSET + k] = sig.charCodeAt(k);
  for (let i = 0; i < DISK4_SLOT_COUNT; i++) {
    const rec = DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + i * DISK4_RECORD_SIZE;
    const nm = i === 2 ? "SLOT TWO" : "EMPTY";
    for (let k = 0; k < nm.length; k++) img[rec + k] = nm.charCodeAt(k);
  }
  const rec2 = DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + 2 * DISK4_RECORD_SIZE;
  put16(img, rec2 + 0x10, 100); put16(img, rec2 + 0x12, 172); put16(img, rec2 + 0x14, 174); put16(img, rec2 + 0x16, 184);
  img[100 * 512 + offA(DISK4_ADDR.mapCells) + 1] = 0x7f; // cell (0,0) low byte
  put16(img, 174 * 512 + offB(DISK4_ADDR.countOwnShips), 5);
  const disk = parseDisk4(img);
  const slot = disk.ok ? readDisk4Slot(disk.value, 2) : null;
  const r = slot && slot.ok ? decodeDisk4State(slot.value) : null;
  check("composes with readDisk4Slot", r !== null && r.ok && r.value.name === "SLOT TWO" && r.value.mapCells[0] === 0x7f && r.value.ownShips.count === 5);
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall disk4-state checks passed");
