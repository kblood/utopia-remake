// Headless end-to-end playthrough of the real Game (src/game/game.ts), driven only by Game.update with mouse and key inputs.
// Scenarios: A boot (intro click, language click, boot stages to the disk menu); B every scenario (0-9) and the tutorial through the
// disk menu, EXIT, then map checks (scroll limits, F1-F6, command column with the build menu pages, disk icons, placing and
// demolishing, existing buildings, pause, 20,000 updates); C save to a slot, run on, load and compare, 2,000 more updates; D colony
// fall (game over) to the disk menu and a new scenario; E alien weekly victory (weeklyBattle, sim-aliens.ts).
// Every update is inside error capture (scenario, step, stage, stack). Coordinates come from the source: the command and icon
// rectangles from the image table (Ui, `$5E06`) and DISK_MENU_BUTTONS, the scroll arrows and the cell diamonds from map.ts and
// controls.ts (copied, and checked where a check is possible). Real Game.update input throughout, except where a step says it
// sets state directly (population, alien age, front units for the fall and the victory).
// Uses the user's own Disk.1 / Disk.2 (read-only); skipped when they are missing. Save slots are written to the in-memory store.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("playthrough tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const dist = (p) => import(pathToFileURL(path.join(root, "dist", p)).href);
const { GameStrings } = await dist("data/gamestrings.js");
const { MAP_WIDTH, MAP_HEIGHT } = await dist("data/scenario.js");
const { Game } = await dist("game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await dist("game/disk-menu.js");
const { Ui } = await dist("game/screens/ui.js");
const { reportRefusal, councilRefusal } = await dist("game/screens/index.js");
const { MENU_PAGES, BUILD_MENU_HITBOXES, menuTiles } = await dist("game/build-menu.js");
const { SAVE_SLOTS, encodeSave, readSlot } = await dist("game/save.js");
const { captureSession } = await dist("game/save-session.js");
const { A, PERIOD } = await dist("game/state.js");
const { SYS } = await dist("game/sim.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);
const ui = new Ui(disk1, strings);

// ---- bookkeeping ---------------------------------------------------------------------------------------------------------------
const started = Date.now();
const counts = { ok: 0, failed: 0 };
const failedNames = [];
let L = "boot"; // the scenario label the checks and crash records carry
let S = "start"; // the step label
const crashes = [];
const notes = []; // informational outcomes (not checks): game over reached, windows counted, and similar
let frames = 0;
let session = null; // { game, music, updates }
let pixelSamples = 0;
const pixelFaults = [];
const moneyFaults = [];
const stats = { announcements: 0, offers: 0 };

function check(name, ok, detail = "") {
  if (ok) {
    counts.ok++;
    console.log(`ok   ${name}`);
  } else {
    counts.failed++;
    failedNames.push(name);
    console.log(`FAIL ${name}${detail ? "  " + detail : ""}`);
  }
  return ok;
}
const note = (text) => {
  notes.push(`${L}: ${text}`);
  console.log(`note ${L}: ${text}`);
};

class Abort extends Error {}

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

// Samples every 50 updates: the screen palette indices stay below 32 (five bitplanes) and the money is a finite integer.
function sample(game) {
  pixelSamples++;
  const px = game.screen.pixels;
  let max = 0;
  for (let i = 0; i < px.length; i++) if (px[i] > max) max = px[i];
  if (max >= 32 && pixelFaults.length < 5) pixelFaults.push(`${L} stage ${game.stage} max ${max}`);
  if (game.map) {
    const money = game.map.world.state.signedLong(A.money);
    if (!Number.isInteger(money) && moneyFaults.length < 5) moneyFaults.push(`${L} money ${money}`);
  }
}

// One Game.update, inside error capture. A throw is recorded with its scenario, step, stage and stack, and aborts the entry.
function upd(input) {
  const game = session.game;
  try {
    game.update({ ...input, keys: input.keys ?? [] });
  } catch (error) {
    const stack = error?.stack ?? String(error);
    crashes.push({ scenario: L, step: S, stage: game.stage, message: String(error?.message ?? error), stack });
    console.log(`FAIL crash: ${L} / ${S} (stage ${game.stage}): ${error?.message ?? error}`);
    console.log(stack.split("\n").slice(0, 8).map((l) => `       ${l}`).join("\n"));
    throw new Abort("crash");
  }
  frames++;
  session.updates++;
  if (session.updates % 50 === 0) sample(game);
}

const NONE = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
const at = (left, x = 0, y = 0, right = false, keys = []) => ({ leftButton: left, rightButton: right, pointerX: x, pointerY: y, keys });
const idle = (n = 1) => { for (let i = 0; i < n; i++) upd(NONE); };
const stageNow = () => session.game.stage;
const map = () => session.game.map;
const controls = () => session.game.map.controls;

// Map and dialogs: a click is held for 5 updates and released for 5. The map reads input only on its completed passes (4 updates
// each), so a press must span one pass boundary and the release must be seen after it.
function click(x, y) {
  settle();
  for (let i = 0; i < 5; i++) upd(at(true, x, y));
  for (let i = 0; i < 5; i++) upd(at(false, x, y));
  idle(4); // the map acts on the release at its next completed pass (up to 4 updates later)
}
// Right button: held across a pass boundary, then released.
function rightClick() {
  for (let i = 0; i < 5; i++) upd(at(false, 0, 0, true));
  for (let i = 0; i < 5; i++) upd(at(false));
}
// Dialogs (announcements, Earth offers) take the first update to initialise their pointer: the leading release is that update.
function dismissAnnouncement() {
  upd(at(false, 279, 146));
  upd(at(true, 279, 146));
  upd(at(false, 279, 146));
  stats.announcements++;
}
function answerOffer() {
  const accept = stats.offers % 2 === 0; // alternate ACCEPT and REFUSE (offer.ts BUTTONS)
  const x = accept ? 111 : 207;
  upd(at(false, x, 148));
  upd(at(true, x, 148));
  upd(at(false, x, 148));
  stats.offers++;
}
// Any announcement or Earth offer that is up is answered before the next input.
function settle() {
  for (let n = 0; n < 40; n++) {
    const stage = stageNow();
    if (stage === "announce") dismissAnnouncement();
    else if (stage === "offer") answerOffer();
    else return;
  }
}

// Command buttons and icons, from the rectangle tables. cmd(i): the image table's rectangle i (`$5E06`, the map's column and the
// window exits, `Ui.buttonPosition`), 16 x 16; the centre is +8. icon(i): DISK_MENU_BUTTONS (the disk picture), 32 x 32.
const cmd = (i) => { const p = ui.buttonPosition(i); return [p.x + 8, p.y + 8]; };
// The overview's own button table (overview.ts BUTTON_RECTS = $FF5C, eight {x0, x1, y0, y1} records): its exit is button 7 of that
// table, not the map's command button 7 (the window is drawn over the map, so the two tables differ).
const { GameImage } = await dist("game/screens/image.js");
const overviewImage = new GameImage(disk1);
const overviewCentre = (i) => {
  const a = 0xff5c + 8 * i;
  return [(overviewImage.word(a) + overviewImage.word(a + 2)) >> 1, (overviewImage.word(a + 4) + overviewImage.word(a + 6)) >> 1];
};
const icon = (i) => { const r = DISK_MENU_BUTTONS[i]; return [r.x0 + 16, r.y0 + 16]; };
// Remake pages (menu.ts: LEFT 40, TOP 40, ROW 12, rows at TOP + 16 + 12 n) and the scenario and music list (y $20 + 9 n, x 100).
const pageRow = (row) => [50, 40 + 16 + row * 12 + 4];
const listRow = (row) => [100, 0x20 + row * 9 + 4];
// Map view cell (vx, vy) of controls.pickCell: x0 = 112 + 16 (vx - vy), y0 = 24 + 8 (vx + vy), 32 x 15, first match wins.
const viewCell = (vx, vy) => [112 + 16 * (vx - vy) + 15, 24 + 8 * (vx + vy) + 7];
// The map's scroll arrows (map.ts ARROWS, inclusive rectangles): centres of the four.
const ARROW_CENTRE = { left: [226, 127], up: [250, 127], down: [226, 141], right: [250, 141] };

// Scenario pick from the disk picture: icon 2 (its release prints $13B), then a fresh press opens the list (as boot-menu.mjs
// scenarioIcon), then the row.
function pickFromDisk(index) {
  S = `pick scenario ${index + 1} on the disk menu`;
  check(`${L}: the disk menu is open for the scenario icon`, stageNow() === "disk", `stage ${stageNow()}`);
  idle(1); // a leading release: the disk picture takes its first update for the button state, not a press
  click(...icon(DISK_BUTTON.scenario));
  upd(at(true, 0, 0));
  upd(at(false, 0, 0));
  check(`${L}: the scenario list is open`, stageNow() === "scenario" && session.game.diskMenu?.listKind === "scenario", `stage ${stageNow()}`);
  click(...listRow(index));
  check(`${L}: picking row ${index + 1} holds that scenario on the list`, session.game.heldScene?.index === index && stageNow() === "scenario", `held ${session.game.heldScene?.index}`);
}
// EXIT (icon 5) with a held scene enters it; the map must then show that scenario.
function exitToMap(index, label = "") {
  S = "EXIT into the map";
  click(...icon(DISK_BUTTON.exit));
  check(`${L}: EXIT enters the held scenario ${index + 1}${label}`, stageNow() === "map" && session.game.scenario === index && session.game.heldScene === null, `stage ${stageNow()} scenario ${session.game.scenario}`);
}
function openDiskFromMap() {
  S = "map disk icon";
  click(...cmd(8)); // BUTTON.disk
  idle(1); // the disk picture's first update only takes the release (the opening click is not a press)
  check(`${L}: the map's disk icon opens the disk menu`, stageNow() === "disk" && session.game.diskMenu !== null, `stage ${stageNow()}`);
}

// Runs the map for n updates; dismisses announcements and offers as they come. Stops early when the stage leaves the map.
function runMap(n, opts = {}) {
  for (let i = 0; i < n; i++) {
    if (opts.until?.()) return { reached: true, left: false };
    if (opts.stopAt && stageNow() === opts.stopAt) return { reached: true, left: false };
    settle();
    if (stageNow() !== "map") return { reached: false, left: true };
    upd(NONE);
  }
  return { reached: false, left: false };
}

// ---- A. Boot: intro click, language click, boot stages, boot disk menu ---------------------------------------------------------
function newSession() {
  L = "boot";
  S = "boot";
  const music = fakeMusic();
  const game = new Game(disk1, disk2, music, null);
  session = { game, music, updates: 0 };
  S = "intro click";
  // The credit roll: a click (left held) leaves the intro for the language screen. The button is released on the next update.
  for (let n = 0; n < 20000 && stageNow() === "intro"; n++) upd(at(true, 100, 0x10));
  upd(at(false, 100, 0x10));
  S = "language choice";
  check(`${L}: the intro click leads to the language screen`, stageNow() === "language");
  for (let n = 0; n < 400 && !session.game.language?.pointerVisible; n++) upd(NONE); // the fade-in: choosing once it ends
  upd(at(true, 160, 0x10)); // English: the pointer row above $2C (languageAt)
  upd(at(false, 160, 0x10));
  // The choice is returned when the 45-update fade-out ends; the boot stages start in that same update (language.ts).
  for (let n = 0; n < 300 && stageNow() === "language"; n++) upd(NONE);
  check(`${L}: a click in the English band chooses English`, session.game.selectedLanguage === 0 && stageNow() === "boot", `stage ${stageNow()} language ${session.game.selectedLanguage}`);
  S = "boot stages";
  let inCheck = 0;
  for (let n = 1; stageNow() === "boot"; n++) {
    if (n > 30000) throw new Error("the boot stages did not finish");
    if (session.game.boot?.currentPhase === "E") inCheck++;
    upd(at(false, 0, 0, false, inCheck === 50 ? ["Enter"] : [])); // Return in the code check, as boot-menu.mjs does
  }
  check(`${L}: the boot stages end at the boot disk menu`, stageNow() === "disk" && session.game.bootMenuOpen === true && session.game.map === null, `stage ${stageNow()}`);
  return session;
}

// ---- B. Entries: scenario and tutorial -------------------------------------------------------------------------------------------
function scrollWalk(dir, expect, label) {
  S = `scroll ${dir}`;
  const [x, y] = ARROW_CENTRE[dir];
  settle();
  let stopped = false;
  for (let i = 0; i < 480; i++) {
    if (stageNow() !== "map") { stopped = true; break; }
    upd(at(true, x, y));
  }
  upd(at(false, x, y));
  idle(8);
  const m = map();
  check(`${L}: scroll ${dir} reaches the map limit (${label}; view ${m?.scrollX},${m?.scrollY})`, !stopped && m !== null && expect(m), `stopped ${stopped}`);
}

function scrollChecks() {
  const start = [map().scrollX, map().scrollY];
  scrollWalk("left", (m) => m.scrollX === 0 && m.scrollY === start[1], "x 0");
  scrollWalk("up", (m) => m.scrollY === 0, "y 0");
  scrollWalk("right", (m) => m.scrollX === MAP_WIDTH - 8, `x ${MAP_WIDTH - 8}`);
  scrollWalk("down", (m) => m.scrollY === MAP_HEIGHT - 8, `y ${MAP_HEIGHT - 8}`);
  // Released at the limit: a further idle span does not move the view.
  const corner = [map().scrollX, map().scrollY];
  idle(40);
  check(`${L}: the view stays at the corner once released`, corner[0] === map().scrollX && corner[1] === map().scrollY);
}

function windowKeys() {
  S = "F1-F6";
  for (const key of ["F1", "F2", "F3", "F4", "F5", "F6"]) {
    const refused = reportRefusal(map().world.state) >= 0;
    upd(at(false, 0, 0, false, [key]));
    for (let i = 0; i < 8 && stageNow() === "map"; i++) idle(1); // the key is taken by the next completed pass
    if (refused) {
      check(`${L}: ${key} without an online command centre is refused on the map`, stageNow() === "map" && map().sim.gameOver === false);
    } else {
      check(`${L}: ${key} opens its report window`, stageNow() === "screen", `stage ${stageNow()}`);
      idle(1); // a window takes a button already held when it opens as no press (PanelScene pollOriginal): release first
      click(...cmd(9));
      check(`${L}: ${key} window closes on its button to the map`, stageNow() === "map", `stage ${stageNow()}`);
    }
  }
  // Pause on the P key (`$15B4A`): toggles the pause bit; it is off again before the next checks.
  S = "P key";
  upd(at(false, 0, 0, false, ["p"]));
  idle(8);
  check(`${L}: the P key pauses the map`, map().sim.paused === true);
  upd(at(false, 0, 0, false, ["p"]));
  idle(8);
  check(`${L}: a second P key resumes the map`, map().sim.paused === false);
}

// The command column (map buttons 0-9, `$5E06` order) and the disk icons behind button 8.
function commandColumn() {
  S = "command column";
  // 0 build: opens the menu; the three pages; an item on each page; the exit.
  click(...cmd(0));
  check(`${L}: build (button 0) opens the build menu`, controls().menuVisible === true);
  const researchBits = () => map().world.state.long(0x14472); // controls.ts INVENTION
  for (const want of [1, 2, 0]) {
    click(...cmd(8)); // next page (menuRelease: button 8)
    check(`${L}: build menu page button shows page ${want + 1}`, controls().menuState.page === want, `page ${controls().menuState.page}`);
    const tiles = menuTiles(want, researchBits());
    const idx = tiles.findIndex((t, i) => t >= 0 && i < BUILD_MENU_HITBOXES[want].length);
    if (idx >= 0) {
      const r = BUILD_MENU_HITBOXES[want][idx];
      click((r.x0 + r.x1) >> 1, (r.y0 + r.y1) >> 1);
      check(`${L}: an item on page ${want + 1} shows its details`, controls().menuState.detail !== null);
    }
  }
  click(...cmd(9)); // exit (menuRelease: button 9, `$B628`)
  check(`${L}: the build menu exit closes the menu`, controls().menuVisible === false);
  rightClick();
  check(`${L}: a right click returns to select mode`, controls().mode === "select", `mode ${controls().mode}`);

  // 1 overview: a full-screen window; exit is button 7 (overview.ts EXIT_BUTTON_INDEX).
  click(...cmd(1));
  check(`${L}: overview (button 1) opens`, stageNow() === "screen", `stage ${stageNow()}`);
  click(...overviewCentre(7));
  check(`${L}: overview closes on its exit (7)`, stageNow() === "map", `stage ${stageNow()}`);

  // 2 demolish: sets demolish mode; a right click leaves it.
  click(...cmd(2));
  check(`${L}: demolish (button 2) sets demolish mode`, controls().mode === "demolish", `mode ${controls().mode}`);
  rightClick();
  check(`${L}: a right click leaves demolish mode`, controls().mode === "select");

  // 3 marker: arms marker mode; the next cell click places a pin and disarms it.
  click(...cmd(3));
  check(`${L}: marker (button 3) arms marker mode`, map().markerMode?.armed === true);
  const [mx, my] = viewCell(3, 3);
  click(mx, my);
  check(`${L}: the next cell click places the marker and disarms it`, map().markerMode?.armed === false);

  // 4 trade, 6 staff, 7 intelligence: each opens its window, closed on button 9.
  for (const [button, name] of [[4, "trade"], [6, "staff"], [7, "intelligence"]]) {
    click(...cmd(button));
    check(`${L}: ${name} (button ${button}) opens its window`, stageNow() === "screen", `stage ${stageNow()}`);
    click(...cmd(9));
    check(`${L}: ${name} window closes on button 9`, stageNow() === "map", `stage ${stageNow()}`);
  }

  // 5 council: refused without a command centre (the room closes at once with its message), else it opens and a release outside
  // the advisers closes it.
  const councilRefused = councilRefusal({ world: map().world }) >= 0;
  click(...cmd(5));
  idle(2);
  // (195, 150) lies between the adviser rectangles of the council picture ($1614E: x 162-228 is outside all six below y 88).
  if (stageNow() === "screen") click(195, 150);
  check(`${L}: council (button 5) ${councilRefused ? "is refused and returns to the map" : "opens and closes on a release outside the advisers"}`, stageNow() === "map", `stage ${stageNow()}`);

  // 8 disk icon: the disk picture; its icons (effects 8, music 4, format 3, music list 7 with a track, exit 5).
  click(...cmd(8));
  idle(1);
  check(`${L}: the disk icon (button 8) opens the disk menu`, stageNow() === "disk");
  click(...icon(DISK_BUTTON.effects));
  check(`${L}: the effects icon keeps the disk menu (no sound system)`, stageNow() === "disk");
  click(...icon(DISK_BUTTON.music));
  check(`${L}: the music icon keeps the disk menu`, stageNow() === "disk");
  click(...icon(DISK_BUTTON.format));
  check(`${L}: the format icon prints its remake note and keeps the disk menu`, stageNow() === "disk" && session.game.diskMenu.shownInfo[1] === -1);
  click(...icon(DISK_BUTTON.musicSelect));
  check(`${L}: the music icon opens the music list`, session.game.diskMenu?.listKind === "music", `list ${session.game.diskMenu?.listKind}`);
  click(...listRow(1));
  check(`${L}: track 2 of the music list starts that track and closes the list`, session.music.current === 1 && session.game.diskMenu?.listKind === "closed", `track ${session.music.current} list ${session.game.diskMenu?.listKind}`);
  click(...icon(DISK_BUTTON.exit));
  check(`${L}: EXIT from the disk icon returns to the map`, stageNow() === "map");

  // 9 pause: toggles the pause; the first press pauses, the second resumes.
  click(...cmd(9));
  check(`${L}: pause (button 9) pauses the map`, map().sim.paused === true);
  click(...cmd(9));
  check(`${L}: the pause button resumes the map`, map().sim.paused === false);
}

// Build a placed building and demolish it. Returns the placed world cell, or null.
function chooseBuildItem() {
  click(...cmd(0));
  if (!controls().menuVisible) return false;
  for (let n = 0; n < 2 && controls().menuState.page !== 0; n++) click(...cmd(8));
  const researchBits = () => map().world.state.long(0x14472);
  let pending = false;
  for (let page = 0; page < MENU_PAGES.length && !pending; page++) {
    const tiles = menuTiles(page, researchBits());
    for (let idx = 0; idx < tiles.length && idx < BUILD_MENU_HITBOXES[page].length && !pending; idx++) {
      if (tiles[idx] < 0) continue;
      const r = BUILD_MENU_HITBOXES[page][idx];
      click((r.x0 + r.x1) >> 1, (r.y0 + r.y1) >> 1);
      pending = controls().menuState.pending !== null;
    }
    if (!pending && page + 1 < MENU_PAGES.length) click(...cmd(8));
  }
  click(...cmd(9));
  return pending && controls().mode === "build";
}
function placeAndDemolish() {
  S = "place a building";
  let placed = null;
  const scrollX = map().scrollX;
  const scrollY = map().scrollY;
  let chosen = chooseBuildItem();
  check(`${L}: the build menu gives an affordable item and the exit selects it (build mode)`, chosen, `mode ${controls().mode}`);
  for (let k = 0; k < 64 && chosen && !placed; k++) {
    const vx = k % 8;
    const vy = Math.floor(k / 8);
    if (controls().mode !== "build") {
      chosen = chooseBuildItem();
      if (!chosen) break;
    }
    const before = Uint16Array.from(map().world.cells);
    const [px, py] = viewCell(vx, vy);
    click(px, py);
    const x = scrollX + vx;
    const y = scrollY + vy;
    if (map().world.cells[y * MAP_WIDTH + x] !== before[y * MAP_WIDTH + x]) placed = { x, y, value: map().world.cells[y * MAP_WIDTH + x] };
  }
  check(`${L}: a building is placed on a cell of the view`, placed !== null);
  if (!placed) return null;
  S = "demolish a building";
  click(...cmd(2));
  check(`${L}: demolish mode is on for the demolition`, controls().mode === "demolish");
  const vx = placed.x - map().scrollX;
  const vy = placed.y - map().scrollY;
  const [px, py] = viewCell(vx, vy);
  check(`${L}: the view cell of the placed building is the one picked`, controls().pickCell(px, py)?.x === placed.x && controls().pickCell(px, py)?.y === placed.y);
  click(px, py);
  const after = map().world.cells[placed.y * MAP_WIDTH + placed.x];
  check(`${L}: the demolition changes the placed cell`, after !== placed.value, `cell ${after} still ${placed.value}`);
  rightClick();
  check(`${L}: leaving demolish mode after the demolition`, controls().mode === "select");
  return placed;
}

// Click every cell of the start view in select mode: each building that has a window opens it, and EXIT (button 9) closes it.
function existingBuildings() {
  S = "existing buildings";
  let windows = 0;
  for (let k = 0; k < 64; k++) {
    const [px, py] = viewCell(k % 8, Math.floor(k / 8));
    if (controls().mode !== "select") rightClick();
    click(px, py);
    if (stageNow() === "screen") {
      windows++;
      click(...cmd(9));
      if (stageNow() !== "map") { check(`${L}: a building window closes on EXIT`, false, `stage ${stageNow()}`); break; }
    }
  }
  note(`building windows opened by clicking the start view: ${windows}`);
  // Each opened building window is checked to close on EXIT above. Some scenarios start with no building in the view: the count is
  // then 0 and nothing is checked.
}

// The map for `updates` updates, dismissing dialogs; a game over ends the run early (its disk menu is the next stage).
function runFor(updates, label) {
  S = `${label}: ${updates} updates`;
  const r = runMap(updates);
  const gameOver = map()?.sim.gameOver === true;
  if (gameOver) note(`game over reached during ${label}`);
  check(`${L}: ${label}: ${updates} map updates with no crash${gameOver ? " (game over: stopped)" : ""}`, r.reached === false && (r.left === false || gameOver), `stage ${stageNow()} after ${updates}`);
  return r;
}

// Save to a slot (save page, name step by a second click, as boot-menu.mjs tapRow), run on, load (held), EXIT, run on.
function saveLoadCycle(slot, index) {
  S = `save slot ${slot + 1}`;
  openDiskFromMap(); // the save icon is on the disk picture
  click(...icon(DISK_BUTTON.save));
  check(`${L}: the save icon opens the slot page`, stageNow() === "save" && session.game.menu !== null, `stage ${stageNow()}`);
  click(...pageRow(slot));
  if (stageNow() === "save" && session.game.nameEntry) click(...pageRow(slot)); // accept the default name
  const saved = readSlot(slot);
  check(`${L}: the slot ${slot + 1} save is written`, saved.ok === true && stageNow() === "save", saved.ok ? stageNow() : saved.error?.code);
  if (!saved.ok) return;
  check(`${L}: the save holds scenario ${index + 1}`, saved.save.scenario === index);
  const atSave = sessionText(map(), index);
  check(`${L}: the saved file equals the state at the save (encode and decode)`, sessionTextOf(saved.save) === atSave);
  const at_ = stateSummary(map());
  rightClick(); // the save page's BACK: the disk picture
  check(`${L}: BACK from the save page shows the disk picture`, stageNow() === "disk");
  click(...icon(DISK_BUTTON.exit));
  check(`${L}: EXIT returns to the map after the save`, stageNow() === "map");
  runFor(500, "run on after the save");

  S = `load slot ${slot + 1}`;
  openDiskFromMap();
  click(...icon(DISK_BUTTON.load));
  check(`${L}: the load icon opens the load page`, stageNow() === "load", `stage ${stageNow()}`);
  click(...pageRow(slot));
  const held = session.game.heldScene;
  check(`${L}: loading slot ${slot + 1} holds the scene on the disk menu`, held !== null && stageNow() === "disk" && session.game.lastLoadError === null, `stage ${stageNow()} error ${session.game.lastLoadError?.code}`);
  if (!held) return;
  check(`${L}: the loaded scene is scenario ${index + 1}`, held.index === index);
  check(`${L}: the loaded state equals the saved state (text of the session)`, sessionText(held.map, index) === atSave);
  const now = stateSummary(held.map);
  check(`${L}: loaded date, money, population, view and map words equal the saved ones`, now.date === at_.date && now.money === at_.money && now.population === at_.population && now.view === at_.view && now.cells === at_.cells, JSON.stringify({ saved: at_, loaded: now }));
  click(...icon(DISK_BUTTON.exit));
  check(`${L}: EXIT enters the loaded scene`, stageNow() === "map" && map() === held.map);
}

function stateSummary(m) {
  return {
    date: m.world.state.dateText(),
    money: m.world.state.signedLong(A.money),
    population: m.world.state.long(A.population),
    view: `${m.scrollX},${m.scrollY}`,
    cells: hashWords(m.world.cells),
  };
}
function hashWords(words) {
  let h = 0x811c9dc5;
  for (const w of words) h = Math.imul(h ^ w, 0x01000193) >>> 0;
  return h.toString(16);
}
const partsOf = (m) => ({ world: m.world, sim: m.sim, loop: m.loop, units: m.objects?.units ?? null, enemies: m.enemies, markers: m.objects?.markers ?? null, effectPool: m.objects?.pool ?? null, extras: m.objects?.extra ?? null, scroll: m.scrollRef, restoredFromDisk4: m.restoredFromDisk4 });
function sessionText(m, index) {
  const captured = captureSession(partsOf(m), index);
  if (!captured.ok) return `error ${captured.error?.code}`;
  return encodeSave({ ...captured.value, name: null });
}
function sessionTextOf(save) {
  return encodeSave({ ...save, name: null });
}

// One scenario or the tutorial, from the disk picture (or the map, through its disk icon).
function playEntry(entry, slot) {
  L = entry.label;
  S = "start of entry";
  if (stageNow() === "map") openDiskFromMap();
  if (entry.tutorial) {
    S = "tutorial";
    click(...icon(DISK_BUTTON.tutorial));
    check(`${L}: the tutorial enters the map at once (no EXIT: $80C8 ends with bra $802C)`, stageNow() === "map" && session.game.scenario === 0 && (map().sim.sysFlags & (SYS.tutorialMode | SYS.noUnitBonus)) === (SYS.tutorialMode | SYS.noUnitBonus), `stage ${stageNow()}`);
  } else {
    pickFromDisk(entry.index);
    exitToMap(entry.index);
  }
  if (stageNow() !== "map") return;
  // The start view is used by the key, command and building checks; the scroll walk to the limits comes after them.
  windowKeys();
  existingBuildings();
  commandColumn();
  placeAndDemolish();
  scrollChecks();
  // Then the 20,000 updates (dismissing announcements and offers).
  const run = runFor(20000, "20,000-update run");
  if (stageNow() === "map" && map().sim.gameOver !== true) {
    saveLoadCycle(slot, entry.index ?? 0);
    runFor(2000, "2,000 updates after the load");
  } else if (run.left) {
    note("the run ended the map stage early (game over), so save and load were not run for this entry");
  }
}

// ---- D. Colony fall (game over) and a new scenario ---------------------------------------------------------------------------------
function colonyFall() {
  L = "colony fall";
  S = "set up the fall";
  pickFromDisk(3);
  exitToMap(3);
  runMap(300);
  const m = map();
  m.world.state.setLong(A.population, 10); // as test/game-over.mjs: below the population threshold
  m.world.state.setByte(A.pending, PERIOD.daily); // the next pass runs the daily period, which ends the colony
  S = "wait for the game-over announcement";
  const r = runMap(3000, { stopAt: "announce" });
  check(`${L}: the daily pass ends the colony: a game-over announcement opens (id 1)`, stageNow() === "announce" && session.game.announce?.id === 1 && m.sim.gameOver === true, `stage ${stageNow()} gameOver ${m.sim.gameOver} ${r.reached}`);
  S = "dismiss the game over";
  settle();
  check(`${L}: the game-over dialog closes to the disk menu over the frozen map`, stageNow() === "disk" && session.game.map === m && m.sim.gameOver === true, `stage ${stageNow()}`);
  // A new scenario from the disk menu after the fall.
  pickFromDisk(1);
  exitToMap(1, " after the fall");
  check(`${L}: the new game after the fall has no game over`, map().sim.gameOver === false && map() !== m);
  runFor(2000, "a new scenario after the fall");
}

// ---- E. Alien victory (weeklyBattle, sim-aliens.ts) -----------------------------------------------------------------------------
function alienVictory() {
  L = "alien victory";
  S = "set up the battle";
  pickFromDisk(4);
  exitToMap(4);
  runMap(200);
  const m = map();
  const s = m.world.state;
  const FRONT = 0x14274; // own units at the front, per type (longs)
  const REC_AGE = 0x13456 + 0x14; // the alien record's age word
  s.setLong(FRONT + 4 * 3, 10); // ten own units of type 12 at the front
  s.setWord(REC_AGE, 0); // the age has run out: the battle is a victory
  check(`${L}: the victory path is not blocked (no unit bonus flag before the battle)`, (m.sim.sysFlags & SYS.noUnitBonus) === 0);
  s.setByte(A.pending, PERIOD.weekly);
  S = "wait for the weekly battle";
  runMap(3000, { until: () => (m.sim.sysFlags & SYS.noUnitBonus) !== 0 });
  check(`${L}: the weekly battle ends in victory (flag set, $14132 = $FF)`, (m.sim.sysFlags & SYS.noUnitBonus) !== 0 && s.byte(0x14132) === 0xff, `flags ${m.sim.sysFlags.toString(16)} $14132 ${s.byte(0x14132)}`);
  runFor(2000, "2,000 updates after the victory");
  check(`${L}: the victory game keeps its money a finite integer`, Number.isInteger(map().world.state.signedLong(A.money)));
}

// ---- Run --------------------------------------------------------------------------------------------------------------------------
const entries = [
  ...Array.from({ length: 10 }, (_, i) => ({ label: `scenario ${i + 1}`, index: i })),
  { label: "tutorial", tutorial: true },
];

// Runs one step of the scenario in error capture: an Abort (a crash, already recorded) or a test error is reported as a failure.
// Returns true when the step ran to its end.
function guarded(label, fn) {
  try {
    fn();
    return true;
  } catch (error) {
    if (!(error instanceof Abort)) {
      counts.failed++;
      failedNames.push(`${label}: test error`);
      console.log(`FAIL ${label}: test error  ${error?.message ?? error}`);
      console.log(String(error?.stack ?? "").split("\n").slice(0, 6).map((l) => `       ${l}`).join("\n"));
    }
    return false;
  }
}

// Session 1 is the boot; every entry then runs in order. A crash or test error in an entry means the next entry boots a fresh
// session first (a boot that itself fails skips the entry).
let needBoot = true;
entries.forEach((entry, i) => {
  if (needBoot) {
    needBoot = !guarded("boot", () => newSession());
    if (needBoot) {
      check(`${entry.label}: skipped, the boot did not reach the disk menu`, false);
      return;
    }
  }
  needBoot = !guarded(entry.label, () => playEntry(entry, i % SAVE_SLOTS));
  if (needBoot) note("the entry did not finish: the next one starts a fresh session");
});

if (guarded("colony fall", () => newSession())) guarded("colony fall", () => colonyFall());
if (guarded("alien victory", () => newSession())) guarded("alien victory", () => alienVictory());

// ---- Summary ----------------------------------------------------------------------------------------------------------------------
check("the screen stays below palette index 32 at every sample", pixelFaults.length === 0, pixelFaults.join("; "));
check("money stays a finite integer at every sample", moneyFaults.length === 0, moneyFaults.join("; "));
check(`no update throws (${crashes.length} crash${crashes.length === 1 ? "" : "es"})`, crashes.length === 0, crashes.map((c) => `${c.scenario}/${c.step}: ${c.message}`).join("; "));

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log("");
for (const n of notes) console.log(`note ${n}`);
console.log(`playthrough summary: ${counts.ok} ok, ${counts.failed} failed, ${crashes.length} crash(es), ${frames} updates, ${pixelSamples} screen samples, ${stats.announcements} announcements and ${stats.offers} offers answered, ${seconds} s`);
if (failedNames.length) console.log(`failed: ${failedNames.join(" | ")}`);
if (counts.failed > 0 || crashes.length > 0) {
  console.log("playthrough FAILED");
  process.exit(1);
}
console.log("all playthrough checks passed");
process.exit(0);
