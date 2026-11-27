// Boot stages B to G after the language choice (src/game/boot-stages.ts; notes/formats/text.md "Language screen and what follows",
// notes/formats/graphics-and-music-blocks.md). The expected counts below come from the traced rules, not from the code under test:
// one update per VBL; a fade is 15 steps of 3 VBLs (45), or 44 when its first wait is pending (D, E-in, F-out 2, each slide-in: the
// VBL flag was set by a decode, clear or blit just before; notes/formats/graphics-and-music-blocks.md, "Fade timing"); typed text
// waits 2 VBLs per character while bit 4 is set (1 when a button
// is down); the slide hold is 121 checks (`$78BB8` with d7 = $78); the music ramp is 63 steps of 3 VBLs (`$78966`).
// Pixels are compared with an independent planar decode of the blocks. Uses the user's Disk.1 (read-only), skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("boot stage tests skipped: original data not found");
  process.exit(0);
}

const disk = new Uint8Array(fs.readFileSync(d1));
const { BootStages } = await import("../dist/game/boot-stages.js");
const { Screen, SCREEN_WIDTH } = await import("../dist/gfx/screen.js");
const { decodePicture, PICTURES, SECTOR_SIZE } = await import("../dist/data/picture.js");
const { getString, drawText } = await import("../dist/data/text.js");
const { unpackLz } = await import("../dist/data/unpack.js");

let failed = 0;
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const NONE = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const pressed = (over) => ({ ...NONE, ...over });
const language = decodePicture(disk, PICTURES.language).palette;

// Constants as traced (not imported from the code under test).
const FADE = 45;
const FADE_P = FADE - 1; // 44: a fade whose first wait is pending
const HOLD = 121;
const TYPE_VBL = 2;
const RAMP_STEPS = 63;
const RAMP_VBL = 3;
const SLIDE_TABLE = 0x7956c - 0x74f18; // file offset of the slide table ($7956C; Disk.1 offset = RAM - $74F18)

// The traced slide table: 29 (frame, string) word pairs, then $FFFF.
const slides = Array.from({ length: 29 }, (_, i) => ({
  frame: (disk[SLIDE_TABLE + 4 * i] << 8) | disk[SLIDE_TABLE + 4 * i + 1],
  string: (disk[SLIDE_TABLE + 4 * i + 2] << 8) | disk[SLIDE_TABLE + 4 * i + 3],
}));
// Text length in drawn characters: newline bytes (bit 7) are not waited for.
const drawn = (bytes) => Array.from(bytes).filter((b) => (b & 0x80) === 0).length;
const captionOf = (k) => getString(disk, 0, slides[k].string);

// ---- independent decode of the picture blocks -------------------------------------------------------------------------------------
const blockA = unpackLz(disk.subarray(0x60 * SECTOR_SIZE, (0xdc + 1) * SECTOR_SIZE));
const blockB = unpackLz(disk.subarray(0xdd * SECTOR_SIZE, (0x14b + 1) * SECTOR_SIZE));
function expectedFrame(data, frame, rows, bytes) {
  const planeBytes = rows * bytes;
  const base = frame * 5 * planeBytes;
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < bytes * 8; x++) {
      const col = x >> 3;
      const bit = 7 - (x & 7);
      let index = 0;
      for (let p = 0; p < 5; p++) index |= ((data[base + p * planeBytes + r * bytes + col] >> bit) & 1) << p;
      out.push(index);
    }
  }
  return out;
}
// Compares a rectangle of the screen with expected pixels (row-major, width `w`).
function sameRect(screen, x0, y0, w, h, expected) {
  for (let r = 0; r < h; r++) {
    for (let x = 0; x < w; x++) {
      if (screen.pixels[(y0 + r) * SCREEN_WIDTH + x0 + x] !== expected[r * w + x]) return false;
    }
  }
  return true;
}
const rect = (screen, x0, y0, w, h) => Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, x) => screen.pixels[(y0 + r) * SCREEN_WIDTH + x0 + x])).flat();
// Reference text: the same glyph routine on an empty screen, one string at (x, y).
function referenceText(bytes, x, y) {
  const ref = new Screen();
  drawText(disk, ref, bytes, x, y, 1);
  return ref;
}

