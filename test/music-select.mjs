// Headless checks of the music-select list on the shared disk-menu scene (src/game/music-select.ts, src/game/disk-menu.ts): geometry
// of the hit test $8132, the highlight bar $818C, the row labels ($1530), the prompt, the press/release timing of the click handler
// ($7F72-$7FDC: the row is the one under the pointer at the press, the action runs after the release) and the music on/off handler
// $1062 (rules and message area). Static trace only, see notes/formats/music.md. The scene's own pixels and input rules (pressed
// icons, message areas, countdown, right button) are in test/disk-menu.mjs.
// Uses the user's own Disk.1 in original/utopia-whdload (read-only); skipped when it is missing. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("music-select tests skipped: original/utopia-whdload/Disk.1 not found");
  process.exit(0);
}

const ms = await import("../dist/game/music-select.js");
const dm = await import("../dist/game/disk-menu.js");
const { readMusicLabels } = await import("../dist/data/gameimage.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { decodePicture } = await import("../dist/data/picture.js");
const { Screen } = await import("../dist/gfx/screen.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- geometry ($8132) ----------------------------------------------------------------------------------------------------
const { musicRowAt, MUSIC_LIST, MUSIC_TRACK_ROWS } = ms;
const { diskButtonAt, DISK_MENU_BUTTONS } = dm;
check("list bounds: x $38..$88, y $20..$79 inclusive", musicRowAt(0x38, 0x20) === 0 && musicRowAt(0x88, 0x20) === 0 && musicRowAt(0x37, 0x20) === -1 && musicRowAt(0x89, 0x20) === -1 && musicRowAt(0x38, 0x1f) === -1 && musicRowAt(0x38, 0x79) === 9 && musicRowAt(0x38, 0x7a) === -1);
check("row = floor((y - $20) / 9)", musicRowAt(0x40, 0x28) === 0 && musicRowAt(0x40, 0x29) === 1 && musicRowAt(0x40, 0x20 + 9 * 4) === 4 && musicRowAt(0x40, 0x20 + 9 * 4 - 1) === 3 && musicRowAt(0x40, 0x20 + 9 * 9) === 9);
check("ten rows, rows below 4 are tracks", MUSIC_LIST.rows === 10 && MUSIC_TRACK_ROWS === 4 && MUSIC_LIST.pitch === 9);

// ---- the nine icon rectangles ($8CB4, hit test $5730 inclusive; full checks in test/disk-menu.mjs) -------------------------------------
check("nine icon rectangles, 32 x 32 each, none over the list", DISK_MENU_BUTTONS.length === 9 && DISK_MENU_BUTTONS.every((r) => r.x1 - r.x0 === 31 && r.y1 - r.y0 === 31 && r.x0 > MUSIC_LIST.x1));
check("icon hit test is inclusive on all sides", diskButtonAt(208, 24) === 0 && diskButtonAt(239, 55) === 0 && diskButtonAt(240, 55) === -1 && diskButtonAt(239, 56) === -1 && diskButtonAt(207, 24) === -1);
check("icon indexes follow the table: 5 = (256,116), 7 = (160,70), 8 = (160,116), 6 = (160,24)", diskButtonAt(256, 116) === 5 && diskButtonAt(160, 70) === 7 && diskButtonAt(160, 116) === 8 && diskButtonAt(160, 24) === 6 && diskButtonAt(287, 147) === 5);

// ---- labels from the game image ($1530) ----------------------------------------------------------------------------------------
const labels = readMusicLabels(disk1);
const printable = (row) => row.every((c) => c >= 0x20 && c < 0x7f);
check("ten label rows of at most 7 characters", labels.length === 10 && labels.every((r) => r.length <= 7 && printable(r)));
check("rows 0-3 are named and distinct", labels.slice(0, 4).every((r) => r.some((c) => c !== 0x20)) && new Set(labels.slice(0, 4).map((r) => r.join())).size === 4);
check("rows 4-9 are blank (spaces only)", labels.slice(4).every((r) => r.every((c) => c === 0x20)));

// ---- picture, highlight, prompt ------------------------------------------------------------------------------------------------
const background = decodePicture(disk1, dm.DISK_MENU_PICTURE, new Screen());
const at = (screen, x, y) => screen.pixels[y * 320 + x];
const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const frame = (scene, down, x, y, right = false) => {
  input.leftButton = down;
  input.rightButton = right;
  input.pointerX = x;
  input.pointerY = y;
  return scene.update(input);
};
const rowY = (row) => 0x20 + 9 * row + 2;
// A scene with the list opened by icon 7 ($1006), the opening click consumed.
const openList = (options) => {
  const scene = new dm.DiskMenuScene(disk1, strings, options);
  frame(scene, false, 0, 0);
  scene.openMusicList(true);
  return scene;
};

{
  const scene = openList();
  check("the disk-menu picture is the background (palette copied)", scene.screen.palette.length === 32 && JSON.stringify(scene.screen.palette) === JSON.stringify(background.palette));
  check("the prompt (string $190) is drawn in the message area", strings.get(ms.MUSIC_PROMPT_STRING).length > 0 && scene.shownPrompt[0] === ms.MUSIC_PROMPT_STRING && (() => {
    for (let y = 0xa3; y < 0xa3 + 6; y++) for (let x = 8; x < 120; x++) if (at(scene.screen, x, y) !== at(background, x, y)) return true;
    return false;
  })());
  check("an icon area of the picture stays untouched", at(scene.screen, 220, 40) === at(background, 220, 40) && at(scene.screen, 270, 130) === at(background, 270, 130));

  const plain = scene.screen.pixels.slice();
  check("no row is highlighted at the start", scene.highlighted === -1);
  frame(scene, false, 0x40, rowY(2));
  const top = 0x20 + 9 * 2;
  check("hover highlights row 2 with a bar of colour 7, 88 x 6", scene.highlighted === 2 && at(scene.screen, 0x38, top) === 7 && at(scene.screen, 0x38 + 87, top + 5) === 7 && at(scene.screen, 0x38, top + 3) === 7);
  check("the bar stops at its 6 scanlines and 88 pixels", at(scene.screen, 0x38, top + 6) === plain[(top + 6) * 320 + 0x38] && at(scene.screen, 0x38 + 88, top) === plain[top * 320 + 0x38 + 88] && at(scene.screen, 0x38, top - 1) === plain[(top - 1) * 320 + 0x38]);
  frame(scene, false, 0x40, rowY(5));
  check("moving to another row moves the bar", scene.highlighted === 5 && at(scene.screen, 0x38, top + 3) === plain[(top + 3) * 320 + 0x38] && at(scene.screen, 0x38, 0x20 + 9 * 5 + 1) === 7);
  frame(scene, false, 0x90, rowY(5));
  check("leaving the bounds clears the highlight", scene.highlighted === -1 && at(scene.screen, 0x38, 0x20 + 9 * 5 + 1) === plain[(0x20 + 9 * 5 + 1) * 320 + 0x38]);
}

// ---- click timing ($7F72-$7FDC) -------------------------------------------------------------------------------------------------
{
  // Track row: nothing on the press, the action after the release, at the row of the PRESS.
  const scene = openList();
  frame(scene, false, 0x40, rowY(1));
  check("press on row 1: no action yet", frame(scene, true, 0x40, rowY(1)) === null);
  check("held while the pointer moves to row 3: still waiting", frame(scene, true, 0x40, rowY(3)) === null);
  const r = frame(scene, false, 0x90, 150); // released outside the list
  check("release runs the row of the press (row 1 -> track 1), wherever the pointer is", r && r.kind === "track" && r.track === 1, JSON.stringify(r));
  check("the result is not repeated", frame(scene, false, 0x40, rowY(1)) === null);
}
{
  const scene = openList();
  const run = (row) => {
    scene.openMusicList(true);
    frame(scene, false, 0x40, rowY(row));
    frame(scene, true, 0x40, rowY(row));
    return frame(scene, false, 0x40, rowY(row));
  };
  check("rows 0-3 give tracks 0-3", [0, 1, 2, 3].every((row) => { const r = run(row); return r && r.kind === "track" && r.track === row; }));
  check("rows 4-9 give 'listClosed' (list closes, no track)", [4, 5, 6, 7, 8, 9].every((row) => { const r = run(row); return r && r.kind === "listClosed" && !scene.listOpen; }));
}
{
  // Presses that do not begin on a row do nothing.
  const scene = openList();
  frame(scene, false, 0x89, rowY(1)); // button up first, so the next frame is a real press edge
  frame(scene, true, 0x89, rowY(1)); // just right of the list
  check("press outside the list, release inside: nothing", frame(scene, false, 0x40, rowY(1)) === null);
  frame(scene, true, 0x40, 0x7a); // just below the last row
  check("press below the last row: nothing", frame(scene, false, 0x40, 0x7a) === null);
}
{
  // The click that opened the menu is ignored, even if it is still held.
  let presses = 0;
  const scene = new dm.DiskMenuScene(disk1, strings, { onButtonPress: () => presses++ });
  scene.openMusicList(true);
  const held = [1, 2, 3].map(() => frame(scene, true, 0x40, rowY(1)));
  const release = frame(scene, false, 0x40, rowY(1));
  check("a button already down when the menu opens gives no result and no click", held.every((x) => x === null) && release === null && presses === 0);
}
{
  // Icons over the open list: the click is requested on the press, the result arrives on the release.
  const presses = [];
  const scene = openList({ onButtonPress: (i) => presses.push(i) });
  frame(scene, false, 270, 130);
  check("icon press: click callback now, no result", frame(scene, true, 270, 130) === null && presses.join() === "5");
  frame(scene, true, 270, 130);
  const r = frame(scene, false, 10, 10); // release elsewhere
  check("icon release: result for the pressed icon (5), wherever the pointer is; the list stays open until the caller decides", r && r.kind === "icon" && r.index === 5 && presses.length === 1 && scene.listOpen, JSON.stringify(r));
  frame(scene, true, 170, 130);
  const r2 = frame(scene, false, 170, 130);
  check("icon 8 (effects)", r2 && r2.kind === "icon" && r2.index === 8 && presses.join() === "5,8");
}
{
  const scene = openList();
  const r = frame(scene, false, 0x40, rowY(1), true);
  check("right button: remake only, closes the list and does not choose a track", r && r.kind === "listClosed" && !scene.listOpen);
}

// ---- music on/off icon ($1062, icon 4) ------------------------------------------------------------------------------------------
{
  const { MUSIC_TOGGLE_STRING, toggleMusic } = ms;
  const { DISK_BUTTON } = dm;
  check("icon 4 is the music on/off button at (208..239, 116..147)", DISK_BUTTON.music === 4 && diskButtonAt(208, 116) === 4 && diskButtonAt(239, 147) === 4 && DISK_BUTTON.exit === 5);
  check("message strings are $197 / $196 / $192 / $193", MUSIC_TOGGLE_STRING.unavailable === 0x197 && MUSIC_TOGGLE_STRING.noMusic === 0x196 && MUSIC_TOGGLE_STRING.on === 0x192 && MUSIC_TOGGLE_STRING.off === 0x193);

  const state = (current, active) => ({ current, active, calls: [], setActive(on) { this.calls.push(on); this.active = on; return true; } });
  const none = state(-1, false);
  check("no expansion memory (no Music): $197, nothing to change", toggleMusic(null) === 0x197);
  check("inactive with no track loaded: $196 and the state is untouched", toggleMusic(none) === 0x196 && none.calls.length === 0 && none.active === false && none.current === -1);
  const paused = state(2, false);
  check("inactive with a track: switched on without reloading, $192", toggleMusic(paused) === 0x192 && paused.calls.join() === "true" && paused.active === true && paused.current === 2);
  const playing = state(2, true);
  check("active: switched off, $193, the selection stays", toggleMusic(playing) === 0x193 && playing.calls.join() === "false" && playing.active === false && playing.current === 2);
  check("toggling twice returns to the start state", toggleMusic(playing) === 0x192 && playing.active === true && playing.calls.join() === "false,true");

  // Scene feedback: the result goes to the second result line (y $BE) and the list prompt ($A3) stays.
  const presses = [];
  const scene = openList({ onButtonPress: (i) => presses.push(i) });
  frame(scene, false, 220, 130);
  check("the prompt $190 is shown first, no result line", scene.shownPrompt[0] === 0x190 && scene.shownInfo.join() === "0,0");
  const prompt = scene.screen.pixels.slice();
  check("icon 4 press: click now, no result, nothing printed", frame(scene, true, 220, 130) === null && presses.join() === "4" && scene.shownInfo.join() === "0,0");
  const r = frame(scene, false, 220, 130);
  check("icon 4 release: icon result 4 (the caller toggles and prints)", r && r.kind === "icon" && r.index === 4 && presses.length === 1);
  for (const [index, name] of [[0x193, "Music Off"], [0x192, "Music on"], [0x196, "No music loaded"], [0x197, "unavailable"]]) {
    const before = scene.screen.pixels.slice();
    scene.printInfo(0, index);
    const area = (px, y) => Array.from(px.slice(y * 320, (y + 6) * 320)).join();
    check(`printInfo(0, $${index.toString(16)}) (${name}): second result line y $BE redrawn, prompt line and picture elsewhere untouched`, scene.shownInfo[1] === index && strings.get(index).length > 0 && area(scene.screen.pixels, 0xbe) !== area(before, 0xbe) && area(scene.screen.pixels, 0xa3) === area(before, 0xa3) && area(scene.screen.pixels, 0xb5) === area(before, 0xb5) && Array.from(scene.screen.pixels.slice(0, 0xb5 * 320)).every((v, i) => v === before[i]));
  }
  check("the prompt is still the list prompt after the messages", scene.shownPrompt[0] === 0x190 && scene.listOpen);
  // The row hover bar keeps working after a message.
  frame(scene, false, 0x40, rowY(2));
  scene.printInfo(0, 0x193);
  check("the highlight survives a message redraw", scene.highlighted === 2 && at(scene.screen, 0x38, 0x20 + 9 * 2 + 1) === 7);
  void prompt;
}

if (failed) {
  console.log(`${failed} music-select check(s) FAILED`);
  process.exit(1);
}
console.log("music-select checks passed");
