# Utopia handoff: an empty load row keeps the load list with `$143` (2026-11-14, empty-load slice)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal` with Haiku. No orchestration tool was called in this slice (no `orchestrator_capabilities`, no `delegate_task`), so that routing is not confirmed and no model switch is claimed. No emulator run; no writes under `original/` (Disk.1 was read with `tools/game_dis.py` and raw byte reads only). Nothing committed, pushed, reset or cleaned. The working tree was already dirty; no existing change was reverted.

Supersedes the empty-record part of [HANDOFF-2026-11-14-load-release-exit.md](HANDOFF-2026-11-14-load-release-exit.md) (its section 2 "sloterror" row, section 3 empty bullet, section 5 limitation 2 for the empty case) and the empty-refusal picture claims of [HANDOFF-2026-11-14-error-picture.md](HANDOFF-2026-11-14-error-picture.md) and [HANDOFF-2026-11-14-load-return.md](HANDOFF-2026-11-14-load-return.md). Status notes sit at the top of each.

## 1. What the original does (STATIC, Disk.1 raw bytes, file offset = address + `$28800`, rechecked this slice)

| Point | Raw bytes / effect (VERIFIED static) |
|---|---|
| `$7FCE` / `$7FDC` | `bsr $2E52` (release wait), `tst.w $8CFE`, `bmi $7EF6`, `bsr $87DC`, `bra $7EF6`. The caller keeps the loop and mode 2 whatever `$87DC` does. |
| `$87DC` head | `move.b $938D,d7`; `cmpi.b #4` -> `$8A42`; `cmpi.b #1` -> `$8918` (save). Only then the EMPT check: `lea $8F96,a0`, `move.w $8CFE,d1`, `mulu #$40`, `adda.w d1,a0`. Mode 1 never reaches the EMPT check. |
| EMPT check `$8804`-`$880E` | `cmpi.l #$454d5054,(a0)`; `bne $8820`. |
| Name check `$880C`-`$8812` | `cmpi.w #$5900,$4(a0)`; `bne $8820`. |
| Refusal `$8814`-`$881E` | `move.w #$143,d0`; `moveq #0,d1`; `bsr.w $8462`; `rts`. |
| `$8462` (prompt printer) | Waits for a VBL, then, for a nonzero index, prints the string at y `$A3` (the list prompt line). Index 0 erases. |
| Not refused | `$8820` `cmpi.b #2` -> `$8828` (load, mode 2); else `$88F0` (scenario, mode 3). |

**Consequence (VERIFIED static).** An EMPTY record in the load list prints `$143` on the list prompt and returns. The mode stays 2, no scene is built, no `$82B8` runs, and the list, its rows and icon 5 (EXIT) stay live. A refused empty load is therefore not a page change: the user can choose another row or leave with EXIT.

Checked offsets: `$87DC` `$30FDC`, `$8804` `$31004`, `$8828` `$31028`, `$8462` `$30C62`, `$7FCE` `$307CE`, `$7FDC` `$307DC`.

## 2. Change

| File | Change |
|---|---|
| `src/game/game.ts` `refuseLoad` (new) | An `empty` load error sets `$143` (`EMPTY_RECORD_STRING`) on the load list's prompt with `MenuScene.setPrompt` and nothing else. Any other typed error goes to `openSlotErrorMenu` as before. |
| `src/game/game.ts` `case "load"` | A failed row release calls `refuseLoad`, not `openSlotErrorMenu` directly. The row, EXIT and right-click branches are unchanged. |
| `src/game/game.ts` `sloterror` RETRY (load) | If the retry finds the slot empty (storage changed while the error screen was open), it reopens the load list with `$143`, the same route. |
| `src/game/game.ts` `openSlotErrorMenu` | Comment corrected: an empty record no longer comes here. |
| `loadFromSlot` | Unchanged. It still returns `false` with `lastLoadError` = `empty`, so the programmatic callers (`test/game-music.mjs`) keep their result. |

Choices I made (redirect if wanted):
- The refusal is the list's own prompt, not a new screen. The original keeps the list, so the remake does too.
- The prompt is printed in the remake's panel, not at the original's y `$A3`. The remake's list page draws no original rows, so the prompt position is a layout choice.
- Corrupt and other typed errors keep the error page, as the brief asked. The trace gives no corrupt route.

## 3. Behaviour now

