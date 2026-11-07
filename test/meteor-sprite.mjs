// Checks of the meteor drawable adapter (src/game/meteor-sprite.ts) and its integration in ObjectLayer
// (src/game/objects.ts, MapScene wiring in src/game/map.ts). Run after `npm run build`.
// Parts 1-3 are asset-free: a plain byte reader stands in for the state and a hand-made SpriteSet stands in for the
// artwork, so they check structure only (anchor, signed offsets, countdown-as-lift, mask, clip, visibility, read-only
// behaviour), never original pixels. Part 4 uses the player's own Disk.1 / Disk.2 in original/utopia-whdload and is
// skipped when they are missing; it only checks that a live MapScene draws the record that Aliens writes.
// The right clip is the shared statically traced per-pixel rule of ObjectLayer.blit (x >= 224 loses columns beyond 254,
// x = 255 quirk; the full table is asserted in test/alien-sprite.mjs).
// NOT asserted (untraced, see meteor-sprite.ts): the paused-meteor control flow of the original and any pixel parity with the
// running original. Same-cell order is the traced $4860 sort (test/draw-list.mjs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { readMeteor, METEOR_TYPE } = await import("../dist/game/meteor-sprite.js");
const { readAlienApparition, ALIEN_TYPE } = await import("../dist/game/alien-sprite.js");
const { ObjectLayer, METEOR_REF } = await import("../dist/game/objects.js");
const { SpriteSet, SPRITE_WIDTH } = await import("../dist/data/sprites.js");
const { validateSpecialSlots, METEOR_SLOT } = await import("../dist/game/disk4-scene.js");
const { GameState: SlotState, STATE_BYTES } = await import("../dist/game/state.js");
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
// $1449C +0 type, +1/+2 x/y, +3/+4 dx/dy, +5 frame, +6 countdown/lift, +7 unused by the draw path.
const meteorBytes = (o = {}) => new Map([
  [0x1449c, o.type ?? 0x15], [0x1449d, o.x ?? 0], [0x1449e, o.y ?? 0], [0x1449f, o.dx ?? 0], [0x144a0, o.dy ?? 0],
  [0x144a1, o.frame ?? 0], [0x144a2, o.lift ?? 0], [0x144a3, o.plus7 ?? 0],
]);

