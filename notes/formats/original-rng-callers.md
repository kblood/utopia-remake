# Original RNG callers - static call-site audit (Disk.1, 62 direct sites)

Status: evidence gathering only (2026-11-07). This note does not claim RNG integration. It does not change what `Sim.roll()` does, and no runtime code, test, save field or capture was touched. It refines the "Static caller-setup audit" paragraph of [sim-port.md](sim-port.md) ("Original RNG routine model"), which was a predecessor-window heuristic; where the two differ, this note is the per-site record.

Everything below is a STATIC trace of the user's WHDLoad 1.2 (0757) `Disk.1` game image (sectors `$14C-$208`, loaded address = file offset - `$28800`). Nothing here is dynamic evidence except the seven sites already named in sim-port.md as captured in the November tape (`$9BCC`, `$9CB0`, `$A3F8`, `$A7BA`, `$A7CC`, `$A84E`, `$10BE8`).

## 1. Inventory validation

`python tools/rng_call_sites.py` (read-only; default path `original/utopia-whdload/Disk.1`) prints `JSR abs.l $2DCA: 44 site(s)`, `JSR abs.l $2DCC: 18 site(s)`, `total: 62`. This matches the 44 + 18 = 62 stated in sim-port.md. Cross-checks done in this pass (scratch scripts kept outside the repository, nothing written to it):

- An independent byte scan of the same sector range for `4EB9 <target>` found the same 44 and 18 addresses (both at even offsets only).
- No other direct form exists in the range: no `jsr/jmp abs.w`, no `jsr/jmp d16(pc)`, no `bsr/bra/Bcc` to `$2DCA`/`$2DCC`, and no 32-bit literal `$00002DCA`/`$00002DCC` other than the operands of those same 62 `jsr` instructions (so no pointer table to the routine). Indirect calls (`jsr (An)`, computed jumps) were not enumerated; the one computed dispatch that reaches RNG callers, `$10E58`, is traced in section 4.
- `$2DCA` is `moveq #100,d2` immediately followed by `$2DCC` (see `src/game/original-rng.ts`), so a `$2DCA` call differs from a `$2DCC` call only in D2.
- The predecessor claim that 13 of the 18 `$2DCC` calls load D2 with `moveq` is confirmed (`$A7BA`, `$10BE8`, `$10CB8`, `$10EF2`, `$10F0A`, `$10FA2`, `$1106C`, `$111F4`, `$1129C`, `$112D2`, `$117F6`, `$1182E`, `$128AE`); the other five derive D2 from memory/arithmetic (`$9BCC`, `$A7CC`, `$110A2`, `$11484`, `$11A74`).

Files read for this note: `AGENTS.md`, `notes/formats/sim-port.md`, `tools/rng_call_sites.py`, `tools/game_dis.py` (capstone M68K-020 linear decode), `original/utopia-whdload/Disk.1` (read-only), `src/game/sim.ts`, `src/game/sim-aliens.ts`, `src/game/sim-ships.ts`, `src/game/enemies.ts`, `src/game/original-rng.ts`. Files written: this note and the caller-audit paragraph of `sim-port.md`. TypeScript line numbers below are for the current, uncommitted working tree and will drift.

## 2. What actually matters in D0

From the verified `$2DCC` body (`$2DD0`: `move.b $BFE801,d0`; `$2DD6`: `mulu.w #13,d0`): the caller's D0 bits 0..7 are overwritten by the CIA TOD low byte, bits 16..31 are discarded by the word multiply, and D0 is restored on return. So **only the caller's D0 bits 8..15 ("byte 1") influence the result** (together with TOD and the seed); the low byte of D0 and the upper word do not. Every row below therefore records byte 1; the full D0 is given only where it explains byte 1.

## 3. Method, vocabulary, premises

Method: for each site, linear disassembly of the enclosing routine, a byte-pattern scan of direct callers of that routine (`bsr/jsr/jmp/bra/Bcc`), a scan of absolute-long references to each state cell involved, and, where D0 comes out of a callee, a trace of that callee's exits. Tracing stops where the D0 value depends on game data; it is then reported as a formula plus the state it depends on.

Classes:

- **CLOSED**: all traced paths give a single value or a small finite set for D0 byte 1, under the premises listed here.
- **FORMULA**: control flow and the D0 expression are traced; the value of byte 1 depends on named state whose range is not established statically.
- **UNRESOLVED**: at least one entry path or callee exit leaves D0 byte 1 untraced.

Premises (each one is a way a CLOSED row could still be wrong):

- **P1 dispatch**: the 16 rows closed by the normal event-handler context use the bound from ordinary new-game play: dispatcher index 0..27, with only indices 0..19 dispatching because indices 20..27 have zero chance. This follows the daily increment, 28-day month rollover and post-daily monthly reset described in section 4. Arbitrary imported or hand-edited `$144BF` values remain outside this bound.
- **P2 `$144CA`**: for ordinary fresh-game play, the `ext.w; subq.b #1` rows (family E) rely on the writer invariant `$144CA` ∈ 0..4. `$866E` clears it as part of `$14234..$144CB`; each supplied scenario block is nine sectors loaded only through `$14233`, so it cannot overwrite `$144CA`; routine `$AD70` stores 0..3 at `$AD9E` from its `$1446A` thresholds; `$12890` stores 4. Family-E paths branch away at 0, so every reached draw has level 1..4 and D0 byte 1 = 0. This does not cover arbitrary imported Disk.4 bytes or hand-edited native saves.
- **P3**: no state-image load, scenario load or save-restore write was enumerated for any cell; "image default" values quoted below are the bytes in `Disk.1` before any scenario load.
- **P4**: decode is linear capstone plus direct-reference scans; data embedded in code was recognised by inspection only.

## 4. Event dispatcher `$10E1E` (42 of the 62 sites are reachable only through it; `$11A74` partly)

`$10E1E` is called from `$9A4E` and returns at once when bit 7 of `$156AA` is set. Otherwise it reads `k = $144BF`, loads `d3 = $13118[k]`, skips a zero chance, and for nonzero chance calls `jsr (a1,d0.l)` with `d0 = 6*k` into the 20-entry `jmp.l` table at `$10E58`; `$10E50` increments `$144BF` after either path. The monthly branch in `$99C4` runs after the daily branch and clears `$144BF` at `$9ACC`. `$564A` rolls the day to 1 when the counter reaches `$1D`, so a month contains 28 daily passes. After the day-1 monthly reset, days 2..28 consume indices 0..26; the following day-1 pass consumes index 27 before resetting. Fresh initialization clears `$144BF`, and the first queued day also follows the daily-then-monthly order. Thus ordinary new-game play reaches at most k=27; Tutorial mode returns before the read/increment. The Disk.1 chance table bytes at indices 20..27 are all zero, so the only ordinary calls to the dispatch table use k=0..19 and enter with D0=6k (byte 1 = 0). The index is still a byte and an arbitrary imported/hand-edited value is not bounded by this proof.

