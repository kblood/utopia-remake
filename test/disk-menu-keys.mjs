// Keys typed in the original disk menu and the first main-loop poll after its in-game exit (src/game/game.ts `updateMap`
// after the exit, src/game/map.ts `foldKeys` / `poll`). Static trace (Disk.1, notes/formats/game-proper.md "Keyboard" and
// "One key cell"): the disk menu loop `$7EF6` never reads the key cell `$161A0`, and its exit `$802C` clears nothing. The
// exit returns through `$15AEC` (`$15EF0`, `rts`) into `$158B0`, which runs `bra $158C2` and `bsr $15B4A` in the same
// iteration. So a key typed in the menu is the cell's value at that poll and is dispatched in the exit iteration: P (raw $19)
// and space ($40) pause at once. A release typed after it overwrites it (nothing dispatched), and the last entry of the batch
// wins. This is a static model; no emulator comparison is claimed.
// Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("disk-menu-keys tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
const { keyUpToken } = await import("../dist/game/intro.js");
const { readSlot } = await import("../dist/game/save.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// Like main.ts: one persistent input object whose `keys` array collects key events until a map update drains it.
const input = { leftButton: false, rightButton: false, pointerX: 50, pointerY: 50, keys: [] };
function step(g, { down = false, x = 50, y = 50, keys = [] } = {}) {
  input.leftButton = down;
  input.pointerX = x;
  input.pointerY = y;
  input.keys.push(...keys);
  g.update(input);
}
// A press, a second frame held (the icon is recorded on the press), and the release that runs the icon's action.
const iconClick = (g, index) => {
  const b = DISK_MENU_BUTTONS[index];
  const x = b.x0 + 16, y = b.y0 + 16;
  step(g, { down: true, x, y });
  step(g, { down: true, x, y });
  step(g, { down: false, x, y });
};

// Icon 2 opens the list only after a second fresh press off the rows (the original's $2E48 wait); that press opens the page.
const scenarioIcon = (g) => {
  iconClick(g, DISK_BUTTON.scenario);
  step(g, { down: true, x: 0, y: 0 });
  step(g, { down: false, x: 0, y: 0 });
};
// The remake's way back from the scenario page to the disk menu (right button, a remake route). The held scene and the page's own
// state are unchanged; the list stays open after a pick, so the disk menu is reached only through this.
const rightClick = (g) => {
  step(g);
  input.rightButton = true;
  g.update(input);
  input.rightButton = false;
  step(g);
};

function newGame() {
  const g = new Game(disk1, disk2, null, null);
  g.strings = new GameStrings(disk1, 0);
  g.bootMenuOpen = false; // the game proper (the boot session is test/boot-menu.mjs)
  g.stage = "scenario";
  g.startScenario(0);
  for (let i = 0; i < 8; i++) step(g); // settle the fresh entry's first pass
  return g;
}

// Opens the in-game disk menu over the running map, types `keys` in it, then clicks EXIT.
function menuThenExit(keys) {
  const g = newGame();
  const map = g.map;
  g.openMapDiskMenu();
  check("in-game disk menu is open over the same map", g.stage === "disk" && g.map === map, `stage ${g.stage}`);
  step(g, { keys });
  for (let i = 0; i < 3; i++) step(g);
  check("menu-typed keys do not act while the menu is open (no pause, the map is not updated)", map.sim.paused === false && g.stage === "disk");
  iconClick(g, DISK_BUTTON.exit);
  return { g, map };
}

// ---- 1. P typed in the menu is dispatched by the exit iteration ($15B4A after $158B0) -----------------------------------
{
  const { g, map } = menuThenExit(["p"]);
  check("exit: the stage is the map again and it is the same scene", g.stage === "map" && g.map === map);
  check("P typed in the menu pauses at the exit update (dispatched by the poll of the exit iteration)", map.sim.paused === true, `paused ${map.sim.paused}`);
  for (let i = 0; i < 12; i++) step(g);
  check("P is dispatched once: the pause stays on through later passes (a replay would unpause)", map.sim.paused === true);
}

// ---- 2. A release typed after the key overwrites it: nothing is dispatched ----------------------------------------------
{
  const { g, map } = menuThenExit(["p", keyUpToken("p")]);
  check("P then its release typed in the menu: the exit iteration dispatches nothing (the release overwrote the key)", map.sim.paused === false && g.stage === "map", `paused ${map.sim.paused}`);
  for (let i = 0; i < 12; i++) step(g);
  check("P then its release: no later pass dispatches the key either", map.sim.paused === false);
}

// ---- 3. The last entry of the menu batch wins (a single cell) -----------------------------------------------------------
{
  const { g, map } = menuThenExit(["p", "x"]);
  check("P then X typed in the menu: only X is in the cell at the exit, so nothing pauses", map.sim.paused === false && g.stage === "map", `paused ${map.sim.paused}`);
  for (let i = 0; i < 12; i++) step(g);
  check("P then X: nothing is replayed by later passes", map.sim.paused === false);
}

// ---- 4. Held routes: scenario pick, load pick, boot menu, tutorial, remake save ------------------------------------------
// Static trace (Disk.1, notes/formats/game-proper.md "Disk menu and its exit"): the scenario `$88F0` and load `$8828` paths
// read and clear no key cell (key_reach: no routine of either path touches `$161A0`), and neither clears one, so a key typed
// before the pick, on its list or while the scene is held is still in the cell at EXIT and is dispatched by that iteration.
// The tutorial `$80C8` ends `bra $802C`, so its key is dispatched at entry. The save-name Return path (`$8974` -> `$5110`) has
// no remake counterpart (the remake saves to a slot list with no name entry); its trace is in the note, not tested here.
// Menu geometry (menu.ts): a row is `floor((y - 56) / 12)`, x in 40..279. A menu opened while a button is held ignores that
// press, so each click is preceded by a frame with the button up (as main.ts delivers it).
const rowClick = (g, row) => {
  const x = 60, y = 56 + 12 * row + 4;
  step(g, { down: true, x, y });
  step(g, { down: true, x, y });
  step(g, { down: false, x, y });
  if (g.stage === "save" && g.nameEntry) {
    // Accept the default name after the new original-style prompt; save-name.mjs exercises Return and editing.
    step(g);
    step(g, { down: true, x, y });
    step(g, { down: false, x, y });
  }
};
// A fresh boot-menu session (the boot disk menu is open, `bootMenuOpen`): the boot exit rule applies (`runDiskMenuExit`).
function bootMenu() {
  const g = new Game(disk1, disk2, null, null);
  g.strings = new GameStrings(disk1, 0);
  g.bootMenuOpen = true;
  g.openDiskMenu();
  step(g);
  return g;
}

// 4a. P typed in the menu, then the scenario list, pick and EXIT.
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  step(g, { keys: ["p"] });
  scenarioIcon(g);
  step(g);
  rowClick(g, 0);
  check("4a: the scenario pick holds the new scene and the list stays open (stage scenario)", g.stage === "scenario" && g.heldScene !== null, `stage ${g.stage}`);
  rightClick(g);
  iconClick(g, DISK_BUTTON.exit);
  check("4a: P typed before the scenario pick pauses the held scene at EXIT", g.stage === "map" && g.map.sim.paused === true, `paused ${g.map?.sim.paused}`);
  for (let i = 0; i < 12; i++) step(g);
  check("4a: P is dispatched once (no replay after EXIT)", g.map.sim.paused === true);
}

