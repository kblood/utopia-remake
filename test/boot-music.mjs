// Startup timing of the boot module (track 3) through the real Game.update (notes/formats/graphics-and-music-blocks.md, "Boot-stage
// sequence"; notes/formats/music.md). The traced order: the boot code starts track 3 at `$78614`-`$78654`, after the logo and title
// fades and before the roll loop at `$78662`; it is never started again; the boot ramp (`$78966`-`$78986`) runs the master volume
// from 62 down to 0 in 3-VBL steps, then clears the tick and the DMA (`$7897E`-`$78986`), then sets the volume back to full.
// Expected counts come from the traced rules (one update per VBL, 2 VBLs per typed character, 45-VBL fades, a 3-VBL ramp step),
// not from the code under test. The language stage is a stub that reports the choice (its timing is test/language.mjs).
// Uses the user's Disk.1 / Disk.2 (read-only); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("boot music tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { Game } = await import("../dist/game/game.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { getString } = await import("../dist/data/text.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

// Traced constants (not imported from the code under test).
const FADE_VBL = 45; // 15 steps of 3 VBLs (`$78CEC` / `$78D54`)
const TYPE_VBL_PER_CHAR = 2; // `$78A48` / `$78AB8`
const RAMP_FIRST = 62; // `$78966`: d1 = $3E
const RAMP_STEP_VBL = 3; // `$78BB8` with d7 = 2
const FULL_VOLUME = 64; // cmd 4 scale (boot-stages.ts VOLUME_FULL)
const LOADING = 40; // string index of LOADING... (step B / G)
const EXPANSION = 41; // string index of EXPANSION MEMORY DETECTED. (step G, `$904` not zero)

// The Game's update counter: `now` is the VBL number of the update being run. Every audio call is logged with it.
let now = 0;
const events = [];

// Same contract as createMusic(): play() of the current track is a no-op unless `restart`; current is -1 when nothing plays.
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
    play(track, restart = false) {
      events.push({ at: now, kind: "play", track, restart });
      m.calls.push({ track, restart });
      if (track < 0 || track >= m.trackCount) return;
      m.current = track;
      m.paused = false;
    },
    stop() {
      events.push({ at: now, kind: "stop" });
      m.stops++;
      m.current = -1;
      m.paused = false;
    },
    fadeOut() {
      events.push({ at: now, kind: "fade" });
      m.fades++;
    },
    setVolume(v) { events.push({ at: now, kind: "volume", v }); },
    setChannelMuted() {},
    resume() {},
    title: () => "",
    dispose() {},
  };
  return m;
}

const idleInput = (over = {}) => ({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [], ...over });
const music = fakeMusic();
const game = new Game(disk1, disk2, music, null);
const frame = (input = idleInput()) => {
  now++;
  game.update(input);
};
// Counts non-newline bytes: each one is a typed character, and each waits two VBLs (a newline does not wait).
const drawn = (bytes) => Array.from(bytes).filter((b) => (b & 0x80) === 0).length;
const normalise = (e) => [e.at, e.kind, e.track ?? null, e.restart ?? null, e.v ?? null];

// ---- 1. Construction, the pre-roll and the module start ---------------------------------------------------------------------------
// The pre-roll (logo fade-in 44 (pending), hold 51, fade-out 45, title fade-in 44 (pending)) starts nothing. Track 3 starts in the update
// that ends the title fade-in (update 184, `$78614`); the roll's first character comes at update 185 (intro.mjs checks the picture timing).
const MODULE_START = 184;
check("building the Game starts nothing (the boot module waits for the title fade)", events.length === 0 && music.calls.length === 0 && game.stage === "intro");
for (let i = 0; i < MODULE_START - 1; i++) frame();
check("the logo and title fades start nothing (no track call through update 183)", events.length === 0 && music.calls.length === 0, JSON.stringify(events));
frame();
check("the update that ends the title fade-in starts track 3 once, without a restart", music.calls.length === 1 && music.calls[0].track === 3 && music.calls[0].restart === false && events[0].at === MODULE_START, JSON.stringify(events));

