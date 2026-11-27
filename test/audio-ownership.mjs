// Music/SFX channel ownership, interruption and cancellation (notes/formats/sfx.md "Channel ownership, interruption and
// cancellation"; static trace of `$11B4`, `$1264`, `$1062`, `$10BC`, `$110A`, player commands 7/8). Synthetic only for the
// model and the WebAudio projection (a fake AudioContext with a hand-driven clock and a synthetic Disk.1 that holds just the
// six effect descriptors); the parts that need the real `Music` skip when the user's Disk.1 is missing. Run after `npm run build`.
// Nothing here compares against an emulator or an audio capture.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- the only wall clock these tests allow the audio code to touch is none: count every timer it arms --------------------------
let timerCalls = 0;
for (const name of ["setTimeout", "setInterval"]) {
  const real = globalThis[name];
  globalThis[name] = (...args) => {
    timerCalls++;
    return real(...args);
  };
}

// ---- fake WebAudio: a clock the test moves by hand, recording buffer sources, pulled script processors ----------------------------
let now = 0;
const processors = [];
const sources = [];
const param = () => ({ value: 1, setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {} });
const node = () => ({ gain: param(), connect() {}, disconnect() {} });
globalThis.AudioContext = class {
  sampleRate = 44100;
  state = "running";
  destination = {};
  get currentTime() {
    return now;
  }
  createGain() { return node(); }
  createIIRFilter() { return node(); }
  createScriptProcessor() {
    const p = { ...node(), onaudioprocess: null };
    processors.push(p);
    return p;
  }
  createBuffer() { return { copyToChannel() {} }; }
  createBufferSource() {
    const n = { ...node(), buffer: null, started: null, stopCalls: 0, onended: null };
    n.start = (when) => { n.started = when; };
    n.stop = () => { n.stopCalls++; };
    sources.push(n);
    return n;
  }
  resume() { return Promise.resolve(); }
};

