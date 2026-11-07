// Scene flow of the whole program: credit roll -> language -> scenario choice -> map, with the
// disk menu (original picture and icons, `disk-menu.ts`) opened from the map; its remake-only pages (save / load / scenario / Disk.4) hang off it. Follows the original's stages
// (notes/formats/text.md, game-proper.md); the slide show and code check are left out.

import type { Music } from "../audio/music.js";
import { GameStrings } from "../data/gamestrings.js";
import { loadCombatTables } from "../data/combat.js";
import { parseDisk4Input, type Disk4Source } from "../data/disk4.js";
import { identifyDisk4Scenario, readDisk4ScenarioReference, resolveDisk4Scenario, type Disk4MetadataError, type Disk4SaveMetadata, type Disk4ScenarioSource, type ScenarioMapCandidate } from "../data/disk4-scenario.js";
import { loadMap, loadTileSet, readScenarioRecords, type ScenarioRecord } from "../data/scenario.js";
import type { Screen } from "../gfx/screen.js";
import { loadSprites } from "../data/sprites.js";
import { AnnounceScene } from "./announce.js";
import { SFX, type Sfx } from "../audio/sfx.js";
import { OfferScene } from "./offer.js";
import { createScreen, type ScreenKind, type ScreenScene } from "./screens/index.js";
import { createBuildingScreen } from "./screens/buildings.js";
import { createOrderScreen } from "./screens/orders.js";
import type { ScreenContext } from "./screens/types.js";
import { IntroScene, type Input } from "./intro.js";
import { LanguageScene, type Language } from "./language.js";
import { inspectDisk4Slot, prepareDisk4HeadlessEnemies, type Disk4HeadlessEnemyLoadError } from "./disk4-load.js";
import { applyDisk4LoadReset, applyDisk4ScenarioPointer, type Disk4ResetError } from "./disk4-reset.js";
import type { SceneRestoreError } from "./disk4-scene.js";
import { MapScene, type MapSceneOptions } from "./map.js";
import { DISK_BUTTON, DiskMenuScene, EFFECTS_STRING, NO_GAME_TO_SAVE_STRING } from "./disk-menu.js";
import { MenuScene } from "./menu.js";
import { toggleMusic } from "./music-select.js";
import { readSlot, SAVE_SLOTS, slotSummaries, slotWarning, writeSlot } from "./save.js";
import { captureSession, restoreSession, type SessionParts } from "./save-session.js";
import { SYS } from "./sim.js";
import { A, GameState } from "./state.js";
import { World, type WorldOptions } from "./world.js";

type Stage = "intro" | "language" | "scenario" | "map" | "disk" | "remake" | "save" | "load" | "announce" | "offer" | "screen" | "d4slot" | "d4scenario" | "d4error" | "sloterror";

// ---- Experimental Disk.4 continuation (not full save fidelity; see notes/formats/game-proper.md) ----------------

/** What the caller asks for. The Disk.4 bytes are the player's own file; nothing is stored in the repo. */
export interface Disk4ActivationRequest {
  /** The Disk.4 file as read: an expanded raw image or the supplied XPKF/MASH seed. Only read. */
  readonly bytes: Uint8Array;
  /** Save slot on that disk (0-9). */
  readonly slot: number;
  /**
   * Deliberate RECOVERY choice (0 .. scenario count - 1). The scenario normally comes from the save itself (saved word
   * `$135C2`, after the disk id word `$1453E` was checked against Disk.2; disk4-scenario.ts). A choice is honoured only when
   * the saved index is outside the scenario table (then `scenarioBy` is "recovery"). The same value as a valid saved index is
   * accepted as a no-op; a DIFFERENT value is refused with `scenario-conflict`, and an unsupported disk id is never recoverable.
   * Without a choice an invalid saved index is refused (`scenario-index`, with advisory map-ranked candidates), never mapped to 0.
   */
  readonly recoverScenario?: number;
  /** Label of the source file (for example its name). Echoed in the result, not interpreted. */
  readonly source?: string;
}

/** Optional deterministic inputs for fresh-start comparison harnesses; omitted during ordinary browser play. */
export interface FreshStartInputs {
  readonly world?: WorldOptions;
  readonly simulation?: MapSceneOptions["simulation"];
}

export type Disk4ActivationError =
  | { readonly stage: "not-ready"; readonly message: string }
  /**
   * The save's own disk id / scenario index (or a recovery choice) was refused before anything was loaded. For
   * `scenario-index` (the only recoverable code) `candidates` ranks the saved map against Disk.2 as ADVISORY suggestions only.
   */
  | { readonly stage: "metadata"; readonly error: Disk4MetadataError; readonly slot: number; readonly candidates?: readonly ScenarioMapCandidate[] }
  | { readonly stage: "inspect"; readonly error: Extract<Disk4HeadlessEnemyLoadError, { readonly stage: "input" | "slot" | "state" }> }
  | { readonly stage: "prepare"; readonly error: Disk4HeadlessEnemyLoadError }
  | { readonly stage: "reset"; readonly error: Disk4ResetError }
  | { readonly stage: "resources"; readonly message: string }
  | { readonly stage: "scene"; readonly error: SceneRestoreError };

