# Utopia handoff: icon 2's second-press wait and the held press (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. The brief asked for `claude_personal`, but no orchestration tool was called, so that routing is not confirmed and no model switch is claimed. No emulator run, no writes under `original/` (read only), nothing committed or pushed, and the dirty worktree was not reset or cleaned.

Read first: [HANDOFF-2026-11-14-opening-click.md](HANDOFF-2026-11-14-opening-click.md) (the trace and its section 6 decision, now implemented here) and [formats/game-proper.md](formats/game-proper.md) "Opening click and the held press".

## 1. Decision and answer

The decision recorded in the opening-click handoff (section 6) was to model the original's second-press wait, even though it costs the user one more click. It is now implemented.

- **Icon 2's release selects no row, and it does not open the list.** The icon acts on its release (`$7F96` -> `$59C8` -> `$7FE4`), and the original then runs `$855A`, which prints `$13B` and waits in `$2E48` for a fresh left press. The remake now does the same: `Game.awaitScenarioPress` prints `$13B` ("Insert scenario disk in internal drive and click mouse button..", string 315) on the disk menu's prompt line.
- **The wait is a raw poll.** `$2E48` reads only the left button, with no latch and no `$50B2`. The remake's wait reads only the left button too. While it runs the disk menu takes no icon, row or right-button input, and its result lines keep counting down (`DiskMenuScene.tickInfo`).
- **The press that opens the list is the one that can pick.** The first frame where the left button is newly down (the edge `$2E48` tests) clears the prompt and opens the scenario page with that press pending (`MenuOptions.pressPending`). The page's first update is the remake's first list poll. A button still down there arms the row under the pointer, and its release picks that row (`activateOnRelease`, the press-row rule of `$7FCE`). A press already released before that update picks nothing.
- **After a pick** the page shows `$8B` on its prompt line, as before. The list stays open, and EXIT enters the last pick, as before (`test/scenario-pick.mjs`, unchanged in behaviour).

## 2. Model, by frame

| Step | Remake | Original (Disk.1, static) |
|---|---|---|
| Icon 2 released | `$13B` on the disk menu prompt; `scenarioWait` set; no page | `$59C8` -> `$8632` -> `$855A`: `$8462` prints `$13B` |
| Frames with the button up | Wait ignores icons, rows and the right button; countdown ticks | `$2E48`: `btst.b #6,$bfe001` loop, nothing else read |
| Frame K: left button newly down | Prompt cleared (page replaces the disk menu); page opens with the press pending | `$2E48` returns; `$84F4` erases the prompt; `$841E` header; `$865A` rows; `$938D` = 3 |
| Frame K+1: first list poll, still down | Row under the pointer armed (if any) | `$7F72` `$8132`, then `$50B2` sees a press edge (the icon release cleared the latch, `$50C6`); `$7FCE` |
| Frame K+1: already up | Nothing armed; the click is spent | `$50B2` sees no press; nothing picked |
| Release on the armed row | Row picked (`$8B` on the page prompt); list stays open | `$7FCE` -> `$2E52` -> `$87DC` -> `$88F0` (`$8B`) |
| EXIT | Enters the last pick once | `$802C` |

## 3. Approximation (explicit)

**The duration of the original's header read (`$841E`, a disk read) and list draw (`$865A`) was not measured.** So the time between the wait's press and the first list poll is unknown. The remake has no such duration: the page's first update is the first list poll, one update after the wait's press. This is an **update approximation**, not a timing claim.

Consequences, stated as limits:
- A press that comes during the original's setup, after `$2E48` returned and before the first poll, is the same press that the first poll sees. The remake accepts it when it is still held at the first update, which matches the original's order. Whether it is held long enough in the original is not known.
- A press released before the first poll picks nothing in both. Where the original's first poll falls relative to the release is not known, so the one-update window is a choice, not a measurement.

## 4. Changes

