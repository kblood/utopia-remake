# Utopia handoff: key bytes through the save, load and scenario picks (2026-11-14)

> **Status update (2026-11-14, later):** open point 1 (the remake save close) is changed: a successful save returns to the disk-menu loop, as the original does. See [HANDOFF-2026-11-14-save-return.md](HANDOFF-2026-11-14-save-return.md). The statements in sections 1, 4 and 7 below describe the state at the time of this handoff.

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator and no original writes: `original/` was only read (`tools/game_dis.py`-style disassembly via capstone, `tools/key_reach.py`). A throwaway probe lived in `$TEMP` and is not part of the repository. Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-disk-menu-key.md](HANDOFF-2026-11-14-disk-menu-key.md) (the exit poll), [HANDOFF-2026-11-14-release-encoding.md](HANDOFF-2026-11-14-release-encoding.md), [formats/game-proper.md](formats/game-proper.md) "One key cell" and "Disk menu and its exit", [formats/game-state.md](formats/game-state.md) (the save and load pages).

## 1. Questions and answers

| Question | Answer | Evidence level |
|---|---|---|
| Does a byte in the key cell before a load, scenario or save pick survive to the exit's `$15B4A`? | **Load and scenario: yes.** Neither path reads or clears `$161A0`. The byte is dispatched by the exit's poll, the same iteration as the EXIT (`$802C`, `$15AEC`, `$158B0`, `$158C2` `bsr $15B4A`). | VERIFIED static (per-routine walks and disassembly) |
| Same, for a save? | **Click-to-save (no name): yes.** The name loop `$8958` reads the cell and never clears it; the click path `$2E52` -> `$89B4` touches nothing. **Return-to-save (name entry): no.** Return is a single byte that overwrites what was there, and it is then consumed by the name entry `$5110`. | VERIFIED static |
| Which bytes do the name entry and its Return path leave? | Every byte the count entry `$5110` reads is cleared at `$515A` (`clr.b $161a0`) unless it is Return or Enter, which `$5110` leaves in the cell. The final `$44` (Return) then reaches `$15B4A`, which clears it and dispatches nothing (no arm for `$44`). So nothing typed in the name prompt is dispatched. | VERIFIED static |
| Does a byte typed during a load, scenario or save prompt survive? | Yes, unless a later byte overwrites it: the cell holds only the last byte, and the IRQ store (`$2BEC`) writes every byte. In the save name loop a non-Return byte is not read at all, so it survives too. | VERIFIED static (store and readers); the overwrite race is not timed |
| Does the remake keep the same bytes? | **Yes, for every held route probed.** Scenario pick, load pick, tutorial, boot-menu scenario hold, last-entry-wins: each matches. | VERIFIED probe (`test/disk-menu-keys.mjs` 4a-4g) |
| Where does the remake differ? | (a) A remake save closes straight to the map (`closeMenu`), where the original returns to the menu loop and waits for EXIT. A menu-typed key is then dispatched by the next map pass, not at an EXIT. Not lost, not replayed (4h). (b) The remake has no name prompt, so the Return path has no counterpart. | VERIFIED probe; remake-only navigation, not changed |

## 2. Trace (Disk.1, file = address + `$28800`)

