// Frame-stepped model of the original's sound-effect channel ownership. DOM free, no timers, no callbacks into the host:
// every state change is an explicit call with the frame it happens in, and every consequence the host must act on (start a
// sample, stop it, mute or unmute a module voice) comes out of `take()` as an event or is readable as state.
//
// Source: static trace of the Disk.1 game image, notes/formats/sfx.md "Channel ownership, interruption and cancellation"
// (request `$11B4`, vertical-blank starter and timers `$1264`, music switch `$1062`, effects switch `$10BC`, track loader
// `$110A`, player commands 7/8 `$176E`/`$1794`). Static evidence only; no emulator or audio capture was compared.
//
// State, as in the original:
//   queue[ch]  `$1520 + 4 * ch`  one pending (not yet started) entry per channel
//   timer[ch]  `$1518 + 2 * ch`  non-zero = the channel is busy; set at the start, counted down once per frame
//   owned[ch]  record word +4 of the player's channel record: false while an effect holds the module's voice (command 7
//              clears it at the REQUEST, command 8 sets it again at the expiry, and only if the music is active then)
//   pair       music-active bit + the track's two usable channels (null = bit 1 clear, all four channels usable)
//   on         bit 2 of `$1581`: effects enabled
//   dvol[id]   descriptor +8 of effect `id`: the volume the starter reads WHEN IT STARTS an entry (`$12C0`). The blast routine
//              `$1237C` writes it before every `$11B4` request, and that write stays even if the request is dropped or refused
//              (static, VERIFIED 2026-11-10: `move.w #imm,8(a6)` only at `$123E6`/`$1242E`, the starter reads `$8(a6)` at `$12C0`).
//              So entries of one descriptor that have not started yet all sound at the value written last.

/** Number of Paula channels. */
export const SFX_CHANNELS = 4;

const clampVolume = (v: number): number => Math.max(0, Math.min(64, v));

/** What the model needs of an effect: duration in frames (descriptor +10) and default volume (+8). */
export interface SfxTimingBank {
  readonly effects: ReadonlyArray<{ readonly frames: number; readonly volume: number }>;
}

/**
 * `pending`: queued, starts at the next vertical blank (`startFrame` is the prediction); `held`: queued while the effects are
 * switched off (starts after they are switched on again); `playing`: DMA on and timer running; `cut`: the sound was stopped
 * by DMACON `$F` but the timer still runs (the channel stays busy); `ended`: finished or cleared; `dropped`: overwritten in
 * its queue slot, or discarded by `dispose`, without ever starting.
 */
export type VoiceStatus = "pending" | "held" | "playing" | "cut" | "ended" | "dropped";

export interface SfxVoice {
  effectId: number;
  /** Amiga channel 0..3. */
  channel: number;
  /** Frame in which the starter switches the DMA on (a prediction while pending; final once started). */
  startFrame: number;
  /** Frame in which the timer reaches 0 (`startFrame + frames - 1`). */
  endFrame: number;
  /** Volume 0..64 the DMA starts with: the shared descriptor's value at the start frame (kept current while pending). */
  volume: number;
  status: VoiceStatus;
}

/** Everything the host has to do, in order. Voices are the model's own objects, so the host can key its nodes by them. */
export type SfxEvent =
  /** (Re)schedule the sound of `voice` at `voice.startFrame`; a node scheduled earlier for it is obsolete. */
  | { type: "queued"; voice: SfxVoice }
  /** An unstarted voice is gone: overwritten (`replaced`), held back while effects are off (`held`), or the model was disposed. */
  | { type: "drop"; voice: SfxVoice; reason: "replaced" | "held" | "dispose" }
  /** The DMA of `voice` went on in `frame`. */
  | { type: "start"; voice: SfxVoice; frame: number }
  /** The sound of `voice` was stopped (DMACON `$F`); its timer keeps running until `voice.endFrame`. */
  | { type: "cut"; voice: SfxVoice; frame: number }
  /** The timer of `voice` is over: `expired` (the sound ran its course), `disabled` (cleared by the effects-off switch) or `dispose`. */
  | { type: "end"; voice: SfxVoice; frame: number; reason: "expired" | "disabled" | "dispose" };

export type MusicPair = readonly [number, number] | null;

const ALL_CHANNELS: readonly number[] = [0, 1, 2, 3];

export class SfxScheduler {
  private readonly queue: (SfxVoice | null)[] = [null, null, null, null];
  private readonly timer: ({ voice: SfxVoice; remaining: number } | null)[] = [null, null, null, null];
  private readonly owned = [true, true, true, true];
  private pair: MusicPair = null;
  private on = true;
  private clock: number | null = null;
  private disposed = false;
  private events: SfxEvent[] = [];

