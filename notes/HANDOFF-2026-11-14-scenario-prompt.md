# Utopia handoff: the scenario pick message on the list prompt (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator run and no original writes: `original/` was only read through the existing notes. Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-load-pick-message.md](HANDOFF-2026-11-14-load-pick-message.md) (open point 1, now closed here), [HANDOFF-2026-11-14-held-key-routes.md](HANDOFF-2026-11-14-held-key-routes.md), [formats/game-proper.md](formats/game-proper.md) "Load failure and return" and "Disk menu and its exit".

Verification gap: `tools/game_dis.py` needs `capstone`, which is not installed in this environment, so the `$88F0`, `$8462` and `$7EF6` trace was **not re-disassembled** in this pass. The statements below rest on the existing notes (game-proper.md, held-key-routes handoff: `$88F0` = `$866E` d0 = 2, `$8AF4`, `$8462` with `$8B`, `rts`, no `$82B8`).

## 1. Result

**Fixed, bounded.** The scenario pick (`$88F0`) now prints `$8B` ("Scenario loaded. Select 'EXIT' to play.") on the list PROMPT (`DiskMenuScene.printPrompt`, y `$A3`), not the result line (`$83A2`, y `$B5`). The prompt has no countdown, and the held scene stays until EXIT. Before this change the remake printed it on the result line for 53 frames.

Smallest faithful behaviour, as decided:

- **Message placement:** prompt line, as the original's `$8462` call places it.
- **Hold:** unchanged. The pick builds the scene and returns to the disk menu, which holds it until EXIT (`Game.heldScene`).
- **No full list renderer:** the remake's scenario list stays the separate `MenuScene` page with its own labels. The original's list rows, and the open list in mode 3 after the pick, are not drawn. The prompt is the only part of the list state shown.

## 2. Change

- `src/game/game.ts`:
  - New `DiskMessage` type (`{ area: "prompt" | "info", index }`).
  - `acceptScene(..., message: DiskMessage | null)` routes the message: `prompt` calls `printPrompt`, `info` calls `printInfo(index, 0)`.
  - `startScenario(index, pick)` sends `{ area: "prompt", index: SCENARIO_LOADED_STRING }` for a pick.
  - `activateDisk4` keeps `{ area: "info", index: GAME_LOADED_STRING }` (its original post-load path is not traced).
  - A slot load still passes no message (`$82B8` erases the load's `$145` in the same handler).
- `src/game/disk-menu.ts`: the `SCENARIO_LOADED_STRING` and `printPrompt` comments name the prompt placement and the scenario pick. No behaviour change in `DiskMenuScene`.
- `test/game-over.mjs`: the scenario-pick assertion that encoded the old result-line placement (`info(g) === "139,0"`) now checks `shownPrompt` `139,0` and `shownInfo` `0,0`.
- `test/boot-menu.mjs`: one added assertion for the boot scenario pick (same path, prompt not result line).
- `test/scenario-pick.mjs` (new, added to the `npm test` chain after `game-over.mjs`): 18 checks, all passing:
  - message placement (prompt rows differ from a plain menu, result rows match it, no result-line text);
  - no timeout (300 frames, prompt pixels unchanged, still held, old map kept);
  - held scene (save icon's remake note on the result line and the prompt kept; music icon on the result line and the prompt kept);
  - a second pick replaces the held scene and shows the prompt again;
  - EXIT enters the held scene once (`loop.passes` 0 -> 1, nothing held, disk menu gone), then the map runs (vbls advance).

## 3. Limitations (not changed)

1. **The prompt is lost when a remake page is visited and closed.** *Answered 2026-11-14, see [HANDOFF-2026-11-14-scenario-list-state.md](HANDOFF-2026-11-14-scenario-list-state.md):* the held prompt is kept with the held scene and printed again on the disk menu's return (the remake submenu's BACK). The load and scenario pages clear it, as the icons' `$855A` `$84F4` erase does in the original; the save page is not reachable while held.
2. **The scenario list is not the original's list.** It has no original rows. *Answered 2026-11-14, see [HANDOFF-2026-11-14-scenario-list-open.md](HANDOFF-2026-11-14-scenario-list-open.md):* the remake's page now stays open after a pick (mode 3, `$88F0` leaves `$938D` alone), and the rows are still not the original's.
3. **The prompt has no `$82B8` erase in the remake's pick path.** The original leaves the prompt until a later `$82B8`/`$84F4` or the next prompt print. The remake keeps it until the scene is entered, which is the same moment the original's list would next close (EXIT). This is a static reading, not a timed comparison.

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/scenario-pick.mjs` | exit 0, 18 ok, 0 FAIL (new) |
| `node test/boot-menu.mjs` | exit 0, 52 ok, 0 FAIL |
| `node test/save.mjs` | exit 0, 403 ok, 0 FAIL |
| `node test/disk-menu.mjs` | exit 0, 107 ok, 0 FAIL |
| `node test/disk-menu-keys.mjs` | exit 0, 41 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 50 ok, 0 FAIL |
| `npm test` (full chain, now including `scenario-pick.mjs`) | exit 0, 0 `FAIL` lines |

Red check: **not run.** The new test was not executed against the pre-change code, so it is not shown to fail without the fix. The game-over assertion that encoded the old result-line placement (`"139,0"` on `shownInfo`) did change, and it passes now with the new placement. No visual parity is claimed; the remake's pages and the list rows are not compared.

## 5. Notes changed

- `notes/formats/game-proper.md`: the "Load failure and return" paragraph's scenario sentence now records the fix and the remaining limits (it previously said "NOT changed here").
- `notes/HANDOFF-2026-11-14-load-pick-message.md`: open point 1 marked fixed, pointing here.
- `notes/README.md`: the newest-handoff pointer is this note.
