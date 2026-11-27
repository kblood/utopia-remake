# Utopia handoff: colony-fall return, boot menu, and scenario pick (2026-11-13)

Model and routing: Claude Haiku 5.5, inline. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled.

Scope: trace the original's colony-fall return (`$10E0A` -> `$157AE`), the boot disk menu (`$7E52`), and the scenario pick, then compare with the remake's game-over UI and restart. Static Disk.1 disassembly only (`tools/game_dis.py`, `tools/game_img.py`), the decoded string table, and the port source and tests. No emulator run, no write under `original/`, no commit or push. The dirty worktree was preserved.

Read first: [AGENTS.md](../AGENTS.md), [formats/game-proper.md](formats/game-proper.md) ("Game over"), [HANDOFF-2026-11-13-save-audit.md](HANDOFF-2026-11-13-save-audit.md) sections 8-9 (colony fall and event index, already fixed there).

## 1. The traced path (VERIFIED static)

| Step | Original (Disk.1) | Evidence |
|---|---|---|
| Colony fall / population loss | `$10E0A` or `$B0B0`: `$E770` (announce), `bset #3,$156AA`, `jmp $157AE` | `game_dis.py` at `$10E0A`, `$B0B0` |
| Boot tail | `$157AE`: `jsr $7E52`, then `$157B4` `bsr $15EF0`, `$157B8` `bsr $11476`, `$157BC` map loop | `game_dis.py` at `$157AE` |
| Disk-menu loop | `$7E52` runs the loop `$7EF6`; the only exit to `$157B4` is `$802C` (`rts` at `$80C6`) | `game_dis.py` at `$7E52`, `$802C` |
| Exit while game over | `$802C`: `btst #3,$156AA` / `bne $7EF6`, silently refused | `game_dis.py` at `$802C` |
| Scenario pick | `$8632` sets mode 3 (`$938D`), `$87DC` -> `$88F0` builds (`$866E` d0=2 falls into `$875C`, which clears bit 3), prints `$8B`, `rts` into `$7FDC`, `bra $7EF6` | scan: `$87DC` has one caller (`$7FDC`); `$88F0` / `$875C` disassembly |
| Load pick | `$85FE` -> mode 2 (`$8828`), builds, prints `$145`, `bra $82B8` (`rts`), back to `$7EF6` | `$8828`-`$88EA` disassembly |
| Tutorial | `$80C8` builds, prints `$8B`, sets bits 7 and 2, money, then `bra $802C` (`$812E`): exits by itself | `$80C8`-`$812E` disassembly |
| Strings | `$8B` "Scenario loaded. Select 'EXIT' to play."; `$145` "Game loaded. Select 'EXIT' to play." | string decode via `GameStrings` |
| In-game disk icon | `$15AE6` `jsr $7E52`, then `$15AEC` `bsr $15EF0` and `rts` to the map loop (no `$11476`, no `$157BC`) | `game_dis.py` at `$15AD0` |

## 2. Mismatch found and fixed

**A pick from the disk menu entered the map at once.** The original's scenario (`$88F0`) and load (`$8828`) return into the disk-menu loop and keep the disk menu up with "Select 'EXIT' to play." until the exit icon. The remake's `acceptScene` held the scene only while the boot session was open, and `enterScene` set the map stage immediately in the game proper. That covers the game-over restart, where the scenario pick is the way out of the game-over screen, and the ordinary in-game scenario and load picks.

The same rule also corrects the tutorial in the boot session. The remake held it; the static trace says `$80C8` ends with `bra $802C`, so it enters at once.

