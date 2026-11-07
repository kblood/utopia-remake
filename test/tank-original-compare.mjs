// Optional original-vs-remake comparison of the own-tank state (one observed Copperline run).
// Run after `npm run build`:   UTOPIA_TANK_TRACE_DIR=<dir with cap_*.json> node test/tank-original-compare.mjs
//
// What it does: reads the player's own external Copperline capture files (never copied into, or derived into, this
// repository: nothing is stored, hashed or printed beyond the compared scalars), stages a live remake `MapScene`
// on the scenario-0 start map, and compares remake state with the original's RAM at aligned checkpoints.
//
//   baseline  cap_NNN_order_first_pass_after_exit.json   (after the exit button of the tank window, pass 0)
//   movement  cap_NNN_move_pPPP.json for PPP = 006, 014, 022, 030, 038
//
// Capture format (observed): {seq, label, frame, segs: [{addr, len, hex}], ...}; segments are disjoint RAM slices with
// big-endian values. Read addresses: tank list `$3AB06` (header record, then 24-byte slots from `$3AB1E`), flag bytes
// `$3D3A6` (102-byte rows), map words `$3F256` (102 words per row), `$144C9` sub-tick, `$156A9` loop flags, marker pins
// `$14540` (10 bytes each).
//
// Pass alignment is derived from the captures, not assumed: the move labels are 0-based passes after the baseline
// capture (baseline = p000). The offset used for a label is the pass count proven by the consecutive capture chain
// (each step: one more `$144C9` modulo 9 and a frame delta of 3..6, i.e. exactly one pass of 4-5 VBL); when the chain is
// incomplete the label is used only if it agrees with the `$144C9` difference modulo 9 and a 4..5.5 VBL/pass average.
// The baseline `$144C9` value is the one input copied from the capture into the staging (the remake cannot know the
// original's phase at tank creation); everything else is produced by the remake's own paths (yard exit rule, pin, order,
// MapScene passes). `$14590` and the date are NOT compared: the original ran 5-VBL passes, the remake 4 (documented).
//
// Not compared: tank bytes +D, +E/+F, +13 (not modelled by the remake), counters ($1429C, $14254, $143B6), RNG, anything
// outside the captured RAM slices, sprites/screen. Exit code 1 on any divergence or unusable capture directory;
// without UTOPIA_TANK_TRACE_DIR the comparison is skipped (exit 0).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const traceDirEnv = process.env.UTOPIA_TANK_TRACE_DIR;
if (!traceDirEnv) {
  console.log("tank original comparison skipped: UTOPIA_TANK_TRACE_DIR is not set (local Copperline capture directory, optional)");
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("tank original comparison skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

let failures = 0;
const fail = (msg) => { console.log(`FAIL ${msg}`); failures++; };
const info = (msg) => console.log(`     ${msg}`);
function fatal(msg) { console.error(`tank original comparison: ${msg}`); process.exit(1); }

// ---- capture directory ---------------------------------------------------------------------------------------------
let dir = path.resolve(traceDirEnv);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fatal(`UTOPIA_TANK_TRACE_DIR is not a directory`);
if (!fs.readdirSync(dir).some((f) => /^cap_\d+_.*\.json$/.test(f)) && fs.existsSync(path.join(dir, "ledger"))) dir = path.join(dir, "ledger");

const bySeq = new Map(); // seq -> { file, label, frame, sub, light, cap }
let baseFile = null;
const moveFiles = new Map(); // label number -> file
for (const file of fs.readdirSync(dir).sort()) {
  const m = /^cap_(\d+)_(.*)\.json$/.exec(file);
  if (!m) continue;
  const move = /^move_p(\d+)$/.exec(m[2]);
  if (m[2] === "order_first_pass_after_exit") baseFile = file;
  if (move) moveFiles.set(Number(move[1]), file);
}
if (!baseFile) fatal(`no cap_NNN_order_first_pass_after_exit.json in the capture directory`);

function loadCapture(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch (e) { fatal(`${file}: not readable JSON (${e.message})`); }
  if (!Number.isInteger(j.seq) || !Number.isInteger(j.frame) || !Array.isArray(j.segs)) fatal(`${file}: unexpected capture shape`);
  const segs = j.segs.map((s) => {
    if (!Number.isInteger(s.addr) || !Number.isInteger(s.len) || typeof s.hex !== "string" || s.hex.length !== s.len * 2) fatal(`${file}: bad segment`);
    return { addr: s.addr, len: s.len, bytes: Buffer.from(s.hex, "hex") };
  });
  const cap = { file, seq: j.seq, label: j.label, frame: j.frame, segs };
  cap.read = (addr, len) => { // bytes if wholly inside one segment, else null
    for (const s of segs) if (addr >= s.addr && addr + len <= s.addr + s.len) return s.bytes.subarray(addr - s.addr, addr - s.addr + len);
    return null;
  };
  const sub = cap.read(0x144c9, 1);
  cap.sub = sub ? sub[0] : null;
  return cap;
}
const base = loadCapture(baseFile);
if (base.sub === null) fatal(`${baseFile}: no $144C9 segment`);
const allCaps = new Map();
for (const f of fs.readdirSync(dir)) if (/^cap_\d+_.*\.json$/.test(f)) { const c = loadCapture(f); allCaps.set(c.seq, c); }

// ---- pass offsets derived from the captures -------------------------------------------------------------------------
const WANTED = [6, 14, 22, 30, 38];
const targets = []; // { label, cap, passes, how }
console.log(`capture directory loaded: baseline seq ${base.seq} frame ${base.frame} $144C9=${base.sub}`);
for (const label of WANTED) {
  const file = moveFiles.get(label);
  if (!file) fatal(`capture for move p${String(label).padStart(3, "0")} is missing`);
  const cap = loadCapture(file);
  if (cap.sub === null) fatal(`${file}: no $144C9 segment`);
  const subDelta = (cap.sub - base.sub + 9) % 9;
  const framesTotal = cap.frame - base.frame;
  let chain = true;
  let prev = base;
  for (let seq = base.seq + 1; seq <= cap.seq; seq++) {
    const c = allCaps.get(seq);
    if (!c || c.sub === null) { chain = false; break; }
    const stepOk = c.sub === (prev.sub + 1) % 9 && c.frame - prev.frame >= 3 && c.frame - prev.frame <= 6;
    if (!stepOk) { chain = false; break; }
    prev = c;
  }
  let passes;
  let how;
  if (chain && cap.seq > base.seq) { passes = cap.seq - base.seq; how = `chain of ${passes} consecutive captures, each +1 on $144C9 mod 9 and 3..6 frames`; }
  else {
    passes = label;
    const perPass = framesTotal / passes;
    if (passes % 9 !== subDelta || perPass < 4 || perPass > 5.5) fatal(`p${label}: label ${label} is inconsistent with the counters ($144C9 delta mod 9 ${subDelta}, ${perPass.toFixed(2)} frames/pass)`);
    how = `label-derived (capture chain incomplete); agrees with $144C9 delta mod 9 = ${subDelta} and ${perPass.toFixed(2)} frames/pass`;
  }
  if (passes !== label) fail(`p${label}: derived pass offset ${passes} differs from its 0-based label`);
  if (passes % 9 !== subDelta) fail(`p${label}: $144C9 ${base.sub} -> ${cap.sub} is not ${passes} passes modulo 9`);
  targets.push({ label, cap, passes, how });
  info(`p${String(label).padStart(3, "0")} (seq ${cap.seq}, frame ${cap.frame}, $144C9=${cap.sub}) = ${passes} passes after the baseline: ${how}`);
}

// ---- remake staging --------------------------------------------------------------------------------------------------
const { readScenarioRecords, loadMap, loadTileSet, MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");
const { UnitSystem, BLOCKED, OCCUPIED } = await import("../dist/game/units.js");
const { cellFlagIndex, CELL_FLAG_BASE, resolveCellFlagPointer } = await import("../dist/game/cell-flags.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const tiles = loadTileSet(disk1, disk2, record).tiles;
const sprites = loadSprites(disk1, disk2, record);
const strings = new GameStrings(disk1, 0);

const state = new GameState(disk2, record.block);
const world = new World(state, loadMap(disk2, record));
const scene = new MapScene(disk1, tiles, world, strings, { sprites });
const s = scene.world.state;
const units = scene.objects.units;
// The observed run: tank yard completed at (48,49) (tile $45; the completion writes BLOCKED | $0400 | tile over the
// old cell), exit 0 (0,-1) free, pin 1 on (52,49), order through the tank window. No mine is staged ((50,51) in that run).
const YARD = { x: 48, y: 49 };
const PIN = { n: 1, x: 52, y: 49 };
const STAGED_ONLY_IN_ORIGINAL = [{ x: 50, y: 51, why: "the observed run also placed a mine here; not staged" }];
world.objects.set([0, 0x45, 0, 0xff, YARD.x, YARD.y, 0, 0], world.objectCount * 8);
world.objectCount++;
world.cells[YARD.y * MAP_WIDTH + YARD.x] = (world.cells[YARD.y * MAP_WIDTH + YARD.x] & 0xe800) | BLOCKED | 0x0400 | 0x45;
s.setByte(A.frameCountdown, 200); // no day change inside the staged passes (the countdown is not compared)
s.setByte(A.pending, 0);
const unit = units.spawnAtYard(YARD.x, YARD.y, false); // the remake's own exit rule picks the cell
if (!unit) fatal("remake staging: the yard could not spawn a tank");
scene.objects.toggleMarker(PIN.n, PIN.x, PIN.y);
units.order(unit, PIN.x, PIN.y);
units.clock.sub = base.sub; // the one value taken from the capture (see header)

// ---- decoding original RAM -------------------------------------------------------------------------------------------
const MAP_BASE = 0x3f256;
const MAP_ROW_WORDS = 102;
const TANK_FIRST = 0x3ab1e;
const TANK_STRIDE = 0x18;
const s8 = (v) => (v > 127 ? v - 256 : v);
const hex = (v, w = 2) => `$${v.toString(16).toUpperCase().padStart(w, "0")}`;

function originalTank(cap, slot) {
  const b = cap.read(TANK_FIRST + slot * TANK_STRIDE, TANK_STRIDE);
  if (!b) return undefined; // slot not in the captured slices
  if (b[0] === 0) return null; // free slot
  return {
    type: b[0], x: b[1], y: b[2], dx: s8(b[3]), dy: s8(b[4]), dir: b[5], vx: s8(b[6]), vy: s8(b[7]), hp: b[8], control: b[9], tech: b[10],
    targetX: b[11], targetY: b[12], recent0: b[0x10], recent1: b[0x11], recent2: b[0x12], pointer: b.readUInt32BE(0x14),
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

function compare(label, cap, cp) {
  let compared = 0;
  const diffs = [];
  const add = (field, orig, mine, fmt = (v) => String(v)) => { compared++; if (orig !== mine) diffs.push(`${field}: original ${fmt(orig)} remake ${fmt(mine)}`); };

  // tanks: every captured slot
  let slotsSeen = 0;
  for (let slot = 0; slot < 99; slot++) {
    const o = originalTank(cap, slot);
    if (o === undefined) continue;
    slotsSeen++;
    const r = remakeTank(cp, slot);
    if (o === null || r === null) {
      add(`tank[${slot}] occupied`, o !== null, r !== null);
      continue;
    }
    for (const f of TANK_FIELDS) {
      if (f === "pointer") add(`tank[${slot}].reservation pointer`, o.pointer, r.pointer, (v) => `${hex(v, 5)}${cellText(v)}`);
      else add(`tank[${slot}].${f}`, o[f], r[f], f === "control" ? (v) => hex(v) : undefined);
    }
  }
  // $144C9 and the loop flags (bit 7 move tick, bit 6 enemy tick of $156A9)
  add("$144C9", cap.sub, cp.passClock.sub);
  const loop = cap.read(0x156a8, 2);
  if (loop) {
    add("$156A9 bit7 (move tick)", (loop[1] >> 7) & 1, cp.passClock.moveTick ? 1 : 0);
    add("$156A9 bit6 (enemy tick)", (loop[1] >> 6) & 1, cp.passClock.enemyTick ? 1 : 0);
  }
  // marker pins 1 and 2 ($14540, 10 bytes each; y = $FF unplaced)
  for (let n = 1; n <= 2; n++) {
    const p = cap.read(0x14540 + (n - 1) * 10, 3);
    if (!p) continue;
    const o = p[2] === 0xff ? "unplaced" : `${p[1]},${p[2]}`;
    const c = scene.objects.markerCell(n);
    add(`marker pin ${n}`, o, c ? `${c.x},${c.y}` : "unplaced");
  }
  // map occupancy (bit 14) and flag bytes over the captured slices; terrain words (bit 14 masked) off the staged-only cells
  let cells = 0;
  const excluded = new Set(STAGED_ONLY_IN_ORIGINAL.map((c) => `${c.x},${c.y}`));
  for (const seg of cap.segs) {
    if (seg.addr >= MAP_BASE && seg.addr < MAP_BASE + 2 * MAP_ROW_WORDS * MAP_HEIGHT && seg.addr % 2 === 0) {
      for (let i = 0; i + 2 <= seg.len; i += 2) {
        const w = (seg.addr - MAP_BASE) / 2 + i / 2;
        const x = w % MAP_ROW_WORDS, y = Math.floor(w / MAP_ROW_WORDS);
        if (x >= MAP_WIDTH || y >= MAP_HEIGHT) continue;
        const o = seg.bytes.readUInt16BE(i), r = world.cells[y * MAP_WIDTH + x];
        cells++;
        add(`map ${x},${y} occupancy bit14`, (o & OCCUPIED) !== 0, (r & OCCUPIED) !== 0);
        if (!excluded.has(`${x},${y}`)) add(`map ${x},${y} word without bit14`, o & ~OCCUPIED & 0xffff, r & ~OCCUPIED & 0xffff, (v) => hex(v, 4));
      }
    } else if (seg.addr >= CELL_FLAG_BASE && seg.addr < CELL_FLAG_BASE + 102 * MAP_HEIGHT) {
      for (let i = 0; i < seg.len; i++) {
        const idx = seg.addr - CELL_FLAG_BASE + i;
        const x = idx % 102, y = Math.floor(idx / 102);
        if (x >= MAP_WIDTH) continue;
        add(`flag byte ${x},${y}`, seg.bytes[i], world.cellFlags[cellFlagIndex(x, y)], (v) => hex(v));
      }
    }
  }
  const ok = diffs.length === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${compared} fields (${slotsSeen} tank slots, ${cells} map cells, flag bytes, $144C9, $156A9 tick bits, pins 1-2); ${diffs.length} divergence(s)`);
  for (const d of diffs) console.log(`       ${d}`);
  if (!ok) failures++;
}

// ---- run ------------------------------------------------------------------------------------------------------------------
const idle = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
let passes = 0;
const pending = new Map(targets.map((t) => [t.passes, t]));
let reached = 0;
scene.enableCheckpoints({
  capacity: 0,
  includeObjectRecords: false,
  includeCells: false,
  onCheckpoint: (cp) => {
    passes++;
    const t = pending.get(passes);
    if (t) {
      reached++;
      compare(`p${String(t.label).padStart(3, "0")} (${t.cap.file}, ${t.passes} passes)`, t.cap, cp); // inside the callback: the map and flag arrays are read at the checkpoint, not later
    }
  },
});
compare(`baseline (${base.file}, pass 0)`, base, scene.captureCheckpoint({ includeObjectRecords: false, includeCells: false }));
const last = Math.max(...targets.map((t) => t.passes));
for (let u = 0; u < (last + 1) * 4 + 8 && passes < last; u++) scene.update(idle);
if (passes < last) fail(`the remake completed only ${passes} of ${last} passes`);
if (reached !== targets.length) fail(`only ${reached} of ${targets.length} movement checkpoints were reached`);

console.log(failures === 0 ? "tank original comparison: no divergence at the compared checkpoints" : `tank original comparison: ${failures} checkpoint(s) diverged or failed`);
process.exit(failures === 0 ? 0 : 1);
