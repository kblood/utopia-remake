> **Superseded (2026-11-13) by [HANDOFF-2026-11-13-eclipse-parity.md](HANDOFF-2026-11-13-eclipse-parity.md).** The bit-6 view described below is wrong after a disk-menu entry during an eclipse and after a new game (both traced); the table state is now a stored parity (save version 11). Kept for the record.

# Utopia handoff: eclipse descriptor swap as a bit-derived tile view (`$11024`), 2026-11-13

Model and routing: Claude Haiku 5.5, as the implementation sub-agent, inline. No orchestration tool was called, so the `claudeAgent` routing requested in the brief is not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run. Nothing under `original/` was written (Disk.1 and Disk.2 were read, and the Disk.1 image was disassembled, read-only). Nothing was committed or pushed. The dirty worktree was preserved (other modified files were not touched).

Read first: [AGENTS.md](../AGENTS.md), [HANDOFF-2026-11-13-weekly-transition.md](HANDOFF-2026-11-13-weekly-transition.md) (the design this slice follows, and its section 4 gate), [formats/sim-port.md](formats/sim-port.md) (weekly row), [formats/game-state.md](formats/game-state.md) section 5.1 item 3.

## 1. What was built

- `src/game/eclipse-tiles.ts` (new, pure): `eclipseTileView(tiles, active)` and `ECLIPSE_TILE_PAIRS = [[4, 51], [50, 54]]` (0-based descriptor indices, tile ids 5/52 and 51/55). `active` false returns a new array of the same tile objects. `active` true returns a new array in which each pair has its data addresses exchanged. Rows stay with their entry. Nothing in the input is written: the source tiles, their planes and the image buffer are shared and read-only, and an exchanged entry is a new `Tile` object.
- `src/data/scenario.ts`: `Tile` gains an optional `source: { image, offset }`, recorded by `readTiles` (the image buffer and the absolute data address). `TILE_BYTES_PER_ROW` is exported. No other field or loader behaviour changed.
- `src/game/map.ts` (`MapScene`): the scene keeps its own tile array (copied from the list it was given) and a `baseTiles` reference. `syncTileView()` computes `SYS.eclipse` from `sim.sysFlags`, and when it changes it rewrites the scene's array in place with `eclipseTileView(baseTiles, active)`. It runs first in `drawPass`, `drawInitialFrame` and `drawModal`. `ObjectLayer` and `Controls` (which passes the same array to `BuildMenuRenderer`) are built with the scene's array, so they follow the same view. `buildingHeight` still reads the base list: rows are identical in the view, so the result is the same.
- `test/eclipse-tiles.mjs` (new): 39 checks. Synthetic part: exchange for both pairs, other entries are the same objects, rows kept, source image kept, input immutability, reversibility (second exchange restores), errors (short list, missing source, address past the image). Real-disk part (skipped when the disks are missing): the loader's source addresses match the planes, exchanged planes differ from the originals, and a live `MapScene` shows the view while `SYS.eclipse` is set and returns to the loaded tiles when it clears, with the scene list, `ObjectLayer.tiles` and `Controls.tiles` being the same array.
- `package.json`: `test/eclipse-tiles.mjs` added to the `npm test` chain after `test/build-menu.mjs`. No other script changed.

No save format changed: the view is derived from `$156AA` bit 6 (`SYS.eclipse`) and is not stored. Build-menu tile icons, the map and the object layer read the view only through the scene's array.

## 2. Verification