// 4b. P typed on the scenario list itself (the list loop reads no cell).
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  scenarioIcon(g);
  step(g);
  step(g, { keys: ["p"] });
  check("4b: P typed on the scenario list is kept (not read by the list)", g.stage === "scenario" && JSON.stringify(input.keys) === '["p"]');
  rowClick(g, 0);
  rightClick(g);
  iconClick(g, DISK_BUTTON.exit);
  check("4b: P typed on the list pauses the held scene at EXIT", g.stage === "map" && g.map.sim.paused === true, `paused ${g.map?.sim.paused}`);
}

// 4c. P typed while the scene is held (the disk menu is open after the pick), then EXIT.
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  scenarioIcon(g);
  step(g);
  rowClick(g, 0);
  check("4c: the pick leaves the list open (stage scenario), scene held", g.stage === "scenario" && g.heldScene !== null);
  rightClick(g);
  step(g, { keys: ["p"] });
  check("4c: P typed while held is kept; the right click does nothing on the list (still open, scene held)", g.stage === "scenario" && g.heldScene !== null && JSON.stringify(input.keys) === '["p"]', `stage ${g.stage}`);
  iconClick(g, DISK_BUTTON.exit);
  check("4c: P typed while held pauses the held scene at EXIT", g.stage === "map" && g.map.sim.paused === true, `paused ${g.map?.sim.paused}`);
}

