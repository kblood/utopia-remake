// Optional original-vs-remake comparison of the 01/11/2090 monthly transition and three subsequent captured passes.
// Run after `npm run build`:
//   UTOPIA_PRODUCTION_TRACE_DIR=<dir holding rng-calls.json, rng-tape-seg2.jsonl and state_pre/post JSON> node test/production-original-compare.mjs
// (the directory itself, or a parent that has an `out/` sub-directory with those files).
//
// Evidence: one Copperline 1.0.1 run (WHDLoad 0757, scenario 0, mine (50,51), yard (48,49), staffing caps 10, A1200/68020/AGA PAL),
// captured by the player outside this repository. NOTHING from it is copied, hashed or stored here: the files are only read at run
// time, and only compared scalars/addresses are printed. The earlier run summarised in sim-port.md ("Observed original production,
// order, and movement": ore 77, other money/population) is a DIFFERENT run; the two are never mixed.
//
// What this does
//   1. Reads the RNG tape rows 21..50 (the 30 draws of the 01/11 transition; row 0 is a reconstructed October draw and is not used,
//      October rows 1..20 are not used either) and checks the rows are self-consistent (seed chain, result < range).
//   2. Reads the pre snapshot (28/10/2090, pass 560) and seeds a REAL MapScene from the RAM it actually covers: the whole 5632-byte
//      state image ($13034..$14633), all 1000 object records ($3B466..$3D3A6), `$156AA` system flags, `$144C9`. Tank list and
//      entity lists must be empty in the capture (as the fresh remake systems are) or the test stops.
//      Map and flag bytes are covered only partially (map words from row 39 col 22 to row 59 col 81, flag rows 40..60); the covered
//      cells are seeded from the capture, every other cell keeps the scenario-0 start map from Disk.2 (premise checked: inside the
//      covered area the capture equals the start map except next to the two player-built records). The mine neighbourhood, the yard
//      and its exit ring must be covered or the test stops. No map or flag data is invented for uncovered cells.
//   3. Advances the scene with ordinary `scene.update()` calls: the day timer reaches 0, the queued day is consumed by
//      `Sim.loopPass()`, `run()` -> daily -> `monthly()` (market, births/deaths, jobs, crime, production, tank yard ->
//      `UnitSystem.spawnAtYard()`). Nothing is patched afterwards and no result field is written.
//   4. The only injected thing is the random source: a test RNG adapter replaces the Sim's generator. Each draw is LABELLED (the
//      calling function of Sim, from the stack) and VALIDATED (function and range) against the next tape row. The result is then
//      COMPUTED by the isolated model of the original routine `$2DCC` (src/game/original-rng.ts) from the row's recorded caller D0,
//      the recorded CIA TOD low byte, the range the remake asked for and the model's own seed (initialised from the first row's
//      recorded seed, then chained from the model's own output). The computed seed/result are verified against the row's recorded
//      seedAfter/result; a mismatch is reported as an RNG-model divergence. The recorded D0/TOD/seed values are capture INPUTS (the
//      remake does not model caller D0 or hardware TOD); results are never copied from the capture into the Sim. After the first
//      mismatch the tape is no longer applied (draws return 0 and are only counted).
//   5. At the pass end (MapScene checkpoint boundary) compares the remake with the post snapshot (01/11/2090, pass 561), in this
//      order, reporting the FIRST divergence: RNG calls, stock/weight, jobs/population/economy, yard progress (object records),
//      tank slot/position/reservation, counters, map/flag occupancy over the covered cells, then a residual sweep of every
//      other byte of the state image. It continues without reseeding through three further captured pass tops and compares
//      alien phase/frame and meteor record bytes at each boundary.
//
// Not compared / excluded (and why)
//   - `$14590` frame countdown: the original's monthly step spanned three video frames (87 left), the remake runs the whole pass in
//     one update and shows the reloaded 90. `$14594..$1459D` date string: the remake computes the date text instead of storing it.
//   - `$144C9` is compared separately (it lives in the unit system, not in the remake's state image).
//   - Map words/flags outside the captured slices; map padding columns (x >= 100); the tank-list header record; screen, sound, messages.
//   - The four full pass snapshots in rng-tape-seg2.jsonl are compared continuously for special-sprite bytes. No state is
//     reseeded between those passes. $144A5 is the low byte of the alien animation index word at $144A4, not meteor +9.
//     Warning lights, screen, sound and message presentation are not compared.
//   - The original's cd/frame timing of each draw: the recorded TOD byte and caller D0 are replayed as inputs; call order, site and
//     range are compared against the remake. The model is exercised at 7 of the 62 original call sites only, and the seed
//     initialiser `$2DA0` is not traced (initial seed provenance unknown).
// A match here says nothing about other months, scenarios or seeds. Exit code 1 on any divergence or unusable explicitly supplied
// capture; skipped (exit 0) only when UTOPIA_PRODUCTION_TRACE_DIR is unset.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRawRngRows } from "./original-rng-capture.mjs";

const traceDirEnv = process.env.UTOPIA_PRODUCTION_TRACE_DIR;
if (!traceDirEnv) {
  console.log("production original comparison skipped: UTOPIA_PRODUCTION_TRACE_DIR is not set (local Copperline capture directory, optional)");
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
let failures = 0;
const fail = (msg) => { console.log(`FAIL ${msg}`); failures++; };
const info = (msg) => console.log(`     ${msg}`);
function fatal(msg) { console.error(`production original comparison: ${msg}`); process.exit(1); }
const hex = (v, w = 2) => `$${(v >>> 0).toString(16).toUpperCase().padStart(w, "0")}`;
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) fatal("original/utopia-whdload/Disk.1 or Disk.2 not found for explicitly requested comparison");

