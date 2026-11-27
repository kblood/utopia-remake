// Mouse handling on the map screen: cell picking ($5CDA), the command button column ($5E06
// rectangles, dispatch $15A74), build / demolish modes ($14591 = 2 / 3) and the build menu's
// original page/item selection mapping ($B2AA). The menu panel itself is drawn by build-menu.ts from the same
// page data. Notes: notes/formats/map-rendering.md section 8 and 9, notes/formats/building.md.

import { COLOR } from "../data/gamefont.js";
import type { GameStrings } from "../data/gamestrings.js";
import { MAP_HEIGHT, MAP_WIDTH, type Tile } from "../data/scenario.js";
import type { Screen } from "../gfx/screen.js";
import type { Builder, Placement } from "./build.js";
import { BuildMenuRenderer, MENU_PAGE_COUNT, drawBuilding, menuHitIndex, menuTiles, type MenuDetail } from "./build-menu.js";
import type { Input } from "./intro.js";
import { MousePoll } from "./screens/mouse-poll.js";
import { Ui, flipButtonPixels } from "./screens/ui.js";
import type { World } from "./world.js";

const VIEW_CELLS = 8;
// Events one `$B3D8` pass can carry. Two is the most one set of button states produces (a left press with the right already
// down: the press, then the right re-press); the bound only stops a loop from running away.
const MENU_EVENTS_PER_PASS = 4;

export type Mode = "select" | "build" | "demolish";

// Command buttons in the original's table order ($5E06): index = d2 of the icon dispatch.
const BUTTONS: { x: number; y: number }[] = [
  { x: 272, y: 63 },
  { x: 296, y: 63 },
  { x: 272, y: 82 },
  { x: 296, y: 82 },
  { x: 272, y: 101 },
  { x: 296, y: 101 },
  { x: 272, y: 120 },
  { x: 296, y: 120 },
  { x: 296, y: 139 },
  { x: 272, y: 139 },
];
const BUTTON_SIZE = 16;
// Image table of the map's command buttons (`$5DDA`, ten longs). `$B628` (the build-menu exit) draws the buttons from it with
// `$58A0`/`$5876` into the displayed bitmaps (static trace, Disk.1 `$B638`-`$B63E`). The images match the picture's blank
// buttons in the interior but not on the 16 x 16 edge ring (building.md, "Right panel, part 2"): the ring is the image's.
export const MAP_BUTTON_IMAGE_TABLE = 0x5dda;
// Mode icon at the top right, drawn by `$6B10` (bottom row 52, x 272) with 1-based tile ids: `$15EF0` draws `$39` for select
// mode (`$14591` = 1), which the map entry `$157B4` also runs before the first pass, and `$15ECA` draws `$3A` for demolish
// mode (`$14591` = 3). Static trace of Disk.1 (map-rendering.md section 9); the `$39` pixels match the copy in the
// Copperline capture exactly (map-rendering.md section 11). The build-mode preview uses the same position.
export const MODE_ICON = { x: 272, bottomRow: 52, select: 0x39, demolish: 0x3a } as const;
export const BUTTON = { build: 0, overview: 1, demolish: 2, marker: 3, trade: 4, council: 5, staff: 6, intel: 7, disk: 8, pause: 9 } as const;

const INVENTION = 0x14472;
const NAME_STRING = 0x10; // type entry +$10: string index of the building name
// String 0, "Click on map to choose a site.": posted by `$6BA2` (`moveq #0,d0` / `bsr $551a`) after a build selection is
// committed and drawn (`$6B10`). Static trace of Disk.1; the snap-D Copperline capture shows it on the message line in build mode.
const BUILD_SITE_PROMPT = 0;
const COST = 6;

