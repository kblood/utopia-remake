# Utopia handoff: the load's return from the disk menu (2026-11-14)

> **Status update (2026-11-14, empty-load slice):** the empty-record route in this note is superseded. A refused EMPTY row now keeps the remake's load list with `$143` on its prompt (no error page, no BACK): see [HANDOFF-2026-11-14-empty-load-list.md](HANDOFF-2026-11-14-empty-load-list.md). The original trace it cites (`$8804`-`$881E`, `$143`, `rts`, mode 2 kept) still holds. The wrong-disk and corrupt routes are unchanged.

> **Status update (2026-11-14, later):** the claim in section 1 that a valid load "already matches" is corrected. The original's `$88CA` prints `$145` on the list prompt and `$82B8` (the `bra` at `$88EA`) erases the prompt in the same handler, so no message is shown. The remake now shows none after a slot load. See [HANDOFF-2026-11-14-load-pick-message.md](HANDOFF-2026-11-14-load-pick-message.md). The scene hold itself is unchanged.

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator and no original writes: `original/` was only read (`tools/`-style disassembly via capstone, with the `+$28800` address mapping). Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-save-return.md](HANDOFF-2026-11-14-save-return.md) (open point 2, the load error BACK), [formats/game-proper.md](formats/game-proper.md) "Load failure and return" and "Save tail and return", [formats/remake-save.md](formats/remake-save.md) "Disk menu behaviour on failure".

## 1. Questions and answers

**Does a failed or refused load return to the disk-menu loop, stay in a subpage, or exit?** It returns to the loop, never through EXIT (VERIFIED static, Disk.1 disassembly; no emulator run).

| Refusal | Original route | Evidence |
|---|---|---|
| Load icon, wrong save disk (`$855A` header not "UTOP"+"SAVE") | `$137`/`$136` message, `$82B8`, `bra $7EF6` | `$85FE`-`$861C`; `$845E` returns -1 |
| Empty record (first long `$454D5054` "EMPT", word `+4` = `$5900`) | `$143` message, `rts` to `$7FDC` `bra $7EF6`; mode 2 kept, so the list stays | `$87DC` -> `$8804`-`$881E` |
| Corrupt or unsupported record | No traced branch refuses it. `$8828` loads it with no format, version or checksum test | `$8828`-`$88EA`: none |

`$82B8` clears the disk-menu mode `$938D` (`clr.b`). The wrong-disk path therefore clears the list mode, and the empty path keeps it.

**Is the scenario-disk check a subpage?** The mode-2 load calls `$8A5A` after it has copied `$1453E` into `$8D00` (`$888A`, `$8894`). It loops (prompt `$E6EC`, `$8AD2`) until the scenario-disk header word equals `$8D00`. The traced exits are a matching disk only; the prompt text and its wait are not traced. This is a real subpage, but it applies to a valid-looking load, not to a refusal. The remake has no disk swap.

**Does a valid load succeed differently?** It also returns to the loop: `$8828` ends with `bra $82B8` and `$7FDC` `bra $7EF6`. The scene is held until EXIT (`$802C`). The message is `$145` (printed at `$88CA`). The remake already does this (`acceptScene` holds the scene and reopens the disk menu, with `GAME_LOADED_STRING`), so load success matches and was not changed.

**Does the original have typed errors for corrupt or unsupported saves?** No. The typed codes `corrupt`, `unsupported-version` and `invalid` are remake additions. Their route is a remake choice, and this handoff chose the loop for them to match the refused load.

## 2. Remake mismatch and change

The remake's error screen BACK for a load ran `closeMenu()`. That calls `leaveDiskMenu()` (the eclipse tile exchange, `exchangeTiles`, when the eclipse byte is set) and sets stage `map`. So a refused load could exit the disk menu and change the map, which the original never does on a refusal. This is a real mismatch (VERIFIED against the static route above. The test counts the `leaveDiskMenu()` calls; the exchange itself happens only when the eclipse byte is set, which the test does not set).

| File | Change |
|---|---|
| `src/game/game.ts` `openSlotErrorMenu` | BACK is `BACK TO DISK MENU` for a save and a load alike. The conditional `BACK TO GAME` label is gone. |
| `src/game/game.ts` `sloterror` action 3 | `openDiskMenu()` for both operations. The load no longer calls `closeMenu()`. |
| `test/save.mjs` | Existing expectations now read `BACK TO DISK MENU` and return to the loop (corrupt, empty). New section "Load refusals and their BACK": corrupt (BACK), unsupported-version (RETRY fails again, BACK), empty (RETRY still empty, BACK, then EXIT). A counter on `sim.leaveDiskMenu` shows no refusal runs the exit effect and EXIT runs it exactly once. |
| `test/game-over.mjs` | The non-game-over load error reads `BACK TO DISK MENU` and returns to the loop, not the map. |
| `notes/formats/game-proper.md` | New "Load failure and return" entry, with the static trace above. |
| `notes/formats/remake-save.md` | The error-action paragraph names the `BACK TO DISK MENU` route for both operations. |

Menu-origin load errors only: the remake's load page is opened only from the disk icon and the remake submenu, both disk-menu entries. Typed error reporting (codes, messages, RETRY, CHOOSE ANOTHER SLOT, DISK MENU, right click) is unchanged.

## 3. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/save.mjs` | exit 0, 395 `ok`, 0 `FAIL` (was 385) |
| `node test/game-over.mjs` | exit 0, 50 `ok`, 0 `FAIL` |
| `node test/disk-menu-keys.mjs` | exit 0, 41 `ok`, 0 `FAIL` |
| `node test/disk-menu.mjs` | exit 0, 107 `ok`, 0 `FAIL` |
| Mutant: BACK route for a load put back to `closeMenu()` in `dist/game/game.js` | `test/save.mjs` exit 1, 6 `FAIL`, all the new load-BACK checks and the save-BACK check that shares the route; `test/game-over.mjs` exit 1, 1 `FAIL`. `dist` rebuilt, both exit 0 |
| `npm test` (full chain) | exit 0, 4,748 `ok`, 0 `FAIL` (the previous handoff recorded 4,738) |

Not verified: no emulator or original-screen comparison of the disk-menu picture after a refused load. The original's empty refusal keeps the list rows, and the remake's error screen draws none.

## 4. Open points (not changed)

1. **Empty-refusal picture.** The original keeps mode 2 and the list rows after `$143`; the remake's BACK shows the loop without the list. Not compared with a capture.
2. **Corrupt and unsupported records.** The original loads any record past the empty test (no traced check). The remake's refusal is its own choice. What the original does with a damaged record is a HYPOTHESIS and needs an emulator run with a bad save.
3. **Scenario-disk swap in the load.** `$8A5A`'s loop has no remake counterpart. The remake loads from its own files.
4. **`$145` and `$143` text.** The indexes are the original's; the remake's loaded and empty texts are its own and were not compared.
5. **Address mapping in `tools/game_img.py`.** Its `BASE 0x1000`, file range `$26000` mapping gives different bytes at `$8828` from the `+$28800` mapping used by `key_reach.py`, `rng_call_sites.py` and this handoff. The `+$28800` mapping gives coherent code at `$7EF6`, `$85FE` and `$8828` (the `$8CB0` countdown, the `$8462` message call, the `$8CFE` row). The tool's mapping was not changed; it should be reconciled before its output is trusted for these routines.
6. Open point 2 of [HANDOFF-2026-11-14-save-return.md](HANDOFF-2026-11-14-save-return.md) is answered by this handoff. Other points there are unchanged.
