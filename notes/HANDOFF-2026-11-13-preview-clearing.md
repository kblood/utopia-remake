# Utopia handoff: the building preview after a clearing refusal (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run and nothing under `original/` was written. Reads used `tools/game_img.py` (read-only Disk.1 disassembly); the `capstone` package was installed into the user's Python site (`python -m pip install capstone`) to run it. Scratch probes and logs live under `/tmp/haiku-msg/`, outside the repository. Nothing was committed or pushed. The dirty worktree was preserved.

Scope: gap 2 of `HANDOFF-2026-11-13-mode-icon-timing.md` (the `$6D2C` clearing refusal and the building preview). The request assumed the original keeps the preview after the refusal. The trace shows the opposite, so the implementation follows the trace, not the request (see section 1).

## 1. Static trace (VERIFIED from the Disk.1 bytes, read-only)

The clearing path is `$6D10` (`build.ts` `clearGround`):

- `$6D10`: `movea.l $142b6,a1`, `d4 = money - cost*2`, `bpl $6d42` (non-negative: the purchase, `$6D42`).
- Negative money falls through to `$6D28 bsr.w $6ace`, then `$6D2C`: `$142B2/$142B6 = 0` (selection cleared), message `$25` (`$551A`), `rts`. The mode stays build. `$6D2C` has no other entry.

So the refusal **does** run `$6ACE`. The handoff note this replaces said it did not; that was wrong.

`$6ACE` (VERIFIED instruction by instruction):

- Writes the 1800-byte block at `$164AA` (5 planes x 45 rows x 8 bytes) into both plane lists, `$160FA` (front) and `$16116` (back).
- Each plane's destination starts at offset `$138` (312 bytes = row 7, byte 32 = x 256) and steps 40 bytes per row for 45 rows: rows 7..51, x 256..319.
- The file holds zeros at `$164AA`. The block is filled at run time by `$4E40` (VERIFIED copy: rows 7..51 of x 256..319 from `$160FA` into `$164AA`). Its caller is not traced. So `$6ACE` restores the saved panel background, not black.

Effect in the original: the building preview (bottom row 52, rows 22..52) is removed from both bitmaps in the frame of the click. Row 52 is outside the restore, so the preview's bottom row stays. The pass path does not restore it either (`$16012` never touches x 272..319), so it stays until a later `$6B10` writes the bottom row of a mode tile (opaque pixels only).

The remake before this change: the preview stayed visible in the press frame and was dropped by the next pass (its restore covers rows 22..159). That is the real difference, and it is timing, not persistence.

## 2. Change

- `src/game/controls.ts`:
  - `MODE_ICON` is exported.
  - `buildPreviewCleared` one-shot flag, set by the builder's `onBuildCancelled(false)` (the `$6D2C` path). `takeBuildPreviewCleared()` reads and clears it.
  - `modeTileId()` is the single source of what `draw` paints at the icon position. `drawsModeTile` exposes it (true when a mode tile is painted). `draw` now uses it; its behaviour is unchanged.
- `src/game/map.ts`:
  - `buildPreviewBottomRow`: the displayed row 52 (x 272..319) captured at the refusal, or null.
  - `restorePanelArea()` (used by every pass, the presenters and the modal exit): after restoring rows 22..159 from the picture, it writes `buildPreviewBottomRow` into row 52 while no mode tile is drawn. When a mode tile is drawn, it drops the stored row (`$6B10` overwrote it). Row 52 is then the picture plus the tile.
  - `presentBuildPreviewCleared()`: called from `update()` after the input poll, after `presentControlPanel` and before `presentMessageLine`. It captures row 52, restores the panel from the picture, draws the controls (no tile in build mode with no selection), and copies the result into the displayed bitmap. It calls no sim, pass, RNG, date or message timer.

Mode-tile drop, and what it does not cover: a mode tile drops the whole stored row. The stored row has 4 changed pixels (x 286..289), all under opaque pixels of the select icon `$39`. The drop is therefore not visible in the pixels of that case; it is checked through the stored state.

## 3. Not modelled (gaps)

