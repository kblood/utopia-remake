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

## Utopia.Slave

- Indeholder strenge for `Utopia`, `1991 Gremlin` og WHDLoad-versionen `1.2`.
- Refererer til filnavnet `Disk.4`, så spillet indlæser disk.4 som en fil.

## disk.4 (656 bytes)

- Begynder med `XPKF`. Pakket med XPK-biblioteket, sub-bibliotek `MASH`.
- Længdefeltet i headeren angiver 648 bytes pakket data. Den udpakkede størrelse er ikke verificeret.
- Kan udpakkes med `xpkmaster.library` og `MASH`-sub-biblioteket. Der findes en kopi af `xpkmaster.library` og `xfdmaster.library` i `E:\Games\Emulator\Amiga\AmigaHardDisks\...\Libs\`. De er Amiga-biblioteker og kører ikke direkte på Windows.

**Konsekvens:** Udpakning kræver enten en Amiga-kørsel i WinUAE eller en Python-implementering af MASH-formatet. Det er ikke gjort endnu.

## Andre filer

- `Utopia.Slave`: WHDLoad-slaven. Indeholder konfiguration og filoffsets. Analyseres senere.
- `Hints`, `Introduction`, `Manual`, `ReadMe`: tekstfiler med Amiga-linjeskift og mellemrumsopfyldning. Kan vises direkte.
- `Utopia.info`, `*.info`: Amiga-ikonfiler, ikke nødvendige for motoren.

## Næste skridt

1. Decodér tekstdata i Disk.2 og verificér mod en WinUAE-kørsel.
2. Find sporlayoutet i Disk.1 med RawDIC, eller udtræk sporene i WinUAE.
3. Pak disk.4 ud i WinUAE ved at køre spillet og tage et hukommelsesdump, eller skriv en MASH-decoder.