export class Controls {
  mode: Mode = "select";
  selection: Placement | null = null;
  private menuOpen = false;
  // Set by a mode or selection change that the original paints at once: `$6B10` writes the icon into both bitmaps when
  // `$15EF0`, `$15ECA`, `$30FE` or the build commit `$6BA2` runs (static trace, map-rendering.md section 9). MapScene reads
  // it with `takeModeIconChanged()` and redraws the panel in the same frame instead of waiting for the next pass.
  private modeIconChanged = false;
  // Set by the input paths whose message the original draws at once with `$551A` or `$552C`: the marker button (`$30FE` posts `$6F`),
  // the money refusals (`$25`, placing with `$15EF0` or clearing ground with `$6D2C`), the marker pins (`$311E` and keys 1-8, messages
  // `$70`-`$72`) and key D (`$31CC`, message `$F2`). MapScene reads it with `takeMessageLineChanged()` and redraws only the message line
  // in the same frame (map-rendering.md section 9, game-text.md section 4). MapScene sets the pin and key-D cases through
  // `markMessageLineChanged()`, because those handlers live in map.ts. The build-menu commit with a pending item also posts
  // string 0 with `$551A` (Disk.1 `$6BD2`), so it sets this flag too.
  private messageLineChanged = false;
  // Set by a clearing refusal (`$6D10` -> `$6D2C`): the selection is dropped and the mode stays build, so the preview is gone
  // from the frame of the click (`$6ACE` restores its rows before the message). MapScene reads it with
  // `takeBuildPreviewCleared()` (map-rendering.md section 9).
  private buildPreviewCleared = false;
  // Set by the menu exit (`$B628`). Once set, the command-button column shows the `$5DDA` images until the bitmap is rebuilt
  // from the picture (boot only, `$4E28`). A scene that replaces this one through a disk-menu route starts with it set
  // (`MapSceneOptions.commandButtonImagesFromTable`, game.ts `sceneOptions`).
  private buttonImagesFromTable = false;
  private buttonImages: Ui | null = null;
  private page = 0;
  // `$142AA`: the item picked inside the open menu. It starts as the previous selection (`$B386` copies `$142B2`),
  // is replaced by an affordable click, cleared by an unaffordable one and committed by the exit button.
  private pending: Placement | null = null;
  // The lines under the item grid (`$B512`): shown only after a click on an item inside this menu session.
  private detail: MenuDetail | null = null;
  private renderer: BuildMenuRenderer | null = null;
  private wasDown = false;
  private wasRight = false;
  // `$5DD4`: the command button `$5756` pressed and `$57FA` has not released yet (-1 = none). Buttons act on the release edge
  // of the left button (`$50B2` returns 0 on it, the main loop then runs `$15A74`; the build-menu loop `$B3F2-$B40A`), with this
  // index and not the pointer position at that moment. The pause button keeps its index while paused (`$15A88-$15A90`).
  private pressedButton = -1;
  // The build menu's own `$50B2` state (the `$B3D8` loop polls it once per pass; its left and right bits are `$156A8` 3 and 6).
  private readonly menuPoll = new MousePoll();
  // XOR state of each command button's image in the open menu's column. `$5756` flips the button on every press, a repeated
  // press included; `$57FA` flips the button `$5DD4` names back on the release. The column is drawn fresh when the menu opens
  // (`$B36C` -> `$58A0`), so every flip starts at zero.
  private menuFlips: boolean[] = BUTTONS.map(() => false);
  // Opens a window screen for icon buttons 4 (trade), 6 (staffing) and 7 (intelligence).
  onClick: () => void = () => {};
  // Button 9 is the pause button: its image is table entry 9 of `$5DDA` (`$18462`), and `$159B8-$159C4` set `$156A9` bit 2
  // after `$5756`, i.e. on the PRESS (not the release). While paused a press on it goes `$15996-$159A6` -> `$159FC` (resume,
  // also on the press) and never reaches `$5756`; the release then only flips the button back (`$57FA`).
  isPaused: () => boolean = () => false;
  onPause: () => void = () => {};
  onScreen: (kind: "trade" | "staff" | "intel" | "overview" | "council") => void = () => {};
  // Button 3 arms marker mode; the hook gets the next map cell click first and returns true when it used it.
  onMarkerButton: () => void = () => {};
  cellHook: (x: number, y: number) => boolean = () => false;
  // Select mode: a click on a map cell (the building click dispatch, $7140).
  onSelect: (x: number, y: number) => void = () => {};

  constructor(
    private readonly disk: Uint8Array,
    private readonly world: World,
    private readonly builder: Builder,
    private readonly strings: GameStrings,
    private readonly say: (message: number) => void,
    private readonly view: () => { x: number; y: number },
    private readonly onDiskMenu: () => void = () => {},
    // Decoded tile images (index = tile id - 1) for the build menu artwork; without them the panel has no pictures.
    private readonly tiles: readonly Tile[] = [],
  ) {
    builder.onBuildCancelled = (leave) => {
      this.selection = null;
      // Both money refusals post `$25` before this callback: placing (`leave` true, build.ts `place`) and clearing ground (`$6D2C`,
      // `leave` false, build.ts `clearGround`). `$551A` draws the line at once either way.
      this.messageLineChanged = true;
      if (leave) {
        this.mode = "select";
        this.modeIconChanged = true; // `$15EF0` from the money refusal (build.ts `place`); `$6D2C` (leave false) runs no icon draw
      } else this.buildPreviewCleared = true; // `$6D10` -> `$6ACE` -> `$6D2C`: the preview's rows are restored at once
    };
  }

