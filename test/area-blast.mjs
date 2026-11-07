// Area-blast ownership (notes/formats/units.md section 6a, sfx.md, sim-port.md): which demolitions are blasts, and the single
// shared `$1237C` rule set (visible 8x8 window -> sprite + full volume, outside -> half-volume sound only, 30 fixed effect
// slots, a full pool returns without sprite or sound) applied once per `$75A8` footprint cell. Run after `npm run build`.
// Uses the user's own Disk.1 / Disk.2 in original/utopia-whdload (skipped when missing); all stagings are synthetic and
// nothing is compared with an emulator. Static evidence only: Disk.1 disassembly of $12332 / $1237C / $7372 / $75A8 /
// $10D00 / $11090 / $11676 / $3626.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("area-blast tests skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { MapScene } = await import("../dist/game/map.js");
const { Builder } = await import("../dist/game/build.js");
const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");
const { SFX } = await import("../dist/audio/sfx.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const newWorld = () => new World(new GameState(disk2, record.block), loadMap(disk2, record));

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// Scenario 0 buildings used below (see the Disk.2 object records): a single-cell tile $2F at (53,35) and a 2x2 launchpad
// $48 at (53,36) (footprint (53,36) (54,36) (54,37) (53,37) in `$75A8` order).
const ONE = [53, 35];
const FOUR = [53, 36];
const FOUR_LIST = [[53, 36], [54, 36], [54, 37], [53, 37]];
const COUNTER = 0x1346a;

// ---- 1. Sim.bomb with a hook-supplied footprint (no unit layer, no game map rules) ----------------------------------
{
  const run = (demolishAt) => {
    const world = newWorld();
    const log = [];
    const byteWrites = [];
    const setByte = world.state.setByte.bind(world.state);
    world.state.setByte = (address, value) => { byteWrites.push(address); setByte(address, value); };
    const sim = new Sim(world, { rng: createRng(3), demolishAt: demolishAt && ((x, y, bombing) => demolishAt(x, y, bombing, world)), effect: (kind, x, y) => log.push([kind, x, y]) });
    const before = world.state.word(COUNTER);
    sim.bomb(10, 20);
    return { log, counter: world.state.word(COUNTER) - before, byteWrites };
  };
  const footprint = run(() => [[10, 20], [11, 20], [11, 21], [10, 21]]);
  check("Sim.bomb: one explosion per reported footprint cell, in list order, one counter increment",
    footprint.counter === 1 && footprint.log.length === 4 && footprint.log.every((e) => e[0] === "explosion") &&
    footprint.log.map((e) => `${e[1]},${e[2]}`).join(" ") === "10,20 11,20 11,21 10,21");
  const none = run(() => []);
  check("Sim.bomb: a hook that demolished nothing (ground, site, refusal) reports [] -> no blast, but the counter still counts ($12350)", none.log.length === 0 && none.counter === 1);
  const unknownVoid = run(() => {});
  const unknownNumber = run(() => 7); // e.g. `(x, y) => list.push(...)`: not a footprint report
  const noHook = run(undefined);
  check("Sim.bomb: unknown or absent footprint reports no invented blast, but still increments the counter",
    [unknownVoid, unknownNumber, noHook].every((r) => r.counter === 1 && r.log.length === 0));
  let bombingModeDuringDemolition = false;
  const vent = run((x, y, bombing) => {
    bombingModeDuringDemolition = bombing;
    return [[x, y]];
  });
  check("Sim.bomb: passes the scoped $156A9 bit-4 permission to $7372 without writing that out-of-image address", bombingModeDuringDemolition && !vent.byteWrites.includes(0x156a9));
}

// ---- 2. Builder.demolish footprint (the cells `$75A8` lists) ---------------------------------------------------------
{
  const world = newWorld();
  const messages = [];
  const builder = new Builder(world, readFlagTable(disk1), readWeights(disk1), (n) => messages.push(n));
  const one = [];
  const four = [];
  check("Builder.demolish: a 1-cell building lists its origin only", builder.demolish(...ONE, one) && one.length === 1 && one[0][0] === ONE[0] && one[0][1] === ONE[1]);
  check("Builder.demolish: a 2x2 building lists origin, x+1, (x+1,y+1), (x,y+1) - from any of its cells",
    builder.demolish(54, 37, four) && JSON.stringify(four) === JSON.stringify(FOUR_LIST));
  const ground = [];
  builder.demolish(...ONE, ground); // now cleared ground ($38): the clearing path ($739E) builds no list
  check("Builder.demolish: clearing ground lists nothing", ground.length === 0);
  const refused = [];
  messages.length = 0;
  const refusedCell = [5, 5]; // map border / not demolishable: refusal message $58
  const res = builder.demolish(...refusedCell, refused);
  check("Builder.demolish: a refusal returns false, lists nothing and emits the refusal message", refused.length === 0 && res === false && messages.length === 1, `res=${res} msgs=${messages}`);
  // a construction site ($74FE) is removed without a list
  const siteWorld = newWorld();
  const siteBuilder = new Builder(siteWorld, readFlagTable(disk1), readWeights(disk1), () => {});
  const o = siteWorld.objects;
  const slot = (() => { for (let i = 0; i < o.length; i += 8) if (o[i + 4] === ONE[0] && o[i + 5] === ONE[1]) return i; return -1; })();
  o[slot] = 0; o[slot + 1] = 0x32; // SITE_TILE: building site record
  o[slot + 2] = 0; o[slot + 3] = 0x2f; // target tile
  const site = [];
  const siteResult = siteBuilder.demolish(...ONE, site);
  check("Builder.demolish: cancelling a construction site lists nothing", siteResult === true && site.length === 0);

  // Reuse a 1-cell object's record as a vent ($47) and mark its map word as occupied. `$7372` refuses it during a
  // plain click, while `$12332`'s scoped bit-4 permission allows the same demolition.
  const ventWorld = newWorld();
  const ventMessages = [];
  const ventBuilder = new Builder(ventWorld, readFlagTable(disk1), readWeights(disk1), (n) => ventMessages.push(n));
  const ventObjects = ventWorld.objects;
  const ventSlot = (() => { for (let i = 0; i < ventObjects.length; i += 8) if (ventObjects[i + 4] === ONE[0] && ventObjects[i + 5] === ONE[1]) return i; return -1; })();
  const ventCellAt = ONE[1] * 100 + ONE[0];
  ventObjects[ventSlot] = 0;
  ventObjects[ventSlot + 1] = 0x47;
  ventWorld.cells[ventCellAt] = (ventWorld.cells[ventCellAt] & ~0x3ff) | 0x4000 | 0x47;
  const refusedVentCells = [];
  const refusedVent = ventBuilder.demolish(...ONE, refusedVentCells);
  const ventSurvivedRefusal = ventObjects[ventSlot + 1] === 0x47 && (ventWorld.cells[ventCellAt] & 0x3ff) === 0x47;
  const bombVentCells = [];
  const bombedVent = ventBuilder.demolish(...ONE, bombVentCells, true);
  check("Builder.demolish: an occupied vent refuses plain demolition but accepts the bomb's bit-4 permission",
    refusedVent === false && ventSurvivedRefusal && refusedVentCells.length === 0 && bombedVent === true && bombVentCells.length === 1 &&
    ventObjects[ventSlot] === 0 && ventObjects[ventSlot + 1] === 0 &&
    ventMessages.length === 1 && ventMessages[0] === 0x123);
}

// ---- 3. Connected MapScene: $1237C rules on every blast cell ---------------------------------------------------------
{
  const tiles = loadTileSet(disk1, disk2, record).tiles;
  const strings = new GameStrings(disk1, 0);
  const sprites = loadSprites(disk1, disk2, record);

  const make = () => {
    const sounds = [];
    const scene = new MapScene(disk1, tiles, newWorld(), strings, { sprites, sfx: (id, volume) => sounds.push({ id, volume }) });
    return { scene, sounds, sim: scene.sim, state: scene.world.state, cells: scene.world.cells };
  };
  const view = (scene, x, y) => { scene.scrollX = x; scene.scrollY = y; };
  const fillPool = (scene, n = 30) => { while (scene.objects.pool.count < n) scene.objects.spawnEffect(0x12, 1, 1); };
  const effectCells = (scene) => scene.objects.effectSlots.filter((e) => e !== null && !(e.x === 1 && e.y === 1)).map((e) => `${e.x},${e.y}`);
  const cleared = (scene, [x, y]) => { const id = scene.cells[y * 100 + x] & 0x3ff; return (id >= 0x38 && id <= 0x3b) || id >= 0x94; }; // cleared tile $38 (+n over a 2x2)
  const LOW = SFX.EXPLOSION_LOW;

  {
    const { scene, sounds, sim } = make();
    view(scene, 50, 33);
    const objects = scene.world.objects;
    const slot = (() => { for (let i = 0; i < objects.length; i += 8) if (objects[i + 4] === ONE[0] && objects[i + 5] === ONE[1]) return i; return -1; })();
    const at = ONE[1] * 100 + ONE[0];
    objects[slot] = 0;
    objects[slot + 1] = 0x47;
    scene.cells[at] = (scene.cells[at] & ~0x3ff) | 0x4000 | 0x47;
    sim.bomb(...ONE);
    check("connected bomb path: Sim.bomb passes the occupied-vent permission, demolishes the vent and presents its footprint",
      objects[slot] === 0 && objects[slot + 1] === 0 && cleared(scene, ONE) && scene.objects.pool.count === 1 &&
      sounds.length === 1 && sounds[0].id === LOW && sounds[0].volume === 64,
      `slot=${objects[slot]},${objects[slot + 1]} tile=${scene.cells[at] & 0x3ff} effects=${scene.objects.pool.count} sounds=${sounds.length}`);
  }

  {
    const { scene, sounds, sim, state } = make();
    view(scene, 50, 33);
    const before = state.word(COUNTER);
    sim.bomb(...ONE);
    check("visible 1-cell bomb: exactly ONE explosion sound (low id, full volume 64) - the demolish callback no longer adds a second",
      sounds.length === 1 && sounds[0].id === LOW && sounds[0].volume === 64, JSON.stringify(sounds));
    check("visible 1-cell bomb: one effect slot (type $12, lift 0) at the cell, building gone, counter +1",
      scene.objects.pool.count === 1 && effectCells(scene).join() === "53,35" && scene.objects.effectSlots[0].type === 0x12 && scene.objects.effectSlots[0].lift === 0 && cleared(scene, ONE) && state.word(COUNTER) === before + 1);
  }
  {
    const { scene, sounds, sim } = make();
    view(scene, 50, 33);
    sim.bomb(54, 37); // any cell of the 2x2 footprint
    check("visible 2x2 bomb: four sounds (one per footprint cell, $12332 loop) and four slots in $75A8 order",
      sounds.length === 4 && sounds.every((s) => s.id === LOW && s.volume === 64) && effectCells(scene).join(" ") === "53,36 54,36 54,37 53,37" && FOUR_LIST.every((c) => cleared(scene, c)), JSON.stringify(sounds));
  }
  {
    const { scene, sounds, sim } = make();
    view(scene, 54, 33); // x = 53 is just outside the window, x = 54..61 inside
    sim.bomb(...FOUR);
    check("half-visible 2x2 bomb: the window test is per cell (32, 64, 64, 32 in list order); sprites only for the visible two",
      sounds.map((s) => s.volume).join() === "32,64,64,32" && effectCells(scene).join(" ") === "54,36 54,37" && scene.objects.pool.count === 2, JSON.stringify(sounds));
  }
  {
    const { scene, sounds, sim, state } = make();
    view(scene, 0, 0);
    const before = state.word(COUNTER);
    sim.bomb(...ONE);
    check("offscreen bomb: one half-volume (32) sound, no effect sprite, no pool use", sounds.length === 1 && sounds[0].id === LOW && sounds[0].volume === 32 && scene.objects.pool.count === 0 && cleared(scene, ONE) && state.word(COUNTER) === before + 1);
  }
  {
    const { scene, sounds, sim, state } = make();
    view(scene, 50, 33);
    fillPool(scene);
    const before = state.word(COUNTER);
    sim.bomb(...ONE);
    check("visible bomb with a full pool: no sprite and NO sound ($1237C returns early); the building is still demolished and counted",
      sounds.length === 0 && scene.objects.pool.count === 30 && cleared(scene, ONE) && state.word(COUNTER) === before + 1);
  }
  {
    const { scene, sounds, sim } = make();
    view(scene, 0, 0);
    fillPool(scene);
    sim.bomb(...ONE);
    check("offscreen bomb with a full pool: the half-volume sound still plays (the pool is only consulted in view)", sounds.length === 1 && sounds[0].volume === 32 && scene.objects.pool.count === 30);
  }
  {
    const { scene, sounds, sim } = make();
    view(scene, 50, 33);
    fillPool(scene, 28); // room for exactly two of the four cells
    sim.bomb(...FOUR);
    check("2x2 bomb with room for two effects: the first two cells (list order) get sprite + sound, the last two nothing",
      sounds.length === 2 && scene.objects.pool.count === 30 && effectCells(scene).join(" ") === "53,36 54,36", `${JSON.stringify(sounds)} ${effectCells(scene)}`);
  }
  {
    const { scene, sounds, sim, state } = make();
    view(scene, 50, 33);
    const before = state.word(COUNTER);
    sim.bomb(...ONE);
    sounds.length = 0;
    sim.bomb(...ONE); // now cleared ground: $7372 builds no list
    check("bombing cleared ground: the counter still counts but there is no blast sound or sprite", sounds.length === 0 && scene.objects.pool.count === 1 && state.word(COUNTER) === before + 2);
  }
  {
    // The Fleet's own ship destruction emits the same `explosion` effect: it now obeys the shared window / pool rules.
    const { scene, sounds, sim } = make();
    view(scene, 50, 33);
    sim.effect("explosion", 52, 34);
    check("explosion effect in view: sprite + full-volume sound", sounds.length === 1 && sounds[0].volume === 64 && scene.objects.pool.count === 1);
    sim.effect("explosion", 5, 5);
    check("explosion effect off view: half volume, no sprite", sounds.length === 2 && sounds[1].volume === 32 && scene.objects.pool.count === 1);
    fillPool(scene);
    sim.effect("explosion", 52, 34);
    check("explosion effect in view with a full pool: nothing", sounds.length === 2 && scene.objects.pool.count === 30);
  }

  // Direct demolishAt callers: only blast callers make a sound.
  {
    const { scene, sounds, sim, state } = make();
    view(scene, 50, 33);
    const o = scene.world.objects;
    const slot = (() => { for (let i = 0; i < o.length; i += 8) if (o[i + 4] === ONE[0] && o[i + 5] === ONE[1]) return i; return -1; })();
    o[slot + 1] = 0x60; // stage a mine ($11090 walks the records for tile $60)
    state.setWord(0x133c2, 1);
    const before = state.word(COUNTER);
    const morale = state.signedLong(A.morale);
    sim.eventMineCollapse(100);
    check("mine collapse ($11090 calls $7372 alone): the mine is gone but no blast sound, no sprite, no damage counter",
      (o[slot] === 0 && o[slot + 1] === 0) && sounds.length === 0 && scene.objects.pool.count === 0 && state.word(COUNTER) === before && state.signedLong(A.morale) < morale);
  }
  {
    const { scene, sounds, sim, state } = make();
    view(scene, 0, 0); // everything off view: every blast cell is one half-volume sound
    state.setByte(0x144bc, 3); // an arson spell in progress
    state.setByte(0x144c6, 0); // security percentage ($144C6): the arson roll cannot be caught
    const objects = (w) => { const out = []; const o = w.objects; for (let i = 0; i < o.length; i += 8) if (o[i] !== 0 || o[i + 1] !== 0) out.push(i); return out; };
    const had = objects(scene.world).length;
    const before = state.word(COUNTER);
    const originalDemolishAt = sim.demolishAt;
    let bombFootprint = [];
    sim.demolishAt = (x, y, bombing) => {
      bombFootprint = originalDemolishAt(x, y, bombing);
      return bombFootprint;
    };
    const message = sim["crimeArson"]();
    const gone = had - objects(scene.world).length;
    const effectCells = scene.objects.effectSlots.filter(Boolean).map((e) => `${e.x},${e.y}`).sort();
    check("arson ($10D60 calls $12332): one building bombed, counter +1, and half-volume sounds/effects match its exact footprint",
      message === 0x119 && gone === 1 && state.word(COUNTER) === before + 1 && bombFootprint.length > 0 &&
      sounds.length === bombFootprint.length && sounds.every((s) => s.volume === 32) &&
      effectCells.length === 0,
      `msg=${message} gone=${gone} footprint=${bombFootprint.length} sounds=${sounds.length} effects=${effectCells}`);
  }
  {
    // Meteor impact ($11676): no blast at the centre, only the bombed building cells. Centre (53,35): the 5x5 window
    // also covers the launchpad at (53,36) and the tile-$33 / $2F buildings around it.
    const { scene, sounds, sim, state } = make();
    view(scene, 50, 33);
    const o = scene.world.objects;
    const live = () => { let n = 0; for (let i = 0; i < o.length; i += 8) if (o[i] !== 0 || o[i + 1] !== 0) n++; return n; };
    const flagged = [];
    for (let cy = 33; cy <= 37; cy++) for (let cx = 51; cx <= 55; cx++) if (scene.cells[cy * 100 + cx] & 0x0400) flagged.push([cx, cy]);
    const had = live();
    const morale = state.signedLong(A.morale);
    const counter = state.word(COUNTER);
    sim.aliens["impact"](...ONE);
    const bombedCalls = state.word(COUNTER) - counter;
    // each flagged cell calls $12332 once, so the counter counts the flagged cells that were still flagged when reached
    check("meteor impact: every blast cell sounds once and there is no extra centre blast; morale falls",
      sounds.length === 5 /* 1 single cell + the 2x2 launchpad */ && sounds.length === scene.objects.pool.count && sounds.every((s) => s.volume === 64) && bombedCalls === 2 &&
      live() < had && state.signedLong(A.morale) < morale, `sounds=${sounds.length} pool=${scene.objects.pool.count} calls=${bombedCalls} flagged=${flagged.length}`);
    const byCell = new Map();
    for (const e of scene.objects.effectSlots) if (e) byCell.set(`${e.x},${e.y}`, (byCell.get(`${e.x},${e.y}`) ?? 0) + 1);
    check("meteor impact: at most one effect per building cell (one per footprint cell of each demolished building)", [...byCell.values()].every((n) => n === 1));
  }
  {
    // Earth tank requisition ($11280 -> $4692 alone, no attacker mark): the unit leaves silently. A tank destroyed in
    // combat ($4692 + $4732 with bit 5 of $156A9 set) still blasts through the same $1237C routine.
    const setup = () => {
      const env = make();
      view(env.scene, 50, 33);
      const unit = env.scene.objects.units.spawnAtYard(55, 40, false);
      env.state.setWord(0x1429c, 20);
      env.state.setLong(unit.type === 9 ? 0x14254 : 0x14258, 20);
      return { ...env, unit };
    };
    const req = setup();
    const lost0 = req.state.long(0x14294);
    const cell = { x: req.unit.x, y: req.unit.y };
    req.sim.eventTankRequisition(100);
    const offered = req.sim.pending !== null && req.sim.pending.offer.what === "tanks";
    req.sim.resolveOffer(true);
    check("tank requisition: the unit is removed silently (no effect slot, no sound), counts and lost statistic still update",
      offered && !req.scene.objects.units.units.includes(req.unit) && req.scene.objects.pool.count === 0 && req.sounds.length === 0 &&
      req.state.word(0x1429c) < 20 && req.state.long(0x14294) > lost0, `offered=${offered} effects=${req.scene.objects.pool.count} sounds=${req.sounds.length}`);

    const full = setup();
    fillPool(full.scene);
    full.sim.eventTankRequisition(100);
    full.sim.resolveOffer(true);
    check("tank requisition with a full effect pool: still removed and the pool is untouched",
      !full.scene.objects.units.units.includes(full.unit) && full.scene.objects.pool.count === 30);

    const combat = setup();
    const unitCell = { x: combat.unit.x, y: combat.unit.y };
    combat.scene.enemies.destroyTank(combat.unit);
    check("combat destruction of a tank stays blast-enabled: one explosion effect at the tank cell and the full-volume sound",
      !combat.scene.objects.units.units.includes(combat.unit) && combat.scene.objects.pool.count === 1 &&
      effectCells(combat.scene).join() === `${unitCell.x},${unitCell.y}` && combat.sounds.length === 1 && combat.sounds[0].volume === 64 &&
      combat.state.word(0x1429c) === 19, `${effectCells(combat.scene)} sounds=${JSON.stringify(combat.sounds)} cell=${cell.x},${cell.y}`);
  }

  {
    // A hook-bound player demolish (left click in demolish mode) is not a blast: `$7372` alone.
    const { scene, sounds } = make();
    view(scene, 50, 33);
    scene.controls.mode = "demolish";
    let px = -1, py = -1;
    for (let y = 8; y < 190 && px < 0; y += 2) for (let x = 0; x < 300; x += 2) {
      const c = scene.controls.pickCell(x, y);
      if (c && c.x === ONE[0] && c.y === ONE[1]) { px = x; py = y; break; }
    }
    const idle = { leftButton: false, rightButton: false, pointerX: px, pointerY: py, keys: [] };
    for (let i = 0; i < 4; i++) scene.update(idle); // input is polled once per main-loop pass (4 video updates)
    for (let i = 0; i < 8; i++) scene.update({ ...idle, leftButton: true });
    const gone = (scene.cells[ONE[1] * 100 + ONE[0]] & 0x3ff) !== 0x2f;
    check("player demolish click ($7372 alone): the building is cleared but there is no blast sound or sprite", px >= 0 && gone && sounds.length === 0 && scene.objects.pool.count === 0, `px=${px} py=${py} gone=${gone}`);
  }
}

if (failed > 0) {
  console.log(`${failed} area-blast check(s) FAILED`);
  process.exit(1);
}
console.log("all area-blast checks passed");
