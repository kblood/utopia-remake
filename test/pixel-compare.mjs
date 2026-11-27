// Optional, read-only pixel comparison of one aligned original capture (a PNG the player made with their own emulator) against the
// remake's title frame (src/game/intro.ts) or language frame (src/game/language.ts). It never writes into the repository, the
// original files or the capture.
//
// Usage (after `npm run build`):   UTOPIA_PIXEL_CAPTURE=<absolute path to a .png> node test/pixel-compare.mjs
//                                  [UTOPIA_PIXEL_STATE=title|language]   (default title)
//                                  [UTOPIA_PIXEL_POINTER=x,y]   (language only: the boot sprite is stamped at pointer x,y, hotspot
//                                  (x-5,y-5); the pointer exception below is then off, so every pixel is compared)
//
// Without UTOPIA_PIXEL_CAPTURE the script still runs its self-test (PNG round trip, CRC and format rejection, synthetic
// comparison) and then reports "skipped" with exit 0. Exit codes with a capture:
//   0  match: every pixel of the compared region equals the remake's palette colour
//   1  divergence (a palette mapping or pixel difference), or a configuration error (missing or non-PNG path, unknown state)
//   2  unavailable: the capture cannot be compared without a model it does not satisfy (unsupported PNG format, size other
//      than 320 x 200, a better-aligned offset than (0,0), or no consistent index-to-colour mapping, which suggests another state)
//
// Alignment and palette (the only assumptions):
//   - The capture must be a native 320 x 200 frame, 1:1 with the remake's Screen buffer, origin at (0,0). Window grabs with
//     borders (716 x 285) and 640 x 256 frames are unavailable: they would need an emulator-specific crop and scale model.
//   - Colours: the remake's palette words are OCS 0x0RGB values expanded with `ocsColor` (4-bit channel x 17). The capture is
//     compared colour by colour; a per-index mapping that is one consistent colour is reported even when it is not the
//     remake's colour, so a palette error is shown, not hidden.
//   - Region per state: title = rows 0..179 only (row 180, `TEXT_Y` in intro.ts, and below hold the credit roll, which types in
//     and clears on its own schedule); language = all 200 rows.
//   - Language pointer: without UTOPIA_PIXEL_POINTER, pixels that are 0,255,0 in the capture over background index 0 are excluded
//     only when they are a mismatch at index 0 and their box is at most 16 x 16; the count and box are printed. A larger box
//     excludes nothing. With UTOPIA_PIXEL_POINTER=x,y the boot sprite (hardware sprite 2, decoded from Disk.1; text.md) is stamped
//     at that remake pointer position and no pixel is excluded. The 12 px of language2.png are the sprite's rows 5..8 at pointer
//     (20,0); mouse.png is the full sprite at (120,40). The pointer positions are inferred from those captures, not read from them.
//
// Evidence limits: a match here is one title frame, one capture, one region. It is not a claim about other screens, the
// roll text, timing or gameplay, and it is not a claim of pixel parity in general.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PixelError, decodePng, encodePng } from "./png-codec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 320;
const HEIGHT = 200;
const COMPARE_ROWS = 180; // title: rows 0..179, above the credit text (`TEXT_Y` = $B4 in src/game/intro.ts)
const MAX_SHOWN = 12;


// ---- PNG decoding and encoding: shared with test/map-capture-compare.mjs (test/png-codec.mjs)

// ---- comparison ------------------------------------------------------------------------------------------------------------

