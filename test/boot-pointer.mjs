// Boot stage pointer (hardware sprite 2; notes/formats/text.md, "Pointer visibility"; graphics-and-music-blocks.md, "Language picture").
// The sprite's 11 rows are decoded from the user's Disk.1 (`$79286`), its control words are the VBL handler's (`$78F80`-`$78FC8`), and
// the language frame with the sprite stamped at a pointer position is compared with the two player captures that show it.
// The pointer positions are inferred from the captures, not read from them: the 12 px capture (language2.png) has its top row at
// the clamped y = 0, so pointer (20,0) puts the sprite's row 5 on screen row 0; the second capture (mouse.png) fits the full 37 px
// sprite at origin (115,35), i.e. pointer (120,40). Uses the user's own Disk.1 (read-only); skipped when it is missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("boot pointer tests skipped: original data not found");
  process.exit(0);
}

const { LanguageScene } = await import("../dist/game/language.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { readBootPointer, stampPointer, BOOT_SPRITE_HOTSPOT } = await import("../dist/gfx/pointer.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}
const key = (x, y) => `${x},${y}`;
const sameSet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));

const sprite = readBootPointer(disk1);
const opaque = [];
for (let row = 0; row < sprite.rows; row++) {
  for (let col = 0; col < 32; col++) if (sprite.opaque[row * 32 + col]) opaque.push({ col, row, index: sprite.index[row * 32 + col] });
}
check("sprite 2 has 11 rows and a hotspot of 5,5", sprite.rows === 11 && sprite.hotspot.x === BOOT_SPRITE_HOTSPOT && sprite.hotspot.y === 5);
check("sprite is 37 opaque pixels, all colour 2 (COLOR26)", opaque.length === 37 && opaque.every((p) => p.index === 26), `${opaque.length} px`);
const boxRows = opaque.map((p) => p.row);
const boxCols = opaque.map((p) => p.col);
check("sprite box is 9 columns by 9 rows, starting at row 0", Math.max(...boxCols) === 8 && Math.min(...boxCols) === 0 && Math.max(...boxRows) === 8 && Math.min(...boxRows) === 0);

// The 12 px in language2.png (x 15..23, y 0..3, over background index 0) are sprite rows 5..8 at screen rows 0..3, origin (15,-5).
const capture12 = new Set([[15, 0], [19, 0], [20, 0], [21, 0], [20, 1], [21, 1], [22, 1], [21, 2], [22, 2], [23, 2], [22, 3], [23, 3]].map(([x, y]) => key(x, y)));
const blank = () => {
  const s = new Screen();
  s.pixels.fill(0);
  return s;
};
const drawn = (screen, base) => {
  const out = new Set();
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) if (screen.pixels[y * 320 + x] !== base.pixels[y * 320 + x]) out.add(key(x, y));
  return out;
};
const s12 = blank();
const b12 = blank();
stampPointer(sprite, s12, 20, 0);
check("pointer (20,0) draws exactly the 12 px of language2.png, clipped above the screen", sameSet(drawn(s12, b12), capture12), `${drawn(s12, b12).size} px`);

// mouse.png: the full sprite at origin (115,35), pointer (120,40), 37 px, nothing above or left of the origin.
const s37 = blank();
stampPointer(sprite, s37, 120, 40);
const d37 = drawn(s37, blank());
check("pointer (120,40) draws the full 37 px sprite at origin (115,35)", d37.size === 37 && [...d37].every((k) => {
  const [x, y] = k.split(",").map(Number);
  return x >= 115 && x <= 123 && y >= 35 && y <= 43;
}), `${d37.size} px`);

// The language frame: the sprite stamped at pointer (20,0) changes exactly the 12 pixels and only by the sprite colour.
const scene = new LanguageScene(disk1, new Screen());
const idle = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
for (let n = 0; !scene.pointerVisible; n++) {
  if (n > 1000) throw new Error("language fade-in did not end");
  scene.update(idle);
}
const before = Uint8Array.from(scene.screen.pixels);
stampPointer(sprite, scene.screen, 20, 0);
const changed = [];
for (let i = 0; i < before.length; i++) if (scene.screen.pixels[i] !== before[i]) changed.push(i);
const colour = scene.screen.palette[26].join(",");
const changedSet = new Set(changed.map((i) => key(i % 320, Math.floor(i / 320))));
check("language frame: stamping pointer (20,0) changes exactly the 12 capture pixels", sameSet(changedSet, capture12), `${changed.length} px`);
check("language frame: the sprite colour is the picture's 0,255,0 (COLOR26)", colour === "0,255,0", colour);

if (failed > 0) {
  console.log(`boot pointer tests failed (${failed})`);
  process.exit(1);
}
console.log("boot pointer tests passed");