  get menuVisible(): boolean {
    return this.menuOpen;
  }

  /** True after a build-menu exit (`$B628`), when the command-button column is the `$5DDA` image set (see `drawCommandButtonImages`). */
  get commandButtonImagesFromTable(): boolean {
    return this.buttonImagesFromTable;
  }

  /**
   * Presentation staging for a closed-menu frame after an exit that already happened (no pass, input or RNG): sets the same
   * state `menuRelease` sets on the exit button. Used by the capture comparator, and by a scene that a disk-menu route builds
   * after an earlier exit (`MapSceneOptions.commandButtonImagesFromTable`; static trace, building.md "Right panel, part 2").
   */
  markMenuExitButtonImages(): void {
    this.buttonImagesFromTable = true;
  }


  /** Draws the ten command buttons from the map's image table `$5DDA` (`$58A0`, no flip) into `screen`. */
  drawCommandButtonImages(screen: Screen): void {
    this.buttonImages ??= new Ui(this.disk, this.strings);
    this.buttonImages.drawButtons(screen, this.buttonImages.readButtonTable(MAP_BUTTON_IMAGE_TABLE));
  }

  // Read-only view of the open menu's state (page, pending item, detail lines, command buttons whose image is flipped) for
  // tests and tools.
  get menuState(): { page: number; pending: Placement | null; detail: MenuDetail | null; flipped: number[] } {
    return {
      page: this.page,
      pending: this.pending ? { ...this.pending } : null,
      detail: this.detail ? { ...this.detail } : null,
      flipped: this.menuFlips.flatMap((on, i) => (on ? [i] : [])),
    };
  }

  // $5CDA: first of the 72 overlapping rectangles that contains the pointer wins.
  pickCell(px: number, py: number): { x: number; y: number } | null {
    const origin = this.view();
    for (let vy = 0; vy < VIEW_CELLS; vy++) {
      for (let vx = 0; vx < VIEW_CELLS; vx++) {
        const x0 = 112 + 16 * (vx - vy);
        const y0 = 24 + 8 * (vx + vy);
        if (px >= x0 && px <= x0 + 31 && py >= y0 && py <= y0 + 14) {
          const x = origin.x + vx;
          const y = origin.y + vy;
          return x < MAP_WIDTH && y < MAP_HEIGHT ? { x, y } : null;
        }
      }
    }
    return null;
  }

  buttonAt(px: number, py: number): number {
    return BUTTONS.findIndex((b) => px >= b.x && px < b.x + BUTTON_SIZE && py >= b.y && py < b.y + BUTTON_SIZE);
  }

  private pageTiles(page: number): number[] {
    return menuTiles(page, this.world.state.long(INVENTION));
  }

  private typeOf(tile: number): number {
    try {
      return this.world.findType(tile);
    } catch {
      return -1;
    }
  }

  /**
   * The mode part of `$15EF0` (static trace, Disk.1): `$14591` = 1 (select) and the selection `$142B2/$142B6` is cleared. The mode
   * icon is not stored: `draw` paints the icon of the mode each frame (`$39` for select). Callers are the right click outside the
   * arrows (`$15F64`), a build-menu exit with nothing pending (`$6BA2`), the marker button outside select mode (`$30FE`), a money
   * refusal while placing (`build.ts`, `$15EF0`) and the in-game disk icon's EXIT (`$15AEC`, game.ts).
   */
  returnToSelectMode(): void {
    this.mode = "select";
    this.selection = null;
    this.modeIconChanged = true;
  }

  /** Reads and clears the mode-icon flag (see `modeIconChanged`): true once after each change the original paints at once. */
  takeModeIconChanged(): boolean {
    const changed = this.modeIconChanged;
    this.modeIconChanged = false;
    return changed;
  }

  /** Sets the message-line flag for a poll-time message drawn at once by the original (MapScene's pin and key-D paths). */
  markMessageLineChanged(): void {
    this.messageLineChanged = true;
  }

