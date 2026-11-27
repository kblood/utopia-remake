// Synthetic regression of two consequences of `$4732` clearing a freed enemy record's +0 (type) and +1/+2 (x, y) by a word store
// and a byte store (enemies.md 3d; ship-control.md 5e). Run after `npm run build`. Uses the original Disk.1 / Disk.2 files read
// at runtime (nothing is copied into the repository).
//
// Static trace (Disk.1, 2026-11-10):
//   - `$1266A` runs for a bomber after `$11C7A` even when that step killed it (`$11AD0`/`$11AD4`/`$11ADA`). The attack reads the
//     record's cleared +1/+2, so its centre is cell (0,0). Its first spiral cell (table `$12C96` entry 0, step (0,-1)) is map
//     row -1, which is the `$73FF` header of the map buffer (103 words at `$3F188`, checked for all 10 scenarios with
//     tools/map_common.py). The scan stops at a `$73FF` word before any tank, ship, building or random draw, so the dead
//     bomber's attack is a no-op. The remake skips the attack of a dead aircraft; this test pins that outcome.
//   - `$4408` tests a missile's arrival against the POINTED record even when its slot is free. That record now reads as cell
//     (0,0), and type 0 takes the ground branch: mode 2, dir 3, no velocity (ship-control.md 5e).
//
// Expected values come from that trace, not from the implementation. Each dead/alive pair is driven on an enemy-tick pass,
// because `$1266A` runs only on that tick.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1 = new Uint8Array(fs.readFileSync(path.join(root, "original", "utopia-whdload", "Disk.1")));
const disk2 = new Uint8Array(fs.readFileSync(path.join(root, "original", "utopia-whdload", "Disk.2")));

