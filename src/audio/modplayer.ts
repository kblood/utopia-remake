// ProTracker (M.K., 4 channel) module parser and Paula-style mixer.
// Pure TypeScript, no DOM or Node dependencies: works headless (tests) and behind WebAudio (webaudio.ts).
//
// Replay behaviour follows the player found in the original (see notes/formats/music.md and
// notes/formats/graphics-and-music-blocks.md): 50 Hz vertical-blank tick, effect F only sets the speed
// (value & $1F, no BPM), standard ProTracker effect semantics, "first word of every sample is zeroed",
// the song wraps from the last position back to position 0 (the restart byte is ignored).

export const PAL_CLOCK = 3546895;
export const TICK_RATE = 50;
export const CHANNELS = 4;
export const ROWS_PER_PATTERN = 64;
export const PATTERN_BYTES = ROWS_PER_PATTERN * CHANNELS * 4;

export interface ModSample {
  name: string;
  /** Length in bytes (header word count * 2). */
  length: number;
  /** Finetune nibble 0..15 (8..15 are negative, -8..-1). */
  finetune: number;
  /** Default volume 0..64. */
  volume: number;
  /** Loop start in bytes. */
  loopStart: number;
  /** Loop length in bytes (<= 2 means no loop). */
  loopLength: number;
  /** Signed 8-bit PCM, `length` bytes (shorter when the file is truncated), first word zeroed. */
  data: Int8Array;
}

export interface ModSong {
  title: string;
  /** Number of sample slots in the header (31 for M.K., 15 for old modules). */
  sampleSlots: number;
  songLength: number;
  restart: number;
  order: Uint8Array;
  patternCount: number;
  /** patternCount * 1024 bytes, raw cells (4 bytes each). */
  patterns: Uint8Array;
  samples: ModSample[];
  tag: string;
}

const KNOWN_TAGS = ["M.K.", "M!K!", "FLT4", "4CHN", "N.T."];

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to && i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
  }
  return s;
}

export function parseMod(bytes: Uint8Array): ModSong {
  if (bytes.length < 600) throw new Error("parseMod: data too short");
  const tag = bytes.length >= 1084 ? String.fromCharCode(bytes[1080], bytes[1081], bytes[1082], bytes[1083]) : "";
  const slots = KNOWN_TAGS.includes(tag) ? 31 : 15;
  const headerEnd = 20 + slots * 30;
  const songLength = bytes[headerEnd];
  const restart = bytes[headerEnd + 1];
  const order = Uint8Array.from(bytes.subarray(headerEnd + 2, headerEnd + 2 + 128));
  const patternsAt = headerEnd + 2 + 128 + (slots === 31 ? 4 : 0);

  let highest = 0;
  for (const p of order) if (p > highest) highest = p;
  const patternCount = highest + 1;
  if (patternsAt + patternCount * PATTERN_BYTES > bytes.length) throw new Error("parseMod: pattern data truncated");
  const patterns = Uint8Array.from(bytes.subarray(patternsAt, patternsAt + patternCount * PATTERN_BYTES));

  const samples: ModSample[] = [];
  let dataAt = patternsAt + patternCount * PATTERN_BYTES;
  for (let i = 0; i < slots; i++) {
    const o = 20 + i * 30;
    const length = ((bytes[o + 22] << 8) | bytes[o + 23]) * 2;
    let loopStart = ((bytes[o + 26] << 8) | bytes[o + 27]) * 2;
    let loopLength = ((bytes[o + 28] << 8) | bytes[o + 29]) * 2;
    if (loopLength > 2) {
      if (loopStart > length) loopStart = length;
      if (loopStart + loopLength > length) loopLength = length - loopStart;
    }
    const avail = Math.max(0, Math.min(length, bytes.length - dataAt));
    const data = new Int8Array(avail);
    for (let k = 0; k < avail; k++) data[k] = (bytes[dataAt + k] << 24) >> 24;
    if (data.length >= 2) {
      data[0] = 0;
      data[1] = 0;
    }
    dataAt += length;
    samples.push({
      name: ascii(bytes, o, o + 22),
      length,
      finetune: bytes[o + 24] & 0x0f,
      volume: Math.min(64, bytes[o + 25]),
      loopStart,
      loopLength,
      data,
    });
  }
  return {
    title: ascii(bytes, 0, 20),
    sampleSlots: slots,
    songLength: Math.max(1, Math.min(128, songLength)),
    restart,
    order,
    patternCount,
    patterns,
    samples,
    tag,
  };
}