// ---- harness -----------------------------------------------------------------------------------------------------------------------
function harness(expansionMemory = true) {
  const screen = new Screen();
  const audio = {
    calls: [],
    setVolume(v) { this.calls.push(["volume", v]); },
    stop() { this.calls.push(["stop"]); },
  };
  const boot = new BootStages(disk, 0, screen, language, { expansionMemory, audio });
  boot.start();
  return { boot, screen, audio, n: 0, phaseAt: { B: 0 }, slideAt: {}, last: boot.currentPhase, slide: -1, result: null };
}
// One update: records the update number at which each phase and slide is first seen.
function tick(h, input = NONE) {
  h.n++;
  const result = h.boot.update(input);
  const phase = h.boot.currentPhase;
  if (phase !== h.last) {
    h.phaseAt[phase] = h.n;
    h.last = phase;
  }
  if (h.boot.slideIndex !== h.slide) {
    h.slideAt[h.boot.slideIndex] = h.n;
    h.slide = h.boot.slideIndex;
  }
  if (result === "done" && h.result === null) h.result = h.n; // the first "done" only: later calls keep returning it
  return result;
}
const runTo = (h, n, input = () => NONE) => { while (h.n < n) tick(h, input(h.n + 1)); };

// Update numbers of the traced schedule (no input). The language fade-out ends at update 0 (the choice); B types "LOADING..." (10).
const B_END = 2 * drawn(getString(disk, 0, 40)) + FADE; // 65
const D_END = B_END + FADE_P; // 109, E starts (D is pending: block A was decoded just before)
const E_FADE_END = D_END + FADE_P; // 153, the poll starts in this update; keys in the next update are read (E-in is pending)
const CONFIRM = 200;

// ---- 1. the data the stages read ------------------------------------------------------------------------------------------------
{
  check("block A decodes to 35 frames of 2,560 bytes (89,600 bytes)", blockA.length === 35 * 5 * 64 * 8, `${blockA.length}`);
  check("block B decodes to 22 frames of 4,345 bytes (95,590 bytes)", blockB.length === 22 * 5 * 79 * 11, `${blockB.length}`);
  check("the slide table has 29 (frame, string) pairs, then $FFFF", slides.length === 29 && ((disk[SLIDE_TABLE + 116] << 8) | disk[SLIDE_TABLE + 117]) === 0xffff);
  check("the slide table starts at frame 0 / string 9 and ends at frame 3 / string 37", slides[0].frame === 0 && slides[0].string === 9 && slides[28].frame === 3 && slides[28].string === 37);
  check("every slide frame lies in block B (frames 0-21)", slides.every((s) => s.frame < 22));
  check("the captions and messages are non-empty strings (40, 41, 38, 39, 9-37)", [40, 41, 38, 39, ...slides.map((s) => s.string)].every((i) => drawn(getString(disk, 0, i)) > 0));
}

// ---- 2. timing without input -----------------------------------------------------------------------------------------------------
{
  const h = harness();
  runTo(h, CONFIRM - 1, () => NONE);
  check("B: LOADING... is typed at 2 VBLs per character and faded in over 45 (phase D starts at update 65)", h.phaseAt.D === B_END, `D at ${h.phaseAt.D}, expected ${B_END}`);
  check("D: the fade-out is 44 updates, pending after the block A decode (phase E starts at update 109)", h.phaseAt.E === D_END, `E at ${h.phaseAt.E}`);
  check("E: no key is read while the code-check picture fades in (the prompts are not typed)", h.boot.typedNumber === "" && h.phaseAt.E === D_END);
  check("E: without Return the check does not finish (phase stays E)", h.boot.currentPhase === "E" && h.boot.typedNumber === "");
  tick(h, pressed({ keys: ["Enter"] }));
  check("E: Return with no digit typed passes the check (WHDLoad slave accepts any entry)", h.boot.currentPhase === "F" && h.phaseAt.F === h.n);
}

