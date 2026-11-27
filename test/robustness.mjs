// Robustness of the paths a real user reaches that the other tests do not cover. Not a fidelity test.
//   A. The user's own disk.4 (read only, original/utopia-whdload/disk.4) through the real remake menu (LOAD DISK.4): every
//      slot is tried; the real file has none populated (its ten records are EMPTY), so each is refused with a typed error.
//      A second, SYNTHETIC image (built in memory from the real header and the scenario-0 new-game state, never written to
//      disk) supplies populated slots: one activates and is played for 20,000 map updates with seeded random input and windows
//      opened; two are refused through the error pages, which must be left with the previous scene intact.
//   B. Mutated disk.4 images built in memory (truncated, byte flips, wrong magic, huge declared sizes, odd argument types).
//      Each activation must return a typed error or succeed, without throwing and within a time limit. The cases run in a child
//      process so a hang is reported as a failed case instead of blocking the run.
//   C. Storage failures through the real save and load menus: no localStorage, getItem throws, setItem throws (quota), invalid
//      JSON, truncated text, wrong types, unknown version, empty slot, and a save over an invalid slot. Each refusal must show an
//      error page (or the empty-slot prompt), leave the running map unchanged, and return to the map.
//   D. Wrong folders given to startFromFiles: empty, one disk, wrong sizes, duplicate names, extra and subfolder files, rejected
//      reads, and a read that resolves to something other than bytes.
// Needs the user's Disk.1 and Disk.2 for A, B, C and the control case of D; A also needs disk.4. Missing files skip the
// sections that need them. Run after `npm run build` (tests import ../dist). Original files are only read; nothing is written
// under original/. The mutated images are built in memory.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => import(pathToFileURL(path.join(root, "dist", p)).href);
const origDir = path.join(root, "original", "utopia-whdload");
const d1Path = path.join(origDir, "Disk.1");
const d2Path = path.join(origDir, "Disk.2");
const d4Path = path.join(origDir, "disk.4");
const CHILD = process.env.ROBUST_MUTANT_CHILD === "1";

// ---- localStorage stand-in whose failure modes the cases switch -------------------------------------------------------------
const store = new Map();
const storageState = { mode: "ok" }; // "ok" | "getThrows" | "setThrows"
globalThis.localStorage = {
  getItem(k) {
    if (storageState.mode === "getThrows") throw new Error("SecurityError: storage access denied");
    return store.has(k) ? store.get(k) : null;
  },
  setItem(k, v) {
    if (storageState.mode === "setThrows") {
      const e = new Error("QuotaExceededError: the quota has been exceeded");
      e.name = "QuotaExceededError";
      throw e;
    }
    store.set(k, String(v));
  },
  removeItem(k) { store.delete(k); },
};

const SHIM = globalThis.localStorage;

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
  return ok;
}
function guard(name, fn) {
  try { return fn(); } catch (e) { check(`${name} (no exception)`, false, `threw: ${e instanceof Error ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)}`); return undefined; }
}
const skip = (why) => console.log(`skipped: ${why}`);

// ---- shared helpers -----------------------------------------------------------------------------------------------------------
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const refsEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function describeError(e) {
  // The first stage/code chain of a typed error, for the report: e.g. "inspect/slot/slot-empty".
  const parts = [];
  let x = e;
  for (let i = 0; i < 8 && x && typeof x === "object"; i++) {
    if (typeof x.stage === "string") parts.push(x.stage);
    if (typeof x.code === "string") { parts.push(x.code); break; }
    x = x.error ?? null;
  }
  return parts.join("/") || "?";
}

// ---- boot-session helpers (the real clicks of test/boot-menu.mjs) ------------------------------------------------------------
// Loaded only when the Disk.1 / Disk.2 files exist; the module-level `game` is the Game under test.
let game = null;
let Api = null;

async function loadApi() {
  const { GameStrings } = await dist("data/gamestrings.js");
  const { Screen } = await dist("gfx/screen.js");
  const { decodePicture, PICTURES } = await dist("data/picture.js");
  const { Game } = await dist("game/game.js");
  const { DISK_BUTTON, DISK_MENU_BUTTONS } = await dist("game/disk-menu.js");
  const { readSlot, slotSummaries } = await dist("game/save.js");
  const { SAVE_SLOTS } = await dist("game/save.js");
  const { readScenarioRecords, readScenarioDiskId, loadMap, MAP_WIDTH, MAP_HEIGHT } = await dist("data/scenario.js");
  const { GameState, STATE_BYTES, A } = await dist("game/state.js");
  const { World } = await dist("game/world.js");
  const { parseDisk4Input, DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT, DISK4_SIGNATURE } = await dist("data/disk4.js");
  const { DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES } = await dist("data/disk4-state.js");
  const { startFromFiles } = await dist("startup.js");
  const { Ui } = await dist("game/screens/ui.js");
  const { GameImage } = await dist("game/screens/image.js");
  return {
    Ui, GameImage,
    GameStrings, Screen, decodePicture, PICTURES, Game, DISK_BUTTON, DISK_MENU_BUTTONS, readSlot, slotSummaries, SAVE_SLOTS,
    readScenarioRecords, readScenarioDiskId, loadMap, MAP_WIDTH, MAP_HEIGHT, GameState, STATE_BYTES, A, World,
    parseDisk4Input, DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT, DISK4_SIGNATURE,
    DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES, startFromFiles,
  };
}

const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const frame = (down, x = 0, y = 0, right = false, keys = []) => {
  input.leftButton = down; input.rightButton = right; input.pointerX = x; input.pointerY = y;
  game.update({ leftButton: down, rightButton: right, pointerX: x, pointerY: y, keys });
};
const idle = () => frame(false, 0, 0);
const centre = (i) => [Api.DISK_MENU_BUTTONS[i].x0 + 16, Api.DISK_MENU_BUTTONS[i].y0 + 16];
const iconClick = (i) => { idle(); const [x, y] = centre(i); frame(true, x, y); frame(true, x, y); frame(false, x, y); };
const rightClick = () => { idle(); frame(false, 0, 0, true); idle(); };
const scenarioIcon = () => { iconClick(Api.DISK_BUTTON.scenario); frame(true, 0, 0); frame(false, 0, 0); };
const tapListRow = (row) => { idle(); const y = 0x20 + row * 9 + 4; frame(false, 100, y); frame(true, 100, y); frame(false, 100, y); };
const tapRow = (row) => {
  idle();
  const y = 40 + 16 + row * 12 + 4;
  frame(false, 50, y); frame(true, 50, y); frame(false, 50, y);
  if (game.stage === "save" && game.nameEntry) { idle(); frame(true, 50, y); frame(false, 50, y); } // default name
};
const labels = () => (game.menu?.entries ?? []).map((e) => e.label);
const enabledFlags = () => (game.menu?.entries ?? []).map((e) => e.enabled !== false);
const openDisk = () => { game.openDiskMenu(); idle(); };

