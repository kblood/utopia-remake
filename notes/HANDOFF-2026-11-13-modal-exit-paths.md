# Utopia handoff: stale frames after leaving a full-screen modal (2026-11-13)

Model and routing: Claude Haiku 5.5, run inline as the review sub-agent. No orchestration tool or delegate was started, so `claudeAgent` routing was not confirmed, and no subscription usage was checked or timer scheduled. No emulator was run and nothing under `original/` was written (the Disk.1/Disk.2 files were only read by the tests). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: follow-up to `HANDOFF-2026-11-13-expiry-reach.md`, section 6.4 ("other modal screens were not swept"). Question: after a message line expires, which transitions out of a full-screen modal can show stale line pixels, and which redraw the whole scene?

## 1. Mechanism that decides the answer

- `Game.update` calls `MapScene.update()` (and so `messages.update()`, the line timer and the expiry) only in stage `"map"`. In every other stage the line timer does not tick and no expiry can happen. The line resumes its remaining frames when the map is back. (This frozen-timer rule is the remake's own choice; the original's timing during a full-screen window is not observed. See section 4.)
- Each stage draws somewhere else: the build menu draws into `screen.pixels` from the persistent buffer (`drawModal`); windows and the offer draw over `map.screen`; the disk and menu pages and the announcement have their own `Screen`.
- A stale line can therefore appear only when the map frame is restored from something that still holds the glyph rows, or when a dialog's own draw leaves the map frame in a state no pass repairs before the next pass.

## 2. Path table

| # | Transition (stage) | Where the frame lives while open | Expiry possible while open | Frame on return, before the next pass | Stale-line result | Status |
|---|---|---|---|---|---|---|
| 1 | Build menu (`controls.menuVisible`, `drawModal`) | Modal frame into `screen.pixels`, from the persistent buffer | Yes (messages ticks each modal update) | Exit branch copies the buffer; `presentLineErase` runs in the same update | None after the fix | Fixed 2026-11-13 (`expiry-reach` section 3, `test/map-loop.mjs` 7i) |
| 2 | F1-F6 window, building, tank/ship, overview (stage `"screen"`, `showWindow`) | `frozen` = `map.screen` copy taken at open | No (no map update while open) | `close` restores `frozen` | None found | Clean. Argued from code. See section 3 for the poll-time ordering |
| 3 | Disk menu from a map icon (`openMapDiskMenu`, stage `"disk"`) | `DiskMenuScene.screen`; `map.screen` untouched | No | `closeMenu` shows the pre-disk map frame; an expiry in the opening update ran before the poll | None found | Clean. Argued from code |
| 4 | Disk sub-pages: remake, load, save, scenario, Disk.4 slots/error, slot error (`openMenu`, `openSlotErrorMenu`) | `MenuScene.screen`; `map.screen` untouched | No | Map frame unchanged; `closeMenu`/`closeSlotError` return to it | None found | Clean. Argued from code |
| 5 | Earth offer (stage `"offer"`, `OfferScene.draw(map.screen)`) | Dialog drawn into `map.screen` | No | Before the fix: the dialog's black panel (x 44..275, rows 24..163) stayed on the frame until the next completed pass, which erased the glyph rows of a showing line | **Stale frame found and fixed** | Fixed in this slice (section 5) |
| 6 | Announcement (stage `"announce"`, `AnnounceScene`) | Own copy of the backdrop (`base`), own `screen` | No | `map.screen` never changed | None found | Clean. Argued from code (`test/announce.mjs` passes, not line-specific) |
| 7 | Scene replacement: scenario, load, Disk.4 entry (`enterScene`, `enterHeldScene`) | New `MapScene`; `enterScene` clears `frozen`, `offer`, `window`, `announce` | No | New scene starts with no line; `presentRestoredState` draws the restored frame | None found | Clean |
| 8 | Game over to the disk menu (`returnToMap`, `closeMenu`) | As row 3 | No | As row 3 | None found | Clean |

## 3. Ordering inside one poll (argued, not probed)

