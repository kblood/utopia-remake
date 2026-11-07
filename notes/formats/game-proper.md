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

### Fresh scenario entry and first pass (VERIFIED statically)

The ordinary scenario path (`$88F0` -> `$866E` -> `$8B02`) initializes the state and returns to the disk menu. The player must
then exit that menu through `$802C`; the boot path enters `$15EF0` and calls `$11476` before reaching the first `$157BC`
pass. `$11476` is unconditional at that boot call site: it clears `$144A8`, returns only if `$144A6` is zero, otherwise
chooses a saved marker coordinate from `$14524` with one `$2DCC` draw, then writes alien type `$13`, x/y and frame 0.
It emits no sound/effect. The same routine is also called by event 1, but that caller has its own chance roll.

Fresh initialization leaves `$156A8=$94` (including the queued-day bit 7). `$802C` clears bits 2 and 4, not bit 7; the first
`$4D1C` therefore consumes a day before the first VBL wait. Starting from 28/06/2090 this becomes 01/07/2090 and sets the
daily and monthly pending bits, so `$99C4` runs those periods after the first wait. A Copperline new-game observation also
showed 01/07/2090, but did not isolate the exact pass boundary. The original RNG result for initial marker selection depends on
hardware/time inputs; the remake uses its injected RNG range draw and does not claim identical placement. On the browser menu
route, the remake consumes the queued day on its immediate first fresh-start pass before presenting the selected map, then
uses its configured VBL interval for later passes. That first pass goes through `MapScene.update()` in the same browser update
that changes the stage, with neutral input so the scenario-menu click is not replayed as a map command. The pass body, draw
and queued-date work run before that update's first VBL countdown, and the VBL then counts toward the next pass. This matches
the statically traced `$157BC` → draw/date → VBL-wait order; first-frame alignment and original runtime parity remain unverified.

The runtime image also supplies `$145A3=1` and the six-byte `$145A4..$145A9` table `00 02 03 04 03 01`. These bytes are
outside `$866E`'s cleared range and remain initialized image data in the original. The remake copies these defaults into a new
`GameState`; snapshot restoration continues to preserve its saved bytes verbatim.

### Date (VERIFIED from `$564A`)
Day `$1459F` (month rolls at $1D, so 28-day months), weekday `$145A1` (mod 7), month `$145A0` (wraps at 12), elapsed-year counter long `$142A6` (cleared to zero in the new-game initializer and incremented at each January rollover). The date string at `$14594` is incremented independently; its starting displayed year is 2090. Thus the visible year is 2090 plus `$142A6`, while simulation rules use the elapsed counter.

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
| 8 | word, labelled "disk id" (1, 2 or 3) in the Disk.1/Disk.2 headers; the expanded Disk.4 seed has 0 here. `$841E` does not read it (it classifies by magic only), so 0 is valid on Disk.4 and the value is not the slave's disk id 3 (see `xpk-mash.md`). |
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

**Input validation use (IMPLEMENTED, synthetic tests).** At startup `validateProfileBytes` (`src/data/profile-input.ts`) requires the `UTOPSCEN` magic at sector `$3C0` of Disk.2 and bounds-checks all ten pairs of all ten records (sprites, tiles, descriptors, map, block, intel, 4 text) against the file length before any engine constructor runs. This checks that declared extents lie inside the file; it does not decode their content, and `last < first` is rejected as corrupt (an engine rule, not an observed original rule). See `utopia-disks.md` for the recognition / validation / compatibility distinction.

### Save record (Disk.4)
+$10 = (A start, A end), +$14 = (B start, B end).
- A: 73 sectors, loaded to/saved from `$39E3A` (object list and map).
- B: 11 sectors, from/to `$13034` (through `$14633`).
- Slot positions step by 120 sectors, skipping the header at $3C0 (8th slot at 1080). Track arithmetic uses `d1 = (A start)/12 + 8`. HYPOTHESIS/unreconciled: the 120-sector stride and the "8th slot at 1080" count are static-analysis statements; only slot 0's extents are known from the seed (its other records are EMPTY), so slot indexing at the header boundary is not verified. The parser below therefore trusts each record's own extent pairs and assumes no stride.

