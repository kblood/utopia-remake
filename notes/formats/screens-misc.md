# Announcement dialog ($E770)

Code: `src/game/announce.ts` (`AnnounceScene`), opened by `Game` for a sim `announce` event; test `test/announce.mjs`.
Evidence: STATIC trace of Disk.1 (`tools/game_dis.py`, file offset = address + `$28800`) plus a rendered check of the
remake's own output against the layout below. No running-original screenshot or input capture exists, so pixel parity is not claimed.

Called with d1 = id from the daily/yearly checks (0 colony falls to crime, 1 game over, 2 quality of life 80, 3 quality of life 90).

## Layout (STATIC)

- Caller state: nothing is cleared first; the dialog is drawn over the displayed map picture (the remake draws over
  `MapScene.screen`, the frozen map).
- Portrait frame: window `$F0F8` = {x 96, y 106, 10 x 8-pixel columns, 10 rows} drawn with `$B680` (its prologue copies the
  displayed bitmap to the back buffer unless `$156A8` bit 5 is set; the body draws the 8x8 frame pieces with a filled interior).
- Text frame: window `$F108` = {x 0, y 8, 31 columns, 11 rows}, drawn with `$B6CE`. `$B6CE` is the frame body without the
  `$B680` prologue, so both windows use the same pieces; the remake's `Ui.frame` is that body.
- Portrait: Disk.1 sectors `$2C0`-`$2CD` (LZ packed, 4 frames of 64 x 64, 5 planes), frame = id (min 3), drawn at (104, 114).
  Verified earlier by rendering (frame 1 is the ruined colony, frames 2 and 3 the congratulation portraits, frame 0 the generic one).
- Heading: string `$183` (game over, ids 0 and 1) or `$184` (ids 2 and 3), at (88, 12), inside the top edge of the text frame.
  Colour: `$E770` does not write `$156AB`, so the colour is the inherited byte. The date and money draws in the pass set it to `$15`
  and restore 1 (`$4D36`-`$4D42`, `$4D90`), so the remake uses colour 1 (INFERENCE from those writers, not a capture).
- Body: the second word of table `$F162 + 4 * id` (string `$122`, `$185`, `$187`, `$188`), drawn by `$5A4E` with the text context
  `$15668`.
- Buttons: `$58A0` draws the ten command buttons (rectangles `$5E06`, 16 x 16) with the image table `$E930`. Entries 0-8 are
  0 (the blank default image `$185A2`); entry 9 is `$17422`, the exit icon. The exit icon is therefore at rectangle 9
  (x 272-287, y 139-154), the lower left of the command column, drawn over the map.

## Leaving (STATIC, `$58F8`)

The dialog waits in `$58F8`, the same loop as the other windows' buttons:

- A press on any of the ten command rectangles flips the button (`$5756`) and plays the click (SFX id 4). A press elsewhere does nothing.
- The release leaves the loop (`$57FA`, the flip back) whatever the pointer position, provided a button was recorded by the press.
  A release with no recorded button does nothing, so a click elsewhere keeps the dialog open.
- Escape and the right button are not read by this loop.
- Then `$B628` redraws the command buttons and the map frame and the caller continues.

Corrections to the earlier note: `$E930` is an image table, not an "OK button rectangle", and the leave target is any command
rectangle (the exit icon is only the one that is drawn as an icon). The remake implements this rule in `AnnounceScene.update`.

## Remake

- The remake draws the two frame windows and the ten buttons with the exit icon, over the map, and no longer draws its earlier black panel.
- A press on a command button flips it and plays SFX id 4 (`Game` passes `sfx.play(SFX.CLICK)`); the release anywhere leaves.
- Game over (ids 0 and 1) then shows the disk menu over the frozen map (corrected 2026-11-10 from the earlier scenario-list
  remake choice). The original does not return from `$E770` to its caller in this case: `$B0B0` (and `$10E0A`) run
  `bset #3,$156AA` and `jmp $157AE`, whose first call `$7E52` is the disk menu (game-proper.md, "Game over"). The remake's
  scenario list is one icon away, as in the original.
- Escape and the right button no longer leave the overview map or the council room (strict since 2026-11-12, screens.md sections 8 and 9; they were a remake convenience before). The report, trade, market, staffing and intelligence windows do not either (screens.md, 2026-11-11). The announcement does not take them, as the original.

## Not traced / open

