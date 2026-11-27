# Utopia – diskformater (WHDLoad 1.2 / 0757)

Observationer fra filerne i `original/utopia-whdload/`. Mappen er gitignored. Der er ingen spildata i denne fil, og tekstuddrag fra spillet er bevidst udeladt.

## Disk.1 (970 752 bytes)

- Begynder med `DOS\0`, så det er en boot block med AmigaDOS-signatur.
- Størrelsen passer ikke til en standard DD-ADF (901 120 bytes) eller HD-ADF (1 802 240 bytes).
- Ingen rod-blok (type 2, sec_type 1) findes på 512-byte-grænser. Diskens filsystem er derfor ikke standard OFS/FFS. Sandsynligvis bruger spillet en egen læseroutine med ikke-standard spor.
- Indeholder læsbare tekststrenge, der ligner assembler-kommentarer. Det tyder på, at kildekode- eller debug-tekst er efterladt i det binære data.

**Konsekvens:** `amitools`/`xdftool` kan ikke åbne Disk.1 som standard. Næste skridt er at læse sporene direkte (track-for-track) eller at bruge WHDLoads RawDIC-dataformat.

## Disk.2 (983 040 bytes)

- Begynder ikke med en gyldig AmigaDOS-header.
- Indeholder mange læsbare tekstblokke, bl.a. narrativ tekst og tekst-kodning med gentagne sekvenser. Det er sandsynligvis spilledata (tekst) og ikke kode.
- Ingen rod-blok fundet.

**Konsekvens:** Tekstdata kan udtrækkes direkte, når tekstkodningen er forstået. Det er en god første decoder at skrive.

### Disk.2 – regioner (målt, ingen tekst gengivet)

- 476–480 KiB: almindelig ASCII-tekst (ca. 95 % udskrivbare tegn, ingen høje bit).
- 724–792 KiB: almindelig ASCII-tekst, afbrudt af 0x00-bytes som linjeskift/separator.
- 816–960 KiB: gentaget fyldmønster, ingen tekst.
- Øvrige områder: binært indhold, ikke undersøgt.

Tekstregionerne er udtrukket lokalt til `original/extracted/disk2-text-regions.txt` (gitignored).

## Inputgrænse: genkendelse og validering (IMPLEMENTED, kun syntetiske tests)

Tre adskilte niveauer. Kun den understøttede WHDLoad 1.2 (0757)-profil er implementeret; ADF/HDF/IPF og andre udgaver afvises.

- **Genkendelse** (`src/data/detect.ts`): kun filnavne (versalfølsomhed ignoreres) og størrelser: `Disk.1` 970 752, `Disk.2` 983 040, `Utopia.Slave` 1 264. `disk.4` er valgfri og uden størrelseskrav (WHDLoad udvider seed-filen, og spillet starter uden den). Den tidligere kontrol, der krævede `disk.4`, var i modstrid med `src/main.ts` og er fjernet.
- **Valideret ressourcetilgængelighed** (`src/data/profile-input.ts`, `src/startup.ts`): de indlæste bytes kontrolleres, før lyd og `Game` oprettes. `Disk.1` skal begynde med `DOS\0`. `Disk.2` skal være mindst `$3C2` sektorer, have magic `UTOPSCEN` ved sektor `$3C0`, og alle ti scenarieposters sprites-, tile-, descriptor-, map-, block-, intel- og fire tekstområder skal have `first <= last` og slutte inden for filen. Fejl returneres som typede, handlingsbare `InputError`s uden at kaste. Kontrollen læser kun filens egne bytes ved kørsel; intet indhold eller nogen hash gemmes. Ikke kontrolleret: Disk.1's interne sektortabeller og indholdet af områderne. Områdegrænsen kommer fra de verificerede loader-noter (`game-proper.md`, afsnit 6). Et område med `last < first` afvises som korrupt; hvis en ægte kopi viser sig at bruge sådan en tom post, skal reglen lempes efter en emulatorobservation.
- **Bevist kørselskompatibilitet**: ikke opnået ved nogen af kontrollerne. En bestået validering siger kun, at de deklarerede ressourcer findes og er i bounds.
- ADF A og ADF B er stadig ikke accepteret som input. `Disk.1`/`Disk.2`-layouts er ikke lempet; ADF A's kode er pakket og fra en anden version (se afsnittet om ADF-parret nedenfor).

