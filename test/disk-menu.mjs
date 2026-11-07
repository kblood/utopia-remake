// Checks of the original disk-menu scene (src/game/disk-menu.ts): the static anchors in the user's Disk.1 that the notes rely on
// ($8CB4 rectangles, the $7FE4 dispatch, the $5948/$59C8 flip, the message areas of $8462/$83A2, the handler strings), then the
// scene's pixels and input rules: picture, pressed icons (32 x 32, plane 3), the click requested once on the press, the action on the
// release of the RECORDED icon, the shared list, the message areas and their countdown. Static trace only, no emulator capture
// (notes/formats/music.md, notes/formats/sfx.md). Uses the user's own Disk.1 in original/utopia-whdload (read-only); skipped when
// it is missing. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("disk-menu tests skipped: original/utopia-whdload/Disk.1 not found");
  process.exit(0);
}

const dm = await import("../dist/game/disk-menu.js");
const ms = await import("../dist/game/music-select.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { COLOR } = await import("../dist/data/gamefont.js");
const { decodePicture } = await import("../dist/data/picture.js");
const { Screen } = await import("../dist/gfx/screen.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const strings = new GameStrings(disk1, 0);
const text = (index) => String.fromCharCode(...strings.get(index));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- static anchors in the game image ($1000 = sector $14C: file offset = address + $28800) -----------------------------------
const at = (address) => address + 0x28800;
const word = (address) => (disk1[at(address)] << 8) | disk1[at(address) + 1];
const sword = (address) => (word(address) << 16) >> 16;
const hex = (address, n) => Array.from(disk1.subarray(at(address), at(address) + n), (b) => b.toString(16).padStart(2, "0")).join("");
const has = (address, pattern) => hex(address, pattern.length / 2) === pattern;
const contains = (from, to, pattern) => hex(from, to - from).includes(pattern);

{
  const table = [];
  for (let i = 0; i < 9; i++) table.push({ x0: word(0x8cb4 + 8 * i), x1: word(0x8cb4 + 8 * i + 2), y0: word(0x8cb4 + 8 * i + 4), y1: word(0x8cb4 + 8 * i + 6) });
  check("$8CB4 holds the nine rectangles of DISK_MENU_BUTTONS (x0, x1, y0, y1 words)", JSON.stringify(table) === JSON.stringify(dm.DISK_MENU_BUTTONS));
  check("the table ends with the terminator the hit test $5730 stops on", (word(0x8cb4 + 72) & 0x8000) !== 0);
}
{
  // $7FE4: `cmpi.b #n,d2` (0C02 00nn) / `tst.b d2` (4A02) followed by beq.b / beq.w; collect n -> branch target.
  const targets = {};
  let a = 0x7fe4;
  for (;;) {
    let n;
    if (word(a) === 0x0c02) {
      n = word(a + 2) & 0xff;
      a += 4;
    } else if (word(a) === 0x4a02) {
      n = 0;
      a += 2;
    } else break;
    const op = word(a);
    if ((op & 0xff00) !== 0x6700) break;
    const disp = op & 0xff;
    if (disp === 0) {
      targets[n] = a + 2 + sword(a + 2);
      a += 4;
    } else {
      targets[n] = a + 2 + ((disp << 24) >> 24);
      a += 2;
    }
  }
  const expected = { 0: 0x85fe, 1: 0x856c, 2: 0x8632, 3: 0x8314, 4: 0x1062, 5: 0x802c, 6: 0x80c8, 7: 0x1006, 8: 0x10bc };
  check("the $7FE4 dispatch maps the nine rectangle indexes to $85FE $856C $8632 $8314 $1062 $802C $80C8 $1006 $10BC", JSON.stringify(Object.entries(targets).map(([k, v]) => [Number(k), v]).sort((p, q) => p[0] - q[0])) === JSON.stringify(Object.entries(expected).map(([k, v]) => [Number(k), v])));
  const named = dm.DISK_BUTTON;
  check("DISK_BUTTON names the same indexes", named.load === 0 && named.save === 1 && named.scenario === 2 && named.format === 3 && named.music === 4 && named.exit === 5 && named.tutorial === 6 && named.musicSelect === 7 && named.effects === 8);
}
{
  // The press: $7FC0 calls $5948 and the release $7FA0 calls $59C8; both flip with $59A0 over 32 rows x 4 bytes of plane `$C(a6)`.
  check("loop: $7FC0 -> jsr $5948 on the press, $7FA0 -> jsr $59C8 on the release, then the $7FE4 dispatch", has(0x7fc0, "4eb900005948") && has(0x7fa0, "4eb9000059c8") && has(0x7fa6, "603c"));
  check("$59A0 flips 32 rows (moveq #$1F) of 4 bytes (4 x not.b) and skips 36 (row pitch 40): a 32 x 32 rectangle of ONE plane", has(0x59b4, "7824741f" + "4618".repeat(4) + "d0c451cafff4"));
  check("$59A0 takes the plane from offset $C of the array in a6 (plane 3) and a6 is $160FA at both call sites", has(0x59ae, "206e000c") && has(0x5956, "4df9000160fa") && has(0x59f6, "4df9000160fa") && has(0x5982, "611c") && has(0x59fc, "61a2"));
  check("$5948 requests the id 4 click exactly once (descriptor $14C0 -> $11B4); $59C8 never calls $11B4", has(0x5984, "4df9000014c0") && has(0x5990, "4eb9000011b4") && !contains(0x59c8, 0x5a16, "4eb9000011b4"));
  check("the press stores x, y, index at $5DD0-$5DD4; the release reads them and clears $5DD4", has(0x594e, "48b900070000" + "5dd0") && has(0x59c8, "4cb9000300005dd0") && has(0x5a0c, "33fcffff00005dd4"));
}
{
  // Message areas: $8462 prints at y $A3 / $AC (prompt), $83A2 at y $B5 / $BE (results); the countdown is $4E20 in $8CB0.
  check("$8462 (prompt): lines at y $A3 and $AC, x 8", has(0x84b0, "7008323c00a3") && has(0x84d8, "7008323c00ac"));
  check("$83A2 (results): lines at y $B5 and $BE, x 8", has(0x83b8, "7008323c00b5") && has(0x83e0, "7008323c00be"));
  check("$83A2 ends by storing 20000 in $8CB0; the loop counts it down and erases both result lines", has(0x83f2, "23fc00004e2000008cb0") && has(0x7f04, "53b900008cb0") && has(0x7f4c, "323c00b5") && has(0x7f5e, "323c00be"));
  check("$82B8 (close list) clears the mode byte and calls $84F4 (prompt lines) but not the result lines", has(0x82de, "42390000938d") && has(0x82e4, "6100020e") && has(0x8534, "323c00a3") && has(0x8546, "323c00ac") && !contains(0x82b8, 0x8314, "00b5") && !contains(0x82b8, 0x8314, "00be") && !contains(0x84f4, 0x855a, "00b5") && !contains(0x84f4, 0x855a, "00be"));
  check("$1006 prints the prompt $190 through $8462 and enters mode 4; $1062 and $10BC print through $83A2 with d0 = 0", has(0x104e, "303c0190") && has(0x1056, "13fc00040000938d") && has(0x109c, "7000") && has(0x10d2, "7000"));
  check("disk-menu text keeps normal colour 1: image default is 1 and boot/map entry do not override $156AB", disk1[at(0x156ab)] === 1 && COLOR.text === 1 && !contains(0x7e52, 0x7ef6, "13fc0001000156ab") && !contains(0x7e52, 0x7ef6, "13fc0015000156ab") && !contains(0x15ae6, 0x15af2, "13fc0001000156ab") && !contains(0x15ae6, 0x15af2, "13fc0015000156ab"));
  check("$1062 strings $197 (no memory), $196 (nothing loaded), $192 (on), $193 (off)", has(0x106e, "323c0197") && has(0x1084, "323c0196") && has(0x1090, "323c0192") && has(0x10b6, "323c0193"));
  check("$10BC strings $194 (on) and $195 (off); off also clears the four channel timers", has(0x10c6, "323c0194") && has(0x1104, "323c0195") && has(0x10e4, "427900001518") && has(0x10f0, "42790000151c"));
}
{
  check("$802C (exit) refuses while $156AA bit 3 is set", has(0x802c, "0839000300" + "0156aa") && has(0x8034, "6600fec0"));
  check("$856C (save) prints $18A first line when $156AA bit 3 is set", has(0x856c, "08390003000156aa") && has(0x8574, "6708303c018a7200"));
  check("$80C8 (tutorial): $191, scenario record 0, $156AA bits 7 and 2, money $7A120, then exit", has(0x80ea, "303c0191") && has(0x80d4, "427900008cfe") && has(0x8114, "08f90007000156aa") && has(0x811c, "08f90002000156aa") && has(0x8124, "23fc0007a120000135ba") && has(0x812e, "6000fefc"));
  check("$85FE (load) lists slots with $13A, $856C (save) with $138, $8632 (scenario) with $13D; $8314 (format) asks $130", has(0x8620, "303c013a") && has(0x85b8, "303c0138") && has(0x865a, "303c013d") && has(0x832a, "303c0130"));
  check("the strings agree", /load game/i.test(text(0x13a)) && /save game/i.test(text(0x138)) && /scenario/i.test(text(0x13d)) && /format|erased/i.test(text(0x130)) && /tutorial/i.test(text(0x191)) && /no game to save/i.test(text(0x18a)) && /music on/i.test(text(0x192)) && /music off/i.test(text(0x193)) && /effects on/i.test(text(0x194)) && /effects off/i.test(text(0x195)));
}

// ---- helpers --------------------------------------------------------------------------------------------------------------------
const originalPicture = decodePicture(disk1, dm.DISK_MENU_PICTURE, new Screen());
const erasePattern = (pixels, y0, bytes) => {
  const result = pixels.slice();
  const { x: sx, y: sy } = dm.MESSAGE_PATTERN_SAMPLE;
  for (let y = y0; y < y0 + dm.MESSAGE_AREA.lineHeight; y++) {
    for (let x = dm.MESSAGE_AREA.x; x < dm.MESSAGE_AREA.x + bytes * 8; x++) {
      result[y * 320 + x] = originalPicture.pixels[(sy + (y & 7)) * 320 + sx + (x & 7)];
    }
  }
  return result;
};
// `$7EE2 -> $82B8` clears both prompt strips on entry using 38 bytes each.
const picture = { ...originalPicture, pixels: erasePattern(erasePattern(originalPicture.pixels, 0xa3, dm.MESSAGE_AREA.prompt.clearBytes), 0xac, dm.MESSAGE_AREA.prompt.clearBytes) };
const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const frame = (scene, down, x, y, right = false) => {
  input.leftButton = down;
  input.rightButton = right;
  input.pointerX = x;
  input.pointerY = y;
  return scene.update(input);
};
const rest = (scene, n = 1) => {
  let last = null;
  for (let i = 0; i < n; i++) last = frame(scene, false, 0, 0);
  return last;
};
const newScene = (options) => {
  const scene = new dm.DiskMenuScene(disk1, strings, options);
  rest(scene); // consumes the opening-click guard
  return scene;
};
const px = (screen, x, y) => screen.pixels[y * 320 + x];
const areaEquals = (a, b, x0, y0, w, h) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (px(a, x, y) !== (b.pixels ? px(b, x, y) : b[y * 320 + x])) return false;
  return true;
};
const centre = (i) => [dm.DISK_MENU_BUTTONS[i].x0 + 16, dm.DISK_MENU_BUTTONS[i].y0 + 16];
const rowY = (row) => 0x20 + 9 * row + 2;
const LIST_X = 0x40;
const line = { prompt: [0xa3, 0xac], info: [0xb5, 0xbe] };
const lineEquals = (scene, kind, i, reference) => areaEquals(scene.screen, reference, 8, line[kind][i], 304, 6);

// ---- the landing page is the picture --------------------------------------------------------------------------------------------
{
  const scene = newScene();
  check("the disk-menu picture is sectors $2CE-$2E4 of the table $8C8C", dm.DISK_MENU_PICTURE.first === 0x2ce && dm.DISK_MENU_PICTURE.last === 0x2e4);
  check("landing page: the picture has the original 38-byte patterned prompt erases and unchanged palette", scene.screen.pixels.every((v, i) => v === picture.pixels[i]) && JSON.stringify(scene.screen.palette) === JSON.stringify(picture.palette));
  check("nothing is open, nothing is printed, nothing is pressed", !scene.listOpen && scene.highlighted === -1 && scene.pressedIcon === -1 && scene.shownPrompt.join() === "0,0" && scene.shownInfo.join() === "0,0" && scene.infoFramesLeft === 0);
  check("nine inclusive 32 x 32 rectangles right of the list; indexes follow the table", dm.DISK_MENU_BUTTONS.length === 9 && dm.DISK_MENU_BUTTONS.every((r) => r.x1 - r.x0 === 31 && r.y1 - r.y0 === 31 && r.x0 > ms.MUSIC_LIST.x1) && dm.diskButtonAt(208, 24) === 0 && dm.diskButtonAt(239, 55) === 0 && dm.diskButtonAt(240, 55) === -1 && dm.diskButtonAt(239, 56) === -1 && dm.diskButtonAt(160, 70) === 7 && dm.diskButtonAt(287, 147) === 5);
  frame(scene, false, LIST_X, rowY(2));
  check("the hover test only exists while a list is open: no bar on the closed panel", scene.highlighted === -1 && scene.screen.pixels.every((v, i) => v === picture.pixels[i]));
  frame(scene, true, LIST_X, rowY(2));
  check("a press on the closed list panel does nothing (no row, no flip)", frame(scene, false, LIST_X, rowY(2)) === null && scene.pressedIcon === -1 && scene.screen.pixels.every((v, i) => v === picture.pixels[i]));
}
{
  const scene = new dm.DiskMenuScene(disk1, strings);
  const held = [1, 2, 3].map(() => frame(scene, true, ...centre(5)));
  check("a button already down when the menu opens gives no flip, no click and no result", held.every((r) => r === null) && scene.pressedIcon === -1 && frame(scene, false, ...centre(5)) === null);
}

// ---- pressed icons: 32 x 32, plane 3, once -----------------------------------------------------------------------------------------
for (let i = 0; i < 9; i++) {
  const r = dm.DISK_MENU_BUTTONS[i];
  const clicks = [];
  const scene = newScene({ onButtonPress: (n) => clicks.push(n) });
  const plain = scene.screen.pixels.slice();
  const [cx, cy] = centre(i);
  frame(scene, false, cx, cy);
  const pressResult = frame(scene, true, cx, cy);
  let flipped = 0;
  let exact = true;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      const inside = x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
      const now = px(scene.screen, x, y);
      const was = plain[y * 320 + x];
      if (inside ? now !== (was ^ dm.ICON_FLIP_COLOR) : now !== was) exact = false;
      if (now !== was) flipped++;
    }
  }
  check(`icon ${i}: the press flips exactly its 32 x 32 rectangle by colour ^ 8 (plane 3), click requested once`, pressResult === null && exact && flipped === 1024 && scene.pressedIcon === i && clicks.join() === String(i));
  frame(scene, true, cx, cy);
  frame(scene, true, cx, cy);
  check(`icon ${i}: holding adds no click and keeps the flip`, clicks.length === 1 && scene.pressedIcon === i);
  const release = frame(scene, false, cx, cy);
  check(`icon ${i}: the release restores the picture exactly and reports the icon`, release && release.kind === "icon" && release.index === i && scene.screen.pixels.every((v, k) => v === plain[k]) && scene.pressedIcon === -1 && clicks.length === 1);
  check(`icon ${i}: the result is not repeated`, rest(scene) === null);
}
{
  // The corners show it is not the 16 x 16 button flip of $57D6.
  const scene = newScene();
  const r = dm.DISK_MENU_BUTTONS[3];
  const plain = scene.screen.pixels.slice();
  frame(scene, true, r.x0 + 1, r.y0 + 1);
  check("pressed icon 3: first and last pixel, and the far corner, are flipped; the pixel just outside is not", [[r.x0, r.y0], [r.x1, r.y1], [r.x0 + 17, r.y0 + 17], [r.x1, r.y0]].every(([x, y]) => px(scene.screen, x, y) === (plain[y * 320 + x] ^ 8)) && px(scene.screen, r.x1 + 1, r.y0) === plain[r.y0 * 320 + r.x1 + 1] && px(scene.screen, r.x0, r.y1 + 1) === plain[(r.y1 + 1) * 320 + r.x0]);
}

