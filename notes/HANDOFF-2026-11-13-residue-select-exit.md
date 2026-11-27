# Utopia handoff: row-52 residue, demolish from select mode and the unaffordable-pick exit (2026-11-13)

Model and routing: Claude Haiku 5.5 (`claude-haiku-5-5`), run inline as the test sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run and nothing under `original/` was written. Nothing was committed or pushed. The dirty worktree was preserved.

Scope: the two open paths named in `HANDOFF-2026-11-13-residue-tests.md` section 6: (a) demolish pressed while in select mode, (b) leaving the build menu after an unaffordable pick. Both were covered by the static trace in `notes/formats/map-rendering.md` ("Mode exit, commit and placement" and "Demolish button and build-menu commit"), but had no row-52 state test.

## 1. Trace used (STATIC, Disk.1, from the earlier notes; not re-read this pass)

- (a) Demolish from select mode: `$15AF8` -> `$15ECA` has no mode test. It sets demolish mode, clears the selection, runs `$6ACE` (rows 7..51 only) and then `$6B10` with `$3A` (plane-5 mask, `$69D8`). The held row after select mode is the `$39` icon's bottom row (scene start, `$157B4` -> `$15EF0`).
- (b) Unaffordable pick then exit: `$B57E` clears the pending item (`$142AA` = 0). The exit `$B628` -> `$6BA2` with nothing pending branches to `$15EF0`: select mode, selection cleared, `$6ACE` (rows 7..51), then `$6B10` with `$39`. The held row is whatever the build preview left (`$61` in the probe).
- In both paths row 52 is outside `$6ACE`, so the held pixels survive wherever the new tile is transparent.
- The menu-open frames do not call `keepPanelBottomRow` (`src/game/map.ts`), so the held row is not overwritten while the menu is open.

## 2. Pixel fact for the shipped tiles (VERIFIED, from tile data, as in the residue-tests note)

`$39` and `$3A` both have an opaque bottom row at x 14..17 and are transparent elsewhere on that row, so with real tiles the held row changes no pixel. The residue is visible only with a tile whose mask is clear at x 14..17. The new probes clear that mask (synthetic) and assert the state, as in section 10 of the earlier pass.

## 3. Tests added (no source change needed)

`test/map-loop.mjs`, section 10 (inside the game-data block; 27 new checks, `ok` 192 -> 219 in map-loop):

- Select-mode demolish probe: scene start holds the `$39` bottom row (x 14..17 differ from the picture); the press does not change the mode; the release sets demolish mode with no selection; the release frame keeps the held row; the held state equals it; nothing outside the panel box and message band differs from the twin; the next pass keeps the row and mode and the panel box.
- Select-mode demolish, real tiles: row 52 is the `$3A` composite over the `$39` row; the icon box matches `$3A` over the picture; the next pass keeps both.
- Unaffordable-exit probe: `$61` preview held (x 14..17 differ from the picture); the build button opens the menu with `$61` pending; the `$45` pick at money 100 is refused (`pending` null, `affordable` false); the exit leaves select mode with no selection; the exit frame keeps the held row; the held state equals it; the next pass keeps the row and the panel box.
- Unaffordable-exit, real tiles (money 100): row 52 is the `$39` composite over the held `$61` row; the icon box matches `$39` over the picture; the next pass keeps both.

Nothing else changed in the tests. The existing `test/build.mjs` (unaffordable pick, exit with nothing pending) and `test/build-menu.mjs` checks were already in place and are unchanged.

## 4. Mutation checks (compiled `dist/game/map.js` only; restored and rebuilt afterwards)

| Mutation | Result |
|---|---|
| M1: `restorePanelArea` restores row 52 from the picture, not `panelBottomRow` | 14 FAIL: the clearing refusal and exit residue checks, and all four new probe groups' held-row, held-state and next-pass checks. Real-tile checks still pass, as expected (section 2). |
| M2: `keepPanelBottomRow` stores zeros instead of the presented row | 32 FAIL, including the new probes and the existing icon-box checks (the zeroed row also breaks the icon box). |

The mutated `dist/game/map.js` was replaced from a backup copy after each run, and `npm run build` was run again.

## 5. Verification (2026-11-13, this pass)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 219 ok, 0 FAIL |
| `node test/build-menu.mjs` | exit 0, 89 ok, 0 FAIL |
| `node test/command-buttons.mjs` | exit 0, 43 ok, 0 FAIL |
| `node test/build.mjs` | exit 0, 54 ok, 0 FAIL |
| `npm test` (full chain) | exit 0, 4,454 `ok`, 0 `FAIL` (was 4,427). The optional construction-site capture comparison skipped, as before (`UTOPIA_SITE_CAPTURE` not set). |

## 6. Limits and open points

- The probes test the state mechanism (row 52 held through a masked blit, the menu, and a pass). They are not an original capture. Whether the original's bottom row for a masked `$39` or `$3A` matches the held pixels is not established.
- Real-tile checks confirm the composite and icon box; with the shipped masks the held row changes no pixel.
- The `$B57E` unaffordable clear and the `$6BA2` -> `$15EF0` branch are taken from the static trace recorded in `controls.ts` and `map-rendering.md`; this pass did not re-read Disk.1.
- The rows 22..51 restore uses the picture, not a traced `$164AA` frame (unchanged from the residue-tests note).
- No source change was needed: no mismatch with the traced paths was demonstrated.

## 7. Notes changed

- `notes/formats/map-rendering.md`: the "Demolish button and build-menu commit" paragraph gains the two new paths and the menu-open note.
- `notes/HANDOFF-2026-11-13-residue-tests.md`: section 6 bullet now points at this note.
- `notes/README.md`: this note is listed as the latest handoff for the residue work.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