// 4d. P then X on the list: the last entry wins, so nothing pauses at EXIT.
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  step(g, { keys: ["p", "x"] });
  scenarioIcon(g);
  step(g);
  rowClick(g, 0);
  rightClick(g);
  iconClick(g, DISK_BUTTON.exit);
  check("4d: P then X before a held EXIT: nothing pauses", g.stage === "map" && g.map.sim.paused === false, `paused ${g.map?.sim.paused}`);
}

// 4e. A slot is saved from the in-game disk menu's save icon. The save's tail (`$89B4`) leaves the save list up with `$141` (remake: the
// save page stands in for it); BACK returns to the picture's loop (`$8A40` `rts` -> `$7FDC` `bra $7EF6`), and only EXIT leaves it.
// The saved slot 0 is the one written here (localStorage is shared by the file).
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  const map = g.map;
  iconClick(g, DISK_BUTTON.save);
  step(g);
  rowClick(g, 0);
  check("4e: the save icon's click writes slot 0 and keeps the save page with $141 (no exit, same map, not paused)", g.stage === "save" && g.menu !== null && g.map === map && map.sim.paused === false && g.menu.promptCodes?.join() === g.strings.get(0x141).join(), `stage ${g.stage}`);
  check("4e: the save leaves the held and map state alone (nothing held, same map)", g.heldScene === null && g.map === map);
  rightClick(g); // BACK from the saved page: the picture's loop
  check("4e: BACK from the saved page returns to the disk picture with $141 on its prompt", g.stage === "disk" && g.diskMenu !== null && g.diskMenu.promptIndex === 0x141 && g.map === map, `stage ${g.stage}`);
  iconClick(g, DISK_BUTTON.exit);
  check("4e: EXIT after the save returns to the same map", g.stage === "map" && g.map === map, `stage ${g.stage}`);
}
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  step(g, { keys: ["p"] });
  iconClick(g, DISK_BUTTON.load);
  step(g);
  rowClick(g, 0);
  check("4e: the load pick is held behind the disk menu, P still in the cell", g.stage === "disk" && g.heldScene !== null && JSON.stringify(input.keys) === '["p"]', `stage ${g.stage}`);
  // The load row is chosen on its release, so the picture opens with the button up: one idle frame before the EXIT press (the
  // picture ignores a button already down at its first update, its opening click).
  step(g);
  iconClick(g, DISK_BUTTON.exit);
  check("4e: P typed before the load pick pauses the loaded scene at EXIT", g.stage === "map" && g.map.sim.paused === true, `paused ${g.map?.sim.paused}`);
}

// 4f. The boot menu: a scenario pick held in the boot session, then EXIT (the boot exit rule, `enterHeldScene`).
{
  const g = bootMenu();
  step(g, { keys: ["p"] });
  scenarioIcon(g);
  step(g);
  rowClick(g, 0);
  check("4f: the boot menu holds the scenario pick (list open)", g.stage === "scenario" && g.heldScene !== null, `stage ${g.stage}`);
  rightClick(g);
  iconClick(g, DISK_BUTTON.exit);
  check("4f: P typed in the boot menu pauses the held scene at its exit", g.stage === "map" && g.map.sim.paused === true, `paused ${g.map?.sim.paused}`);
}

// 4g. The tutorial enters at once (`$80C8` ends `bra $802C`): P typed before its icon is dispatched by the entry update.
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  step(g, { keys: ["p"] });
  iconClick(g, DISK_BUTTON.tutorial);
  check("4g: the tutorial entry dispatches P in its entry update", g.stage === "map" && g.map.sim.paused === true, `paused ${g.map?.sim.paused}`);
}

// 4h. P typed before a successful save stays in the cell through the loop (the save path touches no key cell, `$8958`/`$89B4`) and is
// dispatched once at EXIT, not by a map pass during the save.
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  step(g, { keys: ["p"] });
  iconClick(g, DISK_BUTTON.save);
  step(g);
  rowClick(g, 1);
  check("4h: after the save the save page is up and P is still in the cell", g.stage === "save" && JSON.stringify(input.keys) === '["p"]', `stage ${g.stage} keys ${JSON.stringify(input.keys)}`);
  const map = g.map;
  for (let i = 0; i < 12; i++) step(g);
  check("4h: no map pass runs while the save page waits (P not dispatched yet)", g.stage === "save" && map.sim.paused === false, `paused ${map.sim.paused}`);
  rightClick(g); // BACK to the picture's loop
  check("4h: BACK to the picture keeps P in the cell and runs no map pass", g.stage === "disk" && JSON.stringify(input.keys) === '["p"]' && map.sim.paused === false, `stage ${g.stage}`);
  for (let i = 0; i < 12; i++) step(g);
  check("4h: the picture's loop runs no map pass either (P not dispatched yet)", g.stage === "disk" && map.sim.paused === false, `paused ${map.sim.paused}`);
  iconClick(g, DISK_BUTTON.exit);
  check("4h: EXIT dispatches P once in the exit iteration", g.stage === "map" && map.sim.paused === true, `paused ${map.sim.paused}`);
  for (let i = 0; i < 12; i++) step(g);
  check("4h: P is dispatched once (not lost, not replayed by later passes)", map.sim.paused === true);
}