// A 3-row sprite of type 21 with 3 frames. Left 16 pixels opaque, right 16 transparent (mask 0xFF 0xFF 0x00 0x00 per row).
// Colour of frame f: top rows f + 1, the stored bottom row (row 0) 16 + f. A type-19 twin is added for the coexistence check.
const ROWS = 3;
const PLANE = ROWS * 4;
const FRAME_BYTES = 6 * PLANE;
function syntheticSet(types = [21, 19]) {
  const sheet = new Uint8Array(4 * FRAME_BYTES);
  for (let f = 0; f < 4; f++) {
    for (let row = 0; row < ROWS; row++) {
      const colour = row === 0 ? 16 + f : f + 1;
      for (let p = 0; p < 5; p++) if ((colour >> p) & 1) sheet.fill(0xff, f * FRAME_BYTES + p * PLANE + row * 4, f * FRAME_BYTES + p * PLANE + row * 4 + 4);
      sheet.fill(0xff, f * FRAME_BYTES + 5 * PLANE + row * 4, f * FRAME_BYTES + 5 * PLANE + row * 4 + 2);
    }
  }
  const frameOffsets = [0, FRAME_BYTES, 2 * FRAME_BYTES, 3 * FRAME_BYTES, 0, 0, 0, 0, 0];
  const list = Array.from({ length: 27 }, () => null);
  for (const t of types) list[t - 1] = { type: t, rows: ROWS, frameBytes: FRAME_BYTES, planeBytes: PLANE, frameOffsets, image: 0, mask: 5 * PLANE, sheet };
  return new SpriteSet(list);
}
const MAP_W = 100;
const MAP_H = 75;
const newLayer = (source, types) => {
  const layer = new ObjectLayer(syntheticSet(types), [], new Uint16Array(MAP_W * MAP_H), () => {});
  layer.meteor = source;
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
  check("the meteor type byte is $15 (sprite type 21)", METEOR_TYPE === 0x15 && METEOR_SLOT === 0x1449c);
  check("a free slot (type byte 0) draws nothing", readMeteor(reader(meteorBytes({ type: 0 }))) === null);
  check("another type byte (the alien's $13, an unknown $16) is not interpreted as the meteor", readMeteor(reader(meteorBytes({ type: 0x13 }))) === null && readMeteor(reader(meteorBytes({ type: 0x16 }))) === null);
  check("a frame byte beyond the nine descriptor slots draws nothing", readMeteor(reader(meteorBytes({ frame: 9 }))) === null && readMeteor(reader(meteorBytes({ frame: 200 }))) === null);

  const r = reader(meteorBytes({ x: 53, y: 40, frame: 2, dx: 0xfc, dy: 5, lift: 0x78, plus7: 0x99 }));
  const d = readMeteor(r);
  check("the active record is described field by field (type 21, cell, frame, signed offsets, lift = +6)", d && d.type === 21 && d.x === 53 && d.y === 40 && d.frame === 2 && d.dx === -4 && d.dy === 5 && d.lift === 120, JSON.stringify(d));
  check("+6 is read as a SIGNED byte (0xF6 = -10); creation value $78 = 120", readMeteor(reader(meteorBytes({ lift: 0xf6 }))).lift === -10 && readMeteor(reader(meteorBytes({ lift: 0x78 }))).lift === 120);
  check("only $1449C..$144A2 are read; +7 ($144A3) is not touched by the draw path", [...r.reads].every((a) => a >= 0x1449c && a <= 0x144a2) && r.reads.size > 0 && !r.reads.has(0x144a3), [...r.reads].map((a) => a.toString(16)).join());
  check("no animation counter (not a type-$18 sprite)", d.anim === undefined && d.ref === undefined);
  check("the adapter hands out a fresh description each time (nothing is cached or shared)", readMeteor(r) !== d);
}

