// Optional, read-only comparison of one Copperline gameplay screenshot with the remake's scenario-0 map screen.
// It compares the MAP LAYER: the 8 x 8 window of tiles (screen rows 24..159, x 0..255), exactly, the MODE ICON box
// (x 272..303, rows 30..52: the select-mode tile $39 drawn by `Controls`), exactly, and the LOG PANEL FILL (x 8..311,
// rows 171..194: the pattern fill of a cleared panel, with no text staged). Dynamic and UI regions (top-bar text, the rest
// of the right panel, the message line and the panel outside the fill) are reported with their counts but are not compared.
//
// Usage (after `npm run build`):   UTOPIA_MAP_CAPTURE=<absolute path to a .png> node test/map-capture-compare.mjs
//                                  [UTOPIA_MAP_STATE=tutorial|new-game]   (default tutorial, see "Staging")
//                                  [UTOPIA_MAP_TOPBAR=staged]   (optional top-bar staging, see "Top-bar staging")
//
// Exit codes with a capture: 0 match (the map layer is exact, possibly with one verified selection cell); 1 divergence in
// the map layer; 2 unavailable (no valid alignment, unsupported capture, scroll or staging mismatch, or missing Disk.1/Disk.2).
// Without UTOPIA_MAP_CAPTURE the script runs its self-test and reports "skipped" with exit 0. A capture inside the
// repository is refused (exit 1); captures stay outside it.
//
// Capture model (checked from the pixels, never assumed):
//   - a native 320 x 200 PNG: origin (0, 0), 1:1; or
//   - a window grab W x H with W even, H >= 200, where every column pair (2k, 2k+1) is identical over the whole image, i.e.
//     a 2x horizontal nearest-neighbour upscale of W/2 native columns. The native origin (ox, oy) is searched over every
//     position that fits. The 1:1 vertical scale is part of the search: a wrong scale cannot match. The origin is accepted
//     only when its mismatch count is at most 10% of the 320 x 200 pixels AND the best origin outside a +-2 neighbourhood
//     has at least 3 times as many mismatches.
// Palette: the remake's palette (OCS words through `ocsColor`), compared colour by colour. The comparison reports
// an inconsistent palette mapping instead of hiding it.
//
// Staging: scenario 0 built like `Game.createScene(0)` with the graduation-cap icon (tutorial, `$80C8`: sysFlags
// tutorial | no-unit bonus, money $7A120) or a plain new game (`UTOPIA_MAP_STATE=new-game`). The scroll must be (47, 33).
// No units, no pins, no pointer, no apparition are staged. A capture with units, pins, the pointer over the map or other
// state is outside this comparison's model and fails or is unavailable.
//
// Selection cell: the original draws the cell under the pointer with tile 58 (`$657A`, see notes/formats/map-rendering.md
// section 5). At most one window cell may differ from the normal frame, and only when the window then matches exactly with
// that cell's tile replaced by tile 58 (painter order, the same rule as `ObjectLayer.drawMap`). The chosen cell is printed.
//
// Evidence limits: one frame, one capture, the map layer only, no object layer, no timing. A match is not a claim about
// pixels outside rows 24..159 x 0..255, about other scenarios, pass counts, dates, money or any UI region.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, PixelError } from "./png-codec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 320;
const HEIGHT = 200;
const MAP_TOP = 24; // map window: screen rows 24..159, x 0..255 (notes/formats/map-rendering.md sections 3-4)
const MAP_BOTTOM = 160;
const MAP_RIGHT = 256;
const SELECTION_TILE = 58;
// panel: "cleared" = the log panel after a clear (the pattern fill, no text), as the capture shows; "fresh" = the picture
// (a new game's first frame, `$14634 = $FFFF`). The capture's history that cleared the panel is not known; see staging below.
const STATES = {
  tutorial: { label: "tutorial start ($80C8)", money: 0x7a120, tutorial: true, panel: "cleared" },
  "new-game": { label: "plain new game", tutorial: false, panel: "fresh" },
};
// The log string staged to clear the panel: index 143 is a log string (game-text.md section 5, LOG_INDICES), one or two lines.
const PANEL_STAGING_STRING = 143;
// Message-panel log fill rows (game-text.md section 5 step 7; messages.ts LOG_PANEL_FILL): x 8..311, rows 171..194.
const PANEL = { x0: 8, y0: 171, x1: 312, y1: 195 };
const MAX_SHOWN = 12;
// Mode icon: `$6B10` at (272, bottom row 52) draws tile $39 (select mode, `$15EF0`) as 32 x 23 pixels. Compared exactly;
// notes/formats/map-rendering.md section 11.
const MODE_ICON_BOX = { x0: 272, y0: 30, x1: 304, y1: 53 };
// Top-bar staging (opt-in, visual only). The values are the ones the 2026-11-06 Copperline capture's top bar shows: date
// 03/07/2090, money 506040 GR, quality of life 44. They are written straight into the state the top bar reads
// (A.day, A.month, A.year, A.money, A.qualityOfLife). No pass, date tick, event or RNG runs, and the normal comparison
// never sets them. This is a pixel alignment of one frame, not a comparison of simulation history.
const TOPBAR_STAGING = { label: "03/07/2090, 506040 GR, QoL 44", day: 3, month: 6, yearOffset: 0, money: 506040, qol: 44 };

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// ---- alignment ---------------------------------------------------------------------------------------------------------