function bootGame(disk1, disk2, Ctor) {
  const g = new Ctor(disk1, disk2, null, null);
  g.stage = "language";
  g.language = { pointerVisible: true, screen: new Api.Screen(), picturePalette: Api.decodePicture(disk1, Api.PICTURES.language).palette, update: () => ({ state: "chosen", language: 0 }) };
  return g;
}
function passBoot(g, limit = 20000) {
  let inCheck = 0;
  for (let n = 1; g.stage === "boot" || g.stage === "language"; n++) {
    if (n > limit) throw new Error("the boot stages did not finish");
    if (g.boot?.currentPhase === "E") inCheck++;
    g.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: inCheck === 50 ? ["Enter"] : [] });
  }
}

// Snapshot of the running map: identity plus every saved array. Unchanged means the same scene object with the same bytes and refs.
function mapSnapshot(m) {
  return {
    map: m, state: m.world.state.snapshot(), cells: m.world.cells.slice(), flags: m.world.cellFlags.slice(), objects: m.world.objects.slice(),
    fleet: m.sim.fleet.slots.slice(), units: m.objects?.units ? m.objects.units.slots.slice() : null,
  };
}
function mapUnchanged(snap) {
  const m = snap.map;
  const now = mapSnapshot(m);
  return game.map === m && eq(now.state, snap.state) && eq(now.cells, snap.cells) && eq(now.flags, snap.flags) && eq(now.objects, snap.objects) &&
    refsEq(now.fleet, snap.fleet) && (snap.units === null ? now.units === null : refsEq(now.units, snap.units));
}

// Random play: seeded pointer presses and releases, right clicks and F-keys on the map; on any other stage, a fixed recovery cycle
// (right click, EXIT, random clicks) so that every window eventually closes. Counts only the updates that start on the map.
function playMap(label, updates, seed) {
  const rnd = mulberry32(seed);
  const KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "1", "2", "3", "4", "5", "6", "7", "8", "D", "Escape"];
  const stages = new Set();
  const limit = updates * 25;
  let mapUpdates = 0, total = 0, held = false, recovery = 0, recoveries = 0, px = 160, py = 128;
  let stuck = null;
  let lastStage = "";
  let same = 0;
  while (mapUpdates < updates && total < limit) {
    total++;
    const stage = game.stage;
    stages.add(stage);
    if (stage === lastStage) same++; else { same = 0; lastStage = stage; }
    if (stage !== "map" && same > 2000) { stuck = `${stage} for ${same} updates`; break; }
    const inp = { leftButton: false, rightButton: false, pointerX: px, pointerY: py, keys: [] };
    if (stage !== "map") {
      // Close whatever is open: a disk-picture EXIT, a window's button 9 (the map windows, `cmd(9)`), a full-screen overview's
      // exit (7), the council's outside release, a right click, and a random click (offers and other dialogs).
      held = false;
      recoveries++;
      recovery = (recovery + 1) % 10;
      const targets = [centre(Api.DISK_BUTTON.exit), Api.cmd(9), Api.overviewCentre(7), [195, 150], null];
      const t = targets[Math.floor(recovery / 2) % targets.length];
      if (recovery === 0) inp.rightButton = true;
      else if (recovery % 2 === 0) {
        const [x, y] = t ?? [Math.floor(rnd() * 320), Math.floor(rnd() * 256)];
        inp.leftButton = true; inp.pointerX = x; inp.pointerY = y;
      } else if (recovery % 2 === 1 && recovery > 1) { const [x, y] = t ?? [px, py]; inp.pointerX = x; inp.pointerY = y; }
    } else {
      mapUpdates++;
      recovery = 0;
      if (held) {
        if (rnd() < 0.5) held = false;
        else { px = Math.max(0, Math.min(319, px + Math.floor(rnd() * 9) - 4)); py = Math.max(0, Math.min(255, py + Math.floor(rnd() * 9) - 4)); }
      } else if (rnd() < 0.03) {
        held = true; px = Math.floor(rnd() * 320); py = Math.floor(rnd() * 256);
      }
      inp.leftButton = held; inp.pointerX = px; inp.pointerY = py;
      if (rnd() < 0.01) inp.rightButton = true;
      if (rnd() < 0.01) inp.keys = [KEYS[Math.floor(rnd() * KEYS.length)]];
    }
    try {
      game.update(inp);
    } catch (e) {
      return { label, error: `update ${total} (stage ${stage}): ${e instanceof Error ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)}`, mapUpdates, total, recoveries, stages: [...stages] };
    }
  }
  return { label, mapUpdates, total, recoveries, stages: [...stages], stuck };
}

// ---- the original disk.4 seed and the scenario-0 base state (read only) -----------------------------------------------------
// The base for synthetic images: the scenario's new-game state, from Disk.2 (as test/disk4-scene.mjs builds it).
function scenarioBase(disk2) {
  const records = Api.readScenarioRecords(disk2);
  const record = records[0];
  const state = new Api.GameState(disk2, record.block);
  const world = new Api.World(state, Api.loadMap(disk2, record));
  return { records, image: state.snapshot(), cells: world.cells.slice(), objects: world.objects.slice(), diskId: Api.readScenarioDiskId(disk2) };
}

const put16 = (b, o, v) => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
const offA = (addr) => addr - Api.DISK4_AREA_A_BASE;
const offB = (addr) => addr - Api.DISK4_AREA_B_BASE;
const recOffset = (i) => Api.DISK4_HEADER_OFFSET + Api.DISK4_RECORDS_OFFSET + i * Api.DISK4_RECORD_SIZE;
const SECTOR = 512;

