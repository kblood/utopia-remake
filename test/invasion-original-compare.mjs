// Optional original-vs-remake comparison of ONE bounded ground invasion.
// Run after `npm run build`:
//   UTOPIA_INVASION_CAPTURE_DIR=<capture directory, schema below> node test/invasion-original-compare.mjs
//
// STATUS: one RAM-staged Copperline capture has replayed through six checkpoints with zero differences in the compared
// groups. The baseline has an inconsistent object count relative to its non-empty records, so this is not ordinary-play parity.
// With UTOPIA_INVASION_CAPTURE_DIR unset it prints "skipped" and exits 0. An explicitly empty value is a configuration error;
// a missing directory is a capture-directory error; malformed capture content and unsupported runtime states have distinct errors.
// Every explicitly requested comparison fails with exit code 1 on error; nothing is ever skipped silently.
// Also needs the player's original/utopia-whdload/Disk.1 and Disk.2 (tables, tiles, sprites, scenario). NOTHING from a capture is
// copied, hashed or stored by this repository: files are read at run time and only compared scalars/addresses are printed.
//
// Capture directory (all names plain file names, one Copperline/WinUAE run, written by the player outside this repository):
//   manifest.json   { "schema": "utopia-invasion-capture/1", "scenario": <0-based scenario index>,
//                     "machine": { "emulator", "version", "cpu", "chipset", "video",
//                                  "chipRamKiB": integer, "fastRamKiB": integer },
//                     "provenance": { "setup": "ordinary-play" | "ram-staged",       // REQUIRED, validated, self-declared
//                                     "stagingWrites": [ { "addr", "width": 1|2|4, "before", "after", "reason" }, ... ],
//                                     "noWritesAfterBaseline": true },               // [] for ordinary play, >= 1 write if staged
//                     "checkpoints": [ { "label", "file", "pass" } x 7 ],   // labels in EXACTLY this order:
//                        baseline, queued, spawned, moving, demolished, gun-kill, after-kill
//                     "passTops": [ { "pass", "frame" }, ... ] }           // contiguous, see below
//   <checkpoint>.json  { "label", "pass", "frame", "spawner": { "groupIndex", "cursor" },
//                        "segs": [ { "addr": int, "len": int, "hex": "<2*len hex digits>" }, ... ] }
//   tape-rng.jsonl      one row per call of the original generator ($2DCA/$2DCC):
//                        { "n", "pass", "frame", "site", "ret": "$ADDR", "range", "result", "seedBefore": "$H", "seedAfter": "$H" }
//   tape-tod.jsonl      one row per CIA TOD low-byte read ($BFE801, enemy attack scan):
//                        { "n", "pass", "frame", "site": "enemy-attack-tod-gate", "ret": "$ADDR", "value": 0..255 }
//   tape-raster.jsonl   one row per beam-parity read ($2E00 from the wave launch):
//                        { "n", "pass", "frame", "site": "wave-entry-jitter-raster", "ret": "$ADDR", "value": 0|1 }
// `ret` is bound to the EXACT address of the site label (test/invasion-capture-contract.mjs; derived from the static caller audit
// notes/formats/original-rng-callers.md and checked byte for byte against the local Disk.1): the pushed return address of the
// `jsr` ($B05C, $11768, $1178C, $117FC, $11834, $11A7A, $12778; raster $11848) or, for the TOD read, the address after the
// `move.b $BFE801,d1` at $12694 ($1269A). A different address is a malformed-capture error even if it is used consistently.
//
// Timing. The original's pass length is 4 or 5 video frames and machine/pointer dependent, so the remake's four-VBL default is NOT
// assumed. `passTops` lists EVERY pass top ($157BC reached, one entry per original main-loop pass) from the baseline's pass to the
// after-kill pass: consecutive `pass` numbers (+1), strictly increasing `frame` (VBL count), each pass 1..16 frames long. The replay
// runs the pass that starts at top t with exactly (frame[t+1] - frame[t]) video updates (`MapScene.update`), so the day countdown
// `$14590` and the `$2D` gun latch see the original's VBL count per pass. The pass work happens on the last update of that interval.
// The only scheduler call is `MainLoop.restoreAt` to set the phase inside the pass interval (it writes no game state; the scene is
// built with vblPerPass = the longest recorded pass). A remake checkpoint (pass end, runtime-checkpoints.md section 2) corresponds to
// the original's NEXT pass top. Tape rows carry the number of the pass top that precedes them ("pass"); every draw is validated to
// occur in that very pass. This does not compare the original PRNG algorithm or exact per-call VBL offsets: RNG results are
// injected, and this capture compares state at completed pass boundaries only.
//
// Checkpoint meanings (the original-side semantics are VALIDATED from the capture's own RAM, not trusted):
//   baseline   pass top before the wave is queued: no enemy, no queued wave entry, no own tanks/ships, empty effect list
//   queued     first pass top at which some spawn group holds a queued entry; still no enemy
//   spawned    first pass top with exactly one enemy ($142A2 = 1, one occupied ground slot, none in the air list)
//   moving     the enemy has claimed a playable reservation cell (flag bit 0 is set at its raw +$16 pointer)
//   demolished first pass top with fewer object records ($142C2) than at `moving` (the enemy bombed a building)
//   gun-kill   $142A2 = 0 and the 32-bit kill counter $14298 = baseline + 1 (Gun A kill)
//   after-kill exactly one pass top after gun-kill, kill counter unchanged
//
// Required RAM coverage of EVERY snapshot (capture completeness; this does NOT imply every listed byte is compared):
//   $13034..$14633 state image; $156A8..$156B3 system flags/effect count; $39D42..$3B466 entity lists (effects, enemy air, enemy
//   ground, own ships, own tanks); $3B466..$3D3A6 object records; $3D3A6..$3F188 cell flag bytes (75 x 102); $3F256..$42E1A map words
//   (75 x 102 words). Plus the spawner scalars: groupIndex ($156B2, byte) and cursor ($12A94, word), whose memory widths are statically
//   verified from Disk.1 at $11912 and $11898/$1190C and cross-checked against each snapshot's RAM.
//
// Provenance: the manifest must say whether the baseline was reached by ordinary play or by RAM staging and, if staged, list every
// pre-baseline write (address, width, before, after, reason) and declare that nothing was written after the baseline pass top.
// The comparator validates shape and internal consistency only; it cannot prove the declaration true.
//
// Replay and what is compared: see notes/formats/runtime-checkpoints.md section 7. One MapScene is seeded from the baseline and then
// runs continuously: no reseeding, no combat-method overrides, no patched state. The generator, TOD and raster inputs come from the
// tapes (`SimOptions.rng` / `.hardware`) and every draw is validated for site (the remake function making the call), range and order.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError, RNG_SITES, TOD_SITES, RASTER_SITES, checkReturn, checkSiteTable, describeProvenance, resolveSiteName, validateProvenance, verifySiteBindings } from "./invasion-capture-contract.mjs";