const { SfxScheduler, createSfx, SFX } = await import("../dist/audio/sfx.js");
const { createMusic } = await import("../dist/audio/music.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const types = (events) => events.map((e) => e.type + (e.reason ? ":" + e.reason : "")).join(",");
const live = (n) => n.started !== null && n.stopCalls === 0;

// =================================================================================================================================
// A. The pure model (no AudioContext): durations 10, 6 and 2 frames
// =================================================================================================================================

const bank = { effects: [{ frames: 10, volume: 64 }, { frames: 6, volume: 32 }, { frames: 2, volume: 64 }] };
const fresh = (frame = 100) => {
  const s = new SfxScheduler(bank);
  s.advanceTo(frame);
  return s;
};

{
  // command 7 runs at the request, command 8 at the expiry
  const s = fresh();
  const v = s.request(0, 100, [1, 3]);
  check("model: request under music takes the first channel of the pair, starts in the next frame", v.channel === 1 && v.startFrame === 101 && v.endFrame === 110 && v.status === "pending");
  check("model: the module's voice is released at the REQUEST frame, before the effect starts", !s.moduleEnabled(1) && s.moduleEnabled(3) && s.moduleEnabled(0) && s.moduleEnabled(2));
  check("model: the request produced one queued event", types(s.take()) === "queued");
  s.advanceTo(101);
  check("model: start event in the next frame", types(s.take()) === "start" && v.status === "playing");
  s.advanceTo(109);
  check("model: the module stays released until the timer is over", !s.moduleEnabled(1) && s.busy(1, 109));
  s.advanceTo(110);
  check("model: expiry under active music hands the voice back (command 8)", s.moduleEnabled(1) && !s.busy(1, 110) && types(s.take()) === "end:expired" && v.status === "ended");
}

{
  // overwriting a pending entry
  const s = fresh();
  const a = s.request(0, 100, [1, 3]);
  const replaced = [];
  const b = s.request(1, 100, [1, 3], undefined, (old) => replaced.push(old));
  check("model: second request in the same frame takes the same channel and replaces the first", b.channel === 1 && replaced[0] === a && a.status === "dropped");
  check("model: events: queued, drop(replaced), queued", types(s.take()) === "queued,drop:replaced,queued");
  check("model: the replacement takes the pending slot (same start frame), shorter effect, volume from its descriptor", b.startFrame === 101 && b.endFrame === 106 && b.volume === 32);
  s.advanceTo(106);
  const ev = s.take();
  check("model: only the replacement ever starts", types(ev) === "start,end:expired" && ev[0].voice === b && s.moduleEnabled(1));
}

{
  // both channels of the pair busy: dropped, nothing touched
  const s = fresh();
  s.request(0, 100, [1, 3]);
  s.request(0, 101, [1, 3]);
  s.advanceTo(102); // the second voice starts in frame 102
  s.take();
  const before = [0, 1, 2, 3].map((c) => s.moduleEnabled(c)).join();
  const c = s.request(0, 102, [1, 3]);
  check("model: both channels of the pair busy: request dropped", c === null);
  check("model: a dropped request changes no ownership and queues nothing", [0, 1, 2, 3].map((x) => s.moduleEnabled(x)).join() === before && s.take().length === 0 && s.channelState(1).pending === null);
  check("model: channels 0 and 2 stay with the module", s.moduleEnabled(0) && s.moduleEnabled(2));
}

{
  // `$1062` off while an effect sounds, then music back on
  const s = fresh();
  const v = s.request(0, 100, [1, 3]);
  s.advanceTo(105);
  s.take();
  s.musicChanged(105, null, true);
  const ev = s.take();
  check("model: music off (DMACON $F) cuts the sounding effect", types(ev) === "cut" && ev[0].voice === v && v.status === "cut");
  check("model: ... but the timer goes on: the channel stays busy until the original end", s.busy(1, 109) && !s.busy(1, 110));
  check("model: expiry while the music is off clears the DMA bit and hands NOTHING back (traced: command 8 needs bit 1)", !s.moduleEnabled(1));
  s.take(); // the expiry event
  s.musicChanged(111, [1, 3], false);
  check("model: music on again does not cut and does not repair the released voice", s.take().length === 0 && !s.moduleEnabled(1));
  const again = s.request(1, 112, [1, 3]);
  check("model: the next effect on that channel takes it again", again.channel === 1 && again.startFrame === 113);
  s.advanceTo(118);
  check("model: and its expiry under active music repairs the module voice", s.moduleEnabled(1));
}

{
  // `$110A` reload: DMACON $F, music active afterwards, timer continues
  const s = fresh();
  const v = s.request(0, 100, [1, 3]);
  s.advanceTo(105);
  s.take();
  s.musicChanged(105, [2, 3], true); // another track, different pair
  check("model: a track load cuts the effect sound", types(s.take()) === "cut" && v.status === "cut");
  check("model: the module voice stays released across the reload", !s.moduleEnabled(1));
  s.advanceTo(110);
  check("model: expiry after the reload (music active again) hands the voice back", s.moduleEnabled(1));
  const w = s.request(0, 111, [2, 3]);
  check("model: new requests follow the new track's pair", w.channel === 2);
}

{
  // `$10BC` effects off / on
  const s = fresh();
  const a = s.request(0, 100, null); // channel 0, starts 101
  s.advanceTo(101);
  const b = s.request(0, 101, null); // channel 1, pending, starts 102
  s.take();
  s.setEnabled(101, false);
  check("model: effects off: running voice ends 'disabled', pending voice is held", types(s.take()) === "end:disabled,drop:held" && a.status === "ended" && b.status === "held");
  check("model: effects off clears the timers at once", !s.busy(0, 101) && !s.busy(1, 101) && s.enabled === false);
  check("model: requests are refused while the effects are off", s.request(0, 101, null) === null && s.take().length === 0);
  s.advanceTo(120);
  check("model: nothing starts while the effects are off; the queue entry stays", s.channelState(1).pending === b && b.status === "held" && s.take().length === 0);
  s.setEnabled(120, true);
  check("model: effects on re-announces the held voice for the next frame", types(s.take()) === "queued" && b.startFrame === 121 && b.status === "pending");
  const c = s.request(1, 120, null); // channel 0 is free again (timers were cleared): lowest channel first
  check("model: a new request takes the freed channel 0 and the held voice moves back one frame", c.channel === 0 && c.startFrame === 121 && b.startFrame === 122);
  check("model: both were announced (new voice, then the shifted one)", types(s.take()) === "queued,queued");
  s.advanceTo(121);
  check("model: one start per frame, lowest channel first (121: channel 0)", types(s.take()) === "start" && c.status === "playing" && b.status === "pending");
  s.advanceTo(122);
  check("model: ... then channel 1 with a fresh timer", types(s.take()) === "start" && b.status === "playing" && b.startFrame === 122 && b.endFrame === 131);
}

{
  // effects off under active music: the module is not handed back either
  const s = fresh();
  s.request(0, 100, [1, 3]);
  s.advanceTo(103);
  s.setEnabled(103, false);
  s.setEnabled(104, true);
  s.advanceTo(130);
  check("model: effects off under active music leaves the module voice released (no command 8)", !s.moduleEnabled(1));
}

{
  // disposal
  const s = fresh();
  const a = s.request(0, 100, null);
  s.advanceTo(101);
  const b = s.request(0, 101, null);
  s.take();
  s.dispose();
  check("model: dispose ends the running voice and drops the pending one", types(s.take()) === "end:dispose,drop:dispose" && a.status === "ended" && b.status === "dropped");
  check("model: after dispose nothing is accepted and nothing is produced", s.request(0, 105, null) === null && s.busy(0, 200) === false && s.take().length === 0);
  s.dispose();
  s.musicChanged(300, [1, 3], true);
  s.setEnabled(301, false);
  check("model: later calls and a second dispose are inert", s.take().length === 0);
}

{
  // timer boundaries and idle jumps
  const s = fresh();
  const v = s.request(2, 100, null); // 2 frames: sounds for one
  check("model: a duration of 2 frames is busy in its start frame only", v.endFrame === 102 && s.busy(0, 101) && !s.busy(0, 102));
  s.advanceTo(2_000_000_000);
  check("model: an idle jump does not step frame by frame", s.frame === 2_000_000_000);
  s.advanceTo(5);
  check("model: the clock never runs backwards", s.frame === 2_000_000_000);
}

{
  // `$1237C` writes the blast volume into the shared descriptor before each `$11B4` request, and the starter reads it when the entry starts
  // (`$12C0`). Requests in one frame all pick channel 0 (a pending entry does not make a channel busy), so each replaces the one before:
  // a footprint leaves ONE audible entry, sounding at the value written last.
  const s = fresh();
  const cells = [s.request(0, 100, null, 64), s.request(0, 100, null, 64), s.request(0, 100, null, 64), s.request(0, 100, null, 32)];
  check("footprint: four requests in one frame all take channel 0 and replace one another; only the last stays pending", cells.every((v) => v.channel === 0) && cells.slice(0, 3).every((v) => v.status === "dropped") && s.channelState(0).pending === cells[3]);
  check("footprint: the descriptor holds the last write (32) and the surviving entry carries it", s.volumeOf(0) === 32 && cells[3].volume === 32);
  s.take();
  s.advanceTo(101);
  const starts = s.take().filter((e) => e.type === "start").map((e) => `${e.voice.channel}@${e.frame}:${e.voice.volume}`).join();
  check("footprint: exactly one start, at 32", starts === "0@101:32", starts);
}

{
  // music changes between two requests of one frame (on -> off): channel 0 is free again, so two entries of one descriptor are pending
  // at once; the write reaches both, and the first to start reads the value written last
  const s = fresh();
  const a = s.request(0, 100, [1, 3], 64); // channel 1, start 101
  const b = s.request(0, 100, null, 32); // music off: channel 0 is first free, start 101; the write of 32 reaches a
  check("pending pair: channel 0 and channel 1 both pending, both carry the descriptor's 32", b.channel === 0 && a.channel === 1 && a.volume === 32 && b.volume === 32 && s.volumeOf(0) === 32);
  s.take();
  s.advanceTo(102);
  const starts = s.take().filter((e) => e.type === "start").map((e) => `${e.voice.channel}@${e.frame}:${e.voice.volume}`).join();
  check("pending pair: channel 0 starts in 101, channel 1 in 102, both at 32", starts === "0@101:32,1@102:32", starts);
}

{
  // a write never changes an entry that has started: the DMA's VOL was written at the start
  const s = fresh();
  const a = s.request(0, 100, null, 64); // channel 0, start 101
  s.take();
  s.advanceTo(101);
  check("started entry: starts at 64", types(s.take()) === "start" && a.status === "playing" && a.volume === 64);
  const b = s.request(0, 101, null, 32); // channel 0 is busy: channel 1, start 102
  const ev = s.take();
  check("started entry: a later write (32) leaves the playing entry at 64 and sounds the new one at 32", a.volume === 64 && b.channel === 1 && b.volume === 32 && !ev.some((e) => e.voice === a), types(ev));
  s.advanceTo(102);
  check("started entry: the new entry starts at 32", s.take().some((e) => e.type === "start" && e.voice === b && b.volume === 32));
}

{
  // music active on channels 1 and 2, both busy: a request with no free channel is dropped, but its descriptor write persists
  const s = fresh();
  const a = s.request(0, 100, [1, 2], 64); // channel 1, start 101, busy to 110
  s.advanceTo(101);
  const b = s.request(0, 101, [1, 2], 64); // channel 2, start 102
  s.advanceTo(102);
  const c = s.request(0, 102, [1, 2], 32); // both busy: dropped, writes 32
  check("dropped write: no free channel, no voice, and the descriptor takes 32", c === null && s.volumeOf(0) === 32 && a.channel === 1 && b.channel === 2);
  s.take();
  s.advanceTo(110); // a's timer ends in frame 110: channel 1 is free again
  const d = s.request(0, 110, [1, 2]); // no write: the next entry sounds at the persisted 32
  check("dropped write: the next entry on the freed channel sounds at the persisted 32", d !== null && d.channel === 1 && d.volume === 32, d && `${d.channel}/${d.volume}`);
}

{
  // effects off ($10BC): a refused request still writes the descriptor; the held entry takes that volume when the effects come back
  const s = fresh();
  const a = s.request(0, 100, null, 64); // channel 0, pending for 101
  s.setEnabled(100, false);
  const refused = s.request(0, 100, null, 32);
  check("held write: the refused request makes no voice, the held entry keeps status held and takes the new volume", refused === null && a.status === "held" && a.volume === 32 && s.volumeOf(0) === 32);
  s.take();
  s.setEnabled(103, true);
  s.advanceTo(104);
  const starts = s.take().filter((e) => e.type === "start").map((e) => `${e.voice.channel}@${e.frame}:${e.voice.volume}`).join();
  check("held write: after the effects come back the entry starts at 32 in frame 104", starts === "0@104:32" && a.startFrame === 104, starts);
}

// =================================================================================================================================
// B. WebAudio projection of the model (synthetic Disk.1, fake context)
// =================================================================================================================================

const IMAGE_SECTOR = 0x14c;
function syntheticDisk1() {
  const disk = new Uint8Array(IMAGE_SECTOR * 512 + 0x2000);
  const table = IMAGE_SECTOR * 512 + (0x1490 - 0x1000);
  const frames = [20, 12, 8, 10, 2, 12];
  const dv = new DataView(disk.buffer);
  frames.forEach((f, i) => {
    const at = table + i * 12;
    dv.setUint32(at, 0x14e0); // inside the game image region
    dv.setUint16(at + 4, 4);
    dv.setUint16(at + 6, 630);
    dv.setUint16(at + 8, 64);
    dv.setUint16(at + 10, f);
  });
  for (let i = 0; i < 8; i++) disk[IMAGE_SECTOR * 512 + (0x14e0 - 0x1000) + i] = [0, 90, 127, 90, 0, 166, 129, 166][i];
  return disk;
}
const disk1 = syntheticDisk1();

function fakeLink(init = { current: -1, active: false }, hooks = true) {
  const l = {
    current: init.current,
    active: init.active,
    mutes: [],
    changeListeners: new Set(),
    blockListeners: new Set(),
    setChannelMuted(ch, m) { l.mutes.push([ch, m]); },
    change(c) { l.current = c.current; l.active = c.active; for (const f of [...l.changeListeners]) f(c); },
    block(t) { for (const f of [...l.blockListeners]) f(t); },
  };
  if (hooks) {
    l.onChange = (f) => { l.changeListeners.add(f); return () => l.changeListeners.delete(f); };
    l.onBlock = (f) => { l.blockListeners.add(f); return () => l.blockListeners.delete(f); };
  }
  return l;
}
const mutes = (l) => JSON.stringify(l.mutes);

{
  // timeline scheduling, no link
  now = 1.0;
  const sfx = createSfx(disk1);
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW);
  const n = sources[before];
  check("sfx: one source per accepted request", sources.length === before + 1);
  check("sfx: starts on the next frame boundary of the audio clock (frame 50 -> 51 = 1.02 s)", near(n.started, 1.02) && live(n));
  sfx.dispose();
}

