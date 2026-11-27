// Comparator for the tutorial start route (notes/formats/game-proper.md, "Tutorial start route"): disk-menu icon 6 ($80C8), then the
// exit $802C. It drives a headless boot session with real Game.update clicks and compares a SHORT list of scalars against the values
// the static trace gives, plus one mid-session observation. It does not claim runtime parity with the original at tutorial start: no
// emulator run of this route exists, and the timing- and RNG-dependent fields are excluded on purpose (listed at the end).
//
// Expected values, each with its source (all read from the user's Disk.1 by static decoding, 2026-11-11, not from a capture):
//   scenario index  0       $80D4 `clr.w $8CFE`, copied to $135C2 at $80FC; the held scene is record 0.
//   money           $7A120  `move.l #$7A120,$135BA` at $8124 (remake: A.money = $135BA).
//   $156AA (traced) sets bit 7 ($8114 `bset #7`) and bit 2 ($811C `bset #2`) after `$866E` with d0 = 2. The reset tail of `$866E`
//                   (`$875C`-`$87DA`, reached by falling through `$8754`) writes `$156AA := $01` at `$87CA`, so the byte before the
//                   exit tail is $85. The exit tail `$802C`..`$80C6` (the route ends with `bra $802C` at $812E; the exit's bit-3 test
//                   passes because the reset cleared it) then runs `bclr #0,$156AA` at `$80A6`, so the byte after the exit is $84.
//                   The remake's Sim.sysFlags has no bit 0 (sim.ts SYS), so its expected value is $84 without bit 0.
//   bit 3 (game over) and bit 1 (attack pending) clear, and the eclipse byte `$144BB` = 0 (zeroed by `$866E`), so the exit skips the
//                   eclipse branch (`bset #6`, `$8046`).
// Mid-session observation (OBSERVED, one replay, notes/formats/building.md "E-state RAM"): `$156AA` = $84 at the E frame (frame 16447,
// after a build placement in the tutorial session). It is consistent with the start value above; it is not a startup capture.
//
// Live capture comparison (OBSERVED, ONE Copperline run, 2026-11-11, notes/formats/game-proper.md "Live run of the route"). Stop A is the
// first `$157BC` pass top after the icon-6 exit; stop B is the return after the first `$99C4`. Only fields that are the same at both the
// remake's probe scene (the state before the first pass, `tutorialScene`) and its entered state (after the immediate first pass) are asserted here:
//   pass top (stop A): day $1C, month $05, weekday $00, difficulty $1E (`$1459F`-`$145A2`); pending `$144C1` = $00; years `$142A6` = 0;
//                      `$145A3`..`$145A9` = 01 00 02 03 04 03 01; used objects `$142C2` = 20; QoL word `$142C8` = 0; `$156A8` bit 7 set
//                      (queued day, remake `Sim.dayQueued`); `$156AA` = $84 (static chain above).
//   after first pass (stop B): day $01, month $06, weekday $01 (28/06 -> 01/07/2090); pending `$144C1` = $00; years 0; table unchanged;
//                      objects 20; QoL word `$142C8` = 44; `$156A8` bit 7 clear; `$156AA` = $84; alien type `$144A8` = $13 (the apparition
//                      record, drawn at entry; its position is RNG and not compared).
// Not asserted, on purpose: the countdown `$14590` (video-timed: $5A at stop A, $54 at stop B), the money after the first pass (the
// capture has 506050, the remake 506030 in this build; the daily income depends on RNG draws this comparator does not model; a
// difference of 20 is not treated as a mismatch; test/tutorial-money.mjs decomposes it as two colonists at tax 10 from the births draw), the alien x/y/dx/dy/frame (RNG and motion), `$156A9` and `$156AB` (the draw mode and
// the redraw/cursor phase bits; `$156AB` is not held by the remake's state), the log, the message timers, the RNG.
// The stops are one run each; they support the listed values for that run only and are not a general parity claim.
//
// Excluded (timing, phase or RNG dependent, or pass-dependent): the date `$1459F`/`$145A0`/`$142A6` beyond the values above, the message
// timers, the log, the RNG, `$156A8`/`$156A9`/`$156AB` beyond the queued-day bit, money after the first pass.
//
// Uses the user's own Disk.1 / Disk.2 (read-only); skipped when missing. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("tutorial route tests skipped: original data not found");
  process.exit(0);
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};