// ---- locate the capture files (read only) -----------------------------------------------------------------------------
let dir = path.resolve(traceDirEnv);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  fatal("UTOPIA_PRODUCTION_TRACE_DIR is not a directory");
}
const findFiles = (d) => {
  const names = fs.readdirSync(d);
  return {
    rngJson: names.find((n) => n === "rng-calls.json"),
    rngCsv: names.find((n) => n === "rng-calls.csv"),
    pre: names.find((n) => /^state_pre_nov_.*\.json$/.test(n)),
    post: names.find((n) => /^state_post_nov_.*\.json$/.test(n)),
    passLog: names.find((n) => n === "rng-tape-seg2.jsonl"),
    preMatches: names.filter((n) => /^state_pre_nov_.*\.json$/.test(n)),
    postMatches: names.filter((n) => /^state_post_nov_.*\.json$/.test(n)),
  };
};
let files = findFiles(dir);
if (!files.pre && fs.existsSync(path.join(dir, "out"))) { dir = path.join(dir, "out"); files = findFiles(dir); }
if (!files.pre || !files.post || (!files.rngJson && !files.rngCsv) || !files.passLog) fatal("capture directory must contain rng-calls.json/csv, one state_pre_nov_*.json, one state_post_nov_*.json and rng-tape-seg2.jsonl");
if (files.preMatches.length !== 1 || files.postMatches.length !== 1) fatal(`capture is ambiguous: found ${files.preMatches.length} pre snapshots and ${files.postMatches.length} post snapshots`);

// ---- RNG tape ----------------------------------------------------------------------------------------------------------
function readTapeRows() {
  if (files.rngJson) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(dir, files.rngJson), "utf8")); } catch (e) { fatal(`rng-calls.json: not readable JSON (${e.message})`); }
    if (!Array.isArray(rows)) fatal("rng-calls.json: expected an array of rows");
    return rows.map((r) => ({ n: r.n, date: r.date, reconstructed: r.reconstructed === true, ret: r.ret, d2: r.d2, result: r.result, seedBefore: r.seedBefore, seedAfter: r.seedAfter }));
  }
  const lines = fs.readFileSync(path.join(dir, files.rngCsv), "utf8").split(/\r?\n/).filter((l) => l.length > 0);
  const head = lines[0].split(",");
  const col = (name) => head.indexOf(name);
  for (const need of ["n", "date", "ret", "d2", "result", "seedBefore", "seedAfter"]) if (col(need) < 0) fatal(`rng-calls.csv: column ${need} missing`);
  return lines.slice(1).map((l) => {
    const f = l.split(",");
    return { n: Number(f[col("n")]), date: f[col("date")], reconstructed: false, ret: f[col("ret")], d2: Number(f[col("d2")]), result: Number(f[col("result")]), seedBefore: f[col("seedBefore")], seedAfter: f[col("seedAfter")] };
  });
}
const allRows = readTapeRows();
const tape = allRows.filter((r) => r.n >= 21 && r.n <= 50 && r.date === "01/11/2090" && !r.reconstructed).sort((a, b) => a.n - b.n);
if (tape.length !== 30 || tape.some((r, i) => r.n !== 21 + i)) fatal(`expected the 30 November rows 21..50, found ${tape.length}`);

// Return address of the original's call -> label and the remake function that must make the call (Sim method names, see sim.ts).
const SITES = {
  "$A7C0": { label: "market walk: trend countdown roll(4)", fn: "walkEntry" }, // $A7AE
  "$A7D2": { label: "market walk: target roll(max-min)", fn: "walkEntry" },
  "$A854": { label: "supply/demand coin per good", fn: "marketWalk" }, // $A802/$A820
  "$9BD2": { label: "births roll(difficulty)", fn: "births" }, // $9BAE
  "$9CB6": { label: "deaths fractional pool roll", fn: "deaths" }, // $9C80
  "$10BEE": { label: "crime monthly roll(20)", fn: "crimeMonthly" }, // $10BC8
  "$A3FE": { label: "miner find-roll", fn: "production" }, // $A360
};
const parseSeed = (s) => (typeof s === "string" && /^\$[0-9A-Fa-f]+$/.test(s) ? parseInt(s.slice(1), 16) : NaN);
const expected = tape.map((r, i) => {
  const site = SITES[r.ret];
  if (!site) fatal(`tape row ${r.n}: unknown call site ${r.ret}`);
  if (!Number.isInteger(r.d2) || !Number.isInteger(r.result) || r.d2 <= 0 || r.result < 0 || r.result >= r.d2) fatal(`tape row ${r.n}: result ${r.result} is outside range ${r.d2}`);
  if (i > 0 && parseSeed(r.seedBefore) !== parseSeed(tape[i - 1].seedAfter)) fatal(`tape row ${r.n}: seed chain broken (seedBefore does not equal the previous row's seedAfter)`);
  return { n: r.n, ret: r.ret, label: site.label, fn: site.fn, range: r.d2, result: r.result };
});
// walkEntry pairs: trend (range 4) must be followed by its target roll (A7D2); everything else is positional.
for (let i = 0; i < 10; i++) if (expected[i].ret !== (i % 2 === 0 ? "$A7C0" : "$A7D2") || (i % 2 === 0 && expected[i].range !== 4)) fatal("tape: the first ten rows are not five (roll(4), roll(max-min)) pairs");
// Raw capture rows (full entry registers, TOD byte, seeds) for the same 30 calls: inputs of the computed RNG model. They must agree
// with the rng-calls tape on every shared field, otherwise the capture is inconsistent.
let rawRows;
try {
  rawRows = loadRawRngRows([path.join(dir, files.passLog)]).filter((r) => r.n >= 21 && r.n <= 50).sort((a, b) => a.n - b.n);
} catch (e) { fatal(`${files.passLog}: ${e.message}`); }
if (rawRows.length !== 30 || rawRows.some((r, i) => r.n !== 21 + i)) fatal(`expected 30 raw rng rows n=21..50 in ${files.passLog}, found ${rawRows.length}`);
rawRows.forEach((raw, i) => {
  const row = tape[i];
  if (raw.retText !== row.ret || raw.range !== row.d2 || raw.result !== row.result || raw.seedBefore !== parseSeed(row.seedBefore) || raw.seedAfter !== parseSeed(row.seedAfter)) {
    fatal(`row ${raw.n}: raw tape row and rng-calls row disagree (ret/range/result/seed)`);
  }
  Object.assign(expected[i], { d0: raw.d0, tod: raw.tod, seedBefore: raw.seedBefore, seedAfter: raw.seedAfter });
});
const groupCounts = {};
for (const e of expected) groupCounts[e.fn] = (groupCounts[e.fn] ?? 0) + 1;
console.log(`RNG tape rows 21..50 loaded (30 draws, seed chain consistent): ${Object.entries(groupCounts).map(([k, v]) => `${k} x${v}`).join(", ")}`);

