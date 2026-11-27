# Utopia handoff — 2026-11-13 (save/menu navigation review: held scene and slot errors)

Bounded review of the remake save/load menus (`MenuScene`, `Game` slot navigation, the `sloterror` retry flow, slot labels) against
the notes and the traced disk-menu behaviour. No emulator run, nothing written under `original/`, no commit or push.
Read first: [AGENTS.md](../AGENTS.md), [formats/remake-save.md](formats/remake-save.md) ("Disk menu behaviour on failure", "Slot
labels"), `src/game/menu.ts`, `src/game/game.ts` (`openSlotErrorMenu`, `closeMenu`, `saveRefusal`, `acceptScene`), `test/save.mjs` section 10.

## 1. Result

**One real mismatch, fixed with a regression.** On a slot error screen the BACK action is labelled `BACK TO GAME`, but when a scene
is held behind the disk menu it runs `closeMenu()`, which returns to the disk menu (`Game.closeMenu`, `heldScene` branch). The label
named a destination that BACK does not reach.

How it is reached: a successful load (or scenario pick) with a message holds its scene behind the disk menu (`acceptScene`). The
disk menu's LOAD icon (`DISK_BUTTON.load`) has no held guard, so a load from a slot can fail while a scene is held. Its error screen
then offered `BACK TO GAME`.

## 2. Change

- `src/game/game.ts`, `openSlotErrorMenu`: the last action reads `BACK TO DISK MENU` when `map === null`, `heldScene !== null` or
  the game is over. This is the same condition `closeMenu` uses to choose its destination.
- `test/save.mjs`, section 10 (Game wiring, runs with the local Disk.1/Disk.2): seven `held:` checks. A load holds its scene; SAVE
  stays off while held; a load error keeps the held scene and the map bytes; the label names the disk menu; BACK returns to the disk
  menu with the scene still held; EXIT then enters the held save. The label check failed before the fix (cascading failures in the
  later Disk.4 and game-over checks came from the stuck error screen) and passes after it.
- `notes/formats/remake-save.md`: the actions bullet documents the label rule and the reachable held case.

No save format, migration or session behaviour changed.

## 3. Checked and consistent (read and/or tested)

| Area | Evidence | Outcome |
|---|---|---|
| Action indexing on the error screen (`actionBase = 1 + lines`) | Code read; retry/choose/disk/back exercised in `test/save.mjs` section 10 | Consistent. `CODE:` and message rows and the right-click hint are `enabled: false` and are never returned by `MenuScene.update`. |
| Right click on the error screen | `MenuScene` returns -1; `case "sloterror"` maps it to DISK MENU | Matches the label `RIGHT CLICK: DISK MENU`; tested. |
| Retry success / failure, save and load | Tested (refused write, corrupt, empty, offer-pending) | Consistent; success closes via `acceptScene` / `closeMenu`. |
| Unavailable storage (`no-storage`, `STORAGE OFF`) | Tested: labels, load error, save error, recovery | Consistent with the notes. |
| Empty slot on LOAD | Tested (`EMPTY` error, `SLOT 8` title) | Consistent. |
| Long warning labels | `test/slot-label-width.mjs` (pinned widths, all reachable combinations under the 240-px panel) and long-message wrap/truncation test | Fit within the panel; not re-measured here. |
| Disk.4 session SAVE entry | Tested: disabled, click does nothing | Consistent. |
| Game-over BACK label (`BACK TO DISK MENU`) | Read: `closeMenu` gameOver branch opens the disk menu; asserted in `test/save.mjs` (see section 5) | Consistent; the label and the BACK transition are both tested. |

## 4. Remaining evidence gaps (not original behaviour)

- The remake's slot lists and error screens are remake presentation (`menu.ts` header). No original screen exists for them; there is
  no original-runtime evidence for their layout, labels or BACK targets.
- Whether the original's LOAD icon can be used while a load message is held, and what it shows, is not verified against a running
  original. The remake allows it; the note says so.
- ~~The game-over BACK label has no assertion~~ Closed in section 5.

## 5. Follow-up: game-over BACK assertion (test only)

- `test/save.mjs`, game wiring block after the game-over checks: sets `$156AA` bit 3 on the live map, opens the remake LOAD list,
  loads an empty slot (SLOT 4, its key deleted first), and checks: the LOAD entry is open, the error screen keeps the game-over
  session byte-identical, the label is `BACK TO DISK MENU` and not `BACK TO GAME`, and pressing it reaches the `disk` stage with the
  same live map still game over. Then the flag is cleared and the stage reset for the remaining checks.
- Mutation check (temporary, `dist/game/game.js` only, rebuilt afterwards): forcing the label to `BACK TO GAME` makes the new
  label and transition checks fail. Note that the same sed also changed the held-scene expression, so its failures are not
  attributable to the new test alone.
- Results: `npm run build` passes; `node test/save.mjs` passes with 347 ok and 0 FAIL (343 before, 4 new); full `npm test` exits 0
  with no FAIL lines. Optional external-capture comparisons (`UTOPIA_MENU_CAPTURE`, `UTOPIA_SIDE_CAPTURE`, `UTOPIA_SITE_CAPTURE`)
  print "skipped" because those captures are not set; they are not verified here.
- No `src/` change, no original/emulator writes, no commit or push.
- Remaining gap, unchanged: the game-over BACK path was tested with a *load* error. A save error is not reachable through the menus
  under game over: the SAVE entry is off, so no save slot list opens. `saveToSlot` itself does refuse with `game-over`, which would
  open this screen if it were ever called from a menu.