/** The imported session as the Game records it (a Disk.4 continuation has no remake save). */
export interface Disk4Session {
  readonly slot: number;
  /** Save name from the Disk.4 record. */
  readonly name: string;
  readonly scenario: number;
  readonly scenarioName: string;
  /** "saved": the save's own scenario word `$135C2`; "recovery": that word was invalid and the caller chose (`recoverScenario`). */
  readonly scenarioBy: Disk4ScenarioSource;
  /** The two metadata words exactly as saved (`$1453E` disk id, `$135C2` scenario index), also after a recovery. */
  readonly savedMetadata: Disk4SaveMetadata;
  readonly diskSource: Disk4Source;
  readonly sourceLabel: string;
  /** View origin the scene started with (saved words clamped for display only). */
  readonly view: { readonly x: number; readonly y: number; readonly clamped: boolean };
}

export type Disk4ActivationResult = { readonly ok: true; readonly value: Disk4Session } | { readonly ok: false; readonly error: Disk4ActivationError };

const WRAP_COLUMNS = 30;

/** `$80C8` stores `$7A120` in the money long `$135BA` when it starts the tutorial. */
const TUTORIAL_MONEY = 0x7a120;
/** Titles of the remake slot pages (the originals work on floppies: modes 1 and 2 of `$87DC`). */
const SAVE_TITLE = "SAVE GAME - REMAKE SLOTS";
const LOAD_TITLE = "LOAD GAME - REMAKE SLOTS";

function wrapText(text: string, width = WRAP_COLUMNS): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length > 0 ? `${line} ${word}` : word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

const SLOT_ERROR_LINES = 5;

/** Wraps a message for the error screen: words longer than a line are cut, more than `SLOT_ERROR_LINES` lines end in "...". */
function wrapMessage(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0).flatMap((w) => w.match(new RegExp(`.{1,${WRAP_COLUMNS}}`, "g")) ?? []);
  const lines = wrapText(words.join(" "));
  if (lines.length <= SLOT_ERROR_LINES) return lines;
  const kept = lines.slice(0, SLOT_ERROR_LINES);
  kept[SLOT_ERROR_LINES - 1] = `${kept[SLOT_ERROR_LINES - 1].slice(0, WRAP_COLUMNS - 3)}...`;
  return kept;
}

/** One-line technical description of an activation error (stage and code, then the message). */
export function describeDisk4Error(error: Disk4ActivationError): string {
  switch (error.stage) {
    case "not-ready":
    case "resources":
      return `${error.stage}: ${error.message}`;
    case "metadata":
      return `metadata: ${error.error.code}: ${error.error.message}`;
    case "reset":
      return `reset: ${error.error.code}: ${error.error.message}`;
    case "scene":
      return `scene: ${error.error.code}: ${error.error.message}`;
    case "inspect":
    case "prepare": {
      const e = error.error;
      const inner = ("error" in e ? e.error : e) as unknown as { code?: string; message?: string };
      return `${error.stage}/${e.stage}: ${inner.code ?? ""} ${inner.message ?? ""}`.trim();
    }
  }
}

/** Why a remake save or load was refused (a `SlotError` of save.ts or a `SessionError` of save-session.ts: code + message). */
export interface SaveLoadError {
  readonly code: string;
  readonly message: string;
}

/** The members of a map scene the remake save reads and replaces. */
function sessionParts(map: MapScene): SessionParts {
  return {
    world: map.world,
    sim: map.sim,
    loop: map.loop,
    units: map.objects?.units ?? null,
    enemies: map.enemies,
    markers: map.objects?.markers ?? null,
    effectPool: map.objects?.pool ?? null,
    extras: map.objects?.extra ?? null,
    scroll: map.scrollRef,
    restoredFromDisk4: map.restoredFromDisk4,
  };
}

export class Game {
  private stage: Stage = "intro";
  private readonly intro: IntroScene;
  private language: LanguageScene | null = null;
  private strings: GameStrings | null = null;
  // Remake list pages (scenario choice, remake submenu, slot lists, Disk.4, errors); the original disk menu is `diskMenu`.
  private menu: MenuScene | null = null;
  // The original disk menu (`$7E52`/`$7EF6`: picture, nine icons, shared list incl. music select); stage "disk". notes/formats/music.md.
  private diskMenu: DiskMenuScene | null = null;
  // The language-screen tune (remake only, track 0) is still playing: the original game proper starts silent, so the first map entry ends it.
  private introTune = false;
  private announce: AnnounceScene | null = null;
  private offer: OfferScene | null = null;
  private window: ScreenScene | null = null;
  private frozen: Uint8Array | null = null;
  // The open window was started by an F1-F6 key: `$15B68`-`$15BE2` return to `$15C1A`, which re-presses the pause button.
  private windowFromKey = false;
  private map: MapScene | null = null;
  private scenario = 0;
  private hasEnteredGame = false;
  private selectedLanguage: Language = 0;
  private disk4Source: { bytes: Uint8Array; label: string } | null = null;
  private disk4Session: Disk4Session | null = null;
  private disk4Slot = 0;
  /** The last refused Disk.4 activation (for app code and the error menu); cleared by a successful one. */
  lastDisk4Error: Disk4ActivationError | null = null;
  /** The last refused remake save (null after a successful one or before any). A refusal writes nothing. */
  lastSaveError: SaveLoadError | null = null;
  /** The last refused remake load (null after a successful one or before any). A refusal leaves the active session untouched. */
  lastLoadError: SaveLoadError | null = null;
  /** The failed save / load whose error screen is open (stage "sloterror"): what was tried, on which slot, and why it failed. */
  private slotError: { op: "save" | "load"; slot: number; error: SaveLoadError; actionBase: number } | null = null;
  private readonly records: ScenarioRecord[];
  pointerVisible = false;