{
  // replacement cancels the earlier node
  now = 2.0;
  const sfx = createSfx(disk1);
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW);
  sfx.play(SFX.HIT);
  const [a, b] = [sources[before], sources[before + 1]];
  check("sfx: a replaced pending effect is cancelled, only the replacement stays scheduled", a.stopCalls === 1 && live(b) && near(b.started, 2.02));
  sfx.dispose();
  check("sfx: dispose cancels what is left", b.stopCalls === 1);
}

{
  // module ownership follows the model on the audio clock (block ticks), not on timers
  now = 3.0;
  const link = fakeLink({ current: 0, active: true }); // track 0: channels 1 and 3
  const sfx = createSfx(disk1, undefined, { music: link });
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW); // 20 frames: starts 151, expires 170 = 3.40 s
  check("sfx/music: the module voice is muted at the request", mutes(link) === "[[1,true]]" && live(sources[before]));
  now = 3.38;
  link.block(3.38);
  check("sfx/music: still muted just before the expiry", mutes(link) === "[[1,true]]");
  now = 3.4;
  link.block(3.4);
  check("sfx/music: handed back by the block tick at the expiry", mutes(link) === "[[1,true],[1,false]]");
  link.block(3.5);
  link.block(3.6);
  check("sfx/music: no second unmute (no stale callback)", mutes(link) === "[[1,true],[1,false]]");
  sfx.dispose();
}

