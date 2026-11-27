// Optional, read-only comparison of one Copperline window grab taken after a tank-yard placement (scenario 0, build mode,
// tile $45 committed, money 500030) with the remake's map layer for the same state. It covers the visible map layer
// (rows 24..159, x 0..255, exact) and a 3 x 3 cell crop around the staged site cell (exact). Nothing is simulated: no pass,
// tick, RNG draw or construction week runs; the state is written field by field from the documented runtime addresses.
//
// Usage (after `npm run build`):   UTOPIA_SITE_CAPTURE=<absolute path to a .png> node test/construction-site-capture-compare.mjs
//                                  [UTOPIA_SITE_CELL=51,35]      (map cell of the staged site; default 51,35, see "Site cell")
//                                  [UTOPIA_SITE_POINTER=157,80]  (pointer position of the capture; default 157,80)
//                                  [UTOPIA_SITE_BLINK=0|1]       (selection blink bit `$156A9` bit 1 of the capture; default 0)
//                                  [UTOPIA_SITE_DAY=0..31]       (day byte `$1459F` of the capture; default 2, the E capture)
//                                  [UTOPIA_SITE_POINTER=127,30 UTOPIA_SITE_BLINK=1 UTOPIA_SITE_DAY=3]  (the 2026-11-10 capture)
//
// Day byte (UTOPIA_SITE_DAY): the top bar shows the date, which advances by a day tick in the game. The E capture is day 2
// (`02/07/2090`). The 2026-11-10 capture was taken 20 frames later (frame 16467), and its RAM reads `$1459F` = 3 (`03/07/2090`):
// a fresh Copperline reproduction, byte-identical to the recorded capture, read day 3 at that frame. With day 3 the top bar
// matches exactly. Day 2 gives the 5-pixel residual at x 13..16, rows 4..6. The day is state, so it is passed explicitly.
//
// Cursor phase (UTOPIA_SITE_BLINK): the cursor tile 58 is drawn on the pointer's cell only in phase 0. The E capture
// (2026-11-06 probe, snap-E) shows it, with `$156A9` = $08 in its RAM (phase 0, the default). The 2026-11-10 capture shows
// no cursor under its pointer, and its RAM read after the byte-identical reproduction is `$156A9` = $0A (phase 1, pass
// `UTOPIA_SITE_BLINK=1`). The phase is state, so it is passed explicitly, not inferred from pixels.
//
// Source (snap-E-after-placement.png, Copperline 1.0.1 window grab, 716 x 285, SHA-256
// 009FBB2009B4883FB2E484DF4F3F8F4537F968A4F8D8AA7BD59F3B85B7A6A362, from the 2026-11-06 probe UtopiaCostProbe-20261106-161056,
// kept outside the repository). Its run files (Disk.1, Disk.2, disk.4, Utopia.Slave) are byte-identical to original/utopia-whdload.
// The capture's snapshot JSON (snap-E-after-placement.json) gives money $135BA = 500030, spent $142CA = 6000, used objects $142C2 = 21,
// sites $142C4 = 1, builders $1432A = 20, and the selection $142AA = tile $45 / type T[22] at $1336E. Those values are staged,
// together with the one object record and the site cell described below.
//
// Staged runtime fields (documented in notes/formats/building.md, "Side preview comparison", and build.ts `place`):
//   money, spent, used-object count, site count, builders, one object record (tile $32, target $45, x, y, weeks from the type
//   table), and the site cell's map word through Construction.markSite ($6FC4). Build mode, selection tile $45 and type 22,
//   scroll (47, 33). The object layer draws units, enemies, effects, the alien and the meteor, and pins separately; no code
//   adds building records to its draw list, so the site's pixels come from its cell tile alone.
//
// Pointer and cursor: the capture's pointer is at (157, 80). The hovered cell is taken from the remake's own pick
// (`controls.pickCell`, the function MapScene uses for pointer selection) and drawn as the cursor tile (descriptor 58,
// `ObjectLayer.drawMap`, in the phase UTOPIA_SITE_BLINK gives). The comparator does not assume which cell that is: it prints the pick.
//
// Site cell: the notes give (52, 36) for the record (building.md, "Observed gameplay trace", step 3). The E frame's
// $142B2 tail reads 00330023 (= (51, 35) as bytes; interpretation is HYPOTHESIS). Both are staged in turn as controls.
// Result on this capture (see the printed lines): the cursor covers (51, 35), so the frame cannot show a site there, and
// the frame with no site matches exactly as well. With the remake's tile $32 art, a site at (52, 36) would be visible; the
// capture shows none there (352 mismatches in the map layer), so the capture argues against (52, 36) as the drawn site.
// This is a pixel argument under the remake's art for tile $32, not a check of the record itself.
// A later off-yard capture (notes/formats/building.md, "Off-yard pointer capture", 2026-11-10) reads the record as (51, 35) and
// matches the 3 x 3 crop around (51, 35) exactly with the pointer at (127, 30); (52, 36) is refuted there.
//
// Message line: the commit of the build selection posts string 0 ("Click on map to choose a site.") on the message line (static `$6BA2`;
// controls.ts). With that string staged, rows 158..170 (the text line) match the E capture exactly (0 of 4,160). Staging the building
// name instead (string $1B, the remake's earlier behaviour) or no message gives 300 to 320 mismatches in x 8..142, rows 160..165.
// Log panel (rows 171..199, full width): the E capture shows the cleared pattern fill there. The staging clears the panel
// through the scene's idle timer (500 updates, `$1586E`) BEFORE it posts string 0. The order matters: the message line lasts
// 200 updates, so a line posted before the clear would have expired. With that order the strip matches exactly (0 of 9,280).
// The original's clear trigger and timing are not established (building.md, "Log panel strip").
//
// Exit codes with a capture: 0 the map layer, top bar, right panel, message-line rows and log strip match exactly with the staged state (site cell, cursor, cleared panel, top-bar values, menu-exit buttons); 1 divergence; 2 unavailable
// (not a 2x grab, no valid alignment, a staging that did not take, or missing Disk.1/Disk.2). Without UTOPIA_SITE_CAPTURE the
// script runs its self-test and reports "skipped" with exit 0. A capture inside the repository is refused (exit 1).
//
// Top bar (rows 0..23): staged with the RAM reads of the 2026-11-11 replay (building.md, "E residual breakdown"): day $1459F =
// UTOPIA_SITE_DAY (default 2, the E capture; 3 for the 2026-11-10 capture), month $145A0 = 6 (shown as 07), elapsed years $142A6 = 0
// (2090), QoL long $142C6 = 44 (its word $142C8 shows DOL 44).
// Right panel (x 256..319, rows 24..159): the E frame is after a build-menu exit, so the command-button column is staged in the
// state that exit leaves (`Controls.markMenuExitButtonImages`): the ten buttons are the `$5DDA` images (`$B628` -> `$58A0`,
// building.md "Right panel, part 2"). The staging only sets that state; the pixels are the remake's own draw.
//
// Evidence limits: one frame, one capture, the map layer, the top bar, the message-line text rows, the right panel, the log strip
// and one 3 x 3 crop, scenario 0 only. The message line is staged as string 0 by the remake's own commit path; a match shows that
// the text and its position agree in this frame, not the timing of the message (its 200-frame lifetime is not compared). A match
// does not show the site record, the record's position (the cursor hides the site cell here), timing, animation phase of other
// cells, or any other pixel. The log strip is a match on one frame with the cleared fill staged; the clear's trigger and timing
// in the original are not compared. The right-panel match rests on the `$5DDA` image trace (static) plus this one frame; the
// menu-exit redraw was not observed in a run of its own.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, PixelError } from "./png-codec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 320;
const HEIGHT = 200;
const MAP = { x0: 0, x1: 256, y0: 24, y1: 160 }; // map window (notes/formats/map-rendering.md sections 3-4)
const SITE_TILE = 0x32;
const TARGET_TILE = 0x45;
const TYPE = 22;
const CURSOR_TILE = 58; // descriptor index 58 (`$657A`), the pointer's cell
const DEFAULT_CELL = [51, 35];
const DEFAULT_POINTER = [157, 80];
const DEFAULT_BLINK = 0; // cursor phase of the E capture (`$156A9` bit 1 = 0, cursor drawn); see the header
const CAPTURE_SHA256 = "009fbb2009b4883fb2e484df4f3f8f4537f968a4f8d8aa7bd59f3b85b7a6a362";
const MONEY = 500030;
const SPENT = 6000;
const USED_OBJECTS_BEFORE = 20;
const SITE_COUNT_BEFORE = 0;
const BUILDERS = 20;
const SITE_PROMPT = 0; // string 0, posted by the build-selection commit (see the staging below)
// Message line rows that the E capture shows as text (line y 160; the log panel starts at row 171 and is not compared here).
const MESSAGE_LINE = { x0: 0, x1: WIDTH, y0: 158, y1: 171 };
// Top bar (date, money, QoL text) and the right panel beside the map (command-button column, mode icon, side preview).
const TOP_BAR = { x0: 0, x1: WIDTH, y0: 0, y1: 24 };
const RIGHT_PANEL = { x0: 256, x1: WIDTH, y0: 24, y1: 160 };
// Top-bar values (RAM read in the 2026-11-11 replay; building.md "E residual breakdown and closing step"). The day byte is an
// input (UTOPIA_SITE_DAY, see the header): 2 for the E capture, 3 for the 2026-11-10 capture. The default is the E capture's.
const DEFAULT_DAY = 2;
const MONTH = 6; // month byte (shown as 07)
const YEARS = 0; // elapsed years from 2090
const QUALITY = 44;
// Log panel strip (rows 171..199, full width). The cleared fill is staged, so the whole strip is compared.
const LOG_STRIP = { x0: 0, x1: WIDTH, y0: 171, y1: HEIGHT };
// A log string posted before the string-0 prompt. Index 143 is a log string (game-text.md section 5); the map comparator stages it too.
const LOG_CLEAR_STAGING_STRING = 143;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// ---- pure helpers (shared by the self-test and the capture comparison) ----------------------------------------------