`showWindow` (rows 2) takes `frozen` inside `map.update` when a select-mode click (`controls.onSelect` -> `onSelect`) or a right-click pick (`onPick`) opens a window. Later in the same update, `presentControlPanel`, `presentMessageLine` and `presentBuildPreviewCleared` may write the mode icon, the message band or the preview into `screen.pixels`, after `frozen` was taken. Closing the window would then restore a frame without that presentation until the next pass.

This needs a single poll that both opens a window and changes the mode icon or posts a line. From `controls.update`, a poll handles one button press or one cell click and returns after a button, so the two cannot come from one input. A right-click pick does not change the mode. Not probed; the path is judged unreachable from the code. A synthetic probe would settle it if the controls change.

## 4. Open points (need original evidence)

1. **The offer's exit frame in the original.** Neither `notes/formats/*.md` nor the static traces describe what `$DECC` leaves on the screen after an answer. The fix follows the remake's own window convention (the frozen frame is restored), not an observed original frame.
2. **Line timer during a full-screen window.** The remake freezes the timer while stage is not `"map"`. If the original keeps counting during a window, a line could expire while the window is open, and the remake would show it again after the window. That is a timing difference, not a stale frame. Not observed.
3. **Build menu exit and the line.** Still open as in `expiry-reach` section 6.2 (Copperline capture of the exit after an expiry).

## 5. Fix and test

Change (`src/game/game.ts`, `Game.update` case `"offer"`, and `Game.updateMap`):

- When `updateMap` opens the offer, `frozen` takes a copy of `map.screen.pixels`, as `showWindow` does.
- Each offer update restores `frozen` before `OfferScene.draw`, so the dialog never builds on its own last draw.
- When the answer arrives, `frozen` is restored before `resolveOffer`'s return to the map, then cleared.

Nothing else changed: no timer, pass, RNG or simulation state; `map.ts` is untouched in this slice.

Regression: `test/offer-exit-frame.mjs` (new, 12 checks, real `Game.update` clicks through the tutorial route):

- The line is drawn before the offer, and the offer opens right after a completed pass.
- The offer is drawn over the frame (the check can fail).
- The answer returns to stage `map` with the line still showing.
- The first map frame after the answer runs no pass and equals the pre-offer frame across the whole frame.
- The line glyph rows are drawn in that frame.
- The next pass keeps the line in the band.

Before the fix, the first-frame checks failed: the panel area had 32,470 of 32,480 pixels changed (the dialog's black fill and frame), and the line glyph rows were gone. The residue stayed until the next pass: two displayed updates in this probe (the answer came at loop phase 1). In general a pass runs every four updates, so the residue can last up to three updates. After the fix: 0 pixels differ, and the line rows match.

`package.json` `npm test` chain: `node test/offer-exit-frame.mjs` added after `node test/map-loop.mjs`.

## 6. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/offer-exit-frame.mjs` (before the fix) | exit 1: 2 first-frame checks failed (panel residue, line glyph rows lost) |
| `node test/offer-exit-frame.mjs` (after the fix) | exit 0, 12 `ok` |
| `node test/map-loop.mjs` | exit 0, 309 `ok`, no `FAIL` |
| `node test/message-panel.mjs` | exit 0, 15 `ok`, no `FAIL` |
| `node test/announce.mjs`, `test/game-over.mjs`, `test/tutorial-money.mjs` | exit 0 (40, 50, 21 `ok`), no `FAIL` |
| `npm test` (full chain) | exit 0, 4,560 `ok` (was 4,548), no `FAIL` |

No scratch probes were kept in the repository; the offer probe is the new regression test itself.

## 7. Notes changed

- `notes/HANDOFF-2026-11-13-modal-exit-paths.md`: this note (path table, open points).
- `notes/formats/game-text.md` section 4: a short pointer to this note under the expiry paragraph.
- `notes/README.md`: newest-handoff pointer.
- `src/game/game.ts`, `test/offer-exit-frame.mjs`, `package.json`: the fix, the test and the chain entry.

Repository state: nothing committed or pushed. The dirty worktree was preserved. `original/` was only read.