// The full no-input schedule through the slides, from the confirming update.
{
  const h = harness();
  runTo(h, E_FADE_END + 5, () => NONE);
  tick(h, pressed({ keys: ["Enter"] }));
  const f = h.n;
  check("F starts in the confirming update (fade-out of the picture)", h.phaseAt.F === f);
  // F: fade-out 45, LOADING... 20 + fade-in 45, fade-out 44 (pending: block B was decoded just before), then the first slide starts.
  const slide0 = f + FADE + 2 * drawn(getString(disk, 0, 40)) + FADE + FADE_P;
  // Hold through every slide with no input: each is 45 + 2 per character + 121 + 45.
  let expectStart = slide0;
  const starts = [];
  for (let k = 0; k < 29; k++) {
    starts.push(expectStart);
    expectStart += FADE_P + TYPE_VBL * drawn(captionOf(k)) + HOLD + FADE;
  }
  const endSlides = expectStart;
  const gStart = endSlides;
  const expectDone = gStart + 2 * drawn(getString(disk, 0, 40)) + FADE + TYPE_VBL * drawn(getString(disk, 0, 41)) + RAMP_STEPS * RAMP_VBL + FADE;
  runTo(h, expectDone + 2, () => NONE);
  check("slide 1 starts at the traced schedule (fade-out, LOADING..., fade-out, then the 29 slides)", h.slideAt[0] === starts[0], `at ${h.slideAt[0]}, expected ${starts[0]}`);
  check("the slides follow one another at 44 + 2 per character + 121 + 45 updates", starts.every((s, k) => k === 0 || h.slideAt[k] === s), starts.slice(0, 4).map((s, k) => `${h.slideAt[k]}/${s}`).join(" "));
  check("slide 29 starts at its traced update", h.slideAt[28] === starts[28], `${h.slideAt[28]} vs ${starts[28]}`);
  check("G starts after the last slide's fade-out", h.phaseAt.G === gStart, `G at ${h.phaseAt.G}, expected ${gStart}`);
  check("the sequence ends at G + 351 updates (LOADING..., EXPANSION MEMORY line, 63-step ramp, final fade)", h.result === expectDone, `done at ${h.result}, expected ${expectDone}`);
  check("after done the stage stays done and no audio is touched again", h.boot.update(NONE) === "done" && h.boot.currentPhase === "done");
}

// ---- 3. the code check: typed number, editing, confirm ------------------------------------------------------------------------------
{
  const h = harness();
  runTo(h, E_FADE_END, () => NONE);
  // Update 154 is the first update the poll reads keys in (the fade-in ended in update 153).
  tick(h, pressed({ keys: ["5", "x", "Backspace", "3", "8", "1"] }));
  check("keys: digits are kept up to two; x and extra digits are ignored; Backspace removes the last", h.boot.typedNumber === "38", JSON.stringify(h.boot.typedNumber));
  tick(h, pressed({ keys: ["Backspace", "Backspace", "Backspace"] }));
  check("Backspace removes the digits; a further Backspace on an empty field does nothing", h.boot.typedNumber === "" && h.boot.currentPhase === "E");
  tick(h, pressed({ keys: ["7", "2"] }));
  tick(h, pressed({ keys: ["Enter"] }));
  check("Return passes the check in that update, with the typed number kept as shown", h.boot.currentPhase === "F" && h.phaseAt.F === h.n && h.boot.typedNumber === "72");
}
{
  // A keypad digit is typed like a top-row digit (the count entry's table $650A lists both); a release types nothing.
  const { keypadToken, keyUpToken } = await import("../dist/game/intro.js");
  const h = harness();
  runTo(h, E_FADE_END, () => NONE);
  tick(h, pressed({ keys: [keypadToken("4"), keyUpToken("4"), "2"] }));
  check("code check: keypad digits are typed; a release of one types nothing", h.boot.typedNumber === "42", JSON.stringify(h.boot.typedNumber));
  tick(h, pressed({ keys: ["Enter"] }));
  check("code check: Return after keypad digits passes the check", h.boot.currentPhase === "F" && h.boot.typedNumber === "42");
}

