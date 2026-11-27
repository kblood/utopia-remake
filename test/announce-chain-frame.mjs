// Two announcements in a row over a message line near expiry. Supported chain (src/game/game.ts): updateMap drains map.sim.events
// FIFO into `announcements`, and the first one opens ($E770, stage "announce") on that update. Map updates do not run in stage
// "announce", so a second event can only be queued in the same drain; it opens in the update that closes the first (case
// "announce" -> startAnnouncement(), no returnToMap in between). The chain copies the same unchanged map frame each time.
// Checked here: the backdrop of both dialogs is the current map frame, the line timer and the pass count are frozen across both
// dialogs, and closing the second restores the exact frame shown before the first dialog. Real Game.update clicks; synthetic only
// (the user's own Disk.1 / Disk.2, read-only); skipped when the original files are missing. Nothing under original/ is written.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("announce chain frame tests skipped: original data not found");
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
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

function bootGame() {
  const g = new Game(disk1, disk2, null, null);
  g.stage = "language";
  g.language = { pointerVisible: true, screen: new Screen(), picturePalette: decodePicture(disk1, PICTURES.language).palette, update: () => ({ state: "chosen", language: 0 }) };
  return g;
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
const outsideDialogDiff = (a, b) => {
  let n = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < W; x++) if (!inDialog(x, y) && a[y * W + x] !== b[y * W + x]) n++;
  return n;
};
const lineBandDiff = (a, b) => {
  let n = 0;
  for (let y = 160; y < 166; y++) for (let x = 0; x < W; x++) if (a[y * W + x] !== b[y * W + x] && !inDialog(x, y)) n++;
  return n;
};
const closeWithExitIcon = (dialog) => {
  const c = dialog.ui.rects[9];
  frame(true, (c.x0 + c.x1) >> 1, (c.y0 + c.y1) >> 1);
  frame(false, 10, 10);
};