// ---- RAM snapshots -----------------------------------------------------------------------------------------------------
const RAM_SIZE = 0x43100;
function loadSnapshot(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch (e) { fatal(`${file}: not readable JSON (${e.message})`); }
  if (!Array.isArray(j.segs)) fatal(`${file}: unexpected snapshot shape`);
  const ram = new Uint8Array(RAM_SIZE);
  const cov = new Uint8Array(RAM_SIZE);
  for (const s of j.segs) {
    if (!Number.isInteger(s.addr) || !Number.isInteger(s.len) || typeof s.hex !== "string" || s.hex.length !== s.len * 2) fatal(`${file}: bad segment`);
    if (s.addr + s.len > RAM_SIZE) continue; // outside the addresses this comparison ever reads
    ram.set(Buffer.from(s.hex, "hex"), s.addr);
    cov.fill(1, s.addr, s.addr + s.len);
  }
  const snap = { file, frame: j.frame, ram, cov };
  snap.covered = (addr, len) => { for (let i = 0; i < len; i++) if (!cov[addr + i]) return false; return true; };
  snap.bytes = (addr, len) => { if (!snap.covered(addr, len)) fatal(`${file}: ${hex(addr, 5)}+${len} is not covered by the capture`); return ram.subarray(addr, addr + len); };
  snap.byte = (addr) => snap.bytes(addr, 1)[0];
  snap.word = (addr) => (snap.byte(addr) << 8) | snap.byte(addr + 1);
  snap.long = (addr) => ((snap.word(addr) << 16) | snap.word(addr + 2)) >>> 0;
  return snap;
}
const pre = loadSnapshot(files.pre);
const post = loadSnapshot(files.post);

