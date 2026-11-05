// Round trip of the save format (src/game/save.ts) with a stand-in for localStorage.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d2)) {
  console.log("save tests skipped: original data not found");
  process.exit(0);
}
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { captureGame, applyGame, writeSlot, readSlot, slotSummaries } = await import("../dist/game/save.js");

const disk2 = new Uint8Array(fs.readFileSync(d2));
const rec = readScenarioRecords(disk2)[2];
const make = () => {
  const world = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
  return { world, sim: new Sim(world) };
};
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const a = make();
for (let i = 0; i < 2000; i++) a.sim.tick();
check("slot starts empty", slotSummaries()[1] === null);
check("write succeeds", writeSlot(1, captureGame(a.world, a.sim, 2, 40, 30)));
const b = make();
const data = readSlot(1);
check("read returns data", data !== null && data.scenario === 2 && data.scrollX === 40);
applyGame(data, b.world, b.sim);
check("state restored", b.world.state.long(A.money) === a.world.state.long(A.money));
check("cells restored", b.world.cells.every((c, i) => c === a.world.cells[i]));
check("objects restored", b.world.objects.every((c, i) => c === a.world.objects[i]));
check("summary has a date", /^\d\d\/\d\d\/\d{4}$/.test(slotSummaries()[1].date));
if (failed) process.exit(1);
console.log("all save checks passed");
