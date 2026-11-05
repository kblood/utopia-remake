// Checks of the construction countdown ($7000/$703A), the Command Centre redraw ($7342), the warning
// lights / view bookmark ($5D30, $144BD) and the message log timers ($15698). Run after `npm run build`.
// Needs the user's own game data (Disk.1 and Disk.2 in original/utopia-whdload); skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("construction tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { Builder } = await import("../dist/game/build.js");
const { SITE_TILE } = await import("../dist/game/construction.js");
const { LIGHT, Alerts } = await import("../dist/game/sim-alerts.js");
const { Messages } = await import("../dist/game/messages.js");
const { readFlagTable, readWeights, readLightIcons } = await import("../dist/data/gameimage.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const records = readScenarioRecords(disk2);
const flagTable = readFlagTable(disk1);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const V = { free: 0x13136, builders: 0x1432a, money: 0x135ba, sites: 0x142c4, capacity: 0x14432 };

function fresh(options = {}) {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const said = [];
  const builder = new Builder(world, flagTable, readWeights(disk1), (m) => said.push(m), options.phase);
  const sim = new Sim(world, {
    rng: createRng(7),
    onWeek: () => builder.weekly(),
    centreChanged: (slot) => builder.construction.redrawCentre(slot),
  });
  state.setLong(V.money, 5_000_000);
  if (options.free !== false) state.setLong(V.free, 5000);
  return { state, world, builder, sim, said };
}

const id = (world, x, y) => world.cell(x, y) & 0x3ff;
const T = (world, tile) => world.typeAddress(world.findType(tile));

// A free spot (2x2 free, so it fits every footprint) near the starting base.
function spots(world, count) {
  let base = null;
  for (let i = 0; i < world.objects.length; i += 8) {
    if (((world.objects[i] << 8) | world.objects[i + 1]) === 0x4c) base = [world.objects[i + 4], world.objects[i + 5]];
  }
  const free = (x, y) => (world.cell(x, y) & 0x5400) === 0;
  const out = [];
  for (let r = 2; r < 14 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        const x = base[0] + dx;
        const y = base[1] + dy;
        if (out.some(([a, b]) => Math.abs(a - x) < 3 && Math.abs(b - y) < 3)) continue;
        if (free(x, y) && free(x + 1, y) && free(x, y + 1) && free(x + 1, y + 1) && free(x + 2, y) && free(x, y + 2) && free(x + 2, y + 2)) out.push([x, y]);
      }
    }
  }
  return out;
}

function placeAt(ctx, tile, spot) {
  const type = ctx.world.findType(tile);
  return ctx.builder.place({ tile, type }, spot[0], spot[1]);
}

const slotAt = (world, x, y) => {
  for (let i = 0; i < world.objects.length; i += 8) {
    if ((world.objects[i] | world.objects[i + 1]) !== 0 && world.objects[i + 4] === x && world.objects[i + 5] === y) return i;
  }
  return -1;
};

