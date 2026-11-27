# Utopia handoff: weekly transition audit (`$9A56`-`$9A88`), 2026-11-13

Model and routing: Claude Haiku 5.5, inline, as the research sub-agent. No orchestration tool was called, so the `claudeAgent` routing requested in the brief is not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run. Nothing under `original/` was written. Nothing was committed or pushed. The dirty worktree was preserved. No repository code or test was changed, so no build or test run was required; the scratch probe lives in `%TEMP%\utopia-weekly-audit` and is not part of the repository.

Read first: [AGENTS.md](../AGENTS.md), [HANDOFF-2026-11-13-solar-phase.md](HANDOFF-2026-11-13-solar-phase.md) (the latest handoff before this one), [formats/game-state.md](formats/game-state.md) section 5.1, [formats/sim-port.md](formats/sim-port.md).

Scope: one bounded weekly transition, the `$99C4` weekly branch and its callees `$10FCA` (eclipse) and `$11024`. The monthly slices already reviewed were not re-audited.

## 1. Traced order (VERIFIED, static Disk.1)

The weekly branch at `$9A56`-`$9A88` (Disk.1 game proper, decoded with `tools/game_dis.py`) runs, after `bclr.b #1,$144C1` succeeds:

| Step | Routine | Remake (`src/game/sim.ts`, `weekly()`) |
|---|---|---|
| 1 | `$7000` construction countdown | `this.onWeek?.()` (ported in `construction.ts`) |
| 2 | `$4798` refuel | `this.fleet.weeklyRefuel()` |
| 3 | `$10FCA` eclipse | `this.eclipseWeekly()` |
| 4 | `$12510` repair | `this.fleet.weeklyRepair()` |
| 5 | `$127A0` battle | `this.aliens.weeklyBattle()` |
| 6 | `$144B2` counter, `subq.b #1` if nonzero | `this.s.byte(0x144b2)` decrement |

Order and gating match. The pause and game-over checks in `Sim.run()` also match the original's `$156A9` bit 2 test and the `jmp` after `$B086`.

## 2. Eclipse routine `$10FCA` (VERIFIED static; countdown matches a probe)

Static trace (Disk.1 bytes at image offset `$29800 + ($10FCA - $1000)` = `$397CA`):

- `btst #7,$156AA`: tutorial returns. Remake: `SYS.tutorialMode` returns first. Match.
- `$144BB` nonzero: decrement; if the result is nonzero, return; else message `$DE`, bit 6 cleared, then the swap (section 3). Remake: decrement, return while nonzero, else clear bit 6 and message `$DE`. Match apart from the swap.
- `$144BB` zero, `$145A0` = `$0B` and `$1459F` = `$15`: `$144BB` := 3, message `$DD`, bit 6 set, then the swap. Remake: same test and values. Match apart from the swap.

Scratch probe (`%TEMP%\utopia-weekly-audit\probe.mjs`, read-only against `dist/`, four runs of four weekly passes through `Sim.run()` with pending bit 1):

| Case | Result |
|---|---|
| day 21, month `$0B` | week 1: `$144BB` = 3, `$DD`; week 2: 2; week 3: 1; week 4: 0, `$DE`, bit 6 clear |
| day 20, month `$0B` | never starts |
| day 21, month `$0A` | never starts |
| tutorial bit set, day 21, month `$0B` | never starts |

The calendar month is 0-based: `$05` is June in game-proper.md section 1, so `$0B` is December and the eclipse date is 21 December. This is only a reading of the existing notes, and it does not change any code.

**Gap:** no repository test covers this countdown. The `VERIFIED` label in `sim-port.md` previously rested on the static trace alone. The probe is scratch, not a test.

## 3. The discrepancy: `$11024` descriptor swap (VERIFIED static; not ported)

`$10FCA` calls `$11024` on both the start path (after `$5A8C`) and the end path (`bra $11004` into the same tail). The routine:

- loads `$1612E` (the descriptor table pointer, 8-byte entries `{long rows-1, long data address}`);
- swaps the data-address long of entry 4 with entry 51 (`+$24` and `+$19C`, i.e. `8*4+4` and `8*51+4`);
- swaps the data-address long of entry 50 with entry 54 (`+$194` and `+$1B4`, i.e. `8*50+4` and `8*54+4`);
- leaves each entry's rows-1 in place.

A second swap is its own inverse, so the table state is the parity of calls. The original calls it at each eclipse start and end, and at four other sites, shown in the table below.

