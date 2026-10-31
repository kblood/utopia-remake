# XPK / MASH (disk.4)

Beskrivelse af containerformatet og komprimeringen, som bruges af `disk.4` i WHDLoad-sættet. Ingen originaldata er med her.

Udpakkeren er `tools/xpk_mash.py`. Den er en Python-port af MASH-dekoderen i temisu/ancient (BSD-2-Clause, se `tools/LICENSE-ancient.txt`).

## XPKF-header (målt på disk.4)

- Bytes 0–3: signaturen `XPKF`.
- Bytes 4–7: pakket længde.
- Bytes 8–11: kompressionstype, her `MASH`.
- Bytes 12–15: rå (udpakket) længde. Den er big-endian.
- Byte 32: flag. Bit 0 angiver lange chunk-headere. Bit 1 angiver kodeord, og den slags filer afvises. Bit 2 angiver en udvidet header.
- Headerlængden er 36 bytes uden udvidelse. Med udvidelse er den 38 + en 16-bit længde ved byte 36.

## Chunks

- Hver chunk har en 12-byte header: type (1 byte), pakket længde (4 byte), rå længde (4 byte), og så data. Data er padded til 4 bytes.
- Chunktype 0: rå data, kopieres direkte.
- Chunktype 1: MASH-komprimeret.
- Chunktype 15: slutmarkør.

## MASH-bitstrøm

- Bits læses MSB først.
- En literal-længde kodes som en unary-kode op til 6 ettaller. Ved 6 følger en udvidet længde.
- Literal-bytes læses direkte fra strømmen.
- Derefter findes der tre typer match:
  - En match med længdekode og en VLC-distance.
  - En match med længde 3 og en VLC-distance.
  - En match med længde 2 og en 9-bit distance.
- VLC-distancen starter med en 3-bit basisindeks. Basen har offsets `0, 32, 160, 672, 1696, 3744, 7840, 16032` og bitlængder `5, 7, 9, 10, 11, 12, 13, 14`.

## Verificeret

- `disk.4` udpakkes til 983 040 bytes, som matcher headerens rå længde.
- Output ligger i `original/extracted/disk4.bin` (gitignored).
- Hele dekodningen er ikke krydstjekket mod en WinUAE-kørsel. Det er et åbent punkt.

## Åbent

- Hvilken hukommelsesadresse slaven indlæser `Disk.4` til. Det er ikke fastlagt, så den 1 004 bytes store blok ved `0x78000` kan ikke placeres endnu.
- Hvorfor blokken har huller og blandet tekst. Se [utopia-disks.md](utopia-disks.md).