// Column-pair test for a 2x horizontal upscale: returns the native width, or null when some pair differs.
function horizontalNativeWidth(grab) {
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

// Native colour (0xRRGGBB) at (x, y) of the native frame whose origin is (ox, oy) in the grab.
function grabNative(grab, ox, oy, x, y) {
  const c = ((y + oy) * grab.width + 2 * (x + ox)) * 4;
  return (grab.rgba[c] << 16) | (grab.rgba[c + 1] << 8) | grab.rgba[c + 2];
}

// Mismatches of every native pixel against the expected colours at one origin.
function originMismatches(grab, ox, oy, expected) {
  let mis = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) if (grabNative(grab, ox, oy, x, y) !== expected[y * WIDTH + x]) mis++;
  }
  return mis;
}

// Searches the origin. Returns { ox, oy, mismatched, second } or a reason string when no origin is acceptable.
export function findOrigin(grab, expected) {
  const nativeWidth = horizontalNativeWidth(grab);
  if (nativeWidth === null) return "not a 2x horizontal upscale (column pairs differ or width is odd)";
  const maxOx = nativeWidth - WIDTH;
  const maxOy = grab.height - HEIGHT;
  if (maxOx < 0 || maxOy < 0) return `grab ${grab.width} x ${grab.height} is smaller than a native 320 x 200 frame at 2x`;
  const scores = [];
  for (let oy = 0; oy <= maxOy; oy++) for (let ox = 0; ox <= maxOx; ox++) scores.push({ ox, oy, mis: originMismatches(grab, ox, oy, expected) });
  scores.sort((a, b) => a.mis - b.mis);
  const best = scores[0];
  const second = scores.find((s) => Math.abs(s.ox - best.ox) > 2 || Math.abs(s.oy - best.oy) > 2);
  const total = WIDTH * HEIGHT;
  if (best.mis > total / 10) return `best origin (${best.ox}, ${best.oy}) mismatches ${best.mis} of ${total} pixels (more than 10%)`;
  if (second && second.mis < 3 * best.mis) return `origin is ambiguous: (${best.ox}, ${best.oy}) ${best.mis} vs (${second.ox}, ${second.oy}) ${second.mis}`;
  return { ox: best.ox, oy: best.oy, mismatched: best.mis, second: second ? { ox: second.ox, oy: second.oy, mis: second.mis } : null, nativeWidth };
}

// ---- the remake frame and the selection variant ----------------------------------------------------------------------

