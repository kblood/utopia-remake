# Utopia handoff — 2026-11-13 (native save continuation audit)

Bounded audit of the remake's own save (localStorage, version 10) for one continuation mismatch that the source or tests already
evidence, with no emulator run. Read first: [AGENTS.md](../AGENTS.md), [HANDOFF-2026-11-13.md](HANDOFF-2026-11-13.md),
[formats/remake-save.md](formats/remake-save.md), `src/game/save-session.ts`, `src/game/save.ts`, `src/game/checkpoint.ts`, `test/save.mjs`.

## 1. Result

**No actionable mismatch.** Every candidate below was checked and either ruled out or shown to be unreachable with the shipped
data. No code, test or format changed, so no migration was needed. Two notes were corrected to match the code (section 4). Nothing
was committed or pushed, the dirty worktree is preserved, and `original/` was not written.

## 2. Candidates checked

| Candidate | Evidence | Outcome |
|---|---|---|
| A live crusher with `counter > 7` (from a wave spawn) makes capture refuse the save. `validateSession` allows 0..7. `EnemySystem.spawn` copies `counter = e[5] & 0x7f` with no check (`enemies.ts`, spawn). | Read-only scan of the ten shipped Disk.2 wave tables (`$13476-$135B5`, local data, script in `%TEMP%\wave-scan`, nothing committed). Result: 164 non-empty entries, 17 of them crusher (type 24). For all 17, `e[5] = 0` and `e[6] = 0`. The two entries with `e[5] & 0x7f > 7` are non-crusher types, and the counter check is crusher-only. | **Not reached with shipped data.** It is a refusal, not silent corruption, if a modified table produced it. The live step only wraps `counter - 1 < 0` (`enemies.ts`, crusher), so counter above 7 would not wrap, but no shipped path creates it. |
| Ship / missile `lift` outside `SHIP_SPEC` `[0, 0x7f]`. | Missile mode 4 caps at `AIR_START_LIFT` (`$22`) (`enemies.ts` `missileStep`). Mode 2 removes the missile in the same step once `lift <= 0`. `land()` sets `lift = 0`. Ship mode 7 stops at `>= $22`. | In range for every traced live path. |
| `loop.restoreState` could refuse after the commit has started (`restoreSession` order). | `MainLoop.restoreState` checks the same bounds as `validateSession`, and `restoreSession` checks `vblPerPass` before the commit. | Unreachable. The ordering is not structurally pure (see checklist item 4), but no mismatch. |
| Announce / intel / invention events lost at a save. | `Game.updateMap` (`game.ts`) drains `Sim.events` after every map update. The announce chain stays in its own stage (`game.ts`, announce). The map is ticked only in the map stage. The disk menu is not a map tick. | None is pending at an ordinary idle save. The note's "lost" wording was narrowed. |
| Redraw gate `$156A9` bit 3 is not saved. | `objects.ts` `preparePassGate` / `gate`: the gate is a function of current state. After load the pass gate is `null`, so the first redraw computes it live. It differs from the latched value only if state changed between the last pass and the save. | **Presentation only**, one redraw before the immediate pass. Recorded as checklist item 2. |
| `$156A9` bit 0 (scroll latch), `$15668` message context, `Game.announcements`, `ObjectLayer.extra`. | `mouse-poll.ts`, `announce.ts`, `game.ts`, `objects.ts`. | Presentation, or refused at capture (`extra`). Excluded by design. |
| `warehouseCapacity`, `scenarioStartInitialized`, `Aliens` marker table, `dayQueued` on a fresh scene. | `load` builds the target with `freshStart = false` (`game.ts`). Restore overwrites the state image (which holds the capacity word) and `dayQueued`. | Not a gap. |
| Field inventory of the gameplay classes against `savedX` / `buildX` (Unit, Enemy, ship extras, PassClock, Aliens, Alerts, Fleet, EffectPool, MainLoop, World). | Compared the class fields to `save-session.ts` capture and build. | Every gameplay field is captured and restored. Disk.4-only fields (`sourceRaw`, `flagPointer`, `savedControl`) are refused at capture by design. |

## 3. Prioritized evidence checklist (save and load)

1. **HIGH, needs an explicit go-ahead (emulator).** Original-vs-remake continuation of a saved session: a staged live capture with
   explosions and a crusher, saved, reloaded and compared pass by pass. No such comparison exists. This is the largest open gap
   (`remake-save.md`, Open points).
2. **MEDIUM, static.** Confirm from the Disk.1 trace that the original recomputes the redraw gate (`$156A9` bit 3) at the first
   redraw after the boot-menu return, which matches the port's live recompute. Presentation only, so low gameplay impact.
