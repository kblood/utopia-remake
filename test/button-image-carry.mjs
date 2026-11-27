// Command-button column after a disk-menu route (src/game/game.ts `sceneOptions`, src/game/map.ts `MapSceneOptions.commandButtonImagesFromTable`).
// Static evidence (Disk.1; notes/formats/building.md "Right panel, part 2"): the build-menu exit `$B628` draws the ten buttons from
// the `$5DDA` images. The disk menu `$7E52` (entered from the map at `$15AE6`) decodes its picture into the back bitmap, and its
// exit `$802C` swaps back and copies the displayed pre-menu frame into the other bitmap. The in-game load, scenario and tutorial
// routes never unpack the picture again (`$4E28` / `$2B1A` run only at boot, `$157A8`). So after an in-game load the column is
// the pre-menu one: `$5DDA` images after an earlier build-menu exit, the picture's blank buttons otherwise. The boot-menu load
// has no earlier map, so it shows the picture's buttons. The remake's save/load builds a new MapScene; this test pins the carry.
// The button image bytes are decoded here independently of the engine (5 planes, MSB first, file offset = game address + $28800).
// Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("button-image carry tests skipped: original data not found");
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

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// ---- the button images, decoded here (same geometry as test/map-loop.mjs "build-menu exit") ---------------------------------------
const IMAGE_FILE_BASE = 0x14c * 512 - 0x1000; // file offset of game address 0 (delta $28800)
const wordAt = (a) => (disk1[IMAGE_FILE_BASE + a] << 8) | disk1[IMAGE_FILE_BASE + a + 1];
const longAt = (a) => ((wordAt(a) << 16) | wordAt(a + 2)) >>> 0;
const indexAt = (base, row, col) => {
  let index = 0;
  for (let p = 0; p < 5; p++) index |= ((wordAt(base + p * 32 + row * 2) >> (15 - col)) & 1) << p;
  return index;
};
const BUTTON_X = [272, 296, 272, 296, 272, 296, 272, 296, 296, 272];
const BUTTON_Y = [63, 63, 82, 82, 101, 101, 120, 120, 139, 139];
// Pixels of the command column that differ from the `$5DDA` images (0 = the column shows the images).
const imageMismatches = (screen) => {
  let n = 0;
  for (let i = 0; i < 10; i++) {
    const base = longAt(0x5dda + 4 * i);
    for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) if (screen.pixels[(BUTTON_Y[i] + r) * 320 + BUTTON_X[i] + c] !== indexAt(base, r, c)) n++;
  }
  return n;
};
const RING_PIXELS = 320; // the picture's blank buttons differ from the images on the 16 x 16 edge ring: 32 per button (building.md)

// ---- input helpers (the edges the scenes see) -----------------------------------------------------------------------------------------
let game = null;
const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const frame = (down, x = 0, y = 0) => {
  input.leftButton = down;
  input.pointerX = x;
  input.pointerY = y;
  game.update({ ...input });
};
const idle = () => frame(false, 0, 0);
const iconClick = (i) => {
  idle();
  const x = DISK_MENU_BUTTONS[i].x0 + 16, y = DISK_MENU_BUTTONS[i].y0 + 16;
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
};
const idleInput = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const newGame = (inGame) => {
  const g = new Game(disk1, disk2, null, null);
  g.strings = new GameStrings(disk1, 0);
  if (inGame) g.bootMenuOpen = false; // a game already in the game proper (as the boot-menu test's saver)
  return g;
};

