// The periodic simulation: the ported parts of the original's main-loop worker $99C4.
// Source analysis: notes/formats/game-state.md section 5, port status: notes/formats/sim-port.md.
// Every function names the original routine it follows; arithmetic keeps the original's
// register widths (see sim-math.ts), quirks included.

import { A, PERIOD, type GameState } from "./state.js";
import { Fleet, type EffectKind } from "./sim-ships.js";
import { Aliens, type EnemySpawn } from "./sim-aliens.js";
import { Alerts, LIGHT } from "./sim-alerts.js";
import { OBJECT_SLOTS, T, type World } from "./world.js";
import { createRng, divsQ, divuQ, divuReg, mulu, muls, s16, s8, type Rng, type SeededRng } from "./sim-math.js";
import { createHardware, isSeededHardware, type HardwareSource, type HardwareState } from "./sim-hardware.js";
import { GOOD_WEIGHT, JOB_POOL_TYPES, POWER_TYPES, RESEARCH_BITS, RESEARCH_INDEX, RESEARCH_SCALE, RESEARCH_THRESHOLD, STARVATION_LEVEL, TAX_MORALE, TAX_QOL } from "./sim-tables.js";

// Variable-block addresses used by the simulation (game-state.md section 3).
const V = {
  freeColonists: 0x13136,
  employed: 0x1313a,
  medics: 0x1313e,
  scientists: 0x13142,
  security: 0x13146,
  population: 0x1314a,
  fuelCopy: 0x1314e, // trade slot 0 (fuel), goods follow at $13152
  stock: 0x13152,
  weight: 0x13166,
  market: 0x1316a, // 12 entries x 10 bytes
  tradable: 0x14234, // 6 longs
  retain: 0x144cc, // 6 longs
  supply: 0x1443a,
  demand: 0x14452,
  money: 0x135ba,
  spent: 0x135b6,
  grant: 0x135be,
  capacity: 0x14432,
  jobRequired: 0x143c6,
  jobAssigned: 0x143ea,
  jobShortage: 0x1440e,
  jobCap: 0x14500,
  farmA: 0x143be,
  farmB: 0x143c2,
  births: 0x1432e,
  deaths: 0x14332,
  deathsPending: 0x14336,
  crime: 0x142ce,
  security_pct: 0x144c6,
  power: 0x144c8,
  eclipse: 0x144bb,
  airShort: 0x144b5,
  starving: 0x144b4,
  crowded: 0x144c4,
  crowdDeaths: 0x144c5,
  virusLevel: 0x144b7,
  virusTime: 0x144b8,
  virusDeaths: 0x144b9,
  tradeFail: 0x144ba,
  warnBits: 0x144b1,
  inventionDelay: 0x144c7,
  eventIndex: 0x144bf,
  invention: 0x14472,
  inventionQueue: 0x14476,
  researchAccum: 0x142da,
  tanks: 0x1429c,
  ships: 0x1429e,
  fuelStored: 0x14342,
  objects: 0x142c2,
  tradeBits: 0x144c2,
} as const;

// Type indices with a special role.
const TY = {
  powerStore: 0,
  housing: 7,
  solarA: 11,
  solarB: 12,
  boiler: 14, // job pool 0
  fuelPlant: 15,
  tankA: 16,
  tankB: 17,
  farmA: 18,
  farmB: 19,
  airB: 24,
  mine: 26,
  commandCentre: 29,
  airA: 30,
  powerStation: 31,
  sports: 32,
} as const;

// Bits of the system flag byte $156AA (kept in Sim.sysFlags).
export const SYS = { attackPending: 0x02, noUnitBonus: 0x04, gameOver: 0x08, qol80: 0x10, qol90: 0x20, eclipse: 0x40, tutorialMode: 0x80 } as const;

const TILE_MINE = 0x60;
const TILE_FUEL = 0x3e;
const MAX_POOL = 9;

export type SimEvent =
  | { kind: "announce"; id: number } // $E770 d1: 0 colony falls to crime, 1 game over, 2 quality of life 80, 3 quality of life 90
  | { kind: "invention"; bit: number } // $DF5A
  | { kind: "offer"; what: "colonists" | "scientists" | "tanks"; count: number; price: number; accepted: boolean }
  | { kind: "ship"; what: "launched" | "destroyed"; type: number; x: number; y: number } // $4060/$387E, $46CC
  | { kind: "intel"; slot: number; value: number } // a ticker pair (6, value) written at `slot` (defence screen), message $157 or similar
  | { kind: "aliensDefeated" }; // $127A0 victory

export interface Offer {
  what: "colonists" | "scientists" | "tanks";
  count: number;
  price: number; // Gr per colonist (colonists) or total fine (scientists)
}

/** The cells `$75A8` lists at `$7C28` for a demolished building (1 or 4 cells, origin first). */
export type DemolishFootprint = ReadonlyArray<readonly [number, number]>;

/** A unit removed by `$4692` for the Earth requisition: its type and the cell it stood on (-1, -1 without a unit layer). */
export interface DestroyedUnit {
  readonly type: number;
  readonly x: number;
  readonly y: number;
}

export interface SimOptions {
  rng?: Rng;
  /**
   * Stand-in for the two hardware reads of the original ($BFE801 CIA TOD for the enemy attack gate, `$2E00` beam parity
   * for the wave jitter sign). Default: a seeded `createHardware()`. Never draws from `rng`. See sim-hardware.ts.
   */
  hardware?: HardwareSource;
  // Answer of the original's two-button dialog $DECC: true = first button (accept the Earth
  // request: buy the colonists / hand over the scientists), false = second button.
  decide?: (offer: Offer) => boolean;
  // Called in the weekly step where the original runs $7000 (construction countdown).
  onWeek?: () => void;
  // $7342: the Command Centre record at `slot` went online or offline; its map tiles must be redrawn
  // (Builder.construction.redrawCentre).
  centreChanged?: (slot: number) => void;
  // $9A36 point of the daily step: the message log protect counters count down (Messages.dayPassed).
  onDay?: () => void;
  // $A6D2-$A756 of the tank yard step: the first free cell around the yard at (x, y), in the original's order.
  // Null when all eight neighbours are blocked (message $95; the yard keeps its counter). Without a unit layer the
  // yard's own cell is used.
  yardExit?: (x: number, y: number) => { x: number; y: number } | null;
  // $37CA: put a finished unit on the exit cell. Returns false only when the unit list is full. Without a unit layer
  // the unit is only counted.
  spawnUnit?: (x: number, y: number, advanced: boolean) => boolean;
  // $4692: remove the first unit from the map; returns its type (9 or 10) and cell, or null when none exists.
  // Without a unit layer a unit of the type with a non-zero count is chosen (x = y = -1: no cell is known).
  destroyUnit?: () => DestroyedUnit | null;
  // $7372: knock down the building at a cell. A demolition is NOT a blast by itself: the mine collapse event calls `$7372`
  // alone (no counter, no `$1237C`), while `Sim.bomb` (`$12332`) demolishes and then blasts. A hook that can report the
  // footprint returns the cells `$75A8` listed (`[]` when nothing was a building: ground, construction site, refusal) and
  // `bomb` blasts exactly those. A void/invalid report is unknown, so no blast is presented rather than inventing a cell.
  // The third argument models `$156A9` bit 4, which `$12332` sets only around `$7372` so occupied vents can be demolished.
  demolishAt?: (x: number, y: number, bombing?: boolean) => DemolishFootprint | void;
  // When true an Earth offer waits in `pending` (and time stops) until resolveOffer() is called,
  // instead of asking `decide`.
  interactive?: boolean;
  // Graphics hook for everything the original draws as a side effect (explosions, scroll-to-cell, meteor, alien).
  effect?: (kind: EffectKind, x: number, y: number) => void;
  // $48EC / $48B6: create an enemy ground (air = false) or air unit at the cell; false = its list is full.
  // Without a unit layer the unit is only counted ($142A2 / $142A4).
  spawnEnemy?: (spawn: EnemySpawn) => boolean;
  // Event 17 ($11566): turn the first own ground unit into an enemy ground unit; returns its cell, or null when
  // none could be converted. Without a unit layer only the counters change (cell -1).
  defectUnit?: () => { x: number; y: number } | null;
  // $12510: heal every own ground unit by `amount` hit points (type maximum from UNIT_INIT).
  repairUnits?: (amount: number) => void;
  // `$1237C` for a ship destroyed with its explosion (`$4732` with bit 5 of `$156A9` set): `lift` is the ship's +$10
  // (`$12D68`, the sprite height) and `high` selects the high volume (`$1581` bit 3). Returns whether the blast clobbered
  // A6, the map-word pointer; `$46CC` then skips its map-bit release (enemies.md section 6, ship-control.md 5e). Absent = no
  // blast and no clobber.
  blast?: (x: number, y: number, lift: number, high: boolean) => boolean;
  /** `$11D34` gun A, consumed from pending-period bit 4 at the start of `$99C4`. */
  gunA?: () => void;
  /** `$11D34` gun B, consumed in the daily branch before `$ACE2`. */
  gunB?: () => void;
}

export type SimInitialization = "new-game" | "snapshot";

export class Sim {
  readonly state: GameState;
  readonly messages: number[] = []; // string-table indices shown through $5A8C / $551A
  readonly events: SimEvent[] = [];
  // `$866E` writes $01 during initialization, then ordinary game-start routine `$80A6` clears bit 0 before play.
  // Model the runtime value; snapshot restoration replaces it with the saved session value.
  sysFlags = 0;
  paused = false; // $156A9 bit 2
  // `$156A9` bit 5, the "destroyed by an attack" mark. Every `$4732` tests and clears it (`takeBlastMark`); between two
  // `$4732` calls it stays set only after a missile hit on a FREE slot (ship-control.md 5e), so it persists across passes.
  blastMark = false;
  /**
   * The descriptor exchange of `$11024` (eclipse-tiles.ts): true while entries 4/51 and 50/54 of the table `$1612E` are exchanged.
   * The table is built once at boot and only `$11024` writes those address longs (static trace, notes/formats/game-state.md 5.1),
   * so this is the parity of the traced calls: weekly eclipse start and end, event 14, a disk-menu entry while bit 6 is set, and
   * the disk-menu exit while `$144BB` is nonzero. Nothing clears it on a new game (`$866E`/`$875C` do not touch the table), so a
   * session hands it to the next one (`carryTableState`) and a save stores it (save-session.ts version 11).
   */
  tileExchange = false;
  /**
   * True when `tileExchange` came from a save that stored no parity (versions 2..10, migrated with the disk-menu value 0). The traced calls
   * keep the flag, so the value stays marked as assumed in later saves (save.ts, slot label).
   */
  tileExchangeAssumed = false;

