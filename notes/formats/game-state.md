# Utopia game state and simulation (static analysis of the game image)

Scope: the variable block, the scenario block, the periodic simulation, the object tables, the F-key
screens and the save format. Map drawing and blitting are out of scope (other notes).
Source: Disk.1 game image (sectors $14C..$208 at $1000, entry $156B6); image offset = addr - $1000.
Disassembly done with tools/game_dis.py style tooling (capstone, m68k). Scenario data via
`tools/state_dump.py` (numbers only).

Tags: **[V]** verified directly from code or data; **[H]** hypothesis (inferred from usage, names unknown).
All names below are my own functional labels. No game text is quoted; strings are identified by index only
(table at $188C2: 408 big-endian u16 offsets, index*2 -> offset from $188C2; message display = `$5A8C`, d0 = index).

Conventions: all values big-endian, `$` = hex, "word" = u16, "long" = u32. `T[i]` = object-type entry i.

---

## 1. Memory map of the state

| range | content |
|---|---|
| $13034-$14233 | scenario block, loaded from Disk.2 (9 sectors, 4608 bytes) [V] |
| $14234-$14633 | runtime variable block, zeroed + defaulted by `$866E` [V] |
| $14634-$14640 | message / misc timers [V] |
| $156A8-$156B3 | system flag bytes (see 3.9) [V] |
| $39D42-$3B466 | entity lists (3.8) [V] |
| $3B466-$3D3A6 | 1000 object records x 8 bytes [V] |
| $3D3A6-$3F188 | per-cell flag bytes, 75 rows x $66 (102) [V] |
| $3F256-$42E19 | map rows, 75 x $CC bytes (100 cell words + 2 pad words per row) [V] |

`$866E` is a state-initialization routine entered with d0 = mode. Mode 1 branches to `$875C`, which resets
system/runtime support fields and returns; it is called after the selected save's areas have been read. Other
modes zero `$14234-$144CB` (664 bytes) and apply the defaults of section 3.10. The actual Disk.4 load flow is
the `$938D = 2` handler in `$87DC`: it reads the selected slot's area A/B extents into `$39E3A` and `$13034`,
then runs post-load initialization. [V; traced in `game-proper.md` section 6]

---

## 2. Scenario block ($13034..$14233, from Disk.2)

Disk.2 scenario header = sector $3C0; 10 records of $40 bytes at +10; record words from +$10; the pair at +$20/+$22
(first/last sector) is the block (always 9 sectors). Scenario i block start sectors: 122, 286, 440, 1142, 546, 712, 806,
1262, 942, 1402. [V]

### 2.1 Layout