  /** `$2FBA`: the cell-hover cursor is only used on the active map, never over another scene or a dialog. */
  get pointerUsesCellHover(): boolean {
    return this.stage === "map" && this.map?.pointerUsesCellHover === true;
  }

  /** Mouse coordinates after the active map mode's original hardware-pointer bounds are applied. */
  pointerPoint(x: number, y: number): { readonly x: number; readonly y: number } {
    return this.map ? this.map.pointerPoint(x, y) : { x, y };
  }

  constructor(
    private readonly disk1: Uint8Array,
    private readonly disk2: Uint8Array,
    private readonly music: Music | null = null,
    private readonly sfx: Sfx | null = null,
    private readonly freshStartInputs: FreshStartInputs = {},
  ) {
    this.intro = new IntroScene(disk1);
    this.records = readScenarioRecords(disk2);
  }

  get screen(): Screen {
    if (this.stage === "intro") return this.intro.screen;
    if (this.stage === "language") return this.language!.screen;
    if (this.announce) return this.announce.screen;
    if (this.stage === "disk" && this.diskMenu) return this.diskMenu.screen;
    if (this.menu) return this.menu.screen;
    return this.map!.screen;
  }

  private openMenu(stage: Stage, title: string, labels: { label: string; enabled?: boolean }[]): void {
    this.stage = stage;
    this.diskMenu = null;
    this.menu = new MenuScene(this.disk1, title, labels);
  }

  // F1-F6, trade, staffing and intelligence windows over the frozen map frame.
  private openScreen(kind: ScreenKind): void {
    const map = this.map!;
    if (this.stage !== "map" || map.sim.gameOver) return;
    this.showWindow(createScreen(kind, this.screenContext(map)));
  }

  private screenContext(map: MapScene): ScreenContext {
    const record = this.records[this.scenario];
    const sectors = (range: { first: number; last: number }): Uint8Array => this.disk2.subarray(range.first * 512, (range.last + 1) * 512);
    return { disk: this.disk1, world: map.world, sim: map.sim, strings: this.strings!, intelligence: { portraits: sectors(record.intel), text: sectors(record.text[this.selectedLanguage]) }, say: (n) => map.say(n), scroll: map.scrollRef, objects: map.objects ?? undefined, otherUnits: () => map.enemies?.overview() ?? {}, sound: (id) => this.sfx?.play(id) };
  }

  // A click on a map cell in select mode ($7140): a building window, or an immediate effect.
  private selectCell(x: number, y: number): void {
    const map = this.map!;
    if (this.stage !== "map" || map.sim.gameOver) return;
    const scene = createBuildingScreen(this.screenContext(map), x, y, {
      findTarget: (range, tx, ty) => map.enemies?.findTarget(range, tx, ty) ?? null,
      launchMissile: (from, target) => map.enemies?.launchMissile(from, target) ?? false,
    });
    if (scene) this.showWindow(scene);
  }

  // A right click on the map in select mode ($3EDC): the tank window or the ship window.
  private pickUnit(px: number, py: number): void {
    const map = this.map!;
    if (this.stage !== "map" || map.sim.gameOver) return;
    const pick = map.pickObject(px, py);
    const scene = pick ? createOrderScreen(this.screenContext(map), pick) : null;
    if (scene) this.showWindow(scene);
  }

  private showWindow(window: ScreenScene): void {
    const map = this.map!;
    this.frozen = map.screen.pixels.slice();
    this.window = window;
    this.windowFromKey = false;
    this.stage = "screen";
  }

  private sceneOptions(record: ScenarioRecord, freshStart = false): MapSceneOptions {
    return {
      onDiskMenu: () => this.openDiskMenu(), onScreen: (kind) => this.openScreen(kind), onSelect: (x, y) => this.selectCell(x, y),
      onPick: (px, py) => this.pickUnit(px, py), sfx: (id, volume) => this.sfx?.play(id, volume), sprites: loadSprites(this.disk1, this.disk2, record),
      simulation: freshStart ? this.freshStartInputs.simulation : undefined,
      scenarioStartup: freshStart ? { initialAlien: !this.hasEnteredGame } : undefined,
    };
  }

