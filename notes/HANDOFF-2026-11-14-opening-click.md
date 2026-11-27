# Utopia handoff: the click that opens the scenario list and a held row (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the implementation sub-agent. No orchestration tool was called, so `claude_personal` routing was not confirmed and no model switch is claimed. No emulator run, no writes under `original/` (read only), nothing committed or pushed, and the dirty worktree was not reset or cleaned.

Read first: [HANDOFF-2026-11-14-scenario-page-exit.md](HANDOFF-2026-11-14-scenario-page-exit.md) section 6 (its "also noted" bullet is the question answered here) and [formats/game-proper.md](formats/game-proper.md) "Opening click and the held press" (new, under "Scenario list and the held prompt").

## 1. Question and answer

**Can the click that opens the original list select a row when the same held button is released?** Yes, but only for a second press, not for the icon click.

- **The icon 2 click cannot select a row (VERIFIED static).** The icon's action runs on its release (`$7F96` -> `$59C8` -> `$7FE4`), for the icon recorded at the press. The pointer at the release is not read. A press on icon 2 released over a list row opens the list and picks nothing.
- **The list opens only after a second, fresh left press (VERIFIED static).** `$855A` prints `$13B` and then waits in `$2E48` for the left button to go down. `$2E48` is a raw poll: it reads no latch and never calls `$50B2`, so it consumes nothing.
- **A held second press can become the row press (VERIFIED static).** After the header read and the list draw, the loop's first `$50B2` sees a press edge if the button is still down (the icon release had cleared the latch, `$50C6`). If the pointer is on a row at that poll, `$7FCE` waits for the release and picks that row (`$8CFE`, `$87DC`). If the button is up by then, the click is spent and nothing is picked.
- **The icon band and the row band do not overlap.** Icons are x `$A0`-`$11F`, y `$18`-`$93`; list rows are x `$38`-`$88`, y `$20`-`$79`. A held press therefore cannot turn into an icon action on this path.

Not traced: how long the header read and list draw take in the original, so how long a press must be held to count. That is a timing question for an emulator.

## 2. Static evidence (Disk.1, raw bytes, file offset = address + `$28800`, checked with `tools/game_dis.py`)

| Address | Bytes / instruction | What it establishes |
|---|---|---|
| `$7F96`-`$7FA6` | `tst.w $5DD4`; `bmi $7EF6`; `jsr $59C8`; `bra $7FE4` | the icon action runs on the release, for the recorded icon |
| `$8632`-`$8636` | `move.w #$13B,d0`; `bsr $855A` | icon 2 prints `$13B` and calls the disk step |
| `$855A`-`$8566` | `bsr $8462`; `bsr $2E48`; `bsr $84F4`; `bsr $841E` | prompt, wait for a press, erase, header read |
| `$2E48`-`$2E50` | `btst.b #6,$bfe001`; `bne $2E48` | a raw wait for the left button DOWN; no latch, no `$50B2` |
| `$84F4`-`$852A` | `bclr #2`, `bclr #0` (VBL wait) | clears bits 2 and 0 of `$156A8`; not bit 3 |
| `$865A`-`$866A` | `move.w #$13D,d0`; `bsr $85CA`; `move.b #3,$938D`; `bra $7EF6` | the list opens in mode 3 |
| `$8132`-`$817C` | `tst.b $938D`; x `$38`-`$88`, y `$20`-`$79`; `$8CFE` = row | the hover row exists in every nonzero mode (1-4), not only mode 3 (corrected 2026-11-14 load slice: `beq` on mode 0 only) |
| `$50B2`-`$50DC` | `btst #6`; press: `bset #3`, `beq $50D0` (returns 0) | a still-held button with a clear latch is a press edge |
| `$50C6` | `bclr.b #3,$156A8` | the icon release cleared the latch |
| `$7F80`-`$7F94` | `btst #6`, `bne $7EF6`; `btst #3`, `bne $7FA8` | the right-latch skip, then the press path |
| `$7FA8`-`$7FCE` | `$5730` on `$8CB4` (no icon hit); `bsr $2E52`; `tst.w $8CFE` | a row press waits for the release, then picks the row under the press |
| `$8CB4` | icons 0-8 (x0, x1, y0, y1) | icons x `$A0`-`$11F`, y `$18`-`$93`: no overlap with the rows |

