// The scenario pick from the game proper's disk menu (src/game/game.ts `pickScenario`, `holdScene`, `enterHeldScene`;
// notes/formats/game-proper.md, "Scenario list and the held prompt"). Static trace (Disk.1, raw bytes, re-disassembled 2026-11-14):
//   `$88F0`: `cmpi.b #3,d7` (mode 3 only), `move.b #2,d0`, `bsr $866E`, `move.w $8CFE,$135C2`, `bsr $8AF4`, `move.w #$8B,d0`,
//   `moveq #0,d1`, `bsr $8462`, `rts`. It does not write `$938D` (the mode byte; its absolute-long references are elsewhere) and has no
//   `$82B8`, so the list stays open in mode 3.
//   `$87DC` dispatches the mode (`move.b $938D,d7`): 4 -> `$8A42`, 1 -> `$8918`, 2 -> the load `$8828`, 3 -> `$88F0`.
//   `$7FCE` (a release on a list row): `bsr $2E52` (wait for the button up), `tst.w $8CFE`, `bmi` (no row: nothing), else `bsr $87DC`.
//   `$8132` sets `$8CFE` to the hovered row (`(y - $20) / 9`, rows 0-9) while a list is open (`$938D` nonzero).
//   So every row release after a pick is another pick, with the hovered row, and the held scene is replaced.
//   `$8462` prints d0 on the list PROMPT (`move.w #$A3,d1`); its body has no `$8CB0` reference, so it starts no countdown.
//   `$7EF6` returns from `$88F0` into the loop; only EXIT (`$802C`) leaves it. Icon 2 (`$8632`) calls `$855A` first, which erases the
//   prompt (`$84F4`) after its click, so opening the scenario page erases a held pick's prompt (checked in section 4).
// The list is the disk picture's own list (`DiskMenuScene.openScenarioList`, stage "scenario"): the icon table `$8CB4` is read in mode 3
// too (`$7FA8` -> `$5730`, no `$938D` test), so icon 5 (EXIT, `$802C`) is the way out, and the list has no EXIT row. Rows act on the RELEASE
// of a press that began on them (`$7FCE` -> `$2E52`; `$5948` / `$59C8`): the row is the one under the pointer at the press, and a press
// alone picks nothing. Pixel-level row checks are in test/scenario-list.mjs.
// Real Game.update clicks throughout. Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("scenario-pick tests skipped: original data not found");
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
const { MENU_PANEL } = await import("../dist/game/menu.js");
const { DISK_BUTTON, DISK_LIST_GEOMETRY, DISK_MENU_BUTTONS, DiskMenuScene, MESSAGE_AREA, SCENARIO_LOADED_STRING, SCENARIO_OPEN_STRING, INFO_LIFETIME_FRAMES } = await import("../dist/game/disk-menu.js");
const { SYS } = await import("../dist/game/sim.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A game proper with a map (scenario 0), the boot session closed. `startScenario` is the programmatic entry (no hold).
let game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
const oldMap = game.map;
// Slot 0 holds scenario 0 for the load pick in section 4 (written now, while the live map is the one saved; a held scene is saved in place of it).
const savedToSlot0 = game.saveToSlot(0) === true;

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
const iconClick = (i) => {
  idle();
  const [x, y] = centre(i);
  frame(true, x, y);
  frame(true, x, y);
  frame(false, x, y);
};
// Icon 2 opens the list only after a second fresh press (the original's $855A -> $2E48 wait): this press lands off the rows,
// so it opens the list and picks nothing.
const scenarioIcon = () => {
  iconClick(DISK_BUTTON.scenario);
  frame(true, 0, 0);
  frame(false, 0, 0);
};
// Row r of the scenario list (the original list geometry: y = $20 + 9 r, DISK_LIST_GEOMETRY). One fresh left click.
const rowY = (row) => DISK_LIST_GEOMETRY.y0 + row * DISK_LIST_GEOMETRY.pitch + 4;
const tapRow = (row) => {
  idle();
  frame(false, 100, rowY(row));
  frame(true, 100, rowY(row));
  frame(false, 100, rowY(row));
};
// Row r of a remake MenuScene panel (MENU_PANEL: 12 px rows from TOP + 16), e.g. the remake submenu's BACK entry.
const tapRemakeRow = (row) => {
  idle();
  const y = MENU_PANEL.top + 16 + row * MENU_PANEL.row + 4;
  frame(false, 50, y);
  frame(true, 50, y);
  frame(false, 50, y);
};
// The remake's right click (one fresh press), then an idle frame: the back route from the page or the disk menu.
const rightClick = () => {
  idle();
  frame(false, 0, 0, true);
  idle();
};

// Guarded accessors: a failed placement or a premature EXIT must report FAIL lines, not throw.
const menu = () => game.diskMenu;
const onList = () => game.stage === "scenario" && menu() !== null && menu().listKind === "scenario";
const pagePrompt = () => (menu() ? menu().promptCodes?.join() ?? "none" : "no disk menu");
const promptText = () => (menu() ? menu().shownPrompt.join() : "no disk menu");
const infoText = () => (menu() ? menu().shownInfo.join() : "no disk menu");
const infoLeft = () => (menu() ? menu().infoFramesLeft : -1);

const SCENARIO_PROMPT = `${SCENARIO_LOADED_STRING},0`;
const SCENARIO_PROMPT_CODES = strings.get(SCENARIO_LOADED_STRING).join();
const bandDiffers = (a, b, y0, y1) => {
  for (let y = y0; y < y1; y++) for (let x = 0; x < 320; x++) if (a[y * 320 + x] !== b[y * 320 + x]) return true;
  return false;
};
// The disk menu with no message: a fresh scene has the picture and nothing printed.
const plainDisk = new DiskMenuScene(disk1, strings).screen.pixels;
// The list with the same rows and no pick yet: its rows are the reference for the row visuals (unchanged by a pick).
const bareList = new DiskMenuScene(disk1, strings);
bareList.openScenarioList(game.records.map((r) => r.labelCodes), false);
const barePage = bareList.screen.pixels;
const ROWS_TOP = DISK_LIST_GEOMETRY.y0;
const ROWS_END = ROWS_TOP + 10 * DISK_LIST_GEOMETRY.pitch; // the ten records; the list has no row below them
const PROMPT_TOP = MESSAGE_AREA.prompt.y[0]; // the list prompt line ($8462, y $A3) sits below the rows
const OPEN_PROMPT_CODES = strings.get(SCENARIO_OPEN_STRING).join(); // $13D, shown when the list opens ($865A)
// The original's `$8CB0` count (`move.l #$4E20,$8CB0`, `$83F2`): the longest countdown the image can start. The no-timeout window
// covers it, one frame more, so an expiry at any point of that count is seen.
const ORIGINAL_COUNTDOWN_PASSES = 0x4e20;

// ---- 1. First pick: the list stays open, $8B on its prompt line, the scene held ---------------------------------------------
game.openDiskMenu(); // on the map the disk menu is opened by the control button; this is the same stage change
idle();
scenarioIcon();
check("the scenario icon opens the scenario list (on the disk picture)", onList());
tapRow(1);
check("picking row 1 keeps the list open (stage scenario) with scenario 1 held and the map unchanged", onList() && game.heldScene?.index === 1 && game.map === oldMap);
check("the scenario message is on the list page's prompt line ($8B, string 139)", pagePrompt() === SCENARIO_PROMPT_CODES, `prompt ${pagePrompt()}`);
check("placement: the prompt band under the rows differs from the bare list", menu() !== null && bandDiffers(menu().screen.pixels, barePage, PROMPT_TOP, PROMPT_TOP + 6));
// The pointer still sits on row 1 after the tap, so that row is drawn highlighted (hover); move it off the rows before comparing.
idle();
check("row visuals: the ten scenario rows match the bare list pixel for pixel (a pick changes no row)", menu() !== null && !bandDiffers(menu().screen.pixels, barePage, ROWS_TOP, ROWS_END));
const firstHeld = game.heldScene.map;
check("the first pick's scene has no pass yet (immediate pass pending)", firstHeld.loop.passes === 0 && firstHeld.loop.immediatePassPending === true);

// ---- 2. Multiple picks on the open list: each one replaces the held scene, none runs ----------------------------------------
const passesOld = oldMap.loop.passes;
tapRow(2);
const secondHeld = game.heldScene.map;
check("a second pick on the open list replaces the held scene (held index 2), still on the list, prompt shown", onList() && game.heldScene?.index === 2 && pagePrompt() === SCENARIO_PROMPT_CODES);
check("the second pick builds a new scene (the first is replaced, not entered)", secondHeld !== firstHeld && game.map === oldMap);
tapRow(0);
const thirdHeld = game.heldScene.map;
check("a third pick (row 0) replaces it again (held index 0), still on the list", onList() && game.heldScene?.index === 0 && thirdHeld !== secondHeld && game.map === oldMap);
tapRow(0);
const fourthHeld = game.heldScene.map;
check("picking the same row again builds a fresh scene (held index 0), still on the list", onList() && game.heldScene?.index === 0 && fourthHeld !== thirdHeld);
check("scene counts: every replaced scene is unrun (passes 0, immediate pass still pending)", [firstHeld, secondHeld, thirdHeld].every((m) => m.loop.passes === 0 && m.loop.immediatePassPending === true));
check("scene counts: the old map is unchanged by the picks (its pass count is the same as before the picks)", oldMap.loop.passes === passesOld && game.map === oldMap);

// ---- 3. Prompt lifetime on the open list: no timeout over the original's full pass count ----------------------------------
let idleFrames = 0;
const idleTo = (total) => {
  while (idleFrames < total) {
    idle();
    idleFrames++;
  }
};
idle(); // the pointer leaves the row it tapped (hover), so the snapshot is the page at rest
const pageShot = menu().screen.pixels.slice();
idleTo(300);
check("no timeout: after 300 frames (more than the result countdown) the list still shows $8B", onList() && pagePrompt() === SCENARIO_PROMPT_CODES);
check("no timeout: the list pixels are unchanged after 300 frames", menu() !== null && pageShot.every((v, i) => v === menu().screen.pixels[i]));
idleTo(ORIGINAL_COUNTDOWN_PASSES + 1);
check(`no timeout: after ${ORIGINAL_COUNTDOWN_PASSES + 1} frames (the original's $8CB0 count, one more) the prompt is still shown, held`, onList() && pagePrompt() === SCENARIO_PROMPT_CODES && game.heldScene?.index === 0, `frames ${idleFrames}`);
check("no timeout: the map is not ticked while the list is open (old map passes unchanged)", oldMap.loop.passes === passesOld);

// ---- 4. The right button on the open list does nothing (no original route); the remake submenu is reached from the picture only ----
rightClick();
check("right click on the open list is a no-op: still the scenario list, held index 0, the map unchanged", onList() && game.heldScene?.index === 0 && game.map === oldMap, `stage ${game.stage}`);
check("the list keeps $8B on its prompt and shows no result line after the right click", promptText() === SCENARIO_PROMPT && infoText() === "0,0", `prompt ${promptText()} info ${infoText()}`);
check("the list's prompt pixels differ from a plain disk menu (the message is drawn)", menu() !== null && bandDiffers(menu().screen.pixels, plainDisk, 0xa3, 0xa3 + 6));
idle();
frame(false, 0, 0, true);
idle();
check("a right button held down and released on the list changes nothing (still listed, held index 0)", onList() && game.heldScene?.index === 0 && promptText() === SCENARIO_PROMPT);

// Icon 3 (format, `$8314`) closes the list through `$82B8` and erases its prompt; the picture is then the right button's route.
iconClick(DISK_BUTTON.format);
check("icon 3 closes the list (the remake's format note on the second result line); the held scene stays", game.stage === "disk" && menu().listKind === "closed" && game.heldScene?.index === 0 && menu().shownInfo[1] === -1, `stage ${game.stage} info ${infoText()}`);
idle();
frame(false, 0, 0, true); // right button on the picture: the remake submenu (a remake-only route, no original counterpart)
check("round trip: the right button on the picture opens the remake submenu while the scene is held", game.stage === "remake" && game.heldScene?.index === 0);
tapRemakeRow(4); // BACK TO DISK MENU (the remake submenu: its own panel geometry)
check("round trip: BACK TO DISK MENU returns to the picture with the scene held (stage disk, index 0, no list)", game.stage === "disk" && game.heldScene?.index === 0 && menu().listKind === "closed", `stage ${game.stage}`);

scenarioIcon();
check("the scenario icon opens its list while held (the list on the disk picture)", onList() && game.heldScene?.index === 0);
check("opening the list erases the held prompt ($855A erased it): the list shows $13D, not $8B", pagePrompt() === OPEN_PROMPT_CODES, `prompt ${pagePrompt()}`);
rightClick();
check("right click on the reopened list is a no-op: the list shows $13D and the scene stays held", onList() && game.heldScene?.index === 0 && pagePrompt() === OPEN_PROMPT_CODES, `prompt ${pagePrompt()}`);

scenarioIcon();
tapRow(1);
check("a pick from the reopened list shows the prompt again and keeps the list open (held index 1)", onList() && game.heldScene?.index === 1 && pagePrompt() === SCENARIO_PROMPT_CODES);
const reheld = game.heldScene.map;
rightClick();
check("right click after that pick is a no-op: the list keeps $8B and the held scene (index 1)", onList() && game.heldScene?.index === 1 && promptText() === SCENARIO_PROMPT);

// A load pick replaces the held scene and erases the prompt (`$82B8`, no load message).
const loaded = game.loadFromSlot(0, true);
check("load pick while held: slot 0 loads (scenario 0) and replaces the held scene", loaded === true && game.heldScene?.index === 0 && game.heldScene.map !== reheld && game.map === oldMap && game.stage === "disk", `loaded ${loaded} held ${game.heldScene?.index}`);
check("load pick clears the prompt (`$82B8` erases it) and shows no result line", promptText() === "0,0" && infoText() === "0,0", `prompt ${promptText()} info ${infoText()}`);

scenarioIcon();
tapRow(2);
const finalHeld = game.heldScene.map;
check("after the navigation a final pick (scenario 2) keeps the list open with its prompt", onList() && game.heldScene?.index === 2 && pagePrompt() === SCENARIO_PROMPT_CODES);
rightClick();
check("the right click leaves the list open; the held scenario 2 keeps its prompt and nothing has run", onList() && game.heldScene?.index === 2 && promptText() === SCENARIO_PROMPT && finalHeld.loop.passes === 0);

// ---- 5. EXIT: the last selection enters exactly once, with one first pass; the replaced scenes never run ---------------------
const otherHeld = [firstHeld, secondHeld, thirdHeld, fourthHeld, reheld];
const passesBefore = finalHeld.loop.passes;
iconClick(DISK_BUTTON.exit);
check("EXIT enters the last selection (stage map, nothing held, the list gone)", game.stage === "map" && game.heldScene === null && menu() === null && game.map === finalHeld);
check("EXIT enters scenario 2 (the last pick), not an earlier one", game.scenario === 2);
check("EXIT runs the last selection's one immediate pass", finalHeld.loop.passes === passesBefore + 1 && finalHeld.loop.immediatePassPending === false, `passes ${passesBefore} -> ${finalHeld.loop.passes}`);
check("the replaced scenes are never entered or run (passes 0, pass still pending)", otherHeld.every((m) => m.loop.passes === 0 && m.loop.immediatePassPending === true && m !== game.map));

// ---- 6. Subsequent map ----------------------------------------------------------------------------------------------------
const vblsAfterExit = finalHeld.loop.vbls;
for (let i = 0; i < 20; i++) idle();
check("the map keeps running after EXIT (vbls advance, stage map)", game.stage === "map" && finalHeld.loop.vbls > vblsAfterExit);
check("after EXIT no disk menu, list or held scene is left", menu() === null && game.menu === null && game.heldScene === null);

// ---- 7. Rows act on the RELEASE (the original's `$7FCE`/`$2E52`), not the press ----------------------------------------------
// A fresh game on the open list. A press alone picks nothing; the pick is the release. The entry is the one under the pointer at the
// press (the original's `$8CFE` is not re-tested while it waits), so a release elsewhere still picks the pressed row.
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
const map7 = game.map;
game.openDiskMenu();
idle();
scenarioIcon();
check("section 7: the list opens from the icon with its ten rows (no EXIT row) and $13D on its prompt", onList() && menu().listRows.length === 10 && pagePrompt() === OPEN_PROMPT_CODES);
idle();
frame(true, 100, rowY(2)); // press on row 2
check("section 7: a press on row 2 alone picks nothing (no held scene, still on the list, prompt still $13D)", onList() && game.heldScene === null && pagePrompt() === OPEN_PROMPT_CODES);
frame(true, 100, rowY(5)); // drag while held: the press row still counts
frame(false, 100, rowY(5)); // release on row 5
check("section 7: the release picks the row under the press (row 2, held index 2), not the row under the release", game.heldScene?.index === 2 && onList(), `held ${game.heldScene?.index}`);
idle();
frame(true, 5, rowY(0)); // press off the entries (left of the panel)
frame(false, 100, rowY(0)); // release on row 0: the press was not on an entry, so nothing happens
check("section 7: a press off the entries and a release on a row picks nothing (still held index 2)", game.heldScene?.index === 2 && onList());
check("section 7: nothing has run: the map is unchanged and its pass count is the same", game.map === map7 && map7.loop.passes === 0);

// ---- 8. EXIT on the open list enters the held selection without a right click (one immediate pass) -------------------------
const held8 = game.heldScene.map;
idle();
const [exitX, exitY] = centre(DISK_BUTTON.exit);
frame(true, exitX, exitY); // press on icon 5 (EXIT)
check("section 8: a press on EXIT alone does not leave the list (stage scenario, still held index 2)", game.stage === "scenario" && game.heldScene?.index === 2 && game.map === map7);
frame(false, exitX, exitY); // release on icon 5
check("section 8: the release on EXIT enters the held selection directly (stage map, no disk menu, nothing held)", game.stage === "map" && game.map === held8 && game.heldScene === null && game.diskMenu === null && game.menu === null, `stage ${game.stage}`);
check("section 8: the held scene (index 2) is the one entered, with exactly one immediate pass (run in the EXIT update, as the disk menu's EXIT does)", held8.loop.passes === 1 && held8.loop.immediatePassPending === false && game.scenario === 2, `passes ${held8.loop.passes}`);
idle();
check("section 8: the next update adds no further immediate pass (the held scene is not run twice; passes are paced by vblanks)", held8.loop.passes === 1 && held8.loop.immediatePassPending === false, `passes ${held8.loop.passes}`);

// ---- 9. EXIT with nothing held: the boot session refuses with the note on the page; a held pick then enters ---------------
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = true; // the boot session: the disk menu is the first entry
game.openDiskMenu();
idle();
scenarioIcon();
check("section 9: the boot session's scenario page opens with no held scene", game.stage === "scenario" && game.heldScene === null);
iconClick(DISK_BUTTON.exit); // EXIT with nothing held
const bootNote = "REMAKE: CHOOSE A SCENARIO";
check("section 9: boot EXIT with nothing held stays on the list and prints the remake note on the result line", onList() && game.heldScene === null && game.map === null && String.fromCharCode(...menu().infoCodes[1]) === bootNote, `info ${menu()?.infoCodes[1]}`);
tapRow(0); // a pick shows $8B on the list prompt
check("section 9: a pick on the list shows $8B (held index 0)", onList() && game.heldScene?.index === 0 && pagePrompt() === SCENARIO_PROMPT_CODES);
iconClick(DISK_BUTTON.exit); // EXIT with a held scene (boot session): enters it
check("section 9: boot EXIT with a held pick enters it (stage map, held cleared, boot flag cleared, its one pass run in the EXIT update)", game.stage === "map" && game.heldScene === null && game.map !== null && game.bootMenuOpen === false && game.map.loop.passes === 1 && game.map.loop.immediatePassPending === false, `stage ${game.stage}`);

// ---- 10. EXIT with nothing held in the game proper: the menus close to the map, the map arms its one pass ----------------
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
const map10 = game.map;
game.openDiskMenu();
idle();
scenarioIcon();
iconClick(DISK_BUTTON.exit);
check("section 10: EXIT on the list with nothing held closes the menus to the same map (stage map, no list, no disk menu)", game.stage === "map" && game.map === map10 && game.menu === null && game.diskMenu === null);
check("section 10: the EXIT update runs the map's one immediate pass and clears it (as the disk menu's icon exit does, save.mjs in-game icon exit)", map10.loop.immediatePassPending === false && map10.loop.passes === 1, `passes ${map10.loop.passes}`);

// ---- 11. Game over: the page's EXIT is refused silently while `$156AA` bit 3 is set; the list stays open ------------------------
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
game.map.sim.sysFlags |= SYS.gameOver;
game.openDiskMenu();
idle();
scenarioIcon();
iconClick(DISK_BUTTON.exit);
check("section 11: EXIT on the list is refused under game over (stage scenario, prompt still $13D, nothing held)", onList() && pagePrompt() === OPEN_PROMPT_CODES && game.heldScene === null);

// ---- 12. A row of an EMPTY record: the original's `$87DC` EMPT/Y check runs before the mode test, so mode 3 refuses it with `$143` on
//          the list prompt and picks nothing. The supplied Disk.2 has no EMPTY record, so record 2 is made one for this check (the list
//          reads the names when it opens, so the change is made before `scenarioIcon`).
game = new Game(disk1, disk2, null, null);
game.strings = strings;
game.bootMenuOpen = false;
game.startScenario(0);
game.openDiskMenu();
idle();
game.records[2].labelCodes = [..."EMPTY"].map((c) => c.charCodeAt(0));
const EMPTY_PROMPT_CODES = strings.get(0x143).join(); // "That slot is empty. Choose another..."
scenarioIcon();
tapRow(2);
check("section 12: a row of an EMPTY record with nothing held shows $143 on the list prompt, picks nothing, the list stays open", onList() && game.heldScene === null && pagePrompt() === EMPTY_PROMPT_CODES, `held ${game.heldScene?.index} prompt ${pagePrompt()}`);
tapRow(1);
check("section 12: a named row still picks (held index 1) after the refused row", onList() && game.heldScene?.index === 1 && pagePrompt() === SCENARIO_PROMPT_CODES);
const heldBeforeEmpty = game.heldScene;
tapRow(2);
check("section 12: the EMPTY row while a scene is held shows $143 and keeps the held scene and its map", onList() && game.heldScene === heldBeforeEmpty && pagePrompt() === EMPTY_PROMPT_CODES, `held ${game.heldScene?.index} prompt ${pagePrompt()}`);
check("section 12: nothing ran for the refused row (the held scene's first pass is still pending)", heldBeforeEmpty.map.loop.passes === 0 && heldBeforeEmpty.map.loop.immediatePassPending === true);

if (failed > 0) {
  console.log(`\n${failed} scenario-pick check(s) FAILED`);
  process.exit(1);
}
console.log("\nall scenario-pick checks passed");
