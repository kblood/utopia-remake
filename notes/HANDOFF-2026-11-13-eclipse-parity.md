# Utopia handoff: eclipse descriptor swap as a stored parity (`$11024`), 2026-11-13

Supersedes [HANDOFF-2026-11-13-eclipse-swap.md](HANDOFF-2026-11-13-eclipse-swap.md), whose bit-6 view was wrong after a disk-menu entry during an eclipse and after a new game.

Model and routing: Claude Haiku 5.5, as the implementation sub-agent, inline. No orchestration tool was called, so the `claudeAgent` routing requested in the brief is not confirmed. No subscription usage was checked and no timer was scheduled. No emulator was run, and no original file was written. Nothing was committed or pushed.

Read first: [AGENTS.md](../AGENTS.md), [formats/game-state.md](formats/game-state.md) (`$144BB` row and 5.1 item 3), [formats/sim-port.md](formats/sim-port.md) (weekly row), [formats/remake-save.md](formats/remake-save.md) (version 11 and the migration paragraph).

## 1. The reading taken

The brief asked for the eclipse view to follow every traced `$11024` call. The table itself is the state, so the remake stores a parity. Bit 6 cannot provide it:

- A disk-menu entry (`$7E52`/`$7ECA`) during an eclipse toggles the table while bit 6 is set. The menu's own parity is therefore 0, and the view goes back to unexchanged while the menu is open.
- A new game (`$866E` -> `$875C`) ends with `move.b #1,$156AA` (`$87CA`), which clears bit 6 without a swap. The table stays as it was.

So the parity has to be stored, and saves (taken only in the disk menu) carry it.

## 2. What was built

- `src/game/sim.ts`: `tileExchange` (the parity) and `tileExchangeAssumed` (set by a migration, kept by later saves). Methods:
  - `enterDiskMenu()`: toggles when `SYS.eclipse` is set (`$7ECA`).
  - `leaveDiskMenu()`: returns when game over is set or `$144BB` is 0; otherwise toggles and sets bit 6 (`$8040`-`$8046`).
  - `carryTableState(from)`: hands the parity to a replacement session. `null` keeps the boot state.
  - `eclipseWeekly()` and `eventEclipse()` toggle at the start and end, and at event 14.
- `src/game/eclipse-tiles.ts`: `eclipseTileView(tiles, exchanged)` is pure. It returns a new array; exchanged entries are new `Tile` objects with the other entry's address and their own rows. Sources are not written.
- `src/game/map.ts`: `MapScene.syncTileView()` follows `sim.tileExchange` and rewrites its list in place from the unchanged `baseTiles`.
- `src/game/game.ts`:
  - `createScene` and `activateDisk4` carry the replaced session's parity (`carryTableState`).
  - `startTutorial` and `enterHeldScene` call `leaveDiskMenu()` before entering.
  - `openMapDiskMenu` and the game-over tail call `enterDiskMenu()`.
  - `closeMenu` was restructured: a held scene or no map reopens the disk menu; game over sets `diskMenuFromTail`; otherwise it calls `leaveDiskMenu()` and returns to the map.
- `src/game/save-session.ts`: `SESSION_VERSION = 11`. `sim.tileExchange` and `sim.tileExchangeAssumed` are written, validated as booleans, and restored atomically.
- `src/game/save.ts`: versions 2..10 migrate with `tileExchange` false and `tileExchangeAssumed` true. `decodeSave` reports `tableAssumed`, and `slotWarning` names TBL with the other assumptions (the original single-suffix rule of section 8 was replaced in section 9). The flag is set for every version 2..10.

## 3. Migration choice

Versions 2..10 stored no parity. The migrated value is 0, which is the disk-menu value. Every pre-version-11 save was taken inside the disk menu, and the menu parity is 0 whenever bit 6 is set. Using bit 6 instead was rejected, because it would invert the view after an exit. The value is flagged as assumed, and the flag is kept by every later save.

## 4. Tests