// Standard ProTracker period table, 16 finetune rows (0..7, -8..-1) of 36 notes (C-1..B-3).
const PERIOD_ROWS: number[][] = [
  [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113],
  [850, 802, 757, 715, 674, 637, 601, 567, 535, 505, 477, 450, 425, 401, 379, 357, 337, 318, 300, 284, 268, 253, 239, 225, 213, 201, 189, 179, 169, 159, 150, 142, 134, 126, 119, 113],
  [844, 796, 752, 709, 670, 632, 597, 563, 532, 502, 474, 447, 422, 398, 376, 355, 335, 316, 298, 282, 266, 251, 237, 224, 211, 199, 188, 177, 167, 158, 149, 141, 133, 125, 118, 112],
  [838, 791, 746, 704, 665, 628, 592, 559, 528, 498, 470, 444, 419, 395, 373, 352, 332, 314, 296, 280, 264, 249, 235, 222, 209, 198, 187, 176, 166, 157, 148, 140, 132, 125, 118, 111],
  [832, 785, 741, 699, 660, 623, 588, 555, 524, 495, 467, 441, 416, 392, 370, 350, 330, 312, 294, 278, 262, 247, 233, 220, 208, 196, 185, 175, 165, 156, 147, 139, 131, 124, 117, 110],
  [826, 779, 736, 694, 655, 619, 584, 551, 520, 491, 463, 437, 413, 390, 368, 347, 328, 309, 292, 276, 260, 245, 232, 219, 206, 195, 184, 174, 164, 155, 146, 138, 130, 123, 116, 109],
  [820, 774, 730, 689, 651, 614, 580, 547, 516, 487, 460, 434, 410, 387, 365, 345, 325, 307, 290, 274, 258, 244, 230, 217, 205, 193, 183, 172, 163, 154, 145, 137, 129, 122, 115, 109],
  [814, 768, 725, 684, 646, 610, 575, 543, 513, 484, 457, 431, 407, 384, 363, 342, 323, 305, 288, 272, 256, 242, 228, 216, 204, 192, 181, 171, 161, 152, 144, 136, 128, 121, 114, 108],
  [907, 856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120],
  [900, 850, 802, 757, 715, 675, 636, 601, 567, 535, 505, 477, 450, 425, 401, 379, 357, 337, 318, 300, 284, 268, 253, 238, 225, 212, 200, 189, 179, 169, 159, 150, 142, 134, 126, 119],
  [894, 844, 796, 752, 709, 670, 632, 597, 563, 532, 502, 474, 447, 422, 398, 376, 355, 335, 316, 298, 282, 266, 251, 237, 223, 211, 199, 188, 177, 167, 158, 149, 141, 133, 125, 118],
  [887, 838, 791, 746, 704, 665, 628, 592, 559, 528, 498, 470, 444, 419, 395, 373, 352, 332, 314, 296, 280, 264, 249, 235, 222, 209, 198, 187, 176, 166, 157, 148, 140, 132, 125, 118],
  [881, 832, 785, 741, 699, 660, 623, 588, 555, 524, 494, 467, 441, 416, 392, 370, 350, 330, 312, 294, 278, 262, 247, 233, 220, 208, 196, 185, 175, 165, 156, 147, 139, 131, 123, 117],
  [875, 826, 779, 736, 694, 655, 619, 584, 551, 520, 491, 463, 437, 413, 390, 368, 347, 328, 309, 292, 276, 260, 245, 232, 219, 206, 195, 184, 174, 164, 155, 146, 138, 130, 123, 116],
  [868, 820, 774, 730, 689, 651, 614, 580, 547, 516, 487, 460, 434, 410, 387, 365, 345, 325, 307, 290, 274, 258, 244, 230, 217, 205, 193, 183, 172, 163, 154, 145, 137, 129, 122, 115],
  [862, 814, 768, 725, 684, 646, 610, 575, 543, 513, 484, 457, 431, 407, 384, 363, 342, 323, 305, 288, 272, 256, 242, 228, 216, 203, 192, 181, 171, 161, 152, 144, 136, 128, 121, 114],
];

