// Headless checks of the sound-effect loader and channel model (src/audio/sfx.ts).
// The scheduler checks use a synthetic bank and always run; the parsing checks read the user's own Disk.1 and are
// skipped when it is missing. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseSfxBank, renderEffect, effectSeconds, SfxScheduler, SFX, SFX_COUNT, musicChannels, effectChannelsFor } = await import("../dist/audio/sfx.js");
const { PAL_CLOCK } = await import("../dist/audio/modplayer.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
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

// ---- synthetic effect rendering and channel model -----------------------------------------------

const sine = Int8Array.from([0, 90, 127, 90, 0, -90, -127, -90]);
const synth = (frames, period = 630, volume = 64) => ({ id: 0, name: "synthetic", address: 0, data: sine, lengthWords: 4, period, volume, frames });

{
  const e = synth(26); // 25 frames = 0.5 s
  check("render: duration is (frames - 1) / 50", Math.abs(effectSeconds(e) - 0.5) < 1e-9);
  const { left, right } = renderEffect(e, { sampleRate: 44100, channel: 0, separation: 1, interpolation: "nearest" });
  check("render: length", left.length === 22050);
  let rp = 0;
  for (const v of right) rp = Math.max(rp, Math.abs(v));
  check("render: hard separation puts channel 0 only on the left", rp === 0);
  const hz = crossings(left, 0, left.length) / 2 / 0.5;
  const expect = PAL_CLOCK / 630 / 8;
  check("render: 8-byte loop pitch", Math.abs(hz - expect) < 6, `${hz.toFixed(1)} Hz vs ${expect.toFixed(1)}`);
  let lp = 0;
  for (const v of left) lp = Math.max(lp, Math.abs(v));
  check("render: full volume matches the module mixer scale", Math.abs(lp - 0.5 * (127 / 128)) < 0.01, lp.toFixed(3));
  const half = renderEffect(synth(26, 630, 32), { sampleRate: 44100, channel: 0, separation: 1 });
  let hp = 0;
  for (const v of half.left) hp = Math.max(hp, Math.abs(v));
  check("render: volume 32 halves the amplitude", Math.abs(hp / lp - 0.5) < 0.02);
  const r1 = renderEffect(e, { sampleRate: 44100, channel: 1, separation: 1 });
  let l1 = 0;
  for (const v of r1.left) l1 = Math.max(l1, Math.abs(v));
  check("render: channel 1 is right", l1 === 0);
}

{
  const bank = { effects: [synth(10), synth(10), synth(10)] };
  const s = new SfxScheduler(bank);
  const a = s.request(0, 100, null);
  check("sched: first request takes channel 0, starts in the next frame", a && a.channel === 0 && a.startFrame === 101 && a.endFrame === 110);
  // same frame, channel still "free" (timer 0 until the VBL starts it): the second replaces the first
  const replaced = [];
  const b = s.request(1, 100, null, undefined, (v) => replaced.push(v));
  check("sched: two requests in one frame share the channel, the second replaces the first (double alert quirk)",
    b && b.channel === 0 && b.startFrame === 101 && replaced.length === 1 && replaced[0] === a);
  // after the start, channel 0 is busy: the next one goes to channel 1; one new voice per frame
  const c = s.request(2, 102, null);
  check("sched: busy channel is skipped", c && c.channel === 1 && c.startFrame === 103);
  const d = s.request(2, 102, null);
  check("sched: second request in the same frame lands on the same still-free channel", d && d.channel === 1 && d.startFrame === 103);
  check("sched: channel 0 is busy during its voice", s.busy(0, 105));
  const e1 = s.request(0, 105, null);
  check("sched: channels fill in order 0,1,2,3", e1 && e1.channel === 2);
  const e2 = s.request(0, 106, null);
  check("sched: fourth channel", e2 && e2.channel === 3 && e2.startFrame === 107);
  const e3 = s.request(0, 107, null);
  check("sched: all four busy: dropped", e3 === null);
  check("sched: channel 0 is free again at its end frame", !s.busy(0, 110));
  check("sched: unknown id is ignored", s.request(9, 200, null) === null);
}

{
  const bank = { effects: [synth(30), synth(30)] };
  const s = new SfxScheduler(bank);
  const a = s.request(0, 10, [1, 3]);
  check("sched/music: first preferred channel of the pair", a && a.channel === 1);
  const b = s.request(0, 12, [1, 3]);
  check("sched/music: second channel of the pair", b && b.channel === 3);
  const c = s.request(0, 14, [1, 3]);
  check("sched/music: both busy: dropped, never touches channels 0 or 2", c === null);
  const d = s.request(0, 12 + 30, [1, 3]);
  check("sched/music: free again after the duration", d && d.channel === 1);
  check("musicChannels from flags words", JSON.stringify([musicChannels(0), musicChannels(1), musicChannels(2), musicChannels(3), musicChannels(4)]) === "[[1,3],[2,3],[1,2],[1,3],null]");
}

{
  // `$11B4` tests the music-active bit (bit 1 of $1581), not the loaded track ($1580): a paused track frees all four channels.
  const bank = { effects: [synth(30)] };
  const channelsFor = (link) => effectChannelsFor(link);
  check("effectChannelsFor: active track gives its pair", JSON.stringify(channelsFor({ current: 2, active: true })) === "[1,2]");
  check("effectChannelsFor: paused track (selected, inactive) gives null = all four channels", channelsFor({ current: 2, active: false }) === null);
  check("effectChannelsFor: no track / no link gives null", channelsFor({ current: -1, active: false }) === null && channelsFor(undefined) === null);
  const s = new SfxScheduler(bank);
  const got = [0, 1, 2, 3, 4].map((i) => s.request(0, 10 + 2 * i, channelsFor({ current: 2, active: false }))?.channel ?? null);
  check("sched/paused music: four voices on channels 0-3, the fifth is dropped", got.join() === "0,1,2,3,");
  const r = new SfxScheduler(bank);
  const live = [0, 1, 2].map((i) => r.request(0, 10 + 2 * i, channelsFor({ current: 2, active: true }))?.channel ?? null);
  check("sched/active music: only the track's two channels", live.join() === "1,2,");
}

{
  // the frame-stepped model also owns the module's channels (full coverage of the events: test/audio-ownership.mjs)
  const s = new SfxScheduler({ effects: [synth(10)] });
  const v = s.request(0, 100, [1, 3]);
  check("sched/ownership: a request under music releases the module's voice at once, only on the effect's channel", v.channel === 1 && !s.moduleEnabled(1) && s.moduleEnabled(3) && s.moduleEnabled(0) && s.moduleEnabled(2));
  s.advanceTo(110);
  check("sched/ownership: the expiry under active music hands it back; events queued, start, end", s.moduleEnabled(1) && s.take().map((e) => e.type).join() === "queued,start,end");
  const n = new SfxScheduler({ effects: [synth(10)] });
  n.request(0, 100, null);
  n.advanceTo(120);
  check("sched/ownership: without music no module voice is ever touched", [0, 1, 2, 3].every((c) => n.moduleEnabled(c)));
}

// ---- real data ----------------------------------------------------------------------------------

const diskPath = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(diskPath)) {
  console.log("skip real-data checks: original/utopia-whdload/Disk.1 not found");
} else {
  const disk1 = new Uint8Array(fs.readFileSync(diskPath));
  const bank = parseSfxBank(disk1);
  const fx = bank.effects;
  check("bank: six effects", fx.length === SFX_COUNT && SFX.ALERT === 5);
  check("bank: descriptor fields in range", fx.every((e) => e.period >= 113 && e.period <= 1000 && e.volume <= 64 && e.frames >= 2 && e.data.length === e.lengthWords * 2));
  check("bank: effects 0-2 share one sample (same address and length)", fx[0].address === fx[1].address && fx[1].address === fx[2].address && fx[0].lengthWords === fx[2].lengthWords);
  check("bank: launch uses a second, different sample inside the sample region", fx[3].address > fx[0].address && fx[3].address !== fx[0].address);
  check("bank: click and alert share the 8-byte wave from the program image", fx[4].address === fx[5].address && fx[4].data.length === 8);
  const wave = Array.from(fx[4].data);
  check("bank: the wave is one symmetric cycle (second half mirrors the first)", wave.every((v, i) => v === -wave[(i + 4) % 8]), wave.join(","));
  // each sample must carry real signal
  const rms = (d) => Math.sqrt(Array.from(d).reduce((s, v) => s + v * v, 0) / d.length);
  check("bank: samples are not silent", rms(fx[0].data) > 20 && rms(fx[3].data) > 5 && rms(fx[4].data) > 20, `${rms(fx[0].data).toFixed(1)} ${rms(fx[3].data).toFixed(1)} ${rms(fx[4].data).toFixed(1)}`);
  // the played part of the long samples never runs past the data that was loaded (no wrap needed for 0..3)
  for (const e of fx.slice(0, 4)) {
    const played = effectSeconds(e) * (PAL_CLOCK / e.period);
    check(`bank: effect ${e.id} plays ${Math.round(played)} of ${e.data.length} bytes (no loop)`, played <= e.data.length);
  }
  // the game turns the DMA off after frames - 1 frames: tone effects are 20 ms and 220 ms
  check("bank: click is one frame, alert eleven", effectSeconds(fx[4]) === 0.02 && Math.abs(effectSeconds(fx[5]) - 0.22) < 1e-9);
  // render every effect, finite and non-silent, within the module mixer range
  for (const e of fx) {
    const { left, right } = renderEffect(e, { sampleRate: 44100, channel: 1 });
    let peak = 0;
    let bad = 0;
    for (let i = 0; i < left.length; i++) {
      if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) bad++;
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    check(`render: effect ${e.id} (${e.name}) finite, non-silent, in range`, bad === 0 && peak > 0.02 && peak <= 0.5, `${(left.length / 44100).toFixed(3)} s peak ${peak.toFixed(3)}`);
  }
  const alert = renderEffect(fx[5], { sampleRate: 44100, channel: 0, separation: 1, interpolation: "nearest" });
  const hz = crossings(alert.left, 0, alert.left.length) / 2 / (alert.left.length / 44100);
  check("render: alert tone pitch follows its period", Math.abs(hz - PAL_CLOCK / fx[5].period / 8) < 25, `${hz.toFixed(0)} Hz`);
}

if (failed) {
  console.log(`${failed} sfx check(s) failed`);
  process.exit(1);
}
console.log("sfx checks passed");
