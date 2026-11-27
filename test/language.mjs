// Language screen (notes/formats/text.md, "Language screen"). Traced boot stage: the title fades out and the language picture fades in
// (`$78CEC` and `$78D54`: 15 steps of 3 VBLs each; the fade-in is 44 updates because the language decode `$786D0` leaves its first
// wait pending), then the left button is polled with `btst #6,$BFE001` / `bne`
// at $786F4. That poll is level-triggered: a button already down when the fade-in ends chooses at once, the language comes from the
// pointer row at that moment, nothing is polled during the fades, and the right button is not polled. After the choice the picture
// fades out again (`$78758` -> `$78CEC`: 15 steps of 3 VBLs, 45 updates) with no button read and the pointer off; the scene returns the
// choice once, when that fade ends. Uses the user's own Disk.1 (read-only); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("language tests skipped: original data not found");
  process.exit(0);
}

const { LanguageScene, languageAt } = await import("../dist/game/language.js");
const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { Screen } = await import("../dist/gfx/screen.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const FADE_IN_END = 89; // updates 1..45 fade out, 46..89 fade in (44 updates, pending first wait); the poll runs in the update that takes the last fade-in step
const POST_FADE = 45; // the choice is returned in the update that takes the last step of the fade-out that follows the poll
const RETURNED_AT = FADE_IN_END + POST_FADE; // 134 for a poll at 89

function input(left, y = 0x10, right = false) {
  return { leftButton: left, rightButton: right, pointerX: 0, pointerY: y, keys: [] };
}

// Runs updates 1..count with `script(i)` as the input; returns the update that first returned a language (0 if none) and the language.
function drive(scene, count, script) {
  for (let i = 1; i <= count; i++) {
    const result = scene.update(script(i));
    if (result.state === "chosen") return { at: i, language: result.language };
  }
  return { at: 0, language: -1 };
}

// 1. Bands: the pointer row picks English below $2C, French below $5B, German below $89, otherwise Italian.
{
  const cases = [
    [0, 0],
    [0x2b, 0],
    [0x2c, 1],
    [0x5a, 1],
    [0x5b, 2],
    [0x88, 2],
    [0x89, 3],
    [0xc7, 3],
  ];
  const bad = cases.filter(([y, lang]) => languageAt(y) !== lang);
  check("pointer rows pick the language bands ($2C, $5B, $89)", bad.length === 0, bad.map(([y]) => `y=${y}`).join(" "));
}

// 2. A left button held from the first update is already down at the first poll: the language is chosen at the poll (the update that
// ends the fade-in, from the pointer row of that update), and the scene returns it 45 updates later, when the fade-out ends.
{
  const scene = new LanguageScene(disk1, new Screen());
  const r = drive(scene, 200, () => input(true, 0x60));
  check("a left button held through both fades chooses at the poll and returns the choice when the 45-update fade-out ends", r.at === RETURNED_AT && r.language === 2, `returned at ${r.at} language ${r.language}`);
  check("the poll records the language before the fade-out (chosenLanguage)", scene.chosenLanguage === 2);
  check("the returned choice comes exactly 45 updates after the poll", r.at - FADE_IN_END === 45, `gap ${r.at - FADE_IN_END}`);
  check("after a held choice the boot sprite is off (no arrow from the scene)", scene.pointerVisible === false);
}

// 3. A press during the fade-in that is released before the poll does not choose; a later press does (edge-free poll, no hidden latch).
{
  const scene = new LanguageScene(disk1, new Screen());
  const r = drive(scene, 200, (i) => input((i >= 50 && i <= 60) || i === 100, 0x20));
  check("a press during the fade-in that is released before the poll does not choose; the next press does", r.at === 100 + POST_FADE && r.language === 0, `returned at ${r.at} language ${r.language}`);
}

// 4. A button held only through the fade-out is not polled then; released before the poll, it does not choose at the poll.
{
  const scene = new LanguageScene(disk1, new Screen());
  const r = drive(scene, 200, (i) => input(i <= 45 || i === 100, 0x80));
  check("a button held only during the title fade-out is not polled and does not choose at the poll", r.at === 100 + POST_FADE && r.language === 2, `returned at ${r.at} language ${r.language}`);
}

// 5. The right button is not polled: held through the poll it does not choose; the left button does.
{
  const scene = new LanguageScene(disk1, new Screen());
  const r = drive(scene, 200, (i) => (i < 100 ? input(false, 0xc0, true) : input(true, 0xc0)));
  check("the right button does not choose at the poll; the left button does", r.at === 100 + POST_FADE && r.language === 3, `returned at ${r.at} language ${r.language}`);
}

// 6. The language is read from the pointer row at the poll. The pointer moves during the fade-out, and the choice does not change.
{
  const scene = new LanguageScene(disk1, new Screen());
  const r = drive(scene, 200, (i) => input(true, i <= FADE_IN_END ? 0xc0 : 0x10));
  check("the chosen language comes from the pointer row at the poll, not from later pointer moves", r.at === RETURNED_AT && r.language === 3, `returned at ${r.at} language ${r.language}`);
}

// 7. Fade-in result: after the fades the screen shows the decoded language picture with its own palette, and nothing has been chosen.
{
  const scene = new LanguageScene(disk1, new Screen());
  const r = drive(scene, FADE_IN_END, () => input(false));
  const target = new Screen();
  decodePicture(disk1, PICTURES.language, target);
  const pixelsOk = scene.screen.pixels.every((v, i) => v === target.pixels[i]);
  const paletteOk = scene.screen.palette.every(([rr, gg, bb], i) => rr === target.palette[i][0] && gg === target.palette[i][1] && bb === target.palette[i][2]);
  check("after both fades the language picture and its palette are on screen, with no choice", r.at === 0 && pixelsOk && paletteOk && scene.chosenLanguage === null, `pixels ${pixelsOk} palette ${paletteOk}`);
}

// 7b. The language fade-in (`$78D54` after the decode `$786D0`): its first wait is pending, so black at update 45 (the title fade-out
// ends), the first step at update 47 (two updates after the fade starts, not three), one step every 3 updates, the last at 89.
{
  const scene = new LanguageScene(disk1, new Screen());
  const target = new Screen();
  decodePicture(disk1, PICTURES.language, target);
  const rise = (k) => target.palette.map(([r, g, b]) => [r, g, b].map((v) => Math.min(v, 17 * k)));
  let ok = true;
  const bad = [];
  for (let n = 1; n <= FADE_IN_END; n++) {
    scene.update(input(false));
    if (n >= 45) {
      const k = Math.max(0, Math.floor((n - 44) / 3));
      const shown = scene.screen.palette.map(([r, g, b]) => [r, g, b]);
      if (JSON.stringify(shown) !== JSON.stringify(rise(k))) {
        ok = false;
        bad.push(`update ${n}`);
      }
    }
  }
  check("the language fade-in is 44 updates: black at update 45, first step at 47, last at 89 (one step every 3 updates)", ok, bad.slice(0, 4).join(" "));
}

// 8. Pointer visibility: sprite DMA is off through both fades (text.md, "Language screen"; `$786E4` is the first SPREN set after the
// boot init). `Game.update` reads `pointerVisible` before each update and draws after it, so frame k shows the pointer when the value
// read before update k is true. Frames 1..89 (both fades, the poll update included) hide it; frame 90 is the first visible one.
{
  const scene = new LanguageScene(disk1, new Screen());
  const shownInFrame = [];
  for (let i = 1; i <= FADE_IN_END + 1; i++) {
    shownInFrame[i] = scene.pointerVisible;
    scene.update(input(false));
  }
  const hiddenThroughFades = shownInFrame.slice(1, FADE_IN_END + 1).every((v) => v === false);
  check("the pointer is hidden through both fades and the poll update", hiddenThroughFades);
  check("the first visible frame is the one after the update that ends the fade-in", shownInFrame[FADE_IN_END + 1] === true, `frame ${FADE_IN_END + 1} visible ${shownInFrame[FADE_IN_END + 1]}`);
}

// 9. Title fade-out: the pointer is hidden on every update of the 45-update fade-out (the title is still shown).
{
  const scene = new LanguageScene(disk1, new Screen());
  const early = [];
  for (let i = 1; i <= 45; i++) {
    early.push(scene.pointerVisible);
    scene.update(input(false));
  }
  check("the pointer is hidden during the title fade-out", early.every((v) => v === false));
}

// 10. The fade-out after the choice (`$78CEC`): nothing changes in the poll update, then one palette step every 3 updates, 15 steps,
// and the picture's palette reaches black in the update that returns the choice. The pixels stay. Each step moves every channel by one
// 4-bit level (17 in 8 bits), as the traced `$78CEC` does (only non-zero channels are decremented).
{
  const scene = new LanguageScene(disk1, new Screen());
  const picture = new Screen();
  decodePicture(disk1, PICTURES.language, picture);
  const paletteAfter = [];
  const pixelsAfterPoll = [];
  let returnedAt = 0;
  let returnedCount = 0;
  for (let i = 1; i <= RETURNED_AT + 5; i++) {
    const result = scene.update(input(i === FADE_IN_END)); // a press only in the poll update
    paletteAfter[i] = scene.screen.palette.map(([r, g, b]) => [r, g, b]);
    if (i === FADE_IN_END) pixelsAfterPoll[i] = scene.screen.pixels.slice();
    if (result.state === "chosen") {
      returnedCount++;
      if (returnedAt === 0) returnedAt = i;
    }
  }
  check("the choice is returned once, in the update that ends the fade-out", returnedAt === RETURNED_AT && returnedCount === 1, `returned at ${returnedAt}, returned ${returnedCount} times`);

  const expected = (k) => picture.palette.map(([r, g, b]) => [r, g, b].map((v) => Math.max(0, v - 17 * k)));
  const sameAs = (a, b) => a.every((rgb, i) => rgb.every((v, c) => v === b[i][c]));
  let stepsOk = true;
  const bad = [];
  for (let k = 0; k <= 15; k++) {
    const u = FADE_IN_END + 3 * k;
    if (!sameAs(paletteAfter[u], expected(k))) { stepsOk = false; bad.push(`step ${k} at ${u}`); }
    if (k < 15 && !sameAs(paletteAfter[u + 1], expected(k)) || k < 15 && !sameAs(paletteAfter[u + 2], expected(k))) {
      stepsOk = false;
      bad.push(`hold after step ${k}`);
    }
  }
  check("the fade-out steps one level every 3 updates (step k in the poll update + 3k, 15 steps, nothing in between)", stepsOk, bad.slice(0, 3).join(" "));
  check("the palette is black at the update that returns the choice", paletteAfter[RETURNED_AT].every(([r, g, b]) => r === 0 && g === 0 && b === 0));
  check("the picture is still on screen during the fade-out (only the palette moves)", pixelsAfterPoll[FADE_IN_END].every((v, i) => v === picture.pixels[i]));
  check("the poll update itself starts no step (the first step is one update after the choice)", sameAs(paletteAfter[FADE_IN_END], expected(0)));
}

// 11. Pointer state around the choice (press case: the first update after the poll update sees the button; text.md, "Pointer visibility").
// `pointerVisible` is read before each update: the poll update still shows the arrow, the fade-out does not, and the picture's arrow
// is off until the returned choice.
{
  const scene = new LanguageScene(disk1, new Screen());
  const shown = [];
  let returnedAt = 0;
  for (let i = 1; i <= RETURNED_AT + 2; i++) {
    shown[i] = scene.pointerVisible;
    const result = scene.update(input(i === FADE_IN_END + 1));
    if (result.state === "chosen" && returnedAt === 0) returnedAt = i;
  }
  check("a press at the update after the poll (update 90) leaves the arrow on for that update only", shown[FADE_IN_END + 1] === true, `shown ${shown[FADE_IN_END + 1]}`);
  check("the pointer is off from the next update through the fade-out and the returned choice", shown.slice(FADE_IN_END + 2, FADE_IN_END + POST_FADE + 2).every((v) => v === false));
  check("a press at update 90 returns the choice 45 updates later (update 135)", returnedAt === FADE_IN_END + 1 + POST_FADE, `returned at ${returnedAt}`);
}

// 12. No premature menu interaction, and one-time continuation: during the fade-out the button and pointer are ignored (left presses,
// pointer moves, right button), the language stays the one chosen at the poll, the choice is returned exactly once, and later
// updates (held or pressed buttons) return nothing more.
{
  const scene = new LanguageScene(disk1, new Screen());
  const returns = [];
  for (let i = 1; i <= 250; i++) {
    let s;
    if (i === FADE_IN_END) s = input(true, 0x20); // English, chosen at the poll
    else if (i > FADE_IN_END && i <= RETURNED_AT - 1) s = input(i % 3 === 0, i % 2 ? 0x10 : 0xc0, i % 4 === 0); // presses during the fade-out
    else s = input(i % 2 === 0, 0xc0, false); // after the return
    const result = scene.update(s);
    if (result.state === "chosen") returns.push({ at: i, language: result.language });
  }
  check("during the fade-out and after it, presses and pointer moves do not choose again or change the language", returns.length === 1 && returns[0].at === RETURNED_AT && returns[0].language === 0, JSON.stringify(returns));
  check("after the returned choice the scene stays quiet (no pointer, no further result)", scene.pointerVisible === false && scene.chosenLanguage === 0);
}

if (failed) {
  console.log(`${failed} language check(s) failed`);
  process.exit(1);
}
console.log("all language checks passed");