const VIBRATO_TABLE = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
];

const EMPTY = new Int8Array(0);

class Channel {
  // Tracker state
  sample = -1; // sample selected for the next trigger (0..30), -1 = none yet
  finetune = 0;
  volume = 0;
  period = 0;
  wanted = 0;
  portaSpeed = 0;
  vibCmd = 0;
  vibPos = 0;
  tremCmd = 0;
  tremPos = 0;
  waveControl = 0;
  offsetMemory = 0;
  loopRow = 0;
  loopCount = 0;
  glissando = false;
  // Current row
  note = 0;
  sampleNum = 0;
  cmd = 0;
  param = 0;
  // Paula
  data: Int8Array = EMPTY;
  pos = 0;
  end = 0;
  loopStart = 0;
  loopLength = 0;
  playing = false;
  hwPeriod = 0;
  hwVolume = 0;
  muted = false;
}

export interface ModPlayerOptions {
  /** Output sample rate in Hz (default 44100). */
  sampleRate?: number;
  /** 0 = mono, 1 = hard Amiga panning (channels 0,3 left, 1,2 right). Default 0.5. */
  separation?: number;
  /** "linear" (default) or "nearest" (raw Paula sample-and-hold). */
  interpolation?: "linear" | "nearest";
  /**
   * false (default): behaviour of the original player, effect F only sets the speed (value & $1F, 0 ignored).
   * true: standard ProTracker CIA tempo, F >= 32 sets BPM.
   */
  ciaTempo?: boolean;
  /** Master volume 0..64 (64 = unchanged). */
  masterVolume?: number;
}

export class ModPlayer {
  readonly song: ModSong;
  readonly sampleRate: number;
  separation: number;
  interpolation: "linear" | "nearest";
  masterVolume: number;
  private readonly ciaTempo: boolean;

  private channels: Channel[] = [];
  private speed = 6;
  private bpm = 125;
  private counter = 0;
  private songPos = 0;
  private row = 0;
  private breakRow = 0;
  private breakFlag = false;
  private jumpFlag = false;
  private patDelay = 0;
  private patDelay2 = 0;
  private tickLeft = 0;
  private ticks = 0;
  private wraps = 0;

  constructor(song: ModSong, options: ModPlayerOptions = {}) {
    this.song = song;
    this.sampleRate = options.sampleRate ?? 44100;
    this.separation = options.separation ?? 0.5;
    this.interpolation = options.interpolation ?? "linear";
    this.ciaTempo = options.ciaTempo ?? false;
    this.masterVolume = options.masterVolume ?? 64;
    this.reset();
  }

  /** Restart the song from position 0. */
  reset(): void {
    const muted = this.channels.map((c) => c.muted);
    this.channels = [];
    for (let i = 0; i < CHANNELS; i++) {
      const c = new Channel();
      c.muted = muted[i] ?? false;
      this.channels.push(c);
    }
    this.speed = 6;
    this.bpm = 125;
    this.counter = this.speed - 1; // first tick reads row 0
    this.songPos = 0;
    this.row = 0;
    this.breakRow = 0;
    this.breakFlag = false;
    this.jumpFlag = false;
    this.patDelay = 0;
    this.patDelay2 = 0;
    this.tickLeft = 0;
    this.ticks = 0;
    this.wraps = 0;
  }