  private readonly rng: Rng;
  private readonly hardware: HardwareSource;
  private decide: (offer: Offer) => boolean;

  private onWeek: (() => void) | undefined;
  private centreHook: ((slot: number) => void) | undefined;
  private dayHook: (() => void) | undefined;
  private spawnUnit: (x: number, y: number, advanced: boolean) => boolean;
  private yardExit: (x: number, y: number) => { x: number; y: number } | null;
  private interactive: boolean;
  private demolishAt: (x: number, y: number, bombing?: boolean) => DemolishFootprint | void;
  private destroyUnit: () => DestroyedUnit | null;
  private effectHook: ((kind: EffectKind, x: number, y: number) => void) | undefined;
  private spawnEnemyHook: (spawn: EnemySpawn) => boolean;
  private defectHook: () => { x: number; y: number } | null;
  private repairHook: ((amount: number) => void) | undefined;
  private blastHook: ((x: number, y: number, lift: number, high: boolean) => boolean) | undefined;
  private gunAHook: (() => void) | undefined;
  private gunBHook: (() => void) | undefined;
  // Own spaceships and the ship yard ($AC04, $4060, $ACE2, ...), alien/meteor/intelligence code.
  readonly fleet: Fleet;
  readonly aliens: Aliens;
  // Warning lights and the view bookmark ($15634.., $144BD, $144E8).
  readonly alerts: Alerts;
  pending: { offer: Offer; apply: (accepted: boolean) => void } | null = null;
  private scenarioStartInitialized = false;

  constructor(
    readonly world: World,
    options: SimOptions = {},
    readonly initialization: SimInitialization = "new-game",
  ) {
    this.state = world.state;
    this.rng = options.rng ?? createRng(0x55746f70);
    this.hardware = options.hardware ?? createHardware();
    this.decide = options.decide ?? (() => false);
    this.onWeek = options.onWeek;
    this.centreHook = options.centreChanged;
    this.dayHook = options.onDay;
    this.spawnUnit = options.spawnUnit ?? (() => true);
    this.yardExit = options.yardExit ?? ((x, y) => ({ x, y }));
    this.interactive = options.interactive ?? false;
    this.demolishAt = options.demolishAt ?? (() => []);
    this.destroyUnit = options.destroyUnit ?? (() => {
      const type = this.s.long(0x14254) > 0 ? 9 : this.s.long(0x14258) > 0 ? 10 : null;
      return type === null ? null : { type, x: -1, y: -1 };
    });
    this.effectHook = options.effect;
    // Without a unit layer only the count-word compare of $48EC / $48B6 can be answered (60 ground, 30 air).
    this.spawnEnemyHook = options.spawnEnemy ?? ((spawn) => this.state.word(spawn.air ? 0x142a4 : 0x142a2) < (spawn.air ? 30 : 60));
    // Without a defection hook there is no tank to convert: null, so $1429C / $142A2 and the message stay as they are.
    this.defectHook = options.defectUnit ?? (() => null);
    this.repairHook = options.repairUnits;
    this.blastHook = options.blast;
    this.gunAHook = options.gunA;
    this.gunBHook = options.gunB;
    // New games need a capacity fallback. A saved snapshot must stay byte-for-byte intact while
    // its detached runtime graph is assembled; a later activation path can decide when to resume.
    if (initialization === "new-game" && this.state.long(V.capacity) === 0) this.state.setLong(V.capacity, world.warehouseCapacity);
    this.fleet = new Fleet(this);
    this.aliens = new Aliens(this);
    this.alerts = new Alerts(this.state);
  }

  /**
   * Remake-save access (save-session.ts): the 32-bit state of the port's own generator, or null when a custom `rng`
   * without `getState` was supplied (then the sequence cannot be saved).
   */
  get rngState(): number | null {
    const rng = this.rng as Partial<SeededRng>;
    return typeof rng.getState === "function" ? rng.getState() : null;
  }

  /** Continues the generator at a saved state. False (and nothing changed) when this Sim's generator has no `setState`. */
  restoreRngState(value: number): boolean {
    const rng = this.rng as Partial<SeededRng>;
    if (typeof rng.setState !== "function") return false;
    rng.setState(value);
    return true;
  }

  /**
   * Remake-save access: the two stream counters of the default hardware approximation, or null when a custom
   * `hardware` stub without `getState` / `setState` was injected (then nothing about it can be saved).
   */
  get hardwareState(): HardwareState | null {
    return isSeededHardware(this.hardware) ? this.hardware.getState() : null;
  }

  /** Continues the approximation streams at a saved state. False (nothing changed) for an injected stub without `setState`. */
  restoreHardwareState(state: HardwareState): boolean {
    if (!isSeededHardware(this.hardware)) return false;
    this.hardware.setState(state);
    return true;
  }

  /** `$BFE801` read (CIA TOD low byte), 0..255. Remake approximation, no Sim RNG draw. */
  todLow(): number {
    return this.hardware.todLow() & 0xff;
  }

  /** `$2E00` read (one beam-position bit), 0 or 1. Remake approximation, no Sim RNG draw. */
  rasterParity(): number {
    return this.hardware.rasterParity() & 1;
  }

  /** Construct simulation helpers over saved state without running constructor-time new-game writes. */
  static fromSnapshot(world: World, options: SimOptions = {}): Sim {
    return new Sim(world, options, "snapshot");
  }

  /**
   * New-scenario state initialization `$866E`: it leaves one day queued (`$156A8` bit 7), consumed by the first `$4D1C`.
   * The marker apparition is NOT part of it: the original calls `$11476` once at the boot-menu exit (`$157B8`), which
   * is `leaveBootMenu()`. Detached snapshots never run this initialization.
   */
  initializeScenarioStart(): void {
    if (this.initialization !== "new-game" || this.scenarioStartInitialized) return;
    this.scenarioStartInitialized = true;
    this.dayQueued = true;
  }

  /**
   * `$157B8 -> $11476`, the one-shot call after the first return from the boot disk menu: it clears the apparition
   * record and, when the current scenario has markers ($144A6), draws one marker with one range draw. It reads the state
   * as it is at the call, so it also applies to a restored graph. The caller (`Game`, `runDiskMenuExit`) makes the call once per
   * tail exit: the first entry of the launch, and again after each game-over restart (`$157B4` return, static trace). The restart
   * draw uses the remake's RNG (`initializeScenarioAppearance`), so its marker is an approximation, not the original's value.
   */
  leaveBootMenu(): void {
    this.aliens.initializeScenarioAppearance();
  }

  /**
   * Replaces the runtime callbacks of an existing Sim (for example one built by `Sim.fromSnapshot` before a scene
   * existed): every key that is present overwrites the old callback, absent keys keep theirs. `interactive: true`
   * turns Earth offers into a pending dialog from the next offer on. The random generator (`rng`), the saved state,
   * the world, the Fleet / Aliens / Alerts helpers, `sysFlags`, `paused`, `pending` and the event queue are NOT
   * touched and nothing is called. `decide` is the non-interactive answer of the $DECC dialog.
   */
  bindRuntimeHooks(hooks: Omit<SimOptions, "rng" | "hardware">): void {
    if (hooks.decide !== undefined) this.decide = hooks.decide;
    if (hooks.onWeek !== undefined) this.onWeek = hooks.onWeek;
    if (hooks.centreChanged !== undefined) this.centreHook = hooks.centreChanged;
    if (hooks.onDay !== undefined) this.dayHook = hooks.onDay;
    if (hooks.spawnUnit !== undefined) this.spawnUnit = hooks.spawnUnit;
    if (hooks.yardExit !== undefined) this.yardExit = hooks.yardExit;
    if (hooks.interactive !== undefined) this.interactive = hooks.interactive;
    if (hooks.demolishAt !== undefined) this.demolishAt = hooks.demolishAt;
    if (hooks.destroyUnit !== undefined) this.destroyUnit = hooks.destroyUnit;
    if (hooks.effect !== undefined) this.effectHook = hooks.effect;
    if (hooks.spawnEnemy !== undefined) this.spawnEnemyHook = hooks.spawnEnemy;
    if (hooks.defectUnit !== undefined) this.defectHook = hooks.defectUnit;
    if (hooks.repairUnits !== undefined) this.repairHook = hooks.repairUnits;
    if (hooks.blast !== undefined) this.blastHook = hooks.blast;
    if (hooks.gunA !== undefined) this.gunAHook = hooks.gunA;
    if (hooks.gunB !== undefined) this.gunBHook = hooks.gunB;
  }

  // The alien half of one main-loop pass, called AFTER the unit layer ($333A order, static trace): own tanks, ships,
  // enemy ground, enemy air, effects, then the alien frame ($35C8), the meteor countdown ($3626), (the draw sort is
  // modelled by the renderer, ObjectLayer.drawList, not by a simulation step) and last the spawner $1187C. Not while paused or while an offer is pending. Not part of tick() of the unit
  // layer because that owns the pass clock; MapScene calls `ObjectLayer.update()` first and this second.
  pass(): void {
    if (this.paused || this.pending) return;
    this.aliens.alienFrameStep();
    this.aliens.meteorStep();
    this.aliens.spawnStep();
  }

  /** True while a day change ($14590 ran out) waits for the next main-loop pass to be consumed ($156A8 bit 7). */
  dayQueued = false;

  /**
   * VBL half of the original loop: decrement `$14590` unless paused, queue a day at zero, and set the special-period
   * bit whenever the resulting countdown is `$2D`. The special check is outside the pause branch in `$2C34`, so a
   * paused countdown already at `$2D` still queues gun A. Dialogs and the build menu freeze the whole timer block
   * (`$156A8` bit 4), represented by `modal` / `pending`.
   */
  countFrame(modal = false): void {
    if (modal || this.pending) return;
    if (!this.paused && this.state.countFrame()) this.dayQueued = true;
    if (this.state.byte(A.frameCountdown) === 0x2d) {
      this.state.setByte(A.pending, this.state.byte(A.pending) | PERIOD.special);
    }
  }