{
  // clock frozen (suspended context): neither the model nor the mute move
  now = 3.7;
  const link = fakeLink({ current: 0, active: true });
  const sfx = createSfx(disk1, undefined, { music: link });
  sfx.play(SFX.EXPLOSION_LOW);
  for (let i = 0; i < 10; i++) link.block(3.7);
  check("sfx/music: with a frozen clock the voice stays muted however many blocks run", mutes(link) === "[[1,true]]");
  sfx.dispose();
}

{
  // music off during an effect: cut at once, channel stays busy, nothing is handed back
  now = 4.0;
  const link = fakeLink({ current: 0, active: true });
  const sfx = createSfx(disk1, undefined, { music: link });
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW); // channel 1, frames 201..220
  now = 4.1;
  link.change({ dmaOff: true, active: false, current: 0 });
  check("sfx/music: music off stops the sounding effect (DMACON $F)", sources[before].stopCalls === 1);
  sfx.play(SFX.HIT); // music inactive: all four channels, channel 1 is still busy, channel 0 is free
  const hit = sources[before + 1];
  check("sfx/music: while the music is off the effects use any free channel (0) and play", live(hit) && sources.length === before + 2);
  now = 4.5;
  link.block(4.5);
  check("sfx/music: the cut effect's expiry with the music off hands nothing back (traced stuck voice)", mutes(link) === "[[1,true]]");
  link.change({ dmaOff: false, active: true, current: 0 });
  now = 5.0;
  sfx.play(SFX.EXPLOSION_LOW); // takes channel 1 again
  now = 5.5;
  link.block(5.5);
  check("sfx/music: a later effect on the channel under active music repairs it", mutes(link) === "[[1,true],[1,false]]");
  sfx.dispose();
}

