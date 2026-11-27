// Sound effects of the game. See notes/formats/sfx.md for the findings (all VERIFIED unless marked).
//
// The original has six effects. They are Paula sample playbacks started by the routine at $11B4 of the game image
// from a table of six 12-byte descriptors at $1490: {sample address (long), length in words, period, volume,
// duration in frames}. Four use 8-bit samples stored raw in Disk.1 sectors $368-$386 (loaded to $2227A), two use an
// 8-byte sine wave that sits in the game image itself. Nothing from the original is stored here: descriptors and
// samples are read from the user's Disk.1 at run time.
//
// Layers:
//  - parseSfxBank / renderEffect: pure decoding and mixing, DOM free (used by the tests).
//  - SfxScheduler (sfx-scheduler.ts): the 50 Hz channel/timer/ownership model of $11B4 + the vertical-blank starter at $1264, DOM free.
//  - createSfx: WebAudio output, shares the AudioContext of the music (webaudio.ts).

import { SECTOR_SIZE } from "../data/picture.js";
import { PAL_CLOCK } from "./modplayer.js";
import { TRACKS } from "./tracks.js";
import { SfxScheduler, type MusicPair, type SfxVoice } from "./sfx-scheduler.js";
import { sharedAudioContext, sharedPaulaInput } from "./webaudio.js";

/** Effect ids = index in the descriptor table at $1490 of the game image. */
export const SFX = {
  /** $1490: low, long rumble (sample A at period 864, 97 frames). Area blasts (`$12332`: missile impact, raids, mines). */
  EXPLOSION_LOW: 0,
  /** $149C: higher, shorter blast (sample A at period 608, 67 frames). A unit or building destroyed in combat (`$4732`). */
  EXPLOSION_HIGH: 1,
  /** $14A8: short noise burst (sample A at period 384, quieter, 43 frames). A weapon hit on a unit or building. */
  HIT: 2,
  /** $14B4: the second sample (period 544, 47 frames, about 1 s). Launching a missile from a launcher (`$E086`). */
  LAUNCH: 3,
  /** $14C0: one 20 ms blip of an 8-byte sine. A window button being pressed (`$5756`, `$5948`); four of them in a row = ship completed. */
  CLICK: 4,
  /** $14CC: 220 ms tone of the same sine at a lower pitch. A news or spy-report message line (`$5A8C` + alert). */
  ALERT: 5,
} as const;

export const SFX_COUNT = 6;

const IMAGE_FIRST_SECTOR = 0x14c; // game proper, loaded at $1000
const IMAGE_BASE = 0x1000;
const IMAGE_SECTORS = 0x208 - 0x14c + 1;
const SAMPLE_FIRST_SECTOR = 0x368; // raw, loaded to $2227A by $7D3E
const SAMPLE_SECTORS = 0x386 - 0x368 + 1;
const SAMPLE_BASE = 0x2227a;
const DESCRIPTOR_TABLE = 0x1490;
const DESCRIPTOR_SIZE = 12;
/** The game's timer unit: the VBL handler (`$1264`) runs once per frame, 50 Hz on the PAL setup. */
export const SFX_FRAME_RATE = 50;

export interface SfxEffect {
  id: number;
  name: string;
  /** Address of the sample in the original's memory map (long at +0 of the descriptor). */
  address: number;
  /** Signed 8-bit samples, `lengthWords * 2` bytes (bytes beyond the loaded region read as 0). */
  data: Int8Array;
  lengthWords: number;
  /** Paula period (3,546,895 / period = samples per second). */
  period: number;
  /** Default volume 0..64 (some call sites override it, see notes). */
  volume: number;
  /** Duration field: the game stops the channel after `frames - 1` vertical blanks. */
  frames: number;
}

export interface SfxBank {
  effects: SfxEffect[];
}

const NAMES = ["explosion-low", "explosion-high", "hit", "launch", "click", "alert"];

