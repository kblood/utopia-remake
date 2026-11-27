# Utopia handoff: first map pass after an in-game map-icon exit (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run and nothing under `original/` was written. Nothing was committed or pushed. The dirty worktree was preserved.

Scope: after the in-game map-icon EXIT (the disk icon on the map, `$15AE6` -> `$7E52`, exit `$802C`), does the loop resume in its current iteration, and should the remake arm an immediate pass as it does for a held load and a scenario? Follows `HANDOFF-2026-11-13-load-first-pass.md`, which left this open.

## 1. Static answer (VERIFIED from the raw Disk.1 bytes, read-only)

Disassembly from `tools/game_img.py` (capstone, installed for this read; the helper itself is unchanged).

The loop body, in order (`$157BC`-`$158C6`):

- body `$157BC` ... `$5D30`, `$2E10`, `$2F5E`, `$15846 bclr.b #0,$156A8 / beq` (the VBL wait), `$15888 jsr $99C4` (the periodic pass), `$1588E jsr $50B2` (poll), then the dispatch: a right/left click routes to `$158CA` or `$15A74` (icon dispatch, `$158B0`), `bsr.w $15b4a` (keyboard, `$158C2`), and `bra.w $157bc` (`$158C6`).

The in-game disk icon, icon 8 (`$15A74` -> `$15AE0`):

- `$15AE6 jsr $7e52` (the disk menu), then on exit `$15AEC bsr.w $15ef0` (mode reset and redraw, see gap 1), `rts`.
- The `rts` returns into the dispatch's caller at `$158B4 bra.b $158c2`, which runs the keyboard poll `$15B4A` and then `bra.w $157bc`.

So the in-game EXIT does not return to a point that skips the body. It finishes the current iteration (keyboard poll), then starts the next iteration at `$157BC` (body, VBL wait, pass). That is the same loop top the held scene's exit reaches through `$157B4`/`$157BC`, and the same shape as a fresh scenario's entry. The pass of the iteration that opened the menu had already run before the poll, so the disk menu did not interrupt a pass.

**Conclusion:** the in-game icon exit should arm the immediate pass, like a held scene's exit. The original's VBL-wait timing question (`$15846`, the menu clears the bit just before EXIT) is the same open question as in the load-first-pass handoff and is not settled here.

## 2. Remake before this change

- `Game.diskIcon`, exit button: `closeMenu()` (`leaveDiskMenu`, stage `map`) and no pass armed.
- `Game.update`, the immediate-pass block after the stage switch, ran only when the map object changed (`this.map !== mapBeforeUpdate`). A held scene or a tutorial changes it, so the block ran there; an in-game exit keeps the same map object, so the block would not run even if armed.
- So the in-game exit ran no immediate pass; its first pass followed the 4-update cadence.

## 3. Change (narrow)

`src/game/game.ts`:

- `diskIcon`, `DISK_BUTTON.exit`: after `closeMenu()`, when `stage === "map"` and `this.map` is set, call `this.map.loop.resumeWithImmediatePass()`. A refused exit (game over), a boot-session exit and a held scene's exit (which already arms in `enterHeldScene`) are not affected.
- `Game.update`: capture `stageBeforeUpdate`. The immediate-pass block now runs when the stage is `map` and either the map object changed or the stage was `disk` before the update. A modal exit inside `MapScene` is unaffected (its stage was `map`).

No save format, loop, or `MainLoop` change. `closeMenu` is called from other flows (save and load success, slot-error cancel); those are not changed, and the arm is placed only at the disk-icon exit.

## 4. Tests

`test/save.mjs`, new block after "held load pass" (14 checks, driven through `Game.update` with the real disk-menu clicks):

- (a) In-game icon exit on a running scenario: the open menu runs no pass; the exit update runs exactly one pass and clears the flag; the next passes follow the cadence (none on the next two updates, one on the third; observed passes `4,4,5` from a base of 3).
- (b) Saved load: a save taken after passes stores no pending pass; an in-game load is held behind the menu and arms nothing; its exit runs exactly one pass on the restored count.
- (c) In-game scenario pick: held behind the menu, nothing runs before EXIT; the exit runs one pass of the new scene.
- (d) In-game tutorial: enters at once and its click runs exactly one pass.
- (e) In-game exit refused in game over: the menu stays open and no pass is armed or run.

Mutation check: with the arm line removed from `diskIcon` (temporary, restored afterwards), the save test fails two checks ("the EXIT update runs exactly one pass", and the cadence check reads `3,3,4`). The restored source was rebuilt and the file was checked to match.

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/save.mjs` | exit 0, 374 ok, 0 FAIL (was 360) |
| `node test/map-loop.mjs` | exit 0, 104 ok, 0 FAIL |
| `node test/disk-menu.mjs`, `test/game-over.mjs`, `test/eclipse-parity.mjs`, `test/tutorial-route.mjs`, `test/game-music.mjs` | exit 0 each, 0 FAIL |
| `npm test` (full chain) | exit 0, 4,327 `ok`, 0 `FAIL`. Log at `/tmp/npm-test-icon-exit.log` (not committed) |

The optional capture comparators were skipped as the chain intends (no `UTOPIA_*_CAPTURE` set).

## 6. Gaps and residual risks

1. **`$15EF0` side effects on the in-game exit (SUPERSEDED 2026-11-13, see `HANDOFF-2026-11-13-icon-exit-mode.md`).** The mode part is implemented: the in-game exit returns the controls to select mode and clears the selection (`Controls.returnToSelectMode`). The original text follows.
   **`$15EF0` side effects on the in-game exit are not modelled (open, static, traced).** `$15AEC bsr $15EF0` runs on that exit. `$15EF0` sets `$14591` = 1 (select mode), redraws the mode icon (`$6B10`, `$39`), clears and sets `$156A8` bit 2, and calls `$6ACE`, `$2F5E` and `$6B10`. The remake's disk-icon exit does not reset `Controls.mode`, so a build or demolish mode survives the exit. The disk button in `Controls` does not reset it either. This is a separate, concrete divergence; it was not implemented here because it changes the mode state and the mode icon, which are verified against captures. It is the next thing to settle with the same static trace.
2. **VBL timing of the first pass is unresolved** (same as `HANDOFF-2026-11-13-load-first-pass.md`, gap 1). The menu clears `$156A8` bit 0 just before EXIT, so the original's wait at `$15846` may add up to one VBL before the pass; the immediate pass does not model that frame. Resolving it needs a read-only emulator run with breakpoints at `$15846` and `$15888` after the EXIT click.
3. **Cadence after the immediate pass.** The remake's immediate update also counts a VBL (`MapScene.update`, `loop.vbl(true)`), so the next pass comes three updates later, not four. This is the existing held-scene model, now covered for the in-game exit too; it was not re-derived from the original here.
4. **Other `closeMenu` callers are unchanged** (save and load success, slot-error cancel). Their original routes were not traced in this change.

## 7. Notes changed

- `src/game/game.ts`: `diskIcon` exit arm and the `Game.update` block condition.
- `test/save.mjs`: the new in-game block (after "held load pass").
- `notes/formats/game-proper.md`: "First pass on EXIT" paragraph (in-game exit now armed; `$15EF0` gap recorded).
- `notes/HANDOFF-2026-11-13-load-first-pass.md`: the in-game exit gap marked superseded.
- `notes/README.md`: points to this note as the latest handoff.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
