# Utopia handoff: the key cell `$14636/37` against the remake's poll-time pointer (2026-11-13)

Model and routing: Claude Haiku 5.5, inline. I was asked to act as the research sub-agent, but no orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No child agent was started. No subscription usage was checked and no timer was scheduled. No emulator was run and nothing under `original/` was written (read-only disassembly with `tools/game_dis.py` and throwaway scripts in `/tmp`). Nothing was committed or pushed.

Read first: [HANDOFF-2026-11-13-key-pin-line.md](HANDOFF-2026-11-13-key-pin-line.md) (its open point 1 is the question answered here), [formats/map-rendering.md](formats/map-rendering.md) sections 7.5 and 8, [formats/units.md](formats/units.md) (key n, `$14540`).

Question: does the original's key cell `$14636/37` (read by keys 1-8 at `$3202`) necessarily equal the pointer cell the remake uses at the same poll boundary? **Answer: no, not necessarily.** They agree in the ordinary case. The original's cell is a latched VBL sample, and there are static, time-dependent paths where the latch is stale. The remake has no latch, so it cannot reproduce those paths. No code was changed. The invariant is documented, and a regression pins the remake's own model.

## 1. Static trace (VERIFIED from the Disk.1 bytes)

All addresses are game-image addresses (file offset = address + `$28800`). Sweeps: a linear decode of the whole image for absolute operands `$14634`..`$14637`, `$161A6/8`, `$156A8`, and `$DFF09A`; callers by target.

**Writers of `$14636/37`.** Only `$5CDA` writes the cell word (`move.w d4,$14636` at `$5D0A` on a miss or a `vx`/`vy` of 8, `move.w $8(a1),$14636` at `$5D20` on a hit). The reset `$8776` writes `$FFFF` (`src/game/disk4-reset.ts`). `$14634` (word, `$5AF4`, `$8770`, `$80AE`) is a different word and does not touch bytes 36/37.

**Callers of `$5CDA`.** Three:
- `$2FE8` inside the hover routine `$2FBA`. `$2FBA` is called from the VBL handler at `$2CCC`.
- `$158CA` by `jsr`, from the poll's left-press branch (`$158A0`).
- `$3EDC`, which is called at `$15F78` from the right-press path `$15F44`.

**The VBL handler `$2C34`** (INTREQ bit 5 = VERTB, `$2C4A`):
1. `$2C60` `$2F5E`, then `$2C64` `$2CDA`: the pointer update. It reads the mouse counter `$DFF00A` and writes `$161A6`/`$161A8`. Those two words are written nowhere else in Disk.1, so **the pointer changes only at VBL**.
2. `$2C58` `bset #0,$156A8` (the flag the main loop waits on).
3. `$2CCC` `$2FBA`: if `$156A8` bit 2 is clear, return (no sample). If bit 4 is set, take the arrow path at `$2FFE` (no `$5CDA`). Otherwise `$5CDA` runs and writes `$14636/37`.

**Consumers.**
- Key dispatch `$15B4A` -> `$15C3C`: keys 1-8 require `tst.b $14636` (high byte, `vx`) to be non-negative (`$15C48`-`$15C4E`). A `$FFFF` latch ignores the key. Otherwise `$3202` adds `$14636/37` to the scroll `$144E4/6` and places or removes pin n (`$31BC`/`$3202` path, `units.md`).
- The cell highlight in `$6568` and `$66CA`, and `$15C48`'s `tst.b`, read the same word.

**Main-loop order, from `$157BC`** (the 1-8 key is dispatched only after this):
- `$15812` `move.w #$20,$DFF09A`: VERTB interrupt disabled.
- `$15820` `bclr #2,$156A8`: pointer-active gate closed.
- `$15830` `move.w #$8020,$DFF09A`: VERTB re-enabled.
- `$15838` `jsr $4E08`: bitplane pointer swap (no VBL wait).
- `$1583E` `bset #2,$156A8`: gate reopened.
- `$15846`-`$1584E` `bclr #0` then `beq`: wait for bit 0. `bclr` tests the old bit, so the wait ends at once if bit 0 is already set.
- `$15888` `$99C4`, then `$1588E` `$50B2` (the poll). `$158A0` runs `$158CA` on a left press. `$158C2` runs `$15B4A` (keys).

## 2. The invariant

