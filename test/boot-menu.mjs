// The boot session of Game (notes/formats/game-proper.md, "Fresh scenario entry"): language -> boot stages B to G (test/boot-stages.mjs) -> boot disk menu ($157AE -> $7E52).
// A scenario, remake load or Disk.4 continuation chosen there returns to the boot disk menu and is held ($88F0 / $8828 return to the
// disk-menu loop); only the exit ($802C, icon 5) enters the game proper, and that entry runs the one-shot apparition call $11476 once.
// The tutorial ($80C8) ends with `bra $802C` and enters at once. The same hold applies to a pick in the game proper (game-over.mjs). The exit without a
// held scene is refused (traced: $802C tests $156AA bit 3, set in the boot image). Save at boot: the no-game string $18A with nothing
// held (traced, $856C); with a held scene the original asks for a save disk, and the remake shows a remake note instead (section 8).
// Real Game.update clicks throughout; uses the user's own Disk.1 / Disk.2 (read-only), skipped when missing.
// The Disk.4 boot hold is covered in test/disk4-scene.mjs (section 2c), the in-game paths in test/game-music.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("boot menu tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS, NO_GAME_TO_SAVE_STRING, SAVE_DONE_STRING, SCENARIO_LOADED_STRING } = await import("../dist/game/disk-menu.js");
const { readSlot } = await import("../dist/game/save.js");
const { SYS } = await import("../dist/game/sim.js");
const { A } = await import("../dist/game/state.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

function fakeMusic() {
  const m = {
    trackCount: 4,
    current: -1,
    paused: false,
    calls: [],
    fades: 0,
    stops: 0,
    get active() { return m.current >= 0 && !m.paused; },
    setActive(on) { if (m.current < 0 || m.paused === !on) return false; m.paused = !on; return true; },
    play(track, restart = false) { m.calls.push({ track, restart }); if (track < 0 || track >= m.trackCount) return; m.current = track; m.paused = false; },
    stop() { m.stops++; m.current = -1; m.paused = false; },
    fadeOut() { m.fades++; },
    setVolume() {},
    setChannelMuted() {},
    resume() {},
    title: () => "",
    dispose() {},
  };
  return m;
}

// A fresh boot session: the language screen is replaced by a stub that reports the choice (the screen itself is not under test).
function bootGame(music = null) {
  const game = new Game(disk1, disk2, music, null);
  game.stage = "language";
  game.language = { pointerVisible: true, screen: new Screen(), picturePalette: decodePicture(disk1, PICTURES.language).palette, update: () => ({ state: "chosen", language: 0 }) };
  return game;
}

// The boot stages (boot-stages.ts; about 12,000 updates with no input) run to the disk menu. Their code check (step E) reads
// Return once its fade-in has ended; every other update carries no input.
function passBoot(g, limit = 20000) {
  let inCheck = 0;
  for (let n = 1; g.stage === "boot"; n++) {
    if (n > limit) throw new Error("the boot stages did not finish");
    if (g.boot.currentPhase === "E") inCheck++;
    g.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: inCheck === 50 ? ["Enter"] : [] });
  }
}

const isMarker = (state, alien) => alien !== null && Array.from({ length: state.word(0x144a6) }, (_, i) => [
  state.byte(0x14524 + 2 * i), state.byte(0x14525 + 2 * i),
]).some(([x, y]) => x === alien.x && y === alien.y);