// Compares the region rows 0..rows-1 of `capture` (RGBA, WIDTH x HEIGHT) against the remake frame at offset (dx, dy)
// (capture pixel = frame pixel + offset). Returns counts and the per-index colour histogram used for the palette report.
export function compareRegion(capture, frame, dx = 0, dy = 0, rows = COMPARE_ROWS, overlay = null) {
  let compared = 0;
  let exact = 0;
  let overlayPixels = 0;
  let overlayBox = null;
  const shown = [];
  const perIndex = Array.from({ length: frame.palette.length }, () => new Map());
  for (let y = 0; y < rows; y++) {
    const cy = y + dy;
    if (cy < 0 || cy >= HEIGHT) continue;
    for (let x = 0; x < WIDTH; x++) {
      const cx = x + dx;
      if (cx < 0 || cx >= WIDTH) continue;
      const index = frame.pixels[y * WIDTH + x];
      const [pr, pg, pb] = frame.palette[index];
      const c = (cy * WIDTH + cx) * 4;
      if (overlay && index === overlay.index && capture[c] === overlay.rgb[0] && capture[c + 1] === overlay.rgb[1] && capture[c + 2] === overlay.rgb[2]) {
        // the boot-stage pointer exception (not the software arrow, see the header): index-0 background showing the sprite colour.
        // Counted and reported, not compared. The caller refuses the exclusion if the overlay colour is the index-0 colour, and
        // drops it if the box is larger than the pointer.
        overlayPixels++;
        overlayBox = overlayBox ? { x0: Math.min(overlayBox.x0, x), y0: Math.min(overlayBox.y0, y), x1: Math.max(overlayBox.x1, x), y1: Math.max(overlayBox.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
        continue;
      }
      const key = (capture[c] << 16) | (capture[c + 1] << 8) | capture[c + 2];
      compared++;
      const counts = perIndex[index];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (capture[c] === pr && capture[c + 1] === pg && capture[c + 2] === pb) exact++;
      else if (shown.length < MAX_SHOWN) shown.push({ x, y, index, expected: [pr, pg, pb], actual: [capture[c], capture[c + 1], capture[c + 2]] });
    }
  }
  return { compared, exact, mismatched: compared - exact, shown, perIndex, overlayPixels, overlayBox };
}

// Palette mapping: for each index used in the region, the dominant capture colour and how consistent the mapping is.
export function paletteMapping(perIndex, palette) {
  let total = 0;
  let dominantTotal = 0;
  const rows = [];
  perIndex.forEach((counts, index) => {
    if (counts.size === 0) return;
    let best = -1;
    let bestCount = 0;
    let n = 0;
    for (const [key, count] of counts) {
      n += count;
      if (count > bestCount) { best = key; bestCount = count; }
    }
    total += n;
    dominantTotal += bestCount;
    const [pr, pg, pb] = palette[index];
    rows.push({
      index,
      expected: [pr, pg, pb],
      dominant: [(best >> 16) & 255, (best >> 8) & 255, best & 255],
      pixels: n,
      share: bestCount / n,
      distinct: counts.size,
    });
  });
  return { total, consistency: total === 0 ? 0 : dominantTotal / total, rows };
}

// ---- the states the remake can render headlessly -----------------------------------------------------------------------------

async function remakeLanguageFrame(disk1, pointer) {
  const { LanguageScene } = await import("../dist/game/language.js");
  const { Screen } = await import("../dist/gfx/screen.js");
  const { readBootPointer, stampPointer } = await import("../dist/gfx/pointer.js");
  const scene = new LanguageScene(disk1, new Screen());
  const idle = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  // the picture is on screen and the pointer is visible once the fade-in has ended (phase "choosing"); nothing is chosen yet
  for (let n = 0; !scene.pointerVisible; n++) {
    if (n > 1000) throw new PixelError("language fade-in did not end");
    scene.update(idle);
  }
  if (pointer) stampPointer(readBootPointer(disk1), scene.screen, pointer.x, pointer.y);
  return { pixels: Uint8Array.from(scene.screen.pixels), palette: scene.screen.palette.map((c) => [...c]) };
}

// ---- the title frame of the remake ----------------------------------------------------------------------------------------

async function remakeTitleFrame(disk1) {
  const { IntroScene } = await import("../dist/game/intro.js");
  const scene = new IntroScene(disk1);
  const idle = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  for (let n = 0; scene.stage !== "roll"; n++) {
    if (n > 1000) throw new PixelError("title sequence did not reach the roll");
    scene.update(idle);
  }
  return { pixels: Uint8Array.from(scene.screen.pixels), palette: scene.screen.palette.map((c) => [...c]) };
}

// ---- self-test (always runs; needs no original files) --------------------------------------------------------------------

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

function selfTest() {
  const w = 7;
  const h = 11; // 11 rows cover every filter type (y % 5) more than twice
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 5) * 91) & 255;
  const png = encodePng(w, h, rgba);
  const back = decodePng(png);
  check("PNG round trip keeps every byte through filters 0-4", back.width === w && back.height === h && Buffer.from(back.rgba).equals(Buffer.from(rgba)));

  const bad = Buffer.from(png);
  bad[8 + 25 + 8 + 2] ^= 1; // IHDR is 25 bytes; IDAT's length and type take 8 more; this byte is inside IDAT's data
  let rejected = false;
  try { decodePng(bad); } catch (e) { rejected = e instanceof PixelError && /CRC/.test(e.message); }
  check("a flipped byte inside a chunk is rejected by its CRC", rejected);

  let truncated = false;
  try { decodePng(png.subarray(0, png.length - 20)); } catch (e) { truncated = e instanceof PixelError; }
  check("a truncated file is rejected", truncated);

  let notPng = false;
  try { decodePng(Buffer.from("GIF89a....")); } catch (e) { notPng = e instanceof PixelError; }
  check("a non-PNG file is rejected", notPng);

  // comparison logic on a synthetic frame: exact, one differing pixel, and an offset that aligns the region
  const palette = Array.from({ length: 32 }, (_, i) => [i * 8 + 1, 254 - i * 8, (i * 5) & 255]); // no entry is the overlay colour 0,255,0
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + (i >> 9)) & 31;
  const frame = { pixels, palette };
  const cap = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) cap.set(palette[pixels[i]], i * 4);
  const exactRun = compareRegion(cap, frame);
  check("synthetic capture equal to the frame: every compared pixel exact", exactRun.compared === WIDTH * COMPARE_ROWS && exactRun.mismatched === 0);
  const mapping = paletteMapping(exactRun.perIndex, palette);
  check("synthetic palette mapping is fully consistent", mapping.consistency === 1 && mapping.rows.every((r) => r.distinct === 1));
  cap[(5 * WIDTH + 9) * 4] ^= 0x10;
  const oneOff = compareRegion(cap, frame);
  check("one changed pixel is counted as one mismatch, with its location", oneOff.mismatched === 1 && oneOff.shown[0].x === 9 && oneOff.shown[0].y === 5);
  // the capture content moved 2 columns left (shifted[x] = cap[x + 2]); frame x therefore sits at capture x - 2: offset (-2, 0)
  const shifted = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const sx = Math.min(x + 2, WIDTH - 1);
    shifted.set(cap.subarray((y * WIDTH + sx) * 4, (y * WIDTH + sx) * 4 + 4), (y * WIDTH + x) * 4);
  }
  const shiftRun = compareRegion(shifted, frame, 0, 0);
  const alignedRun = compareRegion(shifted, frame, -2, 0);
  const withOverlay = Uint8Array.from(cap);
  withOverlay[(0 * WIDTH + 3) * 4] = 0; withOverlay[(0 * WIDTH + 3) * 4 + 1] = 255; withOverlay[(0 * WIDTH + 3) * 4 + 2] = 0;
  frame.pixels[3] = 0; // the overlay is only excluded over background index 0
  const ov = compareRegion(withOverlay, frame, 0, 0, COMPARE_ROWS, { rgb: [0, 255, 0], index: 0, maxSize: 16 });
  check("an overlay-coloured pixel is excluded and counted, not compared", ov.overlayPixels === 1 && ov.mismatched === 1 && ov.overlayBox.x0 === 3 && ov.compared === WIDTH * COMPARE_ROWS - 1, `overlay ${ov.overlayPixels}, mismatched ${ov.mismatched}`);
  check("a capture shifted by 2 columns mismatches at (0,0) and matches at (-2,0)", shiftRun.mismatched > 0 && alignedRun.mismatched <= 1, `(0,0): ${shiftRun.mismatched}, (-2,0): ${alignedRun.mismatched}`);
}

