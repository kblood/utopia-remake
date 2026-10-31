# Arkitektur – Utopia-motor

Målet er en motor i stil med ScummVM. Motoren er open source og indeholder ingen spildata. Brugeren leverer selv sine originale filer, og motoren læser dem ved opstart.

## Princip

1. **Motoren** (denne repo) indeholder kun egen kode: loaders, decodere, spillogik og renderer.
2. **Originaldata** leveres af brugeren fra egen kopi af spillet (ADF/WHDLoad-filer). Dataene ligger i en lokal mappe, fx `original/`, som er gitignored.
3. Ved start scanner motoren mappen, genkender filerne ud fra størrelse, checksum og indhold, og vælger den rigtige dataprofil.
4. Ingen originale filer committes, udgives eller indlejres i build-output.

## Lag

| Lag | Ansvar | Kilde |
|---|---|---|
| `io/` | Læser diskbilleder og filsystemer (AmigaDOS OFS/FFS). Udpakning af XPK/PowerPacker-pakket data | Egen kode |
| `formats/` | Decodere for grafik (bitplanes), tiles, kort, lyd og tekst | Egen kode, baseret på observation |
| `detect/` | Genkender spilversion ud fra filstørrelser og hashes. Ingen hashes af originalt indhold committes | Egen kode |
| `game/` | Spillogik: kort, økonomi, AI-ture, tilstande | Clean-room-specifikation i `notes/` |
| `render/` | Canvas 2D-renderer med 320×256-buffer og Amiga-lignende palet | Egen kode |
| `audio/` | Afspilning af decodet musik og effekter | Egen kode |
| `ui/` | Menu, input, skalering | Egen kode |

## Arbejdsgang for et nyt dataformat

1. Find filen og dens format i `original/` (magic bytes, størrelse, struktur).
2. Skriv en decoder i `formats/`, der kan køre på originalfilen lokalt.
3. Verificér decoderen mod en emulatorkørsel (WinUAE eller Copperline). Skærmbilleder eller hukommelsesdumps er referencen.
4. Dokumentér formatet i `notes/formats/<navn>.md` med observationer, ikke med kopieret kode.
5. Tilføj en test, der kører på den lokale fil, hvis den findes. Testen springes over, hvis filen mangler.

## Kendte filer i Utopia (WHDLoad 1.2 / 0757)

- `Disk.1` (970 752 bytes) begynder med `DOS\0`, så det er et AmigaDOS-filsystem. Størrelsen passer ikke til en standard ADF, så den skal analyseres.
- `Disk.2` (983 040 bytes) har ingen gyldig header i starten. Indholdet er ukendt.
- `disk.4` (656 bytes) begynder med `XPKF`, så det er XPK-pakket. Udpakning kræver xfdmaster eller en tilsvarende decoder.
- `Utopia.Slave` er WHDLoad-slaven. Den viser, hvordan spillet indlæser sine egne filer, og er en god kilde til filnavne og offsets.
- `Hints`, `Introduction`, `Manual` og `ReadMe` er tekstfiler.

## Åbne spørgsmål

- Hvordan udpakkes `Disk.1` korrekt? amitools kan ikke åbne den som standard ADF, så filsystemet skal analyseres i detaljer.
- Hvilken lyd- og grafikstruktur bruger spillet? Det kræver analyse af de udpakkede filer.
- Hvilke dele af spillogikken skal specificeres først?
