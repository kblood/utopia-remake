// Optional, read-only comparison of one Copperline window grab of the build-mode side preview (272, bottom row 52) with
// the remake's full MapScene frame in the same state. The side preview is drawn by Controls.draw (`$6B10` after a build
// selection is committed; src/game/controls.ts, MODE_ICON). It lies outside the menu panel that
// build-menu-capture-compare.mjs covers, so this comparator is separate.
//
// Usage (after `npm run build`):   UTOPIA_SIDE_CAPTURE=<absolute path to a .png> node test/build-side-preview-capture-compare.mjs
//                                  [UTOPIA_SIDE_STATE=before|after]   (default before; see "States")
//
// States (from the 2026-11-06 Copperline capture set `UtopiaCostProbe-20261106-161056`, snapshot JSON, outside the repo):
//   before  snap-D-before-placement: build mode, tank yard (tile $45, type 22) committed in $142B2, money $7B8AE = 506030.
//   after   snap-E-after-placement:  same selection after one legal placement, money $7A13E = 500030 (6000 spent, $142CA).
// The remake state is the same: mode build, selection tile $45 / type 22, money set to the state's value, scroll (47, 33),
// the fresh-scenario frame drawn by MapScene.drawInitialFrame (presentation only; no simulation pass).
//
// Capture model: the same as build-menu-capture-compare.mjs (a W x H grab with W even whose column pairs (2k, 2k+1) are
// identical, i.e. a 2x horizontal nearest-neighbour upscale). The native origin is searched over the whole 320 x 200 frame
// and accepted only when the best origin has at most 10% mismatches of the full frame and is at least three times better
// than every origin outside a +-2 neighbourhood. The preview box is then compared at that origin. The full-frame count is
// printed, not compared: the log panel and cost lines are not staged, so they differ from the capture (see the output).
//
// Exit codes with a capture: 0 match (zero mismatches in the preview box); 1 divergence; 2 unavailable (not a 2x grab, no
// valid alignment, original Disk.1/Disk.2 missing). Without UTOPIA_SIDE_CAPTURE the script runs its self-test and reports
// "skipped" with exit 0. A capture inside the repository is refused (exit 1).
//
// Evidence limits: one frame per state, one capture set, the side-preview box only. A match is not a claim about the
// rest of the frame, the mode icon in select mode, other tiles (2 x 2 buildings included), other pages, pointer overlay or
// timing. The pixels under the box come from the remake's map background, so a mismatch there would be a background
// difference as much as a preview difference; the box is therefore also reported with the preview's own footprint.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, PixelError } from "./png-codec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 320;
const HEIGHT = 200;
const TILE = 0x45; // tank construction yard, picked on page 2 (type table entry 22)
const TYPE = 22;
const BOTTOM_ROW = 52; // MODE_ICON bottom row
const PREVIEW_X = 272;
// Box that contains the whole 1 x 1 preview (32 columns, 31 rows above the bottom row) plus a one-pixel margin.
const BOX = { x0: PREVIEW_X - 1, y0: BOTTOM_ROW - 31 - 1, x1: PREVIEW_X + 33, y1: BOTTOM_ROW + 2 };
const STATES = {
  before: { money: 506030, label: "snap-D-before-placement" },
  after: { money: 500030, label: "snap-E-after-placement" },
};

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// ---- pure helpers (shared by the self-test and the capture comparison) ----------------------------------------------

export function nativeWidthIfPaired(grab) {
  if (grab.width % 2 !== 0) return null;
  const rgba = grab.rgba;
  for (let y = 0; y < grab.height; y++) {
    for (let k = 0; k < grab.width / 2; k++) {
      const a = (y * grab.width + 2 * k) * 4;
      const b = a + 4;
      if (rgba[a] !== rgba[b] || rgba[a + 1] !== rgba[b + 1] || rgba[a + 2] !== rgba[b + 2]) return null;
    }
  }
  return grab.width / 2;
}

export function grabNative(grab, ox, oy, x, y) {
  const c = ((y + oy) * grab.width + 2 * (x + ox)) * 4;
  return (grab.rgba[c] << 16) | (grab.rgba[c + 1] << 8) | grab.rgba[c + 2];
}

function originMismatches(grab, ox, oy, expected) {
  let mis = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (grabNative(grab, ox, oy, x, y) !== expected[y * WIDTH + x]) mis++;
  return mis;
}