{
  // effects switch
  now = 6.0;
  const sfx = createSfx(disk1);
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW); // channel 0, start 301
  now = 6.02;
  sfx.play(SFX.HIT); // channel 1, pending, start 302
  const [a, b] = [sources[before], sources[before + 1]];
  sfx.setEnabled(false);
  check("sfx: effects off stops the sounding effect and cancels the pending one", a.stopCalls === 1 && b.stopCalls === 1 && sfx.enabled === false);
  const count = sources.length;
  sfx.play(SFX.CLICK);
  check("sfx: effects off accepts nothing", sources.length === count);
  now = 6.5;
  sfx.setEnabled(true);
  const again = sources[sources.length - 1];
  check("sfx: effects on schedules the held effect again at the next frame boundary", sources.length === count + 1 && live(again) && near(again.started, 6.52) && sfx.enabled === true);
  sfx.dispose();
}

{
  // disposal: everything cancelled, module handed back, hooks detached, later calls inert
  now = 7.0;
  const link = fakeLink({ current: 0, active: true });
  const sfx = createSfx(disk1, undefined, { music: link });
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW);
  sfx.dispose();
  check("sfx dispose: the effect is stopped and the module voice is handed back", sources[before].stopCalls === 1 && mutes(link) === "[[1,true],[1,false]]");
  check("sfx dispose: music hooks are detached", link.changeListeners.size === 0 && link.blockListeners.size === 0);
  const count = sources.length;
  now = 8.0;
  sfx.play(SFX.HIT);
  sfx.setEnabled(false);
  link.change({ dmaOff: true, active: false, current: 0 });
  link.block(8.0);
  sfx.sync();
  sfx.dispose();
  check("sfx dispose: later play/setEnabled/ticks/sync/dispose do nothing", sources.length === count && mutes(link) === "[[1,true],[1,false]]" && sfx.enabled === true);
}

