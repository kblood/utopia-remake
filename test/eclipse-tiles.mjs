// Checks of the eclipse tile view (src/game/eclipse-tiles.ts) and its wiring in MapScene (src/game/map.ts). Run after
// `npm run build`. Part 1-2 are synthetic: hand-made descriptors and image bytes, no game files. They check the exchange
// (pairs 4 <-> 51 and 50 <-> 54 only, rows kept, other entries the same objects), immutability of the source tiles and
// their images, reversibility (a second exchange restores the addresses), and the error cases. Part 3 uses the player's own
// Disk.1 / Disk.2 in original/utopia-whdload and is skipped when they are missing. It checks the loader's source addresses
// and that a live MapScene's tile list (shared by ObjectLayer, Controls and the build menu) follows `Sim.tileExchange`, the
// parity of the traced `$11024` calls (test/eclipse-parity.mjs covers the calls and the session rules).
// Nothing here compares with the running original; the visible effect of the swap is not observed and is not claimed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { eclipseTileView, ECLIPSE_TILE_PAIRS } = await import("../dist/game/eclipse-tiles.js");
const { SYS } = await import("../dist/game/sim.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameTile = (a, b) =>
  a.rows === b.rows &&
  sameBytes(a.planes, b.planes) &&
  (a.source === undefined ? b.source === undefined : b.source !== undefined && a.source.image === b.source.image && a.source.offset === b.source.offset);

// ---- 1. synthetic tiles ------------------------------------------------------------------------------------------------
const SLOT = 128; // each tile's data sits in its own slot; the largest tile here is 5 rows = 120 bytes
const image = Uint8Array.from({ length: 60 * SLOT }, (_, i) => (i * 37 + 11) & 0xff);
const rowsOf = { 4: 3, 51: 5, 50: 2, 54: 4 };
const makeBase = () =>
  Array.from({ length: 60 }, (_, i) => {
    const rows = rowsOf[i] ?? (i % 4) + 1;
    const offset = i * SLOT;
    return { rows, planes: image.slice(offset, offset + rows * 24), source: { image, offset } };
  });
const base = makeBase();
const snapshot = base.map((t) => ({ rows: t.rows, planes: t.planes.slice(), image: t.source.image, offset: t.source.offset, object: t }));
const imageCopy = image.slice();

check("the helper exchanges pairs 4<->51 and 50<->54 (0-based descriptor indices)", JSON.stringify(ECLIPSE_TILE_PAIRS) === JSON.stringify([[4, 51], [50, 54]]));
check("the eclipse flag is $156AA bit 6 (SYS.eclipse)", SYS.eclipse === 0x40);

// inactive: same tile objects, a new array
const off = eclipseTileView(base, false);
check("inactive: a new array of the same length", off !== base && off.length === base.length);
check("inactive: every entry is the same tile object as in the input", off.every((t, i) => t === base[i]));

// active: exactly the four entries change; rows kept; addresses exchanged
const on = eclipseTileView(base, true);
check("active: a new array of the same length", on !== base && on.length === base.length);
const changed = [4, 50, 51, 54];
check("active: all other entries are the same tile objects", on.every((t, i) => changed.includes(i) || t === base[i]));
check("active: every changed entry is a new tile object", changed.every((i) => on[i] !== base[i]));
check("active: rows are kept on every entry", on.every((t, i) => t.rows === base[i].rows));
check("active: entry 4 reads the address of entry 51 with its own rows", on[4].source.offset === base[51].source.offset && on[4].planes.length === base[4].rows * 24 && sameBytes(on[4].planes, image.slice(51 * SLOT, 51 * SLOT + 3 * 24)));
check("active: entry 51 reads the address of entry 4 with its own rows", on[51].source.offset === base[4].source.offset && sameBytes(on[51].planes, image.slice(4 * SLOT, 4 * SLOT + 5 * 24)));
check("active: entry 50 reads the address of entry 54 with its own rows", on[50].source.offset === base[54].source.offset && sameBytes(on[50].planes, image.slice(54 * SLOT, 54 * SLOT + 2 * 24)));
check("active: entry 54 reads the address of entry 50 with its own rows", on[54].source.offset === base[50].source.offset && sameBytes(on[54].planes, image.slice(50 * SLOT, 50 * SLOT + 4 * 24)));
check("active: a swapped entry keeps its source image (no copy of the sheet)", on[4].source.image === image && on[51].source.image === image);

// immutability: the input tiles, their planes and the image are untouched by either call
check("immutability: input tile objects, rows, planes and addresses unchanged after both calls", base.every((t, i) => t === snapshot[i].object && t.rows === snapshot[i].rows && sameBytes(t.planes, snapshot[i].planes) && t.source.offset === snapshot[i].offset && t.source.image === snapshot[i].image));
check("immutability: the image bytes are unchanged", sameBytes(image, imageCopy));
check("immutability: the input array keeps its length and order", base.length === 60 && base[4] === snapshot[4].object);

// reversibility: exchanging again restores every entry
const back = eclipseTileView(on, true);
check("reversibility: a second exchange restores every entry (rows, planes, addresses)", back.every((t, i) => sameTile(t, base[i])));
check("reversibility: the restored array is a new array, and the source is still the input", back !== base && base[4] === snapshot[4].object);
check("reversibility: the inactive view of the exchanged list is the exchanged list itself", eclipseTileView(on, false).every((t, i) => t === on[i]));

// error cases: a missing pair entry, a missing source address, an address that runs past its image
let threw = "";
try { eclipseTileView(base.slice(0, 40), true); } catch (error) { threw = error.message; }
check("a list too short for the pairs throws (no partial view)", threw.includes("eclipseTileView"), threw);
const noSource = base.map((t) => ({ rows: t.rows, planes: t.planes }));
threw = "";
try { eclipseTileView(noSource, true); } catch (error) { threw = error.message; }
check("tiles without a source address throw", threw.includes("no source address"), threw);
check("inactive view needs no sources", eclipseTileView(noSource, false).length === 60);
const overrun = base.slice();
overrun[51] = { rows: 5, planes: base[51].planes, source: { image, offset: image.length - 10 } };
threw = "";
try { eclipseTileView(overrun, true); } catch (error) { threw = error.message; }
check("an exchanged address past its image throws", threw.includes("outside its image"), threw);

// ---- 2. the real loader keeps the sources (player's own disks; skipped when missing) -------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("skip  the player's Disk.1 / Disk.2 are missing: loader and MapScene wiring checks not run");
} else {
  const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
  const { loadSprites } = await import("../dist/data/sprites.js");
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const { GameState } = await import("../dist/game/state.js");
  const { World } = await import("../dist/game/world.js");
  const { MapScene } = await import("../dist/game/map.js");

  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const record = readScenarioRecords(disk2)[0];
  const tiles = loadTileSet(disk1, disk2, record).tiles;

  const everySource = tiles.every((t) => t.source && sameBytes(t.planes, t.source.image.slice(t.source.offset, t.source.offset + t.rows * 24)));
  check("loader: every tile keeps its source address and its planes are that address's bytes", everySource && tiles.length === 161);

  const view = eclipseTileView(tiles, true);
  check("real tiles: entry 4 gets the planes of entry 51 and keeps its rows", view[4].rows === tiles[4].rows && sameBytes(view[4].planes, tiles[51].planes));
  check("real tiles: entry 51 gets the planes of entry 4 and keeps its rows", view[51].rows === tiles[51].rows && sameBytes(view[51].planes, tiles[4].planes));
  check("real tiles: entry 50 and 54 exchange planes", sameBytes(view[50].planes, tiles[54].planes) && sameBytes(view[54].planes, tiles[50].planes));
  check("real tiles: the exchanged planes differ from the originals (a visible change if drawn)", !sameBytes(tiles[4].planes, tiles[51].planes) && !sameBytes(tiles[50].planes, tiles[54].planes));
  check("real tiles: exchanging twice restores the loaded tiles", eclipseTileView(view, true).every((t, i) => sameTile(t, tiles[i])));

  // MapScene wiring: the scene's own tile list follows the sim's exchange parity (Sim.tileExchange) at each draw; the consumers
  // hold that same list. The flag (SYS.eclipse) alone changes nothing any more: the parity is set by the traced calls only.
  const makeScene = () => new MapScene(disk1, tiles, new World(new GameState(disk2, record.block), loadMap(disk2, record)), new GameStrings(disk1, 0), { sprites: loadSprites(disk1, disk2, record) });
  const scene = makeScene();
  check("MapScene: the scene list starts as the loaded tiles (same objects)", scene.tiles.length === tiles.length && scene.tiles.every((t, i) => t === tiles[i]));
  check("MapScene: ObjectLayer and Controls hold the scene's own list", scene.objects !== null && scene.objects.tiles === scene.tiles && scene.controls.tiles === scene.tiles && scene.tiles !== tiles);

  scene.drawInitialFrame(); // the initial presentation; drawPass / drawModal sync the same way (private in TS)
  check("MapScene: parity clear, first draw leaves the loaded tiles in place", scene.tiles.every((t, i) => t === tiles[i]));

  scene.sim.sysFlags |= SYS.eclipse; // the flag alone does not exchange the table
  scene.drawInitialFrame();
  check("MapScene: flag set without a traced call, the scene list still shows the loaded tiles", scene.tiles.every((t, i) => t === tiles[i]));
  scene.sim.sysFlags &= ~SYS.eclipse;

  scene.sim.tileExchange = true; // what the eclipse start (`$1100A`) leaves
  scene.drawInitialFrame();
  check("MapScene: parity set, the scene list shows the exchange for 4/51/50/54", sameBytes(scene.tiles[4].planes, tiles[51].planes) && sameBytes(scene.tiles[51].planes, tiles[4].planes) && sameBytes(scene.tiles[50].planes, tiles[54].planes) && sameBytes(scene.tiles[54].planes, tiles[50].planes));
  check("MapScene: parity set, the other entries are the loaded tile objects", scene.tiles.every((t, i) => [4, 50, 51, 54].includes(i) || t === tiles[i]));
  check("MapScene: parity set, ObjectLayer and Controls still hold the same list", scene.objects.tiles === scene.tiles && scene.controls.tiles === scene.tiles);
  const fresh = loadTileSet(disk1, disk2, record).tiles;
  // a fresh load decompresses into new buffers, so compare the image bytes by value here
  const sameByValue = (x, y) => x.rows === y.rows && sameBytes(x.planes, y.planes) && x.source.offset === y.source.offset && sameBytes(x.source.image, y.source.image);
  check("MapScene: the loaded tiles are unchanged while the view is exchanged (compared with a fresh load)", tiles.every((t, i) => sameByValue(t, fresh[i])));

  scene.drawInitialFrame(); // a second draw with the same parity does nothing new
  check("MapScene: repeated draws with the parity set keep the same view", sameBytes(scene.tiles[4].planes, tiles[51].planes));

  scene.sim.tileExchange = false; // the eclipse end (`$1100A`) toggles back
  scene.drawInitialFrame();
  check("MapScene: parity cleared, the scene list returns to the loaded tiles (same objects)", scene.tiles.every((t, i) => t === tiles[i]));

  const preset = makeScene();
  preset.sim.tileExchange = true; // a scene that starts exchanged (e.g. a restored session) shows the view from its first draw
  preset.drawInitialFrame();
  check("MapScene: a scene that starts exchanged shows the view from its first draw", sameBytes(preset.tiles[4].planes, tiles[51].planes));
}

console.log(failed ? `${failed} check(s) failed` : "all eclipse tile checks passed");
process.exitCode = failed ? 1 : 0;