function loadInlineSnapshot(row, label) {
  if (!Array.isArray(row.segs)) fatal(`${label}: expected full snapshot segments`);
  const ram = new Uint8Array(RAM_SIZE);
  const cov = new Uint8Array(RAM_SIZE);
  for (const segment of row.segs) {
    if (!Array.isArray(segment) || segment.length !== 3) fatal(`${label}: malformed segment`);
    const [addr, len, encoded] = segment;
    if (!Number.isInteger(addr) || !Number.isInteger(len) || typeof encoded !== "string" || encoded.length !== len * 2) fatal(`${label}: malformed segment at ${addr}`);
    if (addr + len > RAM_SIZE) continue;
    ram.set(Buffer.from(encoded, "hex"), addr);
    cov.fill(1, addr, addr + len);
  }
  const snap = { file: label, frame: row.frame, ram, cov };
  snap.covered = (addr, len) => { for (let i = 0; i < len; i++) if (!cov[addr + i]) return false; return true; };
  snap.bytes = (addr, len) => { if (!snap.covered(addr, len)) fatal(`${label}: ${hex(addr, 5)}+${len} is not covered by the capture`); return ram.subarray(addr, addr + len); };
  snap.byte = (addr) => snap.bytes(addr, 1)[0];
  snap.word = (addr) => (snap.byte(addr) << 8) | snap.byte(addr + 1);
  snap.long = (addr) => ((snap.word(addr) << 16) | snap.word(addr + 2)) >>> 0;
  return snap;
}
let passRows;
try {
  passRows = fs.readFileSync(path.join(dir, files.passLog), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
} catch (e) { fatal(`${files.passLog}: could not read JSONL (${e.message})`); }
const expectedFrames = [23716, 23720, 23725, 23730];
const capturedPasses = passRows.filter((row) => row.ev === "snap" && row.kind === "full_nov01" && expectedFrames.includes(row.frame));
if (capturedPasses.length !== expectedFrames.length || capturedPasses.some((row, i) => row.frame !== expectedFrames[i] || row.pc !== 0x157bc)) {
  fatal(`expected four ordered full_nov01 snapshots at ${expectedFrames.join(", ")} with PC $157BC`);
}
const passSnapshots = capturedPasses.map((row) => loadInlineSnapshot(row, `full_nov01 frame ${row.frame}`));

const STATE_BASE = 0x13034, STATE_BYTES = 0x1600;
const OBJ_BASE = 0x3b466, OBJ_BYTES = 8000;
const TANK_HDR = 0x3ab06, TANK_FIRST = 0x3ab1e, TANK_STRIDE = 0x18;
const ENTITY_FIRST = 0x39d42; // entity lists up to the tank list header; must be empty in the pre capture
const FLAG_BASE = 0x3d3a6, FLAG_ROW = 102;
const MAP_BASE = 0x3f256, MAP_ROW_WORDS = 102;
for (const [name, snap] of [["pre", pre], ["post", post]]) {
  if (!snap.covered(STATE_BASE, STATE_BYTES)) fatal(`${name} snapshot does not cover the whole state image $13034..$14633`);
  if (!snap.covered(OBJ_BASE, OBJ_BYTES)) fatal(`${name} snapshot does not cover all 1000 object records`);
  if (!snap.covered(ENTITY_FIRST, OBJ_BASE - ENTITY_FIRST)) fatal(`${name} snapshot does not cover the entity lists and tank list`);
  if (!snap.covered(0x156a8, 4) || !snap.covered(0x144c9, 1)) fatal(`${name} snapshot lacks the loop flags/system flags/pass clock`);
}

const expectedPassMeta = [
  { frame: 23716, pass: 561, sub: 8 },
  { frame: 23720, pass: 562, sub: 0 },
  { frame: 23725, pass: 563, sub: 1 },
  { frame: 23730, pass: 564, sub: 2 },
];
for (const [i, expectedMeta] of expectedPassMeta.entries()) {
  const row = passRows.find((r) => r.ev === "top" && r.frame === expectedMeta.frame);
  if (!row || row.pass !== expectedMeta.pass || row.sub !== expectedMeta.sub || row.date !== "01/11/2090") fatal(`frame ${expectedMeta.frame}: missing expected pass-top metadata`);
  const snap = passSnapshots[i];
  if (!snap.covered(STATE_BASE, STATE_BYTES)) fatal(`${snap.file}: does not cover the whole state image`);
  if (snap.word(0x144a4) !== i + 5 || snap.byte(0x144a8) !== 0x13 || snap.byte(0x144a9) !== 7 || snap.byte(0x144aa) !== 65) fatal(`${snap.file}: alien phase/type/position does not match the capture ledger`);
  if (snap.byte(0x144ad) !== [3, 2, 3, 2][i]) fatal(`${snap.file}: alien +5 frame does not match the capture ledger`);
}

// Cell coverage of the partial map/flag slices (exact bounds are printed).
const { MAP_WIDTH, MAP_HEIGHT, readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
function coverage(snap) {
  const map = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const flag = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (snap.covered(MAP_BASE + 2 * (y * MAP_ROW_WORDS + x), 2)) map[y * MAP_WIDTH + x] = 1;
      if (snap.covered(FLAG_BASE + y * FLAG_ROW + x, 1)) flag[y * MAP_WIDTH + x] = 1;
    }
  }
  return { map, flag };
}
function describeCoverage(name, plane) {
  let first = null, last = null, count = 0;
  const fullRows = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    let inRow = 0, minX = MAP_WIDTH, maxX = -1;
    for (let x = 0; x < MAP_WIDTH; x++) if (plane[y * MAP_WIDTH + x]) { inRow++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    if (inRow === 0) continue;
    count += inRow;
    if (!first) first = { x: minX, y };
    last = { x: maxX, y };
    if (inRow === MAP_WIDTH) fullRows.push(y);
  }
  if (!first) return `${name}: none`;
  return `${name}: ${count} cells, from row ${first.y} col ${first.x} to row ${last.y} col ${last.x}; full rows ${fullRows.length ? `${fullRows[0]}..${fullRows[fullRows.length - 1]}` : "none"}`;
}
const covPre = coverage(pre), covPost = coverage(post);
for (let i = 0; i < covPre.map.length; i++) if (covPre.map[i] !== covPost.map[i] || covPre.flag[i] !== covPost.flag[i]) fatal("pre and post snapshots cover different map/flag cells");
console.log(`pre/post ${describeCoverage("map words", covPre.map)}`);
console.log(`pre/post ${describeCoverage("flag bytes", covPre.flag)}`);

// ---- the captured colony: facts needed to stage and to bound the comparison ------------------------------------------
const MINE = { x: 50, y: 51 }, YARD = { x: 48, y: 49 };
const ring = (c, r) => { const out = []; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push({ x: c.x + dx, y: c.y + dy }); return out; };
const needed = [...ring(MINE, 1), ...ring(YARD, 2)]; // ore neighbourhood, yard record, exit ring and the cells around it
for (const c of needed) if (!covPre.map[c.y * MAP_WIDTH + c.x] || !covPre.flag[c.y * MAP_WIDTH + c.x]) fatal(`cell ${c.x},${c.y} (mine/yard neighbourhood) is not covered by the map/flag slices`);
const objectsPre = pre.bytes(OBJ_BASE, OBJ_BYTES);
const findRecord = (bytes, tile, x, y) => {
  for (let slot = 0; slot < 1000; slot++) { const a = slot * 8; if (((bytes[a] << 8) | bytes[a + 1]) === tile && bytes[a + 4] === x && bytes[a + 5] === y) return slot; }
  return -1;
};
const yardSlot = findRecord(objectsPre, 0x45, YARD.x, YARD.y);
const mineSlot = findRecord(objectsPre, 0x60, MINE.x, MINE.y);
if (yardSlot < 0 || mineSlot < 0) fatal("the pre snapshot has no tank yard record at (48,49) or mine record at (50,51)");
const yardProgressPre = objectsPre[yardSlot * 8 + 6];
info(`pre: ${pre.byte(0x1459f)}/${pre.byte(0x145a0) + 1} ($14590=${pre.byte(0x14590)}, $144C9=${pre.byte(0x144c9)}), yard record slot ${yardSlot} progress ${yardProgressPre}, mine record slot ${mineSlot} richness ${objectsPre[mineSlot * 8 + 6]}, ` +
  `${pre.word(0x142c2)} records, $156AA=${hex(pre.byte(0x156aa))}, tanks $1429C=${pre.word(0x1429c)}`);
