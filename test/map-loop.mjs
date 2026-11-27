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
      // The press latch ($156A9 bit 0, $1596A and $50BE; mouse-poll.ts): a left press on a scroll arrow sets it, it stays set while
      // the left button is held (also off the arrow), a poll with the left button up clears it, and a press that starts off the
      // arrow and moves onto it does not set it.
      // observeButtons is the latch's update (poll() calls it once per pass, and Game before an F-key window opens); the test drives it directly.
      const m = scene();
      const on = (leftButton, p) => ({ leftButton, rightButton: false, pointerX: p.x, pointerY: p.y, keys: [] });
      const arrow = { x: 250, y: 127 }; // inside the first arrow of ARROWS (x 240-261, y 122-132)
      const away = { x: 20, y: 20 };
      m.observeButtons(on(false, away));
      check("scroll latch: an idle frame leaves it clear", m.pressLatch === false);
      m.observeButtons(on(true, arrow));
      check("scroll latch: a left press on a scroll arrow sets it", m.pressLatch === true);
      m.observeButtons(on(true, away));
      check("scroll latch: it stays set while the left button is held off the arrow", m.pressLatch === true);
      m.observeButtons(on(false, away));
      check("scroll latch: a poll with the left button up clears it", m.pressLatch === false);
      m.observeButtons(on(true, away));
      m.observeButtons(on(true, arrow));
      check("scroll latch: a press that starts off the arrow and moves onto it does not set it", m.pressLatch === false);
      m.observeButtons(on(false, away));
    }
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

      // The exit (`$B628` -> `$58A0`, table `$5DDA`) redraws the ten command buttons from their images: the 16 x 16 ring
      // takes the image's pixels, the interior is the same as the picture's. Independent decode of the image bytes here
      // (5 planes, 16 words per plane, MSB first, Disk.1 image base $1000 at sector $14C; building.md "Right panel, part 2").
      const IMAGE_FILE_BASE = 0x14c * 512 - 0x1000;
      const wordAt = (a) => (disk1[IMAGE_FILE_BASE + a] << 8) | disk1[IMAGE_FILE_BASE + a + 1];
      const longAt = (a) => ((wordAt(a) << 16) | wordAt(a + 2)) >>> 0;
      const indexAt = (base, row, col) => {
        let index = 0;
        for (let p = 0; p < 5; p++) index |= ((wordAt(base + p * 32 + row * 2) >> (15 - col)) & 1) << p;
        return index;
      };
      const BUTTON_X = [272, 296, 272, 296, 272, 296, 272, 296, 296, 272];
      const BUTTON_Y = [63, 63, 82, 82, 101, 101, 120, 120, 139, 139];
      const imageMismatches = (screen) => {
        let n = 0;
        for (let i = 0; i < 10; i++) {
          const base = longAt(0x5dda + 4 * i);
          for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) if (screen.pixels[(BUTTON_Y[i] + r) * 320 + BUTTON_X[i] + c] !== indexAt(base, r, c)) n++;
        }
        return n;
      };
      check("build-menu exit: the command buttons are drawn from their $5DDA images on the exit frame", imageMismatches(m.screen) === 0, `mismatches ${imageMismatches(m.screen)}`);
      ticks(m, 4, idle);
      check("build-menu exit: the image buttons persist through the next pass", imageMismatches(m.screen) === 0, `mismatches ${imageMismatches(m.screen)}`);
      const plain = scene();
      plain.update(idle);
      check("without a menu exit the column keeps the picture's blank buttons (the image ring differs on 320 pixels)", imageMismatches(plain.screen) === 320, `mismatches ${imageMismatches(plain.screen)}`);
    }

    // Reachability of a latched pause at the build-menu exit (`$B628`): the menu cannot open while paused (the release
    // of the build command takes no action, `$15A74-$15ABC`), and the modal menu reads no key, so the pause cannot change
    // while it is open. The exit therefore never redraws a latched pause button. Remake check (MapScene, no original capture).
    {
      const m = scene();
      const press = { leftButton: true, rightButton: false, pointerX: 272, pointerY: 63, keys: [] };
      ticks(m, 4, { ...idle, keys: [" "] }); // the pause key is polled at the next pass
      check("pause key: the map is paused", m.sim.paused);
      ticks(m, 4, press);
      ticks(m, 4, idle);
      check("paused: the build command's release does not open the menu", !m.controls.menuVisible && m.sim.paused);
      ticks(m, 4, { ...idle, keys: [" "] }); // resume
      check("resumed: the pause key clears the pause", !m.sim.paused);
      ticks(m, 4, press);
      ticks(m, 4, idle);
      check("resumed: the build menu opens", m.controls.menuVisible);
      m.update({ ...idle, keys: ["p"] }); // the modal update drops keys (no key is read in the menu)
      ticks(m, 8, idle);
      check("pause key while the build menu is open changes nothing", m.controls.menuVisible && !m.sim.paused);
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
      // Scroll arrows (STATIC trace, 2026-11-12, no emulator run): `$158CA` -> `$15940` runs on a left press event, and
      // `$1596A` sets the latch only for a press edge that hits an arrow. The latch repeats the press on every held poll;
      // a poll with the left button up clears it. A drag from off the arrow onto it has no press edge, so it does nothing.
      // A right press edge on an arrow (`$15F44` -> `$15A28` step 6) scrolls once, sets no latch and never repeats, and
      // runs before the build-mode exit. Each step is one whole pass (4 video updates): presses are seen at pass ends.
      const away = { ...idle, leftButton: true, pointerX: 20, pointerY: 20 };
      const onArrow = { ...idle, leftButton: true, pointerX: 250, pointerY: 141 };
      const up = { ...idle, pointerX: 250, pointerY: 141 };
      const rightOn = { ...idle, rightButton: true, pointerX: 250, pointerY: 141 };
      const rightAway = { ...idle, rightButton: true, pointerX: 20, pointerY: 20 };

      {
        const m = scene();
        ticks(m, 4, away);
        ticks(m, 8, onArrow);
        check("arrow drag: a press that starts off the arrow and moves onto it does not scroll", m.scrollX === 47 && m.scrollY === 33, `x=${m.scrollX} y=${m.scrollY}`);
      }
      {
        const m = scene();
        ticks(m, 4, onArrow);
        check("arrow press: a press edge on the arrow scrolls at its first pass", m.scrollX === 48, `x=${m.scrollX}`);
        ticks(m, 4, onArrow);
        check("arrow hold: the held press repeats once per pass", m.scrollX === 49, `x=${m.scrollX}`);
        ticks(m, 4, up);
        check("arrow release: the left button up stops the repeat", m.scrollX === 49, `x=${m.scrollX}`);
        ticks(m, 4, onArrow);
        check("arrow re-press: a new press edge on the arrow scrolls again", m.scrollX === 50, `x=${m.scrollX}`);
      }
      {
        // The latch stays set while the pointer is off the arrow, so returning onto it repeats the press; off the arrow the
        // press itself does nothing.
        const m = scene();
        ticks(m, 4, onArrow);
        ticks(m, 4, away);
        check("arrow latch: moving off the arrow while held does not scroll", m.scrollX === 48, `x=${m.scrollX}`);
        ticks(m, 4, onArrow);
        check("arrow latch: moving back onto the arrow repeats the held press", m.scrollX === 49, `x=${m.scrollX}`);
      }
      {
        const m = scene();
        ticks(m, 4, rightOn);
        check("right press on arrow: scrolls once by 6", m.scrollX === 53, `x=${m.scrollX}`);
        ticks(m, 8, rightOn);
        check("right hold on arrow: no repeat (the right button is an event only on a new press)", m.scrollX === 53, `x=${m.scrollX}`);
        ticks(m, 4, idle);
        ticks(m, 4, rightOn);
        check("right re-press on arrow: a new press scrolls by 6 again", m.scrollX === 59, `x=${m.scrollX}`);
      }
      {
        const m = scene();
        ticks(m, 4, rightAway);
        ticks(m, 4, rightOn);
        check("right drag onto arrow: no press edge on the arrow, no scroll", m.scrollX === 47, `x=${m.scrollX}`);
      }
      {
        // `$15F44` tests the arrows before `$15EF0` leaves build mode, so a right press on an arrow scrolls and keeps the mode.
        const m = scene();
        m.controls.mode = "build";
        ticks(m, 4, rightOn);
        check("right press on arrow in build mode: scrolls and keeps the mode", m.scrollX === 53 && m.controls.mode === "build", `x=${m.scrollX} mode=${m.controls.mode}`);
      }
      {
        // Status quo, not a new trace: the build menu's loop ($B3D8) does not reach $15F44 (building.md, its callee list), so
        // a right press on an arrow while the menu is open does not scroll.
        const m = scene();
        ticks(m, 4, { ...idle, leftButton: true, pointerX: 272, pointerY: 63 });
        ticks(m, 4, idle);
        check("arrow menu: the build menu is open for this check", m.controls.menuVisible);
        ticks(m, 4, rightOn);
        check("right press on arrow while the build menu is open: no scroll", m.scrollX === 47 && m.controls.menuVisible, `x=${m.scrollX}`);
      }
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

    {
      // QoL title (`$4D96`, once per main-loop pass): `bchg #5,$1581` flips bit 5 each pass and the word is drawn only if the bit
      // was set before the flip. The image default `$1581 = $04` leaves it clear, so passes 1 and 3 hide the word and 2 and 4 show
      // it. The QoL 50 scene never shows the word and serves as the reference for the same passes.
      const titleRegion = (screen) => {
        const out = [];
        for (let y = 2; y <= 8; y++) for (let x = 182; x <= 208; x++) out.push(screen.pixels[y * 320 + x]);
        return out;
      };
      const sameRegion = (a, b) => a.every((v, i) => v === b[i]);
      const high = scene();
      high.world.state.setLong(A.qualityOfLife, 95);
      const low = scene();
      low.world.state.setLong(A.qualityOfLife, 50);
      const same = [];
      for (let pass = 0; pass < 4; pass++) {
        ticks(high, 4);
        ticks(low, 4);
        same.push(sameRegion(titleRegion(high.screen), titleRegion(low.screen)));
      }
      check("QoL title: pass 1 hides the word (image bit 5 clear)", same[0]);
      check("QoL title: pass 2 shows the word (bit set before the flip)", !same[1]);
      check("QoL title: pass 3 hides it again", same[2]);
      check("QoL title: pass 4 shows it again (one flip per pass, not per video update)", !same[3], `same=${same.join()}`);
    }
  }

  // ---- 5. Kamikaze dive height hook (enemies.md section 3c) --------------------------------------------------------
  {
    // The original stores rows - 1 in the descriptor (table $1612E, long at +0) and the kamikaze reads its low byte.
    // scenario.ts keeps rows = stored + 1, so the MapScene hook must return rows - 1 for the tile it is given.
    const tiles = loadTileSet(disk1, disk2, record).tiles;
    const strings = new GameStrings(disk1, 0);
    const m = new MapScene(disk1, tiles, newWorld(), strings, { sprites });
    const hook = m.enemies?.hooks.buildingHeight;
    check("kamikaze height hook is wired in the MapScene", typeof hook === "function");
    const gunA = 0x1f;
    check("kamikaze height hook: stored rows - 1 for Gun A (tile $1F), not the rows count",
      hook?.(gunA) === tiles[gunA - 1].rows - 1, `hook=${hook?.(gunA)} rows=${tiles[gunA - 1].rows}`);
  }

  // ---- 5. The mode icon in the scene: select tile $39 at (272, bottom row 52), drawn on the initial frame and every pass --------
  {
    // Controls.draw paints the icon over the restored overlay area. Outside the tile the box must equal the pristine picture
    // (MapScene.initialPicture), so the check is exact: every opaque pixel of tile $39 and nothing else changes in x 272..303, rows 30..52.
    const tiles = loadTileSet(disk1, disk2, record).tiles;
    const strings = new GameStrings(disk1, 0);
    const m = new MapScene(disk1, tiles, newWorld(), strings, { sprites });
    m.world.state.setByte(A.frameCountdown, 90);
    m.world.state.setByte(A.pending, 0);
    const tile = tiles[0x39 - 1];
    // opaque pixels of the tile in its own colour index space: the same plane decode blitTile uses (bottom row first)
    const iconTileMap = () => {
      const opaque = new Map();
      const planeBytes = tile.rows * 4;
      for (let row = 0; row < tile.rows; row++) for (let px = 0; px < 32; px++) {
        const at = row * 4 + (px >> 3), bit = 7 - (px & 7);
        if (((tile.planes[5 * planeBytes + at] >> bit) & 1) === 0) continue;
        let index = 0;
        for (let p = 0; p < 5; p++) index |= ((tile.planes[p * planeBytes + at] >> bit) & 1) << p;
        opaque.set((52 - row) * 320 + 272 + px, index);
      }
      return opaque;
    };
    const iconExact = (pixels) => {
      const opaque = iconTileMap();
      let bad = 0;
      for (let y = 30; y <= 52; y++) for (let x = 272; x <= 303; x++) {
        const at = y * 320 + x;
        const want = opaque.has(at) ? opaque.get(at) : m.initialPicture[at];
        if (pixels[at] !== want) bad++;
      }
      return bad;
    };
    check("initial frame: the mode icon box is tile $39 over the pristine picture", iconExact(m.screen.pixels) === 0, `differs ${iconExact(m.screen.pixels)}`);
    for (let i = 0; i < 4; i++) m.update({ leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] });
    check("after a scheduled pass the mode icon box is unchanged", iconExact(m.screen.pixels) === 0, `differs ${iconExact(m.screen.pixels)}`);
  }

  // ---- 6. Mode changes outside a pass's draw: the frame of the update that made them already shows them ------------------
  // Static (Disk.1): `$15EF0`, `$15ECA`, `$30FE` and the build commit `$6BA2` paint the mode icon with `$6B10` at once, in both
  // bitmaps. The remake had waited for the next completed pass. Each case runs two identical scenes (twins): the input scene
  // gets the input on a pass boundary (the update that polls it), the twin gets a quiet update there. Checks: the frame of the
  // input update shows the mode, the panel equals the panel after the next quiet pass, and nothing outside the panel box
  // (x 272..319, rows 22..159) differs from the twin, so the map and message line keep their draw order.
  {
    const tiles = loadTileSet(disk1, disk2, record).tiles;
    const strings = new GameStrings(disk1, 0);
    const quiet = { leftButton: false, rightButton: false, pointerX: 20, pointerY: 20, keys: [] };
    const at = (leftButton, x, y, rightButton = false) => ({ leftButton, rightButton, pointerX: x, pointerY: y, keys: [] });
    const fresh = (setup, money = 500000) => {
      const m = new MapScene(disk1, tiles, newWorld(), strings, { sprites });
      m.world.state.setByte(A.frameCountdown, 90);
      m.world.state.setByte(A.pending, 0);
      m.world.state.setLong(0x135ba, money);
      setup?.(m);
      // Align: run video updates until a pass completes, so the next boundary is four updates later.
      const n = m.loop.passes;
      while (m.loop.passes === n) m.update(quiet);
      return m;
    };
    // One pass: quiet video updates up to the boundary, then `input` on the boundary update (the one that polls it).
    const passWith = (m, input) => {
      const n = m.loop.passes;
      while (m.loop.updatesIntoPass < m.loop.vblPerPass - 1) m.update(quiet);
      m.update(input);
      return m.loop.passes === n + 1;
    };
    const PANEL_X = 272, PANEL_X1 = 319, PANEL_Y0 = 22, PANEL_Y1 = 159;
    const inPanel = (i) => { const x = i % 320, y = (i / 320) | 0; return x >= PANEL_X && x <= PANEL_X1 && y >= PANEL_Y0 && y <= PANEL_Y1; };
    const panelDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (inPanel(i) && a[i] !== b[i]) n++; return n; };
    const outsideDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (!inPanel(i) && a[i] !== b[i]) n++; return n; };
    // The message line band (rows 160..170, above the log): section 7 checks it; the marker press also changes it.
    const BAND_FIRST = 160, BAND_LAST = 170;
    const inBand = (i) => { const y = (i / 320) | 0; return y >= BAND_FIRST && y <= BAND_LAST; };
    const bandDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (inBand(i) && a[i] !== b[i]) n++; return n; };
    const offBandDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (!inBand(i) && !inPanel(i) && a[i] !== b[i]) n++; return n; };
    // Mode icon box (x 272..303, rows 30..52): mismatches against tile `tileId` over the pristine picture (as in section 5).
    const iconMismatch = (m, pixels, tileId) => {
      const tile = tiles[tileId - 1];
      const planeBytes = tile.rows * 4;
      const opaque = new Map();
      for (let row = 0; row < tile.rows; row++) for (let px = 0; px < 32; px++) {
        const at = row * 4 + (px >> 3), bit = 7 - (px & 7);
        if (((tile.planes[5 * planeBytes + at] >> bit) & 1) === 0) continue;
        let index = 0;
        for (let p = 0; p < 5; p++) index |= ((tile.planes[p * planeBytes + at] >> bit) & 1) << p;
        opaque.set((52 - row) * 320 + 272 + px, index);
      }
      let bad = 0;
      for (let y = 30; y <= 52; y++) for (let x = 272; x <= 303; x++) {
        const i = y * 320 + x;
        const want = opaque.has(i) ? opaque.get(i) : m.initialPicture[i];
        if (pixels[i] !== want) bad++;
      }
      return bad;
    };
    const frameOf = (m) => m.screen.pixels.slice();
    // Row 52 (x 272..319) after `$6B10` draws tile `tileId` over `base` (the 48 pixels the original's bitmap held): opaque tile pixels
    // of its bottom row (tile row 0, x 0..31) are replaced, transparent ones keep `base` (`$69D8`: the mask is plane 6).
    const bottomRowComposite = (base, tileId) => {
      const t = tiles[tileId - 1];
      const pb = t.rows * 4;
      return base.map((v, x) => {
        if (x >= 32) return v;
        const at = x >> 3, bit = 7 - (x & 7);
        if (((t.planes[5 * pb + at] >> bit) & 1) === 0) return v;
        let index = 0;
        for (let p = 0; p < 5; p++) index |= ((t.planes[p * pb + at] >> bit) & 1) << p;
        return index;
      });
    };
    const row52Of = (pix) => Array.from(pix.subarray(52 * 320 + 272, 52 * 320 + 320));
    // Runs the same passes on both twins: the input on `a`, quiet on `b`. Returns the frames of `a` after the input update.
    const pair = (a, b, input) => {
      const aBefore = frameOf(a), bBefore = frameOf(b);
      const aPassed = passWith(a, input), bPassed = passWith(b, quiet);
      return { aBefore, bBefore, aAfter: frameOf(a), bAfter: frameOf(b), passed: aPassed && bPassed };
    };
    const build = (m) => { m.controls.mode = "build"; m.controls.selection = { tile: 0x45, type: 22 }; };

    {
      // Right click out of build mode ($15F64 -> $15EF0): the select icon is in the frame of the click's update.
      const a = fresh(build), b = fresh(build);
      const r = pair(a, b, at(false, 20, 20, true));
      check("right click (build mode): the pass boundary polls it", r.passed);
      check("right click (build mode): the frame of that update already shows select mode and the $39 icon", a.controls.mode === "select" && iconMismatch(a, a.screen.pixels, 0x39) === 0, `mismatch=${iconMismatch(a, a.screen.pixels, 0x39)}`);
      check("right click (build mode): before the click the build preview was shown (no select icon)", iconMismatch(a, r.aBefore, 0x39) > 0);
      check("right click (build mode): nothing outside the panel box differs from the twin", outsideDiff(r.aAfter, r.bAfter) === 0, `differs ${outsideDiff(r.aAfter, r.bAfter)}`);
      const next = frameOf(a);
      passWith(a, quiet);
      check("right click (build mode): the next pass keeps the same panel", panelDiff(next, a.screen.pixels) === 0, `differs ${panelDiff(next, a.screen.pixels)}`);
    }
    {
      // Demolish button: press (flip) on one pass, release on the next ($15AF8 -> $15ECA): the $3A icon is in the release frame.
      const a = fresh(), b = fresh();
      pair(a, b, at(true, 280, 90));
      const r = pair(a, b, at(false, 280, 90));
      check("demolish release: the frame of the release update shows the demolish icon ($3A) at once", a.controls.mode === "demolish" && iconMismatch(a, a.screen.pixels, 0x3a) === 0, `mismatch=${iconMismatch(a, a.screen.pixels, 0x3a)}`);
      check("demolish release: nothing outside the panel box differs from the twin", outsideDiff(r.aAfter, r.bAfter) === 0, `differs ${outsideDiff(r.aAfter, r.bAfter)}`);
      const next = frameOf(a);
      passWith(a, quiet);
      check("demolish release: the next pass keeps the same panel", panelDiff(next, a.screen.pixels) === 0, `differs ${panelDiff(next, a.screen.pixels)}`);
      // A second press keeps demolish mode ($15AF8 has no mode test).
      pair(a, b, at(true, 280, 90));
      pair(a, b, at(false, 280, 90));
      check("demolish: a second press keeps demolish mode and draws the $3A icon", a.controls.mode === "demolish" && iconMismatch(a, a.screen.pixels, 0x3a) === 0);
    }
    {
      // Marker button (index 3, (296, 82)) in build mode ($15B0A -> $30FE -> $15EF0): select mode and the $39 icon are in the release frame.
      const a = fresh(build), b = fresh(build);
      pair(a, b, at(true, 300, 90));
      const r = pair(a, b, at(false, 300, 90));
      check("marker release in build mode: select mode and the $39 icon in the release frame", a.controls.mode === "select" && iconMismatch(a, a.screen.pixels, 0x39) === 0, `mode=${a.controls.mode} mismatch=${iconMismatch(a, a.screen.pixels, 0x39)}`);
      check("marker release in build mode: nothing outside the panel box and the message band differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
    }
    {
      // Build menu exit with a pending item ($B628 -> $6BA2 -> $6B10): the preview is in the exit frame, not the next pass.
      // Items: the build button opens the menu on its release; page arrow (296,139); tile $45 at (25,115) on page 2; exit (272,139).
      const m = fresh();
      passWith(m, at(true, 272, 63));
      passWith(m, at(false, 272, 63));
      check("build menu opens on the release", m.controls.menuVisible);
      const preMenu = frameOf(m);
      const modal = (x, y) => { m.update(at(true, x, y)); m.update(at(false, x, y)); };
      modal(296, 139);
      modal(25, 115);
      const before = frameOf(m);
      check("build menu before the exit: the frame still shows the select icon", iconMismatch(m, before, 0x39) === 0);
      modal(272, 139);
      check("build menu exit with a pending item: the mode is build with tile $45 selected", !m.controls.menuVisible && m.controls.mode === "build" && m.controls.selection?.tile === 0x45);
      check("build menu exit with a pending item: the exit frame shows the preview, not the select icon", iconMismatch(m, m.screen.pixels, 0x39) > 0, `mismatch=${iconMismatch(m, m.screen.pixels, 0x39)}`);
      const exitFrame = frameOf(m);
      const exitTimer = m.messages.inspect().lineFramesLeft;
      passWith(m, quiet);
      check("build menu exit with a pending item: the next pass keeps the same panel", panelDiff(exitFrame, m.screen.pixels) === 0, `differs ${panelDiff(exitFrame, m.screen.pixels)}`);
      // The commit also posts string 0 with `$551A` (Disk.1 `$6BD2`), which draws its line at once (`$552C` -> `$54DE`, timer 200).
      // The exit frame must already carry the prompt line: the band equals the band of the pass that follows, and it changed from the
      // band before the exit.
      const band = (pix) => Array.from(pix.subarray(BAND_FIRST * 320, (BAND_LAST + 1) * 320));
      const preBand = band(preMenu), exitBand = band(exitFrame), nextBand = band(m.screen.pixels);
      const bandMismatch = (x, y) => x.reduce((n, v, i) => n + (v !== y[i] ? 1 : 0), 0);
      check("build menu exit with a pending item: the prompt line is in the exit frame ($551A at once)", bandMismatch(exitBand, preBand) > 0, `band changed ${bandMismatch(exitBand, preBand)}`);
      check("build menu exit with a pending item: the exit frame's message band equals the next pass's band", bandMismatch(exitBand, nextBand) === 0, `differs ${bandMismatch(exitBand, nextBand)}`);
      // The exit frame draws the prompt at 200 frames: the modal exit holds its first tick (MapScene.update, Messages.holdLineTick).
      check("build menu exit with a pending item: the prompt timer is 200 in the exit frame", exitTimer === 200, `timer ${exitTimer}`);
      {
        // Lifetime on a fresh scene: the exit frame plus 199 updates is 200 drawn frames, so the line clears on the 200th update after it.
        const L = fresh();
        passWith(L, at(true, 272, 63));
        passWith(L, at(false, 272, 63));
        const modalL = (x, y) => { L.update(at(true, x, y)); L.update(at(false, x, y)); };
        modalL(296, 139);
        modalL(25, 115);
        modalL(272, 139);
        check("build menu exit with a pending item: the exit frame's prompt timer is 200 on the fresh scene too", !L.controls.menuVisible && L.messages.inspect().lineFramesLeft === 200, `timer ${L.messages.inspect().lineFramesLeft}`);
        let k = 0;
        while (L.messages.inspect().lineFramesLeft > 0 && k < 1000) { L.update(quiet); k++; }
        check("build menu exit with a pending item: the prompt clears on the 200th update after the exit", k === 200, `updates ${k}`);
      }
    }
    {
      // Build menu exit with nothing pending (an unaffordable pick, $B57E): select mode and the $39 icon in the exit frame.
      const m = fresh(build, 100);
      passWith(m, at(true, 272, 63));
      passWith(m, at(false, 272, 63));
      const modal = (x, y) => { m.update(at(true, x, y)); m.update(at(false, x, y)); };
      modal(296, 139);
      modal(25, 115);
      check("unaffordable pick: nothing pending in the open menu", m.controls.menuVisible && m.controls.menuState.pending === null);
      modal(272, 139);
      check("build menu exit with nothing pending: the exit frame shows the select icon ($15EF0 -> $6B10)", !m.controls.menuVisible && m.controls.mode === "select" && iconMismatch(m, m.screen.pixels, 0x39) === 0, `mismatch=${iconMismatch(m, m.screen.pixels, 0x39)}`);
    }
    {
      // Money refusal while placing (build.ts `place` -> `onBuildCancelled(true)` -> `$15EF0`): the press's frame shows select mode.
      // A cell is tried until one passes the placement checks; a refusal is the only way out of build mode there (money 100 < price).
      const m = fresh(build, 100);
      let refused = false;
      for (let vy = 0; vy < 8 && !refused; vy++) for (let vx = 0; vx < 8 && !refused; vx++) {
        const px = 112 + 16 * (vx - vy) + 15, py = 24 + 8 * (vx + vy) + 7;
        const before = frameOf(m);
        passWith(m, at(true, px, py));
        if (m.controls.mode === "select") {
          refused = true;
          check("placement refused for money: the frame of the press shows the select icon at once", iconMismatch(m, m.screen.pixels, 0x39) === 0 && iconMismatch(m, before, 0x39) > 0, `mismatch=${iconMismatch(m, m.screen.pixels, 0x39)}`);
          check("placement refused for money: the selection is cleared", m.controls.selection === null);
        } else passWith(m, at(false, px, py));
      }
      check("a placement refused for money is reached from a cell in the view", refused);
    }
    {
      // Paused: a right click does nothing ($15F64 tests $156A9 bit 2 first), so there is no change and no redraw.
      const m = fresh(build);
      m.sim.paused = true;
      passWith(m, quiet); // paused: the pause button is drawn flipped from here on, so the baseline frame is taken after it
      const before = frameOf(m);
      passWith(m, at(false, 20, 20, true));
      check("paused right click (build mode): the mode is kept and the panel is unchanged", m.controls.mode === "build" && panelDiff(before, m.screen.pixels) === 0);
    }

    // ---- 7. A line message posted by the input poll is in that frame ($551A draws it at once, game-text.md section 4) -------
    // The marker button (`$30FE` posts `$6F`) and a money refusal while placing (`$6CBE` posts `$25`) used to show their line on
    // the next completed pass. Checks per case: the line is in the input frame and equals the band of the next pass; only the
    // message band (rows 160..170) and the panel box differ from the twin (the mode change of a refusal is in the panel); the
    // line timer is not advanced (200 frames right after the input, 0 on the twin); the simulation pass count matches the twin.
    {
      const lineLeft = (m) => m.messages.inspect().lineFramesLeft;
      const LINE_FRAMES_NEW = 200;

      {
        // Marker button in select mode (index 3, (296, 82)): the release posts `$6F` and changes no mode.
        const a = fresh(), b = fresh();
        pair(a, b, at(true, 300, 90));
        const r = pair(a, b, at(false, 300, 90));
        check("marker release (select): the message line is in the release frame", bandDiff(r.aAfter, r.aBefore) > 0 && bandDiff(r.aAfter, r.bAfter) > 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
        check("marker release (select): only the message band differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
        check("marker release (select): the line timer is 200 frames at once, the twin has no line", lineLeft(a) === LINE_FRAMES_NEW && lineLeft(b) === 0, `a=${lineLeft(a)} b=${lineLeft(b)}`);
        check("marker release (select): the presentation advances no pass", a.loop.passes === b.loop.passes && a.loop.updatesIntoPass === b.loop.updatesIntoPass);
        const next = frameOf(a);
        passWith(a, quiet);
        check("marker release (select): the next pass shows the same message band", bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
      }
      {
        // Marker button in build mode: the mode change is in the panel, the message line is still the only band change.
        const a = fresh(build), b = fresh(build);
        pair(a, b, at(true, 300, 90));
        const r = pair(a, b, at(false, 300, 90));
        check("marker release (build): select mode and the message line in the release frame", a.controls.mode === "select" && bandDiff(r.aAfter, r.bAfter) > 0);
        check("marker release (build): nothing outside the band and the panel box differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
        check("marker release (build): the line timer is 200 frames at once", lineLeft(a) === LINE_FRAMES_NEW);
      }
      {
        // Money refusal while placing: the press posts `$25` (money 100 < price), leaves build mode and draws the line at once.
        // A cell is tried until one passes the placement checks, as in section 6.
        const a = fresh(build, 100), b = fresh(build, 100);
        let refused = false;
        for (let vy = 0; vy < 8 && !refused; vy++) for (let vx = 0; vx < 8 && !refused; vx++) {
          const px = 112 + 16 * (vx - vy) + 15, py = 24 + 8 * (vx + vy) + 7;
          const r = pair(a, b, at(true, px, py));
          if (a.controls.mode === "select") {
            refused = true;
            check("money refusal: the message line is in the press frame", bandDiff(r.aAfter, r.aBefore) > 0 && bandDiff(r.aAfter, r.bAfter) > 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
            check("money refusal: nothing outside the band and the panel box differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
            check("money refusal: the line timer is 200 frames at once, money is unchanged", lineLeft(a) === LINE_FRAMES_NEW && a.world.state.signedLong(0x135ba) === 100, `line=${lineLeft(a)}`);
            check("money refusal: the presentation advances no pass", a.loop.passes === b.loop.passes);
            const next = frameOf(a);
            passWith(a, quiet);
            check("money refusal: the next pass shows the same message band", bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
          } else pair(a, b, at(false, px, py));
        }
        check("a money refusal is reached from a cell in the view", refused);
      }
      {
        // Money refusal while clearing ground ($6D10 -> $6D2C, tile $61, twice the price): `$25` at once, the selection is cleared
        // and the mode stays build (no icon change). Detected as a cleared selection in build mode, from the same cell search.
        const clearing = (m) => { m.controls.mode = "build"; m.controls.selection = { tile: 0x61, type: m.world.findType(0x61) }; };
        const a = fresh(clearing, 100), b = fresh(clearing, 100);
        let refused = false;
        for (let vy = 0; vy < 8 && !refused; vy++) for (let vx = 0; vx < 8 && !refused; vx++) {
          const px = 112 + 16 * (vx - vy) + 15, py = 24 + 8 * (vx + vy) + 7;
          const r = pair(a, b, at(true, px, py));
          if (a.controls.selection === null && a.controls.mode === "build") {
            refused = true;
            check("clearing refusal: the message line is in the press frame", bandDiff(r.aAfter, r.aBefore) > 0 && bandDiff(r.aAfter, r.bAfter) > 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
            check("clearing refusal: nothing outside the band and the panel box differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
            check("clearing refusal: the line timer is 200 frames at once, money is unchanged", lineLeft(a) === LINE_FRAMES_NEW && a.world.state.signedLong(0x135ba) === 100, `line=${lineLeft(a)}`);
            const next = frameOf(a);
            passWith(a, quiet);
            check("clearing refusal: the next pass shows the same message band", bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
          } else pair(a, b, at(false, px, py));
        }
        check("a clearing refusal is reached from a cell in the view", refused);
      }
    }

    // ---- 7j. Poll refusals and building-select texts are drawn in the input frame; accepted placement and demolition are silent ----
    // Static (Disk.1): the placement refusals of `$6BF4` (`$2` blocked, `$127`, `$1`, `$3`, `$5E`, `$11B`, `$5D`), the demolition refusal
    // of `$7372` (`$58`), and the building-select texts of `$7140` (scaffold `$7D`, mine `$89`) each call `$551A` at once, from the
    // press's poll (`$158CA` after the pass draw). The accepted placement (`$6BF4` to `$6FC4`) and the accepted demolition (`$7372`
    // to `$6FC4`, the site cancel `$74FE`) call no message routine. Each case compares the press frame with a quiet twin, and the
    // cell is chosen by a probe scene so the case scene starts clean (no earlier line).
    {
      const { createBuildingScreen } = await import("../dist/game/screens/buildings.js");
      const { MAP_WIDTH } = await import("../dist/data/scenario.js");
      const LINE_NEW = 200;
      const OBJECTS = 0x142c2; // the object-record count (build.ts V.objects)
      const MONEY = 0x135ba;
      const lineLeftOf = (m) => m.messages.inspect().lineFramesLeft;
      const cellPixel = (vx, vy) => ({ px: 112 + 16 * (vx - vy) + 15, py: 24 + 8 * (vx + vy) + 7 });
      const pokeTile = (m, x, y, tile) => { const i = y * MAP_WIDTH + x; m.world.cells[i] = (m.world.cells[i] & 0xff00) | tile; };
      const buildAt0 = (m) => { build(m); m.scrollX = 0; m.scrollY = 0; };
      const demolishMode = (m) => { m.controls.mode = "demolish"; };
      const selectWithPoke = (tile, vx, vy) => (m) => {
        m.controls.onSelect = (x, y) => { m.selectedScene = createBuildingScreen({ disk: disk1, world: m.world, sim: m.sim, strings, say: (n) => m.say(n) }, x, y); };
        pokeTile(m, m.scrollX + vx, m.scrollY + vy, tile);
      };

      {
        // Placement refused as "blocked" ($2, x <= 3): the press posts the line at once; build mode and the selection stay.
        const a = fresh(buildAt0), b = fresh(buildAt0);
        const { px, py } = cellPixel(0, 0);
        const r = pair(a, b, at(true, px, py));
        check("placement refused (blocked): the line is in the press frame", bandDiff(r.aAfter, r.aBefore) > 0 && bandDiff(r.aAfter, r.bAfter) > 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
        check("placement refused (blocked): nothing outside the band and the panel box differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
        check("placement refused (blocked): the line timer is 200 frames at once, the twin has no line", lineLeftOf(a) === LINE_NEW && lineLeftOf(b) === 0, `a=${lineLeftOf(a)} b=${lineLeftOf(b)}`);
        check("placement refused (blocked): build mode and the selection stay, money unchanged, no simulation message", a.controls.mode === "build" && a.controls.selection !== null && a.world.state.signedLong(MONEY) === 500000 && a.sim.messages.length === 0);
        check("placement refused (blocked): the presentation advances no pass", a.loop.passes === b.loop.passes);
        const next = frameOf(a);
        passWith(a, quiet);
        check("placement refused (blocked): the next pass shows the same message band", bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
      }
      {
        // Accepted placement: a cell the probes find that spends money. The original's `$6BF4` success path posts nothing.
        let found = null;
        for (let vy = 0; vy < 8 && !found; vy++) for (let vx = 0; vx < 8 && !found; vx++) {
          const probe = fresh(build);
          const { px, py } = cellPixel(vx, vy);
          passWith(probe, at(true, px, py));
          if (probe.world.state.signedLong(MONEY) < 500000) found = { vx, vy };
        }
        check("accepted placement: a cell in the view is accepted by the placement checks", found !== null);
        if (found) {
          const a = fresh(build), b = fresh(build);
          const { px, py } = cellPixel(found.vx, found.vy);
          const r = pair(a, b, at(true, px, py));
          check("accepted placement: the press spends money and keeps the selection", a.world.state.signedLong(MONEY) < 500000 && a.controls.selection !== null);
          check("accepted placement: no line is posted (the band equals the frame before and the twin)", lineLeftOf(a) === 0 && bandDiff(r.aAfter, r.aBefore) === 0 && bandDiff(r.aAfter, r.bAfter) === 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
          check("accepted placement: the simulation posts no message", a.sim.messages.length === 0);
        }
      }
      {
        // Demolition refused ($58): a view cell with no record and no ground tile. The press posts the line at once; the mode stays.
        let found = null;
        for (let vy = 0; vy < 8 && !found; vy++) for (let vx = 0; vx < 8 && !found; vx++) {
          const probe = fresh(demolishMode);
          const { px, py } = cellPixel(vx, vy);
          passWith(probe, at(true, px, py));
          if (lineLeftOf(probe) > 0) found = { vx, vy };
        }
        check("demolition refused: a view cell is refused by the probes", found !== null);
        if (found) {
          const a = fresh(demolishMode), b = fresh(demolishMode);
          const { px, py } = cellPixel(found.vx, found.vy);
          const r = pair(a, b, at(true, px, py));
          check("demolition refused: the line is in the press frame", bandDiff(r.aAfter, r.aBefore) > 0 && bandDiff(r.aAfter, r.bAfter) > 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
          check("demolition refused: nothing outside the band and the panel box differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
          check("demolition refused: the line timer is 200 frames at once, the twin has no line", lineLeftOf(a) === LINE_NEW && lineLeftOf(b) === 0);
          check("demolition refused: demolish mode stays and no record is removed", a.controls.mode === "demolish" && a.world.state.word(OBJECTS) === b.world.state.word(OBJECTS) && a.sim.messages.length === 0);
          const next = frameOf(a);
          passWith(a, quiet);
          check("demolition refused: the next pass shows the same message band", bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
        }
      }
      {
        // Accepted demolition: a view cell whose press removes an object record. The original's `$7372` success path posts nothing.
        let found = null;
        for (let vy = 0; vy < 8 && !found; vy++) for (let vx = 0; vx < 8 && !found; vx++) {
          const probe = fresh(demolishMode);
          const n0 = probe.world.state.word(OBJECTS);
          const { px, py } = cellPixel(vx, vy);
          passWith(probe, at(true, px, py));
          if (probe.world.state.word(OBJECTS) < n0) found = { vx, vy };
        }
        check("accepted demolition: a view cell with a record is demolished by the probes", found !== null);
        if (found) {
          const a = fresh(demolishMode), b = fresh(demolishMode);
          const { px, py } = cellPixel(found.vx, found.vy);
          const r = pair(a, b, at(true, px, py));
          check("accepted demolition: the record count falls by one and demolish mode stays", a.world.state.word(OBJECTS) === b.world.state.word(OBJECTS) - 1 && a.controls.mode === "demolish");
          check("accepted demolition: no line is posted (the band equals the frame before and the twin)", lineLeftOf(a) === 0 && bandDiff(r.aAfter, r.aBefore) === 0 && bandDiff(r.aAfter, r.bAfter) === 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
          check("accepted demolition: the simulation posts no message", a.sim.messages.length === 0);
        }
      }
      for (const [tile, text, label] of [[0x32, 0x7d, "scaffold"], [0x61, 0x89, "land mine"]]) {
        // Building select ($7140 -> `$72AC`): a cell with the tile and no record. The window dispatch says the text at once and opens no window.
        let found = null;
        for (let vy = 0; vy < 8 && !found; vy++) for (let vx = 0; vx < 8 && !found; vx++) {
          const probe = fresh(selectWithPoke(tile, vx, vy));
          const { px, py } = cellPixel(vx, vy);
          passWith(probe, at(true, px, py));
          if (lineLeftOf(probe) > 0) found = { vx, vy };
        }
        check(`${label} ($${text.toString(16)}): a poked cell says it on a select press`, found !== null);
        if (!found) continue;
        const a = fresh(selectWithPoke(tile, found.vx, found.vy)), b = fresh(selectWithPoke(tile, found.vx, found.vy));
        const { px, py } = cellPixel(found.vx, found.vy);
        const r = pair(a, b, at(true, px, py));
        check(`${label}: the line is in the press frame (the original's $551A draws it at once)`, bandDiff(r.aAfter, r.aBefore) > 0 && bandDiff(r.aAfter, r.bAfter) > 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
        check(`${label}: nothing outside the band and the panel box differs from the twin`, offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
        check(`${label}: the line timer is 200 frames at once, the twin has no line`, lineLeftOf(a) === LINE_NEW && lineLeftOf(b) === 0, `a=${lineLeftOf(a)} b=${lineLeftOf(b)}`);
        check(`${label}: select mode stays, no window opens, the simulation posts no message`, a.controls.mode === "select" && a.selectedScene === null && a.sim.messages.length === 0);
        check(`${label}: the presentation advances no pass`, a.loop.passes === b.loop.passes);
        const next = frameOf(a);
        passWith(a, quiet);
        check(`${label}: the next pass shows the same message band`, bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
      }
      {
        // A line said outside the poll (a pass or a window action) is drawn by its own frame, not presented at once.
        const m = fresh();
        m.say(0x10a);
        check("a line said outside the poll sets no presentation flag (the pass draws it)", m.controls.peekMessageLineChanged() === false && lineLeftOf(m) === LINE_NEW);
      }
    }

    // ---- 7k. A poll-posted log entry is drawn in the input frame ($5A8C draws the panel at once) -------------------------
    // Static (Disk.1, game-text.md section 5 step 3): a shipyard click with no command centre ($7140 -> `$B3`) goes through `$5A8C`,
    // the log, not `$551A`. The entry is appended with the log's idle timer (500 frames) and no line. The remake's press presents
    // the band at once (`MapScene.update`, pollLogChanged). Checks: the entry is in the press frame, the line timer is untouched,
    // the order of earlier entries is kept, nothing outside the band and the panel box differs from the twin, no window opens, and
    // the next pass shows the same band.
    {
      const { createBuildingScreen, TYPE } = await import("../dist/game/screens/buildings.js");
      const { MAP_WIDTH } = await import("../dist/data/scenario.js");
      const { T } = await import("../dist/game/world.js");
      const SHIPYARD_TILE = 0x36; // TILE.shipYard (buildings.ts)
      const SEED_LOG = 143; // a log-panel text (LOG_INDICES) posted outside the poll, so it is drawn by a pass before the press
      const LOG_IDLE = 500;
      const cellPixel = (vx, vy) => ({ px: 112 + 16 * (vx - vy) + 15, py: 24 + 8 * (vx + vy) + 7 });
      const pokeTile = (m, x, y, tile) => { const i = y * MAP_WIDTH + x; m.world.cells[i] = (m.world.cells[i] & 0xff00) | tile; };
      const yardWithoutCentre = (vx, vy) => (m) => {
        m.controls.onSelect = (x, y) => { m.selectedScene = createBuildingScreen({ disk: disk1, world: m.world, sim: m.sim, strings, say: (n) => m.say(n) }, x, y); };
        const x = m.scrollX + vx, y = m.scrollY + vy;
        const at = m.world.objectCount * 8;
        m.world.objectCount++;
        m.world.state.setWord(0x142c2, m.world.objectCount);
        m.world.objects[at] = SHIPYARD_TILE >> 8;
        m.world.objects[at + 1] = SHIPYARD_TILE & 255;
        m.world.objects[at + 3] = 0;
        m.world.objects[at + 4] = x;
        m.world.objects[at + 5] = y;
        pokeTile(m, x, y, SHIPYARD_TILE);
        m.world.state.setWord(m.world.typeAddress(TYPE.commandCentre) + T.total, 0);
      };
      const seeded = (vx, vy) => (m) => { m.say(SEED_LOG); yardWithoutCentre(vx, vy)(m); };
      const logCount = (m) => m.messages.logText.length;
      // The message band of a press: the line (160..170) and the log panel (171..199). `bandDiff` above covers the line rows only.
      const wideBand = (i) => { const y = (i / 320) | 0; return y >= 160 && y <= 199; };
      const wideBandDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (wideBand(i) && a[i] !== b[i]) n++; return n; };
      const outsideWideDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (!wideBand(i) && !inPanel(i) && a[i] !== b[i]) n++; return n; };
      let found = null;
      for (let vy = 0; vy < 8 && !found; vy++) for (let vx = 0; vx < 8 && !found; vx++) {
        const probe = fresh(yardWithoutCentre(vx, vy));
        const { px, py } = cellPixel(vx, vy);
        passWith(probe, at(true, px, py));
        if (logCount(probe) > 0) found = { vx, vy };
      }
      check("shipyard without a command centre: a view cell says its text on a select press (log entry)", found !== null);
      if (found) {
        const a = fresh(seeded(found.vx, found.vy)), b = fresh(seeded(found.vx, found.vy));
        const { px, py } = cellPixel(found.vx, found.vy);
        const logBefore = logCount(a);
        const r = pair(a, b, at(true, px, py));
        check("log entry: the band differs from the frame before the press and from the twin (the press frame shows it)", wideBandDiff(r.aAfter, r.aBefore) > 0 && wideBandDiff(r.aAfter, r.bAfter) > 0, `band=${wideBandDiff(r.aAfter, r.bAfter)}`);
        check("log entry: nothing outside the band and the panel box differs from the twin", outsideWideDiff(r.aAfter, r.bAfter) === 0, `differs ${outsideWideDiff(r.aAfter, r.bAfter)}`);
        check("log entry: appended after the seeded entry (order kept), the twin has only the seed", logCount(a) === logBefore + 1 && logCount(b) === logBefore, `a=${logCount(a)} b=${logCount(b)}`);
        check("log entry: the earlier entry is unchanged and first", JSON.stringify(a.messages.logText[0]) === JSON.stringify(b.messages.logText[0]));
        check("log entry: no line is posted (line timer 0) and the log idle timer is restarted at 500", a.messages.inspect().lineFramesLeft === 0 && a.messages.inspect().logIdleFrames === LOG_IDLE, `line=${a.messages.inspect().lineFramesLeft} idle=${a.messages.inspect().logIdleFrames}`);
        check("log entry: select mode stays and no window opens", a.controls.mode === "select" && a.selectedScene === null);
        check("log entry: the presentation advances no pass", a.loop.passes === b.loop.passes);
        const next = frameOf(a);
        passWith(a, quiet);
        check("log entry: the next pass shows the same band", wideBandDiff(next, a.screen.pixels) === 0, `differs ${wideBandDiff(next, a.screen.pixels)}`);
      }
    }

    // ---- 7b. Key D and the marker keys draw their line in the input frame ($31CC calls $551A, $318C calls $552C; game-text.md section 4) --
    // Key D (`$31CC`, message $F2) and keys 1-8 (`$3202` -> `$318C`, message $71) post their message from the poll. Same checks as
    // section 7: the line is in the input frame, only the band differs from the twin, the timer is 200 at once, no pass runs, and the
    // next pass shows the same band. Pointer (127,31) is a map cell (checked); (20,20) is not, so the pin key places nothing there.
    {
      const lineLeft = (m) => m.messages.inspect().lineFramesLeft;
      const LINE_FRAMES_NEW = 200;
      const keyInput = (key, x, y) => ({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [key] });
      check("key pins: the pointer (127,31) is over a map cell", fresh().controls.pickCell(127, 31) !== null);
      for (const [label, input] of [
        ["key D (clear pins, $F2)", keyInput("d", 20, 20)],
        ["pin key 1 on a map cell ($71)", keyInput("1", 127, 31)],
      ]) {
        const a = fresh(), b = fresh();
        const r = pair(a, b, input);
        check(`${label}: the message line is in the input frame`, bandDiff(r.aAfter, r.aBefore) > 0 && bandDiff(r.aAfter, r.bAfter) > 0, `band=${bandDiff(r.aAfter, r.bAfter)}`);
        check(`${label}: only the message band differs from the twin`, offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
        check(`${label}: the line timer is 200 frames at once, the twin has no line`, lineLeft(a) === LINE_FRAMES_NEW && lineLeft(b) === 0, `a=${lineLeft(a)} b=${lineLeft(b)}`);
        check(`${label}: the presentation advances no pass`, a.loop.passes === b.loop.passes && a.loop.updatesIntoPass === b.loop.updatesIntoPass);
        const next = frameOf(a);
        passWith(a, quiet);
        check(`${label}: the next pass shows the same message band`, bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
      }
      {
        // Marker pin by a map click ($311E, after the marker button arms it). The cell click is taken on the press (controls.ts
        // `cellHook`), so the pin message is in the press frame. The arming message $6F is on both twins before the click, so only
        // the band changes at the press and the timer restarts at 200 on `a`.
        const a = fresh(), b = fresh();
        pair(a, b, at(true, 300, 90));
        pair(a, b, at(false, 300, 90));
        const press = pair(a, b, at(true, 127, 31));
        check("marker pin click: the press is polled on the pass boundary", press.passed);
        check("marker pin click: the pin message is in the press frame", bandDiff(press.aAfter, press.aBefore) > 0 && bandDiff(press.aAfter, press.bAfter) > 0, `band=${bandDiff(press.aAfter, press.bAfter)}`);
        check("marker pin click: only the message band differs from the twin in the press frame", offBandDiff(press.aAfter, press.bAfter) === 0, `differs ${offBandDiff(press.aAfter, press.bAfter)}`);
        check("marker pin click: the line timer restarts at 200 frames at once", lineLeft(a) === LINE_FRAMES_NEW, `line=${lineLeft(a)}`);
        const next = frameOf(a);
        passWith(a, quiet);
        check("marker pin click: the next pass shows the same message band", bandDiff(next, a.screen.pixels) === 0, `differs ${bandDiff(next, a.screen.pixels)}`);
      }
      {
        // Pin key 1 with the pointer off the map: nothing is placed and no message is posted, so no line appears.
        const a = fresh(), b = fresh();
        const r = pair(a, b, keyInput("1", 20, 20));
        check("pin key 1 off the map: no line in the input frame", bandDiff(r.aAfter, r.aBefore) === 0 && lineLeft(a) === 0, `band=${bandDiff(r.aAfter, r.aBefore)} line=${lineLeft(a)}`);
      }
    }

    // ---- 7l. Messages said outside the poll: pass body (line held once), post-wait (drawn at once), window keys (drawn, held once) ----
    // Static (game-text.md section 4): a pass-body `$551A` sets 200 at its draw, so the line is drawn for 200 frames and its first
    // tick is on the next update (as 7e). The arson event (`$10D00` -> `$12332` -> `$7372`, refusal `$58`) runs in `$99C4`, after the
    // VBL wait, so its line is drawn at once (as 7f). The pad refusals (`$E9`/`$EA`, `$771E`) come from the enemy ship pass in `$333A`.
    // The F1-F6 refusal (`$B2`) is `$15B4A`'s: the key waits in input.keys for the next completed pass's poll, and the refusal is drawn
    // with 200 frames in that pass's update (the poll posts it; game.ts windowKey, stubbed here as `a.onWindowKey`).
    // Each case runs the scene beside a twin that posts nothing, and counts the updates whose message band (rows 160..199) differs.
    {
      const { MAP_WIDTH } = await import("../dist/data/scenario.js");
      const LINE_PASS = 0xe9; // $771E refusal: a line (not in LOG_INDICES)
      const LINE_KEY = 0xb2; // F1-F6 refusal: a line
      const LOG = 82; // a log string (in LOG_INDICES, as 7e)
      const bandAll = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i++) {
          const y = (i / 320) | 0;
          if (y >= 160 && y <= 199 && a[i] !== b[i]) n++;
        }
        return n;
      };
      // One video update on both twins; true when the message band differs from the twin's (the line is drawn).
      const step = (a, b) => { a.update(quiet); b.update(quiet); return bandAll(a.screen.pixels, b.screen.pixels) > 0; };
      // The first `count` updates after the posting update, plus the posting update itself.
      const shownFrom = (a, b, count) => { const shown = [step(a, b)]; for (let k = 0; k < count; k++) shown.push(step(a, b)); return shown; };
      const more = (a, b, count) => { const shown = []; for (let k = 0; k < count; k++) shown.push(step(a, b)); return shown; };
      const drawnLength = (shown) => { const off = shown.indexOf(false); return off < 0 ? shown.length : off; };
      const alignBefore = (a, b) => { while (a.loop.updatesIntoPass < a.loop.vblPerPass - 1) { a.update(quiet); b.update(quiet); } };

      {
        // A pass-body line: the enemy pass ($333A) posts it before the pass's draw. Drawn in the posting update, timer 200, 200 frames.
        const a = fresh(), b = fresh();
        check("pass-body line: the scene has an enemy system to post from", a.enemies !== null);
        alignBefore(a, b);
        const enemies = a.enemies;
        const pass = enemies.pass;
        enemies.pass = function (clock) { a.say(LINE_PASS); return pass.call(this, clock); };
        const shown = shownFrom(a, b, 0);
        delete enemies.pass;
        check("pass-body line: the posting update is a pass and the timer reads 200 there (no tick before the draw)", a.loop.passes === b.loop.passes && a.messages.inspect().lineFramesLeft === 200, `timer=${a.messages.inspect().lineFramesLeft}`);
        check("pass-body line: drawn in the posting update", shown[0] === true, `shown=${shown[0]}`);
        const all = [shown[0], ...more(a, b, 205)];
        check("pass-body line: drawn for exactly 200 updates, the posting one included", drawnLength(all) === 200 && all[200] === false, `drawn=${drawnLength(all)}`);
      }
      {
        // A pass-body log entry over an active line does not hold or restart the line: the timer matches the twin.
        const a = fresh(), b = fresh();
        a.say(0x10a); b.say(0x10a);
        for (let k = 0; k < 10; k++) { a.update(quiet); b.update(quiet); }
        alignBefore(a, b);
        const pass = a.enemies.pass;
        a.enemies.pass = function (clock) { a.say(LOG); return pass.call(this, clock); };
        step(a, b);
        delete a.enemies.pass;
        check("pass-body log entry over a line: the log is in the panel and the line timer matches the twin", a.messages.inspect().log.length === 1 && a.messages.inspect().lineFramesLeft === b.messages.inspect().lineFramesLeft, `a=${a.messages.inspect().lineFramesLeft} b=${b.messages.inspect().lineFramesLeft}`);
      }
      {
        // A pass-body line over an active line restarts at 200 once and is drawn in the posting update.
        const a = fresh(), b = fresh();
        a.say(0x10a); b.say(0x10a);
        for (let k = 0; k < 20; k++) { a.update(quiet); b.update(quiet); }
        alignBefore(a, b);
        const pass = a.enemies.pass;
        a.enemies.pass = function (clock) { a.say(LINE_PASS); return pass.call(this, clock); };
        const shown = [step(a, b)];
        delete a.enemies.pass;
        check("pass-body line over an active line: the new line reads 200 in the posting update and is drawn there", a.messages.inspect().lineFramesLeft === 200 && shown[0] === true, `timer=${a.messages.inspect().lineFramesLeft} shown=${shown[0]}`);
      }
      {
        // A post-wait refusal (the arson event's demolition refusal `$58`): the cell has tile $70, which no record holds, so
        // `$7372` says $58. The periodic work ($99C4) runs in the posting update after the pass draw; the line is drawn there.
        const a = fresh(), b = fresh();
        const vx = 0, vy = 0;
        const x = a.scrollX + vx, y = a.scrollY + vy;
        const i = y * MAP_WIDTH + x;
        a.world.cells[i] = (a.world.cells[i] & 0xff00) | 0x70;
        b.world.cells[i] = (b.world.cells[i] & 0xff00) | 0x70;
        alignBefore(a, b);
        const run = a.sim.run;
        a.sim.run = function () { this.bomb(x, y); return run.call(this); };
        const shown = [step(a, b)];
        delete a.sim.run;
        check("post-wait refusal: the posting update is a pass and the line timer reads 200 there", a.loop.passes === b.loop.passes + 0 && a.messages.inspect().lineFramesLeft === 200, `timer=${a.messages.inspect().lineFramesLeft}`);
        check("post-wait refusal: drawn in the posting update (the $99C4 message is drawn at once)", shown[0] === true, `shown=${shown[0]}`);
        const all = [shown[0], ...more(a, b, 205)];
        check("post-wait refusal: drawn for exactly 200 updates from the posting one", drawnLength(all) === 200 && all[200] === false, `drawn=${drawnLength(all)}`);
      }
      // The key cell (MapScene.foldKeys): a batch is folded in order in the update it arrives in, and the completed pass's poll dispatches
      // the cell's last entry only (`$2BC2` overwrites `$161A0`; `$15B4A` reads and clears it once per pass; game-proper.md, Keyboard).
      // A release entry (`keyUpToken`) overwrites a key and dispatches nothing. `windowKeyRun` runs updates until a pass completes.
      const windowKeyRun = (a, b, keys) => {
        const input = { ...quiet, keys };
        const passes0 = a.loop.passes;
        let k = 0;
        while (a.loop.passes === passes0 && k < 8) { a.update(input); b.update(quiet); k++; }
        return { k, drawn: bandAll(a.screen.pixels, b.screen.pixels) > 0 };
      };
      {
        // F1-F6 refusal: the arrival update folds the key into the cell and posts nothing; the completed pass dispatches it in its poll
        // (timer 200), and the line is drawn in that pass's update for exactly 200 updates.
        const a = fresh(), b = fresh();
        const taken = [];
        a.onWindowKey = (key) => { taken.push(key); a.say(LINE_KEY); };
        const keys = ["F1"];
        const passes0 = a.loop.passes;
        a.update({ ...quiet, keys }); b.update(quiet);
        check("F-key refusal: a non-pass update folds the key into the cell: no window, no line, nothing taken", a.loop.passes === passes0 && taken.length === 0 && keys.length === 0 && a.messages.inspect().lineFramesLeft === 0, `passes=${a.loop.passes - passes0} taken=${taken} keys=${keys.length}`);
        const at = windowKeyRun(a, b, []);
        check("F-key refusal: the completed pass dispatches the cell (taken once, timer 200)", taken.join() === "F1" && a.messages.inspect().lineFramesLeft === 200, `taken=${taken} timer=${a.messages.inspect().lineFramesLeft}`);
        check("F-key refusal: the line is drawn in the pass update that dispatched the key", at.drawn === true, `drawn=${at.drawn}`);
        const all = [at.drawn, ...more(a, b, 205)];
        check("F-key refusal: drawn for exactly 200 updates from the pass update", drawnLength(all) === 200 && all[200] === false, `drawn=${drawnLength(all)}`);
      }
      {
        // A window key whose poll says a log string does not hold the active line: the line timer matches the twin.
        const a = fresh(), b = fresh();
        a.say(0x10a); b.say(0x10a);
        for (let k = 0; k < 10; k++) { a.update(quiet); b.update(quiet); }
        a.onWindowKey = () => a.say(LOG);
        windowKeyRun(a, b, ["F2"]);
        check("F-key log entry over a line: the log is in the panel and the line timer matches the twin", a.messages.inspect().log.length === 1 && a.messages.inspect().lineFramesLeft === b.messages.inspect().lineFramesLeft, `a=${a.messages.inspect().lineFramesLeft} b=${b.messages.inspect().lineFramesLeft}`);
      }
      {
        // Two window keys in one batch: the cell keeps only the last entry. F2 is dispatched once and F1 is overwritten, not replayed
        // by the later passes.
        const a = fresh();
        const taken = [];
        a.onWindowKey = (key) => taken.push(key);
        const passes0 = a.loop.passes;
        a.update({ ...quiet, keys: ["F1", "F2"] });
        while (a.loop.passes < passes0 + 3) a.update(quiet);
        check("two window keys in one batch: the pass dispatches the last (F2) once; F1 is not replayed", taken.join() === "F2", `taken=${taken}`);
      }
      {
        // A window key overwritten by a later key of the same batch: F1 then "1" leaves "1" in the cell, so no window opens and key 1
        // places pin 1 under the pointer of the pass (the pointer is held over a map cell for the whole run).
        const a = fresh();
        const taken = [];
        a.onWindowKey = (key) => taken.push(key);
        const over = (keys) => ({ leftButton: false, rightButton: false, pointerX: 127, pointerY: 31, keys });
        const before = JSON.stringify(a.objects.markers);
        a.update(over(["F1", "1"]));
        const passes0 = a.loop.passes;
        let k = 0;
        while (a.loop.passes === passes0 && k++ < 8) a.update(over([]));
        check("F1 then 1 in one batch: no window (F1 overwritten), and pin 1 is placed by the pass", taken.length === 0 && JSON.stringify(a.objects.markers) !== before, `taken=${taken}`);
      }
      {
        // Pins are keys 1-8 of the top row only ($15C3C-$15C50 dispatch raw $01-$08; the keypad codes are $0F, $1D-$3F). A keypad digit
        // (intro.ts keypadToken) places nothing; the top-row "1" (control) places pin 1 under the same pointer.
        const { keypadToken } = await import("../dist/game/intro.js");
        const over = (keys) => ({ leftButton: false, rightButton: false, pointerX: 127, pointerY: 31, keys });
        const pinAfter = (key) => {
          const scene = fresh();
          const before = JSON.stringify(scene.objects.markers);
          scene.update(over([key]));
          const passes0 = scene.loop.passes;
          let k = 0;
          while (scene.loop.passes === passes0 && k++ < 8) scene.update(over([]));
          return { changed: JSON.stringify(scene.objects.markers) !== before, passed: scene.loop.passes !== passes0 };
        };
        const keypad = pinAfter(keypadToken("1"));
        const topRow = pinAfter("1");
        check("keypad 1 is not a pin key: the pass completes and places nothing", keypad.passed && !keypad.changed, JSON.stringify(keypad));
        check("top-row 1 (control) places pin 1 in the same position", topRow.passed && topRow.changed, JSON.stringify(topRow));
      }
      {
        // A key released before the pass overwrites it: F1 down and up in one batch dispatches nothing over two passes.
        const { keyUpToken } = await import("../dist/game/intro.js");
        const a = fresh();
        const taken = [];
        a.onWindowKey = (key) => taken.push(key);
        const passes0 = a.loop.passes;
        a.update({ ...quiet, keys: ["F1", keyUpToken("F1")] });
        while (a.loop.passes < passes0 + 2) a.update(quiet);
        check("F1 down then up before the pass: nothing dispatched", taken.length === 0, `taken=${taken}`);
      }
      {
        // The build menu does not read the key cell ($B3D8 reaches neither $15B4A nor the key readers, screens.md section 3). A key
        // pressed in it and still held when it closes is in the cell, so the first pass after the close dispatches it.
        const { keyUpToken } = await import("../dist/game/intro.js");
        const menuAt = (keys = [], leftButton = false) => ({ leftButton, rightButton: false, pointerX: 272, pointerY: 63, keys });
        const exitAt = () => ({ leftButton: true, rightButton: false, pointerX: 272, pointerY: 139, keys: [] });
        const openMenu = (a) => {
          for (let n = 0; n < 4; n++) a.update(menuAt([], true));
          for (let n = 0; n < 4; n++) a.update(menuAt());
          return a.controls.menuVisible;
        };
        const closeMenu = (a) => {
          for (let n = 0; n < 4; n++) a.update(exitAt());
          for (let n = 0; n < 10 && a.controls.menuVisible; n++) a.update(quiet);
          return !a.controls.menuVisible;
        };
        // Runs updates until the first completed pass after the close; returns the window keys dispatched so far.
        const firstPassAfterClose = (a, taken) => {
          const passes0 = a.loop.passes;
          let k = 0;
          while (a.loop.passes === passes0 && k++ < 8) a.update(quiet);
          return taken.slice();
        };
        {
          const a = fresh(), taken = [];
          a.onWindowKey = (key) => taken.push(key);
          check("F-key modal (held): the build menu opens", openMenu(a));
          a.update(menuAt(["F1"]));
          for (let n = 0; n < 8; n++) a.update(menuAt());
          check("F-key modal (held): nothing is dispatched while the menu is open", taken.length === 0 && a.controls.menuVisible, `taken=${taken}`);
          check("F-key modal (held): the menu closes", closeMenu(a));
          check("F-key modal (held): the first pass after the close dispatches the held F1", firstPassAfterClose(a, taken).join() === "F1", `taken=${taken}`);
        }
        {
          // Pressed and released inside the menu: the release overwrites the cell, so nothing is dispatched after the close.
          const a = fresh(), taken = [];
          a.onWindowKey = (key) => taken.push(key);
          openMenu(a);
          a.update(menuAt(["F1"]));
          a.update(menuAt([keyUpToken("F1")]));
          check("F-key modal (tapped): the menu closes", closeMenu(a));
          const after = firstPassAfterClose(a, taken);
          for (let n = 0; n < 8; n++) a.update(quiet);
          check("F-key modal (tapped): a key released in the menu is not dispatched after the close", after.length === 0 && taken.length === 0, `taken=${taken}`);
        }
        {
          // Two keys in the menu: the cell keeps the last, so only F2 is dispatched after the close.
          const a = fresh(), taken = [];
          a.onWindowKey = (key) => taken.push(key);
          openMenu(a);
          a.update(menuAt(["F1"]));
          a.update(menuAt(["F2"]));
          check("F-key modal (two keys): the menu closes", closeMenu(a));
          const after = firstPassAfterClose(a, taken);
          check("F-key modal (two keys): only the last key (F2) is dispatched after the close", after.join() === "F2", `taken=${after}`);
          for (let n = 0; n < 8; n++) a.update(quiet);
          check("F-key modal (two keys): F1 is not replayed", taken.join() === "F2", `taken=${taken}`);
        }
      }
    }

    // ---- 7d. Lifetimes of poll-posted lines are unchanged: 200 drawn frames (the posting update, then 199) ---------------------
    // The modal-exit hold (section 6) must not reach these: a poll-posted line is drawn at 200 and its first tick is on the next
    // update. Each case runs on a fresh scene from the same inputs; `updates` counts the quiet updates until the timer reads 0.
    {
      const lifetime = (setup, money, inputs) => {
        const c = fresh(setup, money);
        for (const input of inputs) passWith(c, input);
        const at0 = c.messages.inspect().lineFramesLeft;
        let k = 0;
        while (c.messages.inspect().lineFramesLeft > 0 && k < 1000) { c.update(quiet); k++; }
        return { at0, k };
      };
      const keyInput = (key, x, y) => ({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [key] });
      // Finds the first cell (as sections 7 and 8) where a placement (`leave`) or a clearing refusal is taken: the press that refuses.
      const refusalCell = (setup, money, refused) => {
        for (let vy = 0; vy < 8; vy++) for (let vx = 0; vx < 8; vx++) {
          const px = 112 + 16 * (vx - vy) + 15, py = 24 + 8 * (vx + vy) + 7;
          const d = fresh(setup, money);
          passWith(d, at(true, px, py));
          if (refused(d) && d.messages.inspect().lineFramesLeft === 200) return { px, py };
        }
        return null;
      };
      const clearing = (m) => { m.controls.mode = "build"; m.controls.selection = { tile: 0x61, type: m.world.findType(0x61) }; };
      const placing = (m) => build(m);
      const placedRefused = (d) => d.controls.mode === "select";
      const clearRefused = (d) => d.controls.selection === null && d.controls.mode === "build";
      const cases = [
        ["marker release (select)", undefined, 500000, [at(true, 300, 90), at(false, 300, 90)]],
        ["marker release (build)", build, 500000, [at(true, 300, 90), at(false, 300, 90)]],
        ["key D (clear pins)", undefined, 500000, [keyInput("d", 20, 20)]],
        ["pin key 1 on a map cell", undefined, 500000, [keyInput("1", 127, 31)]],
        ["marker pin click", undefined, 500000, [at(true, 300, 90), at(false, 300, 90), at(true, 127, 31)]],
      ];
      for (const [label, setup, money, inputs] of cases) {
        const r = lifetime(setup, money, inputs);
        check(`${label}: 200 drawn frames (timer 200 at the posting update, cleared on the 200th update after it)`, r.at0 === 200 && r.k === 200, `at0=${r.at0} updates=${r.k}`);
      }
      const place = refusalCell(placing, 100, placedRefused);
      check("money refusal while placing: a refusing cell is found", place !== null);
      if (place) {
        const r = lifetime(placing, 100, [at(true, place.px, place.py)]);
        check("money refusal while placing: 200 drawn frames", r.at0 === 200 && r.k === 200, `at0=${r.at0} updates=${r.k}`);
      }
      const clear = refusalCell(clearing, 100, clearRefused);
      check("clearing refusal: a refusing cell is found", clear !== null);
      if (clear) {
        const r = lifetime(clearing, 100, [at(true, clear.px, clear.py)]);
        check("clearing refusal: 200 drawn frames", r.at0 === 200 && r.k === 200, `at0=${r.at0} updates=${r.k}`);
      }
    }

    // ---- 7e. A pass-time line (sim.messages, spliced in the completed pass's update) has 200 drawn frames like a poll line --
    // `$551A` (Disk.1, pass body) sets 200 at the draw in the pass; the VBL decrement comes after it. The remake drew it at 199
    // before the splice held its tick (2026-11-13). Log messages and a line replaced by a later line keep their own timers.
    {
      const LINE = 84; // a line string (not in LOG_INDICES, text non-empty)
      const LOG = 82; // a log string (in LOG_INDICES)
      // Quiet updates up to the update before the boundary, then the message is posted, then the boundary update runs the pass.
      const passPosting = (m, indices) => {
        while (m.loop.updatesIntoPass < m.loop.vblPerPass - 1) m.update(quiet);
        const n = m.loop.passes;
        for (const index of indices) m.sim.msg(index);
        m.update(quiet);
        return m.loop.passes === n + 1;
      };
      const drawnFrames = (m) => {
        let k = 0;
        while (m.messages.inspect().lineFramesLeft > 0 && k < 1000) { m.update(quiet); k++; }
        return k;
      };
      const a = fresh();
      const ranA = passPosting(a, [LINE]);
      const atA = a.messages.inspect().lineFramesLeft;
      const kA = drawnFrames(a);
      check("pass-time line: the pass ran and the line timer reads 200 in its posting update", ranA && atA === 200, `pass=${ranA} timer=${atA}`);
      check("pass-time line: 200 drawn frames (the posting update, then 199), like a poll-posted line", kA === 200, `updates=${kA}`);

      // A pass-time log message does not hold or restart the line: the twin posts nothing in that pass.
      const withLog = fresh();
      const twinLog = fresh();
      passPosting(withLog, [LINE]);
      passPosting(twinLog, [LINE]);
      for (let i = 0; i < 10; i++) { withLog.update(quiet); twinLog.update(quiet); }
      const ranLog = passPosting(withLog, [LOG]);
      const twinRan = passPosting(twinLog, []);
      check("pass-time log message: its pass ran, the line timer matches the twin (the log does not hold it)", ranLog && twinRan && withLog.messages.inspect().lineFramesLeft === twinLog.messages.inspect().lineFramesLeft, `log=${withLog.messages.inspect().lineFramesLeft} twin=${twinLog.messages.inspect().lineFramesLeft}`);
      check("pass-time log message: it still goes to the log panel, not the line", withLog.messages.inspect().log.length === 1 && twinLog.messages.inspect().log.length === 0);

      // A pass-time line that replaces an active line restarts at 200 once, with the same held first tick.
      const replace = fresh();
      passPosting(replace, [LINE]);
      for (let i = 0; i < 20; i++) replace.update(quiet);
      const ranR = passPosting(replace, [LINE]);
      const atR = replace.messages.inspect().lineFramesLeft;
      check("pass-time line over an active line: the new line reads 200 in its posting update", ranR && atR === 200, `pass=${ranR} timer=${atR}`);
    }

    // ---- 7f. A message posted by `Sim.runAfterVblWait()` ($99C4, after the completed pass's draw) is shown in its posting update ---
    // The original's `$99C4` runs after the VBL wait, and `$551A` / `$5A8C` draw at once and set 200 there. The remake used to splice
    // these messages in the next update, so they were drawn at the next completed pass, up to a pass late (and already ticked).
    // Each case compares the posting scene with a quiet twin: the band (rows 160..199) must differ from the twin in the posting update.
    {
      const LINE = 84; // a line string
      const LOG = 82; // a log string (in LOG_INDICES)
      const bandOf = (m) => m.screen.pixels.slice(160 * 320, 200 * 320);
      const differs = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
      // Posts `indices` from `runAfterVblWait`, once, after the wrapped call (as `$99C4` does), then restores the method.
      const postAfterWait = (m, indices) => {
        const orig = m.sim.runAfterVblWait.bind(m.sim);
        m.sim.runAfterVblWait = () => {
          orig();
          for (const index of indices) m.sim.msg(index);
          m.sim.runAfterVblWait = orig;
        };
      };
      // Runs the boundary update on both scenes: the posting one gets `indices` posted from `$99C4`, the twin posts nothing.
      const boundary = (indices) => {
        const a = fresh();
        const b = fresh();
        while (a.loop.updatesIntoPass < a.loop.vblPerPass - 1) { a.update(quiet); b.update(quiet); }
        postAfterWait(a, indices);
        const n = a.loop.passes;
        a.update(quiet);
        b.update(quiet);
        return { a, b, ran: a.loop.passes === n + 1 && b.loop.passes === n + 1 };
      };
      // Quiet updates on both scenes until the posting scene's next completed pass (its draw of the band).
      const nextPass = (m, t) => {
        const n = m.loop.passes;
        while (m.loop.passes === n) { m.update(quiet); t.update(quiet); }
      };

      const line = boundary([LINE]);
      check("post-wait line: the pass ran in both scenes", line.ran);
      check("post-wait line: its timer reads 200 in the posting update (no tick in that update)", line.a.messages.inspect().lineFramesLeft === 200, `timer=${line.a.messages.inspect().lineFramesLeft}`);
      const shownAtPost = differs(bandOf(line.a), bandOf(line.b));
      check("post-wait line: the posting update's frame shows the line (band differs from the twin)", shownAtPost > 0, `differs=${shownAtPost}`);
      const atPost = bandOf(line.a);
      line.a.update(quiet);
      line.b.update(quiet);
      check("post-wait line: the next update ticks it to 199 (first tick after the posting update)", line.a.messages.inspect().lineFramesLeft === 199, `timer=${line.a.messages.inspect().lineFramesLeft}`);
      nextPass(line.a, line.b);
      check("post-wait line: the band shown at the posting update equals the band of the next completed pass", differs(atPost, bandOf(line.a)) === 0, `differs=${differs(atPost, bandOf(line.a))}`);

      const logCase = boundary([LOG]);
      check("post-wait log message: the posting update's frame shows the log entry (band differs from the twin)", differs(bandOf(logCase.a), bandOf(logCase.b)) > 0);
      check("post-wait log message: it goes to the log panel, not the line (line timer 0, one log entry; the twin has none)", logCase.a.messages.inspect().lineFramesLeft === 0 && logCase.a.messages.inspect().log.length === 1 && logCase.b.messages.inspect().log.length === 0);
    }

    // ---- 7g. Expiry: the line's pixels go in the update its timer reaches 0 ($2CAA -> $558A); the log's go with the next pass ----
    // `$2CAA` decrements `$156AC` in the VBL and calls `$558A` in the VBL that makes it 0, so the line's glyph rows (160..165)
    // are back to the picture in that update. The log's idle counter `$14634` is also decremented in the VBL, but its clear is
    // the main-loop check `$15850`, which runs after the wait of the next pass (4 updates per pass): its pixels stay until then.
    // The scene is aligned to phase 1 (not a pass boundary) and the message is pushed between updates, so the expiry (200 or 500
    // updates later, both multiples of 4 apart from the phase) falls on a non-pass update. Each run has a quiet twin.
    {
      const LINE = 84; // a line string (not in LOG_INDICES)
      const LOG = 82; // a log string (in LOG_INDICES)
      const GLYPH_FIRST = 160, GLYPH_LAST = 165, PANEL_FIRST = 171, PANEL_LAST = 194;
      const rowsOf = (m, y0, y1) => m.screen.pixels.slice(y0 * 320, (y1 + 1) * 320);
      const diffOf = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
      const aligned = () => {
        const a = fresh();
        const b = fresh();
        while (a.loop.updatesIntoPass !== 1) { a.update(quiet); b.update(quiet); }
        return { a, b };
      };

      // The line: pushed at phase 1, 200 updates to 0. The timer reads 200 right after the push.
      {
        const { a, b } = aligned();
        a.messages.push(LINE);
        check("line expiry: pushed at phase 1, the timer reads 200 before the next update", a.messages.inspect().lineFramesLeft === 200);
        let k = 0;
        let expiredAt = -1;
        let shownBeforeExpiry = 0;
        let passDuringExpiry = null;
        let beforeExpiry = null;
        while (k < 260 && expiredAt < 0) {
          const n = a.loop.passes;
          const prev = rowsOf(a, GLYPH_FIRST, GLYPH_LAST);
          a.update(quiet);
          b.update(quiet);
          k++;
          const left = a.messages.inspect().lineFramesLeft;
          if (left === 0) {
            expiredAt = k;
            passDuringExpiry = a.loop.passes !== n;
            beforeExpiry = prev;
            break;
          }
          if (diffOf(rowsOf(a, GLYPH_FIRST, GLYPH_LAST), rowsOf(b, GLYPH_FIRST, GLYPH_LAST)) > 0) shownBeforeExpiry++;
        }
        check("line expiry: the line is 200 updates after the push (timer 200 -> 0 with no pass hold)", expiredAt === 200, `expiredAt=${expiredAt}`);
        check("line expiry: the expiry update is not a completed pass (so only the expiry presentation can erase it)", passDuringExpiry === false, `pass=${passDuringExpiry}`);
        check("line expiry: the line is drawn in the updates before the expiry (glyph rows differ from the twin)", shownBeforeExpiry >= 150, `shown=${shownBeforeExpiry}`);
        const glyphsAtExpiry = diffOf(rowsOf(a, GLYPH_FIRST, GLYPH_LAST), rowsOf(b, GLYPH_FIRST, GLYPH_LAST));
        check("line expiry: the glyph rows equal the twin in the expiry update itself (erased in the VBL that reaches 0)", glyphsAtExpiry === 0, `differs=${glyphsAtExpiry}`);
        check("line expiry: the expiry update changed the glyph rows (the line was on the frame before it)", diffOf(beforeExpiry, rowsOf(a, GLYPH_FIRST, GLYPH_LAST)) > 0);
        // Neither presentation draws anything else: the rest of the frame stays equal to the twin.
        let other = 0;
        const all = a.screen.pixels, twin = b.screen.pixels;
        for (let i = 0; i < all.length; i++) if (all[i] !== twin[i] && (((i / 320) | 0) < GLYPH_FIRST || ((i / 320) | 0) > GLYPH_LAST)) other++;
        check("line expiry: nothing outside the glyph rows differs from the twin in the expiry update", other === 0, `differs=${other}`);
        check("line expiry: the presentation does not change the timer (0 after the expiry, no extra tick)", a.messages.inspect().lineFramesLeft === 0);
        // The next completed pass must not redraw the line.
        const cntBefore = a.loop.passes;
        while (a.loop.passes === cntBefore) { a.update(quiet); b.update(quiet); }
        check("line expiry: after the expiry the next pass shows no line either (glyph rows equal the twin)", diffOf(rowsOf(a, GLYPH_FIRST, GLYPH_LAST), rowsOf(b, GLYPH_FIRST, GLYPH_LAST)) === 0);
      }

      // The log: pushed at phase 1, cleared 500 updates later by the idle counter. Its pixels stay until the next completed pass.
      {
        const { a, b } = aligned();
        a.messages.push(LOG);
        const panelOf = (m) => rowsOf(m, PANEL_FIRST, PANEL_LAST);
        let k = 0;
        let expiredAt = -1;
        let before = null;
        while (k < 600 && expiredAt < 0) {
          const n = a.loop.passes;
          const prev = panelOf(a);
          a.update(quiet);
          b.update(quiet);
          k++;
          if (a.messages.inspect().logIdleFrames === 0) {
            expiredAt = k;
            before = { prev, passes: n };
            break;
          }
        }
        check("log expiry: the idle counter reaches 0 after 500 updates from the push", expiredAt === 500, `expiredAt=${expiredAt}`);
        const atExpiry = panelOf(a);
        check("log expiry: the expiry update is not a completed pass (so the erase waits for the next pass)", a.loop.passes === before.passes, `passes=${a.loop.passes} before=${before.passes}`);
        check("log expiry: the log text was on the panel before the expiry (differs from the twin)", diffOf(before.prev, panelOf(b)) > 0);
        check("log expiry: the log pixels are not erased in the expiry update itself (main-loop check, next pass)", diffOf(atExpiry, before.prev) === 0, `differs=${diffOf(atExpiry, before.prev)}`);
        const passStart = a.loop.passes;
        while (a.loop.passes === passStart) { a.update(quiet); b.update(quiet); }
        check("log expiry: the next completed pass erases the panel (differs from the text panel)", diffOf(panelOf(a), before.prev) > 0);
      }
    }

    // ---- 7h. Row 159: `$558A` restores 7 rows from y 159 (full width) at the line's expiry; the remake repaints the same rows ----
    // Static trace (game-text.md section 4): the expiry erase copies the setup strip (the picture) into rows 159..165 of both bitmaps.
    // The remake's row 159 already equals the picture in every state probed (select, build and demolish, pointer grid, scrolls), so
    // this section checks the mechanism directly: row 159 is poked with values that differ from the picture in the frame before the
    // expiry, and the expiry update must put the picture back there, without touching any other row outside 159..165.
    {
      const LINE = 84;
      const ROW = 159, ROW_LAST = 165;
      const rowOf = (px, y) => px.slice(y * 320, (y + 1) * 320);
      const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
      const modesToCheck = [
        ["select", () => {}],
        ["build", (m) => { m.controls.mode = "build"; m.controls.selection = { tile: 0x45, type: 22 }; }],
        ["demolish", (m) => { m.controls.mode = "demolish"; }],
      ];
      for (const [name, setup] of modesToCheck) {
        const a = fresh(setup), b = fresh(setup);
        while (a.loop.updatesIntoPass !== 1) { a.update(quiet); b.update(quiet); }
        const pic = a.initialPicture;
        a.messages.push(LINE);
        while (a.messages.inspect().lineFramesLeft > 1) { a.update(quiet); b.update(quiet); }
        // One update before the expiry: row 159 holds values the picture does not have (XOR 1 on every pixel of the row).
        for (let x = 0; x < 320; x++) a.screen.pixels[ROW * 320 + x] = pic[ROW * 320 + x] ^ 1;
        const pokedFrame = a.screen.pixels.slice();
        const passesBefore = a.loop.passes;
        a.update(quiet); b.update(quiet);
        check(`${name}: the expiry update is not a completed pass (the erase is the expiry's own presentation)`, a.loop.passes === passesBefore && a.messages.inspect().lineFramesLeft === 0);
        check(`${name}: the poked row was in the frame before the expiry (the check can fail)`, !same(rowOf(pokedFrame, ROW), rowOf(pic, ROW)));
        check(`${name}: after the expiry row 159 equals the setup picture across x 0..319 (as $558A restores it)`, same(rowOf(a.screen.pixels, ROW), rowOf(pic, ROW)));
        let other = 0;
        for (let i = 0; i < a.screen.pixels.length; i++) {
          const y = (i / 320) | 0;
          if ((y < ROW || y > ROW_LAST) && a.screen.pixels[i] !== pokedFrame[i]) other++;
        }
        check(`${name}: the expiry update changes nothing outside rows 159..165`, other === 0, `differs=${other}`);
        check(`${name}: row 159 of the expiry frame equals the quiet twin (no line, same state)`, same(rowOf(a.screen.pixels, ROW), rowOf(b.screen.pixels, ROW)));
        // The next completed pass keeps row 159 and the glyph rows equal to the twin.
        const passStart = a.loop.passes;
        while (a.loop.passes === passStart) { a.update(quiet); b.update(quiet); }
        check(`${name}: the next pass keeps rows 159..165 equal to the twin`, same(rowOf(a.screen.pixels, ROW), rowOf(b.screen.pixels, ROW)) && [160, 161, 162, 163, 164, 165].every((y) => same(rowOf(a.screen.pixels, y), rowOf(b.screen.pixels, y))));
      }
    }

    // ---- 7i. Expiry while the build menu is open: the menu's exit frame must not show the expired line ----
    // The modal frame is drawn from the persistent buffer and `controls.draw` covers the glyph rows, so the modal frame itself was
    // clean; but the exit (`modalAtStart` branch) rebuilds the frame from the buffer, which kept the line until this slice (one
    // displayed update of stale glyph rows, 145 pixels, measured 2026-11-13). `$558A` writes both bitmaps, so the exit frame has none.
    {
      const LINE = 84;
      const press = { leftButton: true, rightButton: false, pointerX: 272, pointerY: 63, keys: [] };
      const exitPress = { leftButton: true, rightButton: false, pointerX: 272, pointerY: 139, keys: [] };
      const band = (px) => px.slice(159 * 320, 166 * 320);
      const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
      const a = fresh(), b = fresh();
      while (a.loop.updatesIntoPass !== 1) { a.update(quiet); b.update(quiet); }
      a.messages.push(LINE);
      for (let i = 0; i < 12 && !a.controls.menuVisible; i++) {
        const input = i < 4 ? press : quiet;
        a.update(input);
        b.update(input);
      }
      check("line and menu: the build menu opens while the line shows", a.controls.menuVisible && a.messages.lineShowing && !b.messages.lineShowing);
      a.update(quiet); b.update(quiet);
      check("line and menu: the line is drawn in the modal frame before it expires (the check can fail)", !same(band(a.screen.pixels), band(b.screen.pixels)));
      let waited = 0;
      while (a.messages.lineShowing && waited < 400) { a.update(quiet); b.update(quiet); waited++; }
      check("line and menu: the line expires while the menu stays open", !a.messages.lineShowing && a.controls.menuVisible);
      check("line and menu: the expiry's modal frame has no line in rows 159..165", same(band(a.screen.pixels), band(b.screen.pixels)));
      for (let i = 0; i < 4; i++) { a.update(exitPress); b.update(exitPress); }
      for (let i = 0; i < 10 && a.controls.menuVisible; i++) { a.update(quiet); b.update(quiet); }
      check("line and menu: the menu exit ran (modal exit frame)", !a.controls.menuVisible && !b.controls.menuVisible);
      check("line and menu: the exit frame has no expired line in rows 159..165", same(band(a.screen.pixels), band(b.screen.pixels)));
      check("line and menu: the exit frame equals the quiet twin across the whole frame", same(a.screen.pixels, b.screen.pixels));
      const passStart = a.loop.passes;
      while (a.loop.passes === passStart) { a.update(quiet); b.update(quiet); }
      check("line and menu: the next pass equals the quiet twin across the whole frame", same(a.screen.pixels, b.screen.pixels));
    }

    // ---- 7c. The key cell is the pointer sampled in the poll's own update (`$14636/37`, units.md, map-rendering.md 7.5) ----
    // The original's key cell `$14636/37` is written only by `$5CDA`: by the VBL handler `$2FBA` after `$2CDA` has updated the
    // pointer (`$161A6/8` are written nowhere else), and by a same-poll left press (`$158CA`) or right press (`$15F78` -> `$3EDC`).
    // The main loop polls right after the VBL that ends its wait, so with no press the key reads the pointer of that VBL. The
    // remake samples the pointer once per update and uses that one sample for the key and the hover (`MapScene.update`). This
    // section pins that model. It does not reproduce the original's VBL-latched timing (see the handoff, open points).
    {
      const keyInputAt = (key, x, y) => ({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [key] });
      const a = fresh(), b = fresh();
      const X1 = a.controls.pickCell(127, 31), X2 = a.controls.pickCell(150, 60);
      check("key cell: both test pointers are over map cells, and they are different cells", X1 !== null && X2 !== null && (X1.x !== X2.x || X1.y !== X2.y), `${JSON.stringify(X1)} ${JSON.stringify(X2)}`);
      check("key cell: the scene has an object layer (pins)", a.objects !== null);
      // (1) The pointer hovers X1 in every earlier update of the pass, then moves to X2 in the poll's update: pin 1 goes to X2.
      {
        const n = a.loop.passes;
        while (a.loop.updatesIntoPass < a.loop.vblPerPass - 1) a.update(at(false, 127, 31));
        a.update(keyInputAt("1", 150, 60));
        check("key cell: the poll update completes the pass", a.loop.passes === n + 1);
        check("key cell: pin 1 goes to the poll update's pointer cell (X2), not the cell hovered before", a.objects.markers[0].x === X2.x && a.objects.markers[0].y === X2.y, `pin=${a.objects.markers[0].x},${a.objects.markers[0].y} X2=${X2.x},${X2.y}`);
        check("key cell: the other pins stay unplaced", a.objects.markers.slice(1).every((pin) => pin.y === b.objects.markers[pin.type - 1].y));
      }
      // (2) The pointer hovers X1 in the earlier updates, then is off the map in the poll update: no pin, no message.
      {
        const c = fresh();
        while (c.loop.updatesIntoPass < c.loop.vblPerPass - 1) c.update(at(false, 127, 31));
        const before = JSON.stringify(c.objects.markers);
        c.update(keyInputAt("1", 20, 20));
        check("key cell: an off-map poll update places no pin even after an on-map hover", JSON.stringify(c.objects.markers) === before);
        check("key cell: an off-map poll update posts no message line", c.messages.inspect().lineFramesLeft === 0);
      }
    }

    // ---- 8. A clearing refusal removes the building preview in its frame ($6D10 -> $6ACE -> $6D2C, Disk.1 static trace) -------
    // `$6ACE` restores rows 7..51 of x 256..319 from the saved panel background before `$6D2C` posts `$25`, so the preview (rows 22..52)
    // leaves the bitmaps at once. Its bottom row (52) is outside that restore and stays until a mode tile is drawn. The twin still
    // shows the preview (it had no refusal). Checks: rows 22..51 equal the picture in the press frame and after the next pass; row 52
    // keeps the preview's pixels in both frames (they differ from the picture and match the twin); the twin differs only in the panel
    // box and the message band; no pass, money or simulation change beyond the twin's; a mode tile drops the stored row.
    {
      const clearing = (m) => { m.controls.mode = "build"; m.controls.selection = { tile: 0x61, type: m.world.findType(0x61) }; };
      const a = fresh(clearing, 100), b = fresh(clearing, 100);
      const P = a.initialPicture;
      const panelRowsDiff = (pix, y0, y1) => { let n = 0; for (let y = y0; y <= y1; y++) for (let x = 272; x <= 319; x++) if (pix[y * 320 + x] !== P[y * 320 + x]) n++; return n; };
      const row52 = (pix) => pix.slice(52 * 320 + 272, 52 * 320 + 320);
      const sameArray = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
      let refused = false;
      for (let vy = 0; vy < 8 && !refused; vy++) for (let vx = 0; vx < 8 && !refused; vx++) {
        const px = 112 + 16 * (vx - vy) + 15, py = 24 + 8 * (vx + vy) + 7;
        const r = pair(a, b, at(true, px, py));
        if (a.controls.selection === null && a.controls.mode === "build") {
          refused = true;
          check("clearing refusal: the twin still shows the preview in rows 22..51 (the comparison is not empty)", panelRowsDiff(r.bAfter, 22, 51) > 0, `differs ${panelRowsDiff(r.bAfter, 22, 51)}`);
          check("clearing refusal: the preview's rows 22..51 equal the picture in the press frame", panelRowsDiff(r.aAfter, 22, 51) === 0, `differs ${panelRowsDiff(r.aAfter, 22, 51)}`);
          check("clearing refusal: the preview's bottom row 52 stays, equal to the twin's preview row (its pixels differ from the picture)",
            sameArray(row52(r.aAfter), row52(r.bAfter)) && panelRowsDiff(r.aAfter, 52, 52) > 0, `differs from picture ${panelRowsDiff(r.aAfter, 52, 52)}`);
          check("clearing refusal: nothing outside the panel box and the message band differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
          check("clearing refusal: money unchanged and no pass advanced beyond the twin", a.world.state.signedLong(0x135ba) === 100 && a.loop.passes === b.loop.passes);
          const press = frameOf(a);
          passWith(a, quiet);
          passWith(b, quiet);
          check("clearing refusal: the next pass keeps rows 22..51 at the picture", panelRowsDiff(a.screen.pixels, 22, 51) === 0, `differs ${panelRowsDiff(a.screen.pixels, 22, 51)}`);
          check("clearing refusal: the next pass keeps row 52 as it was in the press frame", sameArray(row52(a.screen.pixels), row52(press)), "");
          check("clearing refusal: the next pass differs from the twin only in the panel box and the message band", offBandDiff(a.screen.pixels, b.screen.pixels) === 0, `differs ${offBandDiff(a.screen.pixels, b.screen.pixels)}`);
          check("clearing refusal: row 52 is still held before any mode tile (as in the press frame)", sameArray(row52Of(a.screen.pixels), row52Of(press)));
          passWith(a, at(false, 20, 20, true));
          check("clearing refusal: a right click (select icon drawn) leaves the mode select", a.controls.mode === "select");
          check("clearing refusal: row 52 after the right click is the select icon over the held row (transparent icon pixels keep it)",
            sameArray(row52Of(a.screen.pixels), bottomRowComposite(row52Of(press), 0x39)));
          check("clearing refusal: the select icon is drawn over the row (icon box matches the icon over the picture)", iconMismatch(a, a.screen.pixels, 0x39) === 0, `mismatch=${iconMismatch(a, a.screen.pixels, 0x39)}`);
        } else pair(a, b, at(false, px, py));
      }
      check("a clearing refusal is reached from a cell in the view (section 8)", refused);
    }

    // ---- 9. A mode exit from a building preview: the bottom row is kept as the bitmap holds it (Disk.1 static trace) ------------
    // `$15F1E` (the `$15EF0` exit: right click, marker, disk EXIT, placement refusal) runs `$6ACE` (rows 7..51 only) and then `$6B10` draws
    // `$39` in both bitmaps. Row 52 is outside `$6ACE`; `$69D8` skips transparent tile pixels, so the preview's bottom row stays where
    // `$39` is transparent. The tile data gives every building's bottom row the opaque pixels x 14..17 (the icon's own), except `$31`
    // (x 13 too), and at those x 13 pixels the preview equals the picture. So for every static tile the visible row 52 after the exit is
    // `$39` over the picture, and the held residue shows only in the state, not in the pixels. Checks: the exit frame, the following pass
    // and the twin, with the state (`panelBottomRow`) equal to the held residue.
    {
      const tileId = 0x31;
      const sameRow = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
      const sel = (m) => { m.controls.mode = "build"; m.controls.selection = { tile: tileId, type: m.world.findType(tileId) }; };
      const a = fresh(sel, 100), b = fresh(sel, 100);
      const P = a.initialPicture;
      passWith(a, quiet);
      passWith(b, quiet);
      const picture52 = Array.from(P.subarray(52 * 320 + 272, 52 * 320 + 320));
      const preview52 = row52Of(frameOf(a));
      // The scene starts with the select icon (\`$157B4\` -> \`$15EF0\`), so the build preview is drawn over its held pixels: x 17 keeps \`$39\`'s pixel
      // where \`$31\` is transparent.
      check("exit residue: before the exit row 52 is the preview's bottom row (the building over the held select icon over the picture)", sameRow(preview52, bottomRowComposite(bottomRowComposite(picture52, 0x39), tileId)));
      passWith(a, at(false, 20, 20, true));
      passWith(b, quiet);
      check("exit residue: the right click leaves the mode select", a.controls.mode === "select");
      const exit52 = row52Of(a.screen.pixels);
      check("exit residue: the exit frame shows the select icon over the picture in row 52 (the held residue is covered or equal)", sameRow(exit52, bottomRowComposite(picture52, 0x39)), `differs ${exit52.filter((v, x) => v !== bottomRowComposite(picture52, 0x39)[x]).length}`);
      check("exit residue: the held state equals the icon composite over the held preview row", sameRow(Array.from(a.panelBottomRow), bottomRowComposite(preview52, 0x39)));
      let panelDiff = 0;
      for (let y = 22; y <= 29; y++) for (let x = 272; x <= 319; x++) if (a.screen.pixels[y * 320 + x] !== P[y * 320 + x]) panelDiff++;
      check("exit residue: rows 22..29 of the panel are the picture's in the exit frame", panelDiff === 0, `differs ${panelDiff}`);
      passWith(a, quiet);
      check("exit residue: the following pass keeps row 52 as in the exit frame", sameRow(row52Of(a.screen.pixels), exit52));
      check("exit residue: the following pass still shows the select mode", a.controls.mode === "select");
      check("exit residue: nothing outside the panel box and the message band differs from the twin after the next pass", offBandDiff(a.screen.pixels, b.screen.pixels) === 0, `differs ${offBandDiff(a.screen.pixels, b.screen.pixels)}`);
    }

    // ---- 10. Demolish button and build-menu commit: row 52 residue through the next pass (Disk.1 static trace) --------------------
    // `$15ECA` (demolish button, `$15ED2 -> $6ACE`) and `$6BA2` -> `$6BB4` (commit with a pending item) run `$6ACE` (rows 7..51 only)
    // and then `$6B10`, which blits the new mode tile with the plane-5 mask (`$69D8`): transparent pixels keep what the bitmap held.
    // Row 52 is outside `$6ACE`, so the earlier bottom row stays wherever the new tile is transparent, and the next pass keeps it
    // (`panelBottomRow`). Every shipped mode tile is opaque at x 14..17 of its bottom row and transparent elsewhere on it, so with the
    // real tiles the residue is always overwritten and only the state differs. The synthetic probes below clear that opaque part from
    // the incoming tile's mask (`$3A` for demolish, `$45` for commit) so the held `$61` preview pixels are visible: a bug that restores
    // row 52 from the picture fails them. The real-tile cases check the composite and the icon box directly.
    {
      const RESIDUE = [14, 15, 16, 17]; // x 286..289 of row 52: the opaque bottom-row pixels of every shipped mode tile
      const rowOf = (pix) => Array.from(pix.subarray(52 * 320 + 272, 52 * 320 + 320));
      const sameRow = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
      const differsIn = (x, y, xs) => xs.filter((i) => x[i] !== y[i]).length;
      const hold = (m) => {
        m.controls.mode = "build";
        m.controls.selection = { tile: 0x61, type: m.world.findType(0x61) };
      };
      // The same tile set with the bottom-row pixels at RESIDUE cleared from the mask (plane 5) of each tile id in `ids`.
      const maskedBottom = (ids) => tiles.map((t, i) => {
        if (!ids.includes(i + 1)) return t;
        const pb = t.rows * 4;
        const planes = t.planes.slice();
        for (const x of RESIDUE) planes[5 * pb + (x >> 3)] &= ~(1 << (7 - (x & 7))) & 0xff;
        return { ...t, planes };
      });
      const freshOn = (tileSet, setup, money = 500000) => {
        const m = new MapScene(disk1, tileSet, newWorld(), strings, { sprites });
        m.world.state.setByte(A.frameCountdown, 90);
        m.world.state.setByte(A.pending, 0);
        m.world.state.setLong(0x135ba, money);
        setup?.(m);
        const n = m.loop.passes;
        while (m.loop.passes === n) m.update(quiet);
        return m;
      };
      const modal = (m, x, y) => {
        m.update(at(true, x, y));
        m.update(at(false, x, y));
      };
      // Build menu: open from the build button, pick $45 on page 2 (as in section 6), leave by the exit button (272, 139).
      const commitTo45 = (m) => {
        passWith(m, at(true, 272, 63));
        passWith(m, at(false, 272, 63));
        modal(m, 296, 139);
        modal(m, 25, 115);
        modal(m, 272, 139);
      };

      {
        // Synthetic probe, demolish: the $61 preview's bottom row is held; $3A is transparent at x 14..17, so the held pixels remain.
        const sets = maskedBottom([0x3a]);
        const a = freshOn(sets, hold), b = freshOn(sets, hold);
        const picture52 = rowOf(a.initialPicture);
        passWith(a, quiet);
        passWith(b, quiet);
        const held = rowOf(a.screen.pixels);
        check("demolish probe: the $61 preview's bottom row is held before the button (x 14..17 differ from the picture)", differsIn(held, picture52, RESIDUE) === RESIDUE.length, `differs ${differsIn(held, picture52, RESIDUE)}`);
        pair(a, b, at(true, 280, 90));
        const r = pair(a, b, at(false, 280, 90));
        check("demolish probe: the release sets demolish mode", a.controls.mode === "demolish" && a.controls.selection === null);
        check("demolish probe: the release frame keeps row 52 as held (a transparent $3A adds nothing there)", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("demolish probe: the held state equals the held row", sameRow(Array.from(a.panelBottomRow), held));
        check("demolish probe: nothing outside the panel box and the message band differs from the twin", offBandDiff(r.aAfter, r.bAfter) === 0, `differs ${offBandDiff(r.aAfter, r.bAfter)}`);
        const release = frameOf(a);
        passWith(a, quiet);
        check("demolish probe: the next pass keeps row 52 held", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("demolish probe: the next pass still shows demolish mode", a.controls.mode === "demolish");
        check("demolish probe: the next pass keeps the panel box of the release frame", panelDiff(release, a.screen.pixels) === 0, `differs ${panelDiff(release, a.screen.pixels)}`);
      }
      {
        // Real tiles, demolish: row 52 is the $3A composite over the held preview row; the icon box matches $3A over the picture.
        const c = fresh(hold);
        passWith(c, quiet);
        const held = rowOf(c.screen.pixels);
        passWith(c, at(true, 280, 90));
        passWith(c, at(false, 280, 90));
        check("demolish (real tiles): the release sets demolish mode", c.controls.mode === "demolish");
        check("demolish (real tiles): row 52 is the $3A composite over the held row", sameRow(rowOf(c.screen.pixels), bottomRowComposite(held, 0x3a)), `differs ${differsIn(rowOf(c.screen.pixels), bottomRowComposite(held, 0x3a), RESIDUE)}`);
        check("demolish (real tiles): the release frame's icon box matches $3A over the picture", iconMismatch(c, c.screen.pixels, 0x3a) === 0, `mismatch=${iconMismatch(c, c.screen.pixels, 0x3a)}`);
        const release = frameOf(c);
        passWith(c, quiet);
        check("demolish (real tiles): the next pass keeps row 52 and the icon", sameRow(rowOf(c.screen.pixels), bottomRowComposite(held, 0x3a)) && iconMismatch(c, c.screen.pixels, 0x3a) === 0);
        check("demolish (real tiles): the next pass keeps the panel box of the release frame", panelDiff(release, c.screen.pixels) === 0, `differs ${panelDiff(release, c.screen.pixels)}`);
      }
      {
        // Synthetic probe, commit: the $61 preview's bottom row is held; the committed $45 is transparent at x 14..17.
        const a = freshOn(maskedBottom([0x45]), hold);
        const picture52 = rowOf(a.initialPicture);
        passWith(a, quiet);
        const held = rowOf(a.screen.pixels);
        check("commit probe: the $61 preview's bottom row is held before the menu (x 14..17 differ from the picture)", differsIn(held, picture52, RESIDUE) === RESIDUE.length, `differs ${differsIn(held, picture52, RESIDUE)}`);
        passWith(a, at(true, 272, 63));
        passWith(a, at(false, 272, 63));
        check("commit probe: the build menu opens with the current selection $61 pending", a.controls.menuVisible && a.controls.menuState.pending?.tile === 0x61);
        modal(a, 296, 139);
        modal(a, 25, 115);
        check("commit probe: $45 is the pending item", a.controls.menuState.pending?.tile === 0x45);
        modal(a, 272, 139);
        check("commit probe: the exit commits $45 as the build selection", !a.controls.menuVisible && a.controls.mode === "build" && a.controls.selection?.tile === 0x45);
        check("commit probe: the exit frame keeps row 52 as held (a transparent $45 adds nothing there)", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("commit probe: the held state equals the held row", sameRow(Array.from(a.panelBottomRow), held));
        const exitFrame = frameOf(a);
        passWith(a, quiet);
        check("commit probe: the next pass keeps row 52 held", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("commit probe: the next pass keeps the panel box of the exit frame", panelDiff(exitFrame, a.screen.pixels) === 0, `differs ${panelDiff(exitFrame, a.screen.pixels)}`);
      }
      {
        // Real tiles, commit: row 52 is the $45 composite over the held $61 row; the icon box matches $45 over the picture.
        const d = fresh(hold);
        passWith(d, quiet);
        const held = rowOf(d.screen.pixels);
        commitTo45(d);
        check("commit (real tiles): the exit commits $45 as the build selection", !d.controls.menuVisible && d.controls.mode === "build" && d.controls.selection?.tile === 0x45);
        check("commit (real tiles): row 52 is the $45 composite over the held row", sameRow(rowOf(d.screen.pixels), bottomRowComposite(held, 0x45)), `differs ${differsIn(rowOf(d.screen.pixels), bottomRowComposite(held, 0x45), RESIDUE)}`);
        check("commit (real tiles): the exit frame's icon box matches $45 over the picture", iconMismatch(d, d.screen.pixels, 0x45) === 0, `mismatch=${iconMismatch(d, d.screen.pixels, 0x45)}`);
        const exitFrame = frameOf(d);
        passWith(d, quiet);
        check("commit (real tiles): the next pass keeps row 52 as the composite", sameRow(rowOf(d.screen.pixels), bottomRowComposite(held, 0x45)));
        check("commit (real tiles): the next pass keeps the panel box of the exit frame", panelDiff(exitFrame, d.screen.pixels) === 0, `differs ${panelDiff(exitFrame, d.screen.pixels)}`);
      }
      {
        // Synthetic probe, demolish from select mode: the held row is the $39 select icon's bottom row (scene start, $157B4 -> $15EF0).
        // $15AF8 has no mode test and $15ECA runs $6ACE (rows 7..51) then $6B10 with $3A; a transparent $3A at x 14..17 keeps the $39 pixels.
        const sets = maskedBottom([0x3a]);
        const a = freshOn(sets), b = freshOn(sets);
        const picture52 = rowOf(a.initialPicture);
        passWith(a, quiet);
        passWith(b, quiet);
        const held = rowOf(a.screen.pixels);
        check("select-mode demolish probe: the $39 select icon's bottom row is held (x 14..17 differ from the picture)", differsIn(held, picture52, RESIDUE) === RESIDUE.length, `differs ${differsIn(held, picture52, RESIDUE)}`);
        const r = pair(a, b, at(true, 280, 90));
        check("select-mode demolish probe: the press does not change the mode yet", a.controls.mode === "select" && iconMismatch(a, r.aAfter, 0x39) === 0);
        const release = pair(a, b, at(false, 280, 90));
        check("select-mode demolish probe: the release sets demolish mode with no selection", a.controls.mode === "demolish" && a.controls.selection === null);
        check("select-mode demolish probe: the release frame keeps row 52 as the $39 bottom row was held", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("select-mode demolish probe: the held state equals the held row", sameRow(Array.from(a.panelBottomRow), held));
        check("select-mode demolish probe: nothing outside the panel box and the message band differs from the twin", offBandDiff(release.aAfter, release.bAfter) === 0, `differs ${offBandDiff(release.aAfter, release.bAfter)}`);
        const frame = frameOf(a);
        passWith(a, quiet);
        check("select-mode demolish probe: the next pass keeps row 52 held", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("select-mode demolish probe: the next pass still shows demolish mode", a.controls.mode === "demolish");
        check("select-mode demolish probe: the next pass keeps the panel box of the release frame", panelDiff(frame, a.screen.pixels) === 0, `differs ${panelDiff(frame, a.screen.pixels)}`);
      }
      {
        // Real tiles, demolish from select mode: row 52 is the $3A composite over the $39 row; the icon box matches $3A over the picture.
        const e = fresh();
        passWith(e, quiet);
        const held = rowOf(e.screen.pixels);
        passWith(e, at(true, 280, 90));
        passWith(e, at(false, 280, 90));
        check("select-mode demolish (real tiles): the release sets demolish mode", e.controls.mode === "demolish" && e.controls.selection === null);
        check("select-mode demolish (real tiles): row 52 is the $3A composite over the $39 row", sameRow(rowOf(e.screen.pixels), bottomRowComposite(held, 0x3a)), `differs ${differsIn(rowOf(e.screen.pixels), bottomRowComposite(held, 0x3a), RESIDUE)}`);
        check("select-mode demolish (real tiles): the release frame's icon box matches $3A over the picture", iconMismatch(e, e.screen.pixels, 0x3a) === 0, `mismatch=${iconMismatch(e, e.screen.pixels, 0x3a)}`);
        const frame = frameOf(e);
        passWith(e, quiet);
        check("select-mode demolish (real tiles): the next pass keeps row 52 and the icon", sameRow(rowOf(e.screen.pixels), bottomRowComposite(held, 0x3a)) && iconMismatch(e, e.screen.pixels, 0x3a) === 0);
        check("select-mode demolish (real tiles): the next pass keeps the panel box of the release frame", panelDiff(frame, e.screen.pixels) === 0, `differs ${panelDiff(frame, e.screen.pixels)}`);
      }
      {
        // Synthetic probe, unaffordable pick then exit: the $61 preview's bottom row is held before the menu. The pick ($45, 6000) is
        // refused with money 100 ($B57E clears the pending item), so the exit runs $15EF0 (no pending item): $6ACE restores rows 7..51,
        // $6B10 draws $39 whose mask is clear at x 14..17 here, and the held pixels remain in the exit frame and the next pass.
        const sets = maskedBottom([0x39]);
        const a = freshOn(sets, hold, 100), b = freshOn(sets, hold, 100);
        const picture52 = rowOf(a.initialPicture);
        passWith(a, quiet);
        passWith(b, quiet);
        const held = rowOf(a.screen.pixels);
        check("unaffordable-exit probe: the $61 preview's bottom row is held before the menu (x 14..17 differ from the picture)", differsIn(held, picture52, RESIDUE) === RESIDUE.length, `differs ${differsIn(held, picture52, RESIDUE)}`);
        passWith(a, at(true, 272, 63));
        passWith(a, at(false, 272, 63));
        check("unaffordable-exit probe: the build menu opens with $61 pending", a.controls.menuVisible && a.controls.menuState.pending?.tile === 0x61);
        modal(a, 296, 139);
        modal(a, 25, 115);
        check("unaffordable-exit probe: the $45 pick is refused (pending cleared, affordable false)", a.controls.menuVisible && a.controls.menuState.pending === null && a.controls.menuState.detail?.affordable === false);
        modal(a, 272, 139);
        check("unaffordable-exit probe: the exit leaves select mode with no selection", !a.controls.menuVisible && a.controls.mode === "select" && a.controls.selection === null);
        check("unaffordable-exit probe: the exit frame keeps row 52 as held (a transparent $39 adds nothing there)", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("unaffordable-exit probe: the held state equals the held row", sameRow(Array.from(a.panelBottomRow), held));
        const exitFrame = frameOf(a);
        passWith(a, quiet);
        check("unaffordable-exit probe: the next pass keeps row 52 held", sameRow(rowOf(a.screen.pixels), held), `differs ${differsIn(rowOf(a.screen.pixels), held, RESIDUE)}`);
        check("unaffordable-exit probe: the next pass keeps the panel box of the exit frame", panelDiff(exitFrame, a.screen.pixels) === 0, `differs ${panelDiff(exitFrame, a.screen.pixels)}`);
      }
      {
        // Real tiles, unaffordable pick then exit: row 52 is the $39 composite over the held $61 row; the icon box matches $39 over the picture.
        const f = fresh(hold, 100);
        passWith(f, quiet);
        const held = rowOf(f.screen.pixels);
        passWith(f, at(true, 272, 63));
        passWith(f, at(false, 272, 63));
        modal(f, 296, 139);
        modal(f, 25, 115);
        modal(f, 272, 139);
        check("unaffordable-exit (real tiles): the exit leaves select mode with no selection", !f.controls.menuVisible && f.controls.mode === "select" && f.controls.selection === null);
        check("unaffordable-exit (real tiles): row 52 is the $39 composite over the held $61 row", sameRow(rowOf(f.screen.pixels), bottomRowComposite(held, 0x39)), `differs ${differsIn(rowOf(f.screen.pixels), bottomRowComposite(held, 0x39), RESIDUE)}`);
        check("unaffordable-exit (real tiles): the exit frame's icon box matches $39 over the picture", iconMismatch(f, f.screen.pixels, 0x39) === 0, `mismatch=${iconMismatch(f, f.screen.pixels, 0x39)}`);
        const exitFrame = frameOf(f);
        passWith(f, quiet);
        check("unaffordable-exit (real tiles): the next pass keeps row 52 as the composite", sameRow(rowOf(f.screen.pixels), bottomRowComposite(held, 0x39)));
        check("unaffordable-exit (real tiles): the next pass keeps the panel box of the exit frame", panelDiff(exitFrame, f.screen.pixels) === 0, `differs ${panelDiff(exitFrame, f.screen.pixels)}`);
      }
    }
  }
}

if (failed) {
  console.log(`${failed} map-loop check(s) failed`);
  process.exit(1);
}
console.log("all map-loop checks passed");
