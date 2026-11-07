// Position-preserving music on/off of `Music` (the original button `$1062`, notes/formats/music.md "Music on/off") and the
// sound-effect channel rule that follows from the music-active bit (`$11B4`, notes/formats/sfx.md). Runs the real Music API
// against a fake AudioContext whose ScriptProcessor blocks are pulled by hand, so the rendered PCM can be compared exactly.
// Uses the user's own Disk.1 in original/utopia-whdload (read-only); skipped when it is missing. Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(d1)) {
  console.log("music-pause tests skipped: original/utopia-whdload/Disk.1 not found");
  process.exit(0);
}

// ---- minimal fake WebAudio: just enough for WebAudioSink / the shared Paula bus -----------------------------------------
const processors = [];
const param = () => ({ value: 1, setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {} });
const node = () => ({ gain: param(), connect() {}, disconnect() {} });
globalThis.AudioContext = class {
  sampleRate = 44100;
  currentTime = 0;
  state = "running";
  destination = {};
  createGain() { return node(); }
  createIIRFilter() { return node(); }
  createScriptProcessor() {
    const p = { ...node(), onaudioprocess: null };
    processors.push(p);
    return p;
  }
  resume() { return Promise.resolve(); }
};

const { createMusic } = await import("../dist/audio/music.js");
const { effectChannelsFor, SfxScheduler, musicChannels } = await import("../dist/audio/sfx.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const disk1 = new Uint8Array(fs.readFileSync(d1));
const BLOCK = 2048;
/** Pull `blocks` ScriptProcessor blocks of one Music (identified by its processor); returns one interleaved Float32Array. */
function pull(proc, blocks) {
  const out = new Float32Array(blocks * BLOCK * 2);
  for (let b = 0; b < blocks; b++) {
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    proc.onaudioprocess({ outputBuffer: { getChannelData: (c) => (c === 0 ? l : r) } });
    for (let i = 0; i < BLOCK; i++) {
      out[(b * BLOCK + i) * 2] = l[i];
      out[(b * BLOCK + i) * 2 + 1] = r[i];
    }
  }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const silent = (a) => a.every((v) => v === 0);
const loud = (a) => a.some((v) => Math.abs(v) > 0.01);

/** A Music with its processor: the processor appears when the sink first touches the context (play -> sampleRate). */
function started(track) {
  const music = createMusic(disk1);
  music.play(track);
  return { music, proc: processors[processors.length - 1] };
}

// ---- state before anything is loaded (image default `$1580 = $FF`, bit 1 clear) ---------------------------------------------
{
  const m = createMusic(disk1);
  check("fresh Music: nothing selected, not active", m.current === -1 && m.active === false);
  check("setActive with no track loaded changes nothing", m.setActive(true) === false && m.setActive(false) === false && m.active === false && m.current === -1);
}

// ---- pause keeps the position, resume continues exactly there --------------------------------------------------------------
{
  const ref = started(1); // uninterrupted reference
  const sub = started(1); // paused in the middle
  const BEFORE = 30;
  const AFTER = 30;
  const refAll = pull(ref.proc, BEFORE + AFTER);
  const subBefore = pull(sub.proc, BEFORE);
  check("both renders start identically (deterministic mixer)", same(subBefore, refAll.subarray(0, BEFORE * BLOCK * 2)) && loud(subBefore));
  check("playing: active and selected", sub.music.active === true && sub.music.current === 1);

  check("setActive(false) reports the change", sub.music.setActive(false) === true);
  check("paused: not active, the track stays selected", sub.music.active === false && sub.music.current === 1);
  check("paused: the sink outputs silence", silent(pull(sub.proc, 7)));
  check("pausing twice is a no-op", sub.music.setActive(false) === false && sub.music.active === false && sub.music.current === 1);
  check("the silent blocks did not advance the module", silent(pull(sub.proc, 3)));

  check("setActive(true) reports the change", sub.music.setActive(true) === true);
  check("resumed: active again, same track", sub.music.active === true && sub.music.current === 1);
  const subAfter = pull(sub.proc, AFTER);
  check("resume continues exactly where it stopped (PCM equals the uninterrupted render)", same(subAfter, refAll.subarray(BEFORE * BLOCK * 2)) && loud(subAfter));
  check("resuming while active is a no-op", sub.music.setActive(true) === false);
}

// ---- selecting / loading interacts with the pause the way `$110A` does ---------------------------------------------------
{
  const ref = started(2);
  const start = pull(ref.proc, 20);
  const m = started(2);
  pull(m.proc, 25);
  m.music.setActive(false);
  m.music.play(2); // same track, no restart: the loader semantics of play() leave the music active
  check("play() of the paused current track makes the music active again", m.music.active === true && m.music.current === 2);
  const resumed = pull(m.proc, 5);
  const refLater = started(2);
  pull(refLater.proc, 25);
  check("play() without restart on a paused track continues from the pause position", same(resumed, pull(refLater.proc, 5)));

  m.music.setActive(false);
  m.music.play(2, true); // `$110A` always reloads and restarts, and leaves bit 1 set
  check("play(track, restart) while paused restarts and is active", m.music.active === true && m.music.current === 2);
  check("the restarted module begins at its first row", same(pull(m.proc, 20), start));

  m.music.setActive(false);
  m.music.play(3);
  check("selecting another track while paused: active, new track selected", m.music.active === true && m.music.current === 3);
}

// ---- stop() unloads: paused state does not leak into the next track --------------------------------------------------------
{
  const m = started(0);
  m.music.setActive(false);
  m.music.stop();
  check("stop() while paused: nothing selected, not active", m.music.current === -1 && m.music.active === false);
  check("a stopped Music cannot be switched on", m.music.setActive(true) === false && m.music.active === false);
  m.music.play(1);
  check("the next track starts active", m.music.active === true && m.music.current === 1);
}

// ---- sound-effect channels follow the active bit, not the selected track (`$11B4`) ----------------------------------------
{
  const synth = (frames) => ({ id: 0, name: "t", address: 0, data: new Int8Array(8), lengthWords: 4, period: 400, volume: 64, frames });
  const link = (current, active) => ({ current, active });

  check("active track: its flags pair", JSON.stringify(effectChannelsFor(link(1, true))) === JSON.stringify(musicChannels(1)) && effectChannelsFor(link(1, true)).length === 2);
  check("paused track (selected, inactive): no restriction", effectChannelsFor(link(1, false)) === null);
  check("nothing loaded: no restriction", effectChannelsFor(link(-1, false)) === null && effectChannelsFor(undefined) === null);

  // End to end with a real Music: pause/resume flips the candidate set the allocator sees.
  const { music } = started(0); // flags pair for track 0 is channels 1 and 3
  const s = new SfxScheduler({ effects: [synth(30)] });
  const playing = [];
  for (let i = 0; i < 3; i++) playing.push(s.request(0, 10 + 2 * i, effectChannelsFor(music))?.channel ?? null);
  check("music active: effects use only the track's channels (1, 3) and the third request is dropped", playing.join() === "1,3,");
  music.setActive(false);
  const free = new SfxScheduler({ effects: [synth(30)] });
  const paused = [];
  for (let i = 0; i < 5; i++) paused.push(free.request(0, 10 + 2 * i, effectChannelsFor(music))?.channel ?? null);
  check("music paused: all four channels are candidates, lowest first, fifth dropped", paused.join() === "0,1,2,3,", paused.join());
  check("the selected track did not change meanwhile", music.current === 0);
  music.setActive(true);
  check("music resumed: restricted to the pair again", JSON.stringify(effectChannelsFor(music)) === JSON.stringify(musicChannels(0)));
}

// ---- the transitions are announced the way the original performs them (`onChange`; the effect model listens) ----------------
{
  const { music } = started(1);
  const log = [];
  music.onChange((c) => log.push(`${c.dmaOff ? "F" : "-"}${c.active ? "a" : "p"}${c.current}`));
  music.setActive(false); // `$1062` off: bit 1 cleared and DMACON $F
  music.setActive(true); // `$1062` on: only bit 1
  music.setActive(true); // no change, no event
  music.play(1); // already playing, no restart: nothing
  music.play(1, true); // `$110A`: DMACON $F, music active afterwards
  check("onChange: off = DMACON $F, on = bit only, repeats silent, a track load = DMACON $F and active", log.join(" ") === "Fp1 -a1 Fa1", log.join(" "));
}

if (failed) {
  console.log(`${failed} music-pause check(s) FAILED`);
  process.exit(1);
}
console.log("music-pause checks passed");