3. **MEDIUM, static.** The shipped wave tables give crusher `e[5] = e[6] = 0` in all ten scenarios. Whether the original's runtime
   can write a crusher counter above 7 is still not traced (`enemies.md` section 3a). Until it is, the capture refusal is a
   guard, not a known reachable state.
4. **LOW, code hygiene.** `restoreSession` commits before `loop.restoreState` could refuse. Moving the loop check ahead of the
   commit would make the "refusal before commit" invariant structural. It is unreachable today, so no behaviour changes.
5. **LOW, documented lossy migrations (no new evidence).** Versions 2-9 `blastMark` clear, hardware counters null before version 5,
   enemy pointers derived in versions 2-6, effect slots assumed in versions 6-7, empty effects in versions 2-5. All are as documented
   in `remake-save.md`, and none was re-derived here.

## 4. Doc changes (no code change)

- `notes/formats/remake-save.md`, excluded list: the `messages` / `events` sentence now says that `Game.updateMap` drains the
  events after each map update and that none is pending at an ordinary save. It no longer claims that one is lost.
- `notes/formats/remake-save.md`, open points: new bullet on the crusher counter range, the capture refusal, and the local scan
  result (17 crusher entries, all with `e[5] = e[6] = 0`; data not committed).
- `notes/README.md`: the latest handoff pointer now names this note.

## 5. Verification (2026-11-13, this slice)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (run twice, final exit checked directly) |
| `node test/save.mjs` | exit 0, 319 `ok` lines, `all save checks passed`. Part 2 (Game wiring) ran against the local `original/utopia-whdload` Disk.1 / Disk.2, so nothing in it was skipped. |
| `npm test` (full chain, `UTOPIA_TUTORIAL_CAPTURE_DIR` unset) | exit 0, 4,108 `ok` lines. Log in `%TEMP%\npm-test-save-audit.log`. |
| Read-only wave-table scan (`%TEMP%\wave-scan\scan.mjs`, `check.mjs`) | outside the repository; nothing written under `original/`. |

Skipped by design in `npm test` (the environment variable was unset):

- `test/original-rng.mjs`: raw production capture check (`UTOPIA_PRODUCTION_TRACE_DIR`).
- `test/original-rng-tutorial.mjs`: tutorial chain check (`UTOPIA_TUTORIAL_CAPTURE_DIR`). This was run with the variable set in
  `HANDOFF-2026-11-13.md`, not in this slice.
- `test/tank-original-compare.mjs` (`UTOPIA_TANK_TRACE_DIR`) and `test/production-original-compare.mjs` (`UTOPIA_PRODUCTION_TRACE_DIR`).
- The external capture comparators: pixel (`UTOPIA_PIXEL_CAPTURE`), map (`UTOPIA_MAP_CAPTURE`), build menu (`UTOPIA_MENU_CAPTURE`),
  build side preview (`UTOPIA_SIDE_CAPTURE`), and construction site (`UTOPIA_SITE_CAPTURE`).

## 6. Repository state and model

- Branch `main`. Worktree preserved. Nothing committed, nothing pushed. `dist/` regenerated by the build.
- Edits in this slice: `notes/formats/remake-save.md` (two passages), `notes/README.md` (latest pointer), and this file (new).
- No `src/` or `test/` change.
- Model: Claude Haiku 5.5, inline. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription
  usage was checked and no timer was scheduled.

## 7. Documentation audit addendum (2026-11-13, Haiku 5.5 inline)

Scope: top-level and project-status claims in `README.md`, `notes/ARCHITECTURE.md`, `notes/README.md` and `AGENTS.md`, checked against source and the dated handoffs. No source or test change, no emulator run, no write under `original/`, no commit or push. The worktree's existing edits were preserved.

### Corrected

- `notes/ARCHITECTURE.md`, layer table: it named `io/`, `formats/`, `detect/`, `render/` and `ui/` directories that do not exist under `src/`. Responsibilities now point at the real locations (`src/data/`, `src/game/`, `src/gfx/`, `src/audio/`, `src/startup.ts`, `src/main.ts`). Workflow step 2 now names `src/data/`.
- `notes/ARCHITECTURE.md`, "soak tests" (60k-120k random-input frames): no test in `test/` and no recorded run in `notes/` or the handoffs support it. Marked UNVERIFIED.
- `README.md`, Disk.4 paragraph: the XPKF/MASH decoder was attributed to `src/game/disk4-load.ts`. It lives in `src/data/xpk-mash.ts`; the parsers are in `src/data/disk4*.ts`. `disk4-load.ts` keeps the detached preparation layers.
- `README.md`, optional comparators: `compare:side` and `compare:site` (`test/build-side-preview-capture-compare.mjs`, `test/construction-site-capture-compare.mjs`) were missing from the list. Added, with the note that their results were not re-checked here.
- `notes/README.md`: the latest-handoff pointer already named this note. Only the pointer to section 7 was added.

