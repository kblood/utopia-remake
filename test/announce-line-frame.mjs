// An announcement ($E770, stage "announce") opened while the message line is showing: the backdrop keeps the line's pixels, the
// line timer is frozen while the dialog is open, and the close frame is the frame that was shown before the dialog (no stale
// dialog pixels, no line that expired while the dialog was open). Also the edge where the line expires on the same update the
// dialog opens: the backdrop must not carry the expired glyph rows. Real Game.update clicks and the user's own Disk.1 / Disk.2
// (read-only); skipped when the original files are missing. Synthetic only: no emulator, nothing is written under original/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("announce line frame tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { Screen } = await import("../dist/gfx/screen.js");
const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON } = await import("../dist/game/disk-menu.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

function bootGame() {
  const game = new Game(disk1, disk2, null, null);
  game.stage = "language";
  game.language = { pointerVisible: true, screen: new Screen(), picturePalette: decodePicture(disk1, PICTURES.language).palette, update: () => ({ state: "chosen", language: 0 }) };
  return game;
}
function passBoot(g, limit = 20000) {
  let inCheck = 0;
  for (let n = 1; g.stage === "boot"; n++) {
    if (n > limit) throw new Error("the boot stages did not finish");
    if (g.boot.currentPhase === "E") inCheck++;
    g.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: inCheck === 50 ? ["Enter"] : [] });
  }
}

const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
let game = null;
const frame = (down, x = 0, y = 0) => {
  input.leftButton = down;
  input.pointerX = x;
  input.pointerY = y;
  game.update({ ...input });
};
const idle = () => frame(false, 0, 0);
const W = 320;
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rect = (px, x0, y0, x1, y1) => {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(px[y * W + x]);
  return out;
};
// Dialog windows (announce.ts): portrait $F0F8 at (96,106) 80x80, text $F108 at (0,8) 248x88, button column x 256..319.
const inDialog = (x, y) =>
  (x >= 96 && x < 176 && y >= 106 && y < 186) || (x < 248 && y >= 8 && y < 96) || x >= 256;
const lineBandDiff = (a, b) => {
  let n = 0;
  for (let y = 160; y < 166; y++) for (let x = 0; x < W; x++) if (a[y * W + x] !== b[y * W + x] && !inDialog(x, y)) n++;
  return n;
};

// Boot to the tutorial map, as offer-exit-frame.mjs does (the disk menu entry is the first icon click).
game = bootGame();
idle();
passBoot(game);
{
  // Enter the tutorial through the disk menu: same clicks as the offer probe.
  const { DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
  const x = DISK_MENU_BUTTONS[DISK_BUTTON.tutorial].x0 + 16;
  const y = DISK_MENU_BUTTONS[DISK_BUTTON.tutorial].y0 + 16;
  idle();
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
}
check("the tutorial enters the map", game.stage === "map" && game.map !== null);
const map = game.map;
const picture = map.initialPicture;
const LINE = 84;

// Post a line and let a completed pass draw it (the line is not presented on its own).
map.messages.push(LINE);
{
  const n = map.loop.passes;
  while (map.loop.passes === n) idle();
}
check("the line is showing before the announcement", map.messages.lineShowing);
const lineDrawn = rect(map.screen.pixels, 0, 160, 95, 165);
check("the line glyph rows are drawn in the map frame (the check can fail)", !same(lineDrawn, rect(picture, 0, 160, 95, 165)));

// Let the timer run down a few updates, then open the dialog with the timer still well above 1.
for (let i = 0; i < 3; i++) idle();
const L0 = map.messages.inspect().lineFramesLeft;
check("remaining lifetime is above 2 frames before opening", L0 > 2, `L0=${L0}`);
const openFrame = map.screen.pixels.slice();

map.sim.events.push({ kind: "announce", id: 1 });
const passesAtOpen = map.loop.passes;
idle();
check("the announcement opens (stage announce)", game.stage === "announce" && game.announce !== null);
check("the opening update ticks the line once (the dialog freezes it afterwards)", map.messages.inspect().lineFramesLeft === L0 - 1, `left=${map.messages.inspect().lineFramesLeft} L0=${L0} passesRan=${map.loop.passes - passesAtOpen}`);
const dialog = game.announce;
const shownFirst = game.screen.pixels.slice();

// Backdrop: outside the dialog windows the displayed frame equals the map frame of the opening update, and the line glyph
// rows left of the portrait are the same pixels.
{
  let outside = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < W; x++) if (!inDialog(x, y) && shownFirst[y * W + x] !== map.screen.pixels[y * W + x]) outside++;
  check("outside the dialog windows the displayed frame equals the map frame (pixels differing: 0)", outside === 0, `differs=${outside}`);
  check("the line glyph rows keep their pixels left of the portrait", lineBandDiff(shownFirst, map.screen.pixels) === 0);
}