if (pre.byte(0x1459f) !== 28 || pre.byte(0x145a0) !== 9) fatal("the pre snapshot is not 28/10");
if (post.byte(0x1459f) !== 1 || post.byte(0x145a0) !== 10) fatal("the post snapshot is not 01/11");
if (pre.byte(0x14590) < 1 || pre.byte(0x14590) > 8) fatal("the pre snapshot is more than 8 frames before the day change; the staging expects the day timer to run out inside one pass");
if (pre.byte(0x156a9) & 0x04) fatal("the pre snapshot is paused ($156A9 bit 2)");
// Empty entity lists / tank list in the pre snapshot (the fresh remake systems are empty; anything else would need a seeding path that does not exist).
// The first 8 bytes ($39D42..$39D49) are the temporary-effects list header: non-zero in the capture (same in pre and post), meaning not
// documented, so they are neither seeded nor compared. The tank list header ($3AB06..$3AB1D) is likewise not modelled.
const EFFECTS_HEADER_END = 0x39d4a;
for (let a = ENTITY_FIRST; a < OBJ_BASE; a++) {
  if (a < EFFECTS_HEADER_END || (a >= TANK_HDR && a < TANK_FIRST)) continue;
  if (pre.byte(a) !== 0) fatal(`the pre snapshot has a non-empty entity/tank list byte at ${hex(a, 5)}; not supported by this staging`);
}

// ---- remake staging -------------------------------------------------------------------------------------------------
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");
const { OCCUPIED } = await import("../dist/game/units.js");
const { cellFlagIndex, CELL_FLAG_BASE, resolveCellFlagPointer } = await import("../dist/game/cell-flags.js");
const { OriginalRngModel } = await import("../dist/game/original-rng.js");
if (CELL_FLAG_BASE !== FLAG_BASE) fatal("cell-flags.ts base differs from the flag base this comparison assumes");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const tiles = loadTileSet(disk1, disk2, record).tiles;
const sprites = loadSprites(disk1, disk2, record);
const strings = new GameStrings(disk1, 0);

const state = new GameState(disk2, record.block);
const world = new World(state, loadMap(disk2, record));

// Premise check for the uncovered rows: inside the covered area the capture must equal the scenario start map except next to the
// player-built records (so that the start map is a fair stand-in for the rows the capture did not read).
const baseRecords = world.objects.slice();
const playerSlots = [];
for (let slot = 0; slot < 1000; slot++) {
  let same = true;
  for (let i = 0; i < 8; i++) if (baseRecords[slot * 8 + i] !== objectsPre[slot * 8 + i]) same = false;
  if (!same) playerSlots.push(slot);
}
const nearPlayer = (x, y) => playerSlots.some((s) => Math.abs(objectsPre[s * 8 + 4] - x) <= 2 && Math.abs(objectsPre[s * 8 + 5] - y) <= 2);
const startDiffs = [];
for (let y = 0; y < MAP_HEIGHT; y++) {
  for (let x = 0; x < MAP_WIDTH; x++) {
    if (!covPre.map[y * MAP_WIDTH + x]) continue;
    const w = pre.word(MAP_BASE + 2 * (y * MAP_ROW_WORDS + x));
    if (w !== world.cells[y * MAP_WIDTH + x]) startDiffs.push({ x, y, captured: w, start: world.cells[y * MAP_WIDTH + x] });
  }
}
const unexplained = startDiffs.filter((d) => !nearPlayer(d.x, d.y));
info(`premise: ${playerSlots.length} object record(s) differ from the scenario-0 build (slots ${playerSlots.join(",")}); covered map cells differing from the start map: ${startDiffs.map((d) => `${d.x},${d.y}`).join(" ") || "none"}`);
if (unexplained.length > 0) fail(`premise: ${unexplained.length} covered map cell(s) differ from the scenario start map away from player-built records (${unexplained.slice(0, 6).map((d) => `${d.x},${d.y}`).join(" ")}); the uncovered rows cannot be assumed to equal the start map`);
const flagsPreNonZero = [];
for (let y = 0; y < MAP_HEIGHT; y++) for (let x = 0; x < MAP_WIDTH; x++) if (covPre.flag[y * MAP_WIDTH + x] && pre.byte(FLAG_BASE + y * FLAG_ROW + x) !== 0) flagsPreNonZero.push(`${x},${y}`);
info(`pre flag bytes inside the covered rows that are non-zero: ${flagsPreNonZero.join(" ") || "none"} (the remake's start flags are all zero)`);

// Seed from the capture (only what it covers).
state.restore(pre.bytes(STATE_BASE, STATE_BYTES));
world.objects.set(objectsPre);
world.objectCount = state.word(0x142c2);
for (let y = 0; y < MAP_HEIGHT; y++) {
  for (let x = 0; x < MAP_WIDTH; x++) {
    if (covPre.map[y * MAP_WIDTH + x]) world.cells[y * MAP_WIDTH + x] = pre.word(MAP_BASE + 2 * (y * MAP_ROW_WORDS + x));
    if (covPre.flag[y * MAP_WIDTH + x]) world.cellFlags[cellFlagIndex(x, y)] = pre.byte(FLAG_BASE + y * FLAG_ROW + x);
  }
}
// Construct runtime helpers only after seeding the captured state. Aliens hydrates its live sprite handle
// from $144A8 in its constructor; constructing MapScene before this restore silently leaves that handle null.
const scene = new MapScene(disk1, tiles, world, strings, { sprites });
const units = scene.objects.units;
const sim = scene.sim;
sim.sysFlags = pre.byte(0x156aa);
sim.paused = false;
sim.dayQueued = (pre.byte(0x156a8) & 0x80) !== 0;
units.clock.sub = pre.byte(0x144c9);

