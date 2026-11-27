// Optional, read-only comparison of one Copperline window grab of the build menu panel with the remake's
// BuildMenuRenderer (src/game/build-menu.ts). Only the menu panel window (the 31 x 21 cell rectangle at (0, 24), i.e.
// x 0..247, rows 24..191) is compared; the command buttons, top bar and the rest of the screen are outside it and are
// not compared here.
//
// Usage (after `npm run build`):   UTOPIA_MENU_CAPTURE=<absolute path to a .png> node test/build-menu-capture-compare.mjs
//                                  [UTOPIA_MENU_POINTER=<x>,<y>]   (optional: arrow pointer hotspot in native pixels)
//
// State compared: page 2 of the build menu with no research bits, the tank construction yard (tile $45, name string 27,
// price 6000) picked, the detail lines shown and the preview drawn. This is the state of the 2026-11-06 Copperline capture
// `tankyard-selected` (notes/formats/building.md, "Menu panel rendering"). Other states are outside this comparison.
//
// Capture model (checked from the pixels, never assumed): a window grab W x H with W even where every column pair
// (2k, 2k+1) is identical over the whole image, i.e. a 2x horizontal nearest-neighbour upscale of W/2 native columns.
// The native origin (ox, oy) is searched over every position that fits a 320 x 200 frame. The origin is accepted only
// when its panel mismatch count is at most 1% of the panel AND the best origin outside a +-2 neighbourhood has at least
// three times as many mismatches. The palette is the remake's own (scene palette, as in map-capture-compare.mjs).
//
// Pointer: the arrow pointer is drawn over the panel (the remake's `main.ts` draws Disk.1 `$4A74` at the hotspot). When
// UTOPIA_MENU_POINTER is given, the opaque pixels of that arrow descriptor at the hotspot are excluded from the strict
// count; the hotspot is an input, not a detected value. The check then requires every opaque arrow pixel to carry the
// arrow's own palette colour in the capture. Without UTOPIA_MENU_POINTER nothing is excluded.
// (2026-11-10: the 29 differing pixels at (25, 115) are exactly that arrow's 29 opaque pixels, coloured 006600 x21 and
// 009900 x8 by the arrow's own palette indices. This is pixel evidence for a software arrow, not for a hardware sprite.)
//
// Exit codes with a capture: 0 match (zero mismatches outside the excluded arrow mask, and the arrow check passes); 1 divergence; 2 unavailable
// (not a 2x grab, no valid alignment, or missing original Disk.1/Disk.2). Without UTOPIA_MENU_CAPTURE the script runs its
// self-test and reports "skipped" with exit 0. A capture inside the repository is refused (exit 1).
//
// Evidence limits: one frame, one capture, the panel window only. A match is not a claim about other pages, research
// states, other items, the buttons, the side preview outside the panel, timing or pixels outside the panel.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, PixelError } from "./png-codec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 320;
const HEIGHT = 200;
const STATE = { page: 1, researchBits: 0, selected: 0x45, detail: { nameIndex: 27, cost: 6000, affordable: true } };
// Named sub-regions in native panel coordinates (absolute, as in the capture); the first match wins.
const REGIONS = [
  ["frame ring (outer 8 px)", (x, y, r) => x < r.x0 + 8 || x >= r.x1 - 8 || y < r.y0 + 8 || y >= r.y1 - 8],
  ["title (83..242, rows 30..37)", (x, y) => x >= 83 && x < 243 && y >= 30 && y < 38],
  ["item grid (16..239, rows 40..156)", (x, y) => x >= 16 && x < 240 && y >= 40 && y < 157],
  ["detail lines (16..239, rows 159..185)", (x, y) => x >= 16 && x < 240 && y >= 159 && y < 186],
];

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// ---- pure helpers (shared by the self-test and the capture comparison) ------------------------------------------------

// Native width when every column pair is identical over the whole grab, else null.
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

// Native colour (0xRRGGBB) of the grab at native (x, y) of the frame with origin (ox, oy).
export function grabNative(grab, ox, oy, x, y) {
  const c = ((y + oy) * grab.width + 2 * (x + ox)) * 4;
  return (grab.rgba[c] << 16) | (grab.rgba[c + 1] << 8) | grab.rgba[c + 2];
}

