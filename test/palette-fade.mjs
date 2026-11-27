// Palette fade arithmetic (src/gfx/fade.ts) against the traced boot routines: `$78D54` (fade in), `$78CEC` (fade out), `$789E6`
// (load) and the direct `clr.w $dff180` (`$789B6`). Expected values are computed here from the trace rules, per 4-bit channel,
// not from the code under test. Each fade step moves every channel one level; a fade-in skips entries equal to their target, a
// fade-out skips zero entries; the working copy and the COLOR registers take each written value. No original data is needed.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => import(pathToFileURL(path.join(root, "dist", p)).href);
const { PaletteFader, ocsPalette, Fade, COLOR_COUNT, FADE_STEPS, FADE_FRAMES_PER_STEP } = await dist("gfx/fade.js");
const { Screen, ocsColor } = await dist("gfx/screen.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// Deterministic words: 4-bit channels, with some zero entries and some channels that are already zero.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randomWord = () => (rnd() < 0.15 ? 0 : Math.floor(rnd() * 4096));
const randomPalette = () => Array.from({ length: COLOR_COUNT }, randomWord);

// Channels as [blue, green, red] (low nibble first), and back.
const channels = (w) => [w & 15, (w >> 4) & 15, (w >> 8) & 15];
const pack = ([b, g, r]) => (r << 8) | (g << 4) | b;

// Expected words after k fade-in steps from black: each channel rises one level per step, up to its target.
const expectIn = (target, k) => target.map((w) => pack(channels(w).map((c) => Math.min(c, k))));
// Expected words after k fade-out steps from `start`: each channel falls one level per step, down to zero.
const expectOut = (start, k) => start.map((w) => pack(channels(w).map((c) => Math.max(0, c - k))));
const displayOf = (words) => words.map((w) => ocsColor(w));
const sameWords = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);
const sameRgb = (screen, words) => words.every((w, i) => screen.palette[i].every((v, c) => v === ocsColor(w)[c]));

// The old 8-bit model that the Canvas code used before the register model (17 per level, all entries, every step).
const LEVEL = 17;
const oldStep = (value, target) => (value < target ? value + LEVEL : value > target ? value - LEVEL : value);

// ---- 1. Colour words --------------------------------------------------------------------------------------------------------
{
  const words = randomPalette();
  const back = ocsPalette(displayOf(words));
  check("ocsPalette inverts ocsColor for every 4-bit colour", sameWords(Array.from(back), words));
  let threw = false;
  try {
    ocsPalette(Array.from({ length: COLOR_COUNT }, () => [1, 0, 0]));
  } catch {
    threw = true;
  }
  check("ocsPalette refuses a colour that is not n * 17 (the display has only 4-bit levels)", threw);
}

// ---- 2. Fade in: exact nibble sequence, and the write set ----------------------------------------------------------------
{
  const target = randomPalette();
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  fader.target.set(target);
  fader.clearWorking();
  let wordsOk = true;
  let displayOk = true;
  const writes = [];
  const original = fader.writeRegister.bind(fader);
  fader.writeRegister = (index, word) => {
    writes.push(index);
    original(index, word);
  };
  let writesOk = true;
  let previous = expectIn(target, 0);
  for (let k = 1; k <= FADE_STEPS; k++) {
    writes.length = 0;
    fader.stepIn();
    const expected = expectIn(target, k);
    if (!sameWords(Array.from(fader.working), expected)) wordsOk = false;
    if (!sameRgb(screen, expected)) displayOk = false;
    const changed = expected.flatMap((w, i) => (w !== previous[i] ? [i] : []));
    if (JSON.stringify(writes) !== JSON.stringify(changed)) writesOk = false;
    previous = expected;
  }
  check("fade in: the working copy follows the per-channel rule for steps 1-15", wordsOk);
  check("fade in: the display is the register file (n * 17) after every step", displayOk);
  check("fade in: a register is written exactly when its word changes (entries equal to the target are skipped)", writesOk);
  check("fade in: after 15 steps the working copy equals the target", sameWords(Array.from(fader.working), target));
}

