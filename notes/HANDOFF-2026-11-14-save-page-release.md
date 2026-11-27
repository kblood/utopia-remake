# Utopia handoff: the save page after a save, for every origin, with release-chosen rows (2026-11-14, save-page release slice)

> **Status update (2026-11-14, load slice):** three claims in this note are superseded by [HANDOFF-2026-11-14-load-release-exit.md](HANDOFF-2026-11-14-load-release-exit.md): (a) "the load page still chooses on the press" (section 2 bullet 3, section 5 limitation 4, section 6) is wrong: the load row is the same `$7FCE` release route, and the load page now chooses on the release; (b) "the save page has no EXIT" (section 5 limitation 3) is wrong: both list pages have an EXIT row (icon 5), and the test that pinned its absence was changed; (c) the hover row claim in [HANDOFF-2026-11-14-opening-click.md](HANDOFF-2026-11-14-opening-click.md) (mode 3 only) was corrected to every nonzero mode. The rest of this note stands. **Status update (2026-11-14, save-name slice):** limitation 1 (the name step is not modelled) and section 6's first item are superseded by [HANDOFF-2026-11-14-save-name.md](HANDOFF-2026-11-14-save-name.md): a row release now opens the `$13E`/`$13F` prompt, and the save is written on the confirming click or Return-edit.

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal` with Haiku; no orchestration tool was called (no `orchestrator_capabilities`, no `delegate_task`), so that routing is not confirmed and no model switch is claimed. No emulator run; no writes under `original/` (Disk.1 was only read with `tools/game_dis.py` and raw byte dumps). Nothing committed, pushed, reset or cleaned. The working tree was already dirty when the slice started; no existing change was reverted (the edits here are to `src/game/game.ts`, `src/game/menu.ts`, `src/game/disk-menu.ts`, and the tests and notes named below).

Supersedes the save-page claims in [HANDOFF-2026-11-14-mode3-save-page.md](HANDOFF-2026-11-14-mode3-save-page.md) (its limitations 3 and 4 are fixed here, and its picture-origin statement is reversed) and the picture-origin sentence in [HANDOFF-2026-11-14-mode3-pages.md](HANDOFF-2026-11-14-mode3-pages.md).

## 1. What the original does (STATIC, Disk.1 raw bytes, file offset = address + `$28800`, listings checked with `tools/game_dis.py`)

| Point | Raw / effect (VERIFIED static) |
|---|---|
| Icon 1 `$856C`-`$85BE` | `btst.b #3,$156AA`; then `$135` and `bsr $855A`. `$855A`: `moveq #0,d1`, `bsr $8462` (the `$135` line), `bsr $2E48` (wait for a left press), `bsr $84F4` (erase the prompt), `bsr $841E` (header). Then `cmpi.w #1,d0` -> `beq $85B8`. |
| Save list entry `$85B8`-`$85C6` | `move.w #$138,d0`; `bsr $85CA`; `move.b #1,$938D`; `bra $7EF6`. `$85CA`: `moveq #0,d1`, `bsr $8462` (prints d0 on the prompt, line 1), then the ten rows. `$138` = "Click on slot to save game into...". |
| Dispatch `$87DC`-`$8918` | `move.b $938D,d7`; 4 -> `$8A42`; 1 -> `beq.w $8918` (before the `EMPT` check). |
| Row path `$7FCE`-`$7FE0` | `bsr $2E52` (wait for the left release), `tst.w $8CFE`, `bmi $7EF6`, `bsr $87DC`, `bra $7EF6`. `$8CFE` is set by the hover poll `$8132` at the pass where the press is seen; nothing writes it during `$2E52`, so the row is the one latched at the press. |
| Release wait `$2E52` | `btst.b #6,$bfe001` loop until the button is up (`bne`/`beq` pair, `$2E52`-`$2E5C`). |
| Name step `$8918`-`$896E` | `$13E`/`$13F` on the prompt (`$8462`, two lines: "Game will be saved as 'xxxxxxxxxx'..." / "Click mouse to use this name, or press 'RETURN' to edit name.."); loop on `$161A0`, `$44` (Return) -> `$8974`; a left press -> `$2E52` -> `bra $89B4`. Not modelled in the remake (section 5). |
| Erase `$84F4`-`$8558` | `$2F5E`, `bclr #2,$156A8`, then waits for VBL (`$851A`-`$8522`), erases both prompt lines (`moveq #$26`, 38 bytes, at y `$A3` and `$AC`), `bset #2,$156A8`, `rts`. |
| Success tail `$89B4`-`$8A40` | `bsr $84F4` (erase), header and slot write (`$7D88`), `$140` then `$141` on the prompt (`$8462`, d1 = 0), `move.w #-1,$8CFE` (`$8A38`), `rts`. No `$82B8` call, no `$938D` write. |
| Return and exit | `$8A40 rts` -> `$7FDC` `bra.w $7EF6`, the loop. Only icon 5 (`$7FE4` `cmpi.b #5` -> `$802C`) leaves it. |
| Right button in the loop | `$50B2` sets bit 6 of `$156A8` while the right button is held; `$7F80` `btst #6` / `bne $7EF6` skips the press path. No other right-button route. |

