// Gameplay map view: 8x8-cell isometric window over the 100x75 map, with scroll arrows, animated cells,
// own/enemy objects (objects.ts), message text, warning lights and the top bar.
// Projection, tile blit and scroll rules: notes/formats/map-rendering.md.
//
// Timing: `update()` is the 50 Hz video update (VBL). It offers each update to `Sim.countFrame`, which applies the
// original pause/modal gates. Simulation work runs only on the pass boundary chosen by `MainLoop` (4 video updates by
// default). On a normal boundary, object/special updates and the `$6936` cell scan happen before redraw; the money/date
// text sequence runs during the top-bar draw, then periodic work and input follow the redraw. Grouping of the original VBL
// wait into this browser callback remains an approximation (see `loopPass` and map-rendering.md).

import { COLOR, drawGameText, patchNumber, readTemplate, TEMPLATES } from "../data/gamefont.js";
import { decodePicture, PICTURES } from "../data/picture.js";
import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK, TILE_WIDTH, type Tile } from "../data/scenario.js";
import { Screen, SCREEN_WIDTH } from "../gfx/screen.js";
import type { Input } from "./intro.js";
import type { GameStrings } from "../data/gamestrings.js";
import { readFlagTable, readInventionText, readLightIcons, readWeights } from "../data/gameimage.js";
import { Builder } from "./build.js";
import { Controls } from "./controls.js";
import { mapPointerPoint, type PointerPoint } from "./pointer-input.js";
import { Messages } from "./messages.js";
import { captureCheckpoint, CheckpointRecorder, type CheckpointOptions, type CheckpointRecorderOptions, type CheckpointSource, type RuntimeCheckpoint } from "./checkpoint.js";
import { MainLoop } from "./main-loop.js";
import { restoreMapBackground } from "./map-background.js";
import { loadCombatTables } from "../data/combat.js";
import { EnemySystem, type EnemyHooks } from "./enemies.js";
import type { PreparedDisk4HeadlessEnemies } from "./disk4-load.js";
import { validateSpecialSlots, readSavedMarkers, readSavedView, type SceneRestoreError } from "./disk4-scene.js";
import type { UnitHooks, UnitSystem } from "./units.js";
import { readAlienApparition } from "./alien-sprite.js";
import { readMeteor } from "./meteor-sprite.js";
import { EFFECT_EXPLOSION, EFFECT_EXPLOSION_HIGH, INVENTION_ADDRESS, INVENTION_GATE_BIT, ObjectLayer } from "./objects.js";
import { pickObject, type Pick } from "./orders.js";
import type { SpriteSet } from "../data/sprites.js";
import { SFX } from "../audio/sfx.js";
import { MarkerMode, markerMessageText } from "./screens/markers.js";
import { A } from "./state.js";
import { Sim, type SimOptions } from "./sim.js";
import { Alerts, LIGHT_SIZE, LIGHT_X, LIGHT_Y } from "./sim-alerts.js";
import type { World } from "./world.js";

export const VIEW_CELLS = 8;
// News and spy-report messages that come with the alert tone ($11B4 callers).
const ALERT_MESSAGES = new Set([0x157, 0x8d, 0x186]);
const MAX_SCROLL_X = MAP_WIDTH - VIEW_CELLS;
const MAX_SCROLL_Y = MAP_HEIGHT - VIEW_CELLS;
const START_X = 47;
const START_Y = 33;
// Areas the remake's per-pass overlays use that `$16012` does not restore (see `restoreOverlayAreas`).
const OVERLAY_MESSAGE_FIRST_ROW = 160;
const OVERLAY_PANEL_X = 272;
const OVERLAY_PANEL_FIRST_ROW = 22;
const ANIMATED_FLAG = 0x400;
const A_POWER_LEVEL = 0x144c8;
// A finished ship is announced by four button clicks, 11 frames apart ($4128-$414C).
const LAUNCH_CLICKS = 4;
const CLICK_FRAMES = 11;

// Window clip: the map occupies x 0..255 of the screen.
const CLIP_RIGHT = 256;

interface Arrow {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  dx: number;
  dy: number;
}

// Scroll arrow rectangles (inclusive) and the scroll change per step.
const ARROWS: Arrow[] = [
  { x0: 240, x1: 261, y0: 122, y1: 132, dx: 0, dy: -1 },
  { x0: 216, x1: 237, y0: 122, y1: 132, dx: -1, dy: 0 },
  { x0: 216, x1: 237, y0: 136, y1: 146, dx: 0, dy: 1 },
  { x0: 240, x1: 261, y0: 136, y1: 146, dx: 1, dy: 0 },
];

export function anchorX(vx: number, vy: number): number {
  return 112 + 16 * (vx - vy);
}

export function anchorY(vx: number, vy: number): number {
  return 39 + 8 * (vx + vy);
}

export interface MapSceneOptions {
  onDiskMenu?: () => void;
  onScreen?: (kind: "trade" | "staff" | "intel" | "overview" | "council") => void;
  onSelect?: (x: number, y: number) => void;
  onPick?: (px: number, py: number) => void;
  sfx?: (id: number, volume?: number) => void;
  sprites?: SpriteSet;
  /** Video updates per main-loop pass; default `DEFAULT_VBL_PER_PASS` (4, measured baseline). */
  vblPerPass?: number;
  /** Optional deterministic Sim inputs for trace replay and tests. */
  simulation?: { rng?: SimOptions["rng"]; hardware?: SimOptions["hardware"] };
  /** Game-flow initialization performed after a fresh Disk.2 scenario is built (never for a restored graph). */
  scenarioStartup?: { readonly initialAlien: boolean };
}

