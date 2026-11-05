// Headless checks of the ProTracker player (src/audio/modplayer.ts) and the music track loader.
// Synthetic-module tests always run. Tests with the real modules use original/utopia-whdload/Disk.1
// (the user's own copy) and are skipped when it is missing. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ModPlayer, parseMod, PAL_CLOCK } = await import("../dist/audio/modplayer.js");
const { TRACKS, unpackTrack, loadSong } = await import("../dist/audio/tracks.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- synthetic module -------------------------------------------------------------------------

/** Build a minimal M.K. module. cells: [{pattern,row,channel,period,sample,cmd,param}] */
function buildMod({ songLength = 1, order = [0], cells = [], sample = null } = {}) {
  const patterns = Math.max(...order) + 1;
  const smp = sample ?? { data: Int8Array.from([0, 0, ...Array(14).fill(100), ...Array(16).fill(-100)]), loop: true };
  const size = 1084 + patterns * 1024 + smp.data.length;
  const m = new Uint8Array(size);
  m.set(Buffer.from("synthetic test"), 0);
  const o = 20; // sample 1 header
  m[o + 22] = (smp.data.length / 2) >> 8;
  m[o + 23] = (smp.data.length / 2) & 255;
  m[o + 25] = 64;
  if (smp.loop) {
    m[o + 28] = (smp.data.length / 2) >> 8;
    m[o + 29] = (smp.data.length / 2) & 255;
  } else {
    m[o + 29] = 1;
  }
  m[950] = songLength;
  order.forEach((p, i) => (m[952 + i] = p));
  m.set(Buffer.from("M.K."), 1080);
  for (const c of cells) {
    const at = 1084 + c.pattern * 1024 + c.row * 16 + c.channel * 4;
    m[at] = ((c.sample ?? 0) & 0xf0) | ((c.period ?? 0) >> 8);
    m[at + 1] = (c.period ?? 0) & 255;
    m[at + 2] = (((c.sample ?? 0) & 15) << 4) | (c.cmd ?? 0);
    m[at + 3] = c.param ?? 0;
  }
  const dataAt = 1084 + patterns * 1024;
  smp.data.forEach((v, i) => (m[dataAt + i] = v & 255));
  return m;
}

function renderAll(player, frames, chunk = frames) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let at = 0; at < frames; at += chunk) {
    const n = Math.min(chunk, frames - at);
    player.render(l, r, at, n);
  }
  return [l, r];
}

function crossings(buf, from, to) {
  let n = 0;
  let prev = 0;
  for (let i = from; i < to; i++) {
    const v = buf[i];
    if (Math.abs(v) < 1e-6) continue;
    const s = v > 0 ? 1 : -1;
    if (prev !== 0 && s !== prev) n++;
    prev = s;
  }
  return n;
}

{
  const song = parseMod(buildMod({ cells: [{ pattern: 0, row: 0, channel: 0, period: 428, sample: 1 }] }));
  check("synthetic: parses", song.patternCount === 1 && song.tag === "M.K." && song.samples[0].length === 32);
  check("synthetic: first sample word zeroed", song.samples[0].data[0] === 0 && song.samples[0].data[2] === 100);

  const player = new ModPlayer(song, { sampleRate: 44100, interpolation: "nearest", separation: 1 });
  const [l, r] = renderAll(player, 44100);
  const expectHz = PAL_CLOCK / 428 / 32;
  const hz = crossings(l, 4410, 44100 - 100) / 2 / ((44100 - 100 - 4410) / 44100);
  check("synthetic: pitch of period 428 / 32-byte loop", Math.abs(hz - expectHz) < 3, `${hz.toFixed(1)} Hz vs ${expectHz.toFixed(1)}`);
  let rightPeak = 0;
  for (const v of r) rightPeak = Math.max(rightPeak, Math.abs(v));
  check("synthetic: channel 0 is hard left with separation 1", rightPeak === 0);
  let leftPeak = 0;
  for (const v of l) leftPeak = Math.max(leftPeak, Math.abs(v));
  check("synthetic: full-volume amplitude", Math.abs(leftPeak - 0.5 * (100 / 128)) < 0.01, leftPeak.toFixed(3));

  // 64 rows * speed 6 * 20 ms
  const dur = ModPlayer.duration(song);
  check("synthetic: duration of one 64-row pattern at speed 6", Math.abs(dur - 7.68) < 0.001, `${dur.toFixed(3)} s`);
}

{
  // F03 at row 0: speed 3 -> half the time; D00 at row 31: pattern ends after 32 rows
  const cells = [
    { pattern: 0, row: 0, channel: 0, period: 428, sample: 1, cmd: 0x0f, param: 3 },
    { pattern: 0, row: 31, channel: 1, cmd: 0x0d, param: 0 },
  ];
  const song = parseMod(buildMod({ cells }));
  const dur = ModPlayer.duration(song);
  check("synthetic: effect F sets speed and D breaks the pattern", Math.abs(dur - 32 * 3 * 0.02) < 0.001, `${dur.toFixed(3)} s`);
  const fast = parseMod(buildMod({ cells: [{ pattern: 0, row: 0, channel: 0, cmd: 0x0f, param: 0x7d }] }));
  const dur2 = ModPlayer.duration(fast);
  check("synthetic: F >= 32 is masked, not BPM (original player)", Math.abs(dur2 - 64 * (0x7d & 0x1f) * 0.02) < 0.001, `${dur2.toFixed(3)} s`);
}