## Originale ADF-filer (rå sektorsammenligning)

De to ADF-filer, der er listet i README, er hver 901 120 bytes (1 760 sektorer). De er ikke standard OFS/FFS-volumener, som `amitools/xdftool` kan mounte (`Utopia-a.adf`: ugyldig root block; `Utopia-b.adf`: ugyldig boot block). De indeholder dog rå sektorindhold.

- ADF B er byte-for-byte identisk med de første 1 760 sektorer af WHDLoad `Disk.2`; WHDLoad-filen har yderligere 80 KiB.
- Verificeret mod den lokale ADF B og parseren: alle ti scenariers registrerede sprites-, tile-, descriptor-, map-, parameter-, intelligence- og tekstområder slutter senest ved sektor 1 588. De ligger dermed inden for ADF B's 1 760 sektorer; ingen af de deklarerede scenarioranges kræver WHDLoad-filen's sidste 160 sektorer.
- Exhaustive sector comparison within ADF A's length: it differs from WHDLoad `Disk.1` only in sectors `$000-$059` and `$14C-$208` (279 sectors total). The whole game-image region `$14C-$208` differs; 94 542 of its 96 768 bytes differ. The intervening sectors `$05A-$14B` and all other shared sectors match byte for byte.
- Se det næste afsnit: data efter ADF A's slutning er flyttet, og koden er pakket.

## ADF pair: relocated and packed data (2026-11-26)

Reproduce with `python tools/adf_compare.py <Utopia-a.adf> <Utopia-b.adf>` (read only). This replaces the earlier reading that data past the end of ADF A is missing: the sector-by-sector comparison below only compared equal offsets.

VERIFIED (byte comparison and unpacking of the local files):

- ADF B equals `Disk.2` sectors `$000-$6DF`. The remaining 160 sectors of `Disk.2` are a four-byte filler pattern, so ADF B holds all of `Disk.2`'s data.
- ADF A `$05A-$14B` and `$209-$6DF` equal `Disk.1` at the same sectors.
- The `Disk.1` data that lies past the end of an ADF is stored near the start of ADF A:

| `Disk.1` sectors | Content | ADF A sectors | Check |
|---|---|---|---|
| `$6E0-$6EB` | music 3, tail | `$007-$012` | identical bytes |
| `$6EC-$707` | German strings | `$013-$02E` | identical bytes |
| `$70A-$728` | title picture (packed) | `$031-$04E` | packed differently; 72 of 40,064 unpacked bytes differ |
| `$729-$733` | logo picture (packed) | `$04F-$059` | identical unpacked |

- The two code blocks are packed. Each starts with an unpacker stub whose stream header (packed length, unpacked length, XOR checksum) is `$10C` bytes into the sector; the data is read backwards (ByteKiller layout, identified from the traced stub). Both checksums close:
  - game program: sector `$14C`, 56,380 bytes to 96,768 bytes (the size of `Disk.1` `$14C-$208`);
  - boot stage: sector `$1BB`, 16,360 bytes to 24,576 bytes.
- The stub at sector `$14C` carries a cracking group's signature (Fairlight, 1991), so ADF A is a cracked copy. The ADF A boot block loads further code from sectors `$1BB-$202`.

HYPOTHESIS (strong, static only): ADF A's code is the second game version that `Utopia.Slave` supports (boot-block CRC `$5E14`), with the crack's changes on top.

- At ADF boot address `$78C8A` the unpacked code has the same eight bytes as the `$D9C1` version at `$78C70`; these are the slave's two code-check patch addresses.
- At `$7886C` (the `$5E14` patch address) the unpacked code holds NOPs, and at `$789BE` the final jump is redirected to `$E00`.
- The CRC itself was not reproduced, because the crack changed the block.
- Aligned against `Disk.1`, 84.6% of the game program lies in identical runs of 8 bytes or more at shifted positions (65.2% with 24 bytes or more). The remaining differences were not classified.