At key dispatch, `$14636/37` holds the result of the most recent `$5CDA` call in time.
- **No press in the poll.** The most recent call is the VBL handler sample that ended the wait. The pointer is the one `$2CDA` set at that VBL. So the key cell is the pointer cell at the last VBL, latched.
- **A left press or a right press in the same poll** re-samples synchronously (`$158CA` or `$3EDC`, both before `$15B4A`). The key then uses the pointer at the poll, which is what the remake uses.

## 3. Where the remake agrees and where it does not

The remake (`src/game/map.ts`, `MapScene.update`, lines ~586-587 and ~608): the hover cell is sampled once per browser update with `pickCell(input)`, and the poll runs in the same update with the same `input`. `key()` calls `pickCell(input.pointerX, input.pointerY)` (line ~501). So the remake's key cell is the pointer of the poll's own update. `game.ts` (~855) maps the pointer through `pointerPoint()`, which clamps it like `$2CDA`. The pick rectangles were checked: a `vx = 8` "no cell" rectangle cannot overlap a valid rectangle that comes later in index order, so first-match order gives the same answer as the remake's `vx` loop.

Agreement: the original's VBL sample and the remake's update sample are the same pointer whenever the pointer's cell is unchanged between them. This is the common case.

Divergences (all static, time-dependent, not reproduced by the remake):
1. **Masked VBL, stale latch.** The VBL is re-enabled at `$15830`, and bit 2 reopens at `$1583E`. A VBL that is serviced in that window (a VBL pending from the masked interval, or one during `$4E08`) reaches `$2FBA` with bit 2 clear and skips `$5CDA`. Bit 0 is already set, so the wait ends at once and the key uses the previous VBL's cell, not the current pointer. The window is a few microseconds plus the masked interval, so it is rare, but it is a real path.
2. **Dialog-busy VBL (bit 4 set).** A VBL sampled while `$156A8` bit 4 is set takes the arrow path and keeps the earlier cell. The main loop does not run during a dialog, but a click that opens one in the same poll can return to `$15B4A` with the stale cell (not traced further; the main loop normally sees a fresh VBL sample before its next poll).
3. **Pointer domain.** The original pointer is accumulated from the mouse counter `$DFF00A` at each VBL, and the remake uses the browser's absolute pointer. Both are clamped to 312 x 192. Equal cells need equal pointer positions, which is an existing approximation (`notes/formats/map-rendering.md` section 8).

The remake's model is therefore "the key uses the poll update's pointer". That equals the original when no divergence above applies. It is not a proof of identity.

## 4. Change

No simulation or gameplay code changed. Test only: `test/map-loop.mjs` section 7c (inside the Disk.1/Disk.2 block), with a local helper `keyInputAt`.
- Pointer on cell X1 in all earlier updates of a pass, then on cell X2 in the poll's update, with key 1: pin 1 goes to X2. The other pins stay unplaced. The poll completes the pass.
- Pointer on X1 earlier, off the map in the poll's update, with key 1: no pin change and no message line.

## 5. Verification run on 2026-11-13

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/map-loop.mjs` (with the new section 7c) | exit 0, 0 `FAIL`; the 7c checks are `ok` |
| Mutation: the compiled `dist/game/map.js` poll passes the previous update's pointer to `key()` (temporary, restored by copying the original back and rebuilding) | `test/map-loop.mjs` fails the 7c checks (pin position, off-map pin) and the 7b pin checks that depend on the same pointer |
| `npm test` (full chain) | exit 0, 4,478 `ok` (4,471 before this slice), 0 `FAIL`; optional captures skipped as designed |

## 6. Open points (not changed)

1. **The divergences in section 3 are not modelled.** Modelling the masked-VBL window (point 1) would need the remake to track bit 2 and the VERTB mask across the `$15812`-`$15830` interval and `$4E08`. No emulator capture establishes how often it occurs. Next step if wanted: a same-frame capture (explicit go-ahead needed) that pins a key pressed around a pointer cell change.
2. **Pointer-domain equivalence** (point 3) is an existing approximation, not settled here.
3. The key-pin handoff's open point 1 is answered by this note: the cell is not necessarily the poll-time pointer, and the remake's model is the poll-update pointer.

## 7. Notes changed

- `notes/formats/units.md` (key n paragraph): the cell latch and its writers and consumers.
- `notes/formats/map-rendering.md` section 8: the writer and gate paragraph for `$5CDA`.
- `notes/formats/game-text.md` section 4: the "not verified" key-cell sentence now points here.
- `notes/HANDOFF-2026-11-13-key-pin-line.md`: open point 1 points here.
- `notes/README.md`: index pointer to this note.