// Paints one tile the way MapScene.drawTile does (bottom row first, mask plane, transparent pixels keep the destination).
function paintTile(buf, tile, x, bottomY) {
  const planeBytes = tile.rows * 4;
  for (let row = 0; row < tile.rows; row++) {
    const y = bottomY - 1 - row;
    if (y < 0) continue;
    for (let px = 0; px < 32; px++) {
      const sx = x + px;
      if (sx < 0 || sx >= WIDTH) continue;
      const at = row * 4 + (px >> 3);
      const bit = 7 - (px & 7);
      if (((tile.planes[5 * planeBytes + at] >> bit) & 1) === 0) continue;
      let index = 0;
      for (let plane = 0; plane < 5; plane++) index |= ((tile.planes[plane * planeBytes + at] >> bit) & 1) << plane;
      buf[y * WIDTH + sx] = index;
    }
  }
}

// The window painted in the engine's painter order from the background, with one cell's own tile replaced by tile 58.
function windowWithSelection(scene, tiles, mapWidth, anchorX, anchorY, cell) {
  const buf = Uint8Array.from(scene.background);
  for (let s = 0; s <= 14; s++) {
    for (let vx = Math.max(0, s - 7); vx <= Math.min(7, s); vx++) {
      const vy = s - vx;
      const word = scene.world.cells[(scene.scrollY + vy) * mapWidth + scene.scrollX + vx];
      let tile = tiles[(word & 0x3ff) - 1];
      if (vx === cell.vx && vy === cell.vy) tile = tiles[SELECTION_TILE];
      if (tile) paintTile(buf, tile, anchorX(vx, vy), anchorY(vx, vy));
    }
  }
  return buf;
}

// ---- the comparison of the map layer ---------------------------------------------------------------------------------

function compareMap(capRgb, index, palRgb) {
  let compared = 0;
  let mismatched = 0;
  const shown = [];
  const perIndex = new Map();
  for (let y = MAP_TOP; y < MAP_BOTTOM; y++) {
    for (let x = 0; x < MAP_RIGHT; x++) {
      compared++;
      const i = index[y * WIDTH + x];
      const want = palRgb[i];
      const got = capRgb[y * WIDTH + x];
      if (got === want) continue;
      mismatched++;
      if (!perIndex.has(i)) perIndex.set(i, new Map());
      perIndex.get(i).set(got, (perIndex.get(i).get(got) ?? 0) + 1);
      if (shown.length < MAX_SHOWN) shown.push({ x, y, index: i, expected: want, actual: got });
    }
  }
  return { compared, mismatched, shown, perIndex };
}

// Counts differing pixels in a box; `skip(x, y)` leaves a pixel out (the mode icon box is compared on its own).
function countBox(capRgb, index, palRgb, x0, y0, x1, y1, skip = () => false) {
  let mis = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (skip(x, y) || capRgb[y * WIDTH + x] === palRgb[index[y * WIDTH + x]]) continue;
      mis++;
      bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
    }
  }
  return { mis, box: mis ? `x ${bx0}..${bx1}, y ${by0}..${by1}` : "" };
}

const hex = (v) => v.toString(16).padStart(6, "0");

// ---- self-test (always runs; no original files) ------------------------------------------------------------------------