All 20 absolute-long handler addresses occur once in the loaded game image, in `$10E58..$10ECF`; `$11280` has one additional raw match at `$16B4` that is part of another instruction and is not a pointer. The reachable direct-branch scan from `$156B6` found no other code entry to these handlers; the computed call in `$10E4C` is the event table dispatch. This is a static entry audit, not proof against every possible computed pointer. In the recursively decoded path, the other indirect `jsr/jmp` instructions are the music command table and two callback calls; no handler address occurs in the image outside the event table apart from the false `$16B4` byte pattern.

| k | handler | D0 (6k) | RNG sites reached |
|---|---------|---------|-------------------|
| 0 | `$110FE` | `$00` | `$110FE` |
| 1 | `$1146A` | `$06` | `$1146A`, `$11484` |
| 2 | `$1135A` | `$0C` | none |
| 3 | `$12A16` | `$12` | `$12A58` (D0 reloaded, family E) |
| 4 | `$11090` | `$18` | `$11090`, `$110A2` |
| 5 | `$10ED0` | `$1E` | none (`rts`) |
| 6 | `$10F5E` | `$24` | `$10F68` |
| 7 | `$10F8E` | `$2A` | `$10F96`, `$10FA2` |
| 8 | `$1160E` | `$30` | `$1161A` (D0 reloaded `$142A6`), `$11A74` via `$1163E` |
| 9 | `$11724` | `$36` | `$11762`, `$11786`, `$117F6`, `$1182E`; `$B056` via `$B018` |
| 10 | `$111A6` | `$3C` | `$111A6`, `$111F4` |
| 11 | `$11280` | `$42` | `$11280`, `$1129C`, `$112D2` |
| 12 | `$113A6` | `$48` | `$113A6` |
| 13 | `$ADA6` | `$4E` | `$AE20`, `$AE5E`, `$AE7C`, `$AE9A`, `$AEB6`, `$AECA`, `$AEDE` (D0 reloaded, family E) |
| 14 | `$11058` | `$54` | `$11060`, `$1106C` |
| 15 | `$114AC` | `$5A` | none |
| 16 | `$113FA` | `$60` | `$11414` (D0 := `$0000011E`) |
| 17 | `$11566` | `$66` | `$11566` |
| 18 | `$10ED2` | `$6C` | `$10EE6`, `$10EF2`, `$10F0A` (D0 reloaded `$14472`), `$10F36` (D0 still `$6C`) |
| 19 | `$10C72` | `$72` | `$10CB8`, `$10D1C`, `$10D38`, `$11A74` via `$10D48`, `$10DAC`, `$10DC8`, `$10DE6` (D0 reloaded, section 6) |

Other (non-dispatched) enclosing routines and their single direct callers: births `$9BAE` (`$9B48`), deaths `$9C80` (`$9C62`, `$10CEC`), production `$A360` (`$9BA4`), market `$A802` (`$9B24`) with walk step `$A7AE` (`$A80A`), daily intel `$AF12` (`$9A52`), countdown `$B018` (`$1172E`), weekly battle `$127A0` (`$9A74`), crime `$10BC8` (`$9BA0`), enemy object update `$1193E` (`$34C6`) and `$11A9E` (`$351C`), building attack `$1266A` (`$11956`, `$11ABE`, `$11ADA`).

## 5. Site table (all 62)

