// Synthetic coverage of the raw Disk.4 parser (src/data/disk4.ts). No original data is used.

const {
  parseDisk4, readDisk4Slot, DISK4_SLOT_COUNT, DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE,
  DISK4_AREA_A_SECTORS, DISK4_AREA_B_SECTORS,
} = await import("../dist/data/disk4.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const SECTORS = 1920;
const rec = (i) => DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + i * DISK4_RECORD_SIZE;

function put16(b, o, v) { b[o] = v >> 8; b[o + 1] = v & 0xff; }
function putName(b, i, name) {
  b.fill(0, rec(i), rec(i) + 16);
  for (let k = 0; k < name.length; k++) b[rec(i) + k] = name.charCodeAt(k);
}
function setExtents(b, i, a0, a1, b0, b1) {
  put16(b, rec(i) + 0x10, a0); put16(b, rec(i) + 0x12, a1);
  put16(b, rec(i) + 0x14, b0); put16(b, rec(i) + 0x16, b1);
}
/** Blank synthetic image like the documented seed: signature, id word 0, and ten EMPTY slots. */
function blank(sectors = SECTORS) {
  const b = new Uint8Array(sectors * 512);
  for (let k = 0; k < 8; k++) b[DISK4_HEADER_OFFSET + k] = "UTOPSAVE".charCodeAt(k);
  for (let i = 0; i < DISK4_SLOT_COUNT; i++) putName(b, i, "EMPTY");
  return b;
}
function fillSectors(b, first, last, v) { b.fill(v, first * 512, (last + 1) * 512); }
const errCode = (r) => (r.ok ? null : r.error.code);

check("area sizes", DISK4_AREA_A_SECTORS === 73 && DISK4_AREA_B_SECTORS === 11 && DISK4_SLOT_COUNT === 10);

// Blank disk: all empty, even with garbage extents that would be invalid if read.
{
  const b = blank();
  setExtents(b, 3, 0xffff, 0, 5, 5);
  const r = parseDisk4(b);
  check("blank disk parses", r.ok && r.value.slots.length === 10 && r.value.slots.every((s) => s.state === "empty"));
  check("id word zero accepted", r.ok && r.value.idWord === 0);
  check("empty slot read refused", errCode(readDisk4Slot(r.value, 3)) === "slot-empty");
}

// Populated slot: documented slot-0 extents (0,72) and (74,84).
{
  const b = blank();
  putName(b, 0, "SAVE 01.02.93");
  setExtents(b, 0, 0, 72, 74, 84);
  fillSectors(b, 0, 72, 0xa1);
  fillSectors(b, 74, 84, 0xb2);
  b[73 * 512] = 0xee; // sector 73 lies between the areas and belongs to neither
  const r = parseDisk4(b);
  check("populated parses", r.ok && r.value.slots[0].state === "populated" && r.value.slots[1].state === "empty");
  const s = r.value.slots[0];
  check("extent fields", s.areaA.sectorCount === 73 && s.areaA.byteOffset === 0 && s.areaA.byteLength === 73 * 512 &&
    s.areaB.firstSector === 74 && s.areaB.lastSector === 84 && s.areaB.sectorCount === 11 && s.areaB.byteLength === 11 * 512);
  const out = readDisk4Slot(r.value, 0);
  check("read ok with name", out.ok && out.value.name === "SAVE 01.02.93");
  check("area lengths", out.ok && out.value.areaA.length === 37376 && out.value.areaB.length === 5632);
  check("area contents", out.ok && out.value.areaA.every((v) => v === 0xa1) && out.value.areaB.every((v) => v === 0xb2));
  out.value.areaA[0] = 0; out.value.areaB[0] = 0;
  check("outputs are copies", b[0] === 0xa1 && b[74 * 512] === 0xb2);
  const again = readDisk4Slot(r.value, 0);
  check("second read unaffected", again.ok && again.value.areaA[0] === 0xa1);
  check("slot index range", errCode(readDisk4Slot(r.value, 10)) === "slot-index" && errCode(readDisk4Slot(r.value, -1)) === "slot-index" &&
    errCode(readDisk4Slot(r.value, 1.5)) === "slot-index");
}

// Nonzero id word is exposed, not rejected (the original loader never reads it).
{
  const b = blank();
  put16(b, DISK4_HEADER_OFFSET + 8, 3);
  const r = parseDisk4(b);
  check("id word exposed", r.ok && r.value.idWord === 3);
}

// Input rejection.
{
  const xpk = new Uint8Array(656);
  xpk.set([0x58, 0x50, 0x4b, 0x46]);
  const r = parseDisk4(xpk);
  check("XPK seed rejected", errCode(r) === "compressed-xpk" && /XPK/.test(r.error.message));
  check("too short", errCode(parseDisk4(new Uint8Array(DISK4_HEADER_OFFSET + 100))) === "too-short");
  check("non-bytes", errCode(parseDisk4([1, 2, 3])) === "not-bytes");
  const b = blank();
  b[DISK4_HEADER_OFFSET + 7] = 0x58; // UTOPSAVX
  check("bad signature", errCode(parseDisk4(b)) === "bad-signature");
  const s = blank();
  for (let k = 0; k < 8; k++) s[DISK4_HEADER_OFFSET + k] = "UTOPSCEN".charCodeAt(k);
  check("scenario disk rejected", errCode(parseDisk4(s)) === "bad-signature");
  // Header exactly as small as the parser allows (650 bytes past the header offset) is accepted.
  const minimal = blank().slice(0, DISK4_HEADER_OFFSET + 10 + 10 * 64);
  check("minimal length accepted", parseDisk4(minimal).ok);
}

// Per-slot extent validation. Each case makes only slot 2 invalid; slot 0 stays readable.
function badSlot(name, mutate, code) {
  const b = blank();
  putName(b, 0, "GOOD"); setExtents(b, 0, 0, 72, 74, 84);
  putName(b, 2, "BAD"); setExtents(b, 2, 120, 192, 194, 204);
  mutate(b);
  const r = parseDisk4(b);
  const s = r.ok ? r.value.slots[2] : null;
  check(`${name}: slot invalid (${code})`, r.ok && s.state === "invalid" && s.error.code === code && /Slot 2/.test(s.error.message));
  check(`${name}: read returns error`, r.ok && errCode(readDisk4Slot(r.value, 2)) === code);
  check(`${name}: other slot unaffected`, r.ok && r.value.slots[0].state === "populated" && readDisk4Slot(r.value, 0).ok);
}
badSlot("area A wrong size", (b) => setExtents(b, 2, 120, 191, 194, 204), "extent-size");
badSlot("area A too large", (b) => setExtents(b, 2, 120, 193, 194, 204), "extent-size");
badSlot("area B wrong size", (b) => setExtents(b, 2, 120, 192, 194, 205), "extent-size");
badSlot("area A reversed", (b) => setExtents(b, 2, 192, 120, 194, 204), "extent-order");
badSlot("area B reversed", (b) => setExtents(b, 2, 120, 192, 204, 194), "extent-order");
badSlot("area A past image end", (b) => setExtents(b, 2, SECTORS - 10, SECTORS + 62, 194, 204), "extent-bounds");
badSlot("area B past image end", (b) => setExtents(b, 2, 120, 192, SECTORS - 5, SECTORS + 5), "extent-bounds");
badSlot("area B at 16-bit limit", (b) => setExtents(b, 2, 120, 192, 65525, 65535), "extent-bounds");
badSlot("area A overlaps header", (b) => setExtents(b, 2, 900, 972, 194, 204), "extent-overlap");
badSlot("area B overlaps header (second sector)", (b) => setExtents(b, 2, 120, 192, 961, 971), "extent-overlap");
badSlot("A and B overlap", (b) => setExtents(b, 2, 120, 192, 190, 200), "extent-overlap");
badSlot("blank name", (b) => b.fill(0, rec(2), rec(2) + 16), "blank-name");

// Cross-slot overlap invalidates both slots; extents touching the header edges are fine.
{
  const b = blank();
  putName(b, 0, "ONE"); setExtents(b, 0, 0, 72, 74, 84);
  putName(b, 1, "TWO"); setExtents(b, 1, 84, 156, 158, 168);
  const r = parseDisk4(b);
  check("cross-slot overlap flags both", r.ok && r.value.slots[0].state === "invalid" && r.value.slots[1].state === "invalid");
  const e = blank();
  putName(e, 0, "EDGE"); setExtents(e, 0, 887, 959, 962, 972);
  putName(e, 1, "TOP"); setExtents(e, 1, 973, 1045, 1046, 1056);
  const re = parseDisk4(e);
  check("adjacent to header is valid", re.ok && re.value.slots[0].state === "populated" && re.value.slots[1].state === "populated");
}

// A populated slot at the last image sectors is valid; one sector further is not.
{
  const b = blank();
  putName(b, 4, "LAST"); setExtents(b, 4, SECTORS - 84, SECTORS - 12, SECTORS - 11, SECTORS - 1);
  const r = parseDisk4(b);
  check("extent ending at last sector", r.ok && r.value.slots[4].state === "populated" && readDisk4Slot(r.value, 4).ok);
  setExtents(b, 4, SECTORS - 83, SECTORS - 11, SECTORS - 10, SECTORS);
  check("extent one past end", errCode(readDisk4Slot(parseDisk4(b).value, 4)) === "extent-bounds");
}

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("disk4 tests passed");