  /** Reads and clears the message-line flag (see `messageLineChanged`): true once after a marker press or a money refusal. */
  takeMessageLineChanged(): boolean {
    const changed = this.messageLineChanged;
    this.messageLineChanged = false;
    return changed;
  }

  /** Reads the message-line flag without clearing it (MapScene asks before `takeMessageLineChanged()` in the modal exit). */
  peekMessageLineChanged(): boolean {
    return this.messageLineChanged;
  }

  /** Reads and clears the clearing-refusal flag (see `buildPreviewCleared`): true once after a `$6D2C` refusal. */
  takeBuildPreviewCleared(): boolean {
    const cleared = this.buildPreviewCleared;
    this.buildPreviewCleared = false;
    return cleared;
  }

  /**
   * The tile `draw` paints at the mode icon position (`$6B10`, bottom row 52): the committed building in build mode, the select or
   * demolish icon otherwise. Null when nothing is painted there (build mode with no selection, or the menu is open).
   */
  private modeTileId(): number | null {
    if (this.menuOpen) return null;
    if (this.mode === "build") return this.selection ? this.selection.tile : null;
    return this.mode === "select" ? MODE_ICON.select : MODE_ICON.demolish;
  }

  // Returns true when the click was used by the interface (the scroll arrows are handled by the map).
  // `rightOnArrow`: the right press is on a scroll arrow; `$15F44` scrolls there first and never reaches `$15EF0`.
  update(input: Input, rightOnArrow = false): boolean {
    if (this.menuOpen) {
      this.pollMenu(input);
      return true;
    }
    const pressed = input.leftButton && !this.wasDown;
    const released = !input.leftButton && this.wasDown;
    const rightPressed = input.rightButton && !this.wasRight;
    this.wasDown = input.leftButton;
    this.wasRight = input.rightButton;

    // `$15F44`: a right click does nothing while paused (`$15F64`); otherwise it leaves build / demolish mode (`$15EF0`).
    if (rightPressed && this.mode !== "select" && !this.isPaused() && !rightOnArrow) {
      this.returnToSelectMode();
      return true;
    }
    if (released) {
      const had = this.pressedButton >= 0;
      this.release(); // `$15A74`: runs on every release edge wherever the pointer is.
      return had;
    }
    // A stale pause press (`$5DD4` = 9) is dropped once the pause was left by key (`$15C02` -> `$159FC` + `$57FA`).
    if (this.pressedButton === BUTTON.pause && !input.leftButton && !this.isPaused()) this.pressedButton = -1;
    if (!pressed) return false;

    const button = this.buttonAt(input.pointerX, input.pointerY);
    if (button >= 0) {
      if (button === BUTTON.pause && this.isPaused()) {
        // `$15996-$159A6` -> `$159FC`: resuming is silent, takes effect on the press, and `$5DD4` = 9 awaits the release.
        this.pressedButton = BUTTON.pause;
        this.onPause();
        return true;
      }
      this.onClick(); // `$159B2` -> `$5756`: every other press of the ten buttons (blank ones too) requests id 4.
      this.pressedButton = button;
      if (button === BUTTON.pause) this.onPause(); // `$159B8-$159C4`: the pause bit is set on the press
      return true;
    }
    const cell = this.pickCell(input.pointerX, input.pointerY);
    if (!cell) return false;
    // `$158D4`: while paused a click on a map cell does nothing (no marker, selection, placement or demolition).
    if (this.isPaused()) return true;
    if (this.cellHook(cell.x, cell.y)) return true;
    if (this.mode === "build" && this.selection) this.builder.place(this.selection, cell.x, cell.y);
    else if (this.mode === "demolish") this.builder.demolish(cell.x, cell.y);
    else if (this.mode === "select") this.onSelect(cell.x, cell.y);
    return true;
  }

  // `$15A74-$15B48` (static trace): runs for the button `$5756` recorded. The pause button stays pressed while paused. `$57FA`
  // flips the button back, then overview (1, `$F176`) runs even while paused; every other action is skipped while paused
  // (`$15AB4-$15ABC`) and button 9 never dispatches anything.
  private release(): void {
    const button = this.pressedButton;
    if (button < 0) return;
    if (button === BUTTON.pause && this.isPaused()) return;
    this.pressedButton = -1;
    if (button === BUTTON.overview) this.press(button);
    else if (button !== BUTTON.pause && !this.isPaused()) this.press(button);
  }