  /**
   * Combined date + periodic phase for headless callers. The original caller draws first, advances the queued date
   * (`$4D48/$4D1C`), waits for VBL, then runs `$99C4`. MapScene separates those phases around its redraw; this combined
   * method preserves date-before-worker semantics for callers without a renderer.
   */
  periodicPass(): void {
    if (this.pending) return;
    this.advanceQueuedDay();
    this.runAfterVblWait();
  }

  /** `$4D1C` date work after drawing and before the VBL wait; MapScene separates this from `$99C4`. */
  advanceQueuedDay(): void {
    // The original calls `$564A` unconditionally from `$4D1C`, even while paused. Pause gates `$99C4` periodic
    // simulation work, not the queued calendar step; its pending daily/weekly/monthly bits wait until resume.
    if (this.pending || !this.dayQueued) return;
    this.dayQueued = false;
    this.state.advanceDay();
  }

  /** `$99C4`, after the outer-loop VBL wait. Kept separate so MapScene can draw before periodic side effects. */
  runAfterVblWait(): void {
    if (this.pending) return;
    this.run();
  }

  /**
   * Combined headless form of the sim's share of one pass: `pass()` (alien frame, meteor, spawner), then date and
   * periodic work. A caller that owns a unit layer steps it before calling this. MapScene separates date and periodic
   * work around the redraw. Nothing runs while an offer is pending.
   */
  loopPass(): void {
    if (this.pending) return;
    this.pass();
    this.periodicPass();
  }

  // Hooks used by Fleet / Aliens.
  effect(kind: EffectKind, x: number, y: number): void {
    if (kind === "focus") this.alerts.focus(x, y); // $11432
    this.effectHook?.(kind, x, y);
  }
  spawnEnemy(spawn: EnemySpawn): boolean {
    return this.spawnEnemyHook(spawn);
  }
  defectUnit(): { x: number; y: number } | null {
    return this.defectHook();
  }
  repairUnits(amount: number): void {
    this.repairHook?.(amount);
  }
  // `$1237C` for a ship's own destruction blast ($4732 path, see `SimOptions.blast`). Returns the clobber flag.
  blast(x: number, y: number, lift: number, high: boolean): boolean {
    return this.blastHook?.(x, y, lift, high) === true;
  }
  // `$4732` (`bclr.b #5,$156A9`, then `$1237C` when the bit was set): consumes the mark and reports whether the blast is due.
  // `explosion` is the caller's own `bset.b #5` just before its `$46CC` / `$11C5C` / `$11C30` / `$4692` call (the attack, gun,
  // daily and kamikaze paths). A destroy path without one (a missile's own removal, a walk-off, a requisition) still blasts when
  // a missile hit left the mark set, and then the mark is gone. Every destruction calls this exactly once.
  takeBlastMark(explosion: boolean): boolean {
    const due = explosion || this.blastMark;
    this.blastMark = false;
    return due;
  }
  // $12332: bomb a building cell: demolish ($7372, which lists the footprint cells at $7C28), damage counter $1346A++
  // (always, even when nothing was demolished), then one `$1237C` blast per listed cell in list order. The blast is the
  // `explosion` effect: the host applies the visible-window, volume and 30-slot pool rules of `$1237C` once per cell.
  // Without a footprint report, no cell is presented: the original only calls `$1237C` for cells explicitly listed by `$7372`.
  bomb(x: number, y: number): void {
    const footprint = this.demolishAt(x, y, true);
    this.state.setWord(0x1346a, this.state.word(0x1346a) + 1);
    const cells: DemolishFootprint = Array.isArray(footprint) ? footprint : [];
    for (const [cx, cy] of cells) this.effect("explosion", cx, cy);
  }

  get gameOver(): boolean {
    return (this.sysFlags & SYS.gameOver) !== 0;
  }

  /**
   * The disk menu's entry `$7E52` (`$7ECA`-`$7ED4`): while bit 6 is set it runs `$11024` once more. Called by the remake only where
   * the original enters the menu (map icon `$15AE6`, game-over tail `$157AE`), never when the open menu re-shows a page.
   */
  enterDiskMenu(): void {
    if (this.sysFlags & SYS.eclipse) this.exchangeTiles();
  }

  /**
   * The disk menu's exit `$802C` (`$8040`, the boot exit): refused while bit 3 (game over) is set. Otherwise, with `$144BB` nonzero, it
   * runs `$11024` and sets bit 6. A scenario, tutorial or Disk.4 exit reaches it with `$144BB` zeroed by the reset, so it changes nothing.
   */
  leaveDiskMenu(): void {
    if (this.gameOver) return;
    if (this.s.byte(V.eclipse) === 0) return;
    this.exchangeTiles();
    this.sysFlags |= SYS.eclipse;
  }

  /**
   * Hands the descriptor-exchange state of the session being replaced to this one. A new game, scenario, tutorial, load or Disk.4
   * activation does not rebuild the table, so the state carries over. `null` (no session yet, the boot session) keeps the boot state.
   */
  carryTableState(from: Sim | null): void {
    if (from === null) return;
    this.tileExchange = from.tileExchange;
    this.tileExchangeAssumed = from.tileExchangeAssumed;
  }

  // `$11024`: exchanges the data-address longs of descriptor entries 4/51 and 50/54. Applying it twice is the identity.
  private exchangeTiles(): void {
    this.tileExchange = !this.tileExchange;
  }

  // Combined one-call form kept for headless callers: one VBL followed by one main-loop pass in the traced order
  // (alien phase, then date advance and `$99C4`). The map scene instead calls `countFrame()` per video update and the
  // two halves at its configured pass cadence.
  tick(): void {
    if (this.pending) return;
    this.countFrame();
    this.pass();
    this.periodicPass();
  }

  // $99C4: consume the pending period bits in the original's order.
  run(): void {
    if (this.paused || this.gameOver) return;
    const s = this.state;
    const bit = (b: number): boolean => {
      const pending = s.byte(A.pending);
      if ((pending & b) === 0) return false;
      s.setByte(A.pending, pending & ~b);
      return true;
    };
    if (bit(PERIOD.special)) this.gunAHook?.(); // $99D0..$99E8: Gun A is the first periodic step.
    if (bit(PERIOD.daily)) this.daily();
    if (this.gameOver) return;
    if (bit(PERIOD.weekly)) this.weekly();
    if (bit(PERIOD.monthly)) this.monthly();
    if (bit(PERIOD.yearly)) this.yearly();
  }

  // ---- small helpers ----------------------------------------------------------------------

  private get s(): GameState {
    return this.state;
  }

  msg(index: number): void {
    this.messages.push(index);
  }

  roll(range: number): number {
    return this.rng(range);
  }

  private tAddr(i: number): number {
    return this.world.typeAddress(i);
  }
  private tActive(i: number): number {
    return this.s.word(this.tAddr(i) + T.active);
  }
  tCount(i: number): number {
    return this.s.word(this.tAddr(i) + T.total);
  }
  private tStored(i: number): number {
    return this.s.word(this.tAddr(i) + T.stored);
  }
  private setTStored(i: number, value: number): void {
    this.s.setWord(this.tAddr(i) + T.stored, value);
  }

  private add32(addr: number, delta: number): void {
    this.s.setLong(addr, this.s.long(addr) + delta);
  }

  // $A246: morale change. d0 is used as a signed word; the change shrinks towards +-100%.
  applyMorale(d0: number): void {
    const s = this.s;
    let m = s.signedLong(A.morale);
    const mag = m < 0 ? -m : m;
    const d2 = (100 - divsQ(mag, 100)) & 0xffff; // subi.w #100 / neg.w
    const delta = divsQ(muls(d0, d2), 100);
    m = (m + delta) | 0;
    s.setLong(A.morale, m);
  }

  // $A2DE: add units of a good to the warehouse (capped by the weight capacity).
  // Returns the units actually added and whether the capacity overflowed.
  addGoods(units: number, good: number): { added: number; overflow: boolean } {
    const s = this.s;
    const w = GOOD_WEIGHT[good];
    let d0 = units;
    let d2 = mulu(units, w);
    let overflow = false;
    if (((s.long(V.weight) + d2) | 0) > (s.signedLong(V.capacity) | 0)) {
      overflow = true;
      d2 = (s.long(V.capacity) - s.long(V.weight)) >>> 0;
      d0 = divuQ(d2, w);
    }
    s.setLong(V.weight, s.long(V.weight) + d2);
    this.add32(V.stock + 4 * good, d0);
    return { added: d0 >>> 0, overflow };
  }

  // $A32C: remove up to `units` of a good; returns the units removed.
  removeGoods(units: number, good: number): number {
    const s = this.s;
    const have = s.long(V.stock + 4 * good);
    const d0 = units > have ? have : units;
    s.setLong(V.stock + 4 * good, have - d0);
    s.setLong(V.weight, s.long(V.weight) - mulu(d0, GOOD_WEIGHT[good]));
    return d0;
  }

  // ---- daily -----------------------------------------------------------------------------

  // $99C4 daily branch: QoL, Gun B ($9A06..$9A14), then $ACE2 missile handling.
  private daily(): void {
    if (this.s.byte(A.day) === 1) this.qualityOfLife();
    this.gunBHook?.();
    this.fleet.dailyFuel(); // $ACE2
    this.checkGameOver();
    // $B0B6 `jmp $157AE`: a game over leaves the daily pass here, so the countdown, the message timers and the event scheduler do not run.
    if (this.gameOver) return;
    this.alerts.daily(); // $144BD countdown
    this.dayHook?.(); // $15698 message timers
    this.eventScheduler(); // $10E1E: the unrest colony fall (`$10E0A`) jumps out of the same way
    if (this.gameOver) return;
    this.aliens.dailyIntel(); // $AF12
  }

  // $B086
  private checkGameOver(): void {
    const s = this.s;
    const pop = s.long(V.population);
    let lost = s.word(V.objects) === 0;
    if (!lost) lost = this.tCount(TY.housing) === 0 ? pop < 60 : pop < 30;
    if (lost) {
      this.events.push({ kind: "announce", id: 1 });
      this.sysFlags |= SYS.gameOver;
    }
  }

