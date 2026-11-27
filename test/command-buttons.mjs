// Command-button lifecycle on the map screen (src/game/controls.ts): the ten buttons of table $5E06 click on the PRESS ($5756)
// and act on the RELEASE edge ($50B2 returns 0 on it, $15A74 dispatches the index $5DD4 recorded at the press, wherever the
// pointer is); while paused only the overview button ($15AA0) and the pause button itself act ($15AB4-$15ABC, $15996-$159A6);
// map cells and the right button do nothing while paused ($158D4, $15F64). Notes: notes/formats/screens.md section 1,
// notes/formats/map-rendering.md section 8, notes/formats/sfx.md "Button click call paths".
// Uses the user's own game data in original/utopia-whdload (read-only); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("command button tests skipped: original data not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Builder } = await import("../dist/game/build.js");
const { Controls, BUTTON } = await import("../dist/game/controls.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");
const { Screen } = await import("../dist/gfx/screen.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

function rig() {
  const rec = readScenarioRecords(disk2)[0];
  const world = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
  const builder = new Builder(world, readFlagTable(disk1), readWeights(disk1), () => {});
  const log = { clicks: 0, screens: [], marker: 0, disk: 0, selects: 0, cells: 0 };
  const controls = new Controls(disk1, world, builder, strings, () => {}, () => ({ x: 47, y: 33 }), () => void log.disk++);
  let paused = false;
  controls.onClick = () => void log.clicks++;
  controls.isPaused = () => paused;
  controls.onPause = () => {
    paused = !paused;
  };
  controls.onScreen = (kind) => void log.screens.push(kind);
  controls.onMarkerButton = () => void log.marker++;
  controls.onSelect = () => void log.selects++;
  controls.cellHook = () => {
    log.cells++;
    return false;
  };
  const at = (leftButton, x, y, rightButton = false) => controls.update({ leftButton, rightButton, pointerX: x, pointerY: y, keys: [] });
  return { controls, log, at, setPaused: (on) => void (paused = on), isPaused: () => paused };
}

// Button centres (rectangles of table $5E06, index = d2 of the dispatch).
const C = [
  [280, 71], // 0 build
  [304, 71], // 1 overview
  [280, 90], // 2 demolish
  [304, 90], // 3 marker
  [280, 109], // 4 trade
  [304, 109], // 5 council
  [280, 128], // 6 staffing
  [304, 128], // 7 intelligence
  [304, 147], // 8 disk menu
  [280, 147], // 9 pause
];
const CELL = [128, 30]; // inside the first map diamond (112..143, 24..38)

// --- press clicks, release acts ----------------------------------------------------------------------------------
{
  const { controls, log, at } = rig();
  check("button centres hit the intended buttons", C.every(([x, y], i) => controls.buttonAt(x, y) === i));

  at(true, ...C[1]);
  check("overview: the press clicks and has not opened anything yet", log.clicks === 1 && log.screens.length === 0);
  at(true, ...C[1]);
  check("overview: holding adds no click and no action", log.clicks === 1 && log.screens.length === 0);
  at(false, 20, 20); // released away from the button: $15A74 uses $5DD4, not the pointer
  check("overview: the release dispatches the pressed button wherever the pointer is", log.screens.join() === "overview" && log.clicks === 1);
  at(false, 20, 20);
  check("a second release poll dispatches nothing", log.screens.length === 1);

  at(true, ...C[7]);
  at(false, ...C[7]);
  at(true, ...C[6]);
  at(false, ...C[6]);
  at(true, ...C[4]);
  at(false, ...C[4]);
  at(true, ...C[5]);
  at(false, ...C[5]);
  check("intelligence, staffing, trade and council dispatch on their releases", log.screens.slice(1).join() === "intel,staff,trade,council");

  at(true, ...C[3]);
  check("marker button: nothing before the release", log.marker === 0);
  at(false, ...C[3]);
  check("marker button acts on the release", log.marker === 1);
  at(true, ...C[8]);
  check("disk button: nothing before the release", log.disk === 0);
  at(false, ...C[8]);
  check("disk button acts on the release", log.disk === 1);

  at(true, ...C[2]);
  check("demolish: still select mode while held", controls.mode === "select");
  at(false, ...C[2]);
  check("demolish: mode changes on the release", controls.mode === "demolish");
  // `$15AF8` calls `$15ECA` with no test of `$14591`: a second press sets demolish mode again, it does not leave it (static, Disk.1).
  at(true, ...C[2]);
  at(false, ...C[2]);
  check("demolish: a second click keeps demolish mode ($15AF8 -> $15ECA, no mode test)", controls.mode === "demolish");
  at(false, 20, 20, true); // a right click outside the arrows leaves build / demolish mode ($15F64 -> $15EF0)
  at(false, 20, 20, false);
  check("demolish: a right click leaves the mode", controls.mode === "select");
  // `$15B0A` -> `$30FE`: the marker button outside select mode runs `$15EF0` first, then arms the marker (message `$6F`).
  at(true, ...C[2]);
  at(false, ...C[2]);
  check("setup: demolish mode on again", controls.mode === "demolish");
  const markerBefore = log.marker;
  at(true, ...C[3]);
  at(false, ...C[3]);
  check("marker button in demolish mode: the mode goes back to select before the marker is armed ($30FE)", controls.mode === "select" && log.marker === markerBefore + 1, `mode=${controls.mode} marker=${log.marker - markerBefore}`);

  // A press on a map cell is still a press action ($158CA); a later release over a button has nothing recorded in $5DD4.
  const clicks = log.clicks;
  const shown = log.screens.length;
  at(true, ...CELL);
  check("map cell press selects on the press, silently", log.selects === 1 && log.clicks === clicks);
  at(false, ...C[1]);
  check("a release over a button after a cell press dispatches nothing", log.screens.length === shown);
  // Pressing a button and releasing it on a cell still runs the button.
  at(true, ...C[1]);
  at(false, ...CELL);
  check("a button pressed and released over a map cell still runs", log.screens.length === shown + 1);

  // Menu via release, no leftover state.
  at(true, ...C[0]);
  check("build: the menu is not open before the release", !controls.menuVisible);
  at(false, ...C[0]);
  check("build: the menu opens on the release", controls.menuVisible);
}

// --- pressed look on the map ------------------------------------------------------------------------------------
{
  const { controls, at } = rig();
  const shot = () => {
    const screen = new Screen();
    screen.pixels.fill(7);
    controls.draw(screen);
    return screen;
  };
  const idle = shot();
  at(true, ...C[1]);
  const held = shot();
  let ok = true;
  let changed = 0;
  for (let i = 0; i < idle.pixels.length; i++) {
    const x = i % 320;
    const y = (i / 320) | 0;
    const inside = x >= 296 && x <= 311 && y >= 63 && y <= 78;
    if (held.pixels[i] !== (inside ? idle.pixels[i] ^ 8 : idle.pixels[i])) ok = false;
    if (held.pixels[i] !== idle.pixels[i]) changed++;
  }
  check("a pressed map command button is flipped by colour ^ 8 inside its rectangle only", ok && changed === 256);
  at(false, 20, 20);
  const after = shot();
  check("the release flips it back", after.pixels.every((p, i) => p === idle.pixels[i]));
}

// --- the pause button ------------------------------------------------------------------------------------------
{
  const { controls, log, at, isPaused } = rig();
  const shot = () => {
    const screen = new Screen();
    screen.pixels.fill(7);
    controls.draw(screen);
    return screen;
  };
  const running = shot();
  at(true, ...C[9]);
  check("pause: pressing the pause button pauses at once and clicks", isPaused() && log.clicks === 1);
  at(false, ...C[9]);
  check("pause: the release changes nothing", isPaused() && log.clicks === 1 && log.screens.length === 0);
  const paused = shot();
  let flipped = 0;
  for (let i = 0; i < paused.pixels.length; i++) if (paused.pixels[i] !== running.pixels[i]) flipped++;
  check("pause: the pause button stays flipped while paused ($159C4 leaves it pressed)", flipped === 256);
  at(true, ...C[9]);
  check("pause: pressing it again resumes at once and silently", !isPaused() && log.clicks === 1);
  at(false, ...C[9]);
  check("pause: after the resume release the button is flipped back", shot().pixels.every((p, i) => p === running.pixels[i]));
}

// --- paused: only the original-permitted actions -------------------------------------------------------------------
{
  const { controls, log, at, setPaused, isPaused } = rig();
  setPaused(true);
  const clicks0 = log.clicks;
  for (const b of [0, 2, 3, 4, 5, 6, 7, 8]) {
    at(true, ...C[b]);
    at(false, ...C[b]);
  }
  check("paused: build, demolish, marker, trade, council, staffing, intelligence and disk do nothing",
    !controls.menuVisible && controls.mode === "select" && log.marker === 0 && log.disk === 0 && log.screens.length === 0);
  check("paused: those presses still click ($159AC -> $5756)", log.clicks - clicks0 === 8);
  at(true, ...C[1]);
  at(false, ...C[1]);
  check("paused: the overview button still opens ($15AA0 is reached before the pause test)", log.screens.join() === "overview");
  at(true, ...CELL);
  at(false, ...CELL);
  check("paused: a map cell click does nothing ($158D4)", log.selects === 0 && log.cells === 0);

  // Right click: leaves build / demolish mode only while running.
  setPaused(false);
  at(true, ...C[2]);
  at(false, ...C[2]);
  check("setup: demolish mode on", controls.mode === "demolish");
  setPaused(true);
  at(false, 20, 20, true);
  at(false, 20, 20, false);
  check("paused: a right click does not leave demolish mode ($15F64)", controls.mode === "demolish");
  setPaused(false);
  at(false, 20, 20, true);
  check("running: a right click leaves demolish mode", controls.mode === "select");

  // Resume with the pause button: no dispatch afterwards even though $5DD4 = 9 is pending.
  at(true, ...C[9]);
  at(false, ...C[9]);
  check("setup: paused again by the button", isPaused());
  const before = log.screens.length;
  at(true, ...C[1]); // overview pressed while the pause press is still recorded: $5DD4 is overwritten by the new press
  at(false, ...C[1]);
  check("paused with the pause button pending: overview still works once", log.screens.length === before + 1 && isPaused());
  at(true, ...C[9]);
  at(false, ...C[9]);
  check("paused: the pause button resumes", !isPaused());
}

// --- a pause left by key drops the stale pressed pause button -----------------------------------------------------------
{
  const { controls, log, at, setPaused, isPaused } = rig();
  at(true, ...C[9]);
  at(false, ...C[9]);
  check("setup: paused by the button", isPaused());
  setPaused(false); // P / space ($15C02 -> $159FC + $57FA)
  const screen = new Screen();
  screen.pixels.fill(7);
  at(false, 20, 20);
  controls.draw(screen);
  check("P key resume: the pause button is not left flipped", screen.pixels.every((p) => p === 7));
  at(true, ...C[1]);
  at(false, ...C[1]);
  check("P key resume: the next button works normally", log.screens.join() === "overview" && !isPaused());
}

// Mode marker (controls.ts draw). Build mode draws no frame around the build button (272, 63): the original's closed-menu
// build-mode captures show the plain button (building.md, "Construction-site frame comparison"). Demolish mode keeps its
// 60-pixel frame around button 2 (272, 82), which has no original capture yet.
{
  const drawMode = (mode) => {
    const r = rig();
    r.controls.mode = mode;
    const screen = new Screen();
    screen.pixels.fill(7);
    r.controls.draw(screen);
    return screen;
  };
  const inBox = (i, x0, y0) => {
    const x = i % 320;
    const y = (i / 320) | 0;
    return x >= x0 && x < x0 + 16 && y >= y0 && y < y0 + 16;
  };
  const select = drawMode("select");
  const build = drawMode("build");
  const demolish = drawMode("demolish");
  let buildBox = 0;
  for (let i = 0; i < select.pixels.length; i++) if (inBox(i, 272, 63) && build.pixels[i] !== select.pixels[i]) buildBox++;
  check("build mode: the build button (272, 63) is drawn with no marker frame", buildBox === 0, `${buildBox} pixels differ`);
  let demolishBox = 0;
  for (let i = 0; i < select.pixels.length; i++) if (inBox(i, 272, 82) && demolish.pixels[i] !== select.pixels[i]) demolishBox++;
  check("demolish mode: the demolish button (272, 82) keeps its 60-pixel frame", demolishBox === 60, `${demolishBox} pixels differ`);
}

console.log(failed === 0 ? "all command button checks passed" : `${failed} command button check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