  // A fresh scene of a scenario, built off to the side: nothing of the Game changes until `enterScene`.
  private createScene(index: number, freshStart = true): MapScene {
    const record = this.records[index];
    return new MapScene(
      this.disk1,
      loadTileSet(this.disk1, this.disk2, record).tiles,
      new World(new GameState(this.disk2, record.block), loadMap(this.disk2, record), freshStart ? this.freshStartInputs.world : undefined),
      this.strings!,
      this.sceneOptions(record, freshStart),
    );
  }

  private startScenario(index: number): void {
    this.enterScene(index, this.createScene(index));
  }

  /**
   * Music is never touched by starting or loading a game: in the original the only caller of the track loader `$110A` is the
   * music-select handler `$8A42`, so a new scenario, a load and a Disk.4 slot leave the selected track (`$1580`) and the playing
   * module as they are, and the game proper starts silent until the player picks a track (notes/formats/music.md). The one
   * exception is the remake's own language-screen tune, which ends at the first map entry (the original boot stage fades its
   * module out before the game proper starts).
   */
  private enterScene(index: number, map: MapScene): void {
    this.scenario = index;
    this.map = map;
    this.disk4Session = null; // a new game or a remake load is not a Disk.4 continuation
    this.menu = null;
    this.diskMenu = null;
    this.stage = "map";
    this.hasEnteredGame = true;
    this.endIntroTune();
  }

  private endIntroTune(): void {
    if (!this.introTune) return;
    this.introTune = false;
    this.music?.fadeOut(1);
  }

  // `$8A42`: `$110A` loads and starts the module (always from the beginning, `$1580` is not compared), then `$82B8` closes the list
  // (`DiskMenuScene` already did) and the disk-menu loop continues. A row below 4 ends the intro tune like any other selection.
  private chooseTrack(track: number): void {
    this.introTune = false;
    this.music?.play(track, true);
  }

  private handleDiskMenu(input: Input): void {
    const result = this.diskMenu!.update(input);
    if (result === null) return;
    if (result.kind === "track") this.chooseTrack(result.track);
    else if (result.kind === "icon") this.diskIcon(result.index);
    else if (result.kind === "remake") this.openRemakeMenu();
    // "listClosed": rows 4-9 (`$110A` -> `$82B8`) or the remake's right click; nothing else happens, the music is untouched.
  }

  /**
   * The `$7FE4` dispatch, run on the release of the icon recorded at the press (the click was requested on the press by the scene).
   * Original handlers keep their traced behaviour; the save-disk family needs floppies, so the remake maps load / save / scenario to its
   * own pages (titled as remake pages) and leaves format as a labelled no-op. Disk.4 has no icon: it is in the remake submenu.
   */
  private diskIcon(index: number): void {
    const scene = this.diskMenu!;
    const gameOver = this.map?.sim.gameOver === true; // `$156AA` bit 3
    switch (index) {
      case DISK_BUTTON.load: // `$85FE`
        this.openMenu("load", LOAD_TITLE, this.slotLabels());
        break;
      case DISK_BUTTON.save: // `$856C`
        if (gameOver) scene.printInfo(NO_GAME_TO_SAVE_STRING, 0);
        else if (this.disk4Session !== null) this.openRemakeMenu(); // the remake save cannot hold a Disk.4 continuation: the submenu says so
        else this.openMenu("save", SAVE_TITLE, this.slotLabels());
        break;
      case DISK_BUTTON.scenario: // `$8632`
        this.openScenarioMenu();
        break;
      case DISK_BUTTON.format: // `$8314`: formats a floppy; the remake saves to browser storage
        scene.printRemakeNote("REMAKE: NO DISK TO FORMAT");
        break;
      case DISK_BUTTON.music: // `$1062`: in place, result in the second info line; without Music the "no expansion memory" branch ($197)
        scene.printInfo(0, toggleMusic(this.music));
        break;
      case DISK_BUTTON.exit: // `$802C`: refused while `$156AA` bit 3 (game over) is set
        if (!gameOver) this.closeMenu();
        break;
      case DISK_BUTTON.tutorial: // `$80C8`
        this.startTutorial();
        break;
      case DISK_BUTTON.musicSelect: // `$1006`
        scene.openMusicList(this.music !== null);
        break;
      case DISK_BUTTON.effects: // `$10BC`: toggles bit 2 of `$1581`, prints `$194` / `$195`; without a sound system there is no flag to toggle
        if (this.sfx) {
          const on = !this.sfx.enabled;
          this.sfx.setEnabled(on);
          scene.printInfo(0, on ? EFFECTS_STRING.on : EFFECTS_STRING.off);
        }
        break;
    }
  }

  /**
   * `$80C8`: scenario record 0 with `$156AA` bits 7 (tutorial) and 2 (no-unit bonus) set and money `$7A120`, then the exit handler
   * leaves for the map. The state initialisation `$866E` and the record loader `$8B02` are the same data the scenario start loads.
   */
  private startTutorial(): void {
    const scene = this.createScene(0);
    scene.sim.sysFlags |= SYS.tutorialMode | SYS.noUnitBonus;
    scene.world.state.setLong(A.money, TUTORIAL_MONEY);
    this.enterScene(0, scene);
  }

  private openScenarioMenu(): void {
    this.openMenu(
      "scenario",
      "CHOOSE A SCENARIO",
      this.records.map((r, i) => ({ label: `${i + 1}. ${r.name || "SCENARIO"}` })),
    );
  }

