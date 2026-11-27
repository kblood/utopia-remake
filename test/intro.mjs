// Title screen (src/game/intro.ts): the pre-roll (logo fade-in, hold, fade-out, title fade-in, then the module start) and the credit
// roll (notes/formats/text.md, "Credit roll"; notes/formats/graphics-and-music-blocks.md, "Boot-stage sequence").
// Traced rules, one update per VBL: a fade is 15 steps of 3 VBLs (`$78D54`, `$78CEC`), but a fade whose first wait is already
// pending takes 44 (the logo and title fade-ins: each follows a picture decode, `$785A6` and `$785F2`); the logo hold checks buttons
// 51 times, in updates 45-95 (`$785C8`, `$78BB8` with d7 = $32), and a button ends it early (its result is ignored); the fades read
// no button; the title decodes in the update that ends the logo fade-out; track 3 starts in the update that ends the title fade-in
// (no VBL wait traced); the roll's first character is drawn in the roll's first update, because its first wait is pending (track 3
// is decoded before it, `$78634`); the later characters take two VBLs each (`$78A48`, with d7 = 1). The expected numbers below come
// from these rules, not from the code under test. Pixels are compared with an independent planar decode.
// Uses the user's Disk.1 (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("intro tests skipped: original data not found");
  process.exit(0);
}

const { IntroScene } = await import("../dist/game/intro.js");
const { unpackLz } = await import("../dist/data/unpack.js");
const { getString } = await import("../dist/data/text.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const none = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const left = { ...none, leftButton: true };
const right = { ...none, rightButton: true };

// ---- independent decode of the two pictures (planar, big-endian palette words after the planes) -----------------------------------
const SECTOR = 512;
const PLANE = 40 * 200; // bytes per bitplane of a 320 x 200 picture
function planar(first, last) {
  const data = unpackLz(disk1.subarray(first * SECTOR, (last + 1) * SECTOR));
  const pixels = new Uint8Array(320 * 200);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      let index = 0;
      for (let p = 0; p < 5; p++) index |= ((data[p * PLANE + y * 40 + (x >> 3)] >> (7 - (x & 7))) & 1) << p;
      pixels[y * 320 + x] = index;
    }
  }
  // OCS word 0x0RGB with 4 bits per channel: each level is 17 in 8 bits.
  const palette = Array.from({ length: 32 }, (_, i) => {
    const w = (data[5 * PLANE + 2 * i] << 8) | data[5 * PLANE + 2 * i + 1];
    return [((w >> 8) & 15) * 17, ((w >> 4) & 15) * 17, (w & 15) * 17];
  });
  return { length: data.length, pixels, palette };
}
const logo = planar(0x729, 0x733);
const title = planar(0x70a, 0x728);
const PICTURE_SIZES_OK = logo.length === 40064 && title.length === 40064;

