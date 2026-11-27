# Utopia handoff: the single key cell `$161A0` (batches, releases, the build menu) (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator or original writes; `original/` was only read (`tools/game_dis.py` and byte scans). Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-fkey-poll.md](HANDOFF-2026-11-14-fkey-poll.md) (open points 1 and 2 are answered here), [formats/game-proper.md](formats/game-proper.md) "One key cell", [formats/building.md](formats/building.md) "Re-check 2026-11-12".

Questions:
1. Should F-key handling take the last key in a batch? **Yes** (static trace). The original's cell holds one byte, so the last byte written before the poll is the only one dispatched.
2. Does a key pressed during the build menu remain in the single cell after the menu closes? **Yes, unless a later byte overwrote it** (static trace). The menu neither reads nor clears the cell, and the close returns into the same loop iteration's `$15B4A`.

## 1. Static evidence (VERIFIED static; file addresses as the disassembler labels them)

| Point | Evidence |
|---|---|
| Writer | The keyboard IRQ `$2BC2` does `not.b`, `ror.b #1` and then `move.b d0,$161a0` at `$2BEC`. There is no test of the cell before the store. Only this instruction writes `$161A0` (a byte scan of Disk.1 finds the absolute-long forms: one write, the reads below). |
| Overwrite | Consequence of the unconditional store: a byte that arrives before the poll overwrites the byte that is there. Only the last byte between two polls survives. |
| Reader and clear | `$15B4A`: `move.b $161a0,d0`, exit on zero (`beq $15c58`, the cell is not cleared), then `clr.b $161a0` (`$15B54`) and dispatch of that byte. A nonzero byte is always cleared, so a release byte is read and cleared too. |
| Other readers | The count entry `$5110` (`$5160` reads, `$515A` clears), the disk-menu routine `$8314` (`$8334`), the save-name loop `$8918` (`$8958`). The key_reach walk (screens.md "Key reads") finds that `$B3D8` reaches none of these readers. |
| Release bytes | The IRQ stores every byte, so a release byte is stored and overwrites a pending key. The dispatcher rejects a byte with bit 7 set: `cmpi.b #$1` / `bmi` and `cmpi.b #$8` / `bgt` at `$15C3C`-`$15C46`, and the equality tests `$50`-`$55`, `$22`, `$19`, `$40` do not match it. This fits a release flag in bit 7 (HYPOTHESIS: the Amiga raw-key convention; the encoding is not read from the image, and the overwrite does not depend on it). |
| Menu close | `$15A74` is the release path that enters the build menu (`building.md` "Re-check 2026-11-12"; `$15A74` has one caller, `$158B0`). `$158B0`: `bsr.w $15a74`, then `bra.b $158c2` (`$158B4`), then `$158C2`: `bsr.w $15b4a` (keys), then `bra.b $157bc`. So when the menu returns, the same iteration reaches `$15B4A`. |
| Dispatch order | The press `$158CA` runs before `$15B4A` in the poll (game-proper.md "Loop top"). Keys are read after the press. |

## 2. Answer and the invariant

At `$15B4A`, the cell holds the byte of the most recent keyboard event (key or release) since the previous `$15B4A`. If that byte is a window key (`$50`-`$55`) the window opens (after `$133F8` gates it); if it is a key (`$01`-`$08`, `$22`, `$19`, `$40`) that key is dispatched; a release dispatches nothing. Whatever was before it is lost.

So:
- F1 then F2 between two polls: only F2 (the last).
- F1 then a release of F1 between two polls: nothing.
- F1 pressed in the build menu, still held when it closes: F1 is in the cell and is dispatched by the close iteration.
- F1 pressed in the build menu and released in it: nothing after the close.

## 3. Change

- `src/game/intro.ts`: `Input.keys` may now carry release entries. New exports `KEY_UP_PREFIX` (`"keyup:"`), `keyUpToken(key)` and `isKeyUpToken(entry)`. A release is not a press: consumers that look for names ignore it (checked: `boot-stages` digits and Backspace/Enter, `NumberEntry.feed`, `panel.ts` `includes("Escape")`; the other `onKeys` return from `entry.done`).
- `src/main.ts`: a `keyup` listener pushes `keyUpToken(e.key)` into the same ordered batch. Auto-repeat is still ignored (`e.repeat`).
- `src/game/map.ts`:
  - `keyCell: string | null` is the one cell. `foldKeys(input)` folds each update's batch in order (last entry wins). It runs at the top of `update()`, before the modal/pass branch.
  - The modal branch no longer drops keys (`input.keys?.splice(0)` removed); the cell keeps them.
  - `poll()` reads and clears the cell once. A non-window key is dispatched before the press, as before. A window key is dispatched after `controls.update` (as before), through `onWindowKey`. A release dispatches nothing.
  - Removed: the old "one window key per poll, the rest re-queued" logic.

No simulation, pin, message, timer or pass order changed.

## 4. Behaviour now