| Caller | Condition | Meaning |
|---|---|---|
| `$1100A` (in `$10FCA`) | eclipse start or end | weekly |
| `$1107A` (in `$11058`) | event 14 starts an eclipse | event |
| `$7ED4` (in the disk-menu entry) | bit 6 of `$156AA` set | reconcile at menu entry |
| `$8040` (in the boot exit) | `$144BB` nonzero | reconcile at exit; then sets bit 6 |

The two reconcile sites suggest that the original keeps the table swapped exactly while the eclipse is active. That is an inference from the call conditions, not an observed invariant.

**The remake does not do this.** `eclipseWeekly()` and `eventEclipse()` (`sim.ts` ~877) set the flag and the message only. The tile table is built once from the descriptors (`src/data/scenario.ts` `readTiles`, `loadTileSet`), and no code swaps any entry. `grep` for `1612`, `descriptor` and `swap` in `src/` finds nothing relevant.

**Visible effect (static, not observed):** tile ids are 1-based (`map.ts` 774, `tiles[id - 1]`), so the swap affects tile ids 5, 52, 51 and 55 (`$05`, `$34`, `$33`, `$37`). Build-menu page 1 draws `$33` in slot 9 by default, and research bit 14 replaces slot 9 with `$34` (`build-menu.ts` line 36, `building.md` line 79). Build-menu icons read the same table as the map (`build-menu.ts` line 210). So during an eclipse the build-menu icons for `$33`/`$34` would show the pictures of `$37`/`$05`, if the original blits from the shared table. Whether any map cell uses those ids during an eclipse is not established.

## 4. Why no fix was made

The brief asked for one narrow fix when a defensible mismatch exists. This mismatch is real and instruction-level, but a faithful fix is not narrow:

1. It needs a derived view of the tile table, consumed by `MapScene`, `ObjectLayer`, `Controls` and `build-menu.ts` (`map.ts` 202/221/250/272/774/778, `objects.ts` 184/408/426, `build-menu.ts` 174/215/234/240). Each consumer would need the eclipse-dependent view. That is a renderer change across several files.
2. The reset semantics are unverified. `$866E` zeroes `$144BB` without any traced swap. If the original's game-start path does not reload the tile table, the table may stay swapped after the flag is cleared, and a derived rule ("swapped iff bit 6") would then disagree. The two reconcile sites support the derived rule, but they do not settle a new-game reset.
3. The visible effect has not been observed in any run. Both the effect and the reset need an emulator check before a visual change is claimed.

Recommended design, pending approval: a pure helper `eclipseTileView(tiles, active)` that returns a view with the four data-address exchanges applied and rows unchanged; wire it through the existing tile consumers; regression = a unit test on the helper (entries 4, 50, 51, 54 swapped; rows kept; applying it twice is the identity) plus a check that tile ids 51 and 52 draw the swapped planes during bit 6. No save-format change is needed if the view is derived from `sysFlags`. This matches the two reconcile call sites, but it is a design choice, not a traced rule for new games.

## 5. Unverified items

- Whether the original's new-game path (`$866E`, `$80A6`) reloads the descriptor table or otherwise clears the `$11024` parity. Not traced.
- Whether the swapped pictures are visible on the map or in the build menu during play. Static reading only.
- Whether `$8040` (boot exit) and `$7ED4` (disk-menu entry) swap only once per session, which depends on the reset question above.
- Event 14 (`$11058`) and its `roll` order are outside this slice. Its swap is listed in section 3.
- `$7000`, `$4798`, `$12510` and `$127A0` are called in order from the dispatch, but their bodies were not re-audited here.

## 6. Verification

| Check | Result |
|---|---|
| Static trace, `$9A56`-`$9A88` and `$10FCA`-`$11022` (`tools/game_dis.py`, Disk.1 offset `$397CA`) | Done; reproduced by `game_img.walk` for the `$11024` caller list |
| Scratch probe of the countdown (`%TEMP%`, read-only against `dist/`) | Four cases, results in section 2 |
| `npm run build`, `npm test` | Not run: no repository code or test changed |

An early attempt computed the wrong file offset (`$FCA` instead of `$FFCA` within the game-proper image), which was caught by comparing against `tools/game_img.py`. No result above depends on that attempt.

## 7. Repository state

- Branch `main`. Worktree preserved. Nothing committed or pushed.
- Changed in this slice: `notes/formats/sim-port.md` (weekly row), `notes/formats/game-state.md` (section 5.1 item 3 sub-bullets and the `$144BB` row), `notes/README.md` (latest-handoff pointer), `notes/HANDOFF-2026-11-13-weekly-transition.md` (this file).
- No file under `original/` was read beyond the static disassembly, and none was written. No source, test or `dist/` file was changed by this slice.
