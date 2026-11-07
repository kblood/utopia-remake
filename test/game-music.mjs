// Music lifecycle and the music-select flow of Game with an injected fake Music (no audio, no browser).
// Traced from Disk.1 (notes/formats/music.md, "Music-select flow"): the only caller of the track loader $110A is the mode-4
// handler $8A42, so starting a scenario, loading and activating a Disk.4 slot never start or stop a track; the game proper starts
// silent. The disk menu is ONE scene on the original picture (stage "disk"): selecting row 0-3 of its list (icon 7, $1006) loads that
// module and ALWAYS restarts it; rows 4-9 close the list without touching the music; the menu stays on screen (not the map); icons 4
// and 8 toggle music / effects in place with their messages; icon 5 returns to the map; the remake-only pages hang off the right button.
// Uses the user's own Disk.1 / Disk.2 in original/utopia-whdload (read-only); skipped when missing.
// The Disk.4 path is covered in test/disk4-scene.mjs, the list geometry and click timing in test/music-select.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("game music tests skipped: original data not found");
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
const { SFX } = await import("../dist/audio/sfx.js");
const { MUSIC_TOGGLE_STRING, toggleMusic } = await import("../dist/game/music-select.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS, EFFECTS_STRING, INFO_LIFETIME_FRAMES } = await import("../dist/game/disk-menu.js");
const { SYS } = await import("../dist/game/sim.js");
const { A } = await import("../dist/game/state.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const strings = new GameStrings(disk1, 0);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// Same observable contract as createMusic(): play() of the current track is a no-op unless `restart`, `current` is -1 when nothing plays.
function fakeMusic() {
  const m = {
    trackCount: 4,
    current: -1, // selected track, kept while paused
    paused: false,
    calls: [], // { track, restart } of every play()
    activeCalls: [], // every setActive(on) that changed the state
    fades: 0,
    // Same contract as createMusic(): active = loaded and not paused; play() (the loader $110A) leaves the music active.
    get active() { return m.current >= 0 && !m.paused; },
    setActive(on) {
      if (m.current < 0 || m.paused === !on) return false;
      m.paused = !on;
      m.activeCalls.push(on);
      return true;
    },
    play(track, restart = false) {
      m.calls.push({ track, restart });
      if (track < 0 || track >= m.trackCount) return;
      m.current = track;
      m.paused = false;
    },
    stop() { m.current = -1; m.paused = false; },
    fadeOut() { m.fades++; },
    setVolume() {},
    setChannelMuted() {},
    resume() {},
    title: () => "",
    dispose() {},
  };
  return m;
}
function fakeSfx() {
  const s = {
    enabled: true,
    count: 6,
    log: [],
    play: (id, volume) => void s.log.push({ id, volume, enabled: s.enabled }),
    setEnabled: (on) => { s.enabled = on; },
    setVolume() {},
    resume() {},
  };
  return s;
}
const newGame = (music, sfx = null) => {
  const g = new Game(disk1, disk2, music, sfx);
  g.strings = strings;
  g.stage = "scenario";
  return g;
};

// ---- 1. Starting a scenario never starts music -------------------------------------------------------------------------
const scenarioCount = new Game(disk1, disk2, null, null).records.length;

// The fresh-start comparison seam must feed world initialization before `$6D78` builds records.
{
  const phaseTape = [];
  const rngRanges = [];
  const seed = 0x13579bdf;
  const game = new Game(disk1, disk2, null, null, {
    world: {
      solarPhaseSeed: seed,
      startupSolarPhase: () => { const phase = phaseTape.length % 2 === 0; phaseTape.push(phase); return phase; },
    },
    simulation: { rng: (range) => (rngRanges.push(range), 0) },
  });
  game.strings = strings;
  game.startScenario(0);
  const initialMarkers = game.map.world.state.word(0x144a6);
  const initialAlien = game.map.sim.aliens.alien;
  const alienIsAtMarker = initialAlien && Array.from({ length: initialMarkers }, (_, i) => [
    game.map.world.state.byte(0x14524 + 2 * i), game.map.world.state.byte(0x14525 + 2 * i),
  ]).some(([x, y]) => x === initialAlien.x && y === initialAlien.y);
  const solar = [];
  for (let at = 0; at < game.map.world.objects.length; at += 8) {
    const tile = (game.map.world.objects[at] << 8) | game.map.world.objects[at + 1];
    if (tile === 0x0f || tile === 0x1f) solar.push(game.map.world.objects[at + 6]);
  }
  game.map.sim.roll(13);
  check("Game fresh start solar records match the supplied phase tape (this scenario has no solar records)", solar.length === phaseTape.length && solar.every((v, i) => v === (i % 2 === 0 ? 0xff : 1)), `tape ${phaseTape.length}, records ${solar.length}`);
  check("Game fresh start passes the injected Sim RNG to initial alien placement", rngRanges[0] === initialMarkers && rngRanges.at(-1) === 13);
  check("fresh scenario starts with its queued first day and a silent alien at one marker", game.map.sim.dayQueued && game.map.world.state.dateText() === "28/06/2090" && game.map.world.state.byte(0x144a8) === 0x13 && game.map.world.state.byte(0x144ad) === 0 && alienIsAtMarker);
  check("fresh scenario state restores the Disk.2 id, marker ids and weapon defaults", game.map.world.state.word(0x1453e) === 2 && game.map.world.state.byte(0x14540) === 1 && game.map.world.state.byte(0x1454a) === 2 && game.map.world.state.byte(0x145a3) === 1 && [0, 2, 3, 4, 3, 1].every((v, i) => game.map.world.state.byte(0x145a4 + i) === v));
  check("solar startup tape does not consume the separately seeded continuation stream", game.map.world.solarPhaseRngState === seed);
  game.map.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
  check("fresh startup runs its first pass before its first VBL and consumes the queued day", game.map.loop.passes === 1 && game.map.loop.vbls === 1 && game.map.loop.updatesIntoPass === 1 && !game.map.sim.dayQueued && game.map.world.state.dateText() === "01/07/2090");
  for (let i = 0; i < 2; i++) game.map.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
  check("two more VBLs do not complete the next pass", game.map.loop.passes === 1);
  game.map.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
  check("the next pass completes on the fourth VBL after the immediate startup pass", game.map.loop.passes === 2);
}

{
  const game = newGame(null);
  game.startScenario(0);
  game.map.world.state.setByte(A.frameCountdown, 1);
  game.map.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] });
  check("first-pass date work consumes the old queued day before a same-update VBL queues the next day", game.map.world.state.dateText() === "01/07/2090" && game.map.sim.dayQueued && game.map.world.state.byte(A.frameCountdown) === 90);
}

