// Thin WebAudio output for a ModPlayer. Uses a ScriptProcessorNode: the mixer runs on the main thread,
// which keeps the code small and deterministic (an AudioWorklet would need the mixer in a separate module).
// The AudioContext is created lazily; browsers only let it run after a user gesture, so call
// `resume()` (or Music.play) from a click/key handler.

import type { ModPlayer } from "./modplayer.js";

type AudioContextCtor = typeof AudioContext;

function contextConstructor(): AudioContextCtor | undefined {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext;
}

let shared: AudioContext | null = null;
let paulaBus: { ctx: AudioContext; input: GainNode; dry: GainNode; wet: GainNode } | null = null;
let paulaLedFilterOn = false;

/**
 * The one AudioContext used by music and sound effects (created lazily, never closed). Returns null when this
 * environment has no WebAudio (Node tests). Browsers keep it suspended until a user gesture.
 */
export function sharedAudioContext(): AudioContext | null {
  if (shared && shared.state !== "closed") return shared;
  const Ctor = contextConstructor();
  if (!Ctor) return null;
  shared = new Ctor();
  return shared;
}

/** Shared music/SFX output bus with the guest-controlled A1200 LED-filter approximation. */
function sharedPaulaBus(ctx: AudioContext): GainNode {
  if (paulaBus?.ctx === ctx) return paulaBus.input;
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const stages: IIRFilterNode[] = [];
  const alpha = 1 - Math.exp((-2 * Math.PI * 5500) / ctx.sampleRate);
  for (let i = 0; i < 3; i++) stages.push(ctx.createIIRFilter([alpha], [1, -(1 - alpha)]));
  input.connect(dry);
  input.connect(stages[0]);
  stages[0].connect(stages[1]);
  stages[1].connect(stages[2]);
  stages[2].connect(wet);
  dry.connect(ctx.destination);
  wet.connect(ctx.destination);
  paulaBus = { ctx, input, dry, wet };
  setPaulaLedFilter(paulaLedFilterOn);
  return input;
}

/** Connect another Paula voice (for example an SFX node) to the same filtered master output. */
export function sharedPaulaInput(ctx: AudioContext): GainNode {
  return sharedPaulaBus(ctx);
}

/** Guest writes to CIA-A PRA bit 1: clear engages the LED filter, set bypasses it. */
export function setPaulaLedFilter(enabled: boolean): void {
  paulaLedFilterOn = enabled;
  const bus = paulaBus;
  if (!bus) return;
  const now = bus.ctx.currentTime;
  bus.dry.gain.setValueAtTime(enabled ? 0 : 1, now);
  bus.wet.gain.setValueAtTime(enabled ? 1 : 0, now);
}

export class WebAudioSink {
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private gain: GainNode | null = null;
  private player: ModPlayer | null = null;
  private blockListener: ((audioTime: number) => void) | null = null;

  /** True when this environment has WebAudio at all (false in Node tests). */
  static get supported(): boolean {
    return contextConstructor() !== undefined;
  }

  /** Create the context if needed and return its sample rate, or 0 when WebAudio is unavailable. */
  get sampleRate(): number {
    return this.ensure()?.sampleRate ?? 0;
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = sharedAudioContext();
    if (!ctx) return null;
    const gain = ctx.createGain();
    gain.connect(sharedPaulaBus(ctx));
    const node = ctx.createScriptProcessor(2048, 0, 2);
    node.onaudioprocess = (event) => {
      // audio timeline tick: runs before the block is rendered, also while no player is attached (silence); a listener may
      // detach or replace the player (a fade that has finished stops the music here)
      if (this.blockListener) {
        const t = event.playbackTime;
        this.blockListener(typeof t === "number" && t > 0 ? t : ctx.currentTime);
      }
      const out = event.outputBuffer;
      const l = out.getChannelData(0);
      const r = out.getChannelData(1);
      const player = this.player;
      if (!player) {
        l.fill(0);
        r.fill(0);
        return;
      }
      player.render(l, r, 0, l.length);
    };
    node.connect(gain);
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;
    return ctx;
  }

  /** True once the audio graph exists, i.e. blocks are (or will be, once the context runs) pulled. */
  get live(): boolean {
    return this.node !== null;
  }

  /** The AudioContext clock in seconds (0 before the context exists). */
  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /**
   * Called at the start of every rendered block with the AudioContext time of the block (`playbackTime`, or `currentTime` when
   * the browser does not report it). One listener; null removes it. It is the sink's only clock: no wall-clock timers.
   */
  setBlockListener(listener: ((audioTime: number) => void) | null): void {
    this.blockListener = listener;
  }

  /** Attach the player to render (null = silence). Its sample rate must equal `sampleRate`. */
  setPlayer(player: ModPlayer | null): void {
    this.player = player;
  }

  /** Resume a suspended context (needs a user gesture the first time). */
  resume(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }

  /** Output volume 0..1 (immediate). */
  setVolume(volume: number): void {
    const gain = this.gain ?? (this.ensure(), this.gain);
    if (!gain || !this.ctx) return;
    gain.gain.cancelScheduledValues(this.ctx.currentTime);
    gain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), this.ctx.currentTime);
  }

  /** Ramp the output volume to `target` over `seconds`. */
  fadeTo(target: number, seconds: number): void {
    if (!this.gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, target)), now + seconds);
  }

  dispose(): void {
    this.player = null;
    this.blockListener = null;
    if (this.node) {
      this.node.onaudioprocess = null;
      this.node.disconnect();
    }
    this.gain?.disconnect();
    this.ctx = null; // the context is shared with the sound effects and stays open
    this.node = null;
    this.gain = null;
  }
}
