# Game proper (Disk.1 sectors $14C-$208, loaded to $1000)

Static analysis of the main program. No game text, graphics or music is reproduced here; only addresses, layouts and numbers. Sector = 512 bytes, image offset = sector * 512. "Variant A" = WHDLoad slave CRC $D9C1 (the one in `original/utopia-whdload`). Tools: `tools/game_dis.py` (linear 68k disassembly), `tools/game_img.py` (loads the game image at base $1000, recursive-descent walker), `tools/game_unpack.py` (strict LZ/RLE decoder, format in `picture-lz.md`). All need `capstone` for disassembly.

Status tags: **VERIFIED** = read directly from disassembly or data and cross-checked; **HYPOTHESIS** = plausible inference, not proven.

## 1. Entry point and the slave hook (VERIFIED)

- The boot stage (Disk.1 image offset $3000-$87FF, loaded at chip $77F18, RAM = image offset + $74F18) ends its work with `jmp $1000.l` at $789A4 (image $3A8C), followed by an illegal ($4AFC).
- The slave overwrites that site with `jmp <slave code $1C0>`. The title RAM snapshot shows `4EF9 005FF7D8` at $789A4. The slave is relocated to expansion RAM at $5FF618, so $5FF7D8 = slave offset $1C0.
- **$5FF7D8 is not a relocation or copy stub.** It is the slave's "patch the game and launch" routine: a resload_Control call (slave $382; aborts with code $F when the result is 0; purpose unknown), the in-place patches of section 4, resload_FlushCache, then `jmp $1000.w`.
- At $1000 the game proper is `jmp $156B6.l`. **The real entry is $156B6.**
- Before launch the slave (and the original bootblock on a real machine) sets low-RAM variables:
  - `$900.l` language index, set by the boot stage at $7873C from the mouse y position (y < $2C: 0, < $5B: 1, < $89: 2, else 3) = EN, FR, DE, IT.
  - `$904.l` base of extra RAM: $C00000 (slow RAM), $80000 (second chip bank when chip is 1 MB), $200000 (fast RAM) or 0. The slave sets $80000.
  - `$910.b` ExecBase VBlankFrequency (50 or 60); the slave sets $32 (50).

## 2. Initialisation ($156B6) (VERIFIED)

Order: INTENA off; VBL vector `$6C = $2C34`; `jsr $2B7A` (CIA setup, keyboard IRQ, vector `$68 = $2BC2`); if `$904 != 0` set bit 0 of `$1581` ("extra memory"); `jsr $8B86` (drive probe), `$93A6` (patched to rts), `$2B1A` (screen and copper start), `$15F84` (clears game state $39D4A-$3F188), `$15F9A`.

- Language: `$900` is stored at `$1612A`. The packed string table for that language is loaded through the sector table at `$1613E` and unpacked to `$188C2`.
- Buffer pointers: without extra memory the image defaults are $1612E-area `$57260`, `$63C60`, `$43460`, `$52860`. With extra memory they are computed from `$904 + $60000`: `$1612E = base - $13E00`, `$16132 = base - $7400`, `$16136 = $1612E - $13E00`, `$1613A = $1612E - $4A00` (with `$904 = $80000`: $CC200, $D8C00, $B8400, $C7800).
- Then loads via `$7C4A`, `$7CD6`, `$7D3E`, `$4E28`, `$7E52` and others (screens, tile sheet, sprite blocks, music).

## 3. Main loop, interrupts, input (VERIFIED)

Loop top `$157BC`. Each iteration calls `$333A`, `$16012`, `$6936`, `$6540`, `$3310`, `$4D48`, `$4D1C`, `$4D96`, `$5D30`, then waits for the VBL flag (`bclr #0,$156A8` until set), then `$99C4` and `$50B2` (mouse buttons). A left click calls `$158CA`, otherwise `$15A74` (icon dispatch) or `$15F44`. Then `$15B4A` (keyboard) and back to `$157BC`.

Flag bytes: `$156A8` bit0 = VBL done, bit2 = screen/pointer active, bit3 = left button state, bit6 = right button, bit7 = day tick; `$156A9`/`$156AA`/`$156AB` further flags (`$156AB` = text colour index; `$156A9` bit2 = pause). `$14591` = screen mode (1, 2, 3).

