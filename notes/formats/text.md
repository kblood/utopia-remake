# Bitmap font, string tables and the credit roll

Verified against the WinUAE reference run: with the title picture decoded and the first 12 characters of one credit string drawn, all 64,000 pixels equal the screen read from emulator RAM.

## Where the data is

All offsets are image offsets in `Disk.1`. The boot stage (image `$3000`-`$87FF`) is loaded to chip RAM at `$77F18`, so RAM address = image offset + `$74F18` for this block.

| What | Image offset |
|---|---|
| Character table: 2 bytes per character code (code - `$20`): glyph index, advance width | `$43A2` |
| Glyph bitmaps: 7 rows of 1 byte per glyph, MSB is the left pixel, glyph indices up to 59 | `$4468` |
| Credit string index list: words, ends with a word with bit 15 set | `$4644` |
| Language string table, English | `$46CA` |
| Language string table, French / German / Italian | `$5356` / `$5FDA` / `$6D98` |

## String tables

- A table starts with an array of 16-bit offsets, one per string, relative to the start of the table. String numbers start at 1.
- Strings are zero terminated. Letters are stored in upper or lower case and drawn as upper case.
- A byte with bit 7 set is a line break: back to the start x, down 9 rows.
- Strings 1-8 are the credit roll lines (padded with spaces). Further strings are help and in-game text; they are not documented here.

## Drawing

- A character is looked up with `code = (c >= 'a' ? c - $20 : c) - $20`. Its glyph is drawn 7 rows high, 8 columns wide, and the cursor advances by the width from the table.
- Only set glyph pixels are painted (the original clears those bits in all five planes and ORs the text colour). The credit roll uses colour index 1.

## Credit roll (title screen)

- Text position x = `$30`, y = `$B4` (180). The boot stage steps through the index list, draws the string one character at a time (2 video frames per character), holds it for 121 frames, clears the band, and moves to the next string. The list is cycled until the left mouse button is pressed.
- The clear erases bitplane 0 only, for 7 rows starting at x = `$28`, 31 bytes wide.
- A press of the left mouse button during the hold ends the roll. The next step is the language picture (`Disk.1` sectors `$5A`-`$5F`).
- The language choice is made by the pointer's vertical position. The thresholds are `$2C`, `$5B` and `$89`, which pick English, French, German or Italian, matching the four flags in the language picture.
- Buttons are read from CIA-A port A bit 6 (left) and POTGOR bit 10 (right).

## Not yet checked

The roll timing comes from reading the code and matches the reference run's pace only roughly. The fade between screens is not implemented.
