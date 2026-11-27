# Utopia handoff: the scenario list's rows and mode-3 icons (2026-11-14, rows slice and icons follow-up)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal`; no orchestration tool was called in either slice, so that routing is not confirmed and no model switch is claimed. No emulator run, no writes under `original/` (the Disk.1 and Disk.2 files were only read), nothing committed, pushed, reset or cleaned. Scratch scripts were kept outside the repository (temp directory).

Superseded in part by [HANDOFF-2026-11-14-mode3-pages.md](HANDOFF-2026-11-14-mode3-pages.md) (third slice): a right click on the scenario list is a no-op (section 1 below and the icon 1 row), icon 1 with a held scene saves the held session, the load and save pages' BACK returns to the list (limitations 2 and 5), and the mode-3 row pick refuses an EMPTY record. The statements below about those points are historical.

Read first: [formats/game-proper.md](formats/game-proper.md) "Scenario list and the held prompt", its "Mode-3 icons" table and its "Scenario list rows" block, and [HANDOFF-2026-11-14-scenario-page-exit.md](HANDOFF-2026-11-14-scenario-page-exit.md) (the release and EXIT model the list keeps).

## 1. Result

- **The list is the disk picture's own mode-3 list.** It is drawn by `DiskMenuScene` (`openScenarioList`), not by a separate `MenuScene` page, so the nine icons are live while it is open. `Game.stage` is `scenario` while the list is open on the disk scene, and `disk` otherwise.
- **Icon 5 (EXIT, `$802C`) is the list's exit.** The remake's EXIT row (row 10) is removed; the ten rows keep their geometry and hit targets (x `$38..$88`, y `$20 + 9n`, row 9 ends at y `$79`, nothing below row 9 picks). With a held scene, icon 5 enters it directly with its one first pass, and the list is gone. With nothing held, the boot session refuses with the remake note on the result line, and the game proper closes the menus to the map. Game over refuses silently and the list stays.
- **Every icon was traced against its raw handler** (table in game-proper.md "Mode-3 icons"). Icons 3 (format), 4 (music on/off), 6 (tutorial), 7 (music select) and 8 (effects) act on the list as traced. Icon 3 closes the list, as its handler's `$82B8` exits do. Icon 2 runs the traced `$13B` wait and reopens the list. Icons 0 and 1 open the remake's own load and save pages, which replace the list as the original's `$938D` writes do. Icon 1 with a held scene is refused with a remake note, a remake choice (the original would ask for a save disk there).
- **Music list rows are now erased too.** `$1006` calls `$539E` (the `$51E6` erase, then the text) for all ten rows, so the blank rows 4-9 are erased as the scenario rows are. This changes the music list's pixels in those blank bands (the previous remake drew nothing there). `test/disk-menu.mjs` asserts the traced erase model for them.
- **Not claimed:** pixel agreement with the original screen (no capture), the hover order against the text, the format's floppy behaviour, and the save and load pages' contents.

## 2. Static evidence (Disk.1 raw bytes; file offset = address + `$28800`; checked with `tools/game_dis.py`)