// ---- 1. one building of each footprint: scaffold for the build weeks, then the building -----------------
for (const [tile, cellsOf] of [[0x54, [[0, 0], [1, 0], [0, 1], [1, 1]]], [0x47, [[0, 0]]]]) {
  const ctx = fresh();
  const { world, state, builder } = ctx;
  const [spot] = spots(world, 1);
  const t = T(world, tile);
  const weeks = state.byte(t + 2);
  const workers = state.byte(t + 4);
  const free0 = state.long(V.free);
  const a0 = state.word(t + 0xa);
  const c0 = state.word(t + 0xc);
  check(`$${tile.toString(16)} placed`, placeAt(ctx, tile, spot));
  check("every cell of the footprint shows the scaffold", cellsOf.every(([dx, dy]) => id(world, spot[0] + dx, spot[1] + dy) === SITE_TILE));
  check("site counter 1, builders hold the workers", state.word(V.sites) === 1 && state.long(V.builders) === workers && state.long(V.free) === free0 - workers);
  let early = true;
  for (let w = 1; w < weeks; w++) {
    builder.weekly();
    if (id(world, spot[0], spot[1]) !== SITE_TILE || state.word(V.sites) !== 1) early = false;
  }
  check(`still a scaffold after ${weeks - 1} week(s)`, early);
  builder.weekly();
  const slot = slotAt(world, spot[0], spot[1]);
  check("finished after the last week", cellsOf.every(([dx, dy], n) => id(world, spot[0] + dx, spot[1] + dy) === tile + n), cellsOf.map(([dx, dy]) => id(world, spot[0] + dx, spot[1] + dy).toString(16)).join(","));
  check("record is the building", ((world.objects[slot] << 8) | world.objects[slot + 1]) === tile && world.objects[slot + 2] === state.byte(t + 1) && world.objects[slot + 6] === 0);
  check("workers returned, counters", state.long(V.builders) === 0 && state.long(V.free) === free0 && state.word(V.sites) === 0 && state.word(t + 0xa) === a0 + 1 && state.word(t + 0xc) === c0 + 1);
  check("flag bytes follow the tile table", ((world.cell(spot[0], spot[1]) >> 8) & ~0xe8) === (flagTable[tile] & ~0xe8));
  check("a further week changes nothing", (builder.weekly(), id(world, spot[0], spot[1]) === tile &&state.word(t + 0xc) === c0 + 1));
}

// ---- 2. two sites finish in the order of their build times; completions lower the counter once each -----
{
  const ctx = fresh();
  const { world, state, builder } = ctx;
  const [s1, s2] = spots(world, 2);
  const tiles = [0x47, 0x41];
  const weeks = tiles.map((tile) => state.byte(T(world, tile) + 2));
  placeAt(ctx, tiles[0], s1);
  placeAt(ctx, tiles[1], s2);
  check("two sites counted", state.word(V.sites) === 2);
  const done = [];
  for (let w = 1; w <= Math.max(...weeks); w++) {
    builder.weekly();
    done.push([id(world, s1[0], s1[1]) !== SITE_TILE, id(world, s2[0], s2[1]) !== SITE_TILE]);
  }
  const expect = [];
  for (let w = 1; w <= Math.max(...weeks); w++) expect.push([weeks[0] <= w, weeks[1] <= w]);
  check(`completion weeks ${weeks.join("/")}`, JSON.stringify(done) === JSON.stringify(expect));
  check("both done, counter zero, builders zero", state.word(V.sites) === 0 && state.long(V.builders) === 0);
}

// ---- 3. $7000 uses the counter $142C4: with 0 nothing counts down -----------------------------------------
{
  const ctx = fresh();
  const { world, state, builder } = ctx;
  const [spot] = spots(world, 1);
  placeAt(ctx, 0x47, spot);
  const slot = slotAt(world, spot[0], spot[1]);
  const weeks = world.objects[slot + 6];
  state.setWord(V.sites, 0);
  builder.weekly();
  check("counter 0: the site does not count down", world.objects[slot + 6] === weeks);
  state.setWord(V.sites, 50);
  for (let w = 0; w < weeks; w++) builder.weekly();
  check("an overstated counter is harmless", id(world, spot[0], spot[1]) === 0x47);
}

