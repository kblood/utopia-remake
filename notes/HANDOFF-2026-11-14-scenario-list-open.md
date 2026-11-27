# Utopia handoff: the scenario list stays open after a pick (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. No orchestration tool was called, so `claude_personal` routing was not confirmed and no model switch is claimed. No emulator run, no writes under `original/` (read only), nothing committed or pushed, and the dirty worktree was not reset or cleaned.

Read first: [HANDOFF-2026-11-14-scenario-prompt.md](HANDOFF-2026-11-14-scenario-prompt.md) and [HANDOFF-2026-11-14-scenario-list-state.md](HANDOFF-2026-11-14-scenario-list-state.md) (the earlier `$8B` prompt and held-prompt work this builds on), and [formats/game-proper.md](formats/game-proper.md) "Scenario list and the held prompt".

## 1. Result

**Implemented for the remake's scenario page; the original's row layout is still not reproduced.** After a pick the page stays open, shows `$8B` on its prompt line, and can pick again. The held scene is replaced by each valid pick, and EXIT from the disk menu enters the last selection with one first pass. Rows are not drawn as in the original, and no visual parity is claimed.

## 2. Static evidence (Disk.1, re-disassembled with `tools/game_dis.py`, plain `python`)

File offset = address + `$28800`, checked with `python -c`.

| Address | Bytes / instruction | What it establishes |
|---|---|---|
| `$87DC` | `move.b $938D,d7` | the dispatcher reads the mode byte |
| `$87E2`-`$87EE` | `cmpi.b #4,d7` -> `$8A42`; `cmpi.b #1,d7` -> `$8918` | modes 4 and 1 go elsewhere |
| `$8820`-`$8824` | `cmpi.b #2,d7`; `bne.w $88F0` | mode 2 is the load; the fall-through to `$88F0` is every other mode |
| `$88F0`-`$88F4` | `cmpi.b #3,d7`; `bne.b $88EE` (`rts`) | the pick runs in mode 3 only |
| `$88F6`-`$8916` | `move.b #2,d0`; `bsr $866E`; `move.w $8CFE,$135C2`; `bsr $8AF4`; `move.w #$8B,d0`; `moveq #0,d1`; `bsr $8462`; `rts` | the pick: state init, scene select from the hovered row, `$8B` on the prompt, no `$82B8`, no write to `$938D` |
| `$8132`-`$8148` | `tst.b $938D`; `cmpi.w #$38/#$89`; `$8CFE` row = `(y-$20)/9` | the hover row exists only while a list is open |
| `$7FCE`-`$7FE0` | `bsr $2E52`; `tst.w $8CFE`; `bmi $7EF6`; `bsr $87DC`; `bra $7EF6` | a row release runs the dispatcher with the hovered row |
| `$2E52` | `btst.b #6,$bfe001`; `beq` | a wait for the left button up (not a row action) |
| `$938D` references | writes `$105A` (4), `$80CC` (3, tutorial), `$85BE` (1), `$8626` (2), `$8662` (3), `$82E0` (`clr.b`, the list close); reads `$813C`, `$8220`, `$8232`, `$87DC` | `$88F0` and `$8AF4` have no reference |

Consequence (VERIFIED static): after a pick, `$7EF6` loops with `$938D` still 3, so each later row release is another pick, and only EXIT (`$802C`) leaves the loop.

Not verified here: the original's row geometry and text (`$539E`, `$8F96` layout), the timing of the row action (the trace shows press-to-release, the remake acts on the press), and any capture. No emulator comparison exists for this step.

## 3. Change