// ---- 2. ObjectLayer: anchor, offset, lift, mask, clip --------------------------------------------------------------------
{
  // Scroll (10,10); meteor at map (13,12) = view cell (3,2): x0 = 112 + 16 * (3 - 2) = 128, bottom row = 39 + 8 * 5 - 1 = 78
  // (= 38 + 8 * (vx + vy) in the trace's terms) minus the signed lift.
  const draw = (o, vx = 3, vy = 2, scrollX = 10, scrollY = 10) => {
    const state = reader(meteorBytes({ x: 13, y: 12, ...o }));
    const layer = newLayer(() => readMeteor(state));
    const s = fresh();
    layer.drawAfterCell(s, scrollX, scrollY, vx, vy);
    return s;
  };

  const s0 = draw({ frame: 0 });
  check("lift 0: bottom stored row on the cell box's bottom row (no type-19 style adjustment), rows go up", px(s0, 128, 78) === 16 && px(s0, 128, 77) === 1 && px(s0, 128, 76) === 1 && px(s0, 128, 75) === BG && px(s0, 128, 79) === BG);
  check("the alien's -13 anchor adjustment is NOT applied to the meteor", px(s0, 128, 65) === BG);
  check("masked blit: left 16 pixels painted, right 16 keep the background", px(s0, 143, 77) === 1 && px(s0, 144, 77) === BG && px(s0, 159, 77) === BG && px(s0, 127, 77) === BG);
  check("painted pixels = 3 rows x 16", painted(s0) === 48, `${painted(s0)}`);
  const s2 = draw({ frame: 2 });
  check("the frame byte selects the frame", px(s2, 128, 78) === 18 && px(s2, 128, 77) === 3);

  const lifted = draw({ lift: 0x28 });
  check("+6 lifts the sprite: lift 40 moves the bottom row from 78 to 38", px(lifted, 128, 38) === 16 && px(lifted, 128, 37) === 1 && px(lifted, 128, 78) === BG && painted(lifted) === 48);
  const lowered = draw({ lift: 0xf6 });
  check("a negative +6 lowers the sprite (-10: bottom row 88)", px(lowered, 128, 88) === 16 && px(lowered, 128, 78) === BG);
  const moved = draw({ dx: 0xfd, dy: 2, lift: 4 });
  check("signed offsets and lift combine: bottom = 78 + dy - lift, left = 128 + dx (dx -3, dy +2, lift 4 -> 125, 76)", px(moved, 125, 76) === 16 && px(moved, 125, 75) === 1 && px(moved, 124, 76) === BG && px(moved, 128, 78) === BG);
  const high = draw({ lift: 0x78 });
  check("the creation lift of $78 on this cell puts the 3 rows at 76..78 - 120 < 0: clipped away without throwing", painted(high) === 0);

  check("not drawn on other view cells", painted(draw({}, 2, 2)) === 0 && painted(draw({}, 3, 3)) === 0);
  check("not drawn when the cell is outside the 8 x 8 window", painted(draw({ x: 25, y: 12 }, 3, 2)) === 0 && painted(draw({ x: 13, y: 12 }, 3, 2, 14, 10)) === 0);

  // Right clip: the shared original per-pixel rule (map-rendering.md 7.3; exact table in test/alien-sprite.mjs). View (7,0) has
  // x0 = 224; the opaque half of this sprite is source pixels 0..15; the stored bottom row is y = 38 + 56.
  const edge = draw({ x: 17, y: 10, dx: 8 }, 7, 0);
  check("view (7,0) has x0 = 224; dx +8 -> 232, opaque half 232..247 is fully visible (p <= 254 - 232 = 22)", px(edge, 232, 38 + 56) === 16 && px(edge, 247, 38 + 56) === 16 && painted(edge) === 48);
  const clipped = draw({ x: 17, y: 10, dx: 24 }, 7, 0);
  check("left edge 248: only p <= 6 draw, destination columns 248..254 (7 of 16 opaque columns), column 255 is NOT drawn", painted(clipped) === 21 && px(clipped, 254, 38 + 56) === 16 && px(clipped, 255, 38 + 56) === BG);
  const half = draw({ x: 17, y: 10, dx: 16 }, 7, 0);
  check("left edge 240: p <= 14, destination columns 240..254 (15 columns)", painted(half) === 45 && px(half, 254, 38 + 56) === 16 && px(half, 255, 38 + 56) === BG);
  const quirk = draw({ x: 17, y: 10, dx: 31 }, 7, 0);
  check("left edge 255: original quirk, all 16 opaque columns draw (255..270), not clipped at 255/256", painted(quirk) === 48 && px(quirk, 255, 38 + 56) === 16 && px(quirk, 270, 38 + 56) === 16 && px(quirk, 271, 38 + 56) === BG);
  check("left edge at x >= 256 is not drawn", painted(draw({ x: 17, y: 10, dx: 32 }, 7, 0)) === 0);
  check("view (0,7) has x0 = 0 and draws; a negative left edge is not drawn", painted(draw({ x: 10, y: 17 }, 0, 7, 10, 10)) === 48 && painted(draw({ x: 10, y: 17, dx: 0xff }, 0, 7)) === 0);

  // Existing layer edge rule (frame used as facing, same as the alien): vx = 7, frame 1..3 and a positive dx hides it.
  check("last column, frame 1..3 and dx > 0: hidden by the existing edge rule", painted(draw({ x: 17, y: 10, frame: 2, dx: 3 }, 7, 0)) === 0);
  check("last column, frame 2 without offset: shown", painted(draw({ x: 17, y: 10, frame: 2 }, 7, 0)) === 48);
  check("last column, frame 0 with dx > 0: shown", painted(draw({ x: 17, y: 10, frame: 0, dx: 3 }, 7, 0)) === 48);
  check("last row, frame 3 with dy > 0: hidden; with dy 0: shown", painted(draw({ x: 10, y: 17, frame: 3, dy: 2 }, 0, 7)) === 0 && painted(draw({ x: 10, y: 17, frame: 3 }, 0, 7)) === 48);

  // Layer without a source, with a source that returns null, and a sprite set without type 21.
  const none = newLayer(null);
  const a = fresh();
  none.drawAfterCell(a, 10, 10, 3, 2);
  const empty = newLayer(() => null);
  const b = fresh();
  empty.drawAfterCell(b, 10, 10, 3, 2);
  check("no source / a source without a meteor: nothing drawn", painted(a) === 0 && painted(b) === 0);
  const unknown = newLayer(() => readMeteor(reader(meteorBytes({ x: 13, y: 12 }))), [19]);
  const c = fresh();
  unknown.drawAfterCell(c, 10, 10, 3, 2);
  check("a sprite set without type 21 draws nothing and does not throw", painted(c) === 0);

  // Coexistence with the apparition on different cells (same-cell order is the traced $4860 tie permutation, see test/draw-list.mjs).
  const both = newLayer(() => readMeteor(reader(meteorBytes({ x: 13, y: 12, lift: 4 }))));
  both.apparition = () => readAlienApparition(reader(new Map([[0x144a8, ALIEN_TYPE], [0x144a9, 14], [0x144aa, 12]])));
  const sb = fresh();
  both.drawAfterCell(sb, 10, 10, 3, 2);
  both.drawAfterCell(sb, 10, 10, 4, 2);
  check("alien and meteor on neighbouring cells are both drawn", painted(sb) === 96, `${painted(sb)}`);
}

