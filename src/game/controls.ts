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
import { flipButtonPixels } from "./screens/ui.js";
import type { World } from "./world.js";

const VIEW_CELLS = 8;

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
export const BUTTON = { build: 0, overview: 1, demolish: 2, marker: 3, trade: 4, council: 5, staff: 6, intel: 7, disk: 8, pause: 9 } as const;

const INVENTION = 0x14472;
const NAME_STRING = 0x10; // type entry +$10: string index of the building name
const COST = 6;

export class Controls {
  mode: Mode = "select";
  selection: Placement | null = null;
  private menuOpen = false;
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
      if (leave) this.mode = "select";
    };
  }

  get menuVisible(): boolean {
    return this.menuOpen;
  }

  // Read-only view of the open menu's state (page, pending item, detail lines) for tests and tools.
  get menuState(): { page: number; pending: Placement | null; detail: MenuDetail | null } {
    return { page: this.page, pending: this.pending ? { ...this.pending } : null, detail: this.detail ? { ...this.detail } : null };
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

  // Returns true when the click was used by the interface (the scroll arrows are handled by the map).
  update(input: Input): boolean {
    const pressed = input.leftButton && !this.wasDown;
    const released = !input.leftButton && this.wasDown;
    const rightPressed = input.rightButton && !this.wasRight;
    this.wasDown = input.leftButton;
    this.wasRight = input.rightButton;

    if (this.menuOpen) {
      // The build-menu loop `$B3E0-$B40C` has no right-button branch; the right-click cancel is a remake convenience.
      if (rightPressed) {
        this.menuOpen = false;
        this.pressedButton = -1;
      } else if (pressed) this.menuPress(input.pointerX, input.pointerY);
      else if (released) this.menuRelease();
      return true;
    }
    // `$15F44`: a right click does nothing while paused (`$15F64`); otherwise it leaves build / demolish mode (`$15EF0`).
    if (rightPressed && this.mode !== "select" && !this.isPaused()) {
      this.mode = "select";
      this.selection = null;
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
    } else if (button === BUTTON.demolish) {
      this.mode = this.mode === "demolish" ? "select" : "demolish";
      this.selection = null;
    } else if (button === BUTTON.overview) {
      this.onScreen("overview");
    } else if (button === BUTTON.marker) {
      this.onMarkerButton();
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

  // `$B41A-$B43E`: a press on one of the ten command buttons runs `$5756` (flip + id 4) and nothing else; the action waits
  // for the release (`menuRelease`). Only when no button was hit are the page's item rectangles tested (`$B440`).
  private menuPress(px: number, py: number): void {
    const button = this.buttonAt(px, py);
    if (button >= 0) {
      this.onClick(); // $B438 -> $5756 requests id 4 for command-column button presses.
      this.pressedButton = button;
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
    if (button < 0) return;
    this.pressedButton = -1;
    if (button === 8) {
      this.page = (this.page + 1) % MENU_PAGE_COUNT;
    } else if (button === 9) {
      // `$B406` -> `$B628`: the exit button leaves the modal loop and returns the pending item (`$142AA`), which
      // `$6BA2` makes the build selection (mode 2). With no pending item `$6BA2` branches to `$15EF0`: mode 1
      // (select) and the selection cleared.
      this.menuOpen = false;
      if (this.pending) {
        this.selection = this.pending;
        this.mode = "build";
        this.say(this.world.state.word(this.world.typeAddress(this.pending.type) + NAME_STRING));
      } else {
        this.selection = null;
        this.mode = "select";
      }
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
      if (this.mode === "build" && this.selection) drawBuilding(screen, this.tiles, this.selection.tile, 272, 52);
    }
    // Mode marker: a frame around the active command button.
    const active = this.mode === "build" ? BUTTON.build : this.mode === "demolish" ? BUTTON.demolish : -1;
    if (active >= 0) this.frame(screen, BUTTONS[active].x, BUTTONS[active].y, BUTTON_SIZE, BUTTON_SIZE, COLOR.highlight);
    if (!this.menuOpen) return;

    this.menu().draw(screen, {
      page: this.page,
      researchBits: this.world.state.long(INVENTION),
      selected: this.pending ? this.pending.tile : null,
      detail: this.detail,
      pressed: this.pressedButton,
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