// ---- 4. special buildings -----------------------------------------------------------------------------------
{
  // Second Command Centre: offline tiles, not counted, record is not the online one.
  const ctx = fresh();
  const { world, state, builder } = ctx;
  const [spot] = spots(world, 1);
  const t = T(world, 0x4c);
  const c0 = state.word(t + 0xc);
  const a0 = state.word(t + 0xa);
  check("second Command Centre placed", placeAt(ctx, 0x4c, spot));
  for (let w = 0; w < 40; w++) builder.weekly();
  const slot = slotAt(world, spot[0], spot[1]);
  check("offline tiles $50-$53", [0, 1, 2, 3].every((n) => id(world, spot[0] + (n & 1), spot[1] + (n >> 1)) === 0x50 + n));
  check("record keeps tile $4C, byte +3 not $FF; counts: active +1, total unchanged", ((world.objects[slot] << 8) | world.objects[slot + 1]) === 0x4c && world.objects[slot + 3] !== 0xff && state.word(t + 0xa) === a0 + 1 && state.word(t + 0xc) === c0, `a ${a0}->${state.word(t + 0xa)} c ${c0}->${state.word(t + 0xc)}`);
}
{
  const ctx = fresh();
  const { world, state, builder } = ctx;
  const [spot] = spots(world, 1);
  const cap0 = state.long(V.capacity);
  placeAt(ctx, 0x44, spot);
  for (let w = 0; w < 40; w++) builder.weekly();
  check("warehouse adds 80000 capacity", id(world, spot[0], spot[1]) === 0x44 && state.long(V.capacity) === cap0 + 80000);
}
{
  const ctx = fresh();
  const { world, builder } = ctx;
  const [spot] = spots(world, 1);
  placeAt(ctx, 0x60, spot);
  for (const [dx, dy] of [[-1, 0], [1, 1], [0, 1]]) world.cells[(spot[1] + dy) * 100 + spot[0] + dx] |= 0x8000;
  for (let w = 0; w < 40; w++) builder.weekly();
  const slot = slotAt(world, spot[0], spot[1]);
  check("mine gets its richness count (cells with bit 15 around it)", id(world, spot[0], spot[1]) === 0x60 && world.objects[slot + 6] === 3, `${world.objects[slot + 6]}`);
}
{
  const ctx = fresh();
  const { world, builder } = ctx;
  const [spot] = spots(world, 1);
  placeAt(ctx, 0x3e, spot);
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, -1], [0, 1]]) world.cells[(spot[1] + dy) * 100 + spot[0] + dx] |= 0x0800;
  for (let w = 0; w < 40; w++) builder.weekly();
  const slot = slotAt(world, spot[0], spot[1]);
  check("fuel well gets its richness count (bit 11)", id(world, spot[0], spot[1]) === 0x3e && world.objects[slot + 6] === 4, `${world.objects[slot + 6]}`);
}
for (const [tile, phase, expectByte] of [[0x1f, true, 1], [0x1f, false, 0xff], [0x0f, true, 1]]) {
  const ctx = fresh({ phase: () => phase });
  const { world, builder } = ctx;
  const [spot] = spots(world, 1);
  const ok = placeAt(ctx, tile, spot);
  for (let w = 0; ok && w < 40; w++) builder.weekly();
  const slot = slotAt(world, spot[0], spot[1]);
  check(`tile $${tile.toString(16)} gets phase ${expectByte}`, ok && world.objects[slot + 6] === expectByte && world.objects[slot + 2] === 0 && world.objects[slot + 7] === 0, `${ok}`);
}

// ---- 5. original quirk: workers are taken before the money test ------------------------------------------
{
  const ctx = fresh();
  const { world, state, said } = ctx;
  const [spot] = spots(world, 1);
  const t = T(world, 0x47);
  state.setLong(V.money, 0);
  const free0 = state.long(V.free);
  let left = null;
  ctx.builder.onBuildCancelled = (leave) => (left = leave);
  const ok = placeAt(ctx, 0x47, spot);
  check("no money: refused with message $25, build mode left", !ok && said.at(-1) === 0x25 && left === true);
  check("no site, but the workers are gone from the free pool (kept quirk)", state.word(V.sites) === 0 && id(world, spot[0], spot[1]) !== SITE_TILE && state.long(V.free) === free0 - state.byte(t + 4) && state.long(V.builders) === state.byte(t + 4));
}

// ---- 6. through the simulation: weeks pass with the frames, no completion messages ------------------------
{
  const ctx = fresh({ free: false });
  const { world, state, sim } = ctx;
  const [spot] = spots(world, 1);
  const t = T(world, 0x47);
  placeAt(ctx, 0x47, spot);
  const weeks = state.byte(t + 2);
  let frames = 0;
  while (state.word(V.sites) !== 0 && frames < 90 * 7 * (weeks + 2)) {
    sim.tick();
    frames++;
  }
  check(`finished by ticking (${frames} frames, ${(frames / 630).toFixed(1)} weeks)`, id(world, spot[0], spot[1]) === 0x47 && frames > 90 * 7 * (weeks - 1) && frames <= 90 * 7 * (weeks + 1));
}

