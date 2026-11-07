# In-game text drawing (game proper)

Static analysis of the game proper (Disk.1 sectors $14C-$208 at $1000). Addresses are RAM addresses of that image (image offset = addr - $1000; Disk.1 file offset = addr - $1000 + $14C*512). No game text or graphics are reproduced; strings are identified by table index (0-based, 408 entries per language, see `game-proper.md` section 7). Tags: **VERIFIED** = read from disassembly or data and consistent with the renderer output; **HYPOTHESIS** = inference. Nothing here was compared against an emulator RAM dump (static work only); `tools/text_render.py` implements the routines below literally and its output looks right (coherent text in all four languages).

**This is a different font from the boot stage** (`text.md`): boot font = 7 rows x 8 columns, table at image $43A2; in-game font = 6 rows, table at $62D8. Both use the same idea (glyph table with advance, 9-row line step, only ink pixels painted), but data and routines are separate.

## 1. Character table and glyphs (VERIFIED)

| What | RAM | Disk.1 file offset | Format |
|---|---|---|---|
| Character table | $62D8 | $2EAD8 | 62 entries x 2 bytes for codes $20-$5D: {glyph index, advance width in pixels} |
| Glyph bitmaps | $6354 | $2EB54 | glyph index * 6 bytes; 6 rows, 1 byte per row, MSB = left pixel; 61 glyphs (indices 0-60, up to $64C1) |

- Lookup in the drawer (`$539E`/`$538A`): `c >= $61` -> `c - $20` (lower case is drawn as upper case; there are no lower-case glyphs); then `idx = c - $20`, sign-extended from a byte, entry address = `$62D8 + 2*idx`. In the wrap routine (`$5C30`) the byte subtraction is not sign-extended, so codes below $20 read different (garbage) entries. Strings never contain such codes except the placeholder prefix of section 6.
- Ink never extends beyond the advance (checked for all 62 entries), so glyphs never overlap. Widest ink is 5 px (M, Q, W, Y have advance 6, others 5).
- Only upper-case letters, digits and a few signs have glyphs. Entries that share or lack glyphs:
  - glyph 0 (blank), advance 4: codes $20 space, $22, $24, $2A, $3C, $3D, $3E, $40.
  - code $23 uses glyph 3 (blank), advance 5 (this is the "blank digit" used as leading-zero padding, section 5).
  - codes $28 and $5B use glyph 8, $29 uses glyph 9 (round brackets are drawn as square-bracket shapes), $5D uses glyph 8.
  - codes $5E, $5F, $60 and above read entries past the table: glyph 0, advance 0 (draw nothing, no advance). German strings use $60 and Italian strings use $5E, so those characters are invisible.
