# Utopia handoff: mode-3 icons 0 and 1, their pages and the right button (2026-11-14, third slice)

> **Superseded in part (2026-11-14, save-page release slice, [HANDOFF-2026-11-14-save-page-release.md](HANDOFF-2026-11-14-save-page-release.md)).** A save from the picture no longer returns to the bare picture: it keeps the save page with `$141`, and BACK goes to the picture with `$141` (limitation 2 and the picture-origin sentences below are out of date). A list-origin BACK after a save shows `$141`, not `$8B`. The load page is unchanged.

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal`; no orchestration tool was called, so that routing is not confirmed and no model switch is claimed. No emulator run; no writes under `original/` (Disk.1 and Disk.2 were only read); nothing committed, pushed, reset or cleaned. Scratch scripts were kept outside the repository (`C:\Users\Caldor\.claude-nt\projects\C--LLM-remake-Utopia\scratch\`). The working tree was already dirty when the slice started; no existing change was reverted.

Read first: [formats/game-proper.md](formats/game-proper.md) "Mode-3 icons" and its "Mode-3 icons 0 and 1" block, and [HANDOFF-2026-11-14-scenario-rows.md](HANDOFF-2026-11-14-scenario-rows.md) (superseded in part, see below).

## 1. Result

- **Icon 0 (LOAD) and icon 1 (SAVE) from mode 3 are traced to their submenus, error paths and returns.** The disk check `$855A`/`$841E` returns 1 (save disk), 2 (scenario disk) or -1 (no Utopia header). Icon 0 proceeds only with 1; icon 1 refuses 2 with `$133`, proceeds with 1 and refuses the rest with `$137`/`$139`. Every refusal closes the list (`$82B8`). Game over (`$156AA` bit 3) on icon 1 prints `$18A` and closes the list (`$8592`). The remake has no floppy, so the disk check itself is not reproduced; its page opens without it.
- **Right button on the mode-3 loop is a no-op.** `$50B2` sets bit 6 of `$156A8` while the right button is held, and `$7F80` skips the press and release path; nothing else reads it. The remake's scenario list now ignores a right click (`DiskMenuScene.update`). The picture's right click (the REMAKE MENU, remake-only) is unchanged.
- **A load or save page's BACK returns to the list it replaced** (remake choice, `Game.rememberPicture` / `Game.leaveDiskPage`): the list comes back with its prompt (`$8B` after a pick, `$13D` after the open) and the held scene. The error page's `BACK TO DISK MENU` does the same; its `DISK MENU` and right click go to the picture. A page opened from the picture still returns to the picture.
- **SAVE with a held scene saves the held session** (remake adaptation, `Game.saveToSlot` / `saveRefusal`). The held scene is what the original's RAM holds at that point; the old code refused it or, in the save path, would have used the live map. Now the held scene is written under its own scenario index. A held Disk.4 continuation and a held game over are still refused. The REMAKE MENU's SAVE GAME is enabled for a held scene.
- **EMPTY record rows are refused in mode 3** (`Game.pickScenario`, `$143` on the list prompt, nothing picked, the list and the held scene kept). The `EMPT`/`Y` check runs before the mode test in `$87DC`, so the earlier note saying the scenario pick has no empty-slot check was wrong. The supplied Disk.2 has no EMPTY record, so the refusal is checked on a synthetic one.
- **Not claimed:** pixel agreement with the original (no capture); what the original does after a successful mode-1 save (see limitations).

## 2. Static evidence (Disk.1 raw bytes; file offset = address + `$28800`; listings checked with `tools/game_dis.py` and raw byte reads)

| Point | Evidence |
|---|---|
| Disk check `$855A` | `$2E48` wait, `$84F4`, `$841E`. `$841E` reads header `$3C0` into `$8F8C`; `UTOP` `$55544F50` required; then `SCEN` `$5343454E` -> d0 2; `SAVE` `$53415645` -> d0 1; otherwise -1; a read error keeps the negative status (`$8430`-`$845E`). |
| Icon 0 `$85FE` | `$135`, `$855A`; `cmpi.w #1,d0`; `beq $8620` (`$13A`, `$85CA`, `$938D` = 2 at `$8626`); else `$137`, d1 `$136`, `$83A2`, `$82B8`, `bra $7EF6`. |
| Icon 1 `$856C` | `btst #3 $156AA`: set -> `$18A`, d1 0, `bra $8592` = `$83A2`, `$82B8`, `bra $7EF6` (`$8576`-`$8596`). Clear -> `$135`, `$855A`; d0 2 -> `$133`/`$136`, `$82B8` (`$8584`-`$859A`); d0 1 -> `$138` (`$85CA`), `$938D` = 1 at `$85BE`; other -> `$137`/`$139`, `$82B8`. |
| Mode-1 pick `$8918` | Prompt `$13E`/`$13F`; the name entry; `$8F96 + n*$40` record; prints `$140`/`$141`; ends `move.w #-1,$8CFE`, `rts` (`$8A38`-`$8A40`). No `$82B8` call in the range, so the list stays open (mode 1). |
| Mode-2 pick `$8828` and the EMPT check | `$87DC`: `$938D` 4 -> `$8A42`, 1 -> `$8918`; then `$8F96 + $8CFE*$40`: `cmpi.l #"EMPT"` and `cmpi.w #$5900,4` -> `$143` (`$8462`) and `rts` (`$8804`-`$8818`). This runs before `cmpi.b #2` (`$8820`), so modes 2 and 3 share it. |
| Right button `$50B2` | `btst.b #2,$dff016` (right button); `$5104` `bset #6 $156A8` while held; `$7F80` `btst #6` / `bne $7EF6` skips the press and release path. `$7F72` `bsr $8132` (hover) runs before `$50B2`, so hover still follows the pointer. |