## 3. Remake state (before and after)

- `src/game/game.ts` `diskIcon` (icon 2) calls `openScenarioMenu` on the icon release. There is no `$13B` prompt and no second press: the remake skips the disk step (`HANDOFF-2026-11-14-scenario-list-state.md`).
- `src/game/menu.ts` `MenuScene`: `wasDown = true` ignores a held button at open, and `activateOnRelease` arms only on a press it sees.
- Because the page opens on the icon release, the button is up at open, so the held-press case of section 1 cannot occur. The remake does not reproduce it.

## 4. Change

- `test/boot-menu.mjs` section 11 (new; the file is untracked, as before): a fresh boot, icon 2 pressed, dragged onto row 4 and released there. Checks: the page opens, no scene held, no map, no disk menu; the next idle frames pick nothing; a fresh press alone on row 4 picks nothing; its release picks scenario 3 and the page stays open.
- `notes/formats/game-proper.md`: the "Opening click and the held press" bullet with the trace above.
- This handoff, and the pointers in `notes/README.md` and `HANDOFF-2026-11-14-scenario-page-exit.md`.
- No source change. The section 11 regression passes on the existing code: the icon release never reaches the page. It locks the behaviour; it is not a fix. I did not run a red check, because no small mutation of the page can make the icon release pick a row without a contrived change.

## 5. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/boot-menu.mjs` | exit 0, 62 ok, 0 FAIL (section 11 included) |
| `node test/scenario-pick.mjs` | exit 0, 52 ok, 0 FAIL |
| `node test/game-music.mjs` | exit 0, 86 ok, 0 FAIL |
| `node test/disk-menu-keys.mjs` | exit 0, 42 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 51 ok, 0 FAIL |
| `node test/save.mjs` | exit 0, 404 ok, 0 FAIL |
| `node test/disk-menu.mjs` | exit 0, 107 ok, 0 FAIL |
| `npm test` (full chain) | exit 0, 4833 `ok` lines, 0 `FAIL` lines; the construction-site capture comparison skipped (`UTOPIA_SITE_CAPTURE` not set) |

No emulator run and no capture.

## 6. Decision for the user (not made here)

**Status (2026-11-14, later): implemented.** The decision was taken and the wait is in the remake; see [HANDOFF-2026-11-14-scenario-wait.md](HANDOFF-2026-11-14-scenario-wait.md). The text below is the question as it stood when this note was written.

**Should the remake add the original's second-press wait after icon 2?** The trace establishes it: after the `$13B` prompt the original waits for a left press, and a press still held at the first list poll can pick a row on its release. Matching that means:

1. after the icon 2 release, print `$13B` and wait for a fresh left press instead of opening the page at once;
2. on that press, open the page with the press state carried over, so a held button on a row arms it;
3. update the 30 icon-2 uses across six test files (`boot-menu`, `disk-menu-keys`, `game-over`, `save`, `game-music`, `scenario-pick`, and the section 10 and 11 regressions), each of which currently expects the page to open on the release.

It changes the scenario flow for the user (one more click), and the earlier notes deliberately skipped the disk step. I did not make that change without your decision. If you want it, say so and I will implement it with the held-press regression as the centre.

## 7. Limitations

1. The timing between the second press and the first list poll is not traced, so the length of a held press that counts is unknown.
2. The remake's page is a text list, not the original's rows, so the held-press case has no visual parity either way.
3. Section 11 locks the icon-release case; it does not cover the held second press, which the remake does not reproduce.