// ---- 7. Command Centre offline/online redraw through the sim ($A1EA / $9B8C -> $7342) ----------------------
{
  const ctx = fresh();
  const { world, state, sim } = ctx;
  const slot = (() => {
    for (let i = 0; i < world.objects.length; i += 8) if (((world.objects[i] << 8) | world.objects[i + 1]) === 0x4c) return i;
    return -1;
  })();
  const x = world.objects[slot + 4];
  const y = world.objects[slot + 5];
  const centre = (base) => [0, 1, 2, 3].every((n) => id(world, x + (n & 1), y + (n >> 1)) === base + n);
  check("scenario centre starts online", world.objects[slot + 3] === 0xff && centre(0x4c));
  // No power at all: the centre (power priority position 7) goes offline.
  for (const type of [31, 11, 12]) state.setWord(world.typeAddress(type) + 0xc, 0);
  state.setWord(world.typeAddress(0) + 0xe, 0);
  sim.monthly();
  check("power failure: level >= 14, centre offline, tiles $50-$53", state.byte(0x144c8) >= 14 && world.objects[slot + 3] === 0 && centre(0x50), `level ${state.byte(0x144c8)}`);
  check("message $12C, power light lit", sim.messages.includes(0x12c) && sim.alerts.lit(LIGHT.power));
  // Power returns: a power station worth of output brings it back at the next month.
  state.setWord(world.typeAddress(31) + 0xc, 50);
  state.setWord(world.typeAddress(31) + 0xe, 1000);
  sim.monthly();
  check("power back: centre online again, tiles $4C-$4F, light off", state.byte(0x144c8) < 14 && world.objects[slot + 3] === 0xff && centre(0x4c) && !sim.alerts.lit(LIGHT.power), `level ${state.byte(0x144c8)}`);
}

// ---- 8. warning lights: food, air, focus bookmark ------------------------------------------------------------
{
  const ctx = fresh();
  const { world, state, sim } = ctx;
  for (const type of [18, 19]) for (const off of [0xa, 0xc, 0xe]) state.setWord(world.typeAddress(type) + off, 0);
  state.setLong(0x143be, 0);
  state.setLong(0x143c2, 0);
  state.setLong(0x13152, 0);
  sim.monthly();
  check("starving colony lights the food light", sim.alerts.lit(LIGHT.food));
  state.setLong(0x13152, 5_000_000);
  state.setLong(0x14432, 0x7fffffff);
  sim.monthly();
  check("fed colony turns it off", !sim.alerts.lit(LIGHT.food));
  state.setLong(0x1314a, 3000); // the starvation months above may have emptied the colony
  for (const type of [24, 30]) for (const off of [0xa, 0xc, 0xe]) state.setWord(world.typeAddress(type) + off, 0);
  sim.monthly();
  check("no air: air light", sim.alerts.lit(LIGHT.air) && state.byte(0x144b5) === 10, `pop ${state.long(0x1314a)} short ${state.byte(0x144b5)} stored ${state.word(0x131e2 + 18 * 30 + 0xe)}`);
}
{
  const state = new GameState(disk2, records[0].block);
  const a = new Alerts(state);
  a.focus(60, 40);
  check("focus stores view origin x-4,y-4", state.word(0x144e8) === 56 && state.word(0x144ea) === 36 && a.lit(LIGHT.focus) && state.byte(0x144bd) === 6);
  a.focus(2, 90);
  check("focus clamps to the map", state.word(0x144e8) === 0 && state.word(0x144ea) === 0x43);
  a.focus(200, 5);
  check("focus clamps x to $5C", state.word(0x144e8) === 0x5c && state.word(0x144ea) === 1);
  let lit = [];
  for (let d = 0; d < 8; d++) {
    a.daily();
    lit.push(a.lit(LIGHT.focus));
  }
  check("six days of light, then off (counter 6..0, cleared on the 7th)", JSON.stringify(lit) === JSON.stringify([true, true, true, true, true, true, false, false]), JSON.stringify(lit));
  a.focus(30, 30);
  const target = a.swapView(10, 12);
  check("swap: view goes to the bookmark, the old view becomes the bookmark", target.x === 26 && target.y === 26 && state.word(0x144e8) === 10 && state.word(0x144ea) === 12);
  check("click rectangle x 16-31, y 139-155", Alerts.hitsBookmark(16, 139) && Alerts.hitsBookmark(31, 155) && !Alerts.hitsBookmark(32, 139) && !Alerts.hitsBookmark(16, 156));
  const seq = [];
  const b = new Alerts(state);
  b.set(LIGHT.food, true);
  for (let i = 0; i < 6; i++) seq.push([b.visible(LIGHT.food), b.visible(LIGHT.power)]);
  check("lit light blinks on every second frame, unlit never shows", seq.every(([lit, off], i) => lit === (i % 2 === 0) && off === false), JSON.stringify(seq));
}
{
  // The sim hook: a focus effect raised by game code reaches the bookmark and the day counter runs from the sim.
  const ctx = fresh({ free: false });
  const { state, sim } = ctx;
  sim.effect("focus", 50, 50);
  check("Sim.effect(focus) lights the bookmark", sim.alerts.lit(LIGHT.focus) && state.word(0x144e8) === 46);
  let days = 0;
  while (sim.alerts.lit(LIGHT.focus) && days < 12) {
    for (let i = 0; i < 90; i++) sim.tick();
    days++;
  }
  check("and it goes out after 7 simulated days", days === 7, `${days}`);
}

