// The main-loop pass scheduler of the map view, driven from the 50 Hz video update layer.
//
// The original has two clocks (notes/formats/map-rendering.md "Main-loop timing", units.md, sim-port.md):
//   - the VBL interrupt: the day countdown `$14590` decrements once per video frame (unpaused only);
//   - the main loop (`$157BC` / `$333A`): one pass per N video frames. Each normal pass runs the date/periodic work, the
//     cell animation, the unit / enemy / effect step, the `$144C9` pass clock and polls the mouse and keyboard once. The
//     build-menu modal loop `$B3D8` polls separately without returning through `$333A`; its browser callbacks do not advance
//     the outer-loop pass phase.
//
// OBSERVED (Copperline 1.0.1, A1200 / 68020 / AGA PAL, 1536K chip + 4M fast, scenario 0): a pass took 4 video
// frames with the pointer at (175,41) and at (60,100), and 5 frames with it at (250,141); other positions gave 4, 5
// or an alternation (the pass is CPU-bound: ~3.65 frames of work, then it waits for line 242 of the next frame).
// So the pass length is machine and pointer dependent and NOT a fixed engine constant. This scheduler uses the
// measured baseline of 4 as its default and does not model the pointer-dependent 5. Other emulators (WinUAE),
// CPU speeds and chipsets were not measured.

/** Video frames per main-loop pass: the measured baseline at (175,41), not a claim about every position or machine. */
export const DEFAULT_VBL_PER_PASS = 4;

export class MainLoop {
  /** Video frames per pass (configurable for experiments; the default is the measured baseline). */
  readonly vblPerPass: number;
  /** Video updates counted so far (VBL interrupts). */
  vbls = 0;
  /** Loop passes completed so far. */
  passes = 0;
  private phase = 0;
  private immediatePass = false;

  constructor(vblPerPass: number = DEFAULT_VBL_PER_PASS) {
    if (!Number.isInteger(vblPerPass) || vblPerPass < 1) throw new Error(`MainLoop: vblPerPass ${vblPerPass} must be an integer >= 1`);
    this.vblPerPass = vblPerPass;
  }

  /** Legacy restore for saves that stored only VBL count; the historical phase is derived as `vbls % vblPerPass`. */
  restoreAt(vbls: number): boolean {
    if (!Number.isSafeInteger(vbls) || vbls < 0) return false;
    this.vbls = vbls;
    this.passes = Math.floor(vbls / this.vblPerPass);
    this.phase = vbls % this.vblPerPass;
    this.immediatePass = false;
    return true;
  }

  /** Exact native-save restore for scheduler states that may include a modal-return pass. */
  restoreState(vbls: number, passes: number, phase: number, immediatePass: boolean): boolean {
    if (!Number.isSafeInteger(vbls) || vbls < 0 || !Number.isSafeInteger(passes) || passes < 0 || passes > vbls ||
      !Number.isInteger(phase) || phase < 0 || phase >= this.vblPerPass || typeof immediatePass !== "boolean") return false;
    this.vbls = vbls;
    this.passes = passes;
    this.phase = phase;
    this.immediatePass = immediatePass;
    return true;
  }

  /** A fresh entry or modal input loop returned to `$157BC`; run its pass before the next VBL wait. */
  resumeWithImmediatePass(): void {
    this.immediatePass = true;
  }

  /** Runs a pending return-to-`$157BC` pass before the next VBL wait (fresh entry or modal-loop exit). */
  runImmediatePass(): boolean {
    if (!this.immediatePass) return false;
    this.immediatePass = false;
    this.phase = 0;
    this.passes++;
    return true;
  }

  get updatesIntoPass(): number {
    return this.phase;
  }

  get immediatePassPending(): boolean {
    return this.immediatePass;
  }

  /**
   * Counts one video update (call once per 50 Hz update, after its VBL-side work). `advancePass=false` models a modal
   * callback: VBL time still advances, but the outer main-loop phase is suspended. Production MapScene consumes immediate
   * passes with `runImmediatePass()` before calling this; the legacy branch below remains for direct scheduler callers.
   */
  vbl(advancePass = true): boolean {
    this.vbls++;
    if (!advancePass) return false;
    if (this.immediatePass) {
      this.immediatePass = false;
      this.phase = 0;
      this.passes++;
      return true;
    }
    if (++this.phase < this.vblPerPass) return false;
    this.phase = 0;
    this.passes++;
    return true;
  }
}