// ---- 3. read-only: drawing changes neither the record nor any list ------------------------------------------------------
{
  const bytes = meteorBytes({ x: 13, y: 12, frame: 1, lift: 0x28 });
  const before = JSON.stringify([...bytes]);
  const state = { byte: (a) => bytes.get(a) ?? 0 };
  const layer = newLayer(() => readMeteor(state));
  layer.spawnEffect(0x12, 14, 12);
  layer.units.spawn(9, 12, 11, 2);
  const effects = JSON.stringify(layer.effects);
  const units = layer.units.units.length;
  const clock = layer.units.clock.sub;
  const first = fresh();
  const second = fresh();
  for (let vy = 0; vy < 8; vy++) for (let vx = 0; vx < 8; vx++) layer.drawAfterCell(first, 10, 10, vx, vy);
  for (let vy = 0; vy < 8; vy++) for (let vx = 0; vx < 8; vx++) layer.drawAfterCell(second, 10, 10, vx, vy);
  check("the record bytes (countdown/lift included) are untouched by drawing", JSON.stringify([...bytes]) === before);
  check("no meteor effect is retained: the effect list, the unit list and the pass clock are untouched", JSON.stringify(layer.effects) === effects && layer.effects.length === 1 && layer.units.units.length === units && layer.units.clock.sub === clock);
  check("drawing is repeatable: the same state gives the same pixels", first.pixels.every((v, i) => v === second.pixels[i]));
  const picks = layer.pickables(10, 10);
  check("the meteor is an admitted obstacle in the pick list but never an order target (tank, meteor, effect in sorted order)", picks.length === 3 && picks.map((p) => p.kind).join() === "tank,meteor,effect" && picks[0].ref === layer.units.units[0] && picks[1].ref === METEOR_REF && picks[2].ref === layer.pool.slots[0]);

  // Disk.4 policy: an active type-21 record is accepted when its traced fields are valid and refused (typed
  // "special-state") when they are not. validateSpecialSlots only reads.
  const slot = (set = {}) => {
    const st = SlotState.fromSnapshot(new Uint8Array(STATE_BYTES)).value;
    for (const [addr, v] of Object.entries(set)) st.setByte(Number(addr), v);
    return st;
  };
  const refusal = (set) => validateSpecialSlots(slot({ 0x1449c: 0x15, 0x144a2: 0x78, ...set }))?.code;
  check("a free meteor slot is accepted", validateSpecialSlots(slot()) === null);
  check("an active meteor record with traced fields is accepted (fresh $78 and last-pass 4)", refusal({}) === undefined && refusal({ 0x144a2: 4 }) === undefined);
  check("a position outside the map is refused (special-state)", refusal({ 0x1449d: 100 }) === "special-state" && refusal({ 0x1449e: 75 }) === "special-state");
  check("a non-zero frame is refused (special-state)", refusal({ 0x144a1: 1 }) === "special-state");
  check("a countdown above $78, off the 4-step grid, or 0 is refused (special-state)", refusal({ 0x144a2: 0x7c }) === "special-state" && refusal({ 0x144a2: 6 }) === "special-state" && refusal({ 0x144a2: 0 }) === "special-state");
  check("an unknown type at $1449C is refused (special-state)", validateSpecialSlots(slot({ 0x1449c: 0x16 }))?.code === "special-state");
}

