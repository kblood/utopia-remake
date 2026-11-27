// Headless checks of the overview map (icon button 1), the marker mode (button 3) and the council room
// (button 5): src/game/screens/{overview,markers,council}.ts. Run after `npm run build`. Needs the
// user's own game data (Disk.1 and Disk.2 in original/utopia-whdload); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("overview tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { createScreen, MarkerMode, placeNextMarker, councilRefusal, markerMessageText, OverviewScreen, CouncilScreen } = await import("../dist/game/screens/index.js");
const { Game } = await import("../dist/game/game.js");
const { overviewColours, coverageMap, detectionMap, scrollForClick, clampScroll, OVERVIEW } = await import("../dist/game/screens/overview.js");
const { GameImage } = await import("../dist/game/screens/image.js");
const { mainBackground } = await import("../dist/game/screens/planar.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const strings = new GameStrings(disk1, 0);
const image = new GameImage(disk1);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A stand-in for the map scene's ObjectLayer: only what the overview and marker code touch.
function fakeObjects() {
  const markers = Array.from({ length: 8 }, (_, i) => ({ type: i + 1, x: 0, y: 0xff }));
  return {
    markers,
    units: { units: [] },
    toggleMarker(n, x, y) {
      const there = markers.find((m) => m.y !== 0xff && m.x === x && m.y === y);
      if (there) {
        there.y = 0xff;
        return "removed";
      }
      markers[n - 1].x = x;
      markers[n - 1].y = y;
      return "placed";
    },
  };
}

function fresh(extra = {}) {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const sim = new Sim(world, { rng: createRng(1) });
  const said = [];
  const ctx = { disk: disk1, world, sim, strings, say: (i) => said.push(i), ...extra };
  return { state, world, ctx, said };
}

const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
function press(scene, x, y) {
  input.pointerX = x;
  input.pointerY = y;
  input.leftButton = true;
  return scene.update(input);
}
function release(scene) {
  input.leftButton = false;
  return scene.update(input);
}
function click(scene, x, y) {
  press(scene, x, y);
  return release(scene);
}
const settle = (scene) => {
  input.leftButton = false;
  scene.update(input);
};

// Button rectangles of the overview ($FF5C), read from the disk.
const rect = (i) => {
  const a = 0xff5c + 8 * i;
  return { x0: image.word(a), x1: image.word(a + 2), y0: image.word(a + 4), y1: image.word(a + 6) };
};
const centre = (i) => {
  const r = rect(i);
  return [(r.x0 + r.x1) >> 1, (r.y0 + r.y1) >> 1];
};
const rectsAt = (x, y) => Array.from({ length: 8 }, (_, i) => rect(i)).some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
// Adviser rectangles of the council room ($1614E, 6 x {x0, x1, y0, y1}).
const adviserRect = (i) => {
  const a = 0x1614e + 8 * i;
  return { x0: image.word(a), x1: image.word(a + 2), y0: image.word(a + 4), y1: image.word(a + 6) };
};
const adviserCentre = (i) => {
  const r = adviserRect(i);
  return [(r.x0 + r.x1) >> 1, (r.y0 + r.y1) >> 1];
};

// --- colour classes of the layers ---------------------------------------------------------------------------
const W = 100;
const H = 75;
const cellsOf = (fill = 0) => new Uint16Array(W * H).fill(fill);
const circles = [7, 21, 31].map((n, i) => Uint8Array.from(image.bytes([0x10018, 0x10049, 0x10202][i], n * n)));
const env = (cells, extra = {}) => ({ cells, inventions: 0, power: 0, circles, units: { own: [], ships: [], enemyGround: [], enemyAir: [] }, ...extra });
{
  const cells = cellsOf();
  cells[5 * W + 5] = 0x1000; // rock (bit 12 set, bit 10 clear)
  cells[6 * W + 6] = 0x0400 | 0x32; // an animated building, tile $32
  cells[7 * W + 7] = 0x0400 | 2; // tile 1-3
  const c = overviewColours(0, env(cells));
  check("layer 0: ground, rock and building classes", c[0] === 5 && c[5 * W + 5] === 2 && c[6 * W + 6] === 9 && c[7 * W + 7] === 0x0d);
}
{
  const cells = cellsOf();
  cells[10 * W + 10] = 0x0400; // animated -> lets deposits be seen within 5 cells
  cells[10 * W + 14] = 0x8000; // deposit flag (bit 15)
  cells[40 * W + 40] = 0x8000;
  const seen = detectionMap(cells);
  check("detection boxes are 11 x 11 around animated cells", seen[10 * W + 15] === 0xff && seen[10 * W + 16] === 0 && seen[15 * W + 5] === 0xff && seen[16 * W + 5] === 0);
  const c = overviewColours(1, env(cells));
  check("layer 1: deposit shows inside the detection box only", c[10 * W + 14] === 0x0d && c[40 * W + 40] === 5);
  const known = overviewColours(1, env(cells, { inventions: 1 << 9 }));
  check("layer 1: invention bit 9 reveals every deposit", known[40 * W + 40] === 0x0d);
  const c2 = overviewColours(2, env(cells, { inventions: 1 << 9 }));
  check("layer 2 uses flag bit 11 and invention bit 10", c2[40 * W + 40] === 5);
}
{
  const cells = cellsOf();
  cells[30 * W + 30] = 0x0400 | 1; // tile < 6: 7 x 7 circle
  cells[50 * W + 50] = 0x0400 | 7; // tile 6-9: 21 x 21 circle
  const cover = coverageMap(env(cells));
  const count = (x0, y0) => {
    let n = 0;
    for (let y = y0 - 15; y <= y0 + 15; y++) for (let x = x0 - 15; x <= x0 + 15; x++) if (cover[y * W + x]) n++;
    return n;
  };
  check("coverage: small and large circles stamped around their centre", cover[30 * W + 30] !== 0 && cover[50 * W + 50] !== 0 && count(50, 50) > count(30, 30));
  check("coverage: nothing far from the buildings", cover[5 * W + 5] === 0);
  const weak = coverageMap(env(cells, { power: 4 }));
  check("coverage: tile 6-13 only works while the power byte is below 4", weak[50 * W + 50] === 0 && weak[30 * W + 30] !== 0);
  const all = coverageMap(env(cells, { inventions: 1 << 17 }));
  check("coverage: invention bit 17 covers everything", all[5 * W + 5] !== 0);
  const units = { own: [{ x: 3, y: 3 }], ships: [{ x: 4, y: 4 }], enemyGround: [{ x: 30, y: 31 }, { x: 90, y: 60 }], enemyAir: [] };
  const c = overviewColours(4, env(cells, { units }));
  check("layer 4: own 0x18, ships 6, enemies only inside coverage", c[3 * W + 3] === 0x18 && c[4 * W + 4] === 6 && c[31 * W + 30] === 9 && c[60 * W + 90] === 5);
}
check(
  "scroll for a click centres the 8 x 8 view and clamps",
  JSON.stringify(scrollForClick(8 + 2 * 50, 8 + 2 * 40)) === JSON.stringify({ x: 46, y: 36 }) &&
    JSON.stringify(scrollForClick(0, 0)) === JSON.stringify({ x: 0x5c, y: 0x43 }) &&
    JSON.stringify(scrollForClick(7, 7)) === JSON.stringify({ x: 0x5c, y: 0x43 }) &&
    JSON.stringify(clampScroll(500, 500)) === JSON.stringify({ x: 0x5c, y: 0x43 }),
);

// --- the overview screen --------------------------------------------------------------------------------------------
{
  const objects = fakeObjects();
  const scroll = { x: 10, y: 12 };
  const clickSounds = [];
  const { state, ctx } = fresh({ objects, scroll, sound: (id) => clickSounds.push(id) });
  const scene = createScreen("overview", ctx);
  const screen = new Screen();
  scene.draw(screen);
  const main = mainBackground(disk1);
  check("overview: draws a full-screen picture", screen.pixels.some((p) => p !== 0) && screen.pixels.some((p, i) => p !== main.pixels[i]));
  settle(scene);
  press(scene, ...centre(3));
  check("overview: requests click sound 4 on button press", clickSounds.join() === "4");
  scene.update(input); // held; no second press edge
  check("overview: held button does not repeat click sound", clickSounds.join() === "4");
  release(scene);
  check("overview: release does not request another click sound", clickSounds.join() === "4");
  check("overview: layer button sets the mode and writes $144B6", scene.mode === 3 && state.byte(OVERVIEW.mode) === 3);
  const before = new Screen();
  scene.draw(before);
  press(scene, ...centre(5));
  const during = new Screen();
  scene.draw(during);
  check("overview: pressed button is drawn flipped", during.pixels.some((p, i) => p !== before.pixels[i]));
  release(scene);
  check("overview: mode 5 after release", scene.mode === 5);
  click(scene, 8 + 2 * 60, 8 + 2 * 30);
  check("overview: map clicks do not request button sound", clickSounds.length === 2);
  check("overview: map click scrolls the view and writes it back", scroll.x === 56 && scroll.y === 26 && state.word(OVERVIEW.scrollX) === 56);
  click(scene, 0xe8 + 8 * 2 + 1, 0x4a + 8 * 3 + 1);
  const pin = objects.markers[0];
  check("overview: preview click places pin 1 at the clicked cell", pin.x === 58 && pin.y === 29);
  click(scene, 0xe8 + 8 * 2 + 1, 0x4a + 8 * 3 + 1);
  check("overview: same cell again lifts the pin", pin.y === 0xff);
  press(scene, ...centre(7));
  check("overview: exit button leaves on release", release(scene) === "close");

}
// Strict exits (static trace of $F208-$F2F6, screens.md section 8): only the release of the exit button (7) leaves; the loop
// reads no key and no right button, and a release is not tied to the pointer position.
{
  const { ctx } = fresh({ objects: fakeObjects(), scroll: { x: 10, y: 12 } });
  const main = mainBackground(disk1);
  const again = createScreen("overview", ctx);
  const target = new Screen();
  again.draw(target);
  settle(again);
  input.keys.push("Escape");
  check("overview: Escape does nothing", again.update(input) === "running");
  input.rightButton = true;
  check("overview: a right press does nothing", again.update(input) === "running");
  input.rightButton = false;
  check("overview: a right release does nothing", again.update(input) === "running");
  check("overview: a press off every button and off the map does nothing", press(again, 270, 150) === "running" && !rectsAt(270, 150));
  check("overview: its release does not leave (nothing was latched)", release(again) === "running");
  check("overview: a map press scrolls and does not leave", press(again, 8 + 2 * 60, 8 + 2 * 30) === "running" && again.scrollX === 56);
  check("overview: its release does not leave", release(again) === "running");
  check("overview: an exit press does not leave", press(again, ...centre(7)) === "running");
  input.pointerX = 250;
  input.pointerY = 20;
  check("overview: the exit release leaves wherever the pointer is", release(again) === "close");
  check("overview: closing restores the gameplay background and palette", target.pixels.every((p, i) => p === main.pixels[i]) && target.palette[1].join() === main.palette[1].join());
}
// The poll ($50B2) reports a right press while the left button is held as a press at the pointer ($F284); the latched
// button still runs on the left release.
{
  const { state, ctx } = fresh({ objects: fakeObjects(), scroll: { x: 10, y: 12 } });
  const scene = createScreen("overview", ctx);
  settle(scene);
  press(scene, ...centre(5));
  input.rightButton = true;
  input.pointerX = 8 + 2 * 60;
  input.pointerY = 8 + 2 * 30;
  check("overview: a right press while the left is held is a map press at the pointer", scene.update(input) === "running" && scene.scrollX === 56 && scene.scrollY === 26);
  input.rightButton = false;
  check("overview: the left release still runs the latched button 5", release(scene) === "running" && scene.mode === 5 && state.byte(OVERVIEW.mode) === 5);
}
{
  const { state, ctx } = fresh();
  state.setByte(OVERVIEW.mode, 6);
  check("overview: reopens in the stored mode", createScreen("overview", ctx).mode === 6);
  state.setByte(OVERVIEW.mode, 200);
  check("overview: invalid stored mode falls back to 0", createScreen("overview", ctx).mode === 0);
}

// --- marker mode -----------------------------------------------------------------------------------------------------
{
  const objects = fakeObjects();
  const mode = new MarkerMode();
  check("markers: click without arming is a normal selection", mode.click(objects, 5, 5) === null);
  check("markers: button 3 shows message $6F", mode.arm() === 0x6f && mode.armed);
  const r = mode.click(objects, 5, 5);
  check("markers: armed click puts pin 1 there ($71) and disarms", r.action === "placed" && r.message === 0x71 && r.pin === 1 && !mode.armed && objects.markers[0].x === 5);
  mode.arm();
  const r2 = mode.click(objects, 5, 5);
  check("markers: clicking a pin lifts it ($72)", r2.action === "removed" && r2.message === 0x72 && objects.markers[0].y === 0xff);
  for (let i = 0; i < 8; i++) placeNextMarker(objects, i, 1);
  check("markers: lowest free pin is used first", objects.markers.every((m, i) => m.x === i && m.y === 1));
  mode.arm();
  const r3 = mode.click(objects, 20, 20);
  check("markers: all pins in use does nothing ($70) but still disarms", r3.action === "full" && r3.message === 0x70 && !mode.armed && objects.markers.every((m) => m.y === 1));
  const text = markerMessageText(strings, 3);
  check("markers: message $71 text is returned", Array.isArray(text) && text.length > 0);
}

// --- the council room ----------------------------------------------------------------------------------------
{
  const { state, ctx, said } = fresh();
  state.setWord(0x133f8, 0);
  check("council: refused while no game is active", councilRefusal(ctx) === 0xb2);
  const scene = createScreen("council", ctx);
  check("council: refusal says $B2 and closes at once", said.join() === "178" && scene.update(input) === "close");
}
{
  const { state, ctx, said } = fresh();
  state.setWord(0x133f8, 1);
  check("council: allowed in a running game", councilRefusal(ctx) === -1);
  const scene = createScreen("council", ctx);
  const screen = new Screen();
  scene.draw(screen);
  check("council: draws the picture", screen.pixels.some((p) => p !== 0) && said.length === 0);
  settle(scene);
  // $2E48 then $5730 (static trace, screens.md section 9): the room waits for a press and then its release; the release
  // chooses the adviser under the pointer at that moment. A press alone opens nothing.
  const open = new Screen();
  check("council: a press on an adviser opens nothing yet", press(scene, ...adviserCentre(0)) === "running" && scene.adviser === -1);
  check("council: the release opens his report", release(scene) === "running" && scene.adviser === 0);
  scene.draw(open);
  check("council: adviser opens his report and portrait", open.pixels.some((p, i) => p !== screen.pixels[i]));
  check("council: a press alone on the report does not return to the room", press(scene, 2, 2) === "running" && scene.adviser === 0);
  check("council: its release returns to the room", release(scene) === "running" && scene.adviser === -1);
  check("council: a press elsewhere alone does not leave", press(scene, 150, 150) === "running");
  check("council: its release outside every adviser leaves", release(scene) === "close");
}
// The release, not the press, chooses: press on adviser 0, move to adviser 2 while held, release there.
{
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  const scene = createScreen("council", ctx);
  scene.draw(new Screen());
  settle(scene);
  press(scene, ...adviserCentre(0));
  input.pointerX = adviserCentre(2)[0];
  input.pointerY = adviserCentre(2)[1];
  check("council: moving while held chooses nothing", scene.update(input) === "running" && scene.adviser === -1);
  check("council: the release picks the adviser under the pointer", release(scene) === "running" && scene.adviser === 2);
  click(scene, 2, 2);
  settle(scene);
  press(scene, ...adviserCentre(1));
  input.pointerX = 150;
  input.pointerY = 150;
  check("council: pressing an adviser and releasing outside leaves the room", scene.update(input) === "running" && release(scene) === "close");
}
// Strict exits (screens.md section 9): Escape and the right button are not read; a release with no press does nothing.
{
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  const scene = createScreen("council", ctx);
  const screen = new Screen();
  scene.draw(screen);
  settle(scene);
  input.keys.push("Escape");
  check("council: Escape does nothing", scene.update(input) === "running");
  input.rightButton = true;
  check("council: a right press does nothing", scene.update(input) === "running");
  input.rightButton = false;
  scene.update(input);
  input.pointerX = adviserCentre(0)[0];
  input.pointerY = adviserCentre(0)[1];
  check("council: a release with no press opens nothing", scene.update(input) === "running" && scene.adviser === -1);
  const main = mainBackground(disk1);
  check("council: a release outside every adviser leaves and restores the gameplay background", press(scene, 150, 150) === "running" && release(scene) === "close" && screen.pixels.every((p, i) => p === main.pixels[i]));
}

// --- map return routes through the game: icon buttons 1 (overview) and 5 (council) on the map column -----------------
// Controls.BUTTON centres of the map column (test/command-buttons.mjs): overview (304, 71), council (304, 109).
{
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => void storage.set(k, String(v)),
    removeItem: (k) => void storage.delete(k),
  };
  const sfx = { enabled: true, count: 6, play: () => {}, setEnabled: () => {}, setVolume: () => {}, resume: () => {} };
  const game = new Game(disk1, disk2, null, sfx);
  game.strings = strings;
  game.bootMenuOpen = false; // the game proper is running
  game.stage = "scenario";
  game.startScenario(2);
  const MAP_OVERVIEW = [304, 71];
  const MAP_COUNCIL = [304, 109];
  // The map polls the mouse once per pass (every few VBL updates), so each event is held for several updates, as the
  // button tests do; the window screens see every update.
  const frame = (left, x, y, extra = {}) => {
    for (let i = 0; i < 8; i++) game.update({ leftButton: left, rightButton: false, pointerX: x, pointerY: y, keys: [], ...extra });
  };
  for (let i = 0; i < 8; i++) frame(false, 0, 0);
  check("routes: the game runs on the map", game.stage === "map");

  frame(true, ...MAP_OVERVIEW);
  check("routes: a press on icon 1 opens nothing yet", game.stage === "map");
  frame(false, ...MAP_OVERVIEW);
  check("routes: the icon 1 release opens the overview", game.stage === "screen" && game.window instanceof OverviewScreen);
  frame(false, 0, 0, { keys: ["Escape"] });
  frame(false, 0, 0, { rightButton: true });
  frame(false, 0, 0);
  check("routes: Escape and a right press do not leave the overview", game.stage === "screen" && game.window instanceof OverviewScreen);
  frame(true, 150, 150);
  frame(false, 150, 150);
  check("routes: a map press and release keep the overview open", game.stage === "screen" && game.window instanceof OverviewScreen);
  frame(true, ...centre(7));
  check("routes: an exit press does not leave", game.stage === "screen");
  frame(false, 250, 20);
  check("routes: the exit release returns to the map wherever the pointer is", game.stage === "map" && game.window === null);

  frame(true, ...MAP_COUNCIL);
  frame(false, ...MAP_COUNCIL);
  check("routes: the icon 5 release opens the council room", game.stage === "screen" && game.window instanceof CouncilScreen && game.window.adviser === -1);
  frame(false, 0, 0, { keys: ["Escape"] });
  frame(false, 0, 0, { rightButton: true });
  frame(false, 0, 0);
  check("routes: Escape and a right press do not leave the council room", game.stage === "screen" && game.window instanceof CouncilScreen);
  frame(true, ...adviserCentre(0));
  check("routes: an adviser press opens nothing yet", game.window.adviser === -1);
  frame(false, ...adviserCentre(0));
  check("routes: the adviser release opens his report", game.window.adviser === 0);
  frame(true, 150, 150);
  frame(false, 150, 150);
  check("routes: a click on the report returns to the room", game.stage === "screen" && game.window instanceof CouncilScreen && game.window.adviser === -1);
  frame(true, 150, 150);
  check("routes: a press outside every adviser does not leave", game.stage === "screen");
  frame(false, 150, 150);
  check("routes: its release returns to the map", game.stage === "map" && game.window === null);

  frame(true, ...MAP_OVERVIEW);
  frame(false, ...MAP_OVERVIEW);
  check("routes: the map still opens the overview after the council room", game.stage === "screen" && game.window instanceof OverviewScreen);
}

