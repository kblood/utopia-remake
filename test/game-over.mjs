// Game over: the state after the announcement, and where the daily pass stops (src/game/game.ts, src/game/sim.ts).
// Static evidence (Disk.1, notes/formats/game-proper.md "Game over"): `$B0B0` (population, from `$B086`) and `$10E0A` (unrest colony
// fall) call `$E770` with d1 = 1 or 0, then `bset #3` on `$156AA` and `jmp $157AE`. The jump never returns to the daily caller, so
// the rest of that daily pass does not run. `$157AE` calls `$7E52` (the disk menu) and its loop `$7EF6` does not run the sim; the exit
// `$802C` is refused while bit 3 is set. So the game-over state is the disk menu over a frozen map: exit and save refused, the
// scenario and load icons still open their pages. This is a static model; no emulator comparison is claimed.
// Needs the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("game-over tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState, A, PERIOD } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim, SYS } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { createHardware } = await import("../dist/game/sim-hardware.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);
const records = readScenarioRecords(disk2);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- 1. The daily cut-off in the sim -------------------------------------------------------------------------------------
// `$B086` jumps out of `$99C4`'s daily pass: the countdown `$144BD` ($9A22, `subq.b #1`), the message timers, the event scheduler
// and `$AF12` do not run, and the weekly bit (`$144C1` bit 1, cleared after the daily block) stays pending.
function simWith(population) {
  const state = new GameState(disk2, records[0].block);
  const sim = new Sim(new World(state, loadMap(disk2, records[0])), { rng: createRng(1) });
  state.setLong(A.population, population);
  state.setByte(0x144bd, 5);
  state.setByte(A.pending, PERIOD.daily | PERIOD.weekly);
  return { state, sim };
}
{
  const control = simWith(1000);
  control.sim.run();
  check("sim control: a populated colony runs the daily countdown ($144BD 5 -> 4) and consumes the weekly bit", !control.sim.gameOver && control.state.byte(0x144bd) === 4 && (control.state.byte(A.pending) & PERIOD.weekly) === 0);

  const over = simWith(10);
  over.sim.run();
  check("sim game over: the daily pass stops at $B086 (countdown untouched, announcement 1 queued, flag set)", over.sim.gameOver && over.state.byte(0x144bd) === 5 && over.sim.events.some((e) => e.kind === "announce" && e.id === 1));
  check("sim game over: the weekly bit stays pending (the jump skips the later periods)", (over.state.byte(A.pending) & PERIOD.weekly) !== 0 && (over.state.byte(A.pending) & PERIOD.daily) === 0);
  const before = over.state.byte(A.pending);
  over.sim.run();
  check("sim game over: a later pass does nothing at all", over.state.byte(0x144bd) === 5 && over.state.byte(A.pending) === before && over.sim.events.length === 1);
}