// ---- main -----------------------------------------------------------------------------------------------------------------

// rows: the compared rows of the native frame. title: rows 0..179 (the credit text starts at row 180). language: the whole
// frame, except the boot-stage pointer exception (0,255,0 over index 0, at most 16 x 16; counted and printed, not masked by shape).
const STATES = {
  title: { rows: COMPARE_ROWS, overlay: null, render: remakeTitleFrame },
  // The boot stage's pointer is hardware sprite 2 by static trace (language.ts). Its colour in the capture is 0,255,0 over index 0.
  // 0,255,0 is also a picture colour in this palette (indices 16..31 are 0,255,0), so only index-0 pixels showing it are excluded.
  // The remake's own arrow (`$4A74`) is not this pointer: see the header.
  language: { rows: HEIGHT, overlay: { rgb: [0, 255, 0], index: 0, maxSize: 16 }, render: remakeLanguageFrame },
};

selfTest();
const capturePath = process.env.UTOPIA_PIXEL_CAPTURE;
const state = process.env.UTOPIA_PIXEL_STATE ?? "title";
// The remake pointer position of the capture (language state only). Not read from the capture: the caller states it.
const pointerEnv = process.env.UTOPIA_PIXEL_POINTER;
let pointerAt = null;
if (pointerEnv !== undefined) {
  const m = /^(\d+),(\d+)$/.exec(pointerEnv);
  if (!m || Number(m[1]) > 319 || Number(m[2]) > 199) {
    console.log(`pixel comparison: UTOPIA_PIXEL_POINTER must be x,y within the screen (got "${pointerEnv}")`);
    process.exit(1);
  }
  pointerAt = { x: Number(m[1]), y: Number(m[2]) };
}
if (failures > 0) {
  console.log(`pixel comparator self-test failed (${failures})`);
  process.exit(1);
}
if (!capturePath) {
  console.log("pixel comparison skipped: UTOPIA_PIXEL_CAPTURE is not set (optional, external native 320 x 200 PNG)");
  process.exit(0);
}
if (!STATES[state]) {
  console.log(`pixel comparison: unknown state "${state}" (implemented: ${Object.keys(STATES).join(", ")})`);
  process.exit(1);
}
const resolved = path.resolve(capturePath);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
  console.log(`pixel comparison: UTOPIA_PIXEL_CAPTURE is not a file: ${resolved}`);
  process.exit(1);
}
const relToRoot = path.relative(root, resolved);
if (relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) {
  console.log("pixel comparison: refusing a capture inside the repository (captures stay outside it)");
  process.exit(1);
}
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("pixel comparison unavailable: original Disk.1 not found (original/utopia-whdload/Disk.1)");
  process.exit(2);
}