| Case | Before (fkey-poll handoff) | Now |
|---|---|---|
| F1 then F2 in one batch | F1 opened on the pass; F2 on the next pass | F2 only, once; F1 is overwritten, not replayed |
| F1 then "1" in one batch | F1 on the pass; "1" also | "1" only: pin 1 under the pointer; no window |
| F1 down and up before the pass | F1 on the pass | nothing (the release overwrote it) |
| Non-update: F1 arrives, pass later | Taken on the pass | Folded on arrival (no window, no line); dispatched by the pass |
| F1 held through the build menu | Dropped by the modal | Dispatched by the first pass after the menu closes |
| F1 pressed and released in the build menu | Dropped | Nothing after the close |
| F1 then F2 in the build menu | Both dropped | F2 only, after the close |

## 5. Tests

- `test/map-loop.mjs` section 7l (F-key block rewritten):
  - refusal: arrival folds the key (no window, no line, nothing taken); the pass dispatches it (timer 200, drawn that update, exactly 200 updates);
  - log entry over a line: timer matches the twin;
  - two window keys in one batch: F2 only, and F1 is not replayed by three passes;
  - F1 then "1": no window, pin 1 placed by the pass;
  - F1 down and up in one batch: nothing over two passes;
  - build menu, held: nothing while the menu is open; first pass after the close dispatches F1;
  - build menu, tapped: nothing after the close;
  - build menu, two keys: F2 only after the close, F1 not replayed.
- `test/screens.mjs` section 2g: `pressKey` now reports the arrival outcome (`pass`, `taken` = the update reacted, `queued` = no reaction) rather than whether the array emptied, because the array is emptied at arrival. The F1 refusal still arrives "queued" and is taken by the pass with timer 200.
- `test/button-sound.mjs`: unchanged, passes.

Mutants (compiled `dist/game/map.js` only; restored by copying the good build back, and `cmp` confirmed):

| Mutant | Result |
|---|---|
| M1: earliest key wins (`if (this.keyCell === null)`) | `test/map-loop.mjs` fails 6 checks (two-key batch, F1 then 1, F1 down/up, the two-key modal checks, tapped) |
| M2: the modal clears the cell (old drop behaviour) | fails 3 checks (held, two-key modal) |
| M3: releases do not overwrite the cell | fails 2 checks (F1 down then up; tapped modal) |

## 6. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/map-loop.mjs` | exit 0, 379 `ok`, 0 `FAIL` (was 372) |
| `node test/screens.mjs` | exit 0, 92 `ok`, 0 `FAIL` |
| `node test/button-sound.mjs` | exit 0, 42 `ok`, 0 `FAIL` |
| `npm test` (full chain) | see the result line below |

## 7. Open points (not changed)

1. **Release encoding (CONVENTION, updated 2026-11-14; see [HANDOFF-2026-11-14-release-encoding.md](HANDOFF-2026-11-14-release-encoding.md)).** The bit-7 release flag is the Amiga raw-key convention, not traced in the image. The overwrite itself is traced and does not depend on it. A byte-level capture would settle the value of a release byte.
2. **Keyboard auto-repeat.** The remake ignores `e.repeat`, so a held key is one entry. The original's keyboard firmware may repeat the down code while the key is held (HYPOTHESIS; not traced). A held key through a close would then be dispatched once per repeat that arrives before a poll. Timing not traced.
3. **One-update difference at menu close.** The original dispatches in the same iteration the menu returns. The remake's modal exit sets `resumeWithImmediatePass()` in the exit update, and the pass with its poll runs in the next update. A held key therefore dispatches one update later than in the original. The VBL-wait question in `game-proper.md` ("First pass on EXIT") is still open.
4. **Other windows and the cell (assessed 2026-11-14, see the release-encoding handoff, section 7).** The count and boot loops are tight spins, so an overwrite there is not reachable by human input (assessed, not timed). The disk menu leaves a digit in the cell (open). The count entry, the disk-menu and the save-name loops read the cell too, and a release overwrites a pending digit there in the original. The remake's `NumberEntry` ignores release entries, so it keeps every digit (no change this slice). The remake's other window screens clear `input.keys` on entry, so a key pressed while such a window is open is not held for the map. Not traced per window.
5. **Stage change inside a poll.** As in the fkey-poll handoff, if a poll changes the stage, `windowKey` may find `openScreen` returning early; the key is then dropped. Not traced in play.

## 8. Notes changed

- `notes/formats/game-proper.md`: new paragraph "One key cell" in the Keyboard section.
- `notes/formats/game-text.md`, section 4, F1-F6 paragraph: the latest cell model.
- `notes/formats/screens.md`, section 7 (F-key timing): the cell wording replaces the queue wording.
- `notes/formats/building.md`, "Re-check 2026-11-12": the menu's key-cell fact.
- `notes/HANDOFF-2026-11-14-fkey-poll.md`: open points 1 and 2 now point here.
- `notes/README.md`: newest handoff pointer.