// The real menu route must finish the immediate first pass before the browser presents the newly selected map.
{
  const game = new Game(disk1, disk2, null, null);
  game.strings = strings;
  game.openScenarioMenu();
  const input = (leftButton) => ({ leftButton, rightButton: false, pointerX: 50, pointerY: 60, keys: [] });
  game.update(input(false)); // release ignored while the menu is opening
  game.update(input(true)); // choose scenario 1
  check("scenario choice runs the queued first pass before returning the map frame", game.stage === "map" && game.map.loop.passes === 1 && !game.map.sim.dayQueued && game.map.world.state.dateText() === "01/07/2090");
}

for (let scenario = 0; scenario < scenarioCount; scenario++) {
  const music = fakeMusic();
  const game = newGame(music);
  game.startScenario(scenario);
  check(`new scenario ${scenario}: the game starts silent (no play call, nothing playing)`, music.calls.length === 0 && music.current === -1 && game.stage === "map");
}

// ---- 2. A running selection survives a new scenario (the handler $80C8 loads scenario data only) ------------------------------
{
  const music = fakeMusic();
  const game = newGame(music);
  game.startScenario(1);
  music.play(3); // picked in the music-select list
  music.calls.length = 0;
  game.startScenario(2);
  check("new scenario after a selection: the selected track keeps playing, untouched", music.current === 3 && music.calls.length === 0 && music.fades === 0);
  check("later scenario selection queues its fresh day but does not rerun boot-only alien placement", game.map.sim.dayQueued && game.map.sim.aliens.alien === null);
}