const dirEnv = process.env.UTOPIA_INVASION_CAPTURE_DIR;
if (dirEnv === undefined) {
  console.log("invasion original comparison skipped: UTOPIA_INVASION_CAPTURE_DIR is not set (external original capture directory is optional)");
  process.exit(0);
}

// ---- errors ------------------------------------------------------------------------------------------------------------
function die(kind, code, msg) {
  console.error(`invasion original comparison: ${kind} [${code}] ${msg}`);
  process.exit(1);
}
const malformed = (code, msg) => die("malformed-capture", code, msg);
// The contract module throws ContractError; map it to the same exit-1 error report as every other failure here.
const guard = (fn) => { try { return fn(); } catch (e) { if (e instanceof ContractError) return die(e.kind, e.code, e.message); throw e; } };
const unsupported = (code, msg) => die("unsupported-capture", code, msg);
const configuration = (code, msg) => die("configuration", code, msg);
const hex = (v, w = 2) => `$${(v >>> 0).toString(16).toUpperCase().padStart(w, "0")}`;
const s8 = (v) => ((v & 0xff) > 127 ? (v & 0xff) - 256 : v & 0xff);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (dirEnv === "") configuration("directory", "UTOPIA_INVASION_CAPTURE_DIR is set but empty");
const dir = path.resolve(dirEnv);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die("capture-directory", "not-found", `${dirEnv} is not a directory`);
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) die("original-input", "missing-files", "original/utopia-whdload/Disk.1 or Disk.2 not found for an explicitly requested comparison");

const LABELS = ["baseline", "queued", "spawned", "moving", "demolished", "gun-kill", "after-kill"];
const MAX_PASS_VBL = 16;
const RAM_SIZE = 0x43100; // capture range bound (also bounds the declared staging writes)

// The site tables (RNG_SITES, TOD_SITES, RASTER_SITES) live in invasion-capture-contract.mjs and bind every supported label to the
// exact original call/read return address. They are checked against themselves and against the player's Disk.1 before any capture
// file is trusted: a different release or a damaged image fails as original-input, never as a quiet pass.
checkSiteTable();
const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
guard(() => verifySiteBindings(disk1));

// ---- file readers (plain names only, read only) ---------------------------------------------------------------------------
function plainName(name, what) {
  if (typeof name !== "string" || name === "" || path.basename(name) !== name || name === "." || name === "..") malformed("file-name", `${what}: ${JSON.stringify(name)} is not a plain file name`);
  return name;
}
function readText(name) {
  const file = path.join(dir, plainName(name, "capture file"));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) malformed("missing-file", `${name} is missing from the capture directory`);
  try { return fs.readFileSync(file, "utf8"); } catch (e) { return malformed("unreadable-file", `${name}: ${e.message}`); }
}
function readJson(name) {
  try { return JSON.parse(readText(name)); } catch (e) { return malformed("bad-json", `${name}: ${e.message}`); }
}
function readJsonl(name) {
  const rows = [];
  readText(name).split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    try { rows.push(JSON.parse(line)); } catch (e) { malformed("bad-json", `${name} line ${i + 1}: ${e.message}`); }
  });
  return rows;
}
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
function exactKeys(value, keys, what) {
  const got = Object.keys(value).sort();
  const allowed = [...keys].sort();
  const extra = got.filter((k) => !allowed.includes(k));
  const missing = allowed.filter((k) => !got.includes(k));
  if (extra.length || missing.length) malformed("schema", `${what}: unexpected keys [${extra.join(", ")}], missing keys [${missing.join(", ")}]`);
}
const parseHexAddr = (v, what) => { if (typeof v !== "string" || !/^\$[0-9A-Fa-f]{1,8}$/.test(v)) malformed("bad-address", `${what}: ${JSON.stringify(v)} is not a $HEX string`); return parseInt(v.slice(1), 16); };

// ---- manifest ------------------------------------------------------------------------------------------------------------
const manifest = readJson("manifest.json");
if (!isObject(manifest) || manifest.schema !== "utopia-invasion-capture/1") malformed("manifest", `manifest.json: schema must be "utopia-invasion-capture/1"`);
exactKeys(manifest, ["schema", "scenario", "machine", "provenance", "checkpoints", "passTops"], "manifest.json");
if (!isInt(manifest.scenario) || manifest.scenario < 0) malformed("manifest", "manifest.json: scenario must be a non-negative integer");
if (!isObject(manifest.machine)) malformed("manifest", "manifest.json: machine must identify the emulator and machine configuration");
exactKeys(manifest.machine, ["emulator", "version", "cpu", "chipset", "video", "chipRamKiB", "fastRamKiB"], "manifest.json machine");
for (const key of ["emulator", "version", "cpu", "chipset", "video"]) {
  if (typeof manifest.machine[key] !== "string" || manifest.machine[key].trim() === "") malformed("manifest", `manifest.json machine.${key} must be a non-empty string`);
}
for (const key of ["chipRamKiB", "fastRamKiB"]) if (!isInt(manifest.machine[key]) || manifest.machine[key] < 0) malformed("manifest", `manifest.json machine.${key} must be a non-negative integer`);
const provenance = guard(() => validateProvenance(manifest.provenance, RAM_SIZE));
if (!Array.isArray(manifest.checkpoints) || manifest.checkpoints.length !== LABELS.length) malformed("manifest", `manifest.json: checkpoints must list exactly ${LABELS.join(", ")}`);
manifest.checkpoints.forEach((c, i) => {
  if (!isObject(c) || c.label !== LABELS[i]) malformed("manifest", `manifest.json: checkpoint ${i} must be "${LABELS[i]}"`);
  exactKeys(c, ["label", "file", "pass"], `manifest.json checkpoint ${i}`);
  plainName(c.file, `checkpoint ${c.label} file`);
  if (!isInt(c.pass)) malformed("manifest", `manifest.json: checkpoint ${c.label}: pass must be an integer`);
  if (i > 0 && c.pass <= manifest.checkpoints[i - 1].pass) malformed("manifest", `manifest.json: checkpoint passes must strictly increase (${c.label})`);
});
if (manifest.checkpoints[6].pass !== manifest.checkpoints[5].pass + 1) malformed("manifest", "manifest.json: after-kill must be exactly one pass after gun-kill");
if (!Array.isArray(manifest.passTops) || manifest.passTops.length < 2) malformed("passTops", "manifest.json: passTops must list every pass top from the baseline pass to the after-kill pass");
const P0 = manifest.checkpoints[0].pass;
const P_END = manifest.checkpoints[6].pass;
if (manifest.passTops.length !== P_END - P0 + 1) malformed("passTops", `manifest.json: passTops has ${manifest.passTops.length} entries, expected ${P_END - P0 + 1} (pass ${P0}..${P_END}, every pass top)`);
manifest.passTops.forEach((t, i) => {
  if (!isObject(t) || t.pass !== P0 + i || !isInt(t.frame) || t.frame < 0) malformed("passTops", `manifest.json: passTops[${i}] must be { pass: ${P0 + i}, frame: <VBL count> }`);
  exactKeys(t, ["pass", "frame"], `manifest.json passTops[${i}]`);
  if (i > 0) {
    const len = t.frame - manifest.passTops[i - 1].frame;
    if (len < 1 || len > MAX_PASS_VBL) malformed("passTops", `manifest.json: pass ${t.pass - 1} lasted ${len} video frames (allowed 1..${MAX_PASS_VBL})`);
  }
});
const topFrame = (pass) => manifest.passTops[pass - P0].frame;
const passLength = (pass) => topFrame(pass + 1) - topFrame(pass);
let VBL_PER_PASS = 1;
for (let pass = P0; pass < P_END; pass++) VBL_PER_PASS = Math.max(VBL_PER_PASS, passLength(pass));

