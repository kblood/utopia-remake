# Save-name prompt and editor

The save page now models the original's name step after a slot-row release. The build and test chain pass. No commit or push was made.

## Original trace and evidence

Static Disk.1 trace, as recorded in `notes/formats/game-proper.md` and the code comments in `src/game/save-name.ts`:

- `$8918` enters the name prompt. `$13E` offers the date-derived default (`DD/MM/YYYY`), and `$13F` says a mouse click accepts it or Return enters the editor.
- `$5110` takes characters from the 53 code/character pairs at `$64C8`, up to 16 typed characters. The save tail `$89B4` stores 15 bytes in the slot record.
- The new regression reads `$64C8` directly from the user's local Disk.1 and compares the full table against the decoded model. The table content and prompted string indices are not inferred from remake output.
- No emulator capture was made. Prompt timing and pixels are therefore not claimed as runtime-matched.

## Remake changes

- `src/game/save-name.ts` models the prompt/editor key semantics, allowed characters, default click, 16-character input limit, and 15-character stored result. Escape and right-click cancellation are remake conveniences.
- `Game` (`src/game/game.ts`) opens the prompt only after the save-page row is released. A click accepts the date default; Return enters editing; Return or keypad Enter commits nonempty typed text. The prompt uses Disk.1 strings `$13E`, `$13F`, and `$142`, wrapped to fit the remake slot page. This layout is not pixel-compared with the original.
- The chosen name is captured with the saved session, shown in the slot label in place of the date, preserved through save-error retry, and kept null for direct programmatic saves.
- Native save version is 12. Versions 2–11 and version-less saves migrate with `name: null`; their previous date-based slot labels remain.
- Existing save-page route tests now perform the second click that confirms the default name. `test/save-name.mjs` adds coverage for the raw key table, prompt/editor, click default, typed names, 16-to-15 truncation, failed-write retry and labels.

## Verification

- `npm run build`: exit 0.
- `node test/save-name.mjs`: 18 checks passed.
- Focused `save`, `save-page`, `scenario-icons`, `disk-menu-keys`, `boot-menu`, and `slot-label-width` suites: all pass.
- `npm run build`: exit 0.
- Full `npm test`: exit 0, 5,040 `ok` lines and 0 `FAIL`/`not ok` lines. The run includes local-Disk.1/2 checks; external capture comparisons without configured capture paths remain skipped by their harnesses.

The Claude NT task provider reported a rate limit. I completed the integration inline in the current session; no provider switch is claimed. No emulator or original-file writes were made. The local original disks are read only for the test and runtime loaders.

## Verification addendum (2026-11-14, second session)

- Re-read Disk.1 with raw bytes: the date block at `$14594` (file `$3CD94`) is `28/06/2090`, NUL, `$1C`, `$05`, `$00`, `$1E`. The name step copies 15 bytes over the `$13E` placeholder, so the NUL lands on the closing quote and the first prompt line is drawn as "Game will be saved as '28/06/2090" (no closing quote, no dots). The drawer stops at NUL (game-text.md, `$539E`: NUL-terminated).
- Correction: `drawSaveNamePrompt` drew the template's closing `'...` after the date. It now stops at the date; `test/save-name.mjs` checks the line (19 checks, all pass).
- `npm run build` exit 0; `npm test` exit 0 with no `FAIL` lines (the lines that match "FAIL" are check names containing "FAILED").
