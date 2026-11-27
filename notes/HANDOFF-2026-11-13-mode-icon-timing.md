# Utopia handoff: when the mode icon changes on the map (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run and nothing under `original/` was written (read-only disassembly through `tools/game_img.py`, plus scratch scripts in a temporary directory outside the repository). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: open gap 2 of `HANDOFF-2026-11-13-icon-exit-mode.md`: which mode-change paths redraw the mode icon at once in the original, and which the remake showed only on the next completed pass. Implemented only where the Disk.1 bytes give the evidence. The global map and pass draw order is unchanged.

## 1. Static trace (VERIFIED from the Disk.1 bytes, read-only)

`$6B10` draws the tile in d5 with `$6A22` into both plane lists (`$160FA` and `$16116`). It is called with `$39` (select) or `$3A` (demolish), or with the committed building. So a call paints the displayed bitmap at once, and `$16012` never restores x 272..319 (map-rendering.md section 9). The mode-change routines and their callers:

| Path | Original chain (Disk.1) | Icon drawn at once? | Remake before this change | Remake after |
|---|---|---|---|---|
| Right click out of build or demolish, not paused, not on an arrow | `$15F44` -> `$15F64` -> `$15EF0` (`$39`) | yes | the icon waited for the next completed pass | in the same frame (`presentControlPanel`) |
| Demolish button release | `$15A74` -> `$15AF8` -> `$15ECA` (sets mode 3, clears selection, `$3A`) | yes | toggled: a second press went back to select | sets demolish, no toggle; icon in the same frame |
| Marker button release (`$30FE`), outside select | `$15B0A` -> `$30FE`: if `$14591` != 1, `$15EF0` first (mode 1, `$39`), then message `$6F` | yes | marker only armed; the mode stayed build or demolish | leaves to select, icon in the same frame, message `$6F` as before |
| Build menu exit, pending item committed | `$B628` -> `$6BA2` -> `$309E` -> `$6B10` (preview), `$551A` prompt | yes | the exit frame kept the old icon until the next pass | preview in the exit frame |
| Build menu exit, nothing pending | `$B628` -> `$6BA2` -> `$15EF0` (`$39`) | yes | the exit frame kept the old icon until the next pass | select icon in the exit frame |
| Money refusal while placing | placement code `$6CBE` -> `$15EF0` (mode 1), `$551A` | yes | `onBuildCancelled(true)`, icon on the next pass | select icon in the press frame |
| Money refusal while clearing ground | `$6D2C`: clears `$142B2/$142B6`, message `$25`, no `$6B10` | no | selection cleared, preview gone at the next pass | unchanged (not flagged) |
| In-game disk-icon EXIT | `$15AEC` -> `$15EF0` | yes | already right: the EXIT's immediate pass paints it | unchanged |

The in-game EXIT's draw comes from the immediate pass, so it needed no change.

## 2. Change

- `src/game/controls.ts`: a one-shot flag `modeIconChanged`, set by `returnToSelectMode()`, the demolish press, the marker press outside select mode, the build-menu commit with a pending item, and the builder's cancel with `leave = true`. `takeModeIconChanged()` reads and clears it. The demolish press sets demolish mode unconditionally (no toggle). The marker press leaves build or demolish mode through `returnToSelectMode()` before `onMarkerButton()`.
- `src/game/map.ts`:
  - `restoreOverlayAreas()` is split. Its panel part (x 272..319, rows 22..159, then the `$5DDA` images) is now `restorePanelArea()`, with the same code and order.
  - `presentControlPanel()`: if the menu is closed, it runs `restorePanelArea()`, `Controls.draw(screen)`, then copies the presented pixels into the displayed bitmap (`screenBuffers[activeScreenBuffer]`). The message line, the map, tiles, lights and the top bar are not touched, and no simulation, RNG, date or loop state changes.
  - `update()` clears the flag at its top, so the in-game EXIT's own flag (set before the update) is painted by that update's pass. After the input poll of a completed pass, and in the modal-exit branch, a set flag calls `presentControlPanel()`.
- `src/game/controls.ts` doc comment of `returnToSelectMode` lists the new callers.

## 3. Behaviour changes beyond timing (static evidence, please review)

These are not only timing. The user asked for the mode paths to be traced, and these two differ from the original's code:

