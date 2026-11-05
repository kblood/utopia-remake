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
const { createScreen, MarkerMode, placeNextMarker, councilRefusal, markerMessageText } = await import("../dist/game/screens/index.js");
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
    JSON.stringify(scrollForClick(0, 0)) === JSON.stringify({ x: 0, y: 0 }) &&
    JSON.stringify(clampScroll(500, 500)) === JSON.stringify({ x: 0x5c, y: 0x43 }),
);

// --- the overview screen --------------------------------------------------------------------------------------------
{
  const objects = fakeObjects();
  const scroll = { x: 10, y: 12 };
  const { state, ctx } = fresh({ objects, scroll });
  const scene = createScreen("overview", ctx);
  const screen = new Screen();
  scene.draw(screen);
  const main = mainBackground(disk1);
  check("overview: draws a full-screen picture", screen.pixels.some((p) => p !== 0) && screen.pixels.some((p, i) => p !== main.pixels[i]));
  settle(scene);
  click(scene, ...centre(3));
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
  check("overview: map click scrolls the view and writes it back", scroll.x === 56 && scroll.y === 26 && state.word(OVERVIEW.scrollX) === 56);
  click(scene, 0xe8 + 8 * 2 + 1, 0x4a + 8 * 3 + 1);
  const pin = objects.markers[0];
  check("overview: preview click places pin 1 at the clicked cell", pin.x === 58 && pin.y === 29);
  click(scene, 0xe8 + 8 * 2 + 1, 0x4a + 8 * 3 + 1);
  check("overview: same cell again lifts the pin", pin.y === 0xff);
  press(scene, ...centre(7));
  check("overview: exit button leaves on release", release(scene) === "close");

  const again = createScreen("overview", ctx);
  const target = new Screen();
  again.draw(target);
  settle(again);
  input.keys.push("Escape");
  check("overview: Escape leaves", again.update(input) === "close");
  check("overview: closing restores the gameplay background and palette", target.pixels.every((p, i) => p === main.pixels[i]) && target.palette[1].join() === main.palette[1].join());
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
  const a = 0x1614e; // first adviser rectangle {x0, x1, y0, y1}
  const r = { x0: image.word(a), x1: image.word(a + 2), y0: image.word(a + 4), y1: image.word(a + 6) };
  const open = new Screen();
  click(scene, (r.x0 + r.x1) >> 1, (r.y0 + r.y1) >> 1);
  scene.draw(open);
  check("council: adviser opens his report and portrait", scene.adviser === 0 && open.pixels.some((p, i) => p !== screen.pixels[i]));
  settle(scene);
  click(scene, 2, 2);
  check("council: a press while a report is open returns to the room", scene.adviser === -1);
  settle(scene);
  check("council: a press elsewhere leaves", click(scene, 150, 150) === "close");
}
{
  const { state, ctx } = fresh();
  state.setWord(0x133f8, 1);
  const scene = createScreen("council", ctx);
  const screen = new Screen();
  scene.draw(screen);
  settle(scene);
  input.keys.push("Escape");
  const main = mainBackground(disk1);
  check("council: Escape leaves and restores the gameplay background", scene.update(input) === "close" && screen.pixels.every((p, i) => p === main.pixels[i]));
}

console.log(failed === 0 ? "all overview checks passed" : `${failed} overview check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