// ---- 1. In-game load after a build-menu exit: the column keeps the $5DDA images ----------------------------------------------------------
{
  game = newGame(true);
  game.startScenario(0);
  const before = game.map;
  check("a fresh scene shows the picture's blank buttons (no build-menu exit yet)", before.controls.commandButtonImagesFromTable === false);
  before.update(idleInput);
  check("fresh scene: the column is the picture ring (320 pixels differ from the images)", imageMismatches(before.screen) === RING_PIXELS, `mismatches ${imageMismatches(before.screen)}`);

  before.controls.markMenuExitButtonImages(); // the state the build-menu exit `$B628` leaves (controls.ts; the same staging the comparator uses)
  for (let i = 0; i < 4; i++) before.update(idleInput); // one main-loop pass (4 video updates) redraws the column
  check("after the build-menu exit state the column shows the $5DDA images", imageMismatches(before.screen) === 0, `mismatches ${imageMismatches(before.screen)}`);

  check("the in-game save is written", game.saveToSlot(0) === true);
  check("the in-game load is accepted", game.loadFromSlot(0) === true && game.lastLoadError === null);
  const after = game.map;
  check("the load builds a new scene (stage map)", game.stage === "map" && after !== null && after !== before);
  check("the loaded scene inherits the $5DDA column state (in-game disk-menu route)", after.controls.commandButtonImagesFromTable === true);
  check("the loaded scene's first frame already shows the $5DDA images", imageMismatches(after.screen) === 0, `mismatches ${imageMismatches(after.screen)}`);
  for (let i = 0; i < 4; i++) after.update(idleInput);
  check("after the in-game load the column is the $5DDA image ring, not the picture's", imageMismatches(after.screen) === 0, `mismatches ${imageMismatches(after.screen)}`);
  storage.delete("utopia-remake-save-0");
}

// ---- 2. In-game load with no earlier build-menu exit: the picture's column stays ----------------------------------------------------------
{
  game = newGame(true);
  game.startScenario(0);
  check("the in-game save of a scene without an exit is written", game.saveToSlot(1) === true);
  check("the in-game load of that save is accepted", game.loadFromSlot(1) === true);
  check("no earlier exit: the loaded scene does not carry the $5DDA state", game.map.controls.commandButtonImagesFromTable === false);
  game.map.update(idleInput);
  check("no earlier exit: the loaded column is the picture ring", imageMismatches(game.map.screen) === RING_PIXELS, `mismatches ${imageMismatches(game.map.screen)}`);
  storage.delete("utopia-remake-save-1");
}

// ---- 3. Disk-menu round trip without a load keeps the same scene and its state --------------------------------------------------------------
{
  game = newGame(true);
  game.startScenario(0);
  const scene = game.map;
  scene.controls.markMenuExitButtonImages();
  game.openDiskMenu();
  idle();
  iconClick(DISK_BUTTON.exit);
  check("the disk-menu exit returns to the same scene", game.stage === "map" && game.map === scene);
  check("the disk-menu round trip keeps the $5DDA column state", scene.controls.commandButtonImagesFromTable === true);
}

// ---- 4. A scenario started from the in-game disk menu carries the state; a boot-session scene does not ---------------------------------------
{
  game = newGame(true);
  game.startScenario(0);
  game.map.controls.markMenuExitButtonImages();
  game.startScenario(1);
  check("a new scenario started in-game inherits the $5DDA state", game.map.controls.commandButtonImagesFromTable === true);
}
{
  // Boot session: the boot disk menu holds the first scene; with no earlier map the exit enters the picture's column (static
  // trace: the boot tail unpacks the picture at `$157A8`, and the boot load is followed by the boot exit).
  game = newGame(false);
  game.stage = "disk";
  game.openDiskMenu();
  idle();
  game.startScenario(0); // held while the boot session is open
  check("the boot scene is held, not entered", game.stage === "disk" && game.map === null && game.heldScene !== null);
  iconClick(DISK_BUTTON.exit); // the boot exit (icon 5) enters the held scene
  check("the boot exit enters the held scene", game.stage === "map" && game.map !== null);
  check("boot route: no earlier scene, so the column is the picture's", game.map.controls.commandButtonImagesFromTable === false);
  game.map.update(idleInput);
  check("boot route: the first column is the picture ring", imageMismatches(game.map.screen) === RING_PIXELS, `mismatches ${imageMismatches(game.map.screen)}`);
}

storage.clear();
console.log(failed === 0 ? "button-image carry: all checks passed" : `button-image carry: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