**Consequences (VERIFIED static).** After a successful save the loop keeps the mode-1 save list up (`$938D` = 1), with `$141` on its prompt. The prompt the tail erased (`$84F4`) is gone for good; `$141` is the prompt until a traced erase: `$84F4` (icons 0, 1, 2 at their open, the save tail itself, the Return name path), or `$82B8` (format, music select, a load pick, a list close). There is no traced BACK.

## 2. Change

| File | Change |
|---|---|
| `src/game/menu.ts` | `MenuScene` takes `options.activate`: `press` (the default, every other page) or `release`. In `release` mode a left press latches the entry under the pointer (`pressRow`); the release returns that entry, wherever the pointer is then. A press off the entries latches nothing, a right press cancels and clears the latch. |
| `src/game/game.ts` `openMenu` | the save page is opened in `release` mode; the load page and the others keep `press`. |
| `src/game/game.ts` `diskIcon` (icon 1) | after `rememberPicture()` the held prompt is cleared (`$855A`'s `$84F4`) and the page shows `$138` (`SAVE_OPEN_STRING`) on its status line. |
| `src/game/game.ts` `returnFromSave` | on success, for every origin: `heldPrompt = 0`, `pageReturn = { list: back?.list ?? false, prompt: $141, heldPrompt: 0 }`, then the save page is reopened with the fresh slot labels and `$141` as its status line. The picture is no longer shown after a save. |
| `src/game/game.ts` `leaveDiskPage` | after the picture or the list is rebuilt, the remembered prompt is printed when it is nonzero. For a list origin it is `$141` after a save, or the pre-page prompt otherwise; a picture origin prints `$141` after a save (and nothing otherwise, as before). The erased pre-save prompt is not in `pageReturn`, so it does not come back. |
| `src/game/disk-menu.ts` | `SAVE_OPEN_STRING = 0x138` (`$85B8`), beside `SAVE_DONE_STRING = 0x141`; comments on the erase. |
| `test/save-page.mjs` | new, 31 checks (section 4). |
| `test/scenario-icons.mjs`, `test/disk-menu-keys.mjs`, `test/boot-menu.mjs`, `test/save.mjs` | expectations moved to the new route: a success stays on the save page, BACK shows `$141` (not `$8B`), the picture origin is the save page, the remake-submenu save is the save page; 4j takes an idle frame before its BACK press (the error page opens on the save row's release, and the page ignores a press in the same frame it opens on). The 4e/4h checks now BACK to the picture before EXIT, since the save page has no EXIT. |

Choices I made (redirect if wanted):
- A save from the picture no longer returns to the bare picture: the save page stays up with `$141`, as the brief asked. The picture comes back only through BACK (with `$141`).
- The BACK after a save shows `$141`, not the pre-save prompt, because the original's tail erased that prompt. A BACK without a save still restores the prompt the page replaced (the existing remake choice); the original has no BACK, so that is a remake convenience with the same erase issue in principle. Left as is.
- The load page still chooses on the press. The original's load row is the same `$7FCE` route (`$8828`), so the load page is probably the same release case; it was not changed here because the brief named the save rows only and its tests pin the press.

## 3. Save slot labels and the held scene

- Slot labels are the remake's (`slotLabels()`); the original's ten rows are not drawn by the save page.
- The held scene is unchanged by a save and by BACK; EXIT from the list after BACK enters the held scene, as before (test section 2).
- The saved slot holds the held session (scenario 1 while the live map is 0): test section 2 and `test/scenario-icons.mjs` section 4.

## 4. Tests

`test/save-page.mjs` (31 checks, all pass):
- picture origin: icon 1 shows `$138`; a slot release keeps the save page with `$141` through idle frames; BACK goes to the picture with `$141`; EXIT then enters the live map unpaused.
- scenario origin: the pick's `$8B` is visible before the save and erased by icon 1; the save writes the held scenario to slot 2; BACK gives the list with `$141` (not `$8B`); EXIT enters the held scene (scenario 1), not the live map.
- prompt lifetime: `$141` survives icon 4 (`$1062`, a result line only); icon 7 (`$82B8`) and icon 2 (`$855A`/`$13B`) replace it.
- release timing and row latch: a press alone writes nothing; a press on slot 2 released on slot 5 writes slot 2 only; a press off the rows and a release on a row writes nothing; a press on a row released off the page writes that row; the list origin latches the same way.
- repeated saves keep the origin (list and picture), and BACK still goes to the origin.
- the remake submenu's SAVE GAME: the same save page, BACK to the picture with `$141`.
- a refused write: the error page (not `$141`), and its BACK to the list with the list's own `$8B` (no `$141` was written).
- the save page has no EXIT entry.

Mutants (compiled `dist/`, one at a time, restored byte-identical with `cmp`):

| Mutant | Killed by |
|---|---|
| save page back to press activation | `save-page.mjs` (1 check: a press held on a slot writes nothing) |
| row latch dropped (release uses the pointer at the release) | `save-page.mjs` (4 checks) |
| BACK restores the pre-save prompt (`back?.prompt ?? $141`) | `save-page.mjs` (7), `scenario-icons.mjs` (2), `disk-menu-keys.mjs` (2), `boot-menu.mjs` (1) |
| no `$138` on the save page at open | `save-page.mjs` (3) |

## 5. Limitations

1. **The name step is not modelled.** The original's row release opens the name prompt (`$13E`/`$13F`: "Game will be saved as 'xxxxxxxxxx'..." and "Click mouse to use this name, or press 'RETURN' to edit name..", `$8918`), and the save commits on a click, or on Return with the name edit (`$5110`). The remake saves at once on the release, with no name. Adding it would make a row release a two-step action; that is a product choice, not done here.
2. **The save page is the remake's stand-in for the mode-1 list.** It draws slot labels, not the original's ten rows, so the picture after a save is not compared with the original.
3. **The save page has no EXIT.** The original's icons are live in the list (`$7FE4`), so EXIT is one press away there; the remake's page reaches it through BACK.
4. **The load page still chooses on the press** (see section 2).
5. **BACK without a save restores the replaced prompt** (remake choice; section 2).
6. **Timing is by frame.** The release is taken at the frame it is seen, not at the VBL the original's `$2E52` loop polls; the release-to-save delay is not measured.
7. **The text of `$138`, `$140`, `$141` is the Disk.1 string at that index**; it is not compared with the original's screen.

## 6. Next

- Decide whether the name step should be added (limitation 1); if yes, `$8918` is the trace (`$13E`/`$13F`, `$5110`).
- Switch the load page to release activation, after checking the load route (`$8828`, the same `$7FCE` path) in a capture.
- A capture of the original's mode-1 list after a save (the rows, the `$141` line position, and the release timing) would settle limitations 2 and 6.