  private press(button: number): void {
    if (button === BUTTON.build) {
      this.menuOpen = true;
      this.pending = this.mode === "build" ? this.selection : null;
      this.detail = null;
      // The build command opens the menu on its release, and that release cleared both button bits (`$50D0`): the
      // menu's first poll starts from neither button held.
      this.menuPoll.start(false, false);
      this.menuFlips = BUTTONS.map(() => false);
    } else if (button === BUTTON.demolish) {
      // `$15AF8` -> `$15ECA`: sets demolish mode (3) without a test of the current mode, clears the selection and paints the icon
      // at once. A second press therefore keeps demolish mode; the remake used to toggle back to select (static trace, Disk.1).
      this.mode = "demolish";
      this.selection = null;
      this.modeIconChanged = true;
    } else if (button === BUTTON.overview) {
      this.onScreen("overview");
    } else if (button === BUTTON.marker) {
      // `$15B0A` -> `$30FE`: outside select mode `$15EF0` runs first (select mode, selection cleared, icon at once), then the
      // marker-armed message `$6F` is posted (the same string `MarkerMode.arm` returns).
      if (this.mode !== "select") this.returnToSelectMode();
      this.onMarkerButton();
      this.messageLineChanged = true; // `$551A` draws `$6F` at once (MapScene presents only the message line)
    } else if (button === BUTTON.council) {
      this.onScreen("council");
    } else if (button === BUTTON.trade) {
      this.onScreen("trade");
    } else if (button === BUTTON.staff) {
      this.onScreen("staff");
    } else if (button === BUTTON.intel) {
      this.onScreen("intel");
    } else if (button === BUTTON.disk) {
      this.onDiskMenu();
    }
  }

  // The build-menu loop `$B3D8-$B40C` (static trace of Disk.1): each video update runs one `$50B2` pass through `menuPoll`,
  // repeating while it reports events, and branches on the left bit after each event as `$B3E8` does. Left held (`$B41A`): a
  // press at the pointer, which includes a right press made while the left button is held. Left up (`$B3F2`): the release
  // branch, which acts only on a pending command button (`$5DD4` >= 0); a right press alone therefore does nothing.
  // The pass ends when the menu closes: the release that closed it cleared the right bit too (`$50D0`), so a right button
  // still held is seen as a new press by the map on its next pass (`update`, `wasRight` below).
  private pollMenu(input: Input): void {
    for (let events = 0; events < MENU_EVENTS_PER_PASS && this.menuOpen; events++) {
      if (!this.menuPoll.poll(input.leftButton, input.rightButton)) break;
      if (this.menuPoll.isLeftHeld) this.menuPress(input.pointerX, input.pointerY);
      else this.menuRelease();
    }
    this.wasDown = this.menuPoll.isLeftHeld;
    this.wasRight = this.menuPoll.isRightHeld;
  }

  // `$B41A-$B43E`: a press on one of the ten command buttons runs `$5756` (flip + id 4) and nothing else; the action waits
  // for the release (`menuRelease`). Only when no button was hit are the page's item rectangles tested (`$B440`).
  private menuPress(px: number, py: number): void {
    const button = this.buttonAt(px, py);
    if (button >= 0) {
      this.onClick(); // $B438 -> $5756 requests id 4 for command-column button presses, every time it runs.
      this.pressedButton = button; // `$5756` stores the index in `$5DD4` (the last press wins).
      this.menuFlips[button] = !this.menuFlips[button]; // `$5756` flips the image: XOR, so a repeated press flips it back.
      return;
    }
    // `$B440-$B546`: a click outside the menu's item rectangles is ignored. A matching rectangle's
    // index selects the tile at that same index in the current page list.
    const index = menuHitIndex(this.page, px, py);
    if (index < 0) return;
    const tile = this.pageTiles(this.page)[index];
    if (tile === undefined || tile < 0) return;
    const type = this.typeOf(tile);
    if (type < 0) return;
    const t = this.world.typeAddress(type);
    const cost = this.world.state.word(t + COST);
    const affordable = cost <= this.world.state.signedLong(0x135ba);
    // `$B512-$B624`: the menu stays open. An affordable item becomes the pending selection; an unaffordable one
    // clears it (`$142AA` = 0) and the panel shows the "can't afford" line next to the item's name and price.
    this.pending = affordable ? { tile, type } : null;
    this.detail = { nameIndex: this.world.state.word(t + NAME_STRING), cost, affordable };
  }