### Raw Disk.4 parser (IMPLEMENTED, synthetic tests only)
`src/data/disk4.ts` (`parseDisk4`, `readDisk4Slot`) parses an already expanded, raw, offset-addressable Disk.4 image supplied as bytes:
- Header at byte `$78000` (sector `$3C0`): signature `UTOPSAVE` required; the word at +8 is exposed (`idWord`) but not checked (0 accepted). At least `$78000 + 650` bytes (10 + 10 x 64) are required; sectors `$3C0-$3C1` are treated as the header for overlap checks.
- Ten records from +10. Name = bytes up to the first NUL (trailing spaces trimmed). Name `EMPTY` classifies the slot as empty without reading or validating its extents. A blank name is invalid.
- Populated slot: A = big-endian inclusive pair at +$10, B = pair at +$14. Each must have last >= first, be exactly 73 (A) / 11 (B) sectors, end inside the image (`floor(length / 512)` sectors) and not overlap sectors `$3C0-$3C1`; A and B must not overlap each other, and populated slots must not overlap one another (both slots of a clash become invalid). A bad record makes only that slot "invalid" with a descriptive error.
- `readDisk4Slot` returns copies (`Uint8Array`) of A (37,376 bytes) and B (5,632 bytes), or an error (empty slot, invalid slot, index out of range).
- `parseDisk4` itself stays raw-only: input starting with `XPKF` (the supplied 656-byte seed) is rejected as `compressed-xpk`.
- The disk's slot count (`DISK4_SLOT_COUNT` = 10) is independent of the remake's eight localStorage slots (`SAVE_SLOTS` in `src/game/save.ts`).

### XPK/MASH seed decoding and `parseDisk4Input` (IMPLEMENTED, synthetic tests + optional local golden check)
`src/data/xpk-mash.ts` (`unpackXpkMash`) is a bounded TypeScript translation of the ancient XPKF/MASH decoder (details, validation list and reference quirks in [xpk-mash.md](xpk-mash.md)). It supports long chunk headers, an optional extended header (skipped), raw/MASH/end chunks, and rejects other formats, flags, codecs and chunk types explicitly. Safety limits of this implementation (not format properties): input <= 2 MiB, output <= 1 MiB, <= 4096 chunk headers.

`parseDisk4Input(bytes)` in `src/data/disk4.ts` detects `XPKF`, unpacks, then hands the raw bytes to `parseDisk4`; other input goes to `parseDisk4` unchanged. Failures are tagged with a stage: `decode` (XPK/MASH error) or `disk4` (raw Disk.4 error). Unpacked data that itself starts with `XPKF` is not unpacked again. This is read-only parsing: the result is not connected to the loader, game start, UI or localStorage.

### Area A/B content decoder (IMPLEMENTED, synthetic tests only)
`src/data/disk4-state.ts` (`decodeDisk4State`, input = `Disk4SlotAreas` from `readDisk4Slot`) slices only the VERIFIED ranges of [game-state.md](game-state.md) sections 1, 3.8 and 7.2 into copies: map cell words (75 x 100 from `$3F256`, row stride 102 words, pad words dropped), per-cell flag bytes (75 x 102 from `$3D3A6`, padding columns kept), 1000 x 8-byte object records (`$3B466`) and the four entity lists (enemy air `$39E3A`, enemy ground `$3A146`, own ships `$3A75E`, own tanks `$3AB1E`; full slot arrays, not compacted), plus their count words from area B (`$142A4`, `$142A2`, `$1429E`, `$1429C`, `$142C2`, read as big-endian words and bounded to 30/60/40/99/1000). It requires exactly 37,376 / 5,632 bytes and returns typed errors (`not-areas`, `area-a-size`, `area-b-size`, `count-range`) with no partial result. Untouched copies of areas A and B are returned alongside. Count widths (word) follow the sim's use and `$142C2` as documented; the 30/60/40/99 capacities come from the section 3.8 table. Not decoded here: list headers (`$39E20` etc. lie before area A), record fields (see the entity decoder below), scenario selection or post-load initialisation. This decoder is consumed by the preparation layers; Game.activateDisk4 uses those layers in an experimental scene path. One memory-derived populated capture has been observed (see below), but it is not a persisted Disk.4 and does not verify original load behaviour. The full saved map rows run through `$42E19` including final padding, leaving unused area A bytes up to `$43039`.