VERIFIED (2026-11-26, unpacked comparison): the unpacked game program differs from `Disk.1` `$14C-$208` in 72,097 of 96,768 bytes, and the unpacked boot stage differs from `Disk.1` `$3000` in 20,681 of 24,576 bytes. These are not patch-sized differences, so ADF A is a different build, not `Disk.1` with a few changes. Rebuilding a `Disk.1`-shaped image from the ADFs would therefore not reproduce the WHDLoad game and would break the engine's fixed table addresses silently.

The IPF images `Utopia-TheCreationofaNation_757.zip` and `_758.zip` contain `Utopia_Disk1.ipf` and `Utopia_Disk2.ipf` (CAPS container). No IPF decoder is installed here, and none was written.

Consequence: ADF A and B together appear to hold all the data the engine reads. Support would need the relocation table above, the unpacker, and a per-version map for every table the engine reads from the boot stage and the game program, whose addresses differ. Not implemented. The IPF images listed in `README.md` have not been examined.

## Leftover data on `Disk.1` (2026-11-26)

VERIFIED: `Disk.1` has no AmigaDOS root, directory or file-header block with a valid checksum at any 4-byte offset (ADF A and B have none either). Sectors `$003-$007` are five OFS data blocks with valid checksums (blocks 40-44 of a file whose header is absent) containing a fragment of commented 68000 assembly source. Sector 8 starts with a small hunk executable header. The game is not known to read either; the source text is not reproduced here.

### Disk.2 – entropikort (målt, pr. 8 000-byte blok)

Blokken er valgt, fordi en bitplan i Utopias billedformat fylder 8 000 bytes. Kortet er en klassificering og ikke en dekodning.

- Store områder er "sparse", med over 50 % nul-bytes. Det passer til komprimerede eller spredte billeddata.
- Nogle områder er "mixed" med høj entropi (5–6 bit pr. byte). Det kan være komprimerede data.
- Der er to områder med ren tekst, ved ca. `0x0B5A40`–`0x0C3500` og `0x0C3500`–`0x0C5440`.
- Fra ca. `0x0CD140` og frem er der områder, der består af et fyldmønster med fire ASCII-bytes, som gentages med periode 4. Det er fyld og ikke billeddata. Den tidligere fortolkning med to byteværdier var forkert.
- Hverken komprimeringsformatet eller billedformatet er identificeret. Der er ingen gyldig MASH-header i Disk.2.

**Konsekvens:** Disk.2 er ikke et simpelt billedlager. Billederne er enten komprimerede eller ligger i et format, der kræver at vi følger loaderen.

## HD-installationer (sjekket)

- `AmigaHardDisks\CaldorsHD`, `ClassicWBHD` og `Extra\CaldorHDBackup` indeholder kun `igame.iff` (20 574 bytes) i `Games\U\Utopia`. Det er ikke spildata, så der er ingen udpakket Disk.1 eller disk.4 at hente der.
- `WHDLoad v0001\Games_WHDLoad\Utopia` er samme sæt som `original/utopia-whdload/`. Filstørrelserne matcher.

**Konsekvens:** Der findes ingen udpakket kopi af disk.4 eller Disk.1 på disken. Udpakning skal derfor ske via emulator eller ved en decoder.

## Disk.1 boot-kode (disassembleret, kun strukturen)

- Koden starter ved offset 12 i boot-blokken. Offset 0 indeholder `DOS\0` og er ikke kode.
- Første 1 024 bytes giver 267 instruktioner. De består mest af `move.w`, `bsr.w`, `lea` og `rts`.
- Kalder absolutte adresser `$058000` og `$077F18`. Den sidste ligger lige under `0x078000`, hvor disk.4-dataregionen starter.
- Skriver `$4489` til `$7e(a6)`. Hvis a6 peger på `$DFF000`, er det DSKSYNC-registeret. Spillet læser altså spor rå via diskettecontrolleren med standard MFM-sync, og ikke via AmigaDOS.