// ---- 9. icons --------------------------------------------------------------------------------------------------------
{
  const icons = readLightIcons(disk1);
  check("four 16x16 icons with palette indices below 32", icons.length === 4 && icons.every((p) => p.length === 256 && p.every((v) => v < 32) && p.some((v) => v !== 0)));
}

// ---- 10. message log protect counters ($5A8C, $15698, $9A36) ----------------------------------------------------------
{
  const strings = { get: (i) => [65 + (i % 20)] };
  const m = new Messages(disk1, strings);
  const text = () => m.logText.map((l) => String.fromCharCode(...l)).join("");
  for (const i of [98, 99, 101]) m.push(i);
  check("three messages fill the panel", m.logText.length === 3);
  m.push(108);
  check("fourth while all are protected: panel wiped, new one on top", text() === String.fromCharCode(65 + (108 % 20)), text());
  const n = new Messages(disk1, strings);
  for (const i of [98, 99, 101]) n.push(i);
  for (let d = 0; d < 10; d++) n.dayPassed();
  n.push(108);
  const lines = n.logText.map((l) => String.fromCharCode(...l)).join("");
  check("fourth after ten days: the oldest scrolls out, the others stay", lines === [99, 101, 108].map((i) => String.fromCharCode(65 + (i % 20))).join(""), lines);
  n.push(110);
  const after = n.logText.length;
  check("survivors lost their protection (a fifth message scrolls again, but the new one is protected)", after === 3 && n.logText.map((l) => String.fromCharCode(...l)).join("") === [101, 108, 110].map((i) => String.fromCharCode(65 + (i % 20))).join(""));
  n.push(143);
  check("one more scrolls once more", n.logText.map((l) => String.fromCharCode(...l)).join("") === [108, 110, 143].map((i) => String.fromCharCode(65 + (i % 20))).join(""));
  const o = new Messages(disk1, strings);
  o.push(98);
  for (let i = 0; i < 500; i++) o.update();
  check("panel clears after 500 idle frames", o.logText.length === 0);
}

if (failed) {
  console.log(`${failed} construction check(s) failed`);
  process.exit(1);
}
console.log("all construction checks passed");