// ---- input helpers (the same edges the scenes see: a press on the frame the button goes down, an action on the release) -----------
let game = null;
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
const rightClick = () => { idle(); frame(false, 0, 0, true); idle(); };
// Icon 2 opens the list only after a second fresh press (the original's $855A -> $2E48 wait): this press lands off the rows, so it
// opens the page and picks nothing.
const scenarioIcon = () => {
  iconClick(DISK_BUTTON.scenario);
  frame(true, 0, 0);
  frame(false, 0, 0);
};
// Row r of a MenuScene (LEFT 40, TOP 40, ROW 12): the row band is 12 px tall starting at TOP + 16.
const tapRow = (row) => {
  idle();
  const y = 40 + 16 + row * 12 + 4;
  frame(false, 50, y);
  frame(true, 50, y);
  frame(false, 50, y);
  if (game.stage === "save" && game.nameEntry) {
    // Legacy flow checks accept the default date with the second click; editor behavior is covered in save-name.mjs.
    idle(); frame(true, 50, y); frame(false, 50, y);
  }
};
// Row r of the scenario page (the original list geometry: y = $20 + 9 r, 9 px pitch; EXIT is row 10). One fresh left click.
const tapListRow = (row) => {
  idle();
  const y = 0x20 + row * 9 + 4;
  frame(false, 100, y);
  frame(true, 100, y);
  frame(false, 100, y);
};
const labels = () => game.menu.entries.map((e) => e.label);
const rowOf = (text) => labels().findIndex((l) => l.startsWith(text));
const openDisk = () => { game.openDiskMenu(); idle(); }; // on the map, the disk menu is opened by the control button

// ---- 1. Language -> boot disk menu, the scenario list, hold and replace ------------------------------------------------------
{
  const music = fakeMusic();
  game = bootGame(music);
  music.play(3); // the boot module (track 3), started by the credit roll (test/boot-music.mjs covers that start); the boot ramp stops it
  music.calls.length = 0;
  idle();
  check("language choice starts the boot stages (stage boot): no disk menu and no scenario list yet", game.stage === "boot" && game.boot !== null && game.diskMenu === null && game.menu === null);
  idle(); // the first boot update: the arrow is off from here (the language stub reported its last value in the choosing update)
  check("during the boot stages the arrow is off and nothing is faded", game.pointerVisible === false && music.fades === 0);
  passBoot(game);
  check("the boot disk menu opens when the boot stages end (stage disk, no scenario list)", game.stage === "disk" && game.diskMenu !== null && game.menu === null && game.boot === null);
  check("the boot disk menu is the game proper's first screen: no map yet, boot session open, the boot ramp stopped track 3 once and nothing faded or started", game.map === null && game.bootMenuOpen === true && music.stops === 1 && music.current === -1 && music.fades === 0 && music.calls.length === 0);

  scenarioIcon();
  check("boot icon 2 (scenario, $8632) opens the scenario list", game.stage === "scenario" && game.diskMenu?.listKind === "scenario");
  tapListRow(0);
  check("choosing row 1 (scenario 1) keeps the scenario list open with the scene held: no map, no apparition yet", game.stage === "scenario" && game.map === null && game.heldScene?.index === 0 && game.bootMenuOpen === true);
  check("the boot scenario pick shows $8B on the list's prompt line (the page), not a result line (test/scenario-pick.mjs)", game.diskMenu.promptCodes?.join() === game.strings.get(139).join());
  const held0 = game.heldScene;
  check("the held scene is initialised (queued day) and has no apparition before the boot exit", held0.map.sim.dayQueued && held0.map.sim.aliens.alien === null && music.calls.length === 0);

  tapListRow(1);
  check("picking another row on the open list replaces the held scene (stage scenario, held index 1)", game.stage === "scenario" && game.heldScene?.index === 1 && game.heldScene.map !== held0.map && game.map === null);

  rightClick();
  check("right click on the boot scenario list is a no-op: the list stays, with the held scene (index 1) and its $8B prompt", game.stage === "scenario" && game.heldScene?.index === 1 && game.map === null && game.diskMenu.shownPrompt.join() === "139,0");

  // ---- 2. The boot exit enters the game proper once: marker apparition, immediate first pass, music untouched -----------------
  iconClick(DISK_BUTTON.exit);
  check("boot exit enters the map with the held scenario", game.stage === "map" && game.scenario === 1 && game.map !== null && game.heldScene === null && game.bootMenuOpen === false);
  // The exit's immediate pass runs in the same update and advances the alien frame ($144AD), so only the position and type are checked here.
  check("boot exit draws one marker apparition of that scenario (type $13 at a marker)", isMarker(game.map.world.state, game.map.sim.aliens.alien) && game.map.world.state.byte(0x144a8) === 0x13);
  check("boot exit runs the immediate first pass (queued day consumed) and starts no track", game.map.loop.passes === 1 && !game.map.sim.dayQueued && game.map.world.state.dateText() === "01/07/2090" && music.calls.length === 0);

  // ---- 3. Later entries of the game proper do not repeat the apparition --------------------------------------------------------
  openDisk();
  scenarioIcon();
  tapListRow(2);
  check("a scenario picked from the game proper's list keeps the list open with the scene held (static $88F0, mode 3)", game.stage === "scenario" && game.heldScene?.index === 2 && game.bootMenuOpen === false);
  rightClick();
  check("right click on the list is a no-op: the list stays with the scene held until EXIT", game.stage === "scenario" && game.heldScene?.index === 2);
  iconClick(DISK_BUTTON.exit);
  check("EXIT enters the picked scenario; no boot exit, so no apparition is drawn", game.stage === "map" && game.scenario === 2 && game.heldScene === null && game.map.sim.aliens.alien === null && game.bootMenuOpen === false);
}

