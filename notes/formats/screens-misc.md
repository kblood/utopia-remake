# Announcement dialog ($E770)

Called with d1 = id from the daily/yearly checks (1 game over, 2 QoL >= 80, 3 QoL >= 90).

- Portraits: Disk.1 sectors $2C0-$2CD, LZ/RLE packed, 10,240 bytes unpacked = 4 frames of 64 x 64 pixels, each
  5 bit-planes of 512 bytes (8 bytes per row), frame number = id (VERIFIED by rendering: frame 1 is the ruined
  colony, frames 2 and 3 are the two congratulation portraits, frame 0 is the generic one). Palette = main screen.
- Drawn at (x $68, y $72) by `$2E5E` (d5 = 7 = 8 bytes wide, d3 = $3F = 64 rows).
- Heading: string $183 (game over) or $184 (otherwise) at (x $58, y $0C). Body: second word of the entry
  `$F162 + 4 * id` = string index ($122, $185, $187, $188), wrapped and drawn by `$5A4E`.
- The original opens the window with `$B680` using rectangles `$F0F8`/`$F108` and an OK button rectangle at
  `$E930`; the remake uses a plain black panel and any click closes the dialog (game over then returns to the
  scenario menu).
