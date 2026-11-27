# Utopia handoff: same-frame message line for the marker and money refusals (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run and nothing under `original/` was written (read-only disassembly through `tools/game_img.py`, plus scratch files under `/tmp/haiku-msg/`, outside the repository). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: gap 1 of `HANDOFF-2026-11-13-mode-icon-timing.md` (message line timing). Only the paths the original draws with `$551A` from the input poll were changed: the marker button and the two money refusals. Nothing else about messages, timers, the log panel or the pass order changed.

## 1. Static trace (VERIFIED from the Disk.1 bytes, read-only)

`$551A` (game-text.md section 4) erases the previous line (`$558A`) and draws the new one into both bitmaps at once. It then sets `$156AC` = 200. So a line posted in the input poll is visible in the frame of that update in the original.

| Path | Original chain | Message | Remake before | Remake after |
|---|---|---|---|---|
| Marker button release (`$15B0A` -> `$30FE`) | `$30FE`: `$15EF0` first if not select, then `$6F` (marker armed) | `$6F` | the line showed on the next completed pass | same frame (`presentMessageLine`) |
| Money refusal while placing (`$6CBE`) | `$25`, then `$15EF0` (mode 1) and the icon (`$6B10`) | `$25` | line on the next pass; icon already same frame | line and icon in the press frame |
| Money refusal while clearing ground (`$6D10` -> `$6D2C`) | `$25`, selection cleared, mode kept, no `$6B10` | `$25` | line on the next pass | line in the press frame |

Not covered (kept on the next pass, not traced as same-frame paths): every other line message posted from the poll (keys `$F2`, pins `$71`/`$72`, placement and demolition texts, the building-select prompt `$0`, and so on), and every pass-time message (those are drawn by the pass that posts them).

## 2. Change

- `src/game/messages.ts`:
  - `LINE_BAND` (exported): `{ y: 160, rows: 11 }`, the rows above the log panel (log at 171). Glyphs are 6 rows.
  - `drawLine(screen)`: draws the message line only. `draw()` calls it, then the log, as before.
- `src/game/controls.ts`:
  - `messageLineChanged` one-shot flag, with `takeMessageLineChanged()`. It is cleared at the top of `MapScene.update()` like the mode-icon flag.
  - Set by the marker press in `press()` after `onMarkerButton()`.
  - Set by the builder's `onBuildCancelled` callback for both `leave` values. Both money refusals post `$25` before the callback, so one flag covers both.
- `src/game/map.ts`:
  - `presentMessageLine()`: if the menu is closed, restores rows 160..170 (full width) from `initialPicture`, calls `messages.drawLine(screen)`, and copies the presented frame into the displayed bitmap. It calls no `messages.update()`, no sim, no pass, no RNG, no date or loop state.
  - Called after the completed-pass input poll, right after `presentControlPanel()`.

Timer note: the line timer is set to 200 by `push()` during the poll, after this update's `messages.update()`, so it reads 200 right after the input and is decremented normally from the next update. The presentation adds no decrement.

## 3. Tests

`test/map-loop.mjs`:

- Section 6 (existing): the marker-in-build-mode check moved from "nothing outside the panel box differs" to "nothing outside the panel box and the message band differs". The message line is the intended change there. The helpers `inBand`, `bandDiff` and `offBandDiff` now live in section 6 scope.
- Section 7 (new, 4 cases, each on twin scenes with the same passes):
  - Marker in select mode: the line is in the release frame; only the band differs from the twin; the timer reads 200 (twin 0); no pass advanced; the next pass shows the same band.
  - Marker in build mode: select mode and the line in the release frame; nothing outside the band and panel box differs; timer 200.
  - Money refusal while placing (money 100): the line in the press frame; nothing outside the band and panel box differs; timer 200; money unchanged; no pass advanced; next pass same band.
  - Money refusal while clearing ground (tile `$61`, money 100): the same checks, with the mode kept as build and the selection cleared.

Mutation check (compiled `dist/game/map.js` only, source untouched, rebuilt and restored afterwards): `presentMessageLine()` made a no-op. 5 section-7 checks fail (marker select and build, money refusal, and the next-pass band checks). The restored build passes again.

## 4. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 145 ok, 0 FAIL (was 126 before this handoff's section 7 and its clearing case) |
| `npm test` (full chain, includes `command-buttons`, `message-panel`, `save`, `build-menu`) | exit 0, 4,380 `ok`, 0 `FAIL` (log at `/tmp/haiku-msg/npm-test.log`, scratch, not committed). Optional capture comparators skipped as before. |

## 5. Gaps and residual risks

1. **Other line messages.** Keys, pins, placement and demolition texts posted from the poll still appear on the next pass. The original's `$551A` draws them at once too, but they are not traced as same-frame paths here. Each needs its own trace before it is added.
2. **Log panel.** A log message posted from the poll (a log index in `LOG_INDICES`) is not presented in the same frame. The flag only covers the line, and the log rows are not touched.
3. **Clearing refusal and the preview.** The `$6D2C` path keeps the building preview on the original's bitmaps (mode-icon handoff gap 2). That is unchanged: only the message is now same-frame.
4. **No original capture.** Every change above is a static trace with synthetic tests. The existing `$39` pixel capture (map-rendering.md section 11) is the only pixel reference, and it does not include a message line.
5. **Band height.** Rows 160..170 are the traced line band (glyphs 6 rows, log at 171). The original's `$558A` erase covers rows 159..165, and the remake's pass restores 160..199. The presenter follows the pass, not the original's erase band, so a row-159 difference is not modelled (row 159 is map area, unchanged by either).

## 6. Notes changed

- `notes/formats/game-text.md` section 4: new paragraph "Remake, same-frame line".
- `notes/formats/map-rendering.md` section 9: the bottom panel bullet now records the same-frame line.
- `notes/HANDOFF-2026-11-13-mode-icon-timing.md`: gap 1 marked superseded by this note.
- `notes/README.md`: points to this note as the latest handoff.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
