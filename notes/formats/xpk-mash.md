# XPK / MASH (disk.4)

Beskrivelse af containerformatet og komprimeringen, som bruges af `disk.4` i WHDLoad-sættet. Ingen originaldata er med her.

Der er to udpakkere. `tools/xpk_mash.py` er en Python-port af MASH-dekoderen i temisu/ancient (BSD-2-Clause, se `tools/LICENSE-ancient.txt`). `src/data/xpk-mash.ts` er en afgrænset TypeScript-oversættelse af samme kilde (`MASHDecompressor.cpp`, `XPKMain.cpp`) med BSD-2-Clause-attribution i filhovedet; se afsnittet "TypeScript-dekoder" nedenfor.

## XPKF-header (målt på disk.4)

- Bytes 0–3: signaturen `XPKF`.
- Bytes 4–7: pakket længde.
- Bytes 8–11: kompressionstype, her `MASH`.
- Bytes 12–15: rå (udpakket) længde. Den er big-endian.
- Bytes 16–31: de første 16 bytes af de rå data (initialpræfiks). ancient sammenligner dem med outputtet (`min(rå længde, 16)` bytes), når der verificeres.
- Byte 32: flag. Bit 0 angiver lange chunk-headere. Bit 1 angiver kodeord, og den slags filer afvises. Bit 2 angiver en udvidet header.
- Byte 33: header-checksum. XOR af de første 36 bytes er 0 (kravet er ancients `headerChecksum`; på disk.4 er byte 33 `$96`). Bytes 34–35 er reserverede (0 på disk.4).
- Headerlængden er 36 bytes uden udvidelse. Med udvidelse er den 38 + en 16-bit længde ved byte 36; udvidelsens indhold fortolkes ikke og er ikke dækket af header-checksummen.
- På disk.4 (målt): pakket-felt `$288` (+ 8 = 656 = filstørrelsen), rå længde `$F0000`, flag `$01`. De chunk-headere, der er læst i et hexdump, har rå længde `$10000`; 983 040 / 65 536 giver 15 chunks, efterfulgt af en slutchunk (`0F 0F` + nuller i filens sidste 12 bytes). Det præcise chunk-antal er ikke talt separat.

## Chunks

- Hver chunk har en 12-byte lang header: type (1 byte), header-checksum (1 byte; XOR af alle 12 bytes er 0), 16-bit data-checksum (big-endian), pakket længde (4 byte), rå længde (4 byte), og så data. Data er padded til 4 bytes. Layoutet er målt på disk.4 (første chunk: `01 CA 57 8E 00000013 00010000`) og stemmer med ancients `forEachChunk`.
- Data-checksummen er XOR over de pakkede databytes (uden padding), hvor bytes med lige indeks går i høj byte og bytes med ulige indeks i lav byte (`chunkChecksum` i ancient). ancient antager nul-padding; padding er nul på disk.4.
- Chunktype 0: rå data, kopieres direkte.
- Chunktype 1: MASH-komprimeret.
- Chunktype 15: slutmarkør (alle felter 0 på disk.4).
- MASH-chunks har ingen historik på tværs af chunks: ancients MASH-dekoder starter hver chunk på et nyt outputvindue, så en reference kan kun pege ind i samme chunk.

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
- Den udpakkede kopi har præcis 204 ikke-nul bytes, alle i 1 KiB-headerområdet ved byte-offset `$78000` (sektor `$3C0`). Alle bytes uden for dette område er nul.
- Området begynder med signaturen `UTOPSAVE`. Den indeholder ti 64-byte slots med navnet `EMPTY` og sektorpar. Det stemmer med headerens placering og layout i [game-proper.md](game-proper.md), afsnit 6; det er save-diskens header, ikke et ukendt grafik- eller kodeområde.
- Det observerede word ved header-offset 8 er 0. Det er ikke det disk-type-id, som loaderen returnerer: `$841E` afgør typen fra signaturen (`UTOPSCEN` -> 2, `UTOPSAVE` -> 1) og læser ikke word'et ved offset 8. Dermed er der ingen modstrid med slaveens disk-id 3, som bruges ved valg af filen Disk.4.
- Hele MASH-dekodningen er ikke krydstjekket mod en WinUAE-kørsel. Det er fortsat et åbent punkt. TypeScript-dekoderen sammenlignes kun med Python-portens output via den valgfrie lokale test (se nedenfor), ikke med en emulator.

## TypeScript-dekoder (IMPLEMENTERET; syntetiske tests, valgfri lokal golden-test)

`src/data/xpk-mash.ts` eksporterer `unpackXpkMash(bytes, { verifyPrefix? })`. Den er ren (bytes ind, bytes ud), kaster ikke for noget input og returnerer enten et komplet, valideret output eller en typet fejl (`code`, `message`, evt. `chunkIndex`); aldrig delvist output.

Understøttet: `XPKF` med kodeken `MASH`, lange chunk-headere, valgfri udvidet header (springes over), chunktype 0, 1 og 15. Afvist med eksplicit fejlkode: korte chunk-headere, kodeord, alle andre flagbits end 0–2, andre kodeker, andre chunktyper.