// ---- 2. The game-over state of Game -----------------------------------------------------------------------------------------
const newGame = () => {
  const g = new Game(disk1, disk2, null, null);
  g.strings = strings;
  g.bootMenuOpen = false; // the game proper (the boot session is test/boot-menu.mjs)
  g.stage = "scenario";
  return g;
};
const idle = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const frame = (g, down, x, y, right = false) => g.update({ leftButton: down, rightButton: right, pointerX: x, pointerY: y, keys: [] });
const click = (g, x, y) => { frame(g, true, x, y); frame(g, true, x, y); frame(g, false, x, y); };
const centre = (i) => [DISK_MENU_BUTTONS[i].x0 + 16, DISK_MENU_BUTTONS[i].y0 + 16];
const iconClick = (g, i) => click(g, ...centre(i));
// Icon 2 opens the list only after a second fresh press off the rows (the original's $2E48 wait); that press opens the page.
const scenarioIcon = (g) => {
  iconClick(g, DISK_BUTTON.scenario);
  frame(g, true, 0, 0);
  frame(g, false, 0, 0);
};
const press = (g, row) => { // one left click on a menu row (the menu ignores the press that opened it); a map stage is never ticked here
  // The scenario page uses the list geometry (rows at $20 + 9 n, x $38..$88); the remake pages keep their panel (12 px rows).
  const at = g.stage === "scenario" ? { pointerX: 100, pointerY: 0x20 + row * 9 + 4, rightButton: false } : { pointerX: 50, pointerY: 40 + 16 + row * 12 + 4, rightButton: false };
  g.update({ ...at, leftButton: false });
  g.update({ ...at, leftButton: true });
  if (g.stage !== "map") g.update({ ...at, leftButton: false });
};
const rowOf = (g, text) => g.menu.entries.findIndex((e) => e.label.startsWith(text));
const info = (g) => g.diskMenu.shownInfo.join();
// The remake's right click from the scenario page back to the disk menu (the list stays open after a pick); the frames after it are
// the new menu's opening guard.
const backToDisk = (g) => { frame(g, false, 0, 0); frame(g, false, 0, 0, true); frame(g, false, 0, 0); };
// The announcement's command button 9 (the exit icon, $5E06 rectangle 9): press and release on it leave the dialog. The first update
// of a new dialog only initialises its pointer (announce.ts `Pointer`), so the sequence starts with a released frame.
const leaveAnnouncement = (g) => { frame(g, false, 279, 146); frame(g, true, 279, 146); frame(g, false, 279, 146); };
// An apparition is one of the current scenario's marker cells ($144A6 markers at $14524 + 2i, the boot-menu test's rule).
const isMarker = (state, alien) => alien !== null && Array.from({ length: state.word(0x144a6) }, (_, i) => [
  state.byte(0x14524 + 2 * i), state.byte(0x14525 + 2 * i),
]).some(([x, y]) => x === alien.x && y === alien.y);
const snapshot = (g) => ({ date: g.map.world.state.dateText(), vbls: g.map.loop.vbls, passes: g.map.loop.passes, events: g.map.sim.events.length, over: g.map.sim.gameOver });

