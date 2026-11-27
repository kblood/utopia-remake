// Input bookkeeping for the browser shell. Pure: the DOM listeners in src/main.ts call these methods.
// Button releases are applied only after the next game update (`afterUpdate`), so a click shorter than one
// frame is still seen. Held keys are tracked so that losing focus can release them.

import { keyUpToken, type Input } from "../game/intro.js";

const LEFT_BUTTON = 0;
const RIGHT_BUTTON = 2;

export class InputState {
  /** The object handed to `game.update`. Fields are changed only through the methods below. */
  readonly input: Input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };

  private releaseLeft = false;
  private releaseRight = false;
  // Keys pressed and not yet released, by KeyboardEvent.key, in press order.
  private readonly held: string[] = [];

  /** A mouse button went down on the canvas. Other buttons are ignored. */
  pressButton(button: number): void {
    if (button === LEFT_BUTTON) this.input.leftButton = true;
    if (button === RIGHT_BUTTON) this.input.rightButton = true;
  }

  /** A mouse button went up anywhere. The release takes effect after the next `afterUpdate`. */
  releaseButton(button: number): void {
    if (button === LEFT_BUTTON) this.releaseLeft = true;
    if (button === RIGHT_BUTTON) this.releaseRight = true;
  }

  /** Applies pending button releases. Call once after each `game.update`. */
  afterUpdate(): void {
    if (this.releaseLeft) this.input.leftButton = false;
    if (this.releaseRight) this.input.rightButton = false;
    this.releaseLeft = false;
    this.releaseRight = false;
  }

  /**
   * A key went down. `token` is the entry pushed into `input.keys` (for example a keypad token); `key` is the
   * KeyboardEvent.key used to match the release. Callers ignore auto-repeat before calling this.
   */
  keyDown(key: string, token: string = key): void {
    if (!this.held.includes(key)) this.held.push(key);
    this.input.keys?.push(token);
  }

  /** A key went up. Pushes the release entry, as the original stores releases in the same key cell. */
  keyUp(key: string): void {
    const at = this.held.indexOf(key);
    if (at >= 0) this.held.splice(at, 1);
    this.input.keys?.push(keyUpToken(key));
  }

  /**
   * The window lost focus: both buttons are released at once, and every held key gets its release entry, in press order.
   * Releases pending from earlier mouseups are dropped because the buttons are already up.
   */
  blur(): void {
    this.input.leftButton = false;
    this.input.rightButton = false;
    this.releaseLeft = false;
    this.releaseRight = false;
    for (const key of this.held.splice(0)) this.input.keys?.push(keyUpToken(key));
  }

  /** Keys currently held, in press order (a copy). */
  heldKeys(): string[] {
    return [...this.held];
  }

  setPointer(x: number, y: number): void {
    this.input.pointerX = x;
    this.input.pointerY = y;
  }
}
