# Graphics and music blocks (Disk.1 sectors $60-$DC, $DD-$14B, $3C3-$4AC)

All three blocks are packed with the byte LZ/RLE stream of `picture-lz.md` and stored in `Disk.1` (sector = 512 bytes). Nothing from the original is reproduced here; only layouts and numbers. Addresses are Amiga chip addresses of the boot stage (image offset `$3000` = `$77F18`). Tools: `tools/blocks_common.py` (decoder + range loader), `blocks_render.py` (contact sheets, needs numpy/Pillow, output must go outside the repo), `blocks_modinfo.py` (module numbers), `blocks_dis.py` (68000 disassembly of the boot stage, needs capstone).

Summary:

| Sectors | Unpacked | Is | Layout |
|---|---|---|---|
| `$60`-`$DC` | 89,600 | 35 image frames, 64 x 64, 5 bitplanes | frame = 5 consecutive planes of 64 rows x 8 bytes (2,560 bytes) |
| `$DD`-`$14B` | 95,590 | 22 image frames, 88 x 79, 5 bitplanes | frame = 5 planes of 79 rows x 11 bytes (4,345 bytes) |
| `$3C3`-`$4AC` | 160,028 | one standard 4-channel ProTracker module (`M.K.`) | see below |

## Boot-stage sequence (VERIFIED from disassembly)

After the language choice (`$7873C`):

1. `$789AC` clears the screen, `$60`-`$DC` is loaded to `$58758`, decoded to `$50B58`, and the 32 colours saved from the title picture (`$7914A`) are copied back to the working palette `$71D98`.
2. The "code check" screen (below) is shown, using block A.
3. `$DD`-`$14B` is loaded to `$5A358`, decoded to `$50B58` (overwrites block A), palette restored again, and the slide show (block B) runs.
4. Music is faded out, `$14C`-`$208` (the game) is loaded to `$1000` and the boot stage jumps to `$5FF7D8`.

Palette: neither block holds a palette (sizes are exact multiples of the frame size, see below). Both are drawn with the title picture's 32-colour palette; frame 0..34 / 0..21 rendered with it look coherent (natural skin, sky and metal tones), which confirms it. Colour 0 of that palette is black. The palette is faded in by `$78D54` (steps each channel by 1 per call towards the target at `$71D98`).

## Blit routine `$790BE` (VERIFIED)

Arguments: `a0` source, `a1` table of five plane pointers (the screen planes `$68158`, `$6A098`, `$6BFD8`, `$6DF18`, `$6FE58`, 8,000 bytes apart; table at `$7918E`), `d0` x in pixels, `d1` y, `d2` frame index, `d3` = height - 1, `d5` = width_in_bytes - 1.

- Screen offset = `(y * 40) + (x >> 3)`. The low 3 bits of x are ignored: draws are byte aligned. Screen is 40 bytes/row.
- Frame size = `(d3+1) * (d5+1) * 5`; `a0 += frame_size * d2`.
- Then for plane 0..4: copy `d3+1` rows of `d5+1` bytes from the (contiguous) source into the plane. So a frame is stored plane after plane, each plane a plain row-major bitmap. No mask plane, no transparency: the whole rectangle is overwritten. Frames contain their own border.

## Block A, `$60`-`$DC`: 35 frames of 64 x 64 (VERIFIED)

- Called once, `d3=$3F`, `d5=7`, at x=`$80`, y=`$36`. 89,600 = 35 x 2,560 exactly.
- Rendering all 35 frames gives 35 distinct, coherent pictures (scenery, creatures, vehicles, buildings, characters).
- Used by the "code check" screen: frame index = `byte[$79558] / 8` (the byte is a free-running counter incremented once per vertical blank, so it acts as a random number). A one- or two-digit number is typed (keys read through `$79108`; `D`/`C` confirm, `A` deletes) and compared with `index` after subtracting 6, i.e. expected answer = index + 6. Prompts are drawn with string numbers `$26` and `$27` of the language string table (`text.md`) at y=`$8C` / `$9E`. Three tries (`$7955B`), after which the screen flashes red forever.
- In this image the branch after that compare is an unconditional `bra` (`$78856`), so the check cannot fail here (presumably patched by the slave/crack; the original probably had a conditional branch).
- The index counter is a byte divided by 8, so only indices 0-31 are reachable; frames 32-34 are not selected by this routine. HYPOTHESIS: unused spares, or used by the game proper (no reference to the buffer address was found in the game image).

## Block B, `$DD`-`$14B`: 22 frames of 88 x 79 (VERIFIED)