`Tgt`: A = `$2DCA` (D2 = 100), C = `$2DCC`. "D2" lists the range only for C. Byte 1 = D0 bits 8..15 at the call. Family E = `move.b $144CA,d0; ext.w d0; subq.b #1,d0` (section 6.1): on ordinary fresh-game paths the reached draw has byte 1 = 0 and D0.w in 0..3 (P2's writer invariant). "TS" = the matching `Sim.roll()` draw (section 7).

| Call | Tgt | D2 (C only) | D0 / byte 1 at the call | Class | TS |
|------|-----|-------------|--------------------------|-------|----|
| `$9BCC` | C | `$145A2` byte (zero skips: `$9BB6`) | `moveq #0` then 0 / `$1E` / `$3C` (`$9BBA-$9BCA`); byte 1 = 0 | CLOSED | sim.ts:1132 |
| `$9CB0` | A | | `moveq #8` (`$9C9C`) with `dbra` (`$9CCC`), untouched in the body: 0..8; byte 1 = 0 | CLOSED | sim.ts:1173 |
| `$A3F8` | A | | `$143F2` long (mine count), low word -1 (`$A3EC-$A3F4`), `dbra` (`$A404`): count-1..0; byte 1 = 0 iff count <= 256; see 6.8 | FORMULA | sim.ts:1452 |
| `$A7BA` | C | 4 | `movem.w (a0),d0-d4` (`$A7AE`): current market value, signed word; scenario-block bounds keep it 0..300, so byte 1 = 0 or 1 | CLOSED (Disk.2 table bounds) | sim.ts:1547 |
| `$A7CC` | C | word `d5-d1` (max - min) | same current value as at `$A7BA`; `$2DCC` restores D0 and the update/clamp follows this second draw, so byte 1 = 0 or 1. **Runs only when the `$A7BA` result is nonzero** (`$A7C0` `tst.b d2` / `beq $A800`; section 6.4) | CLOSED (Disk.2 table bounds) | sim.ts:1632 |
| `$A84E` | A | | `moveq #5` (`$A814`), `dbra` (`$A864`), untouched: 5..0; byte 1 = 0 | CLOSED | sim.ts:1584 |
| `$AE20` | A | | family E | CLOSED (ordinary-play invariant) | sim-aliens.ts:439 (stage 0) |
| `$AE5E` | A | | family E (via `bmi $AE52`, D0 unchanged) | CLOSED (ordinary-play invariant) | :439 (stage 1) |
| `$AE7C` | A | | family E | CLOSED (ordinary-play invariant) | :439 (stage 2) |
| `$AE9A` | A | | family E | CLOSED (ordinary-play invariant) | :439 (stage 3) |
| `$AEB6` | A | | family E | CLOSED (ordinary-play invariant) | sim-aliens.ts:439 (new fifth one-shot stage) |
| `$AECA` | A | | family E | CLOSED (ordinary-play invariant) | :445 |
| `$AEDE` | A | | family E | CLOSED (ordinary-play invariant) | :447 |
| `$AF8E` | A | | family E (`$AF84-$AF86`) | CLOSED (ordinary-play invariant) | :486 |
| `$AFE2` | A | | family E (`$AFCE-$AFD0`) | CLOSED (ordinary-play invariant) | :480 |
| `$B056` | A | | family E (`$B052-$B054`) | CLOSED (ordinary-play invariant) | :255 |
| `$10BE8` | C | `$14` | `$144EC` (long) -> `q = trunc(x/100)` (sign handled), `d0 = (q+100) >> 1` (`asr.l`), fully inside `$10BC8` (no caller dependence). `$2DCC` uses only byte 1 of this D0. Byte 1 = 0 iff `$144EC` is in -10099..41199 (section 10, D3); see 6.3 | FORMULA (byte-1 bound on `$144EC` open; observed 0 at row 32) | sim.ts:1423 |
| `$10CB8` | C | 6 | `$142CE` long (>= 0, `$10C72`), preserved by the `push/pop` in `$10CB4`; see 6.3 | FORMULA | sim.ts:862 |
| `$10D1C` | A | | `$14472` long, bit 3 clear (`$10D08-$10D12`); see 6.2 | FORMULA | sim.ts:897 |
| `$10D38` | A | | same (preserved across `$10D1C`) | FORMULA | sim.ts:901 |
| `$10DAC` | A | | `$142CE` long; reached only if its low byte, read as signed, is > `$3C` (`$10C9A`) | FORMULA | sim.ts:918 |
| `$10DC8` | A | | same | FORMULA | sim.ts:922 |
| `$10DE6` | A | | same | FORMULA | sim.ts:933 |
| `$10EE6` | A | | `$14472` long, bit 16 clear (`$10EDA-$10EE4`) | FORMULA | sim.ts:826 |
| `$10EF2` | C | 9 | same | FORMULA | sim.ts:827 |
| `$10F0A` | C | 5 | same | FORMULA | sim.ts:830 |
| `$10F36` | A | | `$6C` (k = 18; `$10F24` only reachable from `$10ED8`; D0 untouched); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:838 |
| `$10F68` | A | | `$24` (k = 6); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:756 |
| `$10F96` | A | | `$2A` (k = 7); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:766 |
| `$10FA2` | C | 4 | `$2A` (k = 7); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:767 |
| `$11060` | A | | `$54` (k = 14); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:802 |
| `$1106C` | C | `$0A` | `$54`; byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:803 |
| `$11090` | A | | `$18` (k = 4, first instruction); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:736 |
| `$110A2` | C | `$133C2` word (zero skips) | `$18`; byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:739 |
| `$110FE` | A | | `$00` (k = 0, first instruction); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:675 |
| `$111A6` | A | | `$3C` (k = 10); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:778 |
| `$111F4` | C | 8 | `0`: `$15C5A` (number-to-text, divisor loop `$3E8`..1) leaves D0 = last remainder = 0 when no `divu` overflows (`d0` here is a small count); independent of entry D0 | CLOSED | sim.ts:783 |
| `$11280` | A | | `$42` (k = 11); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim.ts:712 |
| `$1129C` | C | 9 | `move.w $1429C,d0` on `$42`: zero-extended word, > 10 (`$11292`). The repo notes record a cap of 99 for `$1429C` (units.md, sim-port.md; not re-traced here), so byte 1 = 0 under that cap | FORMULA | sim.ts:714 |
| `$112D2` | C | 8 | `0` (as `$111F4`; `bsr $15C5A` at `$112CC`, `d0` = range+1 <= 10) | CLOSED | sim.ts:715 |
| `$113A6` | A | | `$48` (k = 12); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim-ships.ts:405 |
| `$11414` | A | | `$0000011E`: `move.w #$11E,d0` at `$113FA` on D0 = `$60`; the only way in is the fall-through from `$11408` (`bne` at `$11406` skips to `$1142A`). **Byte 1 = `$01`** | CLOSED (ordinary dispatch bound) | sim.ts:816 |
| `$1146A` | A | | `$06` (k = 1); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim-aliens.ts:128 |
| `$11484` | C | `$144A6` word (zero skips) | Two callers reach it: event 1 (`$06`, the `$1146A` gate first) and the boot exit (`bsr.w $11476` at `$157B8`, which skips the gate). A game-over restart reaches the same call through the same `$157B4` return (game-proper.md, "Restart after game over"; its draw is not captured). The captured first draw is the **boot** call (section 10, D1, resolved). The boot caller's entry D0 is traced statically to `$00000022` (`$15EF0` → `$6B10` → `$6A22` twice; section 10, D1), so byte 1 = 0 on its only path. Event 1 closed as before | CLOSED (boot caller: section 10, D1; event 1 unchanged) | sim-aliens.ts:148 (boot), :138 (event 1) |
| `$11566` | A | | `$66` (k = 17); byte 1 = 0 | CLOSED (ordinary dispatch bound) | sim-aliens.ts:212 |
| `$1161A` | A | | `$142A6` long (`move.l` at `$1160E`; the `cmpi.w #3` gate is on its low word). Direct writer: `addq.l #1` at `$56E8`; image default 0 | FORMULA | sim-aliens.ts:164 |
| `$11762` | A | | after `bsr $B018`; D0 byte 1 = `$FF` only when `$B018` reports successfully while SFX are disabled (`$1581` bit 2 clear); otherwise 0; see 6.5 | FORMULA | sim-aliens.ts:273 |
| `$11786` | A | | family E (`move.b` + `ext.w` make byte 1 independent of the unresolved D0 from `$B018`) | CLOSED (ordinary-play invariant) | sim-aliens.ts:276 |
| `$117F6` | C | `$10` | same conditional D0 byte 1 as `$11762` (reached by `bne.w` at `$11742`); see 6.5 | FORMULA | sim-aliens.ts:298 |
| `$1182E` | C | 8 | `d0 = ((byte $13467 - 1) & $FF) << 6` as a word (`$11816-$1181E`, `moveq #0` first). Writer `$AF52` stores 1..5, image default 1: D0 in {`$00`,`$40`,`$80`,`$C0`,`$100`}; byte 1 = 1 only for 5 | FORMULA | sim-aliens.ts:304 |
| `$11A74` | C | word `min($142C2, $FE)`, `ext.l` | callers: `$10D48` and `$1163E` pass D0 = `$14472` (6.2); `$119AC` enemy-update callers pass byte 1 = 0 in ordinary play because the ground/air loop counts are bounded to 60/30; see 6.6 | FORMULA | sim.ts:946 |
| `$11CB6` | A | | `1`: reached only by `bne` at `$11CAC` after `bsr $11AE6` returned with N=0, Z=0, which only `moveq #1,d0` at `$11C20` produces (other exits: `moveq #-1`, `moveq #0`) | CLOSED | enemies.ts:1158 |
| `$11CF0` | A | | `1` (via `$11CB6`) or `0` (entering `$11CC2` from `$11D1C`); `$710A` saves/restores D0. Byte 1 = 0 | CLOSED | enemies.ts:1179 |
| `$12772` | A | | `moveq #$2F,d0` (`$126A4`) with `dbra` (`$126CC`), untouched in the loop: 47..0; byte 1 = 0 | CLOSED | enemies.ts:948 |
| `$128AE` | C | 4 | `$12822` value, see 6.7 | FORMULA | sim-aliens.ts:561 |
| `$12910` | A | | same D0 (no instruction between `$128AE` and `$12992` writes D0) | FORMULA | sim-aliens.ts:582 (step 3, cost 2) |
| `$12932` | A | | same | FORMULA | :582 (step 4, cost 3) |
| `$12952` | A | | same | FORMULA | :582 (step 5, cost 4) |
| `$12972` | A | | same | FORMULA | :582 (step 6, cost 3) |
| `$12992` | A | | same | FORMULA | :582 (step 7, cost 1) |
| `$129E6` | A | | family E (`$129CE-$129D8`) | CLOSED (ordinary-play invariant) | sim-aliens.ts:603 |
| `$12A58` | A | | family E (`$12A4C-$12A56`) | CLOSED (ordinary-play invariant) | sim-aliens.ts:509 |

Tally: 62 rows (44 A, 18 C). CLOSED 39 (16 rely on the ordinary-play dispatcher bound above; the 13 family-E rows rely on the ordinary-play `$144CA` invariant; `$A7BA/$A7CC` rely on the supported Disk.2 market bounds), FORMULA 23, UNRESOLVED 0. CLOSED byte 1 is 0 at 36 sites, `$01` at `$11414`, and `$00/$01` at the two market sites. The seven sites captured in the November tape are `$9BCC`, `$9CB0`, `$A3F8`, `$A7BA`, `$A7CC`, `$A84E`, `$10BE8`; the capture has byte 1 = 0 at all of them, consistent with these bounds and the per-capture values.

Seven of these sites (`$B056`, `$11762`, `$11786`, `$117F6`, `$1182E`, `$11A74`, `$12772`), plus the `$BFE801` read at `$12694` and the `$2E00` call at `$11842`, are the bound labels of the invasion capture comparator (`test/invasion-capture-contract.mjs`, [runtime-checkpoints.md](runtime-checkpoints.md) section 7); their instruction bytes and return addresses (`ret` = call + 6) were re-read from Disk.1 and are checked against it at comparator start. This is a static binding, not an observation.

The sixteen further direct sites that the RAM-staged Copperline invasion capture `live-8` actually exercises (`$9BCC`, `$A7BA`, `$A7CC`, `$A84E`, `$10BE8`, `$10EE6`, `$10F68`, `$10F96`, `$11060`, `$11090`, `$110FE`, `$111A6`, `$11280`, `$113A6`, `$1146A`, `$11566`) are bound the same way, each to its remake function (the TS column) and to its exact Disk.1 bytes and `ret` = call + 6. Copperline names a call it has no label for `unmapped-<six-digit hex address of the jsr>`; the comparator accepts that name only as the `captureAlias` of exactly one of these audited sites (e.g. `unmapped-0111A6` = `$111A6`, event handler k = 10), resolves it to the descriptive label, and still checks the row's `ret`, range and remake caller. No wildcard exists: any other `unmapped-*` name (unaudited caller) is an unknown-site error. Ranges: `$2DCA` sites 100; `$A7BA` (`moveq #4,d2`) 4 and `$10BE8` (`moveq #20,d2`) 20, both byte-checked against Disk.1; `$9BCC` (byte `$145A2`) and `$A7CC` (word `d5-d1`) carry only an upper bound (255 / 65535), because D2 comes from data. Static binding only, not an observation of the original; the capture's setup is declared RAM-staged.

## 6. Details behind the rows

### 6.1 Family E (13 sites)

`$AE20 $AE5E $AE7C $AE9A $AEB6 $AECA $AEDE $AF8E $AFE2 $B056 $11786 $129E6 $12A58`. Each preceding sequence loads `move.b $144CA,d0`, branches away on zero, then `ext.w d0` (bits 8..15 become the byte's sign) and `subq.b #1,d0`. For ordinary fresh-game play the writer invariant is 0..4: `$866E` clears `$144CA` in its 664-byte zero loop; `$AD70` writes d1 after deriving 0..3 from the `$1446A` thresholds; `$12890` writes 4. Thus the branch-reached values are 1..4, D0.w becomes 0..3 and byte 1 is zero. The old `00 or FF` possibility applied to a predecessor-register guess before accounting for the `ext.w`; it does not apply to this family. This proof is static and bounded to ordinary gameplay; arbitrary imported Disk.4 state or hand-edited native-save bytes are outside it. Within `$ADA6`, no instruction between the `ext.w` and `$AEDE` changes D0 except `bset #7,d0` on paths that leave the routine afterwards.

### 6.2 `$14472` (invention flag long) feeds five sites directly and `$11A74` through two callers

`$10D1C`, `$10D38`, `$10EE6`, `$10EF2`, `$10F0A` and `$11A74` (via `$10D48`, `$1163E`) all see `D0 = $14472` (`move.l` at `$10D08`, `$10EDA`, `$11626`; tests `btst #3` at `$10D0E`, bit 16 at `$10EE0`, bit 8 at `$1162C`). The runtime writer is `$1138A` (event 2, `$1135A`): it scans `$14476` from bit 0 upward, clears the first queued bit at `$11374`, then `bset`s that bit in the existing `$14472` at `$11382-$1138A`. Thus `$14472` accumulates announced inventions; it does not copy or replace the mask. The other writer is fresh-game zeroing at `$866E`. `$14476` is ORed at `$ABCA` from the 10-long table at `$B214`, indexed by the new `$14592` level minus 1 (levels 2..10): `$00000002`, `$000000C1`, `$00014104`, `$00001C00`, `$00002200`, `$00000020`, `$00020008`, `$00008000`, `$00000010` (index 0 is `$00000000`, unused); `$1137C` removes the announced bit from the queue. The union of all nine level entries is `$0003FFFF`, so all eight bits in D0 byte 1 (bits 8..15) can eventually be announced. They first become available at tech level 4 (bits 8 and 14), then levels 5 (bits 10..12), 6 (bits 9 and 13), and 9 (bit 15). A tech-level value alone does not give the current mask because announcements drain one bit every six event-2 calls while research can add more bits; for ordinary gameplay the exact D0 byte 1 is the current `$14472` byte 1. Both state cells start at zero, and the ordinary scenario block ends at `$14233`, so it cannot overwrite them. Imported Disk.4 or hand-edited native-save state is outside this fresh-game writer bound.

### 6.3 `$142CE` and `$144EC`

`$10BC8` (monthly) stores `d1` into `$142CE` (`$10C6A`; direct reads at `$A942`, `$B956`, `$10C72`). `d1 = 100 - ((q+100)>>1) - (rng-10) - ((5-$142A6)<<3 if > 0) - bonus`, with `q = trunc($144EC / 100)` (signed). `$144EC` starts at `$1388` (`$86BA`). `$A246` reads signed long `m=$144EC`, computes the signed-word factor `f = 100 - trunc(abs(m)/100)`, multiplies signed-word `d0` by signed-word `f`, performs signed-word division by 100 with truncation toward zero, sign-extends the quotient and adds it to `m`. These equations assume the `DIVS.W` quotients fit signed words; extreme values instead take the 68000 division-overflow path. The routine has no clamp. This describes a scaled change inside the nominal +/-10000 region, not a proven global bound: repeated large or sign-changing inputs can overshoot, and outside that region the factor changes sign. Ordinary-play bounds on the callers' changes and the resulting morale are not established. `$144EC` is also read as a long at `$11408` against `-3000` (`$FFFFF448`); therefore the upper bound on `$142CE` and the D0 at `$10BE8` remains FORMULA, not a verified small range. For the `$2DCC` draw at `$10BE8` the relevant quantity is narrower (2026-11-13 re-read of `$10BC8`-`$10BE2`): the call replaces only D0's low byte with TOD, so only byte 1 of `d0 = (q+100) >> 1` matters. That byte is 0 exactly when `q` is in -100..411, i.e. `$144EC` in -10099..41199 (no `divu.w` overflow in that range). Section 10, D3 has the details.

### 6.4 Market walk `$A7AE`

`$8B02` loads each selected scenario's nine-sector parameter block to `$13034`; its market table at `$1316A` is offset `$136` into that block. Read-only parsing of all ten local WHDLoad 1.2 (0757) Disk.2 blocks found the same 12 signed-word entries (`value, min, max, step, countdown`): initial values are 1..50, minima are nonnegative (0 or 1), and maxima are at most 300. `$A7AE` loads those words with `movem.w (a0),d0-d4`; its two random calls are at `$A7BA` and `$A7CC`. The second call is conditional (2026-11-13, static disassembly of Disk.1 `$A7AE-$A800`): `$A7BA` is followed by `tst.b d2` / `beq.b $A800` at `$A7C0`, so a first result of 0 skips the second draw and the update (`$A7CC` is not reached). The capture shows this once (section 10, row 18). After each walk it clamps the new value to `[min,max]` at `$A7EC-$A7FA` and writes all five words back, so the next monthly pass remains in bounds. Consequently both call sites see D0 in 0..300 and byte 1 is only `$00` or `$01`; their D2 ranges are 4 and `max-min` respectively. For `$A7CC`, the 12 `max-min` ranges are `19,19,9,290,29,29,100,200,100,4,60,100`. This closes the two ordinary scenario-table rows for the supported local Disk.2 data; it is not a bound for arbitrary modified or other-release tables.

### 6.5 `$B018` exit D0 (rows `$11762`, `$117F6`)

Handler k = 9 enters with D0 = `$36`, calls `$B018`, then continues only if `$141B2` is 0 (`$11732`). That limits the callers `$11762` and `$117F6` to `$B018` entry values 0 or 1: entry 0 returns with D0 = 0, while entry 1 decrements to 0 and may take the report path. With no report, D0 is 0 or the zero-extended `$144CA - 1` value (0..3), so byte 1 is zero.

On the successful report path, `$B06C` sets D0 = `$0157` and calls `$5A8C`. At that entry, `$5A8C` runs its `$5A8C..$5A9E` copy loop; the final `dbra d0` leaves D0 = `$0000FFFF`. `$B078` then loads only the low byte of `$1582` into D0 and calls `$11B4`. If SFX are disabled (`$1581` bit 2 clear), `$11B4` returns immediately at `$11BE`, preserving byte 1 = `$FF`. If SFX are enabled, its active-music path selects one of the track's channel IDs from `$1582/$1583` (0..3), or its no-music path chooses channel 0..3; these paths leave byte 1 = 0. The caller does not change D0 before `$11762`; `$117F6` also receives that same D0 through the branch at `$11742`. Thus these rows are FORMULA: byte 1 is `$FF` only after a successful `$B018` report while SFX are disabled, and zero otherwise. This is a static control-flow result, not a capture of the report transition. Image default `$141B2` = 24.

### 6.6 `$11A74` (`$11A5C`, three caller families)

`$11A5C` loads `min($142C2,$FE)` into D2, sign-extends it, then calls `$2DCC` at `$11A74`; the RNG uses D0's low byte and byte 1, so D0 byte 1 is the remaining caller-specific input. `$10D48` (arson) and `$1163E` (meteor) arrive with `D0 = $14472` (6.2), whose byte 1 can become nonzero from tech 4 onward. The third call family enters `$11A5C` from `$119AC`, reached through the enemy update paths `$1193E → $1197C` and `$11A9E → $119C0`/`$11C7A`.

For the ground path, `$333A` loads `$142A2` into D0 at `$3494`, preserves it around the `$1193E` call at `$34C6`, and the first instruction of `$1193E` (`move.b (a6),d0` at `$1193E`) replaces only D0's low byte with the enemy type. The count is bounded by the 60 fixed ground slots: wave spawn checks `$142A2 < 60` before allocation, and event 17 checks `$142A2 != 60` before defecting a tank into the list. Thus its high byte (D0 bits 8–15) is zero. For the air path, `$333A` similarly loads `$142A4` at `$34FE`, preserves it around `$11A9E` at `$351C`, and that routine's type-byte load also changes only D0's low byte. The air count is bounded by its 30 fixed slots. These ordinary-play paths therefore enter `$11A5C` with D0 byte 1 = 0; the wider inherited D0 bits do not affect that byte.

Overall, this row is **FORMULA**, not CLOSED: the enemy-update caller has byte 1 = 0 under the fixed-slot bounds, while the arson and meteor callers depend on `$14472` as described in 6.2. Arbitrary malformed imported state is outside this ordinary-play bound. The selection range remains `min($142C2,$FE)` after `ext.l`; `$142C2` is the object-record count, written at `$4A4E`, `$6CF4`, `$6E5C`, `$74AA`, `$7506`, `$7798` (the TS mirror caps the same way).

### 6.7 Weekly battle `$127A0` (`$128AE..$12992`)

`$127B4-$127E0` sums seven `$14274` counters with weights into D0 (`S`). `$1280E-$12822`: `d1 = ceil($14592 / 2)` (`$14592` = tech level, 1..10), `mulu.w d1,d0`, `lsr.w #1,d0`, then `sub.w d0,$14(a1)`. On the path to `$128AC` D0 = `((S.w * d1) & $FFFF) >> 1` in the low word (upper word = upper word of the product), and nothing from `$128AE` to `$12992` modifies it. The sum `S` is over the fleet counters at the front; its bound was not established, so byte 1 depends on `S * d1 >= 512` (FORMULA). The TypeScript `weeklyBattle()` reproduces this expression, which independently supports the trace.

### 6.8 `$143F2` (mine count at `$A3F8`)

`$A3F8` loads `D0 = $143F2 - 1` (mine count minus one) and calls `$2DCA` inside a `dbra` loop at `$A404`, so D0 byte 1 depends on the count. `$143F2` is written at mine completion (`$75D4` within the Disk.1-placed footprint loop) and at mine demolition (independent removal not traced); fresh-game initialization clears it at `$866E`. The exact upper bound on the count was not established from code analysis of all writers; the ordinary-play bound remains the byte 1 check: count <= 256 means byte 1 = 0. The one November production tape miner pass recorded 10 rolled miners at `$A3FE`, consistent with byte 1 = 0, but does not establish the general count ceiling. This row is **FORMULA**, dependent on the saved/imported `$143F2` value; verification of ordinary-play bounds requires further writer analysis or extended capture data.

## 7. TypeScript cross-reference (`Sim`, `SimAliens`, `SimShips`, `EnemySystem`)

All `roll()` draws in `src/game` (54 call lines: `sim.ts` 32, `sim-aliens.ts` 18, `sim-ships.ts` 1, `enemies.ts` 3; `sim.ts:428` is the definition) were compared with the 62 sites. Each mapping below rests on the TS comment naming the original address/event AND the draw range and compare structure matching the traced code; it is a method mapping, not evidence that the draws occur in the same order or count. Mapping covers all 62 original sites: 52 TS lines map one-to-one, `sim-aliens.ts:439` is one loop line for five original sites, and `sim-aliens.ts:582` one loop line for five (52 + 2 = 54 lines, 52 + 5 + 5 = 62 sites).

### 7.1 Mapped

The `TS` column of section 5 is the mapping. Points that needed checking:

- `sim-aliens.ts:439` (loop over five one-shot stage tables `$13EE6/$13F10/$13F3A/$13F64/$13FB8`) matches `$AE20/$AE5E/$AE7C/$AE9A/$AEB6`: the first four bases advance by `$2A`; the fifth is reached by `$13F64 + $54` and stores its ticker at `$14486`.
- `sim-aliens.ts:582` (`battle()` casualty loop) matches the five unrolled draws in order: `$12910` (index 3, `subq.w #2,d7`), `$12932` (4, `#3`), `$12952` (5, `#4`), `$12972` (6, `#3`), `$12992` (7, `#1`); the two unconditional steps (indices 0, 1; `$128DA`, `$128F2`) have no draw in either.
- `$11A74` is one TS draw (`Sim.randomBuilding`, `sim.ts:946`, returning `[x, y, tile]`; the only function that calls `roll` for this site, as the invasion comparator's binding requires) serving three TS callers that correspond to the three original callers: arson (`sim.ts:972`, original `$10D48`), meteor (`sim-aliens.ts:181`, `$1163E`), ground and air target pick (`enemies.ts:1015`, `pickTarget`, one draw per call). Its four original callers are traced: walker `beq $119AC` at `$11980`, crusher `bra` at `$11F1C`, bomber `bra` at `$11C8C`, kamikaze `bsr` at `$119C6`; each draws once whether or not a building is found (enemies.md section 3d).
- `enemies.ts:948` is the bomb-chance draw behind the TOD gate (`$12694`); the gate itself is not a `$2DCx` call.

### 7.2 Fifth one-shot report: `$AEB6` (static trace; port updated)

The `$ADA6` sequence has five one-shot stages at `$AE20/$AE5E/$AE7C/$AE9A/$AEB6`, with table bases `$13EE6/$13F10/$13F3A/$13F64/$13FB8` and report slots `$1447C/$1447E/$14480/$14482/$14486`. `$AEB6` tests the signed first byte at `$13FB8`, calls `$2DCA` when it is not already marked, compares the result against the level-indexed byte at `$13FB8 + (level - 1)`, and on success writes the ticker pair at `$14486/$14487` and marks `$13FB8` as `$FF`. The repeatable report is separate: `$AECA` rolls against `$141B3`, then `$AEDE` checks `$13FE2 + (level - 1)` and increases alien strength. `SimAliens.eventIntelStep()` now includes the `$13FB8` one-shot stage before that repeatable pair. The new synthetic regression checks the ticker, flag, early return, and following repeatable-stage order; no original capture has observed the fifth report.

### 7.3 TS draws with no original site

None. Every one of the 54 TS lines maps to at least one original site above.

## 8. What would close the open rows

| Open | Needed |
|------|--------|
| Arbitrary event-dispatch state | Ordinary new-game flow bounds `$144BF` to 0..27, with zero chance at 20..27; arbitrary imported/hand-edited values can still index beyond the dispatch table and need validation or a capture. |
| Arbitrary `$144CA` state | Ordinary new-game writes are bounded to 0..4, closing family E for ordinary play. To claim it for arbitrary imported/hand-edited states, validate their `$144CA` bytes or capture a family-E call with an out-of-domain value. |
| FORMULA, `$14472` (5 rows + `$11A74`) | A higher-tech original tape to validate the predicted invention-bit transitions dynamically; extending the fresh-game writer proof to imported Disk.4/native-save states needs validation of their restored `$14472` values. |
| FORMULA, `$142CE` / `$144EC` (`$10BE8`, `$10CB8`, `$10DAC/C8/E6`) | A bound on `$144EC` from the `$A246` callers (for `$10BE8` it only has to lie in -10099..41199 for byte 1 = 0; the exact 5200..5399 band does not affect the draw), or tapes at extreme morale. |
| FORMULA, `$A3F8`, market, `$1161A`, `$1182E`, `$1129C`, `$128AE..$12992` | The range of the named counter (`$143F2`, Disk.2 market table, `$142A6`, `$13467`, `$1429C`, fleet counters `$14274..`) from writers or play. |
| `$AEB6` mapping | A tape or trace showing whether the fifth stage fires in the original; then decide on the TS side. |

## 9. What this does not establish

No RNG integration, no ordering or count equivalence between `Sim` and the original beyond the per-site mapping above, no first-use seed (see sim-port.md "Seed initialisation `$2DA0`"), no reachability proof for any site, and no dynamic coverage beyond the seven tape sites. `Sim.roll(range)` still provides neither D0 nor CIA TOD, so nothing here justifies wiring `original-rng.ts` into the game-wide generator; the tables above only state what such wiring would have to feed per site.

## 10. Captured-caller input audit (tutorial first pass, 2026-11-13)

Scope: the 32 `$2DCC` entries of the 2026-11-11/12 tutorial first pass (one run each, same input). Sources: `UtopiaMoneyCap-20261112/out/route2-capture.json` (`rng_hits`: D0, D2 at entry, return address, seed before; `births_hits`) and `UtopiaTutorialCap-20261111/out/route-capture.json` (same 32 `d0`, `d2`, `return_addr`, `a7`, `frame`; no seed). The two agree on every field they share. Registers are read at the `$2DCC` breakpoint (entry), so D2 is the range word plus any high word the caller left. Call site = return address - 6. No emulator was run. Static checks: Disk.1 disassembly (`tools/game_dis.py`) and a text scan of the decoded image for references to `$1146A`/`$11484`/`$10E58`.

Model replay: `originalRngStep` with each recorded D0 and range, the recorded seed, and the inferred TOD (`$DB` at frame 14321, `$E1` at frame 14327, as in section 2 of `game-proper.md`). All 31 links reproduce their next recorded seed.

`roll(n)` cannot take D0 or TOD. Its results come from the remake generator, so it cannot reproduce any of these 32 draws. D0 byte 1 (bits 8..15) is the only D0 part that matters (`$2DCC`); the low byte is overwritten by TOD. All 32 captured D0 values are below `$100` (max 76), so byte 1 = 0 for every entry. D2 uses only its low word.

| # | Frame | Site (ret) | Entry D0 | Entry D2 (full) | Range | Remake call (current line) | `roll(n)` supplies D0 byte 1? | Replay result (inferred TOD) |
|---|---|---|---|---|---|---|---|---|
| 1 | 14321 | `$11484` (`$1148A`), boot exit `$157B8` → `$11476` | `$22` | `$FFFF000A` | 10 | `sim-aliens.ts:148` (`initializeScenarioAppearance`, one `roll(n)`, via `Sim.leaveBootMenu`) | no (no D0 input) | 0 |
| 2 | 14327 | `$A7BA` (`$A7C0`) | 5 | 4 | 4 | `sim.ts:1629` (`walkEntry`, `roll(4)`) | no | 1 |
| 3 | 14327 | `$A7CC` (`$A7D2`) | 5 | 19 | 19 | `sim.ts:1632` (`walkEntry`, `roll(max-min)+min`) | no | 11 |
| 4 | 14327 | `$A7BA` | 5 | 4 | 4 | `sim.ts:1629` | no | 3 |
| 5 | 14327 | `$A7CC` | 5 | 19 | 19 | `sim.ts:1632` | no | 15 |
| 6 | 14327 | `$A7BA` | 3 | 4 | 4 | `sim.ts:1629` | no | 1 |
| 7 | 14327 | `$A7CC` | 3 | 9 | 9 | `sim.ts:1632` | no | 2 |
| 8 | 14327 | `$A7BA` | 30 | 4 | 4 | `sim.ts:1629` | no | 3 |
| 9 | 14327 | `$A7CC` | 30 | 290 | 290 | `sim.ts:1632` | no | 156 |
| 10 | 14327 | `$A7BA` | 8 | 4 | 4 | `sim.ts:1629` | no | 1 |
| 11 | 14327 | `$A7CC` | 8 | 29 | 29 | `sim.ts:1632` | no | 18 |
| 12 | 14327 | `$A7BA` | 5 | 4 | 4 | `sim.ts:1629` | no | 3 |
| 13 | 14327 | `$A7CC` | 5 | 29 | 29 | `sim.ts:1632` | no | 6 |
| 14 | 14327 | `$A7BA` | 20 | 4 | 4 | `sim.ts:1629` | no | 3 |
| 15 | 14327 | `$A7CC` | 20 | 100 | 100 | `sim.ts:1632` | no | 93 |
| 16 | 14327 | `$A7BA` | 50 | 4 | 4 | `sim.ts:1629` | no | 1 |
| 17 | 14327 | `$A7CC` | 50 | 200 | 200 | `sim.ts:1632` | no | 47 |
| 18 | 14327 | `$A7BA` | 50 | 4 | 4 | `sim.ts:1629` | no | **0 (no second draw follows)** |
| 19 | 14327 | `$A7BA` | 1 | 4 | 4 | `sim.ts:1629` | no | 2 |
| 20 | 14327 | `$A7CC` | 1 | 4 | 4 | `sim.ts:1632` | no | 1 |
| 21 | 14327 | `$A7BA` | 20 | 4 | 4 | `sim.ts:1629` | no | 1 |
| 22 | 14327 | `$A7CC` | 20 | 60 | 60 | `sim.ts:1632` | no | 30 |
| 23 | 14327 | `$A7BA` | 40 | 4 | 4 | `sim.ts:1629` | no | 2 |
| 24 | 14327 | `$A7CC` | 40 | 100 | 100 | `sim.ts:1632` | no | 96 |
| 25 | 14327 | `$A84E` (`$A854`) | 5 | 100 | 100 | `sim.ts:1666` (`marketWalk`) | no | 75 |
| 26 | 14327 | `$A84E` | 4 | 100 | 100 | `sim.ts:1666` | no | 84 |
| 27 | 14327 | `$A84E` | 3 | 100 | 100 | `sim.ts:1666` | no | 25 |
| 28 | 14327 | `$A84E` | 2 | 100 | 100 | `sim.ts:1666` | no | 92 |
| 29 | 14327 | `$A84E` | 1 | 100 | 100 | `sim.ts:1666` | no | 85 |
| 30 | 14327 | `$A84E` | 0 | 100 | 100 | `sim.ts:1666` | no | 89 |
| 31 | 14327 | `$9BCC` (`$9BD2`) | 30 | 30 | 30 | `sim.ts:1209` (`births`, `roll(difficulty)`) | no | 26 (matches `births_hits` `d2_result`) |
| 32 | 14327 | `$10BE8` (`$10BEE`) | 76 | 20 | 20 | `sim.ts:1423` (`crimeMonthly`, `roll(20)`) | no | 12 |

Notes on the rows:
- Rows 2–24 are the market walk: 12 first draws (`$A7BA`) and 11 second draws (`$A7CC`). Each second draw's D0 equals the first draw's D0 (the same current value), and each second-draw range equals the Disk.2 `max-min` of the walked entry in table order (19, 19, 9, 290, 29, 29, 100, 200, [skipped], 4, 60, 100). Row 18's first draw returned 0, so its second draw did not run. The remake's `walkEntry` already has this branch (`if (d2 === 0) return`).
- Rows 25–30 are the six `$A84E` draws (`$2DCA`, D2 = 100, D0 counts 5..0 as the `dbra` loop).
- Row 31 (births) D2 is the difficulty byte `$145A2` = `$1E`; the replay result (26) equals the recorded `d2_result`.
- Row 32 D0 = 76 (`$4C`) = `(q+100)>>1` with q = 52 or 53, i.e. `$144EC` in 5200..5399 (corrected from 5200..5299). `$144EC` is not in either capture, so q is not checked. The start value `$1388` (5000) would give q = 50 and D0 = 75; that is not the observed value, but it does not change the draw, which reads only byte 1 of D0 (section 10, D3).

### Discrepancies and unresolved items

- **D1 (row 1, `$11484`; RESOLVED 2026-11-13, boot caller, not event 1).** The first draw is the boot-exit call, not the event-1 path. Static: `$157B8` is `bsr.w $11476` (bytes `6100BCBC`, return `$157BC`, after `jsr $7E52` and `bsr $15EF0`; game-proper.md, boot tail). `$11476` starts with `clr.b $144A8`, so it skips the `$1146A` `jsr $2DCA` gate that event 1 runs first. The earlier open reading assumed event 1 and predicted a `$11470` hit. Evidence from the 2026-11-12 capture: (1) no `$2DCC` hit precedes row 1 after the click (the `$2DCA` gate would have produced one at `$2DCC`, D2 = 100, return `$11470`), and the seed before row 1 is the image default `$BFE0450D` (`$2EA0` bytes in Disk.1), so no draw changed the seed before it; (2) the retired-instruction counters in `route2-protocol.log` put the `$157BC` breakpoint 26 instructions after the row-1 `$2DCC` breakpoint, which is exactly the `$2DCC` body (17 instructions to `rts`) plus `$1148A`-`$114AA` (9 instructions to `rts`), so the routine returned straight to `$157BC`; an event-1 return would go to the dispatcher `$10E50`; (3) the range 10 is the `$144A6` word that the boot path reads at `$1147C`. The remake's `initializeScenarioAppearance()` (`sim-aliens.ts:148`, called by `Sim.leaveBootMenu`, `sim.ts:319`) is one `roll(n)` with no gate, which matches. The audit's earlier mapping of row 1 to `sim-aliens.ts:138` was wrong, and the missing `$2DCA` draw was a wrong expectation, not a probe artifact. **Boot caller's D0, traced (2026-11-13, static, same day):** `bsr.w $15EF0` at `$157B4` returns with D0 from its last callee. `$15EF0` runs `moveq #0,d0` at `$15F24` (no branch before it), then `jsr $6B10` with `d5` = `$39` (`moveq #$39,d5`, `$15F32`), so `$6B10`'s `tst.l d5` / `beq` falls through. `$6B10` sets `move.w #$110,d0`, saves D0/D1/D5 with `movem.l`, calls `$6A22` (`lsr.w #3,d0` gives `$0022`; `$69D8` saves and restores its registers and does not touch D0; the `cmpi.w #$48,d5` branch is fixed by `d5` = `$39`), restores D0 to `$00000110`, and calls `$6A22` again, which leaves **D0 = `$00000022`**. `$157B8` (`bsr.w $11476`), `clr.b $144A8`, `move.w $144A6,d2` and `beq` change no D0 before `$11484`. So the entry D0 is `$00000022` on the only path, byte 1 = 0, matching the capture (`d0` = 34). The boot caller is CLOSED. The D2 high word `$FFFF` is a caller leftover (`mulu.w` reads only the low word, and `$2DCC` leaves a zero high word). Event 1's own gate has no capture yet: a read-only breakpoint on `$1146A` in a run of an event-1 apparition would settle its draw order.
- **D2 (market walk; FIXED in notes).** Sections 5 and 6.4 previously read the second draw as unconditional. The disassembly shows it is conditional on a nonzero first result. The remake already has the branch; the capture shows it once (row 18).
- **D3 (`$10BE8`, row 32; band corrected, draw-relevant part closed for this entry, `$144EC` bound open).** Static trace of `$10BC8`-`$10BE8` (2026-11-13 re-read): `d1` = 100; `d0` = `$144EC`; for `d0` >= 0 `divu.w d1,d0` / `ext.l`, otherwise the same on the absolute value with a sign flip, so `q` = trunc(`$144EC`/100); `add.l d1,d0` and `asr.l #1,d0` give `d0` = (q+100) >> 1, which is the `$2DCC` caller's D0 at `$10BE8`. D0 = 76 needs q = 52 or 53, so `$144EC` is in **5200..5399**; the earlier note's 5200..5299 missed q = 53 (`(53+100)>>1` = 76 as well). The start value 5000 gives q = 50 and D0 = 75. The draw does not need the exact band: `$2DCC` replaces D0's low byte with TOD, so only byte 1 of D0 matters. Byte 1 is 0 for q in -100..411, i.e. `$144EC` in -10099..41199 (the `divu.w` path has no overflow there). Outside that range byte 1 is nonzero: a negative result below -10099, and from 41200 a result of 256 or more. Row 32's byte 1 is observed 0 (capture `d0` = 76 as a full register value). `$144EC` is still not captured, so its ordinary-play bound, and therefore byte 1 for other morale values, remains FORMULA.
- **D4 (capture naming).** `route2-capture.json` (2026-11-12 probe, folder `UtopiaMoneyCap-20261112`) is the only file with seeds and births, so it is what `UTOPIA_TUTORIAL_CAPTURE_DIR` must point at (the folder or its `out/`). `route-capture.json` (2026-11-11, `UtopiaTutorialCap-20261111`) has no seed field and is not a substitute for the chain check.

### Test added (narrow, model against capture)

`test/original-rng-tutorial.mjs`, chain section (runs only with `UTOPIA_TUTORIAL_CAPTURE_DIR` set): the market walk's model results are checked against the traced branch. Every first `$A7BA` result is 0..3, every second `$A7CC` result is below its range, the second draw follows a nonzero first draw, and the capture has one zero first draw and eleven nonzero ones. This tests the model's output against the control flow. It is not a new TOD observation and not parity evidence for the walk.

### Scope (what this does not establish)

- No caller is wired to `OriginalRngModel`. `Sim` keeps `createRng`. The TOD byte is still an inferred input, and the engine has no CIA-A source.
- The D0 values are observed for these 32 entries only. For other sites, D0 is still a traced formula (section 5).
- D1 is resolved for the boot caller (above), and its entry D0 (`$00000022`) is traced statically. The event-1 draw order (`$1146A` gate, then `roll(n)`) is traced statically but not captured.
- Interface check (2026-11-13): `OriginalRngModel.draw(d0, range, tod)` takes the full caller D0 and range, so the boot row (`d0` `$22`, range 10) and the morale row (`d0` 76, range 20) can be expressed without changes. The TOD byte is still inferred from the seed chain, so neither row is a standalone observed test. No new test was added: `test/original-rng.mjs` already checks that D0's upper word and low byte do not affect the draw, and that bits 8..15 do.