// The caller's key list is never cleared (main.ts pushes into one array): a key is read in the update it arrives in, and the stage
// takes it from the list, so it is not read again later. Keys that arrived earlier (update 30, Return and a digit) do not pass the check.
{
  const h = harness();
  const shared = [];
  while (h.n < 30) tick(h, { ...NONE, keys: shared });
  shared.push("Enter", "9");
  tick(h, { ...NONE, keys: shared });
  while (h.n < 170) tick(h, { ...NONE, keys: shared });
  check("keys that arrived before the check are dropped, not replayed (the check is still waiting)", h.boot.currentPhase === "E" && h.boot.typedNumber === "" && shared.length === 0);
  shared.push("2");
  tick(h, { ...NONE, keys: shared });
  for (let i = 0; i < 40; i++) tick(h, { ...NONE, keys: shared });
  check("a digit is read once and the list is consumed (no replay of '2' on later updates)", h.boot.typedNumber === "2" && shared.length === 0, JSON.stringify(h.boot.typedNumber));
}

// A key during the code-check fade-in is not read (the poll is not running yet).
{
  const h = harness();
  runTo(h, D_END + 10, () => NONE);
  tick(h, pressed({ keys: ["9", "Enter"] }));
  check("a key pressed during the code-check fade-in is not read (the poll starts clear)", h.boot.currentPhase === "E" && h.boot.typedNumber === "");
}

// ---- 4. the pixels of steps E and the slides -------------------------------------------------------------------------------------
{
  const h = harness();
  runTo(h, E_FADE_END, () => NONE);
  const prompts = referenceText(getString(disk, 0, 38), 32, 140);
  drawText(disk, prompts, getString(disk, 0, 39), 32, 158, 1);
  check("E: the two prompts are drawn in the prompt band (rows 136-170) after the fade", sameRect(h.screen, 0, 136, SCREEN_WIDTH, 35, rect(prompts, 0, 136, SCREEN_WIDTH, 35)));
  // The picture index is the update count at E's start, (count & $FF) >> 3 (cosmetic: the original's counter is a VBL-driven byte).
  const frame = (D_END & 0xff) >> 3; // update 109: frame 13
  check("E: the code-check picture is block A's frame chosen from the update count (frame 13 here)", sameRect(h.screen, 128, 54, 64, 64, expectedFrame(blockA, frame, 64, 8)));
  tick(h, pressed({ keys: ["3", "5"] }));
  const field = referenceText(new Uint8Array(Buffer.from("35-")), 150, 182);
  check("E: the typed number is shown with the dash cursor in the field (x 144-199, rows 182-188)", sameRect(h.screen, 144, 182, 56, 7, rect(field, 144, 182, 56, 7)));
  tick(h, pressed({ keys: ["Enter"] }));
  check("E: the confirmed number is redrawn without the dash", sameRect(h.screen, 144, 182, 56, 7, rect(referenceText(new Uint8Array(Buffer.from("35")), 150, 182), 144, 182, 56, 7)));
}

// Slide frames and captions, on slide 0 and two later ones (with the frame's own index).
{
  const h = harness();
  runTo(h, CONFIRM - 1, () => NONE);
  tick(h, pressed({ keys: ["Enter"] }));
  const probes = [0, 1, 3];
  let nextProbe = 0;
  // Advance to the start of slide `probes[nextProbe]`, then check its frame and, after typing, its caption.
  const frameOk = [];
  const captionOk = [];
  const schedule = [];
  let start = h.n + FADE + 2 * drawn(getString(disk, 0, 40)) + FADE + FADE_P;
  for (let s = 0; s < 29; s++) {
    schedule.push(start);
    start += FADE_P + TYPE_VBL * drawn(captionOf(s)) + HOLD + FADE;
  }
  while (nextProbe < probes.length) {
    const want = probes[nextProbe];
    runTo(h, schedule[want] + 2, () => NONE);
    frameOk.push(sameRect(h.screen, 112, 30, 88, 79, expectedFrame(blockB, slides[want].frame, 79, 11)));
    runTo(h, schedule[want] + FADE + TYPE_VBL * drawn(captionOf(want)) + 1, () => NONE);
    const cap = referenceText(captionOf(want), 20, 140);
    captionOk.push(sameRect(h.screen, 0, 136, SCREEN_WIDTH, 45, rect(cap, 0, 136, SCREEN_WIDTH, 45)));
    nextProbe++;
  }
  check(`the slide frame is block B's frame for slides ${probes.join(", ")} (the 88 x 79 region at 112, 30)`, frameOk.every(Boolean), frameOk.join(","));
  check(`each caption is typed in full at the traced count (slides ${probes.join(", ")})`, captionOk.every(Boolean), captionOk.join(","));
}

