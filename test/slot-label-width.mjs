// Pixel widths of the save/load slot-list labels (save.ts `slotListLabel` / `slotWarning`, drawn by menu.ts `MenuScene` at
// `MENU_PANEL`). The label budget in save.ts is a CHARACTER count; what must hold is the pixel extent of the glyphs in the game
// font, so this test measures the ink of every label the list can show, with the glyph advances read from the user's Disk.1
// (gamefont.ts). Every combination of the five assumption flags is covered, including combinations no migration reaches, so the
// bound does not depend on which versions can really occur. Skipped without original/utopia-whdload/Disk.1. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("slot-label-width tests skipped: original/utopia-whdload/Disk.1 not found");
  process.exit(0);
}

const { drawGameText, COLOR } = await import(pathToFileURL(path.join(root, "dist/data/gamefont.js")).href);
const { Screen } = await import(pathToFileURL(path.join(root, "dist/gfx/screen.js")).href);
const { MENU_PANEL } = await import(pathToFileURL(path.join(root, "dist/game/menu.js")).href);
const { slotListLabel } = await import(pathToFileURL(path.join(root, "dist/game/save.js")).href);

const disk1 = new Uint8Array(fs.readFileSync(d1));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// Ink extent of a label drawn the way MenuScene draws it (left column MENU_PANEL.left, text colour, uppercase codes).
function ink(label) {
  const screen = new Screen();
  const codes = Array.from(label.toUpperCase(), (c) => c.charCodeAt(0));
  drawGameText(disk1, screen, codes, MENU_PANEL.left, MENU_PANEL.top, COLOR.text);
  let min = Infinity;
  let max = -1;
  for (let y = 0; y < screen.pixels.length / 320; y++) {
    for (let x = 0; x < 320; x++) {
      if (screen.pixels[y * 320 + x] === COLOR.text) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
  }
  return { min, max, width: max - min + 1 };
}

// Every label the slot list can show: EMPTY / STORAGE OFF / UNUSABLE, and "ok" with each of the 32 flag combinations.
const DATE = "31/12/2099";
const labels = [
  slotListLabel(7, null),
  slotListLabel(7, { slot: 7, status: "unavailable", error: { code: "no-storage", message: "" } }),
  slotListLabel(7, { slot: 7, status: "unusable", error: { code: "corrupt", message: "" } }),
];
for (let bits = 0; bits < 32; bits++) {
  const flag = (b) => (bits & (1 << b)) !== 0;
  const summary = {
    slot: 7,
    status: "ok",
    scenario: 0,
    date: DATE,
    name: null,
    legacy: flag(0),
    effectsAssumedEmpty: flag(1),
    effectSlotsAssumed: flag(2),
    enemyPointersAssumed: flag(3),
    tableAssumed: flag(4),
  };
  labels.push(slotListLabel(7, summary));
}

const limit = MENU_PANEL.left + MENU_PANEL.width - 1; // last column the panel blanks (279)
const measured = labels.map((label) => ({ label, ...ink(label) }));
const widest = measured.reduce((a, b) => (b.width > a.width ? b : a));
const rightmost = Math.max(...measured.map((m) => m.max));
// save.ts: a version-less save (legacy) never carries FX or PTR (migrateLegacy), so "V1" with FX or PTR is unreachable. Such labels
// stay in the pixel checks (they must still fit) and are left out of the reachable character budget.
const unreachable = (label) => /\bV1\b/.test(label) && /FX|PTR/.test(label);
const reachable = measured.filter((m) => !unreachable(m.label));
const widestReachable = reachable.reduce((a, b) => (b.width > a.width ? b : a));

check("every slot label is drawn inside the list panel (right ink edge <= panel edge)", rightmost <= limit, `rightmost x ${rightmost}, panel edge ${limit}`);
check("every slot label starts at the list's text column", measured.every((m) => m.min === MENU_PANEL.left), `leftmost x ${Math.min(...measured.map((m) => m.min))}`);
check("the widest reachable label is 'SLOT 8  31/12/2099 PTR UNKNOWN', 143 px of ink", widestReachable.label === "SLOT 8  31/12/2099 PTR UNKNOWN" && widestReachable.width === 143, `${widestReachable.label} = ${widestReachable.width} px`);
check("the widest label of ANY flag combination still fits the panel (150 px, unreachable V1 + FX/PTR)", widest.width === 150 && widest.label === "SLOT 8  31/12/2099 FX/PTR/V1/TBL", `${widest.label} = ${widest.width} px`);
check("the panel has at least 90 px to spare beyond the widest label of any combination", limit - MENU_PANEL.left + 1 - widest.width >= 90, `spare ${limit - MENU_PANEL.left + 1 - widest.width} px`);
check("the character budget holds for every reachable label (at most 31 characters)", reachable.every((m) => m.label.length <= 31), `longest reachable ${Math.max(...reachable.map((m) => m.label.length))}`);
check("every unreachable V1 + FX/PTR label still fits the panel (save.ts documents them as unreachable)", measured.filter((m) => unreachable(m.label)).every((m) => m.max <= limit), `${measured.filter((m) => unreachable(m.label)).length} labels`);
check("only the four-way V1 + FX/PTR/TBL label exceeds 31 characters (32), and it is unreachable", measured.filter((m) => m.label.length > 31).every((m) => unreachable(m.label) && m.label.includes("FX/PTR/V1/TBL")) && measured.some((m) => m.label.length === 32));

// Pinned widths of the single-assumption and empty/status labels, from the Disk.1 font advances (5 px a glyph, 4 for space and '/').
const pinned = {
  "SLOT 8  EMPTY": 63,
  "SLOT 8  STORAGE OFF": 90,
  "SLOT 8  UNUSABLE": 76,
  "SLOT 8  31/12/2099": 84,
  "SLOT 8  31/12/2099 V1": 97,
  "SLOT 8  31/12/2099 FX/PTR/TBL": 136,
};
for (const [label, width] of Object.entries(pinned)) {
  const m = measured.find((x) => x.label === label) ?? { label, ...ink(label) };
  check(`pinned width: '${label}'`, m.width === width, `${m.width} px`);
}

if (failed) {
  console.log(`${failed} slot-label-width check(s) failed`);
  process.exit(1);
}
console.log("slot-label-width: all checks passed");