  /** The original disk menu: picture, nine icons, shared list. The remake's own functions are behind `openRemakeMenu`. */
  private openDiskMenu(): void {
    this.stage = "disk";
    this.menu = null;
    this.diskMenu = new DiskMenuScene(this.disk1, this.strings!, { onButtonPress: () => this.sfx?.play(SFX.CLICK) });
  }

  /**
   * REMAKE ONLY (no original counterpart; reached with the right button on the disk menu): the remake save slots, the scenario list
   * and the experimental Disk.4 continuation. The remake's localStorage save (save-session.ts) holds the remake's own session
   * only; it has no place for a Disk.4 continuation (adopted records with saved bytes), so saving is refused for one and the
   * entry stays disabled.
   */
  private openRemakeMenu(): void {
    const saveLabel = this.disk4Session ? "SAVE GAME (OFF: DISK.4 SESSION)" : "SAVE GAME";
    this.openMenu("remake", "REMAKE MENU (NOT ORIGINAL)", [{ label: saveLabel, enabled: this.disk4Session === null }, { label: "LOAD GAME" }, { label: "NEW SCENARIO" }, { label: "LOAD DISK.4 (EXPERIMENTAL)", enabled: this.disk4Source !== null && this.strings !== null }, { label: "BACK TO DISK MENU" }]);
  }

  // ---- experimental Disk.4 continuation ----------------------------------------------------------------------

  /** Hands the player's Disk.4 file to the Game so the disk menu can offer it. Only read; nothing is stored. */
  setDisk4(bytes: Uint8Array, label = "Disk.4"): void {
    this.disk4Source = { bytes, label };
  }

  /** True once a Disk.4 file was provided with `setDisk4`. */
  get hasDisk4(): boolean {
    return this.disk4Source !== null;
  }

  /** True once the language is chosen (the earliest moment `activateDisk4` can work). */
  get canActivateDisk4(): boolean {
    return this.strings !== null && this.stage !== "intro" && this.stage !== "language";
  }

  /** The active Disk.4 continuation, or null for a new game / remake load. Such a session cannot be saved. */
  get importedDisk4(): Disk4Session | null {
    return this.disk4Session;
  }

