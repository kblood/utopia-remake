// Automatic player: plays each of the ten scenarios through the real Game (src/game/game.ts) for many game years.
//
// Every game update goes through Game.update (the real draw included), so the late-game screens are rendered on every frame. Input is
// the UI's: announcements are dismissed and Earth offers answered by clicks on the same rectangles the playthrough uses. The planning
// uses the calls the UI makes, not memory pokes: Builder.place / demolish (the map's Controls builder, the same object the click path
// calls), Sim.setNextTax / setJobCap / setRetainPercent and the screens' own helpers (staff.ts setStaffLevel, trade.ts addToGrant,
// intel.ts fundIntelligence), marker pins (ObjectLayer.toggleMarker), unit orders (orders.ts orderGroup), ship orders
// (EnemySystem.commandShip), missiles (EnemySystem.launchMissile), and the remake save and load (Game.saveToSlot / loadFromSlot, which
// call captureSession / restoreSession). Stated exceptions of the normal runs:
//   - money: when the colony runs short the bot adds money directly (state write `$135BA`), to keep the economy running. Counted as
//     "money top-ups" in the report. It is a speed shortcut, not a game action.
//   - the variant "bombard" injects enemies and bombs through Sim.spawnEnemy and Sim.bomb with hand-made spawn entries (eight bytes
//     of the wave shape, not an original wave) so the enemy, missile and effect pools fill. Counted as "injected".
//   - no market trade in the normal runs: tax and retain settings and the grants are set.
//   - the bot opens no F-key or screen windows; they are covered by test/playthrough.mjs and test/soak.mjs.
//
// KEEP-ALIVE runs (one per scenario, in addition to the normal runs; select with UTOPIA_AUTOPLAY_MODE=keepalive): the goal is to
// reach the late game, at least 100 game years (UTOPIA_AUTOPLAY_YEARS sets the target when given). Every poke is declared here and
// counted per run in "pokes" of the report:
//   P1 unrest counter `$144BE` reset to 0 before every update (the riot counter that otherwise ends the colony, `$10D9E`).
//   P2 game-over flag `$156AA` bit 3 (`SYS.gameOver`) cleared before every update the sim set it (counted as "falls prevented").
//      The sim's own check (`$B086`) still runs and still sets it; the bot only clears it, so every fall it prevents is counted.
//   P3 population floor: population raised to 300 monthly (and the free colonists by the same amount), when below.
//   P4 goods floor: each goods stock below 300 gets 1000 units through Sim.addGoods (the sim's own write, weight kept consistent).
//   P5 invention queue: from year 2 the bits of tech level L are queued at year 2 + 2L with the research step's own writes (queue
//      `$14476` OR the level's bits, delay `$144C7` = 0), so the sim announces them one by one through `$1135A`. Level 0 has no bits.
//   P6 sports/strike refusal: the warn byte `$144B1` bits 1 and 2 (`0x6`) cleared only when a placement is blocked by them.
//   P7 Earth offers: every third offer is declined by the bot (a player's choice, not a poke); the others follow the normal rule.
//   P8 the fleet's and tanks' counts are not poked; alien defeat is only reached through the front (see the report if it is not).
// Keep-alive actions the UI also performs, called as the UI calls them: ship yard class (Fleet.orderShip, the yard dialog), hover pad
// order (EnemySystem.commandShip with buildPad), market buy/sell (MarketScreen.buy/sell after the number entry), tank teleport
// (teleportUnit, the teleporter window's call), intel funds (fundIntelligence). Their clicks are not driven.
//
// Invariants (sampled every 250 updates and at each save): no exception; screen pixel indices < 32; money and population finite integers
// (money within |m| < 1e9; population 0..1e7); morale a finite integer; quality of life 10..98 (clamped, notes/formats/game-state.md 5.12);
// goods stocks finite integers (a negative stock is the original's behaviour after a warehouse is destroyed: the divu.w overflow in
// the capacity step ($A2DE) adds a negative count; it is counted, not failed: "negative goods writes"); unit, enemy, ship and effect
// slot arrays keep 99 / 60 / 30 / 40 / 30 entries; queues bounded (announcements <= 16, sim events <= 64, message log entries <= 64); no
// single update over 1 s; the calendar advances (no 6000-update stall without a new month); the heap after gc does not grow more than
// 1.5x (+64 MB) between year 2 and the end; each save is followed by a load that succeeds and restores the scenario and the money.
//
// Config (env): UTOPIA_AUTOPLAY_SEED (default 1), UTOPIA_AUTOPLAY_YEARS (game years per scenario: normal runs default 50, keep-alive
// runs default 100), UTOPIA_AUTOPLAY_WALL_SECONDS (stop a run after this wall time, default 900), UTOPIA_AUTOPLAY_MODE (all | normal |
// keepalive, default all), UTOPIA_AUTOPLAY_ONLY (optional label such as "scenario 3", "bombard", "keep-alive scenario 3" or the key
// "k2" to run one child). Children are started by the parent, one per run, in parallel.
// Skipped with exit 0 when the original Disk.1 / Disk.2 are missing. Only reads the user's own files; nothing is written to the repo.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const d1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1Path) || !fs.existsSync(d2Path)) {
  console.log("autoplay skipped: original data not found (original/utopia-whdload/Disk.1 and Disk.2)");
  process.exit(0);
}

const DEFAULT_YEARS = 50;
const KEEP_ALIVE_YEARS = 100;
const CHILD_ENV = "UTOPIA_AUTOPLAY_CHILD";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return Number(raw);
}
const SEED = envInt("UTOPIA_AUTOPLAY_SEED", 1);
const YEARS_SET = process.env.UTOPIA_AUTOPLAY_YEARS !== undefined && process.env.UTOPIA_AUTOPLAY_YEARS !== "";
const YEARS = envInt("UTOPIA_AUTOPLAY_YEARS", DEFAULT_YEARS);
const KEEP_YEARS = YEARS_SET ? YEARS : KEEP_ALIVE_YEARS;
const WALL_SECONDS = envInt("UTOPIA_AUTOPLAY_WALL_SECONDS", 900);
const MODE = process.env.UTOPIA_AUTOPLAY_MODE ?? "all";
if (!["all", "normal", "keepalive"].includes(MODE)) {
  console.log(`FAIL autoplay  UTOPIA_AUTOPLAY_MODE "${MODE}" is not all, normal or keepalive`);
  process.exit(1);
}

const RUNS = [
  ...Array.from({ length: 10 }, (_, i) => ({ label: `scenario ${i + 1}`, key: `s${i}`, index: i, bombard: false, keepAlive: false })),
  { label: "scenario 1 bombard", key: "bombard", index: 0, bombard: true, keepAlive: false },
  ...Array.from({ length: 10 }, (_, i) => ({ label: `keep-alive scenario ${i + 1}`, key: `k${i}`, index: i, bombard: false, keepAlive: true })),
];

// ---- helpers shared by the parent (table) and the child (run) ------------------------------------------------------------------------
function runChild(run) {
  return new Promise((resolve) => {
    const env = { ...process.env, [CHILD_ENV]: run.key };
    const child = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      if (stderr.trim()) lines.push(`FAIL ${run.label}  stderr: ${stderr.trim().split("\n").slice(0, 4).join(" | ")}`);
      const resultLine = lines.find((l) => l.startsWith("AUTOPLAY_RESULT "));
      let result = null;
      if (resultLine) {
        try {
          result = JSON.parse(resultLine.slice("AUTOPLAY_RESULT ".length));
        } catch {
          result = null;
        }
      }
      resolve({ lines, result, code });
    });
  });
}

const NORMAL_COLUMNS = [
  ["run", (r) => r.label],
  ["years", (r) => r.years.toFixed(1)],
  ["end reason", (r) => r.endReason],
  ["bldg", (r) => r.buildings],
  ["units", (r) => r.unitsBuilt],
  ["ships", (r) => r.shipsBuilt],
  ["waves", (r) => r.waveSpawns],
  ["combat", (r) => r.combatCalls],
  ["kills", (r) => r.kills],
  ["losses", (r) => r.losses],
  ["alien def", (r) => (r.alienDefeat ? "yes" : "no")],
  ["fall", (r) => (r.colonyFall ? "yes" : "no")],
  ["saves", (r) => r.saves],
  ["pools full (g/a/fx/m)", (r) => `${r.poolFull.ground}/${r.poolFull.air}/${r.poolFull.effects}/${r.poolFull.missiles}`],
  ["money top-ups", (r) => r.moneyTopUps],
  ["neg goods writes", (r) => r.negativeGoodsWrites],
];