| Check | Result |
|---|---|
| Baseline `npm test` before the edits (pre-change `dist/`) | exit 0, 4136 `ok` lines |
| `npm run build` (tsc) after the edits | exit 0 |
| `node test/eclipse-tiles.mjs` | all 39 checks passed (real-disk part ran: the player's Disk.1 / Disk.2 are present) |
| `npm test` after the edits | exit 0, 4175 `ok` lines (4136 + 39) |

Real tile rows, read-only from the player's Disk.1 (`dist/data/scenario.js`): tile 4 and 51 both 27 rows, tile 50 and 54 both 17 rows. Their planes differ, so the exchange is a data change, not a no-op. The equal rows are an observation of this one scenario image set, not a rule the code relies on: the view handles unequal rows by reading the entry's own size from the other address.

**Not verified:** the visible effect (map and build-menu icons during an eclipse) was not observed in any run. The tests check array identity and bytes, not pixels. No claim of visual behaviour is made.

## 3. The divergence (static, VERIFIED disassembly; this is the important caveat)

The bit-derived rule ("exchanged exactly while bit 6 is set") is the brief's design and is what is wired. Static disassembly of the Disk.1 game-proper image (`tools/game_dis.py`, read-only) shows the original's table state is not a function of bit 6 alone:

- `$157AE` runs `jsr $7e52` first. `$7E52` (the disk-menu entry) runs `btst #6,$156AA` and then `jsr $11024` (`$7ECA`-`$7ED4`). So each entry into that menu while bit 6 is set exchanges the table again. `$157AE` is also the target of `jmp` at `$10E18` (the colony-fall tail, which leaves bit 3 set) and at `$B0BE`. The remake's view does not toggle on menu entry, so after one menu entry during an eclipse the original and the remake can disagree.
- The new-game reset (`$866E` -> `$875C`) ends with `move.b #1,$156AA` (`$87CA`). That clears bit 6 with no exchange. A table left exchanged by the menu path would persist into a new game, while the remake's view shows it unexchanged.
- Consequence: the remake's view matches the original on the simple path (start, count down, end, no menu entry during the eclipse, no game over during it), and can differ after a menu entry or a game over during an eclipse. The state the original keeps is a parity of events (weekly start and end, menu entries while bit 6 is set, boot exit with `$144BB` nonzero, event 14), not a bit.

Not checked: the in-game exit path, `$B0BE`, the scenario and load paths (`$88F0`, `$8828`), and whether the scenario path reloads the table. The emulator has not been run.

## 4. Options for the user (decision needed; nothing changed for these)

1. Keep the bit-derived view (as built). Simple, no format change, known divergence after menu entry or game over during an eclipse.
2. Model the parity: a saved toggle state, updated at the five traced call sites. This is a save-format change and needs a migration (versions 2-10 would read as parity 0 or from the bit, to be decided). Needs approval.
3. Hold the port until an emulator run settles the menu-entry and new-game behaviour (a short scripted run: eclipse start, menu entry, read tile 5 and the build-menu icon for `$33`/`$34`; game over during an eclipse, then a new game). That run is outside this slice and needs the user's go-ahead to use the emulator.

## 5. Unverified items

- Whether the swapped pictures are visible on the map or the build menu during play (static reading only).
- The exact invariant (above). The bit rule is a HYPOTHESIS in the notes, labelled as such.
- Whether a new game (`$866E`/`$875C`) clears the table: not traced; the static reset does not touch the table.
- Event 14 (`$11058`), the boot exit (`$8040`) and the reconcile site (`$7ED4`) are listed in game-state.md 5.1 item 3; only the bit-derived view is implemented.

## 6. Repository state

- Branch `main`. Worktree preserved. Nothing committed or pushed.
- Changed in this slice: `src/game/eclipse-tiles.ts` (new), `src/data/scenario.ts`, `src/game/map.ts`, `test/eclipse-tiles.mjs` (new), `package.json` (one test entry), `notes/formats/sim-port.md` (weekly row), `notes/formats/game-state.md` (`$144BB` row and 5.1 item 3), `notes/README.md` (latest-handoff pointer), `notes/HANDOFF-2026-11-13-eclipse-swap.md` (this file).
- Scratch probes (`%TEMP%\utopia-eclipse-probe*.mjs`, `utopia-xref.py`, `utopia-baseline-test.txt`, `utopia-after-test.txt`) live outside the repository and are not part of it.