// ---- 3. Fade out: exact nibble sequence, zero entries skipped -------------------------------------------------------------
{
  const start = randomPalette();
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  fader.load(start);
  let wordsOk = true;
  let displayOk = true;
  let writesOk = true;
  const writes = [];
  const original = fader.writeRegister.bind(fader);
  fader.writeRegister = (index, word) => {
    writes.push(index);
    original(index, word);
  };
  for (let k = 1; k <= FADE_STEPS; k++) {
    writes.length = 0;
    fader.stepOut();
    const expected = expectOut(start, k);
    if (!sameWords(Array.from(fader.working), expected)) wordsOk = false;
    if (!sameRgb(screen, expected)) displayOk = false;
    const changed = expected.flatMap((w, i) => (w !== expectOut(start, k - 1)[i] ? [i] : []));
    if (JSON.stringify(writes) !== JSON.stringify(changed)) writesOk = false;
  }
  check("fade out: the working copy follows the per-channel rule for steps 1-15", wordsOk);
  check("fade out: the display is the register file after every step", displayOk);
  check("fade out: a register is written exactly when its word changes (zero entries are skipped)", writesOk);
  check("fade out: the palette is black after 15 steps", fader.working.every((w) => w === 0) && screen.palette.every((c) => c.every((v) => v === 0)));
}

// ---- 4. Channel packing (0x0RGB, blue in the low nibble) -----------------------------------------------------------------
{
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  fader.load([0x0f0a, 0x0100, 0x0011, 0x0000, ...new Array(COLOR_COUNT - 4).fill(0)]);
  fader.stepOut();
  check("packing: 0x0F0A falls to 0x0E09 (each channel loses one level, blue included)", fader.working[0] === 0x0e09, fader.working[0].toString(16));
  check("packing: 0x0100 falls to 0x0000 (the red nibble alone)", fader.working[1] === 0x0000, fader.working[1].toString(16));
  check("packing: 0x0011 falls to 0x0000 (blue and green each lose one level)", fader.working[2] === 0x0000, fader.working[2].toString(16));
  check("packing: the display shows n * 17 per channel (0x0E09 -> 238,0,153)", JSON.stringify(screen.palette[0]) === JSON.stringify([238, 0, 153]), JSON.stringify(screen.palette[0]));
}

// ---- 5. Load ($789E6) writes both copies; the direct COLOR00 write ($789B6) writes the register only ------------------------
{
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  const words = randomPalette();
  words[0] = 0x0f0a; // non-zero, so the fade-out step writes it
  fader.load(words);
  check("load ($789E6): the working copy and the registers take the same 32 words", sameWords(Array.from(fader.working), words) && sameRgb(screen, words));

  fader.writeRegister(0, 0); // clr.w $dff180
  check("clr.w $dff180 ($789B6): COLOR00 is black while the working copy keeps its word", screen.palette[0].every((v) => v === 0) && fader.working[0] === 0x0f0a);
  fader.stepOut();
  const after = expectOut(words, 1)[0];
  check("the next fade-out step writes COLOR00 from the working copy again (0x0F0A -> 0x0E09)", after === 0x0e09 && fader.working[0] === after && JSON.stringify(screen.palette[0]) === JSON.stringify(ocsColor(after)));
}

// ---- 6. Register retention: a skipped entry keeps its register (not reached in the traced boot path, see notes) ------------
{
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  fader.writeRegister(5, 0x123); // a stale colour in a register the fade will not write
  fader.target.fill(0);
  fader.target[7] = 0x00f;
  fader.clearWorking();
  for (let k = 0; k < FADE_STEPS; k++) fader.stepIn();
  check("retention: a fade-in never writes an entry whose target is zero, so the stale register stays", screen.palette[5][0] === ocsColor(0x123)[0] && screen.palette[5][2] === ocsColor(0x123)[2]);
  const expectedRegisters = Array.from({ length: COLOR_COUNT }, (_, i) => (i === 7 ? 0x00f : i === 5 ? 0x123 : 0));
  check("retention: the entry that does fade in reaches its target, the stale register is unchanged", sameRgb(screen, expectedRegisters));
}

// ---- 7. Fade-in invariant: an entry above its target is a logic error, not a silent overshoot ----------------------------------
{
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  fader.load(Array.from({ length: COLOR_COUNT }, () => 0x0f0));
  fader.target.fill(0);
  let threw = false;
  try {
    fader.stepIn();
  } catch {
    threw = true;
  }
  check("fade in refuses an entry above its target (the traced code only ever adds)", threw);
}

