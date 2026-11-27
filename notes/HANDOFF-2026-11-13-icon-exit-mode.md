# Utopia handoff: mode reset on the in-game disk-icon exit (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run and nothing under `original/` was written (read-only disassembly through `tools/game_img.py`). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: the open gap 1 of `HANDOFF-2026-11-13-icon-exit-pass.md`. The original's in-game disk-icon exit runs `$15EF0`, which sets the select mode `$14591` = 1 and clears the selection. The remake kept build or demolish mode through that exit.

## 1. Static answer (VERIFIED from the Disk.1 bytes, read-only)

- `$15AE0`: `cmpi.b #8,d2` / `$15AE6 jsr $7e52` / `$15AEC bsr.w $15ef0` / `$15AF0 rts`. This is the in-game disk icon.
- `$802C` (exit): the refused branch `btst.b #3,$156aa` / `bne.w $7ef6` returns to the disk-menu loop and never reaches `$15AEC`. The normal exit ends at `$80C6 rts`, so it returns to `$15AEC`.
- `$15EF0` (VERIFIED, the mode part): `move.b #1,$14591` (select mode), `moveq #0,d0` / `move.l d0,$142b2` / `move.l d0,$142b6` (the selection cleared), `moveq #$39,d5` / `jsr $6b10` (the select icon drawn). It also runs `$2F5E`, `bclr/bset #2` on `$156A8` and the INTENA bracket with `$4AA8 = $FFFF`. `$6ACE` clears the bitmap plane lists in the panel area.
- The other `$15EF0` callers (right click `$15F64`, build-menu exit with nothing pending `$6BA2`) already had the mode reset in the remake. The boot tail (`$157B4 bsr $15EF0`) and the tutorial and held exits run it too, but each builds a new `MapScene`, so the remake's controls already start in select mode.

## 2. Change

- `src/game/controls.ts`: new method `Controls.returnToSelectMode()` (the mode part of `$15EF0`: `mode = "select"`, `selection = null`). The right-click path (`update`) and the build-menu exit with nothing pending (`menuRelease`) now call it. Their behaviour is unchanged.
- `src/game/game.ts`, `Game.diskIcon`, `DISK_BUTTON.exit`: the in-game branch (a map, no held scene, not the boot session, not game over) calls `this.map.controls.returnToSelectMode()` after `closeMenu()`, before `resumeWithImmediatePass()`. A refused exit (game over, boot menu) and a held scene's exit do not reach this branch.
- The mode icon needs no separate redraw state. `Controls.draw` paints the icon of `mode` on each completed pass, and the EXIT's immediate pass is one. The remake therefore shows the select icon from that frame.

No save format, loop, `MainLoop` or disk-menu change. `closeMenu` is still called from the save success and slot-error routes without the reset (unchanged, see gap 3).

## 3. Tests

`test/save.mjs`, in-game block after "in-game icon exit refused in game over":

- (e, extended) refused game over keeps build mode and its selection.
- (f) build mode: the pass before EXIT shows no select icon; EXIT returns to the same map in select mode with no selection; the EXIT update still runs exactly one pass; the next frame draws the select icon (`$39`, box x 272..303, rows 30..52, checked pixel by pixel as in `map-loop.mjs` section 5).
- (g) demolish mode: the pass before EXIT draws the demolish icon (`$3A`); EXIT returns to select; the next frame draws `$39`, not `$3A`.
- (h) a held scenario pick made from build mode: the entered scene is in select mode with no selection.

Helpers: `passFrame` steps to a completed pass before a pre-EXIT frame check, because the icon is painted on passes and a plain update keeps the previous icon. This is the existing model (`MapScene.drawPass`), not a change.

Mutation check: removing the `returnToSelectMode()` call from `diskIcon` (temporary; the source was restored and checked byte-identical, then rebuilt) fails four checks: the build-mode EXIT state, its next-frame icon, the demolish EXIT state and its next-frame icon.

## 4. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/save.mjs` | exit 0, 383 ok, 0 FAIL (was 374 ok) |
| `node test/map-loop.mjs` | exit 0, 104 ok, 0 FAIL |
| `node test/disk-menu.mjs` | exit 0, 107 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 50 ok, 0 FAIL |
| `node test/boot-menu.mjs` | exit 0, 51 ok, 0 FAIL |
| `node test/button-image-carry.mjs`, `test/build.mjs`, `test/eclipse-parity.mjs`, `test/tutorial-route.mjs`, `test/game-music.mjs` | exit 0 each, 0 FAIL |
| `npm test` (full chain) | exit 0, 4,336 `ok`, 0 `FAIL`. Log at `/tmp/npm-test-mode-exit.log` (not committed). The optional capture comparators were skipped as before. |

## 5. Gaps and residual risks

1. **Pointer and plane clear not modelled.** `$15EF0`'s `$2F5E`, the `$156A8` bit 2 and `$4AA8` pointer flags, and `$6ACE`'s plane clear have no remake state. The remake draws the pointer each frame, and the panel is repainted on the pass. Not observed in the original.
2. **Icon timing on other mode changes (SUPERSEDED 2026-11-13, see `HANDOFF-2026-11-13-mode-icon-timing.md`).** The static trace shows `$6B10` paints at once, and the remake now shows those changes in the frame of the input that made them (`MapScene.presentControlPanel`). The original text follows. The original's `$15EF0` draws the select icon at once (`$6B10`), for example on a right click out of build mode. The remake paints the icon on the next completed pass, up to four video updates later. The EXIT is not affected, because its immediate pass paints the icon. This existing timing is unchanged here; it needs a capture before anything is changed.
3. **Other exit routes are not traced here.** `closeMenu` for save success and the slot-error BACK still leaves the mode unchanged. Their original routes to `$802C` were not traced in this pass.
4. **VBL timing of the first pass** is still open (`HANDOFF-2026-11-13-load-first-pass.md`, gap 1). The mode reset does not change it.
5. **No original capture** of build or demolish exit. The reset is a static trace (`$15AEC` -> `$15EF0`) with synthetic tests; the demolish icon itself has no original capture (map-rendering.md section 9).

## 6. Notes changed

- `src/game/controls.ts`: `returnToSelectMode()` and its call sites.
- `src/game/game.ts`: the `diskIcon` EXIT branch.
- `test/save.mjs`: the in-game block (e extended, f, g, h).
- `notes/formats/game-proper.md`: new bullet "In-game disk-icon exit" after the game-over restart bullet.
- `notes/formats/map-rendering.md`: section 9 mode icon sentence points to the exit.
- `notes/HANDOFF-2026-11-13-icon-exit-pass.md`: gap 1 marked superseded.
- `notes/README.md`: points to this note as the latest handoff.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