### Entity list decoder (IMPLEMENTED; feeds experimental activation; synthetic tests)
`src/data/disk4-entities.ts` (`decodeDisk4Entities(state: Disk4State)`) turns the four raw entity lists into fixed slot arrays (30 enemy air, 60 enemy ground, 40 own ships, 99 own tanks), read-only. Every slot is kept, free ones included, in slot order: list name, slot index, original RAM record address (`list base + index * record size`), `status` (`free` = type byte 0 per map-rendering.md 7.2 / units.md 3, else `occupied`), the exact record bytes (`raw`, a copy) and the raw unsigned long at the flag-pointer offset (`+$14` own units, `+$16` enemies). Decoded fields are limited to those in game-state.md 3.8, units.md 3, enemies.md 2 and ship-control.md 2-3: type, x/y, signed dx/dy and vx/vy, raw direction, raw hp, raw control byte (`+9`) plus a `waiting` bit for own tanks and enemy ground only, tech, target x/y; per list tank recent directions (`+$10..+$12`), ship class (`+D`) and fuel word (`+E`) for the ordinary ship layout (every type except 17; `layout: "ship"`), lift (`+$10`), next mode (`+$11`), turn (`+$12`), for a type 17 projectile (`layout: "missile"`) instead the raw long at `+$C` (`targetLong`) and its 24-bit masked address `+$D..+$F` (`targetAddress`) with NO class or fuel (the same bytes; `$ACE2`, building-screens.md 3.6), enemy step counter (`+D`), bomb chance (`+E`), damage (`+F`), `+$10` as lift (air) or recent directions (ground), and `+$13`/`+$14`/`+$15` with an `overlap` annotation per type (bomber bomb count and bomb-run bytes, kamikaze dive height, crusher toggle, otherwise `unknown`). Bytes the notes do not document stay only in `raw`.
- No compaction, no use of the count words as iteration bounds (stored count and occupied-slot count are both reported, a mismatch is not an error), no pointer resolution, no clamping, and the input state is not mutated. Free-slot fields are reported as stored: the destroy path `$4732` clears only the word at +0, the byte at +2 and the word at +8 (units.md 5), so stale data can remain.
- Errors: `not-state`, `list-shape` (record size, capacity or buffer length differs from game-state.md 3.8), `count-range` (count not an integer in 0..capacity); no partial result.
- Evidence limits: the ship `+$14` long is VERIFIED (statically) as the per-cell flag-byte pointer created by `$387E`/`$497E` for ordinary ships as well as `$49E8` for missiles, the decoder keeps it raw; `$4526` (new cell step) rewrites it, take-off `$4152` writes it and `$4732`/`$46CC` release the cell it names (traced, see ship-control.md 5c; landing is not traced); the enemy `+$14`/`+$15` bomber meanings and the `+$13` kinds come from the behaviour notes, which do not state which list holds which type (annotations go by type number only); signedness of `hp`, `fuel` and `control` is not documented, so they are raw unsigned; ship `+9` bit 7 is not documented and no `waiting` is derived for ships or aircraft. `prepareDisk4Load` calls the pure decoder and exposes its result as `entities`; the tank, enemy and ship preparation layers described below consume selected lists; `Game.activateDisk4()` exposes an experimental browser flow, while this decoder remains read-only. Coverage: `test/disk4-entities.mjs` (decoder) and `test/disk4-load.mjs` (composition, error propagation) and `test/disk4-scenario.mjs`, synthetic images plus the optional local observed-map comparison; it has not been run against the populated capture below.