  /** Song position (index into the order list). */
  get position(): number {
    return this.songPos;
  }
  /** Row about to be played (the row currently sounding is `currentRow - 1`). */
  get currentRow(): number {
    return this.row;
  }
  get currentSpeed(): number {
    return this.speed;
  }
  /** How many times the song has wrapped from its end back to position 0. */
  get loopCount(): number {
    return this.wraps;
  }
  get elapsedTicks(): number {
    return this.ticks;
  }

  setChannelMuted(channel: number, muted: boolean): void {
    const c = this.channels[channel];
    if (c) c.muted = muted;
  }

  /** Run `count` ticks without mixing. */
  advanceTicks(count: number): void {
    for (let i = 0; i < count; i++) this.tick();
  }

  /** Song length in seconds up to the first wrap (or `limitSeconds`). Does not disturb other players. */
  static duration(song: ModSong, limitSeconds = 3600, ciaTempo = false): number {
    const p = new ModPlayer(song, { ciaTempo });
    let seconds = 0;
    while (p.wraps === 0 && seconds < limitSeconds) {
      p.tick();
      seconds += 2.5 / p.bpm;
    }
    // the wrap happens when the last row is read; that row still plays for the rest of its ticks
    return seconds + ((p.speed - 1) * 2.5) / p.bpm;
  }

  /**
   * Render `count` frames (default: the rest of the buffers) into `left`/`right` starting at `offset`.
   * Output is in -1..1. Returns the number of frames written.
   */
  render(left: Float32Array, right: Float32Array, offset = 0, count = Math.min(left.length, right.length) - offset): number {
    let done = 0;
    while (done < count) {
      if (this.tickLeft <= 0) {
        this.tick();
        this.tickLeft += (this.sampleRate * 2.5) / this.bpm;
      }
      const n = Math.min(count - done, Math.max(1, Math.ceil(this.tickLeft)));
      this.mix(left, right, offset + done, n);
      this.tickLeft -= n;
      done += n;
    }
    return count;
  }

  /** Convenience: render `frames` frames into an interleaved stereo buffer. */
  renderInterleaved(out: Float32Array, frames = out.length >> 1): void {
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    this.render(l, r, 0, frames);
    for (let i = 0; i < frames; i++) {
      out[2 * i] = l[i];
      out[2 * i + 1] = r[i];
    }
  }

  // --- mixer -----------------------------------------------------------------------------------

  private mix(left: Float32Array, right: Float32Array, at: number, n: number): void {
    left.fill(0, at, at + n);
    right.fill(0, at, at + n);
    const sep = Math.max(0, Math.min(1, this.separation));
    const near = ((1 + sep) / 2) * 0.5;
    const far = ((1 - sep) / 2) * 0.5;
    const linear = this.interpolation === "linear";
    const master = this.masterVolume / 64;

    for (let ch = 0; ch < CHANNELS; ch++) {
      const c = this.channels[ch];
      if (!c.playing || c.muted || c.hwPeriod <= 0) continue;
      const amp = (c.hwVolume / 64) * master * (1 / 128);
      if (amp === 0) {
        this.skip(c, n); // keep the sample position running so a later volume change is in sync
        continue;
      }
      const leftSide = ch === 0 || ch === 3;
      const gl = amp * (leftSide ? near : far);
      const gr = amp * (leftSide ? far : near);
      const step = PAL_CLOCK / c.hwPeriod / this.sampleRate;
      const data = c.data;
      let pos = c.pos;
      for (let i = 0; i < n; i++) {
        if (pos >= c.end) {
          if (c.loopLength > 2) {
            pos -= c.loopLength;
            while (pos >= c.end) pos -= c.loopLength;
          } else {
            c.playing = false;
            break;
          }
        }
        const idx = pos | 0;
        let v = data[idx];
        if (linear) {
          let next: number;
          if (idx + 1 < c.end) next = data[idx + 1];
          else next = c.loopLength > 2 ? data[c.loopStart] : 0;
          v += (next - v) * (pos - idx);
        }
        left[at + i] += v * gl;
        right[at + i] += v * gr;
        pos += step;
      }
      c.pos = pos;
    }
  }