// Writes populated slots into a copy of a raw image: name, the two area extents, area A (map words and objects), area B (the saved
// state block with the disk id and scenario index words; pins unplaced). `specs` = [{ index, name, a: [first, last], b: [first, last], diskId, scenario }].
function populate(raw, base, specs) {
  const img = raw.slice();
  for (const s of specs) {
    const rec = recOffset(s.index);
    for (let k = 0; k < 16; k++) img[rec + k] = k < s.name.length ? s.name.charCodeAt(k) : 0;
    put16(img, rec + 0x10, s.a[0]); put16(img, rec + 0x12, s.a[1]);
    put16(img, rec + 0x14, s.b[0]); put16(img, rec + 0x16, s.b[1]);
    if (s.a[0] > s.a[1] || s.b[0] > s.b[1]) continue; // extents the caller wants to break: nothing to fill
    const areaA = img.subarray(s.a[0] * SECTOR, s.a[0] * SECTOR + Api.DISK4_AREA_A_BYTES);
    if (areaA.length === Api.DISK4_AREA_A_BYTES) {
      areaA.fill(0);
      for (let y = 0; y < 75; y++) for (let x = 0; x < 100; x++) put16(areaA, offA(Api.DISK4_ADDR.mapCells) + (y * 102 + x) * 2, base.cells[y * 100 + x]);
      areaA.set(base.objects, offA(Api.DISK4_ADDR.objects));
    }
    const areaB = img.subarray(s.b[0] * SECTOR, s.b[0] * SECTOR + Api.DISK4_AREA_B_BYTES);
    if (areaB.length === Api.DISK4_AREA_B_BYTES) {
      areaB.fill(0);
      areaB.set(base.image);
      put16(areaB, offB(0x1453e), s.diskId);
      put16(areaB, offB(0x135c2), s.scenario);
      for (let i = 0; i < 8; i++) areaB[offB(0x14540 + 10 * i + 2)] = 0xff;
    }
  }
  return img;
}

// Raw image base: the user's own unpacked header when disk.4 is present (its ten records are all EMPTY), else a blank one.
function rawBase(realBytes) {
  if (realBytes) {
    const r = Api.parseDisk4Input(realBytes);
    if (r.ok) return r.value.image.bytes.slice();
  }
  const img = new Uint8Array(983040);
  for (let k = 0; k < 8; k++) img[Api.DISK4_HEADER_OFFSET + k] = Api.DISK4_SIGNATURE.charCodeAt(k);
  for (let i = 0; i < Api.DISK4_SLOT_COUNT; i++) for (let k = 0; k < 5; k++) img[recOffset(i) + k] = "EMPTY".charCodeAt(k);
  return img;
}

// The synthetic populated image used by A (playthrough, refusals) and B (mutants). Slot 0 is good; slot 1 names the wrong disk id
// (refused with a metadata error page); slot 2 names an out-of-table scenario index (recovery page).
function syntheticImage(raw, base) {
  return populate(raw, base, [
    { index: 0, name: "GOOD", a: [100, 172], b: [174, 184], diskId: base.diskId, scenario: 0 },
    { index: 1, name: "BADID", a: [200, 272], b: [274, 284], diskId: (base.diskId + 1) & 0xffff, scenario: 0 },
    { index: 2, name: "BADIDX", a: [300, 372], b: [374, 384], diskId: base.diskId, scenario: 0xffff },
  ]);
}

// Window exits for the recovery of random play (the same rectangles test/playthrough.mjs uses: the command table's button 9 and
// the overview's own button table, entry 7).
function setupWindowGeometry(disk1) {
  const ui = new Api.Ui(disk1, new Api.GameStrings(disk1, 0));
  const overviewImage = new Api.GameImage(disk1);
  Api.cmd = (i) => { const p = ui.buttonPosition(i); return [p.x + 8, p.y + 8]; };
  Api.overviewCentre = (i) => {
    const a = 0xff5c + 8 * i;
    return [(overviewImage.word(a) + overviewImage.word(a + 2)) >> 1, (overviewImage.word(a + 4) + overviewImage.word(a + 6)) >> 1];
  };
}