export function nativeWidthIfPaired(grab) {
  if (grab.width % 2 !== 0) return null;
  for (let y = 0; y < grab.height; y++) {
    for (let k = 0; k < grab.width / 2; k++) {
      const a = (y * grab.width + 2 * k) * 4;
      const b = a + 4;
      if (grab.rgba[a] !== grab.rgba[b] || grab.rgba[a + 1] !== grab.rgba[b + 1] || grab.rgba[a + 2] !== grab.rgba[b + 2]) return null;
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

// Whole-frame origin search with the rule the other capture comparators use: at most 10% mismatches, and the best origin
// outside a +-2 neighbourhood has at least three times as many.
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
  if (best.mis > (WIDTH * HEIGHT) / 10) return `best origin (${best.ox}, ${best.oy}) mismatches ${best.mis} of ${WIDTH * HEIGHT} (more than 10%)`;
  if (second && second.mis < 3 * best.mis) return `origin is ambiguous: (${best.ox}, ${best.oy}) ${best.mis} vs (${second.ox}, ${second.oy}) ${second.mis}`;
  return { ox: best.ox, oy: best.oy, mismatched: best.mis, second: second ? { ox: second.ox, oy: second.oy, mis: second.mis } : null };
}

// Compares a rectangle of the native frame. Returns the count, the mismatch extent and the colour pairs seen.
export function compareRect(grab, ox, oy, expected, rect) {
  const out = { compared: 0, mismatched: 0, extent: null, pairs: new Map() };
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
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

// Parses "x,y" from an environment value; returns null when malformed.
export function parseCell(text) {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Parses the day byte from an environment value (0..31); returns null when malformed.
export function parseDay(text) {
  const m = /^\s*(\d{1,2})\s*$/.exec(text ?? "");
  if (!m) return null;
  const day = Number(m[1]);
  return day <= 31 ? day : null;
}

// ---- self-test (always runs; no original files) ---------------------------------------------------------------------

function selfTest() {
  const palette = Array.from({ length: 32 }, (_, i) => (((i * 37) & 255) << 16) | (((i * 91 + 7) & 255) << 8) | ((255 - i * 8) & 255));
  const index = Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => ((i * 2654435761) >>> 27) & 31);
  const expected = Uint32Array.from(index, (i) => palette[i]);
  const GW = 2 * (WIDTH + 40);
  const GH = HEIGHT + 30;
  const rgba = new Uint8Array(GW * GH * 4);
  const put = (gx, gy, c) => rgba.set([c >> 16, (c >> 8) & 255, c & 255, 255], (gy * GW + gx) * 4);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx += 2) { const c = ((gx * 13) ^ (gy * 29)) & 0xffffff; put(gx, gy, c); put(gx + 1, gy, c); }
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) for (let k = 0; k < 2; k++) put(2 * (x + 31) + k, y + 16, expected[y * WIDTH + x]);
  const grab = { width: GW, height: GH, rgba };
  const found = findFrameOrigin(grab, expected);
  check("synthetic 2x grab: origin (31, 16) found with no mismatch", typeof found === "object" && found.ox === 31 && found.oy === 16 && found.mismatched === 0, typeof found === "object" ? `(${found.ox}, ${found.oy})` : found);
  const rect = { x0: 0, x1: 256, y0: 24, y1: 160 };
  const exact = compareRect(grab, 31, 16, expected, rect);
  check("synthetic map layer compares exact", exact.compared === 256 * 136 && exact.mismatched === 0, `${exact.compared} pixels`);
  const changed = Uint8Array.from(rgba);
  changed.set([0x12, 0x34, 0x56], ((16 + 60) * GW + 2 * (31 + 150)) * 4);
  const one = compareRect({ width: GW, height: GH, rgba: changed }, 31, 16, expected, rect);
  check("one changed pixel in the map layer is one mismatch with its extent", one.mismatched === 1 && one.extent.x0 === 150 && one.extent.y0 === 60, JSON.stringify(one.extent));
  const broken = { width: GW, height: GH, rgba: Uint8Array.from(rgba) };
  broken.rgba[(16 * GW + 2 * 40) * 4] ^= 0x40;
  check("a grab with one differing column pair is refused", typeof findFrameOrigin(broken, expected) === "string");
  check("cell parser accepts 51,35 and rejects junk", JSON.stringify(parseCell("51,35")) === "[51,35]" && parseCell("51;35") === null);
  check("day parser accepts 0..31 and rejects junk", parseDay("3") === 3 && parseDay("31") === 31 && parseDay("32") === null && parseDay("-1") === null && parseDay("x") === null);
}

// ---- main -------------------------------------------------------------------------------------------------------------

selfTest();
if (failures > 0) {
  console.log(`construction-site capture comparator self-test failed (${failures})`);
  process.exit(1);
}
const capturePath = process.env.UTOPIA_SITE_CAPTURE;
if (!capturePath) {
  console.log("construction-site capture comparison skipped: UTOPIA_SITE_CAPTURE is not set (optional, external Copperline capture)");
  process.exit(0);
}
const resolved = path.resolve(capturePath);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
  console.log(`construction-site capture comparison: UTOPIA_SITE_CAPTURE is not a file: ${resolved}`);
  process.exit(1);
}
const relToRoot = path.relative(root, resolved);
if (relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) {
  console.log("construction-site capture comparison: refusing a capture inside the repository (captures stay outside it)");
  process.exit(1);
}
const siteCell = process.env.UTOPIA_SITE_CELL ? parseCell(process.env.UTOPIA_SITE_CELL) : DEFAULT_CELL;
const pointer = process.env.UTOPIA_SITE_POINTER ? parseCell(process.env.UTOPIA_SITE_POINTER) : DEFAULT_POINTER;
if (!siteCell || !pointer) {
  console.log("construction-site capture comparison: UTOPIA_SITE_CELL and UTOPIA_SITE_POINTER must be x,y");
  process.exit(1);
}
const blinkText = process.env.UTOPIA_SITE_BLINK ?? String(DEFAULT_BLINK);
if (blinkText !== "0" && blinkText !== "1") {
  console.log("construction-site capture comparison: UTOPIA_SITE_BLINK must be 0 or 1");
  process.exit(1);
}
const blink = Number(blinkText);
const DAY = process.env.UTOPIA_SITE_DAY ? parseDay(process.env.UTOPIA_SITE_DAY) : DEFAULT_DAY;
if (DAY === null) {
  console.log("construction-site capture comparison: UTOPIA_SITE_DAY must be a day byte 0..31");
  process.exit(1);
}
const DATE_TEXT = `${String(DAY).padStart(2, "0")}/07/2090`; // the date text for the staged day and month (MONTH shows as 07)
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
function unavailable(reason) {
  console.log(`construction-site capture comparison unavailable: ${reason}`);
  process.exit(2);
}
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) unavailable("original Disk.1 or Disk.2 not found (original/utopia-whdload)");