// Population game over through the real update path: the daily pass runs inside the map loop and its event is shown.
{
  const g = newGame();
  g.startScenario(0);
  const map = g.map;
  map.world.state.setLong(A.population, 10);
  map.world.state.setByte(A.pending, PERIOD.daily);
  map.sim.run();
  g.update(idle);
  check("game over (population): the announcement opens over the map (id 1)", g.stage === "announce" && g.announce !== null && g.announce.id === 1, `stage ${g.stage}`);
  leaveAnnouncement(g);
  check("game over: the dialog closes to the DISK MENU, not the scenario list or the map", g.stage === "disk" && g.diskMenu !== null && g.menu === null && g.map === map);
  check("game over: the boot-menu flag stays clear and no held scene exists (the game proper, not the boot session)", g.bootMenuOpen === false && g.heldScene === null);
  check("game over: the disk menu is the screen", g.screen === g.diskMenu.screen);

  const frozen = snapshot(g);
  for (let i = 0; i < 300; i++) g.update(idle);
  check("game over: 300 frames on the disk menu tick no map and no sim (stale map stays frozen)", g.stage === "disk" && JSON.stringify(snapshot(g)) === JSON.stringify(frozen), JSON.stringify(snapshot(g)));

  iconClick(g, DISK_BUTTON.exit);
  check("game over: the exit icon is refused and the disk menu stays (no boot exit, no map)", g.stage === "disk" && g.bootMenuOpen === false && g.map === map);
  iconClick(g, DISK_BUTTON.save);
  check("game over: the save icon prints $18A and opens nothing", g.stage === "disk" && info(g) === "394,0");

  scenarioIcon(g);
  check("game over: the scenario icon still opens the scenario list", g.stage === "scenario" && g.diskMenu?.listKind === "scenario");
  press(g, 1);
  // Original `$88F0`: the scenario is built (`$866E`/`$875C` clear bit 3) and "Scenario loaded. Select 'EXIT' to play." ($8B) is printed,
  // then the disk-menu loop `$7EF6` continues. Only the exit leaves it, so the picked scene waits behind the disk menu.
  check("game over: a picked scenario keeps the list open with $8B on its prompt line, held (old game-over map still shown until EXIT)", g.stage === "scenario" && g.heldScene?.index === 1 && g.map === map && g.map.sim.gameOver === true && g.diskMenu.promptCodes?.join() === g.strings.get(139).join());
  backToDisk(g);
  check("game over: the right click is a no-op on the list (still the list, held $8B prompt); the $18A result line from before the list is still counting down (`$82B8` never erases result lines)", g.stage === "scenario" && g.heldScene?.index === 1 && g.diskMenu.shownPrompt.join() === "139,0" && info(g) === "394,0", `stage ${g.stage} held ${g.heldScene?.index} prompt ${g.diskMenu?.shownPrompt.join()} info ${info(g)}`);
  iconClick(g, DISK_BUTTON.save);
  check("game over: a held scene is saved, not refused: SAVE opens the slot page with the held scene kept (the live game over is not the held session)", g.stage === "save" && g.menu !== null && g.heldScene?.index === 1 && g.map === map);
  backToDisk(g);
  check("game over: BACK from the save page returns to the list with the held $8B prompt", g.stage === "scenario" && g.heldScene?.index === 1 && g.diskMenu?.listKind === "scenario" && g.diskMenu.shownPrompt.join() === "139,0", `stage ${g.stage} prompt ${g.diskMenu?.shownPrompt.join()}`);
  iconClick(g, DISK_BUTTON.exit);
  check("game over: EXIT enters the picked scenario: a fresh map, game over cleared, nothing held", g.stage === "map" && g.map !== map && g.map.sim.gameOver === false && g.heldScene === null && g.bootMenuOpen === false);
  // Restart (static trace, game-proper.md "Restart"): the game-over tail returned through $157B4, so this exit runs $15EF0 and the
  // apparition $11476 again. APPROXIMATION: the marker is one remake-RNG draw over the scenario's markers, not the original's value.
  const restarted = g.map;
  check("restart: the exit draws one apparition at a marker of the picked scenario (remake RNG approximation)", restarted.world.state.word(0x144a6) > 0 && isMarker(restarted.world.state, restarted.sim.aliens.alien));
  // A map icon's disk menu returns through $15AEC: its later exit draws no apparition, even on the restarted game.
  g.openMapDiskMenu();
  g.update(idle); // the opening-click guard (as test/boot-menu.mjs openDisk)
  scenarioIcon(g);
  press(g, 2);
  backToDisk(g);
  iconClick(g, DISK_BUTTON.exit);
  check("after the restart, a pick from a map-icon disk menu enters with no apparition ($15AEC return)", g.stage === "map" && g.scenario === 2 && g.map.sim.aliens.alien === null);
}

// ---- 2b. Restart by the tutorial, and a second game over: each tail exit runs the apparition once -----------------------------
{
  const g = newGame();
  g.startScenario(0);
  const gameOverOn = (game) => {
    const m = game.map;
    m.world.state.setLong(A.population, 10);
    m.world.state.setByte(A.pending, PERIOD.daily);
    m.sim.run();
    game.update(idle);
    leaveAnnouncement(game);
    game.update(idle); // the opening-click guard of the new disk menu
    return m;
  };
  gameOverOn(g);
  check("second game over setup: the game-over tail shows the disk menu with no held scene", g.stage === "disk" && g.heldScene === null && g.map.sim.gameOver === true);
  iconClick(g, DISK_BUTTON.tutorial);
  check("tutorial restart: the tutorial's exit is not refused and enters at once with one apparition ($80C8 bra $802C, $157B4 return)", g.stage === "map" && g.map.sim.gameOver === false && g.heldScene === null && isMarker(g.map.world.state, g.map.sim.aliens.alien));
  const second = gameOverOn(g);
  check("second game over (after the tutorial): the tail shows the disk menu over the frozen map", g.stage === "disk" && g.map === second && second.sim.gameOver === true);
  // The ended game's generator state: the restart continues it (original seed `$2EA0`, never reseeded; sim-port.md).
  const endedRng = second.sim.rngState;
  scenarioIcon(g);
  press(g, 0);
  check("second game over: a pick is held (list open) and the exit enters it once with its apparition", g.heldScene?.index === 0 && g.stage === "scenario");
  backToDisk(g);
  iconClick(g, DISK_BUTTON.exit);
  check("second restart: the exit enters a fresh map with one marker apparition", g.stage === "map" && g.map !== second && g.map.sim.gameOver === false && isMarker(g.map.world.state, g.map.sim.aliens.alien));
  // Regression: a restart used to start the default seed again, so every restart drew the same first value. Now the next draw of the
  // ended game's stream (scenario 0 markers, the same range) is the marker and the stream continues after it.
  const expected = createRng(0);
  expected.setState(endedRng);
  const markers = g.map.world.state;
  const k = expected(markers.word(0x144a6));
  const want = { x: markers.byte(0x14524 + 2 * k), y: markers.byte(0x14525 + 2 * k) };
  const alien = g.map.sim.aliens.alien;
  // The exit's immediate first pass draws too, so only the apparition cell is compared (the old default-seed draw was 7,65 here).
  check("second restart continues the ended game's generator: the apparition is the next draw of that stream", alien !== null && alien.x === want.x && alien.y === want.y, `got ${alien?.x},${alien?.y} want ${want.x},${want.y}`);
}