### VBL handler `$2C34`
Reads INTREQR, acknowledges bits 4-6. On VBL: `$2F44` frame counter++, set bit0 of `$156A8`, call `$2F5E` (pointer restore), `$2CDA` (mouse from JOY0DAT $DFF00A, clamped x <= $138 and y <= $C0 in modes 1/3, results at `$161A6`/`$161A8`), `$2FBA`, `$1264` (music tick).
Timer `$14590` counts down from $5A (90 frames, about 1.8 s at 50 Hz); at 0 it sets bit7 of `$156A8` = day tick, consumed at `$564A`.

### Date (VERIFIED from `$564A`)
Day `$1459F` (month rolls at $1D, so 28-day months), weekday `$145A1` (mod 7), month `$145A0` (wraps at 12), year long `$142A6`. A string "DD/MM/YYYY" is kept at `$14594`. A new game starts at 28/06/2090.

### Keyboard (`$2BC2`, `$15B4A`)
IRQ reads CIA-A SDR, `not` + `ror`, stores the raw key code at `$161A0`, does the handshake. In `$15B4A`: keys $50-$55 (F1-F6) call `$B81C`, `$BA1E`, `$BD9E`, `$C516`, `$D6BA`, `$E1AA` (these need `$133F8 != 0` = a game is active); $22 calls `$31CC`; $19 and $40 toggle pause; $01-$08 call `$3202`.

### Mouse buttons (`$50B2`)
Left = CIA-A PRA $BFE001 bit 6; right = POTINP $DFF016 bit 2.

### Icon dispatch (`$15A74`)
Hit test `$5730`: a0 = table of 8-byte rectangles {x0, x1, y0, y1}, terminated by a negative word; returns index in d2. Map:

| d2 | Routine | Meaning |
|---|---|---|
| 0 | `$6BA2` | |
| 1 | `$F176` | |
| 2 | `$15ECA` | sets screen mode 3 |
| 3 | `$30FE` | |
| 4 | `$CC8E` then `$D0D8` | |
| 5 | `$15CFE` | submenu with the six F-key screens |
| 6 | `$BAAE` | |
| 7 | `$E2D2` | scenario information screen |
| 8 | `$7E52` + `$15EF0` | disk menu |
| 9 | - | ignored |

Subroutine meanings for most of these are HYPOTHESIS (names of game screens not determined).

### Music command dispatcher `$15DE` (VERIFIED structure)
`d0` = command; table at `$15F4` holds a count word (9) then 9 word offsets (relative to the table + 2), `jmp -2(a6)`. Command 0 = init, 1 = play module (a0 = module). Entry `$158A` is the call wrapper. Music flags in `$1581` (bit0 extra memory, bit1 music active), channel timers `$1518-$151E`, choice list `$1530` (4 x 8 bytes), menu at `$1006-$10E8`.

## 4. Slave patches in the game proper, variant A (VERIFIED)

| Address | Patch | Effect |
|---|---|---|
| `$8314`, `$857E`, `$85FE`, `$8632` | `jsr` to slave `$3CA` / `$3B6` + nop at +6 | set `$8D00` to 3 or 2, fall into `$3EE`: load sectors $3C0-$3C1 to `$8F8C`, return d0 = 1 (id 3) or 2 |
| `$841E` | `jmp $3EE` | same header fetch |
| `$997A` | `jmp $3DE` | `clr.w $939C; rts` (motor/state) |
| `$1E6E` | `jsr` to stub `moveq #0,d2; rts` | |
| `$93A6` | `rts` | |
| `$93F8` | `jmp $44A` | **track read hook** (slave read wrapper, resload_DiskLoad) |
| `$7D88` | `jmp $486` | **write hook** |
| `$8966` | operands of the `btst #6,$BFE001` at `$8964` rewritten to `btst #2,$DFF016` | "continue" uses the right button |