  // `$B3E8-$B40C`: on the release edge `$B3F2` needs a pending `$5DD4`, `$57FA` flips the button back, then button 8 advances
  // the page (`$B45E`, wraps after page 3) and button 9 leaves through `$B628`; buttons 0-7 do nothing.
  private menuRelease(): void {
    const button = this.pressedButton;
    if (button < 0) return; // `$B3F2`: nothing pending, so nothing runs (`$57FA` already cleared `$5DD4` on the last release).
    this.pressedButton = -1; // `$57FA` clears `$5DD4`: a second release cannot dispatch the same button again.
    // `$57FA` flips the image back at the last press's coordinates (`$5DD0`), which hold the same index as `$5DD4`.
    this.menuFlips[button] = !this.menuFlips[button];
    if (button === 8) {
      this.page = (this.page + 1) % MENU_PAGE_COUNT;
    } else if (button === 9) {
      // `$B406` -> `$B628`: the exit button leaves the modal loop and returns the pending item (`$142AA`), which
      // `$6BA2` makes the build selection (mode 2). With no pending item `$6BA2` branches to `$15EF0`: mode 1
      // (select) and the selection cleared.
      this.menuOpen = false;
      // `$B628` tests `$156A8` bit 5 (council-report mode) and otherwise redraws the ten buttons from `$5DDA` (`$B638`).
      // Only the map's menu session reaches here, so the flag is set on every exit.
      this.buttonImagesFromTable = true;
      if (this.pending) {
        this.selection = this.pending;
        this.mode = "build";
        this.modeIconChanged = true; // `$6BA2` -> `$6B10`: the preview is drawn at once
        // `$6BA2` -> `$551A` (string 0) draws the prompt line at once too (`$552C` -> `$54DE`, timer 200). MapScene presents it
        // in the exit frame (`presentMessageLine`), not on the next pass.
        this.messageLineChanged = true;
        this.say(BUILD_SITE_PROMPT);
      } else this.returnToSelectMode(); // `$6BA2` -> `$15EF0`
    }
  }

  // Command button shown flipped (`$57D6`): the one `$5756` pressed and `$57FA` has not flipped back, plus the pause button
  // for as long as the game is paused (the pause press leaves it flipped; `$159FC` / `$57FA` flip it back).
  private flipped(button: number): boolean {
    return button === this.pressedButton || (button === BUTTON.pause && this.isPaused());
  }

  draw(screen: Screen): void {
    if (!this.menuOpen) {
      for (let b = 0; b < BUTTONS.length; b++) if (this.flipped(b)) flipButtonPixels(screen, BUTTONS[b].x, BUTTONS[b].y);
      // `$6B10`, called by `$6BA2` after a build-menu selection is committed: side preview at (272, bottom row 52).
      const tile = this.modeTileId();
      if (tile !== null) drawBuilding(screen, this.tiles, tile, MODE_ICON.x, MODE_ICON.bottomRow);
    }
    // Mode marker: a frame around the demolish command button in demolish mode. Build mode draws no frame: the original's
    // closed-menu build-mode captures show the plain build button at (272, 63) (building.md, "Construction-site frame
    // comparison", frames D and E). No original capture of demolish mode exists, so that frame is still unverified.
    if (this.mode === "demolish") this.frame(screen, BUTTONS[BUTTON.demolish].x, BUTTONS[BUTTON.demolish].y, BUTTON_SIZE, BUTTON_SIZE, COLOR.highlight);
    if (!this.menuOpen) return;

    this.menu().draw(screen, {
      page: this.page,
      researchBits: this.world.state.long(INVENTION),
      selected: this.pending ? this.pending.tile : null,
      detail: this.detail,
      flipped: this.menuFlips,
    });
  }

  private menu(): BuildMenuRenderer {
    return (this.renderer ??= new BuildMenuRenderer(this.disk, this.strings, this.tiles));
  }

  private frame(screen: Screen, x: number, y: number, w: number, h: number, colour: number): void {
    for (let i = 0; i < w; i++) {
      screen.set(x + i, y, colour);
      screen.set(x + i, y + h - 1, colour);
    }
    for (let j = 0; j < h; j++) {
      screen.set(x, y + j, colour);
      screen.set(x + w - 1, y + j, colour);
    }
  }
}