// ---- A. the real disk.4 and the synthetic populated image through the remake menu -------------------------------------------
async function sectionA(disk1, disk2, realBytes, base) {
  console.log("\n# A. disk.4 through the remake menu");
  const hashBefore = sha256(realBytes);

  // A1: the user's own file. Enter LOAD DISK.4 at the boot disk menu and try every slot the menu offers and every slot by the API.
  {
    game = bootGame(disk1, disk2, Api.Game);
    game.setDisk4(realBytes, "disk.4 (local)");
    idle();
    passBoot(game);
    rightClick();
    check("A1: boot remake submenu lists LOAD DISK.4 as enabled for the picked disk.4", game.stage === "remake" && labels()[3]?.startsWith("LOAD DISK.4") && enabledFlags()[3] === true, JSON.stringify(labels()));
    tapRow(3);
    check("A1: LOAD DISK.4 opens the slot list with ten rows", game.stage === "d4slot" && labels().length === 10, `stage ${game.stage} rows ${labels().length}`);
    const offered = labels().map((l, i) => ({ l, on: enabledFlags()[i] }));
    console.log(`     offered slots: ${offered.map((o, i) => `${i + 1}=${o.l.replace(/^SLOT \d+\s+/, "")}${o.on ? "(enabled)" : "(disabled)"}`).join(" ")}`);
    const enabledCount = offered.filter((o) => o.on).length;
    check("A1: no slot of the user's disk.4 is enabled (none is populated)", enabledCount === 0, `${enabledCount} enabled`);
    for (let i = 0; i < 10; i++) {
      tapRow(i);
    }
    check("A1: clicking the disabled rows activates nothing and stays on the slot list", game.stage === "d4slot" && game.lastDisk4Error === null && game.map === null && game.importedDisk4 === null);
    rightClick();
    check("A1: right click leaves the slot list for the boot disk menu", game.stage === "disk" && game.heldScene === null && game.map === null);
    // The same call the menu makes, slot by slot: every refusal must be the typed EMPTY error and leave the boot menu open.
    const codes = [];
    for (let i = 0; i < 10; i++) {
      const r = game.activateDisk4({ bytes: realBytes, slot: i, source: "disk.4 (local)", pick: true });
      codes.push(r.ok ? "activated" : `${describeError(r.error)}`);
    }
    console.log(`     API result per slot 1-10: ${codes.join(", ")}`);
    check("A1: every slot of the user's disk.4 is refused with inspect/slot/slot-empty", codes.every((c) => c === "inspect/slot/slot-empty"), codes.join(","));
    check("A1: the refusals keep the boot disk menu, no scene and no held session", game.stage === "disk" && game.heldScene === null && game.map === null && game.importedDisk4 === null && game.lastDisk4Error !== null);
    check("A1: the user's disk.4 bytes are unchanged by all of the above (read only)", sha256(realBytes) === hashBefore);
  }

  // A2: a synthetic populated image built in memory from the real header. One slot activates and is played; two refusals are
  // checked through their error pages, then the good slot is activated again and played for 20,000 map updates.
  {
    const synth = syntheticImage(rawBase(realBytes), base);
    game = bootGame(disk1, disk2, Api.Game);
    game.setDisk4(synth, "synthetic populated image");
    idle();
    passBoot(game);
    rightClick();
    tapRow(3);
    check("A2: the synthetic image offers GOOD, BADID and BADIDX as enabled slots", labels()[0] === "SLOT 1  GOOD" && labels()[1] === "SLOT 2  BADID" && labels()[2] === "SLOT 3  BADIDX" && enabledFlags().slice(0, 3).every(Boolean) && enabledFlags().slice(3).every((x) => !x), JSON.stringify(labels()));
    tapRow(0);
    check("A2: the good slot activates from the boot menu and is held until EXIT", game.stage === "disk" && game.heldScene !== null && game.map === null && game.lastDisk4Error === null, `stage ${game.stage}`);
    iconClick(Api.DISK_BUTTON.exit);
    check("A2: EXIT enters the activated slot 1 (imported session, restored scene)", game.stage === "map" && game.importedDisk4?.slot === 0 && game.map?.restoredFromDisk4 === true, `stage ${game.stage}`);
    const s1 = mapSnapshot(game.map);
    const session1 = game.importedDisk4;

    openDisk();
    rightClick();
    tapRow(3);
    tapRow(1); // BADID
    check("A2: BADID (wrong disk id) shows the DISK.4 LOAD FAILED page with the typed metadata code", game.stage === "d4error" && labels().some((l) => l.includes("unsupported-disk-id")), `stage ${game.stage} ${JSON.stringify(labels())}`);
    check("A2: the failed BADID activation leaves the running scene, session and error record as they were before", mapUnchanged(s1) && game.importedDisk4 === session1 && game.lastDisk4Error !== null);
    rightClick();
    check("A2: right click leaves the error page for the disk menu", game.stage === "disk" && mapUnchanged(s1));

    rightClick();
    tapRow(3);
    tapRow(2); // BADIDX
    check("A2: BADIDX (out-of-table saved index) opens the recovery page, not an error page", game.stage === "d4scenario", `stage ${game.stage}`);
    rightClick();
    check("A2: right click leaves the recovery page for the disk menu with the scene intact", game.stage === "disk" && mapUnchanged(s1) && game.importedDisk4 === session1);

    rightClick();
    tapRow(3);
    tapRow(0); // GOOD again: a new scene replaces the old one
    check("A2: the good slot activates again and is held", game.stage === "disk" && game.heldScene !== null);
    iconClick(Api.DISK_BUTTON.exit);
    check("A2: EXIT enters the second activation", game.stage === "map" && game.importedDisk4?.slot === 0 && game.map !== s1.map);

    const run = playMap("A2 random play (seed 20260711)", 20000, 20260711);
    console.log(`     play: ${run.mapUpdates} map updates in ${run.total} updates, ${run.recoveries} recovery updates, stages seen: ${run.stages.join(", ")}${run.stuck ? `, stuck: ${run.stuck}` : ""}`);
    check("A2: 20,000 map updates of the activated slot with seeded random input and windows opened run without an exception", run.error === undefined && run.mapUpdates >= 20000, run.error ?? `${run.mapUpdates} map updates${run.stuck ? ` (stuck: ${run.stuck})` : ""}`);
    console.log(`     end of play: date ${game.map?.world.state.dateText?.() ?? "?"}, game over ${game.map?.sim.gameOver === true}, stage ${game.stage}`);
    check("A2: the random play opened more than one kind of window (stages seen beyond the map)", run.stages.length > 2, run.stages.join(","));
    check("A2: the imported session is still active after the play", game.importedDisk4?.slot === 0 && game.map?.restoredFromDisk4 === true);
    check("A2: the remake save is still refused for the imported session", guard("A2 save refusal", () => game.saveToSlot(5) === false && game.lastSaveError?.code === "disk4-session"));
  }
  check("the user's disk.4 bytes are unchanged at the end of section A", sha256(realBytes) === hashBefore);
}

// ---- C. storage failures through the real save and load menus -----------------------------------------------------------------
function mapTo(stageWanted) {
  for (let n = 0; n < 6 && game.stage !== stageWanted; n++) {
    if (game.stage === "map") { openDisk(); continue; }
    if (game.stage === "disk") { iconClick(Api.DISK_BUTTON.exit); continue; }
    rightClick();
  }
  return game.stage === stageWanted;
}
function backToMap() {
  for (let n = 0; n < 6 && game.stage !== "map"; n++) {
    if (game.stage === "disk") iconClick(Api.DISK_BUTTON.exit);
    else rightClick();
  }
  return game.stage === "map";
}

