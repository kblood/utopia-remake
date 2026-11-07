# Analysenoter

Denne mappe indeholder analyse af Utopia-spillet. Den bruges til clean-room-specifikationer, ikke til kopieret kode eller assets.

Arkitektur og dataformat-arbejdsgang står i [ARCHITECTURE.md](ARCHITECTURE.md).

## Regler for denne mappe

- Skriv hvad spillet gør (adfærd, formler, tilstande), ikke hvordan originalkoden er skrevet.
- Ingen disassembly, dumps eller udtræk fra originalen må committes. De ligger i `original/`, som er gitignored.
- Hver påstand skal kunne spores til en observation: en emulatorkørsel, en skærmoptagelse eller et måleresultat.

## Status og næste arbejdsgang

Diskversionerne og de vigtigste dataformater er allerede undersøgt; se `formats/utopia-disks.md` og formatnoterne. Den nuværende motor bruger WHDLoad 1.2 (0757), fordi de lokale ADF-billeder ikke svarer direkte til dens `Disk.1`/`Disk.2`, og de fundne HDF-stier ikke giver en udpakket spildatakopi.

Fortsæt med at sammenligne spiladfærd og skærme med originalen i WinUAE eller Copperline, og registrér hver observation med evidensniveau. ADF/HDF-indlæsning er et muligt senere inputformat, hvis en konkret kopi kan valideres; det er ikke et krav om at bruge ScummVM eller en anden emulator som engine.

Remakens egen save/load (localStorage, version 9: hele den levende session med faste slots, referencer, cellflag, ure, RNG, hardware-approksimationstilstande, loopfase og en ventende pass efter modal exit, de 30 faste effektslots (eksplosioner) med huller og den rå `+$16`-pointer for hver fjendeslot, også ledige; version 2-5 migreres med tom effektliste, version 6-7 gemte en tæt effektliste og migreres med alle poster bevaret men antagne slotnumre (`FX SLOT UNK`, bæres videre i senere saves indtil puljen er tom), og version 2-6 migreres med afledte pointere for optagne slots og 0 for ledige, alle som tabsgivende antagelser vist som `FX UNKNOWN` / `FX SLOT UNK` / `PTR UNKNOWN` / `FX/PTR UNK`) er beskrevet i `formats/remake-save.md`. Den er ikke Disk.4-formatet, og der er ingen påstand om Disk.4-skrivning, eksport eller paritet.

Projektets seneste tekniske status og næste arbejdspunkter står i [handoff-noten fra 2026-11-07](HANDOFF-2026-11-07.md).