  /**
   * EXPERIMENTAL Disk.4 continuation (headless-traced state, synthetic tests; not full save fidelity). Prepares the
   * chosen slot, builds a live map scene around the SAME prepared graph (see `MapScene.fromPrepared`) and only then
   * replaces the current scene, so any failure leaves the previous scene, menu and state untouched and returns one
   * typed error (also kept in `lastDisk4Error`). No remake save is written or read; the input bytes are only read.
   *
   * Order (all of it before any resource is loaded or any scene exists): slot inspection -> Disk.2 reference (id word, record
   * count) -> the SAVED metadata (`$1453E` disk id must equal the Disk.2 header id, then `$135C2` is the scenario index; the
   * original's `$888A`-`$88AA`, static trace) -> combat tables / preparation -> the traced load reset
   * (`applyDisk4LoadReset`) on the detached graph -> scenario graphics -> scene. The saved map is NOT used to choose the
   * scenario (it is mutable); see `Disk4ActivationRequest.recoverScenario` for the only override path.
   *
   * Starts from the traced reset: no warning light, no message, no effect (the 30 effect slots are outside the saved ranges
   * and the original load clears them), `sysFlags` clear, not paused, one day queued. Not restored: the RNG state (the port's
   * default seed is used), alien/meteor entries outside the traced domain (a live one outside it refuses the load), the
   * rest of the original post-load work ($802C exit handler), and the tank/enemy/ship policies of
   * `prepareDisk4HeadlessEnemies` apply (out-of-domain crusher counter/animation bytes, odd missile modes, high lift, bad
   * reservation pointers and ship count mismatches are refused). The session runs from the first update; it can not be
   * saved in the remake.
   */
  activateDisk4(request: Disk4ActivationRequest): Disk4ActivationResult {
    const refuse = (error: Disk4ActivationError): Disk4ActivationResult => {
      this.lastDisk4Error = error;
      return { ok: false, error };
    };
    if (!this.canActivateDisk4) return refuse({ stage: "not-ready", message: "Choose a language first: the string tables and menus are needed before a save can be shown" });

    const saved = inspectDisk4Slot(request.bytes, request.slot);
    if (!saved.ok) return refuse({ stage: "inspect", error: saved.error });
    const reference = readDisk4ScenarioReference(this.disk2);
    if (!reference.ok) return refuse({ stage: "metadata", error: reference.error, slot: request.slot });
    const resolved = resolveDisk4Scenario(saved.value.disk4.areaB, reference.value, request.recoverScenario);
    if (!resolved.ok) {
      // Only an out-of-table saved index can be recovered; the map ranking is offered as advice, never applied.
      const advice = resolved.error.code === "scenario-index" ? identifyDisk4Scenario(saved.value.disk4.mapCells, this.disk2) : null;
      const candidates = advice !== null && advice.ok ? advice.value.candidates : undefined;
      return refuse({ stage: "metadata", error: resolved.error, slot: request.slot, ...(candidates ? { candidates } : {}) });
    }
    const { scenario, by: scenarioBy, saved: savedMetadata } = resolved.value;
    const count = reference.value.scenarioCount;

    let tables: ReturnType<typeof loadCombatTables>;
    try {
      tables = loadCombatTables(this.disk1);
    } catch (error) {
      return refuse({ stage: "resources", message: `combat tables: ${error instanceof Error ? error.message : String(error)}` });
    }
    // The scenario index is validated by the preparation (0 .. scenarioCount - 1). Sim options and enemy hooks stay empty
    // here: the scene binds the real callbacks once it exists.
    const prepared = prepareDisk4HeadlessEnemies(request.bytes, { slot: request.slot, scenario, scenarioCount: count }, tables);
    if (!prepared.ok) return refuse({ stage: "prepare", error: prepared.error });
    // The original load handler writes the selected header pointer into `$1453A` before it loads scenario graphics.
    const scenarioPointer = applyDisk4ScenarioPointer(prepared.value, scenario, count);
    if (!scenarioPointer.ok) return refuse({ stage: "reset", error: scenarioPointer.error });
    // The traced load reset acts on the detached graph; a later failure discards the whole graph, so nothing leaks into the current scene.
    const reset = applyDisk4LoadReset(prepared.value);
    if (!reset.ok) return refuse({ stage: "reset", error: reset.error });

    const record = this.records[scenario];
    let tiles: ReturnType<typeof loadTileSet>["tiles"];
    let options: MapSceneOptions;
    try {
      tiles = loadTileSet(this.disk1, this.disk2, record).tiles;
      options = this.sceneOptions(record);
    } catch (error) {
      return refuse({ stage: "resources", message: `scenario graphics: ${error instanceof Error ? error.message : String(error)}` });
    }
    const scene = MapScene.fromPrepared(this.disk1, tiles, prepared.value, this.strings!, options);
    if (!scene.ok) return refuse({ stage: "scene", error: scene.error });

    // Commit: nothing below can fail.
    const session: Disk4Session = {
      slot: prepared.value.slot,
      name: prepared.value.name,
      scenario,
      scenarioName: record.name,
      scenarioBy,
      savedMetadata,
      diskSource: prepared.value.source,
      sourceLabel: request.source ?? this.disk4Source?.label ?? "Disk.4",
      view: { x: scene.view.x, y: scene.view.y, clamped: scene.view.clamped },
    };
    this.scenario = scenario;
    this.map = scene.value;
    this.disk4Session = session;
    this.lastDisk4Error = null;
    this.menu = null;
    this.diskMenu = null;
    this.announce = null;
    this.offer = null;
    this.window = null;
    this.frozen = null;
    this.stage = "map";
    this.endIntroTune(); // no audio state is restored or started (see enterScene)
    return { ok: true, value: session };
  }

  // Disk menu -> slot list of the provided Disk.4.
  private openDisk4SlotMenu(): void {
    const source = this.disk4Source;
    if (!source) return this.openDiskMenu();
    const parsed = parseDisk4Input(source.bytes);
    if (!parsed.ok) {
      const error: Disk4ActivationError = { stage: "inspect", error: { stage: "input", error: parsed.error } };
      this.lastDisk4Error = error;
      return this.openDisk4ErrorMenu(error);
    }
    this.openMenu(
      "d4slot",
      "DISK.4 SLOT (EXPERIMENTAL)",
      parsed.value.image.slots.map((slot) => ({
        label: `SLOT ${slot.index + 1}  ${slot.state === "populated" ? slot.name : slot.state === "empty" ? "EMPTY" : "INVALID"}`,
        enabled: slot.state === "populated",
      })),
    );
  }

  // Recovery list for a save whose scenario word is outside the table; the percentages are the ADVISORY map ranking.
  private openDisk4ScenarioMenu(candidates: readonly ScenarioMapCandidate[]): void {
    const ratio = (index: number): string => {
      const c = candidates.find((candidate) => candidate.index === index);
      return c ? ` ${Math.round(c.ratio * 100)}%` : "";
    };
    this.openMenu("d4scenario", "SAVED SCENARIO INVALID - RECOVER", this.records.map((r, i) => ({ label: `${i + 1}. ${r.name || "SCENARIO"}${ratio(i)}` })));
  }

  private openDisk4ErrorMenu(error: Disk4ActivationError): void {
    const lines = wrapText(describeDisk4Error(error)).slice(0, 7);
    this.openMenu("d4error", "DISK.4 LOAD FAILED", [...lines.map((label) => ({ label, enabled: false })), { label: "RIGHT CLICK: BACK", enabled: false }]);
  }

  // The result of a slot / scenario choice in the menus: success is already committed, failure shows why.
  private activateFromMenu(slot: number, scenario?: number): void {
    const source = this.disk4Source;
    if (!source) return this.closeMenu();
    const result = this.activateDisk4({ bytes: source.bytes, slot, recoverScenario: scenario, source: source.label });
    if (result.ok) return;
    this.disk4Slot = slot;
    if (result.error.stage === "metadata" && result.error.error.code === "scenario-index") this.openDisk4ScenarioMenu(result.error.candidates ?? []);
    else this.openDisk4ErrorMenu(result.error);
  }

