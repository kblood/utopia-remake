# Utopia handoff: poll-posted log entries (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No emulator or original writes; `original/` was only read (scratch scripts under the user's temp folder). Nothing committed or pushed. The dirty worktree was preserved.

Question: does any input-poll path add a log entry rather than a line, and does the original draw it in the press frame or at the next pass?

## 1. Answers (STATIC, Disk.1 and the remake)

- **Yes, one reachable path.** A select-mode press on a shipyard with no online command centre says `$B3` (index 179, in the remake's `LOG_INDICES`). The branch is `createBuildingScreen` (`src/game/screens/buildings.ts`), reached from `Controls.update` in the poll through `onSelect` -> `selectCell`. The original routes `$B3` through `$5A8C` (game-text.md section 5), not `$551A`.
- **Press frame in the original.** `$5A8C` step 3 draws the wrapped text into both bitmaps (`$54DE`) when it appends the entry, so the original shows it in the press frame with the log idle timer at 500 (VERIFIED code, STATIC).
- **Remake before this slice:** the entry was appended to `Messages` but `presentMessageLine` only repaints the message line, so it was drawn only by the next completed pass. Mismatch confirmed.
- **Launch `$12B`** (missile launcher malfunction) is raised by the missile window's fire button (`MissileScreen`, a window-stage action), not by the map poll. Out of scope here; the remake's `say` is not flagged there (`polling` is false).
- **Other poll texts** are lines: placement and demolition refusals, scaffold, mine, power, tank, the building-name texts, the F1-F6 report refusal (`$B2` = 178, not in the log set). The building-name indices (type table `+$10`, types 0..39 checked with a scratch script) include none in the log set, so no name is misrouted by index.
- **Reachability caveat:** the shipyard `$B3` branch needs the command-centre total to be zero while a shipyard stands. The remake reaches that after the centre is lost. Whether build rules can produce that state in play was not traced.

## 2. Change

- `src/game/messages.ts`: `Messages.post(index)` returns `"line" | "log" | "none"` (exported type `PostedAs`); `push` is now `post(index) === "line"`. Behaviour is unchanged.
- `src/game/map.ts`:
  - `say(index)` uses `post`. During `poll()` a line sets the existing `markMessageLineChanged()` flag; a log entry sets `pollLogChanged`.
  - `update()`, after the poll: if `pollLogChanged`, `presentMessageBand()` runs (band rows 160..199 repainted from the picture, then the line and every log entry); otherwise `presentMessageLine()` runs for a line as before. `presentMessageBand` already returns early while a modal is visible.
  - No timer, pass, RNG, date or loop state changes. The log idle timer is still set to 500 by the append itself.
- Comment on `presentMessageBand` updated to mention poll-posted log entries.

## 3. Tests

`test/map-loop.mjs`, new section 7k (9 checks): a shipyard with its command-centre total zeroed, a seeded earlier log entry (drawn by the alignment passes), then the press on a view cell that logs. Checks: the press frame differs from the frame before and from the twin across rows 160..199; nothing outside rows 160..199 and the panel box differs from the twin; the log has the seed plus one new entry; the earlier entry is unchanged and first (order); line timer 0 and log idle timer 500; select mode stays and no window opens; no pass advanced; the next pass keeps the same band.

A test-helper detail found while writing it: the existing `bandDiff` covers rows 160..170 only (the line), so 7k uses its own rows 160..199 comparison. This is a test-scope fact, not a product issue.

Mutant (compiled `dist/game/map.js` only, `say` does not set `pollLogChanged`): exit 1, exactly two FAIL checks (the press-frame check and the next-pass check). The restored build passes.

## 4. Verification

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 (run after each source change, and after the mutant restore) |
| `node test/map-loop.mjs` | exit 0, 353 `ok`, no `FAIL` |
| `node test/message-panel.mjs` | exit 0, 15 `ok`, no `FAIL` |
| `node test/checkpoint.mjs` | exit 0, no `FAIL` |
| `npm test` (full chain) | exit 0, 4,659 `ok` lines (was 4,650 before this slice), no `FAIL` |

## 5. Open points

1. Whether a shipyard can stand with a zero command-centre total in normal play (build-rule trace not done).
2. The launch `$12B` text from the missile window is not presented in the window's frame (window-stage, not traced against the original).
3. The press-order residual from the poll-refusal handoff (keys before the press in the remake, press before keys in the original) is unchanged.
4. No original capture: every claim above is static plus remake tests.

## 6. Notes changed

- `notes/formats/game-text.md`, section 4: new paragraph "Poll-posted log entries" before "Other full-screen exits".
- `notes/README.md`: newest handoff pointer.
- `src/game/map.ts`: `presentMessageBand` comment.
- This note.