async function sectionC(disk1, disk2, base) {
  console.log("\n# C. storage failures through the real menus");
  // A running game: boot, pick scenario 1 from the list and EXIT into the map (real clicks).
  game = bootGame(disk1, disk2, Api.Game);
  idle();
  passBoot(game);
  scenarioIcon();
  tapListRow(0);
  iconClick(Api.DISK_BUTTON.exit);
  check("C setup: the game is running on the map", game.stage === "map" && game.map !== null);
  const SLOT_OK = 0, SLOT_BAD_JSON = 3, SLOT_TRUNC = 4, SLOT_B64 = 5, SLOT_TYPE = 6, SLOT_VER = 7, SLOT_EMPTY = 1, SLOT_QUOTA = 2;
  const key = (slot) => `utopia-remake-save-${slot}`;

  // Control: a normal save and load round trip through the menus (also produces the valid text the mutations start from).
  const beforeSave = mapSnapshot(game.map);
  openDisk(); rightClick(); tapRow(0); tapRow(SLOT_OK);
  check("C0 control: a normal SAVE GAME writes slot 1 (stage save, no error)", game.stage === "save" && game.lastSaveError === null && store.has(key(SLOT_OK)), `stage ${game.stage} ${game.lastSaveError?.code}`);
  check("C0 control: the save leaves the running map unchanged", mapUnchanged(beforeSave));
  rightClick();
  iconClick(Api.DISK_BUTTON.exit);
  const validText = store.get(key(SLOT_OK));
  // Each mutation case below stores its text in a slot of its own, so the cases do not interfere.
  const VALID = validText;

  // Runs one remake operation from the map, then recovers to the map. Returns what the screen and game showed.
  function operate(op, slot) {
    const snap = mapSnapshot(game.map);
    let stage = "";
    guard(`C ${op} slot ${slot + 1}`, () => {
      if (!mapTo("map")) throw new Error(`could not reach the map (stage ${game.stage})`);
      openDisk(); rightClick(); tapRow(op === "save" ? 0 : 1); tapRow(slot);
      stage = game.stage;
    });
    const shown = { stage, labels: labels(), lastSave: game.lastSaveError?.code ?? null, lastLoad: game.lastLoadError?.code ?? null, unchanged: mapUnchanged(snap) };
    guard(`C ${op} slot ${slot + 1} back`, () => { backToMap(); });
    shown.backOnMap = game.stage === "map";
    return shown;
  }

  // C1: no localStorage at all.
  {
    delete globalThis.localStorage;
    const r = guard("C1 save with no localStorage", () => operate("save", SLOT_QUOTA));
    check("C1 save with no localStorage: an error page (SAVE FAILED) with code no-storage", r?.stage === "sloterror" && r.lastSave === "no-storage" && r.labels.some((l) => l.includes("CODE: no-storage")), `stage ${r?.stage} code ${r?.lastSave}`);
    check("C1 save with no localStorage: the running map is unchanged and the game returns to the map", r?.unchanged === true && r?.backOnMap === true);
    const l = guard("C1 load with no localStorage", () => operate("load", SLOT_OK));
    globalThis.localStorage = SHIM;
    check("C1 load with no localStorage: an error page with code no-storage; map unchanged; back on the map", l?.stage === "sloterror" && l.lastLoad === "no-storage" && l.unchanged === true && l.backOnMap === true, `stage ${l?.stage} code ${l?.lastLoad}`);
  }

  // C2: the storage refuses the write (quota exceeded). The slot already holds a valid save: a failed save must not damage it.
  {
    const before = store.get(key(SLOT_OK));
    storageState.mode = "setThrows";
    const r = guard("C2 save with quota", () => operate("save", SLOT_OK));
    storageState.mode = "ok";
    check("C2 save with setItem throwing: an error page with code write-failed", r?.stage === "sloterror" && r.lastSave === "write-failed" && r.labels.some((l) => l.includes("CODE: write-failed")), `stage ${r?.stage} code ${r?.lastSave}`);
    check("C2 save with setItem throwing: the running map is unchanged and the game returns to the map", r?.unchanged === true && r?.backOnMap === true);
    check("C2 save with setItem throwing: the valid save already in the slot is kept byte for byte", store.get(key(SLOT_OK)) === before);
  }

  // C3: reading storage throws; writing works. A save does not read the slot, so it succeeds. A load then reports no-storage.
  {
    storageState.mode = "getThrows";
    const s = guard("C3 save with getItem throwing", () => operate("save", SLOT_EMPTY));
    storageState.mode = "ok";
    check("C3 save with getItem throwing (setItem fine): the save succeeds without an error page", s?.stage === "save" && s.lastSave === null && s.unchanged === true && store.has(key(SLOT_EMPTY)), `stage ${s?.stage} code ${s?.lastSave}`);
    storageState.mode = "getThrows";
    const l = guard("C3 load with getItem throwing", () => operate("load", SLOT_EMPTY));
    storageState.mode = "ok";
    check("C3 load with getItem throwing: an error page with code no-storage, map unchanged, back on the map", l?.stage === "sloterror" && l.lastLoad === "no-storage" && l.unchanged === true && l.backOnMap === true, `stage ${l?.stage} code ${l?.lastLoad}`);
  }

  // C4-C9: stored text that is not a valid save. Each load must show the load error page and leave the map alone.
  const truncated = VALID.slice(0, Math.floor(VALID.length / 2));
  const parsed = JSON.parse(VALID);
  const b64 = { ...parsed, state: parsed.state.slice(0, 40) };
  const wrongType = { ...parsed, scenario: "2" };
  const unknownVersion = { ...parsed, version: 99 };
  const cases = [
    ["C4 invalid JSON", SLOT_BAD_JSON, "{not json at all", ["corrupt"]],
    ["C5 truncated text (half a save)", SLOT_TRUNC, truncated, ["corrupt"]],
    ["C6 valid JSON with a truncated binary part", SLOT_B64, JSON.stringify(b64), ["corrupt", "invalid"]],
    ["C7 wrong type (scenario stored as a string)", SLOT_TYPE, JSON.stringify(wrongType), ["invalid", "corrupt"]],
    ["C8 unknown save version (99)", SLOT_VER, JSON.stringify(unknownVersion), ["unsupported-version"]],
  ];
  for (const [label, slot, text, codes] of cases) {
    store.set(key(slot), text);
    const r = guard(label, () => operate("load", slot));
    check(`${label}: an error page with a typed code (${codes.join(" or ")}), map unchanged, back on the map`, r?.stage === "sloterror" && codes.includes(r.lastLoad) && r.labels.some((l) => l.startsWith("CODE: ")) && r.unchanged === true && r.backOnMap === true, `stage ${r?.stage} code ${r?.lastLoad} labels ${JSON.stringify(r?.labels?.slice(0, 2))}`);
  }

  // C9: an empty slot stays on the load list with the empty-record prompt (the traced $143 path), not an error page.
  {
    store.delete(key(7));
    const r = guard("C9 empty slot", () => {
      if (!mapTo("map")) throw new Error("no map");
      openDisk(); rightClick(); tapRow(1); tapRow(7);
      return { stage: game.stage, code: game.lastLoadError?.code ?? null, unchanged: mapUnchanged(mapSnapshot(game.map)) };
    });
    check("C9 load of an empty slot: stays on the load list with code empty and the map unchanged", r?.stage === "load" && r.code === "empty" && r.unchanged === true, `stage ${r?.stage} code ${r?.code}`);
    backToMap();
  }

  // C10: a save into a slot holding invalid text succeeds (a save never reads the slot), and the slot then loads.
  {
    store.set(key(SLOT_BAD_JSON), "garbage");
    const s = guard("C10 save over invalid text", () => operate("save", SLOT_BAD_JSON));
    check("C10 save over invalid text: succeeds, no error page, map unchanged", s?.stage === "save" && s.lastSave === null && s.unchanged === true, `stage ${s?.stage} code ${s?.lastSave}`);
    const l = guard("C10 reload", () => operate("load", SLOT_BAD_JSON));
    check("C10 the overwritten slot loads without an error (the loaded scene is held on the disk menu until EXIT)", l?.lastLoad === null && l.stage === "disk", `stage ${l?.stage} code ${l?.lastLoad}`);
    backToMap();
  }

  // C11: a valid slot still loads after all of the above (control).
  {
    const l = guard("C11 valid load", () => operate("load", SLOT_OK));
    check("C11 control: a valid slot loads without an error (held on the disk menu until EXIT)", l?.lastLoad === null && l.stage === "disk", `stage ${l?.stage} code ${l?.lastLoad}`);
  }
  check("C end: the game is back on the map after the storage cases", game.stage === "map");
}