function selfTest() {
  // synthetic native frame with a pseudo-random index pattern and palette
  const palette = Array.from({ length: 32 }, (_, i) => [(i * 37) & 255, (i * 91 + 7) & 255, (255 - i * 8) & 255]);
  const rgbOf = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
  const palRgb = palette.map(rgbOf);
  const index = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < index.length; i++) index[i] = ((i * 2654435761) >>> 27) & 31;
  const expected = Uint32Array.from(index, (i) => palRgb[i]);

  // grab: 2x horizontal of the native frame at origin (5, 7), noise around it (a 358 x 285 canvas as the real grab)
  const GW = 2 * 358;
  const GH = 285;
  const rgba = new Uint8Array(GW * GH * 4);
  const put = (gx, gy, c) => { const o = (gy * GW + gx) * 4; rgba[o] = c >> 16; rgba[o + 1] = (c >> 8) & 255; rgba[o + 2] = c & 255; rgba[o + 3] = 255; };
  // the background is column-paired like a real 2x grab, so only the native content decides the origin
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx += 2) { const c = ((gx * 13) ^ (gy * 29)) & 0xffffff; put(gx, gy, c); put(gx + 1, gy, c); }
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) for (let k = 0; k < 2; k++) put(2 * (x + 5) + k, y + 7, expected[y * WIDTH + x]);
  const grab = { width: GW, height: GH, rgba };
  const found = findOrigin(grab, expected);
  check("synthetic 2x grab: origin found at (5, 7) with no mismatch", typeof found === "object" && found.ox === 5 && found.oy === 7 && found.mismatched === 0, typeof found === "object" ? `(${found.ox}, ${found.oy}) mismatches ${found.mismatched}` : found);

  // the same grab with one column pair changed: the pair test refuses it (not a 2x upscale)
  const broken = { width: GW, height: GH, rgba: Uint8Array.from(rgba) };
  const o = (7 * GW + 2 * 40) * 4; broken.rgba[o] ^= 0x40; // one column of one pair only
  const unpaired = findOrigin(broken, expected);
  check("a grab with one differing column pair is refused", typeof unpaired === "string", typeof unpaired === "string" ? unpaired : "");

  // a grab of unrelated content: no origin reaches the 10% bound
  const noise = { width: GW, height: GH, rgba: new Uint8Array(GW * GH * 4) };
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx += 2) {
    const c = ((gx * 97) ^ (gy * 151) ^ ((gx * gy) >> 3)) & 0xffffff;
    for (const col of [gx, gx + 1]) { const o = (gy * GW + col) * 4; noise.rgba.set([c >> 16, (c >> 8) & 255, c & 255, 255], o); }
  }
  const unrelated = findOrigin(noise, expected);
  check("unrelated content is refused (no origin within the mismatch bound)", typeof unrelated === "string", typeof unrelated === "string" ? unrelated : "");

  const cmp = compareMap(expected, index, palRgb);
  check("synthetic native frame compares exact in the map layer", cmp.compared === (MAP_BOTTOM - MAP_TOP) * MAP_RIGHT && cmp.mismatched === 0);
  const iconBox = [MODE_ICON_BOX.x0, MODE_ICON_BOX.y0, MODE_ICON_BOX.x1, MODE_ICON_BOX.y1];
  const iconExact = countBox(expected, index, palRgb, ...iconBox);
  const shifted = Uint8Array.from(index);
  shifted[30 * WIDTH + 280] = (shifted[30 * WIDTH + 280] + 1) & 31;
  const iconOne = countBox(expected, shifted, palRgb, ...iconBox);
  check("synthetic mode icon box: exact frame has no mismatch, one changed pixel is counted", iconExact.mis === 0 && iconOne.mis === 1, `(${iconExact.mis}, ${iconOne.mis})`);
}

// ---- main -------------------------------------------------------------------------------------------------------------