**Correction to `utopia-disks.md`:** the slave calls resload `$38` in the write wrapper `$486` with the file name "Disk.4". `$38` is SaveFileOffset (a0 name, a1 source, d0 size, d1 offset), not LoadFileOffset. The slave read wrapper `$44A` takes the disk number from `$4D4`, converts the sector numbers to byte offsets (`lsr #7` on the multiplied value) and loads from Disk.1 (id 1), Disk.4 (id 3) or Disk.2 (id 2; Disk.3 if flag `$4DC` is set).

## 5. Loader (VERIFIED)

The game has its own MFM track loader (copied from the boot stage).

- `$93F8` read: d0 = first sector, d1 = last sector (inclusive), a0 = destination. Reads 12 sectors per track through a track buffer pointed to by `$9392` (decoded at buffer + $3840). On a real Amiga this is MFM; under WHDLoad it is replaced by a flat-image read.
- `$943C` write, using `$94E6`, `$985E` (MFM encode: sync $4489 x3, checksum) and `$98EC` (DSKLEN $D828).
- Wrappers:
  - `$7D96`: raw load to a0 and restore the screen buffers (via `$5A16`).
  - `$7DEA` (d0, d1, a1 = scratch, a0 = destination): load packed to a1, then unpack to a0.
  - `$7D52` (d0 = index): loads a picture using the 3-entry table at `$8C8C` {first sector, last sector, adjust}: idx0 $2E8-$2F6, idx1 $2CE-$2E4, idx2 $2F8-$327; unpacks to `$2FD4A`, 40,064 bytes each.
  - `$7D24` (a1 = destination): loads and unpacks the main-screen background (sectors $282-$2A0, 40,064 bytes = 320 x 200 x 5 planes + palette).
  - `$7D88`: write wrapper over `$943C`.
- Unpack routine `$8BEA`: a5 = source, a6 = destination, d7 = limit (-1 = none), returns d6 = bytes written. Same LZ/RLE as `picture-lz.md` (`tools/game_unpack.py` reproduces it and decodes every packed range below without error).
- Disk-id variable `$8D00`: 1 = game disk (Disk.1), 2 = scenario disk (Disk.2), 3 = save disk (Disk.4 in the slave). `$8A5A` = "ensure the right disk" (checks the header at sector $3C0 against `$8D00`). `$841E` reads the header, checks the magic and returns d0 = 2 (scenario), 1 (save) or -1 (invalid). `$1453E` = scenario disk id (image default 2).

## 6. Disk headers and records (VERIFIED)

Sectors $3C0-$3C1 (1024 bytes) of Disk.1, Disk.2 and Disk.4 hold a header, loaded to `$8F8C`:

| Offset | Content |
|---|---|
| 0 | 8-byte magic: "UTOP" + "SCEN" or "SAVE" |
| 8 | word disk id (1, 2 or 3) |
| 10 | 10 records of $40 bytes (RAM `$8F96`) |

Each record: 16-byte name field (unused save slots read "EMPTY"), then words from +$10. Disk.1's header (id 1) uses numerically the same sector table as Disk.2; its actual use is unverified (HYPOTHESIS: left over from the tool that mastered the disks).

### Scenario record (Disk.2, 10 records)
Words from +$10 are (first sector, last sector) pairs on Disk.2. Roles come from the loaders at `$8B02` and `$E2D2` (record 0 values given as example):

| Offset | Pair (record 0) | Loaded to | Meaning |
|---|---|---|---|
| +$10 | $5A-$78 (31 sectors) | `$16136 + $BA00` | 4 blocks of 3,840 bytes, mostly zero (see section 8); HYPOTHESIS: sprite sheets |
| +$14 | $01-$37 (55 sectors, raw) | `$1612E + $CA00` | 66 tile/object images (section 7) |
| +$18 | $38-$39 | `$2954A` | 66 image descriptors of 8 bytes {rows-1, offset}, relocated into the table at `$1612E + $2F8` |
| +$1C | $3A-$58 (31 sectors) | `$3F188` | map (section 7) |
| +$20 | $7A-$82 (9 sectors) | `$13034` | scenario block (section 8) |
| +$24 | $84-$9D (26 sectors, raw) | `$2954A` | used by `$E2D2`; format not decoded |
| +$28, +$2C, +$30, +$34 | 4 pairs, index language * 4 | `$6B060` | language text blocks (the ASCII regions of Disk.2 near sectors 1443-1590) |