Validering (kilde: ancients `XPKMain` og MASH-dekoder; strengere steder er markeret):
- Længde ≥ 36, signatur, header-XOR = 0, kodek, flag, pakket-felt ≠ 0 og pakket + 8 = inputlængde (strengere end ancient, der tillader efterfølgende bytes), rå længde ≠ 0.
- Udvidet header: længdeord og indhold ligger inde i inputtet, og der er plads til mindst en chunk-header efter den.
- Hver chunk: header ligger inde i inputtet, header-XOR = 0, kendt type, data + padding ligger inde i inputtet, data-checksum (uden padding), padding er nul (strengere end ancient, der ikke kigger på padding), rå længde ≤ resterende output, ingen tomme chunks (ancient springer dem over), rå chunk: pakket = rå længde. Slutchunken skal have længder og checksum 0 og være de sidste 12 bytes (ancient kræver kun typen).
- Samlet output = headerens rå længde; initialpræfiks (bytes 16–31) = starten af outputtet (kan slås fra med `verifyPrefix: false`).
- Resultatet beskriver headerlængde, udvidelseslængde, om præfikset blev verificeret og hver chunk (type, headeroffset, pakket/rå længde, outputoffset).

Ressourcegrænser (implementationens egne sikkerhedsgrænser, ikke en del af XPK-formatet): input ≤ 2 MiB (`XPK_MAX_INPUT_BYTES`), output ≤ 1 MiB (`XPK_MAX_OUTPUT_BYTES`), højst 4096 chunk-headere inklusive slutchunken (`XPK_MAX_CHUNKS`). Outputtet allokeres først efter grænsekontrollen. disk.4 er 656 bytes pakket og 983 040 bytes udpakket, langt under grænserne.

MASH-dekoderen er en direkte oversættelse af Python-porten: MSB-først-bitlæser; literal-bytes læses direkte fra strømmen og rører ikke ved de allerede bufferede kontrolbits; tilbagereferencer kopieres byte for byte, så overlap gentager mønstret; historikken er pr. chunk. Reference-særheder, der bevares bevidst:
- Den sidste literal-/match-gruppe kan ende med en reserve-match med afstand 0, når outputtet er fyldt; den accepteres.
- Et match, der løber ud over chunkens slutning, klippes (ikke afvist). Afstanden valideres stadig (afstand > historik er en fejl, også ved antal 0).
- Unary-præfikset for udvidet literal-længde: 16 ettaller og et nul er en fejl (`mash-literal-length`), mens 17 ettaller ikke er det i referencen og så giver en enorm længde, som fanges som `mash-literal-overrun`. For match-længde er 15 ettaller og et nul en fejl (`mash-match-length`).
- Ubrugte bytes sidst i en chunks data accepteres (ancient kontrollerer det ikke).

Øvrige fejl: `mash-truncated` (input løber tør midt i kontrolbits eller literal-bytes), `mash-literal-overrun`, `mash-bad-distance` (0 før slutningen, eller længere end chunkens historik, herunder kryds-chunk-reference).

Evidens og test: `test/xpk-mash.mjs` bruger syntetiske containere og MASH-strømme, som testen selv koder (inkl. en håndbygget strøm, afstandsklasse-grænser, overlap, klip, kryds-chunk og fuzz uden undtagelser). Hvis `original/utopia-whdload/disk.4` og `original/extracted/disk4.bin` begge findes lokalt, sammenligner testen desuden TypeScript-udpakningen byte for byte med Python-outputtet og parser `UTOPSAVE`-headeren; ellers springes den del over. Verificeret 2026-11-06: `npm run build`, `node test/xpk-mash.mjs`, `node test/disk4.mjs` og `npm test` lykkedes; hele testkæden bestod med 822 `ok`-kontroller. Den lokale golden-sammenligning blev kørt (ikke sprunget over): den pakkede `disk.4` på 656 bytes blev udvidet identisk med Python-outputtet på 983.040 bytes, og save-headeren blev læst. Dekodningen er ikke koblet til spilstart, UI eller localStorage.

`parseDisk4Input(bytes)` i `src/data/disk4.ts` sammensætter dekoderen med den rå parser: input der starter med `XPKF` udpakkes og sendes til `parseDisk4`; alt andet går direkte til `parseDisk4`. Fejl rapporteres med fase (`decode` eller `disk4`). `parseDisk4` selv er stadig kun for rå billeder.

## Åbent

- Hvordan originalen opdaterer headerens slotnavne og sektorindhold ved save/load; den medfølgende Disk.4 har kun tomme slots. En enkelt hukommelsesaflæst gemning (Copperline, 2026-11-06, slot 0 `REFRUN`) er observeret, men blev ikke skrevet tilbage til værtsfilen og siger intet om XPK/MASH; se [game-proper.md](game-proper.md). MASH-dekodningen er stadig ikke krydstjekket mod en emulator.
- Ikke implementeret: gendannelse af et spil fra Disk.4, skrivning/eksport af Disk.4 (inkl. XPK-pakning), indlæsning af områderne i motoren, kobling til loader/UI, og kompatibilitet med spillets egen save-rutine. Remakens save/load bruger stadig localStorage. Der er ingen påstand om roundtrip-kompatibilitet; se [game-proper.md](game-proper.md), afsnit 6.
- Andre XPK-kodeker, korte chunk-headere, kodeordsbeskyttede filer og andre udgivelser er ikke understøttet og ikke testet.
