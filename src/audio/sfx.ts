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
//  - SfxScheduler: the 50 Hz channel/timer model of $11B4 + the vertical-blank queue at $1264, DOM free.
//  - createSfx: WebAudio output, shares the AudioContext of the music (webaudio.ts).

import { SECTOR_SIZE } from "../data/picture.js";
import { PAL_CLOCK } from "./modplayer.js";
import { TRACKS } from "./tracks.js";
import { sharedAudioContext } from "./webaudio.js";

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
// Channel model of $11B4 / $1264

export interface SfxVoice {
  effectId: number;
  /** Amiga channel 0..3. */
  channel: number;
  /** Frame (tick) in which the voice starts; the VBL handler starts at most one queued voice per frame. */
  startFrame: number;
  /** Frame in which the channel is switched off again (`startFrame + frames - 1`). */
  endFrame: number;
  volume: number;
}

/**
 * The game's allocation rules, in frames of the 50 Hz vertical blank (`$11B4`, `$1264`):
 *  - a request picks the channel and goes into a one-entry queue per channel; the VBL handler starts it in the
 *    next frame, one new voice per frame (lowest channel first);
 *  - "busy" means the channel timer is non-zero, which is only the case once a voice has really started, so two
 *    requests in the same frame get the same channel and the second replaces the first (the double alert at
 *    `$117AE`/`$117C0` is therefore a single alert);
 *  - while music plays, only the two channels named by the track's flags word may be used (first one preferred);
 *    if both are busy the request is dropped. Without music all four channels are candidates, lowest first.
 */
export class SfxScheduler {
  private queue: (SfxVoice | null)[] = [null, null, null, null];
  private active: (SfxVoice | null)[] = [null, null, null, null];
  private lastStart = -1;

  constructor(private readonly bank: SfxBank) {}

  /**
   * Request effect `id` during frame `frame`. `musicChannels` = the pair from the playing track's flags word, or
   * null when no music plays. Returns the queued voice, or null when the request is dropped or disabled.
   * `replaced` receives a voice that this request overwrote in the queue.
   */
  request(id: number, frame: number, musicChannels: readonly [number, number] | null, volume?: number, replaced?: (v: SfxVoice) => void): SfxVoice | null {
    const effect = this.bank.effects[id];
    if (!effect) return null;
    this.settle(frame);
    const candidates = musicChannels ?? [0, 1, 2, 3];
    const channel = candidates.find((c) => this.active[c] === null);
    if (channel === undefined) return null;
    const old = this.queue[channel];
    if (old) {
      replaced?.(old);
      this.queue[channel] = null;
    }
    let startFrame = Math.max(frame + 1, this.lastStart + 1);
    if (old) startFrame = old.startFrame; // takes over the pending slot
    const voice: SfxVoice = {
      effectId: id,
      channel,
      startFrame,
      endFrame: startFrame + effect.frames - 1,
      volume: Math.max(0, Math.min(64, volume ?? effect.volume)),
    };
    this.queue[channel] = voice;
    this.lastStart = Math.max(this.lastStart, startFrame);
    return voice;
  }

  /** Whether `channel` has a voice that has started and not yet ended at `frame` (timer non-zero). */
  busy(channel: number, frame: number): boolean {
    this.settle(frame);
    return this.active[channel] !== null;
  }

  /** Move queued voices whose start frame has come to the active list and retire finished ones. */
  private settle(frame: number): void {
    for (let c = 0; c < 4; c++) {
      const a = this.active[c];
      if (a && a.endFrame <= frame) this.active[c] = null;
      const q = this.queue[c];
      if (q && q.startFrame <= frame) {
        this.queue[c] = null;
        if (q.endFrame > frame) this.active[c] = q;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// WebAudio output

export interface SfxMusicLink {
  /** Index of the playing track or -1 (see Music.current). */
  readonly current: number;
  setChannelMuted(channel: number, muted: boolean): void;
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
   * Play effect `id` (0..5, see `SFX`). `volume` 0..64 overrides the descriptor's default: the original passes 64
   * (full) to the explosions when the blast is inside the visible map window and 32 when it is outside.
   * Call from a user-gesture handler the first time so the browser lets audio start.
   */
  play(id: number, volume?: number): void;
  /** The "effects on/off" switch of the original's music menu (default on). */
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  /** Master volume 0..1. */
  setVolume(volume: number): void;
  /** Call from a gesture handler to make sure the AudioContext is running. */
  resume(): void;
  dispose(): void;
}

/** Channels the effects may use while `track` plays: high and low byte of the track's flags word. */
export function musicChannels(track: number): [number, number] | null {
  const entry = TRACKS[track];
  if (!entry) return null;
  return [(entry.flags >> 8) & 3, entry.flags & 3];
}

export function createSfx(disk1: Uint8Array, _disk2?: Uint8Array, options: SfxOptions = {}): Sfx {
  const bank = parseSfxBank(disk1);
  const scheduler = new SfxScheduler(bank);
  let enabled = true;
  let volume = Math.max(0, Math.min(1, options.volume ?? 1));
  let master: GainNode | null = null;
  const buffers = new Map<string, AudioBuffer>();
  const pending = new Map<SfxVoice, AudioBufferSourceNode>();
  const muteCount = [0, 0, 0, 0];

  const output = (ctx: AudioContext): GainNode => {
    if (!master) {
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
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

  const sfx: Sfx = {
    count: SFX_COUNT,
    get enabled() {
      return enabled;
    },
    play(id, vol) {
      if (!enabled) return;
      const ctx = sharedAudioContext();
      if (!ctx || !bank.effects[id]) return;
      const now = ctx.currentTime;
      const frame = Math.floor(now * SFX_FRAME_RATE);
      const music = options.music && options.music.current >= 0 ? musicChannels(options.music.current) : null;
      const voice = scheduler.request(id, frame, music, vol, (old) => {
        const node = pending.get(old);
        if (node) {
          try {
            node.stop();
            node.disconnect();
          } catch {
            /* already ended */
          }
          pending.delete(old);
        }
      });
      if (!voice) return;
      const effect = bank.effects[id];
      const node = ctx.createBufferSource();
      node.buffer = buffer(ctx, effect, voice);
      node.connect(output(ctx));
      const when = Math.max(now, voice.startFrame / SFX_FRAME_RATE);
      node.start(when);
      pending.set(voice, node);
      const link = options.music;
      if (link && music) {
        // the original silences the module's voice on that channel while the effect owns it
        const ch = voice.channel;
        const delay = (when - now) * 1000;
        const length = effectSeconds(effect) * 1000;
        setTimeout(() => {
          if (muteCount[ch]++ === 0) link.setChannelMuted(ch, true);
        }, delay);
        setTimeout(() => {
          if (--muteCount[ch] === 0) link.setChannelMuted(ch, false);
        }, delay + length);
      }
      node.onended = () => {
        pending.delete(voice);
        node.disconnect();
      };
    },
    setEnabled(e) {
      enabled = e;
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume;
    },
    resume() {
      const ctx = sharedAudioContext();
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    },
    dispose() {
      for (const node of pending.values()) {
        try {
          node.stop();
          node.disconnect();
        } catch {
          /* ignore */
        }
      }
      pending.clear();
      buffers.clear();
      master?.disconnect();
      master = null;
    },
  };
  return sfx;
}