{
  // C00 on row 8: silence afterwards, sound before
  const cells = [
    { pattern: 0, row: 0, channel: 0, period: 428, sample: 1 },
    { pattern: 0, row: 8, channel: 0, cmd: 0x0c, param: 0 },
  ];
  const song = parseMod(buildMod({ cells }));
  const p = new ModPlayer(song, { sampleRate: 44100 });
  const [l] = renderAll(p, 44100 * 2);
  const rowFrames = 6 * 882; // speed 6 ticks of 20 ms
  let before = 0;
  let after = 0;
  for (let i = 0; i < 7 * rowFrames; i++) before = Math.max(before, Math.abs(l[i]));
  for (let i = 9 * rowFrames; i < l.length; i++) after = Math.max(after, Math.abs(l[i]));
  check("synthetic: effect C00 silences the channel", before > 0.1 && after === 0, `${before.toFixed(3)} / ${after}`);
}

{
  // One-shot sample ends and stays silent
  const data = Int8Array.from([0, 0, ...Array(62).fill(80)]);
  const song = parseMod(buildMod({ sample: { data, loop: false }, cells: [{ pattern: 0, row: 0, channel: 2, period: 214, sample: 1 }] }));
  const p = new ModPlayer(song, { sampleRate: 44100 });
  const [l, r] = renderAll(p, 44100 / 2);
  const tailFrom = Math.ceil((64 / (PAL_CLOCK / 214)) * 44100) + 4;
  let tail = 0;
  for (let i = tailFrom; i < l.length; i++) tail = Math.max(tail, Math.abs(l[i]), Math.abs(r[i]));
  let head = 0;
  for (let i = 0; i < 100; i++) head = Math.max(head, Math.abs(l[i]), Math.abs(r[i]));
  check("synthetic: one-shot sample plays once then stops", head > 0.05 && tail === 0, `${head.toFixed(3)} / ${tail}`);
}

// ---- real modules -----------------------------------------------------------------------------

const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(disk1Path)) {
  console.log("music tests on original data skipped: original/utopia-whdload/Disk.1 not found");
} else {
  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  // Structure numbers measured from the unpacked modules (see notes/formats/music.md).
  const expected = [
    { size: 160170, songLength: 15, patterns: 15 },
    { size: 103956, songLength: 55, patterns: 33 },
    { size: 159822, songLength: 46, patterns: 31 },
    { size: 160028, songLength: 55, patterns: 34 },
  ];
  const periods = new Set([0, ...[856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113]]);

  check("track table has 4 entries", TRACKS.length === 4);
  for (let t = 0; t < TRACKS.length; t++) {
    const name = `track ${t}`;
    const raw = unpackTrack(disk1, t);
    const song = loadSong(disk1, t);
    const e = expected[t];
    check(`${name}: unpacked size`, raw.length === e.size, String(raw.length));
    check(`${name}: M.K. tag, song length, pattern count`, song.tag === "M.K." && song.songLength === e.songLength && song.patternCount === e.patterns, `${song.songLength}/${song.patternCount}`);
    const total = song.samples.reduce((a, s) => a + s.length, 0);
    check(`${name}: file size = header + patterns + sample data`, 1084 + song.patternCount * 1024 + total === raw.length);
    const sane = song.samples.every(
      (s) => s.volume <= 64 && s.data.length === s.length && (s.loopLength <= 2 || s.loopStart + s.loopLength <= s.length),
    );
    check(`${name}: sample table sane`, sane && song.samples.some((s) => s.length > 1000));
    let badCells = 0;
    let notes = 0;
    let maxSample = 0;
    for (let i = 0; i < song.patterns.length; i += 4) {
      const period = ((song.patterns[i] & 15) << 8) | song.patterns[i + 1];
      const sampleNum = (song.patterns[i] & 0xf0) | (song.patterns[i + 2] >> 4);
      if (!periods.has(period)) badCells++;
      if (period) notes++;
      if (sampleNum > maxSample) maxSample = sampleNum;
    }
    check(`${name}: all periods are standard notes`, badCells === 0 && notes > 200, `${notes} notes, highest sample ${maxSample}`);

    const seconds = ModPlayer.duration(song, 3600);
    check(`${name}: song length 20 s .. 15 min`, seconds > 20 && seconds < 900, `${seconds.toFixed(1)} s`);

    const player = new ModPlayer(song, { sampleRate: 44100 });
    const [l, r] = renderAll(player, 44100 * 10);
    let nan = 0;
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < l.length; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) nan++;
      peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
      sum += l[i] * l[i] + r[i] * r[i];
    }
    const rms = Math.sqrt(sum / (2 * l.length));
    check(`${name}: renders 10 s without NaN, non-silent, within range`, nan === 0 && peak > 0.05 && peak <= 1 && rms > 0.005, `peak ${peak.toFixed(2)} rms ${rms.toFixed(3)}`);

    if (t === 0) {
      const a = new ModPlayer(song, { sampleRate: 22050 });
      const b = new ModPlayer(song, { sampleRate: 22050 });
      const [al, ar] = renderAll(a, 22050 * 6);
      const [bl, br] = renderAll(b, 22050 * 6, 997);
      let same = true;
      for (let i = 0; i < al.length && same; i++) if (al[i] !== bl[i] || ar[i] !== br[i]) same = false;
      check("render is independent of buffer size", same);
    }
  }
}

if (failed) {
  console.log(`${failed} music check(s) failed`);
  process.exit(1);
}
console.log("music checks passed");