const { readScenarioRecords, loadMap, MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { loadCombatTables } = await import("../dist/data/combat.js");
const { GameState } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { UnitSystem, inMap } = await import("../dist/game/units.js");
const { EnemySystem } = await import("../dist/game/enemies.js");

const records = readScenarioRecords(disk2);
const tables = loadCombatTables(disk1);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const BLOCKED = 0x1000;
const OCCUPIED = 0x4000;
const ACTIVE = 0x0400;
const AIR = 0x2000;

// The blast-mark.mjs fixture: a real Sim, UnitSystem and EnemySystem on scenario 0. Bombs (demolitions) and explosions are
// recorded. Rolls are 0 (every chance succeeds), the TOD gate is open (value 0).
function fresh({ tod = 0 } = {}) {
  const state = new GameState(disk2, records[0].block);
  const world = new World(state, loadMap(disk2, records[0]));
  const bombs = [];
  const explosions = [];
  const sim = new Sim(world, {
    rng: (range) => Math.min(0, range - 1),
    hardware: { todLow: () => tod, rasterParity: () => 0 },
    demolishAt: (x, y) => bombs.push([x, y]),
    spawnEnemy: (s) => enemies.spawn(s),
    defectUnit: () => enemies.defect(),
    repairUnits: (n) => enemies.repair(n),
    blast: (x, y, lift, high) => {
      explosions.push({ x, y, lift, high });
      return false;
    },
  });
  state.setByte(0x144c8, 0); // power level 0: the guns work
  const units = new UnitSystem(world.cells, () => 1, {
    lost: (u) => enemies.tankLeft(u),
    combat: (u, t) => enemies.tankCombat(u, t),
  }, world.cellFlags);
  const enemies = new EnemySystem(sim, units, tables, {
    explode: (x, y, lift, high) => {
      explosions.push({ x, y, lift, high });
      return undefined;
    },
    sound: () => {},
    buildingHeight: () => 20,
  });
  const run = (passes) => {
    for (let i = 0; i < passes; i++) {
      units.tick();
      enemies.pass(units.clock);
    }
  };
  return { state, world, sim, units, enemies, bombs, explosions, run, cells: world.cells, clock: units.clock };
}

// A free 12x12 area of plain ground (no blocked, occupied, active or air cell), as in blast-mark.mjs.
function freeArea(world, size = 12) {
  for (let y = 4; y < MAP_HEIGHT - size - 4; y++) {
    for (let x = 4; x < MAP_WIDTH - size - 4; x++) {
      let ok = true;
      for (let dy = 0; dy < size && ok; dy++) {
        for (let dx = 0; dx < size; dx++) {
          if (world.cells[(y + dy) * MAP_WIDTH + x + dx] & (BLOCKED | OCCUPIED | ACTIVE | AIR)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { x, y };
    }
  }
  throw new Error("no free area");
}

function spawn(env, air, type, x, y, dir, entry = [0, 6, 0, 3, 0, 5, 50, 0]) {
  const slots = air ? env.enemies.airSlots : env.enemies.groundSlots;
  const known = new Set(slots);
  if (!env.enemies.spawn({ air, type, x, y, dir, entry })) throw new Error("spawn failed");
  return slots.find((e) => e !== null && !known.has(e));
}

// ---- 1. the centre of the attack after a kill, and the first cell of its spiral ----------------------------------------------

{
  const [dx0, dy0] = tables.spiral[0];
  check("the attack spiral starts at (0,-1) relative to its centre (table $12C96 entry 0)", dx0 === 0 && dy0 === -1, `${dx0},${dy0}`);
  check("so a centre at (0,0), the cleared position of a freed record, starts on the off-map row -1 ($73FF header)", !inMap(0 + dx0, 0 + dy0));
  // The remaining spiral cells of a centre at (0,0) are never reached: the first border word ends the scan.
  check("the spiral has 48 cells", tables.spiral.length === 48);
}

// ---- 2. a bomber killed inside the map by its kamikaze detonation ($11C7A -> $119C0 -> $11C30) ------------------------------
// The record is cleared to (0,0) before the original's $1266A runs on it, so the bomber lays no attack bomb from its death cell.
// The bomber dies in the middle of an active block, so a naive attack from the death cell would bomb the ring around it. The
// same run with the TOD gate closed (value 200) is the baseline: the detonation's own demolitions must be the only bombs.

function activeBlock(env, x, y, size = 12) {
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) env.cells[(y + dy) * MAP_WIDTH + x + dx] |= ACTIVE;
}

// One scenario: a free area with an active block, `warm` passes, then `setup` puts the enemy in place, then one pass.
// Returns the env, what `setup` made, and whether that pass was an enemy-tick pass (the only pass $1266A can run on).
function onePass({ warm, tod = 0, setup }) {
  const env = fresh({ tod });
  const pos = freeArea(env.world);
  activeBlock(env, pos.x, pos.y);
  env.run(warm);
  const made = setup(env, pos);
  env.run(1);
  return { env, made, tick: env.clock.enemyTick };
}

{
  // a warm-up that puts the detonation pass on an enemy tick (the tick phase is fixed by the number of passes before it)
  let found = null;
  for (let warm = 0; warm < 12 && !found; warm++) {
    const probe = onePass({
      warm,
      setup: (env, pos) => {
        const bx = pos.x + 6;
        const by = pos.y + 6;
        const a = spawn(env, true, 25, bx, by, 2);
        a.aux = -2; // +$13 < 0: $11C7A hands the bomber to the kamikaze step $119C0
        a.mode = 2; // detonation step
        a.lift = 0; // -2 on this step; $119C0 detonates when +$13 >= lift
        return { bx, by, a };
      },
    });
    if (probe.tick && !probe.env.enemies.air.includes(probe.made.a)) found = { warm, probe };
  }
  check("dead bomber: a warm-up exists that puts the detonation on an enemy-tick pass", found !== null);
  if (found) {
    const { warm, probe } = found;
    const gateClosed = onePass({
      warm,
      tod: 200, // $1266A's TOD gate (0..24) stays closed; nothing else differs
      setup: (env, pos) => {
        const bx = pos.x + 6;
        const by = pos.y + 6;
        const a = spawn(env, true, 25, bx, by, 2);
        a.aux = -2;
        a.mode = 2;
        a.lift = 0;
        return { bx, by, a };
      },
    });
    const { bx, by, a } = probe.made;
    check("dead bomber: the detonation killed it inside the map (the record is gone)", !probe.env.enemies.air.includes(a) && probe.env.enemies.air.length === 0);
    check("dead bomber: the bombs equal the gate-closed baseline (the dead record lays no attack bomb from its death cell)",
      JSON.stringify(probe.env.bombs) === JSON.stringify(gateClosed.env.bombs) && probe.env.bombs.some(([x, y]) => x === bx && y === by),
      JSON.stringify({ open: probe.env.bombs.length, closed: gateClosed.env.bombs.length }));
    check("dead bomber: no explosion from the attack (none was due: no blast mark)", probe.env.explosions.length === 0, JSON.stringify(probe.env.explosions));
  }
}
{
  // control: an ordinary bomber (aux >= 0) in the same block flies north on an enemy-tick pass; its attack bombs a neighbour
  let found = null;
  for (let warm = 0; warm < 12 && !found; warm++) {
    const probe = onePass({
      warm,
      setup: (env, pos) => {
        const bx = pos.x + 6;
        const by = pos.y + 6;
        const a = spawn(env, true, 25, bx, by, 0);
        a.mode = 3; // straight flight: no bomb run, the attack is the only bombing
        return { bx, by, a };
      },
    });
    if (probe.tick) found = probe;
  }
  check("ordinary bomber control: a warm-up exists that puts the pass on an enemy tick", found !== null);
  if (found) {
    const { bx, by, a } = found.made;
    const attackBombs = found.env.bombs.filter(([x, y]) => !(x === bx && y === by));
    check("ordinary bomber control: alive after the pass and its attack from a live cell bombs an active neighbour",
      found.env.enemies.air.includes(a) && attackBombs.length >= 1, JSON.stringify(found.env.bombs));
  }
}

// ---- 3. a missile that arrives at a freed slot's cell (0,0)..(1,1) freezes like a ground hit; elsewhere it flies on ----------

// A ground target at a free area, a launch at it, and then the target is killed: its slot is free, `$4732` has cleared it.
function freedTargetMissile(cx, cy) {
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const target = spawn(env, false, 22, x + 10, y + 2, 0);
  target.mode = 5;
  if (!env.enemies.launchMissile({ x: x + 2, y: y + 2 }, env.enemies.findTarget(20, x + 2, y + 2))) throw new Error("launch failed");
  env.run(1);
  env.enemies.destroyGround(target, false);
  const m = env.sim.fleet.ships[0];
  if (!m) throw new Error("no missile");
  // The launch climbs to lift $22 in mode 4 (4 per pass); put the missile at its arrival cell in mode 1 with zero velocity.
  m.mode = 1;
  m.lift = 0x22;
  m.dir = 8;
  m.dx = 0;
  m.dy = 0;
  m.x = cx;
  m.y = cy;
  m.targetX = cx;
  m.targetY = cy;
  return { env, m, target, x, y };
}

for (const [cx, cy] of [[0, 0], [1, 1], [1, 0], [0, 1]]) {
  const { env, m } = freedTargetMissile(cx, cy);
  env.run(1);
  check(`missile arriving at (${cx},${cy}) with its slot freed: frozen in mode 2, dir 3 (the ground branch of $4408 against cell (0,0))`,
    m.mode === 2 && m.dir === 3, `mode ${m.mode} dir ${m.dir}`);
  env.run(30);
  check(`missile arriving at (${cx},${cy}) with its slot freed: removed silently by the lift step, bit 5 of $156A9 left set`,
    env.sim.fleet.ships.length === 0 && env.sim.blastMark === true && env.explosions.length === 0 && env.enemies.groundSlots.every((e) => e === null),
    JSON.stringify({ ships: env.sim.fleet.ships.length, mark: env.sim.blastMark, explosions: env.explosions.length }));
}
for (const [cx, cy] of [[2, 0], [0, 2], [5, 5]]) {
  const { env, m } = freedTargetMissile(cx, cy);
  env.run(3);
  check(`missile arriving at (${cx},${cy}) with its slot freed: outside the 3x3 box of (0,0), no freeze (mode 1 kept), no mark`,
    env.sim.fleet.ships[0] === m && m.mode === 1 && env.sim.blastMark === false, `mode ${m.mode} mark ${env.sim.blastMark}`);
}

// ---- 4. what a death leaves in a freed record, and who reads it (enemies.md 3e) -------------------------------------------
// Static Disk.1 pins (file offset = address + $28800). $4732 stores a word of zero at +0 (type and x), a byte at +2 (y) and a
// word at +8 (hit points and mode); nothing else in the record. The $4408 arrival on a FREE target (type 0 takes the ground
// branch) stores $FF at +B and 5 at +9 of the freed record. The shared spawn tail ($4924-$497A, reached from both branches)
// stores +9 = 6 and +B = +C = $FF, and never +$10..+$12 or +$16..+$19; the air branch stores only +$10 = $22 before it, the
// ground branch +$10..+$12 = $FF. Every routine that reads a free record first tests its type byte.
const hexAt = (addr, n) => Buffer.from(disk1.subarray(addr + 0x28800, addr + 0x28800 + n)).toString("hex");
check("$4732 writes +0 (word), +2 (byte) and +8 (word) of the record and nothing else (the blast is the only other effect)",
  hexAt(0x4768, 12) === "3b4000001b4000023b400008", hexAt(0x4768, 12));
check("$4408 free-target arrival (ground branch) stores $FF at +B and 5 at +9 of the record it points at",
  hexAt(0x4486, 10) === "50ee000b1d7c00050009", hexAt(0x4486, 10));
check("the shared spawn tail stores +9 = 6 and +B = +C = $FF, so a reused record is re-initialised for those bytes",
  hexAt(0x4960, 14) === "1d7c0006000950ee000b50ee000c", hexAt(0x4960, 14));
check("the air spawn branch stores +$10 = $22 and no other byte before the shared tail (it leaves +$11/+$12 stale)",
  hexAt(0x48e0, 6) === "1d7c00220010" && hexAt(0x48ea, 2) === "6038", hexAt(0x48e0, 6) + " " + hexAt(0x48ea, 2));
check("the ground spawn branch stores +$10..+$12 = $FF (the remake's default 'recent' directions)",
  hexAt(0x4918, 8) === "3d4000101d400012", hexAt(0x4918, 8));

{
  // A slot reused after a free-target arrival: the stray +9 = 5 and +B = $FF of the freed record are overwritten by the spawn.
  const { env, m, target, x, y } = freedTargetMissile(0, 0);
  env.run(1);
  check("reuse: the freeze leaves the freed slot's kills and counts as they were (no kill, no count change)",
    env.state.word(0x142a2) === 0 && env.state.long(0x14298) === 1, JSON.stringify({ count: env.state.word(0x142a2), kills: env.state.long(0x14298) }));
  env.run(30);
  check("reuse: the missile is gone and nothing of the freed target is left alive", env.sim.fleet.ships.length === 0 && env.enemies.ground.length === 0);
  const again = env.enemies.spawn({ air: false, type: 23, x, y, dir: 0, entry: [0, 6, 0, 3, 0, 5, 50, 0], origin: "wave" });
  const e = env.enemies.groundSlots[0];
  check("reuse: the wave spawn into the freed slot succeeds and the new enemy starts unfrozen (mode 6, no target, not waiting)",
    again === true && e !== null && e.mode === 6 && e.targetX === 0xff && e.targetY === 0xff && e.waiting === false,
    JSON.stringify(e && { mode: e.mode, tx: e.targetX, ty: e.targetY, waiting: e.waiting }));
  void target;
}
{
  // The same freeze for an AIR slot: $4408 tests only the type byte, so a freed air record reads as cell (0,0) and type 0 too.
  const env = fresh();
  const { x, y } = freeArea(env.world);
  const target = spawn(env, true, 25, x + 10, y + 2, 0);
  if (!env.enemies.launchMissile({ x: x + 2, y: y + 2 }, { x: target.x, y: target.y, enemy: target })) throw new Error("air launch failed");
  env.run(1);
  env.enemies.destroyAir(target, false);
  const m = env.sim.fleet.ships[0];
  if (!m) throw new Error("no missile");
  m.mode = 1;
  m.lift = 0x22;
  m.dir = 8;
  m.dx = 0;
  m.dy = 0;
  m.x = 0;
  m.y = 0;
  m.targetX = 0;
  m.targetY = 0;
  env.run(1);
  check("air slot freed: a missile arriving at (0,0) freezes in mode 2, dir 3 (type 0 takes the ground branch of $4408)",
    m.mode === 2 && m.dir === 3, `mode ${m.mode} dir ${m.dir}`);
  env.run(30);
  check("air slot freed: removed silently with bit 5 left set, and the air list stays empty",
    env.sim.fleet.ships.length === 0 && env.sim.blastMark === true && env.explosions.length === 0 && env.enemies.airSlots.every((a) => a === null),
    JSON.stringify({ ships: env.sim.fleet.ships.length, mark: env.sim.blastMark, explosions: env.explosions.length }));
}

if (failed > 0) {
  console.log(`${failed} freed-record check(s) FAILED`);
  process.exit(1);
}
console.log("all freed-record tests passed");