- `src/game/menu.ts`: `MenuScene` gains a prompt line (`setPrompt`, `promptCodes`), drawn below the entries at `TOP + 16 + n*ROW + 4`, with the panel grown for it. The decoded picture is kept, and each redraw restores it first, so a removed prompt leaves no pixels. Without a prompt the page's pixels are unchanged. REMAKE placement, not traced.
- `src/game/game.ts`:
  - `pickScenarioFromPage(index)` (new): holds the built scene with the `$8B` prompt (`holdScene`) and calls `menu.setPrompt`. The page stays open; no disk menu is built.
  - `holdScene(...)` (new, shared): sets `heldScene` and `heldPrompt`. `acceptScene` uses it and still opens the disk menu, for loads and the Disk.4 continuation.
  - `startScenario(index)`: programmatic only, now public for the harnesses. The `pick` parameter is removed.
  - `case "scenario"`: a row pick calls `pickScenarioFromPage`; a right click still returns to the disk menu (`openDiskMenu`, which reprints the held prompt).
  - `openScenarioMenu` still erases the held prompt (icon 2's `$855A`); EXIT, load picks and the music list are unchanged.
- `src/game/disk-menu.ts`: the `SCENARIO_LOADED_STRING` comment names the list-stays-open trace and the page's prompt. No behaviour change.
- Tests (all in the `npm test` chain, `scenario-pick.mjs` already was):
  - `test/scenario-pick.mjs`: rewritten, 36 checks (see section 4).
  - `test/boot-menu.mjs`, `test/disk-menu-keys.mjs`, `test/game-over.mjs`, `test/save.mjs`, `test/game-music.mjs`: the scenario-pick sections that assumed the page closed after a pick now assert the open page, then leave it with the remake's right click before the disk-menu icons or EXIT. Behaviour assertions (held scene, pass counts, EXIT) are unchanged in meaning.

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 (after the final source edit) |
| `node test/scenario-pick.mjs` | exit 0, 36 ok, 0 FAIL (new coverage: multiple picks, prompt lifetime, navigation, EXIT and pass counts, row pixels) |
| `node test/boot-menu.mjs` | exit 0, 54 ok, 0 FAIL |
| `node test/disk-menu-keys.mjs` | exit 0, 42 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 51 ok, 0 FAIL |
| `node test/save.mjs` | exit 0, 404 ok, 0 FAIL |
| `node test/game-music.mjs` | exit 0, 85 ok, 0 FAIL |
| `node test/disk-menu.mjs`, `button-image-carry.mjs`, `music-select.mjs` | exit 0 (107, 20, 46 ok) |
| `npm test` (full chain, run after the last test edit) | exit 0, 4808 ok, 0 `FAIL` lines |

Red checks, on the built output (`dist/game/game.js`), each restored afterwards and the suite re-run to pass:

1. The page closes after a pick (`this.openDiskMenu()` added after `setPrompt`): `scenario-pick.mjs` exit 1, 8 FAIL lines.
2. The page drops its prompt on a pick (`setPrompt(null)`): exit 1, many FAIL lines, including the first placement check and the second-pick check.

Not run: the emulator, any capture, and the optional `UTOPIA_SITE_CAPTURE` comparison (skipped in `npm test` as before).

## 5. Limitations (not changed)

1. **Rows are not the original's.** The page keeps record names and has no `$539E` rows, hover or row layout. The original's mode-3 list rows are still not decoded, so none are drawn.
2. **The row action is on the press.** *Answered later on 2026-11-14, see [HANDOFF-2026-11-14-scenario-page-exit.md](HANDOFF-2026-11-14-scenario-page-exit.md):* the page's rows and EXIT act on the release, as the original's `$7FCE`/`$2E52` do.
3. **No EXIT on the page.** *Answered later on 2026-11-14, see [HANDOFF-2026-11-14-scenario-page-exit.md](HANDOFF-2026-11-14-scenario-page-exit.md):* the original's icon 5 (EXIT) is live in mode 3, so the page has an EXIT entry and needs no right click.
4. **The prompt position is a remake choice.** `$8B` sits in the page panel under the rows; the original's prompt is at y `$A3` on the disk menu. Not compared on screen.
5. **`$13D` is not shown on opening the page.** The original prints `$13D` on the list prompt when icon 2 succeeds (`$85CA`). The remake's page opens with no prompt, as the earlier notes recorded; a page-open prompt was not added here.
6. **No empty-record refusal.** All ten records on the supplied Disk.2 are named and buildable. The original's `$88F0` has no empty-slot check, so none is added; a record that cannot build would still throw, as before.
7. **Test files untracked.** `test/boot-menu.mjs`, `test/disk-menu-keys.mjs`, `test/game-over.mjs` and `test/scenario-pick.mjs` are untracked in git (`??`) in this worktree. That predates this work and was not changed by it. Nothing was committed.

## 6. Notes changed

- `notes/formats/game-proper.md`: "Scenario list and the held prompt" gains the mode-3 loop table, the `$938D` reference list, and the remake's page behaviour with its limits (the old "not reproduced" bullet is replaced).
- `notes/HANDOFF-2026-11-14-scenario-prompt.md` and `notes/HANDOFF-2026-11-14-scenario-list-state.md`: their "list open after a pick" limitations point here.
- `notes/README.md`: newest-handoff pointer is this note.
