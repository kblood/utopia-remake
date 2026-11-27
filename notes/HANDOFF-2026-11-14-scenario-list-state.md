# Utopia handoff: the held scenario list and its prompt (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. No orchestration tool was called, so `claude_personal` routing was not confirmed and no model switch is claimed. No emulator run, no writes under `original/` (read only), nothing committed or pushed. The dirty worktree was preserved; only the files listed in section 5 were edited.

Read first: [HANDOFF-2026-11-14-scenario-prompt.md](HANDOFF-2026-11-14-scenario-prompt.md) (its limitation 1, "the prompt is lost when a remake page is visited and closed", is answered here), [formats/game-proper.md](formats/game-proper.md) "Scenario list and the held prompt" (new) and "Disk menu".

Verification gap closed: `tools/game_dis.py` now runs in plain `python` (capstone 5.0.7 is importable; the earlier "not installed" note is stale). The routes below were disassembled from the Disk.1 image this pass.

## 1. Question and answer

**Can the remake's separate scenario page be reconciled with the original's list without inventing list rendering?** Partly. The state can be reconciled; the list rows cannot.

- Reconciled: the held scene, its prompt (`$8B`), the prompt's lifetime (cleared where the original erases it), and EXIT. These are traced and implemented.
- Not reconciled: the mode-3 list after a pick. The original draws the rows from the `$8F96` entries with `$539E` (ten rows, y from `$20`, pitch 9; verified in section 2) and leaves the list open. The remake's rows are its own `MenuScene` with record names, and no capture fixes the original's row layout or label text. So no rows are drawn and no mode-3 row handling is added.

## 2. Static evidence (Disk.1, re-disassembled)

Icon 2 (`$8632`), with `$855A` (prompt, wait, erase, disk header):

- `$8632`: `move.w #$13B,d0`; `bsr $855A`.
- `$855A`: `moveq #0,d1`; `bsr $8462` (prompt); `bsr $2E48` (wait for a left press); `bsr $84F4` (erase both prompt lines); `bsr $841E` (header).
- Success (`cmpi.w #2,d0` at `$863A`): `$865A` `move.w #$13D,d0`; `bsr $85CA`; `move.b #3,$938D` (mode 3); `bra $7EF6`. There is no `$82B8` on this path.
- `$85CA`: `moveq #0,d1`; `bsr $8462` (`$13D` on the prompt); then ten `bsr $539E` rows from `$8F96` (stride `$40`), y from `$20`, pitch 9. Verified by the `dbra` and `adda.w #$40` at `$85F4`.

Pick (`$88F0`, only in mode 3, `cmpi.b #3,d7` at `$88F0`): `move.b #2,d0`; `bsr $866E`; `move.w $8CFE,$135C2`; `bsr $8AF4` (scene build); `move.w #$8B,d0`; `moveq #0,d1`; `bsr $8462`; `rts`. `$938D` is not touched, so the list stays open in mode 3 after the pick.

Consequence: opening icon 2 erases a held prompt (`$84F4` after its click), and a pick prints `$8B` again. The original shows no prompt in between that the page visit could keep.

## 3. Change

`src/game/game.ts`:

- New field `heldPrompt` (string index, 0 = none), valid while `heldScene` is set.
- `acceptScene` sets it: a prompt message sets it, anything else clears it. It then calls `openDiskMenu()`, which prints the held prompt, and prints an info message as before.
- `openDiskMenu()` prints `heldPrompt` when a scene is held. This keeps the prompt across the right-button remake submenu and its BACK.
- Cleared where the original erases it: `openMenu("load")` (the load icon's `$855A` erase, also the remake LOAD GAME), `openScenarioMenu()` (icon 2's `$855A` erase, also the remake NEW SCENARIO), the music-select icon (`$1006` -> `$82B8`), and `enterScene` (EXIT or a tutorial).
- A load pick clears it through `acceptScene` (`$82B8` erases the prompt; the handoff `HANDOFF-2026-11-14-load-pick-message.md` already records that no load message is shown).
- Unchanged: the second pick replaces the held scene; EXIT enters it once; the save refusal while held (`exit-first`) and its remake note keep the prompt; the music and effects icons print on the result line and keep the prompt.

`test/scenario-pick.mjs`:

