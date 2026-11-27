# Graphics and music blocks (Disk.1 sectors $60-$DC, $DD-$14B, $3C3-$4AC)

All three blocks are packed with the byte LZ/RLE stream of `picture-lz.md` and stored in `Disk.1` (sector = 512 bytes). Nothing from the original is reproduced here; only layouts and numbers. Addresses are Amiga chip addresses of the boot stage (image offset `$3000` = `$77F18`). Tools: `tools/blocks_common.py` (decoder + range loader), `blocks_render.py` (contact sheets, needs numpy/Pillow, output must go outside the repo), `blocks_modinfo.py` (module numbers), `blocks_dis.py` (68000 disassembly of the boot stage, needs capstone).

Summary:

| Sectors | Unpacked | Is | Layout |
|---|---|---|---|
| `$60`-`$DC` | 89,600 | 35 image frames, 64 x 64, 5 bitplanes | frame = 5 consecutive planes of 64 rows x 8 bytes (2,560 bytes) |
| `$DD`-`$14B` | 95,590 | 22 image frames, 88 x 79, 5 bitplanes | frame = 5 planes of 79 rows x 11 bytes (4,345 bytes) |
| `$3C3`-`$4AC` | 160,028 | one standard 4-channel ProTracker module (`M.K.`) | see below |

## Boot-stage sequence (VERIFIED from disassembly)