// ---- 4. Exit with nothing held is refused; save at boot prints the no-game string -----------------------------------------
{
  game = bootGame(null);
  idle();
  passBoot(game);
  iconClick(DISK_BUTTON.exit);
  check("exit with no scenario chosen is refused: the boot disk menu stays, nothing is entered", game.stage === "disk" && game.map === null && game.bootMenuOpen === true && game.heldScene === null);
  check("the refusal is a remake note on the second result line", game.diskMenu.shownInfo[1] === -1);
  iconClick(DISK_BUTTON.save);
  check("boot icon 1 (save) prints the no-game string and opens no slot list", game.stage === "disk" && game.diskMenu.shownInfo[0] === NO_GAME_TO_SAVE_STRING);
  rightClick();
  check("boot remake submenu: SAVE GAME is disabled while no game exists, scenario and load stay open", game.stage === "remake" && game.menu.entries[0].enabled === false && game.menu.entries[0].label === "SAVE GAME (OFF: NO GAME)" && game.menu.entries[1].enabled !== false && game.menu.entries[2].enabled !== false);
  tapRow(0);
  check("a click on the disabled save row does nothing", game.stage === "remake");
  tapRow(4);
  check("BACK TO DISK MENU from the boot submenu returns to the boot disk menu", game.stage === "disk" && game.map === null);
}

// ---- 5. The tutorial leaves the disk menu by itself: `$80C8` ends with `bra $802C` (`$812E`), the exit, not the loop `$7EF6` ----------
{
  game = bootGame(null);
  idle();
  passBoot(game);
  iconClick(DISK_BUTTON.tutorial);
  check("tutorial at boot enters at once (no EXIT click, nothing held): scenario 0, flags, money and one apparition", game.stage === "map" && game.scenario === 0 && game.heldScene === null && game.bootMenuOpen === false && (game.map.sim.sysFlags & (SYS.tutorialMode | SYS.noUnitBonus)) === (SYS.tutorialMode | SYS.noUnitBonus) && isMarker(game.map.world.state, game.map.sim.aliens.alien) && game.map.world.state.signedLong(A.money) >= 0x7a120);
}

