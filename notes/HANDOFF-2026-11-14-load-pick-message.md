# Utopia handoff: the message after a slot load pick (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator run and no original writes: `original/utopia-whdload/Disk.1` was only read (`tools/game_dis.py`, capstone M68K 020, file offset = address + `$28800`). Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-load-return.md](HANDOFF-2026-11-14-load-return.md) (its section 1 said a valid load already matched; this note corrects that), [formats/game-proper.md](formats/game-proper.md) "Load failure and return" (new paragraph "Load success message"), [HANDOFF-2026-11-14-held-key-routes.md](HANDOFF-2026-11-14-held-key-routes.md) (the held-scene routes, unchanged here).

## 1. Result

**One mismatch, fixed.** After a successful slot load picked from the disk menu, the original shows no message. The remake showed `Game loaded. Select 'EXIT' to play.` on the result line for 53 frames.

Static trace (Disk.1, addresses; no frame or wait lies between the print and the erase):

| Address | Instruction / effect |
|---|---|
| `$88CA` | `move.w #$145,d0`: the load's success message |
| `$88D0` | `bsr $8462`: prints on the **list prompt** (y `$A3`), no `$8CB0` countdown (`$83A2` is the result line and does start one) |
| `$88D4`-`$88E8` | `$866E` (d0 = 1), effect-slot clear |
| `$88EA` | `bra $82B8` |
| `$82B8` `$82E4` | `bsr $84F4`: erases both prompt lines (`$51E6`, 38 bytes at y `$A3` and `$AC`) |
| `$82B8` `$82DE` | `clr.b $938d`: list mode closed |

So the message is drawn and erased in one handler. The remake's `Game.acceptScene` printed it with `DiskMenuScene.printInfo` (`$83A2` semantics, result line y `$B5`, countdown), which the original never does for a load.

Consequence in the remake before this fix: a loaded game's "Select 'EXIT' to play" line stayed on screen for 53 frames. The original shows nothing. Held state and the EXIT are unaffected.

## 2. Change

- `src/game/game.ts`:
  - `acceptScene(index, map, disk4, pick, message)`: the hold now depends on an explicit `pick` flag, not on `message === null`. A pick is held behind the disk menu (`pick` true); the programmatic path (`pick` false) enters at once unless the boot session is open. Behaviour is unchanged for every caller except the load.
  - `loadFromSlot(slot, pick)`: `acceptScene(save.scenario, scene, null, pick, null)`, no message.
  - `startScenario` and `activateDisk4` pass `pick` and keep their messages (`$8B` and `$145` on the result line) as before.
- `src/game/disk-menu.ts`: the `GAME_LOADED_STRING` comment records the trace. The Disk.4 continuation still prints it (its original post-load path is not traced).
- `test/save.mjs`, "held:" block: `held: a load pick shows no message` checks that the result and prompt lines and the countdown are all clear after `loadFromSlot(2, true)`.

Red-green check: with the old code the new check FAILED (save.mjs exit 1, 402 ok); after the change it passes (403 ok, 0 FAIL).

## 3. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 (one type error caught and fixed: `request.pick` is optional, now `request.pick === true`) |
| `node test/save.mjs` | exit 0, 403 ok, 0 FAIL (was 402 before the new check; the check failed first) |
| `node test/disk-menu.mjs` | exit 0, 107 ok, 0 FAIL |
| `node test/disk-menu-keys.mjs` | exit 0, 41 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 50 ok, 0 FAIL |
| `npm test` (full chain) | exit 0, 4,756 ok, 0 FAIL |

No visual parity claim is made. The remake's slot and error pages are remake presentation; this change only removes a message the original erases.

## 4. Open points (not changed)

1. **Scenario pick message (STATIC mismatch; FIXED 2026-11-14, see [HANDOFF-2026-11-14-scenario-prompt.md](HANDOFF-2026-11-14-scenario-prompt.md)).** `$88F0` prints `$8B` ("Scenario loaded. Select 'EXIT' to play.") with `$8462`, so it sits on the list prompt, persists, and has no countdown. The original does **not** call `$82B8` on this path, so the shared list stays open in mode 3 after the pick. The remake prints `$8B` on the result line for 53 frames and closes the list (a new `DiskMenuScene`). Fixing it means printing on the prompt (`printPrompt`) and keeping the list state, but the remake's scenario list is a separate MenuScene page without the original's rows, so the list state has no faithful remake counterpart yet. Left for a separate slice.
2. **Disk.4 load message (FIXED 2026-11-14, see [HANDOFF-2026-11-14-disk4-pick-message.md](HANDOFF-2026-11-14-disk4-pick-message.md)).** The Disk.4 pick is the same mode-2 handler `$8828`; `activateDisk4` no longer prints `$145` for a pick (the earlier wording that its post-load path was only partly traced is superseded: `$888A`-`$88EA` is traced to `$82B8`).
3. **Single-handler erase is a static claim (timing corrected 2026-11-14).** The instruction order and `$51E6`'s erase are static. The earlier "no wait or frame is in that path" was wrong: `$84F4` (`$82E4`) waits for the next VBL (bit 0 of `$156A8`, set by the VBL handler at `$2C58`) before erasing, so the `$145` line is up for one frame at most. See [HANDOFF-2026-11-14-disk4-pick-message.md](HANDOFF-2026-11-14-disk4-pick-message.md) section 3.
4. **Address tooling.** Bash arithmetic in a `$(( ))` expression passed to `game_dis.py` gives a decimal string, which the tool parses as hex. Pass hex strings (`printf '%x'`). The earlier `tools/game_img.py` mapping note (load-return handoff, open point 5) is unchanged.

## 5. Notes changed

- `notes/formats/game-proper.md`: "Load failure and return" gains a "Load success message" paragraph (the trace, the fix, the open scenario case).
- `notes/HANDOFF-2026-11-14-load-return.md`: status line at the top; section 1's "already matches" claim is corrected by this note.
- `notes/README.md`: newest handoff pointer.