selfTest();
const capturePath = process.env.UTOPIA_MAP_CAPTURE;
if (failures > 0) {
  console.log(`map capture comparator self-test failed (${failures})`);
  process.exit(1);
}
if (!capturePath) {
  console.log("map capture comparison skipped: UTOPIA_MAP_CAPTURE is not set (optional, external Copperline screenshot)");
  process.exit(0);
}
const stateName = process.env.UTOPIA_MAP_STATE ?? "tutorial";
if (!STATES[stateName]) {
  console.log(`map capture comparison: unknown state "${stateName}" (implemented: ${Object.keys(STATES).join(", ")})`);
  process.exit(1);
}
const topbarMode = process.env.UTOPIA_MAP_TOPBAR;
if (topbarMode !== undefined && topbarMode !== "staged") {
  console.log(`map capture comparison: unknown UTOPIA_MAP_TOPBAR "${topbarMode}" (implemented: staged)`);
  process.exit(1);
}
const topbarStaged = topbarMode === "staged";
const resolved = path.resolve(capturePath);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
  console.log(`map capture comparison: UTOPIA_MAP_CAPTURE is not a file: ${resolved}`);
  process.exit(1);
}
const relToRoot = path.relative(root, resolved);
if (relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) {
  console.log("map capture comparison: refusing a capture inside the repository (captures stay outside it)");
  process.exit(1);
}
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
function unavailable(reason) {
  console.log(`map capture comparison unavailable (${stateName}): ${reason}`);
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

const { readScenarioRecords, loadMap, loadTileSet, MAP_WIDTH } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene, anchorX, anchorY } = await import("../dist/game/map.js");
const { SYS } = await import("../dist/game/sim.js");
const { LOG_IDLE_FRAMES } = await import("../dist/game/messages.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const tiles = loadTileSet(disk1, disk2, record).tiles;
const scene = new MapScene(disk1, tiles, new World(new GameState(disk2, record.block), loadMap(disk2, record)), new GameStrings(disk1, 0), { sprites: loadSprites(disk1, disk2, record), freshScenario: true });
const preset = STATES[stateName];
if (preset.tutorial) {
  // Game.startTutorial: the same scenario-0 build, then the tutorial flags and money
  scene.sim.sysFlags |= SYS.tutorialMode | SYS.noUnitBonus;
  scene.world.state.setLong(A.money, preset.money);
}
if (scene.scrollX !== 47 || scene.scrollY !== 33) unavailable(`staged scroll is (${scene.scrollX}, ${scene.scrollY}); the start view (47, 33) is required`);
if (topbarStaged) {
  // Visual top-bar staging: the three values the top bar reads, written directly; nothing is ticked or simulated.
  const st = scene.world.state;
  st.setByte(A.day, TOPBAR_STAGING.day);
  st.setByte(A.month, TOPBAR_STAGING.month);
  st.setLong(A.year, TOPBAR_STAGING.yearOffset);
  st.setLong(A.money, TOPBAR_STAGING.money);
  st.setLong(A.qualityOfLife, TOPBAR_STAGING.qol);
  if (st.dateText() !== "03/07/2090" || st.displayMoney() !== TOPBAR_STAGING.money || st.word(A.qualityOfLife + 2) !== TOPBAR_STAGING.qol) {
    unavailable(`top-bar staging did not take: ${st.dateText()}, ${st.displayMoney()}, QoL ${st.word(A.qualityOfLife + 2)}`);
  }
}
if (preset.panel === "cleared") {
  // Staged through the scene's own log timer (Messages): one log entry, then LOG_IDLE_FRAMES of the idle countdown, which
  // empties the panel and paints the pattern fill ($1586E). The original's own history is not reproduced.
  scene.messages.push(PANEL_STAGING_STRING);
  for (let i = 0; i < LOG_IDLE_FRAMES; i++) scene.messages.update();
  if (!scene.messages.panelCleared || scene.messages.logText.length !== 0) unavailable("the panel idle clear did not stage");
  scene.drawInitialFrame(); // presentation only: redraws the frame from the current state, no pass, no tick
}
if (topbarStaged && preset.panel !== "cleared") scene.drawInitialFrame(); // the staged top bar is drawn from the state

const expectedIndex = Uint8Array.from(scene.screen.pixels);
const palRgb = scene.screen.palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);
const expectedRgb = Uint32Array.from(expectedIndex, (i) => palRgb[i]);

const found = findOrigin(grab, expectedRgb);
if (typeof found === "string") unavailable(`no valid alignment: ${found}`);
const { ox, oy } = found;
const capRgb = new Uint32Array(WIDTH * HEIGHT);
for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) capRgb[y * WIDTH + x] = grabNative(grab, ox, oy, x, y);
console.log(`capture ${path.basename(resolved)}: ${grab.width} x ${grab.height}; native frame = grab columns ${2 * ox}..${2 * (ox + WIDTH) - 1} (every second column), rows ${oy}..${oy + HEIGHT - 1}`);
console.log(`alignment: origin (${ox}, ${oy}), mismatches ${found.mismatched} of ${WIDTH * HEIGHT} pixels; next origin ${found.second ? `(${found.second.ox}, ${found.second.oy}) ${found.second.mis}` : "none"}`);
console.log(`staging: scenario 0, ${preset.label}, scroll (${scene.scrollX}, ${scene.scrollY})`);