The remainder of each record (+$38 on) is zero. Records 0 and 4 share the graphics set (1-$37); pairs (162-218), (324-380), (852-907), (586-643) are shared by records 1/6, 2/7, 3/8, 5/9. So there are 5 graphics sets for 10 scenarios. All non-text data on Disk.2 is raw; nothing there is packed.

### Save record (Disk.4)
+$10 = (A start, A end), +$14 = (B start, B end).
- A: 73 sectors, loaded to/saved from `$39E3A` (object list and map).
- B: 11 sectors, from/to `$13034` (through `$14633`).
- Slot positions step by 120 sectors, skipping the header at $3C0 (8th slot at 1080). Track arithmetic uses `d1 = (A start)/12 + 8`.

### Disk menu (`$938D` mode, loop `$7EF6`)
Modes: 1 save game (header "SAVE"), 2 load game, 3 new scenario (header "SCEN"), 4 music select. Handlers `$87DC`, `$8AF4`, `$8B02`. d2 table (`$7FE4`): 0 -> `$85FE`, 1 -> `$856C` (save), 2 -> `$8632`, 3 -> `$8314` (format save disk), 4 -> `$1062`, 5 -> `$802C` (exit), 6 -> `$80C8` (new game), 7 -> `$1006`, 8 -> `$10BC`.

## 7. Graphics and map data (VERIFIED unless noted)

### Screen and copper
Copper list at `$2EA4`: BPLCON0 $5200 (5 planes, lowres), DIWSTRT $2C81, DIWSTOP $F4C1, DDFSTRT $38, DDFSTOP $D0, zero modulos; plane pointers high word 7, low words $5E00, $7D40, $9C80, $BBC0, $DB00 (= $75E00 + 8000 * n). Double buffering uses two 7-long blocks at `$160F2` and `$1610E`: +0 bitmap base, +4 copper list, +8 five plane pointers; initial bitmaps $75E00 and $6C000. `$4E08` swaps the blocks and loads COP1LC. Palettes follow the bitmaps (e.g. $7FA40) and `$2E26` copies 32 colours to COLOR00. `$5A16` copies a 40,000-byte bitmap, `$5A2E` swaps two.
Text: `$539E` (d0 = x, d1 = y, a0 = string, a1 = plane pointer array, colour from `$156AB`); character table `$62D8`, glyphs `$6354`. Strings: NUL-terminated, a byte with bit 7 set is a line break.

### String tables
408 big-endian u16 offsets relative to the table start (first offset 816 = 408 * 2), loaded at `$188C2`, fetched with `move.w (a0,d0.l*2)`. Per-language sectors (table `$1613E`): EN $209-$221 (18,088 bytes unpacked), FR $387-$3A0 (19,763), DE $6EC-$707 (20,755), IT $3A2-$3BB (18,383). Language order EN, FR, DE, IT (word statistics confirm). See `text.md` for the character set.

### Tile / object images
32 pixels wide (4 bytes), 6 planes stored plane after plane, rows * 24 bytes per image (rendering the sheet shows isometric tiles and buildings). **HYPOTHESIS:** the sixth plane is a mask.
Descriptor table at `$1612E`: 161 entries of {rows-1, offset} (big-endian longs). Entries 0-94 come from Disk.1 sectors $222-$25B (unpacks to 51,208 bytes, image data from +$508); entries 95-160 come from the scenario graphics set (66 images from +$14, descriptors from +$18). Map tile ids index this table.

### Map
31 sectors = 15,872 bytes loaded to `$3F188`: a $CE-byte header (103 words of $73FF), then 75 rows of 100 cell words plus 2 pad words ($73FF), row stride 102 words. Confirmed by the pad words in all 10 scenarios.
Cell word: low 10 bits = tile id, high 6 bits = flags (mask $E800 used in code).
Map builder `$6D78` reads from `$3F256` and writes 8-byte object records to `$3B466` (up to 1000): {type word, bytes, x, y, rand}. Tile ids $48-$5F go through table `$77C8`. Per-type counts are kept at +$A of the 18-byte object-type table.

## 8. Scenario block (`$13034`, from +$20) (partly VERIFIED)