  // $AB0C: scientists turn the two research funds into progress; reaching the next threshold
  // raises the technology level and queues the invention bits of that level (announced one at a time by $1135A).
  research(): void {
    const s = this.s;
    if (s.byte(V.power) >= 7) return;
    if (s.word(0x133f8) === 0) {
      this.msg(0xef);
      return;
    }
    const tech = s.byte(A.techLevel);
    const price = 25 + tech * 10;
    let progress = s.long(0x142de);
    const scientists = s.long(V.scientists);
    progress = (progress + scientists) >>> 0;
    let spend = mulu(scientists, price) >>> 0;
    const second = spend;
    let fundA = s.long(0x142d2);
    if (((fundA - spend) | 0) < 0) spend = fundA;
    fundA = (fundA - spend) >>> 0;
    progress = (progress + s16(divuQ(spend, price))) >>> 0;
    s.setLong(0x142d2, fundA);
    let fundB = s.long(0x142d6);
    let share = second;
    if (((fundB - share) | 0) < 0) share = fundB;
    fundB = (fundB - share) >>> 0;
    share = s16(divuQ(share, price)) >> 1;
    progress = (progress + share) >>> 0;
    s.setLong(V.researchAccum, (s.long(V.researchAccum) + share) >>> 0);
    s.setLong(0x142d6, fundB);
    s.setLong(0x142de, progress);
    if (((progress - RESEARCH_THRESHOLD[tech - 1]) | 0) < 0) return;

    let level = tech + 1;
    if (level === 11) level = 10;
    s.setByte(A.techLevel, level);
    const index = level - 1;
    s.setLong(V.inventionQueue, (s.long(V.inventionQueue) | RESEARCH_BITS[index]) >>> 0);
    s.setByte(V.inventionDelay, 0);
    const scale = RESEARCH_INDEX[index];
    s.setByte(0x145a3, scale);
    for (let i = 0; i < 6; i++) s.setByte(0x145a4 + i, RESEARCH_SCALE[i] * scale);
  }

  // ---- weekly ----------------------------------------------------------------------------

  // $99C4 weekly branch: $7000 (construction countdown, ported in construction.ts and run through
  // the onWeek option) and $4798 (ship refuelling).
  private weekly(): void {
    this.onWeek?.();
    this.fleet.weeklyRefuel(); // $4798
    this.eclipseWeekly();
    this.fleet.weeklyRepair(); // $12510
    this.aliens.weeklyBattle(); // $127A0
    const c = this.s.byte(0x144b2);
    if (c !== 0) this.s.setByte(0x144b2, c - 1);
  }

  // $10FCA
  private eclipseWeekly(): void {
    const s = this.s;
    if (this.sysFlags & SYS.tutorialMode) return;
    if (s.byte(V.eclipse) !== 0) {
      s.setByte(V.eclipse, s.byte(V.eclipse) - 1);
      if (s.byte(V.eclipse) !== 0) return;
      this.sysFlags &= ~SYS.eclipse;
      this.msg(0xde);
      this.exchangeTiles(); // `$1100A` on the end path (`bra $11004`)
      return;
    }
    if (s.byte(A.month) === 11 && s.byte(A.day) === 0x15) {
      s.setByte(V.eclipse, 3);
      this.sysFlags |= SYS.eclipse;
      this.msg(0xdd);
      this.exchangeTiles(); // `$1100A` on the start path
    }
  }

  // ---- events ($10E1E) -------------------------------------------------------------------

  // One event slot per day (k = $144BF, reset monthly); chance bytes at $13118+k.
  private eventScheduler(): void {
    const s = this.s;
    if (this.sysFlags & SYS.tutorialMode) return;
    const k = s.byte(V.eventIndex);
    const chance = s.byte(0x13118 + k);
    // Static trace ($10E3A-$10E4C, Disk.1): `move.b (a0)+,d3; beq $10E50` skips the handler for EVERY slot whose chance byte is
    // zero, the index still advances. The attack wave (slot 9) is no exception: its own chance byte is 100 in all ten scenario
    // blocks, so it runs every day slot 9 comes round, but a zero byte would skip it like any other event.
    if (chance !== 0) this.runEvent(k, chance);
    // The unrest colony fall (`$10E0A`, reached from the crime handler's riot routine) jumps out of `$10E1E` before the index advance at
    // `$10E50`, so a game over raised by the handler leaves the index on the slot that fell (Disk.1 trace, notes/formats/game-proper.md).
    if (this.gameOver) return;
    s.setByte(V.eventIndex, k + 1);
  }

  private runEvent(k: number, chance: number): void {
    switch (k) {
      case 0:
        return this.eventColonistOffer(chance);
      case 1:
        return this.aliens.eventAlienAppears(chance);
      case 2:
        return this.eventInvention();
      case 3:
        return this.aliens.eventBattleReport();
      case 4:
        return this.eventMineCollapse(chance);
      case 6:
        return this.eventPowerAccident(chance);
      case 7:
        return this.eventTradeComputer(chance);
      case 8:
        return this.aliens.eventMeteor(chance);
      case 9:
        return this.aliens.eventWave();
      case 10:
        return this.eventScientistsRequisition(chance);
      case 11:
        return this.eventTankRequisition(chance);
      case 12:
        return this.fleet.eventShipExplosion(chance);
      case 13:
        return this.aliens.eventIntelStep();
      case 14:
        return this.eventEclipse(chance);
      case 15:
        return this.fleet.eventFuelBeam();
      case 16:
        return this.eventStrike(chance);
      case 17:
        return this.aliens.eventTankDefect(chance);
      case 18:
        return this.eventVirus(chance);
      case 19:
        return this.eventCrime();
      default:
        return; // 5 is empty in the original
    }
  }

  // The $DECC dialog: answered by `decide`, or left pending for the interface.
  private ask(offer: Offer, apply: (accepted: boolean) => void): void {
    if (this.interactive) {
      this.pending = { offer, apply };
      return;
    }
    const accepted = this.decide(offer);
    this.events.push({ kind: "offer", ...offer, accepted });
    apply(accepted);
  }

  // Answer of the pending Earth dialog: true = first button.
  resolveOffer(accepted: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.events.push({ kind: "offer", ...pending.offer, accepted });
    pending.apply(accepted);
  }

  // $110FE: Earth offers colonists, 100 Gr each, population/4 of them.
  private eventColonistOffer(chance: number): void {
    const s = this.s;
    if (this.roll(100) >= chance) return;
    if (s.byte(V.crowded) !== 0) return;
    const count = s.long(V.population) >> 2;
    const price = mulu(count, 100);
    if (((price - s.long(V.money)) | 0) >= 0) return;
    this.ask({ what: "colonists", count, price: 100 }, (accepted) => {
      if (!accepted) return;
      s.setLong(V.money, s.long(V.money) - price);
      this.add32(V.population, count);
      this.add32(V.freeColonists, count);
    });
  }

  // $1135A: the next queued invention is announced every sixth call.
  private eventInvention(): void {
    const s = this.s;
    const delay = (s.byte(V.inventionDelay) - 1) & 0xff;
    s.setByte(V.inventionDelay, delay);
    if ((delay & 0x80) === 0) return;
    let queue = s.long(V.inventionQueue);
    if (queue === 0) {
      s.setByte(V.inventionDelay, 0);
      return;
    }
    let bitNo = 0;
    while ((queue & (1 << bitNo)) === 0) bitNo++;
    queue = (queue & ~(1 << bitNo)) >>> 0;
    s.setLong(V.inventionQueue, queue);
    s.setLong(V.invention, s.long(V.invention) | (1 << bitNo));
    s.setByte(V.inventionDelay, 5);
    this.events.push({ kind: "invention", bit: bitNo });
    this.applyMorale(0x5dc);
  }

  // $11280: Earth requisitions 1..9 tanks (only above 10 units); refusing costs a fine.
  eventTankRequisition(chance: number): void {
    const s = this.s;
    if (this.roll(100) >= chance) return;
    if (s16(s.word(V.tanks)) <= 10) return;
    const count = this.roll(9) + 1;
    let fine = divuReg(s.long(V.money), this.roll(8) + 2) & 0xfffe;
    if (fine >= 0xf423f) fine = 0xf423f;
    this.ask({ what: "tanks", count, price: fine }, (accepted) => {
      if (!accepted) {
        s.setLong(V.money, s.long(V.money) - fine);
        return;
      }
      for (let i = 0; i < count; i++) {
        const destroyed = this.destroyUnit();
        if (destroyed === null) break;
        s.setWord(V.tanks, s.word(V.tanks) - 1);
        this.add32(destroyed.type === 9 ? 0x14254 : 0x14258, -1);
        this.add32(0x14294, 1);
        this.applyMorale(-50);
        // $4692 -> $4732: a mark left by a missile hit blasts at the removed tank (no attacker mark: silent)
        const due = this.takeBlastMark(false);
        if (due && destroyed.x >= 0) this.blast(destroyed.x, destroyed.y, 0, true);
      }
    });
  }

  // $11090: a random mine collapses.
  eventMineCollapse(chance: number): void {
    const s = this.s;
    if (this.roll(100) >= chance) return;
    const mines = s.word(0x133c2);
    if (mines === 0) return;
    let skip = this.roll(mines);
    const o = this.world.objects;
    for (let slot = 0; slot < OBJECT_SLOTS; slot++) {
      const at = slot * 8;
      if (((o[at] << 8) | o[at + 1]) !== TILE_MINE) continue;
      if (skip-- > 0) continue;
      const x = o[at + 4], y = o[at + 5];
      this.demolishAt(x, y);
      this.effect("focus", x, y); // $110E6 -> $11432: the bookmark goes to the mine's cell, before the message
      this.msg(0xdf);
      this.applyMorale(-300);
      return;
    }
  }

  // $10F5E: lightning in the power storage.
  private eventPowerAccident(chance: number): void {
    const s = this.s;
    const d3 = mulu(chance, this.tCount(TY.powerStore));
    if (((this.roll(100) - d3) & 0x80) === 0) return;
    const e = (this.tStored(TY.powerStore) - s.word(0x1310c)) & 0xffff;
    this.setTStored(TY.powerStore, (e & 0x8000) !== 0 ? 0 : e);
    this.msg(0xda);
  }