### Checked and consistent (no change)

- Repository path references in the four documents: 133 unique references checked by script. Before the edits, every flagged item was shorthand (`io/`, `sim*.ts`, `notes/formats/*.md` patterns, bare names) or a placeholder, and none was a broken direct link. Direct links in `notes/README.md` and the handoff index all resolve.
- Constants: `SESSION_VERSION = 10` (`save-session.ts`), `SAVE_SLOTS = 8` (`save.ts`), `CHECKPOINT_SCHEMA = 4` (`checkpoint.ts`), 30 effect slots, 60/30 enemy and 40 ship/missile slots, `Disk.1` 970 752 and `Disk.2` 983 040 bytes (`detect.ts`).
- Validation error codes named in ARCHITECTURE match `profile-input.ts` (`disk4-unreadable` is the optional-file warning and is not named there).
- `frame()` is a no-op on `EnemySystem` (`enemies.ts`), not on `Sim`. The docs' wording is correct in context.
- The activation header write `$8F96 + index*$40` to `$1453A` matches `disk4-reset.ts`.
- `npm` scripts `compare:invasion`, `compare:pixels`, `compare:map`, `compare:menu`, `compare:side`, `compare:site` exist, and their test files exist.
- The Disk B / WHDLoad `Disk.2` 1 760-sector relation matches `formats/utopia-disks.md`.

### Still genuinely unverified (not changed here)

- The soak-test claim (see above). Either a test or a recorded run is needed before it is restated.
- The results of `compare:side` and `compare:site`, which were not re-run or re-read in this audit.
- The "4,108 `ok` lines" figure in sections 4-5 of the RNG handoff and section 5 of this note. The logs are in `%TEMP%`, outside the repo, so the figure cannot be re-checked from the repo.
- All original-game behaviour in sections 3, 6 and 7 of the RNG handoff: event 1's gate (`$1146A`), the morale `$144EC` bound and its byte 1, the market walk for values of 256 or more, and the TOD inference. None has a capture, and no emulator run was made in this slice.
- Redraw-gate timing after the boot-menu return (section 3, item 2 of this note) and the Disk.4 post-load fidelity described in `README.md`.
- Model routing: no orchestration tool was called, so `claudeAgent` routing is not confirmed. No subscription usage was checked and no timer was scheduled.

### Verification

- `npm run build` and `npm test` were not run, because no `src/` or `test/` file changed.
- Path re-check after the edits (`%TEMP%/doc-audit/paths.mjs`, outside the repository): 157 references, 29 flagged. All 29 are bare file names inside the layer table (for example `music.ts` under the `src/audio/` row), not broken paths. Every markdown link target in `README.md`, `AGENTS.md`, `notes/ARCHITECTURE.md`, `notes/README.md` and this note resolves.

## 8. Game-over slice: colony fall leaves the event index (2026-11-13, Claude Haiku 5.5, inline)

Model: Claude Haiku 5.5, inline. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled.

Scope: one game-over or restart discrepancy supported by the existing Disk.1 disassembly. No emulator run, no write under `original/`, no commit or push. The dirty worktree was preserved and `original/` was only read.

### Finding (VERIFIED static)

- Dispatch slot 19 (`$144BF` = 19, jump-table entry `$10ECA` = `jmp $10C72`) is the crime event. For crime above 60 it reaches the riot routine `$10D9E`, which decrements `$144BE` and at zero does `beq $10E0A`.
- `$10E0A` announces 0 (`$E770`), sets bit 3 of `$156AA` and does `jmp $157AE`. It never returns to the dispatcher.
- The dispatcher's index advance `addq.b #1,$144BF` (`$10E50`) follows the handler's `jsr` at `$10E4C`. So after a colony fall the original leaves `$144BF` = 19.
- The remake's `Sim.eventScheduler` advanced the index after every handler, so it ended at 20.
- Decoding was done with `tools/game_img.py` (the `load_game()` and `one()` helpers) and the raw Disk.1 bytes. Nothing was run in an emulator.

### Change (bounded)

- `src/game/sim.ts`, `eventScheduler`: returns before the index advance when the handler has set the game-over flag. The only game-over setters are `checkGameOver` (not reached from the scheduler, because `daily()` returns first) and `crimeRiot`, so this condition is the colony fall alone.
- `test/game-over.mjs`, new section 1b: a colony fall through the crime slot keeps index 19 (fails at 20 before the fix; verified), and a crime result without a riot still advances to 20.
- Notes: `notes/formats/game-proper.md` (Game over, new bullet), `notes/formats/sim-port.md` (event dispatch gate, exception).

