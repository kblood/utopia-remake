// The save page after a successful save, for every origin (src/game/game.ts `diskIcon`, `returnFromSave`, `leaveDiskPage`, and
// src/game/menu.ts `MenuScene` in `release` mode). Static trace, Disk.1 raw bytes (2026-11-14; file offset = address + `$28800`;
// notes/formats/game-proper.md "Save tail and return", "Mode-3 icons 0 and 1"):
//   icon 1 (`$856C`): `$855A` erases the prompt (`$84F4`), then `$138` on the save list (`$85B8` -> `$85CA`, "Click on slot to save game into...").
//   a row release (`$7FCE` -> `$2E52` -> `$8CFE`, the row latched at the press) runs `$87DC` -> `$8918` (the name step is not modelled here).
//   the save tail `$89B4`: `$84F4` erases the prompt, `$140` then `$141` ("Save complete.") on the list prompt, `$8CFE` = -1, `rts`. No `$82B8`,
//   so the list stays up in mode 1 with `$141` until a traced erase (`$84F4` / `$82B8`: icon 0/1/2 opening, format, music select, a load pick).
//   EXIT (icon 5, `$802C`) is the only way out of the loop. The remake's save page has an EXIT row after the slots (release-chosen, as the
//   icon is; test/load-page.mjs checks its transitions), and its BACK (right button) still goes to the picture or the list it came from.
// Checked through the real Game.update path (mouse frames). Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only);
// skipped when missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("save-page tests skipped: original data not found");
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
const { DISK_BUTTON, DISK_LIST_GEOMETRY, DISK_MENU_BUTTONS, SAVE_DONE_STRING, SAVE_OPEN_STRING, SCENARIO_LOADED_STRING, SCENARIO_OPEN_STRING } = await import("../dist/game/disk-menu.js");
const { MENU_PANEL } = await import("../dist/game/menu.js");
const { readSlot } = await import("../dist/game/save.js");
const { SYS } = await import("../dist/game/sim.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// Same observable contract as `Music` (test/game-music.mjs), as in test/scenario-icons.mjs.
function fakeMusic() {
  const m = {
    current: -1,
    paused: false,
    trackCount: 4,
    calls: [],
    get active() { return m.current >= 0 && !m.paused; },
    setActive(on) {
      if (m.current < 0 || m.paused === !on) return false;
      m.paused = !on;
      return true;
    },
    play(track, restart = false) {
      m.calls.push({ track, restart });
      if (track < 0 || track >= m.trackCount) return;
      m.current = track;
      m.paused = false;
    },
    stop() { m.current = -1; m.paused = false; },
    fadeOut() {},
    setVolume() {},
    setChannelMuted() {},
    resume() {},
    title: () => "",
    dispose() {},
  };
  return m;
}

const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
let game = null;
const frame = (down, x = 0, y = 0, right = false) => {
  input.leftButton = down;
  input.rightButton = right;
  input.pointerX = x;
  input.pointerY = y;
  game.update({ ...input });
};
const idle = () => frame(false, 0, 0);
const centre = (i) => [DISK_MENU_BUTTONS[i].x0 + 16, DISK_MENU_BUTTONS[i].y0 + 16];
const iconClick = (i) => {
  idle();
  const [x, y] = centre(i);
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
};
const rowY = (row) => DISK_LIST_GEOMETRY.y0 + row * DISK_LIST_GEOMETRY.pitch + 4;
const tapRow = (row) => {
  idle();
  frame(false, 100, rowY(row));
  frame(true, 100, rowY(row));
  frame(false, 100, rowY(row));
};
// Icon 2's wait, then the second press that opens the list (off the rows: it picks nothing).
const openList = () => {
  iconClick(DISK_BUTTON.scenario);
  frame(true, 0, 0);
  frame(false, 0, 0);
};
const rightClick = () => {
  idle();
  frame(false, 0, 0, true);
  idle();
};
// The save page's slot rows: MenuScene rows at `top + 16 + n * row`, x inside the panel.
const SLOT_X = 50;
const slotY = (row) => MENU_PANEL.top + 16 + row * MENU_PANEL.row + 4;
// One fresh left click on slot `row` (press, held, release), as the user does it.
const tapSlot = (row) => {
  idle();
  frame(false, SLOT_X, slotY(row));
  frame(true, SLOT_X, slotY(row));
  frame(false, SLOT_X, slotY(row));
  if (game.stage === "save" && game.nameEntry) {
    // These route tests accept the original's default date with a second click; the editor itself is covered in save-name.mjs.
    idle();
    frame(true, SLOT_X, slotY(row));
    frame(false, SLOT_X, slotY(row));
  }
};
const confirmDefaultName = (row = 0) => {
  idle();
  frame(true, SLOT_X, slotY(row));
  frame(false, SLOT_X, slotY(row));
};
const tapMenuLabel = (text) => {
  const row = game.menu.entries.findIndex((e) => e.label === text);
  if (row < 0) throw new Error(`no menu row "${text}"`);
  tapSlot(row);
};

const sameCells = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const onList = () => game.stage === "scenario" && game.diskMenu?.listKind === "scenario";
const onPicture = () => game.stage === "disk" && game.diskMenu !== null && game.diskMenu.listKind === "closed";
const onSavePage = () => game.stage === "save" && game.menu !== null && game.diskMenu === null;
const statusCodes = () => (game.menu?.promptCodes ? game.menu.promptCodes.join() : "none");
const prompt = () => (game.diskMenu ? game.diskMenu.shownPrompt.join() : "no disk menu");
const SCENARIO_PROMPT = `${SCENARIO_LOADED_STRING},0`;
const SAVED_PROMPT = `${SAVE_DONE_STRING},0`;
const OPEN_STATUS = strings.get(SAVE_OPEN_STRING).join();
const SAVED_STATUS = strings.get(SAVE_DONE_STRING).join();
const slotWritten = (slot) => readSlot(slot).ok;

// A game proper on the picture (scenario 0 started, the boot session closed), no list open.
const pictureGame = (music = null) => {
  game = new Game(disk1, disk2, music, null);
  game.strings = strings;
  game.bootMenuOpen = false;
  game.startScenario(0);
  game.openDiskMenu();
  idle();
  return game;
};
// The scenario list open with one scenario picked (row 1, held), as scenario-icons.mjs builds it.
const listWithPick = (music = null) => {
  pictureGame(music);
  openList();
  tapRow(1);
  return game;
};

storage.clear();

// ---- 1. Picture origin: icon 1 -> `$138` -> a slot -> `$141` on the save page -> BACK to the picture -> EXIT -----------------------
pictureGame();
const livePicture = game.map;
iconClick(DISK_BUTTON.save);
check("icon 1 from the picture opens the save page with the save list's prompt $138 (\"Click on slot to save game into...\")", onSavePage() && statusCodes() === OPEN_STATUS, `stage ${game.stage} status ${statusCodes()}`);
tapSlot(2); // slot 3
check("picture-origin success keeps the save page (not the bare picture) with $141 as its status line", onSavePage() && statusCodes() === SAVED_STATUS && slotWritten(2), `stage ${game.stage} status ${statusCodes()}`);
idle();
idle();
check("the $141 status persists through idle frames on the save page", onSavePage() && statusCodes() === SAVED_STATUS);
rightClick();
check("BACK from the picture-origin saved page returns to the picture (no list) with $141 on its prompt (not $138, not blank)", onPicture() && game.diskMenu.promptIndex === SAVE_DONE_STRING, `stage ${game.stage} prompt ${game.diskMenu?.promptIndex}`);
iconClick(DISK_BUTTON.exit);
check("EXIT from the picture after BACK enters the map (the live map, not paused by the save)", game.stage === "map" && game.map === livePicture && game.map.sim.paused === false, `stage ${game.stage}`);

// ---- 2. Scenario origin: the `$8B` the save erased does not come back; `$141` on the list; EXIT enters the held scene -------------
listWithPick();
const heldList = game.heldScene;
const liveList = game.map;
check("the list shows $8B after the pick (before the save)", prompt() === SCENARIO_PROMPT, `prompt ${prompt()}`);
iconClick(DISK_BUTTON.save);
check("icon 1 from the list erases the $8B and opens the save page with $138; the held scene is kept", onSavePage() && statusCodes() === OPEN_STATUS && game.heldScene === heldList, `status ${statusCodes()}`);
tapSlot(1); // slot 2
check("list-origin success keeps the save page with $141; slot 2 holds the held scenario (1), not the live map's (0)", onSavePage() && statusCodes() === SAVED_STATUS && readSlot(1).ok && readSlot(1).save.scenario === 1 && game.heldScene === heldList && game.map === liveList, `status ${statusCodes()}`);
rightClick();
check("BACK from the list-origin saved page: the scenario list with $141 (the $8B the save erased does not return), held scene 1, ten rows", onList() && prompt() === SAVED_PROMPT && game.heldScene === heldList && game.diskMenu.listRows.length === 10, `stage ${game.stage} prompt ${prompt()}`);
check("the list's prompt is not the pick's $8B after BACK", prompt() !== SCENARIO_PROMPT);
iconClick(DISK_BUTTON.exit);
check("EXIT on the list after the save and BACK enters the held scene (scenario 1), not the live map", game.stage === "map" && game.map === heldList.map && game.map !== liveList && game.scenario === 1, `stage ${game.stage} scenario ${game.scenario}`);

// ---- 3. Prompt lifetime: `$141` persists until a traced erase (`$84F4`/`$82B8`), not until a non-erasing icon -----------------
pictureGame(fakeMusic());
iconClick(DISK_BUTTON.save);
tapSlot(3);
rightClick();
check("prompt lifetime: back on the picture with $141", onPicture() && game.diskMenu.promptIndex === SAVE_DONE_STRING);
iconClick(DISK_BUTTON.music); // icon 4 (music on/off, `$1062`): result line only
check("icon 4 (music on/off) prints a result line and leaves $141 on the prompt (no erase)", game.diskMenu.promptIndex === SAVE_DONE_STRING && game.stage === "disk", `prompt ${game.diskMenu?.promptIndex}`);
iconClick(DISK_BUTTON.musicSelect); // icon 7: `$1006` -> `$82B8` closes (erases the prompt), then the music list's prompt
check("icon 7 (music select, `$82B8` erase) replaces $141 with the music list's own prompt", game.diskMenu.listKind === "music" && game.diskMenu.promptIndex !== SAVE_DONE_STRING, `kind ${game.diskMenu?.listKind} prompt ${game.diskMenu?.promptIndex}`);

// A scenario-list prompt erase: icon 2 (`$855A`) prints `$13B` over the `$141` the picture still shows, so that line is gone too.
pictureGame();
iconClick(DISK_BUTTON.save);
tapSlot(4);
rightClick();
iconClick(DISK_BUTTON.scenario);
check("icon 2 (scenario wait) replaces the picture's $141 with its own wait prompt", game.diskMenu.promptIndex !== SAVE_DONE_STRING, `prompt ${game.diskMenu?.promptIndex}`);

// ---- 4. Release timing and row latch on the save page ---------------------------------------------------------------------------
storage.clear(); // slots 1-8 are the remake's eight rows (SAVE_SLOTS); earlier sections wrote some of them
pictureGame();
iconClick(DISK_BUTTON.save);
idle();
frame(false, SLOT_X, slotY(2));
frame(true, SLOT_X, slotY(2));
frame(true, SLOT_X, slotY(2));
check("a press held on slot 3 writes nothing: the save is on the release", !slotWritten(2) && onSavePage() && statusCodes() === OPEN_STATUS, `status ${statusCodes()}`);
frame(false, SLOT_X, slotY(2));
check("the release on slot 3 opens the name prompt without writing yet", !slotWritten(2) && game.nameEntry?.entry.phase === "prompt");
confirmDefaultName(2);
check("a second click accepts the default and writes slot 3 with $141", slotWritten(2) && statusCodes() === SAVED_STATUS);

// The press latches its row: press on slot 2, drag to slot 5, release there -> slot 2 is written, slot 5 is not.
idle();
frame(false, SLOT_X, slotY(1));
frame(true, SLOT_X, slotY(1));
frame(true, SLOT_X, slotY(4));
frame(false, SLOT_X, slotY(4));
check("press on slot 2 and release on slot 5 opens the prompt for slot 2 (the press-latched row)", game.nameEntry?.slot === 1 && !slotWritten(1) && !slotWritten(4));
confirmDefaultName(1);
check("accepting the prompt writes slot 2, not slot 5", slotWritten(1) && !slotWritten(4), `slot2 ${slotWritten(1)} slot5 ${slotWritten(4)}`);

// A press off the rows and a release on a row writes nothing.
idle();
frame(false, 0, 0);
frame(true, 0, 0);
frame(false, SLOT_X, slotY(6));
check("a press off the rows and a release on slot 7 writes nothing", !slotWritten(6) && onSavePage());

// A press on a row, released off the page, still saves that row.
idle();
frame(false, SLOT_X, slotY(7));
frame(true, SLOT_X, slotY(7));
frame(false, 0, 0);
check("a press on slot 8 released off the page still opens that row's name prompt", game.nameEntry?.slot === 7 && !slotWritten(7));
idle(); frame(true, 0, 0); frame(false, 0, 0);
check("the default-name click accepts the row latched at the earlier press", slotWritten(7) && onSavePage(), `slot8 ${slotWritten(7)}`);

// The list-origin page latches the same way.
listWithPick();
iconClick(DISK_BUTTON.save);
idle();
frame(false, SLOT_X, slotY(5));
frame(true, SLOT_X, slotY(5));
frame(false, SLOT_X, slotY(6));
check("list origin: press on slot 6, release on slot 7 latches slot 6 for naming", game.nameEntry?.slot === 5 && !slotWritten(5) && !slotWritten(6));
confirmDefaultName(5);
check("list origin: confirming writes slot 6 only", slotWritten(5) && !slotWritten(6) && onSavePage());

// ---- 5. Repeated saves keep the origin ----------------------------------------------------------------------------------------
listWithPick();
iconClick(DISK_BUTTON.save);
tapSlot(0);
tapSlot(1);
check("a second save from the list-origin page keeps the page with $141 and writes slot 2 with the held scene", onSavePage() && statusCodes() === SAVED_STATUS && readSlot(1).ok && readSlot(1).save.scenario === 1 && game.heldScene?.index === 1, `status ${statusCodes()}`);
rightClick();
check("after the repeated save, BACK still returns to the list (not the picture), with $141", onList() && prompt() === SAVED_PROMPT);

pictureGame();
iconClick(DISK_BUTTON.save);
tapSlot(5);
tapSlot(6);
check("a second save from the picture-origin page keeps the page with $141 (both slots written)", onSavePage() && statusCodes() === SAVED_STATUS && slotWritten(5) && slotWritten(6));
rightClick();
check("after the repeated picture-origin save, BACK still returns to the picture (no list) with $141", onPicture() && game.diskMenu.promptIndex === SAVE_DONE_STRING);

// ---- 6. Remake submenu origin: the same save page, BACK to the picture with $141 ---------------------------------------------
pictureGame();
game.openRemakeMenu();
idle();
tapSlot(0); // SAVE GAME (row 0 of the submenu)
check("the remake submenu's SAVE GAME opens the save page (stage save)", onSavePage(), `stage ${game.stage}`);
tapSlot(7);
check("remake-submenu origin: success keeps the save page with $141", onSavePage() && statusCodes() === SAVED_STATUS && slotWritten(7));
rightClick();
check("remake-submenu origin: BACK returns to the picture with $141 on its prompt", onPicture() && game.diskMenu.promptIndex === SAVE_DONE_STRING);

// ---- 7. A failed save writes no `$141`; the error page's BACK goes back to the page's origin ----------------------------------
listWithPick();
iconClick(DISK_BUTTON.save);
const realSet = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => {
  throw new Error("quota");
};
try {
  tapSlot(7); // slot 8
} finally {
  globalThis.localStorage.setItem = realSet;
}
check("a refused write opens the error page, not the save page's $141", game.stage === "sloterror" && game.lastSaveError?.code === "write-failed", `stage ${game.stage} code ${game.lastSaveError?.code}`);
tapMenuLabel("BACK TO DISK MENU");
check("the error page's BACK after a failed save returns to the list with its own $8B (no $141 was written)", onList() && prompt() === SCENARIO_PROMPT && game.heldScene?.index === 1, `stage ${game.stage} prompt ${prompt()}`);

// ---- 8. The save page's EXIT row survives a save (the page is kept, `$141` stays on its status line) ----------------------------
listWithPick();
iconClick(DISK_BUTTON.save);
tapSlot(2);
check("after a save the page keeps its EXIT row (last) and its $141 status line", onSavePage() && game.menu.entries.at(-1).label === "EXIT" && statusCodes() === SAVED_STATUS, game.menu.entries.map((e) => e.label).join(" | "));

if (failed > 0) {
  console.log(`\nsave-page: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("save-page: all checks passed");
