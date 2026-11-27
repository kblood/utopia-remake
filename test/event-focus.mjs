// Live MapScene check of the event focus ($11432): the bookmark moves to the event cell, the view does not.
// Static Disk.1 trace (notes/formats/sim-port.md "View bookmark"): $11432 writes $144E8/$144EA, $15644 and $144BD only.
// Uses player-supplied WHDLoad data for tables/assets; the tanks and the event calls are synthetic.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("event focus checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");
const { LIGHT } = await import("../dist/game/sim-alerts.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const world = new World(new GameState(disk2, record.block), loadMap(disk2, record));
const state = world.state;
// Rolls answer the largest value, so chance-gated events in the passes do not fire; the event under test is called directly.
const scene = new MapScene(disk1, loadTileSet(disk1, disk2, record).tiles, world, new GameStrings(disk1, 0), {
  sprites: loadSprites(disk1, disk2, record),
  simulation: {
    interactive: false,
    decide: () => false,
    rng: (range) => range - 1,
    hardware: { todLow: () => 0, rasterParity: () => 0 },
  },
});
const sim = scene.sim;
const idle = { leftButton: false, rightButton: false, pointerX: 10, pointerY: 10, keys: [] };
const press = { leftButton: true, rightButton: false, pointerX: 20, pointerY: 145, keys: [] };
const release = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 145, keys: [] };
const view = () => [scene.scrollX, scene.scrollY];
const bookmark = () => [state.word(0x144e8), state.word(0x144ea)];
const sameView = (v) => v[0] === scene.scrollX && v[1] === scene.scrollY;

// Start view: the first scenario's view (scenario 0 new game is (47,33); the scene keeps the view outside the state image).
scene.scrollX = 30;
scene.scrollY = 20;

// ---- 1. defections of real tanks at edge and interior cells ---------------------------------------------------------
const cases = [
  [40, 30, 36, 26],
  [0, 0, 0, 0],
  [4, 4, 0, 0],
  [3, 7, 0, 3],
  [99, 74, 92, 67],
];
for (const [x, y, bx, by] of cases) {
  const before = view();
  state.setWord(0x1429c, 1); // own tank count, the event's guard
  const tank = scene.objects.units.spawn(9, x, y, 4);
  sim.aliens.eventTankDefect(100);
  const converted = scene.enemies.ground.some((g) => g.x === x && g.y === y);
  check(`tank at (${x},${y}) defects: bookmark (${bx},${by}), light on, view unchanged`,
    !!tank && converted && scene.objects.units.units.length === 0 && sameView(before) && bookmark()[0] === bx && bookmark()[1] === by && sim.alerts.lit(LIGHT.focus),
    `bookmark ${bookmark().join(",")} view ${view().join(",")}`);
}

// ---- 2. regular camera movement after the event ---------------------------------------------------------------------
const beforeScroll = bookmark();
scene.scroll(1, 0, 1);
check("scroll right one cell after the event moves the view and leaves the bookmark", scene.scrollX === 31 && bookmark().join() === beforeScroll.join(), `view ${view().join(",")}`);
scene.scrollX = 30;
scene.scroll(1, 0, 200);
check("scroll right clamps to x 92 (MAX_SCROLL_X)", scene.scrollX === 92);
scene.scroll(-1, 0, 500);
check("scroll left clamps to x 0", scene.scrollX === 0);
scene.scroll(0, 1, 200);
check("scroll down clamps to y 67 (MAX_SCROLL_Y)", scene.scrollY === 67);
scene.scroll(0, -1, 500);
check("scroll up clamps to y 0", scene.scrollY === 0);
scene.scrollX = 30;
scene.scrollY = 20;

// ---- 3. the bookmark light jumps to the event cell and a second click returns ---------------------------------------
// The poll runs once per completed pass and reads the pointer and button of the update that completes the pass, so the
// input is held at the light for whole passes (a press, then a release, then a press again).
const runPasses = (input) => { for (let i = 0; i < 2 * scene.loop.vblPerPass; i++) scene.update({ ...input, keys: [] }); };
sim.alerts.focus(40, 30); // bookmark (36, 26), as the defection of (40,30) leaves it
runPasses(press);
check("click on the bookmark light: view goes to (36,26), the old view becomes the bookmark", view().join() === "36,26" && bookmark().join() === "30,20", `view ${view().join(",")} bookmark ${bookmark().join(",")}`);
runPasses(release);
runPasses(press);
check("second click returns to the old view and keeps the bookmark", view().join() === "30,20" && bookmark().join() === "36,26", `view ${view().join(",")} bookmark ${bookmark().join(",")}`);
runPasses(release);

// ---- 4. passes after an event do not move the view on their own ---------------------------------------------------
const stillAt = view();
for (let i = 0; i < 3 * scene.loop.vblPerPass; i++) scene.update({ ...idle, keys: [] });
check("passes after the event leave the view where the player put it", sameView(stillAt), `view ${view().join(",")}`);

if (failed) {
  console.log(`${failed} event focus check(s) failed`);
  process.exit(1);
}
console.log("event focus checks passed");