- Længere inde i koden (under 0x800) sættes DSKPTH (`$20`), DSKLEN (`$24`), DSKSYNC (`$7e`), ADKCON (`$9e`) og INTREQ (`$9c`). DSKLEN-værdien `$980c` angiver en rå læsning på 0x180C ord (6 156 ord, ca. 12,3 KB). Det er tæt på en standard Amiga-spor-læsning, men ikke identisk.

**Konsekvens:** Læsningen af spor er et eget loader-system. Hele layoutet kan ikke rekonstrueres uden at følge loaderen. Det er en stærk kandidat til et manuelt hukommelsesdump i WinUAE.

## Spor-hypotese (målt, ikke bekræftet)

- Disk.1 er 158 spor × 6 144 bytes, og Disk.2 er 160 spor × 6 144 bytes. Begge er præcis delelige.
- 6 144 bytes = 12 sektorer à 512 bytes pr. spor. Det er ikke standard Amiga-DD (11 sektorer), så spillet bruger sandsynligvis et eget spor-layout.
- Disk.1 har ét helt nul-spor. Disk.2 har ingen. Der er 28 nul-sektorer i Disk.1 og 3 i Disk.2.
- Hypotesen skal bekræftes. Spor-starterne har ingen fælles header (147 forskellige 4-byte-starter i Disk.1 af 158 spor), og der er ingen 0x4489-markører pr. spor. Layoutet er altså ikke et simpelt sektor-format.

## Utopia.Slave

- Er en HUNK-fil med én kodesektion på 1 228 bytes. Det er en WHDLoad-slave med standardheaderen `WHDLOADS` ved kodeoffset 4. Kodeoffset 0 er den sædvanlige kontrol `moveq #-1,d0` / `rts`, og den er ikke spilkode.
- Indeholder strenge for `Utopia`, `1991 Gremlin` og WHDLoad-versionen `1.2`.
- Refererer til filnavnet `Disk.4`, så spillet indlæser disk.4 som en fil.

### Kald til WHDLoad (målt)

Slaven kalder WHDLoads `resload`-funktioner via en basepointer i BSS. Kaldene er `jsr d16(a6)`.