- `test/eclipse-parity.mjs` (new; 36 `ok` checks in total, 6 of them synthetic). It covers:
  - the weekly start, the two-call countdown and the third-call end;
  - event 14 at chance 0 and 100, and its no-op during an eclipse;
  - menu entry and exit rules, including exit with `$144BB` 0 and exit during game over;
  - map view from the parity, and menu re-entry while active;
  - a new game during an eclipse (parity carried, no swap at reset, bit 6 cleared);
  - save and load of the parity, and the v10 migration with the `" TBL UNK"` label and assumption kept on re-save;
  - no mutation of the loaded tiles or their image bytes.
- `test/eclipse-tiles.mjs`: the real-data MapScene section now drives the view through `sim.tileExchange`, and the synthetic part is unchanged (40 `ok` lines).
- `test/save.mjs`: version assertions moved to 11; the v10 checks expect `" TBL UNK"`. 321 `ok` lines.
- `package.json`: `node test/eclipse-parity.mjs` added to the `npm test` chain after `test/eclipse-tiles.mjs`.

## 5. Verification results

- `npm run build` (`tsc`): exit 0.
- `node test/eclipse-parity.mjs`: exit 0, "all eclipse parity checks passed".
- `node test/eclipse-tiles.mjs`: exit 0, "all eclipse tile checks passed" (40 `ok` lines).
- `node test/save.mjs`: exit 0, 321 `ok` lines, "all save checks passed".
- `npm test`: exit 0, 4212 `ok` lines in total (the baseline was 4175 before this change).

One test fix during this work: the menu ignores the press that opened it, so the test releases the mouse before clicking the exit icon. Without that frame the exit did not leave the menu. This is a test-driver detail, not a change in the game.

## 6. Not verified

- No emulator comparison was run. The visible effect of the exchange (for example the build-menu icon `$33`/`$34`) is not observed.
- The parity claim rests on static traces. Every traced call is listed in game-state.md 5.1 item 3.
- Disk.4: `activateDisk4` carries the previous session's parity. The Disk.4 record holds no table, so that carry is not verified against the original, and no Disk.4 parity is claimed.
- The v10 assumption (parity 0) is static. It is exact only if the menu parity was 0 in every pre-version-11 save, which the traced rules give when the map parity equals bit 6. That equality and the carry through the tail and Disk.4 paths are not verified.
- Not checked: `$B0BE` (also `jmp $157AE`) and the in-game exit path beyond `$8040`.

## 7. Next

- Compare with the running original: an eclipse start, a menu entry and exit during it, and a new game during it. Record the table state from memory, not from the screen, if possible.
- Decide whether the Disk.4 carry should instead start from a traced boot state.

## 8. Review of the parity and the version-11 migration, 2026-11-13

Routing: the review ran inline as Claude Haiku 5.5. No orchestration tool was called, so `claudeAgent` routing is not confirmed. No emulator was run, no original file was written, and nothing was committed or pushed. The worktree is preserved.

**Static re-check against the raw Disk.1 bytes.** There is no capstone in this environment, so the routines were decoded by hand. The mapping is file offset `sector * 512` with base `$29800` for `$1000`, anchored on `btst #6,$156AA` at `$7ECA`.

- `$10FCA` (weekly): returns on `btst #7`. A nonzero `$144BB` goes to the countdown, which returns while nonzero. At zero it sets message `$DE`, clears bit 6, and branches to `$11004`. The start needs `$145A0` = 11 and `$1459F` = 21, then sets `$144BB` = 3, message `$DD`, `bset #6`, and falls into `$11004`. `$11004` is `jsr $5A8C`, and `$1100A` is `bsr.s $11024; rts`. So each start and each end runs `$11024` once.
- `$11058` (event 14): `tst.b $144BB; bne` skips before the roll. The roll sets `$144BB`, then `bsr $1107A` runs `$11024`, message `$DD`, and `bset #6`.
- `$7ECA` (menu entry): `btst #6; beq` skips, otherwise `jsr $11024`.
- `$802C` (exit): `btst #3; bne` returns to the `$7EF6` loop (refused in game over). `tst.b $144BB; beq.s` skips over `jsr $11024; bset #6` when the count is zero.
- Callers of `$11024`: exactly `$7ED4`, `$8040`, `$1100A` and `$1107A`. Callers of `$7E52`: `$157AE` and `$15AE6`. Callers of `$157AE`: `jmp` from `$B0BE` and `$10E18` (game-over paths). Callers of `$802C`: the icon-5 `beq` at `$7FE8` and the tutorial `bra` at `$812E`. `game-proper.md` line 59 said the tutorial branch was the only one; that is corrected.