Changes (`src/game/game.ts`, `src/game/disk-menu.ts`):
- `SCENARIO_LOADED_STRING` (`$8B`) and `GAME_LOADED_STRING` (`$145`) exported from `disk-menu.ts`.
- `acceptScene(index, map, disk4, message)`: with a message (a disk-menu pick) it holds the scene, opens the disk menu and prints the message. With `message === null` it keeps the old programmatic rule (held only while the boot session is open, otherwise entered).
- `startScenario(index, pick = false)`, `loadFromSlot(slot, pick = false)` and `Disk4ActivationRequest.pick`: the UI call sites pass the pick (scenario list, load page and its retry, the Disk.4 submenu via `activateFromMenu`). Programmatic callers and tests keep direct entry.
- The exit icon checks `heldScene` first (enters it), then the boot-session note, then the game-over refusal. The check order matters: while a scene is held, `this.map` is still the old game-over map.
- `closeMenu` reopens the disk menu while a scene is held (an error screen back must not show the old map).
- `startTutorial` calls `enterScene` directly; `tutorialScene()` builds the same pre-pass scene for tests.

## 3. Boundary found but not fixed

**Resolved 2026-11-13 (later), see [HANDOFF-2026-11-13-restart-apparition.md](HANDOFF-2026-11-13-restart-apparition.md):** the restart now runs the apparition on its tail exit, with an approximate remake-RNG draw. The text below is the state before that change.

**Restart after game over does not repeat the apparition call.** After a game over, the exit returns through `$157B4` (the return address of the `jsr $7E52` in `$157AE`), so `$15EF0`, the apparition call `$11476` and `$157BC` run again. `$11476` has no guard in the image (it clears `$144A8` and draws only if `$144A6` is nonzero). A mid-game disk-icon exit returns through `$15AEC` and runs `$15EF0` only. The remake runs `Game.leaveBootMenu` once per launch, so a restart does not draw the apparition.

Not fixed because a fix needs the disk menu to remember whether the tail (boot or game over) opened it, and it adds an RNG draw whose remake generator differs from the original (no parity claim). Next step: the same tail flag plus `sim.leaveBootMenu()` on that exit, with a test that a mid-game exit does not draw and a game-over restart does.

## 4. Tests changed (their assertions encoded the old assumption)

- `test/game-over.mjs` section 2: a pick is held with `$8B` shown; the save is refused with the exit-first note; EXIT enters a fresh map. Previously: "choosing a scenario starts a fresh map".
- `test/boot-menu.mjs` section 3: an in-game pick is held; EXIT enters it with no apparition. Section 5: the tutorial enters at once. Header updated.
- `test/game-music.mjs`: the first pass moves from the scenario click to the EXIT click (the original's first pass is in `$157BC` after the exit).
- `test/save.mjs`: the load retry is held; EXIT enters it.
- `test/tutorial-route.mjs` and `test/tutorial-money.mjs`: the pre-pass comparator uses the `tutorialScene()` probe; the forced births draw is armed before the icon-6 click, because that click now runs the first pass. The seeded and forced values (506030, 506040, 506050) are unchanged, so the probe does not perturb the RNG.

Discrimination: the held-pick assertions reject the previous behaviour by construction (the old `enterScene` put the stage on `map`). I did not rebuild the old code to re-run them.

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/game-over.mjs` | exit 0, 30 ok |
| `node test/boot-menu.mjs` | exit 0, 51 ok |
| `node test/disk-menu.mjs` | exit 0, 107 ok |
| `node test/save.mjs` | exit 0, 320 ok |
| `node test/game-music.mjs` | exit 0, 84 ok |
| `node test/tutorial-route.mjs`, `node test/tutorial-money.mjs` | exit 0 (24 and 21 ok) |
| `npm test` (full chain, `UTOPIA_TUTORIAL_CAPTURE_DIR` unset) | exit 0, 4,115 `ok`, 0 `FAIL`. Log in `%TEMP%\npm-test-restart.log` |

## 6. Docs changed

- `notes/formats/game-proper.md`: the boot-model paragraph, the tutorial bullet, the comparator addendum, the game-over scenario bullet, and the new restart-boundary bullet.
- `notes/ARCHITECTURE.md`: the boot-menu summary line.
- `notes/README.md`: this note is now the latest handoff.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
