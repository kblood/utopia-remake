// Locates and decodes the music modules on Disk.1. See notes/formats/music.md.
// Nothing from the original is stored here, only the sector layout; modules are unpacked at runtime.

import { SECTOR_SIZE, SectorRange } from "../data/picture.js";
import { unpackLz } from "../data/unpack.js";
import { ModSong, parseMod } from "./modplayer.js";

export interface TrackEntry extends SectorRange {
  /** Flags word of the game's load table at $14E8 (meaning not fully known). */
  flags: number;
}

/** The game's music load table ($14E8), in table order: the track index the game uses (0..3). */
export const TRACKS: readonly TrackEntry[] = [
  { first: 0x4ad, last: 0x59a, flags: 0x103 },
  { first: 0x59b, last: 0x617, flags: 0x203 },
  { first: 0x618, last: 0x6eb, flags: 0x102 },
  { first: 0x3c3, last: 0x4ac, flags: 0x103 },
];

/** Unpacked module bytes of a track (a plain ProTracker M.K. file). */
export function unpackTrack(disk1: Uint8Array, track: number): Uint8Array {
  const entry = TRACKS[track];
  if (!entry) throw new Error(`unpackTrack: no track ${track}`);
  return unpackLz(disk1.subarray(entry.first * SECTOR_SIZE, (entry.last + 1) * SECTOR_SIZE));
}

export function loadSong(disk1: Uint8Array, track: number): ModSong {
  return parseMod(unpackTrack(disk1, track));
}