- Advance widths (px): space 4, `!` 2, `#` 5, `%` 4, `&` 6, `'` 3, `(` `)` 3, `+` `,` `-` `/` 4, `.` 2, digits 5, `:` 2, `;` 3, `?` 4, letters 5 except I = 2 and M, Q, W, Y = 6, `[` `]` 3, `\` 4. Glyph index of a letter = code - $20 (A = 33, ..., Z = 58); digits 16-25.
- Line step is 9 rows (6 glyph rows + gap of 3).

## 2. Drawing routines (VERIFIED)

Arguments: d0 = x pixel, d1 = y pixel, a0 = NUL-terminated string, a1 = pointer to an array of 5 long plane addresses. Planes are 40 bytes per row, 8000 bytes per plane (320 x 200 lowres, 5 planes); the colour is the byte at `$156AB`.

- **`$538A` (transparent text, the normal one)**: computes the byte offset `y*40 + x/8`, falls into the shared body at `$53A2`.
- **`$539E` (opaque variant)**: first calls `$51E6`, which fills a 6-row strip, d2 bytes wide, at (x, y) with an 8-row background pattern (pointer in `$5D7A`, five planes x 16 bytes, phase `y & 7`), then draws the text like `$538A`. Screen setup builds the patterns from the displayed screen: `$4F2A` samples byte column 10 (pixels 80..87) over rows 70..77 into `$16D1A`; `$4F92` samples byte column 19 (pixels 152..159) over those rows into `$16D6A`. Each sampled row byte is duplicated in the 16-byte plane block so `$51E6` can consume one eight-row cycle across the five bitplanes. The disk menu points `$5D7A` at `$16D6A`, so its erases repeat the sampled 8x8 tile from the menu picture. Only the first line is pre-erased. Users: disk menu prompts/results and the keyboard text-entry routine near `$515C`. `$52A8` is the 8-row-high version of the same pattern fill (used to clear panel lines).
- Body (`$53A2`-`$54DC`), per character:
  1. byte 0 ends the string; a byte with **bit 7 set is a line break** (any value $80-$FF): the cursor returns to the line's start (same x including its bit shift) and moves down 9 rows; TAB ($09) is skipped without advance.
  2. table lookup (section 1) -> glyph index and advance; 6 glyph rows, row r written at `+r*40`.
  3. Pixel placement: with `s` = bit shift (x and 7 at line start, carried along), the glyph byte is `lsr`'d by `s` into the current byte; if `s + advance > 8` the bits shifted out (`glyph << (8-s)`) go to the next byte (`s + advance == 8` writes no second byte). After the character `s = (s + advance) and 7` and the byte pointer advances by 1 if `s + advance >= 8`.
  4. **Colour semantics (VERIFIED):** for each of the 5 planes the ink bits are first cleared (AND with NOT mask), then, if bit k of the colour byte is set, ORed into plane k. So ink pixels take exactly the colour index (planes 0-4 = colour bits 0-4); pixels that are not ink are untouched (the background shows through, no background clearing in `$538A`).
- Text running past x = 320 spills into the next scanline's left edge (planes are contiguous rows, nothing clips). German message index 3 is 342 px wide and would spill (observed in `text_render.py`; HYPOTHESIS that the game really shows it that way).
- Two-buffer drawing: the plane arrays are `$160FA` (front buffer, block `$160F2`) and `$16116` (back buffer, block `$1610E`); `$4E08` swaps the blocks. The top bar is drawn only into `$16116` (it is rebuilt every frame), messages are drawn into both (`$54DE` = draw with `$160FA`, then with `$16116`).
- Before message drawing the software mouse pointer is removed (VBL interrupt masked with INTENA $20, `jsr $2F5E`, bit 2 of `$156A8` cleared, `$4AA8 = $FFFF`) and bit 2 is set again afterwards (log) or left to the main loop.

## 3. Text colour `$156AB` (VERIFIED)

Only two values are ever written (all 67 write sites are `move.b #imm,$156AB`; initial value 1):

| Value | Binary | Planes | Palette entry (main-screen palette) | Use |
|---|---|---|---|---|
| 1 | 00001 | plane 0 | $AAA (light grey) | default; message log; many labels |
| 21 ($15) | 10101 | planes 0, 2, 4 | $FF0 (yellow) | top bar fields, single message line, headings/labels of the F-key screens (33 write sites set it before drawing; the matching resets to 1 follow) |

The in-game palette is the 32 words at offset 40,000 of the unpacked main-screen background (see `map-rendering.md` section 9).

The disk-menu message and list text use colour 1. The loaded image byte at `$156AB` is 1, and the shared start reset `$87D2` also writes 1. Neither the boot-menu setup `$7E52` nor the in-game icon-8 entry `$15AE6` changes `$156AB` before the disk-menu loop calls `$82B8`; `$8462`, `$83A2` and `$539E` read the current byte without overriding it. All routines that temporarily write highlight colour 21 restore 1 before returning to their caller. This establishes the normal text colour for the menu from static control-flow evidence; no live-original screenshot comparison exists.

## 4. Message line (single line, `$551A`) (VERIFIED)

`$551A`: d0 = string index (looked up through the table at `$188C2`: `a0 = $188C2 + word[idx]`). Draws at x = 8, y = $A0 (160), colour 21, **no wrapping** (a break byte would go down 9 rows with nothing restoring it). It is drawn into both buffers.
- If a previous line is still showing (`$156AC` != 0) it is erased first by `$558A`: 7 rows starting at y = 159 (planes 0-4, full 40-byte rows, both buffers) are copied back from a saved strip at `$28FD2` (5 planes x 7 rows x 40 bytes) captured from the pristine background at screen setup (`$4FFA`).
- After drawing, `$156AC = 200` frames. The VBL handler (`$2CAA`) decrements it and calls `$558A` when it reaches 0 (so the line lasts 200 frames = 4 s at 50 Hz).
- `$552C` is the entry used after the caller has prepared a0 itself (marker messages 113/114, see section 6).
- All line messages seen with constant indices fit within 304 px except German index 3 (342 px). Constant indices seen at call sites (decimal): 0, 1, 2, 3, 37, 84, 88, 111, 112, 178, 214, 233, 234, 237, 242, 266, 269, 291, 295, 302 (incomplete: some call sites compute the index).

