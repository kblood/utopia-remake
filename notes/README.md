# Analysenoter

Denne mappe indeholder analyse af Utopia-spillet. Den bruges til clean-room-specifikationer, ikke til kopieret kode eller assets.

## Regler for denne mappe

- Skriv hvad spillet gør (adfærd, formler, tilstande), ikke hvordan originalkoden er skrevet.
- Ingen disassembly, dumps eller udtræk fra originalen må committes. De ligger i `original/`, som er gitignored.
- Hver påstand skal kunne spores til en observation: en emulatorkørsel, en skærmoptagelse eller et måleresultat.

## Plan for første analyse

1. Bekræft diskversionen. Sammenlign ADF-filerne (`Utopia-a.adf`, `Utopia-b.adf`) med WHDLoad-versionen `Utopia_1.2_0757`.
2. Kør spillet i WinUAE eller Copperline. Notér opstart, menuer og de vigtigste skærme.
3. Vælg ét delsystem at specificere først, fx kortgenerering eller økonomi.
4. Skriv specifikationen her som en markdown-fil pr. delsystem, med en testcase pr. observation.
