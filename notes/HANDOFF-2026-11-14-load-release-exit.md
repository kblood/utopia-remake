# Utopia handoff: the load page chooses on the release, and both list pages have EXIT (2026-11-14, load slice)

> **Status update (2026-11-14, empty-load slice):** the empty-record parts of this note are superseded by [HANDOFF-2026-11-14-empty-load-list.md](HANDOFF-2026-11-14-empty-load-list.md). An empty row on the load list no longer opens the error page: it keeps the list with `$143` on its prompt (section 2's "sloterror" row, section 3's empty bullet, section 4's empty-slot checks, and the empty part of section 5 limitation 2 are out of date). The corrupt error page and its missing EXIT row are unchanged.

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal` with Haiku; no orchestration tool was called (no `orchestrator_capabilities`, no `delegate_task`), so that routing is not confirmed and no model switch is claimed. No emulator run; no writes under `original/` (Disk.1 was only read with `tools/game_dis.py` and raw byte reads). Nothing committed, pushed, reset or cleaned. The working tree was already dirty; no existing change was reverted.

Supersedes the load and EXIT claims in [HANDOFF-2026-11-14-save-page-release.md](HANDOFF-2026-11-14-save-page-release.md) (see section 6). Read first: [formats/game-proper.md](formats/game-proper.md), "Load and save rows: release, and EXIT on the list pages".

## 1. What the original does (STATIC, Disk.1 raw bytes, file offset = address + `$28800`, listings from `tools/game_dis.py`)

| Point | Raw / effect (VERIFIED static) |
|---|---|
| Loop press path `$7F72`-`$7FA6` | `bsr $8132`; `jsr $50B2`; `bmi $7EF6`; `btst #6,$156A8` (right latch) skips; `btst #3,$156A8` (`$7F8C`): set -> `$7FA8`, clear -> `$7F96`. |
| Hover row `$8132` (file `$30932`) | `tst.b $938D`; `beq $817E` (mode 0 only has no row). Modes 1-4 all get `$8CFE` = `(y-$20)/9` for x `$38`-`$88`, y `$20`-`$79`. |
| Icon hit on press `$7FA8` | `$5730` on the icon table `$8CB4` (index in d2, -1 for none). A hit: `$5948` stores (x, y, index) in `$5DD0`-`$5DD4`, flips the icon, `bra $7EF6`. |
| Icon release `$7F96` | `tst.w $5DD4`; >= 0 -> `$59C8` (un-flip, reads the latched index, sets `$5DD4` = -1) -> `$7FE4` dispatch; `cmpi.b #5` -> `beq $802C` (EXIT). The dispatch uses the press's index, wherever the pointer is at the release. No mode test. |
| Row press `$7FCE`-`$7FE0` | `bsr $2E52` (raw wait for the left release, no poll); `tst.w $8CFE`; `bmi $7EF6`; `bsr $87DC`; `bra $7EF6`. |
| Dispatch `$87DC` (file `$30FDC`) | `move.b $938D,d7`; 4 -> `$8A42`; 1 -> `$8918` (save); EMPT check on `$8F96 + $8CFE*$40` (`$8804`-`$881E`: `$143`, list kept); `cmpi.b #2` -> `$8828` (load); else `$88F0` (scenario). |

**Consequences (VERIFIED static).**
- **The load row is the save row's route.** `$7FCE` -> `$2E52` -> `$87DC` -> `$8828`. The row is the one `$8132` latched at the press frame, so the load list chooses on the RELEASE.
- **EXIT is live in every list.** Icon 5 has no mode test on the `$7F8C`-`$7FE4` path, so it is live in the save list (mode 1) and the load list (mode 2), not only the scenario list. The page does not need a BACK first.

Checked offsets: `$7EF6` `$306F6`, `$7F72` `$30772`, `$7FA8` `$307A8`, `$7FCE` `$307CE`, `$7FE4` `$307E4`, `$8132` `$30932`, `$87DC` `$30FDC`, `$8828` `$31028`, `$50B2` `$2D8B2`, `$5730` `$2DF30`, `$5948` `$2E148`, `$59C8` `$2E1C8`, `$2E52` `$2B652`. (A first attempt used `$2B6F6` for `$7EF6`; the disassembly was wrong, and it was redone at `$306F6`.)

## 2. Change

| File | Change |
|---|---|
| `src/game/game.ts` `openMenu` | the save and load pages open in `release` mode; both get an EXIT entry appended after the eight slot rows (`PAGE_EXIT_ROW` = `SAVE_SLOTS`, label `EXIT`). The other pages keep the press and get no EXIT. |
| `src/game/game.ts` `exitFromPage` (new) | EXIT on a list page calls `exitMenus` (icon 5's action) with the refusal note on the page's prompt line. |
| `src/game/game.ts` `case "save"` / `case "load"` | row `PAGE_EXIT_ROW` -> `exitFromPage`; slot rows and right click unchanged. |
| `src/game/game.ts` `update` (post-update pass block) | `exitedDiskPage` also covers the `save` and `load` stages, so a page's exit into the map runs the one first pass in the same update (before, only `disk` and `scenario`). |
| `src/game/menu.ts` | comment only: release mode is the save and load pages. |
| `test/load-page.mjs` | new, 22 checks, in the `npm test` chain after `save-page.mjs`. |
| `test/save-page.mjs` | section 8 changed from "no EXIT entry" to "the EXIT row survives a save"; the header updated. |
| `test/save.mjs` | the corrupt-page visual baseline takes one idle frame before its hash (see section 4); the `STORAGE OFF` list check ignores the EXIT row. |
| `test/disk-menu-keys.mjs` | 4e takes one idle frame after its load pick, before the EXIT press (see section 4). |
| `package.json` | `node test/load-page.mjs` added to `npm test`. |

Choices I made (redirect if wanted):
- The EXIT row is a labelled row, not the icon artwork: the remake's page is a MenuScene over the picture, not the original's icon layout. Release activation makes it behave as the icon does (press, then release anywhere still exits).
- EXIT's refusal in the boot session with nothing held writes `REMAKE: CHOOSE A SCENARIO` on the page's prompt line, and the page stays. The picture's own refusal is printed in its info line; a page has no info line.
- Game over refuses EXIT silently, as the icon does. The page stays.
- The load error page (`sloterror`, for empty and corrupt records) still replaces the list and has no EXIT row. The original keeps the list (mode 2) with EXIT live; the remake's error page is a separate page, so it is left as is.
- The remake submenu's LOAD GAME and SAVE GAME pages get the same EXIT row (they are the same pages). That EXIT exits the disk menu, which the original's icon also does; the submenu itself has no such exit in the original.

## 3. Behaviour that is unchanged (checked by the suites)

- A load success holds the scene behind the picture (`acceptScene` with `pick`), and EXIT enters it with one first pass; this is the held-scene behaviour the earlier notes describe, now reachable from the load page's own EXIT row too.
- Empty (`$143`) and corrupt records open the remake's error page with the same codes and BACK routes (`test/save.mjs`, `test/load-page.mjs` section 2).
- The save page's release and row latch are unchanged.

## 4. Tests

`test/load-page.mjs` (22 checks, all pass):
- the load icon opens the page with eight slot rows and EXIT last;
- press-not-activate: a press held on slot 1 loads nothing; the release loads it;
- release at another row: press on slot 1, release on slot 3 (empty): slot 1 loads, no error;
- press on the empty slot 3, release on slot 1: the empty error page (CODE: empty), held scene untouched; its BACK returns to the picture;
- blank and outside presses: a press off the rows and a release on slot 1 loads nothing; a press on slot 1 released off the page loads slot 1;
- a corrupt slot 5 opens the corrupt error page;
- EXIT on the load page is activated on the release (a press alone keeps the page), enters the live map unpaused, with exactly one first pass and none pending;
- the page's EXIT matches icon 5 on the picture (stage, pass count, pending, date);
- a held load: the page's EXIT enters the held scene's map (not the live one), with one first pass;
- boot session, nothing held: EXIT keeps the page and shows the note on its prompt;
- game over: EXIT is refused silently (page kept, no pass, no note);
- the save page's EXIT row: present; EXIT enters the live map with one first pass; with a held scene it enters the held map.

Test changes that were needed (not weakened):
- `save.mjs` corrupt baseline: the load row is chosen on the release, so the error page is created on the release frame and draws its hover (the `RETRY` row under the pointer) on the next update. A probe with one idle frame before the hash gives the pinned `5bd3e842` again. The idle frame is now in the test, with a comment. The `empty` baseline was unaffected (its hovered row is not an enabled row).
- `disk-menu-keys.mjs` 4e: the load pick now completes on the release, so the picture opens with the button up. The EXIT click in the test came in the very next frame and was ignored: `DiskMenuScene` starts with `wasDown` true (the opening click) and only clears it on its first update. A person cannot press within one frame of a release, so this is a test-timing artefact, not a player-visible bug; it is recorded as an edge in game-proper.md. The test takes one idle frame. The constructor was not changed.
- `save.mjs` STORAGE OFF check: the load list now has an EXIT row; the check ignores it.
- `save-page.mjs` section 8: it pinned "no EXIT". It now pins the EXIT row after a save.

Mutants (compiled `dist/game/game.js` and `dist/game/menu.js`, one at a time, restored byte-identical with `cmp`):

| Mutant | Killed by |
|---|---|
| load page back to press (`activate: stage === "save" ? "release" : "press"`) | `load-page.mjs` (1: a press alone loads nothing) |
| row latch dropped (release uses the row at the release) | `load-page.mjs` (2), `save-page.mjs` (4), `save.mjs` (2) |
| no immediate pass after a save/load page exit (`exitedDiskPage` without `save`/`load`) | `load-page.mjs` (3) |
| page EXIT row acts as BACK (`leaveDiskPage`) | `load-page.mjs` (5) |

Verification:

| Command | Result |
|---|---|
| `npm run build` | exit 0 (before and after the test edits) |
| `node test/load-page.mjs` | exit 0, 22 ok |
| `node test/save-page.mjs` | exit 0, 31 ok |
| `node test/save.mjs` | exit 0, 405 ok |
| `node test/boot-menu.mjs` | exit 0, 67 ok |
| `node test/disk-menu-keys.mjs` | exit 0, 48 ok |
| `node test/scenario-icons.mjs` | exit 0, 49 ok |
| `node test/game-over.mjs` | exit 0, 52 ok |
| `node test/game-music.mjs` | exit 0, 86 ok |
| `node test/button-sound.mjs` | exit 0, 42 ok |
| `node test/disk4-scene.mjs` | exit 0, 109 ok |
| `npm test` (full chain) | exit 0; 5008 `ok` lines in the log, 0 `FAIL` |

## 5. Limitations (not changed)

1. **The EXIT row is a remake row, not the icon.** The original's EXIT is an icon on the picture; the remake's list page draws a labelled row. Its position and look are not compared with the original.
2. **The load error page has no EXIT.** Empty and corrupt loads replace the list with the remake's error page. The original keeps the list and EXIT live. Adding EXIT to the error page would be a second change; it was not made.
3. **Timing is by frame.** The release is taken at the frame it is seen, not at the VBL the `$2E52` loop polls.
4. **The opening-click edge (remake).** A page opened on a release starts with its press state as "down" (`wasDown` true), so a press in the very first update after it is ignored. A person cannot do this within one frame; the test takes one idle frame. Changing the constructors to take the live button state would remove the edge; it was not done here.
5. **The name step is still not modelled.** See the save-page release handoff, section 5, limitation 1. It is the next feature and was not added here, as the brief asked.
6. **Load success message.** A slot load still shows no message (the original's `$145` is erased in the same handler; see game-proper.md, "Load success message").

## 6. Corrections to earlier notes

- [HANDOFF-2026-11-14-save-page-release.md](HANDOFF-2026-11-14-save-page-release.md): "the load page still chooses on the press" (section 2, section 5 limitation 4, section 6) is WRONG. The load row is the same release route. A status note now sits at its top.
- The same note's "the save page has no EXIT" (section 5 limitation 3) is WRONG. The page has an EXIT row now.
- [HANDOFF-2026-11-14-opening-click.md](HANDOFF-2026-11-14-opening-click.md): "the hover row exists only in mode 3" was WRONG. `$8132` gives a hover row for every nonzero mode (1-4). Corrected in its table.
- [formats/game-proper.md](formats/game-proper.md), the save-tail paragraph: "the load page still chooses on the press" and "the save page has no EXIT entry" were WRONG. Corrected; the new section "Load and save rows" holds the trace.
- [formats/remake-save.md](formats/remake-save.md): the same two sentences corrected.

## 7. Next

- The name step (save-page release handoff, limitation 1; `$8918`, `$13E`/`$13F`, `$5110`). Not started, by the brief.
- Decide whether the load error page should keep the list with EXIT (limitation 2), as the original does.
- A capture of the original's list pages (the icon and row positions, and the release timing) would settle limitations 1 and 3.
