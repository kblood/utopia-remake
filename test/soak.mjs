// Seeded random-input fuzz and long-run soak of the real Game (src/game/game.ts), run through Game.update only.
//
// Per scenario (1-10) and the tutorial: a fresh Game boots (language stub, real boot stages, boot disk menu), enters the game proper
// through the real disk-menu clicks (scenario list row + EXIT, or the tutorial icon), then
//   1. fuzz: UTOPIA_SOAK_FRAMES updates of random but realistic input: a pointer that drifts towards hotspots (map window, command column,
//      disk icons, list and menu rows, anywhere), left presses held for random lengths, rare right clicks, and key presses with releases
//      (F1-F6, digits 1-8, d, p, space, Enter, Escape, Backspace, Tab, letters, keypad tokens). Menus are fuzzed too (save, load, remake
//      submenu, scenario list, music list, Disk.4 pages, error pages, windows). Outside the map for STUCK_LIMIT updates, the driver drives
//      back: an EXIT click from the disk menu, or the defined escape from other stages (escape key, right click, the window or announcement
//      exit, the offer's refuse). A stage that the escape does not leave is a soft lock. A game over starts a fresh game of the same kind.
//   2. idle: no input except dismissing announcements (exit button) and offers (accept or refuse), until UTOPIA_SOAK_FRAMES updates or
//      game over.
// Invariants (every CHECK_EVERY updates): no exception; screen pixel indices < 32; money and population finite integers, population not
// negative; a save to a random slot followed by a load of that slot succeeds (same scenario and money). No update takes over 1 second.
//
// Determinism: the test's own generator is seeded (UTOPIA_SOAK_SEED); the game's randomness is injected (world solar-phase seed and the
// sim's generator, both from the run seed) and Math.random is replaced by a seeded generator for the run. Wall-clock time is only used for
// the 1 second check, which never changes game state, so a failure reruns identically with the same seed and frame count.
//
// Config: UTOPIA_SOAK_SEED (default 1), UTOPIA_SOAK_FRAMES (fuzz updates per run; idle uses the same count), UTOPIA_SOAK_ONLY (optional
// run name such as "scenario 3" or "tutorial", to rerun one run). Skipped with exit 0 when the original Disk.1 / Disk.2 are missing.
// Only reads the user's own files at runtime; nothing is written except the in-memory localStorage stub.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1Path) || !fs.existsSync(d2Path)) {
  console.log("soak skipped: original data not found (original/utopia-whdload/Disk.1 and Disk.2)");
  process.exit(0);
}

const DEFAULT_FRAMES = 18000; // sized so the default run takes about a minute

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return Number(raw);
}
const SEED = envInt("UTOPIA_SOAK_SEED", 1);
const FRAMES = envInt("UTOPIA_SOAK_FRAMES", DEFAULT_FRAMES);
const ONLY = process.env.UTOPIA_SOAK_ONLY || null;
const STUCK_LIMIT = 200; // consecutive updates outside the map before the driver drives back
const CHECK_EVERY = 250; // invariant check cadence (updates)
const ROUND_TRIP_EVERY = 1500; // save/load round trip cadence (updates, when on the map)
const MAX_UPDATE_MS = 1000;
const BOOT_LIMIT = 25000;

// ---- localStorage stub (the save slots live here; each run starts empty) ------------------------------------------------------------
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};
const SLOT_PREFIX = "utopia-remake-save-";