| Point | Evidence |
|---|---|
| The press and release path has no mode test | `$7F8C` `btst #3,$156A8`; press `$7FA8` `$5730` (hit test on `$8CB4`, no `$938D` read); release `$7F96` `tst.w $5DD4`, `$59C8`, `bra $7FE4`; dispatch `$7FE4` compares d2 with 5, 3, 1, 2, 0, 6, 7, 4, 8 (`beq`). |
| Icon 5 is EXIT | `$7FE8` `cmpi.b #5,d2` / `beq $802C`. `$802C`: `btst.b #3,$156AA` (game over: `bne $7EF6`), `$144BB` check, then the map return. It writes no `$938D`. |
| Mode writes | `$85BE` `move.b #1` (save), `$8626` `move.b #2` (load), `$8662` `move.b #3` (scenario, after `$865A`'s `$85CA`), `$80CC` `move.b #3` (tutorial), `$1056` `move.b #4` (music select). |
| Format `$8314` closes the list | `bsr $82b8` at `$834E`, `$8376`, `$839A`, each followed by `bra $7EF6`. It writes no `$938D`. |
| Music on/off `$1062` and effects `$10BC` | Result line only (`bsr $83a2`), then `bra $7EF6`. No mode write, no `$82B8`. |
| Music select `$1006` | `bsr $82b8` first (`$1006`), then the prompt `$190` (`$8462`) and the rows (`$539E` per row, `$103A`), then `move.b #4`. |
| Tutorial `$80C8` | `$84F4`, `move.b #3,$938D`, `$8A5A`, `$84F4`, `$8462` `$191`, `$866E`, `$8B02`, `$8462` `$8B`, `bset #7/#2`, money, `bra $802C` (`$812E`). |
| Entering the disk menu clears the mode | `$7E52` calls `bsr $82b8` at `$7EE2`, before the loop `$7EF6`. So a stale mode 3 cannot reach a later disk menu. |
| List rows (earlier slice) | `$865A`-`$8662` (`$13D`, `$85CA`, `move.b #3`), `$85D0`-`$85F8` (ten rows, x `$3A`, pitch 9, `$539E`), `$51E6` (11-byte, 6-scanline erase). Records: header sector `$3C0`, record n at `$8F96 + n*$40`. |

## 3. Change

- `src/game/disk-menu.ts`: `DiskListKind` (`closed` | `music` | `scenario`); `DiskMenuScene.openScenarioList(names, pressPending)` (prints `$13D`, rows = record names, at most ten; `pressPending` clears the down latch so a press still held at the first update is a press); `listKind`, `listRows`, `promptCodes`, `infoCodes` getters; `DiskMenuResult` gains `{kind: "scenario", index}` (a row release; the list stays open); `drawRows` draws each row as `$539E` does (erase, bar, text); `DISK_LIST_GEOMETRY` (moved here from `menu.ts`).
- `src/game/menu.ts`: the `diskList`, `activateOnRelease` and `pressPending` options and the list layout are removed; `MenuScene` is the remake's own pages only (no options argument).
- `src/game/game.ts`:
  - `openScenarioList(pressPending)` (was `openScenarioMenu`): `heldPrompt` cleared, the disk scene opens the list; the remake submenu's NEW SCENARIO opens the disk picture with the list and `pressPending` false.
  - `pickScenario(index)` (was `pickScenarioFromPage`): holds the scene, prints `$8B` on the list prompt.
  - `handleDiskMenu`: handles `scenario`, `listClosed` (the held `$8B` is reprinted, as the old page's right click did) and syncs the stage (`syncDiskStage`: `scenario` while the list is open, `disk` otherwise, only while the disk picture is shown).
  - `diskIcon` format: `heldPrompt` cleared and `closeList()` before the remake note.
  - `SCENARIO_EXIT_LABEL` removed; the `scenario` stage's `MenuScene` case removed; `case "scenario"` shares the disk handler.
- `src/game/game.ts` exit and screen: the screen getter and the immediate-pass check treat `scenario` like `disk`.
- Tests:
  - `test/scenario-list.mjs` (rewritten on `DiskMenuScene`; 31 checks): names against raw Disk.2 bytes, geometry, hit targets (no EXIT row; nothing below row 9), a seven-name list, the game flow, the pixel rows against the independent glyph decode, prompt, hover.
  - `test/scenario-pick.mjs` (rewritten assertions; 52 checks): picks, prompt lifetime, right click, load pick, EXIT with pass counts, boot note on the result line, game over. Section 10 now expects the EXIT update to run the map's one pass, as the disk menu's icon exit does (`test/save.mjs` in-game icon exit).
  - `test/scenario-wait.mjs` (22 checks): the wait, the pending press, the first poll, the result-line countdown, the last-pick EXIT through icon 5.
  - `test/scenario-icons.mjs` (new, 27 checks, in the `npm test` chain after `scenario-wait.mjs`): icons 0-8 with the list open, icon 5 with and without a held scene, boot and game over, a press on icon 5 released over a row.
  - `test/disk-menu.mjs`: the blank rows 4-9 carry the traced erase model.
  - `test/boot-menu.mjs`, `test/game-over.mjs`, `test/game-music.mjs`, `test/save.mjs`, `test/disk-menu-keys.mjs`: the scenario page's accessors moved to the list (`game.diskMenu.listKind`, `promptCodes`). `test/game-over.mjs` now expects the `$18A` result line from before the list to survive the list's open and close (`$82B8` erases prompt lines only, never result lines); the old expectation was the page's result-line loss, not the original's behaviour.

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/scenario-list.mjs` | all checks pass (31 ok) |
| `node test/scenario-pick.mjs` | all checks pass (52 ok) |
| `node test/scenario-wait.mjs` | all checks pass (22 ok) |
| `node test/scenario-icons.mjs` | all checks pass (27 ok) |
| `node test/disk-menu.mjs` | all checks pass (108 ok, the blank-row check updated) |
| `node test/boot-menu.mjs`, `game-over.mjs`, `game-music.mjs`, `save.mjs`, `disk-menu-keys.mjs` | exit 0 each |
| `npm test` (full chain, after the last edit) | exit 0, 4915 `ok` lines, 0 `FAIL` lines; the optional pixel and construction-site captures skipped (their environment variables not set) |

Mutation check (the compiled `dist/`, one line patched at a time, restored afterwards; the runner is kept outside the repository):

| Mutant | Killed by |
|---|---|
| a row release closes the scenario list | `scenario-pick.mjs`, `scenario-icons.mjs`, `scenario-list.mjs` |
| icon 2's wait does not carry the pending press into the list | `scenario-wait.mjs`, `boot-menu.mjs` |
| icon 5 does nothing while the list is open | `scenario-pick.mjs`, `scenario-icons.mjs`, `scenario-wait.mjs` |
| a right click on the list does not reprint the held `$8B` | `scenario-pick.mjs` |
| list rows drawn without the `$51E6` erase | `scenario-list.mjs`, `disk-menu.mjs` |
| icon 4 (music on/off) closes the list | `scenario-icons.mjs` |
| the hit test accepts rows past the list's names | `scenario-list.mjs` (short-list check) |

The first mutant run found the hit-test mutant survived with an EXIT-row bound (`row < 11`): `musicRowAt` never returns row 10 (`$79` bounds it), so that mutant was equivalent. The short-list check was added so that the labels' bound is tested.

## 5. Limitations

1. **The format icon is a remake note.** Its floppy behaviour (the header read, the Return or click paths) is not modelled; only its list close (`$82B8`) is traced and reproduced.
2. **Icons 0 and 1 are the remake's pages.** Their original save-disk checks (`$855A`, the disk header) need floppies. Their list effect (the mode change to 2 or 1) is reproduced as "the list is replaced"; the return from the remake's page does not reopen the list.
3. **Icon 1 with a held scene is a remake refusal.** The original would ask for a save disk there (bit 3 is clear for a held scene), so the note is a remake choice.
4. **Hover order and pixels.** The remake draws the erase, the bar and the text per row; the original's `$818C` draws only the bar, and the text redraw is not traced. No capture was made.
5. **Right click on the list.** A remake convenience: it closes the list and reprints the held `$8B`. The original's list has no right-button route.
6. **The music list's blank rows** are erased now (traced by `$1006` → `$539E`). Whether the original's pixels match the traced erase is not compared with a capture.
7. **Icon 2's wait** still uses one update as the approximation for the header read and list draw (see game-proper.md, "Opening click and the held press").

## 6. Next

- A capture of the original's mode-3 list (rows, hover, prompt, the icons while the list is open) would settle the colours, the hover order and the erase pixels.
- Decide whether icons 0 and 1 should keep the remake pages or get a list-return route (the original's mode 2 and 1 lists are not traced beyond their handlers).