// ---- RAM snapshots ---------------------------------------------------------------------------------------------------
const STATE_BASE = 0x13034, STATE_BYTES = 0x1600;
const SYSFLAGS = 0x156a8, SYSFLAGS_BYTES = 12;
const LISTS_BASE = 0x39d42;
const EFFECT_FIRST = 0x39d4a, EFFECT_STRIDE = 8, EFFECT_COUNT = 0x156ae, EFFECT_SLOTS = 30; // EFFECT_COUNT is a word
const AIR_FIRST = 0x39e3a, AIR_COUNT = 30, GROUND_FIRST = 0x3a146, GROUND_COUNT = 60, ENEMY_STRIDE = 0x1a;
const SHIP_FIRST = 0x3a75e, SHIP_COUNT = 40, TANK_FIRST = 0x3ab1e, TANK_COUNT = 99, UNIT_STRIDE = 0x18;
const OBJ_BASE = 0x3b466, OBJ_BYTES = 8000;
const FLAG_BASE = 0x3d3a6, FLAG_ROW = 102, FLAG_BYTES = 75 * 102;
const MAP_BASE = 0x3f256, MAP_ROW_WORDS = 102, MAP_BYTES = 75 * 102 * 2;
const GROUPS = 0x135c6, GROUP_SIZE = 0x92;
const REQUIRED = [
  ["state image", STATE_BASE, STATE_BYTES],
  ["system flags / effect count", SYSFLAGS, SYSFLAGS_BYTES],
  ["wave queue cursor", 0x12a94, 2],
  ["entity lists (effects, enemy air/ground, ships, tanks)", LISTS_BASE, OBJ_BASE - LISTS_BASE],
  ["object records", OBJ_BASE, OBJ_BYTES],
  ["cell flag bytes", FLAG_BASE, FLAG_BYTES],
  ["map words", MAP_BASE, MAP_BYTES],
];
const OCCUPIED = 0x4000, AIR_LAYER = 0x2000;

function loadSnapshot(entry, expectedFrame) {
  const file = entry.file;
  const j = readJson(file);
  if (!isObject(j) || j.label !== entry.label || j.pass !== entry.pass) malformed("snapshot", `${file}: label/pass must be "${entry.label}"/${entry.pass}`);
  exactKeys(j, ["label", "pass", "frame", "spawner", "segs"], `${file} snapshot`);
  if (j.frame !== expectedFrame) malformed("snapshot", `${file}: frame ${j.frame} differs from passTops frame ${expectedFrame}`);
  if (!isObject(j.spawner) || !isInt(j.spawner.groupIndex) || j.spawner.groupIndex < 0 || j.spawner.groupIndex > 15
    || !isInt(j.spawner.cursor) || j.spawner.cursor < 0 || j.spawner.cursor > 0x80 || j.spawner.cursor % 4 !== 0) {
    malformed("snapshot", `${file}: spawner needs integer groupIndex 0..15 and cursor 0..$80 (multiple of 4)`);
  }
  exactKeys(j.spawner, ["groupIndex", "cursor"], `${file} spawner`);
  if (!Array.isArray(j.segs)) malformed("snapshot", `${file}: segs must be an array`);
  const ram = new Uint8Array(RAM_SIZE);
  const cov = new Uint8Array(RAM_SIZE);
  for (const s of j.segs) {
    if (!isObject(s) || !isInt(s.addr) || !isInt(s.len) || s.addr < 0 || s.len < 1 || typeof s.hex !== "string" || s.hex.length !== s.len * 2 || !/^[0-9a-fA-F]*$/.test(s.hex)) malformed("snapshot", `${file}: malformed segment`);
    exactKeys(s, ["addr", "len", "hex"], `${file} segment`);
    if (s.addr + s.len > RAM_SIZE) malformed("snapshot", `${file}: segment ${hex(s.addr, 5)}+${s.len} exceeds RAM capture bound ${hex(RAM_SIZE, 5)}`);
    for (let a = s.addr; a < s.addr + s.len; a++) if (cov[a]) malformed("snapshot", `${file}: segment overlaps an earlier segment at ${hex(a, 5)}`);
    ram.set(Buffer.from(s.hex, "hex"), s.addr);
    cov.fill(1, s.addr, s.addr + s.len);
  }
  const snap = { file, label: entry.label, pass: entry.pass, frame: j.frame, spawner: j.spawner, ram, cov };
  snap.covered = (addr, len) => { for (let i = 0; i < len; i++) if (!cov[addr + i]) return false; return true; };
  snap.bytes = (addr, len) => { if (!snap.covered(addr, len)) malformed("coverage", `${file}: ${hex(addr, 5)}+${len} is not covered`); return ram.subarray(addr, addr + len); };
  snap.byte = (addr) => snap.bytes(addr, 1)[0];
  snap.word = (addr) => (snap.byte(addr) << 8) | snap.byte(addr + 1);
  snap.long = (addr) => ((snap.word(addr) << 16) | snap.word(addr + 2)) >>> 0;
  for (const [name, addr, len] of REQUIRED) if (!snap.covered(addr, len)) malformed("coverage", `${file}: required area "${name}" ${hex(addr, 5)}..${hex(addr + len - 1, 5)} is not fully covered`);
  // Static Disk.1 trace: $11912 reads/writes $156B2 as a byte; $11898/$1190C read/write $12A94 as a word.
  if (snap.byte(0x156b2) !== j.spawner.groupIndex) malformed("spawner", `${file}: spawner.groupIndex ${j.spawner.groupIndex} disagrees with RAM $156B2=${snap.byte(0x156b2)}`);
  if (snap.word(0x12a94) !== j.spawner.cursor) malformed("spawner", `${file}: spawner.cursor ${hex(j.spawner.cursor)} disagrees with RAM $12A94=${hex(snap.word(0x12a94))}`);
  return snap;
}
const snaps = manifest.checkpoints.map((entry) => loadSnapshot(entry, topFrame(entry.pass)));
const [baseline, , spawnedSnap, movingSnap, , killSnap, afterSnap] = snaps;
const queuedSnap = snaps[1];
const demolishedSnap = snaps[4];