// Module-private brand: only MapScene.fromPrepared can ask the constructor for the restore path.
const FROM_PREPARED: unique symbol = Symbol("MapScene.fromPrepared");

interface RestoredParts {
  readonly brand: typeof FROM_PREPARED;
  readonly sim: Sim;
  readonly units: UnitSystem;
  readonly enemies: EnemySystem;
  readonly view: { readonly x: number; readonly y: number };
  readonly pins: readonly ({ x: number; y: number } | null)[];
}

// Prepared graphs that already drive a scene: their callbacks can only be bound once.
const activatedGraphs = new WeakSet<Sim>();

export type MapSceneRestoreResult =
  | { readonly ok: true; readonly value: MapScene; readonly view: { readonly x: number; readonly y: number; readonly savedX: number; readonly savedY: number; readonly clamped: boolean } }
  | { readonly ok: false; readonly error: SceneRestoreError };

export class MapScene {
  readonly screen = new Screen();
  /** Restored static background used by local-data checks and diagnostics. */
  readonly background: Uint8Array;
  private readonly initialPicture: Uint8Array;
  private readonly screenBuffers: [Uint8Array, Uint8Array];
  private activeScreenBuffer = 0;
  private readonly cells: Uint16Array;
  private readonly state: World["state"];
  readonly sim: Sim;
  readonly world: World;
  /** True for a scene built by `MapScene.fromPrepared` (experimental Disk.4 continuation), false otherwise. */
  readonly restoredFromDisk4: boolean;
  private readonly messages: Messages;
  readonly controls: Controls;
  readonly objects: ObjectLayer | null; // units, marker pins and effects; null without the sprite sheets
  readonly enemies: EnemySystem | null; // enemy ground and air units, ships, missiles, guns (needs the object layer)
  scrollX = START_X;
  scrollY = START_Y;
  // Live accessor for the overview window, which reads and writes the scroll position.
  readonly scrollRef: { x: number; y: number } = (() => {
    const scene = this;
    return {
      get x() { return scene.scrollX; },
      set x(v: number) { scene.scrollX = v; },
      get y() { return scene.scrollY; },
      set y(v: number) { scene.scrollY = v; },
    };
  })();
  private readonly playSfx: (id: number, volume?: number) => void;
  private readonly markerMode = new MarkerMode();
  /** Pass scheduler: counts video updates, says when a main-loop pass is due. */
  readonly loop: MainLoop;
  private frame = 0; // video updates (blink phase of the top bar)
  private modalCheckpointUpdates = 0;
  /** Pointer-selected map view cell (`$14636`); the blink bit toggles when that cell is drawn. */
  private hoverViewCell: { vx: number; vy: number } | null = null;
  // `$156A9` bit 1 starts set in the loaded image, so the first matching cell draw uses its normal tile.
  private selectionBlinkBit = 1;
  // A button pressed and released between two polls would be lost (the original polls once per pass and does lose
  // it); the browser deviates here on purpose: a press seen in any update since the last poll counts as down.
  private sawLeft = false;
  private sawRight = false;
  private lightWasDown = false;
  private rightWasDown = false;
  private suppressButtonsUntilRelease = false;
  private clicksLeft = 0; // button clicks still to play for a finished ship
  private clickWait = 0;
  private onPick: (px: number, py: number) => void = () => {};
  private readonly lightIcons: Uint8Array[];
  private checkpointRecorder: CheckpointRecorder | null = null;

  /** `$2FBA` selects the cell-hover pointer while the map's current hit test names a cell outside a modal menu. */
  get pointerUsesCellHover(): boolean {
    return this.hoverViewCell !== null && !this.controls.menuVisible;
  }

  /** Original `$14591`: select/demolish modes clamp at `$138/$C0`; build mode uses the other `$2CDA` limit path. */
  pointerPoint(x: number, y: number): PointerPoint {
    return mapPointerPoint(x, y, this.controls.menuVisible ? "build" : this.controls.mode);
  }