// Frozen while open: many updates, same timer, same map frame, same displayed frame.
const mapAtOpen = map.screen.pixels.slice();
const passesStart = map.loop.passes;
for (let i = 0; i < 40; i++) idle();
check("40 updates with the dialog open: the line timer is frozen", map.messages.inspect().lineFramesLeft === L0 - 1, `left=${map.messages.inspect().lineFramesLeft}`);
check("40 updates with the dialog open: no pass ran", map.loop.passes === passesStart);
check("40 updates with the dialog open: the map frame is unchanged", same(map.screen.pixels, mapAtOpen));
check("the dialog frame is stable while idle", same(game.screen.pixels, shownFirst));

// Close with the exit icon (command button 9): press on it, release elsewhere.
const c9 = dialog.ui.rects[9];
const cx = (c9.x0 + c9.x1) >> 1;
const cy = (c9.y0 + c9.y1) >> 1;
frame(true, cx, cy);
check("a press on the exit icon does not close yet", game.stage === "announce");
frame(false, 10, 10);
check("release after the press closes the dialog (stage map)", game.stage === "map" && game.announce === null);
const closeFrame = game.screen.pixels;
check("the close frame equals the map frame shown before the dialog (exact, whole frame)", same(closeFrame, openFrame), `differs=${closeFrame.filter((v, i) => v !== openFrame[i]).length}`);
check("the close frame keeps the line glyph rows", !same(rect(closeFrame, 0, 160, 95, 165), rect(picture, 0, 160, 95, 165)));
check("the timer is unchanged by the close update", map.messages.inspect().lineFramesLeft === L0 - 1);

// Remaining lifetime after close: the line expires after exactly L0 - 1 further map updates, and the expiry frame has no glyph rows.
let updates = 0;
while (map.messages.lineShowing && updates < 500) {
  idle();
  updates++;
}
check("the line expires after exactly the remaining frames", updates === L0 - 1, `updates=${updates} expected=${L0 - 1}`);
check("the expiry frame has the picture in the line rows (no stale glyphs)", same(rect(game.screen.pixels, 0, 159, 319, 165), rect(picture, 0, 159, 319, 165)));

// Edge: the line expires on the update the dialog opens (timer 1 at the open update).
{
  game = bootGame();
  idle();
  passBoot(game);
  const { DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
  const x = DISK_MENU_BUTTONS[DISK_BUTTON.tutorial].x0 + 16;
  const y = DISK_MENU_BUTTONS[DISK_BUTTON.tutorial].y0 + 16;
  idle();
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
  const m = game.map;
  m.messages.push(LINE);
  {
    const n = m.loop.passes;
    while (m.loop.passes === n) idle();
  }
  let guard = 0;
  while (m.messages.inspect().lineFramesLeft > 1 && guard++ < 400) idle();
  check("edge: the line is at its last frame", m.messages.inspect().lineFramesLeft === 1);
  m.sim.events.push({ kind: "announce", id: 2 });
  idle();
  check("edge: the dialog opens on the expiry update", game.stage === "announce" && !m.messages.lineShowing);
  const shown = game.screen.pixels;
  check("edge: the backdrop has no line glyph rows (expired in the opening update)", same(rect(shown, 0, 160, 95, 165), rect(m.initialPicture, 0, 160, 95, 165)));
  check("edge: the map frame under the dialog has no glyph rows either", same(rect(m.screen.pixels, 0, 160, 95, 165), rect(m.initialPicture, 0, 160, 95, 165)));
  // The first update of a new dialog only initialises its pointer (announce.ts Pointer; game-over.mjs), so a released frame comes first.
  idle();
  const c = game.announce.ui.rects[9];
  frame(true, (c.x0 + c.x1) >> 1, (c.y0 + c.y1) >> 1);
  frame(false, 10, 10);
  check("edge: after close the displayed frame has no line glyphs", game.stage === "map" && same(rect(game.screen.pixels, 0, 159, 319, 165), rect(m.initialPicture, 0, 159, 319, 165)));
}

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("announce line frame tests passed");