// ---- validate the original-side meaning of each checkpoint (capture integrity, not a remake claim) ------------------------
const groupCount = (snap, g) => snap.byte(GROUPS + GROUP_SIZE * g + 0x90);
const queuedTotal = (snap) => { let n = 0; for (let g = 0; g < 16; g++) n += groupCount(snap, g); return n; };
const occupiedEnemies = (snap, first, count) => { const out = []; for (let i = 0; i < count; i++) if (snap.byte(first + i * ENEMY_STRIDE) !== 0) out.push(i); return out; };
const ownUnitsPresent = (snap) => {
  for (let i = 0; i < SHIP_COUNT; i++) if (snap.byte(SHIP_FIRST + i * UNIT_STRIDE) !== 0) return `ship slot ${i}`;
  for (let i = 0; i < TANK_COUNT; i++) if (snap.byte(TANK_FIRST + i * UNIT_STRIDE) !== 0) return `tank slot ${i}`;
  if (snap.word(0x1429c) !== 0 || snap.word(0x1429e) !== 0) return "unit count word";
  return null;
};
for (const snap of snaps) {
  const own = ownUnitsPresent(snap);
  if (own) unsupported("own-units", `${snap.file}: own tanks/ships are present (${own}); the remake has no seeding path for them outside Disk.4 adoption and this slice has none`);
}
const need = (cond, snap, msg) => { if (!cond) unsupported("stage", `${snap.file} (${snap.label}): capture does not meet the required ${snap.label} stage: ${msg}`); };
if (!snaps.every((s) => occupiedEnemies(s, AIR_FIRST, AIR_COUNT).length === 0 && s.word(0x142a4) === 0)) unsupported("air-enemy", "one or more checkpoints contain an enemy aircraft; this slice only seeds ground enemies");
if (occupiedEnemies(baseline, GROUND_FIRST, GROUND_COUNT).length !== 0 || baseline.word(0x142a2) !== 0) unsupported("ground-enemy-baseline", "the baseline already contains a ground enemy; this scaffold only seeds an empty ground list");
if (queuedTotal(baseline) !== 0) unsupported("queued-baseline", "the baseline already contains a queued entry; this scaffold must observe one queue transition");
need(queuedTotal(queuedSnap) >= 1 && queuedSnap.word(0x142a2) === 0, queuedSnap, "needs a queued wave entry and no enemy yet");
const enemySlots = occupiedEnemies(spawnedSnap, GROUND_FIRST, GROUND_COUNT);
need(spawnedSnap.word(0x142a2) === 1 && enemySlots.length === 1, spawnedSnap, "needs exactly one enemy ($142A2 = 1, one occupied ground slot)");
const ENEMY_SLOT = enemySlots[0];
const pointerAt = (snap, slot) => snap.long(GROUND_FIRST + slot * ENEMY_STRIDE + 0x16);
const hasPlayableGroundReservation = (snap, slot) => {
  const pointer = pointerAt(snap, slot) - FLAG_BASE;
  if (pointer < 0 || pointer >= FLAG_BYTES) return false;
  const y = Math.floor(pointer / FLAG_ROW), x = pointer - y * FLAG_ROW;
  return x < 100 && (snap.byte(FLAG_BASE + pointer) & 1) !== 0;
};
need(movingSnap.word(0x142a2) === 1 && snap_occupied(movingSnap) && hasPlayableGroundReservation(movingSnap, ENEMY_SLOT), movingSnap, "the enemy must remain in its slot and its raw +$16 must name a playable cell with the ground reservation flag set");
function snap_occupied(snap) { return snap.byte(GROUND_FIRST + ENEMY_SLOT * ENEMY_STRIDE) !== 0; }
need(demolishedSnap.word(0x142c2) < movingSnap.word(0x142c2), demolishedSnap, "$142C2 must be lower than at `moving` (a building record was demolished)");
need(killSnap.word(0x142a2) === 0 && killSnap.long(0x14298) === (baseline.long(0x14298) + 1) >>> 0 && !snap_occupied(killSnap), killSnap, "needs $142A2 = 0, the slot free and the 32-bit kill counter $14298 = baseline + 1");
need(afterSnap.word(0x142a2) === 0 && afterSnap.long(0x14298) === killSnap.long(0x14298), afterSnap, "the kill counter must not change after the kill");