function unavailable(reason) {
  console.log(`pixel comparison unavailable (${state}): ${reason}`);
  process.exit(2);
}

let capture;
try {
  capture = decodePng(fs.readFileSync(resolved));
} catch (e) {
  if (e instanceof PixelError) unavailable(`capture ${path.basename(resolved)} is not a supported PNG (${e.message})`);
  throw e;
}
if (capture.width !== WIDTH || capture.height !== HEIGHT) {
  unavailable(`capture is ${capture.width} x ${capture.height}; a native ${WIDTH} x ${HEIGHT} frame is required (window grabs and other sizes are not aligned)`);
}
let opaque = true;
for (let i = 3; i < capture.rgba.length; i += 4) if (capture.rgba[i] !== 255) { opaque = false; break; }
if (!opaque) unavailable("capture has non-opaque pixels; an opaque native frame is required");

if (pointerAt && state !== "language") {
  console.log("pixel comparison: UTOPIA_PIXEL_POINTER applies to the language state only");
  process.exit(1);
}
const frame = await STATES[state].render(new Uint8Array(fs.readFileSync(d1)), pointerAt);
let overlay = pointerAt ? null : STATES[state].overlay;
if (overlay && frame.palette[overlay.index].join() === overlay.rgb.join()) {
  unavailable(`the background index ${overlay.index} is the overlay colour; the exclusion would hide picture pixels`);
}
const offsets = [];
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
  const r = compareRegion(capture.rgba, frame, dx, dy, STATES[state].rows, overlay);
  offsets.push({ dx, dy, mismatched: r.mismatched, compared: r.compared });
}
const at0 = offsets.find((o) => o.dx === 0 && o.dy === 0);
const best = offsets.reduce((a, b) => (b.mismatched / b.compared < a.mismatched / a.compared ? b : a));
console.log(`alignment: (0,0) mismatched ${at0.mismatched} of ${at0.compared}; best of the +/-2 px scan is (${best.dx},${best.dy}) with ${best.mismatched}`);
if ((best.dx !== 0 || best.dy !== 0) && best.mismatched < at0.mismatched / 2) {
  unavailable(`capture aligns better at offset (${best.dx},${best.dy}); (0,0) is not the verified alignment`);
}

