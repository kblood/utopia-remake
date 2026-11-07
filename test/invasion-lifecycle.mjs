// Connected static-trace regression for a ground invasion in the live MapScene loop.
// Uses player-supplied WHDLoad data for tables/assets; fixture setup is synthetic and not an original-game capture.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("invasion lifecycle checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
const { loadSprites } = await import("../dist/data/sprites.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { loadCombatTables } = await import("../dist/data/combat.js");
const { GameState, A, PERIOD } = await import("../dist/game/state.js");
const { World, T } = await import("../dist/game/world.js");
const { MapScene } = await import("../dist/game/map.js");
const { SYS } = await import("../dist/game/sim.js");
const { cellFlagIndex } = await import("../dist/game/cell-flags.js");

const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
const record = readScenarioRecords(disk2)[0];
const world = new World(new GameState(disk2, record.block), loadMap(disk2, record));
const rolls = [];
let rasterReads = 0;
let recording = false;
const scene = new MapScene(disk1, loadTileSet(disk1, disk2, record).tiles, world, new GameStrings(disk1, 0), {
  sprites: loadSprites(disk1, disk2, record),
  simulation: {
    interactive: false,
    decide: () => false,
    rng: (range) => { if (recording) rolls.push(range); return Math.min(0, range - 1); },
    hardware: { todLow: () => 0, rasterParity: () => { if (recording) rasterReads++; return 0; } },
  },
});
const state = world.state;
const bombCalls = [];
const originalBomb = scene.sim.bomb.bind(scene.sim);
scene.sim.bomb = (x, y) => { bombCalls.push([x, y]); originalBomb(x, y); };
const idle = { leftButton: false, rightButton: false, pointerX: 10, pointerY: 10, keys: [] };
const pass = () => { for (let i = 0; i < scene.loop.vblPerPass; i++) scene.update({ ...idle, keys: [] }); };
const addBuilding = (tile, x, y, active) => {
  const slot = world.objectCount++;
  const at = slot * 8;
  world.objects[at] = tile >> 8;
  world.objects[at + 1] = tile & 0xff;
  world.objects[at + 3] = 0xff;
  world.objects[at + 4] = x;
  world.objects[at + 5] = y;
  state.setWord(0x142c2, state.word(0x142c2) + 1);
  const type = world.findType(tile);
  const typeAddress = world.typeAddress(type);
  state.setWord(typeAddress + T.total, state.word(typeAddress + T.total) + 1);
  if (active) state.setWord(typeAddress + T.active, state.word(typeAddress + T.active) + 1);
  const idx = y * 100 + x;
  world.cells[idx] = (world.cells[idx] & ~0x3ff) | tile | (active ? 0x0400 : 0);
  return { slot, idx, typeAddress };
};

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A finished but inactive farm gives the walker a real object target without stopping its attack scan.
let spawnX = -1;
let spawnY = -1;
for (let y = 8; y < 60 && spawnX < 0; y++) {
  for (let x = 8; x < 90; x++) {
    const here = world.cells[y * 100 + x];
    const below = world.cells[(y + 1) * 100 + x];
    if (!(here & 0x5000) && !(here & 0x0400) && !(below & 0x5000) && !(below & 0x0400)) { spawnX = x; spawnY = y; break; }
  }
}
if (spawnX < 0) throw new Error("could not find a clear fixture cell");
addBuilding(0x41, Math.min(95, spawnX + 30), Math.min(68, spawnY + 20), false);
state.setByte(A.frameCountdown, 90);
state.setByte(A.pending, 0);
state.setWord(0x142a2, 0);
state.setLong(0x14298, 0);

// Level-1 wave row ($13476, 8 entries x 8 bytes): a single ground entry whose count byte (-1) plus the deterministic
// raster-parity jitter (+2 for parity 0) yields exactly one enemy. The other seven entries are empty.
const REC = 0x13456;
const entry = REC + 0x20;
state.setByte(REC + 0x11, 1);
for (let i = 0; i < 64; i++) state.setByte(entry + i, 0);
for (const [offset, value] of [[0, 22], [1, 6], [2, 0], [3, 4], [4, 0xff], [5, 0], [6, 40], [7, 0]]) state.setByte(entry + offset, value);
// Strength 50 (min 50, no decay) so the injected roll 0 passes the warning gate; no intelligence level, no countdown.
state.setByte(REC + 0x10, 50);
state.setByte(REC + 0x18, 50);
state.setByte(REC + 0x1d, 0);
state.setByte(REC + 0x1f, 0);
state.setByte(0x144ca, 0);
state.setByte(0x141b2, 0);
const group = 0x135c6;
state.setByte(group + 0x90, 0);
state.setByte(group + 0x91, 0);
for (let i = 0; i < 8; i++) {
  state.setByte(group + 2 * i, spawnX);
  state.setByte(group + 2 * i + 1, spawnY);
}
for (let i = 0; i < 32; i++) state.setLong(group + 0x10 + 4 * i, 0);
const queued = () => { let n = 0; for (let i = 0; i < 32; i++) if (state.long(group + 0x10 + 4 * i) !== 0) n++; return n; };
scene.sim.sysFlags &= ~SYS.attackPending & ~SYS.noUnitBonus;

// Route both event-9 calls through the ordinary daily worker and event dispatcher. The event-index slot is staged as 9
// twice because the real monthly/day calendar lifecycle is outside this invasion fixture.
const dispatchEvent9 = () => {
  state.setByte(0x144bf, 9);
  state.setByte(A.pending, state.byte(A.pending) | PERIOD.daily);
  pass();
};
recording = true;
dispatchEvent9();
const warned = (scene.sim.sysFlags & SYS.attackPending) !== 0;
dispatchEvent9();
check("daily event dispatcher: event 9 warns, then clears attackPending and queues one entry", warned && (scene.sim.sysFlags & SYS.attackPending) === 0 && queued() === 1 && state.byte(group + 0x90) === 1 && state.long(group + 0x10) === entry, `queued ${queued()}, count ${state.byte(group + 0x90)}`);
check("wave RNG ranges are [100,16,8] with one raster read", JSON.stringify(rolls) === "[100,16,8]" && rasterReads === 1, `ranges ${JSON.stringify(rolls)}, raster reads ${rasterReads}`);
recording = false;

// The real scene spawner walks its own group index / queue cursor until it reaches the queued slot.
let spawnPasses = 0;
// The spawner group/cursor and calendar run normally. Non-interactive mode declines unrelated Earth offers so they
// cannot suspend the queue walk. Group 0 recurs every 16 passes and the cursor takes six 0x14 steps per visit.
while (!scene.enemies.groundSlots[0] && spawnPasses < 120) { pass(); spawnPasses++; }
const attacker = scene.enemies.groundSlots[0];
const spawnIndex = spawnY * 100 + spawnX;
check("MapScene spawner consumes the queued wave entry after the enemy layer and allocates ground slot 0", attacker?.type === 22 && state.byte(group + 0x90) === 0 && queued() === 0 && state.word(0x142a2) === 1, `passes ${spawnPasses}`);
check("wave spawn sets map occupancy but defers flag/reservation until movement (slot pointer stays at its initial 0, no reservation cell)", (world.cells[spawnIndex] & 0x4000) !== 0 && (world.cellFlags[cellFlagIndex(spawnX, spawnY)] & 1) === 0 && attacker?.reserveX === -1 && attacker?.reserveY === -1 && scene.enemies.groundFlagPointers[0] === 0);

// Next pass chooses a target, the following pass begins the walk and claims a reservation cell.
pass();
check("the spawned enemy is not stepped in its creation pass; its next pass selects a target", attacker?.mode === 1 && attacker.x === spawnX && attacker.y === spawnY);
pass();
const claimed = attacker && (world.cellFlags[cellFlagIndex(attacker.reserveX, attacker.reserveY)] & 1) !== 0;
check("normal scene movement claims a flag-byte reservation", claimed && (attacker.reserveX !== spawnX || attacker.reserveY !== spawnY), `${attacker?.x},${attacker?.y} reserved ${attacker?.reserveX},${attacker?.reserveY}`);

// The static attack trace reads CIA TOD (injected 0 opens the gate) then consumes only the 100-way bomb roll.
// Place a finished active building in the known adjacent cell used by the combat spiral.
const attackX = attacker.x;
const attackY = attacker.y;
const targetCell = attackY + 1 < 74 ? [attackX, attackY + 1] : [attackX, attackY - 1];
const victim = addBuilding(0x41, targetCell[0], targetCell[1], true);
attacker.mode = 5; // idle walker still executes the traced attack branch on an enemy tick
const beforeSites = state.word(0x142c2);
let attackPasses = 0;
while (world.objects[victim.slot * 8 + 1] !== 0 && attackPasses < 12) { pass(); attackPasses++; }
check("enemy attack uses Builder demolition through the scene hook and removes the building record", world.objects[victim.slot * 8 + 1] === 0 && state.word(0x142c2) === beforeSites - 1 && (world.cells[victim.idx] & 0x0400) === 0, `passes ${attackPasses}, attacker ${attacker.x},${attacker.y}, target ${targetCell}, bombs ${JSON.stringify(bombCalls)}`);
check("enemy remains in its fixed slot after attacking and records the wait state", scene.enemies.groundSlots[0] === attacker && attacker.waiting);

// Place a finished gun in an unobstructed arc that reaches the claimed enemy. Trigger the actual $99C4 latch path.
const arcs = loadCombatTables(disk1).arcs;
let gun = null;
for (let y = 2; y < 72 && !gun; y++) for (let x = 2; x < 98 && !gun; x++) for (let rot = 0; rot < 8 && !gun; rot++) {
  const arc = arcs[rot];
  const hit = arc.findIndex(([dx, dy]) => x + dx === attacker.reserveX && y + dy === attacker.reserveY && Math.abs(attacker.reserveX - attacker.x) <= 1 && Math.abs(attacker.reserveY - attacker.y) <= 1);
  if (hit < 0 || hit >= 16 || arc.slice(0, hit + 1).some(([dx, dy]) => x + dx < 0 || y + dy < 0 || x + dx >= 100 || y + dy >= 75) || arc.slice(0, Math.min(8, hit)).some(([dx, dy]) => (world.cells[(y + dy) * 100 + x + dx] & 0x0400) !== 0)) continue;
  gun = { x, y, rot };
}
if (!gun) throw new Error("could not find a clear gun arc to the attacker");
const gunRecord = addBuilding(0x1f, gun.x, gun.y, true);
const gunAt = gunRecord.slot * 8;
world.objects[gunAt + 2] = gun.rot;
world.objects[gunAt + 6] = 0;
world.objects[gunAt + 7] = 0;
world.cells[gun.y * 100 + gun.x] = (world.cells[gun.y * 100 + gun.x] & ~0xff) | ((0x1f + gun.rot) & 0xff);
state.setByte(0x144c8, 0);
state.setLong(0x1310e, 20);
const gunCalls = [];
const originalFireGuns = scene.enemies.fireGuns.bind(scene.enemies);
scene.enemies.fireGuns = (tile, damage) => { gunCalls.push([tile, damage]); originalFireGuns(tile, damage); };
state.setByte(A.pending, state.byte(A.pending) | PERIOD.special);
const kills = state.long(0x14298);
pass();
check("scheduled Gun A destroys the invader through the same EnemySystem slot", scene.enemies.groundSlots[0] === null && state.word(0x142a2) === 0 && state.long(0x14298) === kills + 1, `gun ${JSON.stringify(gun)}, target ${attacker.x},${attacker.y}, flag ${(world.cellFlags[cellFlagIndex(attacker.reserveX, attacker.reserveY)] & 1) !== 0}, timer ${world.objects[gunAt + 7]}, calls ${JSON.stringify(gunCalls)}, pending ${state.byte(A.pending)}`);
// Explosive kill (static $11C5C -> $4732 -> $1237C trace + one staged live capture, enemies.md section 6): the effect
// list is not full, so the routine clobbers A6 (off-view sound, or in-view sprite) and the map bit 14 stays set while the
// reservation flag is cleared.
check("gun kill: reservation flag cleared, map bit 14 left set (A6 clobbered by $1237C, effect list not full)", world.objects[gunAt + 7] === 3 && (world.cellFlags[cellFlagIndex(attacker.reserveX, attacker.reserveY)] & 1) === 0 && (world.cells[attacker.reserveY * 100 + attacker.reserveX] & 0x4000) !== 0);

if (failed) process.exit(1);
console.log("all invasion lifecycle checks passed (synthetic fixture; no original invasion comparison)");