const { decodePicture, PICTURES } = await import("../dist/data/picture.js");
const { Screen } = await import("../dist/gfx/screen.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
const { SAVE_SLOTS } = await import("../dist/game/save.js");
const { keypadToken, keyUpToken, KEYPAD_ENTER_TOKEN } = await import("../dist/game/intro.js");
const { A } = await import("../dist/game/state.js");
const { createRng } = await import("../dist/game/sim-math.js");
const { EXIT_BUTTON } = await import("../dist/game/screens/ui.js");
const { CouncilScreen } = await import("../dist/game/screens/council.js");
const { OverviewScreen, EXIT_BUTTON_INDEX } = await import("../dist/game/screens/overview.js");

const disk1 = new Uint8Array(fs.readFileSync(d1Path));
const disk2 = new Uint8Array(fs.readFileSync(d2Path));

// ---- seeded generators ----------------------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- failures ------------------------------------------------------------------------------------------------------------------------------
class SoakFailure extends Error {}

// Every failure names the seed, the run, the update index and the stage, then the stack (of the exception, if any).
function failure(ctx, what, cause = null) {
  const stage = ctx.game ? safeStage(ctx.game) : "?";
  const stack = cause?.stack ?? new Error(what).stack;
  const head = `seed ${SEED} ${ctx.run.name} update ${ctx.updates} stage ${stage} phase ${ctx.phase}: ${what}`;
  const error = new SoakFailure(head);
  error.stack = `${head}\n${String(stack).split("\n").slice(1, 9).join("\n")}`;
  error.ctx = ctx;
  return error;
}
function safeStage(game) {
  try {
    return game.stage;
  } catch {
    return "?";
  }
}

// ---- stats ----------------------------------------------------------------------------------------------------------------------------------
const stats = {
  updates: 0,
  stageUpdates: {}, // updates whose stage after the update was this stage
  stageEntries: {}, // transitions into this stage
  maxUpdateMs: 0,
  saves: 0,
  saveRefusals: {},
  loads: 0,
  maxSlotChars: 0,
  slotCharsTotal: 0,
  gameOvers: 0,
  restarts: 0,
  stuckDriveBacks: 0,
  escapes: 0,
  idleUpdates: 0,
  idleYears: [],
  runs: [],
  pixelChecks: 0,
};

// ---- the boot session: language stub, real boot stages and the boot disk menu -------------------------------------------------------
function fakeMusic() {
  const m = {
    trackCount: 4,
    current: -1,
    paused: false,
    get active() { return m.current >= 0 && !m.paused; },
    setActive(on) { if (m.current < 0 || m.paused === !on) return false; m.paused = !on; return true; },
    play(track) { if (track < 0 || track >= m.trackCount) return; m.current = track; m.paused = false; },
    stop() { m.current = -1; m.paused = false; },
    fadeOut() {},
    setVolume() {},
    setChannelMuted() {},
    resume() {},
    title: () => "",
    dispose() {},
  };
  return m;
}

const runSeedOf = (index) => (Math.imul(SEED, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b) ^ 0x2545f491) >>> 0;

function newGame(ctx) {
  const runSeed = runSeedOf(ctx.runIndex);
  // The game's own randomness: the world's solar-phase stream and the sim's generator (the default sim generator is already fixed).
  const inputs = { world: { solarPhaseSeed: runSeed }, simulation: { rng: createRng((runSeed ^ 0x5bd1e995) >>> 0) } };
  const game = new Game(disk1, disk2, fakeMusic(), null, inputs);
  game.stage = "language";
  game.language = { pointerVisible: true, screen: new Screen(), picturePalette: decodePicture(disk1, PICTURES.language).palette, update: () => ({ state: "chosen", language: 0 }) };
  ctx.game = game;
  ctx.stage = "language";
  ctx.prevStage = "language";
  return game;
}

// ---- input building blocks ------------------------------------------------------------------------------------------------------------
const quiet = (x = 0, y = 0) => ({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });

// One update with the given input. The stage bookkeeping and the 1-second check live here.
function step(ctx, input) {
  const game = ctx.game;
  const before = ctx.prevStage;
  const t0 = performance.now();
  try {
    game.update(input);
  } catch (error) {
    throw failure(ctx, `exception from Game.update: ${error?.message ?? error}`, error);
  }
  const ms = performance.now() - t0;
  ctx.updates++;
  stats.updates++;
  if (ms > stats.maxUpdateMs) stats.maxUpdateMs = ms;
  if (ms > MAX_UPDATE_MS) throw failure(ctx, `one update took ${ms.toFixed(0)} ms (limit ${MAX_UPDATE_MS} ms)`);
  const after = game.stage;
  ctx.stage = after;
  stats.stageUpdates[after] = (stats.stageUpdates[after] ?? 0) + 1;
  if (after !== before) {
    stats.stageEntries[after] = (stats.stageEntries[after] ?? 0) + 1;
    ctx.prevStage = after;
  }
  return game;
}

const press = (ctx, x, y, { right = false } = {}) => step(ctx, { leftButton: !right, rightButton: right, pointerX: x, pointerY: y, keys: [] });

// The same edges the scenes see as a click: press, one held update, release.
function tap(ctx, x, y) {
  step(ctx, { leftButton: true, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  step(ctx, { leftButton: true, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  step(ctx, { leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
}
// A press and a release only: an offer answers on the press edge, so a longer tap would leave its held button for the next stage.
function quickTap(ctx, x, y) {
  step(ctx, { leftButton: true, rightButton: false, pointerX: x, pointerY: y, keys: [] });
  step(ctx, { leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
}
function rightTap(ctx, x = 0, y = 0) {
  step(ctx, { leftButton: false, rightButton: true, pointerX: x, pointerY: y, keys: [] });
  step(ctx, { leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
}
function keyTap(ctx, key) {
  step(ctx, { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [key] });
  step(ctx, { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [keyUpToken(key)] });
}
const centre = (rect) => [rect.x0 + 8, rect.y0 + 8];
const diskIconAt = (ctx, i) => tap(ctx, ...centre(DISK_MENU_BUTTONS[i]));
const listRowAt = (ctx, row) => tap(ctx, 100, 0x20 + row * 9 + 4);

// ---- boot and entry -------------------------------------------------------------------------------------------------------------------
function bootTo(ctx) {
  const game = ctx.game;
  step(ctx, quiet()); // the language stub reports its choice in this update
  let inCheck = 0;
  for (let n = 1; game.stage === "boot" || game.stage === "language"; n++) {
    if (n > BOOT_LIMIT) throw failure(ctx, "the boot stages did not finish");
    if (game.stage === "boot" && game.boot?.currentPhase === "E") inCheck++;
    step(ctx, { ...quiet(), keys: inCheck === 50 ? ["Enter"] : [] });
  }
  if (game.stage !== "disk" || game.map !== null) throw failure(ctx, `after boot: expected the boot disk menu, got stage ${game.stage}`);
  // The disk menu's first update ignores a button already held (its pointer starts from the held state, boot-menu.mjs): one quiet frame.
  step(ctx, quiet());
}

// Enter the run's scenario or the tutorial from the boot disk menu, through the real icons and the scenario list.
function enterRun(ctx) {
  const game = ctx.game;
  if (ctx.run.kind === "tutorial") {
    diskIconAt(ctx, DISK_BUTTON.tutorial);
  } else {
    diskIconAt(ctx, DISK_BUTTON.scenario); // icon 2 acts on its release and waits for a fresh press
    press(ctx, 0, 0);
    step(ctx, quiet());
    listRowAt(ctx, ctx.run.index);
    if (game.stage !== "scenario" || game.heldScene?.index !== ctx.run.index) throw failure(ctx, `scenario ${ctx.run.index + 1} did not hold (stage ${game.stage})`);
    diskIconAt(ctx, DISK_BUTTON.exit);
  }
  clearPending(ctx); // the first map pass can post an announcement or an offer
  const wanted = ctx.run.kind === "tutorial" ? 0 : ctx.run.index;
  if (game.stage !== "map" || game.map === null || game.scenario !== wanted) throw failure(ctx, `entry failed: stage ${game.stage}, scenario ${game.scenario}`);
}

function startGame(ctx) {
  newGame(ctx);
  bootTo(ctx);
  enterRun(ctx);
}

// ---- driver: random but realistic input ----------------------------------------------------------------------------------------------
// The ten 16 x 16 command buttons (controls.ts BUTTONS, top-left corners), as centres. Index 8 is the disk icon.
const COMMAND_BUTTONS = [
  { x: 272, y: 63 }, { x: 296, y: 63 }, { x: 272, y: 82 }, { x: 296, y: 82 }, { x: 272, y: 101 },
  { x: 296, y: 101 }, { x: 272, y: 120 }, { x: 296, y: 120 }, { x: 296, y: 139 }, { x: 272, y: 139 },
].map((c) => ({ x: c.x + 8, y: c.y + 8 }));
const DISK_CENTRES = DISK_MENU_BUTTONS.map((r) => ({ x: r.x0 + 8, y: r.y0 + 8 }));
const HOTSPOTS = [
  { w: 0.34, box: [16, 16, 250, 150] }, // the map window
  { w: 0.2, pts: COMMAND_BUTTONS }, // command column
  { w: 0.12, pts: DISK_CENTRES }, // disk icons
  { w: 0.1, box: [40, 40, 200, 150] }, // list and menu rows
  { w: 0.08, box: [0, 150, 319, 199] }, // window button rows and the message line
  { w: 0.16, box: [0, 0, 319, 199] }, // anywhere
];
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const SPECIAL_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "1", "2", "3", "4", "5", "6", "7", "8", "d", "p", " ", "Enter", "Escape", "Backspace", "Tab"];
const KEY_POOL = [...SPECIAL_KEYS, ...SPECIAL_KEYS, ...LETTERS, ...LETTERS.slice(0, 10), keypadToken("Enter"), KEYPAD_ENTER_TOKEN, ...Array.from({ length: 10 }, (_, d) => keypadToken(String(d)))];

class Driver {
  constructor(rand) {
    this.r = rand;
    this.x = 160;
    this.y = 100;
    this.tx = 160;
    this.ty = 100;
    this.retargetIn = 0;
    this.held = 0;
    this.gap = 0;
    this.rightLeft = 0;
    this.releases = []; // { due, token }
    this.tick = 0;
    this.atTarget = false;
    this.dwell = 0;
  }

  int(lo, hi) {
    return lo + Math.floor(this.r() * (hi - lo + 1));
  }

  pickTarget() {
    let u = this.r();
    let spot = HOTSPOTS[HOTSPOTS.length - 1];
    for (const h of HOTSPOTS) {
      if (u < h.w) {
        spot = h;
        break;
      }
      u -= h.w;
    }
    if (spot.pts) {
      const p = spot.pts[this.int(0, spot.pts.length - 1)];
      this.tx = Math.max(0, Math.min(319, p.x + this.int(-3, 3)));
      this.ty = Math.max(0, Math.min(199, p.y + this.int(-3, 3)));
    } else {
      const [x0, y0, x1, y1] = spot.box;
      this.tx = this.int(x0, x1);
      this.ty = this.int(y0, y1);
    }
  }

  holdLength() {
    const u = this.r();
    if (u < 0.45) return 1;
    if (u < 0.85) return this.int(2, 6);
    if (u < 0.98) return this.int(7, 40);
    return this.int(41, 240);
  }

  // `stage` is the stage the last update left: off the map, a player closes windows and menus, so the driver sends Escape or a right click
  // now and then (the pointer and keys go on as usual).
  next(stage) {
    this.tick++;
    // Reaching a target, the pointer dwells there for a while (clicks are likelier then), and only then picks the next one.
    const reached = Math.abs(this.tx - this.x) < 3 && Math.abs(this.ty - this.y) < 3;
    if (reached && this.dwell === 0) this.dwell = this.int(4, 30);
    if (this.dwell > 0) this.dwell--;
    if ((this.dwell === 0 && reached) || --this.retargetIn <= 0) {
      this.pickTarget();
      this.retargetIn = this.int(5, 60);
    }
    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    const dist = Math.hypot(dx, dy);
    this.atTarget = dist < 3 && this.dwell > 0;
    if (dist > 0) {
      const f = Math.min(1, this.int(1, 18) / dist);
      this.x += dx * f;
      this.y += dy * f;
    }
    if (this.r() < 0.15) this.x += this.int(-1, 1);
    if (this.r() < 0.15) this.y += this.int(-1, 1);
    this.x = Math.max(0, Math.min(319, Math.round(this.x)));
    this.y = Math.max(0, Math.min(199, Math.round(this.y)));

    let leftDown = false;
    if (this.held > 0) {
      leftDown = true;
      if (--this.held === 0) this.gap = 1;
    } else if (this.gap > 0) {
      this.gap--;
    } else if (this.r() < (this.atTarget ? 0.12 : 0.02)) {
      // a player clicks what the pointer has reached more often than in passing
      leftDown = true;
      this.held = this.holdLength() - 1;
      if (this.held === 0) this.gap = 1;
    }

    // Off the map, a player closes windows and menus: Escape or a right click now and then.
    const keys = [];
    let rightNow = false;
    if (stage !== "map" && this.r() < 0.03) {
      if (this.r() < 0.5) keys.push("Escape");
      else rightNow = true;
    }
    let rightDown = rightNow;
    if (rightDown) {
      // the right click of this update
    } else if (this.rightLeft > 0) {
      rightDown = true;
      this.rightLeft--;
    } else if (!leftDown && this.r() < 0.004) {
      rightDown = true;
      this.rightLeft = this.r() < 0.7 ? 0 : this.int(1, 2);
    }

    for (const rel of this.releases.filter((e) => e.due <= this.tick)) keys.push(rel.token);
    this.releases = this.releases.filter((e) => e.due > this.tick);
    if (this.r() < 0.025) {
      const key = KEY_POOL[this.int(0, KEY_POOL.length - 1)];
      keys.push(key);
      if (this.r() < 0.85) this.releases.push({ due: this.tick + this.int(1, 6), token: keyUpToken(key) });
    }
    return { leftButton: leftDown, rightButton: rightDown, pointerX: this.x, pointerY: this.y, keys };
  }
}

// ---- invariants, save round trips and the escape --------------------------------------------------------------------------------------
const TERMINAL = new Set(["map", "disk", "scenario"]);
const REFUSABLE_SAVE = new Set(["game-over", "disk4-session"]);

function checkInvariants(ctx) {
  const game = ctx.game;
  stats.pixelChecks++;
  let pixels;
  try {
    pixels = game.screen.pixels;
  } catch (error) {
    throw failure(ctx, `reading the screen threw: ${error?.message}`, error);
  }
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] >= 32) throw failure(ctx, `screen pixel index ${pixels[i]} at ${i % 320},${Math.floor(i / 320)} (>= 32)`);
  }
  if (game.map) {
    const state = game.map.world.state;
    const money = state.signedLong(A.money);
    const population = state.signedLong(A.population);
    if (!Number.isSafeInteger(money)) throw failure(ctx, `money is not a finite integer: ${money}`);
    if (!Number.isSafeInteger(population)) throw failure(ctx, `population is not a finite integer: ${population}`);
    if (population < 0) throw failure(ctx, `population is negative: ${population}`);
  }
}

function roundTrip(ctx) {
  const game = ctx.game;
  if (game.stage !== "map" || game.map === null || game.map.sim.gameOver || game.heldScene !== null) return;
  const slot = ctx.rand.int(0, SAVE_SLOTS - 1);
  const scenario = game.scenario;
  const money = game.map.world.state.signedLong(A.money);
  let saved;
  try {
    saved = game.saveToSlot(slot);
  } catch (error) {
    throw failure(ctx, `saveToSlot(${slot}) threw: ${error?.message}`, error);
  }
  stats.saves++;
  if (!saved) {
    const code = game.lastSaveError?.code ?? "none";
    if (!REFUSABLE_SAVE.has(code)) throw failure(ctx, `save refused on the map with ${code}: ${game.lastSaveError?.message}`);
    stats.saveRefusals[code] = (stats.saveRefusals[code] ?? 0) + 1;
    return;
  }
  const raw = localStorage.getItem(SLOT_PREFIX + slot);
  if (typeof raw !== "string") throw failure(ctx, `slot ${slot} missing from storage after a save`);
  stats.maxSlotChars = Math.max(stats.maxSlotChars, raw.length);
  stats.slotCharsTotal += raw.length;
  let loaded;
  try {
    loaded = game.loadFromSlot(slot, false);
  } catch (error) {
    throw failure(ctx, `loadFromSlot(${slot}) threw: ${error?.message}`, error);
  }
  stats.loads++;
  if (!loaded) throw failure(ctx, `load of slot ${slot}, written a moment earlier, failed: ${game.lastLoadError?.code}: ${game.lastLoadError?.message}`);
  if (game.stage !== "map" || game.scenario !== scenario) throw failure(ctx, `load of slot ${slot} left stage ${game.stage}, scenario ${game.scenario} (saved ${scenario})`);
  const money2 = game.map.world.state.signedLong(A.money);
  if (money2 !== money) throw failure(ctx, `money changed across save and load: ${money} -> ${money2}`);
}

// For a failure message: the window chain with each window's class and whether a number entry is open in it.
function windowChain(game) {
  const parts = [];
  for (let w = game.window; w; w = w.child ?? null) parts.push(`${w.constructor?.name}${w.modal === true ? "[entry]" : ""}`);
  return parts.length > 0 ? parts.join(" > ") : "none";
}

// The defined escape: from any stage, a sequence of Escape, right click, the stage's own exit (window exit, announcement exit, offer refuse,
// disk EXIT) must reach the map or the disk menu. Returns normally when it does; throws a soft-lock failure otherwise.
function escape(ctx) {
  const game = ctx.game;
  stats.escapes++;
  const from = game.stage;
  settle(ctx);
  const actions = [
    () => keyTap(ctx, "Escape"),
    () => rightTap(ctx),
    () => stageExit(ctx),
    () => rightTap(ctx),
  ];
  for (const act of actions) {
    if (TERMINAL.has(game.stage)) return;
    act();
  }
  if (!TERMINAL.has(game.stage)) throw failure(ctx, `soft lock: the escape from stage ${from} left stage ${game.stage} (windows ${windowChain(game)}, menu ${game.menu?.constructor?.name ?? "none"})`);
}

// A quiet update first: a button the driver left held would hide the press edge of the next click.
function settle(ctx) {
  step(ctx, quiet());
}

// The centre of button `i` of a window's own rectangle table, or null when the table has no such entry.
function buttonCentre(ui, i) {
  const r = ui?.rects?.[i];
  return r ? [Math.floor((r.x0 + r.x1) / 2), Math.floor((r.y0 + r.y1) / 2)] : null;
}

// A point outside every adviser rectangle of the council room (a release there leaves the room): the first one on a coarse grid.
function freeCouncilPoint(room) {
  const inside = (x, y) => room.rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  for (let y = 0; y < 200; y += 2) for (let x = 0; x < 320; x += 2) if (!inside(x, y)) return [x, y];
  throw new Error("the council room has no point outside its advisers");
}

function stageExit(ctx) {
  const game = ctx.game;
  switch (game.stage) {
    case "announce": {
      const [x, y] = buttonCentre(game.announce?.ui, EXIT_BUTTON) ?? [160, 100];
      tap(ctx, x, y);
      break;
    }
    case "offer":
      quickTap(ctx, 208, 148); // REFUSE
      break;
    case "screen": {
      // A window can open a child (the trade window opens the market): the child is left first, then its parent.
      const chain = [];
      for (let w = game.window; w; w = w.child ?? null) chain.push(w);
      for (const w of chain.reverse()) {
        if (game.stage !== "screen") break;
        leaveWindow(ctx, w);
      }
      break;
    }
    case "disk":
    case "scenario":
      diskIconAt(ctx, DISK_BUTTON.exit);
      break;
    default:
      break;
  }
}

// Leaves one window by the way its own code closes it.
function leaveWindow(ctx, win) {
  const game = ctx.game;
  // A number entry (trade and market quantities, `$5110`) takes no Escape and no mouse: the only way out of it is a digit and Return.
  if (win.modal === true) {
    keyTap(ctx, "1");
    keyTap(ctx, "Enter");
    // An entry that was confirmed may still hold the window for a while (the market's message wait counts in its update): let it finish.
    for (let n = 0; n < 120 && win.modal === true && game.stage === "screen"; n++) settle(ctx);
  }
  if (win instanceof CouncilScreen) {
    // The council room leaves on a left release outside its adviser rectangles; an open report takes the first release, so the room
    // may need two (the report closes, then the room).
    const [x, y] = freeCouncilPoint(win);
    tap(ctx, x, y);
    if (game.stage === "screen") tap(ctx, x, y);
  } else if (win instanceof OverviewScreen) {
    // The overview leaves on the release of its exit button (index 7 of its own table); no key and no right click leave it.
    const [x, y] = buttonCentre({ rects: win.rects }, EXIT_BUTTON_INDEX);
    tap(ctx, x, y);
  } else if (win.ui) {
    // A panel window leaves through one of its own button rectangles: the EXIT slot first, then the others in order (some windows use
    // another slot for their leave). Each tap is a click on a button; the loop ends as soon as the window is closed.
    const order = [EXIT_BUTTON, ...Array.from({ length: 10 }, (_, i) => i).filter((i) => i !== EXIT_BUTTON)];
    for (const i of order) {
      if (game.stage !== "screen") break;
      const centre = buttonCentre(win.ui, i);
      if (centre) tap(ctx, centre[0], centre[1]);
    }
  }
}

// Dismisses what the game shows on its own (announcements, offers) after an entry, as the idle run does.
function clearPending(ctx) {
  const game = ctx.game;
  for (let n = 0; n < 40 && (game.stage === "announce" || game.stage === "offer"); n++) {
    if (game.stage === "announce") stageExit(ctx);
    else quickTap(ctx, n % 2 === 0 ? 112 : 208, 148);
  }
}

// ---- one run: fuzz, then idle -----------------------------------------------------------------------------------------------------------
function runOne(run, runIndex) {
  const ctx = { run, runIndex, updates: 0, phase: "boot", game: null, stage: "?", prevStage: "?", rand: null, stuck: 0 };
  const rand = mulberry32(runSeedOf(runIndex));
  ctx.rand = { int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)) };
  const driver = new Driver(rand);
  // The game reads Math.random only where no seed is given (a save load's world); replace it for the run with a seeded stream.
  const mathRandom = mulberry32(runSeedOf(runIndex) ^ 0x7f4a7c15);
  Math.random = mathRandom;
  storage.clear();

  startGame(ctx);
  const startStage = ctx.stage;
  console.log(`ok   ${run.name}: boot and entry (${ctx.updates} updates, stage ${startStage}, scenario ${ctx.game.scenario})`);

  // ---- fuzz
  ctx.phase = "fuzz";
  let fuzzStart = ctx.updates;
  let stuckEvents = 0;
  let gameOvers = 0;
  let maxStuck = 0;
  for (let i = 0; i < FRAMES; i++) {
    const game = ctx.game;
    if (game.stage === "map" && game.map !== null && game.map.sim.gameOver) {
      // A game over: the tail's menu refuses EXIT; the run starts a fresh game of the same kind, as a player would start over.
      gameOvers++;
      stats.gameOvers++;
      ctx.restarts++;
      stats.restarts++;
      startGame(ctx);
      continue;
    }
    if (ctx.stage !== "map") {
      ctx.stuck++;
      maxStuck = Math.max(maxStuck, ctx.stuck);
    } else ctx.stuck = 0;
    if (ctx.stuck >= STUCK_LIMIT) {
      stuckEvents++;
      stats.stuckDriveBacks++;
      if (ctx.stage === "disk" || ctx.stage === "scenario") {
        settle(ctx);
        diskIconAt(ctx, DISK_BUTTON.exit);
      }
      else escape(ctx);
      ctx.stuck = 0;
      continue;
    }
    step(ctx, driver.next(ctx.stage));
    if (ctx.updates % CHECK_EVERY === 0) checkInvariants(ctx);
    if (ctx.updates % ROUND_TRIP_EVERY === 0) roundTrip(ctx);
  }
  checkInvariants(ctx);
  const fuzzUpdates = ctx.updates - fuzzStart;
  console.log(`ok   ${run.name} fuzz: ${fuzzUpdates} updates, ${gameOvers} game over(s), ${stuckEvents} drive-back(s), longest stretch outside the map ${maxStuck}`);

  // ---- idle: no input except dismissing announcements and offers
  ctx.phase = "idle";
  // Bring the fuzzed session back to the map first (not part of the idle run). The escape accepts the disk menu, so the EXIT is taken here.
  for (let n = 0; n < 6 && !ctx.game.map?.sim.gameOver && !(["map", "announce", "offer"].includes(ctx.game.stage)); n++) {
    if (ctx.game.stage === "disk" || ctx.game.stage === "scenario") {
      settle(ctx);
      diskIconAt(ctx, DISK_BUTTON.exit);
    } else escape(ctx);
  }
  if (!ctx.game.map?.sim.gameOver && !["map", "announce", "offer"].includes(ctx.game.stage)) throw failure(ctx, `could not return to the map before the idle run (stage ${ctx.game.stage})`);
  settle(ctx);
  const idleStart = ctx.updates;
  const startDate = ctx.game.map ? ctx.game.map.world.state.dateText() : "";
  let endedBy = "idle budget";
  let coin = 0;
  while (ctx.updates - idleStart < FRAMES) {
    const game = ctx.game;
    if (game.map?.sim.gameOver) {
      endedBy = "game over";
      break;
    }
    if (game.stage === "announce") stageExit(ctx);
    else if (game.stage === "offer") {
      coin++;
      quickTap(ctx, coin % 2 === 0 ? 112 : 208, 148);
    } else if (game.stage === "map") step(ctx, quiet());
    else throw failure(ctx, `idle left the map without input (stage ${game.stage})`);
    if (ctx.updates % CHECK_EVERY === 0) checkInvariants(ctx);
  }
  checkInvariants(ctx);
  const endDate = ctx.game.map ? ctx.game.map.world.state.dateText() : "";
  stats.idleUpdates += ctx.updates - idleStart;
  const years = (text) => (text.length >= 4 ? Number(text.slice(-4)) : NaN);
  const yearsRun = Number.isFinite(years(endDate)) && Number.isFinite(years(startDate)) ? years(endDate) - years(startDate) : NaN;
  stats.idleYears.push({ name: run.name, years: yearsRun, endedBy });
  console.log(`ok   ${run.name} idle: ${ctx.updates - idleStart} updates, ${startDate} -> ${endDate} (${Number.isFinite(yearsRun) ? yearsRun : "?"} years), ended by ${endedBy}`);
  stats.runs.push(run.name);
  return ctx;
}

// ---- main -----------------------------------------------------------------------------------------------------------------------------------
const RUNS = [
  ...Array.from({ length: 10 }, (_, i) => ({ name: `scenario ${i + 1}`, kind: "scenario", index: i })),
  { name: "tutorial", kind: "tutorial" },
];
const selected = RUNS.map((run, i) => ({ run, i })).filter(({ run }) => ONLY === null || run.name === ONLY);
if (selected.length === 0) {
  console.log(`FAIL soak  UTOPIA_SOAK_ONLY "${ONLY}" names no run`);
  process.exit(1);
}

const failures = [];
const started = performance.now();
for (const { run, i } of selected) {
  try {
    runOne(run, i);
  } catch (error) {
    const detail = error instanceof SoakFailure ? error.message : `unexpected ${error?.message ?? error}`;
    const stack = error?.stack ? String(error.stack).split("\n").slice(0, 10).join("\n    ") : "";
    failures.push(run.name);
    console.log(`FAIL soak ${run.name}  ${detail}`);
    console.log(`     ${stack}`);
    console.log(`     rerun: UTOPIA_SOAK_SEED=${SEED} UTOPIA_SOAK_FRAMES=${FRAMES} UTOPIA_SOAK_ONLY="${run.name}" node test/soak.mjs`);
  }
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);

const visited = Object.keys(stats.stageEntries).sort();
const updatesBy = Object.entries(stats.stageUpdates).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(", ");
const entriesBy = Object.entries(stats.stageEntries).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(", ");
console.log("---- coverage");
console.log(`seed ${SEED}, frames per run ${FRAMES}, runs ${selected.length}, updates ${stats.updates} (idle ${stats.idleUpdates}), ${seconds} s`);
console.log(`stages visited (${visited.length}): ${visited.join(", ")}`);
console.log(`updates per stage: ${updatesBy}`);
console.log(`entries per stage: ${entriesBy}`);
console.log(`saves ${stats.saves}, loads ${stats.loads}, refusals ${JSON.stringify(stats.saveRefusals)}, largest slot ${stats.maxSlotChars} characters, mean ${stats.loads ? Math.round(stats.slotCharsTotal / stats.loads) : 0}`);
console.log(`game overs ${stats.gameOvers}, restarts ${stats.restarts}, drive-backs ${stats.stuckDriveBacks}, escapes ${stats.escapes}, pixel checks ${stats.pixelChecks}`);
console.log(`slowest update ${stats.maxUpdateMs.toFixed(1)} ms`);
console.log(`idle years: ${stats.idleYears.map((y) => `${y.name} ${Number.isFinite(y.years) ? y.years : "?"}${y.endedBy === "game over" ? " (game over)" : ""}`).join("; ")}`);
console.log(failures.length === 0 ? `all soak runs passed (${selected.length} runs)` : `${failures.length} soak run(s) FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
