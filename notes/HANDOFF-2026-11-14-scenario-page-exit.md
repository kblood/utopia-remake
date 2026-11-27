# Utopia handoff: the scenario page's EXIT and the release model (2026-11-14, later pass)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. No orchestration tool was called, so no `claude_personal` routing is confirmed and no model switch is claimed. No emulator run, no writes under `original/` (read only), nothing committed or pushed, and the dirty worktree was not reset or cleaned.

Read first: [HANDOFF-2026-11-14-scenario-list-open.md](HANDOFF-2026-11-14-scenario-list-open.md) (the page stays open after a pick; its section 5, limitations 2 and 3, is answered here) and [formats/game-proper.md](formats/game-proper.md) "Scenario list and the held prompt".

## 1. Result

**The original's EXIT is part of the mode-3 screen, and the remake's page now has it.** The original's icons stay live while the list is open: EXIT is icon 5 on the disk picture (`$802C`), and its press and release have no mode test. Rows also pick on the release, not the press, as the original does. The remake's scenario page now has the release model and an EXIT entry that enters the held selection directly, so the right-click detour is gone. The page's rows and visuals are still the remake's own; no visual parity is claimed.

## 2. Static evidence (Disk.1, raw bytes, file offset = address + `$28800`, checked with `python`)

Full table with raw bytes is in [formats/game-proper.md](formats/game-proper.md) "Mode-3 input path". The points that decide the route:

| Address (file offset) | Raw bytes (checked) | What it establishes |
|---|---|---|
| `$7F72` (`30772`) | `610001be 4eb90000 50b2` | the loop: `bsr $8132` (hover), then `jsr $50B2` (the event poll) |
| `$50B2` (`2d8b2`) | `70ff`, `btst #6,$bfe001` | d0 = -1 unless the poll sees an event |
| `$50DC` (`2d8dc`) | `08f9 0003 000156a8` | the press onset sets the latch (bit 3 of `$156A8`) and returns d0 = 0 |
| `$50C6` (`2d8c6`) | `08b9 0003 000156a8` | the release clears it and returns d0 = 0 |
| `$7F8C` (`3078c`) | `0839 0003 000156a8` `66 12` | latch set -> `$7FA8` (the press path); clear -> the release path (`$5DD4`, then `$59C8`, then `$7FE4`) |
| `$7FB2` (`307b2`) | `4eb9 0000 5730` | the hit test on the icon table `$8CB4`; **no `$938D` test on this path** |
| `$8CB4` (`314b4`) | nine entries of four words (x0, x1, y0, y1), then `$FFFF` | icon 5 = (256,287,116,147); equal to the remake's `DISK_MENU_BUTTONS[5]` |
| `$7FC0` (`307c0`) | `4eb9 0000 5948` | icon press: stores the index in `$5DD4`, inverts the icon |
| `$59C8` (`2e1c8`) | `4cb9 0003 00005dd0` ... | icon release: returns `$5DD4` in d2, clears it |
| `$7FE4` (`307e4`) | `0c02 0005`, `beq $802C` | dispatch: icon 5 is EXIT |
| `$7FCE` (`307ce`) | `6100 ae82` (`bsr $2E52`), `tst.w $8CFE` | a row (no icon hit): wait for the release (`$2E52` = `btst #6` loop, `2b652`), then the row under the press (hover not updated during the wait), then `$87DC` |
| `$802C` (`3082c`) | `0839 0003 000156aa` `66 00 fe c0` | EXIT: game over refuses (`$156AA` bit 3); no mode test |
| `$87DC` (`30fdc`) | `1e39 0000 938d` | the mode dispatch (unchanged) |

Consequences (VERIFIED static, not emulator-checked):

1. A press on a row picks nothing: the press only records the row (via `$8CFE`) and waits; the pick is the release (`$2E52` returns when the button is up, then `$87DC`).
2. EXIT is pressed and released on the disk picture in mode 3 exactly as in mode 0. `$938D` stays 3 after a pick, so the list stays open, and EXIT (`$802C`) leaves the loop. The right button is not needed.
3. No double action from the latch: after the row release, the next `$50B2` event clears the latch (`$50C6`) and the row path leaves `$5DD4` alone, so the release does not dispatch again.

Not verified: the on-screen drawing of icons and rows in mode 3 (no capture), and the VBL timing of the release. There is no emulator comparison for this step.