// ---- 2. The roll runs on: no further start, across more than one pass through the credit list ------------------------------
const wrapsAt = [];
let previousIndex = game.intro.creditIndex;
for (let i = 0; i < 4000; i++) {
  frame();
  const index = game.intro.creditIndex;
  if (index < previousIndex) wrapsAt.push(now); // the list wrapped around to its first string
  previousIndex = index;
}
check("the roll keeps running through more than one pass of the credit list", wrapsAt.length >= 1 && game.stage === "intro", `wraps at ${wrapsAt.join(",")}`);
check("the module is not started again by the roll's loop", music.calls.length === 1 && events.length === 1);

// ---- 3. The click ends the roll; the language choice starts nothing ------------------------------------------------------------
let guard = 0;
while (!game.intro.holding) {
  frame();
  if (++guard > 10000) throw new Error("the credit roll never held a string");
}
frame(idleInput({ leftButton: true }));
check("a button during the hold ends the roll: stage language", game.stage === "language");
// The language stage is replaced by a stub that reports the choice at once (the real screen is in test/language.mjs).
game.language = {
  pointerVisible: true,
  screen: new Screen(),
  picturePalette: decodePicture(disk1, PICTURES.language).palette,
  update: () => ({ state: "chosen", language: 0 }),
};
frame(idleInput());
check("the choice starts the boot stages and makes no track call", game.stage === "boot" && music.calls.length === 1 && events.length === 1);

// ---- 4. Boot stages: the module plays through B to F and the ramp of G stops it, once -------------------------------------------
let phaseG = null;
guard = 0;
while (game.stage === "boot") {
  if (++guard > 20000) throw new Error("the boot stages did not finish");
  frame(idleInput({ keys: game.boot.currentPhase === "E" ? ["Enter"] : [] })); // the code check reads Return (the typed number is never compared)
  if (phaseG === null && game.stage === "boot" && game.boot.currentPhase === "G") phaseG = now;
}
check("the boot stages end on the boot disk menu (stage disk)", game.stage === "disk" && phaseG !== null);

// Step G: the message (LOADING..., typed then faded in), the expansion line, then the ramp. The first ramp call comes after these.
const rampStart = phaseG + TYPE_VBL_PER_CHAR * drawn(getString(disk1, 0, LOADING)) + FADE_VBL + TYPE_VBL_PER_CHAR * drawn(getString(disk1, 0, EXPANSION));
const expected = [{ at: MODULE_START, kind: "play", track: 3, restart: false }];
for (let k = 0; k <= RAMP_FIRST; k++) {
  expected.push({ at: rampStart + RAMP_STEP_VBL * k, kind: "volume", v: (RAMP_FIRST - k) / FULL_VOLUME });
}
const stopAt = rampStart + RAMP_STEP_VBL * (RAMP_FIRST + 1);
expected.push({ at: stopAt, kind: "stop" }, { at: stopAt, kind: "volume", v: 1 });
const got = events.map(normalise);
const want = expected.map(normalise);
check("the audio calls are exactly the traced ones: one start, the 63-step ramp, one stop, full volume again", JSON.stringify(got) === JSON.stringify(want), `got ${got.length} calls, want ${want.length}`);
check("the ramp starts after the LOADING line (2 VBLs a character), its 45-VBL fade and the expansion line", rampStart - phaseG === 2 * drawn(getString(disk1, 0, LOADING)) + FADE_VBL + 2 * drawn(getString(disk1, 0, EXPANSION)));
check("the module is stopped once, at the end of the ramp, and nothing faded", music.stops === 1 && music.fades === 0 && stopAt === rampStart + 189);
check("after the stop the track is gone (current -1) and the master volume is full again", music.current === -1 && events.at(-1).kind === "volume" && events.at(-1).v === 1);

// ---- 5. The disk menu touches no track ----------------------------------------------------------------------------------------
const before = events.length;
for (let i = 0; i < 10; i++) frame();
check("the boot disk menu is the game proper's first screen and starts or stops nothing", game.stage === "disk" && events.length === before && music.calls.length === 1);

if (failed) {
  console.log(`${failed} boot music check(s) failed`);
  process.exit(1);
}
console.log("all boot music checks passed");
