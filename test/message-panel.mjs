// Checks of the log panel's pattern fill (src/game/messages.ts: logPanelPattern, fillLogPanel, Messages.panelCleared).
// The fill is the $5C9A -> $52A8 erase of rows 171..194, x 8..311 (game-text.md section 5 step 7), with the 8 x 8 pattern
// `$4F92` samples from byte column 19, rows 70..77 of the displayed picture, phase y & 7. The synthetic part needs no
// original files. The Messages part needs the user's Disk.1 in original/utopia-whdload and is skipped when it is missing.
// Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { logPanelPattern, fillLogPanel, Messages, LOG_IDLE_FRAMES } = await import("../dist/game/messages.js");
const { Screen, SCREEN_WIDTH, SCREEN_HEIGHT } = await import("../dist/gfx/screen.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- synthetic picture: every pixel distinct enough to show a wrong source column, row or phase ----------------------
const picture = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
for (let y = 0; y < SCREEN_HEIGHT; y++) for (let x = 0; x < SCREEN_WIDTH; x++) picture[y * SCREEN_WIDTH + x] = (x * 7 + y * 13 + (x ^ y)) & 31;

const pattern = logPanelPattern(picture);
let patternOk = true;
for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (pattern[r * 8 + c] !== picture[(70 + r) * SCREEN_WIDTH + 152 + c]) patternOk = false;
check("pattern is picture rows 70..77 of byte column 19 (x 152..159)", patternOk && pattern.length === 64);

const screen = new Screen();
screen.pixels.fill(0xee); // a marker value no pattern entry can be equal to by accident: all pattern values are < 32
fillLogPanel(screen, pattern);
let interiorOk = true;
let firstBad = null;
for (let y = 171; y < 195; y++) {
  for (let x = 8; x < 312; x++) {
    if (screen.pixels[y * SCREEN_WIDTH + x] !== pattern[(y & 7) * 8 + (x & 7)]) {
      interiorOk = false;
      if (!firstBad) firstBad = `${x},${y}`;
    }
  }
}
check("fill covers rows 171..194, x 8..311 with pattern row y & 7 and column x & 7", interiorOk, firstBad ? `first bad ${firstBad}` : "");

let outsideOk = true;
for (let y = 0; y < SCREEN_HEIGHT; y++) {
  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const inside = y >= 171 && y < 195 && x >= 8 && x < 312;
    if (!inside && screen.pixels[y * SCREEN_WIDTH + x] !== 0xee) outsideOk = false;
  }
}
check("nothing outside the fill is written (rows 170 and 195 and x 7 and 312 keep their values)", outsideOk);
check("phase: (8, 171) takes pattern row 3 (171 & 7), (8, 172) takes row 4", screen.pixels[171 * SCREEN_WIDTH + 8] === pattern[3 * 8] && screen.pixels[172 * SCREEN_WIDTH + 8] === pattern[4 * 8]);

// ---- Messages: when the panel is cleared (real text and timers, needs Disk.1) -----------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(disk1Path)) {
  console.log("message panel: Messages tests skipped: original/utopia-whdload/Disk.1 not found");
} else {
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const messages = new Messages(disk1, new GameStrings(disk1, 0));
  check("a fresh panel is not cleared (the picture shows until the first clear)", messages.panelCleared === false);
  messages.push(143);
  check("a log message does not clear the panel", messages.panelCleared === false && messages.inspect().log.length === 1);
  for (let i = 0; i < LOG_IDLE_FRAMES - 1; i++) messages.update();
  check("the entry stays until the idle countdown runs out", messages.panelCleared === false && messages.inspect().log.length === 1);
  messages.update();
  check("the idle clear empties the log and marks the pattern fill", messages.panelCleared === true && messages.inspect().log.length === 0);

  // Staging order used by test/construction-site-capture-compare.mjs: the idle clear first, then a prompt line. A line posted
  // after the clear keeps its 200 frames and the fill stays; a line posted before a 500-update clear has expired by then.
  const ordered = new Messages(disk1, new GameStrings(disk1, 0));
  ordered.push(143);
  for (let i = 0; i < LOG_IDLE_FRAMES; i++) ordered.update();
  ordered.push(0);
  check("a line posted after the idle clear keeps 200 frames and the fill stays", ordered.panelCleared === true && ordered.inspect().lineFramesLeft === 200 && ordered.inspect().log.length === 0);
  const expired = new Messages(disk1, new GameStrings(disk1, 0));
  expired.push(0);
  expired.push(143); // a log entry starts the idle countdown; the prompt line is posted before it
  for (let i = 0; i < LOG_IDLE_FRAMES; i++) expired.update();
  check("a line posted before a 500-update idle clear has expired by then", expired.inspect().lineFramesLeft === 0 && expired.panelCleared === true);

  // the full wipe ($5B46): entries are protected for ten days, so a fourth message cannot scroll the first one out
  const wipe = new Messages(disk1, new GameStrings(disk1, 0));
  let wipedAt = -1;
  for (let i = 0; i < 6 && wipedAt < 0; i++) {
    const before = wipe.panelCleared;
    wipe.push(143);
    if (!before && wipe.panelCleared) wipedAt = i;
  }
  check("a full panel wipes and marks the fill", wipedAt > 0, wipedAt >= 0 ? `on message ${wipedAt + 1}` : "never wiped");

  // holdLineTick (map.ts modal exit): one update leaves the line timer alone, then ticking resumes; the log's idle timer still runs.
  const held = new Messages(disk1, new GameStrings(disk1, 0));
  held.pushText([0x41]);
  held.holdLineTick();
  held.update();
  check("a held line is not ticked by the next update", held.inspect().lineFramesLeft === 200);
  held.update();
  check("the hold is one-shot: the update after it ticks the line once", held.inspect().lineFramesLeft === 199);
  const heldLog = new Messages(disk1, new GameStrings(disk1, 0));
  heldLog.push(143);
  heldLog.holdLineTick();
  heldLog.update();
  check("a hold does not stop the log's idle countdown", heldLog.inspect().logIdleFrames === LOG_IDLE_FRAMES - 1);
  const unheld = new Messages(disk1, new GameStrings(disk1, 0));
  unheld.pushText([0x41]);
  unheld.update();
  check("without a hold the line ticks on the first update", unheld.inspect().lineFramesLeft === 199);
}

console.log(failed === 0 ? "message panel tests passed" : `message panel tests: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