{
  // a link without hooks: sync() drives the model, play() samples the music state
  now = 9.0;
  const link = fakeLink({ current: 0, active: true }, false);
  const sfx = createSfx(disk1, undefined, { music: link });
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW);
  now = 9.5;
  sfx.sync();
  check("sfx/hookless link: sync() hands the voice back at the expiry", mutes(link) === "[[1,true],[1,false]]");
  now = 10.0;
  sfx.play(SFX.EXPLOSION_LOW);
  const playing = sources[sources.length - 1];
  link.active = false; // music switched off, nobody told us
  now = 10.1;
  sfx.play(SFX.HIT);
  check("sfx/hookless link: the next play notices the switch-off and cuts the running effect", playing.stopCalls === 1 && live(sources[sources.length - 1]) && sources.length === before + 3);
  sfx.dispose();
}

{
  // WebAudio projection: a music change and a later write of the same descriptor re-schedule a pending node (the old one never sounds)
  now = 2.0; // frame 100; the first entries start in frame 101 (2.02 s) and 102 (2.04 s)
  const link = fakeLink({ current: 0, active: true }); // track 0: channels 1 and 3
  const sfx = createSfx(disk1, undefined, { music: link });
  const before = sources.length;
  sfx.play(SFX.EXPLOSION_LOW, 64); // channel 1 (the pair), start 101
  const pending = sources[before];
  check("descriptor projection: a lone request schedules one node at its start frame", sources.length === before + 1 && Math.abs(pending.started - 2.02) < 1e-9 && live(pending));
  link.change({ current: 0, active: false, dmaOff: true }); // `$1062` off: nothing is playing yet, so the pending entry is not cut
  check("descriptor projection: switching the music off does not touch a pending entry", live(pending));
  sfx.play(SFX.EXPLOSION_LOW, 32); // music off: channel 0 is first free, start 101; its write of 32 reaches the pending channel-1 entry
  const live2 = sources.slice(before).filter(live);
  check("descriptor projection: the pending node is stopped and re-scheduled (stopped once, the new node replaces it)", pending.stopCalls === 1 && live2.length === 2);
  check("descriptor projection: the two live nodes start at 2.02 s (channel 0) and 2.04 s (channel 1, re-scheduled)", live2.map((n) => Math.round(n.started * 100) / 100).sort().join() === "2.02,2.04", live2.map((n) => n.started).join());
  sfx.dispose();
}

check("sfx: not one setTimeout/setInterval was armed by the model or the WebAudio layer", timerCalls === 0, `${timerCalls} call(s)`);

// =================================================================================================================================
// C. The real Music (needs the user's Disk.1)
// =================================================================================================================================

