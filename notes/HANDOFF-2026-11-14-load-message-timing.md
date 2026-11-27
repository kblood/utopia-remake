# Utopia handoff: the load message's timing (2026-11-14)

Model and routing: Claude Haiku 5.5, run as the implementation sub-agent. The brief named Claude NT provider `claude_personal`; no orchestration tool was called, so that routing is not confirmed and no switch is claimed. No emulator run, no writes under `original/` (read only: `tools/game_dis.py` and plain byte slicing of `original/utopia-whdload/Disk.1`), nothing committed or pushed, no worktree reset or clean. The dirty worktree was preserved.

Read first: [HANDOFF-2026-11-14-disk4-pick-message.md](HANDOFF-2026-11-14-disk4-pick-message.md) (its section 3, the one-VBL claim, is refined here), [HANDOFF-2026-11-14-load-pick-message.md](HANDOFF-2026-11-14-load-pick-message.md), and [formats/game-proper.md](formats/game-proper.md) "Load success message" (now with a "Timing analysis" bullet group).

## 1. Question and answer

**Does the `$145` list-prompt line appear for an actual visible VBL?** Partly, by static trace:

- It is printed at VBL C (after `$8462`'s wait at `$8488`-`$8498`) and erased at the first VBL after `$851A` (`$84F4`'s wait `$851A`-`$852A`). The erase's `bclr` at `$851A` discards any VBL that came before it, so the erase lands on VBL C+1 when the path between them is shorter than one field. That path is the print routine `$539E`, `$866E`'s 665-byte clear, `$875C`, `$88DC`'s 120-word clear and `$82B8`, with no VBL wait. By instruction-count estimate it is a few milliseconds, under one PAL field (20 ms). So the line is up for **exactly one VBL interval**.
- Whether field C **shows** it is **not established**. It depends on whether the glyph draw finishes before the beam reaches picture row 163 (about 13 ms into a PAL field, by a line-count estimate), and the draw starts after the VBL handler returns, whose length is unmeasured.

**Can its lifetime be modelled by existing frame/update timing?** The lifetime, yes: the remake's `update` is one 50 Hz frame, so one VBL maps to one update. The **start**, no. The `$145` print comes after:

1. the area reads `$7D96` at `$8868` and `$887A` (WHDLoad disk calls, length not measured);
2. the disk-header check `$8A5A`: `$841E` reads the header, and on a mismatch `$E6EC` prompts for the other disk, a wait that is not traced;
3. `$88C6`'s erase (VBL B) and the print at VBL B+1.

So the delay from the pick is set by the disk and by the user. No frame count can be assigned from the trace.

## 2. Decision

**No source behaviour change.** The remake keeps showing no message for a slot load or a Disk.4 pick. A one-frame line at a fixed offset from the pick would claim a start time the original does not have, and the brief forbids guessing. The adjacent `$144` line (up during the reads) shares the same unknown start and is left as it is.

Comments and test names that said the original shows nothing after a load (or erases it "before any frame") were stale against the one-VBL trace. They are corrected, with no assertion changed:

- `src/game/disk-menu.ts`: the `GAME_LOADED_STRING` doc, which now gives the one-VBL lifetime, the visibility and start caveats, and the test.
- `src/game/game.ts`: the comments at `activateDisk4` (~line 748) and `acceptScene`'s load caller (~line 897).
- `test/save.mjs` (the "held: a load pick shows no message" check name) and `test/disk4-scene.mjs` (section 2e comment).
- `notes/formats/game-proper.md`: the first "Load success message" paragraph (the superseded "no frame or wait" sentence) and the "Timing consequence" bullet, followed by a new "Timing analysis" bullet group.

## 3. Evidence (raw bytes, Disk.1, file offset = address + `$28800`)

Every address was checked by plain byte slicing (independent of capstone), and branch targets were decoded from the displacements. All matched.

