// Regression checks of the id-4 button click ($5756 / $5948, notes/formats/sfx.md "Button click call paths") for the
// paths that are not covered by test/screens.mjs, test/overview.mjs and test/build.mjs: the pause button and the P / space
// key on the map screen, the F1-F6 key return while paused ($15C1A) and the disk menu ($7FC0 -> $5948).
// Uses the user's own game data in original/utopia-whdload (read-only); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("button sound tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Builder } = await import("../dist/game/build.js");
const { Controls, BUTTON } = await import("../dist/game/controls.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Ui } = await import("../dist/game/screens/ui.js");
const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");
const { Game } = await import("../dist/game/game.js");
const { SFX } = await import("../dist/audio/sfx.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

check("button 9 of the command column is the pause button (table $5DDA entry 9 = $18462)", BUTTON.pause === 9);

// --- Controls: the pause button ($159B2 / $15996-$159A6) --------------------------------------------------------------
{
  const rec = readScenarioRecords(disk2)[0];
  const world = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
  const builder = new Builder(world, readFlagTable(disk1), readWeights(disk1), () => {});
  const controls = new Controls(disk1, world, builder, strings, () => {}, () => ({ x: 47, y: 33 }));
  let paused = false;
  let clicks = 0;
  controls.onClick = () => clicks++;
  controls.isPaused = () => paused;
  controls.onPause = () => {
    paused = !paused;
  };
  const update = (leftButton, x, y) => controls.update({ leftButton, rightButton: false, pointerX: x, pointerY: y, keys: [] });

  update(true, 280, 145); // button 9 (272,139) while running: click, then the pause bit is set (on the press, $159B8-$159C4)
  check("pause button: pressing it while running clicks once and pauses", clicks === 1 && paused);
  update(true, 280, 145);
  check("pause button: holding it adds nothing", clicks === 1 && paused);
  update(false, 280, 145);
  check("pause button: release is silent and leaves the pause on", clicks === 1 && paused);
  update(true, 280, 145);
  check("pause button: pressing it while paused resumes silently ($159FC, no $5756)", clicks === 1 && !paused);
  update(false, 280, 145);
  paused = true;
  const screens = [];
  controls.onScreen = (kind) => screens.push(kind);
  update(true, 296, 63); // button 1 (overview) while paused: $159AC still reaches $5756 (the click), the action waits for the release
  check("pause on: another command button still clicks on the press ($159AC)", clicks === 2 && screens.length === 0);
  update(false, 296, 63);
  check("pause on: the overview button still opens on its release ($15AA0 runs before the pause test)", screens.join() === "overview");
  update(true, 20, 20); // not a button, not a map cell
  check("pause on: a blank press is silent", clicks === 2);
  update(false, 20, 20);
}

// --- Game: map keys, F-key windows, disk menu ---------------------------------------------------------------------------
{
  const log = [];
  const sfx = {
    enabled: true,
    count: 6,
    play: (id, volume) => void log.push({ id, volume, enabled: sfx.enabled }),
    setEnabled: (on) => {
      sfx.enabled = on;
    },
    setVolume: () => {},
    resume: () => {},
  };
  const game = new Game(disk1, disk2, null, sfx);
  game.strings = strings;
  game.bootMenuOpen = false; // the game proper is running (the boot session is test/boot-menu.mjs)
  game.stage = "scenario";
  game.startScenario(2);
  const map = game.map;
  const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  const run = (n) => {
    for (let i = 0; i < n; i++) game.update(input);
  };
  // A window key is taken by the first completed pass's poll after it arrives ($15B4A), so run until a pass has completed. The one
  // more update lets the window's first update see the button up (Pointer: a button held when the scene opens is not a press).
  const pressF = (key) => {
    input.keys.push(key);
    const passes = map.loop.passes;
    for (let i = 0; i < 8 && map.loop.passes === passes; i++) run(1);
    run(1);
  };
  const n4 = () => log.filter((e) => e.id === SFX.CLICK).length; // other effects (alerts, explosions) may occur on the running map
  check("game: the scenario starts on the map screen", game.stage === "map" && map.sim.paused === false);
  run(8);
  log.length = 0;

  // $15C02-$15C34: entering the pause presses the pause button (click); leaving it is silent.
  input.keys.push("p");
  run(8);
  check("P key: entering the pause requests one click", map.sim.paused === true && n4() === 1 && SFX.CLICK === 4);
  input.keys.push(" ");
  run(8);
  check("space key: leaving the pause is silent", map.sim.paused === false && n4() === 1);
  input.keys.push("P");
  run(8);
  check("uppercase P key: entering the pause clicks again", map.sim.paused === true && n4() === 2);
  input.keys.push("p");
  run(8);
  check("P key: leaving the pause is silent", map.sim.paused === false && n4() === 2);

  // The pause button through the real scene: press (one click, pauses), release, press again (silent resume).
  const mouse = (down, x, y) => {
    input.leftButton = down;
    input.pointerX = x;
    input.pointerY = y;
    run(8);
  };
  log.length = 0;
  mouse(true, 280, 145);
  mouse(false, 280, 145);
  check("pause button on the map: one click and the game is paused", map.sim.paused === true && n4() === 1);
  mouse(true, 280, 145);
  mouse(false, 280, 145);
  check("pause button on the map: pressing it again resumes without a click", map.sim.paused === false && n4() === 1);

  // $15B68-$15BE6 -> $15C1A: back from an F-key window while paused, the pause button is pressed again (one click).
  // The report windows leave through their exit button only (reports.ts, `$B99C` -> `$58F8`): Escape is not read, so the
  // close is a press on the exit button, which clicks on its own ($5756), then its release. The counts below are deltas
  // of the click log, so the exit click is part of each close.
  const exit = new Ui(disk1, strings).buttonPosition(9);
  const closeWindow = () => {
    input.pointerX = exit.x + 4;
    input.pointerY = exit.y + 4;
    input.leftButton = true;
    run(2);
    input.leftButton = false;
    run(2);
  };
  log.length = 0;
  pressF("F1");
  check("F1 opens the window with no click", game.stage === "screen" && n4() === 0);
  input.keys.push("Escape");
  run(2);
  check("F1 window: Escape does not close it (no key leaves a report)", game.stage === "screen" && n4() === 0);
  closeWindow();
  check("F-key window closed while running: only the exit button's own click", game.stage === "map" && n4() === 1);
  map.sim.paused = true;
  pressF("F1");
  check("F-key window opened while paused: still no click on opening", game.stage === "screen" && n4() === 1);
  closeWindow();
  check("F-key window closed while paused: exit click, then the pause button is re-pressed (one click)", game.stage === "map" && n4() === 3);
  game.openScreen("f1"); // an icon-button window returns through $15A74, which does not touch the pause button
  run(1);
  closeWindow();
  check("icon-button window closed while paused: exit click only", game.stage === "map" && n4() === 4);
  map.sim.paused = false;

  // Disk menu: $7FC0 -> $5948 requests the click on the press of ANY of the nine rectangles, before the handler picked by the $7FE4
  // table runs; the release, blank clicks, list rows and right clicks are silent. The remake's own pages (submenu, slot lists) are silent.
  const centre = (i) => [DISK_MENU_BUTTONS[i].x0 + 16, DISK_MENU_BUTTONS[i].y0 + 16];
  const openDisk = () => {
    input.leftButton = false;
    input.rightButton = false;
    input.keys.length = 0;
    game.openDiskMenu();
    game.update(input); // consumes the opening click guard
    log.length = 0;
  };
  const press = (x, y) => {
    input.pointerX = x;
    input.pointerY = y;
    input.leftButton = true;
    game.update(input);
  };
  const release = () => {
    input.leftButton = false;
    game.update(input);
  };
  const rowY = (row) => 40 + 16 + row * 12 + 4; // remake list pages
  const pressRow = (row) => {
    input.pointerX = 100;
    input.pointerY = rowY(row);
    input.leftButton = false;
    game.update(input);
    input.leftButton = true;
    game.update(input);
    input.leftButton = false;
    game.update(input);
  };
  openDisk();
  check("disk menu opens (the original picture scene)", game.stage === "disk" && game.diskMenu !== null && game.menu === null);
  press(10, 20); // outside every rectangle
  release();
  check("disk menu: a click outside every rectangle is silent and keeps the menu", log.length === 0 && game.stage === "disk");
  press(100, 0x40); // the (closed) list panel
  release();
  check("disk menu: a click on the closed list panel is silent", log.length === 0 && game.stage === "disk");
  // Every one of the nine rectangles requests exactly one id 4 click on its press, none on the hold or the release.
  for (let i = 0; i < 9; i++) {
    openDisk();
    press(...centre(i));
    const onPress = n4();
    game.update(input);
    game.update(input);
    const afterHold = n4();
    release();
    const afterRelease = n4();
    check(`disk menu: icon ${i} clicks once on the press, nothing on the hold or the release`, onPress === 1 && afterHold === 1 && afterRelease === 1 && log.every((e) => e.id === SFX.CLICK));
    sfx.enabled = true; // icon 8 toggled it
  }
  openDisk();
  press(...centre(DISK_BUTTON.effects)); // effects toggle: the click is requested before the toggle runs
  check("disk menu: the effects icon clicks once with the state it had at the press", log.length === 1 && log[0].id === SFX.CLICK && log[0].enabled === true && sfx.enabled === true);
  release();
  check("disk menu: the toggle runs on the release", sfx.enabled === false && game.stage === "disk");
  press(...centre(DISK_BUTTON.effects));
  check("disk menu: the next press is requested while effects are off (the real Sfx drops it)", log.length === 2 && log[1].enabled === false);
  release();
  check("disk menu: and toggles back on", sfx.enabled === true);
  openDisk();
  press(...centre(DISK_BUTTON.load));
  check("disk menu: the load icon clicks once on the press and nothing opens before the release", log.length === 1 && log[0].id === SFX.CLICK && game.stage === "disk");
  release();
  check("disk menu: the release opens the remake load page (silent)", game.stage === "load" && log.length === 1);
  openDisk();
  press(...centre(DISK_BUTTON.exit));
  release();
  check("disk menu: the exit icon clicks once and returns to the map", log.length === 1 && game.stage === "map");
  openDisk();
  input.pointerX = 10;
  input.pointerY = 10;
  input.rightButton = true;
  game.update(input);
  input.rightButton = false;
  check("disk menu: a right click opens the remake submenu silently", log.length === 0 && game.stage === "remake");
  game.update(input);
  pressRow(1); // LOAD GAME of the remake submenu: a remake page, no $5948
  check("remake submenu: a row is silent and opens the remake load page", log.length === 0 && game.stage === "load");
  game.menu = null;
  game.diskMenu = null;
  game.stage = "map";
}

console.log(failed === 0 ? "all button sound checks passed" : `${failed} button sound check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