// Palette after k fade-in steps (each level moves 17 towards the target) and after k fade-out steps (towards black).
const rise = (palette, k) => palette.map((c) => c.map((v) => Math.min(v, 17 * k)));
const fall = (palette, k) => palette.map((c) => c.map((v) => Math.max(0, v - 17 * k)));
const samePixels = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const sameRgb = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What the traced schedule says the screen shows after update n (n = 0 is the scene's construction).
// Logo fade-in (pending first wait): steps at 2, 5, ..., 44. Hold: checks at 45-95. Logo fade-out: steps at 98, ..., 140 (the
// first at 95 + 3). Title fade-in (pending): steps at 142, ..., 184 (the title decodes in update 140, so 140 + 3k - 1).
function expectedPalette(n) {
  if (n <= 44) return rise(logo.palette, Math.floor((n + 1) / 3));
  if (n <= 97) return logo.palette; // hold (checks at 45-95), then the first fade-out step is at 98
  if (n <= 140) return fall(logo.palette, Math.floor((n - 95) / 3));
  if (n <= 184) return rise(title.palette, Math.floor((n - 139) / 3));
  return title.palette;
}
const expectedPixels = (n) => (n < 140 ? logo.pixels : title.pixels); // the title decodes in update 140
function expectedStage(n) {
  if (n <= 43) return "logo-in";
  if (n <= 94) return "logo-hold";
  if (n <= 139) return "logo-out";
  if (n <= 183) return "title-in";
  return "roll";
}

// A scene with its own update counter. `press(n)` is the input of update n; module starts are logged with their update number.
// `keepPixelsAt` lists the updates whose picture is copied (after the update).
function harness(press = () => none, keepPixelsAt = []) {
  const h = {
    n: 0,
    started: [],
    stages: [],
    results: [],
    shown: [],
    digests: [], // palette after each update, for comparing two runs
    pixels: {},
    scene: null,
    step() {
      h.n++;
      h.results.push(h.scene.update(press(h.n)));
      h.stages.push(h.scene.stage);
      h.shown.push(h.scene.charactersShown);
      h.digests.push(h.scene.screen.palette.flat().join(","));
      if (keepPixelsAt.includes(h.n)) h.pixels[h.n] = Buffer.from(h.scene.screen.pixels);
      return h;
    },
  };
  h.scene = new IntroScene(disk1, { startModule: () => h.started.push(h.n) });
  return h;
}

// ---- 0. the pictures the pre-roll shows ----------------------------------------------------------------------------------------
{
  const scene = new IntroScene(disk1);
  check("the logo and title pictures are full screens with 40,064 bytes each (planes + 32 palette words)", PICTURE_SIZES_OK);
  check("at construction the logo is on the screen and the palette is black (the fade-in has not started)", samePixels(scene.screen.pixels, logo.pixels) && scene.screen.palette.every((c) => c.every((v) => v === 0)));
  check("at construction the stage is the logo fade-in and no character is drawn", scene.stage === "logo-in" && scene.charactersShown === 0);
}

// ---- 1. the whole pre-roll with no input: stage and palette after every update, pictures at fixed updates, the module start -----
{
  const h = harness(undefined, [44, 95, 139, 140, 184]);
  for (let n = 1; n <= 260; n++) h.step();
  let stageOk = true;
  let paletteOk = true;
  for (let n = 1; n <= 260; n++) {
    if (h.stages[n - 1] !== expectedStage(n)) stageOk = false;
    if (h.digests[n - 1] !== expectedPalette(n).flat().join(",")) paletteOk = false;
  }
  check("the stage follows the traced schedule after every update (logo-in 1-43, hold 44-94, logo-out 95-139, title-in 140-183, roll 184+)", stageOk);
  check("the palette follows the traced fades after every update (rise by 17 per 3 VBLs from black, the logo's first step at update 2, fall back to black, rise to the title)", paletteOk);
  check("the logo stays on the screen through its hold and fade-out (update 139)", samePixels(h.pixels[139], logo.pixels));
  check("the title decodes in the update that ends the logo fade-out (update 140)", samePixels(h.pixels[140], title.pixels));
  check("the title stays on the screen through its fade-in (update 184)", samePixels(h.pixels[184], title.pixels));
  check("the logo is still the picture at the end of its fade-in and at the end of its hold (updates 44 and 95)", samePixels(h.pixels[44], logo.pixels) && samePixels(h.pixels[95], logo.pixels));
  check("the module starts exactly once, in the update that ends the title fade-in (update 184)", JSON.stringify(h.started) === "[184]", JSON.stringify(h.started));
  check("no character is drawn before the roll's first character, which is drawn in the roll's first update (update 185, one VBL after the start)", h.shown.slice(0, 184).every((c) => c === 0) && h.shown[184] === 1, `${h.shown[183]} ${h.shown[184]}`);
  check("no update before the roll's first character reads a click (every result is running)", h.results.every((r) => r === "running"));
}

// ---- 2. interruption: buttons do nothing during the fades, and after the module has started ------------------------------------------
{
  // Presses in every update that reads no button (the logo fade-in, the logo fade-out, the title fade-in), left and right alternately.
  // The hold reads buttons in updates 45-95; the module start (184) reads none; the roll's first update (185) does.
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const quiet = new Set([...range(1, 44), ...range(96, 184)]);
  const idle = harness();
  const pressed = harness((n) => (quiet.has(n) ? (n % 2 ? left : right) : none));
  for (let n = 1; n <= 190; n++) {
    idle.step();
    pressed.step();
  }
  check("button presses in the fades and the title fade-in change no stage, palette or start update", JSON.stringify(pressed.stages) === JSON.stringify(idle.stages) && JSON.stringify(pressed.digests) === JSON.stringify(idle.digests) && JSON.stringify(pressed.started) === "[184]");
  check("no press in the fades reads as a click", pressed.results.every((r) => r === "running"));
}

// A press in the logo hold ends the hold at once; the logo fade-out and the title fade-in follow with their usual lengths.
{
  const h = harness((n) => (n === 50 ? left : none), [94, 95]);
  for (let n = 1; n <= 190; n++) h.step();
  check("a left press at update 50 ends the logo hold: the fade-out starts that update", h.stages[49] === "logo-out" && h.stages[48] === "logo-hold");
  check("after the press the palette is still the logo's until the first fade-out step (update 53)", h.digests[51] === logo.palette.flat().join(",") && h.digests[52] === fall(logo.palette, 1).flat().join(","));
  check("the logo is still on the screen before the title decodes (update 94), and the title decodes at update 95", samePixels(h.pixels[94], logo.pixels) && samePixels(h.pixels[95], title.pixels));
  check("the title fade-in starts at update 95 (stage title-in), 45 updates after the press", h.stages[94] === "title-in" && h.stages[93] === "logo-out");
  check("the module starts 89 updates after the press (update 139: the title fade-in is pending, 44 updates), and the roll's first character is drawn at 140", JSON.stringify(h.started) === "[139]" && h.shown[138] === 0 && h.shown[139] === 1, `${JSON.stringify(h.started)} ${h.shown[138]} ${h.shown[139]}`);
}

{
  // The first hold check is update 45 (the logo fade-in's last step is at 44): a press there ends the hold at once.
  const h = harness((n) => (n === 45 ? right : none));
  for (let n = 1; n <= 150; n++) h.step();
  check("a right press at the first hold check ends the logo hold too (module at 134)", JSON.stringify(h.started) === "[134]" && h.stages[44] === "logo-out" && h.stages[43] === "logo-hold", JSON.stringify(h.started));
}

// A button held through the title fade-in: the roll's typing runs at one character per update from its first update.
{
  const h = harness((n) => (n >= 150 ? left : none));
  for (let n = 1; n <= 190; n++) h.step();
  check("a button held through the title fade-in does not start the module early (update 184)", JSON.stringify(h.started) === "[184]");
  check("a button still down at the roll's first update draws its first character then (update 185, the first update after the start)", h.shown[184] === 1 && h.shown[183] === 0, `${h.shown[183]} ${h.shown[184]}`);
}

// A button held from the title fade-in to the end of the first line clicks at its hold (the roll's click rule).
{
  const first = (disk1[0x4644] << 8) | disk1[0x4645]; // the first credit string index (word list at $4644, Disk.1 offset)
  const length = getString(disk1, 0, first).length;
  const h = harness((n) => (n >= 150 ? left : none));
  let clickAt = -1;
  for (let n = 1; n <= 184 + length + 5 && clickAt < 0; n++) {
    h.step();
    if (h.results[n - 1] === "clicked") clickAt = n;
  }
  // Character k is drawn in update 184 + k (the first in the roll's first update, 185); the last one is update 184 + length.
  check("a held button types the first line at one character per update from the roll's first update (185)", h.shown[183 + length] === length && h.shown[182 + length] === length - 1, `length ${length}`);
  check("the held button clicks at the hold of the first line, one update after its last character (the roll's click rule)", clickAt === 184 + length + 1, `click at ${clickAt}, expected ${184 + length + 1}`);
}

// ---- 3. the credit roll itself (timing and buttons; the roll starts after the pre-roll) -------------------------------------------
function toRoll(scene) {
  let guard = 0;
  while (scene.stage !== "roll") {
    scene.update(none);
    if (++guard > 1000) throw new Error("the pre-roll never ended");
  }
}
// Runs idle updates until the current string is fully typed (the update that draws its last character starts the hold).
function typeOutIdle(scene) {
  let guard = 0;
  while (!scene.holding) {
    scene.update(none);
    if (++guard > 100000) throw new Error("typing never finished");
  }
}

// 4. Typing, counted from the roll's first update: the first character is drawn in that update (its first wait is pending), then
// one character every two updates (`$78A48`, d7 = 1 per character).
{
  const scene = new IntroScene(disk1);
  toRoll(scene);
  const drawnAt = [];
  let last = scene.charactersShown;
  for (let i = 1; i <= 12; i++) {
    scene.update(none);
    if (scene.charactersShown !== last) {
      drawnAt.push(i);
      last = scene.charactersShown;
    }
  }
  const expected = Array.from({ length: 6 }, (_, k) => 2 * k + 1);
  check("typing draws the first character in the roll's first update, then one every two frames (1, 3, 5, ...)", JSON.stringify(drawnAt) === JSON.stringify(expected), `updates ${drawnAt.join(",")}`);
}

// 5. Hold of 121 frames after the last character, then the next string starts with its first character after two frames.
{
  const scene = new IntroScene(disk1);
  toRoll(scene);
  typeOutIdle(scene);
  check("the hold after the last character is not a click", scene.holding && scene.charactersShown > 0);
  let held = 0;
  while (scene.charactersShown !== 0) {
    scene.update(none);
    held++;
    if (held > 1000) break;
  }
  check("the string is held for 121 frames before the band is cleared", held === 121, `held ${held}`);
  let waited = 0;
  while (scene.charactersShown === 0) {
    scene.update(none);
    waited++;
    if (waited > 1000) break;
  }
  check("the next string's first character follows after two frames", waited === 2 && !scene.holding, `waited ${waited}`);
}

// 6. Right button during typing: speeds the typing (one character per frame while held) and does not end the roll during typing.
{
  const scene = new IntroScene(disk1);
  toRoll(scene);
  scene.update(none); // one idle frame: the first character is drawn in this, the roll's first update (its wait is pending)
  const before = scene.charactersShown;
  check("the first character is drawn in the roll's first idle update (one character before the held presses)", before === 1, `shown ${before}`);
  const results = [scene.update(right), scene.update(right), scene.update(right)];
  check("a held right button draws one character per frame during typing", scene.charactersShown === before + 3, `shown ${scene.charactersShown} from ${before}`);
  check("a right button during typing does not end the roll", results.every((r) => r === "running"));
}

// 7. Left button during typing: same speed-up, same non-click.
{
  const scene = new IntroScene(disk1);
  toRoll(scene);
  const before = scene.charactersShown;
  const results = [scene.update(left), scene.update(left)];
  check("a held left button draws one character per frame during typing", scene.charactersShown === before + 2 && results.every((r) => r === "running"));
}

// 8. The hold ends with either button ("clicked", the language screen), and an idle hold keeps running.
for (const [name, press] of [["left", left], ["right", right]]) {
  const scene = new IntroScene(disk1);
  toRoll(scene);
  typeOutIdle(scene);
  const idle = scene.update(none);
  check(`the hold runs on without a button (${name} check)`, idle === "running" && scene.holding);
  check(`a ${name} button press during the hold ends the credit roll`, scene.update(press) === "clicked");
}

if (failed) {
  console.log(`${failed} intro check(s) failed`);
  process.exit(1);
}
console.log("all intro checks passed");