## 3. Change

- `src/game/disk-menu.ts`: a right click does nothing on the scenario list (`update`; `DiskListKind` unchanged); `promptIndex` getter (the string index on the prompt's first line); comments updated.
- `src/game/game.ts`:
  - `SaveRefusal` loses `exit-first`; `saveRefusal()` checks the held scene (held Disk.4 -> `disk4`, held game over -> `game-over`, else allowed).
  - `saveToSlot` takes the held scene's map and index when one is held.
  - `diskIcon`: icon 0 and icon 1 call `rememberPicture()` before the page opens; icon 1's game over prints `$18A` and closes the list; a held Disk.4 save keeps its note.
  - `pageReturn` (new field) and `leaveDiskPage()`: the page's BACK (load and save right click, and the error page's `BACK TO DISK MENU`) restores the list and the held prompt. `openDiskMenu` clears `pageReturn`.
  - `pickScenario`: an `EMPTY` record prints `$143` and picks nothing (`isEmptyRecord`, `EMPTY_RECORD_STRING`).
  - `openSlotErrorMenu` comment updated; the sloterror `DISK MENU` action stays on the picture.
- Tests (all passing, see section 4):
  - `test/scenario-icons.mjs`: icon 1 with a held scene opens the save page; the slot reloads to the held cells (which differ from the live map's); the save page's and load page's BACK restore the list, prompt and held scene; a row pick works after BACK; the error page's BACK and DISK MENU; a picture-origin load page returns to the picture; icon 1 under game over closes the list (`$18A`). 39 checks.
  - `test/scenario-pick.mjs`: section 4 rewritten (right click is a no-op on the list; the remake submenu is reached from the picture after icon 3); section 12 (EMPTY row, with and without a held scene; nothing runs). 58 checks.
  - `test/boot-menu.mjs` section 8: a boot-held scene is saved to slot 1 before any map exists; BACK from the save page returns to the boot list; the remake submenu offers SAVE GAME; the right click on the boot list does nothing.
  - `test/game-over.mjs`: the right click on the list is a no-op; a held scene is saved (not refused); BACK from the save page returns to the list.
  - `test/disk-menu-keys.mjs`: 4c (the right click on the list keeps P), 4i (held save opens the page; the page writes the held index).
  - `test/save.mjs`: the held remake submenu offers SAVE GAME; the in-game scenario pick's right click is a no-op.
  - `test/game-music.mjs`: right click on the scenario list is a no-op (two checks).
- Notes: `formats/game-proper.md` (Mode-3 icons table rows 0 and 1, the new "Mode-3 icons 0 and 1" block, the boot-save paragraph, the scenario rows' EMPT claim, the right-click paragraph, the held-prompt bullet); `formats/remake-save.md` (BACK to the list, held-scene save); `formats/music.md` (right-button affordance); `README.md` (held scene in the remake save sentence); `notes/README.md` index; `HANDOFF-2026-11-14-scenario-rows.md` (superseded pointer).

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (after the last edit) |
| `node test/scenario-list.mjs` | all checks pass (31 ok) |
| `node test/scenario-pick.mjs` | all checks pass (58 ok) |
| `node test/scenario-wait.mjs` | all checks pass (22 ok) |
| `node test/scenario-icons.mjs` | all checks pass (39 ok) |
| `node test/disk-menu.mjs` | all checks pass (108 ok) |
| `node test/disk-menu-keys.mjs` (44 ok), `save.mjs` (404 ok), `game-music.mjs` (86 ok), `boot-menu.mjs` (66 ok), `game-over.mjs` (52 ok); `button-sound.mjs`, `music-select.mjs` | exit 0 each |
| `npm test` (full chain, after the last edit) | exit 0, 4939 `ok` lines, 0 `FAIL` lines; the optional construction-site capture skipped (its environment variable not set) |

Mutation checks (compiled `dist/`, one change at a time, restored afterwards; the runner is outside the repository):

| Mutant | Killed by |
|---|---|
| a right click on the scenario list closes it | `scenario-pick.mjs`, `scenario-icons.mjs`, `boot-menu.mjs`, `game-music.mjs` (`scenario-icons.mjs` does not test the right click itself) |
| a held save writes the live map | `scenario-icons.mjs`, `boot-menu.mjs` (`disk-menu-keys.mjs` checks the index only, which is what it is for) |
| a held save writes the live scenario index | `scenario-icons.mjs`, `disk-menu-keys.mjs` |
| a load or save page's BACK does not restore the list | `scenario-icons.mjs` (6 checks) |
| the EMPTY row refusal is removed | `scenario-pick.mjs` (section 12) |

## 5. Limitations

1. **The disk check is not modelled.** The remake's load and save pages open without `$855A`, so the original's wrong-disk and scenario-disk refusals (`$137`, `$133`) do not happen. A floppy-based check would need a disk, which the remake does not have.
2. **A successful mode-1 save does not keep the list (superseded in part by [HANDOFF-2026-11-14-mode3-save-return.md](HANDOFF-2026-11-14-mode3-save-return.md)).** The original's traced path ends in `$8CFE` := -1 and `rts`, with the save list still up and `$141` on the prompt. A save started from the scenario list now stays on the save page with `$141` as its status line (superseded again by [HANDOFF-2026-11-14-mode3-save-page.md](HANDOFF-2026-11-14-mode3-save-page.md): the original's list after the save is its mode-1 save list, and the page stands in for it). A save from the picture still returns to the picture with `$141`, as before.
3. **The hover row is not carried across a page.** The original's `$8CFE` survives until the next `$8132` poll; the remake recomputes the hover from the pointer on the next frame, which is what `$8132` does anyway. "Selection" is therefore the held scene and the prompt.
4. **The right click on the music list still closes it.** The trace gives no right-button route in that loop either, so this is probably a remake convenience that should match the scenario list. It is not changed because the brief covered mode 3 only; the music test (`test/disk-menu.mjs`, `game-music.mjs`) pins the current behaviour.
5. **A held save is a remake adaptation.** The original would ask for a save disk (`$855A`). The slot holds the held session's state (checked by the cell comparison in `scenario-icons.mjs`), but the save format does not record a pending first pass; a load of a held save re-arms that pass at EXIT (`enterHeldScene`), as a load does. Save-format fidelity is as in `remake-save.md`.
6. **The EMPTY refusal is synthetic-tested.** No supplied record is EMPTY, so the check runs on a record renamed in the test.
7. **The `$143` prompt replaces a held `$8B` on the list prompt**; the held prompt itself is kept for the next rebuild (`heldPrompt`), as the original would redraw the prompt on the next pick. Not traced beyond `$8462`.

## 6. Next

- A capture of the original's mode-3 list and its load and save lists (hover, prompt, erase pixels) would settle the rows, prompts and the mode-1 list after a save.
- Decide whether the music list's right click should follow the scenario list (limitation 4).