- Called inside a loop, `d3=$4E`, `d5=$0A`, at x=`$74`, y=`$1E`. 95,590 = 22 x 4,345 exactly.
- Rendered frames are coherent bridge/council interiors, character portraits and landscape/action scenes: an introduction slide show.
- Slide table at `$7956C`: 29 pairs of words (frame index, string number), loop count `d7=$1C` (29 iterations). Frame indices in order: 0,1,2,...,11, 3,2,6,3,12,13,3,14,15,16,3,17,19,20,18,16,3 (frame 3 is reused as a recurring shot, frame 21 is never referenced). String numbers run 9..37 consecutively; each slide draws its caption string at x=`$14`, y=`$8C` (string number `n` selects entry `n` of the active language table). The word after the 29 pairs is `$FFFF`, then another list (not studied).
- Each slide is held for 120 frames (`d7=$78` in `$78BB8`); a mouse button ends the hold (left = next slide; the right button, tested in `$78BDC` while flag bit 5 is set, jumps out of the whole show). Mouse buttons come from CIA-A PRA bit 6 and POTGOR bit 2 (`$78CCC`). For languages other than English (`$904` != 0) one extra string (`$29`) is drawn at (`$55`,`$72`) after the show.
- Palette: the title palette again (see above).

## Block C, `$3C3`-`$4AC`: ProTracker module (VERIFIED)

Decoded to `$29670`, packed copy at `$33758`. The data is a plain ProTracker "M.K." module:

| Offset | Size | Field |
|---|---|---|
| `$000` | 20 | title text (the "16-byte name field" noted earlier is this 20-byte title, zero padded) |
| `$014` | 31 x 30 | sample headers: name (22), length in words (2), finetune (1), volume (1), loop start in words (2), loop length in words (2). All big endian |
| `$3B6` | 1 | song length in positions = 55 |
| `$3B7` | 1 | restart byte = 127 (ignored by the player, see below) |
| `$3B8` | 128 | pattern order list; highest pattern number 33, so 34 patterns |
| `$438` | 4 | tag `M.K.` |
| `$43C` | 34 x 1,024 | patterns: 64 rows x 4 channels x 4 bytes. Cell = `ssss pppppppppppp` in word 1 (high nibble of sample number, 12-bit period) and `ssss eeee xxxxxxxx` in word 2 (sample low nibble, effect, parameter) |
| `$43C + 34*1024 = $8C7C` (35,900) | 124,128 | 8-bit signed sample data, samples back to back in header order |

Exact size check: `1084 + 34*1024 + 124128 = 160,028` bytes. Evidence: all 2,725 notes use periods from the standard 36-note table, highest sample number used is 24, 19 samples are used; 7 sample slots (25-31) and slots 8, 14-16 are empty (length 0). Effects present: 0, 1, 2, 4, 6, A, C, D, E (only sub-effects 0, 9 and D), F; the F parameters are 3, 6 and 12 only (speeds, no BPM values), so the module is written for the 50 Hz vertical-blank player. Sample 1 has loop 2,734+5,078; most others are one-shot (loop length 2 bytes = no loop). The standard "first word of sample is zeroed" convention is applied by the player.

## The player (boot stage `$7C8EC`-`$7DDF2`) (VERIFIED from disassembly, naming partly HYPOTHESIS)

A modified standard ProTracker/NoiseTracker replay routine with a small command front end.

### Entry points

- `$7C8EC`: `jmp $7C940` (public entry). `d0` = command; commands >= 9 return immediately. Jump table of 9 words at `$7C958`.
- `$7C8E8`: longword holding the address of the tick routine (`$7CDDE`); stored there by the boot code after command 0.
- `$7CDDE`: tick routine (one call per 50 Hz frame); saves all registers, does `rts`.
- Command table (inputs in `d1`, `d2`, `d3`, `a0`):

