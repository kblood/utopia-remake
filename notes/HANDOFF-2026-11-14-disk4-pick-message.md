# Utopia handoff: the message after a Disk.4 pick (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief named Claude NT provider `claude_personal`; no orchestration tool was called in this pass, so that routing is not confirmed and no switch is claimed. No emulator run, no writes under `original/` (read only, `tools/game_dis.py` and raw byte scans), nothing committed or pushed. The dirty worktree was preserved; only the files in section 5 were edited.

Read first: [HANDOFF-2026-11-14-scenario-list-state.md](HANDOFF-2026-11-14-scenario-list-state.md) (its limit 5 is the open point answered here), [HANDOFF-2026-11-14-load-pick-message.md](HANDOFF-2026-11-14-load-pick-message.md) (its open point 2, the Disk.4 message, is closed here), and [formats/game-proper.md](formats/game-proper.md) "Load success message".

## 1. Question and answer

**Which original route does a Disk.4 pick take, and what does it show?** The remake's Disk.4 pick (`LOAD DISK.4` in the REMAKE MENU, or a scenario recovery pick) is the original's save-disk load: Disk.4 is the save disk, and the load icon's list pick runs the mode-2 handler `$8828`. That handler prints `$145` on the list prompt and erases it in the same handler (`$88EA` `bra $82B8`), so the original shows no message after a load.

**Mismatch, fixed.** `Game.activateDisk4` printed `GAME_LOADED_STRING` (`$145`) on the result line for 53 frames when the pick was a disk-menu pick. It now passes no message, as `loadFromSlot` already does.

## 2. Static evidence (Disk.1, re-disassembled)

Addresses are game-image addresses; file offset = address + `$28800` (checked with `python -c`).

| Address | Instruction / effect |
|---|---|
| `$8820`-`$8824` | `cmpi.b #2,d7`; `bne.w $88F0`: mode 2 (the load) runs here; the scenario is mode 3 (`$88F0`) |
| `$8828`-`$8830` | `move.w #$144,d0`; `bsr $8462`: prints `$144` on the list prompt |
| `$883C` | `jsr $2F5E` (restore; no-op while `$4AA8` is `$FFFF`) |
| `$8868`, `$887A` | `bsr $7D96` (area A, area B reads from the chosen header record; WHDLoad calls) |
| `$887E` | `bsr $84F4`: erases the `$144` prompt lines (waits for the next VBL, see section 3) |
| `$888A`-`$88AA` | `$1453E` -> `$8D00`; `$8A5A` check; `$8F96 + $135C2 * $40` -> `$1453A` |
| `$88C6` | `bsr $84F4` (second erase, nothing shown) |
| `$88CA`-`$88D0` | `move.w #$145,d0`; `bsr $8462`: prints `$145` on the list prompt (after a VBL wait) |
| `$88D4`-`$88D8` | `move.b #1,d0`; `bsr $866E`: the mode-2 reset (`$875C`; its `move.b #$94,$156A8` at `$87BE`) |
| `$88DC`-`$88E6` | clears the 30 effect slots |
| `$88EA` | `bra.w $82B8` |
| `$82B8`-`$82E4` | `$2F5E`; `$156A8` bit 2 clear; `clr.b $938D` (list mode closed); `bsr $84F4` (waits for the next VBL, erases both prompt lines) |
| `$82E8`-`$8306` | `$51E6` x 10: erases the list rows (y `$20`, pitch 9) |
| `$830A` | `bset.b #2,$156A8`; `rts` |

`$8462` and `$84F4` both wait on bit 0 of `$156A8` (`$8488`-`$8498` for the print, before the text; `$851A`-`$8522` for the erase). The bit 0 setter is the VBL handler: `bset.b #0,$156A8` at `$2C58` (file offset `$2B458`), after `btst.b #5` on the INTREQ bits and the `$DFF09C` acknowledge. So each of these waits is one vertical blank.

## 3. Timing

