# Utopia handoff: a key typed in the disk menu and the first main-loop poll (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator or original writes: `original/` was only read (`tools/game_dis.py`, `tools/key_reach.py`, a byte scan of Disk.1). A throwaway probe lived in `$TEMP` and is not part of the repository. Nothing committed or pushed. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-release-encoding.md](HANDOFF-2026-11-14-release-encoding.md) (open point 3 is answered here), [HANDOFF-2026-11-14-key-cell-batch.md](HANDOFF-2026-11-14-key-cell-batch.md), [formats/game-proper.md](formats/game-proper.md) "One key cell" and "Disk menu and its exit".

## 1. Questions and answers

| Question | Answer | Evidence |
|---|---|---|
| Does a digit typed in the disk menu and followed by the mouse exit stay in `$161A0`? | Yes. The menu loop `$7EF6` reads no cell. The format prompt `$8314` reads `$161A0` at `$8334` and clears nothing. Its mouse exit (`$8340`) calls `$2E52` and `$82B8`, which touch no cell. The unrefused exit `$802C` touches none. | VERIFIED static |
| Is it consumed by the first main-loop `$15B4A`? | Yes, in the same iteration as the exit. `$802C` `rts` returns to `$15AEC` (`bsr $15EF0`, `rts`) and then to `$158B0`, which runs `bsr $15A74` and `bra $158C2`, then `bsr $15B4A`. | VERIFIED static |
| What does the digit do there? | `$01`-`$08` reach the pin path (`$15C3C`-`$15C56`). `$19` (P) and `$40` (space) toggle pause at `$15C02` (`bset #2,$156A9`). A release overwrites the key (nothing dispatched). | VERIFIED static |
| Does the remake match? | The value matches: the menu does not drain the key batch, and a later release or key overwrites it, last wins. The timing did not match. The exit's immediate pass polled with a synthetic `keys: []`, so the menu-typed key was dispatched at the next completed pass, not in the exit iteration. Probed: P paused 3 updates after the exit. | VERIFIED probe (before the fix) |

## 2. Trace

| Routine | Role | Key-cell touch | Method |
|---|---|---|---|
| `$7E52` (entry) | `$15AE6` `jsr`, falls into `$7EF6` | none on the entry path | `key_reach` `7d52`, `93a6`, `82b8`: no touch |
| `$7EF6` | menu loop | none in the body | disassembly: `$8132`, `$50B2`, `$59C8`, icon dispatch `$7FE4` |
| `$8314` (format prompt) | `$7FEE` icon 3 | reads `$8334`, no clear | disassembly; byte scan: `$8336` is a read |
| `$8340`-`$8352` | mouse exit of the prompt | none | `bsr $2e52` (waits for release), `bsr $82b8`, `bra $7ef6` |
| `$82B8`, `$84F4`, `$51E6`, `$2F5E` | redraw helpers | none | `key_reach` closures: no touch |
| `$802C` (unrefused) | exit body from `$804E` | none | `key_reach 804e`: 6 routines, none touch |
| `$15AE6`-`$15AF0` | icon 8 path (`jsr $7e52`, `bsr $15ef0`, `rts`) | none | `key_reach 15aec`, `15ef0`: no touch |
| `$158B0`-`$158C6` | release path: `bsr $15a74`, `bra $158c2`, `bsr $15b4a`, `bra $157bc` | the read is `$15B4A` | disassembly |
| `$15B4A` | keyboard poll: read at `$15B4A`, exit on zero, clear at `$15B54` | read and clear | byte scan: `$3E34C`/`$3E356` |

Byte scan of Disk.1 for the absolute long `$161A0` (seven operands): writers `$2BEE` (IRQ store) and `$515A` (`clr.b` in the count entry); readers `$5160`, `$8334`, `$8958`, `$15B4C`; clear `$15B54`. The `$802C` closure hit from `key_reach` is an over-approximation: `$802C`'s `bne $7EF6` puts the whole menu loop into the walk, which reaches `$87DC` and `$5110` through the icon handlers. The exit body itself (`$804E`) is clean.

Pause detail: `$15C02` is `bset.b #2,$156A9` with `beq $15C1A`. Entering the pause clicks through `$5756`; leaving it runs `$159FC` and `$57FA`. The dispatch is inside `$15B4A`, so the pause changes in the same iteration as the poll.

The Return `$44` left by the format prompt is not dispatched: `$15B4A` has no arm for `$44` and falls to `$15C58` `rts`.

## 3. Remake before and after