- Offset `$28` er `resload_DiskLoad` (identificeret ved at sammenligne med WHDLoad-autodoc: d0 offset, d1 størrelse, d2 disknummer, a0 destination). Den tager destination i `a0`, startoffset i `d0`, længde i `d1` og disknummer i `d2`. Hovedkaldet læser offset `$3000`, længde `$7800`, disk 1, til destination `$077F18`.
- Offset `$30` er `resload_CRC16` (d0 længde, a0 adresse, jf. WHDLoad-autodoc). Den kaldes på bufferen ved `$077F18` med længden `$7800`. Resultatet sammenlignes med to kendte værdier, og en forkert værdi fører til en afslutningssti.
- Offset `$34` er sandsynligvis `resload_Control` (a0 peger på en tag-liste). Der er to kald, ved filoffset `$0A6` og `$39A`. Ved `$39A` sættes `a0 = a7`, og et værdi-ord bygges på stakken først (`$77FFFFFA` negeret til `$88000005`). Ved `$0A6` er a0-opsætningen ikke fanget af disassembleringen. Funktionsnavnet er sandsynligt, men ikke verificeret: WHDLoad.i-konstanterne kunne ikke hentes.
- Offset `$38` er `resload_LoadFileOffset`: navn i `a0` (strengen `Disk.4` ved kodeoffset `$4E4`), destination i `a1`, offset i `d0` og længde i `d1`. Retningen er indlæsning, ikke skrivning, fordi spillet ikke skriver til `Disk.4`. Rutinen ved `$0486` har ingen direkte kald (`bsr`), så der er ikke fundet hvem der kalder den.
- Offset `$20` er sandsynligvis `resload_FlushCache` (filoffset `$4B8`). Kaldet er uden argumenter og omgivet af `movem`-gem/gendan, og der er ingen argumentopsætning før det. Sandsynligt, ikke verificeret: WHDLoad.i-konstanterne kunne ikke hentes.
- Navnene `$20`, `$34` og `$38` er afledt af tabellen i Ghidra-loaderen [ResidentLoader.java](https://github.com/apparentlymart/ghidra-amiga-whdload/blob/master/src/main/java/structs/ResidentLoader.java). Den har fire byte pr. indgang. Indgangene `$28` (DiskLoad) og `$30` (CRC16) stemmer med den, men tabelrækkefølgen for indgang 14 og frem er ikke pålidelig. Her placerer den `SaveFileOffset` på `$38`, hvilket ikke passer med indlæsningskaldet. Derfor er `$38` identificeret ud fra kaldets adfærd og ikke ud fra tabellen.
- En wrapper kaldes med et interval af byte-offsets og skifter dem med 7 bit (divideres med 128) før kaldet. Den kan vælge disk 1–3 via et flag. Det er flere disk-læsninger end hovedkaldet.

### Konsekvens for layoutet (målt, ikke bekræftet)

- Offset `$3000` er 12 288 bytes = 2 × 6 144, og længden `$7800` er 30 720 bytes = 5 × 6 144. Det passer til sporhypotesen om 6 144 bytes pr. spor, hvor spillet læser spor 2–6 af Disk.1.
- Verificeret: CRC-16/ARC (polynomium $8005, reflekteret, start 0) af de 0x7800 bytes i Disk.1 fra offset `$3000` giver `$D9C1`, som er den første værdi slaven tjekker imod. Bufferen er altså en lineær kopi af filen fra byte-offset `$3000`, uden sektorhoveder i det område.
- Bufferen starter med en hopinstruktion til `$078550`. Derfra dekodes mindst 400 instruktioner i træk uden fejl. Startsekvensen sætter stakken op og kalder underrutiner. Det er spillets egen kode, ikke data.
- Rutinen ved `$078DE4` opsætter skærmen. Den sætter 5 bitplaner i lowres (BPLCON0 `$5200`), DIW-start `$2C83` og stop `$2CBF`, DDF-start `$30` og stop `$D0`, og nulstiller BPLCON1/2. Det er et standard 320×256 PAL-billede.
- Rutinen ved `$078EBE` peger copperen på en kopilist (COP1LC). Kopilisten ligger ved `$079232` og er et kort program uden waits: 19 MOVE-instruktioner. Den sætter BPLCON0 `$5200` og fem bitplane-pointere, BPL1–5 ved `$068158`, `$06A098`, `$06BFD8`, `$06DF18` og `$06FE58`. Planerne ligger 8 000 bytes fra hinanden (40 bytes × 200 linjer), altså 5 planer × 8 000 bytes.
- Rutinen ved `$078CAA` fylder 40 000 bytes fra `$068158` med et 40-bytes mønster hentet fra `$0791D2`. Det er en tom baggrund før billedet tegnes.
- Rutinen ved `$078E4C` installerer et VBLANK-interrupt på `$078F40` (vektor `$6C`) og aktiverer interruptet. Den er spillets frame-loop.
- Billedets pixeldata kommer ikke fra Disk.1's kodeområde. Den skal indlæses fra en anden disk-læsning, og den er endnu ikke fundet statisk.
- Rutinen ved `$077F32` er den, som slaven patcher til `rts`, så den er ikke en del af spillets skærmvisning.
- Hele bufferen er blandet: ca. 7 000 bytes dekoder som gyldig kode, og resten er tabeller eller data. Den nøjagtige grænse er ikke kortlagt.
- Destinationen `$077F18` er den samme som boot-kodens kald til `$077F18` i Disk.1. Slaven og boot-koden indlæser altså samme kode.
- Efter indlæsningen skriver slaven patches (16- og 32-bit) til adresser i og omkring det indlæste område og til lavt RAM. Det er rettelser af kode og ikke data.

### Slave patches of the verified CRC path (VERIFIED, static, 2026-11-10)

The slave's code (hunk code of `Utopia.Slave`, disassembled with capstone) branches on the CRC16 of the boot-stage block at `$77F18`: `$D9C1` (this profile) or `$5E14`. The `$D9C1` path writes, before the boot stage runs:

- `move.l #$00080000,$904`: the boot stage reads `$904` (`tst.l`) and draws "EXPANSION MEMORY DETECTED." when it is not zero (`graphics-and-music-blocks.md`, text step G). No boot-image code writes `$904`.
- `move.b #$32,$910`: the boot stage's tick-skip flag (`graphics-and-music-blocks.md`, the player).
- `move.w #$4E71,$78C70` (NOP) and `move.w #$6022,$78856` (`bra.b` +$22 to `$7887A`): the code check's empty-entry test is removed and its compare branch is unconditional, so every typed number reaches the success path (`text.md`, step E).
- `move.w #$4E75,$77F32` (`rts`), `move.w #$4EB9/$4EF9` jumps to slave routines for the loader (`$77F84` -> `$42A`, the resload disk read) and the final jump (`$789A4` -> `$1A0`, which patches the game proper and then jumps to `$1000`).

The `$D9C1` path also writes patches to the game proper (`$1E6E`, `$7D88`, `$93F8`, ...). These are not traced here. The `$5E14` path writes the same code-check patch at `$7886C`/`$78C8A` and `$789BE`. The remake implements step E under the `$D9C1` profile only.

## disk.4 (656 bytes)

- Begynder med `XPKF`. Pakket med XPK-biblioteket, sub-bibliotek `MASH`.
- Længdefeltet i headeren angiver 648 bytes pakket data. Den udpakkede størrelse er ikke verificeret.
- Kan udpakkes med `xpkmaster.library` og `MASH`-sub-biblioteket. Der findes en kopi af `xpkmaster.library` og `xfdmaster.library` i `E:\Games\Emulator\Amiga\AmigaHardDisks\...\Libs\`. De er Amiga-biblioteker og kører ikke direkte på Windows.

**Udpakket (verificeret):** `tools/xpk_mash.py` er en Python-port af MASH-dekoderen i temisu/ancient (BSD-2-Clause, se `tools/LICENSE-ancient.txt`). Den udpakker disk.4 til præcis 983 040 bytes, som matcher headerens rå størrelse. Output ligger lokalt i `original/extracted/disk4.bin` (gitignored).

- 982 836 af de 983 040 bytes er 0x00.
- Der er ét område med data ved offset 0x078000 (480 KiB). Det spænder over 1 004 bytes, men kun 204 af dem er ikke-nul. Der er altså huller inde i området.
- De første bytes er ASCII-tekst, og resten er blandet. Teksten gengives ikke her. Der er ikke fundet en formatbeskrivelse endnu.
- Samme startadresse som tekstregionen i Disk.2, men det er et andet data-sæt.

**Konsekvens:** XPK/MASH-dekomprimeringen virker, men betydningen af den sparse region på 1 004 bytes er stadig ukendt. Den dokumenterede spil-save bruger Disk.4 som sektorområde (se `game-proper.md`, afsnit 6); den lille XPK-fil ser derfor ikke ud til at indeholde selve save-slots. Præciseret: den region er save-diskens `UTOPSAVE`-header (se `xpk-mash.md`), så "ukendt" gælder ikke længere selve headeren. `src/data/disk4.ts` parser en allerede udpakket rå Disk.4-header og udleverer områderne A/B for udfyldte slots (syntetiske tests; `src/data/xpk-mash.ts` udpakker nu MASH-frøet i TypeScript, og `parseDisk4Input` sammensætter de to, men intet af det er koblet til loaderen, og der er ingen skrivning). Et første gendannelsesfundament (`src/game/disk4-load.ts`, `GameState.fromSnapshot`, `World.fromSnapshot`; kun syntetiske tests) kan bygge en ny tilstand og verden bytte-for-bytte fra en slots område B, kort, celleflag og objektposter med eksplicit scenarieindeks; enheder, skibe og fjender gendannes ikke, og det er ikke koblet til spillet, så der er ingen fuld gendannelse. Remakens save/load bruger stadig browserens localStorage og er ikke kompatibel med Disk.4.

## Andre filer

- `Utopia.Slave`: WHDLoad-slaven. Indeholder konfiguration og filoffsets. Analyseres senere.
- `Hints`, `Introduction`, `Manual`, `ReadMe`: tekstfiler med Amiga-linjeskift og mellemrumsopfyldning. Kan vises direkte.
- `Utopia.info`, `*.info`: Amiga-ikonfiler, ikke nødvendige for motoren.

## Næste skridt

1. (Delvist løst) Den sparse region er `UTOPSAVE`-headeren; hvad originalen skriver i slotnavne og områder ved save er stadig uverificeret mod en kørsel.
2. Undersøg Disk.4 save-slot dataenes faktiske opbygning og skriveforløb mod originalen, før der implementeres gendannelse/eksport. Headerparseren i `src/data/disk4.ts` dækker kun et udpakket råt billede (`parseDisk4`); `parseDisk4Input` udpakker først XPK/MASH-frøet.
3. ADF/IPF-mounting og kompatibilitet med andre udgivelser er ikke implementeret i browsermotoren.

## Table locations by content (2026-11-26)

Code: `src/data/locate.ts` (pattern search, `??` wildcards, unique match only) and `src/data/anchors.ts` (content lookup). Test: `test/locate.mjs`.

VERIFIED: for eight tables the engine reads from the game program, the first 16 bytes occur exactly once in the WHDLoad program image and exactly once in the unpacked ADF A game program:

| Table | WHDLoad address | ADF A address |
|---|---|---|
| flag table | $16408 | $163F4 |
| weights | $B0EC | $B0D4 |
| inventions | $B1CC | $B1B4 |
| music labels | $1530 | $15C8 |
| font character table | $62D8 | $636A |
| font glyphs | $6354 | $63E6 |
| money template | $2F48 | $2FF4 |
| title template | $6532 | $65C4 |

- The shifts differ per table (from -$18 to +$98), so the tables were moved one by one, not by one global offset.
- A matching 16-byte run shows identical data, not identical code that reads it. Each table still needs its reader checked against the ADF build.
- The reference bytes come from the user's own WHDLoad file at run time; no game bytes are stored in the repository.


## Reference run: WHDLoad boot tree (verified)

A WinUAE 6.0.3 run reaches the game's title screen with the user's own WHDLoad data.

- Boot volume layout (host folder mounted read-only as a bootable volume): `C/WHDLoad`, `C/Assign`, `Libs/xpkmaster.library`, `S/Startup-Sequence`, and the game folder holding `Utopia.Slave`, `Disk.1`, `Disk.2`, `disk.4`.
- Startup-Sequence: `Assign LIBS: <vol>:Libs ADD`, then `CD <vol>:Utopia`, then `<vol>:C/WHDLoad Utopia.Slave`.
- WHDLoad reads `Disk.N` relative to the current directory. Starting it from the volume root gave DOS error #205 on `Disk.1`. Changing into the game folder first fixed it.
- `disk.4` is XPK-packed, so `xpkmaster.library` v4 must be reachable through `LIBS:`.
- Kickstart 3.1 (A1200), 2 MB chip + 4 MB fast. With 1 MB chip and no fast RAM WHDLoad stops with DOS error #103.
- After the WHDLoad nag window, the title picture appears with the version and copyright lines.
- Other HD setups in the user's collection keep WHDLoad in `C:`, the game folder beside its `.slave`, and use the system `SYS:Libs` as `LIBS:`.
- With WHDLoad 20.1 and the owner's `S:WHDLoad.key` in the boot volume, the nag window no longer appears and the title screen is up about 25 s after Start. Older 18.x binaries without the key show the "not registered" window first.

## Rettelse: resload `$38`

Spillets egentlige program (se `game-proper.md`) skriver sin gemte tilstand til `Disk.4`, og Ghidra-tabellen placerer `SaveFileOffset` på `$38`. Derfor er `$38` `resload_SaveFileOffset` (skrivning), ikke en indlæsning. Afsnittet ovenfor, der kalder den `LoadFileOffset`, er forkert.
