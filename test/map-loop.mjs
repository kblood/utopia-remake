// Deterministic checks of the map main-loop pass scheduler (src/game/main-loop.ts) and its wiring: 4 video updates
// per pass, day timer per video update, animation / objects / input once per pass. Run after `npm run build`.
// Part 1 needs no game data. Parts 2-4 use the user's own Disk.1 / Disk.2 in original/utopia-whdload and are skipped
// when missing. These tests pin the REMAKE's configured cadence (the measured baseline of 4 video frames per pass,
// notes/formats/map-rendering.md "Main-loop timing"); they do not re-measure the original, and the original's
// pointer-dependent 5-frame passes are not modelled.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { MainLoop, DEFAULT_VBL_PER_PASS } = await import("../dist/game/main-loop.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- 1. MainLoop: cadence only ------------------------------------------------------------------------------------
{
  check("default is 4 video updates per pass", DEFAULT_VBL_PER_PASS === 4 && new MainLoop().vblPerPass === 4);
  const loop = new MainLoop();
  const due = [];
  for (let i = 1; i <= 16; i++) if (loop.vbl()) due.push(i);
  check("a pass completes on updates 4, 8, 12, 16 (none on the first three)", due.join() === "4,8,12,16", due.join());
  check("counters: 16 video updates, 4 passes", loop.vbls === 16 && loop.passes === 4);
  const five = new MainLoop(5);
  let n = 0;
  for (let i = 0; i < 20; i++) if (five.vbl()) n++;
  check("the length is configurable (5 gives 4 passes in 20 updates)", n === 4 && five.passes === 4);
  let threw = 0;
  for (const bad of [0, -1, 2.5, Number.NaN]) {
    try { new MainLoop(bad); } catch { threw++; }
  }
  check("invalid lengths are refused", threw === 4);

  const first = new MainLoop();
  first.resumeWithImmediatePass();
  check("immediate return-to-loop pass is consumed before any VBL", first.runImmediatePass() && first.passes === 1 && first.vbls === 0 && first.updatesIntoPass === 0 && !first.immediatePassPending);
  check("the first VBL follows the immediate pass and counts toward the next cadence", !first.vbl() && first.vbls === 1 && first.updatesIntoPass === 1);
  let resumedAt = -1;
  for (let i = 2; i <= 4; i++) if (first.vbl()) resumedAt = i;
  check("the next scheduled pass follows four VBLs after the immediate pass", resumedAt === 4 && first.passes === 2);
}

