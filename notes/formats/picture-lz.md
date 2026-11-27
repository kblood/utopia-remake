# Picture packing (LZ/RLE) and the title picture

Verified against a WinUAE reference run (chip RAM dump at the title screen). Only the title picture is verified end to end. The other ranges below are observed load calls, not decoded content.

## Disk addressing

- `Disk.N` in the WHDLoad set is a flat image addressed in 512-byte sectors (`offset = sector * 512`). The 6144-byte "tracks" are 12 sectors each.
- The slave replaces the game's track loader. The game passes first and last sector numbers (inclusive) in `d0` and `d1`; the slave turns them into `offset = d0 * 512`, `size = (d1 - d0 + 1) * 512` for `resload_DiskLoad`.
- The slave loads the boot stage itself: image offset `$3000`, `$7800` bytes, to chip address `$77F18`. It checks a CRC16 of that block against two known values (two game versions) and patches the game for each.

## Loader pattern in the boot stage

For each picture the boot stage does: load a sector range into a scratch buffer, then call a decoder with `a5` = packed data, `a6` = destination, `d7` = output limit (`-1` for none). The decoder stops at a zero control byte.

Observed sector ranges on `Disk.1` (inclusive):

| Sectors | Unpacked size | Notes |
|---|---|---|
| `$70A`-`$728` | 40,064 | Title picture. Verified against emulator RAM. |
| `$729`-`$733` | 40,064 | Full-screen picture shown before the title: the publisher logo with a "PRESENTS..." caption. Decoded by the existing decoder (`PICTURES.presents`) and used by the pre-roll (`src/game/intro.ts`); the packed data unpacks to exactly 40,064 bytes and its palette tail is the logo's 32 colours. Checked against the packed data and a scratch render only, not against RAM. |
| `$05A`-`$05F` | 40,064 | Language selection picture with four flags. |
| `$060`-`$0DC` | 89,600 | Loaded and unpacked after the language choice, drawn with the blit routine at `$790BE`. Not identified. |
| `$0DD`-`$14B` | 95,590 | Unpacked to the same buffer later. Not identified. |
| `$3C3`-`$4AC` | 160,028 | Starts with a 16-byte text name field; loaded once and a routine at `$7C8EC` is called with it (likely music data). Not identified. |
| `$14C`-`$208` | 96,768 (stored raw) | Loaded to chip `$1000` unpacked, the game proper. |

## Unpacked picture layout

- 320 x 200, 5 bitplanes, non-interleaved: 5 planes of 8000 bytes, plane 0 first.
- Then 32 OCS palette words (big endian, `0RGB` with 4 bits per channel). Total 40,064 bytes.
- The display is set up with a copper list (BPLCON0 `$5200`, DIWSTRT `$2C81`, DIWSTOP `$F4C1`, DDFSTRT `$38`, DDFSTOP `$D0`, zero modulos).

## Control bytes

| First byte | Meaning |
|---|---|
| `$00` | End of stream |
| `%00xxxxxx`, bit 5 clear | Literal: copy the next `b & $1F` bytes |
| `%001xxxxx` | Literal: `n = ((b & $1F) << 8 \| next) + $20`, copy `n` bytes |
| `%010xxxxx` | Run: `n = (b & $1F) + 3`, repeat the next byte `n` times |
| `%011xxxxx` | Run: `n = ((b & $1F) << 8 \| next) + $24`, repeat the next byte |
| `%100xxxxx` | Copy 2 bytes from earlier output, distance field `b & $1F` |
| `%101xxxxx` | Copy 3 bytes from earlier output, distance field `b & $1F` |
| `%11llllhh` | Copy `l + 4` bytes (`l` = bits 5-2), offset `h << 8 \| next` |

For the copies, the source starts `count + offset` bytes before the current end of the output. Copies read forward, so overlapping copies repeat data.

## Check

The decoder in `src/data/unpack.ts` reproduces the screen bitmap from the reference run bit for bit except in rows 180-186 of the bitmap, where the game draws text over the picture afterwards. The 64-byte tail decodes to a plausible 32-colour palette.
