# Utopia handoff: a save started from the scenario list keeps the save page with `$141` (2026-11-14, mode-3 save-page slice)

> **CORRECTED 2026-11-14 (superseded in part by [HANDOFF-2026-11-14-save-page-release.md](HANDOFF-2026-11-14-save-page-release.md)).** Limitation 3 (BACK restores the pre-save `$8B`) and limitation 4 (the save row chose on the press) are fixed there: a save keeps the save page for every origin, BACK shows `$141` and not the erased `$8B`, and a row is chosen on its release with the press-latched row. Section 2's "picture-origin save still returns to the picture" and limitation 2 are reversed: a picture-origin save now keeps the save page too. Sections 1 and 3's trace facts still hold.

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal`; no orchestration tool was called, so that routing is not confirmed and no model switch is claimed. No emulator run; no writes under `original/` (Disk.1 was only read through `tools/game_dis.py`); nothing committed, pushed, reset or cleaned. The working tree was already dirty when the slice started; no existing change was reverted.

Supersedes the list-return claims in [HANDOFF-2026-11-14-mode3-save-return.md](HANDOFF-2026-11-14-mode3-save-return.md) (corrected there) and the list-return sentence in [HANDOFF-2026-11-14-mode3-pages.md](HANDOFF-2026-11-14-mode3-pages.md).

## 1. What the original does (STATIC, Disk.1 raw bytes, file offset = address + `$28800`)

Checked with `tools/game_dis.py` and raw byte reads.

- **Icon 1 (`$856C`) with the list open.** Game-over check `$8574`, then the disk check `$855A` with `$135`. On d0 = 1 (`$85B8`): `$138` on the prompt, `bsr $85CA` (the ten records as rows, prompt `$138`), then `move.b #1,$938d` (`$85BE`) and `bra $7EF6`. Mode 1 is the save list. `$85CA` is the same row routine the scenario list uses (`$865A`), with the save prompt.
- **Name entry and success tail (`$8918`-`$8A40`).** `$8958`-`$896E`: a click (`$2E52`, `bra $89b4`) or Return (`$8974` -> `$84F4`, `$826E`, `$142`, `$5110`, then `$89B4`). `$89B4` `bsr $84f4` erases the prompt, the header and the slot record are written (`$7D88`), `$140` is printed on the prompt, then `$141` (`$8462`, d1 = 0), `$8A38` sets the row to -1, `$8A40` `rts`.
- **Consequences (VERIFIED static).** The success tail makes no `$82B8` call and no `$938D` write, so the list stays up in mode 1 and `$141` is on its prompt. Its next erase is by a later `$84F4` or `$82B8`; the tail does not erase it. Only EXIT (`$802C`, icon 5) leaves the loop, as before.
- **Which mode is active after the save:** mode 1, the save list (the records with `$138`-then-`$141`). It is not the scenario list (mode 3). The earlier handoff's claim that it returns to the scenario list was wrong about the list kind; its raw-trace facts were right.

## 2. Change

- `src/game/game.ts` `returnFromSave()`: when `pageReturn.list` is set (icon 1 started from the open scenario list, or the boot list), the save page is reopened (`openMenu("save", SAVE_TITLE, slotLabels())`, so slot 1-10 labels show the write) with `$141` as its status line (`MenuScene.setPrompt(strings.get(SAVE_DONE_STRING))`). `pageReturn` is kept, so the page's BACK still reaches the list. Picture-origin saves are unchanged (`openDiskMenu()`, `printPrompt($141)`).
- Unchanged: `leaveDiskPage` (the BACK path) restores the scenario list with its prompt (`$8B` after a pick, `$13D` after the open) and the held scene. EXIT enters the held scene only from the list (the save page has no icon 5). A retry from the error page goes through `returnFromSave` too, so it lands on the same page.
- Comments and notes updated: `formats/game-proper.md` (save tail, mode-1 list paragraph, mode-3 remake paragraph), `formats/remake-save.md` (RETRY line), `HANDOFF-2026-11-14-mode3-pages.md` (line 73), `HANDOFF-2026-11-14-mode3-save-return.md` (correction banner), `notes/README.md` index.

## 3. Regressions

The four distinctions the brief asked for:

- **Scenario list vs save list:** after a list-origin save, `game.stage === "save"`, `game.diskMenu === null`, and the page is a `MenuScene` (`test/scenario-icons.mjs` section 4).
- **Prompt lifetime:** the `$141` status codes stay on the save page through idle frames; a second save from the page keeps the page with `$141`.
- **Slot data:** slot 1's label changes after the write, and the slot holds the held session (scenario 1, not the live map's 0).
- **BACK:** the page's right click restores the scenario list (stage `scenario`, `$8B` prompt, held scene 1, live map unchanged); a row pick after that works as before.
- **Final EXIT / held scene:** EXIT on the restored list enters the held scene (scenario 1, not the live map). `test/disk-menu-keys.mjs` 4i checks the same route with the `$141`/`$8B` split and BACK before EXIT; `test/boot-menu.mjs` section 8 checks the boot-list origin (save page with `$141`, BACK to the boot list with `$8B`, the held scene kept).
- Picture-origin save still returns to the picture with `$141` (existing check).

Mutant check: the `returnFromSave` list branch disabled in the built `dist/game/game.js` (line 885 `if (false && back?.list)`): `scenario-icons` 1 `FAIL`, `disk-menu-keys` 6 `FAIL`, `boot-menu` 6 `FAIL`. The file was restored from a saved copy (`diff` clean) and the build is current.

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` (tsc) | exit 0 |
| `scenario-icons` / `disk-menu-keys` / `boot-menu` / `save` / `scenario-pick` / `scenario-wait` / `scenario-list` / `game-over` / `disk-menu` / `game-music` | exit 0 each; 48 / 45 / 67 / 404 / 58 / 22 / 31 / 52 / 108 / 86 `ok` lines, no `FAIL` |
| `npm test` | exit 0; about 4950 `ok` lines, no `FAIL`; the optional external capture comparisons were skipped (`UTOPIA_SITE_CAPTURE` not set) |

No emulator or original-screen comparison was run, so the on-screen result (status line position, slot-row layout) is not compared with the original.

## 5. Limitations

1. **The save page is a remake stand-in for the original's mode-1 save list.** The original draws ten record rows with `$138`/`$141` on the prompt; the remake's page draws slot labels with a status line under the entries. The layout is a remake choice.
2. **The picture-origin case is still a remake choice.** Icon 1 from the picture also ends in the original's mode-1 save list (the same `$85CA` then `$89B4` path), but the remake returns to the bare picture with `$141`. Changing it would need the same save-page treatment; not done here, as the brief covered the scenario list.
3. **BACK restores the pre-save prompt (`$8B`).** The original's `$84F4` erases the `$8B` line on the save path, so the remake's restored list shows a prompt the original would no longer show. This is the brief's "preserve the scenario list after BACK", not a traced state.
4. **The save page's pick is on press** (`MenuScene.update`), while the original's row pick is on the release (`$2E52`). Not changed here; the save page predates this slice.
5. **Save fidelity** is as in `formats/remake-save.md`; a held save is a remake adaptation (the original would ask for a save disk, `$855A`).

## 6. Next

- A capture of the original's mode-1 list after a save (the row layout, the `$141` line, and whether EXIT from it shows any other line) would settle limitations 1 and 3.
- If the user wants picture-origin saves to match the original's mode-1 list, extend `rememberPicture`/`returnFromSave` to the picture case (one-line change plus test updates in `test/disk-menu-keys.mjs` 4e/4h and `test/scenario-icons.mjs` section 4).