Every remake code path matches these routines (`Sim.eclipseWeekly`, `eventEclipse`, `enterDiskMenu`, `leaveDiskMenu`; `Game.openMapDiskMenu`, `returnToMap`, `closeMenu`, `enterHeldScene`, `startTutorial`).

**Call-path coverage.** Each traced call toggles exactly once in the remake:

- Weekly start and end: once each. The tutorial gate returns first.
- Event 14: once, and nothing during an eclipse.
- Menu entry: the map icon and the game-over tail, once per entry. Re-showing a page, and the tail's re-open in `closeMenu`, do not toggle.
- Menu exit: `closeMenu`, the held-scene exit and the tutorial's exit, once each. Refused in game over.
- New game, scenario and tutorial: the reset clears `$144BB` (state.ts zeroes `$14234`-`$144CB`), so the exit is a no-op. The parity is carried.
- Disk.4: the parity is carried. The exit then toggles according to the restored count. Not verified, as in section 6.
- Load: `restoreSession` writes the saved parity, and the held exit then toggles once. See the open point below.

**Invariant (new, `test/eclipse-parity.mjs` Part 1k).** On the map, the parity equals bit 6, and bit 6 is set exactly while `$144BB` is nonzero. Menu entry gives parity 0. A 20,000-step walk over the real `Sim` (11 starts, 17 event starts, 26 ends, 2,910 menu exits) had zero failures. The consequence is that every save taken from the disk menu stores parity 0, so the stored field is always 0 for UI-produced saves. Part 1f's saved value of 1 comes from a map-side save that the UI does not produce.

**Open point (recorded, not changed).** On the traced notes (game-proper.md; `$8828` reads save area B of the state, and `$866E`/`$875C` do not touch `$1612E`), the original's save file does not contain the table, so after a load the original's table is whatever is in memory. The remake overwrites it with the saved value. Under the invariant both give 0 for every UI-produced save, so they agree. They could differ only for a hand-edited save with parity 1, which validation does not reject. This is a design choice of the remake's snapshot model, not verified against the original.

**Labels (display decision, not changed here; REPLACED by section 9).** The slot label is a single suffix. `" TBL UNK"` appears only when no FX, PTR or V1 label applies, so v2-v5 show `" FX/PTR UNK"`, v6 shows `" PTR UNKNOWN"`, and v7-v10 show `" TBL UNK"`. The flag is set for all of v2-v10. Whether a combined label is wanted within the 12-character budget is a decision for the owner.

**Tests added** (`test/eclipse-parity.mjs`; the file was already in `npm test`):

- Part 1h: a save inside the menu stores parity 0 with bit 6 set. A pick-load then EXIT gives one exit toggle (0 to 1) and the exchanged view.
- Part 1i: game over during an eclipse gives one entry toggle (1 to 0). A refused EXIT toggles nothing. A tutorial restart leaves parity 0 with bit 6 cleared. The population game-over path is the one `game-over.mjs` drives.
- Part 1j: a per-version fixture for v2-v10, built as `save.mjs` builds its fixtures. Each has parity 0 with the flag set, and the test pins the label each version shows.
- Part 1k: the invariant walk above.

Test discrimination: Part 1j fails if a migration stores `true` or drops the flag. Part 1i fails on a double or missed entry toggle, or an exit toggle in game over. The walk fails on any unpaired toggle.

**Verification.** `npm run build` exit 0. `node test/eclipse-parity.mjs` exit 0, 66 `ok` lines. `node test/eclipse-tiles.mjs` exit 0, 40 `ok` lines. `node test/save.mjs` exit 0, 321 `ok` lines. `npm test` exit 0, 4,242 `ok` lines, about 15 s. The optional external capture comparison was skipped because `UTOPIA_SITE_CAPTURE` is not set.

**Not verified.** The visible effect of the exchange (the menu icons during an eclipse). The original's behavior after a load, which is the open point above. Disk.4 table and count (section 6). Any comparison with the running original.

## 9. Combined slot labels for migrated saves, 2026-11-13

