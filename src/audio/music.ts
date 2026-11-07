// Public music API for the game: createMusic(disk1, disk2) and play(trackIndex).
// Tracks are numbered like the game's music load table ($14E8): 0..3. The modules live on Disk.1 and are
// decoded on first use; disk2 is accepted for API symmetry but not needed.

import { loadSong, TRACKS } from "./tracks.js";
import { ModPlayer, ModSong } from "./modplayer.js";
import { setPaulaLedFilter, WebAudioSink } from "./webaudio.js";

/**
 * A music state change, as the original's code would make it. `dmaOff` = DMACON `$F` was written (all four Paula channels
 * off, effect sounds included): `$1062` switching off, every track load `$110A`, `stop()`. `active`/`current` are the state
 * after the change.
 */
export interface MusicChange {
  readonly dmaOff: boolean;
  readonly active: boolean;
  readonly current: number;
}

export interface Music {
  readonly trackCount: number;
  /**
   * Index of the selected (loaded) track, or -1 when none is loaded (`$1580 < 0` in the original). Unchanged by
   * `setActive(false)`: a paused track stays the selected one. Not "is it audible", see `active`.
   */
  readonly current: number;
  /**
   * The "music active" state (bit 1 of `$1581`): a track is loaded and not paused. Independent of `current`:
   * `current >= 0` with `active === false` is a paused track. `active` is also what the sound-effect allocator reads.
   */
  readonly active: boolean;
  /**
   * The on/off switch of the original button `$1062`, position-preserving: `false` stops the player being rendered
   * (the module position, tick phase and channel state are kept, the `ModPlayer` is not rebuilt); `true` continues
   * from exactly there. Returns whether the state changed (false with no loaded track, or when already in that state).
   * `play()` (the original track loader `$110A`) always leaves the music active.
   */
  setActive(active: boolean): boolean;
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
  /**
   * Silence one of the four Paula channels of the module (0..3), like the original does while a sound effect
   * owns that channel. Survives track changes. See notes/formats/sfx.md.
   */
  setChannelMuted(channel: number, muted: boolean): void;
  /** Call from a gesture handler to make sure the AudioContext is running. */
  resume(): void;
  /**
   * Be told of every change of the music-active state, synchronously, after the change is complete (see `MusicChange`).
   * Returns the function that removes the listener; `dispose()` removes all of them.
   */
  onChange(listener: (change: MusicChange) => void): () => void;
  /**
   * Audio timeline tick: `listener(audioTime)` runs at the start of every rendered block with the AudioContext time of the
   * block, also while the music is paused or stopped (silent blocks are still pulled). This is the clock for everything that has
   * to follow the audio (the effect model, the fade-out) instead of wall-clock timers; it does not run while the context is
   * suspended. Returns the function that removes the listener.
   */
  onBlock(listener: (audioTime: number) => void): () => void;
  /** Module title text read from the module header at runtime. */
  title(track: number): string;
  dispose(): void;
}

export function createMusic(disk1: Uint8Array, _disk2?: Uint8Array): Music {
  const sink = new WebAudioSink();
  const songs = new Map<number, ModSong>();
  let current = -1;
  let volume = 1;
  // end of a running fade-out on the AudioContext clock (checked by the block tick), null = no fade
  let fadeEnd: number | null = null;
  const changeListeners = new Set<(change: MusicChange) => void>();
  const blockListeners = new Set<(audioTime: number) => void>();
  let player: ModPlayer | null = null;
  // Music-inactive with a track still loaded (original: bit 1 of `$1581` clear, `$1580 >= 0`). `current` is kept.
  let paused = false;
  const muted = [false, false, false, false];

  const song = (track: number): ModSong => {
    let s = songs.get(track);
    if (!s) {
      s = loadSong(disk1, track);
      songs.set(track, s);
    }
    return s;
  };

  const cancelFade = (): void => {
    fadeEnd = null;
  };

  const notify = (dmaOff: boolean): void => {
    const change: MusicChange = { dmaOff, active: current >= 0 && !paused, current };
    for (const listener of [...changeListeners]) listener(change);
  };

  const music: Music = {
    trackCount: TRACKS.length,
    get current() {
      return current;
    },
    get active() {
      return current >= 0 && !paused;
    },
    setActive(active) {
      if (current < 0 || paused === !active) return false;
      paused = !active;
      // Pausing only detaches the player from the sink (silence); the player object keeps its position and is re-attached as is.
      sink.setPlayer(paused ? null : player);
      if (!paused) {
        sink.setVolume(volume);
        sink.resume();
      }
      notify(paused); // switching off writes DMACON $F (`$1062`), switching on only sets bit 1
      return true;
    },
    play(track, restart = false) {
      if (track < 0 || track >= TRACKS.length) return;
      cancelFade();
      if (track === current && !restart) {
        const wasPaused = paused;
        if (paused) {
          paused = false;
          sink.setPlayer(player);
        }
        sink.setVolume(volume);
        sink.resume();
        if (wasPaused) notify(false);
        return;
      }
      current = track;
      paused = false;
      if (!WebAudioSink.supported) {
        notify(true);
        return;
      }
      const rate = sink.sampleRate;
      // Browser output is filtered once at the shared Paula bus, so SFX and music obey the same E0 state.
      player = new ModPlayer(song(track), { sampleRate: rate, paulaFilter: "none", onPaulaFilterChange: setPaulaLedFilter });
      muted.forEach((m, ch) => player?.setChannelMuted(ch, m));
      sink.setPlayer(player);
      sink.setVolume(volume);
      sink.resume();
      notify(true); // `$110A`: bit 1 cleared, DMACON $F, load, bit 1 set again
    },
    stop() {
      cancelFade();
      const wasLoaded = current >= 0;
      current = -1;
      paused = false;
      player = null;
      sink.setPlayer(null);
      if (wasLoaded) notify(true);
    },
    fadeOut(seconds = 1) {
      if (current < 0) return;
      cancelFade();
      if (!sink.live) {
        // no audio graph (no WebAudio, or never started): there is no clock to fade on
        music.stop();
        return;
      }
      sink.fadeTo(0, seconds);
      fadeEnd = sink.currentTime + seconds + 0.05; // finished by the block tick on the audio clock, never by a wall-clock timer
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      sink.setVolume(volume);
    },
    setChannelMuted(channel, m) {
      if (channel < 0 || channel >= muted.length) return;
      muted[channel] = m;
      player?.setChannelMuted(channel, m);
    },
    resume() {
      sink.resume();
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    onBlock(listener) {
      blockListeners.add(listener);
      return () => {
        blockListeners.delete(listener);
      };
    },
    title(track) {
      return song(track).title;
    },
    dispose() {
      cancelFade();
      const wasLoaded = current >= 0;
      current = -1;
      paused = false;
      player = null;
      sink.setPlayer(null);
      if (wasLoaded) notify(true);
      changeListeners.clear();
      blockListeners.clear();
      sink.dispose(); // also removes the block listener
    },
  };
  // the sink's block tick is the music's audio clock: it finishes a fade-out, then lets the listeners follow the timeline
  sink.setBlockListener((audioTime) => {
    if (fadeEnd !== null && audioTime >= fadeEnd) music.stop();
    for (const listener of [...blockListeners]) listener(audioTime);
  });
  return music;
}