  // $10F8E: trading computer failure for 1..4 months.
  private eventTradeComputer(chance: number): void {
    const s = this.s;
    if (s.byte(V.tradeFail) === 0) {
      if (((this.roll(100) - chance) & 0x80) === 0) return;
      s.setByte(V.tradeFail, this.roll(4) + 1);
      this.msg(0xdb);
      return;
    }
    s.setByte(V.tradeFail, s.byte(V.tradeFail) - 1);
    if (s.byte(V.tradeFail) === 0) this.msg(0xdc);
  }

  // $111A6: Earth requisitions scientists; refusing costs a fine.
  private eventScientistsRequisition(chance: number): void {
    const s = this.s;
    if (((this.roll(100) - chance) & 0x80) === 0) return;
    const sci = s.long(V.scientists);
    if (s8(sci) <= 0xf) return;
    const count = Math.max(sci >> 2, 5);
    this.msg(0xe5);
    const fine = divuReg(s.long(V.money), this.roll(8) + 2) & 0xfffe;
    this.msg(0xe6);
    this.ask({ what: "scientists", count, price: fine }, (accepted) => {
      if (!accepted) {
        s.setLong(V.money, s.long(V.money) - fine);
        return;
      }
      this.add32(V.jobAssigned + 4 * 7, -count);
      this.add32(V.population, -count);
      this.add32(V.scientists, -count);
      this.allocateJobs(0);
      this.applyMorale(-500);
    });
  }

  // $11058: eclipse (solar output 0 for 1..10 weeks). The original runs `$11024` (`$1107A`) before the message.
  private eventEclipse(chance: number): void {
    const s = this.s;
    if (s.byte(V.eclipse) !== 0) return;
    if (((this.roll(100) - chance) & 0x80) !== 0) {
      s.setByte(V.eclipse, this.roll(10) + 1);
      this.exchangeTiles();
      this.msg(0xdd);
      this.sysFlags |= SYS.eclipse;
    }
  }

  // $113FA: strike messages (the original only toggles bit 2 of $144B1 and shows text).
  private eventStrike(chance: number): void {
    const s = this.s;
    const bits = s.byte(V.warnBits);
    s.setByte(V.warnBits, bits & ~0x04);
    if (bits & 0x04) return this.msg(0x11e);
    if (s.signedLong(A.morale) >= -3000) return;
    if (((this.roll(100) - chance) & 0x80) === 0) return;
    s.setByte(V.warnBits, s.byte(V.warnBits) | 0x04);
    this.msg(0x11d);
  }

  // $10ED2: virus. Level/duration/death bonus in $144B7/$144B8/$144B9.
  private eventVirus(chance: number): void {
    const s = this.s;
    if (s.byte(V.virusLevel) === 0) {
      if (s.long(V.invention) & 0x10000) return;
      if (((this.roll(100) - chance) & 0x80) === 0) return;
      const level = this.roll(9) + 1;
      s.setByte(V.virusLevel, level);
      s.setByte(V.virusDeaths, level * 2);
      s.setByte(V.virusTime, this.roll(5) + 2);
      this.msg(0xd7);
      return;
    }
    let medics = s.long(V.medics);
    if (medics !== 0) {
      medics >>= 1;
      if (medics >= 50) medics = 50;
      const r = this.roll(100);
      if (r <= medics) {
        this.clearVirus();
        return this.msg(0xd9);
      }
    }
    s.setByte(V.virusTime, s.byte(V.virusTime) - 1);
    if (s.byte(V.virusTime) !== 0) return;
    this.clearVirus();
    this.msg(0xd8);
  }

  private clearVirus(): void {
    this.s.setByte(V.virusLevel, 0);
    this.s.setByte(V.virusDeaths, 0);
  }

  // $10C72: crime consequences. Arson ($10D00, crimeArson) and riot ($10D9E, crimeRiot, crime above 50)
  // are dispatched below with the thresholds $32 and $3C.
  eventCrime(): void {
    const s = this.s;
    const crime = s.signedLong(V.crime);
    if (crime < 0) return;
    // $10CB4: thieves take 1..7 percent of the money, and one unit of good 2.
    const pct = this.roll(6) + 1;
    s.setLong(V.money, s.long(V.money) - mulu(divuQ(s.long(V.money), 100), pct));
    if (s.long(0x1315a) !== 0) this.removeGoods(1, 2);
    if (s8(crime) <= 0x14) return this.msg(0x10f);
    // $10CE8: two percent of the colonists die.
    const dead = this.deaths(2);
    s.setLong(V.deathsPending, dead);
    this.allocateJobs(0);
    if (s8(crime) <= 0x32) return this.msg(0x110);
    const arson = this.crimeArson();
    if (s8(crime) <= 0x3c) return this.crimeMessage(arson);
    this.crimeMessage(this.crimeRiot());
  }

  private crimeMessage(index: number): void {
    if (index !== 0) this.msg(index);
  }

  // $11A5C: the n-th used object record, n random below min($142C2, $FE). The one draw of the `$11A74` site (`$2DCC` with D2 =
  // that range) is made here. Returns the record's cell (+4/+5) and its tile word (+0): the original's kamikaze reads its dive
  // height from that word, not from the map cell, which can show another tile while a gun flashes (enemies.md section 3c).
  // Null when the scan runs out (the original then leaves D2 = $FF).
  randomBuilding(): [x: number, y: number, tile: number] | null {
    const o = this.world.objects;
    let skip = this.roll(Math.min(this.s.word(0x142c2), 0xfe));
    for (let slot = 0; slot < OBJECT_SLOTS; slot++) {
      const at = slot * 8;
      if (o[at] === 0 && o[at + 1] === 0) continue;
      if (skip-- === 0) return [o[at + 4], o[at + 5], (o[at] << 8) | o[at + 1]];
    }
    return null;
  }

  // $10D00: arson. Returns the message index (0 = none).
  private crimeArson(): number {
    const s = this.s;
    if (s.long(V.invention) & 8) return 0;
    if (s.byte(0x144bc) === 0) {
      if (this.roll(100) >= 0x28) return 0;
      s.setByte(0x144bc, 6);
    }
    const limit = (s.byte(V.security_pct) * 2) & 0xff;
    if (s8(this.roll(100) - limit) < 0) {
      s.setByte(0x144bc, 0);
      this.applyMorale(0x3e8);
      return 0x11a;
    }
    s.setByte(0x144bc, (s.byte(0x144bc) - 1) & 0xff);
    const spot = this.randomBuilding();
    if (!spot) return 0;
    this.bomb(spot[0], spot[1]); // $10D60: `$12332` (demolish, counter, blast per footprint cell)
    this.effect("focus", spot[0], spot[1]); // $10D6C -> $11432: the bookmark goes to the bombed cell, before the message
    this.applyMorale(-500);
    return 0x119;
  }

  // $10D9E: unrest; after six rounds the colony falls (announcement 0, game over).
  private crimeRiot(): number {
    const s = this.s;
    if (s.byte(0x144be) === 0) {
      if (this.roll(100) >= 0x0a) return 0;
      s.setByte(0x144be, 6);
    }
    const limit = (s.byte(V.security_pct) * 2) & 0xff;
    if (s8(this.roll(100) - limit) < 0) {
      s.setByte(0x144be, 0);
      return 0x121;
    }
    const left = (s.byte(0x144be) - 1) & 0xff;
    s.setByte(0x144be, left);
    if (left === 0) {
      this.events.push({ kind: "announce", id: 0 });
      this.sysFlags |= SYS.gameOver;
      return 0;
    }
    return this.roll(100) < (6 - left) * 10 ? 0x120 : 0;
  }

  // ---- monthly ---------------------------------------------------------------------------

  // $99C4 monthly branch.
  monthly(): void {
    const s = this.s;
    s.setByte(V.warnBits, s.byte(V.warnBits) & ~0x02);
    if (s.byte(V.warnBits) & 0x01) {
      s.setByte(V.warnBits, (s.byte(V.warnBits) & ~0x01) | 0x02);
      this.msg(0x62); // $9B06
      this.applyMorale(0x1f4);
    }
    // $9B20
    this.tradeIncome();
    this.marketWalk();
    s.setByte(V.tradeBits, (s.byte(V.tradeBits) | 0x01) & ~0x02);
    this.assignFarmers();
    this.food();
    this.housing();
    this.air();
    this.births();
    this.finance();
    this.power();
    this.commandCentreCheck();
    this.jobs();
    this.moraleMonthly();
    this.crimeMonthly();
    this.production();
    this.tankYard();
    this.fleet.shipYard(); // $AC04
    this.research();
    s.setLong(0x1436a, s.long(0x14376));
    s.setLong(0x14376, 0);
    s.setLong(0x14372, s.long(0x1437a));
    s.setLong(0x1437a, 0);
    s.setByte(V.eventIndex, 0);
    this.fleet.fuelWarned = false; // $156B3
  }

  // $9B52: after a power failure took the Command Centre offline it comes back once the
  // power level is below 14 again.
  private commandCentreCheck(): void {
    const s = this.s;
    if (s.byte(V.power) >= 0xe) return;
    if (this.tCount(TY.commandCentre) !== 0) return;
    if (this.tActive(TY.commandCentre) === 0) return;
    const slot = this.setCommandCentreActive(0xff, -1);
    if (slot >= 0) this.centreHook?.(slot); // $9B8C: $7342
    s.setWord(this.tAddr(TY.commandCentre) + T.total, 1);
  }

  // Record byte +3 of the first Command Centre object (tile $4C): $FF online, 0 offline.
  // `only` >= 0 restricts the search to a record whose byte currently has that value. Returns the
  // record's slot offset, or -1 when none matched.
  private setCommandCentreActive(flag: number, only: number): number {
    const objects = this.world.objects;
    for (let i = 0; i < objects.length; i += 8) {
      if (((objects[i] << 8) | objects[i + 1]) !== 0x4c) continue;
      if (only >= 0 && objects[i + 3] !== only) continue;
      objects[i + 3] = flag;
      return i;
    }
    return -1;
  }

  // $9E3A: colonists on farms (type 19 is filled first, then type 18), 10 per building.
  private assignFarmers(): void {
    const s = this.s;
    let free = s.long(V.freeColonists) + s.long(V.farmA) + s.long(V.farmB);
    const needB = mulu(this.tActive(TY.farmB), 10);
    let b: number;
    let a: number;
    if (free < needB) {
      b = free;
      free = 0;
      a = 0;
    } else {
      b = needB;
      free -= needB;
      const needA = mulu(this.tActive(TY.farmA), 10);
      if (free < needA) {
        a = free;
        free = 0;
      } else {
        a = needA;
        free -= needA;
      }
    }
    s.setLong(V.freeColonists, free);
    s.setLong(V.farmA, a);
    s.setLong(V.farmB, b);
  }

