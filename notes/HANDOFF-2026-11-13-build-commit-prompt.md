# Utopia handoff: the build-menu commit's prompt line in the exit frame (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the research sub-agent for this slice. No orchestration tool or child agent was called in this slice, so `claudeAgent` routing was not confirmed (no `orchestrator_capabilities` call). No subscription usage was checked and no timer was scheduled. No emulator was run and nothing under `original/` was written. Nothing was committed or pushed.

Read first: [HANDOFF-2026-11-13-key-pin-line.md](HANDOFF-2026-11-13-key-pin-line.md) (same-frame message line, open point 3), [HANDOFF-2026-11-13-mode-icon-timing.md](HANDOFF-2026-11-13-mode-icon-timing.md) (the commit's icon), [HANDOFF-2026-11-13-key-cell-latch.md](HANDOFF-2026-11-13-key-cell-latch.md) (key cell, not changed here), [formats/game-text.md](formats/game-text.md) sections 4-5, [formats/map-rendering.md](formats/map-rendering.md) section 9, [formats/building.md](formats/building.md) (build-menu exit).

## 1. Static trace (VERIFIED from the Disk.1 bytes)

Build-menu exit with a pending item, `$6BA2` (listing read from `tools/game_img.py`):

| Step | Routine | Effect on the displayed bitmaps |
|---|---|---|
| `$6BB4` | `bsr $6ACE` | restores rows 7..51 of x 256..319 from the saved panel background (`$164AA`); row 52 is not restored |
| `$6BC2` | `bsr $309E` | pointer state only; no pixels |
| `$6BCC` | `bsr $6B10` | draws the building tile at x 272, bottom row 52 (the preview), into both plane lists |
| `$6BD0-$6BD2` | `moveq #0,d0` / `bsr $551A` | string 0, "Click on map to choose a site.": `$551A` falls into `$552C` |

`$552C` (`$5528`-`$5588`) draws the line in the same routine: it calls `$2F5E` and `$54DE` (the text draw) and then sets `$156AC` = 200. It erases the old band (`$558A`) first when the timer is non-zero. So the prompt is drawn **at the commit, not at the next pass**. The exit without a pending item (`$6BD8` -> `$15EF0`) posts nothing and is unchanged.

## 2. Remake before this slice

The exit's frame already showed the preview: the modal-exit branch of `MapScene.update` called `presentControlPanel()` (`restorePanelArea` plus `Controls.draw`) when the mode flag was set. But `Controls` posted string 0 with `say()` and set no message flag, so the modal-exit branch drew no message band. The prompt appeared on the next completed pass, one video update later. The original draws it in the exit frame. This is a mismatch in timing only: the text, position and colour are the same once drawn.

## 3. Change (presentation and one timer hold)

- `src/game/controls.ts`, the build-menu commit with a pending item: `messageLineChanged = true` beside `say(BUILD_SITE_PROMPT)`. The flag's comment lists this caller. New: `peekMessageLineChanged()`, a read that does not clear the flag.
- `src/game/map.ts`, the modal-exit branch of `update()`: after `presentControlPanel()` for the mode flag, `if (takeMessageLineChanged()) presentMessageLine()`. `presentMessageLine()` is the existing helper: rows 160..170 only, from the pristine picture, plus `messages.drawLine`. It does not call `messages.update()`, and it does not change the pass order, the RNG, or the simulation.
- New (2026-11-13, this slice): in the same modal branch, after `resumeWithImmediatePass()`, `if (!menuVisible && peekMessageLineChanged()) messages.holdLineTick()`. It is set only in the update where the menu closes and only when that update posted a line. `src/game/messages.ts`: `holdLineTick()` sets a one-shot flag that the next `update()` consumes, leaving the line timer alone once. The log's idle timer is not affected.
- Nothing else changed. The panel's restore, the modal pass order, and the other timers are untouched.

## 4. Timer lifetime: why the hold is the targeted correction

Evidence for 200, not 199, in the exit frame (STATIC; no original capture):

- `$552C` sets 200 at the draw (the trace in section 1). The VBL countdown is the only decrement (game-text.md section 4).
- Fresh entry and modal exit return to `$157BC` without a VBL wait (`map.ts` comment, `HANDOFF` key-pin-line). So the exit draw comes before the first decrement.
- Internal consistency: a line posted by the input poll (marker button, pins, key D, money refusals) already lives 200 drawn frames in the remake. The poll runs after `messages.update()` of its update, so its first tick is on the next update. The modal exit is the one path where the post and the draw are in the update that ticks first. The hold makes it the same as the poll paths.

Why the change is safe and targeted:

- Only one line can be posted in the modal branch: the commit's prompt. Marker, key, and refusal lines come from the poll (non-modal), so the hold cannot reach them; section 7d of `test/map-loop.mjs` checks their 200-frame lifetimes directly.
- The hold is consumed in the same `update()` call, so it is one-shot by construction. It does not change pass order, the simulation, the RNG, or the log.
- The residual that remains (pass-time messages, see section 5) is a different path and is not touched.

## 5. Residuals (not changed)

1. **Pass-time messages (code order, not measured).** `MapScene.update` splices `sim.messages` into `Messages` before `messages.update()` in the same update, then `drawPass` draws them in that update. A pass-posted line is therefore ticked once before its first draw (probably 199 frames at the draw). This is the same kind of off-by-one as the commit had, but it is not an immediate line, so it was left alone. It would need its own trace and a decision on the pass path.
2. **`$6ACE` restores more than the remake.** The original restores rows 7..51 of x 256..319; the remake's `restorePanelArea()` covers rows 22..159 of x 272..319. Rows 7..21 and x 256..271 are not repainted, and row 52 is kept by `keepPanelBottomRow()`. No build-menu pixels reach those rows, so no mismatch was seen, but this is a static boundary, not a verified equality.
3. **The commit's `$309E` and tile id.** Only the presentation was traced here. The pointer and the item's tile are the existing model.
4. **No original capture.** Nothing here is pixel-compared or frame-counted against the running original. The next capture would need an explicit go-ahead.

## 6. Test (discriminating)

`test/map-loop.mjs`:
- section 6, the "build menu exit with a pending item" block: the band checks (the prompt is in the exit frame, and the exit band equals the next pass's band); the exit-frame timer is exactly 200 (was `> 0`); a fresh scene repeats the exit and checks 200 at the exit and 200 updates until the line clears.
- section 7d (new): the lifetime of the poll-posted lines (marker release in select and in build mode, key D, pin key 1, marker pin click, money refusal while placing, clearing refusal). Each is 200 at the posting update and clears on the 200th update after it. This guards against the hold leaking into the poll paths.

`test/message-panel.mjs` (new `holdLineTick` checks): a held line is not ticked by the next update, the hold is one-shot, a hold does not stop the log idle countdown, and an unheld line ticks on the first update.

Mutation: with the `holdLineTick()` call removed from the compiled `dist/game/map.js`, the three exit-timer checks fail (timer 199, clears after 199 updates). The rebuilt output passes again.

## 7. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (before and after the change) |
| `node test/map-loop.mjs` | before the change: 246 ok, 0 FAIL; after: 257 ok, 0 FAIL |
| `node test/message-panel.mjs` | before: passes; after: passes, with the four new hold checks |
| `npm test` (full chain) | exit 0, no `FAIL` line (scratch log `/tmp/npm-test.txt`, not committed) |
| mutant: hold call removed from `dist/game/map.js` | `map-loop` exit 1, 3 FAIL (the exit-timer checks); restored and rebuilt |

Earlier in this slice (before the hold), the exit-frame timer was 199 and the test only asserted `> 0`; that is why the residual was recorded there.

## 8. Notes changed

- `notes/formats/game-text.md` section 4: the build-menu commit's timer is now 200 with the hold; the pass-time residual is recorded there.
- `notes/formats/building.md`: the commit's timer line now says 200 with the hold.
- `notes/formats/map-rendering.md` section 9: the exit with a pending item names the string-0 prompt (unchanged in this slice).
- This file.
