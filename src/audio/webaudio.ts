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

export class WebAudioSink {
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private gain: GainNode | null = null;
  private player: ModPlayer | null = null;

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
    const Ctor = contextConstructor();
    if (!Ctor) return null;
    const ctx = new Ctor();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const node = ctx.createScriptProcessor(2048, 0, 2);
    node.onaudioprocess = (event) => {
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
    if (this.node) {
      this.node.onaudioprocess = null;
      this.node.disconnect();
    }
    this.gain?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.gain = null;
  }
}