  // $9E98: food. All food in stock is taken out, production added, population eats; the
  // balance goes back into the warehouse or causes starvation.
  private food(): void {
    const s = this.s;
    s.setByte(V.starving, 0);
    this.alerts.set(LIGHT.food, false); // $9E9E
    const taken = this.removeGoods(s.long(V.stock), 0);
    s.setLong(0x1433e, taken);
    const pop = s.long(V.population);
    s.setLong(0x14366, pop);
    this.add32(0x14396, pop);
    let prod = (mulu(s.long(V.farmA), s.word(0x13108)) + mulu(s.long(V.farmB), s.word(0x1310a))) >>> 0;
    if (s.byte(V.power) >= 0x12) prod = 0;
    s.setLong(0x14352, prod);
    const net = (taken + prod - pop) | 0;
    if (net >= 0) {
      if (this.addGoods(net, 0).overflow) this.msg(0x6d);
      return;
    }
    this.alerts.set(LIGHT.food, true); // $9F0E: st.b $15654
    const level = divuQ(mulu(-net, 20), pop);
    s.setByte(V.starving, STARVATION_LEVEL[level] ?? 0);
    this.applyMorale((level + 1) * -100);
  }

  // $9DBA: housing, 50 colonists per housing building.
  private housing(): void {
    const s = this.s;
    s.setByte(V.crowded, 0);
    s.setByte(V.crowdDeaths, 0);
    const cap = mulu(this.tCount(TY.housing), 50);
    if (cap === 0) {
      s.setByte(V.crowded, 0xff);
      s.setByte(V.crowdDeaths, 0x50);
      this.applyMorale(-0x50 * 20);
      return this.msg(0x63);
    }
    let over = (divuQ(mulu(s.long(V.population), 100), cap) - 100) & 0xffff;
    if (s16(over) <= 0) return;
    s.setByte(V.crowded, 0xff);
    this.applyMorale(muls(over, -20));
    if (((over & 0xff) - 0x32) & 0x80) return this.msg(0x63);
    const limit = cap + (cap >> 1);
    const pop = s.long(V.population);
    over = divuQ(mulu(pop - limit, 100), pop);
    s.setByte(V.crowdDeaths, over);
    this.msg(0x63);
  }

  // $9CDA: air. Two plant types produce and store air.
  private air(): void {
    const s = this.s;
    s.setByte(V.airShort, 0);
    this.alerts.set(LIGHT.air, false); // $9CE0
    const pop = s.long(V.population);
    s.setLong(0x14362, pop);
    this.add32(0x14392, pop);
    const a = TY.airA;
    const b = TY.airB;
    let d0 = s16(this.tStored(a)) + s16(this.tStored(b));
    s.setLong(0x1433a, d0 >>> 0);
    const countA = this.tCount(a);
    const countB = this.tCount(b);
    let prod = (mulu(countA, s.word(0x13100)) + mulu(countB, s.word(0x13102))) >>> 0;
    if (s.byte(V.power) >= 0x14) prod = 0;
    s.setLong(0x1434e, prod);
    d0 = (d0 + prod - pop) | 0;
    if (d0 < 0) {
      s.setByte(V.airShort, 10);
      this.alerts.set(LIGHT.air, true); // $9D9C: st.b $15664
      this.setTStored(a, 0);
      this.setTStored(b, 0);
      this.applyMorale(muls(divuQ(mulu(-d0, 100), pop), -20));
      return;
    }
    // Storage: the first type's capacity test uses count*capacity, but the overflow keeps one
    // building's worth (original behaviour, see notes).
    const capA = mulu(countA, s.word(0x13104));
    let d1: number;
    if (capA === 0) {
      d1 = d0;
      d0 = 0;
    } else if (((capA - d0) | 0) >= 0) {
      this.setTStored(a, d0);
      return;
    } else {
      d1 = d0;
      d0 = s16(s.word(0x13104));
      d1 -= d0;
    }
    const capB = mulu(countB, s.word(0x13106));
    if (((capB - d1) | 0) < 0) d1 = s.word(0x13106);
    if (countB !== 0) this.setTStored(b, d1);
    this.setTStored(a, d0);
  }

  // $9BAE: births, then deaths ($9C80). The difficulty byte sets the birth rate band.
  private births(): void {
    const s = this.s;
    const difficulty = s.byte(A.difficulty);
    if (difficulty === 0) {
      s.setLong(V.births, 0);
    } else {
      const base = difficulty === 0x14 ? 0 : difficulty === 0x1e ? 0x1e : 0x3c;
      const rate = (this.roll(difficulty) + base) & 0xff;
      const q = divuQ(mulu(s.long(V.population), 10) + 500, 1000);
      const born = divuQ(mulu(q, rate) + 5, 10);
      s.setLong(V.births, born >>> 0);
      this.add32(V.population, born);
      this.add32(V.freeColonists, born);
    }
    let pct = (1 + s.byte(V.starving) + s.byte(V.airShort) + s.byte(V.virusDeaths)) & 0xff;
    const pop = s.long(V.population);
    const d1 = (divuQ(pop, 0x14) - s.long(V.medics)) | 0;
    if (d1 > 0) {
      pct = (pct + 1) & 0xff;
      if (s16(d1) > 10) pct = (pct + 1) & 0xff;
      if (s16(d1) > 30) pct = (pct + 1) & 0xff;
    }
    if (((pct - 0x14) & 0x80) === 0) this.applyMorale(muls(pct, -20));
    if ((pct - s.byte(V.crowdDeaths)) & 0x80) pct = s.byte(V.crowdDeaths);
    const dead = this.deaths(pct) + s.long(V.deathsPending);
    s.setLong(V.deaths, dead);
    s.setLong(V.deathsPending, 0);
  }

  // $9C80: remove pct percent of the free colonists and of every job pool (fractions are
  // decided by a roll). Returns the number removed from the population.
  private deaths(pct: number): number {
    const s = this.s;
    let removed = divuQ(mulu(s.long(V.freeColonists), pct), 100);
    if (removed !== 0) s.setLong(V.freeColonists, s.long(V.freeColonists) - removed);
    for (let i = 0; i < MAX_POOL; i++) {
      const addr = V.jobAssigned + 4 * i;
      const assigned = s.long(addr);
      if (assigned === 0) continue;
      const reg = divuReg(mulu(assigned, pct), 100);
      let d1: number;
      if ((reg & 0xffff) !== 0) {
        d1 = s16(reg & 0xffff);
      } else {
        const remainder = (reg >>> 16) & 0xff;
        // The remainder of the divide by 100 is a percentage of one colonist, so the roll is 0..99 (observed: every
        // $9C80 draw in the 01/11/2090 capture has range 100 while the death percent is 1-2; a roll below `pct` would
        // kill a colonist for every fraction). Evidence: notes/formats/sim-port.md "Monthly RNG tape".
        const r = this.roll(100);
        d1 = ((remainder - r) & 0x80) !== 0 ? 0 : 1;
        if (d1 === 0) continue;
      }
      s.setLong(addr, assigned - d1);
      s.setLong(V.employed, s.long(V.employed) - d1);
      removed += d1;
    }
    s.setLong(V.population, s.long(V.population) - removed);
    return removed;
  }

  // $A010: monthly statistics, tax income and the research grant.
  private finance(): void {
    const s = this.s;
    s.setLong(0x142e2, s.long(0x142f2));
    s.setLong(0x142e6, s.long(0x142f6));
    s.setLong(0x142ea, s.long(0x142fa));
    this.add32(0x14316, s.long(0x142f2));
    this.add32(0x1431a, s.long(0x142f6));
    this.add32(0x1431e, s.long(0x142fa));
    const spent = s.long(0x142ca);
    s.setLong(V.spent, spent);
    this.add32(0x14326, spent);
    s.setLong(0x142ca, 0);
    s.setLong(0x142f6, 0);
    const tax = s.long(A.tax);
    s.setLong(0x144fc, tax);
    let income = mulu(s.long(V.population), tax);
    s.setLong(0x142fa, income);
    let grant = s.long(V.grant);
    s.setLong(0x142f2, grant);
    if (grant !== 0) {
      income = (income + grant) >>> 0;
      grant = ((grant & 0xffff0000) | ((grant - 100) & 0xffff)) >>> 0;
      s.setLong(V.grant, grant);
      if (grant === 0) this.msg(0x65);
    }
    s.setLong(V.money, s.long(V.money) + income);
  }

  // $A0D4: power. Output first, then use in priority order; the first type that cannot be
  // powered sets the shortage level ($144C8 = 21 - its position).
  private power(): void {
    const s = this.s;
    this.alerts.set(LIGHT.power, false); // $A0D4: clr.b $15634
    let d0 = 0;
    if (s.byte(V.eclipse) === 0) {
      d0 += mulu(this.tStored(TY.solarA), this.tCount(TY.solarA));
      d0 += mulu(this.tStored(TY.solarB), this.tCount(TY.solarB));
    }
    d0 += mulu(this.tStored(TY.powerStation), this.tCount(TY.powerStation));
    s.setLong(0x1435a, divuQ(d0, 10));
    d0 += s16(this.tStored(TY.powerStore));
    let used = 0;
    let level = 21;
    for (let k = 0; k < POWER_TYPES.length; k++) {
      const t = this.tAddr(POWER_TYPES[k]);
      const need = mulu(s.byte(t + T.power), s.word(t + T.total));
      used += need;
      d0 -= need;
      if (d0 < 0) {
        for (let j = k + 1; j < POWER_TYPES.length; j++) {
          const u = this.tAddr(POWER_TYPES[j]);
          used += mulu(s.byte(u + T.power), s.word(u + T.total));
        }
        level = 21 - k;
        break;
      }
      level--;
    }
    const usedUnits = divuQ(used, 10);
    s.setLong(0x1436e, usedUnits);
    this.add32(0x1439e, usedUnits);
    if (level === 0) {
      // Everything powered: the remainder is stored up to the storage capacity.
      const cap = mulu(this.tCount(TY.powerStore), s.word(0x1310c));
      if (((cap - d0) | 0) < 0) d0 = cap;
      this.setTStored(TY.powerStore, d0);
      s.setLong(0x14346, divuQ(d0, 10));
      s.setByte(V.power, 0);
      return;
    }
    s.setByte(V.power, level);
    this.alerts.set(LIGHT.power, true); // $A19C: st.b $15634
    const offline = level >= 0xe ? this.setCommandCentreActive(0, 0xff) : -1;
    if (offline >= 0) {
      // The Command Centre goes offline: its record is switched off, it stops counting and its
      // tiles change to the offline ones ($7342).
      this.centreHook?.(offline);
      s.setWord(this.tAddr(TY.commandCentre) + T.total, 0);
      this.msg(0x12c);
    }
    if (level >= 2) s.setByte(V.warnBits, s.byte(V.warnBits) & ~0x03);
    this.setTStored(TY.powerStore, 0);
    s.setLong(0x14346, 0);
  }

