# Utopia handoff: row 159 in the line's expiry erase (2026-11-13)

Model and routing: Claude Haiku 5.5, inline. No orchestration tool was called, so `claudeAgent` routing was not confirmed, and no subscription usage was checked or timer scheduled. No emulator was run and nothing under `original/` was written (the Disk.1 and Disk.2 files were only read by the test and the probes). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: the open point 5.1 of `HANDOFF-2026-11-13-line-expiry.md`. Question: can the expiry erase repaint row 159 as the original's `$558A` does (7 rows from y 159, full width) without corrupting the map window, the selection, the button column or the menu residue? Presentation only: no timer, pass, RNG, date or loop state changed.

## 1. Static trace (VERIFIED from the Disk.1 bytes in earlier slices; not re-read this time)

`$558A` (line erase, called by the VBL `$2CAA` in the update that makes `$156AC` 0) copies 7 rows from y 159, 5 planes x 40 bytes per row (full width, x 0..319), from the strip `$28FD2` into both bitmaps. The strip was captured at setup by `$4FFA` from bitmap A. STATIC: the setup picture is the bitmap A content at that point (`$2B1A` copies A to B; no line is drawn yet). So the original's expiry puts the setup picture back on rows 159..165.

## 2. What row 159 holds in the remake (MEASURED, scratch probes outside the repo)

Row 159 of the remake's frame equals `initialPicture` in every state probed, so the restore is a no-op for everything the remake draws today:

| Source of pixels in rows 159 | Why it equals the picture |
|---|---|
| Map window, x 0..255 (`map-background.ts` region 3 restores rows 89..159 from the picture every pass) | The restore rewrites it each pass; tiles, units and effects do not reach it (below). |
| Panel, x 272..319 (`restorePanelArea` restores rows 22..159 from the picture; row 52 is the only exception) | Restored each pass. No command button reaches row 159 (`BUTTONS`: y 139 + 16 = rows 139..154). |
| Gap, x 256..271 | Nothing writes it (region 4 covers rows 47..96 only). |

Probes (scratch scripts in the user's temp folder, run against `dist/`, not in the repository):

- Select, build (tile `$45`, type 22) and demolish modes: pre-line, line, expiry and next-pass frames, and the twin, compared against `initialPicture` row 159 per region. All zero.
- Pointer grid 2,176 positions per mode (x 0..255 step 4, y 24..159 step 4), a `pickCell` hit on 1,152 of them: row 159 (x 0..255) worst difference 0 in all three modes.
- Scrolls (47,33), (0,0), (20,10), (40,20), (60,40), (8,0): 0 in every case.
- 16 tanks in the bottom view row over 200 passes: the lowest changed row in x 0..255 is 150 (tiles and units), so row 159 never changes.
- Tank sub-cell `dy` from -16 to +16 at view cells (7,7), (6,7), (7,6): the lowest changed row reached 162, 154, 154 at `dy` = 16. That is outside the reachable range: `STEP_PIXELS` (units.ts) gives `dy` up to 15 for a unit moving down, and a unit leaving the window is hidden (`$3694` window rule). Derived bound (STATIC plus code reading, not an emulator result): a unit's sprite is anchored at its origin cell, so the worst case that stays in the window is a unit moving down from view cell (7,6) to (7,7): anchor 143, `dy` up to 15, lowest pixel row 157. Row 159 is not reached.
- Command buttons end at row 154; the mode icon and side preview are at row 52. `$5DDA` button images (after a build-menu exit): the panel stays equal to the picture at row 159.

So in the remake's states the restore changes no visible pixel. The reason is that the remake's picture and its restores already agree at row 159, not that row 159 is unused in the original.

## 3. Change

- `src/game/messages.ts`: `LINE_GLYPH_BAND` (rows 160..165) is replaced by `LINE_ERASE_BAND = { y: 159, rows: 7 }`, the traced `$558A` rows.
- `src/game/map.ts`: `presentLineErase()` repaints `LINE_ERASE_BAND` (full width) from `initialPicture` and copies the frame to the displayed bitmap. Its guards are unchanged (skipped while a modal is visible or a new line is showing). The doc comments are updated.
- No change to the log, the message band (rows 160..170 `presentMessageLine`), the pass order or any timer.

Why it is safe to ship as a change (not only a note): it matches the traced `$558A` rows; it is a no-op in every remake state probed; the test below would detect a row-159 regression in the three modes.

## 4. Tests

`test/map-loop.mjs`, new section 7h (18 checks, three modes): one update before the expiry, row 159 is XORed with 1 at every x (the frame then differs from the picture). The expiry update must:

- not be a completed pass, and clear the line;
- restore row 159 to `initialPicture` across x 0..319;
- change nothing outside rows 159..165 (the poke is the only other change);
- equal the quiet twin in row 159;

and the next completed pass keeps rows 159..165 equal to the twin. Section 7g is unchanged (its checks pass: the glyph rows equal the twin, nothing outside the glyph rows changes).

Mutant check (compiled `dist/game/messages.js` only; source untouched; rebuilt and restored afterwards): `LINE_ERASE_BAND` set back to `{ y: 160, rows: 6 }`. Exactly six checks fail: "after the expiry row 159 equals the setup picture" and "row 159 of the expiry frame equals the quiet twin", in select, build and demolish. The restored build passes with 0 FAIL.

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 301 `ok` (was 283), no `FAIL` |
| `node test/message-panel.mjs` | "message panel tests passed" |
| `npm test` (full chain) | exit 0, 4,540 `ok` (was 4,522), no `FAIL` |

Optional capture comparators were skipped (no external Copperline captures set), as before.

## 6. Still open (needs original evidence)

1. **Object pixels in row 159 at expiry in the original.** The remake's geometry says no unit reaches row 159, but the original's `$16012` restores region 3 through row 159, which hints that something can be drawn there. A Copperline frame at a line expiry, with the view's bottom row occupied (a unit or an effect at view row 6..7 in motion), would settle whether `$558A` erases object pixels there. This is the evidence that would change the remake's row-159 behaviour.
2. **The strip's source.** `$4FFA` is assumed to sample bitmap A as the setup picture. A trace of `$4FFA`'s bitmap pointer and its call order against `$2B1A`/`$7D24` would confirm it (STATIC; not done this slice).
3. **Modal frames.** `presentLineErase` is still skipped while a modal is visible; the original's `$558A` during a modal (the VBL still runs) is not modelled on screen (as in the line-expiry handoff, section 5.5).
4. **The geometry bound** (row 157 maximum for units in the window) is derived from `STEP_PIXELS`, `anchorY` and the `$3694` window rule. It was checked by probes with sub-cell offsets, not by an original frame.

## 7. Notes changed

- `notes/formats/game-text.md` section 4: the "Line erase at expiry" paragraph now says rows 159..165, and the row-159 open point is replaced by a resolved paragraph with the evidence and the remaining gaps.
- `notes/HANDOFF-2026-11-13-line-expiry.md`: section 5.1 marked resolved, pointing here.
- `notes/README.md`: newest handoff pointer.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read. The scratch probe scripts were kept in the user's temp folder, not in the repository.