| Routine | Role | Cell touch | Method |
|---|---|---|---|
| `$87DC` | pick dispatch on `$938D` (mode): 4 -> `$8A42`, 1 -> `$8918`, 2 -> `$8828`, 3 -> `$88F0` | none in the body | disassembly `$87DC`-`$8828` |
| `$8828` | load (mode 2): file reads `$7D96`, `$84F4`, `$8A5A`, `$7C80`, `$7D0E`, `$866E` (d0 = 1), `$82B8`, then `rts` to `$7FDC` -> `bra $7EF6` | none | `key_reach 8828`: 44 routines, none touch |
| `$88F0` | scenario (mode 3): `$866E` (d0 = 2), `$8AF4`, message `$8B`, `rts` | none | `key_reach 88f0`: 51 routines, none touch |
| `$85FE` / `$856C` / `$8632` | load / save / scenario icons: disk check `$855A`, slot-list prints `$85CA`, message `$83A2`, `$82B8`, then `bra $7EF6` or set the mode | none in the bodies | disassembly; `key_reach` on `$855A`, `$83A2`, `$85CA`, `$539E`, `$2E48`, `$841E`: none |
| `$8918` | save name (mode 1): copies the date/name to `$161AA` (not the cell), prints `$13E`/`$13F`, then the loop | reads at `$8958` | direct |
| `$8958` | the loop: `move.b $161a0,d0`; `$44` -> `$8974`; left button (`btst #6,$bfe001`) not pressed -> `bne $8958`; pressed -> `$2E52` (waits for release), `bra $89b4` | **read, no clear** | disassembly |
| `$8974` -> `$89B0` | Return path: `$84F4`, `$826E`, message `$142`, `bsr $5110` (name entry), then falls to `$89B4` | reaches `$5110` | disassembly; `key_reach 8974` |
| `$5110` | count / name entry: `clr.b $161a0` at `$515A`, read `$5160`, `$44`/`$43` at `$5168`/`$516E` confirm (`$51B8`: with no name, cleared and repeat; with a name, `rts`), `$41` Backspace (`$5174`), table match, otherwise cleared by `bra $515a` | **clears at `$515A`; reads at `$5160`** | disassembly |
| `$89B4` -> `$8A40` | common save tail: writes the header record, `$7D88` (WHDLoad save), `$997A`, messages | none | `key_reach 89b4`: 28 routines, none touch |
| `$8A42` | music select (mode 4): `$110A` -> `bra $7EF6` (rows 4+) | none in the body; reaches `$5110` only through `$7EF6` | `key_reach 8a42` (menu closure) |
| `$158A` -> `$15DE` | a `jmp -2(a6)` table dispatcher (bound word `$15F4` = 9, targets `$15F6 + word_i - 2`): the nine targets are `$1608, $16D0, $16DA, $16E0, $1754, $175E, $1766, $176E, $1794` | none | decoded from the image; `key_reach` on the nine: none touch |
| `$15B4A` | keyboard poll: read `$15B4A`, exit on zero, clear `$15B54`, dispatch | read and clear | byte scan |

Byte scan of Disk.1 for the absolute long `$161A0`: writers `$2BEE` (IRQ store) and `$515A` (`clr.b`); readers `$5160`, `$8334`, `$8958`, `$15B4C`; clear `$15B54`. The save, load and scenario paths touch only `$8958`, `$515A` and `$5160`.

Closures through `bra $7EF6` over-report, because `$7EF6` is the menu loop and reaches the format prompt's `$8334` read. The icon-entry bodies (`$856C`, `$85FE`, `$8632`) were checked by disassembly and their non-menu callees by walk, not by the walk alone.

## 3. Survival table (original)

| Selection | Cell before the pick | Byte typed during the selection | At the exit's `$15B4A` |
|---|---|---|---|
| Load (`$85FE` -> `$8828`) | survives | survives; last wins | dispatched (the EXIT iteration) |
| Scenario (`$8632` -> `$88F0`) | survives | survives; last wins | dispatched (the EXIT iteration) |
| Save, click (no name) (`$856C` -> `$8918` -> `$8958` -> click) | survives (the name loop never clears it) | survives; a non-Return byte is not read | dispatched at the EXIT (the save does not exit the menu) |
| Save, Return (`$8958` `$44` -> `$5110`) | overwritten by the Return byte (the cell holds one byte) | consumed by the name entry (cleared, or the Return left as `$44`) | nothing dispatched (`$44` has no arm) |

Release bytes: the consumption and overwrite facts above are byte-level and hold for any byte (the name loop and `$5160` read any nonzero byte; `$515A` clears it). Only the "dispatches nothing" for a release depends on the bit-7 convention (release-encoding handoff, open point 1).

## 4. Remake comparison (probe, then test)

Probe in `$TEMP` (`probe.mjs`, `saveload.mjs`, `boot.mjs`), with a persistent `input.keys` as in `main.ts`, and one idle frame after each menu open (a menu opened while a button is held ignores that press; the remake's `Menu` and `DiskMenuScene` both do this, so the probe's first clicks were lost until fixed).