| Address | Bytes | Meaning |
|---|---|---|
| `$88CA` | `303C0145` | `move.w #$145,d0` |
| `$88D0` | `6100FB90` | `bsr.w $8462` (target checked: `$88D2 - $470 = $8462`) |
| `$88D8` | `6100FD94` | `bsr.w $866E` |
| `$88EA` | `6000F9CC` | `bra.w $82B8` |
| `$82E4` | `6100020E` | `bsr.w $84F4` |
| `$8488` / `$851A` | `08B9 0000 0000156A8` | `bclr.b #0,$156A8` (each wait's first clear) |
| `$8498` / `$852A` | `67F6` | `beq.b` back to `$8490` / `$8522` (the spin) |
| `$2C44` | `33C1 00DFF09C` | `move.w d1,$DFF09C` (INTREQ ack) |
| `$2C4A` | `08000005` | `btst.b #5,d0` (VERTB gate) |
| `$2C58` | `08F9 0000 000156A8` | `bset.b #0,$156A8` (the VBL flag) |

Structural checks (`test/load-message-trace.mjs`): the only absolute `bset #0,$156A8` in the image is at `$2C58`; the absolute `bclr`/`btst #0,$156A8` sites include the four wait clears; and no such VBL-bit access lies in `$82B8`-`$82E4` or `$866E`-`$87DA` (the post-print path).

The VBL vector install was **not** found as a literal longword `00002C58` in the image, so the handler's identity rests on the INTREQR bit-5 gate and the ack, not on a located vector. That is stated as such.

## 4. Test

`test/load-message-trace.mjs` (added to the `npm test` chain after `save.mjs`):

- Reads only the local `original/utopia-whdload/Disk.1` at runtime. Skips with exit 0 when it is absent.
- Checks the bytes, branch targets and wait-loop shape above, and that the post-print path has no VBL-bit access.
- Mutation self-check (each must be reported, and each for its intended reason):
  - `bsr $8462` at `$88D0` replaced by nop: `branch at 88d0 ... target none`;
  - the print wait's `beq` at `$8498` replaced by nop: `branch at 8498 ... target none`;
  - a `bclr #0` at `$8680` inside the reset loop: `VBL-bit access on the post-print path at 8680`;
  - a second `bset #0` at `$8700`: `bset #0,$156A8 absolute sites: 2c58,8700`;
  - `bra $82B8` at `$88EA` replaced by nop: `branch at 88ea ... target none`.

The test does **not** measure cycles, the raster, or the disk-read length; it pins the static structure the timing note relies on. A first version had a bug (`Uint8Array.indexOf` with an array argument never matches); the positive control caught it, and it now uses `Buffer.indexOf`. The mutants had passed vacuously before that fix.

## 5. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/load-message-trace.mjs` | exit 0, 6 ok (the trace and five mutants), 0 FAIL |
| `node test/save.mjs` | exit 0, 403 ok, 0 FAIL |
| `node test/disk4-scene.mjs` | exit 0, 109 ok, 0 FAIL |
| `node test/disk-menu.mjs` | exit 0, 107 ok, 0 FAIL |
| `node test/disk-menu-keys.mjs` | exit 0, 41 ok, 0 FAIL |
| `node test/scenario-pick.mjs` | exit 0, 30 ok, 0 FAIL |
| `node test/game-over.mjs` | exit 0, 50 ok, 0 FAIL |
| `npm test` (full chain, with the new test) | exit 0, no FAIL lines |

The behaviour is unchanged, so the existing assertions are the regression set. No visual parity is claimed.

## 6. Open points (not changed)

1. **Visible frame (unmeasured).** Whether field C shows the line depends on the handler's length and the glyph draw against the raster (row 163). Resolve by a Copperline or WinUAE capture of a slot load's list prompt, sampled on the frame after the `$88C6` erase. Not done here (no emulator run was allowed).
2. **Start (unbounded by the trace).** The delay from pick to print is set by the disk reads and by any disk-swap prompt (`$E6EC`, whose wait is not traced). Tracing `$E6EC` and the reads (`$7D96`, `$841E`) would bound it, but not fix it, since the disk I/O time is external.
3. **`$144` during the reads.** Same unknown start; the remake shows none.
4. **VBL vector.** The install of `$2C58` as the VBL handler is not located in the image as a literal longword. Finding the install (possibly through a relative or indirect load) would settle the handler's identity.
5. **Cycle estimates.** The "well under one field" bound for the post-print path is an estimate from instruction counts (68000-class timing), not a measurement. If it were ever longer than a field, the line would last two VBLs, which the test would not catch.

## 7. Files changed

- `test/load-message-trace.mjs` (new), `package.json` (test chain).
- Comments and check names only: `src/game/disk-menu.ts`, `src/game/game.ts`, `test/save.mjs`, `test/disk4-scene.mjs`.
- `notes/formats/game-proper.md`: superseded sentence corrected; "Timing analysis" bullet group added.
- `notes/HANDOFF-2026-11-14-load-message-timing.md` (this file), `notes/README.md` (newest-handoff pointer).