// ---- 2c. A remake load from the game-over tail keeps the saved generator (only a new game continues the ended one) ----------
{
  const g = newGame();
  g.startScenario(0);
  g.map.sim.restoreRngState(0x12345678);
  check("load from the tail: the test game saves into slot 1 (not game over)", g.saveToSlot(0) === true);
  const m = g.map;
  m.sim.roll(7); // the ended game draws after the save, so its generator state differs from the saved one
  m.world.state.setLong(A.population, 10);
  m.world.state.setByte(A.pending, PERIOD.daily);
  m.sim.run();
  g.update(idle);
  leaveAnnouncement(g);
  g.update(idle);
  check("load from the tail: game over with the tail menu open", g.stage === "disk" && g.map.sim.gameOver === true && g.diskMenuFromTail === true);
  const endedRng = g.map.sim.rngState;
  check("load from the tail: the ended game's generator differs from the saved one (the test can tell them apart)", endedRng !== 0x12345678);
  g.loadFromSlot(0, true);
  check("load from the tail: the loaded scene is held with the saved generator state, not the ended game's", g.heldScene !== null && g.heldScene.map.sim.rngState === 0x12345678 && g.map === m);
}

// ---- 2d. Generator carry: both streams continue the ended game's, exactly at build time; an injected generator is kept; a
// save taken after a restart loads back with the same streams. (Hardware is continuous in the original, so it must not replay.)
{
  const endedGame = (game) => {
    const m = game.map;
    for (let i = 0; i < 5; i++) { m.sim.roll(9); m.sim.todLow(); m.sim.rasterParity(); } // both streams move before the tail
    m.world.state.setLong(A.population, 10);
    m.world.state.setByte(A.pending, PERIOD.daily);
    m.sim.run();
    game.update(idle);
    leaveAnnouncement(game);
    game.update(idle);
    return m;
  };
  const pickZero = (game) => {
    scenarioIcon(game);
    press(game, 0);
    backToDisk(game);
    iconClick(game, DISK_BUTTON.exit);
  };
  // Held pick: the scene is built at the pick, so its state is the carried state at once (no pass, no draw in between).
  const g = newGame();
  g.startScenario(0);
  const ended = endedGame(g);
  const endedRng = ended.sim.rngState;
  const endedHw = JSON.stringify(ended.sim.hardwareState);
  scenarioIcon(g);
  press(g, 0);
  check("carry (held pick): the built scene's generator is the ended game's state, exactly", g.heldScene?.map.sim.rngState === endedRng);
  check("carry (held pick): the hardware streams are the ended game's, not the default seeds", JSON.stringify(g.heldScene?.map.sim.hardwareState) === endedHw && endedHw !== JSON.stringify(createHardware().getState()));
  backToDisk(g);
  iconClick(g, DISK_BUTTON.exit);
  check("carry: the restart is a fresh map with one apparition", g.stage === "map" && g.map.sim.gameOver === false && isMarker(g.map.world.state, g.map.sim.aliens.alien));

  // Save after the restart, draw on, then load: the generators are the saved ones (the save path stores both).
  const savedRng = g.map.sim.rngState;
  const savedHw = JSON.stringify(g.map.sim.hardwareState);
  check("carry: the restarted game saves into slot 0", g.saveToSlot(0) === true);
  g.map.sim.roll(7);
  g.map.sim.todLow();
  check("carry: the generators moved after the save (the load must put them back)", g.map.sim.rngState !== savedRng);
  check("carry: the saved game loads with the saved generator and hardware streams", g.loadFromSlot(0) === true && g.map.sim.rngState === savedRng && JSON.stringify(g.map.sim.hardwareState) === savedHw, `load ${g.lastLoadError?.message ?? ""}`);
  storage.delete("utopia-remake-save-0");

  // An injected generator (explicit harness input) is not overwritten by the carry; the hardware still carries.
  const h = new Game(disk1, disk2, null, null, { simulation: { rng: createRng(5) } });
  h.strings = strings;
  h.bootMenuOpen = false;
  h.stage = "scenario";
  // The first game is built without the injected inputs (a fresh scene would take the same injected object as the restart).
  h.enterScene(0, h.createScene(0, false));
  const hEnded = endedGame(h);
  const hEndedRng = hEnded.sim.rngState;
  scenarioIcon(h);
  press(h, 0);
  check("carry (injected rng): the injected generator state is kept, not the ended game's", h.heldScene?.map.sim.rngState === 5 && hEndedRng !== 5);
  check("carry (injected rng): hardware still carried from the ended game", JSON.stringify(h.heldScene?.map.sim.hardwareState) === JSON.stringify(hEnded.sim.hardwareState));
}

