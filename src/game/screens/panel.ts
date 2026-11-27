// Base class of the window screens: a framed window over the frozen map, the button column with
// the screen's own button images, and the click-to-leave behaviour of $58F8 (a button is shown
// inverted while pressed; releasing it returns its index).

import { SFX } from "../../audio/sfx.js";
import { COLOR } from "../../data/gamefont.js";
import type { Screen } from "../../gfx/screen.js";
import type { Input } from "../intro.js";
import type { GameState } from "../state.js";
import { MousePoll } from "./mouse-poll.js";
import { Pointer, Ui, type Label, type WindowRect } from "./ui.js";
import type { ScreenContext, ScreenScene } from "./types.js";

// Events one frame can carry: a left press, then a right re-press (and a release before them). The poll of `$50B2`
// returns at most two events for one frame of buttons, so the bound only guards against a bad state.
const MAX_POLL_EVENTS = 4;

// Button image tables ($E930 is the default: every button blank, the last one an exit icon).
export const BUTTON_TABLE = {
  default: 0xe930,
  trade: 0xef02,
  market: 0xef50,
} as const;

export abstract class PanelScene implements ScreenScene {
  protected readonly ui: Ui;
  protected readonly state: GameState;
  protected readonly pointer = new Pointer();
  protected pressedButton = -1;
  private buttons: number[];
  private councilMode = false;
  private councilStep: "press" | "release" = "press";
  private readonly mouse = new MousePoll();
  private mouseStarted = false;

  constructor(
    protected readonly ctx: ScreenContext,
    protected window: WindowRect,
    buttonTable: number = BUTTON_TABLE.default,
    ui?: Ui,
  ) {
    this.ui = ui ?? new Ui(ctx.disk, ctx.strings);
    this.state = ctx.world.state;
    this.buttons = this.ui.readButtonTable(buttonTable);
  }

  // Content of the window (labels and values), drawn after the frame.
  protected abstract drawContent(screen: Screen): void;

  // A button was released. Default: any button leaves a report screen.
  protected onButton(_index: number): "running" | "close" {
    return "close";
  }

  // A mouse press that is not on a button (pointer position in this.pointer).
  protected onClick(): void {}

  // Keys of this frame, before the screen leaves on Escape. Return true when they were used.
  protected onKeys(_keys: string[]): boolean {
    return false;
  }

  // True while a sub-dialog (number entry) takes Escape and the right button for itself.
  protected get modal(): boolean {
    return false;
  }

  // Whether Escape and the right mouse button leave the window. Default false: no window of the original leaves on either.
  // Every window screen is traced now: the F1-F6 reports ($B99C -> `$58F8`, reports.ts), the trade, market, staffing and
  // intelligence windows (trade.ts, staff.ts, intel.ts), the order windows (orders.ts, loops $DCDC and $C6EC) and the
  // building windows (buildings.ts, `TracedPanel`). Their loops read neither key nor right button as a leave; the exit
  // button or the window's own leave button closes them. Escape is read only by the number entry `$5110`, which is not a leave.
  // A window that really reads Escape or the right button would override this (none does).
  protected get leavesOnEscapeOrRight(): boolean {
    return false;
  }

  // Whether this window runs one of the traced loops that poll the mouse through `$50B2` (mouse-poll.ts): a right press
  // while the left button is held is a press at the pointer, a release runs the latched button wherever the pointer is,
  // and no key is read. Default true for every window screen (see `leavesOnEscapeOrRight`). The false branch keeps the
  // older edge model (`Pointer`) for a window that has no traced loop; no current window uses it.
  protected get pollsLikeOriginal(): boolean {
    return true;
  }

  // Called when the screen is left (a place for write-backs done on exit).
  protected onClose(): void {}

  // The council room ($15DCE) shows a report without the button column. Its leave is a left click, not a press:
  // `$B99C` with bit 5 of $156A8 set waits with `$2E48` (static trace of Disk.1), which returns on the release of a
  // press and reads no key and no right button. See `updateCouncil`.
  setCouncilMode(on = true): void {
    this.councilMode = on;
    this.councilStep = "press";
  }

  protected setButtonTable(address: number): void {
    this.buttons = this.ui.readButtonTable(address);
  }

