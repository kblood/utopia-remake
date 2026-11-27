// Scene flow of the whole program: credit roll -> language -> boot stages (`boot-stages.ts`: message, code check, slide show,
// final message) -> boot disk menu -> scenario choice -> map, with the disk menu (original picture and icons, `disk-menu.ts`) opened
// from the map; its remake-only pages (save / load / scenario / Disk.4) hang off it. A game over (`$156AA` bit 3) shows its announcement
// and then the disk menu over the frozen map, with the sim stopped (`returnToMap`). Follows the original's stages (notes/formats/text.md,
// game-proper.md). The code check runs as the WHDLoad 1.2 slave patches it (text.md, step E).

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
import { createScreen, reportRefusal, type ScreenKind, type ScreenScene } from "./screens/index.js";
import { createBuildingScreen } from "./screens/buildings.js";
import { createOrderScreen } from "./screens/orders.js";
import type { ScreenContext } from "./screens/types.js";
import { IntroScene, type Input } from "./intro.js";
import { LanguageScene, type Language } from "./language.js";
import { BootStages } from "./boot-stages.js";
import { inspectDisk4Slot, prepareDisk4HeadlessEnemies, type Disk4HeadlessEnemyLoadError } from "./disk4-load.js";
import { applyDisk4LoadReset, applyDisk4ScenarioPointer, type Disk4ResetError } from "./disk4-reset.js";
import type { SceneRestoreError } from "./disk4-scene.js";
import { MapScene, type MapSceneOptions } from "./map.js";
import { DISK_BUTTON, DiskMenuScene, EFFECTS_STRING, NO_GAME_TO_SAVE_STRING, SAVE_DONE_STRING, SAVE_NAME_CLICK_STRING, SAVE_NAME_EDIT_STRING, SAVE_NAME_STRING, SAVE_OPEN_STRING, SCENARIO_LOADED_STRING, SCENARIO_WAIT_STRING } from "./disk-menu.js";
import { MenuScene } from "./menu.js";
import { NAME_PROMPT_COLUMNS, SaveNameEntry, wrapWords } from "./save-name.js";
import { toggleMusic } from "./music-select.js";
import { readSlot, SAVE_SLOTS, slotListLabel, slotSummaries, writeSlot } from "./save.js";
import { captureSession, restoreSession, type SessionParts } from "./save-session.js";
import { SYS, type Sim } from "./sim.js";
import { A, GameState } from "./state.js";
import { World, type WorldOptions } from "./world.js";

// The WHDLoad 1.2 slave writes `$00080000` to `$904` before the boot stage runs (Utopia.Slave, the CRC $D9C1 path), which the boot
// stage reads as "expansion memory detected" (boot-stages.ts). The profile this engine recognises is that one.
const WHDLOAD_EXPANSION_MEMORY = true;

type Stage = "intro" | "language" | "boot" | "scenario" | "map" | "disk" | "remake" | "save" | "load" | "announce" | "offer" | "screen" | "d4slot" | "d4scenario" | "d4error" | "sloterror";

/** REMAKE ONLY: the EXIT row of the save and load pages (icon 5, `$802C`). It follows the slot rows, so its index is `SAVE_SLOTS`. */
const PAGE_EXIT_LABEL = "EXIT";
const PAGE_EXIT_ROW = SAVE_SLOTS;