function readLong(d: Uint8Array, at: number): number {
  return ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;
}

function readWord(d: Uint8Array, at: number): number {
  return (d[at] << 8) | d[at + 1];
}

/** Read `count` bytes at original memory address `address` from Disk.1 (game image or sample region). */
function readMemory(disk1: Uint8Array, address: number, count: number): Int8Array {
  const out = new Int8Array(count);
  let from: number;
  let limit: number;
  if (address >= SAMPLE_BASE && address < SAMPLE_BASE + SAMPLE_SECTORS * SECTOR_SIZE) {
    from = SAMPLE_FIRST_SECTOR * SECTOR_SIZE + (address - SAMPLE_BASE);
    limit = SAMPLE_FIRST_SECTOR * SECTOR_SIZE + SAMPLE_SECTORS * SECTOR_SIZE;
  } else if (address >= IMAGE_BASE && address < IMAGE_BASE + IMAGE_SECTORS * SECTOR_SIZE) {
    from = IMAGE_FIRST_SECTOR * SECTOR_SIZE + (address - IMAGE_BASE);
    limit = IMAGE_FIRST_SECTOR * SECTOR_SIZE + IMAGE_SECTORS * SECTOR_SIZE;
  } else {
    throw new Error(`sfx: sample address $${address.toString(16)} is outside the known regions`);
  }
  for (let i = 0; i < count && from + i < limit; i++) out[i] = (disk1[from + i] << 24) >> 24;
  return out;
}

/** Read the six effect descriptors and their samples from Disk.1. */
export function parseSfxBank(disk1: Uint8Array): SfxBank {
  const table = IMAGE_FIRST_SECTOR * SECTOR_SIZE + (DESCRIPTOR_TABLE - IMAGE_BASE);
  if (disk1.length < table + SFX_COUNT * DESCRIPTOR_SIZE) throw new Error("sfx: Disk.1 image too small");
  const effects: SfxEffect[] = [];
  for (let id = 0; id < SFX_COUNT; id++) {
    const at = table + id * DESCRIPTOR_SIZE;
    const address = readLong(disk1, at);
    const lengthWords = readWord(disk1, at + 4);
    const period = readWord(disk1, at + 6);
    const volume = readWord(disk1, at + 8);
    const frames = readWord(disk1, at + 10);
    if (lengthWords === 0 || period < 113 || volume > 64 || frames === 0) throw new Error(`sfx: effect ${id} has a bad descriptor`);
    effects.push({ id, name: NAMES[id], address, data: readMemory(disk1, address, lengthWords * 2), lengthWords, period, volume, frames });
  }
  return { effects };
}

export interface RenderOptions {
  /** Output sample rate in Hz. */
  sampleRate: number;
  /** Volume 0..64 (default: the descriptor's). */
  volume?: number;
  /** Amiga channel the voice sits on; 0 and 3 are left, 1 and 2 right (default 1). */
  channel?: number;
  /** Stereo separation 0..1 (default 0.5, as in the music player). */
  separation?: number;
  interpolation?: "linear" | "nearest";
}

/** Seconds the channel sounds: the game turns the DMA off after `frames - 1` frames (`$13B6`). */
export function effectSeconds(effect: SfxEffect): number {
  return (effect.frames - 1) / SFX_FRAME_RATE;
}

/**
 * Render one effect like Paula would play it: the sample loops (the DMA restarts at the start address after
 * `lengthWords` words) until the duration is over. Output uses the same level scale as ModPlayer.
 */
