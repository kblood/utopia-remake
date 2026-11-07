// Checks of the alien apparition drawable adapter (src/game/alien-sprite.ts) and its integration in ObjectLayer
// (src/game/objects.ts, MapScene wiring in src/game/map.ts). Run after `npm run build`.
// Part 1-3 are asset-free: a plain byte reader stands in for the state and a hand-made SpriteSet stands in for the
// artwork, so they check structure only (anchor, offset, mask, clip, visibility, read-only behaviour), never original
// pixels. Part 4 uses the player's own Disk.1 / Disk.2 in original/utopia-whdload and is skipped when they are missing;
// it only checks that a live MapScene draws the alien record that Aliens writes. No comparison with the running original
// is made. The same-cell order comes from the traced `$4860` sort and is asserted in test/draw-list.mjs, not here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { readAlienApparition, ALIEN_TYPE } = await import("../dist/game/alien-sprite.js");
const { ObjectLayer, ALIEN_REF } = await import("../dist/game/objects.js");
const { SpriteSet, SPRITE_WIDTH } = await import("../dist/data/sprites.js");
const { validateSpecialSlots } = await import("../dist/game/disk4-scene.js");
const { GameState, STATE_BYTES } = await import("../dist/game/state.js");
const { Screen } = await import("../dist/gfx/screen.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- synthetic fixtures ---------------------------------------------------------------------------------------------
// A byte reader that records every address it is asked for. It has no setter, so the adapter cannot write through it.
function reader(bytes) {
  const reads = new Set();
  return { reads, byte: (addr) => (reads.add(addr), bytes.get(addr) ?? 0) };
}
const alienBytes = (o = {}) => new Map([
  [0x144a8, o.type ?? 0x13], [0x144a9, o.x ?? 0], [0x144aa, o.y ?? 0], [0x144ab, o.dx ?? 0], [0x144ac, o.dy ?? 0], [0x144ad, o.frame ?? 0],
]);

// A 3-row type-19 sprite, 4 frames. Left 16 pixels opaque, right 16 transparent (mask 0xFF 0xFF 0x00 0x00 per row).
// Colour of frame f: top rows f + 1, the stored bottom row (row 0) 16 + f.
const ROWS = 3;
const PLANE = ROWS * 4;
const FRAME_BYTES = 6 * PLANE;
// `fullMask` makes all 32 pixels of every row opaque (used for the exact right-clip checks).
function syntheticSet(fullMask = false) {
  const sheet = new Uint8Array(4 * FRAME_BYTES);
  for (let f = 0; f < 4; f++) {
    for (let row = 0; row < ROWS; row++) {
      const colour = row === 0 ? 16 + f : f + 1;
      for (let p = 0; p < 5; p++) if ((colour >> p) & 1) sheet.fill(0xff, f * FRAME_BYTES + p * PLANE + row * 4, f * FRAME_BYTES + p * PLANE + row * 4 + 4);
      sheet.fill(0xff, f * FRAME_BYTES + 5 * PLANE + row * 4, f * FRAME_BYTES + 5 * PLANE + row * 4 + (fullMask ? 4 : 2));
    }
  }
  const frameOffsets = [0, FRAME_BYTES, 2 * FRAME_BYTES, 3 * FRAME_BYTES, 0, 0, 0, 0, 0];
  const types = Array.from({ length: 27 }, () => null);
  types[ALIEN_TYPE - 1] = { type: ALIEN_TYPE, rows: ROWS, frameBytes: FRAME_BYTES, planeBytes: PLANE, frameOffsets, image: 0, mask: 5 * PLANE, sheet };
  return new SpriteSet(types);
}
const MAP_W = 100;
const MAP_H = 75;
const newLayer = (source, fullMask = false) => {
  const layer = new ObjectLayer(syntheticSet(fullMask), [], new Uint16Array(MAP_W * MAP_H), () => {});
  layer.apparition = source;
  return layer;
};
const BG = 31;
const fresh = () => {
  const s = new Screen();
  s.pixels.fill(BG);
  return s;
};
const px = (s, x, y) => s.pixels[y * 320 + x];
const painted = (s) => s.pixels.reduce((n, v) => n + (v !== BG ? 1 : 0), 0);

// ---- 1. the adapter ---------------------------------------------------------------------------------------------------
{
  const free = reader(alienBytes({ type: 0 }));
  check("a free slot (type byte 0) draws nothing", readAlienApparition(free) === null);
  check("another type byte is not interpreted as the alien", readAlienApparition(reader(alienBytes({ type: 0x15 }))) === null);
  check("a frame byte beyond the nine descriptor slots draws nothing", readAlienApparition(reader(alienBytes({ frame: 9 }))) === null && readAlienApparition(reader(alienBytes({ frame: 200 }))) === null);

  const r = reader(alienBytes({ x: 53, y: 40, frame: 3, dx: 0xfc, dy: 5 }));
  const d = readAlienApparition(r);
  check("the active record is described field by field (type 19, cell, frame, signed offsets)", d && d.type === 19 && d.x === 53 && d.y === 40 && d.frame === 3 && d.dx === -4 && d.dy === 5, JSON.stringify(d));
  check("only $144A8..$144AD are read", [...r.reads].every((a) => a >= 0x144a8 && a <= 0x144ad) && r.reads.size > 0, [...r.reads].map((a) => a.toString(16)).join());
  check("no lift and no animation counter (not a type-$18 sprite)", d.lift === undefined && d.anim === undefined);
  check("the adapter hands out a fresh description each time (nothing is cached or shared)", readAlienApparition(r) !== d);
}

// ---- 2. ObjectLayer: anchor, offset, mask, clip -------------------------------------------------------------------------
{
  // Scroll (10,10); alien at map (13,12) = view cell (3,2): x0 = 112 + 16 * (3 - 2) = 128, bottom row = 39 + 8 * 5 - 1 - 13 = 65
  // (the $3604 insertion block lowers the type-19 y anchor by 13: static trace, not an original pixel comparison).
  const scene = (o) => ({ rec: alienBytes({ x: 13, y: 12, ...o }) });
  const draw = (o, vx = 3, vy = 2, scrollX = 10, scrollY = 10) => {
    const state = reader(scene(o).rec);
    const layer = newLayer(() => readAlienApparition(state));
    const s = fresh();
    layer.drawAfterCell(s, scrollX, scrollY, vx, vy);
    return s;
  };

  const s0 = draw({ frame: 0 });
  check("bottom stored row lands 13 rows above the cell box's bottom row ($3604), rows go up", px(s0, 128, 65) === 16 && px(s0, 128, 64) === 1 && px(s0, 128, 63) === 1 && px(s0, 128, 62) === BG && px(s0, 128, 66) === BG);
  check("the un-adjusted bottom row (78) is not painted", px(s0, 128, 78) === BG && px(s0, 128, 77) === BG && px(s0, 128, 76) === BG);
  check("masked blit: left 16 pixels painted, right 16 keep the background", px(s0, 143, 64) === 1 && px(s0, 144, 64) === BG && px(s0, 159, 64) === BG && px(s0, 127, 64) === BG);
  check("painted pixels = 3 rows x 16", painted(s0) === 48, `${painted(s0)}`);
  const s2 = draw({ frame: 2 });
  check("the frame byte selects the frame", px(s2, 128, 65) === 18 && px(s2, 128, 64) === 3);

  const moved = draw({ frame: 0, dx: 0xfd, dy: 2 });
  check("signed pixel offsets move the sprite (dx -3, dy +2)", px(moved, 125, 67) === 16 && px(moved, 125, 66) === 1 && px(moved, 124, 67) === BG && px(moved, 128, 65) === 1);

  check("not drawn on other view cells", painted(draw({ frame: 0 }, 2, 2)) === 0 && painted(draw({ frame: 0 }, 3, 3)) === 0);
  check("not drawn when the cell is outside the 8 x 8 window", painted(draw({ x: 25, y: 12 }, 3, 2)) === 0);

  // Right clip: view (7,0) has x0 = 224; offset +8 puts the sprite at 232. Frame 0 so the edge rule can not hide it.
  const edge = draw({ x: 17, y: 10, frame: 0, dx: 8 }, 7, 0);
  check("x = 232: the opaque half 232..247 is fully inside the clip (p <= 254 - x = 22)", px(edge, 232, 39 + 56 - 1 - 13) === 16 && px(edge, 247, 39 + 56 - 1 - 13) === 16 && painted(edge) === 48);
  const beyond = draw({ x: 17, y: 10, frame: 0, dx: 32 }, 7, 0);
  check("objects whose left edge is at x >= 256 are not drawn at all", painted(beyond) === 0);

  // Exact original right clip ($3768..$3770, $3260, mask table $4C9A, $32B6..$32F6; map-rendering.md 7.3), for every sprite type
  // through the shared ObjectLayer.blit. View (7,0) has x0 = 224, so dx = x - 224 selects the left edge. Alien frame 0, bottom
  // row y = 81 (rows 79..81). `opaque` = all 32 pixels, `masked` = left 16 pixels only.
  {
    const ROW = 39 + 56 - 1 - 13;
    const dxByte = (x) => (x - 224) & 0xff;
    const columns = (s, y = ROW) => {
      const out = [];
      for (let x = 0; x < 320; x++) if (px(s, x, y) !== BG) out.push(x);
      return out;
    };
    const range = (a, b) => (b < a ? [] : Array.from({ length: b - a + 1 }, (_, i) => a + i));
    const drawAt = (x, fullMask) => {
      const layer = newLayer(() => readAlienApparition(reader(alienBytes({ x: 17, y: 10, frame: 0, dx: dxByte(x) }))), fullMask);
      const s = fresh();
      layer.drawAfterCell(s, 10, 10, 7, 0);
      return s;
    };
    // [left edge x, visible destination columns of the opaque sprite, visible columns of the 16-pixel masked sprite]
    const table = [
      [223, range(223, 254), range(223, 238)], // x <= 223: all source pixels draw
      [224, range(224, 254), range(224, 239)], // first x with a limit: p <= 30, column 255 is cut
      [225, range(225, 254), range(225, 240)], // unaligned: p <= 29
      [232, range(232, 254), range(232, 247)], // byte aligned, masked half untouched (p <= 22)
      [240, range(240, 254), range(240, 254)], // masked half cut at p = 14
      [248, range(248, 254), range(248, 254)], // p <= 6
      [254, [254], [254]], // p <= 0: a single column
      [255, range(255, 286), range(255, 270)], // original quirk ($4D16 alias): all 32 pixels, not clipped at 255 or 256
      [256, [], []], // rejected by $3768
    ];
    for (const [x, opaqueCols, maskedCols] of table) {
      const o = drawAt(x, true);
      const m = drawAt(x, false);
      check(`x = ${x}: opaque sprite draws exactly columns ${opaqueCols.length ? opaqueCols[0] + ".." + opaqueCols[opaqueCols.length - 1] : "(none)"}`, JSON.stringify(columns(o)) === JSON.stringify(opaqueCols), JSON.stringify(columns(o)));
      check(`x = ${x}: masked sprite draws exactly columns ${maskedCols.length ? maskedCols[0] + ".." + maskedCols[maskedCols.length - 1] : "(none)"}`, JSON.stringify(columns(m)) === JSON.stringify(maskedCols), JSON.stringify(columns(m)));
      check(`x = ${x}: all 3 rows are clipped identically`, [ROW - 1, ROW - 2].every((y) => JSON.stringify(columns(o, y)) === JSON.stringify(opaqueCols)) && painted(o) === 3 * opaqueCols.length);
    }
    const x255 = drawAt(255, true);
    check("x = 255 is not clipped at 255 or 256: columns 256..286 are painted (original quirk preserved)", px(x255, 256, ROW) === 16 && px(x255, 286, ROW) === 16 && px(x255, 287, ROW) === BG);
    check("x = 254 never draws destination column 255", px(drawAt(254, true), 255, ROW) === BG && px(drawAt(224, true), 255, ROW) === BG);
    const negative = newLayer(() => readAlienApparition(reader(alienBytes({ x: 10, y: 17, frame: 0, dx: 0xff }))), true);
    const sn = fresh();
    negative.drawAfterCell(sn, 10, 10, 0, 7);
    check("x = -1 is rejected", painted(sn) === 0);

    const { spriteVisibleColumns } = await import("../dist/game/objects.js");
    check("spriteVisibleColumns: 32 for 0..223, 255 - x for 224..254, 32 for 255, 0 outside 0..255",
      [0, 100, 223, 255].every((x) => spriteVisibleColumns(x) === 32) && spriteVisibleColumns(224) === 31 && spriteVisibleColumns(254) === 1 && spriteVisibleColumns(256) === 0 && spriteVisibleColumns(-1) === 0 && spriteVisibleColumns(1000) === 0);
  }
  const left = draw({ x: 10, y: 17, frame: 0 }, 0, 7);
  check("view (0,7) has x0 = 0 and draws; a negative left edge is not drawn", painted(left) === 48 && painted(draw({ x: 10, y: 17, frame: 0, dx: 0xff }, 0, 7)) === 0);

  // `$3694` receives the alien frame byte as the selector for the edge tests. Frames 0..3 are the active alien animation domain.
  check("last column, frame 1..3 and dx > 0: hidden by the existing edge rule", painted(draw({ x: 17, y: 10, frame: 2, dx: 3 }, 7, 0)) === 0);
  check("last column, frame 2 without offset: shown", painted(draw({ x: 17, y: 10, frame: 2 }, 7, 0)) === 48);
  check("last column, frame 0 with dx > 0: shown", painted(draw({ x: 17, y: 10, frame: 0, dx: 3 }, 7, 0)) === 48);
  check("last column, frame 1 with dy > 0 hides, but non-positive offsets remain visible", painted(draw({ x: 17, y: 10, frame: 1, dy: 2 }, 7, 0)) === 0 && painted(draw({ x: 17, y: 10, frame: 1, dx: 0xff, dy: 0xfe }, 7, 0)) === 48);
  check("last row, frames 0..2 admit positive offsets; frame 3 hides only for positive dy", [0, 1, 2].every((frame) => painted(draw({ x: 10, y: 17, frame, dx: 2, dy: 2 }, 0, 7)) === 48) && painted(draw({ x: 10, y: 17, frame: 3, dx: 0, dy: 2 }, 0, 7)) === 0 && painted(draw({ x: 10, y: 17, frame: 3, dy: 0 }, 0, 7)) === 48);
  check("last row, frame 3 with dy > 0: hidden; with dy 0: shown", painted(draw({ x: 10, y: 17, frame: 3, dy: 2 }, 0, 7)) === 0 && painted(draw({ x: 10, y: 17, frame: 3 }, 0, 7)) === 48);

  // Layer without a source, with a source that returns null, and a type with no artwork.
  const none = newLayer(null);
  const a = fresh();
  none.drawAfterCell(a, 10, 10, 3, 2);
  const empty = newLayer(() => null);
  const b = fresh();
  empty.drawAfterCell(b, 10, 10, 3, 2);
  check("no source / a source without an apparition: nothing drawn", painted(a) === 0 && painted(b) === 0);
  const unknown = new ObjectLayer(new SpriteSet(Array.from({ length: 27 }, () => null)), [], new Uint16Array(MAP_W * MAP_H), () => {});
  unknown.apparition = () => readAlienApparition(reader(alienBytes({ x: 13, y: 12 })));
  const c = fresh();
  unknown.drawAfterCell(c, 10, 10, 3, 2);
  check("a sprite set without type 19 draws nothing and does not throw", painted(c) === 0);
}

// ---- 3. read-only: drawing changes neither the record nor any list ------------------------------------------------------
{
  const bytes = alienBytes({ x: 13, y: 12, frame: 2 });
  const before = JSON.stringify([...bytes]);
  const state = { byte: (a) => bytes.get(a) ?? 0 };
  const layer = newLayer(() => readAlienApparition(state));
  layer.spawnEffect(0x12, 14, 12);
  layer.units.spawn(9, 12, 11, 2);
  const effects = JSON.stringify(layer.effects);
  const units = layer.units.units.length;
  const clock = layer.units.clock.sub;
  const first = fresh();
  const second = fresh();
  for (let vy = 0; vy < 8; vy++) for (let vx = 0; vx < 8; vx++) layer.drawAfterCell(first, 10, 10, vx, vy);
  for (let vy = 0; vy < 8; vy++) for (let vx = 0; vx < 8; vx++) layer.drawAfterCell(second, 10, 10, vx, vy);
  check("the record bytes (including the frame) are untouched by drawing", JSON.stringify([...bytes]) === before);
  check("the effect list, the unit list and the pass clock are untouched", JSON.stringify(layer.effects) === effects && layer.units.units.length === units && layer.units.clock.sub === clock);
  check("drawing is repeatable: the same state gives the same pixels", first.pixels.every((v, i) => v === second.pixels[i]));
  const picks = layer.pickables(10, 10);
  check("the alien is an admitted obstacle in the pick list but never an order target (tank, alien, effect in sorted order)", picks.length === 3 && picks.map((p) => p.kind).join() === "tank,alien,effect" && picks[0].ref === layer.units.units[0] && picks[1].ref === ALIEN_REF && picks[2].ref === layer.pool.slots[0]);

  // Disk.4 policy: an active type-19 record is accepted when its traced fields are valid and refused (typed
  // "special-state") when they are not. validateSpecialSlots only reads.
  const slot = (set = {}) => {
    const st = GameState.fromSnapshot(new Uint8Array(STATE_BYTES)).value;
    for (const [addr, v] of Object.entries(set)) st.setByte(Number(addr), v);
    return st;
  };
  check("a free alien slot is accepted", validateSpecialSlots(slot()) === null);
  check("an active alien record with traced fields is accepted", validateSpecialSlots(slot({ 0x144a8: 0x13, 0x144a9: 13, 0x144aa: 12, 0x144ad: 2 })) === null);
  const refusal = (set) => validateSpecialSlots(slot({ 0x144a8: 0x13, ...set }))?.code;
  check("a position outside the map is refused (special-state)", refusal({ 0x144a9: 100 }) === "special-state" && refusal({ 0x144aa: 75 }) === "special-state");
  check("a frame beyond the traced animation range is refused (special-state)", refusal({ 0x144ad: 4 }) === "special-state");
  check("an unknown type at $144A8 is refused (special-state)", validateSpecialSlots(slot({ 0x144a8: 0x15 }))?.code === "special-state");
  const tableWord = slot({ 0x144a8: 0x13 });
  tableWord.setWord(0x144a4, 11);
  check("a phase word outside the traced table is refused (special-state)", validateSpecialSlots(tableWord)?.code === "special-state");
}

// ---- 4. MapScene wiring (local data) -------------------------------------------------------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("alien-sprite game-data checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
} else {
  const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
  const { loadSprites } = await import("../dist/data/sprites.js");
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const { GameState, A } = await import("../dist/game/state.js");
  const { World } = await import("../dist/game/world.js");
  const { MapScene } = await import("../dist/game/map.js");

  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const record = readScenarioRecords(disk2)[0];
  const tiles = loadTileSet(disk1, disk2, record).tiles;
  const sprites = loadSprites(disk1, disk2, record);
  check("the player's Disk.1 provides sprite type 19 with at least frames 0-3", sprites.has(19) && [0, 1, 2, 3].every((f) => sprites.frame(19, f) !== null));

  const makeScene = () => {
    const m = new MapScene(disk1, tiles, new World(new GameState(disk2, record.block), loadMap(disk2, record)), new GameStrings(disk1, 0), { sprites });
    m.world.state.setByte(A.frameCountdown, 90);
    m.world.state.setByte(A.pending, 0);
    return m;
  };
  const idle = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
  // MapScene redraws the map only at a completed scheduled pass (`loop.vblPerPass` = 4 video updates by default), so both
  // scenes are compared at the same pass boundaries. Both are paused first ($156A9 bit 2, `sim.paused`): the day countdown,
  // the periodic work and the alien frame step ($35C8, spawner) are then frozen and neither scene's date or simulation moves
  // between the staged record and the comparison; a paused pass still redraws and still draws the alien record from the
  // state bytes (the drawable reads `$144A8..`, not the paused runtime).
  const toNextPass = (m) => {
    const before = m.loop.passes;
    for (let i = 0; i < m.loop.vblPerPass; i++) m.update(idle);
    return m.loop.passes - before;
  };
  const base = makeScene();
  base.sim.paused = true;
  const scene = makeScene();
  scene.sim.paused = true;
  check("both scenes start at the same pass boundary and paused", base.loop.passes === scene.loop.passes && base.loop.updatesIntoPass === 0 && scene.loop.updatesIntoPass === 0 && base.sim.paused && scene.sim.paused);
  check("base scene: four updates complete exactly one scheduled pass", toNextPass(base) === 1 && base.loop.updatesIntoPass === 0);
  const reference = base.screen.pixels.slice();

  const cx = scene.scrollX + 3;
  const cy = scene.scrollY + 3;
  // The drawable reads the $144A8 state bytes (objects.apparition), so stage the record there and keep the runtime object
  // consistent with it: type $13, x, y, offsets +3/+4 = 0, frame byte +5 as $333A would set it.
  scene.sim.aliens.alien = { x: cx, y: cy };
  const st = scene.world.state;
  st.setByte(0x144a8, ALIEN_TYPE);
  st.setByte(0x144a9, cx);
  st.setByte(0x144aa, cy);
  st.setByte(0x144ab, 0);
  st.setByte(0x144ac, 0);
  st.setByte(0x144ad, 1);
  const snapshot = scene.world.state.snapshot();
  const rng = scene.sim.rngState;
  check("alien scene: four updates complete exactly one scheduled pass, still paused", toNextPass(scene) === 1 && scene.loop.updatesIntoPass === 0 && scene.sim.paused && scene.loop.passes === base.loop.passes);
  const x0 = 112 + 16 * (3 - 3);
  const bottom = 39 + 8 * 6 - 1 - 13; // $3604: the alien's y anchor is lowered by 13
  let outside = 0;
  let inside = 0;
  for (let i = 0; i < reference.length; i++) {
    if (scene.screen.pixels[i] === reference[i]) continue;
    const x = i % 320;
    const y = Math.floor(i / 320);
    if (x >= x0 && x < x0 + SPRITE_WIDTH && y <= bottom && y > bottom - 25) inside++;
    else outside++;
  }
  check("a live MapScene draws the active alien inside its 32 x 25 box on its cell (anchor - 13)", inside > 20 && outside === 0, `inside ${inside}, outside ${outside}`);
  const after = scene.world.state.snapshot();
  let diff = 0;
  const countdownIndex = A.frameCountdown - 0x13034;
  const drawCountIndex = 0x142a0 - 0x13034;
  let changedOutsideCountdown = 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i] !== snapshot[i]) {
      diff++;
      if (i !== countdownIndex && i !== drawCountIndex && i !== drawCountIndex + 1) changedOutsideCountdown++;
    }
  }
  // Paused: `$2C34` does not decrement the countdown, while `$333A` still rebuilds the visible-entry count at `$142A0`.
  // Neither the alien drawable nor the renderer writes any other game state.
  check("a paused pass preserves the countdown and changes only the $142A0 draw-list count; alien drawing is otherwise read-only",
    after[countdownIndex] === snapshot[countdownIndex] && changedOutsideCountdown === 0 && scene.world.state.word(0x142a0) === scene.objects.passDrawCount,
    `${diff} bytes differ, ${changedOutsideCountdown} outside countdown/draw count`);
  check("drawing consumed no RNG", JSON.stringify(scene.sim.rngState) === JSON.stringify(rng));

  scene.sim.aliens.alien = null;
  scene.world.state.setByte(0x144a8, 0); // free record type: the drawable reads the state byte, not the runtime handle
  // Drive both scenes to the same next pass boundary: removal is only visible after the next scheduled redraw.
  check("both scenes complete the next pass together", toNextPass(base) === 1 && toNextPass(scene) === 1 && base.loop.passes === scene.loop.passes);
  check("clearing the record removes the sprite again (same pass boundary as the base scene)", scene.screen.pixels.every((v, i) => v === base.screen.pixels[i]));
}

console.log(failed === 0 ? "all alien sprite tests passed" : `${failed} alien sprite test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
