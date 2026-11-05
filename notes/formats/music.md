# Music: modules on Disk.1 and the player

Nothing from the original is reproduced here; only sector numbers, sizes and structure numbers. Sector = 512 bytes, image offset = sector * 512 in `Disk.1`. Code: `src/audio/` (`tracks.ts` locates and unpacks, `modplayer.ts` parses and mixes, `webaudio.ts` outputs, `music.ts` is the API). Test: `test/music.mjs`.

## Where the music is (VERIFIED)

The game has four tracks, numbered 0..3 by the load table at `$14E8` of the game image (`game-proper.md`, 4 entries of 10 bytes: flags word, first sector, last sector, packed-buffer address). All four are on `Disk.1` (not on `Disk.2` or `disk.4`), packed with the byte LZ/RLE stream of `picture-lz.md` (`unpackLz`), one stream per sector range, no extra header. Unpacked they are plain ProTracker `M.K.` modules:

| Track | Sectors | Unpacked | Song length | Patterns | Samples used / looped / finetuned | Duration to first wrap |
|---|---|---|---|---|---|---|
| 0 | `$4AD`-`$59A` | 160,170 | 15 | 15 | 3 / 0 / 0 | 153.6 s |
| 1 | `$59B`-`$617` | 103,956 | 55 | 33 | 12 / 2 / 3 | 512.0 s |
| 2 | `$618`-`$6EB` | 159,822 | 46 | 31 | 15 / 1 / 0 | 359.7 s |
| 3 | `$3C3`-`$4AC` | 160,028 | 55 | 34 | 19 / 4 / 0 | 430.1 s |

Load-table flags words: `$103`, `$203`, `$102`, `$103` (tracks 0..3). The game copies the word to `$1582` and its two bytes are used as channel numbers into the channel timer table `$1518` by the tick helper at `$11B4` (HYPOTHESIS: sound-effect channel arbitration; not needed for playback).

Track 3 is the module that the boot stage plays during the slide show (`graphics-and-music-blocks.md`, block C). The 20-byte title field of each module names it (track 0 the title tune, tracks 1-3 the three in-game tunes); read it at runtime with `Music.title(i)`, it is not stored in the repo.

Size check for every track: `1084 + patterns * 1024 + sum(sample lengths) = unpacked size` exactly (tested). All note periods are from the standard 36-note table (tested), every pattern cell uses sample numbers <= 24.

Effect census (cells with non-zero effect or parameter), identical set across tracks: 0, 1, 2, 3, 4, 5, 6, A, C, D, E (sub-effects 0, 9 and D only) and F. The F parameters are speeds only (3, 4, 6, 8, 12, 16), never BPM values (>= 32). Track 1 uses effect 5 (tone portamento + volume slide) and three samples with finetune, so the finetune period table matters there. Effects 7 (tremolo), 9 (sample offset), B, E3-E8, EA-EF do not occur in the shipped modules; they are implemented in `modplayer.ts` anyway.

## How the game plays it (VERIFIED structure, details HYPOTHESIS)

Loader at `$1100`-`$11B2` (game image loaded at `$1000`; file offset = address + `$28800` for the `Disk.1` image):

1. Track number `d2` (`byte $8CFE`, must be < 4) is stored at `$1580`; the 10-byte table entry gives flags (`$1582`), sector range and packed buffer.
2. The sectors are read by the slave read hook `$93F8`, unpacked by `$8BEA` to `$43460`.
3. `jsr $158A` with `d0 = 0` (init, `d3 = 1` when byte `$910` is not `$32`, i.e. a 60 Hz machine) returns the tick address in `a0` (stored at `$1586`), then `d0 = 1`, `a0 = $43460` starts the module; bit 1 of `$1581` marks music active.
4. The vertical-blank code `$1264` calls the tick routine once per frame while that bit is set; when `$910` is not `$32` it skips every 6th call (counter `$1584`), so the tempo stays 50 Hz on a 60 Hz machine.

The routine behind `$158A` is the same family as the boot-stage player (`$7C8EC`): same nine-command front end (0 init, 1 play module, ...), same module layout, a NoiseTracker/ProTracker 1.x style replay routine with a 50 Hz tick. That the two copies behave identically is a HYPOTHESIS from the matching structure; the boot-stage copy was disassembled in detail (`graphics-and-music-blocks.md`), and the player in `modplayer.ts` follows that description.

## Replay rules implemented (from the boot-stage disassembly)

- Tick rate fixed at 50 Hz, speed (ticks per row) starts at 6, effect F sets `speed = param & $1F` when that is non-zero. No BPM. (`ciaTempo: true` switches to standard ProTracker tempo for other modules.)
- The first word (2 bytes) of every sample is zeroed; a sample with loop length <= 2 bytes is a one-shot, after which the channel is silent. A looped sample plays `[0, loopStart + loopLength)` once and then repeats `[loopStart, loopStart + loopLength)`.
- Song wraps from the last position to position 0 (restart byte ignored). `Dxx` break row is BCD (> 63 becomes 0), `Bxx` jumps, pattern loop `E6x`, pattern delay `EEx` as in ProTracker 2.x. Slides clamp to periods 113..856.
- Periods use the standard ProTracker table with 16 finetune rows; the note is looked up in row 0 and the value taken from the sample's finetune row (the table in the game image at `$2608` is the standard table; verified against `modplayer.ts`).
- Not emulated: the hardware low-pass filter (`E0x`, used once in two tracks), invert loop (`EFx`, not used), the game's channel muting for sound effects (`$11B4`, player command 7/8).

## Paula model in `modplayer.ts`

- Channel rate = 3,546,895 / period samples per second (PAL colour clock), 4 channels, 8-bit signed samples, volume 0..64, master volume 0..64 (the original scales `vol * master * 25 / 1600`, i.e. 64 = unchanged).
- Amiga panning: channels 0 and 3 left, 1 and 2 right; `separation` 0..1 (default 0.5) mixes the far side in. `interpolation: "nearest"` gives raw sample-and-hold, default `"linear"` (periods >= 113 give < 31.4 kHz source rate, so linear interpolation never aliases at 44.1/48 kHz output).
- The mixer is sample accurate: each 50 Hz tick is `sampleRate / 50` frames with the fractional remainder carried, so output does not depend on buffer sizes (tested).

## API

```ts
const music = createMusic(disk1, disk2);   // src/audio/music.ts; modules decoded lazily, disk2 unused
music.play(0);                              // track 0..3, loops; call from a click/key handler the first time
music.fadeOut(1.5); music.stop(); music.setVolume(0.8);
```

`ModPlayer` (`src/audio/modplayer.ts`) is the DOM-free core: `parseMod(bytes)`, `new ModPlayer(song, { sampleRate })`, `render(left, right, offset?, count?)`, `ModPlayer.duration(song)`. Output goes through a `ScriptProcessorNode` (`webaudio.ts`); browsers keep an `AudioContext` suspended until a user gesture, so `play`/`resume` must be reached from one.

## Open

- Which track the game picks for which screen/event (track index `byte $8CFE`, set by the music-select screen, disk-menu mode 4, `game-proper.md`); the title/intro and in-game assignment above is inferred from the module titles only.
- Meaning of the flags words and the sound-effect channel sharing (`$11B4` and the `$1518` timers); sound effects are separate sample playbacks on the same Paula channels and are not part of this module: see `sfx.md` (the flags word names the two channels effects may take; `Music.setChannelMuted` models the channel muting).
- The module playback has not been compared sample-for-sample with an emulator capture; correctness is checked structurally (periods, timing, pitch of synthetic modules) and by rendering without NaN.