const { Screen } = await import("../dist/gfx/screen.js");
const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
const { SYS } = await import("../dist/game/sim.js");
const { A } = await import("../dist/game/state.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const EXPECTED = {
  scenario: 0,
  money: 0x7a120,
  flagsAfterExit: 0x84, // the remake model (no bit 0 in Sim.sysFlags); the original byte after the exit tail is $84 (bit 0 cleared)
  flagsBeforeExitTail: 0x85, // what the static chain gives before the exit tail (bit 0 still set by the $866E reset); documentation only
};

// ---- input and boot helpers (the same as test/boot-menu.mjs) -----------------------------------------------------------------------
function bootGame() {
  const game = new Game(disk1, disk2, null, null);
  game.stage = "language";
  game.language = { pointerVisible: true, screen: new Screen(), picturePalette: decodePicture(disk1, PICTURES.language).palette, update: () => ({ state: "chosen", language: 0 }) };
  return game;
}
function passBoot(g, limit = 20000) {
  let inCheck = 0;
  for (let n = 1; g.stage === "boot"; n++) {
    if (n > limit) throw new Error("the boot stages did not finish");
    if (g.boot.currentPhase === "E") inCheck++;
    g.update({ leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: inCheck === 50 ? ["Enter"] : [] });
  }
}
const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
let game = null;
const frame = (down, x = 0, y = 0) => {
  input.leftButton = down;
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

// ---- the route ----------------------------------------------------------------------------------------------------------------------
game = bootGame();
idle();
passBoot(game);
check("the boot session reaches the boot disk menu", game.stage === "disk" && game.map === null);

// `$80C8` ends with `bra $802C`, so icon 6 enters the tutorial at once (no EXIT click). The pass-top comparator needs the state before
// the first pass: a probe built by the same routine (`tutorialScene`) before the click stands in for the held scene of the old model.
const held = { index: EXPECTED.scenario, map: game.tutorialScene() };
iconClick(DISK_BUTTON.tutorial);
check("icon 6 enters the tutorial at once (boot session: no held scene, map frame)", game.stage === "map" && game.heldScene === null && game.scenario === EXPECTED.scenario && game.map !== null);

const state = held.map.world.state;
const flags = held.map.sim.sysFlags;

check(`scenario index = ${EXPECTED.scenario} (record 0; static $8CFE/$135C2)`, held.index === EXPECTED.scenario, `index ${held.index}`);
check(`money = $${EXPECTED.money.toString(16)} (static $8124, $135BA)`, state.signedLong(A.money) === EXPECTED.money, `money ${state.signedLong(A.money)}`);
check(`sysFlags = $${EXPECTED.flagsAfterExit.toString(16)} (remake model, after the exit tail)`, flags === EXPECTED.flagsAfterExit, `flags $${flags.toString(16)}`);
check("tutorial bit 7 and no-unit bonus bit 2 are set", (flags & (SYS.tutorialMode | SYS.noUnitBonus)) === (SYS.tutorialMode | SYS.noUnitBonus));
check("game over (bit 3), attack pending (bit 1) and eclipse (bit 6) are clear", (flags & (SYS.gameOver | SYS.attackPending | SYS.eclipse)) === 0);
check("no apparition before the boot exit", held.map.sim.aliens.alien === null);

// Stop A (pass top of the first `$157BC` pass; OBSERVED one run, see the header). The probe (`tutorialScene`) is the state before the first pass.
const TUTORIAL_TABLE = [0x01, 0x00, 0x02, 0x03, 0x04, 0x03, 0x01]; // `$145A3`..`$145A9`, STATIC: the image defaults in state.ts
const tableBytes = () => TUTORIAL_TABLE.map((_, i) => state.byte(0x145a3 + i));
check("pass top: date 28/06/2090 (day $1C, month $05, weekday $00, difficulty $1E)",
  state.byte(A.day) === 0x1c && state.byte(A.month) === 0x05 && state.byte(A.weekday) === 0x00 && state.byte(A.difficulty) === 0x1e,
  `day $${state.byte(A.day).toString(16)} month $${state.byte(A.month).toString(16)}`);
check("pass top: pending period byte $144C1 = 0", state.byte(A.pending) === 0, `pending $${state.byte(A.pending).toString(16)}`);
check("pass top: years elapsed $142A6 = 0", state.long(A.year) === 0);
check("pass top: table $145A3..$145A9 = 01 00 02 03 04 03 01", tableBytes().every((v, i) => v === TUTORIAL_TABLE[i]), tableBytes().map((v) => v.toString(16)).join(" "));
check("pass top: used objects $142C2 = 20", state.word(0x142c2) === 20, `objects ${state.word(0x142c2)}`);
check("pass top: quality of life word $142C8 = 0", state.word(A.qualityOfLife + 2) === 0, `QoL ${state.word(A.qualityOfLife + 2)}`);
check("pass top: queued day set ($156A8 bit 7, capture $85)", held.map.sim.dayQueued === true);

check("the entered map is scenario 0 with the same flags as the probe (bit 0 aside)", game.map !== null && game.scenario === EXPECTED.scenario && (game.map.sim.sysFlags & 0xfe) === (EXPECTED.flagsAfterExit & 0xfe));

// Stop B (after the first pass, OBSERVED one run, see the header). The exit runs the immediate first pass, so the entry state is after it.
const entryState = game.map.world.state;
const entrySim = game.map.sim;
check("after first pass: date 01/07/2090 (day $01, month $06, weekday $01)",
  entryState.byte(A.day) === 0x01 && entryState.byte(A.month) === 0x06 && entryState.byte(A.weekday) === 0x01,
  `day $${entryState.byte(A.day).toString(16)} month $${entryState.byte(A.month).toString(16)}`);
check("after first pass: pending $144C1 = 0", entryState.byte(A.pending) === 0, `pending $${entryState.byte(A.pending).toString(16)}`);
check("after first pass: years $142A6 = 0", entryState.long(A.year) === 0);
check("after first pass: table $145A3..$145A9 unchanged", [0x145a3, 0x145a4, 0x145a5, 0x145a6, 0x145a7, 0x145a8, 0x145a9].every((a, i) => entryState.byte(a) === TUTORIAL_TABLE[i]));
check("after first pass: used objects $142C2 = 20", entryState.word(0x142c2) === 20, `objects ${entryState.word(0x142c2)}`);
check("after first pass: quality of life word $142C8 = 44", entryState.word(A.qualityOfLife + 2) === 44, `QoL ${entryState.word(A.qualityOfLife + 2)}`);
check("after first pass: queued day consumed ($156A8 bit 7 clear)", entrySim.dayQueued === false);
check("apparition record type $144A8 = $13 at entry (position not compared)", entryState.byte(0x144a8) === 0x13, `type $${entryState.byte(0x144a8).toString(16)}`);

// Informational only (not a check): the exit runs the immediate first pass, which may change bits or money after the held state.
// The capture's money after its first pass is 506050 (one run); the remake's daily income is not compared (header).
const after = game.map.sim.sysFlags;
console.log(`info ${"flags after the first pass"}  $${after.toString(16)} (held $${flags.toString(16)}); money ${game.map.world.state.signedLong(A.money)} (capture 506050, not compared)`);

console.log("");
console.log("Excluded on purpose: countdown (video timing), money after the first pass (RNG income), alien position, $156A9/$156AB, timers, log, RNG.");
console.log("No emulator run of this route; the expected flag bytes are the static chain above and the E-state observation.");

if (failed) {
  console.log(`${failed} tutorial route check(s) failed`);
  process.exit(1);
}
console.log("all tutorial route checks passed");
