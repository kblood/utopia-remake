# Utopia handoff: the save's return from the disk menu (2026-11-14)

> **Superseded in part (2026-11-14, save-page release slice, [HANDOFF-2026-11-14-save-page-release.md](HANDOFF-2026-11-14-save-page-release.md)).** The trace in sections 1 and 2 still holds (the success tail `$89B4` has no `$82B8` call and waits for no EXIT). The remake's picture-origin return to the bare picture with `$141` is replaced: a successful save keeps the save page up for every origin with `$141` as its status line, and BACK goes to the picture or list it came from. Where this note says the save "returns to the disk-menu loop" for the remake, read "the save page, from which BACK returns to the loop".

> **Status update (2026-11-14, later):** open point 2 (the load error BACK) is changed: a refused load, like a save, returns to the disk-menu loop (no EXIT, no map). See [HANDOFF-2026-11-14-load-return.md](HANDOFF-2026-11-14-load-return.md).

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator and no original writes: `original/` was only read (`tools/game_dis.py` disassembly of the Disk.1 image). Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-held-key-routes.md](HANDOFF-2026-11-14-held-key-routes.md) (open point 1, the save close), [formats/game-proper.md](formats/game-proper.md) "Save tail and return" and "Save, load and scenario picks", [formats/remake-save.md](formats/remake-save.md) "Menu actions".

## 1. Question and answer

Does a successful click-to-save return to the disk-menu loop (EXIT needed) or straight to gameplay?

**It returns to the disk-menu loop. EXIT is needed.** (VERIFIED static, Disk.1 disassembly.)

Chain, with file offsets = address + `$28800`:

| Step | Routine | Evidence |
|---|---|---|
| Save icon, mode 1 | `$856C` sets mode 1; `$7FDC` `bsr $87DC` | `$7FE4` dispatch: `cmpi.b #$1 / beq $856c` |
| Dispatch | `$87DC` `cmpi.b #$1 / beq.w $8918` | disassembly `$87DC`-`$8820` |
| Name loop | `$8918` -> `$8958`: read `$161A0` (no clear), `$44` -> `$8974`; left button -> `$2E52` (wait for release) -> `bra $89b4` | disassembly |
| Save tail | `$89B4`-`$8A38`: `$84F4`, record and slot write (`$7D88`), messages `$140` then `$141` on the list prompt (`$8462`), `$8CFE` = -1 | disassembly |
| Return | `$8A40 rts` -> `$7FDC` `bra.w $7ef6` -> the menu loop `$7EF6` (`$8CB0` countdown, VBL wait, `$8132`, `$50B2`, dispatch) | disassembly; `$7FDC` is the only caller of `$87DC` |
| Exit | only icon 5, `$802C` (`$7FE4` `cmpi.b #$5 / beq $802C`) | dispatch table |

No `$157B4`, `$15AEC` or `$158B0` return is on the save path. A save (like a scenario pick or a load) therefore waits for EXIT. Return-to-save through `$8974` -> `$5110` (name entry) reaches the same `$89B4` tail, so it returns to the loop too (no remake counterpart; there is no name prompt).

**Remake before this change:** `Game.update` `case "save"` and the retry success both called `closeMenu()`, which runs `leaveDiskMenu()` (the `$802C` effect) and sets stage `map`. So a successful save went straight to gameplay. This was a real mismatch in the menu-origin save flow (the disk icon, and the remake submenu, both open `openMenu("save")`).

## 2. Change