// ---- press / release rules ($7F72-$7FE4) ----------------------------------------------------------------------------------------
{
  const clicks = [];
  const scene = newScene({ onButtonPress: (n) => clicks.push(n) });
  const plain = scene.screen.pixels.slice();
  frame(scene, true, ...centre(4));
  check("press on icon 4, move onto icon 5: the flip stays on icon 4 and icon 5 is untouched", frame(scene, true, ...centre(5)) === null && scene.pressedIcon === 4 && areaEquals(scene.screen, plain, dm.DISK_MENU_BUTTONS[5].x0, dm.DISK_MENU_BUTTONS[5].y0, 32, 32));
  const r = frame(scene, false, ...centre(8));
  check("released over icon 8: the action is the RECORDED icon 4, and only one click was requested", r && r.kind === "icon" && r.index === 4 && clicks.join() === "4" && scene.screen.pixels.every((v, i) => v === plain[i]));
}
{
  const clicks = [];
  const scene = newScene({ onButtonPress: (n) => clicks.push(n) });
  const plain = scene.screen.pixels.slice();
  frame(scene, true, 10, 10);
  frame(scene, true, ...centre(5));
  check("a press on blank picture moved onto an icon: nothing is flipped, no click, no result", scene.pressedIcon === -1 && clicks.length === 0 && frame(scene, false, ...centre(5)) === null && scene.screen.pixels.every((v, i) => v === plain[i]));
  const second = [];
  const again = newScene({ onButtonPress: (n) => second.push(n) });
  frame(again, true, 270, 130);
  frame(again, false, 270, 130);
  frame(again, true, 270, 130);
  frame(again, false, 270, 130);
  check("every press clicks once: two presses, two clicks, two results", second.join() === "5,5");
  const blank = newScene({ onButtonPress: (n) => second.push(n) });
  second.length = 0;
  frame(blank, true, 100, 190);
  frame(blank, false, 100, 190);
  check("a press that hits no rectangle never requests the click", second.length === 0);
}