- Object-type table at `$131E2` (= block + $1AE): 18-byte entries, type id word at +8 (values seen: 1, 4, 6, 10, 14, 15, 31, 47); lookup at `$6BE0`. (VERIFIED layout, field meanings unknown.)
- Block starts with 6 descriptors of $22 bytes {graphics offset, mask offset = +400, 480, 19, ...}; 4 are used, at offsets 0, 3840, 7680, 11520 into the +$10 blocks. **HYPOTHESIS:** animated 32 x 20 sprite sheets, 8 frames of 480 bytes each (offset list $0, $1E0, ...). 21 more descriptors sit in the game image at `$12D6A` (relocated by `$16136`) for Disk.1 sectors $25C-$280 (47,280 bytes unpacked).
- Scenario parameters begin at +$CC (`$13100`): values such as 400, 150, 1200, 800 (HYPOTHESIS: starting resources or limits). `$866E` zeroes and initialises the variable block from `$14234`; `$144CC` has 6 longs of 100; `$14500+`, `$1453A`, `$1453E`, `$14524` also written.
- Game state: `$39D4A-$3F188` cleared by `$15F84`; further flags at `$156A8` onward.

## 9. Disk.1 sector map (VERIFIED by successful decode or by load calls)

| Sectors | Unpacked bytes | Content |
|---|---|---|
| $01-$37 | - | boot data / bootblock (not game proper) |
| $5A-$5F | 40,064 | language picture (boot stage) |
| $60-$DC | 89,600 | 35 frames 64x64 (boot stage code-check screen, see `graphics-and-music-blocks.md`) |
| $DD-$14B | 95,590 | 22 frames 88x79 (boot stage slide show, same note) |
| $14C-$208 | 96,768 raw | **game proper** |
| $209-$221 | 18,088 | EN strings |
| $222-$25B | 51,208 | tile image sheet (95 images) |
| $25C-$280 | 47,280 | 21 sprite-sheet graphics (HYPOTHESIS, see 8) |
| $282-$2A0 | 40,064 | main screen background |
| $2C0-$2CD | 10,240 | loaded at `$E770`; content unidentified |
| $2CE-$2E4 | 40,064 | screen idx 1 |
| $2E8-$2F6 | 40,064 | screen idx 0 |
| $2F8-$327 | 40,064 | screen idx 2 |
| $328-$34B | 26,070 | loaded at `$15D4E` (to `$2B54A`); content unidentified |
| $368-$386 | 15,872 raw | loaded to `$2227A`; unidentified |
| $387-$3A0 | 19,763 | FR strings |
| $3A2-$3BB | 18,383 | IT strings |
| $3C0-$3C1 | 1,024 | header |
| $3C3-$4AC, $4AD-$59A, $59B-$617, $618-$6EB | 160,028 / 160,170 / 103,956 / 159,822 | music modules |
| $6EC-$707 | 20,755 | DE strings |
| $70A-$728 | 40,064 | title picture |
| $729-$733 | 40,064 | logo picture |

Music module load table at `$14E8`: 4 entries of 10 bytes {flags word, first sector, last sector, packed-buffer address long}: ($103, $4AD-$59A, $4D460), ($203, $59B-$617, $5B660), ($102, $618-$6EB, $50860), ($103, $3C3-$4AC, $4DC60). Modules are unpacked to `$43460` and played through `$158A`. Each module starts with a 16-byte name field.

## 10. Unknown / next steps

- Layout of the scenario +$24 block ($84-$9D, used by `$E2D2`) and of Disk.1 $368-$386, $2C0-$2CD, $328-$34B.
- Meaning of the scenario parameter block fields, the 18-byte object-type entries and the 8-byte object records; the units and resources structures; economy and tick logic in `$6936`, `$6540`, `$4D48`, `$4D96`, `$5D30` (called each loop iteration, not analysed).
- Names of the screens behind the icon dispatch and the six F-key routines.
- Palette source for in-game screens; whether the sixth image plane is a mask; the 21 descriptors at `$12D6A`.
- Purpose of the slave's resload_Control call at slave `$382`.
- Variant B of the slave (CRC $5E14) uses different patch addresses and was not compared.