| addr | size | meaning | tag |
|---|---|---|---|
| $13034-$130FF | $CC | six graphics descriptors ($22 each) plus scenario-specific words; differs per scenario | V (layout), H (content) |
| $13100 | w | air plant A: monthly production per building (400) | V (use $9CDA) |
| $13102 | w | air plant B: monthly production per building (150) | V |
| $13104 | w | air plant A: storage per building (1200) | V |
| $13106 | w | air plant B: storage per building (800) | V |
| $13108 | w | food produced per worker, farm group A (10) | V ($9E98) |
| $1310A | w | food produced per worker, farm group B (15) | V |
| $1310C | w | power storage per Flux-Pod-type building (200) | V ($A0D4) |
| $1310E / $13112 | w | `$99C4` periodic helper args (d7 values), 0 / 0 | H |
| $13110 | w | 5 | H |
| $13114 | w | 10 | H |
| $13116 | w | 3840 ($0F00); read by $11ECA (event) | H |
| $13118-$1312B | 20 bytes | daily event chance bytes, index k = event number (see 5.6) | V |
| $13136 | long | free colonists (unassigned) | V |
| $1313A | long | employed total (sum of job pools) | V |
| $1313E | long | medics (job pool 6) | V |
| $13142 | long | scientists (job pool 7) | V |
| $13146 | long | security (job pool 8) | V |
| $1314A | long | total population | V |
| $1314E,$13156 | long | trade: tradable units / related, used by market code | H |
| $13152 | 5 longs | goods stock array, index 0..4; total goods weight is the separate long at $13166 | V |
| $13166 | long | total stored goods weight | V |
| $1316A-$131E1 | 12 x 10 bytes | market table (see 6.9) | V |
| $131E2-$13445 | 34 x 18 | object-type table (section 7.1) | V |
| $13446-$13455 | $FF fill | | V |
| $13456-$13475 | 32 bytes | alien record (section 5.8); +$11 at $13467 is copied into spawned enemy +$A by $48EC and also read by $E642 (that reader's meaning is unresolved) | V |
| $13476-$135B5 | 5 x 8 x 8 bytes | wave entries by alien level; eight entries per level, eight bytes per entry ($117EE) | V |
| $134B6-$13562 | | another per-scenario table view; overlaps the wave-entry address range above | - |
| $135B6 | long | spent last month (shown on finance screen) | V |
| $135BA | long | money (Gr); clamped to 9,999,999 for display | V |
| $135BE | long | research grant remaining (decrements by 100 monthly, message 101 when it hits 0) | V |
| $135C2 | word | scenario index saved in the Disk.2 block at offset $58E; Disk.4 load indexes $8F96 + index*$40 | V |
| $135C4/$135C5 | bytes | x,y of a map position (read by $3EDC, $C5BE) | H |
| $13658.. $13E63 | | 9 repeating $5A-stride tables that differ per scenario (graphics/animation) | H |
| $13EE6 | byte | flag read by $C5BE/$DA94/$E530 (written by $E530) | H |
| $13F10, $13F8E, $14108, $1400C, $14036 | | alien-intel probability tables, indexed by intel level-1 ($AF12/$B018) | V (use), H (meaning) |
| $141B0-$141B2 | bytes | alien activity / countdown ($E642, $B018) | H |

Parameter words $13100-$13138 and the event chance bytes are IDENTICAL in all 10 scenarios [V] (`state_dump.py diff`
prints nothing). The scenarios differ in the graphics descriptors ($1303A-$130FF), the alien/scenario records from
$13456, the later tables and the map/object data (loaded elsewhere).

---

## 3. Variable block ($14234-$14640)

### 3.1 Trade and stock
| addr | meaning | tag |
|---|---|---|
| $14234 [6 longs] | tradable units per good = stock*(100-retain%)/100 ($A784) | V |
| $144CC [6 longs] | retain percent per good, default 100 each | V |
| $1443A [6], $14452 [6] | supply / demand values for trade screen | H |
| $14432 | goods weight capacity (+$13880 = 80000 per warehouse-type building tile $44) | V |
| $14436, $143AA-$143BA | monthly production outputs (see 6.4) | V |
| $14342 | fuel stored in tanks (sum of T[16]+T[17] +$E) | V |
| $14376/$1437A/$1437E/$14392/$14396/$1439A/$1439E/$143A2/$143A6 | monthly/yearly flow statistics (see 3.7) | H |

### 3.2 Population and jobs
| addr | meaning | tag |
|---|---|---|
| $1432A | construction workers (taken from free colonists when a building is placed, returned on completion) | V |
| $1432E / $14332 | births / deaths last month (shown on F1) | V |
| $14336 | | H |
| $143BE / $143C2 | workers in farm-type buildings T[18] (tile $41) / T[19] (tile $42), 10 per building | V |
| $143C6[9] | required staff per job pool | V |
| $143EA[9] | assigned staff per pool | V |
| $1440E[9] | shortage per pool | V |
| $14500[9] | per-pool assignment cap | H |
| $142C2 | number of used object records | V |
| $142C4 | number of construction sites (tile $32) | V |

Job pool order = table at $B0C4 (T pointers): pool 0 = T[14] ($132DE), 1 = T[15] ($132F0), 2 = T[26] mines ($133B6),
3 = T[27] ship yard ($133C8), 4 = T[22] tank yard ($1336E), 5 = T[23] workshop ($13380), 6 = T[4] ($1322A, medics),
7 = T[1] ($131F4, scientists), 8 = T[20] ($1334A, security). [V]
Required staff = count(+$C) * 10; pool 6 uses *20. [V]

### 3.3 Economy and status
| addr | meaning | tag |
|---|---|---|
| $142C6 | quality of life % (clamped 10..98) | V |
| $142CA | construction spend this month (copied to $135B6 monthly) | V |
| $142CE | crime level (signed), written by $10BC8 | V |
| $144EC | morale, signed long, units 1/100 %, default 5000; no enforced range | V |
| $144F0 | pollution counter (default 50), reduced by research | V |
| $144F4 | per-capita tax per month (default 10) | V |
| $144F8 | tax chosen for next year (default 10); applied at year change | V |
| $144FC | copy of tax for display ($A010) | V |
| $142F2 | grant copy; $142F6, $142FA | income pieces: $142FA = pop*tax | V |
| $142E2/$142EE/$14302/$14312/$14316/$1431A/$14326 | statistics: this month ($142E2..), cumulative year ($14316..), previous year ($14302..) | V (copy flow) |
| $1433A | air stock before the month's update (sum of stored in two air plants) | V |
| $1434E | air produced this month | V |
| $14362 | population snapshot for air | V |
| $1433E/$14352/$14366 | food: stock before / production / consumption | V |
| $14346 | power-related counter, cleared when power state recomputed | H |
| $1434A | cumulative income stat (adds goods sold value) | H |
| $1435A, $1436E, $14356, $1435E | monthly stat registers | H |

### 3.4 Research and technology
| addr | meaning | tag |
|---|---|---|
| $14592 | tech level 1..10 | V |
| $145A3 | research progress counter, indexes table at $12D56 | H |
| $142D2/$142D6 | research funds (two kinds) | V (use) |
| $142DA | research accumulator (150 units -> pollution counter -1) | V |
| $142DE | research funds | H |
| $14472 (long) | invention bits (bit 16 = morale bonus; others unlock buildings) | V |
| $14476 | invention bits set by $AB0C from table $B214 | V |
| $1447A | selected research item | H |
| thresholds $B154 | 500,1000,2000,4000,6500,9000,11500,14000,16500 (tech level steps) | V |

### 3.5 Power and environment
| addr | meaning | tag |
|---|---|---|
| $144C8 | power shortage level = number of building types that cannot be powered, computed in $A0D4 | V |
| $144BB | eclipse flag (solar output 0); starts at 3, counts down weekly; each start and end also calls the `$11024` swap, which the remake keeps as a stored PARITY of all traced calls (`Sim.tileExchange`, save version 11; 5.1 item 3) | V |
| $144B4 | starvation level (0..20) | V |
| $144B5 | air shortage flag (=10) | V |
| $144C4 | overcrowding flag | V |
| $144B7 / $144B8 / $144B9 | virus effects | V (use), H |
| $144BA | trade computer failure flag | V |
| $144B1 | bits: warnings (cleared when $144C8<2) | H |
| $144B2 | weekly counter | H |

### 3.6 Time
| addr | meaning | tag |
|---|---|---|
| $14590 | frame countdown, reload 90 ($5A) | V |
| $14591 | speed/step byte (1) | H |
| $14594 | ASCII date string "dd/mm/yyyy", initial "28/06/2090" | V |
| $1459F | day of month 1..28 (wraps at $1D to 1), default $1C | V |
| $145A0 | month 0..11, default 5 | V |
| $145A1 | weekday 0..6 | V |
| $142A6 | elapsed-year counter (long; new-game clear leaves 0 in 2090; increments at each January rollover) | V |
| $145A2 | difficulty 0 / $14 / $1E (default $1E) | V |
| $144C1 | pending periodic bits: 0 daily, 1 weekly, 2 monthly, 3 yearly, 4 special | V |
| $144C9 | frame sub-tick 0..8 | V |

VBL handler `$2C34`: when `$156A8` bit 4 is clear, decrement `$14590` unless `$156A9` pause bit 2 is set. A decrement to zero reloads `$5A`, sets `$156A8` bit 7 (queued day), and skips the special test. Otherwise, if the resulting `$14590` is exactly `$2D`, `$2CA2` sets `$144C1` bit 4. The special test also runs while paused, so a paused countdown held at `$2D` re-sets the same bit. `$99D0` is its only clear; this is a single latched bit, so multiple unconsumed events coalesce. `$156A8` bit 4 freezes the whole timer block during dialogs and the build menu. [V: Disk.1 disassembly; one bounded RAM-staged live Gun A cycle is documented in `enemies.md` section 6; modal/pause gun behavior has not been captured in the running original.]

### 3.7 Statistics flow (VERIFIED copy mechanics, meaning H)
`$A010` monthly: $142F2..$142FA -> $142E2.. (this month); accumulate into $14316..; `$A096` yearly: $14316.. ->
$14302.. and zero $1431A/$14326; `$99C4` copies $14376->$1436A etc. before monthly work ($14392 -> $1437E at year).

### 3.8 Entity lists
| list | first record | record size | max | count var | tag |
|---|---|---|---|---|---|
| own spaceships | $3A75E (header $3A746) | $18 | 40 | $1429E | V |
| own tanks | $3AB1E | $18 | 99 | $1429C | V |
| enemy ground | $3A146 (hdr $3A12C) | $1A | 60 | $142A2 | V |
| enemy air | $39E3A (hdr $39E20) | $1A | 30 | $142A4 | V |
| temporary effects | $39D4A (hdr $39D42) | 8 | 30 | $156AE | V |
| alien sprite | $144A8 | | 1 | | V |
| meteor | $1449C | | 1 | | V |

Special sprite animation fields (static Disk.1 trace, `$333A` at `$35C8..$35F8`): when `$144A8` is nonzero and pause bit 2 of `$156A9` is clear, the main-loop pass reads word `$144A4`, increments its low byte, wraps low-byte `$0B` to word zero, stores the word, and writes table `$11718[index]` to alien `+$5` (`$144AD`). The table bytes are `00 01 02 03 02 03 02 03 02 01 00`; the index advances once per `$333A` pass and is not visibility-gated (the later `$3694` call builds the draw entry). `$144A5` is the low byte of the word `$144A4`, not meteor `+$9`; the meteor record occupies `$1449C..$144A3`. The counter is not reset when `$11476` creates the alien. The captured values at frames 23716/20/25/30 (`$144A4` = 5/6/7/8; alien `+$5` = 3/2/3/2) match the traced transition. A nonzero high byte in `$144A4` is not covered by the capture; table lookup uses the full word and such a value is outside the validated animation range. The remake draws the active alien record (type `$13` at `$144A8`) on the map from these bytes through a read-only adapter (`src/game/alien-sprite.ts`); `$3694` statically confirms signed pixel offsets at `+3`/`+4` and the frame-selected window-edge checks (map-rendering.md 7.2); drawing writes nothing. Active `$144A8` / `$1449C` records in a Disk.4 image are accepted by `validateSpecialSlots` only inside the traced domain (alien: type `$13`, on-map cell, `$144A4` 0..10, frame 0..3; meteor: type `$15`, on-map cell, frame 0, countdown 4..120 step 4) and otherwise refused as `special-state`; accepted records are hydrated inertly by `Aliens` and drawn, other bytes (meteor `+7`) are preserved uninterpreted (static trace and synthetic tests only). The meteor record (`$1449C`, type `$15`) is drawn the same way (`src/game/meteor-sprite.ts`, read-only, polled at draw time; map-rendering.md 7.2): `+1`/`+2` cell, `+3`/`+4` signed offsets, `+5` frame, `+6` a signed byte that is both the countdown and the drawing lift (`$78` at creation, -4 per unpaused pass, impact at 0), `+7` not read by the inspected draw path (static trace, no emulator comparison). Creation writes `+3..+7` = 0 before `+6` = `$78`. Not resolved: the original's paused-meteor control-flow anomaly and visual parity.

Unit record fields (own units, from $333A/$38E2/$11AE6): +0 type, +1 x, +2 y, +3/+4 sub-cell offsets, +5 direction 0..7,
+6/+7 velocity, +8 hit points, +9 mode, +A tech level, +B/+C target x,y, +D/+E fuel/counter, +$10..$12 recent directions,
+$14/$16 pointer to the cell flag byte. [V for positions and use, H for fine names.]
Ship modes (+9): 0 landed, 1 hovering, 2 flying-to-land, 3 flying-to-hover, 4 constructing launchpad, 5 launching,
6 landing, 7 flying to enemy (order from the mode string table, my paraphrase). Fuel (+$E word) falls by 1 per day in mode
1 and by 2 in modes 2/3; at 0 the ship is destroyed ($ACE2). [V]

Per-cell flag bytes ($3D3A6 + y*$66 + x): bit0 enemy ground unit, bit1 own unit, bit6 marker, bits 2/3 other. [H on bits 2/3]
Map cell word: low 10 bits tile id, $0400 animated, $0800 and $8000 resource flags (counted by the builder, 7.3),
$7F = special marker tile (7.3). [V]

### 3.9 System flag bytes
$156A8: bit7 queued day (set at `$2C8E`, cleared by `$564A`), bit4 freezes the VBL timer block during dialogs/build menu; bit2 screen-busy; bit0 is set by each VBL at `$2C58` and cleared by UI paths, with its remaining role not fully mapped; bits3/5/6 are partly used. `$156A9`: bit2 pause (skips `$99C4`), bit4 (set around `$7372` for bombs), bit5 the blast mark (set by each destroyer just before a `$4732`, cleared by every `$4732`; it survives between passes only after a missile hit on a free slot, ship-control.md 5e; `Sim.blastMark`), bit6 enemy
ground moves, bit7 own units move; `$156AA`: bit0 is set by `$866E` then cleared by `$80A6` on ordinary game start (runtime meaning otherwise unmapped), bit1 attack-wave pending, bit2 no-unit-bonus (blocks event 9), bit3 game over, bit4/bit5 QoL >=80/>=90
announced, bit7 Tutorial mode (set by `$8114`; skips daily events/eclipses and affects QoL). $156AB: draw-mode byte ($15 while drawing text, then 1). [V]

### 3.10 Defaults set by $866E [V]
$144CC: 6 longs of 100; $144E4/$144E8 = $2F, $144E6/$144EA = $21 (view origin); $144EC = 5000; $144F0 = 50;
$144F4 = $144F8 = 10; eight 10-byte marker slots at $14540 with byte +2 = $FF; $14590 = 90, $14591 = 1, $14592 = 1;
date "28/06/2090" (day $1C, month 5, weekday 0, difficulty $1E); $14634/$14636 = $FFFF; $15698 = $FF;
$156A8 = $94, $156A9 = 2, $156AA = 1, $156AB = 1.

Timer writers, static (2026-11-11, Disk.1): `$14634` is decremented by the VBL only while positive (`$2CBE`), tested by the main
loop idle clear `$15850` (zero triggers the clear, then the word is `$FFFF`), set to 500 by a log add (`$5AF4`, game-text.md 5),
and set to 1 by `move.w #1,$14634` at `$80AE`, in the exit tail `$802C`-`$80C6` that runs after `bclr #0,$156AA` at `$80A6` (fall-through, not a separate call; `game-proper.md`, "Tutorial start route", 2026-11-11). At the E state of
the 2026-11-10 construction capture (replayed 2026-11-11) the word is `$FFFF` with an empty log list (building.md, E-state RAM).

The game image's initialized bytes outside the `$866E` reset range include `$1453E=2`, marker ids 1..8 at `$14540+10n`,
`$145A3=1`, and weapon table `$145A4..$145A9 = 00 02 03 04 03 01`. A fresh `GameState` recreates these image defaults;
`GameState.fromSnapshot` does not apply them and remains byte-exact. On the ordinary map exit `$802C` clears `$156A8` bits 2
and 4 but leaves bit 7 queued, so the first `$4D1C` consumes a day before the first VBL wait (game-proper.md, fresh entry).

---

## 4. Time chain

- VBL decrements $14590 (90 frames, about 1.8 s PAL); at 0 it sets bit7 of $156A8 (the original code tests the byte;
  see game-proper.md) and `$4D1C` calls `$564A`. [V]
- `$564A`: day++ (wrap to 1 at $1D); weekday++ mod 7; sets $144C1 bit0 (daily); weekday wrap sets bit1 (weekly); day wrap sets
  bit2 (monthly) and month++ mod 12; month wrap sets bit3 (yearly) and year++ ($142A6). The displayed date string at
  `$14594` is incremented independently by digit helper `$571E`, so its initial year 2090 is separate from the elapsed
  counter. [V] Days per month = 28, months = 12, so year = 336 days.
- `$99C4` (main loop, skipped when $156A9 bit2 set) performs the work in 5.1. The preceding `$4D1C` call to `$564A` has no pause guard: a queued date still advances while paused, and the resulting `$144C1` period bits remain for `$99C4` to consume after resume. [V: caller/routine control flow; synthetic regression only, no pause capture]

---

## 5. Periodic simulation

### 5.1 Order inside $99C4 [V]
1. Clear pending `$144C1` bit 4; if set, `$11D34` (a0=$13248 = the +$C total word of T[5] (row start $1323C), the DBRA budget, not a row base; d1=$1F, d7=$1310E; Gun A).
2. Daily: if day==1 `$A8E8`; `$11D34` (a0=$1325A = T[6]+$C, d1=$F, d7=$13112); `$ACE2` ship fuel; `$B086` game over; $144BD countdown;
   $15698 message timers; `$10E1E` event scheduler; `$AF12` alien intelligence.
3. Weekly: `$7000` construction countdown; `$4798`; `$10FCA` eclipse; `$12510`; `$127A0`; $144B2--.
   [V, re-traced 2026-11-13 from Disk.1: the dispatch at `$9A56`-`$9A88` runs exactly this order, gated by `bclr #1` on `$144C1`.]
   - **`$10FCA` body** [V, static]: returns if `$156AA` bit 7 (tutorial). With `$144BB` = 0, `$145A0` = `$0B` and `$1459F` = `$15`: `$144BB` := 3, message `$DD`, bit 6 set, then `jsr $5A8C` and `bsr $11024`. With `$144BB` nonzero: decrement; at zero, message `$DE` and bit 6 cleared, then the same `$5A8C` and `$11024`.
   - **`$11024` graphics swap** [V, static; the state is a parity of every traced call, 2026-11-13 parity handoff; the visible effect is not observed]: swaps the data-address longs (+4) of descriptor entries 4 and 51, and 50 and 54, in the table at `$1612E` (8-byte entries `{rows-1, data address}`; rows-1 stays with its entry). Tile ids are 1-based, so these are tile ids 5, 52, 51 and 55 (`$05`, `$34`, `$33`, `$37`). Callers of `$11024`: the weekly eclipse start and end (`$1100A`, `$10FCA` paths), event 14 (`$1107A`), disk-menu entry `$7ECA` (only if bit 6 is set) and disk-menu exit `$8040` (only if `$144BB` is nonzero). [V, re-checked 2026-11-13 from the raw Disk.1 bytes at `sector*512` with base `$29800` for `$1000`, the `btst #6,$156AA` at `$7ECA` as the anchor: the `jsr $11024` sites are exactly `$7ED4`, `$8040`, `$1100A` (`bsr`) and `$1107A` (`bsr`); `$1100A` is reached from the start path through `$11004` (`jsr $5A8C`) and from the end path by `bra $11004`; `$1107A` is reached from `$11058` (event 14) at `$11028`, after `tst.b $144BB; bne` skips the roll, and after `move.b d2,$144BB`. The entry `$7E52` is called only by `$157AE` and `$15AE6`; `$157AE` only by `jmp` from `$B0BE` and `$10E18` (game-over paths).] Build-menu page 1 draws `$33`, and `$34` is the slot-9 research unlock, so the menu icons would change during an eclipse if the menu reads this table as the map does.
   - **Remake port (parity, 2026-11-13, `src/game/eclipse-tiles.ts`, `Sim.tileExchange`, `MapScene.syncTileView`).** `Sim` keeps the parity: every traced call toggles it (`exchangeTiles`). `Sim.enterDiskMenu()` toggles it when bit 6 is set (`$7ECA`); `Sim.leaveDiskMenu()` returns when game over is set or `$144BB` is 0, else toggles it and sets bit 6 (`$8040`-`$8046`). `eclipseTileView(tiles, exchanged)` returns a new tile list with the four entries' data addresses exchanged when `exchanged` is true (each keeps its own rows); the source tiles, planes and image bytes are not changed. `MapScene` keeps its own list, rewrites it in place when the parity changes, and applies it before each draw. `ObjectLayer`, `Controls` and `BuildMenuRenderer` receive that same list. The parity is saved (save-session.ts version 11); `Game.createScene` and `activateDisk4` carry the replaced session's parity, since no reset rebuilds the table (the carry into the Disk.4 session is not verified against the original).
   - **Why the table is a parity, not bit 6 (static, VERIFIED disassembly, 2026-11-13).** Bit 6 does not give the table state: (a) `$7E52`, entered from `$157AE` (`jsr $7e52`, and also the `$15AE6` call), runs `btst #6,$156AA` / `jsr $11024` (`$7ECA`-`$7ED4`), so each entry into that menu while bit 6 is set exchanges the table, and the menu's own state is then 0 while bit 6 is still set; `$157AE` is also the target of `jmp` at `$10E18` (the colony-fall tail, which leaves bit 3 set); (b) the new-game reset (`$866E` -> `$875C`) ends with `move.b #1,$156AA` (`$87CA`), which clears bit 6 with no exchange, so a table left exchanged persists into the new game. Table construction runs once at boot (`$15762`, `$7C4A` from `$1578E`), and no reset rebuilds it. Not checked: `$B0BE` (also `jmp $157AE`), and the in-game exit path beyond `$8040`; the emulator has not been run.
4. Monthly: `$9B20` = `$A86A` (trade income), `$A802` (market walk), `$9E3A`, `$9E98` (food), `$9DBA` (housing), `$9CDA` (air/finance),
   `$9BAE` (births, calls `$9C80` deaths and `$A246`), `$A010` (statistics/tax/grant), `$A0D4` (power);
   then the Command Centre re-open check (5.9), `$9F36` (job allocation), `$A270` (morale), `$10BC8` (crime), `$A360` (production), `$AB0C` (research).
5. Yearly: `$A096`.

### 5.2 Births and deaths
`$9BAE`: modifier m selected by difficulty $145A2: 0 -> 0, $14 -> $14, $1E -> $1E, plus a random 0/$1E/$3C.
births = ((pop*10+500)/1000 * (rate+rand) + 5)/10 into $1432E, added to pop and free colonists. Crime/overcrowding reduce
it. `$9C80`: death percent d2 removes d2% of free colonists and from each job pool (random rounding). [V, static formula cross-check 2026-11-10: births `$9BAE` rate `roll(difficulty)+base` and `(pop*10+500)/1000` etc. match `sim.ts births()`; `$9C80` matches `deaths()`.]

### 5.3 Air and finance (`$9CDA`) [V]
```
stock   = T[30].E + T[24].E            ; two storage-type buildings, +E = stored air
prod    = T[30].C*$13100 + T[24].C*$13102   (0 if $144C8 >= 20)
net     = stock + prod - population
net < 0 : $144B5 = 10, both .E = 0, morale += (-net*100/pop) * -20 (through $A246)
else    : capacity = T[30].C*$13104 ; surplus beyond capacity capped to $13106 and stored in T[24].E
```
Stored amounts are written back into the two buildings' +E words. [V]

### 5.4 Food (`$9E98`) [V]
```
have  = all of stock good[0] (removed)
prod  = $143BE*$13108 + $143C2*$1310A    (0 if $144C8 >= 18)
net   = have + prod - population
net >= 0 : put net back (capped by capacity; message 109 on overflow)
net <  0 : shortage = (-net)*20/pop -> table $B23C -> $144B4 ; morale += (shortage+1) * -100
```
### 5.5 Housing (`$9DBA`): capacity = T[7].C ($1326C) * 50. Over capacity sets $144C4, penalty, message 99. [V]

### 5.6 Events (`$10E1E`, daily) [V structure]
One event per day cycling k=0..19 ($144BF). Chance bytes at $13118+k (4,40,100,100,1,0,1,3,1,100,3,3,1,100,1,100,20,1,3,100);
roll `$2DCA` in [0,100) against it. Jump table $10E58 (6 bytes per entry): 0 Earth offers colonists (pop/4 at 100 Gr each);
1 alien object appears; 2 invention announcement; 3 `$12A16`; 4 mine collapse; 5 none; 6 power storage accident;
7 trading computer failure; 8 meteor; 9 `$11724`; 10 Earth requisitions scientists (fine = funds/rand(2..9));
11 Earth requisitions tanks; 12 ship explosion; 13 intelligence step (`$ADA6`); 14 eclipse; 15 fuel beaming to ships;
16 strike; 17 tank out of control; 18 virus; 19 crime messages. [handler purposes V, details H]

### 5.7 Production (`$A360`, monthly) [V mechanics, H good names]
- pool 5 (T[23]) staff (if $144C8 < 3): +staff units of good 4.
- pool 0 (T[14]) staff (if $144C8 < 8): consumes up to that many units of good 1, produces the consumed amount of good 3.
- pool 2 (mines), if $144C8 < 12: each worker has 1% chance (RNG==0) to yield one unit of good 2 (weight 1); then ore =
  `$A4A8(workers=$143F2, tile=$60, count=$133C2)` into good 1.
- pool 1 (T[15] refinery type), if $144C8 < 11: `$A4A8(tile=$3E)` = fuel, stored by `$A51A` into the two tank types
  (T[16] capacity 800 each, T[17] capacity 1200 each; message 110 if full).
- `$A4A8`: reads byte +6 of each building of that tile, sorts descending, each building covers 10 workers, sums per-worker
  value, returns sum/2. [V]
- then `$A620` (tank yard progress) and `$AC04` (ship yard progress).
Good weights in kg ($B0EC): idx0 100, idx1 200, idx2 1, idx3 2000, idx4 1000. [V]
`$A2DE(d0 units, d1 good)` adds to stock capped by capacity; `$A32C` removes (capped by stock). [V]

### 5.8 Alien intelligence (`$AF12`, daily; every 10th call) [V mechanics]
Record at $13456: word +$14 incremented; level +$11 = min(5, age/100+1); on level change strength +$18 moves by
+$1B/-$1C within [+$10, +$1E]. If $144CA (intel level) nonzero, a roll against table[$144CA-1] triggers a message (157) and an
intel event. `$B018`: countdown $141B2 with two probability tables. `$127A0` weekly: enemy/funds code touching $1446A (H).

### 5.9 Power (`$A0D4`) [V]
Output = T[11].C*T[11].E + T[12].C*T[12].E (20, 40) (0 when $144BB eclipse) + T[31].C*T[31].E (500).
Use = sum over the 21 pointers at $B100 of (type +5 byte)*(+$C count). Types that cannot be powered counted into $144C8.
Storage clamped to T[0].C*$1310C. At $144C8 >= 14 the Command Centre record (tile $4C) byte +3 is cleared (offline, drawn as
tile $50, message 300, `$A1B0`); when $144C8 < 14, +$C==0 and +$A != 0, `$9B52` sets it back to $FF and sets T[29].C = 1. [V]

### 5.10 Statistics, tax, grants (`$A010`, `$A096`) [V]
Monthly: income = pop * $144F4; plus grant $135BE if nonzero, then $135BE -= 100 (message 101 at 0); money += income;
spend counter -> $135B6. Yearly: tax $144F4 = $144F8; if the new rate exceeded the old, `$A246((new-old)*300)` is applied.
NOTE: the sign looks inverted for a tax rise (morale rises); possibly an original quirk. [V code, H intent]

### 5.11 Morale (`$A246`, `$A270`) [V]
`$A246(d0)`: `m = signedLong($144EC)`; `f = signedWord(100 - trunc(abs(m)/100))`; `delta = trunc(signedWord(d0) * f / 100)`; `$144EC = m + delta` (long addition). The equations assume both `DIVS.W` quotients fit signed words; extreme values take the 68000 division-overflow path. Divisions truncate toward zero. There is no clamp; the signed-word factor can reach zero near +/-10000 and reverse sign outside that region. This is not a proven global bound on morale. See `original-rng-callers.md` section 6.3 for the RNG implications.
`$A270` monthly: sports T[32].C: min(count,5)*100; grant/10 if $135BE != 0; -500 if Command Centre count 0; tax table $B178[rate]
(rate 0..20: +500 step -50, 0 at 10 and 11, then -50..-450); virus $144B7 * -100; if m < 0, m += 1.

### 5.12 Quality of life (`$A8E8`) [V]
```
d6 = 0
crime: if crime<0 d6+=200 else d6 -= min(6, crime*100/8)
d6 += min(pop,10000)/5
units = tanks + ships + counts at $13248,$1325A,$1327E,$13290 (T[5]/T[6]/T[8]/T[9] +$C) ; d6 += 10*units (or +2000 if $156AA bit2)
d6 += table $B1A2[$144F4] (1000 .. -450)
+300 if invention bit 16 ; -300 if $144B8 ; -350 if Command Centre count 0 ; + min(sports,5)*100
-400 each: $144C4, $144B4, $144B5 ; (the $144C8 case adds to a6, an original bug) 
pollution weight sum d5 = min(50, mines + 3*T[15].C + 3*T[31].C + 2*T[30].C + 2*T[23].C + T[14].C + 2*T[22].C + 2*T[27].C)
d6 -= d5 * $144F0
QoL = (d6 / 100) + 55, max 98, -30 if strike, min 10
```
Every 150 of $142DA reduces $144F0 by 1 (messages at 49, 40, 30, 20). First time QoL >= 80 (bit4) or >= 90 (bit5): message via `$E770`.

### 5.13 Research (`$AB0C`) [V static cross-check 2026-11-10]
Tech level $14592 from $145A3 via table $12D56; thresholds $B154; invention bits $14476 from table $B214; message 239 if no
Command Centre.

### 5.14 Crime (`$10BC8`) writes $142CE and $144C6. [V, static formula cross-check 2026-11-10: `crimeMonthly()` matches the disassembly, including the signed percent caps]
### 5.15 Game over (`$B086`, daily) [V]
Lose if $142C2 == 0, or (T[7].C==0 and pop < 60), or (T[7].C != 0 and pop < 30). Sets $156AA bit3.
Static trace (2026-11-10): the loss calls `$E770` (id 1), sets bit 3 at `$B0B6`, then `jmp $157AE` (the disk menu, not a return to
`$99C4`). The rest of that daily pass is skipped, and the disk menu holds the game with the sim stopped. Details: game-proper.md, "Game over".

### 5.16 Market (`$A802`) [V layout, H semantics]
12 entries of 10 bytes at $1316A: words {value, min, max, step, countdown}. First 6 prices, next 6 supply/demand; random walk
with min/max; supply/demand capacity (pop/100+1)*value capped at $270F.

---

### 5.17 Static cross-check of the monthly economy (2026-11-10, Disk.1 disassembly, no emulator)
Routines compared line by line against `src/game/sim.ts` (static evidence only; no emulator run, no pixel or trace parity claimed):
- Production `$A360` (workshop `$143FE` -> good 4 when `$144C8` < 3; pool 0 consumes good 1 into good 3 when < 8; mines pool 2 at < 12 with the 1 % roll per worker, ore via `$A4A8` tile `$60`; fuel pool 1 at < 11, tile `$3E`), `$A4A8` richness sum, `$A2DE` add and `$A32C` remove (capacity overflow adds the leftover kilograms and the units that fit).
- Tank yard `$A620` (power < 10, `$133F8` gate with message `$B3`, per-yard share, counter byte +6 thresholds 20 and `$FF`, messages `$96`/`$94`/`$95`, eight-neighbour exit order, `$37CA` spawn with `$1429C` limit 99, tank count `$14254/$14258` per type). Matches. The per-type counter (`$14254` for type 9, `$14258` for type 10, `addq.l` at `$3856`) is in the unit-fill routine `$381E`, which falls through into `$3840` and is reached on the spawn path via `$380E` (static).
- Jobs `$9F36`/`$9F4A` (a fifth of free colonists plus one, per-pool required = count x 10, x 20 for pool 6, excess released, proportional fill; the `movem.l $18(a2)` copy writes medics, scientists and security to `$1313E/$13142/$13146`). Matches.
- Construction completion `$703A`, `$75D4` flag count (centre plus eight neighbours; bit 15 for mines, bit 11 for fuel) and the warehouse capacity step `+80000`. Matches. Demolition is in `building.md` (a cleared-tile fix was made here).
- Earth offers: colonists `$110FE` (population / 4 at 100 Gr, not overcrowded, price below money), scientists `$111A6` (count max(scientists/4, 5), gate on the LOW BYTE `cmpi.b #$F`), tanks `$11280` (above 10 tanks, count `roll(9)+1`, fine = money / `roll(8)+2` made even, capped at 999,999 = `$F423F`). Match, including the signed-byte gate.
- Air `$9CDA` storage (type A caps at `$13104` per building, the surplus goes to type B capped by `$13106` with the count test). Matches.

**16-bit operand semantics (reproduced in code; reachability not evaluated).** `$A2DE`/`$A32C`/`$9C80`/`$9F4A`/`$10BC8` use `mulu.w`/`divu.w` on low words (for example `mulu.w d3,d2` on the units count, `divu.w d7,d2` on the total shortage, `mulu.w d2,d7` on free colonists), so quantities at or above 65536 are truncated in the original. The remake's `mulu`, `divuQ` and `divuReg` helpers (`src/game/sim-math.ts`) reproduce that truncation and the divide-overflow rule (the register keeps its old value), and `$A2DE`, `$A32C`, the `$9C80` death percentage and the `$9F4A` job requirement use them (checked by reading `src/game/sim.ts`, 2026-11-10; `$10BC8` was not re-checked). Earlier text here said the remake used 32-bit arithmetic; that was stale. `test/goods-capacity.mjs` covers the `$A2DE` overflow arithmetic and the two November endpoints; no test forces a quantity at or above 65536.

**`$A2DE` capacity overflow (static disassembly, 2026-11-10; port `Sim.addGoods`).** `d2 = units x weight`; if `stored + d2 > capacity` (signed compare), `d2 = capacity - stored` and `d0 = d2 / weight` (divu low word), then the stored weight gains `d2` (so it reaches the capacity exactly) and the stock gains `d0`; `d1 = $FF` marks the overflow. The stored weight therefore keeps `d2 mod weight` kilograms that no stock holds. If the leftover is below the stored weight (capacity below stored weight, for example after a warehouse is destroyed), `divu.w` overflows and keeps the negative leftover, `ext.l` gives a negative unit count, and the stock can go negative (static, `$A30E`-`$A324`; original behaviour, not clamped). `$A360` tests `d1` after the workshop, pool 0, good 2 and ore adds and jumps to `$A44C` (message `$6C`) for the first three, skipping the later goods steps; the ore add posts `$6C` and falls through. `$9E98` (food) posts `$6D` on overflow and continues.

## 6. Per-frame routines (no simulation unless stated)
`$6936` tile animation in the viewport (ids 1-3 cycle, 6-13 cycle); `$6540` animation blit; `$4D48` money display;
`$4D1C` date + day-tick; `$4D96` QoL display (title flag bit 5 of $1581, flipped once per main-loop pass; game-text.md section 8); `$5D30` four blinking UI items ($15628, 16-byte stride);
`$3310` eight markers ($14540, 10 bytes); `$16012` bitmap prep; `$333A` unit loop (sub-tick $144C9 0..8, own units move
every 9th frame at count 8, enemy ground at count 4), sprite list at $2954A. [V]

---

## 7. Objects

### 7.1 Type table T[i] at $131E2 + 18*i (34 entries, i = 0..33) [V]
Bytes: +0 =0 (1 on the five special entries), +1 = 1 (4 on specials), +2 build time in weeks (2..10), +3 = $FF (0 for CC),
+4 colonists needed to build, +5 power use per building, +6 word build cost Gr, +8 word tile id, +$A word count built-active,
+$C word count total, +$E word output / stored value, +$10 word name string index.

| i | tile | cost | build wk | +4 | +5 | note |
|---|---|---|---|---|---|---|
| 0 | 1 | 3000 | 4 | 20 | 0 | power storage ($1310C each) |
| 1 | 4 | 5000 | 8 | 20 | 10 | job pool 7, scientists |
| 2,3 | 6,10 | 2500 | 4 | 20 | 8 | sensor-type |
| 4 | 14 | 8500 | 8 | 30 | 20 | job pool 6, medics |
| 5,6 | 31,15 | 5000 | 4 | 15 | 50 | tiles $1F/$0F with variants; +6 random |
| 7 | 47 | 2000 | 6 | 20 | 5 | housing, 50 people |
| 8,9 | 48,49 | 3000 | 6 | 20 | 0 | |
| 10 | 50 | 0 | | | | construction-site placeholder (tile $32) |
| 11,12 | 51,52 | 800 | 2 | 10 | 0 | solar, +E 20/40 |
| 13 | 53 | 8000 | 8 | 30 | 25 | |
| 14 | 61 | 6000 | 6 | 20 | 10 | job pool 0 |
| 15 | 62 | 8200 | 8 | 20 | 15 | fuel production (tile $3E), pool 1 |
| 16,17 | 63,64 | 3000 | 4 | 20 | 2,3 | fuel tanks 800/1200 |
| 18,19 | 65,66 | 2500 | 4 | 20 | 5 | farms (10 workers each) |
| 20 | 67 | 4000 | 4 | 20 | 5 | job pool 8 |
| 21 | 68 | 2000 | 4 | 20 | 2 | warehouse, +80000 capacity |
| 22 | 69 | 6000 | 6 | 20 | 10 | tank yard, pool 4 |
| 23 | 70 | 2800 | 6 | 20 | 10 | workshop, pool 5 |
| 24 | 60 | 3000 | 6 | 30 | 15 | air plant B |
| 25 | 71 | 6200 | 8 | 30 | 8 | |
| 26 | 96 | 5000 | 6 | 20 | 15 | mine, pool 2 |
| 27 | 54 | 6000 | 8 | 30 | 10 | ship yard, pool 3 |
| 28 | 72 | 3000 | 4 | 0 | 0 | launchpad (placed via `$771E`) |
| 29 | 76 | 9000 | 6 | 40 | 25 | command centre ($4C on, $50 off) |
| 30 | 84 | 7000 | 8 | 30 | 20 | air plant A |
| 31 | 88 | 10000 | 10 | 40 | 0 | power station, +E 500 |
| 32 | 92 | 6000 | 8 | 40 | 12 | sports complex |
| 33 | 97 | 1500 | | | | terminator |

### 7.2 Object records ($3B466, 8 bytes, 1000 slots) [V]
+0 word tile id (0 = free slot); +2 byte copy of T +1 (or target-tile low part during construction); +3 byte
active flag ($FF active, 0 offline, from T +3); +4 x; +5 y; +6 byte state counter; +7 byte.
Occupancy is by tile word only (0 = free). `$142C2` counts used records, and several routines use it as a budget over non-empty records rather than as a physical slot index: `$72C0` scans the object array in slot order and stops after examining that many occupied records. Thus a sparse record above that counted prefix can be invisible to coordinate-based building lookup even when its tile word is nonzero. Ordinary placement allocates the first free slot; demolition frees records in place. Disk.4 restore (`World.fromSnapshot`) preserves every saved physical slot, including sparse or inconsistent states.
Construction site: word $32, word +2 = target tile, +4/+5 = x,y, +6 = weeks remaining (from T +2), decremented by `$7000` weekly;
at 0 `$703A` converts to the real building, returns the construction colonists, increments T +$A and +$C.
Mine (tile $60) +6 = count of the 3x3 neighbouring cells with flag $8000 (richness 0..9); fuel type (tile $3E) +6 = count of
cells with flag $0800; solar tiles $0F/$1F set +6 to 1 when `$2E00` reads `$DFF006` bit 0 as set, otherwise `$FF` (static
trace `$6E3A-$6E56`). This phase byte is unrelated to x, which remains at +4; exact raster parity in a live startup is unverified.
Placing: check funds, take T+4 colonists from free (`$6BF4`, `$6C92`), subtract cost T+6 from money, add to $142CA.
Demolish (`$7372`): construction sites removable; ground clearing tiles $61, $94-$9B, $38 ($9E result); others msg 88;
stored-type buildings reduce +E proportionally; farm tiles $41/$42 return 10 workers; warehouse tile $44 reduces stocks and
capacity.

### 7.3 Tile id to type (`$6D78` builder, `$6BE0` lookup, `$77C8` multi-tile table)
Lookup `$6BE0`: search T by +8 == tile. Map pass: for each cell (low 10 bits): `$7F` = marker (stored at $14524 up to 10);
tiles $48-$5F: table $77C8 (4 bytes per tile {base tile, offset flag}); origin cell only (offset 0) creates a record,
other cells of the 2x2 group are skipped; tiles $0..$3 -> type tile 1, 4-5 -> 4, 6-9 -> 6, 10-13 -> 10, 14 -> 14,
$0F-$1E -> 15, $1F-$2E -> 31, $2F.. -> as is up to $61 (excluding $38, >= $62 ignored); $60 and $61 handled directly.
Each created record increments T+$A, T+$C and $142C2; CC tile gets +3=$FF; warehouse tile adds $13880 to capacity.

---

## 8. F-key screens (summary)
- F1 `$B81C`: colony administrator: births/deaths, density = pop*100/(housing*50), seven category counts, morale text from
  $144EC (sign and |m|/100 vs 50), crime text from $142CE (<0, <=20, <=50, else). [V]
- F2 `$BA1E`: finance report: $1433A, $1434E, $14362, $1437E columns. [V data, H labels]
- F3 `$BD9E`: budget: tax $144FC, $142E2, $135B6, $14302, $14312, grant $135BE, $142EE. [H]
- F4 `$C516`: unit/tank status (tank count $1429C, tech level, `$C5BE`). [H]
- F5 `$D6BA`: research (scientists $13142, funds $142D2/$142D6/$142DE, invention bits $14472, selected item $1447A). [H]
- F6 `$E1AA`: defence/intel (arrays $14254, $14274, $14294; $144CA; transfer of money to $1446A). [H]
Icon routines at `$6BA2, $F176, $15ECA, $30FE, $CC8E/$D0D8 (trade, writes $144F8, retain %), $15CFE, $BAAE, $E2D2, $7E52/$15EF0`
are UI handlers on the same state; only `$CC8E`/`$D0D8` (trade) and `$6BA2` (build selection into $142B2/$142B6) were traced. [H]

---

## 9. Save format (Disk.4)
Record +$10 = area A, 73 sectors (37376 bytes) at $39E3A: entity lists, object records, flag map, map rows
(through $42E19 including the final row's two pad words, with slack to $4303A). Record +$14 = area B, 11 sectors ($1600 bytes) = $13034..$14633, i.e. the
scenario block followed by the variable block verbatim. [V extents, H slack]
The original load handler `$87DC` mode 2 copies the saved word `$1453E` into the disk-check request at `$8D00`; `$8A5A` compares it with the supplied scenario disk's header word at `+8`. It then reads `$135C2` as the scenario index and selects `$8F96 + index*$40` (`$888A-$88AA`). The supplied Disk.2 scenario blocks store their own index at offset `$58E`, which loads at `$135C2`. The loader writes `$8F96 + index*$40` to `$1453A` before loading selected scenario resources; this pointer is inside area B and changes the runtime state copy, not the input file. These are static Disk.1/Disk.2 findings. The remake activation uses the saved values as authoritative; map matching is advisory only when the saved index is invalid.
Observation 2026-11-06 (Copperline, memory read after a UI "SAVE COMPLETE", slot 0 `REFRUN`): header record extents A 0-72, B 74-84; area A/B bytes captured from `$39E3A`/`$13034`. Object count word read 20, other entity counts 0. One capture only, not a persisted Disk.4; see [game-proper.md](game-proper.md) section 6.
Status: `src/data/disk4-entities.ts` reads the section 3.8 lists from a decoded save as fixed slot arrays (raw bytes plus the documented fields only; read-only, synthetic tests, not wired). It records two static findings: the `+$14` long of every ship-list record is the per-cell flag-byte pointer (`$387E`/`$49E8` -> `$497E`, VERIFIED statically; later updates untraced), and a type 17 record has a 24-bit enemy-record address in `+$D..+$F` (no class/fuel; building-screens.md 3.6). Details in game-proper.md.

---

## 10. Unknowns
Exact meaning of many $1423x/$143xx statistic slots, the F3-F6 detailed fields, crime formula, research thresholds use,
market exact algorithm, scenario-specific tables ($13456+, $13658+), $127A0, and fine unit-AI behaviour ($333A callees).