  // $9F36: job allocation. A fifth of the free colonists (+1) take part each month.
  private jobs(): void {
    const s = this.s;
    const free = s.long(V.freeColonists);
    const d0 = divuQ(free, 5) + 1;
    s.setLong(V.freeColonists, free - d0);
    this.allocateJobs(d0);
  }

  // $9F4A: d0 = colonists available for filling jobs. Staff above the requirement is
  // released, shortages are filled proportionally; the remainder goes back to the free pool.
  // The per-pool caps $14500[] are the player's staffing choices (0 by default).
  private allocateJobs(avail: number): void {
    const s = this.s;
    let d0 = avail | 0;
    let totalShort = 0;
    for (let i = 0; i < MAX_POOL; i++) {
      const required = mulu(this.tCount(JOB_POOL_TYPES[i]), i === 6 ? 20 : 10);
      s.setLong(V.jobRequired + 4 * i, required);
      let short = 0;
      const assigned = s.long(V.jobAssigned + 4 * i);
      const excess = (assigned - required) | 0;
      if (excess >= 0) {
        d0 = (d0 + excess) | 0;
        s.setLong(V.jobAssigned + 4 * i, required);
      } else {
        const cap = s.long(V.jobCap + 4 * i);
        short = ((cap - required) | 0) >= 0 ? required : cap;
        short = (short - assigned) | 0;
      }
      s.setLong(V.jobShortage + 4 * i, short);
      totalShort = (totalShort + short) | 0;
    }
    if (totalShort !== 0) {
      const pool = d0;
      for (let i = 0; i < MAX_POOL; i++) {
        const short = s.long(V.jobShortage + 4 * i) | 0;
        if (short === 0) continue;
        let share = divuQ(mulu(short, pool), totalShort);
        if (share > short) share = short;
        s.setLong(V.jobAssigned + 4 * i, s.long(V.jobAssigned + 4 * i) + share);
        s.setLong(V.jobShortage + 4 * i, short - share);
        d0 -= share;
      }
    }
    s.setLong(V.freeColonists, s.long(V.freeColonists) + d0);
    s.setLong(V.medics, s.long(V.jobAssigned + 4 * 6));
    s.setLong(V.scientists, s.long(V.jobAssigned + 4 * 7));
    s.setLong(V.security, s.long(V.jobAssigned + 4 * 8));
    let employed = 0;
    for (let i = 0; i < MAX_POOL; i++) employed += s.long(V.jobAssigned + 4 * i);
    s.setLong(V.employed, employed >>> 0);
  }

  // $A270: monthly morale drift.
  private moraleMonthly(): void {
    const s = this.s;
    const sports = this.tCount(TY.sports);
    if (sports !== 0) this.applyMorale(mulu(((sports & 0xff) - 6) & 0x80 ? sports : 5, 100));
    const grant = s.long(V.grant);
    if (grant !== 0) this.applyMorale(divuQ(grant, 10));
    if (this.tCount(TY.commandCentre) === 0) this.applyMorale(-500);
    // The yearly tax-rise term uses the same table as every month.
    this.applyMorale(TAX_MORALE[s.long(A.tax)] ?? 0);
    const virus = s.byte(V.virusLevel);
    if (virus !== 0) this.applyMorale(muls(virus, -100));
    if (s.signedLong(A.morale) < 0) s.setLong(A.morale, s.long(A.morale) + 1);
  }

  // $10BC8: crime level from morale, a random term, the early-game bonus and security staff.
  private crimeMonthly(): void {
    const s = this.s;
    const m = s.signedLong(A.morale);
    const q = m >= 0 ? divuQ(m, 100) : -divuQ(-m, 100);
    let d1 = 100 - ((q + 100) >> 1);
    d1 -= this.roll(20) - 8 - 2;
    const early = 5 - s.long(A.year);
    if (early > 0) d1 -= early << 3;
    let pct = divuQ(mulu(s.long(V.security), 100), s.long(V.population)) & 0xff;
    if (s.byte(V.power) >= 0xd) pct = (pct & 0xff) >> 1;
    s.setByte(V.security_pct, pct);
    let reduction = 0;
    if (pct !== 0) {
      let p = pct;
      if (s8(p) > 10) {
        if (s8(p) > 20) {
          p = 20;
          s.setByte(V.security_pct, p);
        }
        reduction = 0x3c + ((p - 10) & 0xff);
      } else if (s8(p) > 5) {
        const t = (p - 5) & 0xff;
        reduction = 0x1e + ((t * 3) & 0xff);
      } else {
        reduction = (p * 6) & 0xff;
      }
    }
    s.setLong(V.crime, (d1 - reduction) >>> 0);
  }

  // $A620: each tank yard (record tile $45) takes goods 1 until its counter (byte +6) reaches 20,
  // then 2 of good 3, then puts a unit on a free neighbouring cell and starts over. Unit type 10
  // when invention bit 2 is set, else 9.
  tankYard(): void {
    const s = this.s;
    if (s8(s.byte(V.power)) >= 0xa) return;
    if (s.word(0x133f8) === 0) return this.msg(0xb3);
    const yards = s.word(0x1337a);
    if (yards === 0) return;
    const per = divuQ(s.long(0x143fa), yards);
    if (per === 0) return;
    const objects = this.world.objects;
    let left = yards;
    for (let slot = 0; slot < OBJECT_SLOTS && left > 0; slot++) {
      const at = slot * 8;
      if (((objects[at] << 8) | objects[at + 1]) !== 0x45) continue;
      left--;
      let counter = objects[at + 6];
      if (counter < 0x80) {
        if (counter < 20) {
          const want = s8(per) < 20 - counter ? per & 0xff : 20 - counter;
          const took = this.removeGoods(want, 1);
          if (took === 0) return this.msg(0x96);
          counter = (counter + took) & 0xff;
          objects[at + 6] = counter;
          this.add32(0x1437a, took);
          this.add32(0x143a2, took);
          s.setLong(0x1434a, s.long(0x1434a) - took);
          if (s8(counter) < 20) continue;
        }
        if (this.removeGoods(2, 3) === 0) return this.msg(0x94);
        objects[at + 6] = 0xff;
      }
      const advanced = (s.long(V.invention) & 4) !== 0;
      // $A6D2-$A756 runs first: with no free neighbour the message is $95 and the counter keeps its value (retry).
      const exit = this.yardExit(objects[at + 4], objects[at + 5]);
      if (exit === null) {
        this.msg(0x95);
        continue;
      }
      // $A756: the counter is cleared and the made-units counter $143B6 counted BEFORE the call to $37CA, so both
      // happen even when the unit list is full (the unit is then not placed and message $8F is shown).
      objects[at + 6] = 0;
      this.add32(0x143b6, 1);
      if (s.word(V.tanks) >= 99 || !this.spawnUnit(exit.x, exit.y, advanced)) {
        this.msg(0x8f); // $37CA: the unit list is full
        continue;
      }
      s.setWord(V.tanks, s.word(V.tanks) + 1);
      this.add32(advanced ? 0x14258 : 0x14254, 1);
    }
  }

  // $A360: production. Pool 5 (workshop) makes good 4, pool 0 turns good 1 into good 3,
  // mines (pool 2) yield good 2 and ore, the fuel plant (pool 1) fills the tanks.
  private production(): void {
    const s = this.s;
    for (let i = 0; i < 6; i++) s.setLong(0x143a6 + 4 * i, 0);
    const lvl = s.byte(V.power);
    const assigned = (i: number): number => s.long(V.jobAssigned + 4 * i);
    body: {
      if (lvl < 3 && assigned(5) !== 0) {
        const r = this.addGoods(assigned(5), 4);
        s.setLong(0x143ba, r.added);
        if (r.overflow) {
          this.msg(0x6c);
          break body;
        }
      }
      if (lvl < 8 && assigned(0) !== 0) {
        const used = this.removeGoods(mulu(assigned(0), 1), 1);
        this.add32(0x1437a, used);
        this.add32(0x143a2, used);
        s.setLong(0x1434a, s.long(0x1434a) - used);
        const r = this.addGoods(used, 3);
        s.setLong(0x143a6, r.added);
        if (r.overflow) {
          this.msg(0x6c);
          break body;
        }
      }
      s.setByte(0x144c3, 0);
      s.setLong(0x1435e, 0);
      if (lvl < 0xc && assigned(2) !== 0) {
        let found = 0;
        const miners = assigned(2) & 0xffff;
        for (let i = 0; i < miners; i++) if (this.roll(100) === 0) found++;
        const r = this.addGoods(found, 2);
        s.setLong(0x14436, r.added);
        if (r.overflow) {
          this.msg(0x6c);
          break body;
        }
        if (this.tCount(TY.mine) !== 0) {
          const ore = this.richnessSum(assigned(2), this.tCount(TY.mine), TILE_MINE);
          const o = this.addGoods(ore, 1);
          s.setLong(0x143ae, o.added);
          s.setLong(0x1435e, o.added);
          this.add32(0x1434a, o.added);
          if (o.overflow) this.msg(0x6c);
        }
      }
    }
    s.setLong(0x14356, 0);
    if (lvl < 0xb && assigned(1) !== 0 && this.tCount(TY.fuelPlant) !== 0) {
      const fuel = this.richnessSum(assigned(1), this.tCount(TY.fuelPlant), TILE_FUEL);
      s.setLong(0x143aa, fuel);
      s.setLong(0x14356, fuel);
      if (this.storeFuel(fuel)) this.msg(0x6e);
    }
  }

