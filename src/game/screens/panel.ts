// Base class of the window screens: a framed window over the frozen map, the button column with
// the screen's own button images, and the click-to-leave behaviour of $58F8 (a button is shown
// inverted while pressed; releasing it returns its index).

import { COLOR } from "../../data/gamefont.js";
import type { Screen } from "../../gfx/screen.js";
import type { Input } from "../intro.js";
import type { GameState } from "../state.js";
import { Pointer, Ui, type Label, type WindowRect } from "./ui.js";
import type { ScreenContext, ScreenScene } from "./types.js";

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

  // Called when the screen is left (a place for write-backs done on exit).
  protected onClose(): void {}

  // The council room ($15DCE) shows a report without the button column and leaves it on the next left
  // press ($B99C with bit 5 of $156A8 set waits with $2E48 instead of using the buttons).
  setCouncilMode(on = true): void {
    this.councilMode = on;
  }

  protected setButtonTable(address: number): void {
    this.buttons = this.ui.readButtonTable(address);
  }

  update(input: Input): "running" | "close" {
    const keys = input.keys ? input.keys.slice() : [];
    if (input.keys) input.keys.length = 0;
    this.pointer.update(input);
    const p = this.pointer;
    if (this.councilMode) {
      if (keys.includes("Escape") || p.rightPressed || p.pressedEdge) {
        this.onClose();
        return "close";
      }
      return "running";
    }
    const used = this.onKeys(keys);
    // Escape and the right mouse button leave the screen (convenience; the original needs a button).
    if (!this.modal && !used && (keys.includes("Escape") || p.rightPressed)) {
      this.onClose();
      return "close";
    }
    if (p.pressedEdge) {
      const b = this.ui.buttonAt(p.x, p.y);
      if (b >= 0) this.pressedButton = b;
      else this.onClick();
    }
    if (p.releasedEdge && this.pressedButton >= 0) {
      const b = this.pressedButton;
      this.pressedButton = -1;
      if (this.onButton(b) === "close") {
        this.onClose();
        return "close";
      }
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