// ---- D. wrong folders given to startFromFiles -------------------------------------------------------------------------------------
async function sectionD(disk1, disk2, realDisk4) {
  console.log("\n# D. wrong folders given to startFromFiles");
  const { startFromFiles } = Api;
  const file = (name, bytes, size = bytes.length, read = null) => ({ name, size, read: read ?? (async () => bytes) });
  const zeros = (n) => new Uint8Array(n);
  const calls = [];
  const factories = {
    createMusic: () => { calls.push("music"); return {}; },
    createSfx: () => { calls.push("sfx"); return {}; },
    createGame: () => { calls.push("game"); return {}; },
  };
  const run = async (name, files) => {
    calls.length = 0;
    try {
      const r = await startFromFiles(files, factories);
      return { r, calls: [...calls] };
    } catch (e) {
      return { threw: e, calls: [...calls] };
    }
  };
  // The real recognised set: Disk.1, Disk.2 and Utopia.Slave (the profile requires the slave at its size; its bytes are not validated).
  const slavePath = path.join(origDir, "Utopia.Slave");
  const slave = fs.existsSync(slavePath) ? new Uint8Array(fs.readFileSync(slavePath)) : zeros(1264);
  const slaveFile = () => file("Utopia.Slave", slave, slave.length);
  const realFiles = () => [file("Disk.1", disk1, disk1.length), file("Disk.2", disk2, disk2.length), slaveFile()];
  const refusedCleanly = (x, codes) => x.r && x.r.ok === false && Array.isArray(x.r.errors) && x.r.errors.length > 0 && (codes === undefined || x.r.errors.some((e) => codes.includes(e.code))) && x.calls.length === 0;

  const control = await run("control", realFiles());
  check("D control: the user's Disk.1 and Disk.2 start the game (factories run once each, in order)", control.r?.ok === true && control.calls.join() === "music,sfx,game", JSON.stringify(control.r?.errors ?? control.threw?.message));

  let x = await run("empty", []);
  check("D1 empty folder: a typed missing-file error, no factory, no exception", !x.threw && refusedCleanly(x, ["missing-file"]), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors?.map((e) => e.code)));

  x = await run("only Disk.1", [file("Disk.1", disk1, disk1.length)]);
  check("D2 only Disk.1: missing-file error for Disk.2, no factory", !x.threw && refusedCleanly(x, ["missing-file"]) && x.r.errors.some((e) => e.file === "Disk.2"), JSON.stringify(x.r?.errors));

  x = await run("only Disk.2", [file("Disk.2", disk2, disk2.length), slaveFile()]);
  check("D3 only Disk.2: missing-file error for Disk.1, no factory", !x.threw && refusedCleanly(x, ["missing-file"]), JSON.stringify(x.r?.errors));

  x = await run("Disk.2 one byte too large", [file("Disk.1", disk1, disk1.length), file("Disk.2", disk2, disk2.length + 1), slaveFile()]);
  check("D4 wrong declared size of Disk.2: file-size-mismatch, no factory", !x.threw && refusedCleanly(x, ["file-size-mismatch"]), JSON.stringify(x.r?.errors));

  const shortDisk1 = disk1.slice(0, 1000);
  x = await run("Disk.1 truncated, size declared right", [file("Disk.1", shortDisk1, disk1.length), file("Disk.2", disk2, disk2.length), slaveFile()]);
  check("D5 Disk.1 declared at the right size but holding 1000 bytes: refused by the byte checks, no exception, no factory", !x.threw && refusedCleanly(x), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors?.map((e) => e.code)));

  x = await run("Disk.1 zero-filled", [file("Disk.1", zeros(disk1.length)), file("Disk.2", disk2, disk2.length), slaveFile()]);
  check("D6 Disk.1 with the right size but zero bytes: refused by the byte checks, no factory", !x.threw && refusedCleanly(x), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors?.map((e) => e.code)));

  x = await run("duplicate DISK.1 first", [file("DISK.1", zeros(disk1.length)), file("Disk.1", disk1, disk1.length), file("Disk.2", disk2, disk2.length), slaveFile()]);
  check("D7 two names differing only by case, the wrong one first: no exception; the first match is used (documented in detect.ts), so it is refused", !x.threw && refusedCleanly(x), x.threw ? String(x.threw) : `ok=${x.r?.ok}`);

  x = await run("duplicate disk.1 second", [file("Disk.1", disk1, disk1.length), file("disk.1", zeros(disk1.length)), file("Disk.2", disk2, disk2.length), slaveFile()]);
  check("D8 two names differing only by case, the right one first: no exception; the first match is used and the game starts", !x.threw && x.r?.ok === true && x.calls.join() === "music,sfx,game", x.threw ? String(x.threw) : JSON.stringify(x.r?.errors));

  x = await run("extra files", [...realFiles(), file("Hints", zeros(1200)), file("Utopia.Slave.bak", zeros(1264)), file("readme.txt", new TextEncoder().encode("hello"))]);
  check("D9 extra files next to the real set are ignored: the game starts", !x.threw && x.r?.ok === true && x.calls.length === 3, x.threw ? String(x.threw) : JSON.stringify(x.r?.errors));

  x = await run("subfolder only", [file("Utopia/Disk.1", disk1, disk1.length), file("Utopia/Disk.2", disk2, disk2.length)]);
  check("D10 the real files only inside a subfolder (names carry the path): missing-file, no factory, no exception", !x.threw && refusedCleanly(x, ["missing-file"]), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors?.map((e) => e.file)));

  x = await run("subfolder decoy", [file("old/Disk.1", zeros(disk1.length)), ...realFiles()]);
  check("D11 a subfolder decoy named like Disk.1 next to the top-level files: the top-level files are used and the game starts", !x.threw && x.r?.ok === true, x.threw ? String(x.threw) : JSON.stringify(x.r?.errors));

  x = await run("Disk.1 read rejects", [file("Disk.1", null, disk1.length, async () => { throw new Error("EIO: read error"); }), file("Disk.2", disk2, disk2.length), slaveFile()]);
  check("D12 Disk.1 read rejects: read-failed error naming the file, no factory", !x.threw && refusedCleanly(x, ["read-failed"]) && x.r.errors.some((e) => e.file === "Disk.1" && e.message.includes("EIO")), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors));

  x = await run("Disk.2 read rejects", [file("Disk.1", disk1, disk1.length), file("Disk.2", null, disk2.length, async () => { throw new Error("NotReadableError"); }), slaveFile()]);
  check("D13 Disk.2 read rejects: read-failed error naming the file, no factory", !x.threw && refusedCleanly(x, ["read-failed"]), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors));

  x = await run("disk.4 read rejects", [...realFiles(), file("disk.4", null, 656, async () => { throw new Error("disk removed"); })]);
  check("D14 disk.4 read rejects: the game starts without it, with a disk4-unreadable warning", !x.threw && x.r?.ok === true && x.r.warnings?.some((w) => w.code === "disk4-unreadable") && !x.r.input?.disk4, x.threw ? String(x.threw) : JSON.stringify(x.r?.warnings));

  x = await run("Disk.1 read resolves null", [file("Disk.1", null, disk1.length, async () => null), file("Disk.2", disk2, disk2.length), slaveFile()]);
  check("D15 Disk.1 read resolves null (not bytes): a typed refusal, no exception, no factory", !x.threw && refusedCleanly(x), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors?.map((e) => e.code)));

  x = await run("Disk.2 read resolves a plain array", [file("Disk.1", disk1, disk1.length), file("Disk.2", null, disk2.length, async () => Array.from(disk2.slice(0, 64)))]);
  check("D16 Disk.2 read resolves a plain array of 64 bytes: a typed refusal, no exception, no factory", !x.threw && refusedCleanly(x), x.threw ? String(x.threw) : JSON.stringify(x.r?.errors?.map((e) => e.code)));

  if (realDisk4) {
    x = await run("real disk.4 added", [...realFiles(), file("disk.4", realDisk4, realDisk4.length)]);
    check("D17 the real disk.4 added to the real set: the game starts with the Disk.4 bytes kept for the continuation", !x.threw && x.r?.ok === true && x.r.input?.disk4 !== undefined && x.r.input?.disk4 !== null, x.threw ? String(x.threw) : JSON.stringify(x.r?.errors));
  }
}

