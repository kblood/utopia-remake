# Utopia handoff: message line and log erase at expiry (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed, and no subscription usage was checked or timer scheduled. No emulator was run and nothing under `original/` was written. The Disk.1 bytes were read with `tools/game_img.py`'s decoder through a scratch script in the user's temp folder (outside the repository). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: the open point "erase lag" from `HANDOFF-2026-11-13-post-wait-message.md` (section 5.1). Question: are the line's or the log's pixels erased in the same VBL/update as the timer reaches 0? Presentation only: no timer, pass, RNG, date or loop state changed.

## 1. Static trace (VERIFIED from the Disk.1 bytes, read-only)

`$2CAA` (VBL handler), in order:

- `tst.w $156AC`; if nonzero, `subq.w #1,$156AC`; `bne` skips the next step; at zero it falls through to `bsr.w $558a`. So the line's erase runs in the same VBL that makes the 200-frame count 0.
- `$14634` (log idle): `tst`, `ble` (skip at 0), `subq`. The VBL only decrements it. It does not clear the log.

`$558A` (line erase): copies 7 rows from y 159 (5 planes x 40 bytes per row, from the saved strip `$28FD2`) into both bitmaps (`$160FA` and `$16116`). The strip was captured at setup by `$4FFA` from bitmap A, rows 159..165.

`$15850` (log idle clear, main loop): `tst.w $14634`; if zero, `subq` (so the clear runs once), `$5C9A` paints the 3-line pattern fill over rows 171..194, `used = 0`. It sits after the pass's VBL wait (`$15846`), so it runs in the first iteration after the VBL that made `$14634` 0. The remake's pass is 4 VBLs (`DEFAULT_VBL_PER_PASS`, a measured baseline), so the log's pixels go 0 to 3 updates after the timer reaches 0, at the next pass boundary.

Answer:

| Element | Timer reaches 0 in | Pixels erased in (original) | Remake before | Remake after |
|---|---|---|---|---|
| Line (`$156AC`) | VBL `$2CAA` | that same VBL (`$558A`) | next completed pass, 0 to 3 updates late | same update (`presentLineErase`) |
| Log (`$14634`) | VBL `$2CAA` (decrement only) | the next main-loop check `$15850` (next pass boundary) | next completed pass (`drawPass`, fill) | unchanged (already the next pass) |

## 2. Change

`src/game/messages.ts`:

- `update()` returns `true` when the line timer reaches 0 in that call (not on a held tick). The log's idle clear is not reported.
- `lineShowing` getter (`lineLeft > 0`).
- `LINE_GLYPH_BAND` (exported): rows 160..165, the 6-row glyph band.

`src/game/map.ts`:

- `update()` keeps the return value of `messages.update()` as `lineExpired`.
- `presentLineErase()` runs after the frame is drawn (after the pass's draw or the modal branch, before the completed-pass block). It repaints rows 160..165 from `initialPicture` and copies the frame to the displayed bitmap. It returns early when `messages.lineShowing` (while a modal is visible it repaints only the persistent buffer; see `HANDOFF-2026-11-13-expiry-reach.md`) (a line posted after the expiry is drawn by its own presentation, and must not be erased).
- Row 159 is traced in `$558A` but is not repainted. It is the map-window snapshot row (`map-background.ts` region 3, rows 89..159) and the panel's top row (`restorePanelArea`). Whether the original's strip differs from the remake's picture there is not verified, so the change does not overfit it.

No change to the log pixels or the log state. The log's state is emptied at the VBL expiry in `Messages.update` (the remake), but the original empties it in the main loop. This is a state-timing difference. It is not visible on screen, because nothing on the normal update path redraws the log between the two.

## 3. Tests

`test/map-loop.mjs`, new section 7g (19 checks):

- Line: a push at phase 1 (not a pass boundary) gives timer 200, expiry at exactly 200 updates, and the expiry update is not a completed pass. The glyph rows equal the quiet twin in the expiry update, and differ from it in the 197 updates shown before. Nothing outside the glyph rows differs from the twin in that update. The timer reads 0 with no extra tick. The next pass keeps the line gone.
- Log: a push at phase 1, idle expiry at exactly 500 updates, the expiry update is not a pass. The panel rows (171..194) are unchanged in the expiry update, and the next completed pass erases them (differs from the text panel).

Mutant check (compiled `dist/game/map.js` only; source untouched; rebuilt and restored afterwards): `presentLineErase()` made a no-op. It fails exactly the two line checks that the expiry update must erase ("glyph rows equal the twin in the expiry update", differs=145, and "the expiry update changed the glyph rows"). The log checks and the rest pass, as expected, since the log is unchanged.

## 4. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (before and after the change) |
| `node test/map-loop.mjs` | exit 0, 283 `ok` (was 269), no `FAIL` |
| `node test/message-panel.mjs` | exit 0, 15 `ok`, no `FAIL` |
| `node test/checkpoint.mjs` | exit 0, 67 `ok`, "all checkpoint checks passed" |
| `npm test` (full chain) | exit 0, 4,522 `ok` (was 4,508), no `FAIL` |

Optional capture comparators were skipped (no external Copperline captures set), as before.

## 5. Still open

1. **Row 159 (resolved 2026-11-13, see `HANDOFF-2026-11-13-row159-erase.md`).** The original's `$558A` erases 159..165. The remake now repaints 159..165 full width (`LINE_ERASE_BAND`), which changes no visible pixel in any state probed. The text below is the original open point, kept for history: the remake repainted only 160..165 (`LINE_GLYPH_BAND`). Whether row 159 holds anything the remake would wrongly overwrite, and whether the original's setup strip matches the remake's `initialPicture` there, is not verified. The change assumes the strip equals the setup picture (`$4FFA` reads bitmap A at setup, not the pristine file).
2. **Log state timing.** The remake empties the log list at the VBL expiry; the original does it in the main loop at the next pass. Pixel timing matches. A checkpoint or inspector that reads the list would see the earlier empty list. Moving the state clear to the pass boundary would change `Messages.update`'s contract (and the checkpoint `messagesPushed` / `inspect` expectations), so it was not changed here.
3. **Pass length.** The "0 to 3 updates" for the log depends on the 4-VBL pass baseline (`DEFAULT_VBL_PER_PASS`), which is pointer-dependent in the original (4 or 5 frames, `main-loop.ts`).
4. **No original capture.** These are static traces plus synthetic tests. No Copperline frame of a line or log expiry exists.
5. **Modal frames (partly resolved 2026-11-13).** An expiry during an open build menu leaves the modal frame clean (`controls.draw` covers the glyph rows), but the persistent buffer kept the glyphs, so the menu exit frame showed them for one update. The erase now repaints that buffer during a modal (`HANDOFF-2026-11-13-expiry-reach.md`, test `test/map-loop.mjs` 7i). The original's exit frame is not observed.

## 6. Notes changed

- `notes/formats/game-text.md` section 4: the "Line erase lag (open)" paragraph is replaced by "Line erase at expiry (fixed)", with the row-159 open point. Section 5 step 6 gets the log erase timing (STATIC).
- `notes/HANDOFF-2026-11-13-post-wait-message.md`: section 5.1 is marked resolved, pointing here.
- `notes/README.md`: newest handoff pointer.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
