# Utopia handoff: a successful save from the scenario list returns to the list (2026-11-14, mode-3 save-return slice)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal`; no orchestration tool was called, so that routing is not confirmed and no model switch is claimed. No emulator run; no writes under `original/` (Disk.1 was only read); nothing committed, pushed, reset or cleaned. Scratch files were kept outside the repository (`C:\Users\Caldor\.claude-nt\projects\C--LLM-remake-Utopia\scratch\`). The working tree was already dirty when the slice started; no existing change was reverted.
> **CORRECTED 2026-11-14 (superseded by [HANDOFF-2026-11-14-mode3-save-page.md](HANDOFF-2026-11-14-mode3-save-page.md), itself superseded in part by [HANDOFF-2026-11-14-save-page-release.md](HANDOFF-2026-11-14-save-page-release.md)).** The claim that a list-origin save returns to the scenario list, and the section 2 change and section 5 limitation 1 that followed it, were contradictory with the raw trace and are withdrawn. Icon 1 (`$856C` `$85B8`) draws the list through `$85CA` and sets `$938D` = 1; the success tail `$89B4` keeps that mode-1 save list up with `$141` on its prompt. The remake now keeps the save page up with `$141` as its status line, and its BACK restores the scenario list. The §1 raw-trace facts (no `$82B8`, `$141` persists, the only exit is EXIT) still hold.

Read first: [formats/game-proper.md](formats/game-proper.md) "Save tail and return" and "Mode-3 icons 0 and 1"; [HANDOFF-2026-11-14-mode3-pages.md](HANDOFF-2026-11-14-mode3-pages.md) (limitation 2, superseded in part here).

## 1. Result

- **Raw Disk.1 recheck (STATIC, file offset = address + `$28800`, `tools/game_dis.py`).** `$7FD8` `bmi.w $7ef6` (no row), `$7FDC` `bsr.w $87dc`, `$7FE0` `bra.w $7ef6`. `$89B4` `bsr.w $84f4` (erases the prompt), the header record and slot (`$7D88`), `$140` then `$141` on the list prompt (`$8462`, d1 = 0), `$8A38` `move.w #-1,$8cfe`, `$8A40` `rts`. The success path makes no `$82B8` call, so the list stays up with `$141` on its prompt, and the only way out is EXIT (icon 5). Scanning the whole image confirms `$7FDC` is the only `bsr`/`jsr` to `$87DC`.
- **A successful save started from the scenario list now returns to the list** (remake, as requested for this slice): the list comes back with `$141` on its prompt, the held scene is unchanged, the hover is cleared as a fresh open clears it, and EXIT enters the held scene. Saves from the picture still return to the picture with `$141`.
- **Slot contents** are unchanged: the save still writes the held session under its own scenario index (test: slot 2 holds scenario 1 while the live map is 0).

## 2. Change

- `src/game/game.ts` `returnFromSave()`: reads `pageReturn` before `openDiskMenu()` clears it; when `pageReturn.list` is set it reopens the scenario list (`openScenarioList(names, false)`) and calls `syncDiskStage()`; then it prints `SAVE_DONE_STRING` on the prompt in both cases. The `rememberPicture` / `leaveDiskPage` BACK path is unchanged.
- The remake submenu's SAVE GAME opens its page without `rememberPicture` (the submenu is reached from the picture), so it still returns to the picture. The boot list's icon 1 goes through `rememberPicture`, so a boot-held save returns to the boot list.
- Notes: `formats/game-proper.md` (save-tail remake paragraph, mode-1 list paragraph, the remake paragraph after "Mode-3 icons 0 and 1"); `formats/remake-save.md` (RETRY and success paragraph); this handoff; `HANDOFF-2026-11-14-mode3-pages.md` (limitation 2 superseded); `notes/README.md` index.

## 3. Tests

- `test/scenario-icons.mjs` section 4: a list-origin save returns to the list with `$141` (stage `scenario`, ten rows, hover -1); the prompt persists through idle frames; a list-origin save to slot 2 then EXIT enters the held scene (scenario 1, not the live map); a row pick after a list-origin save holds the new scene and shows `$8B`; a picture-origin save to slot 8 returns to the picture with `$141` and writes the live map's scenario 0. The old assertion (a list-origin save returns to the picture) is replaced. 46 checks.
- `test/disk-menu-keys.mjs` 4i: the held save from the list returns to the list with `promptIndex` `$141`; the EXIT check that follows is unchanged. 44 checks.
- `test/boot-menu.mjs` section 8: the boot list's held save returns to the boot list with `$141`. 66 checks.
- Picture-origin save success is still pinned by `disk-menu-keys.mjs` 4e and 4h (stage `disk`).

Mutant check: `returnFromSave` with the list branch disabled (`if (false && back?.list)`), built into `dist/`: `scenario-icons` 5 `FAIL`, `disk-menu-keys` 1 `FAIL`, `boot-menu` 1 `FAIL`. The source was restored from a saved copy, rebuilt, and the list branch confirmed present.

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` (tsc) | exit 0 |
| `scenario-icons.mjs` / `disk-menu-keys.mjs` / `boot-menu.mjs` / `scenario-pick.mjs` / `scenario-wait.mjs` / `scenario-list.mjs` / `game-over.mjs` / `disk-menu.mjs` / `save.mjs` | exit 0 each; 46 / 44 / 66 / 58 / 22 / 31 / 52 / 108 / 404 `ok` lines, no `FAIL` |
| `npm test` | see the final report of this slice |

No emulator or original-screen comparison was run, so the on-screen result (prompt line position, the rows drawn) is not compared with the original.

## 5. Limitations

1. **The list is a remake choice, not the traced list.** Icon 1 from the scenario list sets the original's mode to 1 (`$85CA` with `$938D` = 1, no `$82B8`), so the original's list after the save is its mode-1 save list (the slot rows), not the scenario list. The remake's page draws no save rows and the returned list shows the scenario rows. The `$141` and the list-stays-up part follow the trace; the list kind does not.
2. **The disk check is not modelled** (as before): `$855A` and its wrong-disk refusals do not happen.
3. **The hover row is not carried across the save.** `$8CFE` is -1 after `$8A38`, which matches; the remake recomputes the hover from the pointer on the next frame.
4. **The held prompt is not restored after the save.** The list's own `$141` replaces it; if the list later closes (music list, format), the existing `listClosed` rule prints the held `$8B` again, as after a BACK.
5. **Save fidelity** is as in `formats/remake-save.md`; a held save is a remake adaptation (the original would ask for a save disk).

## 6. Next

- A capture of the original's mode-1 list after a save (rows and the prompt line) would settle whether the scenario list is the right remake return or whether the save list should be shown.
