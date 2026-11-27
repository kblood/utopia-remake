// The scenario list's rows in the original layout (`DiskMenuScene.openScenarioList`, src/game/disk-menu.ts; traced in notes/formats/game-proper.md,
// "Scenario list rows"). Static trace of Disk.1 raw bytes (2026-11-14):
//   `$865A`: `move.w #$13D,d0`, `bsr $85CA`, `move.b #3,$938D`. `$85CA`: `moveq #0,d1`, `bsr $8462` (d0 on the list prompt, y $A3).
//   `$85D2`-`$85F8`: `lea $8F96,a0`; per row (ten, `dbra` 9): `moveq #$3A,d0` (x), `moveq #$0B,d2` (11 bytes), `lea $160FA,a1`, `bsr $539E`,
//   then `addi.w #9,d1` (y pitch 9 from `$20`) and `adda.w #$40,a0` (the next record).
//   `$539E` = `$51E6` (6-row pattern erase, 11 bytes from byte x/8) + the opaque text of `$53A2`: a0 is the record start, so the row
//   text is the 16-byte name field up to its NUL. Disk.2 header records: `$8F8C` + 10 + n * $40 (`$8F96` is record 0).
// Checked here: the names against the raw Disk.2 bytes; each row's text and erase against an independent glyph decode from the raw
// Disk.1 character and glyph tables (`$62D8` -> file `$2EAD8`, `$6354` -> file `$2EB54`, game-text.md section 1). The disk picture
// background comes from the existing picture decoder (not decoded independently here). Hover bar: the `$818C` bar of the music list
// (colour 7); the text-over-bar order is the remake's, unverified. Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload
// (read only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("scenario-list tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { GameStrings } = await import("../dist/data/gamestrings.js");
const { readScenarioRecords } = await import("../dist/data/scenario.js");
const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { Game } = await import("../dist/game/game.js");
const { DiskMenuScene, DISK_LIST_GEOMETRY, DISK_BUTTON, DISK_MENU_BUTTONS, DISK_MENU_PICTURE, MESSAGE_AREA, SCENARIO_OPEN_STRING } = await import("../dist/game/disk-menu.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);
const G = DISK_LIST_GEOMETRY;
const W = 320;

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- 1. Names: the records' label codes are the raw Disk.2 name fields up to their NUL -------------------------------------
const HEADER = 0x3c0 * 512; // header sector $3C0 (game-proper.md section 6)
const rawNames = Array.from({ length: 10 }, (_, i) => {
  const at = HEADER + 10 + i * 0x40;
  const field = disk2.subarray(at, at + 16);
  const nul = field.indexOf(0);
  return Array.from(nul < 0 ? field : field.subarray(0, nul));
});
const records = readScenarioRecords(disk2);
check("Disk.2 header magic is UTOPSCEN", String.fromCharCode(...disk2.subarray(HEADER, HEADER + 8)) === "UTOPSCEN");
check("ten records are read in header order", records.length === 10 && records.every((r, i) => r.index === i));
check("every record's labelCodes equals its raw name field up to the first NUL", records.every((r, i) => r.labelCodes.join() === rawNames[i].join()));
check("every name is 1..15 bytes of printable ASCII (no NUL inside, no bit-7 line break)", rawNames.every((c) => c.length >= 1 && c.length <= 15 && c.every((v) => v >= 0x20 && v < 0x7f)));
check("the NUL is inside the 16-byte field of every record", rawNames.every((c, i) => disk2[HEADER + 10 + i * 0x40 + c.length] === 0));

/// ---- 2. Geometry: the traced list values; the last record row and the prompt line do not overlap ----------------------------
check("row origin x is $3A and the row pitch is 9 from y $20 (the music labels' geometry, $85DA / $8132)", G.labelX === 0x3a && G.y0 === 0x20 && G.pitch === 9);
check("the erase is 11 bytes wide from byte x/8 and 6 scanlines tall ($85DC, $51E6)", G.eraseBytes === 11 && G.eraseRows === 6);
check("the hover bar is the music list's: x $38, 88 px, 6 rows, colour 7 ($818C)", G.barX === 0x38 && G.barWidth === 88 && G.barHeight === 6 && G.barColor === 7);
check("the hit x bounds are $38..$88 inclusive ($8132)", G.x0 === 0x38 && G.x1 === 0x88);
check("the ten record rows' erases do not overlap (pitch 9, 6 scanlines erased)", G.y0 + 9 * G.pitch + G.eraseRows <= G.y0 + 10 * G.pitch);
check("the last row's erase ends above the list prompt line ($A3)", G.y0 + 9 * G.pitch + G.eraseRows <= MESSAGE_AREA.prompt.y[0]);
check("no disk icon overlaps the rows' x span (x 56..143): every icon starts right of it", DISK_MENU_BUTTONS.every((r) => r.x0 > G.barX + G.barWidth - 1));

// ---- hit targets: a scenario list on a scene, one press and release at a point --------------------------------------------
const idleInput = (x, y) => ({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
const downInput = (x, y) => ({ ...idleInput(x, y), leftButton: true });
const names = records.map((r) => r.labelCodes);
const hitAt = (x, y) => {
  const s = new DiskMenuScene(disk1, strings);
  s.openScenarioList(names, false);
  s.update(idleInput(x, y));
  s.update(downInput(x, y));
  const result = s.update(idleInput(x, y));
  return result?.kind === "scenario" ? result.index : null;
};
const rowTop = (i) => G.y0 + i * G.pitch;
check("each record row picks its own entry at its first and last pixel row", Array.from({ length: 10 }, (_, i) => hitAt(100, rowTop(i)) === i && hitAt(100, rowTop(i) + G.pitch - 1) === i).every(Boolean));
check("the row x bounds are inclusive at $38 and $88, and nothing lies just outside them", Array.from({ length: 10 }, (_, i) => hitAt(G.x0, rowTop(i)) === i && hitAt(G.x1, rowTop(i)) === i && hitAt(G.x0 - 1, rowTop(i)) === null && hitAt(G.x1 + 1, rowTop(i)) === null).every(Boolean));
check("nothing picks above the first row", hitAt(100, G.y0 - 1) === null);
check("the first pixel row below the last record row picks nothing: the list has no EXIT row (icon 5 leaves it)", hitAt(100, rowTop(10)) === null && hitAt(100, rowTop(10) + G.pitch - 1) === null);
check("the last record row ends exactly one pixel above that empty row", hitAt(100, rowTop(10) - 1) === 9);
check("nothing below the list picks", hitAt(100, rowTop(11)) === null);

// A list with fewer names than rows: the rows past the last name are not rows, so nothing there picks (the list's labels bound the hit test).
const shortPick = (count, row) => {
  const s = new DiskMenuScene(disk1, strings);
  s.openScenarioList(names.slice(0, count), false);
  s.update(idleInput(100, rowTop(row)));
  s.update(downInput(100, rowTop(row)));
  const result = s.update(idleInput(100, rowTop(row)));
  return result?.kind === "scenario" ? result.index : null;
};
check("a list of seven names picks rows 0-6 and nothing in rows 7-9 (no name there)", Array.from({ length: 7 }, (_, i) => shortPick(7, i) === i).every(Boolean) && [7, 8, 9].every((row) => shortPick(7, row) === null));

// ---- 3. The list in the game flow: the rows are the records in order, and each row picks its scenario ---------------------
const gameStrings = strings;
const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const frame = (down, x = 0, y = 0) => {
  input.leftButton = down;
  input.pointerX = x;
  input.pointerY = y;
  game.update({ ...input });
};
const iconClick = (i) => {
  frame(false);
  const [x, y] = [DISK_MENU_BUTTONS[i].x0 + 16, DISK_MENU_BUTTONS[i].y0 + 16];
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
};
let game = new Game(disk1, disk2, null, null);
game.strings = gameStrings;
game.bootMenuOpen = false;
game.openDiskMenu();
iconClick(DISK_BUTTON.scenario);
frame(true, 0, 0); // the wait's press (`$2E48`) opens the list
frame(false, 0, 0);
check("icon 2 opens the scenario list on the disk picture (stage scenario, the disk scene holds it, no page)", game.stage === "scenario" && game.diskMenu?.listKind === "scenario" && game.menu === null);
check("the list's rows are the ten record names in order (no EXIT row)", JSON.stringify(game.diskMenu.listRows.map((r) => r.join())) === JSON.stringify(records.map((r) => r.labelCodes.join())));
check("the list prompt is $13D on open (the list's prompt, $865A)", game.diskMenu.promptCodes?.join() === strings.get(SCENARIO_OPEN_STRING).join());

// Each record row picks its own scenario index (press and release on the row, one per record; each pick replaces the held scene).
let picksOk = true;
for (let i = 0; i < 10; i++) {
  frame(false, 100, rowTop(i) + 4);
  frame(true, 100, rowTop(i) + 4);
  frame(false, 100, rowTop(i) + 4);
  if (game.heldScene?.index !== i) picksOk = false;
}
check("row i picks scenario i for all ten rows (the held index follows the row)", picksOk && game.stage === "scenario");
check("the picks keep the list open with the scenario's $8B prompt", game.diskMenu.promptCodes?.join() === strings.get(0x8b).join());

// The traced values, written out here (not read from the implementation): the pixel expectations must not follow a changed export.
const T = { labelX: 0x3a, y0: 0x20, pitch: 9, eraseBytes: 0x0b, eraseRows: 6, barX: 0x38, barWidth: 88, barHeight: 6, barColor: 7 };
const topT = (i) => T.y0 + i * T.pitch;
// ---- 4. Pixels: rows, gap rows, prompt, and the hover bar against an independent glyph decode ---------------------------------
const CHAR_TABLE = 0x2ead8; // file offset of $62D8 (Disk.1), 2 bytes per code: {glyph index, advance}
const GLYPHS = 0x2eb54; // file offset of $6354, 6 bytes per glyph
// Ink of a string drawn at (x, y): glyph row bytes, MSB = left pixel; the pen advances by the table's width (game-text.md sections 1, 2).
function inkPixels(codes, x, y) {
  const ink = new Set();
  let pen = x;
  for (const raw of codes) {
    let c = raw;
    if (c >= 0x61) c -= 0x20;
    const e = CHAR_TABLE + 2 * (c - 0x20);
    const glyph = disk1[e];
    const advance = disk1[e + 1];
    for (let r = 0; r < 6; r++) {
      const bits = disk1[GLYPHS + glyph * 6 + r];
      for (let col = 0; col < 8; col++) if (bits & (0x80 >> col)) ink.add(`${pen + col},${y + r}`);
    }
    pen += advance;
  }
  return ink;
}
const bgScreen = new Screen();
decodePicture(disk1, DISK_MENU_PICTURE, bgScreen);
const bg = bgScreen.pixels.slice();
// The `$51E6` pattern: the picture's byte column 19 (x 152..159), rows 70..77, repeated per byte; row = y & 7, column = x & 7.
const pattern = (px, py) => bg[(70 + (py & 7)) * W + 152 + (px & 7)];
const erased = (px, py, yTop) => px >= T.labelX - (T.labelX & 7) && px < T.labelX - (T.labelX & 7) + T.eraseBytes * 8 && py >= yTop && py < yTop + T.eraseRows;
// Expected palette index of every pixel in [y0, y1) for a row drawn at yTop with `codes`; `bar` adds the hover bar (colour 7).
function expectedBand(codes, yTop, y0, y1, bar = false) {
  const ink = inkPixels(codes, T.labelX, yTop);
  const out = new Uint8Array(W * (y1 - y0));
  for (let py = y0; py < y1; py++) {
    for (let px = 0; px < W; px++) {
      let v = bg[py * W + px];
      if (erased(px, py, yTop)) v = pattern(px, py);
      if (bar && px >= T.barX && px < T.barX + T.barWidth && py >= yTop && py < yTop + T.barHeight) v = T.barColor;
      if (ink.has(`${px},${py}`)) v = 1; // colour 1: plane 0 only ($156AB = 1, game-text.md section 3)
      out[(py - y0) * W + px] = v;
    }
  }
  return out;
}
const mismatches = (screen, expected, y0, y1) => {
  let n = 0;
  for (let py = y0; py < y1; py++) for (let px = 0; px < W; px++) if (screen[py * W + px] !== expected[(py - y0) * W + px]) n++;
  return n;
};

// A list built like the game's (no hover), with its $13D prompt.
const rest = new DiskMenuScene(disk1, strings);
rest.openScenarioList(names, false);
let totalInk = 0;
let rowMismatch = 0;
for (let i = 0; i < 10; i++) {
  const codes = records[i].labelCodes;
  totalInk += inkPixels(codes, T.labelX, topT(i)).size;
  rowMismatch += mismatches(rest.screen.pixels, expectedBand(codes, topT(i), topT(i), topT(i) + T.pitch), topT(i), topT(i) + T.pitch);
}
check("rows: every record row matches the independent glyph decode and the pattern erase (full band, 9 scanlines each)", rowMismatch === 0, `mismatches ${rowMismatch}`);
check("the rows carry ink (sanity: the independent decode finds glyph pixels in every row)", totalInk > 300, `ink ${totalInk}`);
check("the gap scanlines under each row (rows 6..8 of its pitch) equal the disk picture exactly", Array.from({ length: 10 }, (_, i) => i).every((i) => {
  const a = rest.screen.pixels;
  for (let py = topT(i) + T.eraseRows; py < topT(i) + T.pitch; py++) for (let px = 0; px < W; px++) if (a[py * W + px] !== bg[py * W + px]) return false;
  return true;
}));
check("the list's background is the disk picture, not the remake's main picture", (() => {
  const main = new Screen();
  decodePicture(disk1, PICTURES.main, main);
  let diff = 0;
  for (let i = 0; i < W * 200; i++) if (main.pixels[i] !== bg[i]) diff++;
  return diff > 0 && rest.screen.pixels[5 * W + 300] === bg[5 * W + 300];
})());

// The prompt line: $13D at y $A3, the pattern erase 37 bytes from x 8, then the text in colour 1.
const promptY = MESSAGE_AREA.prompt.y[0];
{
  const yEnd = promptY + MESSAGE_AREA.lineHeight;
  const ink = inkPixels(strings.get(SCENARIO_OPEN_STRING), MESSAGE_AREA.x, promptY);
  let n = 0;
  for (let py = promptY; py < yEnd; py++) {
    for (let px = 0; px < W; px++) {
      let v = bg[py * W + px];
      if (px >= MESSAGE_AREA.x && px < MESSAGE_AREA.x + MESSAGE_AREA.prompt.printBytes * 8 && py < yEnd) v = pattern(px, py);
      if (ink.has(`${px},${py}`)) v = 1;
      if (rest.screen.pixels[py * W + px] !== v) n++;
    }
  }
  check("prompt line: $13D at x 8, y $A3 over its 37-byte pattern erase, matches the independent decode", n === 0 && ink.size > 100, `mismatches ${n} ink ${ink.size}`);
}

// Hover: the pointer on record row 3 draws the $818C bar behind its text (remake order, unverified against the original); leaving
// the row restores the rest picture exactly.
const hover = new DiskMenuScene(disk1, strings);
hover.openScenarioList(names, false);
hover.update(idleInput(100, topT(3) + 4));
const hovered = hover.screen.pixels.slice();
const hover3 = expectedBand(records[3].labelCodes, topT(3), topT(3), topT(3) + T.pitch, true);
check("hover on row 3 draws the colour-7 bar over the erase, with the text on top (the remake's order)", mismatches(hovered, hover3, topT(3), topT(3) + T.pitch) === 0);
const clean = new DiskMenuScene(disk1, strings);
clean.openScenarioList(names, false);
hover.update(idleInput(0, 0));
check("moving off the rows restores the rest picture (the bar is gone)", hover.screen.pixels.every((v, i) => v === clean.screen.pixels[i]));

if (failed > 0) {
  console.log(`\n${failed} scenario-list check(s) FAILED`);
  process.exit(1);
}
console.log("\nall scenario-list checks passed");
