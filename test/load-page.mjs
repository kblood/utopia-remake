// The load page's rows and EXIT, and the save page's EXIT (src/game/game.ts `openMenu`, `diskIcon`, `exitFromPage`, `exitMenus`; src/game/menu.ts
// `MenuScene` in `release` mode). Static trace, Disk.1 raw bytes (2026-11-14; file offset = address + `$28800`; notes/formats/game-proper.md
// "Load and save rows: release"):
//   the loop `$7EF6`: `$7F72` `$8132` (hover row `$8CFE` for any nonzero mode), `$50B2` (press edge sets bit 3 of `$156A8`), `$7F8C`
//   `btst #3` -> `$7FA8` while the button is down: `$5730` tests the icon table `$8CB4`; a hit latches its index in `$5DD4` (`$5948`) and
//   the release dispatches it (`$7F96` -> `$59C8` -> `$7FE4`, no mode test: icon 5, EXIT, is `$802C` in every list).
//   a press that misses the icons: `$7FCE` `bsr $2E52` (waits for the release, no poll), `tst.w $8CFE`, `bmi $7EF6`, `bsr $87DC`, `bra $7EF6`.
//   `$87DC`: mode 1 -> `$8918` (save); mode 2 -> the EMPT check `$8804`-`$881E` (`$143`, the list stays), then `$8828` (load). So the load
//   row is the same release route as the save row (the row latched at the press).
// Checked through the real Game.update path (mouse frames). Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only);
// skipped when missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("load-page tests skipped: original data not found");
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
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
const { MENU_PANEL } = await import("../dist/game/menu.js");
const { SYS } = await import("../dist/game/sim.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
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
const rightClick = () => {
  idle();
  frame(false, 0, 0, true);
  idle();
};
// The page's rows: MenuScene rows at `top + 16 + n * row`, x inside the panel.
const ROW_X = 50;
const rowY = (row) => MENU_PANEL.top + 16 + row * MENU_PANEL.row + 4;
const tapRow = (row) => {
  idle();
  frame(false, ROW_X, rowY(row));
  frame(true, ROW_X, rowY(row));
  frame(false, ROW_X, rowY(row));
};
const rowOf = (text) => {
  const row = game.menu.entries.findIndex((e) => e.label === text);
  if (row < 0) throw new Error(`no menu row "${text}"`);
  return row;
};
const tapLabel = (text) => tapRow(rowOf(text));
const codes = (text) => Array.from(text.toUpperCase(), (c) => c.charCodeAt(0)).join();

const pictureGame = () => {
  game = new Game(disk1, disk2, null, null);
  game.strings = strings;
  game.bootMenuOpen = false;
  game.startScenario(0);
  game.openDiskMenu();
  idle();
  return game;
};
// One save of the live scenario into slot 1 (row 0), from the picture; BACK to the picture afterwards.
const saveSlotOne = () => {
  pictureGame();
  iconClick(DISK_BUTTON.save);
  tapRow(0);
  // Save rows now open the original's default-name prompt; accept its date name before leaving the page.
  idle();
  frame(true, 0, 0);
  frame(false, 0, 0);
  rightClick();
};
const onLoadPage = () => game.stage === "load" && game.menu !== null && game.diskMenu === null;
const onPicture = () => game.stage === "disk" && game.diskMenu !== null;
const labelsOf = (g) => g.menu.entries.map((e) => e.label);

storage.clear();
saveSlotOne();
check("setup: a save into slot 1 from the picture writes it and BACK shows the picture", onPicture() && storage.has("utopia-remake-save-0"));

// ---- 1. The load page: the icon opens it; its rows, and the EXIT row after the slots --------------------------------------------
iconClick(DISK_BUTTON.load);
check("icon 0 opens the load page (stage load) with eight slot rows and EXIT last", onLoadPage() && game.menu.entries.length === 9 && labelsOf(game)[8] === "EXIT", labelsOf(game).join(" | "));

// ---- 2. Press-not-activate: a press alone loads nothing; the release picks the pressed row --------------------------------------
idle();
frame(false, ROW_X, rowY(0));
frame(true, ROW_X, rowY(0));
frame(true, ROW_X, rowY(0));
check("a press held on slot 1 loads nothing (the choice is on the release)", onLoadPage() && game.heldScene === null, `stage ${game.stage}`);
frame(false, ROW_X, rowY(0));
check("the release on slot 1 loads it: the held scene is set and the picture is shown", onPicture() && game.heldScene !== null && game.heldScene.index === 0, `stage ${game.stage}`);
const held = game.heldScene;

// Release at another row: the press's row (slot 1, loaded) is the one that loads; the slot the release is on (slot 3, empty) is not used.
iconClick(DISK_BUTTON.load);
idle();
frame(false, ROW_X, rowY(0));
frame(true, ROW_X, rowY(0));
frame(true, ROW_X, rowY(2));
frame(false, ROW_X, rowY(2));
check("press on slot 1, released on slot 3: slot 1 is loaded (no error page for the empty slot 3)", onPicture() && game.heldScene !== null && game.heldScene !== held && game.heldScene.index === 0 && game.lastLoadError === null, `stage ${game.stage} error ${game.lastLoadError?.code}`);
const reheld = game.heldScene;

// Press on an empty slot, released on the good one: the press's row (slot 3, empty) is the one that acts. The original's `$87DC` EMPT
// check prints `$143` on the list prompt and returns, so the list stays (no error page), and the held scene is untouched.
const EMPTY_CODES = strings.get(0x143).join();
iconClick(DISK_BUTTON.load);
idle();
frame(false, ROW_X, rowY(2));
frame(true, ROW_X, rowY(2));
frame(true, ROW_X, rowY(2));
frame(false, ROW_X, rowY(0));
check("press on the empty slot 3, released on slot 1: the list stays (no error page), the held scene is untouched", onLoadPage() && game.lastLoadError?.code === "empty" && game.heldScene === reheld, `stage ${game.stage} code ${game.lastLoadError?.code}`);
check("the empty refusal prints $143 on the list's prompt line", game.menu.promptCodes?.join() === EMPTY_CODES, `prompt ${game.menu.promptCodes?.join()}`);
// The list keeps taking row attempts: another empty row refuses again; a press on the empty row released off the page is refused too
// (the row latched at the press acts, as `$8CFE` does).
tapRow(2);
check("another attempt on the empty slot 3 refuses again: the list stays with $143", onLoadPage() && game.lastLoadError?.code === "empty" && game.menu.promptCodes?.join() === EMPTY_CODES && game.heldScene === reheld);
idle();
frame(false, ROW_X, rowY(2));
frame(true, ROW_X, rowY(2));
frame(false, 0, 0);
check("press on the empty slot 3, released off the page: refused on the list (the latched row acts)", onLoadPage() && game.lastLoadError?.code === "empty" && game.heldScene === reheld);
// A right click returns to the picture the list came from; nothing is loaded and the held scene stays.
rightClick();
check("a right click from the refusing list returns to the picture (no load, the held scene kept)", onPicture() && game.heldScene === reheld, `stage ${game.stage}`);

// Blank and outside presses: a press off the rows and a release on a row load nothing; a press on a row released off the page loads it.
iconClick(DISK_BUTTON.load);
idle();
frame(true, 0, 0);
frame(false, ROW_X, rowY(0));
check("a press off the rows, released on slot 1, loads nothing", onLoadPage() && game.heldScene === reheld, `stage ${game.stage}`);
idle();
frame(false, ROW_X, rowY(0));
frame(true, ROW_X, rowY(0));
frame(false, 0, 0);
check("a press on slot 1 released off the page still loads slot 1 (the pressed row)", onPicture() && game.heldScene !== reheld && game.heldScene.index === 0, `stage ${game.stage}`);

// A corrupt record: the same release route gives the corrupt error page.
storage.set("utopia-remake-save-4", "{oops");
iconClick(DISK_BUTTON.load);
tapRow(4);
check("a corrupt slot 5 from the load page opens its error page (CODE: corrupt)", game.stage === "sloterror" && game.lastLoadError?.code === "corrupt", `stage ${game.stage} code ${game.lastLoadError?.code}`);
tapLabel("BACK TO DISK MENU");
storage.delete("utopia-remake-save-4");

// ---- 3. EXIT on the load page: icon 5's action, no BACK first ------------------------------------------------------------------
// Picture origin, nothing held, in the game: the EXIT row enters the live map, with one first pass (as icon 5 does on the picture).
const exitViaPage = (() => {
  pictureGame();
  const map = game.map;
  const before = map.loop.passes;
  iconClick(DISK_BUTTON.load);
  idle();
  frame(true, ROW_X, rowY(rowOf("EXIT")));
  const pressed = game.stage;
  frame(false, ROW_X, rowY(rowOf("EXIT")));
  return { map, before, pressed, stage: game.stage, paused: map.sim.paused, passes: map.loop.passes - before, pending: map.loop.immediatePassPending, date: map.world.state.dateText(), same: game.map === map };
})();
check("EXIT is activated on the release: the press alone keeps the load page", exitViaPage.pressed === "load", `stage ${exitViaPage.pressed}`);
check("EXIT on the load page enters the live map, not paused, with no BACK", exitViaPage.stage === "map" && exitViaPage.same && exitViaPage.paused === false && game.menu === null && game.diskMenu === null, `stage ${exitViaPage.stage}`);
check("EXIT on the load page runs exactly one first pass and leaves none pending", exitViaPage.passes === 1 && exitViaPage.pending === false, `passes ${exitViaPage.passes}`);

// The same exit from icon 5 on the picture gives the same transition (stage, pass count, date).
const exitViaIcon = (() => {
  pictureGame();
  const map = game.map;
  const before = map.loop.passes;
  iconClick(DISK_BUTTON.exit);
  return { stage: game.stage, paused: map.sim.paused, passes: map.loop.passes - before, pending: map.loop.immediatePassPending, date: map.world.state.dateText() };
})();
check("the page's EXIT matches icon 5 on the picture: same stage, pass count, pending state and date", exitViaPage.stage === exitViaIcon.stage && exitViaPage.passes === exitViaIcon.passes && exitViaPage.pending === exitViaIcon.pending && exitViaPage.date === exitViaIcon.date && exitViaPage.paused === exitViaIcon.paused, `page ${JSON.stringify({ ...exitViaPage, map: 0 })} icon ${JSON.stringify(exitViaIcon)}`);

// Held scene: a load pick is held; the load page's EXIT enters the held scene (its map, not the live one), with one first pass.
saveSlotOne();
iconClick(DISK_BUTTON.load);
tapRow(0);
const heldMap = game.heldScene.map;
const liveMap = game.map;
const heldIndex = game.heldScene.index;
iconClick(DISK_BUTTON.load);
const beforePasses = heldMap.loop.passes;
tapLabel("EXIT");
check("EXIT on the load page with a held load enters the held scene (its map), not the live map", game.stage === "map" && game.map === heldMap && game.map !== liveMap && game.scenario === heldIndex && game.heldScene === null, `stage ${game.stage}`);
check("EXIT on the load page with a held load runs exactly one first pass", heldMap.loop.passes - beforePasses === 1 && heldMap.loop.immediatePassPending === false, `passes ${heldMap.loop.passes - beforePasses}`);

// Boot session with nothing held: EXIT refuses with the remake note on the page's prompt line and keeps the page (as icon 5 does).
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = true;
game.openDiskMenu();
idle();
iconClick(DISK_BUTTON.load);
tapLabel("EXIT");
check("boot session, nothing held: EXIT on the load page keeps the page and shows the remake note on its prompt", onLoadPage() && game.heldScene === null && game.menu.promptCodes?.join() === codes("REMAKE: CHOOSE A SCENARIO") && game.bootMenuOpen === true, `stage ${game.stage} prompt ${game.menu.promptCodes?.join()}`);

// Game over: EXIT is refused silently under `$156AA` bit 3, the page stays, and no pass runs.
pictureGame();
game.map.sim.sysFlags |= SYS.gameOver;
game.openDiskMenu();
idle();
const overMap = game.map;
const overPasses = overMap.loop.passes;
iconClick(DISK_BUTTON.load);
tapLabel("EXIT");
check("game over: EXIT on the load page is refused silently (the page stays, no pass, no note)", onLoadPage() && game.map === overMap && overMap.loop.passes === overPasses && game.menu.promptCodes === null, `stage ${game.stage} prompt ${game.menu?.promptCodes}`);

// ---- 3b. An EMPTY record refused on the load list: the list stays, and the rows and EXIT keep working --------------------------------
// (a) Picture origin, nothing held: repeated refusals keep the list with $143; EXIT from the list is the picture's EXIT (one first pass).
pictureGame();
iconClick(DISK_BUTTON.load);
for (let n = 0; n < 3; n++) tapRow(2);
check("picture origin: three selections of the empty slot 3 keep the list with $143 (no error page, no scene, no held scene)", onLoadPage() && game.lastLoadError?.code === "empty" && game.menu.promptCodes?.join() === EMPTY_CODES && game.heldScene === null, `stage ${game.stage} prompt ${game.menu?.promptCodes?.join()}`);
{
  const map = game.map;
  const before = map.loop.passes;
  tapLabel("EXIT");
  check("picture origin: EXIT from the retained list enters the live map with one first pass", game.stage === "map" && game.map === map && map.sim.paused === false && map.loop.passes - before === 1 && map.loop.immediatePassPending === false, `stage ${game.stage} passes ${map.loop.passes - before}`);
}
// (b) Picture origin: after a refusal the same list still loads a populated row (the refusal is not sticky), and the picture shows it held.
pictureGame();
iconClick(DISK_BUTTON.load);
tapRow(2);
tapRow(0);
check("picture origin: after an empty refusal, the same list loads slot 1 (picture, held scene = slot 1)", onPicture() && game.heldScene !== null && game.heldScene.index === 0 && game.lastLoadError === null, `stage ${game.stage} error ${game.lastLoadError?.code}`);
// (c) Scenario-held: a load pick is held; a refused empty row keeps the held scene and its map; EXIT enters the held map.
saveSlotOne();
iconClick(DISK_BUTTON.load);
tapRow(0);
const heldC = game.heldScene;
iconClick(DISK_BUTTON.load);
tapRow(2);
check("held scene: an empty refusal keeps the list with $143 and the held scene object and its map untouched", onLoadPage() && game.heldScene === heldC && game.heldScene.map === heldC.map && game.map !== heldC.map && game.menu.promptCodes?.join() === EMPTY_CODES, `stage ${game.stage}`);
{
  const passes = heldC.map.loop.passes;
  tapLabel("EXIT");
  check("held scene: EXIT from the retained list enters the held map with one first pass", game.stage === "map" && game.map === heldC.map && game.heldScene === null && heldC.map.loop.passes - passes === 1, `stage ${game.stage}`);
}
// (d) Boot session, nothing held: the refusal shows $143 (not the EXIT note); EXIT then refuses with the note and the list stays.
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = true;
game.openDiskMenu();
idle();
iconClick(DISK_BUTTON.load);
tapRow(2);
check("boot session: the empty refusal shows $143 on the retained list, not the EXIT note", onLoadPage() && game.lastLoadError?.code === "empty" && game.menu.promptCodes?.join() === EMPTY_CODES, `stage ${game.stage}`);
tapLabel("EXIT");
check("boot session: EXIT after the refusal keeps the list and shows the remake note", onLoadPage() && game.menu.promptCodes?.join() === codes("REMAKE: CHOOSE A SCENARIO") && game.heldScene === null, `stage ${game.stage}`);
// (e) Game over: EXIT after a refusal is still refused silently; the list stays with its $143 prompt.
pictureGame();
game.map.sim.sysFlags |= SYS.gameOver;
game.openDiskMenu();
idle();
iconClick(DISK_BUTTON.load);
tapRow(2);
const overE = game.map;
const overEPasses = overE.loop.passes;
tapLabel("EXIT");
check("game over: a refused empty row keeps the list with $143, and EXIT is refused silently (no pass)", onLoadPage() && game.map === overE && game.menu.promptCodes?.join() === EMPTY_CODES && overE.loop.passes === overEPasses, `stage ${game.stage} prompt ${game.menu?.promptCodes?.join()} passes ${overE.loop.passes - overEPasses}`);

// ---- 4. The save page's EXIT row ------------------------------------------------------------------------------------------------
saveSlotOne();
iconClick(DISK_BUTTON.save);
check("the save page offers EXIT as its last row (icon 5)", game.stage === "save" && labelsOf(game).length === 9 && labelsOf(game)[8] === "EXIT", labelsOf(game).join(" | "));
const savePageMap = game.map;
const savePagePasses = savePageMap.loop.passes;
tapLabel("EXIT");
check("EXIT on the save page leaves the disk menu for the live map, with no BACK first", game.stage === "map" && game.map === savePageMap && game.menu === null && savePageMap.sim.paused === false, `stage ${game.stage}`);
check("EXIT on the save page runs exactly one first pass", savePageMap.loop.passes - savePagePasses === 1 && savePageMap.loop.immediatePassPending === false);

// Save page EXIT with a held scene (a list-origin save page): the held scene is entered, not the live map.
saveSlotOne();
iconClick(DISK_BUTTON.load);
tapRow(0);
const heldFromSave = game.heldScene;
iconClick(DISK_BUTTON.save);
tapLabel("EXIT");
check("EXIT on the save page with a held scene enters the held scene (its map)", game.stage === "map" && game.map === heldFromSave.map && game.heldScene === null, `stage ${game.stage}`);

if (failed > 0) {
  console.log(`\nload-page: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("load-page: all checks passed");
