# Utopia handoff: apparition on restart after game over (2026-11-13)

**Correction (review, same day):** the statement in section 1 that a restart's draw "shifts the remake's later random outcomes" was incomplete. Every new scene used the same default seed, so each restart drew the same first value. A tail-built new game now continues the ended game's generator (`Game.createScene`). See `notes/HANDOFF-2026-11-13-disk-menu-tail-review.md`. The marker is still not the original's.

Model and routing: Claude Haiku 5.5, inline, as the research sub-agent. No orchestration tool was called and no subscription routing was confirmed, so `claudeAgent` use is not verified. No subscription usage was checked and no timer was scheduled. No child agent was started.

Scope: the original's second `$11476` apparition (the restart after a game over, `$157B4` return), the remake's ability to represent it while its RNG is approximate, and a bounded implementation if one is safe. Sources: `notes/HANDOFF-2026-11-13-restart-exit.md` section 3, `notes/formats/game-proper.md` ("Game over", "Restart after game over"), `notes/formats/original-rng-callers.md` (row 1, D1), and the source and tests named below. No emulator was run, nothing under `original/` was written, and nothing was committed or pushed. The dirty worktree was preserved.

## 1. Question and answer

**Question:** can the remake represent the original's second apparition on game-over restart while its RNG stays approximate?

**Answer: the event is representable, the marker is not.**

- **Control flow (VERIFIED static, Disk.1):** a restart EXIT returns through `$157B4` (the return address of `jsr $7E52` in `$157AE`). That runs `bsr $15EF0`, `bsr $11476` (the apparition) and the map loop `$157BC`. The mid-game icon exit returns through `$15AEC` (no `$11476`). `$11476` has no guard: a zero marker count returns, any other count draws once. This is implementable and implemented.
- **The marker draw (not reproducible from current evidence):**
  - The original draws `$2DCC` with D0 byte 1 = 0 on this path (same `$15EF0` entry as the boot call, D0 `$22`), so the result depends only on the seed `$2EA0` and the CIA TOD byte `$BFE801`.
  - The seed is the original's whole RNG history since launch. The remake's `Sim.roll` generator never reproduces it, so the seed can never match.
  - TOD is a hardware timing input. No capture records it for a restart exit. The only TOD bytes (`$DB`, `$E1`) are inferred from the tutorial's seed chain in one run.
  - So even a perfect TOD model would need the original's full draw sequence, which the remake does not produce.

**Verdict: safe to implement as a bounded, labelled approximation.** The implementation adds one `roll(n)` per tail exit over the scenario's existing markers, and claims only the traced event and its range. It does not claim the original's marker. The RNG consumption shifts the remake's later random outcomes after a restart. That is acceptable because the remake's generator was never parity-matched after the first draw.

## 2. Implementation (`src/game/game.ts`, `src/game/sim.ts`, `src/game/sim-aliens.ts`)

- `Game.diskMenuFromTail` (new field): the open disk menu came from the game-over tail (`$157AE`), not a map icon (`$15AE6`).
  - Set by `returnToMap()` when the map is in game over, which then opens the disk menu.
  - Cleared by `openMapDiskMenu()` (the map's disk callback, `sceneOptions`), by the non-game-over `returnToMap()` path, and by an entered scene.
  - Sub-menus (load, scenario, error, remake) keep it, because `closeMenu` and the menu back paths only call `openDiskMenu()`, which does not touch the flag.
- `Game.runDiskMenuExit(sim)` (replaces `leaveBootMenu`): `tail = bootMenuOpen || diskMenuFromTail`. It clears both flags and calls `sim.leaveBootMenu()` when `tail` is true. `enterScene` calls it, so the scenario, load, Disk.4 and tutorial exits all share it.
  - The tutorial from a game-over tail also gets the apparition. `$80C8` clears bit 3 through `$875C` before its `bra $802C`, so the exit is not refused and returns through `$157B4`.
- `Sim.leaveBootMenu()` and `Aliens.initializeScenarioAppearance()`: doc comments now say the call runs once per tail exit and that the draw is an approximation.

The only RNG use is the existing `Sim.roll(n)`. No new generator, no `OriginalRngModel` wiring, no new save field, and no change to the `$11476` gate.

## 3. Tests (`test/game-over.mjs`)

- Section 2 (after the existing EXIT check):
  - restart: the exit draws one marker of the picked scenario (`$144A6 > 0` and the apparition is a marker).
  - a map-icon disk menu after the restart, then a pick and EXIT, has no apparition.
- New section 2b:
  - a game over, then the tutorial restart enters at once with one apparition.
  - a second game over, then a pick and EXIT, enters a fresh map with one apparition.
- New helper `isMarker` (the same rule as `test/boot-menu.mjs`).

Discrimination: the restart checks fail on the previous code, which ran the call only on the first boot exit and left the restarted alien `null`. I did not rebuild the old code to re-run them. A first run failed only because the newly opened disk menu swallowed its first click (the opening-click guard); I added the idle frame the boot test uses and then the checks passed. That was a harness fix, not a change to the expected result.

## 4. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/game-over.mjs` | exit 0, 37 ok, 0 FAIL (was 30 before the 7 new checks) |
| `node test/boot-menu.mjs` | exit 0, 51 ok |
| `node test/disk-menu.mjs` | exit 0, 107 ok |
| `node test/save.mjs` | exit 0, 320 ok |
| `node test/game-music.mjs` | exit 0, 84 ok |
| `node test/tutorial-route.mjs`, `node test/tutorial-money.mjs` | exit 0 (24 and 21 ok) |
| `node test/aliens.mjs`, `node test/disk4-scene.mjs` | exit 0 (78 and 106 ok) |
| `npm test` (full chain) | exit 0, 4,122 `ok`, 0 `FAIL` (was 4,115). Log at `/tmp/npm-test-restart-apparition.log` (not committed) |

## 5. Notes changed

- `notes/formats/game-proper.md`: the remake-model paragraph (no longer "a restart does not repeat it") and the restart bullet, now "Restart after game over (STATIC event order, IMPLEMENTED; the draw is APPROXIMATE)". It also gives the minimal capture below.
- `notes/formats/original-rng-callers.md`: the `$11484` caller row names the restart caller (same return, draw not captured).
- `notes/ARCHITECTURE.md`: the fresh-startup paragraph names `runDiskMenuExit` and the restart repeat.
- `notes/HANDOFF-2026-11-13-restart-exit.md`: section 3 is resolved by this note (pointer added).
- `notes/README.md`: this note is the latest handoff.

## 6. What is not verified

- No emulator run. The restart order is a static trace of `$157AE`, `$802C` and `$157B4`, the same as the boot order, not an observed run.
- The restart marker is not the original's. The draw is the remake's, so only the event and the range are traced.
- The scenario's marker count and the alien frame after the restart are not checked against the original.

## 7. Minimal capture for an exact check (not done)

One read-only run of game over, scenario pick, then EXIT. Break on `$2DCC` with the return `$1148A` and record:

- the seed `$2EA0` before the call, the `$BFE801` byte (TOD), D0 and D2 at entry;
- `$144A6` (the marker count);
- after the return, `$144A8` and the marker cell `$14524 + 2i` for the result `i`.

Also confirm the return to `$157BC` after the `$15EF0` path.

With those values, the arithmetic `(n * (seed_after & $FF)) >> 8` can be checked. Even then, the remake cannot match the marker without the original's full RNG history since launch.

## 8. Repository state

Nothing committed or pushed. The dirty worktree was preserved. `original/` was only read by the existing tests; nothing was written under it.
