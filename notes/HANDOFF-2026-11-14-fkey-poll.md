# Utopia handoff: F1-F6 window keys taken at the loop poll (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No emulator or original writes; `original/` was only read. Nothing committed or pushed. The dirty worktree was preserved.

Question (from the refusal-timing handoff, open point 3): the original takes F1-F6 in `$15B4A`, the key dispatcher that runs after the press poll `$50B2` of a completed pass. The remake took them on browser arrival in `game.ts`, so a window could open and a refusal could start up to 3 updates before the original's poll. Can the key be queued and taken at the loop poll without breaking paused, modal, repeat handling or the screen tests?

## 1. Static evidence

| Point | Evidence |
|---|---|
| Dispatch point | `$158B4` runs `$15B4A` after `$50B2`, once per loop iteration (game-proper.md, "Loop top", and `HANDOFF-2026-11-13-key-cell-latch.md`). |
| Key cell | The IRQ writes the raw key code to the single byte `$161A0` (game-proper.md, "Keyboard"). `$15B4A` reads it and clears it (`$15B54`). Two keys between polls leave only the last code (single cell). |
| Pause | Passes run while paused: `MainLoop.vbl` ignores `sim.paused`. The F-key window does not depend on pause for its timing. |
| Modal | The build menu `$B3D8` polls only the mouse (`$50B2`). It is not reached from `$15B4A` (building.md, "Re-check 2026-11-12"). The F-key reports do not read `$161A0` (screens.md, "Window entries"). |
| Repeat | Auto-repeat keydowns: `main.ts` ignores `e.repeat`, so one physical press is one array entry. Unchanged. |

## 2. Change

- `src/game/map.ts`
  - `MapScene.poll` takes one window key (F1-F6) from `input.keys` per completed pass, the earliest. Other window keys in the same batch are re-queued at the front of `input.keys`. Non-window keys are processed as before, first.
  - After the press handling (after `controls.update`, the scroll arrows), the poll calls `onWindowKey(key)`. This is after the press `$158CA` and before the `$15B4A` order of the original, which also runs the key last.
  - `onWindowKey` is a new `MapSceneOptions` callback.
  - Removed: `sayFromKey`, `keySay`, `keyLinePending` and the non-pass `keyLine` presentation in `update()`. A refusal is now posted from inside the poll (`polling` routing), so the completed pass draws it through the existing `markMessageLineChanged` path.
  - Unchanged: the modal branch still clears `input.keys` (F-keys during the build menu are dropped).
- `src/game/game.ts`
  - The `"map"` case no longer reads F-keys. It calls `updateMap` only.
  - `windowKey(name)` (new) runs from the poll: `reportRefusal` (`$133F8`); a refusal calls `map.say($B2)`, which is drawn in the pass; otherwise `openScreen` and `windowFromKey = true` when the stage is `"screen"`.
  - `observeButtons` is no longer called from `game.ts`; the poll already calls it with its own input.

## 3. Behaviour now

| Case | Before | Now |
|---|---|---|
| F-key on an update that is not a pass | Taken at once: window or refusal in that update | Queued in `input.keys`, nothing posted, no window |
| F-key on the completed pass | Already taken | Taken in the poll; window opens or refusal (200 frames, drawn in that update) |
| Two window keys in one batch | Both taken on successive updates (the first opened a window, the second stayed queued) | One per completed pass, earliest first; the second waits for the next pass |
| F-key while paused | Opened at once | Opened at the next pass; the pass runs while paused, so the delay is the same as any poll action |
| F-key while the build menu is open | Opened a window over the menu (bug: the original does not dispatch keys in the menu) | Dropped by the modal update, not replayed |
| Auto-repeat | Ignored at keydown (`main.ts`) | Unchanged |

## 4. Tests

- `test/map-loop.mjs` section 7l, the F-key checks rewritten to queue through the poll (`onWindowKey` stubbed the way `game.ts` `windowKey` posts the refusal):
  - a non-pass update leaves the key queued and posts nothing;
  - the completed pass takes it: keys empty, timer 200, drawn in that update, drawn for exactly 200 updates;
  - an F-key whose poll posts a log string does not restart an active line (timer matches the twin);
  - two window keys in one batch: the first pass takes F1, the next takes F2;
  - an F-key while the build menu is open is dropped (none taken, array cleared, and not taken later).
- `test/screens.mjs` section 2g: the F1 refusal is taken by the pass (`pressKey` helper), and the arrival update is checked not to take it. Timer 200 in the pass update, 199 on the next update. The F1 window opens at the pass once the command centre is back.
- `test/button-sound.mjs`: the F-key windows use `pressF`, which runs until a pass completes and then one more update (the window's `Pointer` treats a button held on its first update as "held when opened", so the press must follow an idle update). Paused open, paused close (exit click plus the pause re-press), running close and the icon-button window all pass unchanged.

## 5. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (after each source change) |
| `node test/map-loop.mjs` | exit 0, 372 `ok`, no `FAIL` |
| `node test/screens.mjs` | exit 0, 92 `ok`, no `FAIL` |
| `node test/button-sound.mjs` | exit 0, 42 `ok`, no `FAIL` |
| `node test/message-panel.mjs`, `window-input.mjs`, `checkpoint.mjs`, `announce-line-frame.mjs`, `announce-chain-frame.mjs`, `offer-exit-frame.mjs`, `map-background.mjs`, `game-over.mjs` | exit 0, no `FAIL` |
| `npm test` (full chain) | exit 0, 4681 `ok`, no `FAIL` |

Not run: mutants for this slice. The refusal-timing mutants in `HANDOFF-2026-11-14-refusal-timing.md` refer to the earlier `sayFromKey` version, which no longer exists.

## 6. Open points

1. **Single key cell. Answered (2026-11-14, `HANDOFF-2026-11-14-key-cell-batch.md`).** The original keeps only the last key code (`$161A0`) between polls, so F1 followed by F2 in one pass dispatches F2 only. The remake now folds the batch into one cell and dispatches its last entry; F1 is overwritten, not queued. The earliest-first queue described above is no longer in the code.
2. **Key kept across the modal. Answered (2026-11-14, key-cell batch handoff).** The original does not read or clear the cell in the build menu, so a key pressed in it stays and is dispatched by the first pass after the menu closes, unless a later byte (a release included) overwrote it. The remake now keeps it in the cell (it no longer drops it) and the poll dispatches it. Earlier text: the remake dropped it, the same as the other keys the modal update cleared.
3. **Key order inside the poll.** The original runs the press `$158CA` before `$15B4A`. The remake now runs the window key last, after `controls.update`, so this is closer. Ordinary (non-window) keys still run before the press, as before (poll-refusal handoff, item 4). Not changed.
4. **Window freeze frame.** The window's frozen frame is copied in the poll after the pass draw and before the poll's line presentation. The original's `$B99C` freeze point is not traced; the remake matches the icon-window path (`openScreen` in the same poll).
5. **Stage changes during the poll.** If the poll changes the stage (for example a disk-menu exit), `windowKey` is not reached for that key unless `openScreen` still sees `"map"`; `openScreen` returns early otherwise. The key is then discarded. Not traced in play.

## 7. Notes changed

- `notes/formats/game-text.md`, section 4: F1-F6 refusal bullet and its test list.
- `notes/formats/screens.md`, section 7: F-key timing paragraph.
- `notes/HANDOFF-2026-11-14-refusal-timing.md`: open point 3 is resolved by this handoff.
- `notes/README.md`: newest handoff pointer.
- This note.