### Restore preparation foundation (IMPLEMENTED; feeds experimental activation; original runtime fidelity unverified)
`src/game/disk4-load.ts` (`prepareDisk4Load(bytes, { slot, scenario, scenarioCount })`) composes `parseDisk4Input` -> `readDisk4Slot` -> `decodeDisk4State` -> `decodeDisk4Entities` -> `GameState.fromSnapshot` -> `World.fromSnapshot` and returns fresh detached state/world objects, the decoded raw `disk4`, typed fixed-slot `entities`, plus slot, name, scenario and source. Errors are tagged by stage (`request`, `input`, `slot`, `state`, `entities`, `restore`). `prepareDisk4TankLoad()` adds detached `UnitSystem.fromDisk4` restoration, preserving fixed own-tank slots, record provenance and the saved sub-tick. `prepareDisk4SimLoad()` adds `Sim.fromSnapshot()` over the same graph. It skips the known new-game capacity fallback (`$14432`) and alien marker-table scan (`$144A6`/`$14524`), preserving those saved bytes. It still creates only inert simulation helpers: ships, enemies, transient flags, alien/meteor render objects, hooks and original post-load initialization are not restored. Preparation functions do not touch an active game or input bytes and do not return partial results. `Game.activateDisk4` reads saved disk id `$1453E` and scenario index `$135C2` before preparation; an explicit scenario choice is accepted only to recover an invalid saved index.
- **Scenario metadata (`src/data/disk4-scenario.ts`; static Disk.1 trace and Disk.2 data).** The original `$87DC` mode-2 load path reads `$1453E`, checks it against the Disk.2 header word at `+8` through `$8A5A`, then reads `$135C2` and indexes `$8F96 + index * $40` (`$888A-$88AA`). The supplied scenario blocks store their own index at block offset `$58E`, loaded at `$135C2`. `Game.activateDisk4` uses valid saved metadata as authoritative; a disk-id mismatch is refused, and an out-of-table index requires an explicit recovery choice. `identifyDisk4Scenario` is advisory only: it ranks saved-map tile-id matches using implementation thresholds (50% minimum and a 10-point lead) and cannot override a valid index. The memory-derived capture matches scenario 0 in all 7,500 map cells, but that is independent supporting evidence, not the selection source.
- **Headless enemy and ship continuation (`prepareDisk4HeadlessEnemies()`, synthetic checks).** This composes `prepareDisk4ShipLoad()` then adopts its `EnemyRoster` and `ShipRoster` into one `EnemySystem` (the ships into `sim.fleet`) with the same fixed arrays and exact `Enemy` / ship / missile objects. Adoption validates the roster, shared map/flag buffers and caller-supplied `CombatTables` before returning; it does not initialize, spawn, step, consume RNG, call hooks, or mutate state/map/flags/object records/counters. Enemy movement advances when the caller calls `pass(clock)`; gun periods run through `Sim.periodicPass()` (inside the headless `Sim.loopPass()`), while `frame()` is a legacy no-op. `pass()` visits occupied entries in stable slot order; spawn/defect use the first free slot, matching static original scans `$48EC` (ground) and `$48B6` (air); destruction clears a slot without shifting survivors. A prepared missile's `target.enemy` is a save-time identity; the runtime binding is the fixed enemy slot (`target.ref`), whose current occupant is looked up on every use, so slot reuse after a death is followed and no dead `Enemy` is retained. Ships get their `ShipExtra` from saved `+6/+7`, `+$11`, `+$12` and the `+$14` reservation cell (must be a playable flag byte), and restored missiles follow `$4408` (main pass) and `$ACE2` (daily destroy/refresh) as traced in ship-control.md 5c. Ship/missile validation (all-or-error, typed `EnemyAdoptError`) covers missile modes other than 1/2/4, lift above `$7F`, bad `+$14` pointers and a `$1429E` count that differs from occupancy. Crushers (type 24) are adopted: the saved `+$13` is split into toggle (bit 7) and counter (low 7 bits), `+$14` is the animation, and the crusher continues with the step traced from `$11F12`/`$11F42` (enemies.md 3a). Only a counter above 7 or an animation above the largest value of table `$12D60` returns typed `unsupported-state` (`crusher-counter` / `crusher-anim`) before mutation; this is a conservative domain check, not proof that the original rejects such bytes. The crusher mapping is a static trace checked by synthetic tests (`test/disk4-crusher.mjs`), not an observation of the running original or a persisted save; sliding off the map after an arrival is an untraced policy. Preparation and adoption create no ships through `Fleet.createShip()` and write nothing; the fleet must be empty beforehand. This layer is not a playable restore or a reconstruction of original post-load initialization.
- `GameState.fromSnapshot(image)` (`src/game/state.ts`) adopts exactly `STATE_BYTES` (5,632) bytes of area B byte for byte as a copy. The new-game defaults (`$866E`) are not applied and nothing is clamped. Errors: `not-bytes`, `state-size`.
- `World.fromSnapshot(state, { cells, cellFlags, objects })` (`src/game/world.ts`) copies all 7,500 map cell words (flag bits intact, no solar-tile normalisation), all 7,650 per-cell flag bytes (`World.cellFlags`, 102-byte rows, including padding) and all 1,000 records in their original slots. It does not call `buildObjects`, recompute type counters, draw random phases or set `warehouseCapacity` (kept 0 so `Sim` does not overwrite the saved `$14432`). `World.objectCount` becomes the saved `$142C2` count word. Errors: `not-bytes`, `map-size`, `flags-size`, `object-size`, `object-count` (word above 1000).
- **Object records are not a dense prefix.** The port (`src/game/build.ts`, following `$6BF4`/`$7372`; the original's allocation order itself is HYPOTHESIS beyond "tile word 0 = free slot", game-state.md 7.2) frees a slot in place on demolition and takes the first free slot on construction, so used records can sit beyond the count and between holes; a restored save may contain such holes. Coordinate lookup (`Builder.findObject` and building-window `findRecord`) uses `$142C2` as the original DBRA budget over non-empty records, so an under-counted sparse record beyond that budget is intentionally not found. Other routines such as mine collapse, tank-yard production, Gun scans and `Fleet.shipYard` traverse fixed slots while counting matching record types; they do not use `$142C2` as a universal array bound. `World.objectCount` is the saved/current count word, not proof that occupied records form a dense prefix.
- Experimental live-scene activation exists, but the game is not a fidelity-complete restore: the own tank list can additionally be hydrated into a detached runtime `UnitSystem`, and `prepareDisk4EnemyLoad()` (on top of `prepareDisk4SimLoad()`) hydrates the enemy ground (60) and air (30) lists into a detached fixed-slot `EnemyRoster` (`src/game/enemies.ts`); `prepareDisk4ShipLoad()` (on top of that) hydrates own ship types 11-16 and missiles (type 17) into a detached `ShipRoster` (see the ship paragraph below). The composed headless graph is consumed by `Game.activateDisk4()` for the experimental live-scene path. Enemy hydration keeps stable slot indices (free slots stay `null`, their stale bytes stay in `entities`), the exact record bytes/address/flag pointer/full `+9` control byte, lift (air), tech, type, step counter, damage, bomb chance, recent directions (ground) and the `+$13..+$15` bytes; the reservation mirror is resolved from the `+$16` pointer with the shared 102-byte resolver when it names a playable cell (it need not equal x/y; otherwise -1/-1). Occupied records must have a type valid for their list (ground 9/10/22/23/24, air 25/26/27), an on-map cell, and direction 0..7, otherwise the whole preparation fails with an `enemies`-stage typed error; the `+$16` long is NOT validated against the flag array (any unsigned long, zero / padding / out-of-range included, is kept raw for occupied and free records and `EnemyRoster.groundPointers` / `airPointers` carry it; the reserve mirror is the named cell only when it is playable, else -1/-1). It shares the world's map and flag buffers without copying or writing them and performs no spawn, defection, movement, combat, RNG, hooks or counter updates. For type-24 ground records `Enemy.fromDisk4` decodes `+$13` as toggle (bit 7) + counter (low 7 bits) and `+$14` as the animation (static trace, enemies.md 3a; the raw bytes stay in `sourceRaw` and `aux` / `p14`; other kinds keep the defaults). HYPOTHESIS/open: that the aircraft `aux` is signed and the ground `aux` unsigned follows `spawn()`, not a save observation; saved enemies are assumed to hold their map bits already. `prepareDisk4SimLoad()` constructs an inert `Sim` that skips the known capacity fallback and marker-table rescan, but its unsaved transient flags, ship runtime objects (alien/meteor handles are hydrated from the saved bytes by `Aliens`, section below), hooks, `MapScene`, screen state and original post-load initialization are not restored. Skipping constructor writes preserves bytes; it does not prove the original load behavior.
- **Own ship hydration (`src/game/ship-roster.ts`, `prepareDisk4ShipLoad()`; detached preparation, synthetic tests).** `ShipRoster.fromDisk4(slots, enemies?)` takes the 40 decoded ship slots (never the count word) and keeps stable slot indices (free slots stay `null`, stale bytes stay in `entities`). Per occupied ship it keeps the exact type, cell, signed dx/dy, direction (0..8), hp, full `+9` byte as `mode`/`savedControl` (0..8, no waiting bit is split off), tech, target x/y, class (`+D`, must equal type - 11), unsigned fuel word, lift, the raw record bytes and RAM address, plus a typed detached `extra` record `{ vx, vy, next, turn }` (signed `+6/+7`, `+$11`, `+$12`); hydration alone is not built through `Fleet.createShip()` and creates no `EnemySystem` extra (the headless adoption seeds one from these saved values, ship-control.md 5c). Validation (typed `ships`-stage error, whole preparation rejected, lowest bad slot reported): slot count 40, slot provenance and 24-byte raw size (`slot-count`/`slot-index`, also a `layout` that disagrees with the type byte), type 11..16 or 17 (`ship-type`), on-map cell (`position`), direction 0..8 (`direction`), class 0..5 matching the type for types 11..16 only (`class`), mode 0..8 (`mode`). **Occupied missile (type 17) is a distinct `RestoredMissile`** (`kind: "missile"`, no class/fuel/`cls`): it keeps the common fields, `+B/+C` as stored (stale until a daily `$ACE2`), lift, the typed `extra`, `target { semantics: "VERIFIED", rawLong, address, ref, enemy? }` and `flagPointer`. The target address is the 24-bit value in bytes **`+$D..+$F`** (`$ACE2`: `move.l $C(a6),d2; andi.l #$FFFFFF,d2`; `+$C` = saved y is masked away). It is resolved against the decoded fixed enemy slots (`prepareDisk4ShipLoad()` supplies them) by exact slot start only: air `$39E3A + i*$1A` (30), ground `$3A146 + i*$1A` (60); `$3A12C` is air slot 29 (the ground scan base), not a separate header. `target.ref` is `{ list, index, address, status }`; a free enemy slot is accepted (`status: "free"`, `enemy: null`) because `$ACE2` only destroys the missile on its next daily step. A pointer into the air header `$39E20..$39E39`, inside a slot, or outside both lists is a `missile-target` error (`reason`: `header` / `misaligned` / `out-of-range`; the failing `address` is reported); missing or malformed enemy slot lists are `enemy-slots`. When `enemy.objects` is passed (the prepare function passes `EnemyRoster.ground/air`), the target carries `enemy: Enemy | null`, the already-hydrated detached object by reference, after checking list/slot/`sourceAddress`/type (`enemy-object` on disagreement); it is shared identity only and is never read or written. Nothing is clamped, derived or written: no hooks, counters (`$1429E`, `$14254..`), RNG, map words, flag bytes, enemy objects or saved state; hydration does not fly, re-aim or destroy the missile (the headless adoption does, 5c). The `+$14` long of every ship-list record (ships and missiles) is VERIFIED (static, `$387E`/`$49E8` -> `$497E`) as a pointer to the per-cell flag byte (`$3D3A6 + y*$66 + x`); it is kept as `flagPointer { semantics: "VERIFIED", raw, target, atOwnCell }`, classified with `resolveCellFlagPointer` (playable / padding / out-of-range); hydration never rejects or writes it, only the headless adoption requires a playable target and then treats it as the current reservation cell (`$4526` / `$4732`, ship-control.md 5c), not necessarily x/y. Also unverified: that the saved ship mode/next/turn bytes (and the missile's `+$10..+$12`, mapped by position) behave after load as they do in the live port, and that saved ships hold their map marks already.
- The prepared graph can be activated through the experimental scene flow below. It is not connected to the remake's own localStorage save ([remake-save.md](remake-save.md): a separate, remake-only record that refuses Disk.4 sessions and provenance), and saving/exporting Disk.4 does not exist.
- **Experimental scene activation (`MapScene.fromPrepared`, `Game.activateDisk4`; synthetic saved state plus local game assets; not compared with the original runtime).** Saved metadata selects the scenario: `$1453E` must match Disk.2 header `+8`, and valid `$135C2` selects the header-table entry. Only an invalid saved index can be recovered by caller choice; map matching supplies advisory suggestions. The original `$875C-$87DA` reset is modelled for `sysFlags`, pause, queued day and warning lights; `$88DC-$88E6` clears all 30 effects. The scene starts with empty messages/effects. The decoded raw area-B copy and input Disk.4 bytes remain unchanged; the runtime GameState mirrors the original `$88AA` write of `$8F96 + scenario*$40` at `$1453A`. RNG restoration and the remaining `$802C` exit-handler/post-load behavior are incomplete. Active alien/meteor records hydrate only within validated traced domains. Disk.4 sessions cannot be saved through remake localStorage. This remains bounded static-trace/synthetic continuation, not original restore fidelity, write-through, export or roundtrip compatibility.

Still incomplete or unverified: full-fidelity playable restoration (restored ship landing (static trace and synthetic coverage only, without emulator comparison), stale freed-enemy-record bytes and missile modes other than 1/2/4 are unsupported or untraced; crusher states with a counter above 7 or an animation above the table maximum are refused and the crusher step is a static trace without an emulator comparison), original post-load initialization, robust scenario identification for edited maps, writing/exporting Disk.4 or re-packing XPK, and save-name (15-byte date/name) decoding. Experimental browser activation and its disk-menu flow exist, but do not claim original restore fidelity. Headless EnemySystem adoption (enemies, ships, missiles) and explicit passes are implemented as a limited continuation layer, not full restoration fidelity. Coverage is synthetic in `test/disk4.mjs`, `test/disk4-state.mjs`, `test/disk4-entities.mjs`, `test/disk4-load.mjs`, `test/disk4-enemies.mjs`, `test/disk4-crusher.mjs`, `test/disk4-ships.mjs`, `test/disk4-fleet.mjs`, `test/disk4-scene.mjs` and `test/xpk-mash.mjs`; the XPK test additionally compares the TypeScript expansion of the player's local seed with local Python output when those local files exist (skipped otherwise). A persisted, written-back Disk.4 has not been observed, and the XPK/MASH decoder has not been cross-checked against an emulator.

### Observed populated save capture (2026-11-06, OBSERVED; limited)
- Setup: isolated Copperline A1200 run using a temporary copy of the WHDLoad set. The user-facing game reached the world and the save UI showed `SAVE COMPLETE` for slot 0 named `REFRUN`.
- Copperline's configured `[[filesys]]` host-directory volume did not persist the write: the copied Disk.4 file stayed the expanded blank seed after the UI success. So no written-back Disk.4 exists from this run.
- With the emulator paused after the save, guest memory was read through Copperline control: the Disk.4 header from `$8F8C` (1024 bytes), area A from `$39E3A` (37,376 bytes) and area B from `$13034` (5,632 bytes). The header record gave slot 0 name `REFRUN` with extents A sectors 0-72 and B sectors 74-84 (matches the seed's slot 0 extents above).
- A raw 983,040-byte snapshot was reconstructed outside the repo (OS temp folder `UtopiaReferenceRun-20261106\disk4-observed-save.raw`) by overlaying exactly those captured header/A/B regions onto the expanded seed. It is not committed, and no `original/` files or repo/test data were changed.
- Read-only check: `parseDisk4Input()` and `decodeDisk4State()` accepted that artifact: slot 0 `REFRUN`, 7,500 map words, object count 20, enemy air/ground and own ship/tank counts all zero.
- Meaning: structural compatibility of the parser/decoder and a map-based scenario match with one memory-derived capture. It does NOT establish persisted write-through, original Disk.4 load behaviour, or runtime fidelity. This capture is used only by optional local checks; no capture or game data is stored in the repo. Export and original post-load fidelity remain unimplemented.

### Save handler `$8918` (VERIFIED static flow)

- Mode 1 (`$938D = 1`) builds a 15-byte date/name from `$14594` into `$161AA`, copies those 15 bytes into the selected 64-byte header record, then calls `$7D88` to write header sectors `$3C0-$3C1` first.
- It then writes area A from `$39E3A` using the record's words at +$10 and area B from `$13034` using +$14. Under WHDLoad `$7D88` is patched to the slave's `SaveFileOffset` wrapper, which writes to `Disk.4` at the sector-derived byte offset. The final message is `$141`; the selected slot is reset to `$FFFF`.
- Mode 2 reads the same two areas from the chosen record into `$39E3A` and `$13034`.
- WHDLoad's `resload_SaveFileOffset` documentation says it extends a missing/short file to the requested offset (filling the gap with `$DD`) and warns that files used with `SaveFileOffset`/`LoadFileOffset` must not be compressed. This implies the supplied XPK `disk.4` is only the initial seed; after a save, WHDLoad's save-file path provides an uncompressed, offset-addressable `Disk.4`. See the [WHDLoad Resload API](https://www.whdload.de/docs/autodoc.html).
- In the supplied blank Disk.4 image, slot 0 has sector words `(0,72)` and `(74,84)`. The header's slot records carry these extents; preserve them when writing a slot.

### Disk menu (`$938D` mode, loop `$7EF6`)
Modes: 1 save game (header "SAVE"), 2 load game, 3 load scenario (header "SCEN"), 4 music select. Handlers `$87DC`, `$8AF4`, `$8B02`. d2 table (`$7FE4`, VERIFIED by decoding the compare/branch chain, `test/disk-menu.mjs`): 0 -> `$85FE` (load game from a save disk: asks for the disk with `$135`, a disk header "UTOP"+"SAVE" -> `$13A` "Click on slot to load game from...", mode 2), 1 -> `$856C` (save game: `$18A` "There is no game to save!" when `$156AA` bit 3 (game over) is set, else the same disk check, `$138` "Click on slot to save game into...", mode 1; `$87DC` mode 1 -> `$8918` asks for the name), 2 -> `$8632` (load scenario from a scenario disk: header "UTOP"+"SCEN", `$13D` "Click on slot to load scenario from...", mode 3), 3 -> `$8314` (format a save disk: `$130` warning, Return formats, a mouse click aborts), 4 -> `$1062` (music on/off), 5 -> `$802C` (exit to the map; refused while `$156AA` bit 3 is set), 6 -> `$80C8` (**tutorial**, not a generic "new game": `$191` "Loading Tutorial..", state initialisation `$866E`, scenario record 0 through `$8B02`, `$156AA` bit 7 (tutorial) and bit 2 (no-unit bonus), money `$135BA = $7A120`, then `bra $802C`), 7 -> `$1006` (music select: opens mode 4), 8 -> `$10BC` (effects on/off, `$194`/`$195`). The icon pictures agree (arrow out of a floppy, arrow into a floppy, plain floppy, floppy with "!", music note, red stop square, graduation cap, floppy with a note, "FX"). The game proper starts in this loop (`$157AE` -> `$7E52` -> `$7EF6`), not on the map; its picture is idx 1 of `$8C8C` (`$2CE`-`$2E4`). The pressed look and the click come from `$5948`/`$59C8` ([sfx.md](sfx.md), [screens.md](screens.md) section 10): a 32 x 32 flip of plane 3, not the 16 x 16 flip of `$5756`. Handler results are printed by `$83A2` in a message area of two lines (y `$B5`, `$BE`; the list prompt `$8462` uses y `$A3`, `$AC`) and erased by a loop countdown (`$8CB0 = $4E20` iterations).

**Remake** (`src/game/disk-menu.ts` `DiskMenuScene`, `Game` stage `disk`; tests `test/disk-menu.mjs`, `test/music-select.mjs`, `test/game-music.mjs`, `test/button-sound.mjs`): `Game.openDiskMenu()` shows the original picture, nine live icons and the shared list; icons 4, 5, 7, 8 run the traced handlers (music toggle, exit, music select, effects), icon 6 starts scenario 0 as the tutorial (flags and money as above; the rest of `$866E` is what the scenario start loads anyway, not compared). The save-disk family needs floppies, so icons 0-2 open the remake's own pages (remake slot lists titled `... - REMAKE SLOTS`, scenario list) and icon 3 prints a remake note; nothing there is original behaviour. Remake-only functions have no icon: the right button on the landing page opens the REMAKE MENU page (remake save, remake load, scenario list, experimental Disk.4). The original ignores the right button. The nine icon rectangles (`$8CB4`), the shared 10-row list (`$8132` hover test, row `floor((y - $20) / 9)`, x `$38..$88`, y `$20..$79`; `$8CFE` is the list row, in mode 3 the scenario slot copied to `$135C2`, in mode 4 the track row), the press/release rules and the track loader `$110A` are traced in [music.md](music.md) "Music-select flow" (static; no emulator capture). Note: `$80C8` clears `$8CFE` for the scenario slot, it does not select a music track.

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