/** A string shown by a disk-menu pick: `prompt` is the list prompt (`$8462`), `info` the result line (`$83A2`, with its countdown). */
interface DiskMessage {
  readonly area: "prompt" | "info";
  readonly index: number;
}

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
  /** The disk menu's own pick (remake submenu slot): the scene is held until EXIT, as the original's load (`$8828`) does. */
  readonly pick?: boolean;
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
/** `$8462` text of `$87DC`'s EMPT check: "That slot is empty. Choose another..." (a scenario row of an EMPTY record, mode 3). */
const EMPTY_RECORD_STRING = 0x143;
/** The record name the original's `EMPT`/`Y` check looks for (`$454D5054`, then `$5900`): the name field reads exactly `EMPTY` up to its NUL. */
const EMPTY_RECORD_CODES = [..."EMPTY"].map((c) => c.charCodeAt(0));
function isEmptyRecord(codes: readonly number[]): boolean {
  return codes.length === EMPTY_RECORD_CODES.length && codes.every((code, i) => code === EMPTY_RECORD_CODES[i]);
}
/** Why the remake save is refused (`Game.saveRefusal`). */
type SaveRefusal = "no-game" | "game-over" | "disk4";
/** The REMAKE MENU label of the save entry while it is off. */
const SAVE_OFF_LABEL: Record<SaveRefusal, string> = {
  "no-game": "SAVE GAME (OFF: NO GAME)",
  "game-over": "SAVE GAME (OFF: GAME OVER)",
  disk4: "SAVE GAME (OFF: DISK.4 SESSION)",
};

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
  // Boot steps B to G after the language choice (`boot-stages.ts`); the boot disk menu opens when they end.
  private boot: BootStages | null = null;
  private strings: GameStrings | null = null;
  // Remake list pages (scenario choice, remake submenu, slot lists, Disk.4, errors); the original disk menu is `diskMenu`.
  private menu: MenuScene | null = null;
  // The original disk menu (`$7E52`/`$7EF6`: picture, nine icons, shared list incl. music select); stage "disk". notes/formats/music.md.
  private diskMenu: DiskMenuScene | null = null;
  // The boot module (track 3) is started once, at the first update of the credit roll (`$78614`-`$78654`, before the roll loop at
  // `$78662`). Nothing else starts it; the boot stage's ramp stops it (`$78966`-`$78986`), so the game proper starts silent.
  private introTuneStarted = false;
  private announce: AnnounceScene | null = null;
  // Announcements the sim queued, in its order: the original's `$E770` calls block one after the other, so the remake shows them one
  // dialog at a time and does not drop the later ones.
  private announcements: number[] = [];
  private offer: OfferScene | null = null;
  private window: ScreenScene | null = null;
  private frozen: Uint8Array | null = null;
  // The open window was started by an F1-F6 key: `$15B68`-`$15BE2` return to `$15C1A`, which re-presses the pause button.
  private windowFromKey = false;
  private map: MapScene | null = null;
  private scenario = 0;
  /**
   * The original boot disk menu (`$157AE` -> `$7E52`) is still the first session: true from the language choice until the boot exit
   * enters the game proper. That exit runs the `$157B8 -> $11476` call (`runDiskMenuExit`), once per launch; a game-over restart runs it again.
   */
  private bootMenuOpen = true;
  /**
   * The open disk menu was entered by the game-over tail (`$157AE` -> `$7E52`), not by a map icon (`$15AE6`). The tail's
   * exit returns through `$157B4` (`$15EF0`, then the apparition `$11476`), so a restart after a game over runs the apparition
   * call again; a map-icon exit returns through `$15AEC` and does not. Set by `returnToMap` in a game over, cleared by a map icon
   * and by an entered scene (`runDiskMenuExit`). Static trace (game-proper.md, "Game over"); the draw itself is the remake's RNG.
   */
  private diskMenuFromTail = false;
  /**
   * A scene built during the boot session (scenario, tutorial, remake load or Disk.4 continuation) waits here for the boot exit.
   * Nothing of it is entered, saved or announced until then; a later choice replaces it.
   */
  private heldScene: { readonly index: number; readonly map: MapScene; readonly disk4: Disk4Session | null } | null = null;
  /**
   * The list-prompt string (`$8462`) the held disk menu shows: `SCENARIO_LOADED_STRING` after a scenario pick, 0 for none. It is kept
   * here, not in the scene, because a remake page replaces the disk-menu scene and the held state must outlive that (openDiskMenu prints
   * it again). It is cleared where the original's `$84F4` erases the prompt: opening the load page or the scenario list (`$855A`, after its click),
   * the music list (`$82B8`), and a load pick (`$82B8`). Only meaningful while `heldScene` is set.
   */
  private heldPrompt = 0;
  /**
   * The picture a page opened by icon 0 or 1 replaced (`rememberPicture`): whether the scenario list was open, its prompt string and the
   * held prompt. The page's BACK restores them (`leaveDiskPage`), so a page opened from the list returns to the list with its prompt.
   * A successful save replaces them (`returnFromSave`): the prompt is `$141` and the held prompt is 0, because the save's erase is final.
   * Cleared when the picture is rebuilt (`openDiskMenu`). Null when no such page is open.
   */
  private pageReturn: { readonly list: boolean; readonly prompt: number; readonly heldPrompt: number } | null = null;
  /**
   * Icon 2's wait (`$855A` -> `$2E48`, awaitScenarioPress): set once the icon's release has printed `$13B`, until a fresh left press opens
   * the scenario list. `wasDown` is the button at the previous frame, so the wait's press is an edge, as `$2E48` tests it. While set the
   * disk menu takes no icon, row or right-button input (`$2E48` reads only the left button). Null otherwise.
   */
  private scenarioWait: { wasDown: boolean } | null = null;
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
  // `name` is the save name the failed save was given (RETRY writes the same name); null for a load and for an unnamed save.
  private slotError: { op: "save" | "load"; slot: number; error: SaveLoadError; actionBase: number; name: string | null } | null = null;
  /** The save name step (save-name.ts) while a row release is naming a save; null otherwise. Set only on the save page. */
  private nameEntry: { slot: number; entry: SaveNameEntry; priorPrompt: readonly (readonly number[])[] } | null = null;
  private readonly records: ScenarioRecord[];
  /** Whether the arrow is drawn for the frame that follows the last update (`main.ts` draws after each update). */
  pointerVisible = false;
  /** True for a frame whose pointer is the boot stage's hardware sprite 2 (the language poll), not the game proper's arrow. */
  private bootPointerFrame = false;
  /** Set by the language choice: from the next update the game proper's arrow (`$156A8` bit 2, `$1583E`) is shown. */
  private gameProperPointer = false;

  /** The boot sprite (`readBootPointer`) is drawn only for the language-poll frames (text.md, "Pointer visibility"). */
  get pointerUsesBootSprite(): boolean {
    return this.bootPointerFrame;
  }

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
    // The boot module starts in the update that ends the title fade-in (intro.ts), not on the roll's first update.
    this.intro = new IntroScene(disk1, { startModule: () => this.startIntroTune() });
    this.records = readScenarioRecords(disk2);
  }

  get screen(): Screen {
    if (this.stage === "intro") return this.intro.screen;
    if (this.stage === "language") return this.language!.screen;
    if (this.stage === "boot") return this.boot!.screen;
    if (this.announce) return this.announce.screen;
    if ((this.stage === "disk" || this.stage === "scenario") && this.diskMenu) return this.diskMenu.screen;
    if (this.menu) return this.menu.screen;
    return this.map!.screen;
  }

  private openMenu(stage: Stage, title: string, labels: { label: string; enabled?: boolean }[]): void {
    this.stage = stage;
    this.diskMenu = null;
    this.nameEntry = null; // a page that is replaced ends the name step (its prompt and row go with the page)
    // The load page is the load icon's (`$85FE` -> `$855A`, which erases the prompt after its click): the held prompt goes with it.
    // (The save icon's erase is done in diskIcon, where the picture it replaces is remembered first.)
    if (stage === "load") this.heldPrompt = 0;
    // A save or load row is chosen on its release (`$7FCE` -> `$2E52`, the row latched at the press, `$8132`/`$8CFE`); the other
    // pages keep the press. Both list pages carry EXIT (icon 5, `$802C`), which the original keeps live in every list (`$7FE4`).
    const listPage = stage === "save" || stage === "load";
    const entries = listPage ? [...labels, { label: PAGE_EXIT_LABEL }] : labels;
    this.menu = new MenuScene(this.disk1, title, entries, { activate: listPage ? "release" : "press" });
  }

  // F1-F6, trade, staffing and intelligence windows over the frozen map frame.
  private openScreen(kind: ScreenKind): void {
    const map = this.map!;
    if (this.stage !== "map" || map.sim.gameOver) return;
    this.showWindow(createScreen(kind, this.screenContext(map)));
  }

  // F1-F6 (`$15B4A`): called from the completed pass's poll, after its press handling, so the pass draws first. Without an
  // online command centre `$15B3E` posts message $B2 and no report opens (`reportRefusal`); the line is drawn by that pass.
  private windowKey(name: string): void {
    const map = this.map!;
    const refusal = reportRefusal(map.world.state);
    if (refusal >= 0) {
      map.say(refusal);
      return;
    }
    this.openScreen(name.toLowerCase() as ScreenKind);
    if ((this.stage as Stage) === "screen") this.windowFromKey = true;
  }

  private screenContext(map: MapScene): ScreenContext {
    const record = this.records[this.scenario];
    const sectors = (range: { first: number; last: number }): Uint8Array => this.disk2.subarray(range.first * 512, (range.last + 1) * 512);
    return { disk: this.disk1, world: map.world, sim: map.sim, strings: this.strings!, intelligence: { portraits: sectors(record.intel), text: sectors(record.text[this.selectedLanguage]) }, say: (n) => map.say(n), scroll: map.scrollRef, objects: map.objects ?? undefined, otherUnits: () => map.enemies?.overview() ?? {}, sound: (id) => this.sfx?.play(id), pressLatch: () => map.pressLatch };
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
      onDiskMenu: () => this.openMapDiskMenu(), onScreen: (kind) => this.openScreen(kind), onSelect: (x, y) => this.selectCell(x, y),
      onPick: (px, py) => this.pickUnit(px, py), onWindowKey: (key) => this.windowKey(key), sfx: (id, volume) => this.sfx?.play(id, volume), sprites: loadSprites(this.disk1, this.disk2, record),
      simulation: freshStart ? this.freshStartInputs.simulation : undefined,
      freshScenario: freshStart,
      // A scene built here replaces the current one (none in the boot session). The original's disk menu restores the pre-menu
      // bitmap on exit and nothing on the in-game load, scenario or tutorial path unpacks the picture again (`$4E28` runs only on
      // the boot tail), so the command-button column carries over (building.md, "Right panel, part 2"; static trace).
      commandButtonImagesFromTable: this.map?.controls.commandButtonImagesFromTable === true,
    };
  }

  // A fresh scene of a scenario, built off to the side: nothing of the Game changes until `enterScene`.
  private createScene(index: number, freshStart = true): MapScene {
    const record = this.records[index];
    const scene = new MapScene(
      this.disk1,
      loadTileSet(this.disk1, this.disk2, record).tiles,
      new World(new GameState(this.disk2, record.block), loadMap(this.disk2, record), freshStart ? this.freshStartInputs.world : undefined),
      this.strings!,
      this.sceneOptions(record, freshStart),
    );
    // The descriptor table is not rebuilt by a scenario, tutorial, load or Disk.4 start (`$866E`/`$875C` do not touch `$1612E`), so the
    // exchange parity of the session being replaced carries over; a load then takes the saved value (restoreSession).
    scene.sim.carryTableState(this.map?.sim ?? null);
    // A new game started from the game-over tail (a restart, `$157B4` return) continues the generator of the game it ends. The
    // original's seed `$2EA0` is one cell that only `$2DCC` writes (`$2DA0`, its only initialiser, has no caller in the image;
    // sim-port.md), so a new scenario does not reseed it. Without this every restart began the default seed again and drew the
    // same first value, so a scenario's restart marker never changed. Loads (`freshStart` false) keep the saved generator state.
    // The game-over map is still the current map while the tail's menu is open, so its state is the one carried.
    // The hardware approximation (TOD and beam-position streams, sim-hardware.ts) is continuous hardware in the original, so a
    // restart must not replay the first game's values either: it is carried the same way. A generator injected through
    // `freshStartInputs` is an explicit harness input and is left as injected.
    const ended = this.diskMenuFromTail && freshStart ? this.map?.sim ?? null : null;
    if (ended !== null) {
      const injected = this.freshStartInputs.simulation;
      const rng = injected?.rng === undefined ? ended.rngState : null; // null: a custom generator cannot be carried
      if (rng !== null) scene.sim.restoreRngState(rng);
      const hardware = injected?.hardware === undefined ? ended.hardwareState : null;
      if (hardware !== null) scene.sim.restoreHardwareState(hardware);
    }
    return scene;
  }

  /**
   * Programmatic scenario start (public for the harnesses): entered as the boot rule says, held only while the boot session is open.
   * The scenario list's pick is `pickScenario`, not this.
   */
  startScenario(index: number): void {
    this.acceptScene(index, this.createScene(index), null, false, null);
  }

  /**
   * A row pick on the scenario list: the original's mode-3 list (`$938D` = 3). The list stays open after a pick. `$88F0` returns
   * into `$7EF6` without `$82B8` and does not write `$938D`, and the next row release runs `$87DC` again with the hovered row, so
   * another scenario can be picked before EXIT (notes/formats/game-proper.md, "Scenario list and the held prompt"). The new scene
   * replaces the held one (`holdScene`), and the list prompt shows `$8B`.
   */
  private pickScenario(index: number): void {
    // `$87DC`: the `EMPT`/`Y` check (`$8804`-`$8818`) runs before the mode test, so a row of an EMPTY record is refused in mode 3 too:
    // `$143` on the list prompt, no scene built, the list and the held scene stay (`$8462`, then `rts` without `$82B8`).
    if (isEmptyRecord(this.records[index].labelCodes)) {
      this.diskMenu!.printPrompt(EMPTY_RECORD_STRING);
      return;
    }
    this.holdScene(index, this.createScene(index), null, { area: "prompt", index: SCENARIO_LOADED_STRING });
    this.diskMenu!.printPrompt(SCENARIO_LOADED_STRING);
  }

  /**
   * Music is never touched by starting or loading a game: in the original the only caller of the track loader `$110A` is the
   * music-select handler `$8A42`, so a new scenario, a load and a Disk.4 slot leave the selected track (`$1580`) and the playing
   * module as they are, and the game proper starts silent until the player picks a track (notes/formats/music.md). The boot
   * module is stopped by the boot stage's ramp, before any scene exists, so entering a scene has no music to end.
   */
  private enterScene(index: number, map: MapScene, disk4: Disk4Session | null = null): void {
    this.runDiskMenuExit(map.sim);
    this.heldScene = null;
    this.heldPrompt = 0;
    this.scenario = index;
    this.map = map;
    this.disk4Session = disk4; // a new game or a remake load is not a Disk.4 continuation
    this.announce = null;
    this.announcements = [];
    this.offer = null;
    this.window = null;
    this.frozen = null;
    this.menu = null;
    this.diskMenu = null;
    this.stage = "map";
  }

  /**
   * A load from the disk menu does not enter the game: the original's `$8828` builds the state, prints "... Select 'EXIT' to play."
   * (`message`) and returns into the disk-menu loop `$7EF6`. Only the exit (`$802C`) leaves that loop, so the new scene is held and the
   * disk menu is shown again, in the boot session and in the game proper alike. A scenario pick (`$88F0`) does not come here: its page
   * stays open (`pickScenario`). A newer choice replaces a held scene. The state initialisation of the scene is already done
   * here, as in `$866E`/`$875C`. `pick` false is the programmatic entry: held only while the boot session is open (the boot rule),
   * otherwise entered. `message` is the string for the pick and its area; a load passes none, because its `$145` is erased by `$82B8`
   * in the same handler (game-proper.md, "Load failure and return"); the Disk.4 continuation keeps its result-line print (not traced).
   */
  private acceptScene(index: number, map: MapScene, disk4: Disk4Session | null, pick: boolean, message: DiskMessage | null): void {
    if (!pick && !this.bootMenuOpen) {
      this.enterScene(index, map, disk4);
      return;
    }
    this.holdScene(index, map, disk4, message);
    this.openDiskMenu(); // prints the held prompt, if any
    if (message?.area === "info") this.diskMenu!.printInfo(message.index, 0);
  }

  /** The held state of a pick or a load: the scene and the prompt its message leaves (`heldPrompt`); a newer hold replaces it. */
  private holdScene(index: number, map: MapScene, disk4: Disk4Session | null, message: DiskMessage | null): void {
    this.heldScene = { index, map, disk4 };
    this.heldPrompt = message?.area === "prompt" ? message.index : 0;
  }

  /**
   * `$802C` with a held scene: the held state already cleared `$156AA` bit 3 (`$875C`), so the exit enters the game with it. This is
   * the only way off the disk menu for a scenario pick or a load (the original's exit runs `$157B4`/`$15AEC` back to the map).
   */
  private enterHeldScene(): void {
    const held = this.heldScene!;
    held.map.sim.leaveDiskMenu(); // `$802C`: the exit of the disk menu; a reset scene has `$144BB` 0 (nothing), a native load keeps its saved count
    // The scenario pick (`$88F0`) and the load (`$8828`) return into the same loop and leave through the same `$802C` `rts`, so the
    // first map pass after EXIT is the same for both. A scenario is armed when it is built (`freshScenario`); a restored load is not,
    // because a save stores no pending pass. Arm the held load here so its EXIT runs that pass too (static trace, game-proper.md).
    // A Disk.4 continuation keeps its own state: its disk-menu exit has not been traced.
    if (held.disk4 === null) held.map.loop.resumeWithImmediatePass();
    this.enterScene(held.index, held.map, held.disk4);
  }

  /**
   * The exit of the disk menu's tail enters the game and runs the apparition call `$157B8 -> $11476` (`Sim.leaveBootMenu`) over the
   * state the held scene has at exit. Two tails do so: the boot menu (the first entry, `bootMenuOpen`; every source of the boot
   * session, scenario, tutorial, remake load and Disk.4 continuation, is drawn over the state it has at exit, so a load is followed
   * by the same call, static-trace model, game-proper.md) and the game-over tail (`diskMenuFromTail`, a restart: static trace, the
   * same `$157B4` return; the draw uses the remake's RNG, so the marker is an approximation, see game-proper.md "Restart"). A map
   * icon's exit (`$15AEC`) runs no apparition. Each tail's call happens once per exit.
   */
  private runDiskMenuExit(sim: Sim): void {
    const tail = this.bootMenuOpen || this.diskMenuFromTail;
    this.bootMenuOpen = false;
    this.diskMenuFromTail = false;
    if (tail) sim.leaveBootMenu();
  }

  /**
   * Why the remake save is refused now, or null when it is allowed. One place for the menu entry, the save slot path and the
   * icon path. A held scene is the session the original's RAM holds at that point (`$88F0` built it, `$875C` reset it), so it is
   * saved in place of the old map: only a held Disk.4 continuation or a held game over is refused. Otherwise, in the original's
   * order: no game (boot session with nothing held), game over (`$156AA` bit 3: the original's `$856C` prints `$18A`), then the
   * Disk.4 continuation the remake save cannot hold.
   */
  private saveRefusal(): SaveRefusal | null {
    const held = this.heldScene;
    if (held !== null) {
      if (held.disk4 !== null) return "disk4";
      return held.map.sim.gameOver ? "game-over" : null;
    }
    if (this.map === null) return "no-game";
    if (this.map.sim.gameOver) return "game-over";
    if (this.disk4Session !== null) return "disk4";
    return null;
  }

  // The credit roll's start (`$78654`, cmd 1 and `bset #1`): once per launch. The remake has no logo or title fades before it, so
  // the module starts with the roll's first frame (text.md, "Credit roll"). `Music.play` is the remake's equivalent of cmd 0/1.
  private startIntroTune(): void {
    if (this.introTuneStarted) return;
    this.introTuneStarted = true;
    this.music?.play(3);
  }

  // `$8A42`: `$110A` loads and starts the module (always from the beginning, `$1580` is not compared), then `$82B8` closes the list
  // (`DiskMenuScene` already did) and the disk-menu loop continues.
  private chooseTrack(track: number): void {
    this.music?.play(track, true);
  }

  private handleDiskMenu(input: Input): void {
    if (this.scenarioWait !== null) {
      this.waitForScenarioPress(input);
      return;
    }
    const result = this.diskMenu!.update(input);
    if (result === null) return;
    if (result.kind === "track") this.chooseTrack(result.track);
    else if (result.kind === "scenario") this.pickScenario(result.index);
    else if (result.kind === "icon") this.diskIcon(result.index);
    else if (result.kind === "remake") this.openRemakeMenu();
    else this.listClosed(); // music rows 4-9 (`$110A` -> `$82B8`) or the remake's right click on the music list; the music is untouched
    this.syncDiskStage();
  }

  /**
   * A music list closed (`$82B8`): rows 4-9, or the remake's right click on it. The list's prompt goes with it; a held scenario's `$8B`
   * is printed again. The scenario list does not close on a right click (no original route, `DiskMenuScene.update`).
   */
  private listClosed(): void {
    if (this.heldScene !== null && this.heldPrompt !== 0) this.diskMenu!.printPrompt(this.heldPrompt);
  }

  /** The stage follows the list on the disk picture: `scenario` while the scenario list is open, `disk` otherwise (only while the disk picture is shown). */
  private syncDiskStage(): void {
    if (this.diskMenu === null || (this.stage !== "disk" && this.stage !== "scenario")) return;
    this.stage = this.diskMenu.listKind === "scenario" ? "scenario" : "disk";
  }

  /**
   * The `$7FE4` dispatch, run on the release of the icon recorded at the press (the click was requested on the press by the scene).
   * Original handlers keep their traced behaviour; the save-disk family needs floppies, so the remake maps load / save / scenario to its
   * own pages (titled as remake pages) and leaves format as a labelled no-op. Disk.4 has no icon: it is in the remake submenu.
   */
  private diskIcon(index: number): void {
    const scene = this.diskMenu!;
    switch (index) {
      case DISK_BUTTON.load: // `$85FE`
        this.rememberPicture();
        this.openMenu("load", LOAD_TITLE, this.slotLabels());
        break;
      case DISK_BUTTON.save: { // `$856C`: `$156AA` bit 3 set -> `$18A` and `$82B8` (the list closes); clear -> the save-disk check `$855A`
        // The remake has no save disk, so it opens its own slot page (no disk check is traced for it). A held scene is saved (`saveToSlot`).
        const refusal = this.saveRefusal();
        if (refusal === "game-over") {
          scene.printInfo(NO_GAME_TO_SAVE_STRING, 0);
          scene.closeList(); // `$8592` `bsr $82b8`: the original erases the list on this path
        } else if (refusal === "no-game") scene.printInfo(NO_GAME_TO_SAVE_STRING, 0); // remake state: the boot session with nothing held
        else if (refusal === "disk4" && this.heldScene !== null) scene.printRemakeNote("REMAKE: DISK.4 SESSION CANNOT BE SAVED");
        else if (refusal === "disk4") this.openRemakeMenu(); // the remake save cannot hold a Disk.4 continuation: the submenu says so
        else {
          this.rememberPicture();
          this.heldPrompt = 0; // `$855A`'s `$84F4` erases the prompt on the way in; BACK gets it back from pageReturn
          this.openMenu("save", SAVE_TITLE, this.slotLabels());
          this.menu!.setPrompt(this.strings!.get(SAVE_OPEN_STRING)); // `$138`, the save list's prompt (`$85B8` -> `$85CA`)
        }
        break;
      }
      case DISK_BUTTON.scenario: // `$8632` -> `$855A`: prints `$13B` and waits for a press (awaitScenarioPress)
        this.awaitScenarioPress();
        break;
      case DISK_BUTTON.format: // `$8314`: every exit path calls `$82B8` (closes the list, erases the prompt) before `bra $7EF6`; the floppy format is not modelled
        this.heldPrompt = 0;
        scene.closeList();
        scene.printRemakeNote("REMAKE: NO DISK TO FORMAT");
        break;
      case DISK_BUTTON.music: // `$1062`: in place, result in the second info line; without Music the "no expansion memory" branch ($197)
        scene.printInfo(0, toggleMusic(this.music));
        break;
      case DISK_BUTTON.exit: // `$802C`
        this.exitMenus((note) => scene.printRemakeNote(note));
        break;
      case DISK_BUTTON.tutorial: // `$80C8`
        this.startTutorial();
        break;
      case DISK_BUTTON.musicSelect: // `$1006`: `$82B8` closes any list first, and its `$84F4` erases the prompt (see heldPrompt)
        this.heldPrompt = 0;
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
   * `$802C`, the EXIT icon's action (`$7FE4` dispatch, icon 5). The icons are live in the scenario list too (mode 3 keeps the disk
   * picture and its table, notes/formats/game-proper.md), so the scenario list offers the same exit. A held scene (scenario pick, load)
   * enters with its one immediate pass (`enterHeldScene`). With none, the boot session refuses with a note (`refuse`); otherwise the exit
   * is refused while `$156AA` bit 3 (game over) is set, silently. In the game proper the menus close and the map arms its immediate pass.
   * The held check comes first: `this.map` is still the old map then.
   */
  private exitMenus(refuse: (note: string) => void): void {
    if (this.heldScene !== null) this.enterHeldScene();
    else if (this.bootMenuOpen) refuse("REMAKE: CHOOSE A SCENARIO");
    else if (this.map?.sim.gameOver !== true) {
      this.closeMenu();
      // An in-game icon exit (`$15AE6` -> `$7E52`, exit `$802C`, then `$15AEC` `$15EF0`, `rts`, `$158B4` keyboard poll `$15B4A`,
      // `bra $157BC`) resumes at the loop top, as a held scene's exit does. Its `$15EF0` returns the map to select mode (build or
      // demolish mode and the selection are dropped; the mode icon follows the mode). Then arm the immediate pass; the next update runs it.
      if (this.stage === "map" && this.map) {
        this.map.controls.returnToSelectMode();
        this.map.loop.resumeWithImmediatePass();
      }
    }
  }

  /**
   * `$80C8`: scenario record 0 with `$156AA` bits 7 (tutorial) and 2 (no-unit bonus) set and money `$7A120`. It ends with `bra $802C`
   * (`$812E`), so the exit runs by itself and the tutorial enters the game at once, with or without the boot session (unlike a
   * scenario pick, which returns to the disk-menu loop). The state initialisation `$866E` and the record loader `$8B02` are the
   * same data the scenario start loads.
   */
  private startTutorial(): void {
    const scene = this.tutorialScene();
    scene.sim.leaveDiskMenu(); // `$812E` `bra $802C`: the reset has cleared `$144BB`, so this changes nothing
    this.enterScene(0, scene);
  }

  /** The tutorial scene before its first pass (the state `$80C8` leaves for the exit). Public for the static-trace tests. */
  tutorialScene(): MapScene {
    const scene = this.createScene(0);
    scene.sim.sysFlags |= SYS.tutorialMode | SYS.noUnitBonus;
    scene.world.state.setLong(A.money, TUTORIAL_MONEY);
    return scene;
  }

  /**
   * Icon 2's `$855A` wait (`$2E48`): prints `$13B` ("Insert scenario disk in internal drive and click mouse button..") on the disk
   * menu's prompt line and waits for a fresh left press. The icon acted on its release, so that click is spent and cannot select a row.
   * Only the press opens the list; the remake's list setup has no measured duration, so this wait is an update approximation (see
   * notes/formats/game-proper.md, "Opening click and the held press").
   */
  private awaitScenarioPress(): void {
    this.diskMenu!.printPrompt(SCENARIO_WAIT_STRING);
    this.scenarioWait = { wasDown: false };
  }

  /**
   * One frame of the wait. The frame with the button newly down opens the scenario list with that press pending (`openScenarioList(true)`).
   * The page's first update is the first list poll (`$50B2`): a press still held there arms the row under the pointer, and a press
   * released before it picks nothing. The result lines still count down; the right button is not read (`$2E48`).
   */
  private waitForScenarioPress(input: Input): void {
    const wait = this.scenarioWait!;
    const pressed = input.leftButton && !wait.wasDown;
    wait.wasDown = input.leftButton;
    this.diskMenu!.tickInfo();
    if (!pressed) return;
    this.scenarioWait = null;
    this.openScenarioList(true);
  }

  /**
   * Opens the scenario list on the disk picture (`$865A`, mode 3): `$13D` on the list prompt, the ten record names as rows, and icon 5
   * (EXIT, `$802C`) for leaving. `pressPending`: icon 2's wait opened it, so a button still down at the list's first update is a press
   * (`$50B2`'s first poll); the remake submenu's NEW SCENARIO entry passes false (its press chose the entry). The disk scene must exist.
   */
  private openScenarioList(pressPending: boolean): void {
    this.heldPrompt = 0; // `$84F4` erases the prompt on the way in (`$855A`); the list's own prompt replaces it
    this.diskMenu!.openScenarioList(this.records.map((r) => r.labelCodes), pressPending);
    this.syncDiskStage();
  }

  /**
   * Icon 0 or 1 is about to open its page from the picture: remember what the page replaces (the list, its prompt and the held prompt).
   * The original's `$855A` erases the prompt and sets the mode of the page's list (`$938D` 2 or 1); the remake's page is its own screen,
   * so its BACK brings the picture back as it was (remake choice, notes/formats/game-proper.md "Mode-3 icons").
   */
  private rememberPicture(): void {
    const scene = this.diskMenu!;
    this.pageReturn = { list: scene.listKind === "scenario", prompt: scene.promptIndex, heldPrompt: this.heldPrompt };
  }

  /**
   * A page's BACK (its right click, or the error page's BACK): the disk picture again. When the page replaced the scenario list, the list
   * comes back with the prompt it showed (its rows are the same records, and the hover row follows the pointer as `$8132` does); the held
   * scene is unchanged. Without a remembered list the picture shows the held prompt, as any rebuilt picture does.
   */
  private leaveDiskPage(): void {
    const back = this.pageReturn;
    this.pageReturn = null;
    if (back !== null) this.heldPrompt = back.heldPrompt;
    this.openDiskMenu();
    if (back?.list) {
      this.diskMenu!.openScenarioList(this.records.map((r) => r.labelCodes), false);
      this.syncDiskStage();
    }
    // The prompt the picture or list showed when the page opened, or the save's `$141` after a save (`returnFromSave`): an erased
    // prompt is not in `back`, so it does not come back.
    if (back !== null && back.prompt !== 0) this.diskMenu!.printPrompt(back.prompt);
  }

  /** The original disk menu: picture, nine icons, shared list. The remake's own functions are behind `openRemakeMenu`. */
  private openDiskMenu(): void {
    this.stage = "disk";
    this.menu = null;
    this.scenarioWait = null;
    this.pageReturn = null;
    this.diskMenu = new DiskMenuScene(this.disk1, this.strings!, { onButtonPress: () => this.sfx?.play(SFX.CLICK) });
    if (this.heldScene !== null && this.heldPrompt !== 0) this.diskMenu.printPrompt(this.heldPrompt);
  }

  /**
   * REMAKE ONLY (no original counterpart; reached with the right button on the disk menu): the remake save slots, the scenario list
   * and the experimental Disk.4 continuation. The remake's localStorage save (save-session.ts) holds the remake's own session
   * only; it has no place for a Disk.4 continuation (adopted records with saved bytes), so saving is refused for one and the
   * entry stays disabled.
   */
  private openRemakeMenu(): void {
    const refusal = this.saveRefusal();
    const saveEntry = refusal === null ? { label: "SAVE GAME", enabled: true } : { label: SAVE_OFF_LABEL[refusal], enabled: false };
    this.openMenu("remake", "REMAKE MENU (NOT ORIGINAL)", [saveEntry, { label: "LOAD GAME" }, { label: "NEW SCENARIO" }, { label: "LOAD DISK.4 (EXPERIMENTAL)", enabled: this.disk4Source !== null && this.strings !== null }, { label: "BACK TO DISK MENU" }]);
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
    return this.strings !== null && this.stage !== "intro" && this.stage !== "language" && this.stage !== "boot";
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
   * saved in the remake. While the boot session is open the committed scene is held for the boot exit like any other scene:
   * `importedDisk4` stays null and the disk menu stays up until then.
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
    // The Disk.4 record holds no descriptor table, so the activation keeps the exchange parity of the session it replaces (boot state
    // 0 in a fresh launch). Whether that matches the original's table when the Disk.4 record was written is NOT verified.
    scene.value.sim.carryTableState(this.map?.sim ?? null);

    // Commit: nothing below can fail. The boot session holds the scene until its exit (acceptScene); the session is visible only once entered.
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
    this.lastDisk4Error = null;
    // A disk-menu pick is the original's mode-2 load (`$8828`): its `$145` is printed on the list prompt and erased at the next VBL
    // (`$84F4`, one frame, not modelled), so the remake holds no message (game-proper.md, "Load success message"; as `loadFromSlot`).
    // No audio state is restored or started (see enterScene).
    this.acceptScene(scenario, scene.value, session, request.pick === true, null);
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
    const result = this.activateDisk4({ bytes: source.bytes, slot, recoverScenario: scenario, source: source.label, pick: true });
    if (result.ok) return;
    this.disk4Slot = slot;
    if (result.error.stage === "metadata" && result.error.error.code === "scenario-index") this.openDisk4ScenarioMenu(result.error.candidates ?? []);
    else this.openDisk4ErrorMenu(result.error);
  }

  private slotLabels(): { label: string; enabled?: boolean }[] {
    return slotSummaries().map((s, i) => ({ label: slotListLabel(i, s) }));
  }

  // Failed remake save / load: the map scene is untouched; this screen names the typed reason and offers retry / back.
  // The error stays in `lastSaveError` / `lastLoadError`.
  private openSlotErrorMenu(op: "save" | "load", slot: number, error: SaveLoadError, name: string | null = null): void {
    const lines = wrapMessage(error.message);
    const actionBase = 1 + lines.length;
    this.slotError = { op, slot, error, actionBase, name };
    this.openMenu("sloterror", `${op === "save" ? "SAVE" : "LOAD"} FAILED - SLOT ${slot + 1}`, [
      { label: `CODE: ${error.code}`, enabled: false },
      ...lines.map((label) => ({ label, enabled: false })),
      { label: `RETRY SLOT ${slot + 1}` },
      { label: "CHOOSE ANOTHER SLOT" },
      { label: "DISK MENU" },
      // Both operations are menu-origin (disk icon or the remake submenu) and BACK returns to the disk-menu loop with no exit effect:
      // a save's `$8A40` returns to `$7EF6`, and a load's refusal (`$85FE` wrong disk) also prints and `bra $7EF6`s (game-proper.md,
      // "Load failure and return"). An EMPTY record does not come here: it stays on the load list (`refuseLoad`, `$8804`). BACK returns where the page was opened from (`leaveDiskPage`: the
      // list comes back when icon 0 or 1 opened the page from it); "DISK MENU" and the right click go to the picture. The exit
      // `closeMenu` would run (`leaveDiskMenu`, the eclipse exchange) is the EXIT icon's, so a failed operation never does it.
      { label: "BACK TO DISK MENU" },
      { label: "RIGHT CLICK: DISK MENU", enabled: false },
    ]);
  }

  /**
   * A refused load from the load page (a row release, `$7FCE` -> `$87DC` in mode 2). An EMPTY record is the original's EMPT check
   * (`$8804`-`$881E`): `$143` on the list prompt, then `rts`, so the list stays open (mode 2 kept, no scene, no error page) and
   * another row can be chosen, or EXIT. Corrupt and other typed errors have no traced route; they keep the remake's error page.
   */
  private refuseLoad(slot: number, error: SaveLoadError): void {
    if (error.code !== "empty") return this.openSlotErrorMenu("load", slot, error);
    this.menu!.setPrompt(this.strings!.get(EMPTY_RECORD_STRING));
  }

  private closeSlotError(): void {
    this.slotError = null;
  }

  /**
   * EXIT on a save or load page (its row after the slots): icon 5's action, `$802C` through `exitMenus`, with no BACK first. The
   * original keeps the icons live in its lists (`$7F8C` -> `$7F96` -> `$7FE4`, no mode test), so the page offers the exit directly.
   * A refusal (boot session with nothing held) prints its note on the page's prompt line; game over refuses silently, as the icon does.
   */
  private exitFromPage(): void {
    this.exitMenus((note) => this.menu?.setPromptText(note));
  }

  // A successful save from a save page (the disk icon's `$856C` or the remake submenu) returns to the disk-menu loop, not to the
  // map: the original's `$8A40` `rts` returns to `$7FDC`, which does `bra $7EF6`, so the loop waits for EXIT (game-proper.md, "Save
  // tail"). The programmatic `saveToSlot` is unchanged. The prompt line shows the original's last message (`$141`).
  // The traced `$89B4` tail does not call `$82B8` and leaves `$938D` = 1 (icon 1's own write, `$85BE`), so the original's list after the
  // save is the mode-1 save list, and the prompt it erases (`$84F4`) is gone for good: `$141` is the prompt until a traced erase. The
  // remake keeps the save page up for every origin (picture, scenario list, boot list, remake submenu) with `$141` as its status line;
  // the page stands in for the original's save list (remake choice: slot labels, not its rows). The page's BACK (`leaveDiskPage`) shows
  // the picture or list it came from with `$141` (the pre-save prompt is not restored: `$84F4` erased it), and the held scene is kept.
  // The page's EXIT row (`exitFromPage`) leaves the disk menu directly, as icon 5 does. A second save from the page takes the same route (`pageReturn` is kept).
  private returnFromSave(): void {
    const back = this.pageReturn;
    this.heldPrompt = 0; // the tail's `$84F4` erased the held prompt too
    this.pageReturn = { list: back?.list ?? false, prompt: SAVE_DONE_STRING, heldPrompt: 0 };
    this.openMenu("save", SAVE_TITLE, this.slotLabels()); // fresh slot labels show the write
    this.menu!.setPrompt(this.strings!.get(SAVE_DONE_STRING));
  }

  /**
   * Row release on the original save list enters `$8918`. It first offers the date-derived default name; Return enters the raw-key
   * editor at `$5110`, while a mouse click accepts the default and writes the slot. The remake keeps that two-step interaction on
   * its slot page. Escape/right-click are remake-only ways to cancel back to the prior page prompt.
   */
  private chooseSaveSlot(slot: number): void {
    const map = this.heldScene?.map ?? this.map;
    if (!map) return;
    const state = map.world.state;
    const day = String(state.byte(A.day)).padStart(2, "0");
    const month = String(state.byte(A.month) + 1).padStart(2, "0");
    const year = String(2090 + state.long(A.year));
    const entry = new SaveNameEntry(`${day}/${month}/${year}`);
    this.nameEntry = { slot, entry, priorPrompt: this.menu!.promptLines };
    this.drawSaveNamePrompt(entry);
  }

  /** Render the two original name strings on the remake save page, wrapped to its panel; the original pixels are not reproduced. */
  private drawSaveNamePrompt(entry: SaveNameEntry): void {
    const strings = this.strings!;
    const asText = (codes: readonly number[]): string => String.fromCharCode(...codes);
    let lines: string[];
    if (entry.phase === "prompt") {
      const template = asText(strings.get(SAVE_NAME_STRING));
      const placeholder = /x{2,}/.exec(template);
      const shownName = entry.defaultName.slice(0, placeholder?.[0].length ?? entry.defaultName.length);
      // The original copies 15 bytes of the date block over the placeholder (`$8918`): the date's NUL lands on the closing quote, so
      // the drawn line ends at the date ("...as '28/06/2090"); the rest of the template is not printed (Disk.1 `$14594` bytes, `$13E`).
      const text = placeholder ? template.slice(0, placeholder.index) + shownName : `${template} ${entry.defaultName}`;
      lines = [...wrapWords(text, NAME_PROMPT_COLUMNS), ...wrapWords(asText(strings.get(SAVE_NAME_CLICK_STRING)), NAME_PROMPT_COLUMNS)];
    } else {
      const edit = asText(strings.get(SAVE_NAME_EDIT_STRING));
      lines = [...wrapWords(edit, NAME_PROMPT_COLUMNS), ...wrapWords(entry.text || "_", NAME_PROMPT_COLUMNS)];
    }
    this.menu!.setPromptLines(lines.map((line) => Array.from(line, (c) => c.charCodeAt(0))));
  }

  private updateSaveName(input: Input): void {
    const pending = this.nameEntry;
    if (!pending) return;
    const outcome = pending.entry.update(input);
    if (outcome === null) {
      this.drawSaveNamePrompt(pending.entry);
      return;
    }
    this.nameEntry = null;
    if (outcome.kind === "cancel") {
      this.menu!.setPromptLines(pending.priorPrompt);
      return;
    }
    if (this.saveToSlot(pending.slot, outcome.name)) this.returnFromSave();
    else this.openSlotErrorMenu("save", pending.slot, this.lastSaveError!, outcome.name);
  }

  // Remake save of the held scene, or of the live map when none is held, into a slot. Refusals (Disk.4 session, pending offer, ...) write
  // nothing and are kept in `lastSaveError`. A held scene (picked on the list, or loaded and waiting for EXIT) is the session the
  // original's RAM holds, so it is saved under its own scenario index, never the old map's.
  private saveToSlot(slot: number, name: string | null = null): boolean {
    this.lastSaveError = null;
    const held = this.heldScene;
    const map = held ? held.map : this.map;
    if (!map || (held ? held.disk4 !== null : this.disk4Session !== null) || map.restoredFromDisk4) {
      this.lastSaveError = { code: "disk4-session", message: "A Disk.4 continuation cannot be saved" };
      return false;
    }
    if (map.sim.gameOver) {
      // Same refusal as the original's `$856C` with `$156AA` bit 3 set (`$18A`): the menu entry is off, this is the direct path.
      this.lastSaveError = { code: "game-over", message: "The game is over: there is no game to save" };
      return false;
    }
    const captured = captureSession(sessionParts(map), held ? held.index : this.scenario);
    if (!captured.ok) {
      this.lastSaveError = captured.error;
      return false;
    }
    captured.value.name = name;
    const written = writeSlot(slot, captured.value);
    if (!written.ok) {
      this.lastSaveError = written.error;
      return false;
    }
    return true;
  }

  // Remake load. The target scene is built and filled off to the side; only a complete, validated restore replaces the active
  // session. Any failure returns false with `lastLoadError` set and the running scene, menu stage and Game state untouched.
  private loadFromSlot(slot: number, pick = false): boolean {
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
    // The scene was drawn from the scenario's default state when it was built; show the restored state now (the first pass of a saved
    // loop may be far off, see MapScene.presentRestoredState). The scene is not yet the active one, so a failure leaves the game as it was.
    try {
      scene.presentRestoredState();
    } catch (error) {
      this.lastLoadError = { code: "resources", message: `restored picture: ${error instanceof Error ? error.message : String(error)}` };
      return false;
    }
    // A pick holds the restored scene behind the disk menu with no message. The original's load message is up for one VBL (erased at
    // the next, `$84F4`); the remake models no such frame (game-proper.md, "Load success message").
    this.acceptScene(save.scenario, scene, null, pick, null);
    return true;
  }

  update(input: Input): void {
    const mapBeforeUpdate = this.map;
    const stageBeforeUpdate = this.stage;
    this.bootPointerFrame = false;
    if (this.gameProperPointer) this.pointerVisible = true;
    const pointer = this.pointerPoint(input.pointerX, input.pointerY);
    input = { ...input, pointerX: pointer.x, pointerY: pointer.y };
    switch (this.stage) {
      case "intro":
        // Track 3 is the boot stage's own module (`$3C3`-`$4AC`), started by the intro at the end of the title fade-in (`$78614`-`$78654`).
        if (this.intro.update(input) === "clicked") {
          this.language = new LanguageScene(this.disk1, this.intro.screen);
          this.stage = "language";
        }
        break;
      case "language": {
        // The boot sprite value before the update is the one the chosen frame shows: a button already down at the poll leaves it off
        // (text.md, "Pointer visibility"). The arrow only comes on from the next update, with the game proper's loop. During the
        // 45-update fade-out after the choice the scene reads no input and the pointer stays off.
        this.pointerVisible = this.language!.pointerVisible;
        this.bootPointerFrame = this.pointerVisible;
        const result = this.language!.update(input);
        if (result.state === "chosen") {
          // The scene returns the choice once, when its fade-out ends. The boot stages (B to G) start in this same update, as the
          // original's `$7875C` follows the fade-out without a wait; the boot disk menu opens when they end (`case "boot"`).
          this.selectedLanguage = result.language;
          this.strings = new GameStrings(this.disk1, result.language as Language);
          const { screen, picturePalette } = this.language!;
          this.language = null;
          this.boot = new BootStages(this.disk1, result.language, screen, picturePalette!, {
            expansionMemory: WHDLOAD_EXPANSION_MEMORY,
            audio: this.music,
          });
          this.stage = "boot";
          this.boot.start();
        }
        break;
      }
      case "boot": {
        // The boot sprite is off for the whole boot stage (text.md, "Pointer visibility"): no arrow is drawn.
        this.pointerVisible = false;
        if (this.boot!.update(input) === "done") {
          this.boot = null;
          this.gameProperPointer = true;
          // The game proper starts here (`$157AE` -> `$7E52`). The boot ramp has already stopped track 3; nothing is faded here.
          this.openDiskMenu();
        }
        break;
      }
      case "map": {
        // F1-F6 are not read here: MapScene.poll takes them on the next completed pass and calls windowKey (see there).
        this.updateMap(this.map!, input);
        break;
      }
      case "screen": {
        const map = this.map!;
        map.screen.pixels.set(this.frozen!);
        const result = this.window!.update(input);
        if (result === "close") {
          this.window = null;
          this.frozen = null;
          this.returnToMap();
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
        // The dialog is drawn over the frame shown before it (`frozen`, as for a window), so it never builds on its own last draw.
        map.screen.pixels.set(this.frozen!);
        this.offer!.draw(map.screen);
        const answer = this.offer!.update(input);
        if (answer !== null) {
          map.sim.resolveOffer(answer);
          this.offer = null;
          // The dialog's panel must not stay on the displayed frame until the next pass: leaving restores the frame before it
          // (the window close does the same), so the first map frame after the answer has no dialog pixels.
          map.screen.pixels.set(this.frozen!);
          this.frozen = null;
          this.returnToMap();
        }
        break;
      }
      case "announce": {
        if (this.announce!.update(input)) {
          this.announce = null;
          if (this.announcements.length > 0) this.startAnnouncement();
          else this.returnToMap();
        }
        break;
      }
      case "disk":
      case "scenario": // the scenario list open on the disk picture (mode 3); its icons and rows are the disk menu's
        this.handleDiskMenu(input);
        break;
      case "remake": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        // Remake pages are silent (no `$5948` call exists for them, notes/formats/sfx.md).
        if (choice === 0) {
          if (this.saveRefusal() === null) this.openMenu("save", SAVE_TITLE, this.slotLabels());
        } else if (choice === 1) this.openMenu("load", LOAD_TITLE, this.slotLabels());
        else if (choice === 2) { // the remake submenu's entry: the disk picture with the list open, no icon wait, nothing pending
          this.openDiskMenu();
          this.openScenarioList(false);
        }
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
        // The page's own choices (rows, EXIT, right click) are read for their edges only while a name is being entered: the name step
        // takes the keys, the left click and the right click, and no row or EXIT can be chosen under it.
        const choice = this.menu!.update(input);
        if (this.nameEntry !== null) {
          this.updateSaveName(input);
          break;
        }
        if (choice === null) break;
        if (choice === PAGE_EXIT_ROW) this.exitFromPage();
        else if (choice >= 0 && choice < SAVE_SLOTS) this.chooseSaveSlot(choice);
        else this.leaveDiskPage(); // remake right click: back (the list comes back when icon 0 opened the page from it)
        break;
      }
      case "load": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        if (choice === PAGE_EXIT_ROW) this.exitFromPage();
        else if (choice >= 0 && choice < SAVE_SLOTS) {
          if (!this.loadFromSlot(choice, true)) this.refuseLoad(choice, this.lastLoadError!);
        } else this.leaveDiskPage(); // remake right click: back (the list comes back when icon 1 opened the page from it)
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
            if (this.saveToSlot(failed.slot, failed.name)) {
              this.closeSlotError();
              this.returnFromSave();
            } else this.openSlotErrorMenu("save", failed.slot, this.lastSaveError!);
          } else if (this.loadFromSlot(failed.slot, true)) this.closeSlotError();
          else if (this.lastLoadError!.code === "empty") {
            // The record went empty since the error (only possible if storage changed meanwhile): the load list comes back with `$143`.
            this.closeSlotError();
            this.openMenu("load", LOAD_TITLE, this.slotLabels());
            this.refuseLoad(failed.slot, this.lastLoadError!);
          } else this.openSlotErrorMenu("load", failed.slot, this.lastLoadError!);
        } else if (action === 1) {
          this.closeSlotError();
          this.openMenu(failed.op, failed.op === "save" ? SAVE_TITLE : LOAD_TITLE, this.slotLabels());
        } else if (action === 2) {
          this.closeSlotError();
          this.openDiskMenu();
        } else if (action === 3) {
          // BACK TO DISK MENU for a save and a load alike (see openSlotErrorMenu): the loop continues, nothing is exited.
          this.closeSlotError();
          this.leaveDiskPage();
        }
        break;
      }
    }

    // The original leaves the boot/scenario menu and runs `$157BC` before returning to its display loop. A newly
    // selected scenario or tutorial therefore consumes its immediate first pass before the browser presents the map.
    // Keep the menu click out of `$50B2`: the original menu poll already consumed that input. A disk-menu exit into the map
    // counts too: a held scene changes the map object, an in-game icon exit keeps it, so the stage change is what matters.
    const exitedDiskPage = stageBeforeUpdate === "disk" || stageBeforeUpdate === "scenario" || stageBeforeUpdate === "save" || stageBeforeUpdate === "load";
    if (this.stage === "map" && this.map && (this.map !== mapBeforeUpdate || exitedDiskPage) &&
      this.map.loop.immediatePassPending) {
      // The keys are the real batch, not `[]`: the disk menu never drains `input.keys`, so a key typed in the menu is still
      // in the cell when the exit returns (`$802C` rts, `$15AEC` `$15EF0`, rts to `$158B0`, `bra $158C2`, `bsr $15B4A`: the same iteration reads it).
      // Passing the batch here folds it into the key cell before this update's immediate pass polls (Disk.1 static trace).
      this.updateMap(this.map, {
        leftButton: false,
        rightButton: false,
        pointerX: input.pointerX,
        pointerY: input.pointerY,
        keys: input.keys,
      });
    }
  }

  private updateMap(map: MapScene, input: Input): void {
    map.update(input);
    for (const event of map.sim.events.splice(0)) {
      if (event.kind === "invention") map.announceInvention(event.bit);
      if (event.kind === "announce") this.announcements.push(event.id);
    }
    if (this.announce === null && this.announcements.length > 0) this.startAnnouncement();
    if (map.sim.pending && !this.announce && this.stage === "map") {
      this.frozen = map.screen.pixels.slice(); // the frame the dialog covers (restored when it closes, case "offer")
      this.offer = new OfferScene(this.disk1, this.strings!, map.sim.pending.offer);
      this.stage = "offer";
    }
  }

  // The next queued announcement ($E770) over the current map frame.
  private startAnnouncement(): void {
    const id = this.announcements.shift()!;
    this.announce = new AnnounceScene(this.disk1, this.strings!, this.map!.screen, id, () => this.sfx?.play(SFX.CLICK));
    this.stage = "announce";
  }

  /**
   * Back to the map view, except in a game over: then the disk menu. The original's game-over paths (`$B0B0` for `$B086`, and
   * `$10E0A` for the unrest colony fall) call `$E770`, set `$156AA` bit 3 and `jmp $157AE`; `$157AE` opens the disk menu (`$7E52`)
   * and its exit is refused while bit 3 is set, so the map loop is not entered again (notes/formats/game-proper.md, "Game over").
   */
  private returnToMap(): void {
    if (this.map?.sim.gameOver) {
      this.diskMenuFromTail = true; // `$157AE` opened the menu: its exit returns through `$157B4`
      this.map.sim.enterDiskMenu(); // `$157AE` -> `$7E52`: a fresh entry (`$7ECA` exchanges while bit 6 is set)
      this.openDiskMenu();
    } else {
      this.diskMenuFromTail = false;
      this.stage = "map";
    }
  }

  /** A map icon's disk menu (`$15AE6` -> `$7E52`): its exit returns through `$15AEC`, so no apparition. */
  private openMapDiskMenu(): void {
    this.map?.sim.enterDiskMenu(); // `$7E52` entry: `$7ECA` exchanges while bit 6 is set
    this.diskMenuFromTail = false;
    this.openDiskMenu();
  }

  // Back from a menu. A menu page inside the disk menu returns to the disk menu's loop (no entry, no exit). The loop itself ends
  // with `$802C`, the exit, which returns to the map unless a game over refuses it (the loop then continues, as on the original).
  private closeMenu(): void {
    this.menu = null;
    this.diskMenu = null;
    // A held scene (scenario pick, load) waits behind the disk menu: `this.map` is the old scene until the exit enters the held one.
    if (this.map === null || this.heldScene !== null) {
      this.openDiskMenu();
      return;
    }
    if (this.map.sim.gameOver) {
      this.diskMenuFromTail = true; // the tail's loop continues (its exit is refused while bit 3 is set)
      this.openDiskMenu();
      return;
    }
    this.map.sim.leaveDiskMenu(); // `$802C`: the exit of the disk menu, before the map returns
    this.diskMenuFromTail = false;
    this.stage = "map";
  }
}
