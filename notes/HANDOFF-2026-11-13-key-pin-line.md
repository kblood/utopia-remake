# Utopia handoff: key D and marker-pin messages drawn in the input frame (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the implementation sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed. No subscription usage was checked and no timer was scheduled. No child agent was started. No emulator was run. Nothing under `original/` was written (read-only disassembly with `tools/game_dis.py` on `original/utopia-whdload/Disk.1`). Nothing was committed or pushed. The dirty worktree was preserved.

Read first: [AGENTS.md](../AGENTS.md), [HANDOFF-2026-11-13-message-line-timing.md](HANDOFF-2026-11-13-message-line-timing.md) (the marker and money-refusal slice this extends), [formats/game-text.md](formats/game-text.md) section 4, [formats/map-rendering.md](formats/map-rendering.md) section 9.

Scope: the open item "other line messages" in the message-line handoff, section 5 gap 1. Only the poll-time messages of key D, keys 1-8 and the marker pin click were traced and changed. Excluded by the brief: panel residue, save labels, game over, restart and eclipse parity.

## 1. Discrepancy and static trace (VERIFIED from the Disk.1 bytes)

| Path | Original, from the poll | Message | Remake before this slice | Remake after |
|---|---|---|---|---|
| Key D (`$15B4A` -> `$31CC`) | `clr.b $144B0`, clears the eight pins, `move.w #$F2,d0`, `bsr.w $551a` | `$F2` | line on the next completed pass | same frame |
| Keys 1-8 (`$3202`, found pin or free pin) -> `$318C` | pin message `$71`/`$72` written into the string at its placeholder, `bsr.w $552c` | `$71`/`$72` | line on the next completed pass | same frame |
| Marker pin click (`$158CA` -> `$311E` -> `$318C` or `$3154`) | `$71`/`$72`, or `$70` with all eight in use (`bsr.w $551a`) | `$70`-`$72` | line on the next completed pass | same frame |

`$551A` is the string lookup (`$188C2` table) and then falls into `$552C`, which erases the old band (`$558A`) when the timer is nonzero, draws the new line, and sets `$156AC` = 200. So the three rows draw the same line that the marker and money-refusal paths already draw.

## 2. Change

- `src/game/controls.ts`: new public `markMessageLineChanged()`, which sets the existing one-shot `messageLineChanged` flag. The comment on the flag lists the new callers.
- `src/game/map.ts`:
  - `key()`: key D sets the flag after `$F2` is pushed; keys 1-8 set it only when a cell is picked and a pin is toggled (the `$3202` path with a cell), so an off-map press posts nothing.
  - `cellHook` (the marker-click path): sets the flag after its message is pushed, for `$71`, `$72` and `$70`.
- The presentation is the existing `presentMessageLine()`: rows 160..170 only, from the pristine picture, no `messages.update()`, no pass, no RNG, no timer change. It is called after the poll in the completed-pass branch, as before.

No simulation, pin state, message text, timer or pass order changed. The only behaviour change is when the line appears.

## 3. Tests

`test/map-loop.mjs`, new section 7b (inside the Disk.1/Disk.2 block), plus the marker pin click case:

- Key D and pin key 1 on a map cell: the line is in the input frame; only the band differs from the twin; the timer is 200 at once and 0 on the twin; no pass advances; the next pass shows the same band.
- Marker pin click (after the marker button arms it): the press frame carries the line; only the band differs; timer 200; the next pass shows the same band.
- Pin key 1 with the pointer off the map: no line in the input frame.
- Check that `pickCell(127, 31)` is a map cell, so the key cases cannot pass vacuously.

Mutation check (compiled `dist/game/map.js` only, `markMessageLineChanged` calls removed, rebuilt and restored afterwards): `test/map-loop.mjs` fails 6 checks, all in the new section and the marker pin click. The restored build passes with 0 `FAIL`.

## 4. Verification run on 2026-11-13

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 0 `FAIL` (new section 7b and marker pin click: all `ok`) |
| `npm test` (full chain) | exit 0, 4,471 `ok`, 0 `FAIL`; optional site-capture comparison skipped as designed (`UTOPIA_SITE_CAPTURE` unset) |

Scratch logs were written under `/tmp` and are not part of the repository.

## 5. Open points (not changed)

1. **Key 1-8 cell equivalence: answered statically (2026-11-13, later slice).** `$14636/37` is written only by `$5CDA`, latched by the VBL hover `$2FBA` (gated by `$156A8` bits 2 and 4) and by a same-poll press. It is not necessarily the poll-time pointer the remake uses. See `HANDOFF-2026-11-13-key-cell-latch.md` for the invariant, the stale paths, and the regression in `test/map-loop.mjs` section 7c. Not changed in code.
2. **`$318C` bit-4 gate (not modelled).** `$318C` returns without drawing when `$156A8` bit 4 is set (dialog busy). The remake does not model it. The map poll runs with bit 4 clear, so this should not matter for these paths, but it is an assumption, not a trace of the poll state.
3. **Still next-pass.** The accepted-placement message, the demolition text, the building-select prompt (string `0`, posted by the path in `building.md` line 271, `moveq #0,d0` / `bsr.w $551a`, which the poll may reach), and every pass-time message. `notes/formats/map-rendering.md` section 9 records that the build-menu commit (`$6BA2`) writes `$551A` for its message; that path is the next candidate for a same-frame trace. The accepted-placement message was not traced in this slice.
4. **No original capture.** Everything here is static. A same-frame emulator comparison would need an explicit go-ahead.

## 6. Notes changed

- `notes/formats/game-text.md` section 4: the same-frame paragraph lists key D, keys 1-8 and the marker pin click, names the open items above, and drops the old "keys, pins still next pass" statement.
- `notes/formats/map-rendering.md` section 9: the same-frame sentence now covers the new paths.
- `notes/README.md`: the index names this handoff as the newest.
- `notes/HANDOFF-2026-11-13-key-pin-line.md`: this file.
