// Icon 2's second-press wait and the held press that can pick a row (src/game/game.ts `awaitScenarioPress`, `waitForScenarioPress`;
// src/game/menu.ts `MenuOptions.pressPending`; notes/formats/game-proper.md, "Opening click and the held press").
// Static trace (Disk.1, raw bytes): `$8632` calls `$855A`, which prints `$13B` (string 315, "Insert scenario disk in internal drive and
// click mouse button..") and waits in `$2E48` (`btst.b #6,$bfe001`, a raw poll for the left button DOWN: no latch, no `$50B2`, no
// right-button read). The list opens after that press. The loop's first `$50B2` then sees a press still held (the icon release cleared
// the latch) and `$7FCE` picks the row under the press on its release. A press released before that first poll picks nothing.
// The remake's list setup has no measured duration, so "the first poll" is the page's first update: an update approximation.
// Real Game.update clicks throughout. Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("scenario-wait tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_LIST_GEOMETRY, DISK_MENU_BUTTONS, INFO_LIFETIME_FRAMES, SCENARIO_LOADED_STRING, SCENARIO_OPEN_STRING, SCENARIO_WAIT_STRING } = await import("../dist/game/disk-menu.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A started game proper (scenario 0, boot session closed) with its disk menu open: the state the map's icon 2 is clicked in.
const newGame = () => {
  const g = new Game(disk1, disk2, null, null);
  g.strings = strings;
  g.bootMenuOpen = false;
  g.startScenario(0);
  g.openDiskMenu();
  return g;
};
let game = newGame();

const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const frame = (down, x = 0, y = 0, right = false) => {
  input.leftButton = down;
  input.rightButton = right;
  input.pointerX = x;
  input.pointerY = y;
  game.update({ ...input });
};
const idle = () => frame(false, 0, 0);
const centre = (i) => [DISK_MENU_BUTTONS[i].x0 + 16, DISK_MENU_BUTTONS[i].y0 + 16];
// Row r of the scenario list (the original list geometry: y = $20 + 9 r; x inside the list bounds $38..$88).
const rowY = (row) => DISK_LIST_GEOMETRY.y0 + row * DISK_LIST_GEOMETRY.pitch + 4;
const ROW_X = 100;
// Icon 2 as the user makes it: a press on the icon, a second frame held, and the release that runs `$59C8` -> `$7FE4`.
const iconClick = (i = DISK_BUTTON.scenario) => {
  idle();
  const [x, y] = centre(i);
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
};
// One fresh left click on a row, released on the same row.
const tapRow = (row) => {
  idle();
  frame(true, ROW_X, rowY(row));
  frame(false, ROW_X, rowY(row));
};

// Guarded accessors: a missing disk menu reports FAIL lines rather than throwing. The scenario list is the disk picture's list (mode 3).
const menu = () => game.diskMenu;
const diskPrompt = () => (menu() ? menu().shownPrompt.join() : "no disk menu");
const pagePrompt = () => (menu() ? menu().promptCodes?.join() ?? "none" : "no disk menu");
const WAIT_PROMPT = `${SCENARIO_WAIT_STRING},0`; // "315,0"
const OPEN_PROMPT = strings.get(SCENARIO_OPEN_STRING).join(); // $13D: the list prompt when the page opens ($865A)
const PICK_PROMPT = strings.get(SCENARIO_LOADED_STRING).join(); // the page prompt shows the message codes ($8B, string 139)
const onWait = () => game.stage === "disk" && menu() !== null && !menu().listOpen && game.heldScene === null && diskPrompt() === WAIT_PROMPT;
const onPage = () => game.stage === "scenario" && menu() !== null && menu().listKind === "scenario";

// ---- 1. The icon's release opens the wait, not the list; prompt transitions --------------------------------------------------------
game = newGame();
idle();
check("before icon 2 the disk menu has no prompt line (0,0)", diskPrompt() === "0,0", `prompt ${diskPrompt()}`);
iconClick();
check("icon 2's release prints $13B on the disk menu's prompt and opens no list (the wait)", onWait(), `stage ${game.stage} prompt ${diskPrompt()}`);
check("the wait's prompt string is the traced $13B (string 315)", SCENARIO_WAIT_STRING === 0x13b);

// ---- 2. Opening click cannot select: icon pressed, dragged and released over row 2 ---------------------------------------------
game = newGame();
idle();
const [cx, cy] = centre(DISK_BUTTON.scenario);
frame(true, cx, cy);
frame(true, cx, cy);
frame(true, ROW_X, rowY(2));
frame(false, ROW_X, rowY(2));
check("the icon's press dragged over row 2 and released there: the wait is shown, nothing is held or picked", onWait(), `stage ${game.stage} prompt ${diskPrompt()}`);
for (let i = 0; i < 10; i++) idle();
check("ten idle frames of the wait pick nothing and keep the $13B line", onWait(), `stage ${game.stage} prompt ${diskPrompt()}`);
// The wait ignores the right button (`$2E48` reads only the left one): no remake submenu, nothing changes.
frame(false, 0, 0, true);
idle();
check("a right click during the wait is not read: still waiting on $13B, no remake submenu", onWait() && game.menu === null, `stage ${game.stage}`);

