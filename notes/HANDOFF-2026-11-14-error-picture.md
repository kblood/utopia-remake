# Utopia handoff: the picture under a load error (2026-11-14)

> **Status update (2026-11-14, empty-load slice):** an EMPTY load row no longer opens an error page, so the "original picture after a refused empty load" comparison in section 5 and the empty `CODE: empty` baseline are out of date. The remake keeps its load list with `$143` on its prompt ([HANDOFF-2026-11-14-empty-load-list.md](HANDOFF-2026-11-14-empty-load-list.md)). The corrupt error page and the "no underlay" decision are unchanged.

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator and no original writes: `original/` was only read by the test harness (Disk.1 and Disk.2 at run time) and no original data was copied or stored. Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-load-return.md](HANDOFF-2026-11-14-load-return.md) (the load's BACK), [formats/game-proper.md](formats/game-proper.md) "Load failure and return", [formats/remake-save.md](formats/remake-save.md) "Disk menu behaviour on failure".

## 1. Question and answer

The original leaves the slot list drawn after a refused empty load (static, `$87DC` -> `$8804`-`$881E`, mode 2 kept; no emulator run). The remake replaces the page with its error screen. **Can the remake keep the exact prior page under the error overlay without changing retries, BACK or the simulation? No, not faithfully, and it was not implemented.**

Reasons, each checked in the code or by a scratch probe:

| Point | Finding |
|---|---|
| What is on screen before the error | A menu-origin load runs `DiskMenuScene` -> `openMenu("load")`. `openMenu` sets `diskMenu = null`, so the original disk-menu picture is gone before the slot page exists. The slot page is a `MenuScene` over the main picture (`menu.ts`). |
| Is there a faithful list to keep? | No. `DiskMenuScene` draws only music labels (`readMusicLabels`). The original's load list rows are not reproduced, so there are no rows to keep. |
| Would an underlay of the prior `MenuScene` work? | It would be a copy of the remake's own page, not the original's. The error panel is `16 + entries*12 + 8` px high. An empty or corrupt error has 7 entries (one message line), so 108 px. The eight-slot list panel is 120 px. A kept underlay would show the bottom 12 px of the eighth slot row (scratch probe: 2814 pixels in rows 142-153 differ from the error page). That is a new visual the original does not produce. |
| Could retries or BACK change? | No need. An underlay is a render change only. It was not implemented because the picture it would produce is neither the original's nor verified. |

Decision: document, do not implement. Re-open if an original capture of the refused-load picture is made (emulator, with a bad save).

## 2. Regression added

`test/save.mjs`, new block after "Load refusals and their BACK" (inside the Game wiring section, so it runs only with the user's Disk.1 and Disk.2):

| Check | Meaning |
|---|---|
| corrupt slot from the disk icon opens `CODE: corrupt`, untouched session | state |
| corrupt page matches its pinned hash `5bd3e842` | visual (remake baseline) |
| BACK redraws the disk loop exactly as a fresh `DiskMenuScene` | visual + state |
| empty slot from the disk icon opens `CODE: empty`, untouched session | state |
| empty page matches its pinned hash `c65fb588` | visual (remake baseline) |
| empty and corrupt pages differ | visual |
| BACK redraws the loop, map and `loop.passes` untouched | state |

The hashes are FNV-1a over the 320 x 200 index buffer of the error screen. They are a baseline captured from this build, NOT an original capture. Mutant check: `dist/game/game.js` with the BACK label changed (`BACK TO DISK MENU!`) fails the two hash checks and the existing label checks (7 FAIL). `dist` was rebuilt and restored; the suite is green again.

## 3. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 (before and after the mutant) |
| `node test/save.mjs` | exit 0, 402 `ok`, 0 `FAIL` (was 395 before the block) |
| `node test/disk-menu.mjs` | exit 0, 107 `ok`, 0 `FAIL` |
| `node test/disk-menu-keys.mjs` | exit 0, 41 `ok`, 0 `FAIL` |
| `node test/game-over.mjs` | exit 0, 50 `ok`, 0 `FAIL` |
| `npm test` (full chain) | see the final report |

No source file under `src/` changed in this step; the only code change is `test/save.mjs`.

## 4. Open points (not changed)

1. **Original picture after a refused empty load.** The original keeps the list rows; the remake shows its own error page. Needs an emulator capture of the disk menu after `$143` to compare.
2. **Corrupt and unsupported records.** The remake's codes are its own. What the original does with a damaged record is a HYPOTHESIS (see the load-return handoff, open point 2).
3. **Hash baseline.** The pinned hashes freeze the remake's current page. Re-capture them deliberately when the page is changed on purpose (the test message names this).