// ---- the shared list ($1006, $8132, $818C, $82B8, $110A) ----------------------------------------------------------------------------
{
  const scene = newScene();
  check("openMusicList(true): the list opens, the prompt $190 is the first prompt line, no result line", scene.openMusicList(true) === true && scene.listOpen && scene.shownPrompt.join() === "400,0" && scene.shownInfo.join() === "0,0");
  check("the prompt is drawn at y $A3 and nothing else of the message areas changes", !lineEquals(scene, "prompt", 0, picture) && lineEquals(scene, "prompt", 1, picture) && lineEquals(scene, "info", 0, picture) && lineEquals(scene, "info", 1, picture));
  const rowsDrawn = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((row) => !areaEquals(scene.screen, picture, ms.MUSIC_LIST.labelX, 0x20 + 9 * row, 56, 6));
  check("the labels of rows 0-3 are drawn on the panel; the blank rows 4-9 draw nothing visible", rowsDrawn.slice(0, 4).every(Boolean) && rowsDrawn.slice(4).every((d) => !d));
  check("an icon is untouched by the list", areaEquals(scene.screen, picture, 208, 24, 32, 32) && areaEquals(scene.screen, picture, 160, 116, 32, 32));
  const plain = scene.screen.pixels.slice();
  frame(scene, false, LIST_X, rowY(2));
  const top = 0x20 + 18;
  check("hover highlights row 2: bar of colour 7, 88 x 6 from x $38", scene.highlighted === 2 && px(scene.screen, 0x38, top) === 7 && px(scene.screen, 0x38 + 87, top + 5) === 7 && px(scene.screen, 0x38 + 88, top) === plain[top * 320 + 0x38 + 88] && px(scene.screen, 0x38, top + 6) === plain[(top + 6) * 320 + 0x38]);
  frame(scene, false, 0x90, rowY(2));
  check("leaving the bounds clears the bar", scene.highlighted === -1 && scene.screen.pixels.every((v, i) => v === plain[i]));
}
{
  // Click: the row of the press, the action after the release, wherever the pointer is by then.
  const scene = newScene();
  scene.openMusicList(true);
  frame(scene, false, LIST_X, rowY(1));
  check("press on row 1: no result yet, no click, no flip", frame(scene, true, LIST_X, rowY(1)) === null && scene.pressedIcon === -1);
  check("held while the pointer moves to row 3: still waiting", frame(scene, true, LIST_X, rowY(3)) === null);
  const r = frame(scene, false, 0x90, 150);
  check("release outside the list: row 1 -> track 1, and the list closes ($8A46 -> $82B8)", r && r.kind === "track" && r.track === 1 && !scene.listOpen && scene.shownPrompt.join() === "0,0" && scene.screen.pixels.every((v, i) => v === picture.pixels[i]));
  check("no result is repeated", rest(scene) === null);
}
{
  const clicks = [];
  const scene = newScene({ onButtonPress: (n) => clicks.push(n) });
  const run = (row) => {
    scene.openMusicList(true);
    frame(scene, false, LIST_X, rowY(row));
    frame(scene, true, LIST_X, rowY(row));
    return frame(scene, false, LIST_X, rowY(row));
  };
  check("rows 0-3 give tracks 0-3 and close the list", [0, 1, 2, 3].every((row) => { const r = run(row); return r && r.kind === "track" && r.track === row && !scene.listOpen; }));
  check("rows 4-9 close the list without a track", [4, 5, 6, 7, 8, 9].every((row) => { const r = run(row); return r && r.kind === "listClosed" && !scene.listOpen; }));
  check("list rows are not buttons: no click for any of them", clicks.length === 0);
  scene.openMusicList(true);
  frame(scene, false, 0x89, rowY(1));
  frame(scene, true, 0x89, rowY(1));
  check("press just right of the list, release inside it: nothing", frame(scene, false, LIST_X, rowY(1)) === null && scene.listOpen);
  frame(scene, true, LIST_X, 0x7a);
  check("press just below the last row: nothing", frame(scene, false, LIST_X, 0x7a) === null && scene.listOpen);
}
{
  // Icon 7 over an open list: $1006 starts with $82B8, then redraws: the list is open again with a fresh prompt.
  const scene = newScene();
  scene.openMusicList(true);
  scene.printInfo(0, 0x193);
  scene.openMusicList(true);
  check("opening again keeps one list and one prompt; the result line stays", scene.listOpen && scene.shownPrompt.join() === "400,0" && scene.shownInfo.join() === "0,403");
  check("without expansion memory: $197 in the second result line, the list stays closed", (() => { const s = newScene(); s.openMusicList(true); return s.openMusicList(false) === false && !s.listOpen && s.shownInfo.join() === "0,407" && s.shownPrompt.join() === "0,0"; })());
}