- Header comment records the `$855A` / `$85CA` routes.
- `save: slot 0` written before the picks (saving is refused while held).
- New section 4b: the remake submenu's right button and BACK restore the prompt; the scenario page's right-button return leaves it cleared; a pick after the page shows it again; a load pick (slot 0, scenario 0) replaces the held scene and clears the prompt and result line; a final pick of scenario 2 precedes the unchanged EXIT checks.

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 (run after each mutation, `dist` restored) |
| `node test/scenario-pick.mjs` | exit 0, 30 ok, 0 FAIL |
| `node test/disk-menu.mjs` | exit 0, 107 ok |
| `node test/disk-menu-keys.mjs` | exit 0, 41 ok |
| `node test/save.mjs` | exit 0, 403 ok |
| `node test/game-over.mjs` | exit 0, 50 ok |
| `node test/boot-menu.mjs` | exit 0, 52 ok |
| `node test/music-select.mjs`, `node test/game-music.mjs` | exit 0, 46 ok and 84 ok |
| `npm test` (full chain) | exit 0, 4787 ok, 0 FAIL |

Mutation checks on the built output (not the source), each followed by a rebuild:

1. Reprint removed from `openDiskMenu` (`void 0` in its place): `scenario-pick.mjs` exit 1, 10 FAIL. This includes the BACK round trip and the basic pick placement, so it is not specific to 4b.
2. Scenario-page clear removed (`openScenarioMenu`, its `heldPrompt = 0`): exit 1, 1 FAIL, `page: leaving the scenario page clears the prompt ... prompt 139,0`. This is the discriminating one.

Failed attempts, reported candidly:

- The first attempt at mutation 1 used `sed` on a single-line pattern. The compiled JS splits that statement over two lines, so the mutation did not apply (exit 0). Nothing was learned from that run; it was redone on the real line.
- The first attempt at mutation 2 targeted `enterScene` (line 334), not `openScenarioMenu`, and then a comment line inside `openScenarioMenu`. Both were wrong targets; the dist file was rebuilt after each. Only the third attempt, on the assignment inside `openScenarioMenu`, produced the failure above.
- Two disassembly listings for `$85CA` and `$855A` were first read at file offsets computed from the wrong base. The output was re-run with `python -c` offsets; the second listing is the one cited.

No visual parity is claimed. The prompt's pixels are checked only against a plain menu, as before. No capture of the original's list exists.

## 5. Notes and files changed

- `src/game/game.ts` (`heldPrompt`, `acceptScene`, `openDiskMenu`, `openMenu`, `openScenarioMenu`, `enterScene`, the music-select icon).
- `test/scenario-pick.mjs` (header, save before picks, section 4b).
- `notes/formats/game-proper.md`: new "Scenario list and the held prompt" subsection before section 7, with the traced table and the remake choices.
- `notes/HANDOFF-2026-11-14-scenario-prompt.md`: limitation 1 marked answered, pointing here.
- `notes/README.md`: newest-handoff pointer.

## 6. Remaining limits (not changed)

1. **Mode 3 after a pick.** *Answered 2026-11-14, see [HANDOFF-2026-11-14-scenario-list-open.md](HANDOFF-2026-11-14-scenario-list-open.md):* the remake's page stays open after a pick with the prompt, and a further pick replaces the held scene. Row placement and the `$539E` text layout are still not decoded, so no original rows are drawn.
2. **The scenario page is a remake page.** Its rows are record names. Icon 2's `$13B` disk prompt and wait are skipped (the remake has no disk swap). The equivalent state is taken after the click.
3. **Prompt on the remake submenu.** The submenu's SAVE and LOAD children erase the held prompt as the icons do. The submenu itself is a remake route, so keeping the prompt through BACK is a remake choice, not a traced rule.
4. **Timing.** The prompt has no countdown (`$8462`, no `$8CB0` start), as before. The erase on the icon route is static; the click wait is not timed.
5. **Disk.4 pick.** Answered 2026-11-14 ([HANDOFF-2026-11-14-disk4-pick-message.md](HANDOFF-2026-11-14-disk4-pick-message.md)): the Disk.4 pick is the mode-2 load `$8828`, and its `$145` is erased in the same handler, so the result-line print was removed. The held prompt is still cleared because the pick replaces the held scene; that clear is a remake choice.