const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(disk1Path) || !fs.existsSync(disk2Path)) {
  console.log("map-loop game-data checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
} else {
  const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
  const { loadSprites } = await import("../dist/data/sprites.js");
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const { GameState, A, PERIOD } = await import("../dist/game/state.js");
  const { World } = await import("../dist/game/world.js");
  const { Sim } = await import("../dist/game/sim.js");
  const { createRng } = await import("../dist/game/sim-math.js");
  const { MapScene } = await import("../dist/game/map.js");
  const { restoreMapBackground } = await import("../dist/game/map-background.js");
  const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
  const { Screen } = await import("../dist/gfx/screen.js");
  const { ObjectLayer } = await import("../dist/game/objects.js");
  const { UNIT_BASIC } = await import("../dist/game/units.js");

  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const record = readScenarioRecords(disk2)[0];
  const cellsOf = () => loadMap(disk2, record);
  const newWorld = () => new World(new GameState(disk2, record.block), cellsOf());

  // ---- 2. Sim: VBL countdown and loop-pass consumption ------------------------------------------------------------
  {
    const world = newWorld();
    const s = world.state;
    const sim = new Sim(world, { rng: createRng(1) });
    s.setByte(A.frameCountdown, 90);
    s.setByte(A.pending, 0);
    const date0 = s.dateText();
    for (let i = 0; i < 89; i++) sim.countFrame();
    check("countFrame: one decrement per call, no day yet after 89", s.byte(A.frameCountdown) === 1 && !sim.dayQueued && s.dateText() === date0);
    sim.countFrame();
    check("countFrame: the 90th reloads the timer and queues the day while preserving the earlier gun latch", s.byte(A.frameCountdown) === 90 && sim.dayQueued && s.dateText() === date0 && (s.byte(A.pending) & 0x10) !== 0);
    sim.loopPass();
    check("loopPass: consumes the queued day (date advances once, queue empty)", !sim.dayQueued && s.dateText() !== date0);
    const date1 = s.dateText();
    sim.loopPass();
    sim.loopPass();
    check("loopPass: with nothing queued the date does not move", s.dateText() === date1);

    // paused: the timer is frozen and an expiry cannot happen
    s.setByte(A.frameCountdown, 40);
    sim.paused = true;
    for (let i = 0; i < 25; i++) sim.countFrame();
    check("paused: countdown frozen (observed: $14590 does not move)", s.byte(A.frameCountdown) === 40 && !sim.dayQueued);
    sim.paused = false;
    sim.countFrame();
    check("resume: the countdown continues from where it froze", s.byte(A.frameCountdown) === 39);

    // `$4D1C` calls `$564A` without a pause check; `$99C4` then leaves the resulting period bits pending until resume.
    s.setByte(A.frameCountdown, 1);
    sim.countFrame();
    check("expiry queues the day", sim.dayQueued);
    const date2 = s.dateText();
    sim.paused = true;
    sim.loopPass();
    check("paused pass consumes the queued calendar day but defers periodic work", !sim.dayQueued && s.dateText() !== date2 && (s.byte(A.pending) & PERIOD.daily) !== 0);
    const pausedDate = s.dateText();
    sim.paused = false;
    sim.loopPass();
    check("first unpaused pass drains the pending daily work without ticking the date twice", !sim.dayQueued && s.dateText() === pausedDate && (s.byte(A.pending) & PERIOD.daily) === 0);

    // daily work runs in the pass that consumed the day, not before
    const w2 = newWorld();
    const sim2 = new Sim(w2, { rng: createRng(2) });
    const s2 = w2.state;
    s2.setByte(A.frameCountdown, 1);
    s2.setByte(A.pending, 0);
    let days = 0;
    sim2.bindRuntimeHooks({ onDay: () => days++ });
    sim2.countFrame();
    check("the daily hook has not run at expiry", days === 0);
    sim2.loopPass();
    check("the daily hook runs once in the consuming pass", days === 1 && (s2.byte(A.pending) & PERIOD.daily) === 0);

    // legacy combined form for headless callers
    const w3 = newWorld();
    const sim3 = new Sim(w3, { rng: createRng(3) });
    w3.state.setByte(A.frameCountdown, 1);
    const d3 = w3.state.dateText();
    sim3.tick();
    check("Sim.tick() still advances countdown, day and daily work in one call", w3.state.dateText() !== d3 && !sim3.dayQueued);
  }

  const sprites = loadSprites(disk1, disk2, record);
  const mapTiles = loadTileSet(disk1, disk2, record).tiles;

  // ---- 3. ObjectLayer: one pass per update(), pass clock also while paused ----------------------------------------
  {
    const cells = new Uint16Array(100 * 75).fill(1);
    const layer = new ObjectLayer(sprites, [], cells, () => {});
    layer.spawnEffect(0x12, 50, 40);
    layer.update();
    check("ObjectLayer.update() is one pass: the effect counter drops by one and $144C9 advances", layer.effects[0].frame === 3 && layer.units.clock.sub === 1);

    const paused = new ObjectLayer(sprites, [], cells, () => {});
    const tank = paused.units.spawn(UNIT_BASIC, 40, 30, 0);
    paused.units.order(tank, 60, 30);
    paused.spawnEffect(0x12, 50, 40);
    paused.paused = true;
    for (let i = 0; i < 20; i++) paused.update();
    check("paused: $144C9 still advances once per pass (20 passes -> 2 mod 9)", paused.units.clock.sub === 2);
    check("paused: units and effects remain still (matches Disk.1 $333A pause gates)", tank.x === 40 && tank.y === 30 && tank.dx === 0 && tank.dy === 0 && paused.effects[0].frame === 4);
    paused.paused = false;
    paused.update();
    check("unpaused: effects count again", paused.effects[0].frame === 3 && paused.units.clock.sub === 3);
  }

  {
    const flatId = mapTiles.findIndex((tile) => tile.rows <= 16) + 1;
    const makeLayer = (withNeighbour) => {
      const cells = new Uint16Array(100 * 75).fill(flatId);
      const layer = new ObjectLayer(sprites, mapTiles, cells, () => {});
      if (withNeighbour) {
        const tank = layer.units.spawn(UNIT_BASIC, 48, 33, 1); // view cell (1,0), facing 1 repaints (+1,0)
        tank.dx = 1; // any non-zero sub-cell offset activates the neighbour redraw
      }
      return layer;
    };
    const phaseFor = (layer) => {
      const phase = { value: 0 };
      layer.drawMap(new Screen(), 47, 33, { vx: 2, vy: 0, phase });
      return phase.value;
    };
    const unclaimedPhase = phaseFor(makeLayer(false));
    const claimedPhase = phaseFor(makeLayer(true));
    check("hover on a neighbour-repainted cell does not toggle the selection blink bit", claimedPhase === 0 && unclaimedPhase === 1, `claimed=${claimedPhase} unclaimed=${unclaimedPhase}`);
  }

  // ---- 4. MapScene: the wiring ------------------------------------------------------------------------------------
  {
    const tiles = loadTileSet(disk1, disk2, record).tiles;
    const strings = new GameStrings(disk1, 0);
    const scene = () => {
      const m = new MapScene(disk1, tiles, newWorld(), strings, { sprites });
      m.world.state.setByte(A.frameCountdown, 90); // a known timer phase; no day change within the first passes
      m.world.state.setByte(A.pending, 0);
      return m;
    };
    const idle = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
    const ticks = (m, n, input = idle) => { for (let i = 0; i < n; i++) m.update(input); };
    const ID = 0x3ff; // TILE_ID_MASK is 0x3FF (ids are 1-based)
    const FLAG = 0x400;

    {
      const m = scene();
      const picture = decodePicture(disk1, PICTURES.main).pixels;
      const restored = restoreMapBackground(picture);
      m.update(idle);
      // Search for a pixel changed by the restore and not covered by later scene drawing.
      let index = -1;
      for (let at = 0; at < restored.length; at++) if (picture[at] !== restored[at] && m.screen.pixels[at] === restored[at]) { index = at; break; }
      check("MapScene displays a background pixel changed by the traced restore", index >= 0, index >= 0 ? `at (${index % 320},${Math.floor(index / 320)})` : "no uncovered changed pixel found");
    }

    {
      // `$6568-$658E`: `$156A9` bit 1 starts set, so the first matched draw is normal, then cursor, then normal.
      const at = 33 * 100 + 47;
      const hover = { ...idle, pointerX: 120, pointerY: 30 }; // first view cell (0,0), within `$5E58` rectangle 0
      const normal = scene();
      normal.world.cells[at] = 1;
      const highlighted = scene();
      highlighted.world.cells[at] = 1;
      const cursorTile = scene();
      cursorTile.world.cells[at] = 59; // descriptor index 58 ($1D0 / 8)
      const ticks = (m, input) => { for (let i = 0; i < 4; i++) m.update(input); };
      ticks(normal, idle);
      ticks(cursorTile, idle);
      ticks(highlighted, hover);
      const equalPixels = (a, b) => a.length === b.length && a.every((pixel, i) => pixel === b[i]);
      check("first hovered redraw uses the normal tile from initial $156A9 bit 1", equalPixels(highlighted.screen.pixels, normal.screen.pixels));
      check("map pointer state selects the cell-hover graphic only while a cell is under the pointer", highlighted.pointerUsesCellHover && !normal.pointerUsesCellHover);
      ticks(highlighted, hover);
      check("second hovered redraw substitutes cursor descriptor 58", equalPixels(highlighted.screen.pixels, cursorTile.screen.pixels));
      ticks(highlighted, hover);
      check("third hovered redraw returns to the normal map tile", equalPixels(highlighted.screen.pixels, normal.screen.pixels));
    }

    {
      const m = scene();
      check("scenario 0 starts at view 47,33 and loop length 4", m.scrollX === 47 && m.scrollY === 33 && m.loop.vblPerPass === 4);
      const at = 33 * 100 + 47;
      m.world.cells[at] = (m.world.cells[at] & ~ID) | FLAG | 1; // animated cell 1 in the window's first cell
      const id = () => m.world.cells[at] & ID;
      const seen = [];
      for (let i = 1; i <= 12; i++) {
        m.update(idle);
        seen.push(id());
      }
      check("cell animation: one step per pass (updates 4, 8, 12), not before", seen.join() === "1,1,1,2,2,2,2,3,3,3,3,1", seen.join());
    }

    {
      const m = scene();
      const s = m.world.state;
      s.setByte(A.frameCountdown, 90);
      ticks(m, 4);
      check("frame timer: one decrement per video update (4 updates = 1 pass = -4)", s.byte(A.frameCountdown) === 86);
      ticks(m, 1);
      check("frame timer: not tied to passes (a fifth update still counts)", s.byte(A.frameCountdown) === 85);
    }

    {
      const m = scene();
      m.objects.spawnEffect(0x12, 50, 40);
      const frame = () => m.objects.effects[0].frame;
      const sub0 = m.objects.units.clock.sub;
      const seen = [];
      for (let i = 1; i <= 8; i++) {
        m.update(idle);
        seen.push(`${frame()}/${m.objects.units.clock.sub - sub0}`);
      }
      check("objects: effects and $144C9 step once per pass", seen.join() === "4/0,4/0,4/0,3/1,3/1,3/1,3/1,2/2", seen.join());
    }

    {
      const m = scene();
      const down = { leftButton: true, rightButton: false, pointerX: 272, pointerY: 63, keys: [] };
      ticks(m, 4, down); // the press only flips the button ($5756); the release in the next normal pass opens the menu ($15A74)
      check("build command press does not open the menu yet", !m.controls.menuVisible);
      ticks(m, 4, idle);
      check("build menu opens from the build command", m.controls.menuVisible);
      check("build-menu modal state selects the arrow pointer instead of the cell-hover graphic", !m.pointerUsesCellHover);
      const sub = m.objects.units.clock.sub;
      m.world.state.setByte(A.frameCountdown, 20);
      m.world.state.setByte(A.pending, m.world.state.byte(A.pending) | 0x10);
      m.objects.spawnEffect(0x12, 50, 40);
      ticks(m, 100, idle);
      check("modal build menu freezes simulation passes, unit clock and effects", m.objects.units.clock.sub === sub && m.objects.effects[0].frame === 4);
      check("modal build menu freezes countdown and preserves an unconsumed gun latch", m.world.state.byte(A.frameCountdown) === 20 && (m.world.state.byte(A.pending) & 0x10) !== 0);
      ticks(m, 4, { ...down, pointerX: 272, pointerY: 139 }); // menu exit command button 9, polled by the modal pass
      check("menu exit press alone keeps the modal loop ($B3F2-$B40C acts on the release)", m.controls.menuVisible && m.objects.units.clock.sub === sub);
      ticks(m, 1, idle); // the release is polled by one modal update ($B3F2-$B40C); this update is modalAtStart, so it runs no pass
      check("menu exit leaves the modal loop without advancing a pass on the exit click", !m.controls.menuVisible && m.objects.units.clock.sub === sub && m.objects.effects[0].frame === 4);
      ticks(m, 1, idle); // the return to $157BC queued an immediate pass: it runs on the very next browser update
      check("the main-loop pass resumes after leaving the build menu", m.objects.units.clock.sub === (sub + 1) % 9 && m.objects.effects[0].frame === 3);
    }

    {
      const m = scene();
      const s = m.world.state;
      s.setByte(A.frameCountdown, 2);
      const date0 = s.dateText();
      m.update(idle);
      m.update(idle); // the timer runs out here
      check("pending day: expiry on update 2 does not change the date", s.dateText() === date0 && s.byte(A.frameCountdown) === 90);
      m.update(idle);
      check("pending day: still not on update 3", s.dateText() === date0);
      m.update(idle); // pass
      check("pending day: consumed on the next loop pass (update 4)", s.dateText() !== date0);
    }

    {
      const m = scene();
      const s = m.world.state;
      s.setByte(A.frameCountdown, 90);
      const date0 = s.dateText();
      ticks(m, 3);
      m.update({ ...idle, keys: [" "] }); // the pass polls the pause key
      check("pause key is polled at the pass and freezes the VBL countdown from then on", m.sim.paused && s.byte(A.frameCountdown) === 86);
      const sub0 = m.objects.units.clock.sub;
      m.objects.spawnEffect(0x12, 50, 40);
      ticks(m, 12);
      check("paused 12 updates (3 passes): countdown frozen, date unchanged", s.byte(A.frameCountdown) === 86 && s.dateText() === date0);
      check("paused: $144C9 still advances once per pass", (m.objects.units.clock.sub - sub0 + 9) % 9 === 3, `${m.objects.units.clock.sub - sub0}`);
      check("paused: effects do not count down", m.objects.effects[0].frame === 4);
      ticks(m, 3);
      m.update({ ...idle, keys: [" "] }); // resume key, polled at this pass
      check("resume key polled at its pass: the VBL countdown is still frozen until then", !m.sim.paused && s.byte(A.frameCountdown) === 86);
      ticks(m, 2);
      check("after resume the countdown runs again", s.byte(A.frameCountdown) === 84);
    }

    {
      const m = scene();
      const s = m.world.state;
      s.setByte(A.pending, 0);
      m.sim.dayQueued = true; // a day expired before the user paused
      m.sim.paused = true;
      const before = s.dateText();
      ticks(m, 4);
      check("paused MapScene pass consumes an already queued day", !m.sim.dayQueued && s.dateText() !== before);
      check("paused MapScene pass leaves the resulting daily work pending until resume", (s.byte(A.pending) & PERIOD.daily) !== 0);
    }

    {
      // The VBL handler latches `$144C1` bit 4 at exact countdown `$2D`; `$99C4` consumes it at a pass.
      const gunScene = (countdown) => {
        const m = scene();
        const shots = [];
        m.enemies.fireGuns = (tile) => shots.push(tile);
        m.world.state.setByte(A.frameCountdown, countdown);
        return { m, shots, s: m.world.state };
      };

      {
        const { m, shots, s } = gunScene(0x30);
        ticks(m, 3);
        check("gun A: VBL reaching $2D sets the pending special bit without firing", s.byte(A.frameCountdown) === 0x2d && (s.byte(A.pending) & 0x10) !== 0 && shots.length === 0);
        ticks(m, 1);
        check("gun A: the next pass consumes the latch and fires exactly once", s.byte(A.frameCountdown) === 0x2c && shots.join() === "31", shots.join());
        ticks(m, 8);
        check("gun A: later passes without a crossing do not fire again", shots.length === 1);
      }

      {
        const { m, shots, s } = gunScene(2);
        const date0 = s.dateText();
        ticks(m, 3); // the timer runs out on update 2 and only queues the day
        check("day gun: rollover queues the day without firing before its pass", shots.length === 0 && s.dateText() === date0);
        ticks(m, 1);
        check("day gun: gun B fires at the pass that consumes the day, once, and not gun A", shots.join() === "15" && s.dateText() !== date0, shots.join());
        ticks(m, 8);
        check("day gun: no second round without another rollover", shots.length === 1);
      }

      {
        const { m, shots, s } = gunScene(0x2d);
        ticks(m, 4);
        check("restored countdown below $2D does not synthesize a gun A latch", s.byte(A.frameCountdown) === 0x29 && shots.length === 0);
      }

      {
        const { m, shots, s } = gunScene(0x30);
        m.sim.paused = true;
        s.setByte(A.frameCountdown, 0x2d);
        ticks(m, 8);
        check("paused VBL at $2D latches gun A but pass does not consume it", s.byte(A.frameCountdown) === 0x2d && (s.byte(A.pending) & 0x10) !== 0 && shots.length === 0);
        m.sim.paused = false;
        ticks(m, 4);
        check("after resume the saved latch fires at the next pass", shots.join() === "31", shots.join());
      }
    }

    {
      // Held scroll arrow x+ (rect x 240-261, y 136-146): one scroll at EVERY poll, the first one immediately.
      const m = scene();
      const held = { ...idle, leftButton: true, pointerX: 250, pointerY: 141 };
      const xs = [];
      for (let i = 1; i <= 12; i++) {
        m.update(held);
        xs.push(m.scrollX);
      }
      check("held arrow: scrolls at the first poll with no delay, then once per pass", xs.join() === "47,47,47,48,48,48,48,49,49,49,49,50", xs.join());
      ticks(m, 8);
      check("released: no more scrolling", m.scrollX === 50 && m.scrollY === 33);
    }

    {
      // The first poll after a press scrolls at once, wherever in the pass cycle the press lands.
      const m = scene();
      ticks(m, 2);
      const held = { ...idle, leftButton: true, pointerX: 250, pointerY: 141 };
      m.update(held);
      m.update(held); // update 4: pass
      check("held arrow pressed mid-cycle: first pass scrolls once", m.scrollX === 48);
    }

    {
      // Deliberate browser deviation: a press shorter than a pass is still seen at the next poll (once).
      const m = scene();
      const down = { ...idle, leftButton: true, pointerX: 250, pointerY: 141 };
      const up = { ...down, leftButton: false }; // the pointer stays on the arrow
      m.update(up);
      m.update(down);
      m.update(up);
      m.update(up); // pass: the button is up now but was down since the last poll
      check("sub-pass click is latched and scrolls once at the next poll", m.scrollX === 48);
      ticks(m, 4, up);
      check("the latch is cleared by the poll (no second scroll)", m.scrollX === 48);
    }

    {
      // The first draw of a scene is not a tick, and map-cell animation and the countdown start at zero progress.
      const m = scene();
      check("fresh scene: no pass has run", m.loop.passes === 0 && m.loop.vbls === 0);
    }
  }
}

if (failed) {
  console.log(`${failed} map-loop check(s) failed`);
  process.exit(1);
}
console.log("all map-loop checks passed");