export function renderEffect(effect: SfxEffect, options: RenderOptions): { left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> } {
  const rate = options.sampleRate;
  const frames = Math.max(1, Math.round(effectSeconds(effect) * rate));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const sep = Math.max(0, Math.min(1, options.separation ?? 0.5));
  const near = ((1 + sep) / 2) * 0.5;
  const far = ((1 - sep) / 2) * 0.5;
  const channel = options.channel ?? 1;
  const leftSide = channel === 0 || channel === 3;
  const amp = (Math.max(0, Math.min(64, options.volume ?? effect.volume)) / 64) * (1 / 128);
  const gl = amp * (leftSide ? near : far);
  const gr = amp * (leftSide ? far : near);
  const step = PAL_CLOCK / effect.period / rate;
  const data = effect.data;
  const n = data.length;
  const linear = (options.interpolation ?? "linear") === "linear";
  let pos = 0;
  for (let i = 0; i < frames; i++) {
    while (pos >= n) pos -= n;
    const idx = pos | 0;
    let v = data[idx];
    if (linear) v += (data[idx + 1 < n ? idx + 1 : 0] - v) * (pos - idx);
    left[i] = v * gl;
    right[i] = v * gr;
    pos += step;
  }
  return { left, right };
}

// ---------------------------------------------------------------------------------------------------------------
// Channel model of $11B4 / $1264: src/audio/sfx-scheduler.ts (pure, frame-stepped, event based)

export { SfxScheduler, SFX_CHANNELS } from "./sfx-scheduler.js";
export type { SfxVoice, SfxEvent, SfxTimingBank, VoiceStatus, MusicPair } from "./sfx-scheduler.js";

// ---------------------------------------------------------------------------------------------------------------
// WebAudio output

/** A music state change as `Music.onChange` reports it (structurally the same as `MusicChange` in music.ts). */
export interface SfxMusicChange {
  /** The original wrote DMACON `$F` at this moment (`$1062` off, the track loader `$110A`, stop): all effect sounds stop, their timers go on. */
  readonly dmaOff: boolean;
  /** The music-active bit after the change. */
  readonly active: boolean;
  /** The selected track after the change, or -1. */
  readonly current: number;
}

export interface SfxMusicLink {
  /** Index of the selected track or -1 (see Music.current); a paused track stays selected. */
  readonly current: number;
  /** Music-active bit (see Music.active): only while it is set do the effects share the track's two channels. */
  readonly active: boolean;
  setChannelMuted(channel: number, muted: boolean): void;
  /**
   * Optional: be told of every music state change. Without it the state is only sampled at each `play`, so a change that
   * leaves the channel pair as it was (a reload of a track with the same pair) cannot be seen.
   */
  onChange?(listener: (change: SfxMusicChange) => void): () => void;
  /**
   * Optional: audio timeline tick. Called at the start of every rendered block with the AudioContext time of that block
   * (also while the music is paused); the effect model advances with it, so a module voice is handed back on the audio clock
   * instead of a wall-clock timer. Without it the model only advances at API calls and `sync()`.
   */
  onBlock?(listener: (audioTime: number) => void): () => void;
}

export interface SfxOptions {
  /** Link to the music: restricts effects to the track's two channels and mutes the module's voice there, like the original. */
  music?: SfxMusicLink;
  /** Stereo separation 0..1 (default 0.5, the music player's default). */
  separation?: number;
  /** Master volume 0..1 (default 1). */
  volume?: number;
}

export interface Sfx {
  readonly count: number;
  /**
   * Play effect `id` (0..5, see `SFX`). `volume` 0..64 is written to the effect's shared descriptor, as `$1237C` does: the
   * original passes 64 (full) to the explosions when the blast is inside the visible map window and 32 when it is outside.
   * A queued entry sounds at the descriptor's volume when it starts, so a later write (even a dropped request's) changes an
   * entry that has not started yet (notes/formats/sfx.md, consequence 8). Call from a user-gesture handler the first time
   * so the browser lets audio start.
   */
  play(id: number, volume?: number): void;
  /**
   * The "effects on/off" switch of the original's music menu (default on). Switching off stops every sounding effect at
   * once and clears the channel timers (`$10BC`); entries that were queued but not started are held and start when the
   * effects are switched on again.
   */
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  /** Master volume 0..1. */
  setVolume(volume: number): void;
  /** Call from a gesture handler to make sure the AudioContext is running. */
  resume(): void;
  /** Advance the channel model to the audio clock and apply module ownership (called automatically by the music's block tick and by every other call). */
  sync(): void;
  /** Stop every effect, cancel everything that is scheduled, give the module its voices back and detach from the music. Later calls do nothing. */
  dispose(): void;
}