// ---- tapes ---------------------------------------------------------------------------------------------------------------
function loadTape(name, kind, sites, validateRow) {
  const rows = readJsonl(name);
  if (rows.length === 0) malformed("tape", `${name}: empty; an invasion window has at least one ${kind} row`);
  let prevPass = P0, prevFrame = -1;
  rows.forEach((r, i) => {
    const at = `${name} row ${i + 1}`;
    if (!isObject(r) || r.n !== i + 1) malformed("tape", `${at}: n must be ${i + 1} (strict order, no gaps)`);
    if (!isInt(r.pass) || r.pass < P0 || r.pass >= P_END) malformed("tape", `${at}: pass ${r.pass} is outside the replay window ${P0}..${P_END - 1}`);
    if (r.pass < prevPass) malformed("tape", `${at}: pass goes backwards`);
    if (!isInt(r.frame) || r.frame < topFrame(r.pass) || r.frame > topFrame(r.pass + 1) || r.frame < prevFrame) malformed("tape", `${at}: frame ${r.frame} is not inside pass ${r.pass} (${topFrame(r.pass)}..${topFrame(r.pass + 1)}) or goes backwards`);
    prevPass = r.pass; prevFrame = r.frame;
    const label = resolveSiteName(sites, r.site); // the table label, or the exact capture-tool alias of one audited site
    if (label === null) unsupported("unknown-site", `${at}: site ${JSON.stringify(r.site)} is not in the ${kind} site table (known: ${Object.keys(sites).join(", ")}; capture aliases: ${Object.values(sites).filter((s) => s.captureAlias).map((s) => s.captureAlias).join(", ") || "none"})`);
    guard(() => checkReturn(sites, label, parseHexAddr(r.ret, `${at} ret`), at)); // exact original address of this label
    if (kind === "RNG") exactKeys(r, ["n", "pass", "frame", "site", "ret", "range", "result", "seedBefore", "seedAfter"], at);
    else exactKeys(r, ["n", "pass", "frame", "site", "ret", "value"], at);
    r.site = label; // canonical from here on (replay and divergence messages)
    validateRow(r, at, i, rows);
  });
  const endIndexByPass = new Map();
  for (let pass = P0; pass < P_END; pass++) endIndexByPass.set(pass, rows.filter((r) => r.pass <= pass).length);
  return { name, kind, rows, sites, idx: 0, endIndexByPass };
}
const tapes = {
  rng: loadTape("tape-rng.jsonl", "RNG", RNG_SITES, (r, at, i, rows) => {
    const site = RNG_SITES[r.site];
    if (!isInt(r.range) || r.range < 1 || !isInt(r.result) || r.result < 0 || r.result >= r.range) malformed("tape", `${at}: result ${r.result} is outside range ${r.range}`);
    if (site.range !== undefined && r.range !== site.range) malformed("tape", `${at}: site ${r.site} has range ${site.range}, row says ${r.range}`);
    if (site.maxRange !== undefined && r.range > site.maxRange) malformed("tape", `${at}: site ${r.site} has range <= ${site.maxRange}, row says ${r.range}`);
    const before = parseHexAddr(r.seedBefore, `${at} seedBefore`);
    parseHexAddr(r.seedAfter, `${at} seedAfter`);
    if (i > 0 && before !== parseHexAddr(rows[i - 1].seedAfter, `${at} previous seedAfter`)) malformed("tape", `${at}: seed chain broken (seedBefore is not the previous row's seedAfter)`);
  }),
  tod: loadTape("tape-tod.jsonl", "TOD", TOD_SITES, (r, at) => { if (!isInt(r.value) || r.value < 0 || r.value > 255) malformed("tape", `${at}: value must be a byte`); }),
  raster: loadTape("tape-raster.jsonl", "raster", RASTER_SITES, (r, at) => { if (r.value !== 0 && r.value !== 1) malformed("tape", `${at}: value must be 0 or 1`); }),
};