  private slotLabels(): { label: string; enabled?: boolean }[] {
    return slotSummaries().map((s, i) => ({
      label: !s ? `SLOT ${i + 1}  EMPTY` : s.status === "ok" ? `SLOT ${i + 1}  ${s.date}${slotWarning(s)}` : s.status === "unavailable" ? `SLOT ${i + 1}  STORAGE OFF` : `SLOT ${i + 1}  UNUSABLE`,
    }));
  }

  // Failed remake save / load: the map scene is untouched; this screen names the typed reason and offers retry / back.
  // The error stays in `lastSaveError` / `lastLoadError`.
  private openSlotErrorMenu(op: "save" | "load", slot: number, error: SaveLoadError): void {
    const lines = wrapMessage(error.message);
    const actionBase = 1 + lines.length;
    this.slotError = { op, slot, error, actionBase };
    this.openMenu("sloterror", `${op === "save" ? "SAVE" : "LOAD"} FAILED - SLOT ${slot + 1}`, [
      { label: `CODE: ${error.code}`, enabled: false },
      ...lines.map((label) => ({ label, enabled: false })),
      { label: `RETRY SLOT ${slot + 1}` },
      { label: "CHOOSE ANOTHER SLOT" },
      { label: "DISK MENU" },
      { label: "BACK TO GAME" },
      { label: "RIGHT CLICK: DISK MENU", enabled: false },
    ]);
  }

  private closeSlotError(): void {
    this.slotError = null;
  }

  // Remake save of the live map into a slot. Refusals (Disk.4 session, pending offer, ...) write nothing and are kept in `lastSaveError`.
  private saveToSlot(slot: number): boolean {
    this.lastSaveError = null;
    const map = this.map;
    if (!map || this.disk4Session !== null || map.restoredFromDisk4) {
      this.lastSaveError = { code: "disk4-session", message: "A Disk.4 continuation cannot be saved" };
      return false;
    }
    const captured = captureSession(sessionParts(map), this.scenario);
    if (!captured.ok) {
      this.lastSaveError = captured.error;
      return false;
    }
    const written = writeSlot(slot, captured.value);
    if (!written.ok) {
      this.lastSaveError = written.error;
      return false;
    }
    return true;
  }

  // Remake load. The target scene is built and filled off to the side; only a complete, validated restore replaces the active
  // session. Any failure returns false with `lastLoadError` set and the running scene, menu stage and Game state untouched.
  private loadFromSlot(slot: number): boolean {
    this.lastLoadError = null;
    const read = readSlot(slot);
    if (!read.ok) {
      this.lastLoadError = read.error;
      return false;
    }
    const save = read.save;
    if (save.scenario >= this.records.length) {
      this.lastLoadError = { code: "invalid", message: `Scenario ${save.scenario} does not exist (the game files have ${this.records.length})` };
      return false;
    }
    let scene: MapScene;
    try {
      scene = this.createScene(save.scenario, false);
    } catch (error) {
      this.lastLoadError = { code: "resources", message: `scenario graphics: ${error instanceof Error ? error.message : String(error)}` };
      return false;
    }
    const restored = restoreSession(save, sessionParts(scene));
    if (!restored.ok) {
      this.lastLoadError = restored.error;
      return false;
    }
    this.enterScene(save.scenario, scene);
    return true;
  }