Before the credit roll (VERIFIED from the boot code, 2026-11-10; the remake's `IntroScene` reproduces steps 1 and 2 with the same schedule, see text.md "Credit roll"):

1. Boot init (`$78550`-`$78582`), then the logo `$729`-`$733` is decoded to the screen and fades in (44 VBLs, `$785C4`: pending, see "Fade timing"), holds 51 VBLs (`$785C8`), and fades out (45, `$785CE`).
2. The title `$70A`-`$728` is decoded and fades in (44, `$78610`, pending for the same reason).
3. Track 3 is loaded (`$3C3`-`$4AC`, `$78614`-`$78622`), unpacked to `$29670` (`$78634`), started by cmd 0 (`$78640`) and cmd 1 (`$78654`), and the tick is enabled (`bset #1`, `$7865A`). No VBL wait is traced in this block (the load and unpack times are not traced).
4. The credit roll loop starts at `$78662` (a button ends it, `$78684`); it is followed by the language picture fade-out, load and fade-in (`$78698`-`$786F4`), then the choice.

So the module starts 184 VBLs after the pre-roll begins (44 + 51 + 45 + 44, the title fade-in ending it) and before any credit line. The remake starts it once, in the update that ends the title fade-in (`IntroScene` option `startModule`, which calls `Game.startIntroTune`); the roll's first update is the next one, and the roll's first character is drawn in that update (its first wait is pending, `src/game/intro.ts`, pinned by `test/intro.mjs`).

After the language choice (`$7873C`) the boot stage runs the traced steps A to G in `notes/formats/text.md` ("Language screen and what follows"). The remake implements B to G in `src/game/boot-stages.ts`; in the order of the code:

1. The language picture fades out (45 updates, step A). A message screen (`$789AC`, LOADING...) is typed and fades in (45).
2. `$60`-`$DC` is loaded to `$58758`, decoded to `$50B58`, and the 32 colours saved from the title picture (`$7914A`) are copied to the working palette `$71D98`. The message fades out (44, pending: the decode is just before it).
3. The "code check" screen (below) is shown, using block A. Under the WHDLoad 1.2 slave the compare is patched out (`text.md`, step E), so any typed number passes. Its fade-in is pending (the clear and the blit precede it).
4. On success, the message is shown again, `$DD`-`$14B` is loaded to `$5A358`, decoded to `$50B58` (overwrites block A), palette restored, and the slide show (block B) runs. The fade-out before the show is pending (block B's decode is just before it), and so is every slide's fade-in (clear and blit before it); a slide's fade-out after its hold is not.
5. Music: the master volume ramp (`$78966`-`$7897C`, 62 down to 0, 3 VBLs a step, 189 VBLs in all), then `bclr #1` and DMACON `$F` (`$7897E`-`$78986`), then the master volume is set back to full (the remake's `stop()` and `setVolume(1)`, `boot-stages.ts`). `$14C`-`$208` (the game) is loaded to `$1000`, the boot stage fades out (45, kept: the load before it is not traced, see "Fade timing") and jumps to `$1000` (`jmp $1000.l` at `$789A4`). The boot code never writes `$1580` (scan of `$78550`-`$79AF8`), so the original's selection after the stop is whatever it was before the boot; that initial value is not traced here, and the remake's `current = -1` after the stop is an assumption until it is.

Palette: neither block holds a palette (sizes are exact multiples of the frame size, see below). Both are drawn with the title picture's 32-colour palette; frame 0..34 / 0..21 rendered with it look coherent (natural skin, sky and metal tones), which confirms it. Colour 0 of that palette is black. The palette is faded in by `$78D54` and out by `$78CEC`; the exact rules are in "Palette fades" below.

## Palette fades: `$789E6`, `$78D54`, `$78CEC` (VERIFIED static, Disk.1 only; the remake is `src/gfx/fade.ts`)

Addresses are RAM addresses of the boot stage (file offset = address - `$74F18`). Nothing here is compared with a running original.

- **Three arrays.** The working copy `$7910A` (32 words, `0x0RGB`, 4 bits per channel); the target `$71D98`, which a fade-in reads through the long pointer at `$7918A`; and the COLOR registers `$DFF180`+2i. A picture decode writes its 32 palette words to `$71D98` (the decoder writes to `a6 + 40000`, and `$68158 + $9C40 = $71D98`), not to the registers.
- **`$789E6` (load).** Copies 32 words from `(a0)` to the working copy AND to the COLOR registers, no arithmetic. Called with `$791D2` (an all-zero palette in the image) at `$78556` (boot init), `$785AA` (before the logo fade-in) and `$785F6` (before the title fade-in). The language fade-in and the boot fade-ins have no load: their registers are zero because the fade-out before each one ended black, both copies reaching zero.
- **`clr.w $dff180` (`$789B6`).** Writes COLOR00 alone, leaving the working copy as it is. In the message routine `$789AC` (steps B, F and G), before its fade-in; the registers are zero there already, so the write has no visible effect in the traced path.
- **Fade in (`$78D54`).** First `clr.w` on the 32 working words; the registers are not touched. Then 15 steps. In a step, each entry in order: if the working word equals the target word, it is skipped (no write). Otherwise each channel that differs moves ONE level up (`addq #1` blue, `addi #$10` green, `addi #$100` red), and the new word is written to the working copy and to the register. A channel never moves past its target, because the working copy starts at zero and only rises.
- **Fade out (`$78CEC`).** 15 steps. Each entry in order: a zero word is skipped. Otherwise each non-zero channel moves ONE level down (`subq`/`subi`, clamped at zero by the test), and the new word is written to the working copy and to the register.
- **Timing of one fade.** Each step is taken after three flag waits (`$78D64`-`$78D70`, `$78CF4`-`$78D00`); a step therefore runs in the update of the third VBL. The VBL handler (`$78F40`) sets bit 0 of `$79556` on every frame; the waits clear it, so the flag does not count VBLs (see "Fade timing").
- **Which entries are written.** Exactly the entries whose value changes in that step: fade-in writes the entries not yet at their target, fade-out writes the non-zero entries. Entries with a zero target are never written by a fade-in, so their registers keep the value they had (for the traced path that value is zero, see the trace above).
- **Display.** A register value n shows as `n * 17` per channel (`ocsColor`, the picture decoder's mapping; the linear mapping is an assumption about the display, not measured).
- **Canvas comparison.** The old remake fade stepped 8-bit values by 17 in every entry and every step, and reset the screen to black at each fade-in. For the palettes the boot code produces (every channel `n * 17`) the two are the same arithmetic: `test/palette-fade.mjs` checks the register model against the old model after every step for 20 random palettes, in both directions. The fade-in's black reset is not a register write, so the remake no longer resets the display there; the registers are black by the loads above.
- **Hardware side effects Canvas does not show.** (a) The register writes within one step happen one after another, not at the same instant. Each step runs straight after the VBL, so the writes finish before the display starts at line `$2C` (44). This is a static estimate (about 32 entries of 60-100 CPU cycles, against 44 × 454 = 19,976 CPU clocks before line 44 on PAL, at 454 clocks a line and 7,093,790 Hz), not a measurement, and the VBL handler's own cost is not traced. If it holds, the frame shows the whole step and Canvas's one-palette-per-update model is exact. (b) Register retention (a skipped entry keeps the register's old value) is modelled (`PaletteFader`, test section 6), but the traced path never reaches it: the registers are black whenever a fade-in starts.
- **Pending first wait.** Applied to the starts listed in "Fade timing" below; the undetermined starts are listed there.

**Fade timing: the VBL flag and the pending first wait (static, Disk.1; applied 2026-11-10).** Nothing here is compared with a running original. Cycle figures are at the PAL 68000 clock (7,093,790 Hz), not measurements, and come in two kinds. The **bus floor** is what the 68000 must spend at least: every bus cycle takes at least 4 clocks, and each instruction word fetched and each data access is one bus cycle, so the words and accesses of an instruction give a lower bound without any timing table. The **nominal** values are the MC68000 table figures as recalled; the repository, `node_modules` and the local tools hold no 68000 timing table (searched), so these are unverified memory. The pending claims below use only the bus floor.

- **The flag.** The VBL handler `$78F40` (vector `$6C`) sets bit 0 of `$79556` on every VERTB (`bset #0` at `$78F5E`). Three routines clear it, each by a `bclr #0` loop that waits for it: the fade-in wait (`$78D64`), the fade-out wait (`$78CF4`) and the wait routine `$78BB8` (typing, slide and logo holds). `bclr` returns the old value, so a flag that is already set when a wait starts is taken at once and that wait costs no VBL. A VBL that comes while no wait runs leaves the flag set, and several such VBLs still leave one set flag. A scan of the 16 absolute-long references to `$79556` in the boot range finds no other write to bit 0 (the other accesses are bit 1, 2, 4 and 5 operations and `btst`s). Register-indirect writes are not scanned.
- **Interrupts stay on.** The installer `$78E4C` (reached from `$78574`, before the logo decode) masks, clears INTENA, sets the `$6C` vector, enables VERTB and PORTS, and drops the mask to IPL 1 at `$78E76`. Nothing in the boot path raises the mask again (the SR scan finds only `$78DEC` and `$78E4C` setting `$2700`). The disk-loader routines (`$78202`-`$784F0`, called from `$77F84`) write INTREQ only with `$1000` and `$0002` (DSKSYN and DSKBLK), not VERTB. So VBL edges reach the flag for the whole path.
- **Rule.** A fade whose first wait starts with the flag set takes its first step two VBLs after it starts, not three, and lasts 44 VBLs. A fade that follows a wait is pending exactly when the time from that wait's consumed edge to the fade's first wait is longer than one VBL interval. The next edge always comes one interval after the consumed one, so the VBL phase does not enter. The shortest interval is 312 lines (141,648 clocks, 19.97 ms) and the longest 313 lines (142,102 clocks, 20.01 ms), at 454 clocks a line (64 µs, as recalled from PAL line timing; no local hardware data). A window longer than 142,102 clocks is always pending. A window shorter than 141,648 clocks is not pending when the CPU runs at its nominal speed. DMA can only lengthen the CPU's time, so it can turn a short window into a pending one, but it cannot make a long window not pending. A pending first wait needs at least one edge inside the long operation before the fade, so the claim does not depend on where the VBL phase falls when the boot starts.
- **Decode bound (re-derived 2026-11-10 from the Disk.1 loop bodies).** The picture decoder `$7C846` writes one output byte per iteration of one of three loops: literal `$7C86C` (`move.b (a5)+,(a6)+`), run `$7C88C` (`move.b d1,(a6)+`; the run's source byte is read once, at `$7C88A`), and back-references `$7C8B2` (`move.b (a4)+,(a6)+`) and `$7C8D6` (`move.b (a4)+,(a6)+`). Each iteration also runs `addq.l #1,d6`, `subq.l #1,d7`, `beq` (not taken) and `dbra` (taken). Nominal cost per byte: 42 for the run loop (8 + 8 + 8 + 8 + 10), 46 for the literal and back-reference loops (12 for their move). Bus floor: 28 for the run loop (8 + 4 + 4 + 4 + 8), 32 for the others. The earlier figure of 34 (8 + 8 + 8 + 10) left out the byte move. It is still below the nominal minimum of 42, so it remains a valid bound, but it should not be quoted. Per-token overhead only adds. A decode of N bytes therefore costs at least 28N clocks (floor) or 42N (nominal), and exceeds one VBL interval (142,102 clocks) for N above 5,075 (floor) or 3,384 (nominal). Output sizes, as recorded from `src/data/unpack.ts` on Disk.1 (2026-11-10; the frame arithmetic below agrees): logo, title and language 40,064 bytes each (40,000 plane bytes and the 64-byte palette); block A 89,600 (35 frames of 2,560); block B 95,590 (22 frames of 4,345); track 3 160,028. A logo-sized decode costs at least 1,121,792 clocks on the floor (7.9 intervals, 158 ms) and at least 1,682,688 nominal (11.9 intervals, 237 ms). The earlier "nine or more fields" came from the 34 figure (1,362,176 clocks, 9.6 intervals). Every decode the table marks as pending exceeds one interval on either count.
- **Clear and blit bounds (re-derived 2026-11-10; the code-check and slide fade-ins are proven pending on the bus floor).** Clear `$78CAA`: the one `movem.l $791D2.l,d2-d7/a2-a5` load (`$78CB4`) is before the loop; the 1,000-iteration loop (`move.w #$3e7,d0`, `dbra`) runs `movem.l d2-d7/a2-a5,(a0)` (2 instruction words and 20 word writes: floor 88, nominal 8 + 8 × 10 = 88), `adda.w d1,a0` (floor 4, nominal 8) and `dbra` taken (floor 8, nominal 10). That is at least 100,000 clocks on the floor (14.1 ms) and 106,000 nominal (14.9 ms); the load, prologue and epilogue add a little. Blit `$790BE` for a block A frame (5 planes × 64 rows × 8 bytes = 2,560 bytes): each byte is `move.b (a0)+,(a2)+` (instruction word, byte read, byte write: floor 12, nominal 12) plus `dbra` taken (floor 8, nominal 10). Each row adds `move.w d5,d0` (4), the eight moves (8 × 12), seven taken and one not-taken inner `dbra` (7 × 8 + 8), `adda.w #$28,a2` (8), `suba.w d5,a2` (4), `subq.w #1,a2` (4) and the row `dbra` (8): 188 clocks on the floor. Block A: at least 320 rows × 188 = 60,160 clocks. Block B frame (5 planes × 79 rows × 11 bytes = 4,345 bytes): each row is 4 + 11 × 12 + 10 × 8 + 8 + 24 = 248, so at least 395 × 248 = 97,960. Clear plus block A is at least 160,160 clocks, 1.13 × the longest interval (142,102); clear plus block B is at least 197,960, 1.39 ×. Both windows exceed one VBL interval on the bus floor alone, so an edge is always inside them, and the code-check fade-in (block A) and each slide fade-in (block B, 29 slides) are pending. The earlier figures (46,000 and 78,000 for the blits, 152,000 and 184,000 for the pairs) were loose: they counted the byte move as 8 clocks, not 12, and left out the row overhead. They remain valid lower bounds, below the new ones.

| Fade start | Code | What runs just before (no wait in between) | First wait | Remake |
|---|---|---|---|---|
| Logo fade-in | `$785C4` | decode `$785A6` (40,064 B), load `$789E6` | pending | 44 (steps at 2, 5, ..., 44) |
| Logo fade-out | `$785CE` | hold's last check, a short poll | not pending | 45 |
| Title fade-in | `$78610` | decode `$785F2` (40,064 B), load | pending | 44 |
| Roll's first character | `$78AB8` (d7 = 1) | decode of track 3 `$78634` (160,028 B), player commands | pending | drawn in the roll's first update (was the second) |
| Language fade-out (roll click) | `$786AC` | click in the hold `$78680`, 32-word copy | not pending | 45 |
| Language fade-in | `$786E0` | decode `$786D0` (40,064 B) | pending | 44 |
| Language fade-out after the choice | `$78758` | poll `$786F4`, which does not read bit 0 | undetermined (press timing) | 45 |
| Message fade-ins (B, F, G) | `$789E0` | the last typed character: its wait, then one draw | not pending | 45 |
| Step D fade-out | `$78798` | decode of block A `$78780` (89,600 B), 32-word copy | pending | 44 |
| Code-check fade-in | `$78814` | clear `$787BA`, prompts (no waits), blit `$790BE` (block A frame) | pending (proven, bus floor ≥ 160,160 clocks) | 44 |
| Step F first fade-out | `$7888A` | Enter in the key loop (no waits) | undetermined (key timing) | 45 |
| Step F second fade-out | `$788CA` | decode of block B `$788B2` (95,590 B), 32-word copy | pending | 44 |
| Slide fade-in (29 slides) | `$7890E` | clear `$788DC`, blit `$790BE` (block B frame) | pending (proven, bus floor ≥ 197,960 clocks) | 44 |
| Slide fade-out after the hold | `$78934` | the hold's last check, a short branch | not pending | 45 |
| Step G final fade-out | `$789A0` | volume ramp, then the load of `$14C`-`$208` (`$77F84`) | undetermined (load time not traced) | 45 |

Message first characters (B, F, G): the window from the fade-out's last wait to the first character's first wait holds the fade's last step, the clear `$78CAA` and a few setup instructions. The clear is at least 100,000 clocks on the floor and 106,000 nominal, so the window is about 0.75 of one interval (141,648 to 142,102 clocks) on the nominal count. It is pending only if the window is longer than one interval, which DMA stalls (not modelled) could cause, so the status stays open and the first character stays at two VBLs, the remake's default. (This corrects the earlier "may or may not fall inside it": the question is the window's length against one interval, not the phase.)

**Left undetermined (the remake keeps the default; the trace does not decide them).**

1. The language fade-out after the choice (`$78758`) and step F's first fade-out (`$7888A`, after Enter) start after a poll or a key loop that reads no bit 0 and runs for as long as the player takes. The first wait is pending exactly when a VBL edge came after the last fade-in wait and before the press. The remake's update model cannot place a press within a field: a press first seen in the update after the fade-in's last step (`test/language.mjs`, section 11) is treated as not pending. A press seen later is pending in the original, and the original's first step is then one update earlier (2 updates instead of 3). The remake keeps 3 there.
2. Step G's final fade-out follows the load of the game (`$77F84`, `$14C`-`$208`). A load that spans a field would make it 44. The load time is not traced, and the WHDLoad slave may replace the loader, so it is kept at 45.
3. The first character after each message clear (above) depends on DMA stalls, which the trace does not model. The roll's later lines (their erase and the 2-VBL first character after a hold) were not re-traced in this pass.

**Applied.** `Fade` takes `firstWaitPending` (`src/gfx/fade.ts`). `IntroScene` uses it for the logo and title fade-ins and starts the roll's first character one update earlier (`src/game/intro.ts`). `LanguageScene` uses it for the language fade-in (`src/game/language.ts`). `BootStages` uses it for step D, the code-check fade-in, step F's second fade-out and each slide's fade-in (`src/game/boot-stages.ts`). Tests: `test/intro.mjs`, `test/language.mjs` (section 7b), `test/boot-stages.mjs` (`FADE_P`), `test/boot-music.mjs`, `test/boot-menu.mjs`, `test/palette-fade.mjs` (section 10).

**Limits.** Static reading only; no emulator capture confirms the update numbers. The pending claims assume a 68000 at the PAL clock with the VBL interval between 312 and 313 lines of 454 clocks (PAL line timing as recalled; no local hardware data). DMA can only lengthen the CPU's time, so the bus-floor bounds hold on that machine, and so do the pending claims, which need only long windows. Claims that a window is not pending depend on the CPU running at nominal speed. Faster machines (the Copperline A1200 runs a 68020) are not bounded here: the pending claims rest on the 68000 bus floor, and their margin on a faster machine is an estimate, not a result. The post-choice and step F fade-outs remain as described under "Left undetermined".

## Blit routine `$790BE` (VERIFIED)

Arguments: `a0` source, `a1` table of five plane pointers (the screen planes `$68158`, `$6A098`, `$6BFD8`, `$6DF18`, `$6FE58`, 8,000 bytes apart; table at `$7918E`), `d0` x in pixels, `d1` y, `d2` frame index, `d3` = height - 1, `d5` = width_in_bytes - 1.

- Screen offset = `(y * 40) + (x >> 3)`. The low 3 bits of x are ignored: draws are byte aligned. Screen is 40 bytes/row.
- Frame size = `(d3+1) * (d5+1) * 5`; `a0 += frame_size * d2`.
- Then for plane 0..4: copy `d3+1` rows of `d5+1` bytes from the (contiguous) source into the plane. So a frame is stored plane after plane, each plane a plain row-major bitmap. No mask plane, no transparency: the whole rectangle is overwritten. Frames contain their own border.

## Block A, `$60`-`$DC`: 35 frames of 64 x 64 (VERIFIED)

- Called once, `d3=$3F`, `d5=7`, at x=`$80`, y=`$36`. 89,600 = 35 x 2,560 exactly.
- Rendering all 35 frames gives 35 distinct, coherent pictures (scenery, creatures, vehicles, buildings, characters).
- Used by the "code check" screen: frame index = `byte[$79558] / 8` (the byte is a free-running counter incremented once per vertical blank, so it acts as a random number). A one- or two-digit number is typed (keys read through `$79108` as Amiga raw key codes: the digit table at `$79524`; Return `$44` and keypad Enter `$43` confirm, Backspace `$41` deletes; the earlier `D`/`C`/`A` reading was wrong) and compared with `index` after subtracting 6, i.e. expected answer = index + 6. Prompts are drawn with string numbers `$26` and `$27` of the language string table (`text.md`) at y=`$8C` / `$9E`. Three tries (`$7955B`), after which the screen flashes red forever.
- In this image the branch after that compare is an unconditional `bra` (`$78856`), so the check cannot fail here (presumably patched by the slave/crack; the original probably had a conditional branch).
- The index counter is a byte divided by 8, so only indices 0-31 are reachable; frames 32-34 are not selected by this routine. HYPOTHESIS: unused spares, or used by the game proper (no reference to the buffer address was found in the game image).

## Block B, `$DD`-`$14B`: 22 frames of 88 x 79 (VERIFIED)

- Called inside a loop, `d3=$4E`, `d5=$0A`, at x=`$74`, y=`$1E`. 95,590 = 22 x 4,345 exactly.
- Rendered frames are coherent bridge/council interiors, character portraits and landscape/action scenes: an introduction slide show.
- Slide table at `$7956C`: 29 pairs of words (frame index, string number), loop count `d7=$1C` (29 iterations). Frame indices in order: 0,1,2,...,11, 3,2,6,3,12,13,3,14,15,16,3,17,19,20,18,16,3 (frame 3 is reused as a recurring shot, frame 21 is never referenced). String numbers run 9..37 consecutively; each slide draws its caption string at x=`$14`, y=`$8C` (string number `n` selects entry `n` of the active language table). The word after the 29 pairs is `$FFFF`, then another list (not studied).
- Each slide is held for 121 checks (`d7=$78` with `dbra` in `$78BB8`: one check per VBL, the first after the fade-in); a mouse button ends the hold (left = next slide; the right button, tested in `$78BDC` while flag bit 5 is set, jumps out of the whole show). Mouse buttons come from CIA-A PRA bit 6 and POTGOR bit 2 (`$78CCC`). For languages other than English (`$904` != 0) one extra string (`$29`) is drawn at (`$55`,`$72`) after the show.
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

## Pixel comparison of the title and language pictures (OBSERVED, one capture each; 2026-11-10)

Evidence: the player's own native 320 x 200 PNG captures in the OS temp folder, directory `UtopiaReferenceRun-20261106` (files `screen100.png`, `screen45.png`, `screen70.png`, `normal-boot.png` for the title, `language2.png`, `language-enter.png` for the language picture). The PNGs are not in the repository and were not modified; the emulator that wrote them is not identified by the files themselves. Comparator: `test/pixel-compare.mjs` (`UTOPIA_PIXEL_CAPTURE=<png>`, optional `UTOPIA_PIXEL_STATE=title|language`, default title; `npm run compare:pixels`). It reads the PNG itself (8-bit, non-interlaced), renders the remake's state headlessly from the user's `Disk.1` (`IntroScene` after the title fade-in, `LanguageScene` after its fade-in), and compares pixel colours.

- **Alignment.** Only native 320 x 200 captures are compared, at offset (0,0), 1:1. Window grabs (716 x 285) and 640 x 256 frames are reported as unavailable: they would need an emulator-specific crop and scale model. A +/-2 pixel scan reports whether another offset fits better; if one does, the state is unavailable rather than compared.
- **Palette.** The remake's `ocsColor` (4-bit channel x 17) is compared colour by colour. Title: 26 indices used in the region, 100% of the pixels take each index's dominant capture colour. Language: 7 indices, same result.
- **Title region, rows 0..179** (row 180, `TEXT_Y`, and below hold the credit roll, which types and clears on its own schedule, so they are not compared). `screen100.png`, `screen45.png`, `screen70.png` and `normal-boot.png` each match all 57,600 pixels exactly.
- **Language picture, all 200 rows.** `language2.png` and `language-enter.png` (byte-identical, SHA-256 `4F24C3D0833196D404BAAAC7B91DFB030837C70BFCFCF63A4780FB2AB7000ACB`) match all 63,988 pixels that are not the pointer exception. The 12 excluded pixels are 0,255,0 over background index 0 at (15,0), (19,0), (20,0), (21,0), (20,1), (21,1), (22,1), (21,2), (22,2), (23,2), (22,3), (23,3). The box is x 15..23, y 0..3, within the 16 x 16 pointer size. 0,255,0 is also a picture colour in this palette (indices 16..31), so the exclusion requires the index-0 condition and the box size; a pixel that fails either stays a divergence.
  - **Source of the 12 pixels (2026-11-10, checked):** they are not the remake's software arrow. Disk.1 `$4A74` (rows 8, 29 opaque, palette indices 7 x21 and 6 x8) matches the 12-pixel set at no hotspot, and on this palette those indices are 884400 and 662200, not 0,255,0. `$4AA4` (one row, 11 pixels) matches at no hotspot either. **Explained:** the boot stage's hardware sprite 2 (text.md, "Pointer visibility") decodes from Disk.1 at `$79286` (11 rows, one colour, COLOR26). The 12 pixels are its rows 5..8 at origin (15,-5), i.e. pointer (20,0). A second capture, `mouse.png`, shows the full 37-pixel sprite at origin (115,35), pointer (120,40). Both fit exactly. The pointer positions are inferred from the captures (text.md has the confidence split). `test/boot-pointer.mjs` checks the decoded pixels. With `UTOPIA_PIXEL_POINTER=20,0` (and `120,40` for `mouse.png`), `test/pixel-compare.mjs` compares the whole language frame with no exception: 64000 of 64000 pixels exact for both captures.
- **Unavailable, not divergent.** The `screen130`, `screen145`, `screen165` and `intro2` frames (credit roll and logo states) and the `menu1` and `afterlang` frames give a palette mapping below 98% against the title or language frame, so the comparator reports them as another state rather than as pixel differences.
- **Limits.** One frame per state from one capture each, plus `mouse.png` (a second language frame with the pointer elsewhere). No credit-roll text, timing, fade frames, or other screen (menus, map, gameplay) is compared. The pointer positions are inferred, not in the captures, and the horizontal origin is the designer's constant, not an independent measurement. Without `UTOPIA_PIXEL_POINTER` the 12-pixel exception still applies. This is picture parity for those two states only, not boot parity.

## Open

- Whether the game proper (`$14C`-`$208`, loaded to `$1000`) calls the player (no `jsr $7C8EC` found in that image; only the boot stage calls it at `$78642`, `$78656`, `$7896E`). In-game music may use other tracks or another route.
- Where block A frames 32-34 and block B frame 21 are used, if anywhere.
- Meaning of `$910` and the list after the `$FFFF` at `$795A6`.
- The correct answer table for the code check was derived from the compare code only (index + 6); the printed manual would confirm it.