| d0 | Action |
|---|---|
| 0 | Init hardware hook. Stores `a0` at `$7CCBA` (CIA-ICR shadow pointer, unused here). Utopia calls it with d1=d2=d3=0, which just returns `a0 = $7CDDE` (tick address). HYPOTHESIS: `d2 != 0` installs its own level-3 interrupt wrapper (`$7CB86`) that chains to the old vector; `d1` = 1..4 selects a CIA timer (4 records of 24 bytes at `$7CB26`) for timing. Not used by the game |
| 1 | `a0` = module. Runs command 2, then builds the sample table (`$7CD60`): sample data start = patterns + (highest pattern + 1) * 1024 |
| 2 | Module init only (`$7CCC0`): remembers the module pointer, detects `M.K.` at `$438` (31 samples, order list `$3B8`, patterns `$43C`) else assumes the 15-sample layout (order list `$1D8`, patterns `$258`), finds the highest pattern, speed = 6, tick = 0, position = 0, clears the four audio volume registers, ADKCON = `$FF`, DMACON = `$0F` (audio DMA off), sets CIA-A PRA bit 1 (filter off) |
| 3 | `d1` = sample number, `a0` = destination: rebuilds sample slot `d1` from the module header with data at `a0` (HYPOTHESIS: replacing an instrument with separately loaded data) |
| 4 | Master volume `d1` (0..64) into `$7D662+$20E` (initial 64). Channel volume is scaled `vol * master * 25 / 1600`, so 64 = unchanged. The game fades out with d1 = 62 down to 0, one step per 2 frames |
| 5 / 6 | Play flag (`$7CCBE`) on / off. The flag only matters for the optional own-interrupt/CIA modes; Utopia's own vblank code decides when to call the tick |
| 7 / 8 | `d1` = channel 0..3: mute (clear the channel's DMA-mask word at +4 and switch the DMA bit off) / unmute |

The boot code calls: command 0 at `$78640`, command 1 with `a0=$29670` at `$78654`, then sets bit 1 of `$79556`; command 4 for the fade at `$7896C`. The boot-stage vblank handler (`$78F40`) calls `jsr ((a0 = long at $7C8E8))` at `$79026` when bit 1 of `$79556` is set; if `byte[$910]` is not `$32` it skips every 6th call (counter at `$7902E`). HYPOTHESIS: `$910` holds a 50/60 Hz flag so that NTSC machines still play at 50 Hz tempo.

### State block at `$7D662` (a5 inside the tick), offsets

| Off | Meaning |
|---|---|
| `$00` | song length (b) |
| `$01` | tick counter (b); `$02` speed (b, default 6); `$03` song position (b) |
| `$05` | pattern-break flag, `$06` break row, `$07` position-jump flag |
| `$08` | current pattern pointer (l); `$0C` byte offset into pattern (l, += `$10` per row, next position at `$400`) |
| `$10` | module pointer (l); `$14` order list pointer; `$18` pattern data pointer |
| `$1C` | sample table, 16 bytes per sample (up to 31): data ptr (l), play length in words (w), loop ptr (l), loop length in words (w), volume (w), finetune (w) |
| `$20C` | shadow of the DMA enable bits (w); `$20E` master volume (w) |
| `$210`, `$242`, `$274`, `$2A6` | channel blocks, `$32` bytes each, order paula 0..3 |
| `$2D8` | 16-byte invert-loop (EF) table; `$2E8` 32-byte sine table |
| `$308` | period table: 16 finetune rows x 36 words (`$48` bytes per row), row 0 starts at 856 and ends at 113, row 1 starts 850, row 8 starts 907 |
| `$788`, `$789` | pattern-delay counter and "delay active" flag |

### Replay behaviour

- Per tick: advance the tick counter; when it reaches speed, fetch the next row (`$7CF4E`), otherwise run the per-tick effect handlers (`$7D0FA`). Tempo is therefore fixed: tick rate = call rate, speed = effect F value.
- Effect F: `speed = param & $1F`, applied only when non-zero (`$7D652`). No BPM handling, so values >= 32 are masked, not interpreted as tempo.
- Songs wrap: when the position + 1 reaches the song length it returns to position 0 (restart byte is not used).
- Effects use the standard PT semantics: 0 arpeggio (3-tick cycle), 1/2 slides (clamped to periods 113 and 856), 3 tone portamento, 4 vibrato, 5, 6 combos, 7 tremolo, 9 sample offset (param << 7 words), A volume slide, B position jump, C volume, D pattern break (BCD), E sub-effects 0-F (filter, fine slides, glissando, vibrato/tremolo waveform, finetune, loop, retrigger, fine volume, cut, delay, pattern delay, invert loop), F speed. Effect 8 is a no-op.
- Audio DMA is started with a short delay loop and the new sample pointer/length are written after the DMA restart, i.e. standard ProTracker 1.x timing (`$7CE74`-`$7CEE8`).
- Each tick also masks the volume with the master volume (command 4) before the hardware write.

## Open

- Whether the game proper (`$14C`-`$208`, loaded to `$1000`) calls the player (no `jsr $7C8EC` found in that image; only the boot stage calls it at `$78642`, `$78656`, `$7896E`). In-game music may use other tracks or another route.
- Where block A frames 32-34 and block B frame 21 are used, if anywhere.
- Meaning of `$910` and the list after the `$FFFF` at `$795A6`.
- The correct answer table for the code check was derived from the compare code only (index + 6); the printed manual would confirm it.