const rows = STATES[state].rows;
let region = compareRegion(capture.rgba, frame, 0, 0, rows, overlay);
if (overlay && region.overlayBox) {
  const w = region.overlayBox.x1 - region.overlayBox.x0 + 1;
  const h = region.overlayBox.y1 - region.overlayBox.y0 + 1;
  if (w > overlay.maxSize || h > overlay.maxSize) {
    console.log(`overlay box ${w} x ${h} is larger than the pointer (${overlay.maxSize} x ${overlay.maxSize}); no pixels excluded`);
    overlay = null;
    region = compareRegion(capture.rgba, frame, 0, 0, rows, null);
  }
}
const mapping = paletteMapping(region.perIndex, frame.palette);
const matchFraction = region.exact / region.compared;
console.log(`region rows 0..${rows - 1}: ${region.compared} px, ${region.exact} exact, ${region.mismatched} differing (${(matchFraction * 100).toFixed(2)}% exact)`);
if (overlay) {
  const b = region.overlayBox;
  console.log(`pointer exception ${overlay.rgb.join(",")} over index ${overlay.index} (boot sprite colour; not the software arrow $4A74): ${region.overlayPixels} px excluded${b ? `, box x ${b.x0}..${b.x1}, y ${b.y0}..${b.y1}` : ""}`);
}
console.log(`palette mapping: ${(mapping.consistency * 100).toFixed(2)}% of pixels take their index's dominant colour across ${mapping.rows.length} indices`);
if (mapping.consistency < 0.98) {
  unavailable(`no consistent index-to-colour mapping (${(mapping.consistency * 100).toFixed(1)}%): the capture is probably another screen or another frame; not a palette result`);
}
if (region.mismatched === 0) {
  console.log(`pixel comparison match (${state}): ${region.compared} px in ${WIDTH} x ${HEIGHT} at offset (0,0), palette exact`);
  process.exit(0);
}
for (const row of mapping.rows.filter((r) => r.dominant.join() !== r.expected.join() || r.distinct > 1)) {
  console.log(`  index ${row.index}: remake ${row.expected.join(",")}, capture dominant ${row.dominant.join(",")} (${row.pixels} px, ${(row.share * 100).toFixed(1)}% of them, ${row.distinct} colours)`);
}
for (const s of region.shown) {
  console.log(`  diff at (${s.x},${s.y}) index ${s.index}: remake ${s.expected.join(",")}, capture ${s.actual.join(",")}`);
}
console.log(`pixel comparison DIVERGENCE (${state}): ${region.mismatched} differing pixels (first ${region.shown.length} listed)`);
process.exit(1);
