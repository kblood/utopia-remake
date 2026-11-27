# Utopia handoff: row-52 residue on demolish and build-menu commit, tests (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the test sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run and nothing under `original/` was written. Scratch probes live under `/tmp/haiku-msg/`, outside the repository. Nothing was committed or pushed. The dirty worktree was preserved.

Scope: the open gap in `HANDOFF-2026-11-13-preview-clearing.md` section 7 ("Not done: demolish and menu-commit tests"). The previous note's trace says `$6ACE` runs on the demolish button (`$15ED2`) and on the build-menu commit with a pending item (`$6BB4`), and that row 52 stays. Those paths had no tests.

## 1. Trace used (STATIC, Disk.1, from the earlier notes; not re-read this pass)

- `$15ED2` (demolish) and `$6BB4` (commit) call `$6ACE`, which restores rows 7..51 only. Row 52 is not restored.
- Both then call `$6B10`, which blits the new mode tile with the plane-5 mask (`$69D8`): transparent pixels keep what the bitmap held.
- So the held bottom row persists where the new tile is transparent, and the next pass keeps it.

Details and the callers' list: `notes/formats/map-rendering.md`, "Mode exit, commit and placement".

## 2. Pixel fact for the shipped tiles (VERIFIED, from tile data, scratch probe)

Every mode and building tile checked (`$31`, `$39`, `$3A`, `$45`, `$61`) has an opaque bottom row only at x 14..17 (screen x 286..289), transparent elsewhere on that row. A new tile therefore always overwrites the held pixels that could differ from the picture. With the real tiles the residue is state-only: no pixel differs from the picture-based model. The tests cannot show residue with real data, so section 10 uses synthetic probes.

## 3. Tests added (no source change needed)

`test/map-loop.mjs`, new section 10 (inside the game-data block, reuses the section 6 helpers). 26 new checks in total (`ok` count 166 -> 192 in map-loop):

- Demolish probe: a held `$61` preview, then the demolish press/release with a synthetic `$3A` whose mask is clear at x 14..17. Checks: the held pixels differ from the picture, the release frame and the held state keep row 52, the twin differs only outside the panel box and message band, the next pass keeps row 52, mode and panel box.
- Demolish, real tiles: row 52 equals the `$3A` composite over the held row; the icon box matches `$3A` over the picture; the next pass keeps both.
- Commit probe: a held `$61` preview, then the build menu (open, page 2, pick `$45`, exit) with a synthetic `$45` clear at x 14..17. Checks: the exit commits `$45`, the exit frame and held state keep row 52, the next pass keeps row 52 and the panel box.
- Commit, real tiles: row 52 equals the `$45` composite over the held row; the icon box matches `$45` over the picture; the next pass keeps both.

## 4. Mutation checks (compiled `dist/game/map.js` only; rebuilt from source afterwards)

| Mutation | Result |
|---|---|
| M1: `restorePanelArea` restores row 52 from the picture, not `panelBottomRow` | 8 FAIL: the demolish and commit probes (release/exit frame, held state, next pass) and the existing section 8/9 residue checks. The real-tile checks still pass, as expected (see section 2). |
| M2: `keepPanelBottomRow` stores nothing | 9 FAIL: the probes plus the section 8/9 held-state checks. |

After each mutation the file was rebuilt with `npm run build`; the restored suite passes.

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 192 ok, 0 FAIL |
| `node test/build-menu.mjs` | exit 0, 89 ok, 0 FAIL |
| `node test/command-buttons.mjs` | exit 0, 43 ok, 0 FAIL |
| `node test/build.mjs` | exit 0, 54 ok, 0 FAIL |
| `npm test` (full chain) | exit 0, 4,427 `ok`, 0 `FAIL` (was 4,401). Optional capture comparators skipped as before. |

## 6. Limits and open points

- The synthetic probes test the state mechanism (row 52 held through a masked blit and a pass). They are not an original capture. Whether the original's bottom row for a masked tile matches the held pixels is not established.
- Real-tile checks show that the held row changes no pixel, so they guard against an unnoticed regression in the composite and icon box, not the residue itself.
- Demolish from select mode (`$39` held) and the unaffordable-pick exit (`$15EF0`) were not separately tested in this pass. Both are now covered in `HANDOFF-2026-11-13-residue-select-exit.md` (map-loop section 10, synthetic and real tiles).
- The rows 22..51 restore uses the picture (`$6ACE` restores a saved `$164AA`, not traced to an emulator frame).

## 7. Notes changed

- `notes/formats/map-rendering.md`: "Mode exit, commit and placement" gains the paragraph "Demolish button and build-menu commit: row 52 through the next pass" and points at section 10.
- `notes/HANDOFF-2026-11-13-preview-clearing.md`: section 7 "Not done" marked done, with a pointer to this note.
- `notes/README.md`: this note is the latest handoff.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read. `grep.exe.stackdump` (untracked, not created here) was left alone.