// --- blink cadence (screens.md section 8 "Blink cadence"; static trace of $F208-$F2F6, $F22C, $FD80/$FDA6, $FEC8, $50B2) ---
// The count of idle passes ($10A84, `move.w #$1770` at $F214) restarts at $F208 on every event that reaches it. The model
// gives 723 passes per frame, so the blink (6000 passes, then two VBL waits) falls on update 9 of a fresh overview and every
// 10 updates after that. Tests run on the model's own constants: the exact period on the Amiga is not established.
{
  const { BLINK_POLLS, IDLE_POLL_CLOCKS, PAL_FRAME_CLOCKS, IDLE_POLLS_PER_FRAME } = await import("../dist/game/screens/overview.js");
  check("blink: $F214 count is 6000 passes", BLINK_POLLS === 6000);
  check("blink: model clocks 196 per idle pass on a 141,875-clock PAL frame give 723 passes per frame", IDLE_POLL_CLOCKS === 196 && PAL_FRAME_CLOCKS === 141875 && IDLE_POLLS_PER_FRAME === 723);

  const openOverview = () => createScreen("overview", fresh({ objects: fakeObjects(), scroll: { x: 10, y: 12 } }).ctx);
  const idleAt = () => ({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
  // Runs `frames` updates; `at(i)` gives the input of update i. Returns the update indices where the pin phase changed.
  const toggles = (scene, frames, at = idleAt) => {
    const seen = [];
    let last = scene.pinsDrawn;
    for (let i = 0; i < frames; i++) {
      scene.update(at(i));
      if (scene.pinsDrawn !== last) {
        seen.push(i);
        last = scene.pinsDrawn;
      }
    }
    return seen.join();
  };
  const down = (x, y) => ({ leftButton: true, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  const up = (x, y) => ({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  const mapCell = [8 + 2 * 50, 8 + 2 * 40]; // inside the map ($F2D4)
  const offMap = [270, 150]; // off the map and off the preview and the buttons ($F2C4 -> $F208)

  check("blink: idle updates toggle the pins on updates 9, 19, 29, 39 ($F214 count, two VBL waits)", toggles(openOverview(), 40) === "9,19,29,39");

  {
    // $F22C ends the expiry frame (update 8); the second wait ($FDA6) is update 9, which polls nothing.
    const scene = openOverview();
    toggles(scene, 9);
    check("blink: the expiry frame leaves the blink waiting for its second VBL", scene.blinkPending === true && scene.pinsDrawn === false);
    const [bx, by] = centre(0);
    scene.update(down(bx, by)); // update 9: the wait frame, no mouse poll
    check("blink: the wait frame toggles the pins and polls nothing", scene.pinsDrawn === true && scene.blinkPending === false && scene.latchedButton === -1);
    scene.update(down(bx, by)); // update 10: the held press is seen now ($F21C -> $F262 -> $50B2)
    check("blink: the press is read on the first poll after the wait", scene.latchedButton === 0);
  }

  check(
    "blink: a layer button press only latches it ($5756 -> $F21C), so the count runs on: updates 9, 19, 29, 39",
    toggles(openOverview(), 40, (i) => (i === 5 ? down(...centre(3)) : i > 5 ? down(...centre(3)) : idleAt())) === "9,19,29,39",
  );
  check(
    "blink: the release of a latched layer button restarts the loop ($F2F6 -> $F208): toggles move to 15, 25, 35",
    toggles(openOverview(), 40, (i) => (i === 5 ? down(...centre(3)) : i === 6 ? up(...centre(3)) : idleAt())) === "15,25,35",
  );
  check(
    "blink: a right press alone reads no latch and does not restart the loop ($F26A -> $F274 -> $F21C)",
    toggles(openOverview(), 40, (i) => (i === 5 ? { leftButton: false, rightButton: true, pointerX: 0, pointerY: 0, keys: [] } : idleAt())) === "9,19,29,39",
  );
  check(
    "blink: a map press restarts the loop ($F2D4 -> $F2E8 -> $F2F6); the release that follows changes nothing",
    toggles(openOverview(), 40, (i) => (i === 5 ? down(...mapCell) : i === 6 ? up(...mapCell) : idleAt())) === "14,24,34",
  );
  check(
    "blink: a press off the map restarts the loop at once ($F2C4 -> $F208)",
    toggles(openOverview(), 40, (i) => (i === 5 ? down(...offMap) : i === 6 ? up(...offMap) : idleAt())) === "14,24,34",
  );
}

console.log(failed === 0 ? "all overview checks passed" : `${failed} overview check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