- The `$145` line is printed at VBL N (`$88D0`) and erased at VBL N+1 (`$82E4`), so the original shows it for **at most one frame**. The earlier wording "no frame passes in between" (in `test/save.mjs` and `HANDOFF-2026-11-14-load-pick-message.md`) was wrong and is corrected here.
- The remake draws no message after a load or a Disk.4 pick, so the remaining difference is that single frame. It is not modelled: `DiskMenuScene` has no one-VBL prompt lifetime, and no capture exists to check whether the frame is visible.
- The `$144` line is printed before the area reads and erased after them (`$887E`). It is therefore visible for the duration of the disk reads (WHDLoad calls, not measured). The remake has no disk reads and shows no `$144`. This is untimed, as with slot loads.
- The list-row erase in `$82B8` is the list closing, not a message; the remake's fresh disk menu has no list open after the pick.

## 4. Change

`src/game/game.ts`:
- `activateDisk4`: the held-scene call passes `null` as the message (was `request.pick ? { area: "info", index: GAME_LOADED_STRING } : null`). `request.pick === true` still holds the scene behind the disk menu until EXIT.
- The `GAME_LOADED_STRING` import is removed (no other use in `game.ts`).

`src/game/disk-menu.ts`: the `GAME_LOADED_STRING` comment says the Disk.4 pick shows none, and records the one-frame detail. The constant itself is kept.

`test/disk4-scene.mjs`: new section 2e. A disk-menu pick (`activateDisk4({ pick: true })`) on a fresh game-proper disk menu:
1. succeeds, is held (`stage` `disk`, `heldScene` set, restored), no map entered, no session yet;
2. shows no result line and no list prompt (`shownInfo` `0,0`, `shownPrompt` `0,0`, `infoFramesLeft` 0);
3. EXIT (icon 5, press and release) enters the held continuation once and clears the hold.

`test/save.mjs`: the comment at the load-pick check is corrected to the one-VBL wording. The assertion is unchanged.

## 5. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/disk4-scene.mjs` | exit 0, 109 ok, 0 FAIL (includes new section 2e) |
| `node test/save.mjs` | exit 0, 403 ok |
| `node test/scenario-pick.mjs` | exit 0, 30 ok |
| `node test/disk-menu.mjs` | exit 0, 107 ok |
| `node test/disk-menu-keys.mjs` | exit 0, 41 ok |
| `node test/game-over.mjs` | exit 0, 50 ok |
| `node test/game-music.mjs`, `node test/music-select.mjs`, `node test/boot-menu.mjs` | exit 0, 84 / 46 / 52 ok |
| `npm test` (full chain) | exit 0, 4790 ok, no FAIL lines |

Mutation check (on the built `dist/game/game.js`, not the source): the pick message was restored to `{ area: "info", index: 0x145 }`. `disk4-scene.mjs` then exited 1 with exactly one FAIL, `Disk.4 pick: no result line and no list prompt remain`. The build was then restored and the test passed again.

No visual parity is claimed. The remake's Disk.4 pick is remake presentation (LOAD DISK.4 is a remake entry), and the pixel result of the one-frame `$145` is not compared.

## 6. Remaining limits (not changed)

1. **One frame of `$145`.** The original shows it for one VBL interval (section 3); the remake shows none. Modelling it needs a one-VBL prompt lifetime in `DiskMenuScene` and a capture to confirm visibility. Slot loads have the same gap.
2. **`$144` during the reads.** Not reproduced; its length depends on disk I/O, not measured.
3. **Disk.4 post-load state.** Unchanged: the remaining `$802C` post-load work, RNG restoration and the other post-load items in `game-proper.md`.
4. **EXIT semantics.** EXIT enters the held scene once, through `Game.enterHeldScene`, as before. The `$802C` bit 3 gate and its traces are unchanged and are in `game-proper.md`, "Boot exit and boot save"; they were not re-traced in this pass.
5. **Routing.** No `claude_personal` routing was confirmed in this pass (section header).

## 7. Notes and files changed

- `src/game/game.ts`, `src/game/disk-menu.ts`
- `test/disk4-scene.mjs` (section 2e), `test/save.mjs` (comment only)
- `notes/formats/game-proper.md`: "Load success message" paragraph (new, after "Load failure and return"); the "Load failure and return" sentence about the Disk.4 message is updated.
- `notes/HANDOFF-2026-11-14-load-pick-message.md`: open point 2 closed (points here).
- `notes/HANDOFF-2026-11-14-scenario-list-state.md`: limit 5 closed (points here).
- `notes/README.md`: newest-handoff pointer.