// ---- 8. Visible RGB equals the old 8-bit Canvas model, every step, both directions --------------------------------------
{
  let inOk = true;
  let outOk = true;
  for (let trial = 0; trial < 20; trial++) {
    const target = randomPalette();
    const screen = new Screen();
    const fader = new PaletteFader(screen);
    fader.target.set(target);
    fader.clearWorking();
    let old = target.map(() => [0, 0, 0]);
    const oldTarget = displayOf(target);
    for (let k = 0; k < FADE_STEPS; k++) {
      fader.stepIn();
      old = old.map((c, i) => c.map((v, ch) => oldStep(v, oldTarget[i][ch])));
      if (!screen.palette.every((c, i) => c.every((v, ch) => v === old[i][ch]))) inOk = false;
    }
    // fade out from the same colours
    fader.load(target);
    let oldOut = oldTarget.map((c) => c.slice());
    for (let k = 0; k < FADE_STEPS; k++) {
      fader.stepOut();
      oldOut = oldOut.map((c) => c.map((v) => oldStep(v, 0)));
      if (!screen.palette.every((c, i) => c.every((v, ch) => v === oldOut[i][ch]))) outOk = false;
    }
  }
  check("visible RGB, fade in: the register model equals the old 8-bit model after every step (20 random palettes)", inOk);
  check("visible RGB, fade out: the register model equals the old 8-bit model after every step (20 random palettes)", outOk);
}

// ---- 9. The tick-driven Fade: 3 frames a step, 45 frames, the clear at construction -----------------------------------------
{
  const target = randomPalette();
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  fader.load(target);
  const fade = new Fade(fader, "out");
  let firstStepFrame = -1;
  let doneFrame = -1;
  let stepsOk = true;
  for (let frame = 1; frame <= FADE_STEPS * FADE_FRAMES_PER_STEP; frame++) {
    const done = fade.tick();
    if (frame % FADE_FRAMES_PER_STEP === 0) {
      const k = frame / FADE_FRAMES_PER_STEP;
      if (!sameRgb(screen, expectOut(target, k))) stepsOk = false;
      if (firstStepFrame < 0) firstStepFrame = frame;
    } else if (!sameRgb(screen, expectOut(target, Math.floor(frame / FADE_FRAMES_PER_STEP)))) {
      stepsOk = false; // nothing changes between steps
    }
    if (done) doneFrame = frame;
  }
  check("tick fade out: one step on every third frame, nothing in between", stepsOk);
  check("tick fade out: the first step is on frame 3 and the fade is done on frame 45", firstStepFrame === 3 && doneFrame === 45, `first ${firstStepFrame} done ${doneFrame}`);

  const screen2 = new Screen();
  const fader2 = new PaletteFader(screen2);
  fader2.working.fill(0x0fff);
  new Fade(fader2, "in");
  check("tick fade in: the working copy is cleared when the fade starts (`clr.w (a0)+` at `$78D54`)", fader2.working.every((w) => w === 0));
}

// ---- 10. A pending first wait (a decode, clear or blit just before the fade left the VBL flag set): 44 frames, the first step on
// frame 2 and one step every 3 frames after it. The fade-in still clears the working copy at its start.
{
  const target = randomPalette();
  const screen = new Screen();
  const fader = new PaletteFader(screen);
  fader.load(target);
  const fade = new Fade(fader, "out", true);
  let stepsOk = true;
  let doneFrame = -1;
  for (let frame = 1; frame <= FADE_STEPS * FADE_FRAMES_PER_STEP; frame++) {
    const done = fade.tick();
    // After frame f the steps taken are floor((f + 1) / 3): step k lands on frame 3k - 1.
    const taken = Math.floor((frame + 1) / FADE_FRAMES_PER_STEP);
    if (!sameRgb(screen, expectOut(target, Math.min(taken, FADE_STEPS)))) stepsOk = false;
    if (done && doneFrame < 0) doneFrame = frame; // tick() keeps returning true after the last step: keep the first
  }
  check("pending fade out: step k lands on frame 3k - 1 (the first step after two frames), nothing in between", stepsOk);
  check("pending fade out: the fade is done on frame 44 (not 45)", doneFrame === 44 && fader.working.every((w) => w === 0), `done ${doneFrame}`);

  const screen2 = new Screen();
  const fader2 = new PaletteFader(screen2);
  fader2.target.set(randomPalette());
  fader2.working.fill(0x0fff);
  const fadeIn = new Fade(fader2, "in", true);
  check("pending fade in: the working copy is cleared when the fade starts", fader2.working.every((w) => w === 0));
  let inDone = -1;
  for (let frame = 1; frame <= FADE_STEPS * FADE_FRAMES_PER_STEP; frame++) {
    if (fadeIn.tick()) {
      inDone = frame;
      break;
    }
  }
  check("pending fade in: done on frame 44 and the working copy reaches the target", inDone === 44 && sameWords(Array.from(fader2.working), Array.from(fader2.target)), `done ${inDone}`);
}

console.log(failed === 0 ? "all palette fade checks passed" : `${failed} palette fade check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