// ---- 1b. The colony fall leaves the event index alone (`$10E0A` jumps out of `$10E1E`) -------------------------------------
// Static trace (Disk.1, read with tools/game_img.py, 2026-11-13): dispatch slot 19 (`$144BF` = 19, jump-table entry `$10ECA`) is the
// crime event `$10C72`. Its riot routine `$10D9E` branches to `$10E0A` when `$144BE` runs out. `$10E0A` calls `$E770` (announcement 0),
// sets bit 3 of `$156AA` and does `jmp $157AE`. The index advance `addq.b #1,$144BF` at `$10E50` follows the handler's `jsr` and is never
// reached, so after a colony fall the index still names the event that fell. A crime result that is not a riot still advances it.
// Regression for the remake's scheduler, which advanced the index after every handler (discriminating: index 20 before the fix).
function crimeDay(crime) {
  const state = new GameState(disk2, records[0].block);
  const sim = new Sim(new World(state, loadMap(disk2, records[0])), { rng: createRng(7), demolishAt: () => [] });
  state.setLong(A.population, 1000); // above both loss thresholds, so the population check does not end the game first
  state.setByte(A.day, 5); // not day 1: no quality-of-life pass
  state.setByte(0x144bf, 19); // event slot: crime
  state.setByte(0x13118 + 19, 100); // its chance byte
  state.setLong(0x142ce, crime); // crime percent
  state.setByte(0x144c6, 0); // security 0: a riot round cannot be stopped
  state.setByte(0x144be, 1); // one riot round left: the next round ends the colony
  state.setByte(A.pending, PERIOD.daily);
  sim.run();
  return { state, sim };
}
{
  const fall = crimeDay(70); // above 60: the riot routine
  check("colony fall via the crime slot: announcement 0 queued and the game-over flag set", fall.sim.gameOver && fall.sim.events.some((e) => e.kind === "announce" && e.id === 0));
  check("colony fall via the crime slot: the event index stays on slot 19 (the original's `jmp` skips `$10E50`)", fall.state.byte(0x144bf) === 19, `index ${fall.state.byte(0x144bf)}`);

  const quiet = crimeDay(16); // 16: a small crime result, no riot, no game over
  check("crime without a riot: no game over and the event index advances to 20", !quiet.sim.gameOver && quiet.state.byte(0x144bf) === 20, `index ${quiet.state.byte(0x144bf)}`);
}