  /** Descriptor +8 per effect id (see the header, `dvol`). */
  private readonly descriptorVolume: number[];

  constructor(private readonly bank: SfxTimingBank) {
    this.descriptorVolume = bank.effects.map((e) => clampVolume(e.volume));
  }

  /** The shared descriptor volume of effect `id` (descriptor +8): what an entry started now would sound at. */
  volumeOf(id: number): number {
    return this.descriptorVolume[id] ?? 0;
  }

  /** The newest frame the model has been advanced to (0 before the first call). */
  get frame(): number {
    return this.clock ?? 0;
  }

  /** Effects enabled (bit 2 of `$1581`). */
  get enabled(): boolean {
    return this.on;
  }

  /** The last observed music state: the track's channel pair while the music is active, otherwise null. */
  get music(): MusicPair {
    return this.pair;
  }

  /** The module's record word +4 for `channel`: false while an effect owns the module's voice (see the header). */
  moduleEnabled(channel: number): boolean {
    return this.owned[channel] ?? true;
  }

  /** Pending entry and running timer of a channel, for tests and diagnostics. */
  channelState(channel: number): { pending: SfxVoice | null; timer: SfxVoice | null; remaining: number } {
    const t = this.timer[channel] ?? null;
    return { pending: this.queue[channel] ?? null, timer: t ? t.voice : null, remaining: t ? t.remaining : 0 };
  }

  /** Drain the events produced since the last call. The owner must call this, the model never discards them. */
  take(): SfxEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /**
   * Request effect `id` in frame `frame` (after that frame's vertical blank). `musicChannels` is the observation of bit 1 of
   * `$1581`: the channel pair of the playing track, or null when the music is not active. `volume` is the value the caller
   * writes into the shared descriptor before the request (the blast routine `$1237C`, 64 in view or 32 out of view); omitted
   * = no write. Returns the queued voice, or null when the request is dropped (effects off, unknown id, no free candidate
   * channel). The descriptor write happens in every case, the drop included. `replaced` receives the unstarted voice this
   * request overwrote.
   */
  request(id: number, frame: number, musicChannels: MusicPair, volume?: number, replaced?: (v: SfxVoice) => void): SfxVoice | null {
    const effect = this.bank.effects[id];
    if (!effect || this.disposed) return null;
    this.advanceTo(frame);
    if (volume !== undefined) this.writeDescriptorVolume(id, volume);
    if (!this.on) return null; // `$11B4` returns at once while bit 2 is clear
    this.pair = musicChannels;
    const candidates: readonly number[] = musicChannels ?? ALL_CHANNELS;
    // free = timer 0; a pending queue entry does not make a channel busy (the double-alert quirk of `$117AE`/`$117C0`)
    const channel = candidates.find((c) => this.timer[c] === null);
    if (channel === undefined) return null;
    if (musicChannels !== null) this.owned[channel] = false; // command 7, now and not at the start
    const old = this.queue[channel];
    if (old) {
      old.status = "dropped";
      this.events.push({ type: "drop", voice: old, reason: "replaced" });
      replaced?.(old);
    }
    const voice: SfxVoice = {
      effectId: id,
      channel,
      startFrame: -1,
      endFrame: -1,
      volume: this.descriptorVolume[id],
      status: "pending",
    };
    this.queue[channel] = voice;
    this.plan();
    return voice;
  }

  /**
   * `$1237C` stores the blast volume in descriptor +8. Entries of that descriptor that are still queued read the new value when
   * they start, so a pending one is re-scheduled with it (a `queued` event replaces its node); a held one only takes the value.
   * A voice that has started keeps the volume it started with (the DMA's VOL register is written only at the start).
   */
  private writeDescriptorVolume(id: number, volume: number): void {
    const v = clampVolume(volume);
    if (this.descriptorVolume[id] === v) return;
    this.descriptorVolume[id] = v;
    for (let c = 0; c < SFX_CHANNELS; c++) {
      const q = this.queue[c];
      if (!q || q.effectId !== id) continue;
      q.volume = v;
      if (q.status === "pending") this.events.push({ type: "queued", voice: q });
    }
  }

  /** Whether `channel` is busy (timer non-zero) once the vertical blank of `frame` has run. */
  busy(channel: number, frame: number): boolean {
    this.advanceTo(frame);
    return this.timer[channel] !== null;
  }

  /** Run the vertical blanks up to `frame` (monotonic: an earlier frame is ignored). */
  advanceTo(frame: number): void {
    if (this.disposed) return;
    if (this.clock === null) {
      this.clock = frame;
      return;
    }
    while (this.clock < frame) {
      // nothing queued and no timer running, or the starter is frozen by the effects switch: the frames are empty
      if (!this.on || !this.running()) {
        this.clock = frame;
        return;
      }
      this.clock += 1;
      this.vbl(this.clock);
    }
  }