Before (probe, `$TEMP/keycell-probe/probe.mjs`, persistent `input.keys` as in `main.ts`): `g.openMapDiskMenu()`, `["p"]` typed in the menu, three idle updates, EXIT click. After the exit update: stage `map`, `paused false`, `keyCell null`. Three updates later `paused true`.

Cause: in `Game.update`, the post-switch block runs `updateMap(map, {..., keys: []})` when the disk menu exits to the map with an immediate pass pending. The menu never drains `input.keys` (`DiskMenuScene` and `Game.handleDiskMenu` do not touch keys), so the menu-typed key stays in the array, but the exit's immediate pass folds nothing and polls the old cell. The array is folded at the next map update, and `poll()` runs at the next completed pass.

## 4. Change

- `src/game/game.ts` (post-switch `updateMap`): `keys: input.keys` instead of `keys: []`, with a comment that cites the static chain. The batch the original's cell holds at the close is folded before the immediate pass polls. The same block covers held-scene entry (`enterHeldScene`) and the boot exit, whose original first `$15B4A` also follows the immediate pass body (`$157BC`), so those paths receive the batch too.
- `test/disk-menu-keys.mjs` (new; added to the `npm test` chain after `game-over.mjs`):
  1. P typed in the menu pauses in the exit update; later passes do not replay it (13 checks in the file, the three cases below).
  2. P then its release: nothing is dispatched by the exit or by later passes.
  3. P then X (last wins): nothing pauses.
- Mutant (compiled `dist/game/game.js`, line 1003 back to `keys: []`): `test/disk-menu-keys.mjs` fails `P typed in the menu pauses at the exit update` (`paused false`). The good build was restored and passes.

No pin, message, timer, RNG or pass order changed. The pin position is not asserted: at the exit the pointer is over the disk-menu icon, off the map, so a pin would not show there.

## 5. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/disk-menu-keys.mjs` | exit 0, 13 `ok`, 0 `FAIL` (mutant: exit 1) |
| `node test/disk-menu.mjs` | exit 0, 107 `ok` |
| `node test/game-over.mjs` | exit 0, 50 `ok` |
| `node test/map-loop.mjs` | exit 0, 381 `ok` |
| `node test/screens.mjs` | exit 0, 95 `ok` |
| `node test/boot-stages.mjs` | exit 0, 45 `ok` |
| `node test/boot-menu.mjs` | exit 0, 51 `ok` |
| `node test/button-sound.mjs` | exit 0, 42 `ok` |
| `node test/intro.mjs` | exit 0, 36 `ok` |
| `node test/window-input.mjs` | exit 0, 173 `ok` |
| `node test/order-input.mjs` | exit 0, 52 `ok` |
| `node test/tutorial-route.mjs` | exit 0, 24 `ok` |
| `node test/save.mjs` | exit 0, 383 `ok` |
| `node test/game-music.mjs` | exit 0, 84 `ok` |
| `npm test` (full chain) | exit 0, 4,708 `ok`, 0 `FAIL` |

## 6. Notes changed

- `notes/formats/game-proper.md`: "One key cell" (readers sentence) and "Keyboard encodings", the disk-menu bullet, now "Disk menu and its exit".
- `notes/HANDOFF-2026-11-14-release-encoding.md`: open point 3 answered (see below).
- `notes/HANDOFF-2026-11-14-disk-menu-key.md`: this note.
- `notes/README.md`: newest handoff pointer.

## 7. Open points (not changed)

1. **Other icons after a menu-typed key (ANSWERED 2026-11-14, see [HANDOFF-2026-11-14-held-key-routes.md](HANDOFF-2026-11-14-held-key-routes.md)).** Load and scenario picks read and clear nothing, so a menu-typed byte reaches the exit poll. The save name loop `$8958` reads without clearing; only its Return path (`$5110`) clears, and the Return byte overwrites what was there. The remake's held routes keep the byte (tests in `test/disk-menu-keys.mjs` section 4).
2. **Pin placement at a menu exit.** The pin path uses `$14636/37` (the `$5CDA` cell), not the pointer sample of this update. The regression test uses pause, which needs no cell. A digit's pin at a menu exit is not checked.
3. **Held-scene exit.** The post-switch block covers it, but `test/disk-menu-keys.mjs` tests only the in-game exit. `test/boot-menu.mjs` and `test/game-over.mjs` run the held paths and pass.
4. **Register-relative access.** The byte scan and `key_reach` cover absolute-long operands only. A base-register access to `$161A0` (for example `$A0` off a `$16100` base) is not excluded.
5. **Release bit value.** Still a convention (release-encoding handoff, open point 1). Nothing here depends on it.
6. **Auto-repeat** (key-cell-batch, open point 2) unchanged.
