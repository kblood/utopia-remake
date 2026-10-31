# Utopia – decompile og genskabning

## Mål

Dekompilere Amiga-spillet **Utopia** (*Utopia: The Creation of a Nation*) og bruge det til at genskabe spillet i en ny implementering. Første platform er endnu ikke valgt. Udgangspunktet er en webbrowser, fordi tidligere projekter er bygget dér.

Projektet er til personligt og undervisningsmæssigt brug. Genskabelsen skal bygge på egen kode og egne assets. Originale diskbilleder, grafik, musik eller kode må ikke distribueres med resultatet.

## Status

- [x] Projektmappe oprettet (`C:\LLM\remake\Utopia`)
- [x] Emulatorer og spilfiler lokaliseret (se nedenfor)
- [x] Research af metoder til dekompilering og genskabelse (se afsnittet "Metoder")
- [ ] Valg af målplatform (TypeScript + Canvas 2D foreslået)
- [ ] Analyse af spillets kode (68000, HUNK-format, eventuel crunching)
- [ ] Prototype

## Emulatorer

| Emulator | Sti | Bemærkning |
|---|---|---|
| WinUAE | `E:\Games\Emulator\Amiga\Emulation\WinUAE\winuae64.exe` | Nyeste 64-bit build fundet. Bruges som referencemaskine og til debugging. |
| WinUAE | `E:\Games\Emulator\Amiga\WinUAE\` | Indeholder `winuae.exe`, `winuae30_64.exe` og `winuae64_floppy.exe`. Mangler `winuae64.exe`. |
| WinUAE | `E:\Games\Emulator\Amiga\New Releases\WinUAEFloppy\WinUAE\winuae64.exe` | Floppy-variant. |
| WinUAE | `E:\Games\Emulator\Amiga\Amiga Forever 2016\WinUAE\` | Ældre build. |
| Copperline | `E:\Games\Emulator\Amiga\AmiHET\Copperline_Audit_20261021\Copperline-1.0.1\Copperline-1.0.1-win-x64\copperline.exe` | Copperline 1.0.1, Windows x64. Kommandolinjeværktøjet `copperline-ctl.exe` ligger i samme mappe. |

Noterne i `C:\LLM\MiSTer\Amiga\CLAUDE.md` og `C:\LLM\MiSTer\Amiga\skills\winuae\SKILL.md` angiver `D:\Games\Emulator\Amiga\WinUAE\`. Den mappe findes ikke længere, så stien i noterne er forældet.

### Kildekode til emulatorerne

- WinUAE: `C:\LLM\MiSTer\Amiga\research\repos\WinUAE` (git)
- Copperline: `C:\LLM\MiSTer\Amiga\research\repos\Copperline` (git)

## Spilfiler – Utopia

### Disketter (ADF)

- `E:\Games\Emulator\Amiga\All Games\U-W\Utopia\Utopia-a.adf`
- `E:\Games\Emulator\Amiga\All Games\U-W\Utopia\Utopia-b.adf`

### IPF (kopibeskyttede disketter)

- `E:\Games\Emulator\Amiga\IPF\Utopia-TheCreationofaNation_757.zip`
- `E:\Games\Emulator\Amiga\IPF\Utopia-TheCreationofaNation_758.zip`
- `E:\Games\Emulator\Amiga\IPF\Utopia-TheNewWorlds_2576.zip`

### WHDLoad (installeret og klar til kørsel)

- Pakke: `E:\Games\Emulator\Amiga\WHDLoad\WHDLoadPacks\WHDPacks\U\Utopia`
- Installeret mappe: `E:\Games\Emulator\Amiga\WHDLoad\WHDLoad v0001\Games_WHDLoad\Utopia` (indeholder `Utopia.Slave`)
- Konfiguration: `E:\Games\Emulator\Amiga\WHDLoad\WHDLoad v0001\Utopia.uae`
- Upakket kopi: `E:\Games\Emulator\Amiga\WHDLoad\WHDLoadPacks\WHDLoad Collection\Games-WHDLoad\unpacked\Utopia`
- Arkiv: `E:\Games\Emulator\Amiga\WHDLoad\WHDLoadPacks\WHDLoad Collection\Games-WHDLoad\Utopia_v1.2_0757.zip`

Versionen er `1.2_0757` og bruger slave-filen `Utopia.Slave`. Det er det mest oplagte udgangspunkt til analyse, fordi WHDLoad-slaven indeholder init-kode, relokering og pakket-data-håndtering.

### Harddisk-installationer

Mapper med `Games\U\Utopia` under `E:\Games\Emulator\Amiga\AmigaHardDisks\` (bl.a. `CaldorsHD`, `ClassicWBHD`, `CaldorHDBackup`, `CF_backup`, `Extra\Coffin`, `Extra\Apollo\Vampire`).

### Relaterede titler (ikke Utopia)

- `Vision-The5DimensionUtopia_2651.zip` (IPF)
- `utopia_-_black_and_white_(1989)(17-bit_software)[xxx].zip` (demo, `Grandis\Amiga Porno\Demos`). Ikke relevant til spillet, og indholdet er ikke åbnet.

## Metoder til dekompilering og genskabelse

Research-noter (verificeret delvist; se "Ikke verificeret" nedenfor).

**Om spillet:** Utopia blev udviklet af Celestial Software (Graeme Ing og Robert Crack) og udgivet af Gremlin. Amiga-versionen udkom i september 1991. Der er ikke fundet offentliggjort reverse-engineering af spillet.

### Værktøjer

| Værktøj | Bruges til | Amiga-specifikt? |
|---|---|---|
| Ghidra + [ghidra-amiga](https://github.com/BartmanAbyss/ghidra-amiga) | 68k-disassembly og dekompilering. Fork med HUNK-, Kickstart- og WinUAE-state-loader | Ja, via add-on |
| Reko | C#-dekompiler med m68k-understøttelse | Ikke verificeret |
| radare2 / Cutter | 68k-disassembly (68000–68060) via Capstone | Nej, HUNK skal loades manuelt |
| IDA Pro | Stærk kommerciel disassembler | Usikkert om HUNK-loader |
| ReSource / ReSrc4 | Ældre Amiga HUNK-disassemblere | Ja |
| amitools | Python: HUNK-bibliotek, `hunktool`, `xdftool` til ADF/HDF | Ja |
| amiga-re-kit | Python (MIT): HUNK-info, disassembler, MCP-server | Ja |
| Copperline | Emulator med CPU/chipset-debugger, headless-kørsler og VCD-output | Ja |
| WinUAE | Emulator med indbygget debugger | Ja |
| XFD / xfdmaster | Generel decrunch, bl.a. PowerPacker | Ja |
| SPS IPF | Flux-niveau-bevaring af kopibeskyttede disketter | Ja |
| WHDLoad | Installer med slaves der patcher originalen. Autodoc'en nævner `resload_Decrunch` | Ja |

**Pakkede programmer:** Amiga-spil er ofte pakket med Imploder, PowerPacker eller Cranker. Den praktiske fremgangsmåde er at lade spillet pakke sig selv ud i en emulator, tage et memory dump ved entry point og loade det i Ghidra eller IDA. Det er ikke verificeret endnu.

### Genskabelsesmetoder

1. **Disassembly-informeret omskrivning.** Eksempel: OpenTTD (x86, analyseret i IDA og omskrevet i C). Juridisk status er omstridt.
2. **Statisk rekompilering.** Eksempel: pop2, som oversætter Mac 68k-builden af Prince of Persia 2 til C++/WebAssembly. Projektet indeholder ingen spildata og angiver ingen licens.
3. **Hybrid.** Originalkoden kører i en 68k-kerne, mens dele omskrives. Der er ikke fundet et Amiga-eksempel.
4. **Trace-drevet clean room.** Optag hukommelse og registre fra en emulator, skriv specifikationer og tests ud fra dem, og genimplementér. Det er den mest oplagte vej her, og Copperline er det rigtige værktøj til det.

### Juridiske punkter (ikke juridisk rådgivning)

- **EU:** Direktiv 2009/24/EF tillader dekompilering til interoperabilitet under strikse betingelser. At observere og teste et programs adfærd behandles mere lempeligt. Teksten er ikke verificeret.
- **USA:** DMCA 1201(f) er snævert og dækker ikke klart at udgive en genskabelse.
- **Distribution er hovedrisikoen.** Kode, grafik og musik er beskyttet. En genskabelse med egne assets og uden originale filer er lavere risiko, men at kopiere udtryk fra disassembly er stadig et problem. Bør vurderes af jurist for den relevante jurisdiktion.

### Browser-motorer

- **TypeScript + Canvas 2D:** Ingen afhængigheder. Passer til en software-blitter og copper-lignende effekter pr. scanline på en 320×256-buffer.
- **PixiJS:** Sprite-batching og WebGL/WebGPU. Relevant hvis der er mange sprites.
- **Phaser:** Komplet spilframework. Mere end et enkelt strategispil har brug for.
- **WebAssembly fra C/Rust:** Nødvendig for hybrid- eller rekompileringsvejen. Giver mere værktøjsopsætning og sværere debugging.
- **Godot web-eksport:** Kun Compatibility-renderer (WebGL 2) virker i browseren. C# eksporteres ikke til web.

### Anbefaling

1. Identificér den præcise diskversion og packeren. Pak ud via emulator-dump hvis nødvendigt, og load HUNK'en i Ghidra (med ghidra-amiga) eller IDA.
2. Gå ikke efter fuld dekompilering. Brug Copperline eller WinUAE til at optage adfærd for delsystemer (kortgenerering, økonomiformler, AI-ture) og skriv en clean-room-specifikation med tests.
3. Genimplementér i TypeScript med Canvas 2D. Tilføj PixiJS kun hvis antallet af sprites kræver det. Brug egen grafik og musik.
4. Valgfrit: kør den originale 68k-kode i en WASM-emulator til differentiel test, kun internt.

### Ikke verificeret

- IDAs indbyggede HUNK-loader, WinUAE-debuggerens funktioner og Ghidras 68k-dekompiler-kvalitet.
- PixiJS- og Phaser-påstande er generel viden.
- EU-direktivets ordlyd.
- Ingen Utopia-specifik reverse engineering, packer- eller kopibeskyttelsesdetaljer er fundet. Den konkrete disk skal undersøges.

## Åbne spørgsmål

1. **Målplatform:** Hvilken webbaseret stack skal bruges? Kandidater er TypeScript med Canvas 2D eller WebGL, PixiJS, Phaser, eller WebAssembly fra C/Rust. Valget afhænger af, hvordan Amiga-grafikken (blitter, copper, bitplanes) skal efterlignes.
2. **Analyseværktøj:** Ghidra (med m68k-plugin) er et oplagt valg. Det skal bekræftes.
3. **Omfang:** Skal hele spillet genskabes, eller først en vertikal skive (fx kortvisning og en tur)?