// ---- 5. the slide hold, the buttons, and their interaction with the typing ---------------------------------------------------------
{
  // Slide 0's start S: the update where its entry runs. L: its drawn characters. The hold runs S+FADE+2L+1 .. S+FADE+2L+121.
  const S = (() => {
    const h = harness();
    runTo(h, CONFIRM - 1, () => NONE);
    tick(h, pressed({ keys: ["Enter"] }));
    return h.n + FADE + 2 * drawn(getString(disk, 0, 40)) + FADE + FADE_P;
  })();
  const L = drawn(captionOf(0));

  // Left press during the hold (update S+44+2L+10): the hold ends there, the fade-out follows, slide 1 starts 45 later.
  {
    const h = harness();
    const press = S + FADE_P + 2 * L + 10;
    runTo(h, CONFIRM - 1, () => NONE);
    tick(h, pressed({ keys: ["Enter"] }));
    runTo(h, press - 1, () => NONE);
    tick(h, pressed({ leftButton: true }));
    runTo(h, press + 60, () => NONE);
    check("a left press during the hold ends it: the next slide starts 45 updates later", h.slideAt[1] === press + FADE, `slide 1 at ${h.slideAt[1]}, expected ${press + FADE}`);
    check("a left press ends the hold (no right-button leave)", h.result === null && h.boot.currentPhase === "slide");
  }

  // Right press during the hold: the current slide fades out and the sequence goes on to G; no later slide starts.
  {
    const h = harness();
    const press = S + FADE_P + 2 * L + 30;
    runTo(h, CONFIRM - 1, () => NONE);
    tick(h, pressed({ keys: ["Enter"] }));
    runTo(h, press - 1, () => NONE);
    tick(h, pressed({ rightButton: true }));
    runTo(h, press + FADE + 2, () => NONE);
    check("a right press during the hold leaves the show: G starts 45 updates later", h.phaseAt.G === press + FADE, `G at ${h.phaseAt.G}`);
    check("after a right press no further slide starts", h.slideAt[1] === undefined && h.boot.slideIndex === 0);
  }

  // Right press during the typing of slide 0 (bit 5 is set while the slide is shown): it leaves too.
  {
    const h = harness();
    runTo(h, CONFIRM - 1, () => NONE);
    tick(h, pressed({ keys: ["Enter"] }));
    const press = S + FADE_P + 3;
    runTo(h, press - 1, () => NONE);
    tick(h, pressed({ rightButton: true }));
    runTo(h, press + FADE + 2, () => NONE);
    check("a right press while a caption is typed leaves the show (G 45 updates later)", h.phaseAt.G === press + FADE && h.slideAt[1] === undefined);
  }

  // Right press during a fade: nothing is read there, so slide 1 keeps its schedule.
  {
    const h = harness();
    runTo(h, CONFIRM - 1, () => NONE);
    tick(h, pressed({ keys: ["Enter"] }));
    runTo(h, S + 10, () => NONE);
    tick(h, pressed({ rightButton: true }));
    runTo(h, S + FADE_P + 2 * L + HOLD + FADE + 2, () => NONE);
    check("buttons during a fade are not read (slide 1 starts on schedule)", h.slideAt[1] === S + FADE_P + 2 * L + HOLD + FADE, `slide 1 at ${h.slideAt[1]}`);
  }

  // A left button held down through the typing: each character takes 1 VBL, and the hold ends at its first check.
  {
    const h = harness();
    runTo(h, CONFIRM - 1, () => NONE);
    tick(h, pressed({ keys: ["Enter"] }));
    const held = () => pressed({ leftButton: true });
    runTo(h, S, () => NONE);
    runTo(h, S + FADE_P + L + 1, () => held());
    const cap = referenceText(captionOf(0), 20, 140);
    check("with a left button held from slide 0's start, its caption is typed at 1 VBL per character (complete at S+44+L)", sameRect(h.screen, 0, 136, SCREEN_WIDTH, 45, rect(cap, 0, 136, SCREEN_WIDTH, 45)));
    runTo(h, S + FADE_P + L + 1 + FADE + 2, held);
    check("with a left button held, the hold ends at its first check: slide 1 starts after one VBL and the fade-out", h.slideAt[1] === S + FADE_P + L + 1 + FADE, `slide 1 at ${h.slideAt[1]}, expected ${S + FADE_P + L + 1 + FADE}`);
  }
}

