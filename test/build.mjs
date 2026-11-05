// Checks of building placement, construction and demolition (src/game/build.ts).
// Uses the user's own copy in original/utopia-whdload; skipped when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("build tests skipped: original data not found");
  process.exit(0);
}

const { readScenarioRecords, loadMap } = await import("../dist/data/scenario.js");
const { GameState, A } = await import("../dist/game/state.js");
const { World } = await import("../dist/game/world.js");
const { Sim } = await import("../dist/game/sim.js");
const { Builder, SITE_TILE } = await import("../dist/game/build.js");
const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const rec = readScenarioRecords(disk2)[0];

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const world = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
const messages = [];
const builder = new Builder(world, readFlagTable(disk1), readWeights(disk1), (m) => messages.push(m));
const sim = new Sim(world, { onWeek: () => builder.weekly() });
const s = world.state;

// Find an empty cell next to the starting base to build on.
let spot = null;
const base = [];
for (let i = 0; i < world.objects.length; i += 8) {
  const tile = (world.objects[i] << 8) | world.objects[i + 1];
  if (tile === 0x4c) base.push([world.objects[i + 4], world.objects[i + 5]]);
}
check("scenario has a command centre", base.length === 1);
const free = (x, y) => (world.cell(x, y) & 0x5400) === 0;
search: for (let r = 2; r < 12; r++) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = base[0][0] + dx, y = base[0][1] + dy;
    if (free(x, y) && free(x + 1, y) && free(x, y + 1) && free(x + 1, y + 1)) { spot = [x, y]; break search; }
  }
}
check("found a free 2x2 spot", spot !== null, JSON.stringify(spot));

const type = world.findType(0x47); // housing, 50 people
const sel = { tile: 0x47, type };
const t = world.typeAddress(type);
const money0 = s.long(A.money);
const free0 = s.long(0x13136);
const total0 = s.word(t + 0x0c);
const ok = builder.place(sel, spot[0], spot[1]);
check("placing succeeds", ok, JSON.stringify(messages));
check("site tile written", (world.cell(spot[0], spot[1]) & 0x3ff) === SITE_TILE);
check("money charged", money0 - s.long(A.money) === s.word(t + 6), `${money0 - s.long(A.money)}`);
check("workers taken", free0 - s.long(0x13136) === s.byte(t + 4));
check("occupied cell refused", builder.place(sel, spot[0], spot[1]) === false);

const weeks = s.byte(t + 2);
for (let w = 0; w < weeks; w++) builder.weekly();
check("building completes after build time", (world.cell(spot[0], spot[1]) & 0x3ff) === 0x47, `cell ${(world.cell(spot[0], spot[1]) & 0x3ff).toString(16)}`);
check("workers returned", s.long(0x13136) === free0);
check("count increased", s.word(t + 0x0c) === total0 + 1);

check("demolish works", builder.demolish(spot[0], spot[1]) === true);
check("cell cleared", (world.cell(spot[0], spot[1]) & 0x3ff) === 0x38);
check("count back", s.word(t + 0x0c) === total0);

for (let i = 0; i < 3 * 28 * 90; i++) sim.tick();
check("simulation still runs", Number.isFinite(s.long(A.money)));

if (failed) {
  console.log(`${failed} build check(s) failed`);
  process.exit(1);
}
console.log("all build checks passed");