Routing: implemented inline as Claude Haiku 5.5. No orchestration tool was called in this session, so `claudeAgent` routing is not confirmed. No subscription usage was checked and no timer was scheduled. No emulator was run, no original file was written, and nothing was committed or pushed.

**Problem (section 8).** `slotWarning` returned one suffix, so a migrated save hid every assumption but the first: v2-5 showed `" FX/PTR UNK"` without TBL, v6 showed `" PTR UNKNOWN"` without TBL, and v7-v10 showed `" TBL UNK"` alone.

**Change (`src/game/save.ts`, `slotWarning`; `SLOT_SUFFIX_COLUMNS` = 13).** The label is `SLOT n  dd/mm/yyyy` (18 columns) plus the suffix, so the suffix has 13 columns.

- A single assumption keeps its exact wording: `" FX UNKNOWN"`, `" FX SLOT UNK"`, `" PTR UNKNOWN"`, `" V1"`, `" TBL UNK"`.
- Two or more are joined with `/` in the order FX, PTR, V1, TBL. ` UNK` is appended when it fits: `" FX/PTR UNK"`, `" FX/TBL UNK"`, `" PTR/TBL UNK"`, `" V1/TBL UNK"`.
- The three-way combination drops ` UNK` (`" FX/PTR/TBL UNK"` would be 15 columns): `" FX/PTR/TBL"`.
- Migration values, flags and the save format are unchanged. Only the displayed string differs.

Per version (flags the migration holds, from the existing decoder):

| Version | Flags | Label before | Label now |
|---|---|---|---|
| 2..5 (object layer, enemies) | FX (empty pool), PTR, TBL | `" FX/PTR UNK"` | `" FX/PTR/TBL"` |
| 6 (empty dense list) | PTR, TBL | `" PTR UNKNOWN"` | `" PTR/TBL UNK"` |
| 7, 8, 9, 10 (base session) | TBL | `" TBL UNK"` | `" TBL UNK"` |
| version-less | V1, TBL | `" V1"` | `" V1/TBL UNK"` |
| 7 with assumed slot numbers | FX (slots), TBL | `" FX SLOT UNK"` | `" FX/TBL UNK"` |

**Trade-off (decision for the owner).** When FX is combined with another assumption, the `SLOT` wording is lost, so `" FX/TBL UNK"` no longer says that the slot numbers (not only an empty pool) are assumed. The stored flags and the single-assumption label keep the distinction; "SLOT" does not fit next to TBL in 13 columns. The alternative is to drop TBL from combined labels, which would reintroduce the hiding this change removes.

**Reachability.** Version-less saves (`migrateLegacy`) never carry FX or PTR, so the four-way label (14 columns) cannot occur. The test documents this rather than asserting it fits.

**Tests.**
- `test/save.mjs`: the exact label for each of the 14 reachable flag combinations, that every held assumption is named, and that the widest label (`" PTR/TBL UNK"`, 30 columns with the prefix) is within 31. The game-level v5, v6 and version-less label checks and the v7 slot-summary check now expect the new strings.
- `test/eclipse-parity.mjs` Part 1j: the exact label for v2 to v10 built from real `decodeSave` results, the 31-column layout for each (with a `SLOT 4  31/12/2099` prefix), and that the named flags match the decoded flags. The old "a higher-priority warning hides TBL UNK" expectation is removed.

**Verification.** `npm run build` exit 0. `node test/eclipse-parity.mjs` exit 0, "all eclipse parity checks passed" (84 `ok` lines). `node test/save.mjs` exit 0, "all save checks passed" (337 `ok` lines). `node test/eclipse-tiles.mjs` exit 0 (40 `ok` lines). `npm test` exit 0, 4,276 `ok` lines, 0 `FAIL` lines. The external capture comparison was skipped because `UTOPIA_SITE_CAPTURE` is not set.

**Not verified.** The rendered label in the browser, at the real menu font, has not been seen. The 31-column budget is the character count the code uses, not a pixel measurement. The migration assumptions themselves are unchanged and remain static inferences (sections 3 and 6 of this note).

**Files.** `src/game/save.ts`, `test/save.mjs`, `test/eclipse-parity.mjs`, `notes/formats/remake-save.md` (slot-label section and the TBL row), and this handoff (sections 2 and 8 marked as superseded where they described the old label).
