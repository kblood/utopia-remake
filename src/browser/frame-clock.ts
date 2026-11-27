// Fixed-step clock for the browser loop. Pure: no DOM, no timers.
// Converts animation-frame timestamps into a count of fixed-length game updates.

export const FRAME_MS = 20; // 50 Hz, like the original PAL display
export const MAX_UPDATES_PER_FRAME = 10;

export class FrameClock {
  private last: number;
  private owed = 0;

  constructor(
    startMs: number,
    private readonly frameMs: number = FRAME_MS,
    private readonly maxUpdates: number = MAX_UPDATES_PER_FRAME,
  ) {
    this.last = startMs;
  }

  /** Milliseconds accumulated but not yet turned into updates (always below one frame after a call). */
  get remainderMs(): number {
    return this.owed;
  }

  /**
   * Returns how many updates to run for the timestamp `nowMs`. The fractional remainder is kept for the next call.
   * When more than `maxUpdates` are due (for example after a backgrounded tab), only `maxUpdates` are returned and
   * the rest of the owed time is discarded, so the game does not replay the lost time.
   * Non-finite timestamps and deltas that are negative or non-finite give 0 updates; a finite timestamp resyncs the clock.
   */
  advance(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0;
    const delta = nowMs - this.last;
    this.last = nowMs;
    if (!Number.isFinite(delta) || delta < 0) return 0;

    this.owed += delta;
    const due = Math.floor(this.owed / this.frameMs);
    if (due > this.maxUpdates) {
      this.owed = 0;
      return this.maxUpdates;
    }
    this.owed -= due * this.frameMs;
    return due;
  }
}