// ---- 4. MapScene wiring (local data) -------------------------------------------------------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("meteor-sprite game-data checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
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
  const frame0 = sprites.has(21) ? sprites.frame(21, 0) : null;
  check("the player's Disk.1 provides sprite type 21, frame 0, 25 rows high", frame0 !== null && frame0.rows === 25, frame0 ? `${frame0.rows} rows` : "missing");

  const makeScene = () => {
    const m = new MapScene(disk1, tiles, new World(new GameState(disk2, record.block), loadMap(disk2, record)), new GameStrings(disk1, 0), { sprites });
    m.world.state.setByte(A.frameCountdown, 90);
    m.world.state.setByte(A.pending, 0);
    return m;
  };
  const idle = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
  // Redraws are pass-aligned: one pass is 4 video updates and only the completing update draws. Every unpaused pass runs
  // Sim.meteorStep, which takes 4 off the record's +6 before the redraw. Both scenes always advance through the same number
  // of completed passes, so every pixel and state comparison below is made against the base scene at the same boundary.
  const PASS = 4;
  const advance = (m) => {
    const passes = m.loop.passes;
    for (let i = 0; i < PASS; i++) m.update(idle);
    if (m.loop.passes !== passes + 1) throw new Error(`expected exactly one completed pass, got ${m.loop.passes - passes}`);
  };
  const base = makeScene();
  const scene = makeScene();
  const cx = scene.scrollX + 3;
  const cy = scene.scrollY + 3;
  const timer = 0x28; // the first drawn countdown: a mid-fall value that keeps the 25-row box on screen
  const staged = timer + 4; // the pass decrements by 4 before the redraw
  scene.sim.aliens.meteor = { x: cx, y: cy, timer: staged }; // what event 8 writes: type $15, x, y and the countdown in +6
  check("the sim's meteor record leaves +3..+5 at zero (frame 0, no offset)", [0x1449f, 0x144a0, 0x144a1].every((a) => scene.world.state.byte(a) === 0) && scene.world.state.byte(0x144a2) === staged);
  const countdownIndex = A.frameCountdown - 0x13034;
  const timerIndex = 0x144a2 - 0x13034;
  const baseBefore = base.world.state.snapshot();
  const snapshot = scene.world.state.snapshot();
  const rngBefore = JSON.stringify(scene.sim.rngState);
  const effectsBefore = scene.objects.effects.length;
  const baseEffectsBefore = base.objects.effects.length;
  advance(base);
  advance(scene);
  const reference = base.screen.pixels.slice();
  const x0 = 112 + 16 * (3 - 3);
  const boxDiff = (bottom) => {
    let inside = 0;
    let outside = 0;
    for (let i = 0; i < reference.length; i++) {
      if (scene.screen.pixels[i] === reference[i]) continue;
      const x = i % 320;
      const y = Math.floor(i / 320);
      if (x >= x0 && x < x0 + SPRITE_WIDTH && y <= bottom && y > bottom - 25) inside++;
      else outside++;
    }
    return { inside, outside };
  };
  const bottom = 38 + 8 * 6 - timer; // 38 + 8 * (vx + vy) + dy - lift
  const first = boxDiff(bottom);
  check("a live MapScene draws the active meteor inside its 32 x 25 box on its cell, lifted by the countdown, at the first redraw", first.inside > 20 && first.outside === 0, `inside ${first.inside}, outside ${first.outside}`);
  const changed = (before, after) => {
    const out = [];
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) out.push(i);
    return out;
  };
  const baseAfter = base.world.state.snapshot();
  const after = scene.world.state.snapshot();
  const baseChanged = changed(baseBefore, baseAfter);
  const sceneChanged = changed(snapshot, after);
  const extra = sceneChanged.filter((i) => !baseChanged.includes(i));
  const drawCountIndex = 0x142a0 - 0x13034;
  const allowedExtra = new Set([timerIndex, drawCountIndex, drawCountIndex + 1]);
  check("one pass adds only the meteor countdown and its original draw-list count beyond the base scene; other record bytes stay untouched",
    extra.includes(timerIndex) && extra.every((i) => allowedExtra.has(i)) && baseChanged.every((i) => sceneChanged.includes(i)) &&
    scene.world.state.byte(0x144a2) === timer && scene.sim.aliens.meteor.timer === timer && scene.world.state.word(0x142a0) === scene.objects.passDrawCount &&
    [0x1449c, 0x1449d, 0x1449e, 0x1449f, 0x144a0, 0x144a1, 0x144a3].every((a) => scene.world.state.byte(a) === snapshot[a - 0x13034]),
    `extra ${extra.join()} (timer index ${timerIndex}, draw count ${drawCountIndex}); base changed ${baseChanged.length}, scene changed ${sceneChanged.length}`);
  check("the 4 VBL updates of the pass count the day countdown down by 4 in both scenes", after[countdownIndex] === snapshot[countdownIndex] - PASS && baseAfter[countdownIndex] === baseBefore[countdownIndex] - PASS, `${snapshot[countdownIndex]} -> ${after[countdownIndex]}`);
  check("the pass and the drawing consumed no RNG and retained no effect beyond the base scene", JSON.stringify(scene.sim.rngState) === JSON.stringify(base.sim.rngState) && JSON.stringify(scene.sim.rngState) === rngBefore && scene.objects.effects.length === effectsBefore && base.objects.effects.length === baseEffectsBefore, `rng ${rngBefore} -> ${JSON.stringify(scene.sim.rngState)}, effects ${effectsBefore} -> ${scene.objects.effects.length}`);

  // The next completed pass takes another 4 off +6, which the state-backed source draws 4 rows lower (no redraw state kept).
  const firstPixels = scene.screen.pixels.slice();
  advance(base);
  advance(scene);
  reference.set(base.screen.pixels);
  const second = boxDiff(bottom + 4);
  check("the next pass counts +6 down by 4 ($28 -> $24) and draws the meteor 4 rows lower, polled from the state at draw time", scene.world.state.byte(0x144a2) === timer - 4 && scene.sim.aliens.meteor.timer === timer - 4 && second.inside > 20 && second.outside === 0 && scene.screen.pixels.some((v, i) => v !== firstPixels[i]), `+6 ${scene.world.state.byte(0x144a2).toString(16)}, inside ${second.inside}, outside ${second.outside}`);

  scene.sim.aliens.meteor = null;
  check("clearing the record clears the type byte at $1449C", scene.world.state.byte(0x1449c) === 0 && scene.sim.aliens.meteor === null);
  advance(base);
  advance(scene);
  check("clearing the record removes the sprite at the next redraw (base and meteor scenes at the same pass)", scene.screen.pixels.every((v, i) => v === base.screen.pixels[i]));
}

console.log(failed === 0 ? "all meteor sprite tests passed" : `${failed} meteor sprite test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