1. `$6ACE` also restores rows 7..21 and x 256..271. The remake leaves those as they are (the top bar, the lights and the picture stand in for the saved block). The preview lies at x 272+, so this does not change the preview.
2. The remake's background is the picture, not `$164AA` as saved by `$4E40`. Not checked against an emulator frame.
3. Transparent pixels of a later mode tile over row 52 are not modelled. The stored row is dropped whole when a tile is drawn.
4. The same `$6ACE` restore also runs on the placement refusal and mode exit (`$15EF0`) and the build-menu commit (`$6BA2`), so the original would also leave row 52 behind there. The remake stores that row only on the clearing refusal. Those paths draw a mode tile in the same frame, which would drop a stored row at once, so the visible difference is limited to transparent pixels of that tile. Not added (the request was the clearing refusal only).
5. The request's clearing list (next accepted action, mode exit, menu transitions) was not used as a rule. The trace shows nothing restores row 52 on those paths: `$6ACE` stops at row 51, and the tile draws cover only opaque pixels. The stored row goes only when a mode tile is drawn, or the scene is rebuilt (a new `MapScene` has none).
6. No original capture of this state. The only pixel reference is the `$39` capture (map-rendering.md section 11), which does not cover x 256..319 rows 7..51.

## 4. Tests

`test/map-loop.mjs`, new section 8 (12 checks, twin scenes as in sections 6 and 7; the refusal cell is found by the same search as section 7):

- the twin still shows the preview in rows 22..51 (the comparison is not empty);
- the press frame: rows 22..51 equal the picture;
- the press frame: row 52 equals the twin's preview row and differs from the picture (4 pixels);
- nothing outside the panel box and the message band differs from the twin; money unchanged; no pass beyond the twin;
- after the next pass: rows 22..51 still the picture; row 52 unchanged; the twin differs only in the panel box and band;
- the stored row is held until a mode tile is drawn; a right click (select icon drawn) drops it; the icon box matches the icon over the picture.

Mutation checks (compiled `dist/game/map.js` only; restored and rebuilt afterwards):

- presenter made a no-op: 3 section-8 checks fail (press-frame rows, row 52 kept, stored row held);
- residue block in `restorePanelArea` disabled: 2 section-8 checks fail (row 52 from the twin, the drop check).

Existing tests: section 6 and 7 pass unchanged (the mode-icon and message-line behaviour is untouched).

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 157 ok, 0 FAIL (was 145) |
| `node test/command-buttons.mjs` | exit 0, 43 ok, 0 FAIL |
| `node test/build.mjs` | exit 0, 54 ok, 0 FAIL |
| `node test/build-menu.mjs` | exit 0, 89 ok, 0 FAIL |
| `node test/message-panel.mjs` | exit 0, 11 ok, 0 FAIL |
| `npm test` (full chain) | exit 0, 4,392 `ok`, 0 `FAIL`. Log at `/tmp/haiku-msg/npm-test.log` (scratch, not committed). Optional capture comparators skipped as before. |

## 6. Notes changed

- `notes/formats/map-rendering.md` section 9: the "Immediate or next pass" paragraph's "not modelled" sentence is replaced, and a new paragraph "Clearing refusal and the building preview" records the trace and the correction.
- `notes/formats/building.md`, item 4 (ground clearing): the refusal's `$6ACE` and `$6D2C` order and the bottom-row note.
- `notes/HANDOFF-2026-11-13-mode-icon-timing.md`: gap 2 marked superseded, with the correction.
- `notes/README.md`: this note is the latest handoff.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read. `grep.exe.stackdump` (untracked, not created here) was left alone.

## 7. Second pass (same day): exit, commit and placement

- Callers of `$6ACE`: `$6BB4` (commit with a pending item), `$6D28` (refusal), `$15ED2` (demolish), `$15F1E` (mode exit). Accepted placement calls none of them and keeps the selection. Details: map-rendering.md, "Mode exit, commit and placement".
- The stored-row "drop when a mode tile is drawn" rule is replaced by `panelBottomRow`, the persistent row 52, changed only by mode-tile draws (masked, `$69D8`). Section 3 gap 3 is closed for the traced paths.
- Visible output is unchanged for every static tile: building bottom rows share the icon's footprint (x 14..17; `$31` also x 13, equal to the picture). The change corrects the state model, not the pixels.
- Tests: map-loop 166 ok (section 8 updated; section 9 added for the `$31` exit). build, build-menu, command-buttons, message-panel pass; `npm test` 4,401 ok, 0 FAIL. Build `npm run build` exit 0.
- Not done: the full bitmap-writer audit; any emulator frame. Demolish and menu-commit tests are now done: see `HANDOFF-2026-11-13-residue-tests.md` (map-loop section 10, synthetic probes plus real tiles).
- Nothing committed or pushed. No original writes. Scratch scripts in /tmp/haiku-msg.