// ---- 6. Remake load at boot: held, atomic on failure, and the exit replaces the saved apparition (static-trace order) ----------
{
  // A save of scenario 3 (index 2) whose apparition sits at (0,0), which is not a marker of that scenario.
  const saver = new Game(disk1, disk2, null, null);
  saver.bootMenuOpen = false; // a game already in the game proper
  saver.strings = new GameStrings(disk1, 0);
  saver.startScenario(2);
  saver.map.sim.aliens.alien = { x: 0, y: 0 };
  check("the saved apparition record is not a marker of scenario 3, so an overwrite is visible", !isMarker(saver.map.world.state, { x: 0, y: 0 }));
  check("the save slot is written from the in-game session", saver.saveToSlot(0) === true);

  game = bootGame(null);
  idle();
  passBoot(game);
  rightClick();
  tapRow(1); // LOAD GAME (remake submenu)
  check("boot remake submenu: LOAD GAME opens the load page", game.stage === "load");
  tapRow(0); // slot 1
  check("a successful boot load is held: stage disk, no map, held scenario 3", game.stage === "disk" && game.map === null && game.heldScene?.index === 2 && game.lastLoadError === null);
  const held = game.heldScene;

  rightClick(); // the disk menu's right click opens the remake submenu
  tapRow(1); // LOAD GAME again
  tapRow(4); // slot 5: empty
  check("a refused boot load of an empty slot keeps the load list with $143 (no error screen) and leaves the held scene untouched", game.stage === "load" && game.heldScene === held && game.lastLoadError?.code === "empty" && game.menu.promptCodes?.join() === game.strings.get(0x143).join());
  rightClick();
  check("a right click from the refusing list returns to the boot disk menu, the held scene still waiting", game.stage === "disk" && game.heldScene === held && game.map === null);

  iconClick(DISK_BUTTON.exit);
  check("the boot exit after a load enters scenario 3 once", game.stage === "map" && game.scenario === 2 && game.map !== null && game.heldScene === null);
  const replaced = game.map.sim.aliens.alien;
  check("the first-entry exit replaces the loaded apparition with a marker of the loaded scenario", isMarker(game.map.world.state, replaced) && !(replaced.x === 0 && replaced.y === 0));
  game.loadFromSlot(0);
  check("a later load keeps its saved apparition (the exit call is one-shot)", game.stage === "map" && game.map.sim.aliens.alien?.x === 0 && game.map.sim.aliens.alien?.y === 0);
  storage.delete("utopia-remake-save-0");
}

// ---- 7. A later refusal does not disturb a held scene; the disk menu is the only way back to the scenario list ----------------
{
  game = bootGame(null);
  idle();
  passBoot(game);
  scenarioIcon();
  tapListRow(3);
  rightClick(); // the list stays open after a pick; the right click returns to the disk menu, where EXIT is
  iconClick(DISK_BUTTON.exit);
  check("exit after a boot choice enters the game once", game.stage === "map" && game.scenario === 3 && game.map.sim.aliens.alien !== null);
  const apparition = game.map.sim.aliens.alien;
  openDisk();
  iconClick(DISK_BUTTON.exit);
  check("the in-game exit returns to the map without re-running the boot exit (apparition untouched)", game.stage === "map" && game.map.sim.aliens.alien === apparition && game.heldScene === null);
}

