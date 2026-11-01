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

## disk.4 (656 bytes)

- Begynder med `XPKF`. Pakket med XPK-biblioteket, sub-bibliotek `MASH`.
- Længdefeltet i headeren angiver 648 bytes pakket data. Den udpakkede størrelse er ikke verificeret.
- Kan udpakkes med `xpkmaster.library` og `MASH`-sub-biblioteket. Der findes en kopi af `xpkmaster.library` og `xfdmaster.library` i `E:\Games\Emulator\Amiga\AmigaHardDisks\...\Libs\`. De er Amiga-biblioteker og kører ikke direkte på Windows.

**Udpakket (verificeret):** `tools/xpk_mash.py` er en Python-port af MASH-dekoderen i temisu/ancient (BSD-2-Clause, se `tools/LICENSE-ancient.txt`). Den udpakker disk.4 til præcis 983 040 bytes, som matcher headerens rå størrelse. Output ligger lokalt i `original/extracted/disk4.bin` (gitignored).

- 982 836 af de 983 040 bytes er 0x00.
- Der er ét område med data ved offset 0x078000 (480 KiB). Det spænder over 1 004 bytes, men kun 204 af dem er ikke-nul. Der er altså huller inde i området.
- De første bytes er ASCII-tekst, og resten er blandet. Teksten gengives ikke her. Der er ikke fundet en formatbeskrivelse endnu.
- Samme startadresse som tekstregionen i Disk.2, men det er et andet data-sæt.

**Konsekvens:** disk.4 er en sparsom buffer med én datablok. Næste skridt er at bestemme, hvad den 1 004 bytes store region er (tabel, kode eller grafik).

## Andre filer

- `Utopia.Slave`: WHDLoad-slaven. Indeholder konfiguration og filoffsets. Analyseres senere.
- `Hints`, `Introduction`, `Manual`, `ReadMe`: tekstfiler med Amiga-linjeskift og mellemrumsopfyldning. Kan vises direkte.
- `Utopia.info`, `*.info`: Amiga-ikonfiler, ikke nødvendige for motoren.

## Næste skridt

1. Decodér tekstdata i Disk.2 og verificér mod en WinUAE-kørsel.
2. Find sporlayoutet i Disk.1 med RawDIC, eller udtræk sporene i WinUAE.
3. Pak disk.4 ud i WinUAE ved at køre spillet og tage et hukommelsesdump, eller skriv en MASH-decoder.

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