| File | Change |
|---|---|
| `src/game/game.ts` | New `returnFromSave()`: `menu = null`, `openDiskMenu()`, `printPrompt(SAVE_DONE_STRING)`. Used by `case "save"` success and by the `sloterror` retry success for a save. `saveToSlot` (the programmatic API) is unchanged. `openSlotErrorMenu`: a save's BACK is labelled `BACK TO DISK MENU` for every save error (a save never has a held scene or a game over here, `saveRefusal` refuses those first). The `sloterror` BACK for a save calls `openDiskMenu()`, not `closeMenu()`. Load paths unchanged. |
| `src/game/disk-menu.ts` | `SAVE_DONE_STRING = 0x141` (the save tail's last message). `DiskMenuScene.printPrompt(index)`: prints on the list prompt line 0 with the `$8462` erase width (37 bytes), without opening a list. |
| `test/disk-menu-keys.mjs` | 4e and 4h rewritten to the original return (no exit; the key stays in the cell through the loop, dispatched once at EXIT). New 4i (held scene refuses the save icon, writes nothing, the held scene and key go to EXIT) and 4j (a failed write, its error screen, `BACK TO DISK MENU` returns to the loop, EXIT dispatches the key once). |
| `test/save.mjs` | Remake-submenu save success, its retry after the storage recovers, and the storage-off retry now expect the disk-menu loop, not the map. The offer-pending save error's BACK expects `BACK TO DISK MENU`. |
| `notes/formats/game-proper.md`, `notes/formats/remake-save.md` | "Save tail and return" entry added; the two stale "returns to the map" sentences and the menu action list corrected. |

Choices I made (redirect if wanted):
- The save's error BACK now goes to the disk-menu loop, not through EXIT, because a save never exits in the original. The load error's BACK keeps its `closeMenu` route (its original route was not traced here).
- The `$141` text is printed on the prompt line, as the original does. The remake save page draws no list rows, so the picture after a save is not compared.

## 3. Held-scene, key cell and save results (VERIFIED by the remake probe)

| Case | Result |
|---|---|
| Save icon with a held scene (4i) | Remake note, stays on the disk menu, no save list, no write; the held scene and the typed key are entered only at EXIT, and the key pauses the entered scene (match with the static route: the save never clears the cell, and the held exit dispatches it). |
| Save success from the icon (4e, 4h) | Stage `disk`, same map, not paused; the typed `P` stays in the cell through the loop (no map pass); EXIT returns to the same map and dispatches `P` once (not replayed by 12 later passes). |
| Save failure (4j) | Error screen with `CODE: write-failed` over the loop, the failed click keeps `P`; `BACK TO DISK MENU` returns to the loop, EXIT dispatches `P` once. |
| Remake submenu save (test/save.mjs) | Success and storage-recovery retry return to the disk-menu loop; the active map and session are unchanged. |

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/disk-menu-keys.mjs` | exit 0, 41 `ok`, 0 `FAIL` |
| `node test/save.mjs` | exit 0, 385 `ok`, 0 `FAIL` |
| `node test/disk-menu.mjs` | exit 0, 107 `ok` |
| `node test/map-loop.mjs` | exit 0, 381 `ok` |
| Mutant: `returnFromSave` replaced by `closeMenu()` in `dist/game/game.js` | `test/disk-menu-keys.mjs` exit 1, 3 `FAIL` (4e stage, 4h stage and key cell, 4h paused); `dist` restored and identical, exit 0 |
| `npm test` (full chain) | exit 0, 4,738 `ok`, 0 `FAIL` (the previous handoff recorded 4,724) |

No emulator or original-screen comparison was run, so the picture after a save (the prompt line position, the absence of the list rows) and the `$141` text are not verified against the original.

## 5. Open points (not changed)

1. **Save list rows.** The original's save page keeps its ten rows drawn after the save; the remake's save list is a separate menu page, so the disk-menu picture after a save differs in the row area. Not verified against an original capture.
2. **Load error BACK.** `closeMenu` still exits to the map from a load error's BACK (the original's load has no error screen; its route was not traced here).
3. **Save-name Return path.** The original's name entry `$5110` (the Return save) has no remake counterpart; unchanged.
4. **`$141` and `$140` text.** The index is the save tail's; the text and the `$140` line (printed before the write) are not reproduced.
5. Other open points of [HANDOFF-2026-11-14-held-key-routes.md](HANDOFF-2026-11-14-held-key-routes.md) section 7 are unchanged.

## 6. Notes changed

- `notes/formats/game-proper.md`: "Save tail and return" entry; the stale save-close sentences corrected.
- `notes/formats/remake-save.md`: menu actions updated (save success and BACK).
- `notes/HANDOFF-2026-11-14-held-key-routes.md`: open point 1 is answered by this handoff (status line added at the top).
- `notes/README.md`: newest handoff pointer.