const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("skip real-Music checks: original/utopia-whdload/Disk.1 not found");
} else {
  const real = new Uint8Array(fs.readFileSync(d1));
  const BLOCK = 2048;
  const pull = (proc, blocks = 1) => {
    for (let b = 0; b < blocks; b++) proc.onaudioprocess({ outputBuffer: { getChannelData: () => new Float32Array(BLOCK) } });
  };
  const last = () => processors[processors.length - 1];
  const timersBefore = timerCalls;

  {
    now = 20;
    const m = createMusic(real);
    const log = [];
    const off = m.onChange((c) => log.push(`${c.dmaOff ? "F" : "-"}${c.active ? "a" : "p"}${c.current}`));
    m.play(0);
    m.play(0); // same track, not paused, no restart: nothing happens
    m.setActive(false);
    m.setActive(false); // no change
    m.setActive(true);
    m.play(0, true);
    m.setActive(false);
    m.play(0); // continues the paused track
    m.play(1);
    m.stop();
    m.stop(); // nothing loaded
    check("music: change events (load = DMACON $F, pause = $F, resume only sets the bit, repeats are silent)", log.join(" ") === "Fa0 Fp0 -a0 Fa0 Fp0 -a0 Fa1 Fp-1", log.join(" "));
    off();
    m.play(2);
    check("music: an unsubscribed listener hears nothing more", log.length === 8);
    m.dispose();
  }

  {
    now = 21;
    const m = createMusic(real);
    const times = [];
    const off = m.onBlock((t) => times.push(t));
    m.play(0);
    const proc = last();
    pull(proc);
    m.setActive(false);
    now = 21.5;
    pull(proc);
    check("music: the block tick carries the audio time, also while paused", times.join() === "21,21.5", times.join());
    off();
    pull(proc);
    check("music: an unsubscribed block listener is not called", times.length === 2);
    const events = [];
    m.onChange((c) => events.push(c));
    m.dispose();
    check("music: dispose announces the unload once, detaches the sink and removes all listeners", events.length === 1 && proc.onaudioprocess === null);
  }

  {
    // fade-out on the audio clock
    now = 30;
    const m = createMusic(real);
    const events = [];
    m.onChange((c) => events.push(`${c.dmaOff ? "F" : "-"}${c.current}`));
    m.play(1);
    const proc = last();
    m.fadeOut(1);
    now = 30.5;
    pull(proc);
    now = 31.0;
    pull(proc);
    check("music fade: still playing before the fade has run out on the audio clock", m.current === 1);
    now = 31.1;
    pull(proc);
    check("music fade: stopped by the block tick once the audio clock passed the end", m.current === -1 && m.active === false && events.join() === "F1,F-1", events.join());
    m.play(2);
    m.fadeOut(1);
    now = 31.5;
    m.play(3); // a new track cancels the fade
    now = 33;
    pull(proc);
    check("music fade: a track load cancels a running fade (no stale stop)", m.current === 3 && m.active === true);
    m.dispose();
  }

  {
    // real Music + Sfx end to end
    now = 40;
    const music = createMusic(real);
    music.play(0); // channels 1 and 3
    const proc = last();
    const log = [];
    const link = {
      get current() { return music.current; },
      get active() { return music.active; },
      setChannelMuted: (c, m) => { log.push([c, m]); music.setChannelMuted(c, m); },
      onChange: (l) => music.onChange(l),
      onBlock: (l) => music.onBlock(l),
    };
    const sfx = createSfx(disk1, undefined, { music: link });
    const before = sources.length;
    sfx.play(SFX.EXPLOSION_LOW); // frames 2001..2020 = 40.02 .. 40.40 s
    check("music+sfx: the effect owns channel 1 from the request", JSON.stringify(log) === "[[1,true]]" && live(sources[before]));
    now = 40.1;
    music.setActive(false);
    check("music+sfx: pausing the music stops the effect sound", sources[before].stopCalls === 1);
    music.setActive(true);
    now = 40.5;
    pull(proc);
    check("music+sfx: the block tick hands the voice back at the original end (music active again)", JSON.stringify(log) === "[[1,true],[1,false]]", JSON.stringify(log));
    sfx.dispose();
    music.dispose();
  }

  check("music: no wall-clock timer armed by the real Music, fades included", timerCalls === timersBefore, `${timerCalls - timersBefore} call(s)`);
}

if (failed) {
  console.log(`${failed} audio-ownership check(s) FAILED`);
  process.exit(1);
}
console.log("audio-ownership checks passed");