**Open point, partly settled (see section 6):** `$7F96` (`tst.w $5DD4`) treats any value >= 0 as a pending icon. Mode-3 entry always runs after the icon release `$59C8`, which sets `$5DD4` to -1, so the first row release on the list cannot dispatch icon 0 (section 6, points 1 and 2). The value at game start, before any icon press, is still the RAM state and is not settled (section 6, point 4).

## 3. Change

- `src/game/menu.ts`:
  - `MenuOptions.activateOnRelease` (new, optional 4th constructor argument; default off, so every other remake page is unchanged). With it, a press records the entry under the pointer (or none, off the entries or disabled), and the release returns that entry. A right press clears the record and still returns -1.
  - `setPromptText(text)` (new): the page's prompt line with a remake message.
- `src/game/game.ts`:
  - `SCENARIO_EXIT_LABEL` (exported, `"EXIT"`): the scenario page's last entry, index `records.length`.
  - `openScenarioMenu`: the page is built with the ten records, then EXIT, and `{ activateOnRelease: true }`.
  - `exitMenus(refuse)` (new, private): the disk menu's icon-5 action, extracted so both the disk menu and the page use it. A held scene enters (`enterHeldScene`); with none, the boot session calls `refuse("REMAKE: CHOOSE A SCENARIO")`; otherwise, unless game over, the menus close to the map (`closeMenu`) and the map arms its immediate pass. The disk menu's `DISK_BUTTON.exit` case calls it with `scene.printRemakeNote`; the page calls it with `menu.setPromptText`.
  - `case "scenario"`: `-1` (right click) returns to the disk menu (unchanged); `records.length` runs `exitMenus`; any other index is a pick (`pickScenarioFromPage`, unchanged).
  - `diskIcon`: the unused `gameOver` local is removed (the exit check moved into `exitMenus`).
- `test/scenario-pick.mjs`: the reference page has the EXIT entry; the game is a `let` so sections 7-11 start fresh games; new sections:
  - 7: a press alone picks nothing; the release picks the press row, even with the pointer released on another row; a press off the entries picks nothing.
  - 8: EXIT on the page, released on EXIT, enters the last pick directly (no disk menu), one immediate pass in the EXIT update; the next update adds none.
  - 9: the boot session: EXIT with nothing held prints the remake note on the page and stays; a pick replaces the note; EXIT with a held pick enters it.
  - 10: EXIT with nothing held in the game proper closes to the same map with its pass armed.
  - 11: game over refuses the page's EXIT silently; the list stays open.
  - Sections 1-6 keep their meaning; the reference-page changes match the page (11 entries).