// Mismatches inside `rect` ({x0,y0,x1,y1}, exclusive ends) for one origin. `expected` is 320 x 200 RGB.
function rectMismatches(grab, ox, oy, expected, rect) {
  let mis = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) if (grabNative(grab, ox, oy, x, y) !== expected[y * WIDTH + x]) mis++;
  }
  return mis;
}

// Origin search over the panel rectangle only. Returns { ox, oy, mismatched, second } or a reason string.
export function findPanelOrigin(grab, expected, rect) {
  const nativeWidth = nativeWidthIfPaired(grab);
  if (nativeWidth === null) return "not a 2x horizontal upscale (column pairs differ or width is odd)";
  const maxOx = nativeWidth - WIDTH;
  const maxOy = grab.height - HEIGHT;
  if (maxOx < 0 || maxOy < 0) return `grab ${grab.width} x ${grab.height} is smaller than a native 320 x 200 frame at 2x`;
  const scores = [];
  for (let oy = 0; oy <= maxOy; oy++) {
    for (let ox = 0; ox <= maxOx; ox++) scores.push({ ox, oy, mis: rectMismatches(grab, ox, oy, expected, rect) });
  }
  scores.sort((a, b) => a.mis - b.mis);
  const best = scores[0];
  const second = scores.find((s) => Math.abs(s.ox - best.ox) > 2 || Math.abs(s.oy - best.oy) > 2);
  const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  if (best.mis > area / 100) return `best origin (${best.ox}, ${best.oy}) mismatches ${best.mis} of ${area} panel pixels (more than 1%)`;
  if (second && second.mis < 3 * best.mis) return `origin is ambiguous: (${best.ox}, ${best.oy}) ${best.mis} vs (${second.ox}, ${second.oy}) ${second.mis}`;
  return { ox: best.ox, oy: best.oy, mismatched: best.mis, second: second ? { ox: second.ox, oy: second.oy, mis: second.mis } : null };
}

// Compares the panel at one origin. `excluded(x, y)` leaves a pixel out of the strict count (reported separately).
export function comparePanel(grab, ox, oy, expected, rect, excluded = () => false) {
  const out = { compared: 0, mismatched: 0, excludedMismatched: 0, box: null, regions: new Map(), colourPairs: new Map() };
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      out.compared++;
      const got = grabNative(grab, ox, oy, x, y);
      const want = expected[y * WIDTH + x];
      if (got === want) continue;
      if (excluded(x, y)) {
        out.excludedMismatched++;
        continue;
      }
      out.mismatched++;
      out.box = out.box
        ? { x0: Math.min(out.box.x0, x), x1: Math.max(out.box.x1, x), y0: Math.min(out.box.y0, y), y1: Math.max(out.box.y1, y) }
        : { x0: x, x1: x, y0: y, y1: y };
      const key = `${want.toString(16).padStart(6, "0")}->${got.toString(16).padStart(6, "0")}`;
      out.colourPairs.set(key, (out.colourPairs.get(key) ?? 0) + 1);
      for (const [name, inside] of REGIONS) {
        if (inside(x, y, rect)) {
          out.regions.set(name, (out.regions.get(name) ?? 0) + 1);
          break;
        }
      }
    }
  }
  return out;
}

// ---- self-test (always runs; no original files) -----------------------------------------------------------------------

