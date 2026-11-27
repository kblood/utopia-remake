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
const { Controls } = await import("../dist/game/controls.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");

const disk1 = new Uint8Array(fs.readFileSync(d1));
const disk2 = new Uint8Array(fs.readFileSync(d2));
const rec = readScenarioRecords(disk2)[0];

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// Fresh-start capture inputs must reach `$6D78` before it allocates any solar-building records.
{
  const solarMap = loadMap(disk2, rec);
  solarMap[0] = 0x0f; // add one valid solar building to exercise the callback; shipped scenario 0 has none
  const reference = new World(new GameState(disk2, rec.block), solarMap);
  const solarSlots = (w) => {
    const found = [];
    for (let at = 0; at < w.objects.length; at += 8) {
      const tile = (w.objects[at] << 8) | w.objects[at + 1];
      if (tile === 0x0f || tile === 0x1f) found.push(w.objects[at + 6]);
    }
    return found;
  };
  const expectedCount = solarSlots(reference).length;
  const tape = [];
  const seed = 0x13579bdf;
  const driven = new World(new GameState(disk2, rec.block), solarMap, {
    solarPhaseSeed: seed,
    startupSolarPhase: () => { const phase = tape.length % 2 === 0; tape.push(phase); return phase; },
  });
  const actual = solarSlots(driven);
  check("fresh-world solar-phase tape is consumed during buildObjects before play", expectedCount > 0 && tape.length === expectedCount && actual.length === expectedCount && actual.every((v, i) => v === (i % 2 === 0 ? 0xff : 1)), `solar records ${expectedCount}, tape calls ${tape.length}`);
  check("solar-phase input is separate from its restorable RNG stream", driven.solarPhaseRngState === seed);
}

const world = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
const messages = [];
const builder = new Builder(world, readFlagTable(disk1), readWeights(disk1), (m) => messages.push(m));
const sim = new Sim(world, { onWeek: () => builder.weekly() });
const s = world.state;

// `$72C0` uses `$142C2` as a DBRA budget over non-empty records. A sparse
// record beyond the count is not visible to this lookup.
{
  const savedObjects = world.objects.slice();
  const savedCount = s.word(0x142c2);
  const cellIndex = 35 * 100 + 54;
  const savedCell = world.cells[cellIndex];
  world.objects.fill(0);
  world.objects.set([0x00, 0x10, 0, 0, 10, 10, 0, 0, 0x00, 0x11, 0, 0, 11, 10, 0, 0], 0);
  world.objects.set([0x00, 0x1f, 0, 0xff, 54, 35, 0, 0], 20 * 8);
  world.cells[cellIndex] = 0x22;
  s.setWord(0x142c2, 2);
  check("demolition lookup ignores occupied records beyond the $142C2 budget", builder.findObject(54, 35) === -1);
  s.setWord(0x142c2, 3);
  check("demolition lookup reaches a sparse record when it is inside the $142C2 budget", builder.findObject(54, 35) === 20 * 8);
  world.objects.set(savedObjects);
  world.cells[cellIndex] = savedCell;
  s.setWord(0x142c2, savedCount);
}