// ---- 3. The remake's language-screen tune ends at the first map entry only ------------------------------------------------
{
  const music = fakeMusic();
  const game = newGame(music);
  music.play(0); // what the language stage started
  game.introTune = true;
  music.calls.length = 0;
  game.startScenario(0);
  check("first map entry fades the language-screen tune out once", music.fades === 1 && music.calls.length === 0 && game.introTune === false);
  game.startScenario(1);
  check("later scenarios do not fade again", music.fades === 1);
}
{
  const music = fakeMusic();
  const game = newGame(music);
  music.play(2);
  game.introTune = true; // a pick in the list first (not reachable before the map, but the flag must clear)
  game.chooseTrack(1);
  music.fades = 0;
  game.startScenario(0);
  check("a chosen track is not faded by the scenario start", game.introTune === false && music.fades === 0 && music.current === 1);
}

// ---- 4. Remake load keeps the playing track and starts nothing ------------------------------------------------------------
{
  const music = fakeMusic();
  const game = newGame(music);
  game.startScenario(2);
  check("save to slot 1 succeeds", game.saveToSlot(0) === true);
  game.startScenario(1);
  music.play(3);
  music.calls.length = 0;
  check("remake load succeeds", game.loadFromSlot(0) === true && game.scenario === 2 && game.stage === "map");
  check("remake load keeps the selected track and makes no play call", music.current === 3 && music.calls.length === 0);
}
{
  const music = fakeMusic();
  const game = newGame(music);
  game.startScenario(2);
  game.saveToSlot(1);
  check("remake load with nothing playing stays silent (no default track)", game.loadFromSlot(1) === true && music.current === -1 && music.calls.length === 0);
}
{
  const music = fakeMusic();
  const game = newGame(music);
  game.startScenario(0);
  music.play(2);
  music.calls.length = 0;
  check("refused load (empty slot): music untouched", game.loadFromSlot(7) === false && music.current === 2 && music.calls.length === 0);
}
{
  const game = newGame(null);
  game.startScenario(1);
  check("no Music: scenario starts without error", game.stage === "map");
}