function selfTest() {
  // Synthetic native frame with a pseudo-random palette index pattern, shown 2x horizontally at origin (7, 5) in a grab.
  const palette = Array.from({ length: 32 }, (_, i) => ((i * 37) & 255) << 16 | ((i * 91 + 7) & 255) << 8 | ((255 - i * 8) & 255));
  const index = Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => ((i * 2654435761) >>> 27) & 31);
  const expected = Uint32Array.from(index, (i) => palette[i]);
  const GW = 2 * (WIDTH + 20);
  const GH = HEIGHT + 30;
  const rgba = new Uint8Array(GW * GH * 4);
  const put = (gx, gy, c) => {
    const o = (gy * GW + gx) * 4;
    rgba.set([c >> 16, (c >> 8) & 255, c & 255, 255], o);
  };
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx += 2) { const c = ((gx * 13) ^ (gy * 29)) & 0xffffff; put(gx, gy, c); put(gx + 1, gy, c); }
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) for (let k = 0; k < 2; k++) put(2 * (x + 7) + k, y + 5, expected[y * WIDTH + x]);
  const grab = { width: GW, height: GH, rgba };
  const rect = { x0: 0, y0: 24, x1: 248, y1: 192 };

  const found = findPanelOrigin(grab, expected, rect);
  check("synthetic 2x grab: panel origin found at (7, 5) with no mismatch", typeof found === "object" && found.ox === 7 && found.oy === 5 && found.mismatched === 0, typeof found === "object" ? `(${found.ox}, ${found.oy}) mismatches ${found.mismatched}` : found);
  const exact = typeof found === "object" ? comparePanel(grab, found.ox, found.oy, expected, rect) : null;
  check("synthetic panel compares exact over 248 x 168 pixels", exact !== null && exact.compared === 248 * 168 && exact.mismatched === 0);

  const changed = Uint8Array.from(rgba);
  const at = ((5 + 60) * GW + 2 * (7 + 100)) * 4; // native (100, 60): inside the panel
  changed.set([0x12, 0x34, 0x56], at);
  const one = { width: GW, height: GH, rgba: changed };
  const strict = comparePanel(one, 7, 5, expected, rect);
  check("one changed panel pixel is counted as one mismatch with its box", strict.mismatched === 1 && strict.box.x0 === 100 && strict.box.y0 === 60, JSON.stringify(strict.box));
  const excluded = comparePanel(one, 7, 5, expected, rect, (x, y) => x >= 96 && x < 104 && y >= 56 && y < 64);
  check("the same pixel inside an excluded pointer box is reported as excluded, not as a mismatch", excluded.mismatched === 0 && excluded.excludedMismatched === 1);

  const noise = { width: GW, height: GH, rgba: new Uint8Array(GW * GH * 4) };
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx += 2) {
    const c = ((gx * 97) ^ (gy * 151) ^ ((gx * gy) >> 3)) & 0xffffff;
    for (const col of [gx, gx + 1]) noise.rgba.set([c >> 16, (c >> 8) & 255, c & 255, 255], (gy * GW + col) * 4);
  }
  check("unrelated content is refused", typeof findPanelOrigin(noise, expected, rect) === "string");
  const broken = { width: GW, height: GH, rgba: Uint8Array.from(rgba) };
  broken.rgba[(7 * GW + 2 * 40) * 4] ^= 0x40;
  check("a grab with one differing column pair is refused", typeof findPanelOrigin(broken, expected, rect) === "string");
}

// ---- main -------------------------------------------------------------------------------------------------------------