  /**
   * The music state changed in `frame`. `pair` is the new observation (null = not active). `dmaOff` = the original wrote
   * DMACON `$F` at that moment (`$1062` off, the track loader `$110A`): every running effect sound stops but its timer keeps
   * counting, queued entries are untouched, and nothing is handed back to the module.
   */
  musicChanged(frame: number, pair: MusicPair, dmaOff: boolean): void {
    if (this.disposed) return;
    this.advanceTo(frame);
    this.pair = pair;
    if (!dmaOff) return;
    for (let c = 0; c < SFX_CHANNELS; c++) {
      const t = this.timer[c];
      if (t && t.voice.status === "playing") {
        t.voice.status = "cut";
        this.events.push({ type: "cut", voice: t.voice, frame: this.frame });
      }
    }
  }

  /**
   * The effects switch (`$10BC`). Off: every timer is cleared, running sounds stop, the starter and the timers freeze, and
   * queued entries are held, not discarded; the module's `owned` words are NOT restored (no command 8). On: held entries
   * start from the next vertical blank, lowest channel first.
   */
  setEnabled(frame: number, enabled: boolean): void {
    if (this.disposed) return;
    this.advanceTo(frame);
    if (enabled === this.on) return;
    this.on = enabled;
    if (!enabled) {
      for (let c = 0; c < SFX_CHANNELS; c++) {
        const t = this.timer[c];
        if (t) {
          this.timer[c] = null;
          t.voice.status = "ended";
          this.events.push({ type: "end", voice: t.voice, frame: this.frame, reason: "disabled" });
        }
        const q = this.queue[c];
        if (q) {
          q.status = "held";
          this.events.push({ type: "drop", voice: q, reason: "held" });
        }
      }
      return;
    }
    for (const q of this.queue) {
      if (q) {
        q.status = "pending";
        q.startFrame = -1; // forces a fresh `queued` event
      }
    }
    this.plan();
  }

  /** Discard everything; the model ignores all later calls. Pending and running voices end with reason `dispose`. */
  dispose(): void {
    if (this.disposed) return;
    for (let c = 0; c < SFX_CHANNELS; c++) {
      const q = this.queue[c];
      if (q) {
        this.queue[c] = null;
        q.status = "dropped";
        this.events.push({ type: "drop", voice: q, reason: "dispose" });
      }
      const t = this.timer[c];
      if (t) {
        this.timer[c] = null;
        t.voice.status = "ended";
        this.events.push({ type: "end", voice: t.voice, frame: this.frame, reason: "dispose" });
      }
    }
    this.disposed = true;
  }

  private running(): boolean {
    return this.queue.some((q) => q !== null) || this.timer.some((t) => t !== null);
  }

  /** One vertical blank (`$1264`, effects enabled): start at most one queued voice, then count every timer down. */
  private vbl(frame: number): void {
    for (let c = 0; c < SFX_CHANNELS; c++) {
      const q = this.queue[c];
      if (!q) continue;
      this.queue[c] = null;
      const frames = Math.max(1, this.bank.effects[q.effectId].frames);
      q.volume = this.descriptorVolume[q.effectId]; // `$12C0`: the volume is read here, at the start
      q.status = "playing";
      q.startFrame = frame;
      q.endFrame = frame + frames - 1;
      this.timer[c] = { voice: q, remaining: frames };
      this.events.push({ type: "start", voice: q, frame });
      break;
    }
    for (let c = 0; c < SFX_CHANNELS; c++) {
      const t = this.timer[c];
      if (!t) continue;
      t.remaining -= 1;
      if (t.remaining > 0) continue;
      this.timer[c] = null;
      // command 8 (hand the voice back) runs only while the music is active at this moment; otherwise the original clears
      // the channel's DMA bit and the module's word stays as it was
      if (this.pair !== null) this.owned[c] = true;
      t.voice.status = "ended";
      this.events.push({ type: "end", voice: t.voice, frame, reason: "expired" });
    }
  }

  /** Predict the start frames of the pending entries (next blank first, lowest channel first, one per frame) and announce changes. */
  private plan(): void {
    let f = this.frame + 1;
    for (let c = 0; c < SFX_CHANNELS; c++) {
      const q = this.queue[c];
      if (!q || q.status !== "pending") continue;
      if (q.startFrame !== f) {
        q.startFrame = f;
        q.endFrame = f + Math.max(1, this.bank.effects[q.effectId].frames) - 1;
        this.events.push({ type: "queued", voice: q });
      }
      f += 1;
    }
  }
}