- The message origin and wrap width: resolved statically (STATIC, Disk.1 disassembly and raw image scan, no emulator run).
  The text context record `$15668` has these words in the disk image (sector `$14C` at `$1000`, so file offset `$15668 + $28800`):
  +0 x = 8, +2 y = `$27` (39), +4 used-line cursor = 0, +6 = 6, +8 = `$F0` (240), +`$A` = `$1E`.
  - `$5A4E` (the renderer used by `$E770`, `$E000`, `$E6B8`, `$E7F6`) reads only +0, +2 and +4: it draws at
    (x, y + 9 * cursor) and adds the line count to the cursor. It calls the wrap routine `$5C30` with the record in a2.
  - `$5C30` takes the wrap width from **+8** (`move.w $8(a2),d3` at `$5C30`), not from +6. It wraps when the advance sum
    reaches the width (`cmp.w d3,d7; bmi` at `$5C7E`), which the remake's `wrapText` reproduces.
  - +6 is the max line count. Only `$5A8C` (the message panel, `$15688`) tests it (`cmp.w $6(a2),d3` at `$5AD6`); `$5A4E`
    does not. The earlier label "+6 wrap limit" was wrong.
  - `$E770` (`$E7EC` `lea $15668,a2`, `clr.w 4(a2)`, `jsr $5A4E` at `$E7F6`) sets neither x, y nor the width. The `$E000`
    F-key screen uses the same record the same way (heading at y 25, body at the stored y 39), which the original's layout
    supports: 8 + 240 = 248, the right edge of the `$F108` window.
  - Writers. Absolute-long scan of the image (`00 01 56 68` only at `$E01A`/`$E7EE`, no pointer table holds `$15668`),
    a capstone linear sweep (absolute and PC-relative operands; only those two `lea`s touch the record, plus `clr.w $1566C`
    cursor resets and `$5A4E`'s cursor update), and a literal-base scan (`lea`/`movea`/`move.l #` to `$10000`..`$15678`
    followed by a store with the same register and displacement landing in `$15668`..`$15677`: only the two cursor clears)
    found no write to x, y or the width. Clear and copy loops with a literal base in `$10000`..`$15708` were checked; none
    reaches `$15668`. The `$5D30` table (`$15628`, four 16-byte entries, ends at `$15667`) and the `$8770` clears
    (`$15634`..`$15665`) stop before the record.
  - So the record keeps its disk values from load until used. The remake now reads them from the disk
    (`readMessageContext` in `announce.ts`): origin (8, 39), width 240. The earlier (20, 30, 220) was an inference and is retired.
  - Live bounded run (EMULATOR, Copperline 1.0.1, A1200/68020/AGA, 2 MiB chip + 4 MiB fast, read-only WHDLoad boot tree
    with a copy of the game folder, 2026-11-10; capture artifacts kept outside the repo). Write watches on `$15668`..`$15671`
    (class default, which also covers disk DMA) plus PC breaks at `$E770` and `$E7EC`. Observed: the record is zero until
    6.84 s emulated (frame 341), then the CPU fill loop at `$5F18AC`-`$5F18BC` writes `$CCCC` to all five words. No later
    write to the record occurred up to 795 s emulated (frame 39722), with the machine paused in the intro at PC `$78C00`
    (the title/credit screen was on display at 269 s). So the disk bytes (8, 39, 240) have NOT yet reached the record in the
    observed interval. This is consistent with the record being loaded only after the intro's language and code steps, which
    this run did not reach (pointer navigation not calibrated). `$E770`/`$E7EC` were not hit. The live check therefore does
    not yet confirm or contradict the disk values at first use; the code is unchanged.
  - Live run 2, 2026-11-10 (EMULATOR, Copperline 1.0.1, A1200/68020/AGA, 2 MiB chip + 4 MiB fast, the same decrypted KS 3.1
    A1200 copy and read-only boot tree of a game-folder copy; `Utopia.Slave` and `Disk.1` hashes matched the recorded ones; capture
    artifacts outside the repository). Watches (write, class default) on the eight words `$15668`..`$15676`. Observed:
    - 6.39 s emulated (frame 318): eight writes `$0000` -> `$CCCC`, one per word, from the fast-RAM fill at `$5F0DF2`-`$5F0E04`.
      The same fill as the earlier run (6.84 s there); the time differs between sessions.
    - No later watch write to the record occurred up to 117 s emulated. The record read `$CCCC` (16 bytes at `$15668`) at the
      roll exit (87.2 s) and at 117 s. So the disk values (8, 39, 240) were not observed in RAM before the intro's language stage.
    - Not reached: a clean language choice, the code check, the slide show, the disk menu, `$E770` and `$E7EC`. The credit
      roll ends on a left press (routine `$78CCC`: bit 0 = left, bit 1 = right; exit to `$78698`). After the roll exit the
      language poll did not stop as expected: a breakpoint at `$786F4` fired about 34,000 times in a tight sequence with the
      pointer word `$79106` = 0 (run 3), another session read `$0048` there, and a later stop was back in the roll button
      routine (`$78CCC`). These are not explained; the breakpoint and pointer behaviour in this boot is unresolved.
    - Headless limits: the control API has no image output (`--screenshot-after` works only per launch), so the language
      pointer could not be calibrated from screenshots.
    - Static discrepancy, unresolved: the Disk.1 listing at file offset `$36E8` (base `$78600`, the mapping of `notes/formats`
      tools) puts `btst.b #6,$BFE001` at `$786DC` with `bne` at `$786E4` and `moveq #1,d1` (the French branch) at `$786F4`.
      This note, `graphics-and-music-blocks.md`, `text.md` and `src/game/language.ts` cite `$786F4` as the poll. One of the two
      readings is wrong; the mapping must be re-checked before either is changed.
    - Result: no value source is established for the record, so the remake is unchanged. Still open: the record's contents at
      `$E7EC` (first use), the post-load write, and the poll address.
  - Still open (static evidence cannot settle these): (a) whether the loader writes the disk bytes to RAM verbatim (the
    bounded run above has no post-load capture yet); (b) register-relative stores through a base that is computed, not
    a literal (not excluded); (c) `$8A4C` (called first by `$E770`) is still not traced, though no absolute reference to the
    record appears in it. A RAM read of `$15668`..`$1566F` at the first `$E770` (for example a Copperline breakpoint on
    `$E7EC`, reading a2 and the record words before `clr.w 4(a2)`) would close (a) and (b) in one step.
- `$8A4C` (called first) is not traced; it is not reproduced.
- The first-poll state: a button already held when the dialog opens is treated as held (not pressed), as the remake's `Pointer`
  does for all windows. The original's `$50B2` could read such a state as a press (its state bit 3 starts clear); not traced.
- The exit redraw `$B628` and the frame copy `$5A16` are buffer bookkeeping; the remake shows the pre-dialog frame when the dialog closes.