- **Picture origin, nothing held:** an empty row refuses; the list stays with `$143`; another row (empty or populated) can be chosen; EXIT from the list enters the live map with one first pass; the right click returns to the picture.
- **Scenario-held load:** a refused empty row keeps the held scene object and its map; EXIT from the list enters the held map with one first pass.
- **Boot session, nothing held:** the refusal shows `$143`; EXIT then refuses with the note `REMAKE: CHOOSE A SCENARIO` on the list's prompt, and the list stays (as before for the EXIT note).
- **Game over:** the refusal shows `$143`; EXIT is refused silently; the list and its prompt stay, and no pass runs.
- **Row release semantics (unchanged):** the row latched at the press acts on the release, wherever the pointer is then. A press on an empty row released on a populated row refuses (no load); a press on a populated row released on an empty row loads the populated one.
- **Corrupt or unsupported:** the error page, as before (CODE line, RETRY, CHOOSE ANOTHER SLOT, DISK MENU, BACK TO DISK MENU). It has no EXIT row. Its BACK TO DISK MENU returns to the picture; icon 5 then leaves.

## 4. Tests

| File | What changed |
|---|---|
| `test/load-page.mjs` | Section 2: the empty-row check now expects the list with `$143` (not the error page); repeated attempts, a press on an empty row released off the page, and a right click back to the picture. New section 3b: picture origin (three refusals, EXIT with one first pass, a successful load after a refusal), scenario-held (EXIT enters the held map), boot session (`$143` then the EXIT note), game over (refusal, then silent EXIT with no pass). |
| `test/save.mjs` | Menu-load empty check, load-refusal block, visual baseline (the empty-refusal list is pinned at `5dd860c5`; the corrupt page stays at `5bd3e842`; the pin was re-taken on purpose, and the file's comment says so), held block and game-over block. |
| `test/boot-menu.mjs` | Section 6: a refused boot load of an empty slot keeps the list, and a right click returns to the boot picture with the held scene. |
| `test/scenario-icons.mjs` | Section 4 (scenario-list origin): the empty refusal keeps the list with `$143`; a right click returns to the scenario list with `$8B`; EXIT from the retained list enters the held scene. |

Unchanged and still passing: `test/save-page.mjs`, `test/scenario-pick.mjs`, `test/game-over.mjs`, `test/disk-menu-keys.mjs`, `test/game-music.mjs` (programmatic `loadFromSlot` still returns `false`), `test/disk4-scene.mjs`, `test/disk-menu.mjs`.

## 5. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/load-page.mjs` | exit 0, 33 ok |
| `node test/save.mjs` | exit 0, 404 ok |
| `node test/save-page.mjs` | exit 0, 31 ok |
| `node test/boot-menu.mjs` | exit 0, 67 ok |
| `node test/scenario-icons.mjs` | exit 0, 49 ok |
| `node test/scenario-pick.mjs` | exit 0, 58 ok |
| `node test/game-over.mjs` | exit 0, 52 ok |
| `node test/disk-menu-keys.mjs` | exit 0, 48 ok |
| `node test/game-music.mjs` | exit 0, 86 ok |
| `node test/disk4-scene.mjs` | exit 0, 109 ok |
| `node test/disk-menu.mjs` | exit 0, 108 ok |
| `npm test` (full chain) | see section 6 |

## 6. Full run

- `npm test` (full chain, output to a scratch file outside the repo): exit 0, 5018 `ok` lines, 0 `FAIL`. (The previous slice logged 5008; the difference is the new load-page checks.)
- Mutant (compiled `dist/game/game.js`, `refuseLoad` sent back to the error page, then rebuilt from source): `test/load-page.mjs` 5 FAIL, `test/save.mjs` 9 FAIL. The build was restored from source afterwards and `test/load-page.mjs` passes again (33 ok).

## 7. Limitations (not changed)

1. **The corrupt error page still has no EXIT row.** The trace gives no corrupt route; the page's BACK TO DISK MENU returns to the picture, and icon 5 leaves from there. Adding EXIT to it would be a remake choice.
2. **The `$143` text and its position are not compared with a capture.** The remake prints the same string index at its own prompt position (not y `$A3`), and draws no original list rows.
3. **Prompt lifetime.** The original erases the `$143` line only at the next traced erase (a successful load erases it; the next refusal overwrites it). The remake keeps it until the page changes, which matches that for these cases.
4. **The `$8462` VBL wait is not modelled** (no frame is counted for the print or the erase).
5. **Storage race edge.** A sloterror RETRY that finds the slot empty reopens the load list with `$143`; that path is reachable only if storage changes while the error screen is open. It is covered by code reading, not by a test.

## 8. Next

- A capture of the original's empty refusal (the list rows and the `$143` line at y `$A3`) would settle limitations 2 and 3.
- Decide whether the corrupt error page should also keep the list with EXIT (limitation 1).
- The name step on the save row (save-page release handoff, limitation 1) is still open.