## 5. Message log panel (`$5A8C`) (VERIFIED code, timing numbers VERIFIED)

`$5A8C`: d0 = string index; panel descriptor at `$15688`: {x = 8, y = $AB (171), used lines (word, `$1568C`), max lines = 3, pixel width = $130 (304), bytes per row - 1 = $25 (38 bytes = 304 px), row skip = 2}. Three more descriptors of the same layout exist for text boxes at `$15668` (x 8, y $27, 6 lines, 240 px) and `$15678` (x 8, y $2D, 16 lines, 232 px), used with `$5A4E` (see below). Panel geometry on the background picture: dark inset box x 0-319, y 168-199, interior from (2,170).

Steps:
1. `$5C30` word-wraps the string into the buffer `$161AA`: advance widths are accumulated; a space remembers the position; when the sum reaches (>=) the width (304) the text rewinds to the last space, which is replaced by $FF, and the line counter increments. A source $FF is a forced break (resets the sum), TAB is dropped. No hyphenation; a word longer than a line breaks at stale state (not seen in the data). Returns d6 = number of lines.
2. Pointer is removed (as above).
3. `d3 = used + lines`. If `d3 <= 3`: look up a free entry in the entry list at `$15698` (4 bytes each {first line, line count, protect counter, pad}, terminated by $FF); store {used, lines, $0A}; set the idle timer `$14634 = 500`; draw the wrapped text at x = 8, y = 171 + 9 * used (colour 1, both buffers via `$54DE`); `used += lines`.
4. If it would not fit (`d3 > 3`): walk the entries from the oldest; an entry whose protect counter (byte 2) is non-zero makes the walk give up and **the whole panel is cleared and the new message starts at the top** (`$5B46`: calls `$C4EC` (redraws a 3-label block, purpose HYPOTHESIS: restore of some overlaid screen item), clears the panel with `$5C9A`/`$52A8` using the pattern at `$16D6A`, `used = 0`, list empty, retry). Otherwise the oldest entries that cover the missing lines are dropped and the remaining lines are moved up (`$5B72`-`$5C2C`; it copies **plane 0 only**, which is enough because log text uses colour 1) and the freed rows are cleared. The protect counter is set to 10 when a message is added and decremented once per game day by `$9A36` (inside the daily tick routine), so a message younger than 10 days is never scrolled out; in practice a full panel is therefore wiped.
5. A message of more than 3 lines would make step 4 loop forever, so all strings sent to `$5A8C` have at most 3 lines. For the constant indices seen at call sites (143, 200, 199, 238, 98, 99, 109, 101, 300, 108, 110, 179, 149, 148, 150, 239, 197, 198, 343, 299, 215, 218, 219, 221, 223, 265, 285, 82, 141, 390; other callers use computed indices) all wrap to 1 or 2 lines in all four languages (checked with the wrap routine).
6. Panel idle clear: the main loop (`$15850`) clears the panel (blit pattern `$16D6A` over 3 lines of 8 rows, `used = 0`, list empty) when `$14634` reaches 0, i.e. 500 frames (10 s at 50 Hz) after the last message. The VBL handler decrements `$14634` while it is positive; the loop's `subq` makes it -1 so the clear happens once.
7. Clearing panel lines is a pattern fill (`$52A8`): 8 rows per line (step 8, not 9) over 38 bytes (x 8..311), pattern phase y and 7. For a faithful remake it is enough to redraw the background picture region (the panel interior is a flat dark texture).

`$5A4E` (d0 = index, a2 = box descriptor, as `$15668`/`$15678`): same wrapping, draws at (x, y + 9 * used) into the back buffer only and adds the line count to `used` (no overflow check). Called from the F-key text screens (`$E022`, `$E6B8`, `$E7F6`).

`$55CA` (label list, a0): entries of three words {string index, x, y} until index $FFFF; an index word that is negative (but not -1) draws nothing and instead pre-erases a 6-row strip (d3 bytes wide, from the caller) at (x, y) with `$51E6`. Each string is drawn with `$538A` into the plane array in a1. This is how the headings/labels of the F-key screens are placed (30 call sites).

## 6. Strings with a placeholder prefix (VERIFIED for markers, rest HYPOTHESIS)