// Boot to the tutorial map through the disk menu (same clicks as announce-line-frame.mjs).
game = bootGame();
idle();
passBoot(game);
{
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

// Post a line and let a completed pass draw it, then run the timer down to 3 frames left (near expiry).
map.messages.push(LINE);
{
  const n = map.loop.passes;
  while (map.loop.passes === n) idle();
}
check("the line is showing before the chain", map.messages.lineShowing);
{
  let guard = 0;
  while (map.messages.inspect().lineFramesLeft > 3 && guard++ < 400) idle();
}
check("the line is near expiry (3 frames left) before the chain opens", map.messages.inspect().lineFramesLeft === 3, `left=${map.messages.inspect().lineFramesLeft}`);
const preOpen = map.screen.pixels.slice();

// Two announcements in one map update: the first opens, the second is queued behind it (FIFO drain in updateMap).
map.sim.events.push({ kind: "announce", id: 1 }, { kind: "announce", id: 2 });
idle();
check("the first announcement opens on the drain update (stage announce, id 1)", game.stage === "announce" && game.announce !== null && game.announce.id === 1, `id=${game.announce?.id}`);
check("the opening update ticks the line once (3 -> 2)", map.messages.inspect().lineFramesLeft === 2, `left=${map.messages.inspect().lineFramesLeft}`);
const first = game.announce;
const L1 = map.messages.inspect().lineFramesLeft;
const passesAfterOpen = map.loop.passes;
const mapAtOpen = map.screen.pixels.slice();
const shownFirst = game.screen.pixels.slice();

check("the line is still showing under the first dialog", map.messages.lineShowing);
check("first dialog backdrop: outside the windows the frame equals the map frame", outsideDialogDiff(shownFirst, mapAtOpen) === 0, `differs=${outsideDialogDiff(shownFirst, mapAtOpen)}`);
check("first dialog backdrop: line glyph rows left of the portrait keep their pixels", lineBandDiff(shownFirst, mapAtOpen) === 0);

// Frozen while the first dialog is open (first update initialises its pointer; nothing else runs).
for (let i = 0; i < 20; i++) idle();
check("first dialog open: the line timer is frozen", map.messages.inspect().lineFramesLeft === L1, `left=${map.messages.inspect().lineFramesLeft}`);
check("first dialog open: no pass runs", map.loop.passes === passesAfterOpen);
check("first dialog open: the map frame is unchanged", same(map.screen.pixels, mapAtOpen));
check("first dialog open: the displayed frame is stable", same(game.screen.pixels, shownFirst));

// Close the first dialog: the same update must open the second (chain), with no map stage in between.
frame(true, (first.ui.rects[9].x0 + first.ui.rects[9].x1) >> 1, (first.ui.rects[9].y0 + first.ui.rects[9].y1) >> 1);
check("a press on the exit icon does not close the first dialog yet", game.stage === "announce" && game.announce === first);
frame(false, 10, 10);
check("release closes the first dialog and the same update opens the second (stage announce, id 2)", game.stage === "announce" && game.announce !== first && game.announce.id === 2, `stage=${game.stage} id=${game.announce?.id}`);
const second = game.announce;
const shownSecond = game.screen.pixels.slice();
check("the chain update does not tick the line timer", map.messages.inspect().lineFramesLeft === L1, `left=${map.messages.inspect().lineFramesLeft}`);
check("the chain update runs no pass", map.loop.passes === passesAfterOpen);
check("second dialog backdrop: outside the windows the frame equals the current map frame", outsideDialogDiff(shownSecond, mapAtOpen) === 0, `differs=${outsideDialogDiff(shownSecond, mapAtOpen)}`);
check("second dialog backdrop: line glyph rows left of the portrait keep their pixels", lineBandDiff(shownSecond, mapAtOpen) === 0);
check("the map frame is unchanged by closing the first dialog", same(map.screen.pixels, mapAtOpen));

// Frozen while the second dialog is open.
for (let i = 0; i < 20; i++) idle();
check("second dialog open: the line timer is frozen across both dialogs", map.messages.inspect().lineFramesLeft === L1, `left=${map.messages.inspect().lineFramesLeft}`);
check("second dialog open: no pass runs across both dialogs", map.loop.passes === passesAfterOpen);
check("second dialog open: the map frame is unchanged", same(map.screen.pixels, mapAtOpen));
check("second dialog open: the displayed frame is stable", same(game.screen.pixels, shownSecond));
check("the second dialog is still the active announcement", game.announce === second && game.stage === "announce");

// Close the second dialog: back to the map, with the frame shown before the first dialog.
closeWithExitIcon(second);
check("closing the second dialog returns to the map (no third dialog)", game.stage === "map" && game.announce === null);
const closeFrame = game.screen.pixels;
check("the close frame equals the map frame shown under the dialogs (exact, whole frame)", same(closeFrame, mapAtOpen), `differs=${closeFrame.filter((v, i) => v !== mapAtOpen[i]).length}`);
check("the close frame equals the frame before the first dialog (exact, whole frame)", same(closeFrame, preOpen), `differs=${closeFrame.filter((v, i) => v !== preOpen[i]).length}`);
check("the close frame keeps the line glyph rows", !same(rect(closeFrame, 0, 160, 95, 165), rect(picture, 0, 160, 95, 165)));
check("the close update leaves the timer unchanged", map.messages.inspect().lineFramesLeft === L1);

// The remaining lifetime after the chain: the line expires after exactly L1 more map updates.
let updates = 0;
while (map.messages.lineShowing && updates < 500) {
  idle();
  updates++;
}
check("the line expires after exactly the remaining frames", updates === L1, `updates=${updates} expected=${L1}`);
check("the expiry frame has the picture in the line rows (no stale glyphs)", same(rect(game.screen.pixels, 0, 159, 319, 165), rect(picture, 0, 159, 319, 165)));

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("announce chain frame tests passed");