  // $A4A8: workers fill the buildings of one tile type in descending order of the richness
  // byte (+6 of the record), 10 workers per building; the sum is halved. Also writes the
  // average richness to $144C3.
  private richnessSum(workers: number, count: number, tile: number): number {
    const objects = this.world.objects;
    const values: number[] = [];
    for (let i = 0; i < objects.length && values.length < count; i += 8) {
      if (((objects[i] << 8) | objects[i + 1]) === tile) values.push(objects[i + 6]);
    }
    let sum = 0;
    for (const v of values) sum += v;
    this.s.setByte(0x144c3, divuQ(sum & 0xff, values.length || 1));
    values.sort((x, y) => y - x);
    let total = 0;
    for (let w = 0; w < workers; w++) total += values[Math.floor(w / 10)] ?? 0;
    return total >> 1;
  }

  // $A51A: store fuel in the two tank types. Returns true when there is nowhere to put it
  // (no tanks, or full: message 110). The stored words follow the original, including its
  // flat 800/1200 limits and the untouched second type when everything fits the first.
  storeFuel(produced: number): boolean {
    const s = this.s;
    const a = TY.tankA;
    const b = TY.tankB;
    const countA = this.tCount(a);
    const countB = this.tCount(b);
    if (countB === 0 && countA === 0) return true;
    const stored = this.tStored(a) + this.tStored(b);
    let d0 = (produced + stored) | 0;
    let d1 = 0;
    let flag = false;
    const capA = mulu(countA, 800);
    let fits = false;
    if (capA === 0) {
      d1 = d0;
      d0 = 0;
    } else if (((capA - d0) | 0) >= 0) {
      fits = true;
    } else {
      d1 = d0;
      d0 = 800;
      d1 -= 800;
    }
    if (!fits) {
      const capB = mulu(countB, 1200);
      if (((capB - d1) | 0) < 0) {
        d1 = (d1 & 0xffff0000) | 1200;
        flag = true;
      }
      if (countB === 0) d1 = 0;
      this.setTStored(b, d1);
    }
    this.setTStored(a, d0);
    s.setLong(V.fuelStored, (d0 + d1) | 0);
    return flag;
  }

  // ---- trade -----------------------------------------------------------------------------

  // $A7AE: one step of the random walk of a market entry (value, min, max, step, countdown).
  private walkEntry(addr: number): void {
    const s = this.s;
    const min = s16(s.word(addr + 2));
    const max = s16(s.word(addr + 4));
    let value = s16(s.word(addr));
    let step = s16(s.word(addr + 6));
    let countdown = s16(s.word(addr + 8));
    if (countdown === 0) {
      let d2 = this.roll(4) & 0xff;
      if (d2 === 0) return;
      countdown = d2 + 3;
      d2 = this.roll(max - min) + min;
      let diff = s16(d2 - value);
      if (diff >= 0) {
        step = s16(divuQ(diff, countdown) + 1);
      } else {
        diff = -diff;
        step = s16(-(divuQ(diff, countdown) + 1));
      }
    }
    value = s16(value + step);
    if (((value - min) & 0x8000) !== 0) value = min;
    if (value > max) value = max;
    countdown = s16(countdown - 1);
    s.setWord(addr, value);
    s.setWord(addr + 2, min);
    s.setWord(addr + 4, max);
    s.setWord(addr + 6, step);
    s.setWord(addr + 8, countdown);
  }

  // $A802: price walk for the 12 market entries, then this month's supply and demand.
  private marketWalk(): void {
    const s = this.s;
    for (let i = 0; i < 12; i++) {
      const addr = V.market + 10 * i;
      this.walkEntry(addr);
    }
    const base = divuQ(s.long(V.population), 100) + 1;
    for (let i = 0; i < 6; i++) {
      const entry = s.word(V.market + 10 * (6 + i));
      let amount = mulu(base, entry);
      if (amount >= 0x2710) amount = 0x270f;
      s.setLong(V.supply + 4 * i, amount);
      s.setLong(V.demand + 4 * i, 0);
      if (this.roll(100) > 0x32) {
        s.setLong(V.demand + 4 * i, amount);
        s.setLong(V.supply + 4 * i, 0);
      }
    }
  }

  // $A86A (with $A784): automatic sales. Per commodity (fuel, then goods 0..4) the tradable
  // share (stock above the retain percentage), limited by this month's demand, is sold at
  // the market price.
  private tradeIncome(): void {
    const s = this.s;
    const bits = s.byte(V.tradeBits);
    s.setByte(V.tradeBits, bits & ~0x01);
    if ((bits & 0x01) === 0) return;
    if (s.byte(V.tradeFail) !== 0) return;
    s.setLong(V.fuelCopy, s.long(V.fuelStored));
    for (let i = 0; i < 6; i++) {
      const src = s.long(V.fuelCopy + 4 * i);
      const kept = divuQ(mulu(s.long(V.retain + 4 * i), src), 100);
      s.setLong(V.tradable + 4 * i, src - kept);
    }
    for (let i = 0; i < 6; i++) {
      let units = s.long(V.tradable + 4 * i);
      const demand = s.long(V.demand + 4 * i);
      if (units === 0 || demand === 0) continue;
      if (((demand - units) | 0) < 0) units = demand;
      if (i === 0) this.add32(V.fuelStored, -units);
      else units = this.removeGoods(units, i - 1);
      const income = mulu(units, s.word(V.market + 10 * i));
      this.add32(V.money, income);
      this.add32(0x142f6, income);
    }
    s.setLong(0x1434a, s.long(0x13156));
  }

  // ---- quality of life ($A8E8, on the first day of each month) ---------------------------

  qualityOfLife(): void {
    const s = this.s;
    let pollution = s.long(A.pollution);
    if (((150 - s.long(V.researchAccum)) | 0) < 0) {
      s.setLong(V.researchAccum, s.long(V.researchAccum) - 150);
      pollution = (pollution - 1) >>> 0;
      s.setLong(A.pollution, pollution);
      const low = pollution & 0xff;
      if (low === 0x31) this.msg(0x17d);
      else if (low === 0x28 || low === 0x1e) this.msg(0x17e);
      else if (low === 0x14) this.msg(0x180);
    }
    let q = 0;
    const crime = s.signedLong(V.crime);
    if (crime < 0) {
      q += 200;
    } else {
      let c = mulu(crime, 100) >> 3;
      if (s8(c) > 6) c = 6;
      q -= c;
    }
    q += divuQ(Math.min(s.long(V.population), 10000), 5);
    if (this.sysFlags & SYS.noUnitBonus) {
      q += 2000;
    } else {
      let units = s.word(V.tanks) + s.word(V.ships);
      for (const i of [5, 6, 8, 9]) units += this.tCount(i);
      q += s16(mulu(units & 0xffff, 10));
    }
    q += TAX_QOL[s.long(A.tax)] ?? 0;
    if (s.long(V.invention) & 0x10000) q += 300;
    if (s.byte(V.virusTime) !== 0) q -= 300;
    if (this.tCount(TY.commandCentre) === 0) q -= 350;
    q += Math.min(this.tCount(TY.sports), 5) * 100;
    if (s.byte(V.crowded) !== 0) q -= 400;
    if (s.byte(V.starving) !== 0) q -= 400;
    if (s.byte(V.airShort) !== 0) q -= 400;
    // Original quirk: the power-shortage term ($144C8) is added to a6, not to the sum.
    let weights = this.tCount(TY.mine);
    weights += this.tCount(TY.fuelPlant) * 3;
    weights += this.tCount(TY.powerStation) * 3;
    weights += this.tCount(TY.airA) * 2;
    weights += this.tCount(23) * 2;
    weights += this.tCount(TY.boiler);
    weights += this.tCount(22) * 2;
    weights += this.tCount(27) * 2;
    if (weights > 0x32) weights = 0x32;
    q -= mulu(weights, pollution);
    let qol = divsQ(q, 100) + 0x37;
    if (qol > 0x62) qol = 0x62;
    if (this.sysFlags & SYS.tutorialMode) qol = s16(qol - 0x1e);
    if (qol < 0x0a) qol = 0x0a;
    s.setLong(A.qualityOfLife, qol);
    if (((qol & 0xff) - 0x50) & 0x80) return;
    if ((((qol & 0xff) - 0x5a) & 0x80) !== 0) {
      const done = this.sysFlags & SYS.qol80;
      this.sysFlags |= SYS.qol80;
      if (!done) this.events.push({ kind: "announce", id: 2 });
    } else {
      this.sysFlags |= SYS.qol80;
      const done = this.sysFlags & SYS.qol90;
      this.sysFlags |= SYS.qol90;
      if (!done) this.events.push({ kind: "announce", id: 3 });
    }
  }

  // ---- yearly ----------------------------------------------------------------------------

  // $A096 plus the register copy in $99C4: the tax chosen for next year takes effect.
  // Original quirk: a tax rise applies a positive morale change.
  private yearly(): void {
    const s = this.s;
    for (let i = 0; i < 5; i++) s.setLong(0x14302 + 4 * i, s.long(0x14316 + 4 * i));
    s.setLong(0x1431a, 0);
    s.setLong(0x14326, 0);
    const oldTax = s.long(A.tax);
    const next = s.long(A.nextTax);
    s.setLong(A.tax, next);
    const rise = (next - oldTax) | 0;
    if (rise > 0) this.applyMorale(mulu(rise, 300));
    for (let i = 0; i < 5; i++) {
      s.setLong(0x1437e + 4 * i, s.long(0x14392 + 4 * i));
      s.setLong(0x14392 + 4 * i, 0);
    }
  }

  // ---- player-facing setters ---------------------------------------------------------------

  // Staffing level the player wants for a job pool (0..8): $14500[pool].
  setJobCap(pool: number, staff: number): void {
    this.s.setLong(V.jobCap + 4 * pool, staff);
  }

  // Tax rate for the next year (applied at the year change), 0..20.
  setNextTax(rate: number): void {
    this.s.setLong(A.nextTax, rate);
  }

  // Percentage of a trade commodity (0 = fuel, 1..5 = goods 0..4) the player keeps back.
  setRetainPercent(commodity: number, percent: number): void {
    this.s.setLong(V.retain + 4 * commodity, percent);
  }
}