/** Channels the effects may use while `track` plays: high and low byte of the track's flags word. */
export function musicChannels(track: number): [number, number] | null {
  const entry = TRACKS[track];
  if (!entry) return null;
  return [(entry.flags >> 8) & 3, entry.flags & 3];
}

/**
 * The channel restriction `$11B4` applies: tests bit 1 of `$1581` (music active), not the loaded track `$1580`. Active music
 * gives the track's pair; inactive music (never started, or switched off with `$1062`) and no link at all give null = all four
 * channels are candidates, even when a track is still selected.
 */
export function effectChannelsFor(link: Pick<SfxMusicLink, "current" | "active"> | undefined): [number, number] | null {
  return link !== undefined && link.active && link.current >= 0 ? musicChannels(link.current) : null;
}

function samePair(a: MusicPair, b: MusicPair): boolean {
  return a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);
}

/**
 * WebAudio projection of the channel model (`SfxScheduler`). The model owns all state; this layer holds exactly one
 * cancellable `AudioBufferSourceNode` per queued or sounding voice and changes it only in answer to model events, so there are
 * no wall-clock timers and nothing that can fire after a voice was replaced, cut, disabled or disposed. Time is the
 * AudioContext clock (frames of 1/50 s); a suspended context stops the clock, the nodes and the module's blocks together.
 */