1. **Demolish does not toggle.** `$15A74`-`$15AF8` tests nothing before `bsr $15ECA`, which sets `$14591` = 3 unconditionally. The remake used to return to select on a second press. `test/command-buttons.mjs` asserted the toggle; it now asserts that a second press keeps demolish mode, and that a right click leaves it.
2. **The marker button leaves build or demolish mode.** `$30FE` runs `$15EF0` when `$14591` != 1, before the marker-armed message `$6F`. The remake only armed the marker. Covered by `test/command-buttons.mjs` (mode select, marker count +1) and `test/map-loop.mjs` section 6.

## 4. Tests

`test/map-loop.mjs`, new section 6 (inside the game-data block, Disk.1/Disk.2 present). Each case runs two identical `MapScene`s (twins). The input scene gets the input on a pass boundary (the update that polls it). The twin gets a quiet update there. Checks: the frame of the input update shows the mode icon (`iconMismatch` over the picture, as in section 5); the panel after the next quiet pass equals the panel of the input frame; nothing outside the panel box differs from the twin.

Cases: right click out of build mode; demolish release, and a second press; marker release in build mode; build menu exit with a pending item (preview); build menu exit with nothing pending (select); money refusal while placing (a cell in the view is tried until a refusal; money 100 < price 6000); paused right click (no change, panel unchanged).

Mutation check: `presentControlPanel()` made a no-op (temporary, source restored and checked byte-identical, then rebuilt). 9 of the new checks fail.

`test/save.mjs`, the in-game exit block (f)-(h), passes unchanged; the in-game EXIT path is not changed.

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 126 ok, 0 FAIL (was 104; section 6 adds 22) |
| `node test/command-buttons.mjs` | exit 0, 43 ok, 0 FAIL (was 40; demolish and marker checks changed and added) |
| `node test/save.mjs` | exit 0, 383 ok, 0 FAIL (unchanged) |
| `node test/build-menu.mjs` | exit 0, 89 ok, 0 FAIL (unchanged) |
| `npm test` (full chain) | exit 0, 4,361 `ok`, 0 `FAIL`. Log at `/tmp/haiku-mode/npm-test.log` (scratch, not committed). The optional capture comparators were skipped as before. |

## 6. Gaps and residual risks

1. **Message line timing (superseded by `HANDOFF-2026-11-13-message-line-timing.md`).** A message posted by the same poll (the marker `$6F`, the money refusal `$25`) reached the message line on the next pass in the remake. The original's `$551A` draws it at once. `presentControlPanel` does not touch rows 160..199 (on purpose), so this is still next-pass. Not changed here.
2. **`$6D2C` clearing refusal (superseded by `HANDOFF-2026-11-13-preview-clearing.md`).** This gap's premise was wrong: `$6D10` runs `$6ACE` before `$6D2C` (the money branch `$6D26` falls through to `$6D28 bsr $6ACE`), so the original removes the preview's rows 22..51 in the frame of the click. Only its bottom row 52 stays. The remake now does the same-frame removal and keeps that row, with tests.
3. **`$6ACE` plane clear** before `$15EF0`, `$15ECA` and `$6B10` in `$6BA2` is not modelled. The remake's panel restore from the picture stands in for it.
4. **Command-button flips.** `$5756`/`$57FA` write both bitmaps at once in the original; the remake flips on the pass (unchanged here).
5. **Right click in select mode** also runs `$15EF0` in the original (`$15F64`, `jsr $3EDC` then `bsr $15EF0`). The icon and selection are unchanged in select mode, so nothing visible differs. Not modelled.
6. **No original capture** of build, demolish or marker mode changes. Every change above is a static trace with synthetic tests; the existing `$39` capture (map-rendering.md section 11) is the only pixel reference.

## 7. Notes changed

- `notes/formats/map-rendering.md` section 9: new paragraph "Immediate or next pass".
- `notes/formats/game-proper.md`: dispatch table rows 2 and 3.
- `notes/formats/building.md`: command-button list (demolish, marker).
- `notes/formats/screens.md`: marker mode paragraph.
- `notes/HANDOFF-2026-11-13-icon-exit-mode.md`: gap 2 marked superseded.
- `notes/README.md`: points to this note as the latest handoff.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