| Route | Remake path | Result |
|---|---|---|
| P in the menu, scenario pick, EXIT | `disk`, `scenario`, `handleDiskMenu`/`menu.update` never drain `input.keys`; `enterHeldScene` -> post-switch `updateMap` with the batch | paused at EXIT (match; 4a) |
| P on the scenario list | the list (`menu.ts`) does not drain | kept; paused at EXIT (match; 4b) |
| P while held (after pick) | the held disk stage does not drain | kept; paused at EXIT (match; 4c) |
| P then X before a held EXIT | last entry wins | nothing (match; 4d) |
| P in the menu, load pick, EXIT | load page does not drain | paused at EXIT (match; 4e) |
| Boot-menu scenario pick, EXIT | `bootMenuOpen`, `enterHeldScene`, `runDiskMenuExit` | paused at EXIT (match; 4f) |
| P before the tutorial icon | `startTutorial` -> `enterScene`, post-switch `updateMap` (immediate pass) | paused at entry (match; 4g) |
| P before a remake save click | `closeMenu` -> stage map at once | not lost, dispatched once by a later map pass; the original would wait for EXIT (4h checks only that it is not lost or replayed) |

The remake's only shortcut that touches a key's timing is the save close. No remake route drops a key that the original keeps.

## 5. Change

- **No engine change.** Every held route the original traces to a surviving byte matches in the remake, so nothing is "proven" wrong in `src/`. The save-close shortcut (`closeMenu`) is a remake navigation choice and is recorded in open point 1, not changed.
- `test/disk-menu-keys.mjs`: section 4 (4a-4h, 16 new checks) covers the held routes above, plus the "not replayed" and last-wins cases. The header comment is unchanged; section 4 has its own header.
- `tools/key_reach.py`: the docstring's example list had the `$15DE` table targets wrong (entries 1, 2, ... mixed the `jmp -2(a6)` offset and omitted it). The corrected nine targets are decoded from the image and walked: none touches `$161A0`.

## 6. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/disk-menu-keys.mjs` | exit 0, 29 `ok`, 0 `FAIL` (was 13) |
| Mutant: `handleDiskMenu` clears `input.keys` in `dist/game/game.js` | `test/disk-menu-keys.mjs` exit 1, 12 `FAIL`; the good build restored and exit 0 |
| `node test/disk-menu.mjs` | exit 0, 107 `ok` |
| `node test/save.mjs` | exit 0, 383 `ok` |
| `node test/map-loop.mjs` | exit 0, 381 `ok` |
| `node test/game-over.mjs` | exit 0, 50 `ok` |
| `node test/boot-menu.mjs` | exit 0, 51 `ok` |
| `node test/window-input.mjs` | exit 0, 173 `ok` |
| `node test/order-input.mjs` | exit 0, 52 `ok` |
| `node test/screens.mjs` | exit 0, 95 `ok` |
| `node test/button-sound.mjs` | exit 0, 42 `ok` |
| `npm test` (full chain) | exit 0, 4,724 `ok`, 0 `FAIL` (was 4,708) |

## 7. Open points (not changed)

1. **Remake save close.** `closeMenu` returns a remake save straight to the map with the exit's effect (`leaveDiskMenu`). The original's save returns to the disk menu loop and needs EXIT. A menu-typed key is dispatched at the next map pass in the remake. Changing it would change the remake's save navigation, so it is a design decision, not a key fix.
2. **Save-name Return path has no remake counterpart.** The original's Return path (`$8974` -> `$5110`) lets a digit typed in the menu be overwritten by the Return byte and never dispatched; the remake's slot list has no name prompt. Nothing to test until a name prompt exists.
3. **Overwrite race during the picks is not timed.** Load and scenario take a long run of file work with no poll. The last byte before the next poll is the one dispatched; the rate of keyboard bytes against that work is not measured.
4. **Disk4 continuation exit.** The held Disk.4 exit (`enterHeldScene` with `disk4`) skips `resumeWithImmediatePass`, so a key from its menu is folded at the next map update. Its original exit is untraced (game-proper.md, "Disk.4").
5. **Release dispatch** still rests on the bit-7 convention (release-encoding open point 1).
6. **Register-relative access** to `$161A0` (key-cell-batch / disk-menu-key open point 4) is not excluded by the byte scan.
7. **Menu closure over-reports.** `key_reach` follows `bra $7EF6`, so a walk from any icon reaches the format prompt's `$8334` read. Handler bodies were checked by disassembly for this handoff, not by the tool alone.

## 8. Notes changed

- `notes/formats/game-proper.md`: "Disk menu and its exit" gains the save, load and scenario survival facts.
- `notes/HANDOFF-2026-11-14-disk-menu-key.md`: open point 1 (other icons after a menu-typed key) is answered here.
- `notes/README.md`: newest handoff pointer.
