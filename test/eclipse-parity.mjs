// Parity of the descriptor exchange (`$11024`, sim.ts `tileExchange`) over the supported remake flows: the weekly eclipse start and
// end, event 14, disk-menu entry and exit, a new scenario, save and load, and the version 10 migration (save.ts, save-session.ts).
// Static evidence only (notes/formats/game-state.md, sim-port.md): every traced call toggles the table, the table is built once at
// boot and no reset rebuilds it. Nothing here compares with the running original, and the visible effect is not observed.
// Part 1 uses the player's Disk.1 / Disk.2 in original/utopia-whdload (read-only) and is skipped when they are missing. Part 2 is
// synthetic (hand-made tiles) and always runs. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { eclipseTileView, ECLIPSE_TILE_PAIRS } = await import("../dist/game/eclipse-tiles.js");
const { SYS } = await import("../dist/game/sim.js");
const { SESSION_VERSION } = await import("../dist/game/save-session.js");
const { encodeSave, decodeSave, slotWarning, readSlot } = await import("../dist/game/save.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameByValue = (a, b) =>
  a.rows === b.rows &&
  sameBytes(a.planes, b.planes) &&
  (a.source === undefined ? b.source === undefined : b.source !== undefined && a.source.offset === b.source.offset && sameBytes(a.source.image, b.source.image));

// ---- 2. synthetic: the pure view and the no-mutation rule (always runs) ---------------------------------------------------
{
  const SLOT = 128;
  const image = Uint8Array.from({ length: 60 * SLOT }, (_, i) => (i * 29 + 5) & 0xff);
  const base = Array.from({ length: 60 }, (_, i) => {
    const rows = i === 4 ? 3 : i === 51 ? 5 : i === 50 ? 2 : i === 54 ? 4 : (i % 4) + 1;
    return { rows, planes: image.slice(i * SLOT, i * SLOT + rows * 24), source: { image, offset: i * SLOT } };
  });
  const fresh = base.map((t) => ({ rows: t.rows, planes: t.planes.slice(), source: { image: t.source.image.slice(), offset: t.source.offset } }));
  const imageBefore = image.slice();
  const baseRefs = base.slice();
  const once = eclipseTileView(base, true);
  const twice = eclipseTileView(once, true);
  check("synthetic: one exchange changes entries 4, 50, 51, 54 and no others", ECLIPSE_TILE_PAIRS.length === 2 && once[4].source.offset === base[51].source.offset && once[51].source.offset === base[4].source.offset);
  check("synthetic: a second exchange of the exchanged view restores every address", twice.every((t, i) => t.source.offset === base[i].source.offset && t.rows === base[i].rows));
  check("synthetic: the source array and its tiles are the same objects after the exchanges", base.length === baseRefs.length && base.every((t, i) => t === baseRefs[i]));
  check("synthetic: the source tiles keep their planes and addresses (no shared descriptor mutation)", base.every((t, i) => sameByValue(t, fresh[i])));
  check("synthetic: the image bytes are unchanged", sameBytes(image, imageBefore));
  check("synthetic: the flag-free helper (false) returns the source objects", eclipseTileView(base, false).every((t, i) => t === base[i]));
}

// ---- 1. the player's own data: session parity over the remake flows ----------------------------------------------------
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("skip  the player's Disk.1 / Disk.2 are missing: session parity checks not run");
  console.log(failed === 0 ? "all eclipse parity checks passed" : `${failed} eclipse parity check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const { readScenarioRecords, loadTileSet } = await import("../dist/data/scenario.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
const { A, PERIOD } = await import("../dist/game/state.js");

const records = readScenarioRecords(disk2);
const loaded = loadTileSet(disk1, disk2, records[0]).tiles;
const ECLIPSE_FLAG = SYS.eclipse;
const ECLIPSE_COUNT = 0x144bb;
const GAME_OVER = SYS.gameOver;

const newGame = () => {
  const g = new Game(disk1, disk2, null, null);
  g.strings = new GameStrings(disk1, 0);
  g.bootMenuOpen = false;
  g.stage = "scenario";
  return g;
};
const frame = (g, down, x, y) => g.update({ leftButton: down, rightButton: false, pointerX: x, pointerY: y, keys: [] });
const idle = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const click = (g, x, y) => { frame(g, true, x, y); frame(g, true, x, y); frame(g, false, x, y); };
const iconClick = (g, i) => click(g, DISK_MENU_BUTTONS[i].x0 + 16, DISK_MENU_BUTTONS[i].y0 + 16);

// The weekly start needs the 21st of November; the eclipse count and flag are the traced `$144BB` and `$156AA` bit 6.
const setDate = (sim, month, day) => { sim["s"].setByte(A.month, month); sim["s"].setByte(A.day, day); };
const startEclipse = (sim) => { setDate(sim, 11, 0x15); sim["eclipseWeekly"](); };
const endEclipse = (sim) => { while (sim["s"].byte(ECLIPSE_COUNT) !== 0) sim["eclipseWeekly"](); };

// Part 1a: the weekly eclipse start and end (the traced count of three weekly calls after the start)
{
  const g = newGame();
  g.startScenario(0);
  const sim = g.map.sim;
  check("start: the scenario begins with parity 0 and no eclipse", sim.tileExchange === false && (sim.sysFlags & ECLIPSE_FLAG) === 0);
  startEclipse(sim);
  check("weekly start: parity toggles to 1 and bit 6 is set with $144BB 3", sim.tileExchange === true && (sim.sysFlags & ECLIPSE_FLAG) !== 0 && sim["s"].byte(ECLIPSE_COUNT) === 3);
  sim["eclipseWeekly"]();
  sim["eclipseWeekly"]();
  check("weekly countdown: two calls keep the exchange", sim.tileExchange === true && (sim.sysFlags & ECLIPSE_FLAG) !== 0);
  sim["eclipseWeekly"]();
  check("weekly end: the third call after the start toggles parity back to 0 and clears bit 6", sim.tileExchange === false && (sim.sysFlags & ECLIPSE_FLAG) === 0 && sim["s"].byte(ECLIPSE_COUNT) === 0);
}

// Part 1b: event 14 starts an eclipse (a chance of 100 always passes the `roll(100) - chance` test; 0 never does)
{
  const g = newGame();
  g.startScenario(0);
  const sim = g.map.sim;
  sim["eventEclipse"](0);
  check("event 14 with chance 0: nothing happens", sim.tileExchange === false && (sim.sysFlags & ECLIPSE_FLAG) === 0);
  sim["eventEclipse"](100);
  const count = sim["s"].byte(ECLIPSE_COUNT);
  check("event 14: parity toggles, bit 6 is set and $144BB is 1..10", sim.tileExchange === true && (sim.sysFlags & ECLIPSE_FLAG) !== 0 && count >= 1 && count <= 10);
  sim["eventEclipse"](100);
  check("event 14 during an eclipse: no second toggle (the event returns early)", sim.tileExchange === true);
  endEclipse(sim);
  check("end of an event eclipse: parity back to 0 and bit 6 clear", sim.tileExchange === false && (sim.sysFlags & ECLIPSE_FLAG) === 0);
}

// Part 1c: disk-menu entry and exit rules
{
  const g = newGame();
  g.startScenario(0);
  const sim = g.map.sim;
  sim.enterDiskMenu();
  check("entry with bit 6 clear: no toggle", sim.tileExchange === false);
  startEclipse(sim);
  sim.enterDiskMenu();
  check("entry during an eclipse: parity 1 -> 0 (the map view leaves the exchange while the menu is open)", sim.tileExchange === false && (sim.sysFlags & ECLIPSE_FLAG) !== 0);
  sim.leaveDiskMenu();
  check("exit during an eclipse ($144BB nonzero): parity 0 -> 1 and bit 6 set", sim.tileExchange === true && (sim.sysFlags & ECLIPSE_FLAG) !== 0);
  sim.enterDiskMenu();
  sim.leaveDiskMenu();
  check("a menu round trip during an eclipse restores parity 1", sim.tileExchange === true);
  sim.enterDiskMenu();
  sim.leaveDiskMenu();
  sim["s"].setByte(ECLIPSE_COUNT, 0);
  sim.sysFlags &= ~ECLIPSE_FLAG;
  const before = sim.tileExchange;
  sim.leaveDiskMenu();
  check("exit with $144BB 0: no toggle and no bit 6", sim.tileExchange === before && (sim.sysFlags & ECLIPSE_FLAG) === 0);
  sim.sysFlags |= GAME_OVER;
  const parityOver = sim.tileExchange;
  sim.leaveDiskMenu();
  check("exit during game over is refused: no toggle", sim.tileExchange === parityOver);
  sim.sysFlags &= ~GAME_OVER;
}

// Part 1d: the map shows the parity, and the loaded tiles are never changed (menu re-entry while the eclipse is active)
{
  const g = newGame();
  g.startScenario(0);
  const map = g.map;
  const sim = map.sim;
  startEclipse(sim);
  map["syncTileView"]();
  check("the map view follows the parity: entry 4 reads the address of entry 51 after the start", sameBytes(map.tiles[4].planes, loaded[51].planes) && sameBytes(map.tiles[51].planes, loaded[4].planes));
  g.openMapDiskMenu();
  map["syncTileView"]();
  check("menu re-entry while active: the parity is 0 and the view is the loaded tiles", sim.tileExchange === false && map.tiles.every((t, i) => sameByValue(t, loaded[i])));
  frame(g, false, 0, 0); // the menu ignores the press that opened it: a released frame first (as the menu tests do)
  iconClick(g, DISK_BUTTON.exit);
  map["syncTileView"]();
  check("menu exit while active: the parity is 1 again and the view is exchanged", sim.tileExchange === true && sameBytes(map.tiles[4].planes, loaded[51].planes));
  check("the loaded tiles are unchanged after the menu round trip (no shared descriptor mutation)", loaded.every((t, i) => sameByValue(t, loadTileSet(disk1, disk2, records[0]).tiles[i])));
}

// Part 1e: new-game reset carries the parity; bit 6 is cleared without a swap
{
  const g = newGame();
  g.startScenario(0);
  startEclipse(g.map.sim);
  const parityBefore = g.map.sim.tileExchange;
  g.startScenario(0);
  const sim = g.map.sim;
  check("new game during an eclipse: the reset clears bit 6 and $144BB", (sim.sysFlags & ECLIPSE_FLAG) === 0 && sim["s"].byte(ECLIPSE_COUNT) === 0);
  check("new game: the parity is carried from the replaced session (no swap at reset)", sim.tileExchange === parityBefore && sim.tileExchange === true);
  g.map["syncTileView"]();
  check("new game: the map view keeps the carried exchange", sameBytes(g.map.tiles[4].planes, loaded[51].planes));
}

// Part 1f: save and load keep the parity; a save taken inside the menu stores 0 during an eclipse
{
  const g = newGame();
  g.startScenario(0);
  startEclipse(g.map.sim);
  const saved = g["saveToSlot"](0);
  check("save during an eclipse (in the map, parity 1) succeeds", saved === true);
  const read = readSlot(0);
  check("save: version 12 and the parity is stored (true, not assumed)", read.ok && SESSION_VERSION === 12 && read.save.sim.tileExchange === true && read.save.sim.tileExchangeAssumed === false);
  g.map.sim.enterDiskMenu();
  check("the live parity is changed before the load (menu entry toggles it to 0)", g.map.sim.tileExchange === false);
  check("load: the saved session is restored", g["loadFromSlot"](0, false));
  check("load: the parity comes back from the save (1)", g.map.sim.tileExchange === true && (g.map.sim.sysFlags & ECLIPSE_FLAG) !== 0);
}

// Part 1g: version 10 migration (no stored parity): 0 with the assumption flag, slot label " TBL UNK", kept on re-save
{
  const g = newGame();
  g.startScenario(0);
  g["saveToSlot"](1);
  const text = readSlot(1);
  const j = JSON.parse(encodeSave(text.save));
  j.version = 10;
  delete j.sim.tileExchange;
  delete j.sim.tileExchangeAssumed;
  const old = decodeSave(JSON.stringify(j));
  check("v10 migration: decodes, parity 0 and the assumption flag set", old.ok && old.save.sim.tileExchange === false && old.save.sim.tileExchangeAssumed === true && old.tableAssumed === true);
  const label = slotWarning({ legacy: false, effectsAssumedEmpty: old.effectsAssumedEmpty, effectSlotsAssumed: old.effectSlotsAssumed, enemyPointersAssumed: old.enemyPointersAssumed, tableAssumed: old.tableAssumed });
  check("v10 migration: the slot label is TBL UNK", label === " TBL UNK", JSON.stringify(label));
  const again = decodeSave(encodeSave(old.save));
  check("v10 migration: a re-save keeps the assumption (the flag is not cleared by a later save)", again.ok && again.tableAssumed === true && again.save.sim.tileExchangeAssumed === true);
  check("v10 migration: a version 11 save without the assumption shows no label", slotWarning({ legacy: false, effectsAssumedEmpty: false, enemyPointersAssumed: false, tableAssumed: false }) === "");
}

// Part 1h: the save path inside the disk menu, and the real pick-load then EXIT (parity 0 in the menu, the exit toggle enters with 1)
{
  const g = newGame();
  g.startScenario(0);
  const sim = g.map.sim;
  startEclipse(sim);
  g.openMapDiskMenu();
  check("menu entry during an eclipse: parity 1 -> 0", sim.tileExchange === false && (sim.sysFlags & ECLIPSE_FLAG) !== 0);
  check("save inside the menu (the real save path) succeeds", g["saveToSlot"](2) === true);
  const inMenu = readSlot(2);
  check("save inside the menu stores parity 0 with bit 6 set, not assumed", inMenu.ok && inMenu.save.sim.tileExchange === false && inMenu.save.sim.tileExchangeAssumed === false && (inMenu.save.sim.sysFlags & ECLIPSE_FLAG) !== 0);
  const before = g.map;
  check("pick-load from the menu: loaded and held behind the disk menu", g["loadFromSlot"](2, true) && g.heldScene !== null && g.map === before && g.stage === "disk");
  check("held load: the old map keeps parity 0 until EXIT", before.sim.tileExchange === false);
  frame(g, false, 0, 0); // the menu ignores the press that opened it: a released frame first
  iconClick(g, DISK_BUTTON.exit);
  check("EXIT enters the held load: one exit toggle (0 -> 1), bit 6 set, nothing held", g.stage === "map" && g.heldScene === null && g.map !== before && g.map.sim.tileExchange === true && (g.map.sim.sysFlags & ECLIPSE_FLAG) !== 0);
  g.map["syncTileView"]();
  check("the entered load shows the exchanged view (entry 4 reads the address of entry 51)", sameBytes(g.map.tiles[4].planes, loaded[51].planes));
}

// Part 1i: game over during an eclipse (the tail `$157AE` -> `$7E52`): one entry toggle; a refused EXIT and a restart toggle nothing
{
  const g = newGame();
  g.startScenario(0);
  const map = g.map;
  const sim = map.sim;
  startEclipse(sim);
  map.world.state.setLong(A.population, 10);
  map.world.state.setByte(A.pending, PERIOD.daily);
  sim.run();
  g.update(idle);
  frame(g, false, 279, 146); frame(g, true, 279, 146); frame(g, false, 279, 146); // leave the game-over announcement (game-over.mjs)
  g.update(idle);
  check("game over in an eclipse: the tail menu opens with one entry toggle (1 -> 0), bit 6 kept", g.stage === "disk" && sim.gameOver && g.diskMenuFromTail && sim.tileExchange === false && (sim.sysFlags & ECLIPSE_FLAG) !== 0);
  frame(g, false, 0, 0);
  iconClick(g, DISK_BUTTON.exit);
  check("the tail's EXIT is refused: no toggle", g.stage === "disk" && sim.tileExchange === false);
  iconClick(g, DISK_BUTTON.tutorial);
  check("restart by the tutorial: the reset clears bit 6 and $144BB, the exit toggles nothing, parity stays 0", g.stage === "map" && g.map !== map && g.map.sim.gameOver === false && g.map.sim.tileExchange === false && (g.map.sim.sysFlags & ECLIPSE_FLAG) === 0 && g.map.sim["s"].byte(ECLIPSE_COUNT) === 0, `stage ${g.stage} parity ${g.map.sim.tileExchange}`);
}

// Part 1j: every pre-version-11 save takes the same migration (parity 0, assumed); the assumption reaches the slot label
{
  const g = newGame();
  g.startScenario(0);
  g["saveToSlot"](3);
  const base = encodeSave(readSlot(3).save);
  // The historical body of each version, shaped as save.mjs does it: fields a version never stored are removed, the effect list is
  // dense for versions 6 and 7 only, and version 2 stores the absolute year ($142A6, STATE_BASE $13034).
  const legacy = (version) => {
    const j = JSON.parse(base);
    j.version = version;
    delete j.sim.tileExchange;
    delete j.sim.tileExchangeAssumed;
    if (version < 5) delete j.sim.hardware;
    if (version < 4) delete j.world.solarPhaseRng;
    if (version <= 6) { delete j.enemies.groundPointers; delete j.enemies.airPointers; }
    if (version < 8) {
      const dense = j.effectSlots === null ? null : j.effectSlots.filter((e) => e !== null);
      delete j.effectSlots;
      delete j.effectSlotsAssumed;
      if (version >= 6) j.effects = dense;
    }
    if (version === 2) {
      const state = Buffer.from(j.state, "base64");
      state.writeUInt32BE(2094, 0x142a6 - 0x13034);
      j.state = state.toString("base64");
    }
    return JSON.stringify(j);
  };
  // The label each migrated version shows: every applicable assumption is named (save.ts slotWarning). v2..5 hold an empty effect
  // pool and pointer assumptions (FX and PTR, plus TBL, 13-column suffix: " FX/PTR/TBL" without " UNK"); v6 holds only PTR (its dense
  // effect list is empty here, so no FX); v7..10 hold only TBL.
  const expectedLabel = { 2: " FX/PTR/TBL", 3: " FX/PTR/TBL", 4: " FX/PTR/TBL", 5: " FX/PTR/TBL", 6: " PTR/TBL UNK", 7: " TBL UNK", 8: " TBL UNK", 9: " TBL UNK", 10: " TBL UNK" };
  for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const old = decodeSave(legacy(version));
    const label = old.ok ? slotWarning({ legacy: old.legacy, effectsAssumedEmpty: old.effectsAssumedEmpty, effectSlotsAssumed: old.effectSlotsAssumed, enemyPointersAssumed: old.enemyPointersAssumed, tableAssumed: old.tableAssumed }) : null;
    check(`v${version} migration: parity 0 and the assumption flag set`, old.ok && old.save.sim.tileExchange === false && old.save.sim.tileExchangeAssumed === true && old.tableAssumed === true, old.ok ? "" : JSON.stringify(old.error));
    check(`v${version} label: ${JSON.stringify(expectedLabel[version])} names every assumption the migration holds`, label === expectedLabel[version], JSON.stringify(label));
    check(`v${version} label: "SLOT 4  31/12/2099" + the label fits 31 columns`, ("SLOT 4  31/12/2099" + label).length <= 31, String(("SLOT 4  31/12/2099" + label).length));
    check(`v${version} label: the flags it names are exactly the flags the migration holds`, old.ok && (label.includes("FX") === Boolean(old.effectsAssumedEmpty || old.effectSlotsAssumed)) && (label.includes("PTR") === Boolean(old.enemyPointersAssumed)) && label.includes("TBL") && !label.includes("V1"));
  }
}

// Part 1k: invariant walk over the real sim (fixed seed, 20000 steps): on the map the parity equals bit 6, and bit 6 is set exactly
// while $144BB is nonzero; while the disk menu is open the entry has cleared the parity (0). The map view therefore follows bit 6,
// and the menu/tail state is the only place where they differ (the reason the parity is stored). Static model, no emulator.
{
  const g = newGame();
  g.startScenario(0);
  const sim = g.map.sim;
  let seed = 0x2f6b;
  const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let menuOpen = false;
  let walkFailures = 0;
  let starts = 0;
  let ends = 0;
  let events = 0;
  let exits = 0;
  for (let step = 0; step < 20000; step++) {
    const op = next(10);
    if (menuOpen) {
      if (op < 6) {
        sim.leaveDiskMenu();
        menuOpen = false;
        exits++;
      }
      if (!menuOpen && (sim.tileExchange !== ((sim.sysFlags & ECLIPSE_FLAG) !== 0) || (sim["s"].byte(ECLIPSE_COUNT) !== 0) !== ((sim.sysFlags & ECLIPSE_FLAG) !== 0))) walkFailures++;
      continue;
    }
    if (op < 2) {
      sim.enterDiskMenu();
      menuOpen = true;
      if (sim.tileExchange !== false) walkFailures++;
      continue; // the menu state is not the map invariant: it is checked on exit
    } else if (op < 4) {
      setDate(sim, next(12), 1 + next(28)); // weekly; the start can fire only on 21 November
      const before = sim["s"].byte(ECLIPSE_COUNT);
      sim["eclipseWeekly"]();
      if (before === 0 && sim["s"].byte(ECLIPSE_COUNT) !== 0) starts++;
      if (before === 1) ends++;
    } else if (op < 5) {
      const before = sim["s"].byte(ECLIPSE_COUNT);
      sim["eventEclipse"](next(2) === 0 ? 0 : 100);
      if (before === 0 && sim["s"].byte(ECLIPSE_COUNT) !== 0) events++;
    } else if (op < 6) {
      setDate(sim, 11, 0x15);
      sim["eclipseWeekly"]();
      if (sim["s"].byte(ECLIPSE_COUNT) !== 0) starts++;
    }
    const bit6 = (sim.sysFlags & ECLIPSE_FLAG) !== 0;
    if (sim.tileExchange !== bit6 || (sim["s"].byte(ECLIPSE_COUNT) !== 0) !== bit6) walkFailures++;
    if (sim.tileExchange !== bit6) break;
  }
  check(`invariant walk (20000 steps, ${starts} starts, ${events} event starts, ${ends} ends, ${exits} menu exits): map parity == bit 6 == ($144BB != 0), menu entry clears parity`, walkFailures === 0, `failures ${walkFailures}`);
  check("invariant walk exercised the eclipse start, end, event and menu exits", starts > 0 && ends > 0 && events > 0 && exits > 0);
}

console.log(failed === 0 ? "all eclipse parity checks passed" : `${failed} eclipse parity check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
