// Frame after an Earth offer closes (stage "offer", OfferScene draws into map.screen). The offer is a full-screen dialog over the
// map frame; Game's window path restores the frozen map frame when a window closes (showWindow / "screen" stage), but the offer
// path did not, so the offer's panel (a black fill over x 44..275, rows 24..163, which covers the message line's glyph rows) stayed
// on the displayed frame until the next completed pass. These checks pin that the first map frame after the answer is the frame
// that was shown before the offer, with the message line still drawn, and that the next pass keeps the line.
// Real Game.update clicks throughout; uses the user's own Disk.1 / Disk.2 (read-only), skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("offer exit frame tests skipped: original data not found");
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
const iconClick = (i) => {
  idle();
  const x = DISK_MENU_BUTTONS[i].x0 + 16;
  const y = DISK_MENU_BUTTONS[i].y0 + 16;
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
};

const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const rect = (px, x0, y0, x1, y1) => {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(px[y * 320 + x]);
  return out;
};
// The offer's panel (OfferScene PANEL: x 44..275, rows 24..163) and the message band's glyph rows inside it.
const PANEL = { x0: 44, y0: 24, x1: 275, y1: 163 };
const LINE = 84;

game = bootGame();
idle();
passBoot(game);
iconClick(DISK_BUTTON.tutorial);
check("the tutorial enters the map", game.stage === "map" && game.map !== null);
const map = game.map;

// The line is posted and drawn by the next completed pass (a pushed line is not presented on its own). The pass ends the phase at
// 0, so the offer opens on phase 1 and the answer's next update is phase 2: no pass can run before the first frame after the answer.
const picture = map.initialPicture;
const band = (px) => rect(px, 0, 160, 319, 165);
map.messages.push(LINE);
{
  const n = map.loop.passes;
  while (map.loop.passes === n) idle();
}
check("the line is showing before the offer", map.messages.lineShowing);
check("the line is drawn in the frame before the offer (the check can fail)", !same(band(map.screen.pixels), band(picture)));
const before = map.screen.pixels.slice();
check("the offer opens on the update after a completed pass (phase 0)", map.loop.updatesIntoPass === 0);

// An Earth offer becomes pending; the next map update opens the dialog (Game.updateMap).
map.sim.pending = { offer: { what: "colonists", count: 100, price: 1000 }, apply: () => {} };
idle();
check("the offer opens (stage offer)", game.stage === "offer");
idle();
check("the offer is drawn over the map frame (the check can fail)", !same(rect(map.screen.pixels, PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1), rect(before, PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1)));

// ACCEPT button (x 76..147, rows 140..155): the release-free press on the down edge answers the dialog.
frame(true, 100, 148);
check("the answer leaves the offer (stage map)", game.stage === "map" && map.sim.pending === null);
check("the line is still showing after the answer (no timer ticks during the dialog)", map.messages.lineShowing);

// The first map frame after the answer, before any pass, is the frame that was shown before the offer.
const passStart = map.loop.passes;
idle();
check("the first frame after the answer runs no pass", map.loop.passes === passStart);
check("the first frame after the answer has no offer panel (equals the frame before the offer)", same(map.screen.pixels, before), `panel differs in ${rect(map.screen.pixels, PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1).filter((v, i) => v !== rect(before, PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1)[i]).length} pixels`);
check("the line glyph rows are drawn in the first frame after the answer", same(band(map.screen.pixels), band(before)));

// The next completed pass keeps the line in its band.
while (map.loop.passes === passStart) idle();
check("the next pass keeps the line in the message band", same(band(map.screen.pixels), band(before)));

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("offer exit frame tests passed");