// Static UI mapping: page 2 list slot 5 is tank yard tile $45 and its `$E9E2` hitbox is x=16..47/y=100..130.
{
  const said = [];
  const controls = new Controls(disk1, world, builder, new GameStrings(disk1, 0), (n) => said.push(n), () => ({ x: 47, y: 33 }));
  const clickSounds = [];
  controls.onClick = () => clickSounds.push(4);
  const update = (leftButton, x, y) => controls.update({ leftButton, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  const press = (x, y) => update(true, x, y);
  const release = (x, y) => update(false, x, y);
  const click = (x, y) => {
    press(x, y);
    release(x, y);
  };
  s.setLong(0x135ba, 500000);
  press(272, 63); // build command: `$5756` clicks on the press, `$15A74` opens the menu only on the release
  check("build button press requests click sound 4 but the menu opens only on release ($15A74)", !controls.menuVisible && controls.mode === "select" && clickSounds.join() === "4");
  release(272, 63);
  check("build button release opens the menu without another click", controls.menuVisible && clickSounds.join() === "4");
  press(272, 63); // menu command-column button 0 is blank but still follows $B438 -> $5756
  check("blank build-menu command button requests click sound and leaves the menu open", controls.menuVisible && clickSounds.join() === "4,4");
  press(272, 63); // still held: the button press edge must not repeat
  check("held build-menu command button does not repeat click sound", clickSounds.join() === "4,4");
  release(272, 63);
  check("build-menu button release is silent and does nothing for a blank button", controls.menuVisible && clickSounds.join() === "4,4" && controls.menuState.page === 0);
  press(296, 139); // menu page arrow, command button 8: the page changes only on the release ($B3FA-$B404 -> $B45E)
  check("page arrow press clicks but does not advance the page yet", controls.menuVisible && controls.menuState.page === 0 && clickSounds.join() === "4,4,4");
  release(296, 139);
  check("page arrow release advances the page", controls.menuVisible && controls.menuState.page === 1 && clickSounds.join() === "4,4,4");
  click(31, 115); // center of tile $45 hitbox, index 5
  // Static `$B512-$B624`: an item click keeps the modal menu open, stores the pending item (`$142AA`) and shows its
  // name/price; the exit button (command button 9, `$B406`/`$B628`) then returns it and enters build mode.
  const pick = controls.menuState;
  check("page 2 tank-yard item pick is silent and keeps the menu open", controls.menuVisible && controls.mode === "select" && pick.pending?.tile === 0x45 && pick.page === 1 && clickSounds.join() === "4,4,4");
  check("page 2 tank-yard pick resolves to type-table entry T[22] with price 6000 shown", pick.pending?.type === 22 && world.typeAddress(pick.pending.type) === 0x1336e && pick.detail?.cost === 6000 && pick.detail.affordable === true);
  press(272, 139); // exit button: the press only clicks and flips; the selection is returned on the release ($B3FA-$B40C)
  check("exit button press sounds once but keeps the menu open until released", controls.menuVisible && controls.mode === "select" && clickSounds.join() === "4,4,4,4");
  release(272, 139);
  check("exit button release commits the pending tile $45 into build mode without another click", !controls.menuVisible && controls.mode === "build" && controls.selection?.tile === 0x45 && clickSounds.join() === "4,4,4,4");
  check("page 2 tank-yard selection resolves to type-table entry T[22]", controls.selection?.type === 22 && world.typeAddress(controls.selection.type) === 0x1336e);
  // Static `$6BA2` (Disk.1 $6BA2-$6BD6): after `$6B10`, `moveq #0,d0; bsr $551a` posts string 0 on the message line. The
  // remake used to post the building name (string $1B) here. Item clicks and the commit post exactly one message: string 0.
  check("build-mode commit posts exactly string 0 (the site prompt), not the building name", JSON.stringify(said) === "[0]", JSON.stringify(said));
  check("string 0 reads 'Click on map to choose a site.'", String.fromCharCode(...new GameStrings(disk1, 0).get(0)) === "Click on map to choose a site.");
}

// The pointer position observed in the original run ($161A6/$161A8 = x 25, y 115) is inside the same hitbox {16,47,100,130}.
{
  const controls = new Controls(disk1, world, builder, new GameStrings(disk1, 0), () => {}, () => ({ x: 47, y: 33 }));
  const click = (x, y) => {
    controls.update({ leftButton: true, rightButton: false, pointerX: x, pointerY: y, keys: [] });
    controls.update({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  };
  s.setLong(0x135ba, 500000);
  click(272, 63);
  click(296, 139);
  click(25, 115);
  click(272, 139); // exit button commits the pending item
  check("observed pointer (25,115) on page 2 selects tile $45 / T[22]", !controls.menuVisible && controls.mode === "build" && controls.selection?.tile === 0x45 && controls.selection.type === 22);
}

// Unaffordable pick (`$B57E`): menu stays open, pending cleared, "can't afford" detail; exit with nothing pending
// returns to select mode (`$6BA2` -> `$15EF0`).
{
  const controls = new Controls(disk1, world, builder, new GameStrings(disk1, 0), () => {}, () => ({ x: 47, y: 33 }));
  const click = (x, y) => {
    controls.update({ leftButton: true, rightButton: false, pointerX: x, pointerY: y, keys: [] });
    controls.update({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  };
  s.setLong(0x135ba, 100); // below every price
  click(272, 63);
  click(296, 139);
  click(25, 115);
  const st = controls.menuState;
  check("unaffordable pick keeps the menu open, clears the pending item and flags the detail", controls.menuVisible && st.pending === null && st.detail?.affordable === false && st.detail.cost === 6000);
  click(272, 139);
  check("exit with nothing pending leaves select mode with no selection", !controls.menuVisible && controls.mode === "select" && controls.selection === null);
  s.setLong(0x135ba, 500000);
}

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

// --- 2 x 2 demolition and site cancellation write one cleared id into every footprint cell ($74D6 / $752C -> $6FC4).
// Completion ($703A -> $6A8C) and the Command Centre redraw ($7342 -> $6A8C) still write tile+0..+3 (static, Disk.1).
{
  const w2 = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
  const b2 = new Builder(w2, readFlagTable(disk1), readWeights(disk1), () => {});
  const st = w2.state;
  // First type with a 2 x 2 footprint (byte +1 = 4) in scenario 0, read from the table rather than hard-coded.
  let big = -1;
  for (let i = 0; i < 34 && big < 0; i++) if (st.byte(w2.typeAddress(i) + 1) === 4) big = i;
  const row = w2.typeAddress(big);
  const tile = st.word(row + 8);
  const cells = (x, y) => [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([cx, cy]) => w2.cell(cx, cy) & 0x3ff);
  const freeSlot = () => { for (let i = 0; i < w2.objects.length; i += 8) if (w2.objects[i] === 0 && w2.objects[i + 1] === 0) return i; return -1; };
  const sx = 20, sy = 20;
  // Hand-built completed record of the 2 x 2 type at (sx, sy): the same bytes $703A leaves (tile, footprint, +3 = online flag 0).
  {
    const slot = freeSlot();
    w2.objects[slot] = tile >> 8;
    w2.objects[slot + 1] = tile & 0xff;
    w2.objects[slot + 3] = 0;
    w2.objects[slot + 4] = sx;
    w2.objects[slot + 5] = sy;
    st.setWord(row + 0x0a, 1);
    st.setWord(row + 0x0c, 1);
    st.setWord(0x142c2, st.word(0x142c2) + 1);
    b2.construction.writeTiles(tile, sx, sy, 4);
    check("2x2 setup: completed building writes tile..tile+3 (the $6A8C pattern)", cells(sx, sy).join() === [tile, tile + 1, tile + 2, tile + 3].map((v) => v & 0x3ff).join(), `${cells(sx, sy)}`);
    check("2x2 demolition: the building is found and removed", b2.demolish(sx, sy) === true);
    check("2x2 demolition: every footprint cell becomes the cleared tile $38 (not $38..$3B)", cells(sx, sy).every((c) => c === 0x38), `${cells(sx, sy)}`);
  }
  {
    // A construction site of the same type: $6FC4 wrote tile $32 into all four cells; cancelling writes $38 the same way.
    const slot = freeSlot();
    const cx = 30, cy = 30;
    w2.objects[slot] = 0x00;
    w2.objects[slot + 1] = 0x32;
    w2.objects[slot + 2] = tile >> 8;
    w2.objects[slot + 3] = tile & 0xff;
    w2.objects[slot + 4] = cx;
    w2.objects[slot + 5] = cy;
    st.setWord(0x142c2, st.word(0x142c2) + 1);
    st.setWord(0x142c4, st.word(0x142c4) + 1);
    b2.construction.markSite(0x32, cx, cy, 4);
    check("2x2 site: all four cells carry the site tile $32", cells(cx, cy).every((c) => c === 0x32), `${cells(cx, cy)}`);
    check("2x2 site cancel: demolishing the site clears it", b2.demolish(cx, cy) === true && st.word(0x142c4) === 0);
    check("2x2 site cancel: every footprint cell becomes $38 (not $38..$3B)", cells(cx, cy).every((c) => c === 0x38), `${cells(cx, cy)}`);
  }
  {
    // Command Centre redraw ($7342): online tiles $4C..$4F through $6A8C, four distinct ids (unchanged by this slice).
    const slot = freeSlot();
    w2.objects[slot] = 0x00;
    w2.objects[slot + 1] = 0x4c;
    w2.objects[slot + 3] = 0xff;
    w2.objects[slot + 4] = 40;
    w2.objects[slot + 5] = 40;
    b2.construction.redrawCentre(slot);
    check("Command Centre redraw still writes $4C..$4F through the +n pattern", cells(40, 40).join() === [0x4c, 0x4d, 0x4e, 0x4f].join(), `${cells(40, 40)}`);
  }
}

// --- tank yard (tile $45 / T[22]): staged checks of the observed trace, notes/formats/building.md (2026-11-06) ----------
// One observed scenario of unidentified index, so the preconditions below are set by hand (money 506030, no builders,
// plenty of free colonists, no warning bits) rather than taken from a scenario. Footprint cells, calendar timing of the
// original completion and the scenario's other state are deliberately not asserted.
{
  // The type row is the same in every Disk.2 scenario block (static observation in building.md).
  const rows = readScenarioRecords(disk2).map((r) => {
    const g = new GameState(disk2, r.block);
    const w = new World(g, loadMap(disk2, r));
    const row = w.typeAddress(w.findType(0x45));
    return { type: w.findType(0x45), row, cost: g.word(row + 6), weeks: g.byte(row + 2), builders: g.byte(row + 4), tile: g.word(row + 8) };
  });
  check("tank yard: tile $45 is T[22] at $1336E in every Disk.2 scenario block", rows.every((r) => r.type === 22 && r.row === 0x1336e && r.tile === 0x45), JSON.stringify(rows[0]));
  check("tank yard: T[22] cost 6000, weeks 6, colonists needed 20 in every Disk.2 scenario block", rows.every((r) => r.cost === 6000 && r.weeks === 6 && r.builders === 20));
}
{
  const w = new World(new GameState(disk2, rec.block), loadMap(disk2, rec));
  const st = w.state;
  const said = [];
  const b = new Builder(w, readFlagTable(disk1), readWeights(disk1), (m) => said.push(m));
  const type = w.findType(0x45);
  let yx = null;
  let yy = null;
  const centre = [];
  for (let i = 0; i < w.objects.length; i += 8) if (((w.objects[i] << 8) | w.objects[i + 1]) === 0x4c) centre.push([w.objects[i + 4], w.objects[i + 5]]);
  const open = (x, y) => (w.cell(x, y) & 0x5400) === 0;
  find: for (let r = 2; r < 12 && centre.length === 1; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = centre[0][0] + dx;
      const y = centre[0][1] + dy;
      if (open(x, y) && open(x + 1, y) && open(x, y + 1) && open(x + 1, y + 1)) { yx = x; yy = y; break find; }
    }
  }
  check("tank yard: found a free spot near the command centre", yx !== null, JSON.stringify([yx, yy]));

  // Hand-set preconditions of the observed placement: money 506030, expenditure 0, no builders, enough colonists.
  st.setLong(0x135ba, 506030);
  st.setLong(0x142ca, 0);
  st.setLong(0x1432a, 0);
  st.setLong(0x13136, 100);
  st.setByte(0x144b1, 0);
  const objects0 = st.word(0x142c2);
  const sites0 = st.word(0x142c4);
  const spentLast0 = st.long(0x135b6);
  const placed = b.place({ tile: 0x45, type }, yx, yy);
  check("tank yard: placement succeeds", placed === true, JSON.stringify(said));
  check("tank yard: charge is 6000 (money 506030 -> 500030)", st.signedLong(0x135ba) === 500030);
  check("tank yard: current expenditure $142CA 0 -> 6000, spent-last-month $135B6 untouched", st.long(0x142ca) === 6000 && st.long(0x135b6) === spentLast0);
  check("tank yard: 20 builders reserved from the free colonists", st.long(0x1432a) === 20 && st.long(0x13136) === 80);
  let slot = -1;
  for (let i = 0; i < w.objects.length; i += 8) {
    if (((w.objects[i] << 8) | w.objects[i + 1]) === 0x32 && w.objects[i + 4] === yx && w.objects[i + 5] === yy) slot = i;
  }
  check("tank yard: construction record {tile $32, target $45, x, y, weeks 6}", slot >= 0 && ((w.objects[slot + 2] << 8) | w.objects[slot + 3]) === 0x45 && w.objects[slot + 6] === 6,
    slot >= 0 ? JSON.stringify([...w.objects.slice(slot, slot + 8)]) : "no record");
  check("tank yard: site count $142C4 and object count $142C2 each +1", st.word(0x142c4) === sites0 + 1 && st.word(0x142c2) === objects0 + 1);

  // Six weekly countdowns (the construction rule): still a site after five, the finished yard record after six.
  for (let week = 1; week <= 5; week++) b.weekly();
  check("tank yard: still a site with 1 week left after 5 weekly passes", ((w.objects[slot] << 8) | w.objects[slot + 1]) === 0x32 && w.objects[slot + 6] === 1 && st.word(0x142c4) === sites0 + 1);
  b.weekly();
  check("tank yard: record becomes tile $45, active $FF, x/y kept, progress byte 0, site count back", ((w.objects[slot] << 8) | w.objects[slot + 1]) === 0x45 && w.objects[slot + 3] === 0xff &&
    w.objects[slot + 4] === yx && w.objects[slot + 5] === yy && w.objects[slot + 6] === 0 && st.word(0x142c4) === sites0);
  // Port rule, not part of the observation: the builders go back to the free colonists on completion.
  check("tank yard: builders returned on completion (port rule, not observed)", st.long(0x1432a) === 0 && st.long(0x13136) === 100);
}

if (failed) {
  console.log(`${failed} build check(s) failed`);
  process.exit(1);
}
console.log("all build checks passed");