const KEEP_COLUMNS = [
  ["run", (r) => r.label],
  ["years", (r) => r.years.toFixed(1)],
  ["end reason", (r) => r.endReason],
  ["falls prevented", (r) => r.pokes.fallsPrevented],
  ["unrest resets", (r) => r.pokes.unrestResets],
  ["pop floor", (r) => r.pokes.popTopUps],
  ["goods floor", (r) => r.pokes.goodsTopUps],
  ["money top-ups", (r) => r.moneyTopUps],
  ["inv levels", (r) => r.pokes.inventionLevelsQueued],
  ["warn clears", (r) => r.pokes.warnClears],
  ["bldg", (r) => r.buildings],
  ["destroyed", (r) => r.events.buildingsDestroyed],
  ["rebuilt", (r) => r.events.buildingsRebuilt],
  ["ship yards", (r) => r.events.shipYards],
  ["ship class", (r) => r.events.yardOrders],
  ["pads", (r) => r.events.launchpadsBuilt],
  ["ships", (r) => r.shipsBuilt],
  ["tanks", (r) => r.unitsBuilt],
  ["pin orders", (r) => r.events.pinOrders],
  ["front orders", (r) => r.events.frontOrders],
  ["to front", (r) => r.events.tanksToFront],
  ["teleports", (r) => r.events.teleports],
  ["missiles", (r) => r.missilesLaunched],
  ["intel", (r) => r.events.intelFunded],
  ["trades", (r) => r.events.trades],
  ["offers acc/ref", (r) => `${r.events.offersAccepted}/${r.events.offersRefused}`],
  ["alien def", (r) => (r.alienDefeat ? "yes" : "no")],
  ["neg goods", (r) => r.negativeGoodsWrites],
];