Some strings (EN: indices 38, 81, 86, 113, 114, 147, 153, 154, 172, 173, 226, 229, 230, 232, 240, 267, 340, 350, 355, 380; the set differs per language) start with a byte that is below $20 (or, for long strings such as index 350, $8B-$96, i.e. offsets above 127). That byte is **the offset, inside the rest of the string, of a placeholder letter (an `x` in EN/FR/DE/IT in all but one case)**. VERIFIED code: `$3198-$31B4` (marker set/clear messages 113 and 114): `d2 = first byte`, a0 advanced past it, `a1 = a0 + d2`, `*a1 = digit` (`'1' + marker number - 1`), then `$552C` draws the rest as a message line. The other prefixed strings are drawn by code that skips the prefix; what gets patched in (a digit, a letter) is not traced (HYPOTHESIS: a number or name). Passing a prefixed string unmodified to the drawers would give garbage, because the prefix is read as a character (`$539E` treats it as a line break when bit 7 is set).

Bytes $80-$FE in the middle of a string (FR index 184, IT 185 and 213) are line breaks as far as `$538A` is concerned (bit 7); `$5C30` only recognises $FF. Message log strings use $FF breaks (about 100 per language).

## 7. Number text (VERIFIED)

`$15C5A`: d0 = value, d2 = first divisor (a power of ten, 1,000,000 down to 1), a0 = destination. Writes `log10(d2)+1` ASCII digits (d2 = 1,000,000: subtraction loops for the two top digits, then `divu`), **zero-padded to that width, then leading zeros replaced by `#` ($23)** - which is the blank 5-px glyph, so numbers are right-aligned in a fixed-width field. A zero value keeps one `0`. It does not write a terminator and does not handle negative values (callers clamp or ensure non-negative). `$560A` (d0 = x, d1 = y, d3 = count, a0 = array of longs, divisor in d2): draws a column of numbers 9 rows apart (negative values drawn as 0); used by the F-key screens with divisors 10000 and 1000 (e.g. at `$BB24`).

## 8. Top bar (y = 2, colour 21, redrawn every frame by the main loop at `$4D48`, `$4D1C`, `$4D96`) (VERIFIED)

The bar background (rows 0-23) is restored each frame by `$16012`, so the transparent text never accumulates. Strings live in the game image as templates (read at run time by `tools/text_render.py`).

| Field | x | Routine | Value / source | Text |
|---|---|---|---|---|
| Date | 8 | `$4D1C` (first calls `$564A`: day tick, see `game-proper.md`) | string at `$14594`, 10 characters `DD/MM/YYYY`, digits patched in place by `$571E` (increment with wrap 9 -> 0 and carry) | 8 digits x 5 px + 2 separators x 4 px = 48 px |
| Money | 110 ($6E) | `$4D48` | long at `$135BA`, clamped above to 9,999,999 (signed compare); template at `$2F48`: 7 digit slots (divisor 1,000,000), a space and a 2-letter currency suffix | 35 + 4 + 10 = 49 px; leading zeros blank |
| Title word flash | 182 ($B6) | `$4D96` | six-letter word at `$6532` drawn only on alternate frames (bit 5 of `$1581` toggled each call) and only if the low word of `$142C6` is >= 90; below 90 a string of six spaces (`$6539`) is "drawn", i.e. nothing | 27 px |
| Quality of life | 224 ($E0) | `$4D96` | long at `$142C6` (QoL %, clamped 10..98 by the simulation); template at `$2F53`: 4-character label ending in a colon, 3 digit slots (divisor 100), a space and `%` | 18 + 15 + 4 + 4 = 41 px |

The template strings hold `x` placeholders that `$15C5A` overwrites. HYPOTHESIS: because the toggle runs once per frame and the two screen buffers swap every frame, one buffer always carries the title word and the other never, so it flickers between the two instead of blinking slowly.

## 9. Renderer

`python -I tools/text_render.py INDEX --out FILE.png [--lang 0..3] [--mode log|line|raw] [--topbar] ...` draws a string-table index on the main-screen background with the real palette, using the literal plane-level algorithm above. `--stats` prints how many strings wrap to 1, 2, ... lines (no text). It reads Disk.1 from `original/utopia-whdload` (never copied into the repository); write the PNG outside the repository.

## 10. Unknown / not verified

- Purpose of `$C4EC` in the log clear-all path; exact visual role of the 3-label list at `$EC32`.
- What the placeholder is replaced with in the prefixed strings other than 113/114.
- Whether German index 3 (342 px) is ever shown (it would spill into the left edge).
- Real frame timing of the top-bar flicker; whether negative money is possible.
- No emulator RAM comparison of the drawn text was done.
