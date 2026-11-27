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
import { isKeyUpToken, type Input } from "./intro.js";
import type { GameStrings } from "../data/gamestrings.js";
import { readFlagTable, readInventionText, readLightIcons, readWeights } from "../data/gameimage.js";
import { Builder } from "./build.js";
import { Controls, MODE_ICON } from "./controls.js";
import { mapPointerPoint, type PointerPoint } from "./pointer-input.js";
import { fillLogPanel, LINE_BAND, LINE_ERASE_BAND, logPanelPattern, Messages, type PostedAs } from "./messages.js";
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
import { Sim, type DestroyedUnit, type SimOptions } from "./sim.js";
import { eclipseTileView } from "./eclipse-tiles.js";
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
// The side panel's columns: x 272..319 (48 pixels). Its bottom row is the mode icon / building preview row (52).
const OVERLAY_PANEL_WIDTH = 48;
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
  /** An F1-F6 key taken by the completed pass's poll (`$15B4A`). The callback runs inside the poll: a refusal it posts is drawn in that pass. */
  onWindowKey?: (key: string) => void;
  sfx?: (id: number, volume?: number) => void;
  sprites?: SpriteSet;
  /** Video updates per main-loop pass; default `DEFAULT_VBL_PER_PASS` (4, measured baseline). */
  vblPerPass?: number;
  /** Optional deterministic Sim inputs for trace replay and tests. */
  simulation?: { rng?: SimOptions["rng"]; hardware?: SimOptions["hardware"] };
  /**
   * The command-button column already shows the `$5DDA` images (a build-menu exit happened in the bitmap this scene replaces).
   * Set by `Game` for scenes built by a disk-menu route, so the first frame of this scene already shows them. Static trace:
   * building.md "Right panel, part 2" (the disk menu restores the pre-menu bitmap on exit).
   */
  commandButtonImagesFromTable?: boolean;
  /**
   * A fresh Disk.2 scenario: its new-game state initialization runs once the graph is built (never for a restored graph).
   * The boot-exit apparition is not part of it; `Game` applies it when the game proper is entered (`Sim.leaveBootMenu`).
   */
  freshScenario?: boolean;
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

/** F1-F6, the window keys dispatched by the original's `$15B4A` (`$50`-`$55`). */
function isWindowKey(key: string): boolean {
  return /^F[1-6]$/.test(key);
}

export class MapScene {
  readonly screen = new Screen();
  /** Restored static background used by local-data checks and diagnostics. */
  readonly background: Uint8Array;
  private readonly initialPicture: Uint8Array;
  // The log panel's fill pattern, sampled from the picture at setup (`$4F92`); used once the panel has been cleared.
  private readonly logPattern: Uint8Array;
  private readonly screenBuffers: [Uint8Array, Uint8Array];
  private activeScreenBuffer = 0;
  // The bottom row (row 52, x 272..319) as the original's bitmaps hold it. Only `$6B10` writes it (masked, opaque tile pixels), and
  // `$6ACE` and `$16012` do not restore it, so it keeps the pixels of earlier mode tiles and building previews (map-rendering.md
  // section 9). Set from the picture at setup and read back from the presented frame after each panel draw (`keepPanelBottomRow`).
  private panelBottomRow: Uint8Array = new Uint8Array(OVERLAY_PANEL_WIDTH);
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
  // Bit 5 of `$1581`, the QoL title flag. `$4D96` flips it once per main-loop pass (the only caller is `jsr $4D96` at `$157F2`,
  // and the only operation on bit 5 is the `bchg #5,$1581` at `$4DCA`). The image default `$1581 = $04` clears it.
  private qolTitleFlag = false;
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
  // `$156A9` bit 0, the press latch of the scroll arrows (`$1596A`): a left press on an arrow sets it, it stays set while the
  // left button is held (the original repeats the press every pass), and a poll with the left button up clears it (`$50BE`).
  private scrollLatch = false;
  private leftWasDown = false;
  private suppressButtonsUntilRelease = false;
  private clicksLeft = 0; // button clicks still to play for a finished ship
  private clickWait = 0;
  private onPick: (px: number, py: number) => void = () => {};
  private onWindowKey: (key: string) => void = () => {};
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

  // The tile list the object layer, controls and build menu read. It is this scene's own array: `syncTileView` rewrites it
  // in place from the unchanged `baseTiles` while the sim's descriptor exchange changes (eclipse-tiles.ts), so each consumer
  // that holds the array sees the same view.
  private readonly tiles: Tile[];
  private readonly baseTiles: readonly Tile[];
  private tilesExchanged = false;