  private skip(c: Channel, n: number): void {
    c.pos += (PAL_CLOCK / c.hwPeriod / this.sampleRate) * n;
    if (c.pos >= c.end) {
      if (c.loopLength > 2) {
        c.pos = c.loopStart + ((c.pos - c.loopStart) % c.loopLength);
      } else {
        c.playing = false;
      }
    }
  }

  // --- replayer --------------------------------------------------------------------------------

  private tick(): void {
    this.ticks++;
    this.counter++;
    if (this.counter < this.speed) {
      for (const c of this.channels) this.perTick(c);
      return;
    }
    this.counter = 0;
    if (this.patDelay2 === 0) {
      this.readRow();
    } else {
      for (const c of this.channels) this.perTick(c);
    }
    this.advanceRow();
  }

  private advanceRow(): void {
    this.row++;
    if (this.patDelay !== 0) {
      this.patDelay2 = this.patDelay;
      this.patDelay = 0;
    }
    if (this.patDelay2 !== 0) {
      this.patDelay2--;
      if (this.patDelay2 !== 0) this.row--;
    }
    if (this.breakFlag) {
      this.row = this.breakRow;
      this.breakRow = 0;
      this.breakFlag = false;
    }
    if (this.row >= ROWS_PER_PATTERN || this.jumpFlag) this.nextPosition();
  }

  private nextPosition(): void {
    this.row = this.breakRow;
    this.breakRow = 0;
    this.jumpFlag = false;
    this.songPos = (this.songPos + 1) & 0x7f;
    if (this.songPos >= this.song.songLength) {
      this.songPos = 0;
      this.wraps++;
    }
  }

  private readRow(): void {
    const pattern = this.song.order[this.songPos & 0x7f];
    const base = pattern * PATTERN_BYTES + this.row * 16;
    const p = this.song.patterns;
    for (let ch = 0; ch < CHANNELS; ch++) {
      const c = this.channels[ch];
      const o = base + ch * 4;
      c.sampleNum = (p[o] & 0xf0) | (p[o + 2] >> 4);
      c.note = ((p[o] & 0x0f) << 8) | p[o + 1];
      c.cmd = p[o + 2] & 0x0f;
      c.param = p[o + 3];
      this.playVoice(c);
    }
  }

  private periodIndex(note: number): number {
    const row = PERIOD_ROWS[0];
    for (let n = 0; n < 36; n++) if (note >= row[n]) return n;
    return 35;
  }

  private playVoice(c: Channel): void {
    if (c.sampleNum !== 0) {
      const index = c.sampleNum - 1;
      const s = this.song.samples[index];
      if (s) {
        c.sample = index;
        c.finetune = s.finetune;
        c.volume = s.volume;
      } else {
        c.sample = -1;
      }
    }
    if (c.note !== 0) {
      if (c.cmd === 0x0e && c.param >> 4 === 5) c.finetune = c.param & 0x0f;
      const period = PERIOD_ROWS[c.finetune][this.periodIndex(c.note)];
      if (c.cmd === 3 || c.cmd === 5) {
        c.wanted = period === c.period ? 0 : period;
      } else {
        c.period = period;
        const delayed = c.cmd === 0x0e && c.param >> 4 === 0x0d && (c.param & 0x0f) > 0;
        if (!delayed) this.trigger(c, c.cmd === 9);
      }
    }
    this.tickZeroEffects(c);
    c.hwPeriod = c.period;
    c.hwVolume = c.volume;
  }