// ---- B. mutated disk.4 images (runs in a child process; see main) -------------------------------------------------------------
async function runMutants(disk1, disk2, realDisk4, base) {
  const LIMIT_MS = 10000;
  const strings = new (await dist("data/gamestrings.js")).GameStrings(disk1, 0);
  const raw = rawBase(realDisk4);
  const good = syntheticImage(raw, base);
  const rnd = mulberry32(991);
  const cases = [];
  const add = (label, bytes, slot = 0, extra = {}) => cases.push({ label, bytes, slot, extra });

  // Truncations of the populated image.
  const cut = [0, 1, 8, 100, 512, Api.DISK4_HEADER_OFFSET, Api.DISK4_HEADER_OFFSET + 10, Api.DISK4_HEADER_OFFSET + 0x41, 200 * SECTOR, 372 * SECTOR, 372 * SECTOR + 100, 983040 - 1];
  for (const n of cut) add(`truncated raw image to ${n} bytes`, good.slice(0, n));
  // Truncated XPK seed (the user's own file, cut).
  if (realDisk4) for (const n of [0, 4, 8, 40, 300, realDisk4.length - 1]) add(`truncated XPK seed to ${n} bytes`, realDisk4.slice(0, n));
  // Random byte flips (half inside the header area) on the populated image.
  for (let i = 0; i < 40; i++) {
    const m = good.slice();
    const flips = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < flips; k++) {
      const at = rnd() < 0.5 ? Api.DISK4_HEADER_OFFSET + Math.floor(rnd() * 700) : Math.floor(rnd() * m.length);
      m[at] = Math.floor(rnd() * 256);
    }
    add(`random byte flips #${i + 1} (${flips} bytes) in the populated image`, m);
  }
  // Random flips in the XPK seed (only when the user's file is present).
  if (realDisk4) for (let i = 0; i < 25; i++) {
    const m = realDisk4.slice();
    const flips = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < flips; k++) m[Math.floor(rnd() * m.length)] = Math.floor(rnd() * 256);
    add(`random byte flips #${i + 1} in the XPK seed`, m);
  }
  // Wrong magic: each signature byte replaced, all zero, lower case, and a wrong container id.
  for (let k = 0; k < 8; k++) { const m = good.slice(); m[Api.DISK4_HEADER_OFFSET + k] = 0x58; add(`signature byte ${k} replaced`, m); }
  { const m = good.slice(); m.fill(0, Api.DISK4_HEADER_OFFSET, Api.DISK4_HEADER_OFFSET + 8); add("signature zeroed", m); }
  { const m = good.slice(); for (let k = 0; k < 8; k++) m[Api.DISK4_HEADER_OFFSET + k] |= 0x20; add("signature lower case", m); }
  if (realDisk4) { const m = realDisk4.slice(); m[0] = 0x59; add("XPK magic changed", m); }
  // Huge or impossible declared sizes in the header records (slot 0 is the populated one).
  const extentCases = [
    ["area A last sector 0xFFFF", [100, 0xffff], [174, 184]],
    ["area A first 0xFFFF", [0xffff, 0xffff], [174, 184]],
    ["area A reversed", [172, 100], [174, 184]],
    ["area A 65536 sectors (0 to 0xFFFF)", [0, 0xffff], [174, 184]],
    ["area B last sector 0xFFFF", [100, 172], [174, 0xffff]],
    ["area B first beyond the image", [100, 172], [0xfffe, 0xffff]],
    ["area A overlapping the header", [0x3be, 0x3c8], [174, 184]],
    ["area B overlapping area A", [100, 172], [150, 160]],
  ];
  for (const [label, a, b] of extentCases) add(`header extents: ${label}`, populate(raw, base, [{ index: 0, name: "HUGE", a, b, diskId: base.diskId, scenario: 0 }]));
  // Odd names and counts: blank name, a name of the wrong length.
  { const m = good.slice(); m[recOffset(0)] = 0; add("record name blank", m); }
  { const m = good.slice(); for (let k = 0; k < 16; k++) m[recOffset(0) + k] = 0x41; add("record name with no NUL", m); }
  // Huge declared sizes of the XPK container (checksum repaired so the size checks are what is tested).
  if (realDisk4) {
    const xpkWith = (rawLength, packed = realDisk4.length - 8, codec = 0x4d415348, flags = realDisk4[32]) => {
      const m = realDisk4.slice();
      const put32 = (o, v) => { m[o] = (v >>> 24) & 0xff; m[o + 1] = (v >>> 16) & 0xff; m[o + 2] = (v >>> 8) & 0xff; m[o + 3] = v & 0xff; };
      put32(4, packed); put32(8, codec); put32(12, rawLength); m[32] = flags;
      let x = 0; for (let i = 0; i < 35; i++) x ^= m[i];
      m[35] = x; // the XOR of the first 36 bytes must be zero
      return m;
    };
    add("XPK declared raw size 0xFFFFFFFF", xpkWith(0xffffffff));
    add("XPK declared raw size 0x7FFFFFFF", xpkWith(0x7fffffff));
    add("XPK declared raw size just over the decoder limit", xpkWith(0x00100001));
    add("XPK declared raw size 0x0FFFFFFF", xpkWith(0x0fffffff));
    add("XPK declared raw size zero", xpkWith(0));
    add("XPK packed size 0xFFFFFFFF", xpkWith(983040, 0xffffffff));
    add("XPK packed size zero", xpkWith(983040, 0));
    add("XPK codec not MASH", xpkWith(983040, undefined, 0x4c5a5353));
    add("XPK password flag", xpkWith(983040, undefined, undefined, realDisk4[32] | 2));
  }
  // Argument types and slot numbers.
  add("bytes is a plain array", Array.from(good.subarray(0, 4096)));
  add("bytes is an ArrayBuffer", good.buffer.slice(0));
  add("bytes is undefined", undefined);
  add("bytes is null", null);
  add("bytes is a string", "UTOPSAVE");
  for (const slot of [-1, 10, 1.5, "0", NaN]) add(`slot ${String(slot)}`, good, slot);
  for (const r of [-1, 1.5, "3", NaN, 10]) add(`recovery index ${String(r)} on the good image`, good, 0, { recoverScenario: r });

  // Run. Each case gets a fresh Game and the same stage the boot session gives after the boot stages (the scenario list).
  for (const c of cases) {
    console.log(`START\t${c.label}`);
    const t0 = performance.now();
    let verdict;
    try {
      const g = new Api.Game(disk1, disk2);
      g.strings = strings;
      g.bootMenuOpen = false;
      g.stage = "scenario";
      const res = g.activateDisk4({ bytes: c.bytes, slot: c.slot, source: "mutant", ...c.extra });
      verdict = res.ok ? "success" : `error:${describeError(res.error)}`;
    } catch (e) {
      verdict = `THREW:${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    }
    const ms = Math.round(performance.now() - t0);
    console.log(`CASE\t${c.label}\t${ms}\t${verdict.replace(/[\r\n\t]/g, " ")}`);
  }
  void LIMIT_MS;
}

async function mutantSection(disk1, disk2, realDisk4, base) {
  console.log("\n# B. mutated disk.4 images (child process, a hang is a failed case)");
  const LIMIT_MS = 10000;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ROBUST_MUTANT_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { err += d.toString(); });
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; child.kill(); }, 110000);
  const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
  clearTimeout(killer);
  const lines = out.split("\n").filter(Boolean);
  const started = new Set();
  const done = new Set();
  let last = null;
  let cases = 0;
  const tally = new Map();
  let slowest = 0;
  for (const line of lines) {
    const [kind, name, ms, verdict] = line.split("\t");
    if (kind === "START") { last = name; started.add(name); }
    else if (kind === "CASE") {
      cases++;
      done.add(name);
      const msNum = Number(ms);
      slowest = Math.max(slowest, msNum);
      const threw = verdict.startsWith("THREW:");
      const slow = msNum > LIMIT_MS;
      tally.set(verdict, (tally.get(verdict) ?? 0) + 1);
      check(`B mutant: ${name} (typed error or success, no throw, < ${LIMIT_MS / 1000} s)`, !threw && !slow, threw ? verdict : slow ? `${msNum} ms` : `${verdict} in ${msNum} ms`);
    }
  }
  console.log(`     verdicts over ${cases} cases (slowest ${slowest} ms): ${[...tally].map(([v, n]) => `${v} x${n}`).join("; ")}`);
  if (timedOut || (last !== null && !done.has(last))) {
    check(`B mutant: ${last ?? "(no case started)"} finishes (no hang)`, false, timedOut ? "the child process hit the 110 s limit and was stopped" : "the child exited without finishing this case");
  }
  if (cases === 0 && code !== 0) check("B child process ran", false, err.split("\n").slice(0, 3).join(" | ") || `exit ${code}`);
  void disk1; void disk2; void realDisk4; void base;
}

// ---- main -------------------------------------------------------------------------------------------------------------------------
if (CHILD) {
  const { readFileSync } = fs;
  const disk1 = new Uint8Array(readFileSync(d1Path));
  const disk2 = new Uint8Array(readFileSync(d2Path));
  Api = await loadApi();
  const base = scenarioBase(disk2);
  const realDisk4 = fs.existsSync(d4Path) ? new Uint8Array(readFileSync(d4Path)) : null;
  await runMutants(disk1, disk2, realDisk4, base);
} else {
  if (!fs.existsSync(d1Path) || !fs.existsSync(d2Path)) {
    skip("robustness checks need original/utopia-whdload/Disk.1 and Disk.2 (not found)");
    process.exit(0);
  }
  const disk1 = new Uint8Array(fs.readFileSync(d1Path));
  const disk2 = new Uint8Array(fs.readFileSync(d2Path));
  Api = await loadApi();
  const base = scenarioBase(disk2);
  const realDisk4 = fs.existsSync(d4Path) ? new Uint8Array(fs.readFileSync(d4Path)) : null;
  if (!realDisk4) skip("disk.4 not found: section A1 and the XPK cases are skipped (A2 uses a synthetic image)");
  setupWindowGeometry(disk1);
  const startedAt = Date.now();
  if (realDisk4) await sectionA(disk1, disk2, realDisk4, base);
  else console.log("\n# A. (skipped: no disk.4)");
  await sectionC(disk1, disk2, base);
  await sectionD(disk1, disk2, realDisk4);
  await mutantSection(disk1, disk2, realDisk4, base);
  console.log(`\nrobustness: ${passed} ok, ${failed} FAIL (${Math.round((Date.now() - startedAt) / 1000)} s)`);
  process.exit(failed === 0 ? 0 : 1);
}
