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

## HD-installationer (sjekket)

- `AmigaHardDisks\CaldorsHD`, `ClassicWBHD` og `Extra\CaldorHDBackup` indeholder kun `igame.iff` (20 574 bytes) i `Games\U\Utopia`. Det er ikke spildata, så der er ingen udpakket Disk.1 eller disk.4 at hente der.
- `WHDLoad v0001\Games_WHDLoad\Utopia` er samme sæt som `original/utopia-whdload/`. Filstørrelserne matcher.

**Konsekvens:** Der findes ingen udpakket kopi af disk.4 eller Disk.1 på disken. Udpakning skal derfor ske via emulator eller ved en decoder.

## Disk.1 boot-kode (disassembleret, kun strukturen)

- Koden starter ved offset 12 i boot-blokken. Offset 0 indeholder `DOS\0` og er ikke kode.
- Første 1 024 bytes giver 267 instruktioner. De består mest af `move.w`, `bsr.w`, `lea` og `rts`.
- Kalder absolutte adresser `$058000` og `$077F18`. Den sidste ligger lige under `0x078000`, hvor disk.4-dataregionen starter.
- Skriver `$4489` til `$7e(a6)`. Hvis a6 peger på `$DFF000`, er det DSKSYNC-registeret. Spillet læser altså spor rå via diskettecontrolleren med standard MFM-sync, og ikke via AmigaDOS.

**Konsekvens:** Læsningen af spor er et eget loader-system. Hele layoutet kan ikke rekonstrueres uden at følge loaderen. Det er en stærk kandidat til et manuelt hukommelsesdump i WinUAE.

## Spor-hypotese (målt, ikke bekræftet)

- Disk.1 er 158 spor × 6 144 bytes, og Disk.2 er 160 spor × 6 144 bytes. Begge er præcis delelige.
- 6 144 bytes = 12 sektorer à 512 bytes pr. spor. Det er ikke standard Amiga-DD (11 sektorer), så spillet bruger sandsynligvis et eget spor-layout.
- Disk.1 har ét helt nul-spor. Disk.2 har ingen. Der er 28 nul-sektorer i Disk.1 og 3 i Disk.2.
- Hypotesen skal bekræftes. Spor-starterne har ingen fælles header (147 forskellige 4-byte-starter i Disk.1 af 158 spor), og der er ingen 0x4489-markører pr. spor. Layoutet er altså ikke et simpelt sektor-format.

## Utopia.Slave

- Indeholder strenge for `Utopia`, `1991 Gremlin` og WHDLoad-versionen `1.2`.
- Refererer til filnavnet `Disk.4`, så spillet indlæser disk.4 som en fil.

## disk.4 (656 bytes)

- Begynder med `XPKF`. Pakket med XPK-biblioteket, sub-bibliotek `MASH`.
- Længdefeltet i headeren angiver 648 bytes pakket data. Den udpakkede størrelse er ikke verificeret.
- Kan udpakkes med `xpkmaster.library` og `MASH`-sub-biblioteket. Der findes en kopi af `xpkmaster.library` og `xfdmaster.library` i `E:\Games\Emulator\Amiga\AmigaHardDisks\...\Libs\`. De er Amiga-biblioteker og kører ikke direkte på Windows.

**Udpakket (verificeret):** `tools/xpk_mash.py` er en Python-port af MASH-dekoderen i temisu/ancient (BSD-2-Clause, se `tools/LICENSE-ancient.txt`). Den udpakker disk.4 til præcis 983 040 bytes, som matcher headerens rå størrelse. Output ligger lokalt i `original/extracted/disk4.bin` (gitignored).

- 982 836 af de 983 040 bytes er 0x00.
- Der er én sammenhængende region med data på 1 004 bytes ved offset 0x078000 (480 KiB). Den er ikke analyseret endnu.
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