selfTest();
const capturePath = process.env.UTOPIA_MENU_CAPTURE;
if (failures > 0) {
  console.log(`build-menu capture comparator self-test failed (${failures})`);
  process.exit(1);
}
if (!capturePath) {
  console.log("build-menu capture comparison skipped: UTOPIA_MENU_CAPTURE is not set (optional, external Copperline capture)");
  process.exit(0);
}
const resolved = path.resolve(capturePath);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
  console.log(`build-menu capture comparison: UTOPIA_MENU_CAPTURE is not a file: ${resolved}`);
  process.exit(1);
}
const relToRoot = path.relative(root, resolved);
if (relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) {
  console.log("build-menu capture comparison: refusing a capture inside the repository (captures stay outside it)");
  process.exit(1);
}
let pointer = null;
if (process.env.UTOPIA_MENU_POINTER !== undefined) {
  const m = /^(\d+),(\d+)$/.exec(process.env.UTOPIA_MENU_POINTER.trim());
  if (!m) {
    console.log(`build-menu capture comparison: UTOPIA_MENU_POINTER must be "x,y" (got "${process.env.UTOPIA_MENU_POINTER}")`);
    process.exit(1);
  }
  pointer = { x: Number(m[1]), y: Number(m[2]) };
}
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
function unavailable(reason) {
  console.log(`build-menu capture comparison unavailable: ${reason}`);
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
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");
const bm = await import("../dist/game/build-menu.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { readPointer, POINTER_ARROW } = await import("../dist/gfx/pointer.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const tiles = loadTileSet(disk1, disk2, record).tiles;
const strings = new GameStrings(disk1, 0);
const scene = new MapScene(disk1, tiles, new World(new GameState(disk2, record.block), loadMap(disk2, record)), strings, { sprites: loadSprites(disk1, disk2, record), freshScenario: true });
const palRgb = scene.screen.palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);

const renderer = new bm.BuildMenuRenderer(disk1, strings, tiles);
const win = renderer.frame;
const rect = { x0: win.x, y0: win.y, x1: win.x + win.w * 8, y1: win.y + win.h * 8 };
const shot = new Screen();
shot.pixels.fill(0);
renderer.draw(shot, { ...STATE, flipped: [] });
const expected = Uint32Array.from(shot.pixels, (i) => palRgb[i]);

const found = findPanelOrigin(grab, expected, rect);
if (typeof found === "string") unavailable(`no valid alignment: ${found}`);
const { ox, oy } = found;
const nativeW = nativeWidthIfPaired(grab);
console.log(`capture ${path.basename(resolved)}: ${grab.width} x ${grab.height}, 2x column pairs identical (${nativeW} native columns)`);
console.log(`alignment: panel origin (${ox}, ${oy}), mismatches ${found.mismatched} of ${(rect.x1 - rect.x0) * (rect.y1 - rect.y0)}; next origin ${found.second ? `(${found.second.ox}, ${found.second.oy}) ${found.second.mis}` : "none"}`);
console.log(`crop: grab columns ${2 * (ox + rect.x0)}..${2 * (ox + rect.x1) - 1} (every second column), rows ${oy + rect.y0}..${oy + rect.y1 - 1}; native panel x ${rect.x0}..${rect.x1 - 1}, rows ${rect.y0}..${rect.y1 - 1}`);
console.log(`state: page ${STATE.page + 1}, research bits 0, pending tile $${STATE.selected.toString(16)}, detail name ${STATE.detail.nameIndex} cost ${STATE.detail.cost}`);

// The excluded set, when a hotspot is given, is the opaque mask of the arrow descriptor (Disk.1 `$4A74`, the same
// image `main.ts` draws) at that hotspot, not the whole 8 x 8 box. The arrow is then checked below.
const arrow = pointer ? readPointer(disk1, POINTER_ARROW) : null;
const inArrow = (x, y) => {
  const dx = x - pointer.x;
  const dy = y - pointer.y;
  return dx >= 0 && dx < 32 && dy >= 0 && dy < arrow.rows && arrow.opaque[dy * 32 + dx] === 1;
};
const excluded = pointer ? inArrow : () => false;
const cmp = comparePanel(grab, ox, oy, expected, rect, excluded);
console.log(`panel: compared ${cmp.compared}, exact ${cmp.compared - cmp.mismatched - cmp.excludedMismatched}, mismatched ${cmp.mismatched}${cmp.box ? ` (box x ${cmp.box.x0}..${cmp.box.x1}, y ${cmp.box.y0}..${cmp.box.y1})` : ""}, excluded arrow mask at (${pointer ? `${pointer.x}, ${pointer.y}` : "not set"}): ${cmp.excludedMismatched} differ`);
for (const [name] of REGIONS) console.log(`  ${name}: ${cmp.regions.get(name) ?? 0} differ`);
if (cmp.colourPairs.size) console.log(`colour pairs (remake->capture): ${[...cmp.colourPairs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`).join("; ")}`);
check("panel matches the remake render outside the excluded arrow mask", cmp.mismatched === 0);
if (pointer) {
  // Every opaque arrow pixel must show the arrow's own palette colour in the capture (the arrow is drawn over the panel).
  let opaque = 0;
  let coloured = 0;
  const arrowColours = new Map();
  for (let r = 0; r < arrow.rows; r++) {
    for (let c = 0; c < 32; c++) {
      if (!arrow.opaque[r * 32 + c]) continue;
      opaque++;
      const want = palRgb[arrow.index[r * 32 + c]];
      if (grabNative(grab, ox, oy, pointer.x + c, pointer.y + r) === want) coloured++;
      const key = want.toString(16).padStart(6, "0");
      arrowColours.set(key, (arrowColours.get(key) ?? 0) + 1);
    }
  }
  console.log(`pointer arrow (Disk.1 $4A74, ${arrow.rows} rows) at (${pointer.x}, ${pointer.y}): ${opaque} opaque pixels; palette colours ${[...arrowColours].map(([k, v]) => `${k} x${v}`).join(", ")}`);
  check("every opaque arrow pixel carries the arrow's own palette colour in the capture", coloured === opaque, `${coloured} of ${opaque}`);
}

if (failures > 0) {
  console.log(`build-menu capture comparison: divergence (${failures} check(s) failed; ${cmp.mismatched} panel pixel(s) outside the excluded arrow mask)`);
  process.exit(1);
}
console.log("build-menu panel matches the capture outside the excluded arrow mask");
process.exit(0);