// ---- message areas ($83A2, $8462) and their countdown ($8CB0) ------------------------------------------------------------------------
{
  const scene = newScene();
  scene.openMusicList(true);
  const prompted = scene.screen.pixels.slice();
  scene.printInfo(0, ms.MUSIC_TOGGLE_STRING.off);
  check("a result string goes to the SECOND result line (y $BE); the prompt line $A3 is untouched and still shown", scene.shownInfo.join() === "0,403" && scene.shownPrompt.join() === "400,0" && !lineEquals(scene, "info", 1, prompted) && lineEquals(scene, "info", 0, prompted) && lineEquals(scene, "prompt", 0, prompted));
  check("the countdown starts at INFO_LIFETIME_FRAMES (HYPOTHESIS: 50 frames for the traced 20000 loop iterations)", scene.infoFramesLeft === dm.INFO_LIFETIME_FRAMES && dm.INFO_LIFETIME_FRAMES === 50);
  scene.printInfo(0x18a, 0);
  check("$83A2 with d1 = 0 prints only the first line and leaves the second as it was", scene.shownInfo.join() === "394,403" && scene.infoFramesLeft === dm.INFO_LIFETIME_FRAMES);
  rest(scene, 10);
  scene.printInfo(0, ms.MUSIC_TOGGLE_STRING.on);
  check("a new print replaces that line and restarts the countdown", scene.shownInfo.join() === "394,402" && scene.infoFramesLeft === dm.INFO_LIFETIME_FRAMES);
  rest(scene, dm.INFO_LIFETIME_FRAMES - 1);
  check("one frame before the end the lines are still there", scene.shownInfo.join() === "394,402" && scene.infoFramesLeft === 1);
  rest(scene);
  const resultErased = erasePattern(erasePattern(prompted, 0xb5, dm.MESSAGE_AREA.info.printBytes), 0xbe, dm.MESSAGE_AREA.info.printBytes);
  check("at the end both result lines use the 37-byte pattern erase (the prompt stays: it belongs to the list)", scene.shownInfo.join() === "0,0" && lineEquals(scene, "info", 0, resultErased) && lineEquals(scene, "info", 1, resultErased) && scene.shownPrompt.join() === "400,0" && scene.screen.pixels.every((v, i) => v === resultErased[i]));
  scene.printInfo(0, ms.MUSIC_TOGGLE_STRING.off);
  scene.closeList();
  check("closing the list clears the prompt but not the result line or its countdown ($82B8 / $84F4)", scene.shownPrompt.join() === "0,0" && scene.shownInfo.join() === "0,403" && scene.infoFramesLeft === dm.INFO_LIFETIME_FRAMES && lineEquals(scene, "prompt", 0, picture));
}
{
  const scene = newScene();
  scene.printRemakeNote("remake: no disk to format");
  check("REMAKE ONLY: remake text goes to the second result line, marked as not an original string, with the same countdown", scene.shownInfo.join() === "0,-1" && !lineEquals(scene, "info", 1, picture) && lineEquals(scene, "info", 0, picture) && scene.infoFramesLeft === dm.INFO_LIFETIME_FRAMES);
  rest(scene, dm.INFO_LIFETIME_FRAMES);
  const remakeNoteErased = erasePattern(erasePattern(picture.pixels, 0xb5, dm.MESSAGE_AREA.info.printBytes), 0xbe, dm.MESSAGE_AREA.info.printBytes);
  check("it vanishes to the original 37-byte result-line erase pattern", scene.shownInfo.join() === "0,0" && scene.screen.pixels.every((v, i) => v === remakeNoteErased[i]));
}