  constructor(
    private readonly disk: Uint8Array,
    private readonly tiles: Tile[],
    world: World,
    strings: GameStrings,
    options: MapSceneOptions = {},
    restored?: RestoredParts,
  ) {
    if (restored && restored.brand !== FROM_PREPARED) throw new Error("MapScene: use MapScene.fromPrepared for a restored scene");
    this.restoredFromDisk4 = restored !== undefined;
    this.loop = new MainLoop(options.vblPerPass);
    this.messages = new Messages(disk, strings);
    this.world = world;
    this.cells = world.cells;
    this.state = world.state;
    const unitHooks: UnitHooks = {
      lost: (u) => this.enemies?.tankLeft(u),
      combat: (u, moveTick) => this.enemies?.tankCombat(u, moveTick),
    };
    // A restored scene adopts the prepared UnitSystem (slots, clock and provenance intact) instead of making a new one.
    this.objects = options.sprites
      ? new ObjectLayer(options.sprites, tiles, this.cells, (t, x, y) => this.drawTile(t, x, y), () => world.state.byte(A.techLevel), unitHooks, world.cellFlags, restored?.units)
      : null;
    const builder = new Builder(world, readFlagTable(disk), readWeights(disk), (n) => this.messages.push(n));
    const simHooks: Omit<SimOptions, "rng" | "hardware"> = {
      // `$7372` only. Whether the demolition is a blast belongs to the caller: `Sim.bomb` (`$12332`) asks for one `explosion`
      // effect per returned footprint cell (`blastCell`), the mine collapse (`$11090`) calls `$7372` alone and stays silent.
      demolishAt: (x, y, bombing = false) => {
        const footprint: [number, number][] = [];
        builder.demolish(x, y, footprint, bombing);
        return footprint;
      },
      destroyUnit: () => this.destroyFirstUnit(),
      onWeek: () => builder.weekly(),
      centreChanged: (slot) => builder.construction.redrawCentre(slot),
      onDay: () => this.messages.dayPassed(),
      effect: (kind, x, y) => this.simEffect(kind, x, y),
      spawnUnit: (x, y, advanced) => (this.objects ? this.objects.units.spawnAtYard(x, y, advanced) !== null : true),
      spawnEnemy: (spawn) => this.enemies?.spawn(spawn) ?? true,
      defectUnit: () => (this.enemies ? this.enemies.defect() : { x: -1, y: -1 }),
      repairUnits: (amount) => this.enemies?.repair(amount),
    };
    const enemyHooks: EnemyHooks = {
      explode: (x, y, lift, high) => this.blastCell(x, y, lift, high),
      sound: (id) => this.playSfx(id),
      buildPad: (x, y) => builder.placeLaunchpad(x, y),
      buildingHeight: (x, y) => tiles[(this.cells[y * MAP_WIDTH + x] & TILE_ID_MASK) - 1]?.rows ?? 0,
    };
    if (restored) {
      // The prepared Sim / EnemySystem are used as they are (never rebuilt: the EnemySystem owns the adopted
      // roster and the Fleet callbacks); their callbacks are bound at the end of this constructor.
      this.sim = restored.sim;
      this.enemies = restored.enemies;
    } else {
      this.sim = new Sim(world, { interactive: true, ...options.simulation, ...simHooks });
      this.enemies = this.objects ? new EnemySystem(this.sim, this.objects.units, loadCombatTables(disk), enemyHooks) : null;
      if (options.scenarioStartup) {
        this.sim.initializeScenarioStart(options.scenarioStartup.initialAlien);
        // `$157BC` starts the first game pass directly after boot/menu exit; it does not first wait for a full VBL interval.
        this.loop.resumeWithImmediatePass();
      }
    }
    if (this.objects) {
      this.objects.enemies = this.enemies;
      this.objects.apparition = () => readAlienApparition(world.state); // read-only: the sim owns $144A8
      this.objects.meteor = () => readMeteor(world.state); // read-only: the sim owns $1449C and its countdown
      this.objects.inventionGate = () => (world.state.long(INVENTION_ADDRESS) & INVENTION_GATE_BIT) !== 0; // opens the redraw gate $156A9 bit 3
    }
    this.controls = new Controls(disk, world, builder, strings, (n) => this.messages.push(n), () => ({ x: this.scrollX, y: this.scrollY }), options.onDiskMenu, tiles);
    if (options.onScreen) this.controls.onScreen = options.onScreen;
    if (options.onSelect) this.controls.onSelect = options.onSelect;
    if (options.onPick) this.onPick = options.onPick;
    this.playSfx = options.sfx ?? (() => {});
    this.controls.onMarkerButton = () => this.messages.push(this.markerMode.arm());
    this.controls.cellHook = (x, y) => {
      if (!this.objects) return false;
      const result = this.markerMode.click(this.objects, x, y);
      if (!result) return false;
      if (result.pin) this.messages.pushText(markerMessageText(strings, result.pin));
      else this.messages.push(result.message);
      return true;
    };
    this.controls.onClick = () => this.playSfx(SFX.CLICK);
    this.controls.isPaused = () => this.sim.paused;
    this.controls.onPause = () => {
      this.sim.paused = !this.sim.paused;
    };
    this.lightIcons = readLightIcons(disk);
    decodePicture(disk, PICTURES.main, this.screen);
    this.initialPicture = this.screen.pixels.slice();
    // The original copies the decoded picture to both bitmaps at `$2B1A`, then restores selected regions once per pass
    // while preserving untouched pixels in each bitmap (`$16012`).
    this.background = restoreMapBackground(this.initialPicture);
    this.screenBuffers = [this.initialPicture.slice(), this.initialPicture.slice()];
    if (restored) {
      // Everything that can throw has run. From here on the prepared graph belongs to this scene.
      this.scrollX = restored.view.x;
      this.scrollY = restored.view.y;
      this.objects?.restoreMarkers(restored.pins);
      this.suppressButtonsUntilRelease = true;
      this.objects?.preparePassGate(this.scrollX, this.scrollY);
      // One frame of what was saved, with no tick, step, construction pass, RNG draw or state write.
      this.drawInitialFrame();
      // The render can fail on malformed presentation assets. Claim and bind the graph only after it succeeds.
      activatedGraphs.add(restored.sim);
      restored.sim.bindRuntimeHooks({ interactive: true, ...simHooks });
      restored.enemies.bindHooks(enemyHooks);
      restored.units.bindHooks(unitHooks);
    } else {
      // Hold the initial gate stable until the first main-loop pass refreshes it.
      this.objects?.preparePassGate(this.scrollX, this.scrollY);
      this.drawInitialFrame();
    }
  }