- `test/game-music.mjs`: the scenario pick is split into a press (no pick) and a release (the pick); the disk EXIT part is unchanged.
- Notes: `notes/formats/game-proper.md` (mode-3 input path table, the release and EXIT bullet, evidence line), this handoff, `notes/README.md` (newest-handoff pointer), and `notes/HANDOFF-2026-11-14-scenario-list-open.md` (limitations 2 and 3 answered here).

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/scenario-pick.mjs` | exit 0, 52 ok, 0 FAIL |
| `node test/game-music.mjs` | exit 0, 86 ok, 0 FAIL |
| `node test/boot-menu.mjs` | exit 0, 54 ok, 0 FAIL |
| `node test/disk-menu-keys.mjs` | exit 0, 42 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 51 ok, 0 FAIL |
| `node test/save.mjs` | exit 0, 404 ok, 0 FAIL |
| `npm test` (full chain) | exit 0, 4825 `ok` lines, 0 `FAIL` lines; the construction-site capture comparison skipped (`UTOPIA_SITE_CAPTURE` not set, as before) |

Red checks, on the built output (`dist/game/game.js`), each restored from a copy and the suite re-run to pass:

1. Press activation on the page (`{ activateOnRelease: true }` replaced by `undefined`): `scenario-pick.mjs` exit 1, 3 FAIL lines (section 7 press checks, section 8 press check, section 10 arming).
2. Page EXIT reverted to a right-click detour (`choice === records.length` -> `openDiskMenu()`): exit 1, 9 FAIL lines across sections 8-11.

Not run: the emulator, any capture, and the optional `UTOPIA_SITE_CAPTURE` comparison.

## 5. Limitations

1. **Rows and EXIT are the remake's text entries.** The page does not show icon 5's picture, does not invert it, and draws no pressed look; the press highlight is the remake's hover only.
2. **The remake's release timing is per frame**, not the original's VBL; `$2E52` waits for the button up, and the remake acts on the frame where it sees the release.
3. **The held pass runs in the EXIT update.** That is the remake's existing held-scene exit (the same as the disk menu's), not a traced timing.
4. **The page's prompt line placement is a remake choice** (under the entries, see the earlier handoff). The boot refusal note uses that line.
5. **No capture.** The on-screen state of the original in mode 3 (icons and rows drawn together) is not compared.

## 6. Follow-up: the `$5DD4` latch at scenario-page entry (2026-11-14, same day; static, no emulator)

Task: settle section 2's open point (the value of `$5DD4` before the first icon press, and whether the first row release can dispatch icon 0). Full trace: [formats/game-proper.md](formats/game-proper.md) "`$5DD4` latch state at scenario-page entry". Checked against the raw bytes of `original/utopia-whdload/Disk.1` (file offset = address + `$28800`; every cited offset re-read and matched).

**Result.**

1. **Mode-3 entry always has `$5DD4` = -1 (VERIFIED static).** The only jump into the dispatch `$7FE4` is `bra.b $7FE4` at `$7FA6` (`$7FE4` has no other `jsr`, `bra` or `bsr`). It follows `jsr $59C8` at `$7FA0`, and `$59C8` ends with `move.w #$FFFF,$5DD4` at `$5A0C`. The list is entered only from that dispatch: icon 2 (`beq.w $8632` at `$7FFE`, then `$855A` and `move.b #3,$938D` at `$8662`) or icon 6 (`beq.w $80C8` at `$800C`, `move.b #3,$938D` at `$80CC`). Nothing else sets mode 3.
2. **The first row release cannot dispatch icon 0 (VERIFIED static consequence).** A press on a row goes to `$7FCE` (`$2E52` waits for the raw release; no `$5DD4` write). The release edge is then taken by `$50B2`, and `$7F96` (`tst.w $5DD4`) reads -1 and returns. Icon 0 (LOAD, `$85FE`) is not reachable from this page.
3. **The remake's page has no first-entry bug.** `openScenarioMenu` builds a new `MenuScene` with `armed = null` and `wasDown = true`, so the click that opened it (the icon 2 release, or the REMAKE MENU press) is ignored, and a release with no press picks nothing. `DiskMenuScene` is replaced on that route, so no disk press state carries over. No code change was needed.
4. **Still open: the mode-0 disk menu at game start (STATIC; the value is RAM).** Before any icon press, `$5DD4` holds the RAM value. No traced code sets it (writer scan: `$5848` and `$5A0C` clear; `$5952`, `$5760`, `$15A1A` write indices; their callers are map, build or disk code, and no boot-stage caller was found by a direct-reference scan). If it is >= 0, a press off the icons followed by its release would dispatch that index at `$7F96` -> `$59C8` -> `$7FE4`. The remake cannot show that; it is neither observed nor claimed. Settling it needs the RAM value at the first disk-menu entry, which is an emulator or capture question.

**Also noted, not changed (timing, static).** *Answered later on 2026-11-14, see [HANDOFF-2026-11-14-opening-click.md](HANDOFF-2026-11-14-opening-click.md): the icon release picks no row, and the held second press is traced but not reproduced.* Icon 2's `$855A` waits with the raw poll `$2E48` and does not touch the latch. If the button is still down when the list loop starts (after the disk header read), the loop's first `$50B2` sees a press edge and can pick the row under the pointer on that click's release. The remake's page ignores a held click. The timing is not traced, so no change was made.

**Change.** Regression only: `test/boot-menu.mjs` section 10 (a new `Game` booted through the stages to the disk menu, icon 2, two idle frames, a press alone on row 4, then its release). It checks that nothing is held or dispatched on the press or the idle frames, and that the release picks scenario 3 with the page open and no map or disk menu. Red check: with `{ activateOnRelease: true }` removed from the built `dist/game/game.js`, `node test/boot-menu.mjs` exits 1 with `FAIL a press alone on row 4 of the fresh page picks nothing`; the built file was restored and the test re-run to pass.

**Verification.** `npm run build` exit 0. Focused: `scenario-pick` exit 0 (52 ok), `game-music` exit 0 (86 ok), `boot-menu` exit 0 (58 ok, section 10 included), `disk-menu-keys` exit 0 (42 ok), `game-over` exit 0 (51 ok). Full `npm test` exit 0, 4829 `ok` lines, 0 `FAIL` lines; the construction-site capture comparison skipped (`UTOPIA_SITE_CAPTURE` not set). No emulator run.