// The colony fall (announcement 0, `$10E0A`) takes the same route.
{
  const g = newGame();
  g.startScenario(0);
  g.map.sim.sysFlags |= SYS.gameOver;
  g.map.sim.events.push({ kind: "announce", id: 0 });
  g.update(idle);
  check("colony fall (id 0): the dialog opens with its own id", g.stage === "announce" && g.announce.id === 0);
  leaveAnnouncement(g);
  check("colony fall: the dialog closes to the disk menu", g.stage === "disk" && g.diskMenu !== null);
}

// Queued announcements: the sim's order is kept, one dialog at a time, and the game over is not lost behind a quality-of-life dialog.
{
  const g = newGame();
  g.startScenario(0);
  g.map.sim.sysFlags |= SYS.gameOver;
  g.map.sim.events.push({ kind: "announce", id: 2 }, { kind: "announce", id: 1 });
  g.update(idle);
  check("queued: the first announcement (id 2) opens and the game-over one waits", g.stage === "announce" && g.announce.id === 2);
  leaveAnnouncement(g);
  check("queued: the second dialog opens next (game over, id 1), not the map", g.stage === "announce" && g.announce.id === 1);
  leaveAnnouncement(g);
  check("queued: after the last dialog of a game over, the disk menu", g.stage === "disk" && g.diskMenu !== null);
}

// A quality-of-life dialog alone (no game over) still returns to the map.
{
  const g = newGame();
  g.startScenario(0);
  g.map.sim.events.push({ kind: "announce", id: 2 });
  g.update(idle);
  leaveAnnouncement(g);
  check("quality of life (id 2) without game over: the dialog returns to the map", g.stage === "map" && g.map.sim.gameOver === false);
}

// Failed load on a game-over game: its error menu's BACK label names the disk menu and returns there, not to a map.
{
  const g = newGame();
  g.startScenario(0);
  g.map.sim.sysFlags |= SYS.gameOver;
  storage.set("utopia-remake-save-4", "{oops");
  g.openDiskMenu();
  g.update(idle); // consumes the opening-click guard of the scene (as game-music.mjs openDisk)
  iconClick(g, DISK_BUTTON.load);
  check("game over: the load page opens from the disk menu", g.stage === "load");
  press(g, 4);
  check("game over: a corrupt slot shows the load error", g.stage === "sloterror" && g.lastLoadError !== null);
  const back = rowOf(g, "BACK TO");
  check("game over: the error menu's back entry reads BACK TO DISK MENU", back >= 0 && g.menu.entries[back].label === "BACK TO DISK MENU", back >= 0 ? g.menu.entries[back].label : "none");
  press(g, back);
  check("game over: leaving the error returns to the disk menu, not the map", g.stage === "disk" && g.diskMenu !== null && g.map.sim.gameOver === true);
  storage.delete("utopia-remake-save-4");
}

// Without game over the load error's BACK still reads BACK TO DISK MENU and returns to the disk-menu loop, not the map: a refused
// load returns to the loop (original `$85FE`/`$8828` path, notes/formats/game-proper.md "Load failure and return"); only EXIT leaves it.
{
  const g = newGame();
  g.startScenario(0);
  storage.set("utopia-remake-save-4", "{oops");
  g.openDiskMenu();
  g.update(idle); // consumes the opening-click guard of the scene (as game-music.mjs openDisk)
  iconClick(g, DISK_BUTTON.load);
  press(g, 4);
  const back = rowOf(g, "BACK TO");
  check("no game over: the load error's back entry reads BACK TO DISK MENU", back >= 0 && g.menu.entries[back].label === "BACK TO DISK MENU", back >= 0 ? g.menu.entries[back].label : "none");
  press(g, back);
  check("no game over: leaving the load error returns to the disk-menu loop, not the map", g.stage === "disk" && g.diskMenu !== null);
  storage.delete("utopia-remake-save-4");
}

if (failed) {
  console.log(`\n${failed} game-over check(s) failed`);
  process.exit(1);
}
console.log("\nall game-over checks passed");
