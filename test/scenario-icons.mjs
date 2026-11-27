// Mode 3 (the scenario list open on the disk picture): what each of the nine disk icons does while the list is open (src/game/game.ts
// `diskIcon`, `exitMenus`, `openScenarioList`; src/game/disk-menu.ts). Static trace, Disk.1 raw bytes (2026-11-14; file offset = address +
// `$28800`; notes/formats/game-proper.md, "Mode-3 input path" and "Scenario list rows"):
//   `$5730` (the icon hit test) and the press/release path (`$7F8C`-`$7FE4`) have NO `$938D` test, so every icon is reachable while the
//   list is open. Per icon, the list effect follows the handler's own writes to `$938D`:
//     0 load `$85FE`: writes `$938D` = 2 (the load); the remake's load page replaces the list, and its BACK returns to the list.
//     1 save `$856C`: writes `$938D` = 1 (game over: `$18A` and `$82B8`, the list closes); the remake's save page replaces the list and
//       saves the HELD session when a scene is held (the original would ask for a save disk); its BACK returns to the list, and a
//       successful save stays on the save page with `$141` as its status line (the traced `$89B4` tail leaves `$938D` = 1, the mode-1
//       save list, which the remake's page stands in for; the scenario list is not shown after a save).
//     2 scenario `$8632` -> `$855A`: prints `$13B`, waits for a fresh left press (`$2E48`), then `$865A` redraws the list (`$13D`).
//     3 format `$8314`: no `$938D` write, but every exit calls `$82B8` (close, erase the prompt) before `bra $7EF6`; the remake closes the list
//       and prints its note (the floppy format itself is not modelled).
//     4 music on/off `$1062`: no mode write, result line only; the list stays.
//     5 EXIT `$802C`: `btst #3 $156AA` refuses while game over; otherwise it leaves the loop (no `$938D` write).
//     6 tutorial `$80C8`: `move.b #3,$938D` (already 3), then `bra $802C`: the tutorial enters at once.
//     7 music select `$1006`: `bsr $82B8` (closes the list, erases the prompt), then prints `$190` and `move.b #4,$938D`.
//     8 effects `$10BC`: no mode write, result line only; the list stays.
// Checked here through the real Game.update path (mouse frames), with the list opened by icon 2 and a second press, as the user does it.
// Music and effects are fakes with the contract of `Music` / `Sfx` (test/game-music.mjs). The list's own rules (rows, hover, the
// release, the prompts) are in test/scenario-pick.mjs and test/scenario-wait.mjs. Needs the user's own Disk.1 / Disk.2 in
// original/utopia-whdload (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("scenario-icons tests skipped: original data not found");
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
const { DISK_BUTTON, DISK_LIST_GEOMETRY, DISK_MENU_BUTTONS, NO_GAME_TO_SAVE_STRING, SAVE_DONE_STRING, SCENARIO_OPEN_STRING, SCENARIO_LOADED_STRING, SCENARIO_WAIT_STRING } = await import("../dist/game/disk-menu.js");
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