export function createSfx(disk1: Uint8Array, _disk2?: Uint8Array, options: SfxOptions = {}): Sfx {
  const bank = parseSfxBank(disk1);
  const engine = new SfxScheduler(bank);
  const link = options.music;
  let volume = Math.max(0, Math.min(1, options.volume ?? 1));
  let master: GainNode | null = null;
  let disposed = false;
  /** Newest block time seen (ScriptProcessor `playbackTime`): the model runs on the timeline the module is rendered on. */
  let blockTime = 0;
  const buffers = new Map<string, AudioBuffer>();
  const nodes = new Map<SfxVoice, AudioBufferSourceNode>();
  /** Mute state this layer last pushed into the link, per channel. */
  const pushed = [false, false, false, false];
  const detach: (() => void)[] = [];

  const output = (ctx: AudioContext): GainNode => {
    if (!master) {
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(sharedPaulaInput(ctx));
    }
    return master;
  };

  const buffer = (ctx: AudioContext, effect: SfxEffect, voice: SfxVoice): AudioBuffer => {
    const side = voice.channel === 0 || voice.channel === 3 ? "L" : "R";
    const key = `${effect.id}:${voice.volume}:${side}:${ctx.sampleRate}:${options.separation ?? 0.5}`;
    let b = buffers.get(key);
    if (!b) {
      const r = renderEffect(effect, { sampleRate: ctx.sampleRate, volume: voice.volume, channel: voice.channel, separation: options.separation });
      b = ctx.createBuffer(2, r.left.length, ctx.sampleRate);
      b.copyToChannel(r.left, 0);
      b.copyToChannel(r.right, 1);
      buffers.set(key, b);
    }
    return b;
  };

  const frameOf = (ctx: AudioContext): number => Math.floor(Math.max(ctx.currentTime, blockTime) * SFX_FRAME_RATE + 1e-6);

  /** Stop and forget the node of `voice` (a node that was never started or already ended is fine). */
  const silence = (voice: SfxVoice): void => {
    const node = nodes.get(voice);
    if (!node) return;
    nodes.delete(voice);
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* already ended */
    }
    try {
      node.disconnect();
    } catch {
      /* already disconnected */
    }
  };

  /** (Re)schedule the node of `voice` at its start frame. */
  const schedule = (ctx: AudioContext, voice: SfxVoice): void => {
    silence(voice);
    const node = ctx.createBufferSource();
    node.buffer = buffer(ctx, bank.effects[voice.effectId], voice);
    node.connect(output(ctx));
    node.onended = () => {
      if (nodes.get(voice) === node) nodes.delete(voice);
      node.disconnect();
    };
    nodes.set(voice, node);
    node.start(Math.max(ctx.currentTime, voice.startFrame / SFX_FRAME_RATE));
  };

  /** Mirror the model's module-ownership words into the music (only what changed). */
  const syncModule = (): void => {
    if (!link) return;
    for (let ch = 0; ch < 4; ch++) {
      const mute = !engine.moduleEnabled(ch);
      if (mute === pushed[ch]) continue;
      pushed[ch] = mute;
      link.setChannelMuted(ch, mute);
    }
  };

  /** Apply the model's pending events to the audio graph, then the module ownership. */
  const flush = (ctx: AudioContext | null): void => {
    for (const e of engine.take()) {
      if (e.type === "queued") {
        if (ctx) schedule(ctx, e.voice);
      } else if (e.type === "drop" || e.type === "cut") {
        silence(e.voice);
      } else if (e.type === "end" && e.reason !== "expired") {
        silence(e.voice);
      }
    }
    syncModule();
  };

  /** Advance to the audio clock; `time` is a block time from the music (optional). */
  const pump = (time?: number): void => {
    if (disposed) return;
    const ctx = sharedAudioContext();
    if (!ctx) return;
    if (time !== undefined && time > blockTime) blockTime = time;
    engine.advanceTo(frameOf(ctx));
    flush(ctx);
  };

  /** Without a change hook the music state is sampled; a pair that differs from the model's is a switch-off or a reload. */
  const observeMusic = (frame: number): void => {
    const pair = effectChannelsFor(link);
    if (samePair(pair, engine.music)) return;
    engine.musicChanged(frame, pair, engine.music !== null);
  };

  if (link?.onChange) {
    detach.push(
      link.onChange((change) => {
        if (disposed) return;
        const ctx = sharedAudioContext();
        if (!ctx) return;
        const pair = change.active && change.current >= 0 ? musicChannels(change.current) : null;
        engine.musicChanged(frameOf(ctx), pair, change.dmaOff);
        flush(ctx);
      }),
    );
  }
  if (link?.onBlock) detach.push(link.onBlock((time) => pump(time)));

  const sfx: Sfx = {
    count: SFX_COUNT,
    get enabled() {
      return engine.enabled;
    },
    play(id, vol) {
      if (disposed) return;
      const ctx = sharedAudioContext();
      if (!ctx || !bank.effects[id]) return;
      const frame = frameOf(ctx);
      observeMusic(frame);
      // the engine refuses the request while the effects are off, but the volume is still written to the shared descriptor
      engine.request(id, frame, effectChannelsFor(link), vol);
      flush(ctx);
    },
    setEnabled(enabled) {
      if (disposed) return;
      const ctx = sharedAudioContext();
      engine.setEnabled(ctx ? frameOf(ctx) : engine.frame, enabled);
      flush(ctx);
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume;
    },
    resume() {
      const ctx = sharedAudioContext();
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    },
    sync() {
      pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of detach.splice(0)) off();
      engine.dispose();
      engine.take();
      for (const voice of [...nodes.keys()]) silence(voice);
      // the module gets every voice back; the mute state outlives nothing that is torn down here
      if (link) {
        for (let ch = 0; ch < 4; ch++) {
          if (!pushed[ch]) continue;
          pushed[ch] = false;
          link.setChannelMuted(ch, false);
        }
      }
      buffers.clear();
      master?.disconnect();
      master = null;
    },
  };
  return sfx;
}