// ---- test RNG adapter ------------------------------------------------------------------------------------------------
// Replaces the Sim's generator (the field is `readonly` only in TypeScript). Labels each draw by the calling Sim method and checks
// it, and its range, against the next tape row; while the sequence is aligned the result is computed by the isolated model of the
// original `$2DCC` from the row's recorded D0 / TOD byte, the remake's range and the model's own seed, and verified against the
// row's recorded seed/result.
const draws = []; // { index, fn, range, result, matched }
let aligned = true;
let firstCallDivergence = null;
const rngModel = new OriginalRngModel(expected[0].seedBefore);
const modelDivergences = [];
let modelVerified = 0;
function callerFunction() {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = 12;
  const lines = new Error().stack.split("\n").slice(1);
  Error.stackTraceLimit = previous;
  for (const line of lines) {
    const m = /at (?:new )?(?:async )?([^\s(]+) \(/.exec(line);
    if (!m) continue;
    const name = m[1].replace(/^Sim\./, "");
    if (name === "roll" || name === "adapter" || name === "callerFunction" || name.endsWith(".adapter")) continue;
    return name;
  }
  return "?";
}
function adapter(range) {
  const index = draws.length;
  const fn = callerFunction();
  const want = expected[index];
  let result = 0;
  let matched = false;
  if (aligned) {
    if (!want) {
      aligned = false;
      firstCallDivergence = `draw ${index + 1}: unexpected extra draw from ${fn} with range ${range} (the tape ends after ${expected.length} draws)`;
    } else if (want.fn !== fn || want.range !== range) {
      aligned = false;
      firstCallDivergence = `draw ${index + 1} (tape row ${want.n}, ${want.ret} ${want.label}): original range ${want.range} from ${want.fn}; remake range ${range} from ${fn}`;
    } else {
      matched = true;
      if (rngModel.seed !== want.seedBefore) modelDivergences.push(`draw ${index + 1} (tape row ${want.n}): model seed ${hex(rngModel.seed, 8)} differs from the recorded seed before the call ${hex(want.seedBefore, 8)}`);
      const out = rngModel.draw(want.d0, range, want.tod);
      if (out.d0 !== want.d0 >>> 0) modelDivergences.push(`draw ${index + 1}: caller D0 not preserved`);
      if (out.seed !== want.seedAfter || out.result !== want.result) {
        modelDivergences.push(`draw ${index + 1} (tape row ${want.n}, ${want.ret}): computed seed ${hex(out.seed, 8)} result ${out.result}; recorded seed ${hex(want.seedAfter, 8)} result ${want.result}`);
        aligned = false; // the model no longer reproduces the capture: stop applying the tape (draws return 0)
      } else {
        modelVerified++;
        result = out.result;
      }
    }
  }
  draws.push({ index, fn, range, result, matched });
  return result;
}
sim.rng = adapter;

// ---- decoding the original's RAM for the post comparison ---------------------------------------------------------
const s8 = (v) => (v > 127 ? v - 256 : v);
function originalTank(snap, slot) {
  const a = TANK_FIRST + slot * TANK_STRIDE;
  const b = snap.bytes(a, TANK_STRIDE);
  if (b[0] === 0) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    type: b[0], x: b[1], y: b[2], dx: s8(b[3]), dy: s8(b[4]), dir: b[5], vx: s8(b[6]), vy: s8(b[7]), hp: b[8], control: b[9], tech: b[10],
    targetX: b[11], targetY: b[12], recent0: b[0x10], recent1: b[0x11], recent2: b[0x12], pointer: dv.getUint32(0x14),
  };
}
function remakeTank(cp, slot) {
  const t = cp.tanks[slot];
  if (!t) return null;
  return {
    type: t.type, x: t.x, y: t.y, dx: t.dx, dy: t.dy, dir: t.dir, vx: t.vx, vy: t.vy, hp: t.hp, control: t.control, tech: t.tech,
    targetX: t.targetX, targetY: t.targetY, recent0: t.recent[0], recent1: t.recent[1], recent2: t.recent[2], pointer: t.reservation ? t.reservation.pointer : -1,
  };
}
const TANK_FIELDS = ["type", "x", "y", "dx", "dy", "dir", "vx", "vy", "hp", "control", "tech", "targetX", "targetY", "recent0", "recent1", "recent2", "pointer"];
const cellText = (p) => { const r = resolveCellFlagPointer(p); return r.kind === "playable" ? ` (cell ${r.x},${r.y})` : ""; };

// ---- the comparison (called with the pass-end checkpoint of the monthly pass) ------------------------------------------
const groups = []; // { name, compared, diffs: [] } in report order
function group(name) { const g = { name, compared: 0, diffs: [] }; groups.push(g); return g; }
const cmp = (g, field, orig, mine, fmt = (v) => String(v)) => { g.compared++; if (orig !== mine) g.diffs.push(`${field}: original ${fmt(orig)} remake ${fmt(mine)}`); };
const comparedAddresses = new Set(); // state-image bytes already compared by a named group (the residual sweep skips them)
const cmpBytes = (g, field, addr, width, { signed = false } = {}) => {
  for (let i = 0; i < width; i++) comparedAddresses.add(addr + i);
  const orig = width === 1 ? post.byte(addr) : width === 2 ? post.word(addr) : post.long(addr);
  const mine = width === 1 ? state.byte(addr) : width === 2 ? state.word(addr) : state.long(addr);
  const f = signed ? (v) => (width === 4 ? v | 0 : width === 2 ? (v << 16) >> 16 : s8(v)) : (v) => String(v);
  cmp(g, `${field} (${hex(addr, 5)})`, orig, mine, (v) => f(v));
};

const NAMES = [ // address ranges of the state image, used only to label residual divergences
  [0x13034, 0x13134, "scenario block start"], [0x13136, 0x13149, "colonist pools"], [0x1314a, 0x1314d, "population"], [0x13152, 0x13169, "goods stock/weight"],
  [0x131e2, 0x13445, "object type table"], [0x135b6, 0x135c1, "money/spend/grant"], [0x14254, 0x142a5, "unit counters"], [0x142ca, 0x142d1, "expenditure/crime area"],
  [0x142e2, 0x1432d, "monthly statistics"], [0x1432e, 0x14335, "births/deaths"], [0x14336, 0x143b9, "flow statistics"], [0x143ba, 0x143c1, "production counters"],
  [0x143c6, 0x14433, "job pools"], [0x14436, 0x14471, "production counters"], [0x14472, 0x14499, "inventions/intel"], [0x144a0, 0x144bf, "status bytes"],
  [0x144ec, 0x144ef, "morale"], [0x14500, 0x14523, "staffing caps"],
];
const nameOf = (a) => (NAMES.find(([lo, hi]) => a >= lo && a <= hi) ?? [0, 0, "state image"])[2];

function compare(cp) {
  const gCalls = group("RNG calls (order, site, range)");
  cmp(gCalls, "draws consumed", expected.length, draws.length);
  if (firstCallDivergence) gCalls.diffs.unshift(firstCallDivergence);
  gCalls.compared += draws.length;

  // Computed transitions of the original-routine model (`$2DCC`) against the recorded seed/result of each matched call.
  const gModel = group("original RNG routine model: computed seed/result vs recorded (inputs: recorded D0, TOD byte, range, seed chain)");
  cmp(gModel, "calls verified", expected.length, modelVerified);
  gModel.diffs.push(...modelDivergences);
  gModel.compared += draws.length;

  const gStock = group("stock and weight");
  for (let i = 0; i < 6; i++) cmpBytes(gStock, `goods stock ${i}`, 0x13152 + 4 * i, 4);
  cmpBytes(gStock, "stored weight", 0x13166, 4);
  cmpBytes(gStock, "capacity", 0x14432, 4);
  for (const [name, a] of [["ore added $143AE", 0x143ae], ["ore added $1435E", 0x1435e], ["good-2 production $14436", 0x14436], ["good-3 production $143A6", 0x143a6], ["good-1 used $1437A", 0x1437a], ["good-1 used total $143A2", 0x143a2], ["$1434A", 0x1434a]]) cmpBytes(gStock, name, a, 4);

  const gEco = group("jobs, population and economy");
  for (const [name, a] of [["population", 0x1314a], ["free colonists", 0x13136], ["employed", 0x1313a], ["medics", 0x1313e], ["scientists", 0x13142], ["security", 0x13146],
    ["births", 0x1432e], ["deaths", 0x14332], ["farm workers A", 0x143be], ["farm workers B", 0x143c2]]) cmpBytes(gEco, name, a, 4);
  for (let i = 0; i < 9; i++) {
    cmpBytes(gEco, `job pool ${i} required`, 0x143c6 + 4 * i, 4);
    cmpBytes(gEco, `job pool ${i} assigned`, 0x143ea + 4 * i, 4);
    cmpBytes(gEco, `job pool ${i} shortage`, 0x1440e + 4 * i, 4, { signed: true });
  }
  for (const [name, a] of [["money", 0x135ba], ["morale", 0x144ec], ["crime", 0x142ce]]) cmpBytes(gEco, name, a, 4, { signed: true });
  for (const [name, a] of [["spent last month", 0x135b6], ["current expenditure", 0x142ca], ["grant", 0x135be], ["quality of life", 0x142c6], ["tax", 0x144f4], ["pollution", 0x144f0], ["research accumulator", 0x142da]]) cmpBytes(gEco, name, a, 4);
  for (const [name, a] of [["day", 0x1459f], ["month", 0x145a0], ["weekday", 0x145a1], ["pending period bits", 0x144c1], ["security percent", 0x144c6]]) cmpBytes(gEco, name, a, 1);

  const gYard = group("yard progress and object records");
  cmp(gYard, `yard record ${yardSlot} +6 (progress)`, post.bytes(OBJ_BASE + yardSlot * 8 + 6, 1)[0], world.objects[yardSlot * 8 + 6]);
  const objectsPost = post.bytes(OBJ_BASE, OBJ_BYTES);
  for (let slot = 0; slot < 1000; slot++) {
    for (let i = 0; i < 8; i++) cmp(gYard, `object record ${slot} byte ${i}`, objectsPost[slot * 8 + i], world.objects[slot * 8 + i], (v) => hex(v));
  }

  const gTank = group("tank slots (position, reservation)");
  for (let slot = 0; slot < 99; slot++) {
    const o = originalTank(post, slot);
    const r = remakeTank(cp, slot);
    if (o === null || r === null) { cmp(gTank, `tank[${slot}] occupied`, o !== null, r !== null); continue; }
    for (const f of TANK_FIELDS) {
      if (f === "pointer") cmp(gTank, `tank[${slot}].reservation pointer`, o.pointer, r.pointer, (v) => `${hex(v, 5)}${cellText(v)}`);
      else cmp(gTank, `tank[${slot}].${f}`, o[f], r[f], f === "control" ? (v) => hex(v) : undefined);
    }
  }

  const gCounters = group("counters");
  cmpBytes(gCounters, "tanks $1429C", 0x1429c, 2);
  cmpBytes(gCounters, "type-9 count $14254", 0x14254, 4);
  cmpBytes(gCounters, "units made $143B6", 0x143b6, 4);
  cmp(gCounters, "$144C9 pass clock", post.byte(0x144c9), cp.passClock.sub);

  const gMap = group("map and flag occupancy (covered cells only)");
  let cells = 0;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const i = y * MAP_WIDTH + x;
      if (covPost.map[i]) {
        cells++;
        const w = post.word(MAP_BASE + 2 * (y * MAP_ROW_WORDS + x));
        cmp(gMap, `map ${x},${y} occupancy bit14`, (w & OCCUPIED) !== 0, (world.cells[i] & OCCUPIED) !== 0);
        cmp(gMap, `map ${x},${y} word without bit14`, w & ~OCCUPIED & 0xffff, world.cells[i] & ~OCCUPIED & 0xffff, (v) => hex(v, 4));
      }
      if (covPost.flag[i]) cmp(gMap, `flag byte ${x},${y}`, post.byte(FLAG_BASE + y * FLAG_ROW + x), world.cellFlags[cellFlagIndex(x, y)], (v) => hex(v));
    }
  }

  // Residual sweep: every state-image byte not compared above and not excluded.
  const gRest = group("residual state image sweep (all other bytes)");
  const excluded = (a) => a === 0x14590 || (a >= 0x14594 && a <= 0x1459d) || a === 0x144c9;
  for (let a = STATE_BASE; a < STATE_BASE + STATE_BYTES; a++) {
    if (excluded(a) || comparedAddresses.has(a)) continue;
    const o = post.byte(a), m = state.byte(a);
    gRest.compared++;
    if (o !== m) gRest.diffs.push(`${hex(a, 5)} (${nameOf(a)}): original ${hex(o)} remake ${hex(m)}`);
  }
  info(`compared map cells: ${cells}`);
}