- `src/game/disk-menu.ts`: `SCENARIO_WAIT_STRING` (`0x13b`, with the `$855A` / `$2E48` note); `DiskMenuScene.tickInfo()` (the result countdown, split from `update`, which calls it first).
- `src/game/menu.ts`: `MenuOptions.pressPending`; the page's `wasDown` starts false when it is set, so a button still down at its first update is a press. Without it the page keeps ignoring a held button, as before.
- `src/game/game.ts`: `scenarioWait` field; `handleDiskMenu` routes input to `waitForScenarioPress` while it is set; icon 2 calls `awaitScenarioPress` (prints `$13B`, sets the wait) instead of opening the page; `openScenarioMenu(pressPending)`; the remake submenu's own scenario entry calls `openScenarioMenu(false)` (no wait, nothing pending: its press chose the entry, so the button is down and must not arm a row); `openDiskMenu` clears the wait.
- `test/scenario-wait.mjs` (new, added to `npm test` after `scenario-pick.mjs`): 22 checks.
- Existing tests moved to the second press (each icon-2 open now adds a press off the rows, or a press in the wait):
  - `test/boot-menu.mjs`: helper `scenarioIcon()`; section 11 rewritten to the real sequence (icon release over row 4 shows `$13B` and picks nothing; the next press opens the page; a press held through the first poll and released on row 4 picks row 4). Section 10 uses the helper.
  - `test/scenario-pick.mjs`, `test/disk-menu-keys.mjs`, `test/game-over.mjs`, `test/game-music.mjs`: helper or inline second press after each icon-2 click.
  - `test/save.mjs`: the two direct `diskIcon(DISK_BUTTON.scenario)` calls are followed by an off-row press that opens the page.
- `notes/formats/game-proper.md`: the "Opening click and the held press" bullet's remake line now describes the implemented wait and the approximation; the icon-release sentence no longer says the list opens on the release.
- `notes/README.md` index and `HANDOFF-2026-11-14-opening-click.md` section 6 now point here.

## 5. Regressions (test/scenario-wait.mjs)

1. **Opening click cannot select:** icon pressed, dragged over row 2 and released there: the `$13B` wait shows, no page, no held scene; ten idle frames pick nothing; a right click in the wait is not read.
2. **Held second press selects on release:** the press that opens the page, held through its first poll over row 2, picks scenario 2 only on the release; the page's prompt is clear while pending, then shows `$8B`.
3. **The row is the one under the press at the first poll:** held over row 2 at the first poll and released over row 5 picks row 2. A press off the rows at the first poll arms nothing, and moving onto row 4 before the release picks nothing.
4. **Already-released click does not select:** a press released before the first poll picks nothing; ten idle frames pick nothing; a later fresh tap on row 3 picks scenario 3.
5. **Prompt transitions:** no line before icon 2 (`0,0`); `$13B` (`315,0`) on the disk menu after the icon release; cleared when the page opens; `$8B` on the page after a pick.
6. **Result-line countdown during the wait:** a result line expires while the wait runs (the wait ticks the countdown itself).
7. **Last-selection EXIT:** picks of rows 1 then 2 hold scenario 2; EXIT enters scenario 2 once, with its one immediate pass, and the replaced scene never runs.

Mutation checks (temporary, sources restored byte-for-byte afterwards, confirmed with `cmp`):
- Page ignores a held button at open (`pressPending` no effect): sections 2-3 and the `$8B` checks fail (4 FAIL lines), so the held-press regression is discriminating.
- Wait does not tick result lines: the countdown check fails (`waited 58 left 49`).

## 6. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/scenario-wait.mjs` | exit 0, 22 ok, 0 FAIL |
| `node test/scenario-pick.mjs` | exit 0, 52 ok, 0 FAIL (unchanged count) |
| `node test/boot-menu.mjs` | exit 0, 63 ok, 0 FAIL (was 62: section 11 has one more check) |
| `node test/disk-menu-keys.mjs` | exit 0, 42 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 51 ok, 0 FAIL |
| `node test/save.mjs` | exit 0, 404 ok, 0 FAIL |
| `node test/game-music.mjs` | exit 0, 86 ok, 0 FAIL |
| `node test/disk-menu.mjs` | exit 0, 107 ok, 0 FAIL |
| `npm test` (full chain, foreground) | exit 0, 4856 `ok` lines, 0 `FAIL` lines; optional captures skipped (`UTOPIA_SITE_CAPTURE` and others not set) |

No emulator run and no capture. Fidelity claims are limited to the static trace and the update approximation in section 3.

## 7. Open points and limits

1. **Timing is unknown.** How long the original's header read and list draw take is not measured, so the remake's one-update window is an approximation (section 3).
2. **The right button does not leave the wait.** `$2E48` reads only the left button, so the remake's wait ignores the right button too. The user leaves the wait by pressing the left button. This is faithful to the trace, but it is a UX cost; a remake exit from the wait would be a separate decision.
3. **The page is the remake's text list.** Its rows and the `$8B` placement are the remake's own (no row-layout or visual parity claim). The `$13B` line uses the disk menu's traced prompt area (`$8462`, y `$A3`), checked by code only, not by a screenshot.
4. **Remake submenu scenario entry.** It opens the page with no wait, as before (`openScenarioMenu(false)`). That route has no original counterpart.