// ---- the right button: remake only ---------------------------------------------------------------------------------------------------
{
  const scene = newScene();
  check("landing page: a right press asks for the remake submenu", frame(scene, false, 10, 10, true)?.kind === "remake");
  check("a held right button does not repeat it", frame(scene, false, 10, 10, true) === null && frame(scene, false, 10, 10, true) === null);
  rest(scene);
  check("a new right press does", frame(scene, false, 10, 10, true)?.kind === "remake");
  scene.openMusicList(true);
  rest(scene);
  const r = frame(scene, false, LIST_X, rowY(1), true);
  check("with the list open a right press closes it first (no track, no submenu)", r && r.kind === "listClosed" && !scene.listOpen && scene.screen.pixels.every((v, i) => v === picture.pixels[i]));
  check("the right press that closed the list does not also open the submenu while held", frame(scene, false, LIST_X, rowY(1), true) === null);
  const held = new dm.DiskMenuScene(disk1, strings);
  check("a right button already down when the menu opens is ignored until released and pressed again", frame(held, false, 0, 0, true) === null && frame(held, false, 0, 0, true) === null && (rest(held), frame(held, false, 0, 0, true)?.kind === "remake"));
}

// `$7F80` skips left-button edges while the right button is held; the remake keeps right-click navigation.
{
  const clicks = [];
  const scene = newScene({ onButtonPress: (n) => clicks.push(n) });
  const result = frame(scene, true, ...centre(4), true);
  check("simultaneous left and right on the landing page runs only the remake right-click action", result?.kind === "remake" && scene.pressedIcon === -1 && clicks.length === 0);
  frame(scene, false, ...centre(4), true);
  check("the suppressed left edge is consumed and does not activate after right release", frame(scene, false, ...centre(4)) === null && clicks.length === 0);
}
{
  const scene = newScene();
  scene.openMusicList(true);
  const result = frame(scene, true, LIST_X, rowY(1), true);
  check("simultaneous left and right on a music row closes the list without selecting a track", result?.kind === "listClosed" && !scene.listOpen);
  frame(scene, false, LIST_X, rowY(1), true);
  check("the suppressed row edge does not select a track after right release", frame(scene, false, LIST_X, rowY(1)) === null);
}

if (failed) {
  console.log(`${failed} disk-menu check(s) FAILED`);
  process.exit(1);
}
console.log("disk-menu checks passed");