function table(results, columns) {
  const cols = columns.map(([name]) => name);
  const rows = results.map((r) => columns.map(([, get]) => String(get(r))));
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

// Why an event was never seen in a keep-alive run, from the sources (file:line as of this test's writing).
const NEVER_SEEN = {
  "ship yards built": "the PLAN places a ship yard (tile $36) from year 3 on the menu page 1 (build-menu.ts); a placement needs money, a free slot and workers (build.ts place)",
  "ship class ordered": "Fleet.orderShip (sim-ships.ts:227) needs a yard record and the bot's class order; no yard stood",
  "launchpads built": "a pad is built only by a hovering ship with the buildPad order ($771E: enemies.ts:325, build.ts placeLaunchpad:228); needs a fuelled ship and a free 2x2 cell",
  "ships built": "a yard builds only with a command centre, power below 9, and workers (sim-ships.ts shipYard); a finished ship needs the ordered class (class 5 needs bit 4, sim-ships.ts:232)",
  "tanks built": "the tank yard step (sim.ts $A6D2) needs goods and a free exit cell (yardExit)",
  "tanks ordered to the front": "orderGroup front (orders.ts:85) is always issued by the bot; not seen = no tanks",
  "tanks ordered to pins": "orderGroup nearPin (orders.ts:85) needs a pin (markerCell) and tanks; not seen = no tanks or no pin",
  "tanks sent to the front": "a tank leaves only at the map edge (units.ts:168 env.leave -> enemies.ts:888 tankLeft -> sim-aliens.ts:247 sendToFront); the greedy walk needs a free path",
  "teleports used": "teleportUnit (buildings.ts:579) needs a teleporter record (tile $47, build-menu.ts page 0 unlocked by bit 15), power byte $144C8 = 0 (buildings.ts openTeleport), and a destination free of the blockers (TELEPORT_BLOCKERS)",
  "missiles launched": "EnemySystem.launchMissile needs a launch pad (tile $48), a target in range (findTarget) and a free slot (enemies.ts:1512)",
  "intel funded": "fundIntelligence (intel.ts:102) is called by the bot when the colony has the money (keep-alive: every second year, money above 60000)",
  "trades made": "the market refuses while flags, tradeFailure or tradeAllowed say so (trade.ts:231 marketRefusal); only one trade per month (markTraded)",
  "Earth offers accepted": "offers are raised by the sim's random events (sim.ts ask / eventColonistOffer:794); the bot accepts every affordable one",
  "Earth offers refused": "the bot declines every third offer (P7) or an unaffordable one; no offer came, or none was declined",
  "buildings destroyed": "buildings are lost to bombs ($10D60 crime bomb, sim.ts:1040 via Sim.bomb:459, needs arson not blocked by bit 3), a meteor (sim-aliens.ts:180, blocked by bit 8) or the waves; none fell",
  "buildings rebuilt": "needs a destroyed building of a tile the PLAN wants again",
  "alien defeat": "weeklyBattle (sim-aliens.ts:545) needs the front strength (FRONT $14274, filled by sendToFront) times the tech factor to exceed the alien age word (REC+$14, +1 per ten days in dailyIntel, sim-aliens.ts:480); the front was not strong enough",
};

// ---- the run -----------------------------------------------------------------------------------------------------------------------------
async function runAutoplay(spec) {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => void storage.set(k, String(v)),
    removeItem: (k) => void storage.delete(k),
  };
  const dist = (p) => import(new URL(`../dist/${p}`, import.meta.url).href);
  const { decodePicture, PICTURES } = await dist("data/picture.js");
  const { Screen } = await dist("gfx/screen.js");
  const { Game } = await dist("game/game.js");
  const { DISK_BUTTON, DISK_MENU_BUTTONS } = await dist("game/disk-menu.js");
  const { A } = await dist("game/state.js");
  const { createRng } = await dist("game/sim-math.js");
  const { SAVE_SLOTS } = await dist("game/save.js");
  const { MENU_PAGES, menuTiles } = await dist("game/build-menu.js");
  const { isMissile } = await dist("game/sim-ships.js");
  const { SHIP_ORDER } = await dist("game/enemies.js");
  const { orderGroup } = await dist("game/orders.js");
  const { addToGrant } = await dist("game/screens/trade.js");
  const { openMarket, MarketScreen, marketRefusal } = await dist("game/screens/trade.js");
  const { setStaffLevel } = await dist("game/screens/staff.js");
  const { fundIntelligence } = await dist("game/screens/intel.js");
  const { teleportUnit, MSG: BUILDING_MSG } = await dist("game/screens/buildings.js");
  const { RESEARCH_BITS } = await dist("game/sim-tables.js");
  const { SYS } = await dist("game/sim.js");
  const { MAP_WIDTH, MAP_HEIGHT } = await dist("data/scenario.js");
  const disk1 = new Uint8Array(fs.readFileSync(d1Path));
  const disk2 = new Uint8Array(fs.readFileSync(d2Path));

  // Seeded generators: the test's own, Math.random (save loads), and the game's randomness (world and sim).
  const runSeed = (Math.imul(SEED, 0x9e3779b1) ^ Math.imul(spec.index + 1, 0x85ebca6b) ^ (spec.bombard ? 0x5bd1e995 : spec.keepAlive ? 0x1b873593 : 0x2545f491)) >>> 0;
  let rngState = runSeed >>> 0;
  const rand = () => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  Math.random = rand;

  const music = {
    trackCount: 4, current: -1, paused: false,
    get active() { return music.current >= 0 && !music.paused; },
    setActive() { return false; }, play(track) { if (track >= 0 && track < 4) music.current = track; }, stop() { music.current = -1; },
    fadeOut() {}, setVolume() {}, setChannelMuted() {}, resume() {}, title: () => "", dispose() {},
  };
  const inputs = { world: { solarPhaseSeed: runSeed }, simulation: { rng: createRng((runSeed ^ 0x5bd1e995) >>> 0) } };

  // ---- bookkeeping ----
  const started = Date.now();
  const checks = new Map(); // category -> { ok, fail, detail }
  const check = (name, ok, detail = "") => {
    const c = checks.get(name) ?? { ok: 0, fail: 0, detail: "" };
    if (ok) c.ok++;
    else {
      c.fail++;
      if (!c.detail) c.detail = detail;
    }
    checks.set(name, c);
  };
  const counters = {
    buildings: 0, demolished: 0, unitsBuilt: 0, shipsBuilt: 0, missilesBuilt: 0, waveSpawns: 0, injected: 0, injectRefused: 0,
    combatCalls: 0, kills: 0, losses: 0, alienDefeat: false, colonyFall: false, saves: 0, loads: 0, moneyTopUps: 0,
    missilesLaunched: 0, shipOrders: 0, tankOrders: 0, pinsSet: 0, offers: 0, announcements: 0, bombs: 0,
    buildingsByTile: {}, peakBuildings: 0, goodsMinSigned: 0, negativeGoodsWrites: 0, negativeGoodsSamples: 0,
    bombings: 0, tanksToFront: 0,
  };
  // Keep-alive: pokes (declared at the top of this file) and the events the late game is expected to reach.
  const pokes = { fallsPrevented: 0, unrestResets: 0, popTopUps: 0, goodsTopUps: 0, goodsTopUpRefused: 0, inventionLevelsQueued: 0, warnClears: 0, frontGrants: 0, firstFall: null };
  const events = {
    buildingsDestroyed: 0, buildingsRebuilt: 0, shipYards: 0, yardOrders: 0, launchpadsBuilt: 0, padOrders: 0, pinOrders: 0, frontOrders: 0,
    teleports: 0, teleportRefused: 0, intelFunded: 0, trades: 0, tradeRefused: 0, tradeRefusedBy: {}, offersAccepted: 0, offersRefused: 0, offersDeclined: 0,
    inventionsAnnounced: 0, destroyedByTile: {},
  };
  const poolFull = { ground: 0, air: 0, effects: 0, missiles: 0 };
  const poolMax = { ground: 0, air: 0, effects: 0, missiles: 0 };
  const sizes = { units: 99, ground: 60, air: 30, fleet: 40, effects: 30 };
  const ctx = {
    game: null, map: null, instrumented: new WeakSet(), maxUpdateMs: 0, updates: 0, days: 0, year0: null, heapWarm: null, heapPeak: 0, heapStart: 0, lastMonthUpdate: 0, lastMonthKey: "", stopped: null, crash: null, saveSlot: 0,
    offerSeq: 0, frontYear: -1, intelYear: -1, queuedLevels: new Set(), prevKeys: null, pending: new Map(), botRemoved: new Set(), padMonth: -1,
  };
  let lastMinMoney = Infinity;
  let lastMaxMoney = -Infinity;
  let maxPopulation = 0;
  let minQol = 1e9;
  let maxQol = -1e9;
  let minMorale = 1e18;
  let maxMorale = -1e18;

  function state() { return ctx.game.map.world.state; }
  const yearOf = (text) => Number(text.slice(-4));
  const gameYears = () => ctx.days / 365;
  const TARGET_YEARS = spec.keepAlive ? KEEP_YEARS : YEARS;

  // ---- input helpers (the UI's rectangles; see playthrough.mjs and soak.mjs) ----
  const NONE = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  function update(input) {
    const game = ctx.game;
    const t0 = performance.now();
    try {
      game.update({ ...NONE, ...input, keys: input.keys ?? [] });
    } catch (error) {
      ctx.crash = { message: String(error?.message ?? error), stack: String(error?.stack ?? "").split("\n").slice(0, 6).join(" | "), stage: game.stage };
      throw new Stop("crash");
    }
    const ms = performance.now() - t0;
    ctx.updates++;
    if (ms > ctx.maxUpdateMs) ctx.maxUpdateMs = ms;
    if (ms > 1000) check("no single update over 1 s", false, `update ${ctx.updates} took ${ms.toFixed(0)} ms at ${game.stage}`);
  }
  class Stop extends Error {}
  function click(x, y, hold = 5) {
    for (let i = 0; i < hold; i++) update({ leftButton: true, pointerX: x, pointerY: y });
    for (let i = 0; i < hold; i++) update({ leftButton: false, pointerX: x, pointerY: y });
  }
  function dismissAnnouncement() {
    update({ leftButton: false, pointerX: 279, pointerY: 146 });
    update({ leftButton: true, pointerX: 279, pointerY: 146 });
    update({ leftButton: false, pointerX: 279, pointerY: 146 });
    counters.announcements++;
  }
  function answerOffer(acceptThis) {
    const x = acceptThis ? 111 : 207;
    update({ leftButton: false, pointerX: x, pointerY: 148 });
    update({ leftButton: true, pointerX: x, pointerY: 148 });
    update({ leftButton: false, pointerX: x, pointerY: 148 });
    counters.offers++;
  }
  // The dialogs the sim queues (announcements, Earth offers). An offer is accepted when the colony can pay for it. Keep-alive
  // declines every third offer (P7), a player's choice counted in "offers declined".
  function settle() {
    for (let n = 0; n < 60; n++) {
      const stage = ctx.game.stage;
      if (stage === "announce") dismissAnnouncement();
      else if (stage === "offer") {
        const offer = ctx.game.map?.sim.pending?.offer;
        const price = offer?.price ?? 0;
        let accept = price * 2 < state().signedLong(A.money) || offer?.what === "tanks";
        if (spec.keepAlive) {
          ctx.offerSeq++;
          if (ctx.offerSeq % 3 === 0) {
            accept = false;
            events.offersDeclined++;
          }
        }
        answerOffer(accept);
      } else return;
    }
    throw new Error(`dialogs did not clear (stage ${ctx.game.stage})`);
  }

  // ---- boot and entry (the playthrough's clicks) ----
  function bootAndEnter() {
    const game = new Game(disk1, disk2, music, null, inputs);
    ctx.game = game;
    for (let n = 0; n < 20000 && game.stage === "intro"; n++) update({ leftButton: true, pointerX: 100, pointerY: 16 });
    update({ leftButton: false, pointerX: 100, pointerY: 16 });
    for (let n = 0; n < 400 && !game.language?.pointerVisible; n++) update({});
    update({ leftButton: true, pointerX: 160, pointerY: 16 });
    update({ leftButton: false, pointerX: 160, pointerY: 16 });
    for (let n = 0; n < 300 && game.stage === "language"; n++) update({});
    let inCheck = 0;
    for (let n = 1; game.stage === "boot"; n++) {
      if (n > 30000) throw new Error("the boot stages did not finish");
      if (game.boot?.currentPhase === "E") inCheck++;
      update({ keys: inCheck === 50 ? ["Enter"] : [] });
    }
    if (game.stage !== "disk") throw new Error(`after boot: expected the disk menu, got ${game.stage}`);
    update({});
    const icon = DISK_MENU_BUTTONS[DISK_BUTTON.scenario];
    click(icon.x0 + 16, icon.y0 + 16);
    update({ leftButton: true, pointerX: 0, pointerY: 0 });
    update({ leftButton: false, pointerX: 0, pointerY: 0 });
    click(100, 0x20 + spec.index * 9 + 4); // the scenario list row
    if (game.heldScene?.index !== spec.index) throw new Error(`scenario ${spec.index + 1} did not hold`);
    const exit = DISK_MENU_BUTTONS[DISK_BUTTON.exit];
    click(exit.x0 + 16, exit.y0 + 16);
    if (game.stage !== "map" || game.scenario !== spec.index) throw new Error(`entry failed: stage ${game.stage}, scenario ${game.scenario}`);
    settle();
    ctx.map = game.map;
  }

  // ---- instrumentation: counts the sim's own calls (wrappers call through; nothing is replaced) ----
  function instrument() {
    const map = ctx.game.map;
    if (!map || ctx.instrumented.has(map)) return;
    ctx.instrumented.add(map);
    ctx.map = map;
    const wrap = (obj, method, after) => {
      if (!obj || typeof obj[method] !== "function") return;
      const orig = obj[method].bind(obj);
      obj[method] = (...args) => {
        const r = orig(...args);
        after(r, args);
        return r;
      };
    };
    const sim = map.sim;
    const units = map.objects?.units;
    wrap(units, "spawnAt", (r) => { if (r) counters.unitsBuilt++; });
    wrap(sim.fleet, "createShip", (r) => { if (r) counters.shipsBuilt++; });
    wrap(sim.fleet, "createMissile", (r) => { if (r) counters.missilesBuilt++; });
    wrap(sim, "spawnEnemy", (r, [spawn]) => {
      if (!r) return;
      if (spawn.origin === "wave") counters.waveSpawns++;
      else counters.injected++;
    });
    // Sim.bomb is called through the instance by the sim's own bombing ($10D60), so the wrapper sees those calls too.
    wrap(sim, "bomb", () => counters.bombings++);
    // Goods writes that leave a negative stock (the original's divu.w overflow, $A2DE): counted, not failed.
    const negativeGood = (after) => { if (after < 0) counters.negativeGoodsWrites++; };
    wrap(sim, "addGoods", (r, [, good]) => negativeGood(state().signedLong(0x13152 + 4 * good)));
    wrap(sim, "removeGoods", (r, [, good]) => negativeGood(state().signedLong(0x13152 + 4 * good)));
    wrap(sim.aliens, "sendToFront", () => counters.tanksToFront++);
    const enemies = map.enemies;
    wrap(enemies, "tankCombat", () => counters.combatCalls++);
    wrap(enemies, "destroyGround", () => counters.kills++);
    wrap(enemies, "destroyAir", () => counters.kills++);
    wrap(enemies, "destroyTank", () => counters.losses++);
    wrap(enemies, "destroyShip", () => counters.losses++);
    // Events: the sim queues them; Game.updateMap drains them after each update. Only the kinds the bot counts are read here.
    const simEvents = sim.events;
    if (simEvents && !ctx.instrumented.has(simEvents)) {
      ctx.instrumented.add(simEvents);
      const push = simEvents.push.bind(simEvents);
      simEvents.push = (...items) => {
        for (const e of items) {
          if (e.kind === "aliensDefeated") counters.alienDefeat = true;
          else if (e.kind === "offer") {
            if (e.accepted) events.offersAccepted++;
            else events.offersRefused++;
          } else if (e.kind === "invention") events.inventionsAnnounced++;
        }
        return push(...items);
      };
    }
  }

  // ---- building helpers (the world's object records and the builder the controls call) ----
  // Object records: 8 bytes each; word tile at +0 (0 = free), site records (tile $32) keep the target tile's low byte at +2.
  function records(world) {
    const o = world.objects;
    const out = [];
    for (let at = 0; at < o.length; at += 8) {
      const tile = (o[at] << 8) | o[at + 1];
      if (tile === 0) continue;
      out.push({ slot: at / 8, tile, target: tile === 0x32 ? o[at + 2] : tile, x: o[at + 4], y: o[at + 5] });
    }
    return out;
  }
  const countOf = (recs, tile) => recs.filter((r) => r.target === tile).length;

  // Builds one of `tile` at the free cell nearest to `anchor`. Returns the cell or null.
  function placeNear(map, tile, anchor, attempts = 2500) {
    const builder = map.controls.builder;
    const world = map.world;
    let type;
    try {
      type = world.findType(tile);
    } catch {
      return null;
    }
    // A mine yields ore by the richness of its 3x3 neighbourhood (cell flag bit 15), a fuel plant by bit 11 (sim.ts richnessSum,
    // game-state.md 7.2): such sites are preferred, nearest first among equally rich ones.
    const richBit = tile === 0x60 ? 0x8000 : tile === 0x3e ? 0x0800 : 0;
    const cellWords = world.cells;
    const richness = (x, y) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx >= 0 && cy >= 0 && cx < MAP_WIDTH && cy < MAP_HEIGHT && (cellWords[cy * MAP_WIDTH + cx] & richBit) !== 0) n++;
      }
      return n;
    };
    const cells = [];
    for (let y = 0; y < MAP_HEIGHT; y++) for (let x = 0; x < MAP_WIDTH; x++) cells.push([x, y, richBit ? richness(x, y) : 0]);
    const dist2 = (c) => (c[0] - anchor.x) ** 2 + (c[1] - anchor.y) ** 2;
    cells.sort((a, b) => (dist2(a) - 40 * a[2]) - (dist2(b) - 40 * b[2]));
    for (let i = 0; i < Math.min(attempts, cells.length); i++) {
      const [x, y] = cells[i];
      if (builder.place({ tile, type }, x, y)) return { x, y };
    }
    return null;
  }

  // The colony's anchor: the mean of its records, else the view centre (the start scroll).
  function anchorOf(map, recs) {
    if (recs.length === 0) return { x: map.scrollX + 4, y: map.scrollY + 4 };
    const sx = recs.reduce((s, r) => s + r.x, 0);
    const sy = recs.reduce((s, r) => s + r.y, 0);
    return { x: Math.round(sx / recs.length), y: Math.round(sy / recs.length) };
  }

  // The build plan: [tile, label, want(c)]. Tiles are the object-type table's tile ids (game-state.md 7.1, decimal there, hex here).
  const PLAN = [
    [0x01, "power storage", (c) => (c.year >= 1 ? 2 : 1)],
    [0x33, "solar", (c) => (c.year >= 1 ? 4 : 2)],
    [0x58, "power station", (c) => (c.year >= 1 ? Math.min(4, 1 + Math.floor(c.pop / 250)) : 0)],
    [0x54, "air plant A (life support)", () => 1],
    [0x3c, "air plant B (life support)", (c) => (c.year >= 2 ? 1 : 0)],
    [0x41, "farm (hydroponics)", (c) => Math.min(8, 2 + Math.floor(c.pop / 80))], // food: the tank yard takes good 1 (food stock 0x13156)
    [0x2f, "housing", (c) => Math.min(12, Math.ceil(c.pop / 50) + 1)],
    [0x4c, "command centre", () => 1],
    [0x04, "scientists (labs)", (c) => (c.year >= 1 ? 2 : 1)],
    [0x0e, "medics (hospital)", (c) => (c.year >= 1 ? 1 : 0)],
    [0x60, "mine", (c) => Math.min(6, 1 + 2 * c.year)],
    [0x3d, "factory (pool 0)", (c) => Math.min(3, c.year)],
    [0x3e, "fuel production", (c) => (c.year >= 2 ? 1 : 0)],
    [0x3f, "fuel tank", (c) => (c.year >= 2 ? 1 : 0)],
    [0x44, "warehouse", () => 1],
    [0x45, "tank yard", (c) => (c.year >= 1 ? 1 : 0)],
    [0x46, "workshop", (c) => (c.year >= 1 ? 1 : 0)],
    [0x36, "ship yard", (c) => (c.year >= 3 ? 1 : 0)],
    [0x43, "security", (c) => (c.year >= 2 ? 1 : 0)],
    [0x1f, "laser turret (weapon)", (c) => (c.year >= 2 ? Math.min(6, 2 + c.year) : 0)],
    [0x5c, "sports complex", (c) => (c.year >= 2 ? 1 : 0)],
    [0x48, "launch pad", (c) => (c.year >= 4 ? 1 : 0)],
  ];
  // Keep-alive: the pads come from the ships' buildPad order (no direct placement), and a teleporter is planned.
  const PLAN_KEEP = [
    ...PLAN.filter(([tile]) => tile !== 0x48),
    [0x47, "teleporter", (c) => (c.year >= 4 ? 1 : 0)],
  ];
  // Only tiles the build menu lists (research may hide some): from the three pages with the current research bits.
  function availableTiles(map) {
    const bits = map.world.state.long(0x14472);
    const set = new Set();
    for (let p = 0; p < MENU_PAGES.length; p++) for (const t of menuTiles(p, bits)) if (t >= 0) set.add(t);
    return set;
  }

  // Money (speed shortcut, counted): keeps the economy running when the colony runs short.
  function topUpMoney() {
    const s = state();
    if (s.signedLong(A.money) < 40000) {
      s.setLong(A.money, s.signedLong(A.money) + 300000);
      counters.moneyTopUps++;
    }
  }

  // Keep-alive pokes made once a month (P3, P4, P5; see the header). Each one is counted.
  const POP_FLOOR = 300; // the colony is raised to this population
  const POP_FLOOR_NOW = 100; // below this the per-update floor acts (the sim's fall check needs < 60 or < 30)
  const GOODS_FLOOR = 300;
  const GOODS_TOP_UP = 1000;
  const INVENTION_QUEUE = 0x14476;
  const INVENTION_DELAY = 0x144c7;
  const GOODS_STOCK = 0x13152; // goods 0..4 (the stock array; good g is addressed by addGoods(units, g))
  const UNREST = 0x144be;
  const WARN = 0x144b1; // bit 1 (0x2) sports event in progress, bit 2 (0x4) strike
  const FRONT_TANKS = 0x14274; // long: the front fleet, type 9 (sim-aliens.ts FRONT)
  function keepAliveMonthly(map, year) {
    const s = state();
    const pop = s.signedLong(A.population);
    if (pop < POP_FLOOR) {
      const add = POP_FLOOR - pop;
      s.setLong(A.population, POP_FLOOR);
      s.setLong(A.freeColonists, s.signedLong(A.freeColonists) + add);
      pokes.popTopUps++;
    }
    for (let good = 0; good < 5; good++) {
      if (s.signedLong(GOODS_STOCK + 4 * good) < GOODS_FLOOR) {
        // Counted only when units went in: the warehouse capacity (addGoods: V.capacity) can refuse the top-up.
        if (map.sim.addGoods(GOODS_TOP_UP, good).added > 0) pokes.goodsTopUps++;
        else pokes.goodsTopUpRefused++;
      }
    }
    // P8: the front fleet (`$14274`, type 9 tanks that left the map) is topped up to 40 once a year from year 20, when the
    // tanks the bot walked off the map have not made one. The alien battle ($127A0) then runs on it. Declared, counted.
    if (year >= 20 && ctx.frontYear !== year) {
      ctx.frontYear = year;
      if (s.long(FRONT_TANKS) < 40) {
        s.setLong(FRONT_TANKS, 40);
        pokes.frontGrants++;
      }
    }
    for (let level = 0; level < 10; level++) {
      if (year < 2 + 2 * level || ctx.queuedLevels.has(level)) continue;
      ctx.queuedLevels.add(level);
      if (RESEARCH_BITS[level] !== 0) {
        s.setLong(INVENTION_QUEUE, (s.long(INVENTION_QUEUE) | RESEARCH_BITS[level]) >>> 0);
        s.setByte(INVENTION_DELAY, 0);
        pokes.inventionLevelsQueued++;
      }
    }
  }
  // Keep-alive, every update before it runs: the riot counter and the game-over flag (P1, P2).
  function keepAlivePoke() {
    const map = ctx.game.map;
    if (!map) return;
    const s = state();
    if (s.byte(UNREST) !== 0) {
      s.setByte(UNREST, 0);
      pokes.unrestResets++;
    }
    // P3 again, per update: the sim's fall check (`$B086`) runs daily, and a month's floor is too late when the population drops
    // between two monthly floors (the population below 60 with no housing, or below 30 with housing).
    if (s.signedLong(A.population) < POP_FLOOR_NOW) {
      const add = POP_FLOOR - s.signedLong(A.population);
      s.setLong(A.population, POP_FLOOR);
      s.setLong(A.freeColonists, s.signedLong(A.freeColonists) + add);
      pokes.popTopUps++;
    }
    if ((map.sim.sysFlags & SYS.gameOver) !== 0) {
      // The first prevented fall is described (the sim's own check reads the population and the housing count, `$B086`).
      if (pokes.firstFall === null) {
        const recs = records(map.world);
        pokes.firstFall = { date: s.dateText(), population: s.signedLong(A.population), housing: countOf(recs, 0x2f), buildings: recs.length, unrest: s.byte(UNREST) };
      }
      map.sim.sysFlags &= ~SYS.gameOver;
      pokes.fallsPrevented++;
    }
  }

  // Keep-alive: the building plan's stock of the bot's own removals and the destroyed buildings. A record whose origin cell
  // vanishes without a bot demolition is "destroyed"; a new record of a tile that was destroyed is "rebuilt".
  function trackRecords(recs) {
    const now = new Map();
    for (const r of recs) now.set(`${r.x},${r.y}`, r.target);
    if (ctx.prevKeys) {
      for (const [key, tile] of ctx.prevKeys) {
        if (now.has(key) || ctx.botRemoved.has(key)) continue;
        events.buildingsDestroyed++;
        events.destroyedByTile[tile] = (events.destroyedByTile[tile] ?? 0) + 1;
        ctx.pending.set(tile, (ctx.pending.get(tile) ?? 0) + 1);
      }
      for (const [key, tile] of now) {
        if (ctx.prevKeys.has(key)) continue;
        if (tile === 0x48) events.launchpadsBuilt++; // pads come only from the ships' buildPad order in keep-alive (PLAN_KEEP)
        const pending = ctx.pending.get(tile) ?? 0;
        if (pending > 0) {
          events.buildingsRebuilt++;
          ctx.pending.set(tile, pending - 1);
        }
      }
    }
    ctx.prevKeys = now;
    ctx.botRemoved.clear();
  }

  // Keep-alive: ships. A ship with fuel gets the buildPad order once no pad is pending (the hovering ship builds the pad).
  function keepAliveShips(map, recs, ships) {
    const enemies = map.enemies;
    let padShip = null;
    const pending = ships.some((sh) => enemies.padPending(sh));
    const pads = countOf(recs, 0x48);
    if (!pending && pads < 3) {
      padShip = ships.find((sh) => sh.fuel > 0 && !enemies.padPending(sh)) ?? null;
      if (padShip && enemies.commandShip(padShip, SHIP_ORDER.buildPad, null) === 0) events.padOrders++;
      else padShip = null;
    }
    for (const sh of ships) {
      if (sh === padShip || enemies.padPending(sh)) continue;
      const order = ctx.year % 2 === 0 ? SHIP_ORDER.front : SHIP_ORDER.hover;
      enemies.commandShip(sh, order, null);
      counters.shipOrders++;
    }
  }

  // Keep-alive: ship yards take a class when idle (the yard dialog's order, Fleet.orderShip). Class 1 first, then class 2.
  function keepAliveYards(map) {
    const o = map.world.objects;
    for (let slot = 0; slot < o.length / 8; slot++) {
      const at = slot * 8;
      if (((o[at] << 8) | o[at + 1]) !== 0x36) continue;
      if (o[at + 6] !== 0) continue;
      if (map.sim.fleet.orderShip(slot, 1 + (events.yardOrders % 2))) events.yardOrders++;
    }
  }

  // Keep-alive: the tank teleporter moves the tank nearest the teleporter onto the pin (teleportUnit, the window's call).
  function keepAliveTeleport(map, recs) {
    const s = state();
    const tele = recs.find((r) => r.target === 0x47);
    if (!tele || s.byte(0x144c8) !== 0) return;
    const units = map.objects?.units;
    const pin = map.objects?.markerCell(1);
    if (!units || !pin || units.units.length === 0) return;
    const tank = units.units.reduce((best, u) => ((u.x - tele.x) ** 2 + (u.y - tele.y) ** 2 < (best.x - tele.x) ** 2 + (best.y - tele.y) ** 2 ? u : best));
    const code = teleportUnit(ctx.game.screenContext(map), units, tank, pin);
    if (code === BUILDING_MSG.teleported) events.teleports++;
    else events.teleportRefused++;
  }

  // Keep-alive: one market trade a month through the market window's own buy/sell (the number entry is bypassed).
  function keepAliveTrade(map) {
    const s = state();
    const refusal = marketRefusal(s);
    if (refusal >= 0) {
      events.tradeRefused++;
      events.tradeRefusedBy[refusal] = (events.tradeRefusedBy[refusal] ?? 0) + 1;
      return;
    }
    const screen = openMarket(ctx.game.screenContext(map));
    if (!(screen instanceof MarketScreen)) return;
    const before = s.signedLong(A.money);
    const goodsAt = (item) => s.signedLong(GOODS_STOCK + 4 * (item - 1));
    // Sell where the market has demand (the demand array, item 1..5 = goods 0..4) and the colony has stock.
    for (let item = 1; item <= 5; item++) {
      if (s.long(0x14452 + 4 * item) === 0 || goodsAt(item) <= 0) continue;
      const stockBefore = goodsAt(item);
      screen.sell(item, 500);
      if (s.signedLong(A.money) !== before || goodsAt(item) !== stockBefore) {
        events.trades++;
        return;
      }
    }
    // Buy where the market has supply, when the stock is short and the colony can pay.
    for (let item = 1; item <= 5; item++) {
      if (s.long(0x1443a + 4 * item) === 0 || goodsAt(item) >= 300 || before < 150000) continue;
      screen.buy(item, 300);
      if (s.signedLong(A.money) !== before) {
        events.trades++;
        return;
      }
    }
  }

  // The monthly plan: economy settings, staffing, grants, building, pins and orders, missiles, a demolition now and then.
  function planMonth(map) {
    const s = state();
    const year = Math.floor(gameYears());
    ctx.year = year;
    const recs = records(map.world);
    const pop = s.signedLong(A.population);
    const keep = spec.keepAlive;
    if (keep) trackRecords(recs);
    topUpMoney();
    if (keep) keepAliveMonthly(map, year);
    // Economy: tax and grants through the UI's calls.
    map.sim.setNextTax(year < 3 ? 6 : 10);
    // Job pools 0-8 (game-state.md 5.x: 0 factory, 1 fuel plant, 2 mines, 3 ship yard, 4 tank yard, 5 workshop, 6 medics, 7 scientists,
    // 8 security). The caps leave colonists for the farms: assignFarmers takes what the pools leave free, and farms make the food.
    const POOL_CAPS = [2, 2, 8, 2, 4, 2, 2, 4, 4];
    for (let pool = 0; pool < 9; pool++) {
      map.sim.setJobCap(pool, POOL_CAPS[pool]);
      setStaffLevel(s, pool, POOL_CAPS[pool]);
    }
    const spare = s.signedLong(A.money) - 60000;
    if (spare > 0) {
      addToGrant(s, false, Math.min(4000, spare));
      addToGrant(s, true, Math.min(2000, Math.max(0, s.signedLong(A.money) - 60000)));
    }
    const intelYear = keep ? year % 2 === 0 : year % 3 === 0;
    if (intelYear && ctx.intelYear !== year && s.signedLong(A.money) > 60000) {
      ctx.intelYear = year;
      fundIntelligence(s, 5000);
      events.intelFunded++;
    }
    // Building: the plan in order, at most a few new buildings per month.
    const avail = availableTiles(map);
    let placedThisMonth = 0;
    const anchorBase = anchorOf(map, recs);
    for (const [tile, label, want] of keep ? PLAN_KEEP : PLAN) {
      if (placedThisMonth >= 6) break;
      if (!avail.has(tile)) continue;
      const have = countOf(recs, tile);
      const target = want({ year, pop });
      if (have >= target) continue;
      let type;
      try {
        type = map.world.findType(tile);
      } catch {
        continue;
      }
      const cost = s.word(map.world.typeAddress(type) + 6);
      if (s.signedLong(A.money) < cost + 20000) continue;
      let cell = placeNear(map, tile, anchorBase);
      if (!cell && keep && (s.byte(WARN) & 0x6) !== 0) {
        // P6: the sports event or the strike refuses every placement (build.ts place, $6CA2 area); cleared, then the placement again.
        s.setByte(WARN, s.byte(WARN) & ~0x6);
        pokes.warnClears++;
        cell = placeNear(map, tile, anchorBase);
      }
      if (cell) {
        counters.buildings++;
        counters.buildingsByTile[label] = (counters.buildingsByTile[label] ?? 0) + 1;
        if (tile === 0x36) events.shipYards++;
        placedThisMonth++;
      }
    }
    // Demolition, once every four years: a sports complex (when two stand) far from the anchor. Exercises Builder.demolish.
    if (year >= 4 && year % 4 === 0 && ctx.lastDemolishYear !== year && countOf(recs, 0x5c) >= 2) {
      ctx.lastDemolishYear = year;
      const victim = recs.filter((r) => r.tile === 0x5c).sort((a, b) => (b.x - anchorBase.x) ** 2 + (b.y - anchorBase.y) ** 2 - ((a.x - anchorBase.x) ** 2 + (a.y - anchorBase.y) ** 2))[0];
      if (map.controls.builder.demolish(victim.x, victim.y)) {
        counters.demolished++;
        ctx.botRemoved.add(`${victim.x},${victim.y}`);
      }
    }
    // Pins and tank orders: pin 1 near the nearest enemy ground unit, else east of the colony; the tanks walk there.
    const units = map.objects?.units;
    const enemies = map.enemies;
    if (units && enemies) {
      let target = { x: Math.min(MAP_WIDTH - 5, anchorBase.x + 14), y: anchorBase.y };
      const nearest = enemies.groundSlots.find((e) => e !== null);
      if (nearest) target = { x: nearest.x, y: nearest.y };
      const pin = map.objects.markerCell(1);
      if (!pin || pin.x !== target.x || pin.y !== target.y) {
        if (pin) map.objects.toggleMarker(1, pin.x, pin.y); // removes the pin at its cell
        if (map.objects.toggleMarker(1, target.x, target.y) === "placed") counters.pinsSet++;
      }
      const tanks = units.units;
      if (tanks.length > 0) {
        const pinNow = map.objects.markerCell(1);
        if (pinNow) {
          const pinned = orderGroup(units, tanks[0], "nearPin", Math.ceil(tanks.length / 2), pinNow).length;
          counters.tankOrders += pinned;
          events.pinOrders += pinned;
        }
        if (keep) {
          // To the front: the tanks walk off the east map edge (units.ts env.leave -> tankLeft -> sendToFront). The order target
          // must fit the save format (tanks[].targetX 0..255, the save's own check), so the west edge is not used: a target west
          // of the map would be -8, which no player order can make.
          const edge = { x: MAP_WIDTH + 8, y: anchorBase.y };
          const sent = orderGroup(units, tanks[0], "front", Math.ceil(tanks.length / 2), edge).length;
          counters.tankOrders += sent;
          events.frontOrders += sent;
        } else if (pinNow) {
          counters.tankOrders += orderGroup(units, tanks[0], "front", tanks.length, pinNow).length;
        }
      }
    }
    // Ships: the yard's ships go to the front, or hover, alternating by year.
    const fleet = map.sim.fleet;
    const ships = fleet.slots.filter((r) => r !== null && !isMissile(r));
    if (keep) {
      keepAliveYards(map);
      keepAliveTeleport(map, recs);
      keepAliveTrade(map);
    }
    if (map.enemies) {
      if (keep) keepAliveShips(map, recs, ships);
      else {
        for (const ship of ships) {
          const order = year % 2 === 0 ? SHIP_ORDER.front : SHIP_ORDER.hover;
          map.enemies.commandShip(ship, order, null);
          counters.shipOrders++;
        }
      }
      // Missiles from a launch pad at the nearest enemy ground unit (the building window's target).
      const pad = recs.find((r) => r.target === 0x48);
      if (pad) {
        const t = map.enemies.findTarget(40, pad.x, pad.y);
        if (t && map.enemies.launchMissile({ x: pad.x, y: pad.y }, t)) counters.missilesLaunched++;
      }
    }
    counters.peakBuildings = Math.max(counters.peakBuildings, recs.length);
  }

  // The bombardment variant, once a day: bombs on the colony and injected enemies on its cells (see the header).
  const TEMPLATE_GROUND = [22, 23, 24];
  const TEMPLATE_AIR = [25, 26, 27];
  function bombardDay(map) {
    const recs = records(map.world);
    const built = recs.filter((r) => r.tile !== 0x32 && r.tile !== 0x38);
    for (let k = 0; k < 2 && built.length > 0; k++) {
      const r = built[int(0, built.length - 1)];
      map.sim.bomb(r.x, r.y);
      counters.bombs++;
    }
    // Ground and air enemies on random cells; a refusal means that pool is full.
    for (let k = 0; k < 4; k++) {
      const air = k % 2 === 1;
      const type = air ? TEMPLATE_AIR[int(0, 2)] : TEMPLATE_GROUND[int(0, 2)];
      const x = int(4, MAP_WIDTH - 5);
      const y = int(4, MAP_HEIGHT - 5);
      const spawn = { air, type, level: 1, x, y, dir: int(0, 7), entry: [type, 6, 0, 3, 1, 0, 0, 0] };
      if (map.sim.spawnEnemy(spawn)) counters.injected++;
      else counters.injectRefused++;
    }
    // Missiles at the nearest ground enemy from a random colony cell, a few per day.
    for (let k = 0; k < 3 && built.length > 0; k++) {
      const r = built[int(0, built.length - 1)];
      const t = map.enemies?.findTarget(60, r.x, r.y);
      if (t && map.enemies.launchMissile({ x: r.x, y: r.y }, t)) counters.missilesLaunched++;
    }
  }

  // Pool sizes, queues and the other invariants (every 250 updates and at each save and load).
  function sample(where) {
    const game = ctx.game;
    const map = game.map;
    const px = game.screen.pixels;
    let max = 0;
    for (let i = 0; i < px.length; i++) if (px[i] > max) max = px[i];
    check("screen pixels < 32", max < 32, `${where}: max index ${max} at stage ${game.stage}`);
    if (!map) return;
    const s = map.world.state;
    const money = s.signedLong(A.money);
    const pop = s.signedLong(A.population);
    const morale = s.signedLong(A.morale);
    const qol = s.long(A.qualityOfLife);
    lastMinMoney = Math.min(lastMinMoney, money);
    lastMaxMoney = Math.max(lastMaxMoney, money);
    maxPopulation = Math.max(maxPopulation, pop);
    // Goods stocks: a negative stock is original behaviour (see the header); only finiteness is required, and the negatives are counted.
    let goodsFinite = true;
    for (const good of [0, 1, 2, 3, 4]) {
      const stock = s.signedLong(0x13152 + 4 * good);
      counters.goodsMinSigned = Math.min(counters.goodsMinSigned, stock);
      if (!Number.isSafeInteger(stock)) goodsFinite = false;
      if (stock < 0) counters.negativeGoodsSamples++;
    }
    minQol = Math.min(minQol, qol);
    maxQol = Math.max(maxQol, qol);
    minMorale = Math.min(minMorale, morale);
    maxMorale = Math.max(maxMorale, morale);
    check("money is a finite integer, |m| < 1e9", Number.isSafeInteger(money) && Math.abs(money) < 1e9, `${where}: money ${money}`);
    check("population is a finite integer in 0..1e7", Number.isSafeInteger(pop) && pop >= 0 && pop <= 1e7, `${where}: population ${pop}`);
    check("morale is a finite integer", Number.isSafeInteger(morale), `${where}: morale ${morale}`);
    check("goods stocks are finite integers (negative stocks are counted, not failed)", goodsFinite, `${where}: goods stock ${counters.goodsMinSigned}`);
    // Computed on the first day of each month (sim.ts qualityOfLife); before that the stored value is the initial 0.
    if (ctx.days >= 31) check("quality of life 10..98 (clamped)", qol >= 10 && qol <= 98, `${where}: quality of life ${qol}`);
    const u = map.objects?.units;
    const e = map.enemies;
    const f = map.sim.fleet;
    const fx = map.objects?.effectSlots;
    check("slot arrays keep their fixed sizes", (u?.slots.length ?? sizes.units) === sizes.units && (e?.groundSlots.length ?? sizes.ground) === sizes.ground && (e?.airSlots.length ?? sizes.air) === sizes.air && f.slots.length === sizes.fleet && (fx?.length ?? sizes.effects) === sizes.effects, `${where}: unit ${u?.slots.length} ground ${e?.groundSlots.length} air ${e?.airSlots.length} fleet ${f.slots.length} effects ${fx?.length}`);
    const ground = e ? e.groundSlots.filter((x) => x !== null).length : 0;
    const air = e ? e.airSlots.filter((x) => x !== null).length : 0;
    const effects = fx ? fx.filter((x) => x !== null).length : 0;
    const missiles = f.slots.filter((r) => r !== null && isMissile(r)).length;
    poolMax.ground = Math.max(poolMax.ground, ground);
    poolMax.air = Math.max(poolMax.air, air);
    poolMax.effects = Math.max(poolMax.effects, effects);
    poolMax.missiles = Math.max(poolMax.missiles, missiles);
    if (ground === sizes.ground) poolFull.ground++;
    if (air === sizes.air) poolFull.air++;
    if (effects === sizes.effects) poolFull.effects++;
    if (missiles === sizes.fleet) poolFull.missiles++;
    check("queues bounded (announcements <= 16, sim events <= 64, log <= 64)", game.announcements.length <= 16 && map.sim.events.length <= 64 && (map.messages?.entries?.length ?? 0) <= 64, `${where}: announcements ${game.announcements.length} events ${map.sim.events.length} log ${map.messages?.entries?.length}`);
  }

  // The heap after a collection: warm at year 2, final at the end.
  function heapCheck(where) {
    if (typeof global.gc === "function") global.gc();
    const used = process.memoryUsage().heapUsed;
    ctx.heapPeak = Math.max(ctx.heapPeak, used);
    if (ctx.heapStart === 0) ctx.heapStart = used;
    return used;
  }

  // Save then load (Game.saveToSlot / loadFromSlot). The loaded scene must continue on the map with the same scenario and money.
  function saveAndLoad(where) {
    const game = ctx.game;
    const scenario = game.scenario;
    const money = game.map.world.state.signedLong(A.money);
    const slot = ctx.saveSlot++ % SAVE_SLOTS;
    const saved = game.saveToSlot(slot, null);
    if (!saved) {
      check("save to a slot succeeds", false, `${where}: ${game.lastSaveError?.code}: ${game.lastSaveError?.message}`);
      return;
    }
    counters.saves++;
    const loaded = game.loadFromSlot(slot, false);
    if (!loaded) {
      check("load of the slot just saved succeeds", false, `${where}: ${game.lastLoadError?.code}: ${game.lastLoadError?.message}`);
      return;
    }
    counters.loads++;
    check("load of the slot just saved succeeds", true);
    const restored = game.stage === "map" && game.scenario === scenario && game.map !== null && game.map.world.state.signedLong(A.money) === money;
    check("the loaded scene continues with the saved scenario and money", restored, `${where}: stage ${game.stage}, scenario ${game.scenario} (saved ${scenario}), money ${game.map?.world.state.signedLong(A.money)} (saved ${money})`);
    instrument();
  }

  // ---- the year loop ----
  const stopReasons = { years: "years reached", over: "colony fall (game over)", wall: "wall-time limit", stall: "stalled calendar" };
  let endReason = null;
  let monthKey = "";
  let lastDate = "";
  let dateUpdate = 0;
  let sampleEvery = 250;
  let saveEvery = 3;
  let lastSaveYear = -1;

  try {
    bootAndEnter();
    check("boot and entry reach the map", true);
    instrument();
    monthKey = state().dateText().slice(3);
    lastDate = state().dateText();
    dateUpdate = ctx.updates;
    heapCheck("start");

    for (;;) {
      // P1, P2 (keep-alive): the riot counter and the game-over flag are cleared before the sim's check sees them.
      if (spec.keepAlive) keepAlivePoke();
      if (ctx.game.map.sim.gameOver) {
        counters.colonyFall = true;
        endReason = "over";
        break;
      }
      const map = ctx.game.map;
      const years = Math.floor(gameYears());
      if (gameYears() >= TARGET_YEARS) {
        endReason = "years";
        break;
      }
      if ((Date.now() - started) / 1000 > WALL_SECONDS) {
        endReason = "wall";
        break;
      }
      // Calendar: a stall is no new day for 6000 updates (a day is about 90 updates).
      const date = state().dateText();
      if (date !== lastDate) {
        lastDate = date;
        dateUpdate = ctx.updates;
        ctx.days++;
        if (ctx.game.stage === "map" && spec.bombard) bombardDay(map);
      } else if (ctx.updates - dateUpdate > 6000 && ctx.game.stage !== "offer" && ctx.game.stage !== "announce") {
        check("calendar advances (no stall)", false, `no new day for ${ctx.updates - dateUpdate} updates at ${date} stage ${ctx.game.stage}`);
        endReason = "stall";
        break;
      }
      const monthNow = date.slice(3);
      if (monthNow !== monthKey) {
        monthKey = monthNow;
        if (ctx.game.stage === "map") {
          try {
            planMonth(ctx.game.map);
          } catch (error) {
            check("monthly planning runs without exception", false, `${date}: ${error?.stack?.split("\n").slice(0, 3).join(" | ")}`);
          }
        }
        if (years >= 2 && ctx.heapWarm === null) ctx.heapWarm = heapCheck("warm");
        if (years >= lastSaveYear + saveEvery && ctx.game.stage === "map") {
          lastSaveYear = years;
          saveAndLoad(`year ${years}`);
        }
      }
      if (ctx.updates % sampleEvery === 0) sample(`year ${years}`);
      if (ctx.game.stage === "announce" || ctx.game.stage === "offer") settle();
      else if (ctx.game.stage === "map") update({});
      else {
        check("the map stays the active stage", false, `stage ${ctx.game.stage} at ${date}`);
        endReason = "stage";
        break;
      }
      if (ctx.game.map !== ctx.map) instrument();
    }
    // Final checks.
    if (ctx.game.map && !ctx.game.map.sim.gameOver) {
      sample("end");
      saveAndLoad("end");
    }
    if (ctx.game.map?.sim.gameOver) counters.colonyFall = true;
    const finalHeap = heapCheck("end");
    if (ctx.heapWarm !== null) {
      const limit = ctx.heapWarm * 1.5 + 64 * 1024 * 1024;
      check("heap after gc does not grow more than 1.5x + 64 MB from year 2", finalHeap <= limit, `warm ${(ctx.heapWarm / 1e6).toFixed(0)} MB, end ${(finalHeap / 1e6).toFixed(0)} MB`);
    }
    check("no single update over 1 s", ctx.maxUpdateMs <= 1000, `slowest update ${ctx.maxUpdateMs.toFixed(0)} ms`);
  } catch (error) {
    if (error instanceof Stop) {
      check("no exception", false, `${ctx.crash?.message} at stage ${ctx.crash?.stage} | ${ctx.crash?.stack}`);
      endReason = "crash";
    } else {
      check("the run completes without exception", false, `${error?.message ?? error} | ${String(error?.stack ?? "").split("\n").slice(0, 4).join(" | ")}`);
      endReason = "error";
    }
  }
  if (!checks.has("no exception")) check("no exception", endReason !== "crash" && endReason !== "error", "");
  if (spec.keepAlive) {
    const reached = endReason === "years";
    const endText0 = stopReasons[endReason] ?? endReason ?? "unknown";
    check(`keep-alive reaches ${TARGET_YEARS} game years`, reached, `ended by ${endText0} at ${(gameYears()).toFixed(1)} years`);
  }

  const years = gameYears();
  const buildings = counters.buildings;
  const label = spec.label;
  const endText = stopReasons[endReason] ?? endReason ?? "unknown";
  const lines = [];
  for (const [name, c] of checks) {
    if (c.fail === 0) lines.push(`ok   ${label}: ${name} (${c.ok})`);
    else lines.push(`FAIL ${label}: ${name} (${c.fail} failures, ${c.ok} ok)  ${c.detail}`);
  }
  const eventTable = {
    "ship yards built": counters.buildingsByTile["ship yard"] ?? 0,
    "ship class ordered": events.yardOrders,
    "launchpads built": events.launchpadsBuilt,
    "ships built": counters.shipsBuilt,
    "tanks built": counters.unitsBuilt,
    "tanks ordered to pins": events.pinOrders,
    "tanks ordered to the front": events.frontOrders,
    "tanks sent to the front": counters.tanksToFront,
    "teleports used": events.teleports,
    "missiles launched": counters.missilesLaunched,
    "intel funded": events.intelFunded,
    "trades made": events.trades,
    "Earth offers accepted": events.offersAccepted,
    "Earth offers refused": events.offersRefused,
    "buildings destroyed": events.buildingsDestroyed,
    "buildings rebuilt": events.buildingsRebuilt,
    "alien defeat": counters.alienDefeat ? 1 : 0,
  };
  if (spec.keepAlive) {
    const never = Object.entries(eventTable).filter(([, n]) => n === 0).map(([name]) => name);
    for (const name of never) lines.push(`note ${label}: never seen: ${name}  (${NEVER_SEEN[name] ?? "no reason recorded"})`);
  }
  for (const line of lines) console.log(line);
  return {
    label,
    keepAlive: spec.keepAlive,
    years: Number.isFinite(years) ? years : 0,
    endReason: endText,
    endDate: ctx.game?.map ? state().dateText() : "",
    buildings,
    buildingsByTile: counters.buildingsByTile,
    demolished: counters.demolished,
    unitsBuilt: counters.unitsBuilt,
    shipsBuilt: counters.shipsBuilt,
    missilesBuilt: counters.missilesBuilt,
    missilesLaunched: counters.missilesLaunched,
    tankOrders: counters.tankOrders,
    shipOrders: counters.shipOrders,
    pinsSet: counters.pinsSet,
    waveSpawns: counters.waveSpawns,
    injected: counters.injected,
    injectRefused: counters.injectRefused,
    bombs: counters.bombs,
    bombings: counters.bombings,
    combatCalls: counters.combatCalls,
    kills: counters.kills,
    losses: counters.losses,
    alienDefeat: counters.alienDefeat,
    colonyFall: counters.colonyFall,
    saves: counters.saves,
    loads: counters.loads,
    offers: counters.offers,
    announcements: counters.announcements,
    moneyTopUps: counters.moneyTopUps,
    poolFull,
    poolMax,
    money: { min: lastMinMoney, max: lastMaxMoney },
    maxPopulation,
    qualityOfLife: { min: minQol, max: maxQol },
    morale: { min: minMorale, max: maxMorale },
    updates: ctx.updates,
    maxUpdateMs: Math.round(ctx.maxUpdateMs),
    heapMB: { start: Math.round(ctx.heapStart / 1e6), peak: Math.round(ctx.heapPeak / 1e6) },
    wallSeconds: Math.round((Date.now() - started) / 1000),
    seed: SEED,
    checks: Object.fromEntries([...checks].map(([k, c]) => [k, { ok: c.ok, fail: c.fail }])),
    crash: ctx.crash ?? null,
    bombard: spec.bombard,
    negativeGoodsWrites: counters.negativeGoodsWrites,
    negativeGoodsSamples: counters.negativeGoodsSamples,
    goodsMinSigned: counters.goodsMinSigned,
    pokes: spec.keepAlive ? { ...pokes, botDeclinedOffers: events.offersDeclined } : null,
    events: spec.keepAlive ? { ...events, tanksToFront: counters.tanksToFront } : null,
  };
}

