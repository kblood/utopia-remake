// Public music API for the game: createMusic(disk1, disk2) and play(trackIndex).
// Tracks are numbered like the game's music load table ($14E8): 0..3. The modules live on Disk.1 and are
// decoded on first use; disk2 is accepted for API symmetry but not needed.

import { loadSong, TRACKS } from "./tracks.js";
import { ModPlayer, ModSong } from "./modplayer.js";
import { WebAudioSink } from "./webaudio.js";

export interface Music {
  readonly trackCount: number;
  /** Index of the track being played, or -1. */
  readonly current: number;
  /**
   * Start a track (loops forever). Call it from a user-gesture handler the first time so the browser lets audio
   * start. Re-playing the track that is already playing does nothing unless `restart` is true.
   */
  play(track: number, restart?: boolean): void;
  stop(): void;
  /** Fade out over `seconds` (default 1) and then stop. */
  fadeOut(seconds?: number): void;
  /** Master volume 0..1 (default 1). */
  setVolume(volume: number): void;
  /** Call from a gesture handler to make sure the AudioContext is running. */
  resume(): void;
  /** Module title text read from the module header at runtime. */
  title(track: number): string;
  dispose(): void;
}

export function createMusic(disk1: Uint8Array, _disk2?: Uint8Array): Music {
  const sink = new WebAudioSink();
  const songs = new Map<number, ModSong>();
  let current = -1;
  let volume = 1;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  const song = (track: number): ModSong => {
    let s = songs.get(track);
    if (!s) {
      s = loadSong(disk1, track);
      songs.set(track, s);
    }
    return s;
  };

  const cancelFade = (): void => {
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    stopTimer = undefined;
  };

  const music: Music = {
    trackCount: TRACKS.length,
    get current() {
      return current;
    },
    play(track, restart = false) {
      if (track < 0 || track >= TRACKS.length) return;
      cancelFade();
      if (track === current && !restart) {
        sink.setVolume(volume);
        sink.resume();
        return;
      }
      current = track;
      if (!WebAudioSink.supported) return;
      const rate = sink.sampleRate;
      sink.setPlayer(new ModPlayer(song(track), { sampleRate: rate }));
      sink.setVolume(volume);
      sink.resume();
    },
    stop() {
      cancelFade();
      current = -1;
      sink.setPlayer(null);
    },
    fadeOut(seconds = 1) {
      if (current < 0) return;
      sink.fadeTo(0, seconds);
      cancelFade();
      stopTimer = setTimeout(() => music.stop(), seconds * 1000 + 50);
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      sink.setVolume(volume);
    },
    resume() {
      sink.resume();
    },
    title(track) {
      return song(track).title;
    },
    dispose() {
      cancelFade();
      current = -1;
      sink.dispose();
    },
  };
  return music;
}