let map = compareMap(capRgb, expectedIndex, palRgb);
let selection = null;
if (map.mismatched > 0) {
  // at most one selection cell: the window must match exactly once that cell carries tile 58
  for (let vy = 0; vy < 8 && !selection; vy++) {
    for (let vx = 0; vx < 8 && !selection; vx++) {
      const buf = windowWithSelection(scene, tiles, MAP_WIDTH, anchorX, anchorY, { vx, vy });
      const trial = compareMap(capRgb, buf, palRgb);
      if (trial.mismatched === 0) selection = { vx, vy, cell: [scene.scrollX + vx, scene.scrollY + vy] };
    }
  }
  if (selection) map = compareMap(capRgb, windowWithSelection(scene, tiles, MAP_WIDTH, anchorX, anchorY, selection), palRgb);
}
const compared = map.compared;
// Whole-frame residual against the normal frame (no selection), with the part the selection tile explains reported.
// The selection tile replaces one cell's tile, so each residual pixel in the map layer must be one where the chosen
// window differs from the normal frame. Anything else would be a real map-layer divergence.
{
  let raw = 0;
  let rawFrame = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      if (capRgb[i] === palRgb[expectedIndex[i]]) continue;
      rawFrame++;
      if (y >= MAP_TOP && y < MAP_BOTTOM && x < MAP_RIGHT) raw++;
    }
  }
  const explained = selection
    ? (() => {
        const sel = windowWithSelection(scene, tiles, MAP_WIDTH, anchorX, anchorY, selection);
        let n = 0;
        for (let y = MAP_TOP; y < MAP_BOTTOM; y++) {
          for (let x = 0; x < MAP_RIGHT; x++) {
            const i = y * WIDTH + x;
            if (capRgb[i] !== palRgb[expectedIndex[i]] && sel[i] !== expectedIndex[i]) n++;
          }
        }
        return n;
      })()
    : 0;
  console.log(`raw residual against the normal frame: ${rawFrame} pixels in the whole frame, ${raw} in the map layer; ${selection ? `${explained} of the map-layer residual lie on the selection tile's footprint` : "no selection cell applies"}`);
}
console.log(`map layer (rows ${MAP_TOP}..${MAP_BOTTOM - 1}, x 0..${MAP_RIGHT - 1}): compared ${compared}, exact ${compared - map.mismatched}, mismatched ${map.mismatched}`);
if (selection) console.log(`selection cell: view (${selection.vx}, ${selection.vy}) = map cell (${selection.cell[0]}, ${selection.cell[1]}); the window matches exactly with tile ${SELECTION_TILE} on it`);
else if (map.mismatched === 0) console.log("selection cell: none (the normal frame matches the window exactly)");
else console.log("selection cell: none explains the differences (no single cell carrying tile 58 makes the window match)");

// The mode icon box is compared exactly. A mismatch there is a divergence (exit 1) like one in the map layer.
const iconBox = MODE_ICON_BOX;
const icon = countBox(capRgb, expectedIndex, palRgb, iconBox.x0, iconBox.y0, iconBox.x1, iconBox.y1);
const iconCompared = (iconBox.x1 - iconBox.x0) * (iconBox.y1 - iconBox.y0);
console.log(`mode icon (x ${iconBox.x0}..${iconBox.x1 - 1}, rows ${iconBox.y0}..${iconBox.y1 - 1}): compared ${iconCompared}, exact ${iconCompared - icon.mis}, mismatched ${icon.mis}${icon.box ? ` (${icon.box})` : ""}`);