// Whole-frame origin search. Returns { ox, oy, mismatched, second } or a reason string.
export function findFrameOrigin(grab, expected) {
  const nativeWidth = nativeWidthIfPaired(grab);
  if (nativeWidth === null) return "not a 2x horizontal upscale (column pairs differ or width is odd)";
  const maxOx = nativeWidth - WIDTH;
  const maxOy = grab.height - HEIGHT;
  if (maxOx < 0 || maxOy < 0) return `grab ${grab.width} x ${grab.height} is smaller than a native 320 x 200 frame at 2x`;
  const scores = [];
  for (let oy = 0; oy <= maxOy; oy++) for (let ox = 0; ox <= maxOx; ox++) scores.push({ ox, oy, mis: originMismatches(grab, ox, oy, expected) });
  scores.sort((a, b) => a.mis - b.mis);
  const best = scores[0];
  const second = scores.find((s) => Math.abs(s.ox - best.ox) > 2 || Math.abs(s.oy - best.oy) > 2);
  // The whole frame is not expected to match here: the log panel and cost lines are not staged, and the map may carry a
  // hover marker. The gate is therefore 10% of the frame plus the separation test below, not an exact frame match.
  if (best.mis > (WIDTH * HEIGHT) / 10) return `best origin (${best.ox}, ${best.oy}) mismatches ${best.mis} of ${WIDTH * HEIGHT} (more than 10%)`;
  if (second && second.mis < 3 * best.mis) return `origin is ambiguous: (${best.ox}, ${best.oy}) ${best.mis} vs (${second.ox}, ${second.oy}) ${second.mis}`;
  return { ox: best.ox, oy: best.oy, mismatched: best.mis, second: second ? { ox: second.ox, oy: second.oy, mis: second.mis } : null };
}

// Compares `box` at one origin. Returns the mismatch count, the bounding box of mismatches and the colour pairs seen.
export function compareBox(grab, ox, oy, expected, box) {
  const out = { compared: 0, mismatched: 0, extent: null, pairs: new Map() };
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      out.compared++;
      const got = grabNative(grab, ox, oy, x, y);
      const want = expected[y * WIDTH + x];
      if (got === want) continue;
      out.mismatched++;
      out.extent = out.extent
        ? { x0: Math.min(out.extent.x0, x), x1: Math.max(out.extent.x1, x), y0: Math.min(out.extent.y0, y), y1: Math.max(out.extent.y1, y) }
        : { x0: x, x1: x, y0: y, y1: y };
      const key = `${want.toString(16).padStart(6, "0")}->${got.toString(16).padStart(6, "0")}`;
      out.pairs.set(key, (out.pairs.get(key) ?? 0) + 1);
    }
  }
  return out;
}

// ---- self-test (always runs; no original files) ---------------------------------------------------------------------

function selfTest() {
  const palette = Array.from({ length: 32 }, (_, i) => (((i * 37) & 255) << 16) | (((i * 91 + 7) & 255) << 8) | ((255 - i * 8) & 255));
  const index = Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => ((i * 2654435761) >>> 27) & 31);
  const expected = Uint32Array.from(index, (i) => palette[i]);
  const GW = 2 * (WIDTH + 20);
  const GH = HEIGHT + 30;
  const rgba = new Uint8Array(GW * GH * 4);
  const put = (gx, gy, c) => rgba.set([c >> 16, (c >> 8) & 255, c & 255, 255], (gy * GW + gx) * 4);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx += 2) { const c = ((gx * 13) ^ (gy * 29)) & 0xffffff; put(gx, gy, c); put(gx + 1, gy, c); }
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) for (let k = 0; k < 2; k++) put(2 * (x + 7) + k, y + 5, expected[y * WIDTH + x]);
  const grab = { width: GW, height: GH, rgba };
  const found = findFrameOrigin(grab, expected);
  check("synthetic 2x grab: frame origin found at (7, 5) with no mismatch", typeof found === "object" && found.ox === 7 && found.oy === 5 && found.mismatched === 0, typeof found === "object" ? `(${found.ox}, ${found.oy}) mismatches ${found.mismatched}` : found);
  const exact = compareBox(grab, 7, 5, expected, BOX);
  check("synthetic preview box compares exact", exact.compared === (BOX.x1 - BOX.x0) * (BOX.y1 - BOX.y0) && exact.mismatched === 0, `${exact.compared} pixels`);
  const changed = Uint8Array.from(rgba);
  changed.set([0x12, 0x34, 0x56], ((5 + 40) * GW + 2 * (7 + 290)) * 4); // native (290, 40): inside the box
  const one = compareBox({ width: GW, height: GH, rgba: changed }, 7, 5, expected, BOX);
  check("one changed pixel inside the box is one mismatch with its extent", one.mismatched === 1 && one.extent.x0 === 290 && one.extent.y0 === 40, JSON.stringify(one.extent));
  const noise = { width: GW, height: GH, rgba: new Uint8Array(GW * GH * 4) };
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx += 2) {
    const c = ((gx * 97) ^ (gy * 151) ^ ((gx * gy) >> 3)) & 0xffffff;
    for (const col of [gx, gx + 1]) noise.rgba.set([c >> 16, (c >> 8) & 255, c & 255, 255], (gy * GW + col) * 4);
  }
  check("unrelated content is refused", typeof findFrameOrigin(noise, expected) === "string");
  const broken = { width: GW, height: GH, rgba: Uint8Array.from(rgba) };
  broken.rgba[(7 * GW + 2 * 40) * 4] ^= 0x40;
  check("a grab with one differing column pair is refused", typeof findFrameOrigin(broken, expected) === "string");
}