// 4i. Held scene: the save icon opens the slot page, and the page's write saves the HELD session (a scenario pick) to its slot. The
// held scene is still entered only by EXIT, with the key typed in the menu dispatched there.
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  const slotKey = "utopia-remake-save-0";
  const before = storage.get(slotKey);
  scenarioIcon(g);
  step(g);
  rowClick(g, 0);
  check("4i: the scenario pick holds its scene; the list stays open (stage scenario)", g.stage === "scenario" && g.heldScene !== null, `stage ${g.stage}`);
  const held = g.heldScene;
  rightClick(g);
  step(g, { keys: ["p"] });
  iconClick(g, DISK_BUTTON.save);
  check("4i: the save icon with a held scene opens the slot page (stage save) and keeps the held scene", g.stage === "save" && g.heldScene === held && storage.get(slotKey) === before, `stage ${g.stage}`);
  step(g);
  rowClick(g, 0);
  check("4i: the page writes the held session to slot 1 and stays on the save page (stage save, no scenario list) with $141 as its status line, the scene still held", g.stage === "save" && g.diskMenu === null && g.menu?.promptCodes?.join() === new GameStrings(disk1, 0).get(0x141).join() && g.heldScene === held && storage.get(slotKey) !== before, `stage ${g.stage} status ${g.menu?.promptCodes?.join()}`);
  const written = readSlot(0);
  check("4i: slot 1 holds the HELD scenario (its index), not the live map's", written.ok && written.save.scenario === held.index, `slot ${written.ok ? written.save.scenario : written.error?.code} held ${held.index}`);
  check("4i: P typed before the save is still in the cell", JSON.stringify(input.keys) === '["p"]');
  rightClick(g); // BACK from the save page: the scenario list it came from, with the save's $141 (the $8B the save erased does not come back)
  check("4i: BACK from the saved page returns to the scenario list with $141 on its prompt and the scene still held", g.stage === "scenario" && g.diskMenu?.listKind === "scenario" && g.diskMenu.promptIndex === 0x141 && g.heldScene === held, `stage ${g.stage} prompt ${g.diskMenu?.promptIndex}`);
  iconClick(g, DISK_BUTTON.exit);
  check("4i: EXIT enters the held scene, and P typed before it pauses that scene", g.stage === "map" && g.map === held.map && g.map.sim.paused === true, `stage ${g.stage} paused ${g.map?.sim.paused}`);
}

// 4j. Save failure: the storage refuses the write. The error screen keeps the disk menu underneath; BACK TO DISK MENU returns to the
// loop (no exit), and P typed before the failed click survives to EXIT. Storage is restored afterwards.
{
  const g = newGame();
  g.openMapDiskMenu();
  step(g);
  step(g, { keys: ["p"] });
  const map = g.map;
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error("quota"); };
  try {
    iconClick(g, DISK_BUTTON.save);
    step(g);
    rowClick(g, 2);
  } finally {
    globalThis.localStorage.setItem = realSet;
  }
  check("4j: a refused save opens its error screen over the loop", g.stage === "sloterror" && g.lastSaveError?.code === "write-failed", `stage ${g.stage} code ${g.lastSaveError?.code}`);
  check("4j: the failed click keeps P in the cell", JSON.stringify(input.keys) === '["p"]');
  const back = g.menu.entries.findIndex((e) => e.label === "BACK TO DISK MENU");
  step(g); // the error page opened on the save row's release: the next press is a fresh one (a page ignores the press that opened it)
  rowClick(g, back);
  check("4j: BACK TO DISK MENU returns to the loop, not through EXIT", g.stage === "disk" && g.map === map && map.sim.paused === false, `stage ${g.stage}`);
  iconClick(g, DISK_BUTTON.exit);
  check("4j: EXIT after the failed save dispatches P once", g.stage === "map" && map.sim.paused === true, `paused ${map.sim.paused}`);
}

console.log(failed === 0 ? "disk-menu-keys: all checks passed" : `disk-menu-keys: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