const inIcon = (x, y) => x >= iconBox.x0 && x < iconBox.x1 && y >= iconBox.y0 && y < iconBox.y1;
const inPanel = (x, y) => x >= PANEL.x0 && x < PANEL.x1 && y >= PANEL.y0 && y < PANEL.y1;
// The log panel fill is compared exactly (no text is staged, so the fill is the whole interior).
const panelCount = countBox(capRgb, expectedIndex, palRgb, PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1);
const panelCompared = (PANEL.x1 - PANEL.x0) * (PANEL.y1 - PANEL.y0);
console.log(`log panel fill (x ${PANEL.x0}..${PANEL.x1 - 1}, rows ${PANEL.y0}..${PANEL.y1 - 1}, state ${stateName}/${preset.panel}): compared ${panelCompared}, exact ${panelCompared - panelCount.mis}, mismatched ${panelCount.mis}${panelCount.box ? ` (${panelCount.box})` : ""}`);
if (panelCount.mis > 0) {
  let shown = 0;
  for (let y = PANEL.y0; y < PANEL.y1 && shown < 6; y++) {
    for (let x = PANEL.x0; x < PANEL.x1 && shown < 6; x++) {
      if (capRgb[y * WIDTH + x] === palRgb[expectedIndex[y * WIDTH + x]]) continue;
      console.log(`  panel diff at (${x}, ${y}): expected #${hex(palRgb[expectedIndex[y * WIDTH + x]])} actual #${hex(capRgb[y * WIDTH + x])}`);
      shown++;
    }
  }
}
// The top bar: with staging it is compared exactly (rows 0..23, full width); without staging it stays a counted, uncompared region.
const topCompared = WIDTH * MAP_TOP;
const top = countBox(capRgb, expectedIndex, palRgb, 0, 0, WIDTH, MAP_TOP);
if (topbarStaged) {
  console.log(`top bar (rows 0..${MAP_TOP - 1}, staged ${TOPBAR_STAGING.label}; visual staging, not a simulation-history comparison): compared ${topCompared}, exact ${topCompared - top.mis}, mismatched ${top.mis}${top.box ? ` (${top.box})` : ""}`);
  let shown = 0;
  for (let y = 0; y < MAP_TOP && shown < 12; y++) {
    for (let x = 0; x < WIDTH && shown < 12; x++) {
      if (capRgb[y * WIDTH + x] === palRgb[expectedIndex[y * WIDTH + x]]) continue;
      console.log(`  top bar diff at (${x}, ${y}): expected #${hex(palRgb[expectedIndex[y * WIDTH + x]])} actual #${hex(capRgb[y * WIDTH + x])}`);
      shown++;
    }
  }
}
const uiRegions = [
  ["top bar (date, money, QoL text)", 0, 0, WIDTH, MAP_TOP, () => false],
  ["right panel outside the mode icon, buttons", MAP_RIGHT, MAP_TOP, WIDTH, MAP_BOTTOM, inIcon],
  ["message line and log panel outside the fill", 0, MAP_BOTTOM, WIDTH, HEIGHT, inPanel],
].filter(([name]) => !(topbarStaged && name.startsWith("top bar")));
for (const [name, x0, y0, x1, y1, skip] of uiRegions) {
  const r = countBox(capRgb, expectedIndex, palRgb, x0, y0, x1, y1, skip);
  console.log(`not compared (UI/dynamic) ${name}: ${r.mis} pixels differ${r.box ? ` (${r.box})` : ""}`);
}

if (map.mismatched === 0 && icon.mis === 0 && panelCount.mis === 0 && (!topbarStaged || top.mis === 0)) {
  console.log(`map layer, mode icon and log panel fill${topbarStaged ? " and staged top bar" : ""} match: every compared pixel equals the remake's palette colour`);
  process.exit(0);
}
if (icon.mis > 0) console.log(`mode icon divergence: ${icon.mis} of ${iconCompared} pixels differ`);
if (panelCount.mis > 0) console.log(`log panel divergence: ${panelCount.mis} of ${panelCompared} pixels differ`);
if (topbarStaged && top.mis > 0) console.log(`top bar divergence (staged): ${top.mis} of ${topCompared} pixels differ`);
for (const s of map.shown) {
  console.log(`  diff at (${s.x}, ${s.y}) index ${s.index}: expected #${hex(s.expected)} actual #${hex(s.actual)}`);
}
const used = [...map.perIndex].map(([i, counts]) => {
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return `index ${i} -> #${hex(top[0])} (${top[1]} of ${[...counts.values()].reduce((a, b) => a + b, 0)})`;
});
console.log(`palette report for mismatched map pixels: ${used.length ? used.join("; ") : "none"}`);
console.log(map.mismatched > 0 ? "map layer divergence" : icon.mis > 0 ? "mode icon divergence" : panelCount.mis > 0 ? "log panel divergence" : "top bar divergence (staged)");
process.exit(1);