  // Council-room report (`$2E48`, the wait of `$B99C` with bit 5 of $156A8 set): the loop waits for a press of the left
  // button, then for its release, and the release leaves. The room opens a report on its own release (council.ts), so
  // the button is up when the report starts and the wait begins with a press, exactly as `$2E48` does. Escape and the
  // right button are not read.
  private updateCouncil(input: Input): "running" | "close" {
    const left = input.leftButton;
    if (this.councilStep === "press") {
      if (left) this.councilStep = "release";
    } else if (!left) {
      this.onClose();
      return "close";
    }
    return "running";
  }

  update(input: Input): "running" | "close" {
    const keys = input.keys ? input.keys.slice() : [];
    if (input.keys) input.keys.length = 0;
    this.pointer.update(input);
    const p = this.pointer;
    if (this.councilMode) return this.updateCouncil(input);
    const used = this.onKeys(keys);
    // Escape and the right mouse button leave only a window that opts in (`leavesOnEscapeOrRight`); no current window does.
    if (!this.modal && !used && this.leavesOnEscapeOrRight && (keys.includes("Escape") || p.rightPressed)) {
      this.onClose();
      return "close";
    }
    if (this.pollsLikeOriginal) return this.pollOriginal(input);
    // A number entry ($5110) reads the key code only: it never polls the mouse ($50B2), never hit-tests ($5730) and never
    // calls $5756, so while one is open a press neither highlights a button, clicks, selects a row nor leaves a release
    // pending for later. (Original detail not reproduced: a button still held when the entry ends is seen as a new press
    // by the next $50B2 if its state bit was clear; here a press during an entry is simply dropped.)
    const modal = this.modal;
    if (p.pressedEdge && !modal) this.pressAtPointer();
    if (p.releasedEdge && this.pressedButton >= 0) {
      const b = this.pressedButton;
      this.pressedButton = -1;
      if (modal) return "running"; // a release seen during an entry must not run the button (it could close the window)
      if (this.onButton(b) === "close") {
        this.onClose();
        return "close";
      }
    }
    return "running";
  }

  // A press at the pointer: a command button is latched and its click sounds ($5756 via `$D8AE`, `$DCFE`, `$C70E`, `$5928`),
  // anything else is the window's own press (icon, pin, row). A press over another button replaces the latch.
  private pressAtPointer(): void {
    const b = this.ui.buttonAt(this.pointer.x, this.pointer.y);
    if (b >= 0) {
      this.pressedButton = b;
      this.ctx.sound?.(SFX.CLICK); // $5756 plays id 4 on the press; the release ($57FA) is silent.
    } else this.onClick();
  }

  // The traced loops: one `$50B2` poll per pass, and each event runs its branch at once. A press (left held after the
  // poll) hit-tests the pointer; a release runs the latched button ($57FA) wherever the pointer is. A number entry owns the
  // loop while it is open: it does not poll, so the mouse state keeps what it was when the entry started.
  private pollOriginal(input: Input): "running" | "close" {
    if (this.modal) return "running";
    if (!this.mouseStarted) {
      this.mouse.start(input.leftButton, input.rightButton, this.ctx.pressLatch?.() ?? false);
      this.mouseStarted = true;
    }
    for (let n = 0; n < MAX_POLL_EVENTS && this.mouse.poll(input.leftButton, input.rightButton); n++) {
      if (this.mouse.isLeftHeld) {
        this.pressAtPointer();
      } else if (this.pressedButton >= 0) {
        const b = this.pressedButton;
        this.pressedButton = -1;
        if (this.onButton(b) === "close") {
          this.onClose();
          return "close";
        }
      }
      // A repeated press (latched scroll) takes one event per update. The map loop polls once per pass; the F-key report loop
      // `$58F8` polls with no VBL wait between repeats, so the original repeats at poll rate (documented limit, screens.md "Window loops").
      if (this.mouse.isRepeat) break;
    }
    return "running";
  }

  draw(screen: Screen): void {
    this.ui.frame(screen, this.window);
    this.drawContent(screen);
    if (this.councilMode) return;
    this.ui.drawButtons(screen, this.buttons);
    if (this.pressedButton >= 0) this.ui.invertButton(screen, this.pressedButton);
  }

  protected labels(screen: Screen, list: Label[], color: number = COLOR.text): void {
    this.ui.labels(screen, list, color);
  }
}