  /** Start the selected sample on the channel (Paula DMA restart). */
  private trigger(c: Channel, applyOffset: boolean): void {
    if ((c.waveControl & 0x04) === 0) c.vibPos = 0;
    if ((c.waveControl & 0x40) === 0) c.tremPos = 0;
    const s = c.sample >= 0 ? this.song.samples[c.sample] : undefined;
    if (!s || s.data.length <= 2) {
      c.playing = false;
      return;
    }
    const looping = s.loopLength > 2;
    c.data = s.data;
    c.loopStart = looping ? s.loopStart : 0;
    c.loopLength = looping ? s.loopLength : 0;
    c.end = Math.min(s.data.length, looping ? s.loopStart + s.loopLength : s.length);
    c.pos = 0;
    if (applyOffset) {
      if (c.param !== 0) c.offsetMemory = c.param;
      c.pos = c.offsetMemory * 256;
    }
    c.playing = c.pos < c.end;
    if (!c.playing && looping) {
      c.pos = c.loopStart;
      c.playing = true;
    }
  }

  private tickZeroEffects(c: Channel): void {
    const x = c.param >> 4;
    const y = c.param & 0x0f;
    switch (c.cmd) {
      case 9:
        if (c.param !== 0) c.offsetMemory = c.param;
        break;
      case 0x0b:
        this.songPos = (c.param - 1) & 0x7f;
        this.breakRow = 0;
        this.jumpFlag = true;
        break;
      case 0x0c:
        c.volume = Math.min(64, c.param);
        break;
      case 0x0d: {
        const row = x * 10 + y;
        this.breakRow = row > 63 ? 0 : row;
        this.jumpFlag = true;
        break;
      }
      case 0x0e:
        this.extendedTickZero(c, x, y);
        break;
      case 0x0f:
        if (this.ciaTempo) {
          if (c.param >= 32) this.bpm = c.param;
          else if (c.param !== 0) this.speed = c.param;
        } else if ((c.param & 0x1f) !== 0) {
          this.speed = c.param & 0x1f;
        }
        break;
      default:
        break;
    }
  }

  private extendedTickZero(c: Channel, sub: number, y: number): void {
    switch (sub) {
      case 1:
        c.period = Math.max(113, c.period - y);
        break;
      case 2:
        c.period = Math.min(856, c.period + y);
        break;
      case 3:
        c.glissando = y !== 0;
        break;
      case 4:
        c.waveControl = (c.waveControl & 0xf0) | y;
        break;
      case 6:
        if (y === 0) {
          c.loopRow = this.row;
        } else {
          if (c.loopCount === 0) c.loopCount = y;
          else c.loopCount--;
          if (c.loopCount !== 0) {
            this.breakRow = c.loopRow;
            this.breakFlag = true;
          }
        }
        break;
      case 7:
        c.waveControl = (c.waveControl & 0x0f) | (y << 4);
        break;
      case 0x0a:
        c.volume = Math.min(64, c.volume + y);
        break;
      case 0x0b:
        c.volume = Math.max(0, c.volume - y);
        break;
      case 0x0c:
        if (y === 0) c.volume = 0;
        break;
      case 0x0e:
        if (this.patDelay2 === 0) this.patDelay = y + 1;
        break;
      default: // 0 filter, 5 finetune (applied with the note), 8 unused, 9/D per tick, F invert loop: not emulated
        break;
    }
  }

  private perTick(c: Channel): void {
    c.hwPeriod = c.period;
    c.hwVolume = c.volume;
    const x = c.param >> 4;
    const y = c.param & 0x0f;
    switch (c.cmd) {
      case 0:
        if (c.param !== 0) this.arpeggio(c, x, y);
        break;
      case 1:
        c.period = Math.max(113, c.period - c.param);
        c.hwPeriod = c.period;
        break;
      case 2:
        c.period = Math.min(856, c.period + c.param);
        c.hwPeriod = c.period;
        break;
      case 3:
        this.tonePortamento(c, true);
        break;
      case 4:
        this.vibrato(c, true);
        break;
      case 5:
        this.tonePortamento(c, false);
        this.volumeSlide(c, x, y);
        break;
      case 6:
        this.vibrato(c, false);
        this.volumeSlide(c, x, y);
        break;
      case 7:
        this.tremolo(c);
        break;
      case 0x0a:
        this.volumeSlide(c, x, y);
        break;
      case 0x0e:
        this.extendedPerTick(c, x, y);
        break;
      default:
        break;
    }
  }