// ---- parent: starts one child per run and prints their checks -----------------------------------------------------------------------
if (!process.env[CHILD_ENV]) {
  const only = process.env.UTOPIA_AUTOPLAY_ONLY || null;
  const runs = RUNS.filter((r) => (MODE === "all" || (MODE === "keepalive") === r.keepAlive) && (only === null || r.label === only || r.key === only));
  if (runs.length === 0) {
    console.log(`FAIL autoplay  UTOPIA_AUTOPLAY_ONLY "${only}" names no run in mode ${MODE}`);
    process.exit(1);
  }
  console.log(`autoplay: seed ${SEED}, mode ${MODE}, ${YEARS} game years per normal run, ${KEEP_YEARS} per keep-alive run (wall limit ${WALL_SECONDS} s), ${runs.length} runs in parallel`);
  const started = Date.now();
  const outputs = await Promise.all(runs.map((run) => runChild(run)));
  const results = [];
  let failed = 0;
  let passed = 0;
  const notes = [];
  for (let i = 0; i < runs.length; i++) {
    const out = outputs[i];
    for (const line of out.lines) {
      if (line.startsWith("AUTOPLAY_RESULT ")) continue;
      if (line.startsWith("note ")) {
        notes.push(line);
        continue;
      }
      console.log(line);
      if (line.startsWith("FAIL ")) failed++;
      else if (line.startsWith("ok   ")) passed++;
    }
    if (out.result) results.push(out.result);
    else {
      failed++;
      console.log(`FAIL ${runs[i].label}  the run produced no result (exit ${out.code})`);
    }
  }
  const normal = results.filter((r) => !r.keepAlive);
  const keep = results.filter((r) => r.keepAlive);
  if (normal.length > 0) {
    console.log("---- per scenario");
    console.log(table(normal, NORMAL_COLUMNS));
  }
  if (keep.length > 0) {
    console.log(`---- keep-alive, per scenario (target ${KEEP_YEARS} game years)`);
    console.log(table(keep, KEEP_COLUMNS));
    console.log("---- keep-alive events never seen (the reason is read from the source)");
    for (const line of notes) console.log(line.slice("note ".length));
    if (notes.length === 0) console.log("(every event was seen in every keep-alive run)");
  }
  console.log(`---- summary: ${passed} ok, ${failed} FAIL, ${runs.length} runs, ${((Date.now() - started) / 1000).toFixed(1)} s wall`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- child -----------------------------------------------------------------------------------------------------------------------------
const childKey = process.env[CHILD_ENV];
const runSpec = RUNS.find((r) => r.key === childKey);
if (!runSpec) throw new Error(`unknown autoplay child ${childKey}`);
const out = await runAutoplay(runSpec);
console.log(`AUTOPLAY_RESULT ${JSON.stringify(out)}`);
process.exit(0);