// ---- 8. Boot save with a held scene: the held session (no map yet) is what SAVE writes. The remake's slot page opens (the original
//         would ask for a save disk, `$855A`; no `$18A`, since bit 3 is clear for a held scene). BACK returns to the boot list with its
//         prompt; the remake submenu offers SAVE GAME enabled until the boot exit, which enters the held scene ----
{
  game = bootGame(null);
  idle();
  passBoot(game);
  scenarioIcon();
  tapListRow(0);
  const held = game.heldScene;
  check("a scenario is held at boot with the list open (no map yet)", game.stage === "scenario" && held !== null && game.map === null);
  rightClick();
  check("right click on the boot list is a no-op (no original route): still the list, the same held scene, no map", game.stage === "scenario" && game.heldScene === held && game.map === null);
  iconClick(DISK_BUTTON.save);
  check("held scene: the save icon opens the slot page (stage save) and keeps the held scene; no note, no $18A", game.stage === "save" && game.menu !== null && game.heldScene === held && game.map === null);
  rightClick();
  check("BACK from the save page returns to the boot list with its $8B prompt and the held scene", game.stage === "scenario" && game.diskMenu?.listKind === "scenario" && game.diskMenu.shownPrompt[0] === SCENARIO_LOADED_STRING && game.heldScene === held, `stage ${game.stage} prompt ${game.diskMenu?.shownPrompt}`);
  iconClick(DISK_BUTTON.save);
  tapRow(0); // slot 1: the held session is written (not the old map, which does not exist at boot)
  const written = readSlot(0);
  check("held scene: SAVE writes the held scenario (index 0) to the slot; the save page stays up with $141 as its status line (no scenario list), the scene still held", written.ok && written.save.scenario === 0 && game.stage === "save" && game.diskMenu === null && game.menu?.promptCodes?.join() === new GameStrings(disk1, 0).get(0x141).join() && game.heldScene === held && game.map === null, `stage ${game.stage} ${written.ok ? "scenario " + written.save.scenario : written.error?.code}`);
  rightClick();
  check("BACK from the post-save page returns to the boot list with the save's $141 (not the $8B the save erased) and the held scene", game.stage === "scenario" && game.diskMenu?.listKind === "scenario" && game.diskMenu.shownPrompt[0] === SAVE_DONE_STRING && game.heldScene === held && game.map === null, `stage ${game.stage} prompt ${game.diskMenu?.shownPrompt}`);
  iconClick(DISK_BUTTON.format); // closes the list: the remake submenu is reached from the picture
  check("icon 3 closes the list on the picture (the held scene stays)", game.stage === "disk" && game.diskMenu.listKind === "closed" && game.heldScene === held);
  rightClick();
  check("held scene: the remake submenu offers SAVE GAME enabled (the held session is what it saves)", game.stage === "remake" && game.menu.entries[0].enabled !== false && game.menu.entries[0].label === "SAVE GAME");
  tapRow(4); // BACK TO DISK MENU
  check("back from the submenu: the held scene is still waiting", game.stage === "disk" && game.heldScene === held);
  iconClick(DISK_BUTTON.exit);
  check("the boot exit enters the held scene, and the game proper's save is then available", game.stage === "map" && game.heldScene === null);
  openDisk();
  rightClick();
  check("after the exit the remake submenu offers SAVE GAME (enabled)", game.stage === "remake" && game.menu.entries[0].enabled !== false && game.menu.entries[0].label === "SAVE GAME");
  rightClick();
  check("a right click on the remake submenu returns to the map's disk menu", game.stage === "disk");
}