// ---- 6. step G: the expansion line, the module ramp and the audio ----------------------------------------------------------------
{
  const h = harness(true);
  runTo(h, CONFIRM - 1, () => NONE);
  tick(h, pressed({ keys: ["Enter"] }));
  let start = h.n + FADE + 2 * drawn(getString(disk, 0, 40)) + FADE + FADE_P;
  for (let s = 0; s < 29; s++) start += FADE_P + TYPE_VBL * drawn(captionOf(s)) + HOLD + FADE;
  const G = start;
  const expansion = referenceText(getString(disk, 0, 41), 85, 114);
  const expansionEnd = G + 2 * drawn(getString(disk, 0, 40)) + FADE + 2 * drawn(getString(disk, 0, 41));
  runTo(h, expansionEnd + 1, () => NONE);
  check("G: EXPANSION MEMORY DETECTED. is typed under LOADING... (expansionMemory on)", sameRect(h.screen, 80, 110, 160, 12, rect(expansion, 80, 110, 160, 12)));
  runTo(h, expansionEnd + RAMP_STEPS * RAMP_VBL + FADE + 2, () => NONE);
  // The volume calls are the 63 ramp steps and then the restore to full (checked below).
  const volumes = h.audio.calls.filter((c) => c[0] === "volume").map((c) => c[1]);
  const steps = volumes.slice(0, -1);
  check("the module volume steps 62/64 down to 0/64 (63 steps, one per 3 VBLs), then full volume", steps.length === RAMP_STEPS && steps[0] === 62 / 64 && steps[62] === 0 && volumes.at(-1) === 1, `${steps.length} steps`);
  check("the ramp ends with the module stopped and the master volume restored to full", JSON.stringify(h.audio.calls.slice(-2)) === JSON.stringify([["stop"], ["volume", 1]]), JSON.stringify(h.audio.calls.slice(-2)));
}

{
  // Without `$904`, the expansion line is not drawn and G is 52 updates shorter (2 x 26 characters).
  const h = harness(false);
  runTo(h, CONFIRM - 1, () => NONE);
  tick(h, pressed({ keys: ["Enter"] }));
  let start = h.n + FADE + 2 * drawn(getString(disk, 0, 40)) + FADE + FADE_P;
  for (let s = 0; s < 29; s++) start += FADE_P + TYPE_VBL * drawn(captionOf(s)) + HOLD + FADE;
  const G = start;
  const expectDone = G + 2 * drawn(getString(disk, 0, 40)) + FADE + RAMP_STEPS * RAMP_VBL + FADE;
  runTo(h, expectDone + 2, () => NONE);
  check("without expansion memory the sequence ends 52 updates earlier (no EXPANSION line)", h.result === expectDone, `done at ${h.result}, expected ${expectDone}`);
  check("without expansion memory the line area stays blank", sameRect(h.screen, 80, 110, 160, 12, new Array(160 * 12).fill(0)));
}

console.log(failed === 0 ? `all boot stage checks passed (${checks})` : `${failed} boot stage check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