  update(input: Input): void {
    const mapBeforeUpdate = this.map;
    const pointer = this.pointerPoint(input.pointerX, input.pointerY);
    input = { ...input, pointerX: pointer.x, pointerY: pointer.y };
    switch (this.stage) {
      case "intro":
        if (this.intro.update(input) === "clicked") {
          this.language = new LanguageScene(this.disk1, this.intro.screen);
          this.music?.play(0);
          this.introTune = true; // remake only: the original game proper starts silent
          this.stage = "language";
        }
        break;
      case "language": {
        this.pointerVisible = this.language!.pointerVisible;
        const result = this.language!.update(input);
        if (result.state === "chosen") {
          this.selectedLanguage = result.language;
          this.strings = new GameStrings(this.disk1, result.language as Language);
          this.pointerVisible = true;
          this.openScenarioMenu();
        }
        break;
      }
      case "scenario": {
        const choice = this.menu!.update(input);
        if (choice !== null && choice >= 0) this.startScenario(choice);
        else if (choice !== null && this.map) this.openDiskMenu(); // remake right click, only when a game exists to go back to
        break;
      }
      case "map": {
        const map = this.map!;
        const keys = input.keys ?? [];
        const fkey = keys.findIndex((k) => /^F[1-6]$/.test(k));
        if (fkey >= 0) {
          const name = keys.splice(fkey, 1)[0];
          this.openScreen(name.toLowerCase() as ScreenKind);
          if ((this.stage as Stage) === "screen") {
            this.windowFromKey = true;
            break;
          }
        }
        this.updateMap(map, input);
        break;
      }
      case "screen": {
        const map = this.map!;
        map.screen.pixels.set(this.frozen!);
        const result = this.window!.update(input);
        if (result === "close") {
          this.window = null;
          this.frozen = null;
          this.stage = "map";
          // `$15C1A` -> `$15C26-$15C34`: back from an F-key window while paused, the inverted pause button is drawn again
          // through `$5756`, which also requests the click. Icon-button windows return through `$15A74`, which does not.
          if (this.windowFromKey && map.sim.paused) this.sfx?.play(SFX.CLICK);
          this.windowFromKey = false;
        } else {
          this.window!.draw(map.screen);
        }
        break;
      }
      case "offer": {
        const map = this.map!;
        this.offer!.draw(map.screen);
        const answer = this.offer!.update(input);
        if (answer !== null) {
          map.sim.resolveOffer(answer);
          this.offer = null;
          this.stage = "map";
        }
        break;
      }
      case "announce": {
        if (this.announce!.update(input)) {
          const over = this.announce!.id < 2;
          this.announce = null;
          if (over) this.openScenarioMenu();
          else this.stage = "map";
        }
        break;
      }
      case "disk":
        this.handleDiskMenu(input);
        break;
      case "remake": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        // Remake pages are silent (no `$5948` call exists for them, notes/formats/sfx.md).
        if (choice === 0) {
          if (this.disk4Session === null) this.openMenu("save", SAVE_TITLE, this.slotLabels());
        } else if (choice === 1) this.openMenu("load", LOAD_TITLE, this.slotLabels());
        else if (choice === 2) this.openScenarioMenu();
        else if (choice === 3) this.openDisk4SlotMenu();
        else this.openDiskMenu(); // BACK TO DISK MENU or the right button
        break;
      }
      case "d4slot": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        if (choice < 0) this.openDiskMenu();
        else this.activateFromMenu(choice);
        break;
      }
      case "d4scenario": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        if (choice < 0) this.openDiskMenu();
        else this.activateFromMenu(this.disk4Slot, choice);
        break;
      }
      case "d4error": {
        const choice = this.menu!.update(input);
        if (choice !== null && choice < 0) this.openDiskMenu();
        break;
      }
      case "save": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        if (choice >= 0 && choice < SAVE_SLOTS) {
          if (!this.saveToSlot(choice)) return this.openSlotErrorMenu("save", choice, this.lastSaveError!);
          this.closeMenu();
        } else this.openDiskMenu(); // remake right click: back to the disk menu
        break;
      }
      case "load": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        if (choice >= 0 && choice < SAVE_SLOTS) {
          if (!this.loadFromSlot(choice)) this.openSlotErrorMenu("load", choice, this.lastLoadError!);
        } else this.openDiskMenu(); // remake right click: back to the disk menu
        break;
      }
      case "sloterror": {
        const choice = this.menu!.update(input);
        const failed = this.slotError!;
        if (choice === null) break;
        const action = choice < 0 ? 2 : choice - failed.actionBase;
        if (action === 0) {
          // Retry the same slot: success leaves the screen, failure shows the (possibly different) new error.
          if (failed.op === "save") {
            if (this.saveToSlot(failed.slot)) {
              this.closeSlotError();
              this.closeMenu();
            } else this.openSlotErrorMenu("save", failed.slot, this.lastSaveError!);
          } else if (this.loadFromSlot(failed.slot)) this.closeSlotError();
          else this.openSlotErrorMenu("load", failed.slot, this.lastLoadError!);
        } else if (action === 1) {
          this.closeSlotError();
          this.openMenu(failed.op, failed.op === "save" ? SAVE_TITLE : LOAD_TITLE, this.slotLabels());
        } else if (action === 2) {
          this.closeSlotError();
          this.openDiskMenu();
        } else if (action === 3) {
          this.closeSlotError();
          this.closeMenu();
        }
        break;
      }
    }

    // The original leaves the boot/scenario menu and runs `$157BC` before returning to its display loop. A newly
    // selected scenario or tutorial therefore consumes its immediate first pass before the browser presents the map.
    // Keep the menu click out of `$50B2`: the original menu poll already consumed that input.
    if (this.stage === "map" && this.map && this.map !== mapBeforeUpdate && this.map.loop.immediatePassPending) {
      this.updateMap(this.map, {
        leftButton: false,
        rightButton: false,
        pointerX: input.pointerX,
        pointerY: input.pointerY,
        keys: [],
      });
    }
  }

  private updateMap(map: MapScene, input: Input): void {
    map.update(input);
    for (const event of map.sim.events.splice(0)) {
      if (event.kind === "invention") map.announceInvention(event.bit);
      if (event.kind === "announce" && !this.announce) {
        this.announce = new AnnounceScene(this.disk1, this.strings!, map.screen, event.id);
        this.stage = "announce";
      }
    }
    if (map.sim.pending && !this.announce && this.stage === "map") {
      this.offer = new OfferScene(this.disk1, this.strings!, map.sim.pending.offer);
      this.stage = "offer";
    }
  }

  private closeMenu(): void {
    this.menu = null;
    this.diskMenu = null;
    this.stage = "map";
  }
}