// ---- 9. Input and arrow at the language choice, through the real LanguageScene and Game.update (text.md, "Pointer visibility" and "Language screen and what follows").
//         `game.pointerVisible` is the flag main.ts draws with after each update. The boot sprite is switched on and off in one
//         update when the left button is already down at the poll (the update that ends the fade-in), with no VBL between: that
//         poll frame shows no arrow. A press after one poll pass shows the arrow in the poll frame. The choice then fades the picture
//         out for 45 updates with the pointer off and no input read; the boot stages start when that fade ends and keep the pointer
//         off until they end; the disk menu opens then, and the game proper's arrow comes from the next update. No disk-menu control
//         can fire before the disk menu opens (text.md; its first update ignores a held button).
{
  const { LanguageScene } = await import("../dist/game/language.js");
  const { Screen } = await import("../dist/gfx/screen.js");
  const FADE_IN_END = 89; // the language fade-in is 44 updates (pending first wait, notes/formats/graphics-and-music-blocks.md)
  const FADE_OUT = 45;
  const [scenarioX, scenarioY] = centre(DISK_BUTTON.scenario);
  const at = (left, x = 0, y = 0x20) => ({ leftButton: left, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  const runChoice = (script) => {
    const g = new Game(disk1, disk2, null, null);
    g.stage = "language";
    g.language = new LanguageScene(disk1, new Screen());
    const shown = [];
    const stages = [];
    let chosenAt = 0;
    let diskAt = 0;
    let inCheck = 0;
    for (let i = 1; i <= 20000; i++) {
      // The script drives the language choice (updates 1-150); after that only the boot stages run, and Return is read in their code check.
      let input = script(i);
      if (i > 150) {
        if (g.boot?.currentPhase === "E") inCheck++;
        input = { ...at(false), keys: inCheck === 50 ? ["Enter"] : [] };
      }
      g.update(input);
      shown[i] = g.pointerVisible;
      stages[i] = g.stage;
      if (chosenAt === 0 && g.stage !== "language") chosenAt = i;
      if (diskAt === 0 && g.stage === "disk") diskAt = i;
      if (diskAt !== 0 && i === diskAt + 2) break; // two more frames: the arrow shows from the frame after the menu opens
    }
    return { g, chosenAt, diskAt, shown, stages };
  };

  // Held through the poll (update 89) and released at 96: the boot stages start when the 45-update fade-out ends (update 134).
  const held = runChoice((i) => at(i <= 95));
  check("a left button already down at the poll does not start the boot stages there: they start when the 45-update fade-out ends", held.chosenAt === FADE_IN_END + FADE_OUT && held.stages[FADE_IN_END] === "language" && held.stages[FADE_IN_END + FADE_OUT - 1] === "language" && held.stages[FADE_IN_END + FADE_OUT] === "boot", `started at ${held.chosenAt}`);
  check("the boot stages run until the disk menu opens, and then it is open (stage disk, no map)", held.diskAt > held.chosenAt && held.stages.slice(held.chosenAt, held.diskAt).every((s) => s === "boot") && held.g.stage === "disk" && held.g.map === null);
  check("the held-at-poll poll frame shows no arrow (boot sprite off before any VBL)", held.shown[FADE_IN_END] === false, `shown ${held.shown[FADE_IN_END]}`);
  check("the pointer stays off through the fade-out, the boot stages and the frame the disk menu opens", held.shown.slice(FADE_IN_END + 1, held.diskAt + 1).every((v) => v === false));
  check("the game proper's arrow shows from the frame after the disk menu opens", held.shown[held.diskAt + 1] === true && held.shown[held.diskAt + 2] === true);
  check("releasing the held choice click on the disk menu activates nothing", held.g.stage === "disk" && held.g.map === null && held.g.heldScene === null);

  // Ordinary press: up at the poll (91), down in the next update. Presses on the scenario icon during the fade-out do nothing: the
  // disk menu is not open then, so no scenario list may appear before the fade ends.
  const press = runChoice((i) => {
    if (i === FADE_IN_END + 1) return at(true);
    if (i > FADE_IN_END + 1 && i <= FADE_IN_END + FADE_OUT && i % 2 === 0) return at(true, scenarioX, scenarioY);
    return at(false, scenarioX, scenarioY);
  });
  check("a press after one poll pass chooses at the poll; the boot stages start 45 updates later", press.chosenAt === FADE_IN_END + 1 + FADE_OUT && press.stages.slice(FADE_IN_END + 1, FADE_IN_END + FADE_OUT + 1).every((s) => s === "language"), `started at ${press.chosenAt}`);
  check("the press-chosen poll frame keeps the arrow (boot sprite on during the poll wait)", press.shown[FADE_IN_END] === false && press.shown[FADE_IN_END + 1] === true, `shown ${press.shown[FADE_IN_END]} ${press.shown[FADE_IN_END + 1]}`);
  check("the pointer is off from the next update through the fade-out, the boot stages and the frame the disk menu opens", press.shown.slice(FADE_IN_END + 2, press.diskAt + 1).every((v) => v === false));
  check("the game proper's arrow shows from the frame after the disk menu opens", press.shown[press.diskAt + 1] === true);
  check("clicks on a disk icon during the fade-out open nothing: the press-chosen menu holds no scene and no list", press.stages.slice(FADE_IN_END + 1, FADE_IN_END + FADE_OUT + 1).every((s) => s === "language") && press.g.map === null && press.g.heldScene === null);
  // One-time: the disk menu object opened when the boot stages end is the one that stays; no later update reopens it.
  const menuAt = press.g.diskMenu;
  press.g.update(at(false));
  check("the disk menu is opened once: later updates keep the same menu", press.g.diskMenu === menuAt && press.g.stage === "disk");
}

// ---- 10. A truly fresh Game (new Game, the boot stages run to the disk menu): the first scenario page starts with no press state.
//         The icon 2 release (`$59C8`, which sets `$5DD4` = -1 before the `$7FE4` dispatch) comes first, so the first page release has
//         no stale icon to dispatch (STATIC, notes/formats/game-proper.md "Scenario list and the held prompt"). A press alone on a row
//         picks nothing, the release picks that row, and the page stays open. test/scenario-pick.mjs starts from a started game instead.
{
  game = bootGame(null);
  idle();
  passBoot(game);
  scenarioIcon();
  check("fresh boot: icon 2 opens the scenario page with nothing held and no map", game.stage === "scenario" && game.diskMenu?.listKind === "scenario" && game.heldScene === null && game.map === null);
  idle();
  idle();
  check("the fresh page's first idle frames pick nothing (the click that opened it is already up)", game.stage === "scenario" && game.heldScene === null && game.diskMenu?.listKind === "scenario");
  const rowY = 0x20 + 3 * 9 + 4; // row 4 (index 3), as tapRow (the list's $20 + 9 n geometry)
  frame(false, 100, rowY);
  frame(true, 100, rowY);
  check("a press alone on row 4 of the fresh page picks nothing and opens no other page", game.stage === "scenario" && game.heldScene === null && game.diskMenu?.listKind === "scenario");
  frame(false, 100, rowY);
  check("the release picks row 4 (scenario 3); the page stays open, no load page and no map", game.stage === "scenario" && game.heldScene?.index === 3 && game.diskMenu?.listKind === "scenario" && game.map === null && game.diskMenu?.listKind === "scenario");
}

// ---- 11. Icon 2's release opens the wait, not the list (STATIC, notes/formats/game-proper.md, "Opening click and the held press"): the
//         icon acts on its release, so the release over row 4 picks nothing and prints `$13B` (string 315) on the disk menu. The next press
//         opens the page; that press held through the page's first poll arms row 4, and its release picks row 4.
{
  game = bootGame(null);
  idle();
  passBoot(game);
  const [cx, cy] = centre(DISK_BUTTON.scenario);
  const rowAt = (row) => 0x20 + row * 9 + 4;
  idle();
  frame(true, cx, cy);
  frame(true, 100, rowAt(3));
  frame(false, 100, rowAt(3));
  check("icon 2 pressed and released over row 4: no list, no held scene, the disk menu shows the $13B wait line", game.stage === "disk" && game.menu === null && game.heldScene === null && game.map === null && game.diskMenu.shownPrompt.join() === "315,0");
  idle();
  idle();
  check("idle frames during the wait pick nothing and keep the $13B line", game.stage === "disk" && game.heldScene === null && game.diskMenu.shownPrompt.join() === "315,0");
  frame(true, 100, rowAt(3));
  check("a fresh press on row 4 opens the page (the press pending), the disk menu's prompt is cleared, nothing picked yet", game.stage === "scenario" && game.diskMenu?.listKind === "scenario" && game.heldScene === null && game.diskMenu?.listKind === "scenario");
  frame(true, 100, rowAt(3));
  check("the press still held at the page's first poll picks nothing by itself", game.stage === "scenario" && game.heldScene === null);
  frame(false, 100, rowAt(3));
  check("the release picks row 4 (scenario 3); the page stays open, no map", game.stage === "scenario" && game.heldScene?.index === 3 && game.diskMenu?.listKind === "scenario" && game.map === null && game.diskMenu?.listKind === "scenario");
}

console.log(failed === 0 ? "all boot menu checks passed" : `${failed} boot menu check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