  constructor(
    private readonly disk: Uint8Array,
    tiles: Tile[],
    world: World,
    strings: GameStrings,
    options: MapSceneOptions = {},
    restored?: RestoredParts,
  ) {
    if (restored && restored.brand !== FROM_PREPARED) throw new Error("MapScene: use MapScene.fromPrepared for a restored scene");
    this.baseTiles = tiles;
    this.tiles = tiles.slice();
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
      ? new ObjectLayer(options.sprites, this.tiles, this.cells, (t, x, y) => this.drawTile(t, x, y), () => world.state.byte(A.techLevel), unitHooks, world.cellFlags, restored?.units)
      : null;
    const builder = new Builder(world, readFlagTable(disk), readWeights(disk), (n) => this.say(n));
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
      yardExit: (x, y) => (this.objects ? this.objects.units.yardExit(x, y) : { x, y }),
      spawnUnit: (x, y, advanced) => (this.objects ? this.objects.units.spawnAt(x, y, advanced) !== null : true),
      spawnEnemy: (spawn) => this.enemies?.spawn(spawn) ?? true,
      defectUnit: () => (this.enemies ? this.enemies.defect() : null),
      repairUnits: (amount) => this.enemies?.repair(amount),
      // A ship's own destruction blast ($4732 -> $1237C, lift as height, high volume): the same cell blast as combat.
      blast: (x, y, lift, high) => this.blastCell(x, y, lift, high),
    };
    const enemyHooks: EnemyHooks = {
      explode: (x, y, lift, high) => this.blastCell(x, y, lift, high),
      sound: (id) => this.playSfx(id),
      buildPad: (x, y) => builder.placeLaunchpad(x, y),
      // The descriptor stores rows - 1 (scenario.ts keeps rows = stored + 1); the kamikaze subtracts 10 from the stored value.
      buildingHeight: (tile) => (tiles[tile - 1]?.rows ?? 1) - 1,
    };
    if (restored) {
      // The prepared Sim / EnemySystem are used as they are (never rebuilt: the EnemySystem owns the adopted
      // roster and the Fleet callbacks); their callbacks are bound at the end of this constructor.
      this.sim = restored.sim;
      this.enemies = restored.enemies;
    } else {
      this.sim = new Sim(world, { interactive: true, ...options.simulation, ...simHooks });
      this.enemies = this.objects ? new EnemySystem(this.sim, this.objects.units, loadCombatTables(disk), enemyHooks) : null;
      if (options.freshScenario) {
        this.sim.initializeScenarioStart();
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
    this.controls = new Controls(disk, world, builder, strings, (n) => this.say(n), () => ({ x: this.scrollX, y: this.scrollY }), options.onDiskMenu, this.tiles);
    if (options.commandButtonImagesFromTable) this.controls.markMenuExitButtonImages();
    if (options.onScreen) this.controls.onScreen = options.onScreen;
    if (options.onSelect) this.controls.onSelect = options.onSelect;
    if (options.onPick) this.onPick = options.onPick;
    if (options.onWindowKey) this.onWindowKey = options.onWindowKey;
    this.playSfx = options.sfx ?? (() => {});
    this.controls.onMarkerButton = () => this.messages.push(this.markerMode.arm());
    this.controls.cellHook = (x, y) => {
      if (!this.objects) return false;
      const result = this.markerMode.click(this.objects, x, y);
      if (!result) return false;
      if (result.pin) this.messages.pushText(markerMessageText(strings, result.pin));
      else this.messages.push(result.message);
      // `$311E` draws its message ($71/$72, or $70 with all pins in use) at once: `$551A`/`$552C` from the poll.
      this.controls.markMessageLineChanged();
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
    this.panelBottomRow = this.initialPicture.slice(MODE_ICON.bottomRow * SCREEN_WIDTH + OVERLAY_PANEL_X, MODE_ICON.bottomRow * SCREEN_WIDTH + OVERLAY_PANEL_X + OVERLAY_PANEL_WIDTH);
    this.logPattern = logPanelPattern(this.initialPicture);
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
  private destroyFirstUnit(): DestroyedUnit | null {
    const layer = this.objects;
    if (!layer) {
      const type = this.state.long(0x14254) > 0 ? 9 : this.state.long(0x14258) > 0 ? 10 : null;
      return type === null ? null : { type, x: -1, y: -1 };
    }
    const unit = layer.units.units[0];
    if (!unit) return null;
    layer.removeUnit(unit);
    return { type: unit.type, x: unit.x, y: unit.y };
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
  // low sound). A ship's own destruction blasts through `Sim.blast` instead (`$46CC`/`$4732`: its lift and high sound).
  // "meteorImpact" has no
  // presentation: `$11676` (and `$3626` before it) never calls `$1237C` for the impact centre; the blasts come only
  // from the bombed building cells, through "explosion".
  private simEffect(kind: string, x: number, y: number): void {
    if (kind === "explosion") this.blastCell(x, y, 0, false);
    else if (kind === "launch") this.clicksLeft = LAUNCH_CLICKS; // the ship is complete ($4128): four clicks, not the launch sound
    // "focus" ($11432): Sim.alerts stores the view bookmark and lights the second warning light.
  }

  // Shows a string-table message on the message line / log. A line message said by the input poll (a placement or demolition
  // refusal, a building-select text such as the scaffold, mine or power texts) is drawn at once by the original's `$551A`
  // (game-text.md section 4), so the poll's presentation takes the flag below. Pass-time and window-stage messages do not set it.
  say(index: number): PostedAs {
    const posted = this.messages.post(index);
    if (this.polling) {
      if (posted === "line") this.controls.markMessageLineChanged();
      else if (posted === "log") this.pollLogChanged = true;
    } else if (posted === "line" && this.inPassBody) {
      // A pass-body `$551A` sets 200 at the draw and the VBL decrement comes after it: the same hold as a spliced pass-time line.
      this.messages.holdLineTick();
    } else if (posted !== "none" && this.inPostWait) {
      // `$99C4` (the arson event's `$7372` refusal, `$58`) is drawn at once: update() presents the band after `runAfterVblWait`.
      this.postWaitChanged = true;
    }
    return posted;
  }

  // True while `poll()` runs: the input actions of the completed pass (`$158CA` / `$15B4A` after the pass draw).
  private polling = false;
  // Set by `say` when a poll message went into the log panel ($5A8C draws it at once). Consumed by update() after the poll.
  private pollLogChanged = false;
  // The original's one key cell `$161A0`: the last entry of the keyboard batch since the last poll (a key name, or a release
  // token from `keyUpToken`), null when empty. See foldKeys().
  private keyCell: string | null = null;
  // True while `loopPass()` runs (the pass body: `$333A`, its `$551A` lines are drawn by that pass's draw).
  private inPassBody = false;
  // True while `runAfterVblWait()` runs (`$99C4`), and set when a message posted there must be presented in that update.
  private inPostWait = false;
  private postWaitChanged = false;

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
    // `$31CC` draws its message at once (`$551A` in the poll), so the line is shown in this frame (presentMessageLine).
    if (this.objects && (key === "d" || key === "D")) {
      this.objects.clearMarkers();
      this.messages.push(0xf2);
      this.controls.markMessageLineChanged();
    }
    // Keys 1-8 (top row: raw $01-$08, `$15C3C`-`$15C50`) drop or lift a marker pin on the cell under the pointer (messages $71 / $72).
    // A keypad digit (intro.ts `keypadToken`) is not a pin key. `$318C` draws the line at once (`$552C`).
    if (this.objects && /^[1-8]$/.test(key)) {
      const cell = this.controls.pickCell(input.pointerX, input.pointerY);
      if (cell) {
        this.messages.push(this.objects.toggleMarker(Number(key), cell.x, cell.y) === "placed" ? 0x71 : 0x72);
        this.controls.markMessageLineChanged();
      }
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
    // A change made before this update (the in-game EXIT's `returnToSelectMode`) is painted by this update's own pass draw.
    this.controls.takeModeIconChanged();
    this.controls.takeMessageLineChanged();
    this.controls.takeBuildPreviewCleared();
    this.foldKeys(input);
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
      this.controls.update({ ...input, keys: [] });
      this.sawLeft = false;
      this.sawRight = false;
      if (!this.controls.menuVisible) this.loop.resumeWithImmediatePass();
      // The exit's prompt line is posted in this update and drawn in this update (presentMessageLine, below). The remake ticks the
      // line timer in messages.update() of this same update, but a poll-posted line is first ticked on the next update (the draw
      // comes before its first tick). The hold makes the exit's line match that: 200 frames, first tick on the next update.
      if (!this.controls.menuVisible && this.controls.peekMessageLineChanged()) this.messages.holdLineTick();
      // Modal callbacks are diagnostic samples only. Do not advance MainLoop's simulation phase or pass count.
      this.modalCheckpointUpdates++;
    } else if (passBoundary) {
      this.loopPass();
      completed = true;
    }
    // A pass-time line is posted before its pass's draw (`$551A` sets 200 at the draw, and the VBL decrement comes after it), so
    // the update that splices it skips its one tick (Messages.holdLineTick). Log messages and other lines are unchanged.
    if (this.spliceSimMessages().line) this.messages.holdLineTick();
    this.playClicks();
    const lineExpired = this.messages.update();
    // Pointer selection is sampled every browser update; map selection highlighting is painted only on a completed pass.
    const pointedCell = this.controls.menuVisible ? null : this.controls.pickCell(input.pointerX, input.pointerY);
    this.hoverViewCell = pointedCell ? { vx: pointedCell.x - this.scrollX, vy: pointedCell.y - this.scrollY } : null;
    if (completed) {
      this.drawPass();
    } else if (this.controls.menuVisible) {
      this.drawModal();
    } else if (modalAtStart) {
      // Menu exit (`$B628`): the pre-menu frame is shown again at once; the next update runs the queued pass. The exit
      // redraws the command buttons from the `$5DDA` images in the displayed bitmap before it returns (`$B638`).
      this.screen.pixels.set(this.screenBuffers[this.activeScreenBuffer]);
      if (this.controls.commandButtonImagesFromTable) this.controls.drawCommandButtonImages(this.screen);
      // The exit's own mode change (build commit, `$15EF0`) is drawn with the restored frame, not on the next pass. The commit's
      // prompt line (`$551A`, string 0) is drawn at once too, so the message band is presented here as well.
      if (this.controls.takeModeIconChanged()) this.presentControlPanel();
      if (this.controls.takeMessageLineChanged()) this.presentMessageLine();
    }
    // The line's expiry is in this update's VBL (`$2CAA` -> `$558A`), before any message of this update is drawn; a pass's draw
    // already leaves the line out. Done after the frame is drawn so a non-pass update shows it (presentLineErase).
    if (lineExpired) this.presentLineErase();
    if (immediatePass) {
      // The original first waits for VBL after `$333A`/draw/date. Count that VBL only after the immediate pass has rendered.
      this.sim.countFrame(false);
      this.loop.vbl(true);
    }
    if (completed) {
      // The date tick `$564A` ran inside `drawTopBar` (`$4D1C`); the VBL wait, `$99C4` and `$50B2` follow the draw.
      this.inPostWait = true;
      try {
        this.sim.runAfterVblWait();
      } finally {
        this.inPostWait = false;
      }
      // `$99C4` runs after the VBL wait and before `$50B2`. Its messages go through `$551A` / `$5A8C`, which draw at once and set the
      // line's 200 frames at that point, after this update's tick. They are therefore spliced here, without a hold (the tick already
      // ran this update), and the band is presented in this update rather than in the next completed pass (presentMessageBand).
      const spliced = this.spliceSimMessages().count > 0;
      if (spliced || this.postWaitChanged) {
        this.postWaitChanged = false;
        this.presentMessageBand();
      }
      this.polling = true;
      try {
        this.poll({ ...input, leftButton: input.leftButton || this.sawLeft, rightButton: input.rightButton || this.sawRight });
      } finally {
        this.polling = false;
      }
      this.sawLeft = false;
      this.sawRight = false;
      // The poll runs after this pass's draw: a mode change it made (right click, demolish, marker, money refusal) is drawn now.
      if (this.controls.takeModeIconChanged()) this.presentControlPanel();
      // A clearing refusal ($6D10 -> $6ACE -> $6D2C) removes the building preview in this frame (presentBuildPreviewCleared).
      if (this.controls.takeBuildPreviewCleared()) this.presentBuildPreviewCleared();
      // A line message the poll posted (marker, pin, key D, a placement or demolition refusal, a building-select text): `$551A` draws
      // it at once (presentMessageLine).
      // A log entry the poll posted ($5A8C, e.g. the shipyard's "no command centre" text) is drawn at once too: the band is repainted
      // from the picture with the line and every log entry (presentMessageBand), which also shows a line posted in the same poll.
      const lineChanged = this.controls.takeMessageLineChanged();
      if (this.pollLogChanged) {
        this.pollLogChanged = false;
        this.presentMessageBand();
      } else if (lineChanged) this.presentMessageLine();
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
    this.inPassBody = true;
    try {
      this.passBody();
    } finally {
      this.inPassBody = false;
    }
  }

  private passBody(): void {
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

  /** The map's press latch `$156A9` bit 0 (see scrollLatch). Window screens read it when they open (ScreenContext.pressLatch). */
  get pressLatch(): boolean {
    return this.scrollLatch;
  }

  /**
   * Updates the press latch from this frame's left button: a left press on a scroll arrow sets it ($1596A), a poll with the
   * left button up clears it ($50BE). Idempotent within a frame. Game calls it before a key opens a window, because the original
   * runs the key dispatcher ($15B4A) after the poll of the same pass. poll() calls it itself before taking a window key.
   */
  observeButtons(input: Input): void {
    if (!input.leftButton) this.scrollLatch = false;
    else if (!this.leftWasDown && this.arrowAt(input.pointerX, input.pointerY)) this.scrollLatch = true;
    this.leftWasDown = input.leftButton;
  }

  // The keyboard handler (`$2BC2`) stores every decoded byte in `$161A0`, releases included, and each store overwrites the last, so only
  // the last entry of a batch can be dispatched. `$15B4A` reads the cell once per pass and clears it. This update's batch is folded
  // into the cell here, so the modal build menu (which never reads the cell: notes/formats/building.md, re-check 2026-11-12) keeps a
  // key pressed in it until a later entry overwrites it, and the first completed pass after the menu closes dispatches it.
  private foldKeys(input: Input): void {
    for (const entry of input.keys?.splice(0) ?? []) this.keyCell = entry;
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
    this.observeButtons(input);
    // `$15B4A` reads the key cell (foldKeys) once per pass and clears it. A window key (F1-F6) is dispatched after the press of the
    // same poll, so it is not taken on arrival; the cell holds it until a completed pass polls. A release entry dispatches nothing.
    let windowKey: string | undefined;
    const entry = this.keyCell;
    this.keyCell = null;
    if (entry !== null && !isKeyUpToken(entry)) {
      if (!isWindowKey(entry)) this.key(entry, input);
      else windowKey = entry;
    }
    // `$15F44`: a right press edge with the left button up is an event only on a new press. Its arrow test runs before the
    // build-mode exit (`$15EF0`), so an arrow under the pointer scrolls by 6 and keeps the mode. It sets no latch and never repeats.
    const rightArrow = !input.leftButton && input.rightButton && !this.rightWasDown ? this.arrowAt(input.pointerX, input.pointerY) : undefined;
    const used = this.controls.update(input, rightArrow !== undefined);
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
    if (!used && rightArrow) {
      this.scroll(rightArrow.dx, rightArrow.dy, 6);
    } else if (!used && input.leftButton && this.scrollLatch) {
      // `$158CA` -> `$15940` -> `$15A28` (step 1): a left press event on an arrow. The event is the press edge that set the
      // latch (`$1596A`) or a repeat while the latch holds, so a drag onto an arrow from off it does nothing.
      const arrow = this.arrowAt(input.pointerX, input.pointerY);
      if (arrow) this.scroll(arrow.dx, arrow.dy, 1);
    }
    if (windowKey !== undefined) this.onWindowKey?.(windowKey);
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

  /**
   * Descriptor exchange view (`$11024`): follows `Sim.tileExchange`, the parity of the traced calls. It is not the eclipse flag, so a
   * game over during an eclipse keeps the exchange after the flag is cleared by a new game. Call before anything draws tiles.
   */
  private syncTileView(): void {
    const exchanged = this.sim.tileExchange;
    if (exchanged === this.tilesExchanged) return;
    this.tiles.splice(0, this.tiles.length, ...eclipseTileView(this.baseTiles, exchanged));
    this.tilesExchanged = exchanged;
  }

  private drawPass(): void {
    this.syncTileView();
    this.activeScreenBuffer = 1 - this.activeScreenBuffer;
    const target = this.screenBuffers[this.activeScreenBuffer];
    this.screen.pixels.set(target);
    this.screen.pixels.set(restoreMapBackground(this.initialPicture, this.screen.pixels));
    this.restoreOverlayAreas();
    this.drawTiles();
    this.drawLights();
    this.drawTopBar(true);
    this.controls.draw(this.screen);
    this.keepPanelBottomRow();
    this.messages.draw(this.screen);
    target.set(this.screen.pixels);
  }

  /** Initial/restored presentation: draw without advancing the original two-buffer loop (and without a date tick). */
  private drawInitialFrame(): void {
    this.syncTileView();
    const target = this.screenBuffers[this.activeScreenBuffer];
    this.screen.pixels.set(target);
    this.screen.pixels.set(restoreMapBackground(this.initialPicture, this.screen.pixels));
    this.restoreOverlayAreas();
    this.drawTiles();
    this.drawLights();
    this.drawTopBar(false);
    this.controls.draw(this.screen);
    this.keepPanelBottomRow();
    this.messages.draw(this.screen);
    // This is a presentation-only preview. `$2B1A` leaves both original bitmaps as copies of the pristine picture;
    // the first scheduled pass must draw into a pristine buffer, not inherit this preview's untouched pixels.
  }

  /**
   * Presents the scene's state as it is now, without a pass. The constructor has drawn the scenario's default state; a remake load
   * then replaces the state (`restoreSession`), and a saved loop carries no pending immediate pass, so the disk-menu exit would show
   * that default picture until the first pass. This is the presentation the restored-graph constructor draws (`MapScene.fromPrepared`), with
   * the same gate refresh. Presentation only: no tick, pass, RNG draw or write to the screen buffers, and the descriptor view
   * follows the restored parity (`syncTileView`). See notes/HANDOFF-2026-11-13-load-presentation.md.
   */
  presentRestoredState(): void {
    this.objects?.preparePassGate(this.scrollX, this.scrollY);
    this.drawInitialFrame();
  }

  /**
   * Remake-side overlays (command-button flips, mode frame, side preview, message line and log) are redrawn from state on
   * every pass, but `$16012` never touches the areas they live in, so the persistent bitmap would keep what an earlier pass
   * (or the build menu) put there; the button flip is an XOR (`$57D6`) and would blink every second pass. The original
   * keeps these areas correct with event-driven edits instead: flip on press and flip back on release in both bitmaps
   * (`$5756`/`$57FA`), message and log erase from pristine strips in both bitmaps (`$558A`, `$5C9A`, game-text.md). Resetting
   * them to the pristine picture before the overlays are drawn gives the same visible result, except for the log panel after
   * a clear: `$5C9A` paints its pattern fill there, which the picture does not contain (messages.ts `fillLogPanel`). Not restored: row 88, the
   * top bar right of x 255 and the other `$16012`-untouched pixels, which keep their per-bitmap history.
   */
  private restoreOverlayAreas(): void {
    this.restoreMessageBand();
    this.restorePanelArea();
  }

  // The message line and log panel band, rows 160..199, full width.
  private restoreMessageBand(): void {
    this.screen.pixels.set(this.initialPicture.subarray(OVERLAY_MESSAGE_FIRST_ROW * SCREEN_WIDTH), OVERLAY_MESSAGE_FIRST_ROW * SCREEN_WIDTH);
    // A log clear ($5C9A) replaces the panel's picture texture with the 8 x 8 pattern fill (rows 171..194, x 8..311).
    if (this.messages.panelCleared) fillLogPanel(this.screen, this.logPattern);
  }

  /**
   * Moves the simulation's queued messages (`Sim.messages`) into `Messages`, in posting order, with their sound. Returns the count
   * and whether a line message set the line (its 200 frames are set here, see `Messages.push`).
   */
  private spliceSimMessages(): { count: number; line: boolean } {
    let line = false;
    const queued = this.sim.messages.splice(0);
    for (const index of queued) {
      if (this.messages.push(index)) line = true;
      if (ALERT_MESSAGES.has(index)) this.playSfx(SFX.ALERT);
    }
    return { count: queued.length, line };
  }

  // The panel part of `restoreOverlayAreas`: command-button columns and side preview (x 272..319, rows 22..159), then the `$5DDA` images.
  private restorePanelArea(): void {
    const initial = this.initialPicture;
    const pixels = this.screen.pixels;
    // Command-button columns and the side preview: x 272..319, rows 22..159. Row 52 (the mode icon / preview bottom row) is not
    // restored from the picture: `$6ACE` restores rows 7..51 only, so row 52 keeps what `$6B10` left there (`panelBottomRow`).
    for (let y = OVERLAY_PANEL_FIRST_ROW; y < OVERLAY_MESSAGE_FIRST_ROW; y++) {
      if (y === MODE_ICON.bottomRow) continue;
      const at = y * SCREEN_WIDTH + OVERLAY_PANEL_X;
      pixels.set(initial.subarray(at, y * SCREEN_WIDTH + SCREEN_WIDTH), at);
    }
    pixels.set(this.panelBottomRow, MODE_ICON.bottomRow * SCREEN_WIDTH + OVERLAY_PANEL_X);
    // After a build-menu exit the original's button column holds the `$5DDA` images (the edge ring differs from the picture;
    // controls.ts `MAP_BUTTON_IMAGE_TABLE`). A static scan of Disk.1 finds no other `$58A0` call with `$5DDA` (the other two
    // loads of `$5DDA` feed `$5756`, a flip), so the images stay for this scene and for a scene a disk-menu route replaces
    // (`MapSceneOptions.commandButtonImagesFromTable`, set by `Game`; static trace, not observed over time).
    if (this.controls.commandButtonImagesFromTable) this.controls.drawCommandButtonImages(this.screen);
  }

  /** Stores the presented frame's row 52 (x 272..319) as the original bitmaps hold it after a `Controls.draw` (`panelBottomRow`). */
  private keepPanelBottomRow(): void {
    const first = MODE_ICON.bottomRow * SCREEN_WIDTH + OVERLAY_PANEL_X;
    this.panelBottomRow = this.screen.pixels.slice(first, first + OVERLAY_PANEL_WIDTH);
  }

  /**
   * A mode or selection change made outside a pass's draw is shown in the same frame. The original's `$6B10` writes the mode icon into
   * both bitmaps when it runs (`$15EF0`, `$15ECA`, `$30FE`, `$6BA2`), so the next displayed frame already has it (static trace; the
   * remake had waited for the next completed pass). This repeats only the panel work a pass does (`restorePanelArea`, `Controls.draw`),
   * then copies the presented frame into the displayed bitmap so a later modal or restore keeps it. The message line, the map and
   * the pass order are not touched, and no simulation, RNG, date or loop state changes.
   */
  private presentControlPanel(): void {
    if (this.controls.menuVisible) return; // the modal path draws its own frame on the next update
    this.restorePanelArea();
    this.controls.draw(this.screen);
    this.keepPanelBottomRow();
    this.screenBuffers[this.activeScreenBuffer].set(this.screen.pixels);
  }

  /**
   * A line message posted by the input poll (the marker `$6F`, the money refusal `$25`, and a refusal or building-select text through
   * `say` while `polling`) is shown in the same frame. The original's
   * `$551A` erases the old line and draws the new one at once, into both bitmaps (game-text.md section 4). The remake draws the line
   * in `drawPass`, so it used to show on the next completed pass. This repeats only the message band (rows 160..170, the rows above
   * the log panel) from the pristine picture and draws the line. The panel, the map, the log and every timer are not touched: no
   * `messages.update()`, no pass, no RNG, no date or loop state. The poll's callers set the flag (controls.ts, and `say` while `polling`); `takeMessageLineChanged` reads it.
   */
  private presentMessageLine(): void {
    if (this.controls.menuVisible) return; // the modal path draws its own frame on the next update
    const first = LINE_BAND.y * SCREEN_WIDTH;
    this.screen.pixels.set(this.initialPicture.subarray(first, first + LINE_BAND.rows * SCREEN_WIDTH), first);
    this.messages.drawLine(this.screen);
    this.screenBuffers[this.activeScreenBuffer].set(this.screen.pixels);
  }

  /**
   * The message line's expiry (`$2CAA` calls `$558A` in the VBL that makes `$156AC` 0; game-text.md section 4). The remake had kept the
   * line's pixels until the next completed pass, 0 to 3 updates late. This repaints the traced 7 rows (159..165, full width) from the
   * pristine picture, the same source `presentMessageLine` uses, and copies the frame to the displayed bitmap. Row 159 is repainted as
   * `$558A` does; in the remake it already equals the picture in every state probed (the map window's restore and the panel restore
   * both use the picture there, and no button or tile reaches it), so only the glyph rows change on screen. Nothing else changes: no
   * timer, pass, RNG, date or loop state, and the log is not touched (its pixels go with the next pass, see Messages.update). Skipped
   * when a line is showing again in this update (a line posted after the expiry is drawn by its own presentation). While a modal menu is
   * visible only the persistent buffer is repainted: the modal's frame is its own (drawModal), but the menu's exit rebuilds the frame from
   * that buffer, so an expiry during the modal must not leave the line in it (the exit frame would show it for one update).
   */
  private presentLineErase(): void {
    if (this.messages.lineShowing) return;
    const first = LINE_ERASE_BAND.y * SCREEN_WIDTH;
    const band = this.initialPicture.subarray(first, first + LINE_ERASE_BAND.rows * SCREEN_WIDTH);
    // `$558A` writes both bitmaps. The persistent buffer is what a modal frame and the modal exit are rebuilt from, so it loses the
    // line even while a modal is visible; otherwise the exit frame shows the expired glyph rows again (measured 2026-11-13: 145 pixels).
    if (this.controls.menuVisible) {
      this.screenBuffers[this.activeScreenBuffer].set(band, first);
      return; // the modal's own frame is already drawn for this update; it is not the picture in these rows
    }
    this.screen.pixels.set(band, first);
    this.screenBuffers[this.activeScreenBuffer].set(this.screen.pixels);
  }

  /**
   * A simulation message posted by `Sim.runAfterVblWait()` (`$99C4`, after the completed pass's draw), or a log entry the input poll posts (`pollLogChanged`), is shown in the same update.
   * The band (rows 160..199: the line and the log panel) is repainted as `drawPass` leaves it, then the line and every log entry are
   * drawn, so the frame equals the next completed pass's band with the new message. No timer, pass, RNG, date or loop state changes.
   */
  private presentMessageBand(): void {
    if (this.controls.menuVisible) return; // the modal path draws its own frame on the next update
    this.restoreMessageBand();
    this.messages.draw(this.screen);
    this.screenBuffers[this.activeScreenBuffer].set(this.screen.pixels);
  }

  /**
   * A clearing refusal ($6D10 -> $6ACE -> $6D2C, static trace of Disk.1, 2026-11-13): `$6ACE` restores the saved panel background
   * (`$164AA`, saved by `$4E40` from rows 7..51 of x 256..319) into both bitmaps before the refusal message, so the building preview
   * is gone in the frame of the click. The restore covers rows 7..51 only, so the preview's bottom row (52) stays on the bitmaps
   * (`panelBottomRow`, kept by the restore and changed only by a later mode tile draw). Presentation only: the picture stands in for the saved
   * background, and no pass, RNG, money, message timer or simulation state changes. Rows 7..21 and x 256..271 are not touched.
   */
  private presentBuildPreviewCleared(): void {
    if (this.controls.menuVisible) return; // the modal path draws its own frame on the next update
    const shown = this.screenBuffers[this.activeScreenBuffer];
    this.screen.pixels.set(shown);
    this.restorePanelArea();
    this.controls.draw(this.screen);
    this.keepPanelBottomRow();
    shown.set(this.screen.pixels);
  }

  /**
   * Modal menus draw into `screen.pixels` only, on top of the displayed bitmap, and never write the bitmaps back. Static
   * trace: `$B680` copies the displayed bitmap to the other one (`$5A16`) and draws the panel into the back bitmap; the exit
   * `$B628` redraws the command buttons there, swaps and copies again, so afterwards both bitmaps hold the pre-menu frame.
   * Keeping the menu out of the persistent bitmaps gives that outcome and cannot leave panel pixels in rows 160..191 or in
   * the button column that no `$16012` region would ever clean.
   */
  private drawModal(): void {
    this.syncTileView();
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
  // `tickDate` is true only for a scheduled main-loop pass. It is false for the initial/restored presentation frame, which
  // must neither advance the date nor run `$4D96`: that routine flips `$1581` bit 5 on each pass, and the title is drawn only
  // when the bit was set before the flip (bchg's Z flag, `$4DCA`-`$4DD2`).
  private drawTopBar(tickDate: boolean): void {
    const disk = this.disk;
    const y = 2;
    const money = patchNumber(readTemplate(disk, TEMPLATES.money), this.state.displayMoney(), 0, 7);
    drawGameText(disk, this.screen, money, 110, y, COLOR.highlight);
    if (tickDate) this.sim.advanceQueuedDay();
    drawGameText(disk, this.screen, Array.from(this.state.dateText(), (c) => c.charCodeAt(0)), 8, y, COLOR.highlight);
    const quality = this.state.word(A.qualityOfLife + 2);
    if (tickDate) {
      const titleWasSet = this.qolTitleFlag;
      this.qolTitleFlag = !titleWasSet;
      if (quality >= 90 && titleWasSet) drawGameText(disk, this.screen, readTemplate(disk, TEMPLATES.title), 182, y, COLOR.highlight);
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