const captureBytes = fs.readFileSync(resolved);
let grab;
try {
  grab = decodePng(captureBytes);
} catch (e) {
  if (e instanceof PixelError) unavailable(`capture ${path.basename(resolved)} is not a supported PNG (${e.message})`);
  throw e;
}

const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { readFlagTable } = await import("../dist/data/gameimage.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { MapScene, anchorX, anchorY } = await import("../dist/game/map.js");
const { Construction } = await import("../dist/game/construction.js");
const { LOG_IDLE_FRAMES } = await import("../dist/game/messages.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const tiles = loadTileSet(disk1, disk2, record).tiles;
const flagTable = readFlagTable(disk1);
const ADDR = { builders: 0x1432a, objects: 0x142c2, sites: 0x142c4 };

// One scene in the staged state. `site` is the map cell of the placed yard, or null for the state without it.
// Presentation only: no pass, tick, RNG draw, construction week or input update runs; the cursor is the remake's own pick.
function stage(site, blinkBit = blink) {
  const world = new World(new GameState(disk2, record.block), loadMap(disk2, record));
  const scene = new MapScene(disk1, tiles, world, new GameStrings(disk1, 0), { sprites: loadSprites(disk1, disk2, record), freshScenario: true });
  if (scene.scrollX !== 47 || scene.scrollY !== 33) unavailable(`staged scroll is (${scene.scrollX}, ${scene.scrollY}); the start view (47, 33) is required`);
  const st = world.state;
  if (site) {
    st.setLong(A.money, MONEY);
    st.setLong(A.spent, SPENT);
    st.setWord(ADDR.objects, USED_OBJECTS_BEFORE + 1);
    st.setWord(ADDR.sites, SITE_COUNT_BEFORE + 1);
    st.setLong(ADDR.builders, BUILDERS);
    if (st.displayMoney() !== MONEY) unavailable(`money staging did not take (${st.displayMoney()})`);
    const o = world.objects;
    let slot = -1;
    for (let i = 0; i < o.length; i += 8) if (o[i] === 0 && o[i + 1] === 0) { slot = i; break; }
    if (slot < 0) unavailable("no free object slot for the site record");
    const t = world.typeAddress(TYPE);
    o[slot] = 0;
    o[slot + 1] = SITE_TILE;
    o[slot + 2] = 0;
    o[slot + 3] = TARGET_TILE;
    o[slot + 4] = site[0];
    o[slot + 5] = site[1];
    o[slot + 6] = st.byte(t + 2); // weeks remaining, as `place` writes it
    o[slot + 7] = 0;
    new Construction(world, flagTable).markSite(SITE_TILE, site[0], site[1], 1);
    st.setByte(A.day, DAY);
    st.setByte(A.month, MONTH);
    st.setLong(A.year, YEARS);
    st.setLong(A.qualityOfLife, QUALITY);
    if (st.dateText() !== DATE_TEXT) unavailable(`top-bar date staging did not take (${st.dateText()}, expected ${DATE_TEXT})`);
    if (st.word(A.qualityOfLife + 2) !== QUALITY) unavailable("QoL staging did not take");
    // The E frame is after the build-menu exit (`$B628`): the button column is the `$5DDA` image set (controls.ts).
    scene.controls.markMenuExitButtonImages();
  }
  scene.controls.mode = "build";
  scene.controls.selection = { tile: TARGET_TILE, type: TYPE };
  const pick = scene.controls.pickCell(pointer[0], pointer[1]);
  scene.hoverViewCell = pick ? { vx: pick.x - scene.scrollX, vy: pick.y - scene.scrollY } : null;
  scene.selectionBlinkBit = blinkBit; // 0 draws the cursor tile on the pointer's cell; 1 draws the map tile (see UTOPIA_SITE_BLINK)
  // The commit of the build selection posts string 0 ("Click on map to choose a site.") on the message line (`$6BA2`,
  // `moveq #0,d0; bsr $551a`; controls.ts BUILD_SITE_PROMPT). The E capture shows that line, so it is staged here too.
  // The E capture shows the log panel cleared (the pattern fill). The idle clear runs first, then the prompt is posted: the
  // message line lasts 200 updates and the clear 500, so the other order would expire the line. Staged with the same
  // timers the game uses (Messages.update); no pass, tick or RNG runs.
  scene.messages.push(LOG_CLEAR_STAGING_STRING);
  for (let i = 0; i < LOG_IDLE_FRAMES; i++) scene.messages.update();
  if (!scene.messages.panelCleared || scene.messages.logText.length !== 0) unavailable("the log panel idle clear did not stage");
  scene.messages.push(SITE_PROMPT);
  scene.drawInitialFrame();
  const palRgb = scene.screen.palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);
  return { scene, pick, expected: Uint32Array.from(scene.screen.pixels, (i) => palRgb[i]) };
}

const primary = stage(siteCell);
const found = findFrameOrigin(grab, primary.expected);
if (typeof found === "string") unavailable(`no valid alignment: ${found}`);
const { ox, oy } = found;
const sha = createHash("sha256").update(captureBytes).digest("hex");
console.log(`capture ${path.basename(resolved)}: ${grab.width} x ${grab.height}, sha256 ${sha}${sha === CAPTURE_SHA256 ? " (the E capture recorded in building.md)" : " (not the recorded E capture)"}`);
console.log(`alignment: origin (${ox}, ${oy}), full-frame mismatches ${found.mismatched} of ${WIDTH * HEIGHT}; next origin ${found.second ? `(${found.second.ox}, ${found.second.oy}) ${found.second.mis}` : "none"}`);
console.log(`staging: scenario 0, build mode, tile $${TARGET_TILE.toString(16)} type ${TYPE}, money ${MONEY}, spent ${SPENT}, used objects ${USED_OBJECTS_BEFORE + 1}, sites ${SITE_COUNT_BEFORE + 1}, builders ${BUILDERS}; site cell (${siteCell.join(", ")}) tile $${SITE_TILE.toString(16)}; scroll (47, 33); cursor phase ${blink}; day byte ${DAY} (${DATE_TEXT})`);
if (!primary.pick) unavailable("the pointer picks no map cell");
console.log(`pointer (${pointer.join(", ")}) picks map cell (${primary.pick.x}, ${primary.pick.y}); cursor tile ${CURSOR_TILE} drawn there`);

// Bounded crop: the 3 x 3 view cells around the site cell, from the anchor geometry, clipped to the map window.
const scroll = { x: primary.scene.scrollX, y: primary.scene.scrollY };
const crop = (() => {
  const xs = [];
  const ys = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const vx = siteCell[0] + dx - scroll.x;
      const vy = siteCell[1] + dy - scroll.y;
      xs.push(anchorX(vx, vy));
      ys.push(anchorY(vx, vy));
    }
  }
  return { x0: Math.max(MAP.x0, Math.min(...xs) - 16), x1: Math.min(MAP.x1, Math.max(...xs) + 16), y0: Math.max(MAP.y0, Math.min(...ys) - 32), y1: Math.min(MAP.y1, Math.max(...ys) + 8) };
})();

