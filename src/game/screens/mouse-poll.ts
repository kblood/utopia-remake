// The mouse poll `$50B2` (static trace of Disk.1, 2026-11-10; no emulator run). The window loops of the ship yard `$D886`,
// the ship window `$DCDC`, the tank window `$C6EC`, the build menu `$B3D8`, the read-outs and the F1-F6 reports (`$B99C` ->
// `$58F8`), the overview map `$F208` (`overview.ts`), the trade `$CC8E`, the market `$D106`, the staffing window `$BAAE`, the intelligence window `$E2D2`, the command
// centre `$C0C6`, the hospital `$C280`, the sports complex `$C3DE`, the launcher `$E122` and the teleporter `$CBB4` (which polls
// it directly) call it once per pass and act on its result only: the left button and the right button are tracked as the two
// state bits `$156A8` bit 3 (left held) and bit 6 (right held). No key is read on these paths: a static walk from these loops
// reaches no routine that reads the key cell `$161A0` (the count entry `$5110` is one of the key readers, and it never polls).
//
// Transitions, from the code (left pressed = `btst #6,$BFE001` clear, right pressed = `btst #2,$DFF016` clear):
//   left pressed, left was up     -> event (`$50DC` -> `$50D0`), right bit cleared
//   left pressed, left was held, latch set -> event (`$50E6` -> `$50D0`), right bit cleared: the press repeats every poll
//   left pressed, left was held, latch clear -> the right check below
//   left released, left was held  -> event (`$50D0`), right bit cleared
//   left up, was up               -> the right check (and the latch is cleared first, `$50BE`)
//   right check, right pressed    -> event only on a new right press (`$5104`: bit 6 was clear), else none
//   right check, right up         -> bit 6 cleared, none
// The event is reported as `true` (`d0 = 0`); `none` is `false` (`d0 = -1`). A caller that reads `leftHeld` after an event
// knows whether it is a press (`$D8AE` / `$DCFE` / `$C70E` / `$5928`: hit test at the pointer) or a release (`$57FA`).
//
// A left press while the right button is already down clears the right bit (`$50D0`), so the right button is seen again
// on the next poll: the same frame then carries two events, the left press and a right re-press at the same pointer.
//
// The map's press latch `$156A9` bit 0 is set only by a scroll-arrow press (`$1596A`, the one `bset #0` of Disk.1, traced
// 2026-11-12: the image has no other writer of the bit; `move.b #2,$156A9` at `$87C6` clears it). While it is set, every
// poll with the left button held is a press event (`$50E4`-`$50EE`), so the caller runs its press branch once per pass in the
// map loop. (The F-key report loop `$58F8` polls with no VBL wait between repeats, so its repeats are faster in the original;
// the port takes one per update, a documented limit.) A poll with the left button up clears it (`$50BE`). The latch is passed in at the window's start: the only window entered
// while it is set is an F1-F6 report, opened by the key dispatcher `$15B4A` during a held arrow (ship-control/screens notes,
// "Window loops"). Every other entry is a release or a press edge, which has cleared it already.
export class MousePoll {
  private leftHeld = false; // $156A8 bit 3
  private rightHeld = false; // $156A8 bit 6
  private latch = false; // $156A9 bit 0, the map's scroll press latch
  private repeated = false; // the last event was a repeat of a held press (latch set)

  /** Whether the left button is held after the last poll (the press/release branch of the caller). */
  get isLeftHeld(): boolean {
    return this.leftHeld;
  }

  /** Whether the last event repeated a held press (latch set). The original runs one `$50B2` call per pass: a caller takes one such event per pass. */
  get isRepeat(): boolean {
    return this.repeated;
  }

  /** Whether the right button is held after the last poll (`$156A8` bit 6): a release event clears it, so a button still down is a new press next time. */
  get isRightHeld(): boolean {
    return this.rightHeld;
  }

  /**
   * The state the window finds when it opens: the bits the map loop left, which equal the buttons seen at the opening
   * snapshot (a button already held does not count as a new press).
   */
  start(left: boolean, right: boolean, pressLatch = false): void {
    this.leftHeld = left;
    this.rightHeld = right;
    this.latch = pressLatch;
    this.repeated = false;
  }

  /** One `$50B2` call on the buttons as they are now. Returns true for an event (`d0 = 0`), false for none (`d0 = -1`). */
  poll(left: boolean, right: boolean): boolean {
    this.repeated = false;
    if (left) {
      const wasHeld = this.leftHeld;
      this.leftHeld = true;
      if (!wasHeld) {
        this.rightHeld = false;
        return true;
      }
      if (this.latch) {
        // `$50E6` tests the latch and branches to `$50D0`: a repeated press, the right bit cleared as for any left edge.
        this.rightHeld = false;
        this.repeated = true;
        return true;
      }
    } else {
      const wasHeld = this.leftHeld;
      this.leftHeld = false;
      this.latch = false; // `$50BE` clears the latch on every poll with the left button up
      if (wasHeld) {
        this.rightHeld = false;
        return true;
      }
    }
    if (right) {
      const wasRight = this.rightHeld;
      this.rightHeld = true;
      return !wasRight;
    }
    this.rightHeld = false;
    return false;
  }
}