function compareSpecialPass(cp, snap, index) {
  const g = group(`special sprite state at original frame ${snap.frame} (pass ${expectedPassMeta[index].pass})`);
  cmp(g, "$144C9 pass clock", expectedPassMeta[index].sub, cp.passClock.sub);
  cmp(g, "$144A4 alien animation index word", snap.word(0x144a4), state.word(0x144a4), (v) => hex(v, 4));
  cmp(g, "$144A5 alias (low byte of $144A4)", snap.byte(0x144a5), state.byte(0x144a5), (v) => hex(v));
  for (const [name, addr] of [["alien type", 0x144a8], ["alien x", 0x144a9], ["alien y", 0x144aa], ["alien frame +5", 0x144ad]]) {
    cmp(g, `${name} (${hex(addr, 5)})`, snap.byte(addr), state.byte(addr), (v) => hex(v));
  }
  // The meteor occupies only $1449C..$144A3. $144A4/$144A5 are the adjacent alien phase word.
  for (let a = 0x1449c; a <= 0x144a3; a++) cmp(g, `meteor record byte ${hex(a, 5)}`, snap.byte(a), state.byte(a), (v) => hex(v));
  const expectedAlien = cp.aliens.alien;
  cmp(g, "hydrated alien present", true, expectedAlien !== null);
  if (expectedAlien) {
    cmp(g, "hydrated alien x", snap.byte(0x144a9), expectedAlien.x);
    cmp(g, "hydrated alien y", snap.byte(0x144aa), expectedAlien.y);
    cmp(g, "hydrated alien frame", snap.byte(0x144ad), expectedAlien.frame);
  }
}

