// Checks of the announcement dialog ($E770, src/game/announce.ts): drawn over the map with the traced frame windows
// $F0F8 and $F108 (no black panel), the command-button hit areas ($5E06), and the $58F8 leaving rule (a release after a press
// on a command button; a press elsewhere, Escape and the right button do not leave). Run after `npm run build`.
// Needs the user's own Disk.1 in original/utopia-whdload; skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(disk1Path)) {
  console.log("announce tests skipped: original/utopia-whdload/Disk.1 not found");
  process.exit(0);
}

const { AnnounceScene, readMessageContext } = await import("../dist/game/announce.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Screen, SCREEN_WIDTH } = await import("../dist/gfx/screen.js");
const { Ui } = await import("../dist/game/screens/ui.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const strings = new GameStrings(disk1, 0);
const ui = new Ui(disk1, strings);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A flat backdrop, so any pixel left at its colour is untouched by the dialog.
const BACKDROP = 7;
function backdrop() {
  const s = new Screen();
  s.pixels.fill(BACKDROP);
  return s;
}

function input(left, x, y, right = false) {
  return { leftButton: left, rightButton: right, pointerX: x, pointerY: y, keys: [] };
}
// Centre of a command button, from the rectangle table the dialog uses.
function centre(i) {
  const r = ui.rects[i];
  return { x: (r.x0 + r.x1) >> 1, y: (r.y0 + r.y1) >> 1 };
}
function pressAndRelease(scene, at, releaseAt) {
  const pressed = scene.update(input(true, at.x, at.y));
  const released = scene.update(input(false, releaseAt.x, releaseAt.y));
  return { pressed, released };
}

// 1. Frames over the map, no black panel.
{
  const scene = new AnnounceScene(disk1, strings, backdrop(), 1);
  const px = scene.screen.pixels;
  const at = (x, y) => px[y * SCREEN_WIDTH + x];
  check("outside both windows the backdrop is untouched (old black panel area)", at(20, 150) === BACKDROP && at(10, 150) === BACKDROP, `${at(20, 150)},${at(10, 150)}`);
  check("right of the portrait window the backdrop is untouched", at(200, 150) === BACKDROP);
  let changedPortrait = 0;
  for (let y = 106; y < 186; y++) for (let x = 96; x < 176; x++) if (px[y * SCREEN_WIDTH + x] !== BACKDROP) changedPortrait++;
  check("portrait window $F0F8 (96,106, 80x80) is drawn over the backdrop", changedPortrait > 80 * 80 * 0.5, `changed=${changedPortrait}`);
  let changedText = 0;
  for (let y = 8; y < 96; y++) for (let x = 0; x < 248; x++) if (px[y * SCREEN_WIDTH + x] !== BACKDROP) changedText++;
  check("text window $F108 (0,8, 248x88) is drawn over the backdrop", changedText > 248 * 88 * 0.5, `changed=${changedText}`);
  let overflow = 0;
  for (let y = 8; y < 96; y++) for (let x = 248; x < 272; x++) if (px[y * SCREEN_WIDTH + x] !== BACKDROP) overflow++;
  check("heading and message stay inside the text window (nothing right of x 247)", overflow === 0, `changed=${overflow}`);
  // Command buttons: the exit icon is index 9; the others are blank default images, all drawn over the column.
  const c9 = centre(9);
  check("exit icon (index 9) is drawn in its command rectangle", at(c9.x, c9.y) !== BACKDROP || at(c9.x + 1, c9.y + 1) !== BACKDROP);
}

// 2. Hit areas: the ten command rectangles, nothing else.
{
  for (let i = 0; i < 10; i++) {
    const c = centre(i);
    check(`command rectangle ${i} is a button`, ui.buttonAt(c.x, c.y) === i);
  }
  check("a point between the portrait window and the column is not a button", ui.buttonAt(200, 150) === -1);
}

// 3. $58F8 leaving rule.
{
  // A press on a command button, released elsewhere, leaves the dialog and plays the click once.
  let clicks = 0;
  const scene = new AnnounceScene(disk1, strings, backdrop(), 1, () => clicks++);
  const c9 = centre(9);
  const hold = scene.update(input(false, 150, 150));
  check("no press: the dialog stays open", hold === false);
  const press = scene.update(input(true, c9.x, c9.y));
  check("press on the exit button does not leave yet", press === false);
  check("press on a command button plays the click once", clicks === 1, `clicks=${clicks}`);
  const release = scene.update(input(false, 10, 10));
  check("release anywhere after a command-button press leaves", release === true);
}
{
  // A press elsewhere, and its release, leave nothing and play nothing.
  let clicks = 0;
  const scene = new AnnounceScene(disk1, strings, backdrop(), 2, () => clicks++);
  scene.update(input(false, 0, 0));
  const r = pressAndRelease(scene, { x: 150, y: 150 }, { x: 150, y: 150 });
  check("press and release outside the buttons: stays open", r.released === false && r.pressed === false);
  check("press outside the buttons plays no click", clicks === 0);
}
{
  // Escape and the right button are not leave keys of the original loop.
  const scene = new AnnounceScene(disk1, strings, backdrop(), 3);
  const right = scene.update(input(false, 150, 150, true));
  check("right button does not leave", right === false);
  const keys = scene.update({ leftButton: false, rightButton: false, pointerX: 150, pointerY: 150, keys: ["Escape"] });
  check("Escape does not leave", keys === false);
}
{
  // A button that is already held when the dialog opens is not a press (the click that opened it).
  const scene = new AnnounceScene(disk1, strings, backdrop(), 1);
  const c9 = centre(9);
  scene.update(input(true, c9.x, c9.y));
  const rel = scene.update(input(false, c9.x, c9.y));
  check("held at open: its release does not leave", rel === false);
}
{
  // A release after a press on button 0 (overview position) is a command button too.
  const scene = new AnnounceScene(disk1, strings, backdrop(), 0);
  scene.update(input(false, 0, 0));
  const c0 = centre(0);
  const r = pressAndRelease(scene, c0, c0);
  check("press and release on button 0 leaves", r.released === true);
}

// 4. The pressed look: the button flips while held and is restored by the release.
{
  const scene = new AnnounceScene(disk1, strings, backdrop(), 1);
  scene.update(input(false, 0, 0));
  const c9 = centre(9);
  const before = scene.screen.pixels[c9.y * SCREEN_WIDTH + c9.x];
  scene.update(input(true, c9.x, c9.y));
  const during = scene.screen.pixels[c9.y * SCREEN_WIDTH + c9.x];
  check("the pressed command button is drawn flipped", during === (before ^ 8), `before=${before} during=${during}`);
}

// 5. Every id opens (game over, QoL 80 and 90, and colony falls).
for (const id of [0, 1, 2, 3]) {
  const scene = new AnnounceScene(disk1, strings, backdrop(), id);
  check(`announce id ${id} draws a screen`, scene.screen.pixels.length === SCREEN_WIDTH * 200);
  let overflow = 0;
  for (let y = 8; y < 96; y++) for (let x = 248; x < 272; x++) if (scene.screen.pixels[y * SCREEN_WIDTH + x] !== BACKDROP) overflow++;
  check(`announce id ${id}: text stays inside the window`, overflow === 0, `changed=${overflow}`);
}

// 6. The message origin and wrap width come from the $15668 text context (disk values, STATIC: notes/formats/screens-misc.md):
// x 8, y 39, wrap width 240. The raw bytes are read here at the file offset of RAM $15668 (sector $14C at $1000), independent
// of GameImage, so the mapping is checked too.
{
  const SECTOR = 512;
  const fileOffset = 0x14c * SECTOR + (0x15668 - 0x1000);
  const raw = (o) => (disk1[fileOffset + o] << 8) | disk1[fileOffset + o + 1];
  const ctx = readMessageContext(disk1);
  check("$15668 record on disk: x word is 8", raw(0) === 8, `raw=${raw(0)}`);
  check("$15668 record on disk: y word is 39", raw(2) === 39, `raw=${raw(2)}`);
  check("$15668 record on disk: wrap width word (+8) is 240", raw(8) === 240, `raw=${raw(8)}`);
  check("readMessageContext returns the disk origin and width", ctx.x === 8 && ctx.y === 39 && ctx.width === 240, JSON.stringify(ctx));
}

if (failed) {
  console.log(`${failed} announce check(s) failed`);
  process.exit(1);
}
console.log("all announce checks passed");