const mapCmp = compareRect(grab, ox, oy, primary.expected, MAP);
const cropCmp = compareRect(grab, ox, oy, primary.expected, crop);
const lineCmp = compareRect(grab, ox, oy, primary.expected, MESSAGE_LINE);
const logCmp = compareRect(grab, ox, oy, primary.expected, LOG_STRIP);
const topCmp = compareRect(grab, ox, oy, primary.expected, TOP_BAR);
const panelCmp = compareRect(grab, ox, oy, primary.expected, RIGHT_PANEL);
console.log(`top bar (rows ${TOP_BAR.y0}..${TOP_BAR.y1 - 1}, staged date ${DATE_TEXT}, money ${MONEY}, DOL ${QUALITY}): compared ${topCmp.compared}, mismatched ${topCmp.mismatched}${topCmp.extent ? `, extent x ${topCmp.extent.x0}..${topCmp.extent.x1}, rows ${topCmp.extent.y0}..${topCmp.extent.y1}` : ""}`);
console.log(`right panel (rows ${RIGHT_PANEL.y0}..${RIGHT_PANEL.y1 - 1}, x ${RIGHT_PANEL.x0}..${RIGHT_PANEL.x1 - 1}, menu-exit button images): compared ${panelCmp.compared}, mismatched ${panelCmp.mismatched}${panelCmp.extent ? `, extent x ${panelCmp.extent.x0}..${panelCmp.extent.x1}, rows ${panelCmp.extent.y0}..${panelCmp.extent.y1}` : ""}`);
console.log(`map layer (rows ${MAP.y0}..${MAP.y1 - 1}, x ${MAP.x0}..${MAP.x1 - 1}): compared ${mapCmp.compared}, exact ${mapCmp.compared - mapCmp.mismatched}, mismatched ${mapCmp.mismatched}`);
console.log(`message line (rows ${MESSAGE_LINE.y0}..${MESSAGE_LINE.y1 - 1}, staged string ${SITE_PROMPT}): compared ${lineCmp.compared}, mismatched ${lineCmp.mismatched}${lineCmp.extent ? `, extent x ${lineCmp.extent.x0}..${lineCmp.extent.x1}, rows ${lineCmp.extent.y0}..${lineCmp.extent.y1}` : ""}`);
console.log(`log panel strip (rows ${LOG_STRIP.y0}..${LOG_STRIP.y1 - 1}, x 0..${WIDTH - 1}, cleared fill staged): compared ${logCmp.compared}, mismatched ${logCmp.mismatched}${logCmp.extent ? `, extent x ${logCmp.extent.x0}..${logCmp.extent.x1}, rows ${logCmp.extent.y0}..${logCmp.extent.y1}` : ""}`);
console.log(`3 x 3 crop around (${siteCell.join(", ")}), x ${crop.x0}..${crop.x1 - 1}, rows ${crop.y0}..${crop.y1 - 1}: compared ${cropCmp.compared}, mismatched ${cropCmp.mismatched}`);
if (mapCmp.mismatched > 0) {
  console.log(`map-layer mismatch extent x ${mapCmp.extent.x0}..${mapCmp.extent.x1}, rows ${mapCmp.extent.y0}..${mapCmp.extent.y1}`);
  for (const [pair, n] of [...mapCmp.pairs].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  expected->capture ${pair}: ${n}`);
}

// Controls on the same capture and pointer: the state without the site, and the other candidate cell from the notes.
const controls = [["no site", null]];
for (const c of [[51, 35], [52, 36]]) if (c.join() !== siteCell.join()) controls.push([`site (${c.join(", ")})`, c]);
for (const [label, cell] of controls) {
  const r = compareRect(grab, ox, oy, stage(cell).expected, MAP);
  console.log(`control ${label}: map layer mismatched ${r.mismatched} of ${r.compared}${r.extent ? `, extent x ${r.extent.x0}..${r.extent.x1}, rows ${r.extent.y0}..${r.extent.y1}` : ""}`);
}

const coveredByCursor = primary.pick.x === siteCell[0] && primary.pick.y === siteCell[1];
if (mapCmp.mismatched === 0) {
  console.log(coveredByCursor
    ? `verdict: the map layer matches exactly, but the cursor covers the site cell (${siteCell.join(", ")}); this frame does not show the site there`
    : "verdict: the map layer matches exactly with the staged site cell");
}
process.exit(mapCmp.mismatched === 0 && topCmp.mismatched === 0 && panelCmp.mismatched === 0 && lineCmp.mismatched === 0 && logCmp.mismatched === 0 ? 0 : 1);