// ---- run -------------------------------------------------------------------------------------------------------------
const idle = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
let compared = false;
let checkpoints = 0;
let passTraceIndex = 0;
scene.enableCheckpoints({
  capacity: 0,
  includeObjectRecords: false,
  includeCells: false,
  onCheckpoint: (cp) => {
    checkpoints++;
    if (!compared && cp.time.day === 1 && cp.time.month === 10) { compared = true; compare(cp); }
    if (!compared || passTraceIndex >= passSnapshots.length) return;
    if (cp.passClock.sub === expectedPassMeta[passTraceIndex].sub) {
      compareSpecialPass(cp, passSnapshots[passTraceIndex], passTraceIndex);
      passTraceIndex++;
    }
  },
});
for (let u = 0; u < 64 && passTraceIndex < passSnapshots.length; u++) scene.update(idle);
if (!compared) fatal(`the remake did not reach 01/11 within 64 updates (day ${state.byte(0x1459f)}, month ${state.byte(0x145a0)}, ${checkpoints} pass checkpoint(s))`);
if (passTraceIndex !== passSnapshots.length) fatal(`the remake reached only ${passTraceIndex}/${passSnapshots.length} captured pass-clock checkpoints`);
if (draws.length === 0) fatal("the test RNG adapter was never called: the Sim does not use the injected generator");

// ---- report ----------------------------------------------------------------------------------------------------------
console.log(`remake consumed ${draws.length} draw(s) at the monthly pass; labelled sequence: ${draws.map((d) => `${d.fn}(${d.range})`).join(" ")}`);
let first = null;
for (const g of groups) {
  const ok = g.diffs.length === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${g.name}: ${g.compared} fields; ${g.diffs.length} divergence(s)`);
  for (const d of g.diffs.slice(0, 40)) console.log(`       ${d}`);
  if (g.diffs.length > 40) console.log(`       ... ${g.diffs.length - 40} more`);
  if (!ok) { failures++; if (!first) first = `${g.name}: ${g.diffs[0]}`; }
}
if (first) console.log(`first divergence: ${first}`);
console.log(failures === 0
  ? "production original comparison: no divergence in the compared fields (one month, one scenario; map/flag compared only over the captured slices)"
  : `production original comparison: ${failures} group(s) diverged or failed`);
process.exit(failures === 0 ? 0 : 1);