// ---- main -------------------------------------------------------------------------------------------------------------

selfTest();
if (failures > 0) {
  console.log(`build-side-preview capture comparator self-test failed (${failures})`);
  process.exit(1);
}
const capturePath = process.env.UTOPIA_SIDE_CAPTURE;
if (!capturePath) {
  console.log("build-side-preview capture comparison skipped: UTOPIA_SIDE_CAPTURE is not set (optional, external Copperline capture)");
  process.exit(0);
}
const resolved = path.resolve(capturePath);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
  console.log(`build-side-preview capture comparison: UTOPIA_SIDE_CAPTURE is not a file: ${resolved}`);
  process.exit(1);
}
const relToRoot = path.relative(root, resolved);
if (relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) {
  console.log("build-side-preview capture comparison: refusing a capture inside the repository (captures stay outside it)");
  process.exit(1);
}
const stateName = process.env.UTOPIA_SIDE_STATE ?? "before";
if (!(stateName in STATES)) {
  console.log(`build-side-preview capture comparison: UTOPIA_SIDE_STATE must be before or after (got "${stateName}")`);
  process.exit(1);
}
const preset = STATES[stateName];
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
function unavailable(reason) {
  console.log(`build-side-preview capture comparison unavailable: ${reason}`);
  process.exit(2);
}
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) unavailable("original Disk.1 or Disk.2 not found (original/utopia-whdload)");

let grab;
try {
  grab = decodePng(fs.readFileSync(resolved));
} catch (e) {
  if (e instanceof PixelError) unavailable(`capture ${path.basename(resolved)} is not a supported PNG (${e.message})`);
  throw e;
}

const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const tiles = loadTileSet(disk1, disk2, record).tiles;
const scene = new MapScene(disk1, tiles, new World(new GameState(disk2, record.block), loadMap(disk2, record)), new GameStrings(disk1, 0), { sprites: loadSprites(disk1, disk2, record), freshScenario: true });
if (scene.scrollX !== 47 || scene.scrollY !== 33) unavailable(`staged scroll is (${scene.scrollX}, ${scene.scrollY}); the start view (47, 33) is required`);
scene.world.state.setLong(A.money, preset.money);
scene.controls.mode = "build";
scene.controls.selection = { tile: TILE, type: TYPE };
scene.drawInitialFrame(); // presentation only: redraws the frame from the current state, no pass, no tick
const palRgb = scene.screen.palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);
const expected = Uint32Array.from(scene.screen.pixels, (i) => palRgb[i]);

const found = findFrameOrigin(grab, expected);
if (typeof found === "string") unavailable(`no valid alignment: ${found}`);
const { ox, oy } = found;
console.log(`capture ${path.basename(resolved)} (${preset.label}): ${grab.width} x ${grab.height}, ${nativeWidthIfPaired(grab)} native columns`);
console.log(`alignment: frame origin (${ox}, ${oy}); full-frame mismatches ${found.mismatched} of ${WIDTH * HEIGHT}; next origin ${found.second ? `(${found.second.ox}, ${found.second.oy}) ${found.second.mis}` : "none"}`);
console.log(`crop: grab columns ${2 * ox}..${2 * (ox + WIDTH) - 1} (every second column), rows ${oy}..${oy + HEIGHT - 1}`);
console.log(`state: ${stateName} (money ${preset.money}), build mode, tile $${TILE.toString(16)} type ${TYPE}, bottom row ${BOTTOM_ROW}`);

const box = compareBox(grab, ox, oy, expected, BOX);
console.log(`preview box x ${BOX.x0}..${BOX.x1 - 1}, rows ${BOX.y0}..${BOX.y1 - 1}: ${box.compared} pixels, ${box.mismatched} mismatches`);
if (box.mismatched > 0) {
  console.log(`mismatch extent x ${box.extent.x0}..${box.extent.x1}, rows ${box.extent.y0}..${box.extent.y1}`);
  for (const [pair, n] of [...box.pairs].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  expected->capture ${pair}: ${n}`);
  process.exit(1);
}
console.log("preview box: exact match");
process.exit(0);