// Same observable contract as `Music` (test/game-music.mjs): play() of a track is recorded, setActive changes the pause state.
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
function fakeSfx() {
  const s = { enabled: true, count: 6, log: [], play: (id, volume) => void s.log.push({ id, volume }), setEnabled: (on) => { s.enabled = on; }, setVolume() {}, resume() {} };
  return s;
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
// Icon 2's wait then the second press that opens the list (the press lands off the rows: it picks nothing).
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
// Row r of a remake MenuScene panel (the slot pages, the error page): one fresh left click on the row.
const tapMenuEntry = (row) => {
  idle();
  const y = MENU_PANEL.top + 16 + row * MENU_PANEL.row + 4;
  frame(false, 50, y);
  frame(true, 50, y);
  frame(false, 50, y);
  if (game.stage === "save" && game.nameEntry) {
    // Existing route checks accept the offered default name; the editor path is covered in save-name.mjs.
    idle(); frame(true, 50, y); frame(false, 50, y);
  }
};
// The remake page row with this label (the error page's BACK / DISK MENU entries are found by text, not by number).
const tapMenuLabel = (text) => {
  const row = game.menu.entries.findIndex((e) => e.label === text);
  if (row < 0) throw new Error(`no menu row "${text}" in ${game.menu.entries.map((e) => e.label).join(" | ")}`);
  tapMenuEntry(row);
};

const onList = () => game.stage === "scenario" && game.diskMenu?.listKind === "scenario";
const info = () => (game.diskMenu ? game.diskMenu.shownInfo.join() : "no disk menu");
const prompt = () => (game.diskMenu ? game.diskMenu.shownPrompt.join() : "no disk menu");
const noteText = (line = 1) => String.fromCharCode(...(game.diskMenu.infoCodes[line] ?? []));
const SCENARIO_PROMPT = `${SCENARIO_LOADED_STRING},0`;
const SAVED_PROMPT = `${SAVE_DONE_STRING},0`; // `$141`, the save tail's message on the list prompt
const SAVED_STATUS = strings.get(SAVE_DONE_STRING).join(); // `$141` as the remake save page's status line (codes)
const onSavePage = () => game.stage === "save" && game.menu !== null && game.diskMenu === null;
const statusCodes = () => (game.menu?.promptCodes ? game.menu.promptCodes.join() : "none");
const WAIT_PROMPT = `${SCENARIO_WAIT_STRING},0`;
const OPEN_PROMPT = strings.get(SCENARIO_OPEN_STRING).join();

// A game proper (scenario 0 started, the boot session closed) with the list open and one scenario picked (row 1, held).
const listWithPick = (music = null, sfx = null) => {
  game = new Game(disk1, disk2, music, sfx);
  game.strings = strings;
  game.bootMenuOpen = false;
  game.startScenario(0);
  game.openDiskMenu();
  idle();
  openList();
  tapRow(1);
  return game;
};

// ---- 1. Music on/off (icon 4, `$1062`): the result line, the list and the held prompt stay ---------------------------------------
listWithPick(fakeMusic(), null);
const heldBefore = game.heldScene;
iconClick(DISK_BUTTON.music);
check("icon 4 with no track loaded prints $196 ('No music loaded') on the result line", info() === `0,${0x196}`, `info ${info()}`);
check("icon 4 leaves the list open, the held scene and the $8B prompt alone", onList() && game.heldScene === heldBefore && prompt() === SCENARIO_PROMPT, `stage ${game.stage} prompt ${prompt()}`);
check("icon 4 does not start a scene: the map is the one from before", game.map !== null && game.stage === "scenario" && game.heldScene?.index === 1);

// ---- 2. Effects on/off (icon 8, `$10BC`) ---------------------------------------------------------------------------------------
listWithPick(null, fakeSfx());
iconClick(DISK_BUTTON.effects);
check("icon 8 turns the effects off and prints $195 on the result line", game.sfx.enabled === false && info() === `0,${0x195}`, `info ${info()} enabled ${game.sfx.enabled}`);
check("icon 8 leaves the list open with the $8B prompt and the held scene", onList() && prompt() === SCENARIO_PROMPT && game.heldScene?.index === 1);
iconClick(DISK_BUTTON.effects);
check("icon 8 again turns the effects on and prints $194", game.sfx.enabled === true && info() === `0,${0x194}`);

// ---- 3. Format (icon 3): the remake note on the result line; no mode change --------------------------------------------------
listWithPick();
iconClick(DISK_BUTTON.format);
check("icon 3 prints the remake's format note on the result line", noteText() === "REMAKE: NO DISK TO FORMAT", `info ${noteText()}`);
check("icon 3 closes the list and erases the prompt (`$8314` exits through `$82B8`), the held scene stays", game.stage === "disk" && game.diskMenu.listKind === "closed" && prompt() === "0,0" && game.heldScene?.index === 1, `stage ${game.stage} prompt ${prompt()}`);

// ---- 4. Save (icon 1) with a held scene: the HELD session is saved (not the live map, which is scenario 0 here) ------------------
// listWithPick enters scenario 0 and then holds scenario 1 on the list. The save page writes what the held scene is.
listWithPick();
const heldForSave = game.heldScene;
const liveForSave = game.map;
iconClick(DISK_BUTTON.save);
check("icon 1 with a held scene opens the remake's save page (stage save); the held scene and the live map are kept", game.stage === "save" && game.menu !== null && game.heldScene === heldForSave && game.map === liveForSave, `stage ${game.stage}`);
const slotBeforeSave = game.menu.entries[0].label;
tapMenuEntry(0); // slot 1
const savedHeld = readSlot(0);
check("save page slot 1: the held scenario (index 1) is written, not the live map's scenario 0", savedHeld.ok && savedHeld.save.scenario === 1, `slot ${savedHeld.ok ? savedHeld.save.scenario : savedHeld.error?.code}`);
// The original's `$89B4` tail leaves `$938D` = 1 (icon 1's write) and draws no scenario list: the remake's save-slot page stays up with
// `$141` as its status line (game-proper.md "Save tail"). It is NOT the scenario list (no diskMenu), and the held scene is unchanged.
check("a save started from the list stays on the save page (stage save, no scenario list) with $141 as its status line; the held scene and the live map unchanged", onSavePage() && statusCodes() === SAVED_STATUS && game.heldScene === heldForSave && game.map === liveForSave, `stage ${game.stage} status ${statusCodes()} disk ${game.diskMenu !== null}`);
check("the save page's slot 1 label is the written slot (it changed from the empty page's label)", game.menu.entries[0].label !== slotBeforeSave, `label ${game.menu.entries[0].label}`);
idle();
idle();
check("the $141 status line persists through idle frames on the save page", onSavePage() && statusCodes() === SAVED_STATUS, `status ${statusCodes()}`);
// The slot holds the HELD session's state: its world cells are the held scene's, and differ from the live map's (scenario 0).
const sameCells = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
check("the held scene's cells differ from the live map's, so the slot can tell the two apart", !sameCells(heldForSave.map.world.cells, liveForSave.world.cells));
game.loadFromSlot(0, true);
check("loading slot 1 restores the held session (scenario 1) with that scene's cells", game.heldScene?.index === 1 && sameCells(game.heldScene.map.world.cells, heldForSave.map.world.cells), `held ${game.heldScene?.index}`);

// A list-origin save followed by BACK and EXIT: the held scene (not the live map) is entered, and the slot written by the save is the
// held session. The save page keeps `$141`; its BACK restores the scenario list with its own `$8B` prompt (the list the save came from).
listWithPick();
const heldExit = game.heldScene;
const liveExit = game.map;
iconClick(DISK_BUTTON.save);
tapMenuEntry(1); // slot 2
check("list-origin save to slot 2 stays on the save page with $141; slot 2 holds the held scenario", onSavePage() && statusCodes() === SAVED_STATUS && readSlot(1).ok && readSlot(1).save.scenario === 1, `stage ${game.stage} status ${statusCodes()}`);
tapMenuEntry(1); // a second save from the page: still the page, still $141
check("a second save from the page (slot 2 again) keeps the save page with $141 and writes the held session", onSavePage() && statusCodes() === SAVED_STATUS && readSlot(1).ok && readSlot(1).save.scenario === 1 && game.heldScene === heldExit, `stage ${game.stage} status ${statusCodes()}`);
rightClick();
check("BACK from the save page after the save: the scenario list again with the save's $141 (the $8B it erased does not come back), held scene 1", onList() && prompt() === SAVED_PROMPT && game.heldScene === heldExit && game.map === liveExit, `stage ${game.stage} prompt ${prompt()}`);
iconClick(DISK_BUTTON.exit);
check("EXIT on the returned list enters the held scene (scenario 1), not the live map", game.stage === "map" && game.map === heldExit.map && game.map !== liveExit && game.scenario === 1, `stage ${game.stage} scenario ${game.scenario}`);

// A row pick works after a list-origin save and its BACK: the list stays open, the new hold replaces the scene and the $8B prompt returns.
listWithPick();
iconClick(DISK_BUTTON.save);
tapMenuEntry(1); // slot 2
rightClick(); // BACK from the save page to the list
tapRow(3);
check("after a list-origin save and BACK, a row pick holds the new scene (index 3), the list stays open and shows $8B again", onList() && game.heldScene?.index === 3 && prompt() === SCENARIO_PROMPT, `held ${game.heldScene?.index} prompt ${prompt()}`);

// A save started from the picture (no list) still returns to the picture with the $141 prompt; the live map is written.
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
game.openDiskMenu();
idle();
iconClick(DISK_BUTTON.save);
tapMenuEntry(7); // slot 8
const pictureSave = readSlot(7);
check("picture-origin save keeps the save page (stage save, no list) with the $141 status line", onSavePage() && statusCodes() === SAVED_STATUS, `stage ${game.stage} status ${statusCodes()}`);
rightClick();
check("BACK from the picture-origin saved page returns to the picture (stage disk, no list) with the $141 prompt", game.stage === "disk" && game.diskMenu.listKind === "closed" && game.diskMenu.promptIndex === SAVE_DONE_STRING, `stage ${game.stage} prompt ${game.diskMenu?.promptIndex}`);
check("picture-origin save writes the live map's scenario (0) to slot 8", pictureSave.ok && pictureSave.save.scenario === 0, `slot ${pictureSave.ok ? pictureSave.save.scenario : pictureSave.error?.code}`);

// Icon 1 from the list, BACK from its page: the list comes back with its $8B prompt and the held scene.
listWithPick();
iconClick(DISK_BUTTON.save);
rightClick();
check("the save page's right click returns to the list (stage scenario) with its $8B prompt and the held scene (index 1)", onList() && prompt() === SCENARIO_PROMPT && game.heldScene?.index === 1, `stage ${game.stage} prompt ${prompt()}`);
check("the list's rows are the ten records again (the page replaced them and they came back)", game.diskMenu.listRows.length === 10);
tapRow(3);
check("after the BACK a row pick works as on a fresh list (held index 3, the list stays open, the $8B prompt is shown again)", onList() && game.heldScene?.index === 3 && prompt() === SCENARIO_PROMPT, `held ${game.heldScene?.index} prompt ${prompt()}`);

// ---- 5. Load (icon 0): the remake's load page replaces the list; its BACK returns to the list with its prompt and the held scene ---
listWithPick();
iconClick(DISK_BUTTON.load);
check("icon 0 opens the remake's load page (stage load); the list is replaced by the page", game.stage === "load" && game.menu !== null && game.diskMenu === null);
rightClick();
check("the load page's right click returns to the list (stage scenario) with its $8B prompt and the held scene (index 1)", onList() && prompt() === SCENARIO_PROMPT && game.heldScene?.index === 1, `stage ${game.stage} prompt ${prompt()}`);
iconClick(DISK_BUTTON.load);
rightClick();
check("a second load page BACK still returns to the same list (nothing is lost on repeated visits)", onList() && prompt() === SCENARIO_PROMPT && game.heldScene?.index === 1);

// The picture's own route: a load page opened from the picture (no list) comes back to the picture with no list.
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
game.openDiskMenu();
idle();
iconClick(DISK_BUTTON.load);
rightClick();
check("a load page opened from the picture returns to the picture with no list (stage disk)", game.stage === "disk" && game.diskMenu.listKind === "closed" && game.heldScene === null);

// An EMPTY slot on the load list (opened from the scenario list): the list stays with `$143` (no error page), the held scene stays,
// a right click returns to the scenario list with its $8B prompt, and EXIT from the retained list enters the held scene.
listWithPick();
iconClick(DISK_BUTTON.load);
tapMenuEntry(2); // slot 3: empty (slot 1 was written above)
check("a load of an empty slot keeps the load list with $143 (no error page), the held scene stays", game.stage === "load" && game.diskMenu === null && game.lastLoadError?.code === "empty" && game.menu.promptCodes?.join() === strings.get(0x143).join() && game.heldScene?.index === 1, `stage ${game.stage} prompt ${game.menu?.promptCodes?.join()}`);
rightClick();
check("a right click from the refusing load list returns to the scenario list with its $8B prompt and the held scene", onList() && prompt() === SCENARIO_PROMPT && game.heldScene?.index === 1, `stage ${game.stage} prompt ${prompt()}`);
iconClick(DISK_BUTTON.load);
tapMenuEntry(2);
const heldScenarioMap = game.heldScene.map;
tapMenuLabel("EXIT");
check("EXIT from the retained load list after a refusal enters the held scene (its map)", game.stage === "map" && game.map === heldScenarioMap && game.heldScene === null && game.scenario === 1, `stage ${game.stage}`);

// ---- 5b. Icon 1 with the game over on: `$856C` prints $18A and `$82B8` closes the list (`$8592`), so the list does not stay ---------
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
game.map.sim.sysFlags |= SYS.gameOver;
game.openDiskMenu();
idle();
openList();
iconClick(DISK_BUTTON.save);
check("game over: icon 1 prints $18A on the result line and closes the scenario list (the original's `$82B8` on this path)", game.stage === "disk" && game.diskMenu.listKind === "closed" && game.diskMenu.shownInfo[0] === NO_GAME_TO_SAVE_STRING && game.menu === null, `stage ${game.stage} info ${info()}`);

// ---- 6. Music select (icon 7, `$1006`): with a music module the music list replaces the scenario list, the scene stays held -----
listWithPick(fakeMusic(), null);
iconClick(DISK_BUTTON.musicSelect);
check("icon 7 replaces the scenario list with the music list (stage disk, listKind music, prompt $190)", game.stage === "disk" && game.diskMenu.listKind === "music" && prompt() === `${0x190},0`, `stage ${game.stage} kind ${game.diskMenu?.listKind} prompt ${prompt()}`);
check("icon 7 erases the scenario's $8B prompt and keeps the scene held (`$82B8` is not a scene reset)", game.heldScene?.index === 1 && game.diskMenu.listRows.length === 10);
rightClick();
check("the music list's right click closes it; the held scene is still there", game.stage === "disk" && game.diskMenu.listKind === "closed" && game.heldScene?.index === 1);

// Without expansion memory (no Music) the music list does not open: $197 on the result line, the list is closed (`$1006`).
listWithPick(null, null);
iconClick(DISK_BUTTON.musicSelect);
check("icon 7 without Music prints $197 and opens no list (the trace's 'no expansion memory' branch)", game.stage === "disk" && game.diskMenu.listKind === "closed" && info() === `0,${0x197}`, `info ${info()}`);
check("icon 7 without Music still keeps the held scene and erases the prompt", game.heldScene?.index === 1 && prompt() === "0,0", `prompt ${prompt()}`);

// ---- 7. Tutorial (icon 6, `$80C8`): ends in `$802C`, so it enters at once even with the list open ----------------------------
listWithPick();
iconClick(DISK_BUTTON.tutorial);
check("icon 6 enters the tutorial at once (stage map, scenario 0, list and held scene gone)", game.stage === "map" && game.scenario === 0 && game.diskMenu === null && game.heldScene === null);
check("the tutorial scene has its tutorial flag (`$156AA` bit 7 -> SYS.tutorialMode)", (game.map.sim.sysFlags & SYS.tutorialMode) !== 0, `flags ${game.map.sim.sysFlags}`);

// ---- 8. Scenario (icon 2) with the list open: the wait prints $13B, the second press reopens the list with $13D ---------------
listWithPick();
iconClick(DISK_BUTTON.scenario);
check("icon 2 with the list open prints the wait's $13B on the list prompt (no row is picked)", prompt() === WAIT_PROMPT && game.heldScene?.index === 1, `prompt ${prompt()} held ${game.heldScene?.index}`);
frame(true, 0, 0); // the second press (`$2E48`) reopens the list
frame(false, 0, 0);
check("the second press reopens the scenario list ($13D) with the scene still held (index 1)", onList() && game.diskMenu.promptCodes?.join() === OPEN_PROMPT && game.heldScene?.index === 1, `prompt ${prompt()}`);
tapRow(3);
check("a row pick after the reopen works (scenario 3 held, the list still open)", onList() && game.heldScene?.index === 3 && prompt() === SCENARIO_PROMPT);

// ---- 9. EXIT (icon 5) with the list open: the held scene enters directly with one pass, and the list is gone ---------------
const heldMap = game.heldScene.map;
iconClick(DISK_BUTTON.exit);
check("icon 5 leaves the list directly: stage map, held scene entered (scenario 3), list gone", game.stage === "map" && game.map === heldMap && game.scenario === 3 && game.diskMenu === null && game.heldScene === null);
check("icon 5 runs exactly one first pass (the EXIT update)", heldMap.loop.passes === 1 && heldMap.loop.immediatePassPending === false, `passes ${heldMap.loop.passes}`);

// ---- 10. EXIT with the list open and nothing held: the boot session refuses (note), the game proper leaves to the map -----
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = true; // the boot session: the disk menu is the first screen, no map and nothing held
game.openDiskMenu();
idle();
openList();
iconClick(DISK_BUTTON.exit);
check("boot session: icon 5 with nothing held refuses with the remake note and keeps the list", onList() && game.heldScene === null && noteText() === "REMAKE: CHOOSE A SCENARIO", `info ${noteText()}`);

// Game over: icon 5 is refused silently under `$156AA` bit 3, and the list stays.
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
game.map.sim.sysFlags |= SYS.gameOver;
game.openDiskMenu();
idle();
openList();
iconClick(DISK_BUTTON.exit);
check("game over: icon 5 is refused silently and the list stays (no note)", onList() && game.map.sim.gameOver === true && info() === "0,0", `info ${info()}`);

// ---- 11. A press on icon 5 released elsewhere is not EXIT (the icon acts on the release of its own press) ----------------
listWithPick();
idle();
const [ex, ey] = centre(DISK_BUTTON.exit);
frame(true, ex, ey);
frame(true, ex, ey);
frame(false, 100, rowY(5)); // released over row 5: the icon's press was recorded, so the release runs icon 5 (the list is left)
check("an icon press released over a row runs the icon (the release of the press), not a row pick", game.stage === "map" && game.heldScene === null, `stage ${game.stage}`);

if (failed > 0) {
  console.log(`\n${failed} scenario-icons check(s) FAILED`);
  process.exit(1);
}
console.log("\nall scenario-icons checks passed");