  /**
   * Experimental Disk.4 continuation: builds a scene around a graph prepared by `prepareDisk4HeadlessEnemies()`
   * WITHOUT replacing it. `scene.world`, `scene.sim`, `scene.objects.units` and `scene.enemies` are the prepared
   * instances (state, map words, flag bytes, object records, RNG, fixed slots, ship extras and Fleet callbacks are
   * as prepared). Presentation callbacks are bound only after every fallible step has succeeded; construction
   * ticks nothing and writes no saved byte. It draws one initial frame.
   *
   * Taken from the save: the view origin ($144E4/$144E6, clamped for display only) and the eight pin records
   * ($14540 + 10 n, +1 x / +2 y, y = $FF unplaced), set without any key handling. NOT restored (stated, not
   * guessed): messages, the effect pool and open dialogs (a fresh scene starts them empty, matching the traced load
   * reset), the original post-load initialisation. The warning lights, `sysFlags` ($156AA), the pause bit and the queued
   * day ($156A8 bit 7) are not saved; `Game.activateDisk4` sets them from the traced load reset (disk4-reset.ts) on the
   * detached graph before this call, and this constructor leaves them as given.
   * Active alien/meteor records are hydrated from their saved area-B bytes when their traced type, position, frame and
   * phase/countdown fields are valid. `sprites` is
   * required. Any problem returns one typed error and creates no scene; a graph can drive one scene only.
   */
  static fromPrepared(
    disk: Uint8Array,
    tiles: Tile[],
    prepared: PreparedDisk4HeadlessEnemies,
    strings: GameStrings,
    options: MapSceneOptions = {},
  ): MapSceneRestoreResult {
    const fail = (error: SceneRestoreError): MapSceneRestoreResult => ({ ok: false, error });
    if (!options.sprites) {
      return fail({ code: "sprites-required", message: "A restored scene needs the sprite sheets: without them own tanks, ships and enemies would be invisible" });
    }
    const { world, state, sim, tanks, enemySystem } = prepared;
    if (activatedGraphs.has(sim)) return fail({ code: "already-activated", message: "This prepared graph already drives a scene" });
    if (sim.initialization !== "snapshot" || sim.world !== world || world.state !== state || !tanks.usesBuffers(world.cells, world.cellFlags) || !enemySystem.isComposedOf(sim, tanks)) {
      return fail({ code: "graph-mismatch", message: "The prepared state, world, Sim, tank system and enemy system do not belong together" });
    }
    const special = validateSpecialSlots(state);
    if (special) return fail(special);
    const pins = readSavedMarkers(state);
    if (!pins.ok) return fail(pins.error);
    const view = readSavedView(state);
    try {
      const restored: RestoredParts = { brand: FROM_PREPARED, sim, units: tanks, enemies: enemySystem, view, pins: pins.value };
      const scene = new MapScene(disk, tiles, world, strings, options, restored);
      return { ok: true, value: scene, view };
    } catch (error) {
      return fail({ code: "exception", message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Opt-in runtime checkpoints (notes/formats/runtime-checkpoints.md). From the next completed main-loop pass on, a
   * deep-frozen JSON-serializable `RuntimeCheckpoint` is stored in the returned in-memory recorder (and handed to
   * `options.onCheckpoint`) after each completed pass; normal passes include redraw/date/periodic/input, while modal
   * passes include menu input and redraw only. Purely observational: no game state, RNG, hook or input is touched.
   * A second call replaces the previous recorder.
   */
  enableCheckpoints(options: CheckpointRecorderOptions = {}): CheckpointRecorder {
    const recorder = new CheckpointRecorder(options);
    this.messages.observer = (index) => recorder.noteMessage(index);
    this.checkpointRecorder = recorder;
    return recorder;
  }

  /** Stops recording; the recorder returned earlier keeps what it stored. */
  disableCheckpoints(): void {
    this.messages.observer = null;
    this.checkpointRecorder = null;
  }

  /** One-off read-only checkpoint (boundary "manual") of the current state; does not need `enableCheckpoints`. */
  captureCheckpoint(options: CheckpointOptions = {}): RuntimeCheckpoint {
    return captureCheckpoint(this.checkpointSource(), "manual", options);
  }

  private checkpointSource(): CheckpointSource {
    return {
      loop: this.loop,
      sim: this.sim,
      units: this.objects?.units ?? null,
      enemies: this.enemies,
      effectSlots: this.objects?.effectSlots,
      markers: this.objects?.markers,
      view: { x: this.scrollX, y: this.scrollY },
      messageLog: this.messages.inspect(),
    };
  }

  // $4692 for the Earth tank requisition: removes the first unit (the original walks its list in slot order) without a
  // blast (bit 5 of $156A9 is not set, so $4732 does not call $1237C). The counts and morale belong to Sim.
  private destroyFirstUnit(): number | null {
    const layer = this.objects;
    if (!layer) return this.state.long(0x14254) > 0 ? 9 : this.state.long(0x14258) > 0 ? 10 : null;
    const unit = layer.units.units[0];
    if (!unit) return null;
    layer.removeUnit(unit);
    return unit.type;
  }

  // $1237C, the one blast routine (units.md section 6, sfx.md): the window test is the 8x8 view at ($144E4, $144E6).
  // Outside it only the half-volume sound plays (no sprite, no pool use). Inside it the blast sprite (type $12, or $14 for
  // a non-zero lift) takes the first free of the 30 fixed effect slots at the victim's altitude and the full-volume sound
  // plays; with the list full the routine returns early: no sprite, no sound. `high` selects the unit-destroyed sound
  // (bit 3 of $1581: single object destroyed in combat) over the area-blast one.
  // Returns whether the original routine clobbered A6 (the caller's map-word pointer): true off-view and after a
  // successful allocation, false when the list was full. Only the combat caller ($4732 family) keeps A6 live and
  // uses this value; `$12332` pushes A6 around each call. Without an ObjectLayer an available slot is assumed
  // (headless approximation: the effect pool is not modelled there, so the in-view result is always "allocated").
  private blastCell(x: number, y: number, lift: number, high: boolean): boolean {
    const inside = x >= this.scrollX && x < this.scrollX + VIEW_CELLS && y >= this.scrollY && y < this.scrollY + VIEW_CELLS;
    if (inside) {
      // Sprite type is selected from $12D68 (the saved lift byte), independently of the high-volume/death-sound
      // flag. Ground kills have `high = true` but lift zero and therefore use type $12; airborne kills with nonzero
      // lift use type $14.
      const allocated = this.objects ? this.objects.spawnEffect(lift !== 0 ? EFFECT_EXPLOSION_HIGH : EFFECT_EXPLOSION, x, y, lift) : true;
      if (!allocated) return false;
    }
    this.playSfx(high ? SFX.EXPLOSION_HIGH : SFX.EXPLOSION_LOW, inside ? 64 : 32);
    return true;
  }

  // Graphics and sound the sim asks for (explosions, scroll-to-cell, launches, meteors, aliens).
  // "explosion" is one `$1237C` call at a cell: `Sim.bomb` emits one per footprint cell (`$12332`, area variant: lift 0,
  // low sound), and the Fleet's own ship destruction emits one at the ship (parameters not traced for that caller: lift 0
  // and the area sound, as before; only the shared window / volume / pool rules are applied). "meteorImpact" has no
  // presentation: `$11676` (and `$3626` before it) never calls `$1237C` for the impact centre; the blasts come only
  // from the bombed building cells, through "explosion".
  private simEffect(kind: string, x: number, y: number): void {
    if (kind === "explosion") this.blastCell(x, y, 0, false);
    else if (kind === "launch") this.clicksLeft = LAUNCH_CLICKS; // the ship is complete ($4128): four clicks, not the launch sound
    else if (kind === "alienAppear") this.playSfx(SFX.ALERT);
    // "focus" ($11432): Sim.alerts stores the view bookmark and lights the second warning light.
  }

  // Shows a string-table message on the message line / log.
  say(index: number): void {
    this.messages.push(index);
  }

  // $DF5A: a new invention. The original opens a picture dialog; here the description from table
  // $B1CC (word pair per invention: title, description) goes to the message log.
  announceInvention(bit: number): void {
    this.messages.push(readInventionText(this.disk, bit));
  }

  // Keyboard ($15B4A): P and space toggle the pause ($156A9 bit 2). `$15C02` tests-and-sets the bit: entering the pause
  // presses the inverted pause button through `$5756` (`$15C34`, id 4 click); leaving it runs `$159FC` + the silent release `$57FA`.
  private key(key: string, input: Input): void {
    if (key === "p" || key === "P" || key === " ") {
      const entering = !this.sim.paused;
      this.sim.paused = entering;
      if (entering) this.playSfx(SFX.CLICK);
    }
    // Raw key $22 (D): $31CC clears all eight pins, message $F2.
    if (this.objects && (key === "d" || key === "D")) {
      this.objects.clearMarkers();
      this.messages.push(0xf2);
    }
    // Keys 1-8 drop or lift a marker pin on the cell under the pointer (messages $71 / $72).
    if (this.objects && key >= "1" && key <= "8") {
      const cell = this.controls.pickCell(input.pointerX, input.pointerY);
      if (cell) this.messages.push(this.objects.toggleMarker(Number(key), cell.x, cell.y) === "placed" ? 0x71 : 0x72);
    }
  }

  // What a right click on the map in select mode picks ($3EDC): an own tank or a ship, null for anything else.
  pickObject(px: number, py: number): Pick | null {
    if (!this.objects) return null;
    return pickObject(this.objects, this.sim.fleet.ships, this.scrollX, this.scrollY, px, py, this.controls.pickCell(px, py));
  }

  // The four clicks of a finished ship, one every 11 frames.
  private playClicks(): void {
    if (this.clicksLeft <= 0 || --this.clickWait > 0) return;
    this.playSfx(SFX.CLICK);
    this.clicksLeft--;
    this.clickWait = CLICK_FRAMES;
  }

  private arrowAt(px: number, py: number): Arrow | undefined {
    return ARROWS.find((a) => px >= a.x0 && px <= a.x1 && py >= a.y0 && py <= a.y1);
  }

  private onArrow(px: number, py: number): boolean {
    return this.arrowAt(px, py) !== undefined;
  }

  private scroll(dx: number, dy: number, step: number): void {
    const x = Math.max(0, Math.min(MAX_SCROLL_X, this.scrollX + dx * step));
    const y = Math.max(0, Math.min(MAX_SCROLL_Y, this.scrollY + dy * step));
    if (x !== this.scrollX || y !== this.scrollY) {
      this.scrollX = x;
      this.scrollY = y;
    }
  }

  // One 50 Hz video update. The first pass after fresh entry or modal exit runs before this update's VBL-side work;
  // normal passes run after their preceding VBL. The outer-loop phase is suspended in the modal menu.
  update(input: Input): void {
    this.frame++;
    const modalAtStart = this.controls.menuVisible;
    const immediatePass = !modalAtStart && this.loop.immediatePassPending;
    if (!modalAtStart) this.modalCheckpointUpdates = 0;
    this.sawLeft ||= input.leftButton;
    this.sawRight ||= input.rightButton;
    let completed = false;
    let passBoundary = false;
    if (immediatePass) {
      // Fresh entry and modal exit return to `$157BC` without first waiting for VBL. The pass body and draw/date work
      // happen before the first VBL-side countdown update below.
      completed = this.loop.runImmediatePass();
      if (completed) this.loopPass();
    } else {
      // `$2C34`: countdown / gun latch run at VBL, except while the original dialog/build-menu freeze is active.
      this.sim.countFrame(modalAtStart);
      passBoundary = this.loop.vbl(!modalAtStart);
    }
    if (this.controls.menuVisible) {
      // `$B3D8` repeatedly calls `$50B2` without a VBL wait. The browser receives input once per video update, so poll the
      // modal menu at that cadence instead of waiting for the normal simulation-pass boundary. No simulation pass runs;
      // when the modal returns to the outer loop, queue its next pass for the next browser video update.
      input.keys?.splice(0);
      this.controls.update({ ...input, keys: [] });
      this.sawLeft = false;
      this.sawRight = false;
      if (!this.controls.menuVisible) this.loop.resumeWithImmediatePass();
      // Modal callbacks are diagnostic samples only. Do not advance MainLoop's simulation phase or pass count.
      this.modalCheckpointUpdates++;
    } else if (passBoundary) {
      this.loopPass();
      completed = true;
    }
    for (const index of this.sim.messages.splice(0)) {
      this.messages.push(index);
      if (ALERT_MESSAGES.has(index)) this.playSfx(SFX.ALERT);
    }
    this.playClicks();
    this.messages.update();
    // Pointer selection is sampled every browser update; map selection highlighting is painted only on a completed pass.
    const pointedCell = this.controls.menuVisible ? null : this.controls.pickCell(input.pointerX, input.pointerY);
    this.hoverViewCell = pointedCell ? { vx: pointedCell.x - this.scrollX, vy: pointedCell.y - this.scrollY } : null;
    if (completed) {
      this.drawPass();
    } else if (this.controls.menuVisible) {
      this.drawModal();
    } else if (modalAtStart) {
      // Menu exit (`$B628`): the pre-menu frame is shown again at once; the next update runs the queued pass.
      this.screen.pixels.set(this.screenBuffers[this.activeScreenBuffer]);
    }
    if (immediatePass) {
      // The original first waits for VBL after `$333A`/draw/date. Count that VBL only after the immediate pass has rendered.
      this.sim.countFrame(false);
      this.loop.vbl(true);
    }
    if (completed) {
      // The date tick `$564A` ran inside `drawTopBar` (`$4D1C`); the VBL wait, `$99C4` and `$50B2` follow the draw.
      this.sim.runAfterVblWait();
      this.poll({ ...input, leftButton: input.leftButton || this.sawLeft, rightButton: input.rightButton || this.sawRight });
      this.sawLeft = false;
      this.sawRight = false;
      // Checkpoint after the normal cycle's input poll; this copy includes post-draw date and periodic state.
      this.checkpointRecorder?.atPass(this.checkpointSource(), "pass-end");
    } else if (modalAtStart && this.modalCheckpointUpdates % this.loop.vblPerPass === 0) {
      this.checkpointRecorder?.atPass(this.checkpointSource(), "pass-end-modal");
    }
  }

  // One simulated main-loop pass. Static Disk.1 order: `$333A` updates own tanks, ships, enemy ground, enemy air, effects
  // and the alien/meteor records, then `$1187C` queues/spawns; after it returns the caller runs `$16012`, `$6936` scans /
  // animates visible cells. `update()` then draws `$6540/$3310`, advances date at `$4D48/$4D1C`, runs `$99C4` after the
  // VBL wait, and polls `$50B2`. `ObjectLayer.update()` and `Sim.pass()` model `$333A`; cell animation follows them.
  private loopPass(): void {
    if (this.objects) {
      this.objects.paused = this.sim.paused;
      this.objects.update();
    }
    this.sim.pass();
    // `$157D4` calls `$6936` after `$333A` has updated objects and the spawner, but before `$6540` draws the map.
    this.animateCells();
    // `$156A9` bit 3 is reset once per `$333A` pass and set during object-list / `$6936` scanning. Capture its gate after
    // moving-object, special-sprite and animated-cell work; retain it through redraws until the next normal pass.
    this.objects?.preparePassGate(this.scrollX, this.scrollY);
    // `$142A0` is the transient count consumed by `$4860` after `$333A` inserts visible draw entries.
    if (this.objects) this.world.state.setWord(0x142a0, this.objects.passDrawCount);
  }

  // Normal-loop keyboard/mouse/arrow poll ($50B2, $15B4A, $15A28), once per pass. The modal build-menu path polls its
  // mouse input once per video update. A held arrow scrolls at every normal poll, the first one immediately (observed: no
  // initial delay, no acceleration).
  private poll(input: Input): void {
    // The click that selected a Disk.4 slot (or scenario) can still be down on the first map frame.
    // Consume held mouse buttons through release so a menu click cannot become a map order.
    if (this.suppressButtonsUntilRelease) {
      if (!input.leftButton && !input.rightButton) this.suppressButtonsUntilRelease = false;
      else input = { ...input, leftButton: false, rightButton: false };
    }
    const step = input.rightButton ? 6 : 1;
    for (const key of input.keys?.splice(0) ?? []) this.key(key, input);
    const used = this.controls.update(input);
    // $159CE: a click on the second warning light swaps the view with the stored bookmark.
    if (!used && input.leftButton && !this.lightWasDown && Alerts.hitsBookmark(input.pointerX, input.pointerY)) {
      const target = this.sim.alerts.swapView(this.scrollX, this.scrollY);
      this.scrollX = Math.max(0, Math.min(MAX_SCROLL_X, target.x));
      this.scrollY = Math.max(0, Math.min(MAX_SCROLL_Y, target.y));
    }
    this.lightWasDown = input.leftButton;
    // $15F44: a right click in select mode on something that is not a scroll arrow picks a tank or a ship; while paused
    // it does nothing ($15F64-$15F82 skip $3EDC).
    if (!used && input.rightButton && !this.rightWasDown && !this.sim.paused && this.controls.mode === "select" && !this.onArrow(input.pointerX, input.pointerY)) {
      this.onPick(input.pointerX, input.pointerY);
    }
    this.rightWasDown = input.rightButton;
    if (!used && (input.leftButton || input.rightButton)) {
      const arrow = this.arrowAt(input.pointerX, input.pointerY);
      if (arrow) this.scroll(arrow.dx, arrow.dy, step);
    }
  }

  // Animated cells (flag bit 10) cycle through fixed id loops: 1-3 and the building loops 6-9, 10-13.
  private animateCells(): void {
    for (let vy = 0; vy < VIEW_CELLS; vy++) {
      for (let vx = 0; vx < VIEW_CELLS; vx++) {
        const at = (this.scrollY + vy) * MAP_WIDTH + this.scrollX + vx;
        const cell = this.cells[at];
        if (!(cell & ANIMATED_FLAG)) continue;
        let id = cell & TILE_ID_MASK;
        if (id >= 1 && id <= 3) {
          id = id === 3 ? 1 : id + 1;
        } else if (id >= 6 && id <= 13) {
          if (this.state.byte(A_POWER_LEVEL) >= 4) continue; // $69BA: building animation stops on a power shortage
          id++;
          if (id === 10 || id > 13) id -= 4;
        } else {
          continue;
        }
        this.cells[at] = (cell & ~TILE_ID_MASK) | id;
      }
    }
  }

  private drawPass(): void {
    this.activeScreenBuffer = 1 - this.activeScreenBuffer;
    const target = this.screenBuffers[this.activeScreenBuffer];
    this.screen.pixels.set(target);
    this.screen.pixels.set(restoreMapBackground(this.initialPicture, this.screen.pixels));
    this.restoreOverlayAreas();
    this.drawTiles();
    this.drawLights();
    this.drawTopBar(true);
    this.controls.draw(this.screen);
    this.messages.draw(this.screen);
    target.set(this.screen.pixels);
  }

  /** Initial/restored presentation: draw without advancing the original two-buffer loop (and without a date tick). */
  private drawInitialFrame(): void {
    const target = this.screenBuffers[this.activeScreenBuffer];
    this.screen.pixels.set(target);
    this.screen.pixels.set(restoreMapBackground(this.initialPicture, this.screen.pixels));
    this.restoreOverlayAreas();
    this.drawTiles();
    this.drawLights();
    this.drawTopBar(false);
    this.controls.draw(this.screen);
    this.messages.draw(this.screen);
    // This is a presentation-only preview. `$2B1A` leaves both original bitmaps as copies of the pristine picture;
    // the first scheduled pass must draw into a pristine buffer, not inherit this preview's untouched pixels.
  }

  /**
   * Remake-side overlays (command-button flips, mode frame, side preview, message line and log) are redrawn from state on
   * every pass, but `$16012` never touches the areas they live in, so the persistent bitmap would keep what an earlier pass
   * (or the build menu) put there; the button flip is an XOR (`$57D6`) and would blink every second pass. The original
   * keeps these areas correct with event-driven edits instead: flip on press and flip back on release in both bitmaps
   * (`$5756`/`$57FA`), message and log erase from pristine strips in both bitmaps (`$558A`, `$5C9A`, game-text.md). Resetting
   * them to the pristine picture before the overlays are drawn gives the same visible result. Not restored: row 88, the
   * top bar right of x 255 and the other `$16012`-untouched pixels, which keep their per-bitmap history.
   */
  private restoreOverlayAreas(): void {
    const initial = this.initialPicture;
    const pixels = this.screen.pixels;
    // Message line and log panel, rows 160..199, full width.
    pixels.set(initial.subarray(OVERLAY_MESSAGE_FIRST_ROW * SCREEN_WIDTH), OVERLAY_MESSAGE_FIRST_ROW * SCREEN_WIDTH);
    // Command-button columns and the side preview (bottom row 52, up to 30 rows): x 272..319, rows 22..159.
    for (let y = OVERLAY_PANEL_FIRST_ROW; y < OVERLAY_MESSAGE_FIRST_ROW; y++) {
      const at = y * SCREEN_WIDTH + OVERLAY_PANEL_X;
      pixels.set(initial.subarray(at, y * SCREEN_WIDTH + SCREEN_WIDTH), at);
    }
  }

  /**
   * Modal menus draw into `screen.pixels` only, on top of the displayed bitmap, and never write the bitmaps back. Static
   * trace: `$B680` copies the displayed bitmap to the other one (`$5A16`) and draws the panel into the back bitmap; the exit
   * `$B628` redraws the command buttons there, swaps and copies again, so afterwards both bitmaps hold the pre-menu frame.
   * Keeping the menu out of the persistent bitmaps gives that outcome and cannot leave panel pixels in rows 160..191 or in
   * the button column that no `$16012` region would ever clean.
   */
  private drawModal(): void {
    this.screen.pixels.set(this.screenBuffers[this.activeScreenBuffer]);
    this.controls.draw(this.screen);
    this.messages.draw(this.screen);
  }

  private drawTiles(): void {
    let cursor: { vx: number; vy: number; phase: { value: number } } | undefined;
    const hovered = this.hoverViewCell;
    if (hovered && hovered.vx >= 0 && hovered.vx < VIEW_CELLS && hovered.vy >= 0 && hovered.vy < VIEW_CELLS) {
      // `$6570` is reached only if `$655E` did not skip this cell as already drawn for a neighbour.
      cursor = { ...hovered, phase: { value: this.selectionBlinkBit } };
    }
    // With an object layer the whole window is drawn by `ObjectLayer.drawMap` ($6540 + $3310): tiles in painter order, the
    // globally sorted draw list through one cursor, neighbour redraws and the pins last.
    if (this.objects) {
      this.objects.drawMap(this.screen, this.scrollX, this.scrollY, cursor);
      if (cursor) this.selectionBlinkBit = cursor.phase.value;
      return;
    }
    // Painter order: diagonals by vx + vy, then vx ascending.
    for (let s = 0; s <= 2 * (VIEW_CELLS - 1); s++) {
      for (let vx = Math.max(0, s - (VIEW_CELLS - 1)); vx <= Math.min(VIEW_CELLS - 1, s); vx++) {
        const vy = s - vx;
        const cell = this.cells[(this.scrollY + vy) * MAP_WIDTH + this.scrollX + vx];
        let tile = this.tiles[(cell & TILE_ID_MASK) - 1]; // ids are 1-based
        if (cursor && cursor.vx === vx && cursor.vy === vy) {
          const cursorTile = cursor.phase.value === 0;
          cursor.phase.value ^= 1;
          if (cursorTile) tile = this.tiles[58]; // descriptor index 58 is the cursor tile
        }
        if (tile) this.drawTile(tile, anchorX(vx, vy), anchorY(vx, vy));
      }
    }
    if (cursor) this.selectionBlinkBit = cursor.phase.value;
  }

  // $5D30: the four warning lights (power, event bookmark, food, air) blink while their flag is set.
  private drawLights(): void {
    for (let k = 0; k < 4; k++) {
      if (!this.sim.alerts.visible(k)) continue;
      const icon = this.lightIcons[k];
      for (let row = 0; row < LIGHT_SIZE; row++) {
        for (let col = 0; col < LIGHT_SIZE; col++) this.screen.pixels[(LIGHT_Y + row) * SCREEN_WIDTH + LIGHT_X[k] + col] = icon[row * LIGHT_SIZE + col];
      }
    }
  }

  // Top bar, redrawn on each scheduled map pass: money, date, and quality of life (notes/formats/game-text.md, section 8). Original
  // order `$4D48` (money), `$4D1C` (calls `$564A`, the queued day tick, FIRST and then draws the date string), `$4D96`:
  // the money shown is the pre-tick value, the date of the pass whose tick fires is already the new one.
  // `tickDate` is false for the initial/restored presentation frame, which must not advance the date.
  private drawTopBar(tickDate: boolean): void {
    const disk = this.disk;
    const y = 2;
    const money = patchNumber(readTemplate(disk, TEMPLATES.money), this.state.displayMoney(), 0, 7);
    drawGameText(disk, this.screen, money, 110, y, COLOR.highlight);
    if (tickDate) this.sim.advanceQueuedDay();
    drawGameText(disk, this.screen, Array.from(this.state.dateText(), (c) => c.charCodeAt(0)), 8, y, COLOR.highlight);
    const quality = this.state.word(A.qualityOfLife + 2);
    if (quality >= 90 && (this.frame & 32) !== 0) {
      drawGameText(disk, this.screen, readTemplate(disk, TEMPLATES.title), 182, y, COLOR.highlight);
    }
    const label = patchNumber(readTemplate(disk, TEMPLATES.qualityOfLife), quality, 4, 3);
    drawGameText(disk, this.screen, label, 224, y, COLOR.highlight);
  }

  // Images are stored bottom row first, 5 colour planes then a mask plane, 32 pixels wide.
  private drawTile(tile: Tile, x: number, bottomY: number): void {
    const planeBytes = tile.rows * 4;
    for (let row = 0; row < tile.rows; row++) {
      const y = bottomY - 1 - row;
      if (y < 0) continue;
      for (let px = 0; px < TILE_WIDTH; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= CLIP_RIGHT) continue;
        const at = row * 4 + (px >> 3);
        const bit = 7 - (px & 7);
        if (((tile.planes[5 * planeBytes + at] >> bit) & 1) === 0) continue;
        let index = 0;
        for (let plane = 0; plane < 5; plane++) {
          index |= ((tile.planes[plane * planeBytes + at] >> bit) & 1) << plane;
        }
        this.screen.pixels[y * SCREEN_WIDTH + sx] = index;
      }
    }
  }
}