// ---- remake modules --------------------------------------------------------------------------------------------------
const { MAP_WIDTH, MAP_HEIGHT, readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");
const { cellFlagIndex, CELL_FLAG_BASE, CELL_FLAG_BYTES, resolveCellFlagPointer } = await import("../dist/game/cell-flags.js");
const { readSavedView } = await import("../dist/game/disk4-scene.js");
if (CELL_FLAG_BASE !== FLAG_BASE || CELL_FLAG_BYTES !== FLAG_BYTES || MAP_WIDTH !== 100 || MAP_HEIGHT !== 75) unsupported("layout", "the remake's cell flag/map layout differs from the one this comparator assumes");

// ---- tape replay (RNG / TOD / raster adapters) -------------------------------------------------------------------------
class TapeDivergence extends Error {}
const replay = { active: false, pass: P0 };
const HELPER_FRAMES = new Set(["callerFunction", "tapeRng", "tapeTod", "tapeRaster", "consume", "roll", "todLow", "rasterParity"]);
function callerFunction() {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = 16;
  const lines = new Error().stack.split("\n").slice(1);
  Error.stackTraceLimit = previous;
  for (const line of lines) {
    const m = /at (?:new )?(?:async )?([^\s(]+) \(/.exec(line);
    if (!m) continue;
    const name = m[1].split(".").pop();
    if (HELPER_FRAMES.has(name)) continue;
    return name;
  }
  return "?";
}
function consume(tape, extra) {
  const fn = callerFunction();
  const row = tape.rows[tape.idx];
  const what = `${tape.kind} draw #${tape.idx + 1} from ${fn}${extra.text}`;
  if (!replay.active) throw new TapeDivergence(`${what}: outside the replay`);
  if (!row) throw new TapeDivergence(`${what} in original pass ${replay.pass}: the ${tape.name} tape ends after ${tape.rows.length} rows`);
  const site = tape.sites[row.site];
  if (row.pass !== replay.pass) throw new TapeDivergence(`${what}: the tape places it (site ${row.site}) in original pass ${row.pass}, the remake draws in pass ${replay.pass}`);
  if (site.fn !== fn) throw new TapeDivergence(`${what}: site ${row.site} (${hex(parseHexAddr(row.ret, "ret"), 5)}) belongs to remake function ${site.fn}`);
  extra.check(row);
  tape.idx++;
  return row;
}
const tapeRng = (range) => consume(tapes.rng, {
  text: `, range ${range}`,
  check: (row) => { if (row.range !== range) throw new TapeDivergence(`RNG draw #${tapes.rng.idx + 1}: original range ${row.range} (site ${row.site}), remake range ${range}`); },
}).result;
const tapeTod = () => consume(tapes.tod, { text: "", check: () => {} }).value;
const tapeRaster = () => consume(tapes.raster, { text: "", check: () => {} }).value;

// ---- baseline seeding ------------------------------------------------------------------------------------------------
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const record = records[manifest.scenario];
if (!record) malformed("manifest", `manifest.json: scenario ${manifest.scenario} does not exist (${records.length} scenario records in Disk.2)`);
console.log(`capture identity: scenario ${manifest.scenario}; ${manifest.machine.emulator} ${manifest.machine.version}; ${manifest.machine.cpu}/${manifest.machine.chipset} ${manifest.machine.video}; RAM ${manifest.machine.chipRamKiB}K chip + ${manifest.machine.fastRamKiB}K fast; ${describeProvenance(provenance)}`);
const tiles = loadTileSet(disk1, disk2, record).tiles;
const sprites = loadSprites(disk1, disk2, record);
const strings = new GameStrings(disk1, 0);

// Unsupported baselines: states the remake has no faithful seeding path for.
if (baseline.byte(0x156a9) & 0x04) unsupported("paused", "baseline is paused ($156A9 bit 2)");
if (baseline.byte(0x156a8) & 0x10) unsupported("dialog-freeze", "baseline has the dialog/build-menu freeze set ($156A8 bit 4)");
if (baseline.word(EFFECT_COUNT) !== 0) unsupported("effects-baseline", "baseline has a non-empty effect pool ($156AE); the slot layout is traced (30 fixed slots, first free slot) but no seeding path into ObjectLayer.pool exists in this scaffold, so only an empty baseline is replayed");
const state = new GameState(disk2, record.block);
const world = new World(state, loadMap(disk2, record));
state.restore(baseline.bytes(STATE_BASE, STATE_BYTES));
const savedView = readSavedView(state);
if (savedView.clamped) unsupported("view", `baseline view words ($144E4/$144E6 = ${savedView.savedX},${savedView.savedY}) lie outside the legal origin range`);
world.objects.set(baseline.bytes(OBJ_BASE, OBJ_BYTES));
world.objectCount = state.word(0x142c2);
world.cellFlags.set(baseline.bytes(FLAG_BASE, FLAG_BYTES));
for (let y = 0; y < MAP_HEIGHT; y++) for (let x = 0; x < MAP_WIDTH; x++) world.cells[y * MAP_WIDTH + x] = baseline.word(MAP_BASE + 2 * (y * MAP_ROW_WORDS + x));
// The scene is built after the state is seeded (the alien handle is hydrated from $144A8 in the constructor).
const scene = new MapScene(disk1, tiles, world, strings, {
  sprites,
  vblPerPass: VBL_PER_PASS,
  simulation: { rng: tapeRng, hardware: { todLow: tapeTod, rasterParity: tapeRaster } },
});
if (!scene.objects || !scene.enemies) unsupported("no-object-layer", "the scene has no object layer / enemy system");
const sim = scene.sim;
sim.sysFlags = baseline.byte(0x156aa);
sim.paused = false;
sim.dayQueued = (baseline.byte(0x156a8) & 0x80) !== 0;
scene.objects.units.clock.sub = baseline.byte(0x144c9);
sim.aliens.restoreSpawner(baseline.spawner.groupIndex, baseline.spawner.cursor);
scene.scrollX = savedView.x;
scene.scrollY = savedView.y;
// Raw +$16 of every fixed enemy slot, free ones included (enemies.md 3b): the slot owns the pointer.
for (let i = 0; i < GROUND_COUNT; i++) scene.enemies.groundFlagPointers[i] = baseline.long(GROUND_FIRST + i * ENEMY_STRIDE + 0x16);
for (let i = 0; i < AIR_COUNT; i++) scene.enemies.airFlagPointers[i] = baseline.long(AIR_FIRST + i * ENEMY_STRIDE + 0x16);

// ---- comparison --------------------------------------------------------------------------------------------------------
const NAMES = [
  [0x13034, 0x13134, "scenario block start"], [0x13152, 0x13169, "goods stock/weight"], [0x13456, 0x135b5, "alien record / wave entries"], [0x135c6, 0x13ee5, "wave spawn groups"],
  [0x135b6, 0x135c1, "money/spend/grant"], [0x14254, 0x142a5, "unit/enemy counters"], [0x142c2, 0x142c5, "object/site counts"], [0x14298, 0x1429b, "kill counter"],
  [0x14436, 0x14471, "production counters"], [0x1449c, 0x144ad, "meteor / alien record"], [0x144b0, 0x144cf, "status bytes"], [0x144e4, 0x144eb, "view / bookmark"], [0x14540, 0x1458f, "marker pins"],
];
const nameOf = (a) => (NAMES.find(([lo, hi]) => a >= lo && a <= hi) ?? [0, 0, "state image"])[2];
const flagText = (p) => { const r = resolveCellFlagPointer(p); return r.kind === "playable" ? ` (cell ${r.x},${r.y})` : r.kind === "padding" ? ` (padding ${r.x},${r.y})` : ""; };

function compare(cp, snap, ctx) {
  const groups = [];
  const group = (name) => { const g = { name, compared: 0, diffs: [] }; groups.push(g); return g; };
  const cmp = (g, field, orig, mine, fmt = (v) => String(v)) => { g.compared++; if (orig !== mine) g.diffs.push(`${field}: original ${fmt(orig)} remake ${fmt(mine)}`); };
  const done = new Set();
  const cmpBytes = (g, field, addr, width) => {
    for (let i = 0; i < width; i++) done.add(addr + i);
    const orig = width === 1 ? snap.byte(addr) : width === 2 ? snap.word(addr) : snap.long(addr);
    const mine = width === 1 ? state.byte(addr) : width === 2 ? state.word(addr) : state.long(addr);
    cmp(g, `${field} (${hex(addr, 5)})`, orig, mine, (v) => String(v));
  };
  if (cp.time.offer !== null) {
    const gModal = group("runtime modal state");
    cmp(gModal, "unexpected remake Earth offer", null, cp.time.offer, (v) => JSON.stringify(v));
  }
  if (!cp.passClock || !cp.enemies || !cp.view) die("internal", "no-runtime", "MapScene checkpoint lacks pass clock, enemy system or view");

  const gTime = group("timing (original VBL/pass boundaries)");
  cmp(gTime, "$14590 frame countdown", snap.byte(0x14590), cp.time.frameCountdown);
  cmp(gTime, "$144C9 pass clock", snap.byte(0x144c9), cp.passClock.sub);
  cmp(gTime, "$156A8 bit 7 day queued", (snap.byte(0x156a8) & 0x80) !== 0, cp.time.dayQueued);
  cmp(gTime, "$156A9 bit 2 paused", (snap.byte(0x156a9) & 0x04) !== 0, cp.time.paused);
  cmp(gTime, "$156AA system flags", snap.byte(0x156aa), cp.time.sysFlags, (v) => hex(v));
  if (!ctx.seed) {
    cmp(gTime, "$156A9 bit 7 move tick", (snap.byte(0x156a9) & 0x80) !== 0, cp.passClock.moveTick);
    cmp(gTime, "$156A9 bit 6 enemy tick", (snap.byte(0x156a9) & 0x40) !== 0, cp.passClock.enemyTick);
  }
  for (const [name, addr, width] of [["pending period bits $144C1", 0x144c1, 1], ["day", 0x1459f, 1], ["month", 0x145a0, 1], ["event index", 0x144bf, 1], ["attack countdown", 0x141b2, 1]]) cmpBytes(gTime, name, addr, width);

  const gSpawn = group("wave queue and spawner");
  const spawner = sim.aliens.spawner;
  cmp(gSpawn, "spawner group index ($156B2)", snap.spawner.groupIndex, spawner.groupIndex);
  cmp(gSpawn, "spawner cursor ($12A94)", snap.spawner.cursor, spawner.cursor, (v) => hex(v));
  for (let g = 0; g < 16; g++) {
    const base = GROUPS + GROUP_SIZE * g;
    cmpBytes(gSpawn, `group ${g} count`, base + 0x90, 1);
    for (let q = 0; q < 32; q++) cmpBytes(gSpawn, `group ${g} queue ${q}`, base + 0x10 + 4 * q, 4);
  }

  const gEnemy = group("enemy slots (ground 60 / air 30: occupancy, record, raw +$16 pointer)");
  for (const [list, first, count, pointers, slots] of [["ground", GROUND_FIRST, GROUND_COUNT, cp.enemies.groundFlagPointers, cp.enemies.ground], ["air", AIR_FIRST, AIR_COUNT, cp.enemies.airFlagPointers, cp.enemies.air]]) {
    for (let i = 0; i < count; i++) {
      const at = first + i * ENEMY_STRIDE;
      const b = snap.bytes(at, ENEMY_STRIDE);
      const tag = `${list}[${i}]`;
      cmp(gEnemy, `${tag}.flagPointer (+$16 raw)`, snap.long(at + 0x16), pointers[i], (v) => `${hex(v, 5)}${flagText(v)}`);
      const e = slots[i];
      cmp(gEnemy, `${tag} occupied`, b[0] !== 0, e !== null);
      if (b[0] === 0 || e === null) continue;
      const crusher = list === "ground" && b[0] === 24;
      const orig = { type: b[0], x: b[1], y: b[2], dx: s8(b[3]), dy: s8(b[4]), dir: b[5], vx: s8(b[6]), vy: s8(b[7]), hp: b[8], tech: b[10], targetX: b[11], targetY: b[12], steps: b[13], bombChance: b[14], damage: b[15] };
      const mine = { type: e.type, x: e.x, y: e.y, dx: s8(e.dx), dy: s8(e.dy), dir: e.dir & 0xff, vx: s8(e.vx), vy: s8(e.vy), hp: e.hp & 0xff, tech: e.tech, targetX: e.targetX & 0xff, targetY: e.targetY & 0xff, steps: e.steps & 0xff, bombChance: e.bombChance & 0xff, damage: e.damage & 0xff };
      for (const f of Object.keys(orig)) cmp(gEnemy, `${tag}.${f}`, orig[f], mine[f]);
      if (list === "ground") {
        cmp(gEnemy, `${tag}.control (+9: waiting bit 7 | mode)`, b[9], (e.waiting ? 0x80 : 0) | (e.mode & 0x7f), (v) => hex(v));
        for (let r = 0; r < 3; r++) cmp(gEnemy, `${tag}.recent[${r}] (+$${(0x10 + r).toString(16)})`, b[0x10 + r], e.recent[r] & 0xff);
      } else {
        cmp(gEnemy, `${tag}.mode (+9)`, b[9], e.mode & 0xff, (v) => hex(v));
        cmp(gEnemy, `${tag}.lift (+$10)`, b[0x10], e.lift & 0xff);
      }
      if (crusher) {
        cmp(gEnemy, `${tag}.crusher toggle/counter (+$13)`, b[0x13], e.crusher ? ((e.crusher.toggle ? 0x80 : 0) | e.crusher.counter) : -1, (v) => hex(v));
        cmp(gEnemy, `${tag}.crusher anim (+$14)`, b[0x14], e.crusher ? e.crusher.anim : -1);
      } else {
        cmp(gEnemy, `${tag}.aux (+$13)`, b[0x13], e.aux & 0xff);
        cmp(gEnemy, `${tag}.byte14`, b[0x14], e.byte14 & 0xff);
      }
      cmp(gEnemy, `${tag}.byte15`, b[0x15], e.byte15 & 0xff);
    }
  }
  for (const [name, addr, width] of [["enemy ground count $142A2", 0x142a2, 2], ["enemy air count $142A4", 0x142a4, 2], ["kills (32-bit) $14298", 0x14298, 4], ["own tanks $1429C", 0x1429c, 2], ["own ships $1429E", 0x1429e, 2]]) cmpBytes(gEnemy, name, addr, width);

  const gObj = group("object / building records (all 1000: demolition, gun timers +6/+7)");
  const objects = snap.bytes(OBJ_BASE, OBJ_BYTES);
  for (let slot = 0; slot < 1000; slot++) {
    const gun = (((objects[slot * 8] << 8) | objects[slot * 8 + 1]) & 0xff) === 0x1f || (((objects[slot * 8] << 8) | objects[slot * 8 + 1]) & 0xff) === 0x0f;
    for (let i = 0; i < 8; i++) cmp(gObj, `record ${slot} byte ${i}${gun && i >= 6 ? " (gun step/timer)" : ""}`, objects[slot * 8 + i], world.objects[slot * 8 + i], (v) => hex(v));
  }
  cmpBytes(gObj, "object records $142C2", 0x142c2, 2);
  cmpBytes(gObj, "sites $142C4", 0x142c4, 2);

  // The effect list is 30 FIXED 8-byte slots (static trace of $1237C/$333A): a hole is a slot with type 0, survivors keep their
  // slot, a new effect takes the first free one. The count at $156AE is a WORD. Every slot is inspected; holes are legal.
  const gEffects = group("effect slots ($39D4A, 30 x 8 bytes, count word $156AE)");
  const count = snap.word(EFFECT_COUNT);
  if (count > EFFECT_SLOTS) malformed("effect-count", `${snap.file}: effect count ${count} exceeds the fixed ${EFFECT_SLOTS}-slot pool`);
  const effectBytes = Array.from({ length: EFFECT_SLOTS }, (_, i) => snap.bytes(EFFECT_FIRST + i * EFFECT_STRIDE, EFFECT_STRIDE));
  const effectOccupied = effectBytes.filter((b) => b[0] !== 0).length;
  if (effectOccupied !== count) malformed("effect-count", `${snap.file}: count word $156AE = ${count} but ${effectOccupied} of the ${EFFECT_SLOTS} slots are occupied`);
  if (cp.queues.effectSlots === null || cp.queues.effectSlots.length !== EFFECT_SLOTS) malformed("effect-slots", "the remake checkpoint has no 30-slot effect pool (schema 4 queues.effectSlots)");
  cmp(gEffects, "effect count ($156AE word)", count, cp.queues.effectCount);
  for (let i = 0; i < EFFECT_SLOTS; i++) {
    const b = effectBytes[i];
    const m = cp.queues.effectSlots[i];
    cmp(gEffects, `effect slot ${i} occupied`, b[0] !== 0, m !== null);
    if (b[0] === 0 || m === null) continue; // a hole: only its occupancy is compared
    if (b[3] !== 0 || b[4] !== 0 || b[7] !== 0) unsupported("effect-bytes", `${snap.file}: effect slot ${i} has a non-zero +3/+4/+7 byte; the remake effect has no field for it`);
    for (const [f, o, r] of [["type", b[0], m.type], ["x", b[1], m.x], ["y", b[2], m.y], ["frame (+5)", b[5], m.frame], ["lift (+6)", b[6], m.lift]]) cmp(gEffects, `effect slot ${i} ${f}`, o, r);
  }

  const gMap = group("playable map words (bits 14/13 and remainder), cell flag bytes (100 x 75 plus padding columns)");
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < FLAG_ROW; x++) {
      cmp(gMap, `flag byte ${x},${y}`, snap.byte(FLAG_BASE + y * FLAG_ROW + x), world.cellFlags[cellFlagIndex(x, y)], (v) => hex(v));
      if (x >= MAP_WIDTH) continue;
      const w = snap.word(MAP_BASE + 2 * (y * MAP_ROW_WORDS + x));
      const mine = world.cells[y * MAP_WIDTH + x];
      cmp(gMap, `map ${x},${y} ground bit14`, (w & OCCUPIED) !== 0, (mine & OCCUPIED) !== 0);
      cmp(gMap, `map ${x},${y} air bit13`, (w & AIR_LAYER) !== 0, (mine & AIR_LAYER) !== 0);
      cmp(gMap, `map ${x},${y} word without bits 13/14`, w & ~(OCCUPIED | AIR_LAYER) & 0xffff, mine & ~(OCCUPIED | AIR_LAYER) & 0xffff, (v) => hex(v, 4));
    }
  }
  const gView = group("view");
  cmp(gView, "view x ($144E4)", snap.word(0x144e4), cp.view.x);
  cmp(gView, "view y ($144E6)", snap.word(0x144e6), cp.view.y);

  const gRest = group("residual state image sweep (every other byte)");
  // `$14590` is compared against the pass-length replay; `$14594..$1459D` is independently updated display text;
  // `$144C9` and `$144E4..$144E7` are compared in their named groups above.
  const excluded = (a) => a === 0x14590 || (a >= 0x14594 && a <= 0x1459d) || a === 0x144c9 || a === 0x144e4 || a === 0x144e5 || a === 0x144e6 || a === 0x144e7;
  for (let a = STATE_BASE; a < STATE_BASE + STATE_BYTES; a++) {
    if (excluded(a) || done.has(a)) continue;
    const o = snap.byte(a), m = state.byte(a);
    gRest.compared++;
    if (o !== m) gRest.diffs.push(`${hex(a, 5)} (${nameOf(a)}): original ${hex(o)} remake ${hex(m)}`);
  }
  return groups;
}
function report(title, groups) {
  let first = null;
  for (const g of groups) {
    const ok = g.diffs.length === 0;
    console.log(`${ok ? "ok  " : "FAIL"} ${title} / ${g.name}: ${g.compared} fields; ${g.diffs.length} divergence(s)`);
    for (const d of g.diffs.slice(0, 40)) console.log(`       ${d}`);
    if (g.diffs.length > 40) console.log(`       ... ${g.diffs.length - 40} more`);
    if (!ok && !first) first = `${title} / ${g.name}: ${g.diffs[0]}`;
  }
  return first;
}

// Seed check: the freshly seeded scene must read back as the baseline. A difference here is a gap of the seeding/observation
// support (unsupported capture), not a remake divergence.
const seedGroups = compare(scene.captureCheckpoint({ includeObjectRecords: false, includeCells: false }), baseline, { seed: true });
const seedBad = seedGroups.filter((g) => g.diffs.length > 0);
if (seedBad.length > 0) {
  for (const g of seedBad) console.error(`  seed check ${g.name}: ${g.diffs.length} difference(s), first: ${g.diffs[0]}`);
  unsupported("seed", `the baseline cannot be seeded faithfully (${seedBad.map((g) => g.name).join("; ")}); see the lines above and runtime-checkpoints.md section 7`);
}
console.log(`baseline seeded and read back (pass ${P0}, frame ${baseline.frame}); replaying ${P_END - P0} original passes, scene vblPerPass ${VBL_PER_PASS}`);

// ---- run: one scene, continuously, no reseeding ------------------------------------------------------------------------
const idle = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
let failures = 0;
let firstDivergence = null;
let passEnds = 0;
let stop = false;
let callbackDivergence = null; // the recorder swallows exceptions thrown by onCheckpoint, so a tape divergence is parked here
const checkpointByTop = new Map(manifest.checkpoints.slice(1).map((c, i) => [c.pass, snaps[i + 1]]));
const recorder = scene.enableCheckpoints({
  capacity: 0,
  includeObjectRecords: false,
  includeCells: false,
  onCheckpoint: (cp) => {
    passEnds++;
    if (cp.boundary !== "pass-end") {
      callbackDivergence = new TapeDivergence(`the remake ran a ${cp.boundary} pass in original pass ${replay.pass}`);
      stop = true;
      return;
    }
    for (const t of Object.values(tapes)) {
      const want = t.endIndexByPass.get(replay.pass);
      if (t.idx !== want) {
        callbackDivergence = new TapeDivergence(`after original pass ${replay.pass} the remake consumed ${t.idx} ${t.kind} tape row(s), the original made ${want}`);
        stop = true;
        return;
      }
    }
    const snap = checkpointByTop.get(replay.pass + 1);
    if (!snap) return;
    const title = `${snap.label} (pass top ${snap.pass}, frame ${snap.frame})`;
    const groups = compare(cp, snap, { seed: false });
    const first = report(title, groups);
    if (first) { failures++; firstDivergence ??= first; stop = true; }
  },
});
try {
  for (replay.pass = P0; replay.pass < P_END && !stop; replay.pass++) {
    const n = passLength(replay.pass);
    replay.active = true;
    if (n !== VBL_PER_PASS && !scene.loop.restoreAt(scene.loop.passes * VBL_PER_PASS + (VBL_PER_PASS - n))) unsupported("scheduler", "MainLoop.restoreAt refused the pass phase");
    for (let i = 0; i < n; i++) scene.update({ ...idle, keys: [] });
    replay.active = false;
  }
} catch (e) {
  if (!(e instanceof TapeDivergence)) throw e;
  callbackDivergence ??= e;
}
if (callbackDivergence) {
  failures++;
  firstDivergence ??= `tape: ${callbackDivergence.message}`;
  console.log(`FAIL tape replay: ${callbackDivergence.message}`);
}
if (recorder.failures > 0) die("internal", "checkpoint-callback", `the checkpoint callback failed ${recorder.failures} time(s): ${recorder.lastError}`);
if (failures === 0) {
  if (passEnds !== P_END - P0) die("internal", "pass-checkpoints", `observed ${passEnds} pass-end checkpoints, expected ${P_END - P0}`);
  for (const t of Object.values(tapes)) if (t.idx !== t.rows.length) die("internal", "tape-leftover", `${t.name}: ${t.rows.length - t.idx} row(s) unconsumed`);
}

// ---- report ----------------------------------------------------------------------------------------------------------
console.log(`tapes consumed: RNG ${tapes.rng.idx}/${tapes.rng.rows.length}, TOD ${tapes.tod.idx}/${tapes.tod.rows.length}, raster ${tapes.raster.idx}/${tapes.raster.rows.length}`);
if (firstDivergence) console.log(`first divergence: ${firstDivergence}`);
console.log(failures === 0
  ? `invasion original comparison: captured slice has no divergence under replayed RNG/TOD/raster inputs (${describeProvenance(provenance)}; one scenario/run; not general game parity; see runtime-checkpoints.md section 7 for limits)`
  : `invasion original comparison: ${failures} divergence report(s)`);
process.exitCode = failures === 0 ? 0 : 1;