// ---- 5. The disk menu and its music flow through Game.update ---------------------------------------------------------------
{
  const music = fakeMusic();
  const sfx = fakeSfx();
  const game = newGame(music, sfx);
  game.startScenario(0);
  const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  const frame = (down, x, y, right = false) => {
    input.leftButton = down;
    input.rightButton = right;
    input.pointerX = x;
    input.pointerY = y;
    game.update(input);
  };
  const click = (x, y) => {
    frame(true, x, y);
    frame(true, x, y);
    frame(false, x, y);
  };
  const centre = (i) => [DISK_MENU_BUTTONS[i].x0 + 16, DISK_MENU_BUTTONS[i].y0 + 16];
  const iconClick = (i) => click(...centre(i));
  const listY = (row) => 0x20 + 9 * row + 2; // original list rows ($8132)
  const LIST_X = 0x40;
  const rightClick = () => {
    frame(false, 0, 0);
    frame(false, 0, 0, true);
    frame(false, 0, 0);
  };
  const openDisk = () => {
    input.leftButton = false;
    input.rightButton = false;
    game.openDiskMenu();
    game.update(input); // consumes the opening-click guard of the scene
  };
  const openList = () => {
    openDisk();
    iconClick(DISK_BUTTON.musicSelect);
  };
  const info = () => game.diskMenu.shownInfo.join();

  openDisk();
  check("disk menu: the original picture scene (stage disk, its own screen, no list page), list closed, nothing printed", game.stage === "disk" && game.screen === game.diskMenu.screen && game.menu === null && !game.diskMenu.listOpen && info() === "0,0");
  const noMusic = newGame(null, null);
  noMusic.startScenario(0);
  noMusic.openDiskMenu();
  noMusic.update(input);
  input.pointerX = centre(7)[0];
  input.pointerY = centre(7)[1];
  input.leftButton = true;
  noMusic.update(input);
  noMusic.update(input);
  input.leftButton = false;
  noMusic.update(input);
  check("no Music: icon 7 prints $197 and the list stays closed", noMusic.diskMenu.shownInfo.join() === "0,407" && !noMusic.diskMenu.listOpen && noMusic.stage === "disk");

  game.menu = null;
  game.stage = "map";
  sfx.log.length = 0;
  openList();
  check("icon 7 opens the list on the same picture (same scene, prompt $190), no stage change", game.stage === "disk" && game.diskMenu.listOpen && game.diskMenu.shownPrompt[0] === 0x190 && game.screen === game.diskMenu.screen);
  check("opening the list requested the icon click once, no music call", sfx.log.length === 1 && sfx.log[0].id === SFX.CLICK && music.calls.length === 0);

  // Selecting track 3 (row 3): plays from the start, the disk menu stays up (not the map), the list closes.
  sfx.log.length = 0;
  const scene = game.diskMenu;
  click(LIST_X, listY(3));
  check("row 3 starts track 3 from the beginning (restart); the same scene stays, list closed", music.calls.length === 1 && music.calls[0].track === 3 && music.calls[0].restart === true && music.current === 3 && game.stage === "disk" && game.diskMenu === scene && !scene.listOpen);
  check("a list row is not a button: no click effect", sfx.log.length === 0);

  // Re-selecting the track that already plays restarts it ($110A does not compare with $1580).
  iconClick(DISK_BUTTON.musicSelect);
  music.calls.length = 0;
  click(LIST_X, listY(3));
  check("selecting the playing track again restarts it", music.calls.length === 1 && music.calls[0].track === 3 && music.calls[0].restart === true);

  for (const row of [0, 1, 2]) {
    iconClick(DISK_BUTTON.musicSelect);
    click(LIST_X, listY(row));
    check(`row ${row} selects track ${row}`, music.current === row && game.stage === "disk" && !scene.listOpen);
  }

  // Blank rows 4-9 close the list and leave the music alone.
  for (const row of [4, 6, 9]) {
    iconClick(DISK_BUTTON.musicSelect);
    music.calls.length = 0;
    const before = music.current;
    click(LIST_X, listY(row));
    check(`blank row ${row}: the list closes, the running track is untouched`, music.calls.length === 0 && music.current === before && game.stage === "disk" && !scene.listOpen);
  }

  // A click outside the list rows does nothing and keeps the list open; with the list closed the panel does nothing.
  click(LIST_X, listY(1));
  check("with the list closed a click on the panel does nothing", game.stage === "disk" && music.calls.length === 0);
  iconClick(DISK_BUTTON.musicSelect);
  music.calls.length = 0;
  click(0x89, listY(1));
  click(LIST_X, 0x7a);
  check("clicks just outside the list bounds do nothing", game.stage === "disk" && scene.listOpen && music.calls.length === 0);

  // Right click with a list open: remake-only, closes the list, nothing plays, no submenu yet.
  rightClick();
  check("right click closes the open list without a music call (stage disk)", game.stage === "disk" && !scene.listOpen && music.calls.length === 0);

  // Effects icon (8): the click is requested on the press with the state it had; the toggle and $194/$195 on the release, list state kept.
  iconClick(DISK_BUTTON.musicSelect);
  sfx.log.length = 0;
  frame(true, ...centre(DISK_BUTTON.effects));
  const effectsAtPress = sfx.enabled;
  frame(false, ...centre(DISK_BUTTON.effects));
  check("effects icon: clicks with the state at the press, toggles on the release, $195 in the second result line, list stays open", sfx.log.length === 1 && sfx.log[0].enabled === true && effectsAtPress === true && sfx.enabled === false && info() === `0,${EFFECTS_STRING.off}` && EFFECTS_STRING.off === 0x195 && scene.listOpen && game.stage === "disk");
  iconClick(DISK_BUTTON.effects);
  check("effects icon again: back on with $194", sfx.enabled === true && info() === `0,${EFFECTS_STRING.on}` && EFFECTS_STRING.on === 0x194);

  iconClick(DISK_BUTTON.musicSelect);
  check("music-select icon with the list already open: still one open list, fresh prompt", game.stage === "disk" && scene.listOpen && scene.shownPrompt[0] === 0x190);

  // The result lines vanish after the countdown; the list prompt stays.
  for (let i = 0; i < INFO_LIFETIME_FRAMES; i++) frame(false, 0, 0);
  check("the result message disappears after its countdown, the prompt stays", info() === "0,0" && scene.shownPrompt[0] === 0x190);

  // The music on/off icon ($1062, button 4): toggles in place, prints $193 / $192, never reloads; the prompt line stays.
  {
    const wasPlaying = music.current;
    music.calls.length = 0;
    sfx.log.length = 0;
    const px = () => scene.screen.pixels.slice();
    const differs = (a, b) => a.some((v, i) => v !== b[i]);
    check("list shows the prompt $190 and no result before the toggle", scene.shownPrompt[0] === 0x190 && info() === "0,0" && music.active === true && wasPlaying >= 0);
    const promptPixels = px();
    frame(true, ...centre(DISK_BUTTON.music));
    check("music icon press: the click is requested now, the music is untouched, nothing printed yet, icon drawn pressed", sfx.log.length === 1 && sfx.log[0].id === SFX.CLICK && music.active === true && info() === "0,0" && game.stage === "disk" && scene.pressedIcon === DISK_BUTTON.music);
    frame(true, ...centre(DISK_BUTTON.music));
    check("music icon held: still nothing", music.active === true && info() === "0,0" && music.activeCalls.length === 0);
    frame(false, ...centre(DISK_BUTTON.music));
    check("music icon release switches the music off: $193 on the second result line, track kept, list and prompt stay", music.active === false && music.current === wasPlaying && info() === `0,${MUSIC_TOGGLE_STRING.off}` && scene.shownPrompt[0] === 0x190 && scene.listOpen && game.stage === "disk" && scene.pressedIcon === -1);
    check("the message area was redrawn", differs(px(), promptPixels));
    check("no track was (re)loaded by the toggle", music.calls.length === 0 && sfx.log.length === 1);

    sfx.log.length = 0;
    frame(true, ...centre(DISK_BUTTON.music));
    check("second press: clicks again on the press, still paused until the release", sfx.log.length === 1 && music.active === false && info() === `0,${MUSIC_TOGGLE_STRING.off}`);
    frame(false, ...centre(DISK_BUTTON.music));
    check("second release switches it on again from where it stopped: $192, same track, no play call", music.active === true && music.current === wasPlaying && music.calls.length === 0 && info() === `0,${MUSIC_TOGGLE_STRING.on}` && music.activeCalls.join() === "false,true");

    // Leaving the disk menu and coming back keeps the paused state: the menu reads the state, it does not own it.
    iconClick(DISK_BUTTON.music);
    check("paused again", music.active === false && info() === `0,${MUSIC_TOGGLE_STRING.off}`);
    openDisk(); // a fresh scene, e.g. after a remake page
    iconClick(DISK_BUTTON.musicSelect);
    check("leaving and reopening keeps the paused state; the reopened list shows the prompt and no stale message", music.active === false && music.current === wasPlaying && game.diskMenu.shownPrompt[0] === 0x190 && game.diskMenu.shownInfo.join() === "0,0");
    click(LIST_X, listY(0)); // `$110A` on row 0 loads, restarts and leaves the music active
    check("picking a track while paused starts it and the music is active", music.active === true && music.current === 0 && music.calls.length === 1 && music.calls[0].restart === true);
    iconClick(DISK_BUTTON.musicSelect);

    // Nothing loaded: $196, no state change.
    music.stop();
    music.calls.length = 0;
    music.activeCalls.length = 0;
    iconClick(DISK_BUTTON.music);
    check("no track loaded: $196 and nothing changes", game.diskMenu.shownInfo[1] === 0x196 && music.current === -1 && music.active === false && music.activeCalls.length === 0 && music.calls.length === 0 && game.stage === "disk");
    music.play(1);
    iconClick(DISK_BUTTON.music);
    check("after a track is loaded the same icon pauses it", music.active === false && game.diskMenu.shownInfo[1] === 0x193 && music.current === 1);
    music.play(1);
  }
  check("toggleMusic(null) is the 'no expansion memory' message $197", toggleMusic(null) === MUSIC_TOGGLE_STRING.unavailable && MUSIC_TOGGLE_STRING.unavailable === 0x197 && DISK_BUTTON.music === 4);

  // Exit (icon 5): the click is requested on the press; the release returns to the map.
  openList();
  sfx.log.length = 0;
  frame(true, ...centre(DISK_BUTTON.exit));
  check("exit icon: the click is requested on the press, the menu stays until the release", sfx.log.length === 1 && sfx.log[0].id === SFX.CLICK && game.stage === "disk");
  frame(false, ...centre(DISK_BUTTON.exit));
  check("exit icon released: back to the map, menu gone, music state untouched", game.stage === "map" && game.diskMenu === null && game.screen === game.map.screen && music.current === 1);

  // Exit while the game is over is refused ($802C tests $156AA bit 3); saving prints $18A in the FIRST result line ($856C).
  openDisk();
  game.map.sim.sysFlags |= SYS.gameOver;
  iconClick(DISK_BUTTON.exit);
  check("game over: the exit icon is refused (the menu stays)", game.stage === "disk");
  iconClick(DISK_BUTTON.save);
  check("game over: the save icon prints $18A (first result line) and opens nothing", game.stage === "disk" && info() === "394,0");
  game.map.sim.sysFlags &= ~SYS.gameOver;

  // The save-disk family and the remake pages: icons 0-2 open the remake's own pages (named as such), 3 is a labelled no-op.
  openDisk();
  iconClick(DISK_BUTTON.load);
  check("icon 0 (load game, $85FE): the remake's load slot page", game.stage === "load" && /REMAKE/.test(game.menu.title) && game.diskMenu === null);
  rightClick();
  check("right click on a remake page: back to the disk menu scene", game.stage === "disk" && game.diskMenu !== null && game.menu === null);
  iconClick(DISK_BUTTON.save);
  check("icon 1 (save game, $856C): the remake's save slot page", game.stage === "save" && /REMAKE/.test(game.menu.title));
  rightClick();
  iconClick(DISK_BUTTON.scenario);
  check("icon 2 (load scenario, $8632): the scenario list", game.stage === "scenario" && game.menu.title === "CHOOSE A SCENARIO");
  rightClick();
  check("right click on the scenario list while a game exists: back to the disk menu", game.stage === "disk");
  sfx.log.length = 0;
  iconClick(DISK_BUTTON.format);
  check("icon 3 (format, $8314): clicks, then a remake note in the second result line; nothing opens, nothing is written", sfx.log.length === 1 && info() === "0,-1" && game.stage === "disk");

  // The remake submenu hangs off the right button on the landing page (list closed).
  rightClick();
  check("right click on the landing page opens the remake submenu (stage remake, a MenuScene page)", game.stage === "remake" && game.menu !== null && game.diskMenu === null && /REMAKE/.test(game.menu.title));
  check("the submenu offers save, load, scenario, Disk.4 and back; Disk.4 is disabled without a source", game.menu.entries.map((e) => e.label).join("|") === "SAVE GAME|LOAD GAME|NEW SCENARIO|LOAD DISK.4 (EXPERIMENTAL)|BACK TO DISK MENU" && game.menu.entries[3].enabled === false);
  rightClick();
  check("right click on the submenu: back to the disk menu", game.stage === "disk" && game.menu === null);

  // Icon 6 (tutorial, $80C8): scenario record 0, $156AA bits 7 and 2, money $7A120, straight to the map.
  game.startScenario(2);
  openList();
  iconClick(DISK_BUTTON.tutorial);
  check("icon 6 (tutorial, $80C8): scenario 0 completes its immediate first pass with tutorial flags", game.stage === "map" && game.scenario === 0 && (game.map.sim.sysFlags & (SYS.tutorialMode | SYS.noUnitBonus)) === (SYS.tutorialMode | SYS.noUnitBonus) && game.map.world.state.signedLong(A.money) >= 0x7a120 && game.map.world.state.dateText() === "01/07/2090" && game.diskMenu === null, `stage ${game.stage}, scenario ${game.scenario}, flags $${game.map.sim.sysFlags.toString(16)}, money ${game.map.world.state.signedLong(A.money)}, date ${game.map.world.state.dateText()}, disk menu ${game.diskMenu !== null}`);
  check("the tutorial start does not touch the music either", music.current === 1);
}

if (failed) {
  console.log(`${failed} game music check(s) FAILED`);
  process.exit(1);
}
console.log("game music checks passed");