### Impact and limits

- Observable only in the frozen game-over state, for example checkpoint `status.eventIndex`. A game over stops the scheduler, saves are refused, and a new scenario builds a fresh state. No gameplay effect is traced in the current remake.
- Reset question: resolved in section 9 below (the new-game path `$866E` d0 = 2 clears `$144BF`; the remake matches).
- The population loss (`$B086`) is in `$99C4` before `$10E1E`, so it does not touch the index. The remake matches that order (`Sim.daily` returns after `checkGameOver`).

### Verification (2026-11-13, this slice)

| Command | Result |
|---|---|
| `npm run build` | exit 0 (before the test: unfixed source, new test failed on index 20 as expected; after the fix: exit 0) |
| `node test/game-over.mjs` | exit 0, 28 `ok`, `all game-over checks passed` |
| `node test/sim.mjs` | exit 0, 87 `ok` |
| `node test/aliens.mjs` | exit 0, 78 `ok` |
| `node test/checkpoint.mjs` | exit 0, 66 `ok` |
| `npm test` (full chain, `UTOPIA_TUTORIAL_CAPTURE_DIR` unset) | exit 0, 4,111 `ok` lines, 0 `FAIL`. Log in `%TEMP%`/`/tmp/npm-test-gameover.log` |

Skipped by design as in section 5 (the optional capture comparators and the `UTOPIA_*_CAPTURE` / `UTOPIA_*_TRACE_DIR` checks).

## 9. Event index reset after a colony fall (2026-11-13, Claude Haiku 5.5, inline research)

Model: Claude Haiku 5.5, inline. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled.

Scope: read-only static question from section 8: does the original reset `$144BF` on a new scenario, tutorial or boot after a colony fall? No emulator, no write under `original/`, no code change, no commit or push. The worktree was preserved.

### Finding (VERIFIED static, Disk.1 via `tools/game_img.py`)

- **Fresh start resets the index.** `$866E` with d0 = 2 zeroes `$14234`-`$144CB` (`$8680`-`$8682`, `move.w #$297` gives 664 bytes; `$14234 + $298 = $144CC`). `$144BF` lies inside. Entries with d0 = 2: the tutorial `$80C8` (`$80F8`) and the scenario load `$88F0` (`$88FA`, disk-menu mode 3). So every new scenario or tutorial starts with index 0.
- **Load does not zero it, but restores it.** Mode 2 (`$8828`) calls `$866E` with d0 = 1, which branches to `$875C` past the loop (`$8670` `beq.w $875c`). The save load reads area B (11 sectors, `$13034`-`$14633`) at `$8874`, so the saved `$144BF` is restored. Saves are refused in game over (`$856C`), so a saved index is never a post-fall value.
- **Boot.** The image byte at `$144BF` is 0. No session begins without a fresh start or a load, so the boot value is never read.
- **Monthly write.** `$9ACC` (`move.b d0,$144BF`) clears it; `moveq #0,d0` at `$9AB4`, and d0 is unchanged to `$9ACC`.

### Bulk and indirect writers checked

- Scenario block: 9 sectors (`$13034`-`$14233`, `$8B52`) cannot reach `$144BF`.
- `$6D78` (map build): writes state only through `$a(a0)` and `$c(a0)` on `$13034`.
- Loops with lea state bases: `$7476` (`$13152`), `$A786` (six longs at `$14234`), `$ADEC` (`$1447C`-`$1448B`), `$135C6` (ends `$13F04`), `$E332` (reads only). None reaches `$144BF`.
- Not excluded: writes through state-held pointers (for example `$142B2`/`$142B6`) and the callees `$E370`/`$B680`. Neither changes the reset conclusion, which rests on the zero loop and area B.

### Remake comparison

- `GameState.applyDefaults()` (`src/game/state.ts`) zeroes the same range, and scenes and tutorials build a new `GameState`, so the index starts at 0. `fromSnapshot` restores the saved byte, as the original does. `Sim.daily` clears the index in the monthly step (`sim.ts` near line 1050).
- No mismatch was found, so no code or test changed.

### Documentation

- `notes/formats/game-proper.md`, "Event index on the colony fall": the open reset point is replaced with the traced reset and the remaining limits.
- Section 8 above now points here.

### Open

- Runtime capture is still needed to confirm the static path (for example a breakpoint on `$8680` or `$9ACC` after a colony fall and a new tutorial start).
- Pointer-indirect writes to `$144BF` are not exhaustively excluded (see above).