// ---- 3. Post-open held press selects on release: a second press opens the list, held at its first poll, picks on release ----------
game = newGame();
iconClick();
frame(true, ROW_X, rowY(2)); // the second press: its edge opens the page (the press is not yet read by the list)
check("the second press opens the scenario list on the disk picture with nothing picked yet", onPage() && game.heldScene === null && game.menu === null);
check("the list's prompt is $13D while the press is pending (the list prompt, no $13B or $8B line)", pagePrompt() === OPEN_PROMPT, `prompt ${pagePrompt()}`);
frame(true, ROW_X, rowY(2)); // the page's first poll: still held over row 2, so row 2 is armed
check("held through the first poll over row 2: still nothing picked (the release picks)", game.stage === "scenario" && game.heldScene === null);
frame(false, ROW_X, rowY(2));
check("the release picks scenario 2 (row 2): held index 2, the list stays open", onPage() && game.heldScene?.index === 2, `held ${game.heldScene?.index}`);
check("after the pick the list shows the $8B prompt", pagePrompt() === PICK_PROMPT, `prompt ${pagePrompt()}`);

// ---- 4. The row is the one under the press at the first poll, not the one under the release -------------------------------------
game = newGame();
iconClick();
frame(true, ROW_X, rowY(2));
frame(true, ROW_X, rowY(2));
frame(true, ROW_X, rowY(5));
frame(false, ROW_X, rowY(5));
check("held over row 2 at the first poll, released over row 5: scenario 2 is picked, not row 5", game.heldScene?.index === 2, `held ${game.heldScene?.index}`);

// The press that is held at the first poll with the pointer off the rows arms nothing; moving onto a row before the release picks nothing.
game = newGame();
iconClick();
frame(true, 0, 0);
frame(true, 0, 0);
frame(true, ROW_X, rowY(4));
frame(false, ROW_X, rowY(4));
check("a press off the rows at the first poll arms nothing: a later move onto row 4 and the release pick nothing", onPage() && game.heldScene === null, `held ${game.heldScene?.index}`);

// ---- 5. A press released before the first poll picks nothing (the already-released click), and the page then works normally ---------
game = newGame();
iconClick();
frame(true, ROW_X, rowY(2)); // the press opens the page
frame(false, ROW_X, rowY(2)); // released before the page's first poll
check("a press released before the first list poll picks nothing (no held scene, still on the list)", onPage() && game.heldScene === null && pagePrompt() === OPEN_PROMPT, `held ${game.heldScene?.index}`);
for (let i = 0; i < 10; i++) idle();
check("the list keeps picking nothing without a new press", onPage() && game.heldScene === null);
tapRow(3);
check("a later fresh click on row 3 picks scenario 3 (the list is live)", game.heldScene?.index === 3 && pagePrompt() === PICK_PROMPT, `held ${game.heldScene?.index}`);

// ---- 6. Result lines still count down during the wait (the wait runs no update of the disk menu, so it ticks the countdown itself) -
game = newGame();
game.diskMenu.printRemakeNote("REMAKE: TEST LINE");
check("a result line is printed on the disk menu before icon 2", game.diskMenu.infoFramesLeft === INFO_LIFETIME_FRAMES && game.diskMenu.shownInfo[1] === -1);
iconClick();
let waited = 0;
while (game.diskMenu !== null && game.diskMenu.infoFramesLeft > 0 && waited < INFO_LIFETIME_FRAMES + 5) {
  idle();
  waited++;
}
check("the result line expires while the wait runs (still waiting on $13B, no list)", onWait() && game.diskMenu.infoFramesLeft === 0 && game.diskMenu.shownInfo.join() === "0,0", `waited ${waited} left ${game.diskMenu?.infoFramesLeft}`);

// ---- 7. Last-selection EXIT: after picks on the open list, EXIT enters the last pick, once ---------------------------------------
game = newGame();
iconClick();
frame(true, ROW_X, rowY(1));
frame(true, ROW_X, rowY(1));
frame(false, ROW_X, rowY(1));
check("first pick (row 1, scenario 1) holds it and keeps the list open with $8B", game.heldScene?.index === 1 && onPage() && pagePrompt() === PICK_PROMPT);
tapRow(2);
check("a second pick (row 2) replaces the held scene; the list is still open", game.heldScene?.index === 2 && onPage());
const heldMap = game.heldScene.map;
iconClick(DISK_BUTTON.exit); // icon 5 (`$802C`) leaves the list directly: the list has no EXIT row
check("EXIT (icon 5) enters the LAST selection (scenario 2) once: stage map, nothing held, the list gone", game.stage === "map" && game.scenario === 2 && game.heldScene === null && game.diskMenu === null && game.map === heldMap, `stage ${game.stage} scenario ${game.scenario}`);
check("the replaced scenario (1) never runs: the entered scene has its single immediate pass", heldMap.loop.passes === 1 && heldMap.loop.immediatePassPending === false, `passes ${heldMap.loop.passes}`);

console.log(failed === 0 ? "all scenario wait checks passed" : `${failed} scenario wait check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