  private extendedPerTick(c: Channel, sub: number, y: number): void {
    switch (sub) {
      case 9:
        if (y !== 0 && this.counter % y === 0) this.trigger(c, false);
        break;
      case 0x0c:
        if (this.counter === y) {
          c.volume = 0;
          c.hwVolume = 0;
        }
        break;
      case 0x0d:
        if (this.counter === y && c.note !== 0) this.trigger(c, false);
        break;
      default:
        break;
    }
  }

  private arpeggio(c: Channel, x: number, y: number): void {
    const phase = this.counter % 3;
    if (phase === 0) return;
    const row = PERIOD_ROWS[c.finetune];
    let idx = 0;
    while (idx < 35 && c.period < row[idx]) idx++;
    c.hwPeriod = row[Math.min(35, idx + (phase === 1 ? x : y))];
  }

  private volumeSlide(c: Channel, x: number, y: number): void {
    if (x !== 0) c.volume = Math.min(64, c.volume + x);
    else c.volume = Math.max(0, c.volume - y);
    c.hwVolume = c.volume;
  }

  private tonePortamento(c: Channel, readParam: boolean): void {
    if (readParam && c.param !== 0) c.portaSpeed = c.param;
    if (c.wanted === 0) return;
    if (c.period > c.wanted) {
      c.period -= c.portaSpeed;
      if (c.period <= c.wanted) {
        c.period = c.wanted;
        c.wanted = 0;
      }
    } else if (c.period < c.wanted) {
      c.period += c.portaSpeed;
      if (c.period >= c.wanted) {
        c.period = c.wanted;
        c.wanted = 0;
      }
    }
    c.hwPeriod = c.period;
    if (c.glissando) {
      const row = PERIOD_ROWS[c.finetune];
      let idx = 0;
      while (idx < 35 && c.period < row[idx]) idx++;
      c.hwPeriod = row[idx];
    }
  }

  private waveValue(type: number, pos: number): number {
    const index = (pos >> 2) & 0x1f;
    switch (type & 3) {
      case 0:
        return VIBRATO_TABLE[index];
      case 1:
        return pos & 0x80 ? 255 - (index << 3) : index << 3;
      default:
        return 255;
    }
  }

  private vibrato(c: Channel, readParam: boolean): void {
    if (readParam) {
      if (c.param & 0x0f) c.vibCmd = (c.vibCmd & 0xf0) | (c.param & 0x0f);
      if (c.param & 0xf0) c.vibCmd = (c.vibCmd & 0x0f) | (c.param & 0xf0);
    }
    const amount = (this.waveValue(c.waveControl & 3, c.vibPos) * (c.vibCmd & 0x0f)) >> 7;
    c.hwPeriod = c.vibPos & 0x80 ? c.period - amount : c.period + amount;
    c.vibPos = (c.vibPos + ((c.vibCmd >> 2) & 0x3c)) & 0xff;
  }

  private tremolo(c: Channel): void {
    if (c.param & 0x0f) c.tremCmd = (c.tremCmd & 0xf0) | (c.param & 0x0f);
    if (c.param & 0xf0) c.tremCmd = (c.tremCmd & 0x0f) | (c.param & 0xf0);
    const amount = (this.waveValue((c.waveControl >> 4) & 3, c.tremPos) * (c.tremCmd & 0x0f)) >> 6;
    const v = c.tremPos & 0x80 ? c.volume - amount : c.volume + amount;
    c.hwVolume = Math.max(0, Math.min(64, v));
    c.tremPos = (c.tremPos + ((c.tremCmd >> 2) & 0x3c)) & 0xff;
  }
}
