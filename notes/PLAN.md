# Plan: a playable Utopia

Started 2026-11-25. This is the working plan. Update the status column as work lands.

## Goal: what "works" means

| id | Acceptance criterion | How it is checked | Status |
|---|---|---|---|
| W1 | `npm install`, `npm start`, open the printed address: the app is served locally and the README says how | `test/serve.mjs` | done |
| W2 | In a real browser: pick the game folder, title, language, boot, disk menu, scenario, map. No console errors | `tools/browser-smoke.mjs` (headless Chrome, local files) | done |
| W3 | All 10 scenarios and the tutorial start and play for years; every window opens and closes | `test/playthrough.mjs` | done |
| W4 | Seeded random input and long idle runs throw nothing and never hang | `test/soak.mjs` | done, with limits (see Findings) |
| W5 | Save, load and continue works in every scenario | `test/playthrough.mjs` | done |
| W6 | Colony fall and alien defeat are reachable and leave the game usable | `test/playthrough.mjs` | done |
| W7 | Every player-facing feature in the player's manual is present, or listed below with a decision | feature audit, then this file | audit done, open items in Findings |
| W8 | `npm run build` and `npm test` pass | CI-style run | done (coordinator run, 2026-11-25) |

## Not part of "works"

These need external emulator captures or inputs that are not available. They stay documented as open in `notes/formats/`:

- pixel, timing and audio parity with the running original;
- ADF, HDF and IPF input, and other releases;
- Disk.4 export and verified Disk.4 restore fidelity;
- floppy format.

## Work phases

| Phase | Task | Owner | Files owned | Status |
|---|---|---|---|---|
| 1 | A. Local server and run instructions | Haiku | `tools/serve.mjs`, `test/serve.mjs`, `package.json`, `README.md` | done |
| 1 | B. Browser shell: frame catch-up cap, stuck buttons, error display, canvas size, cursor | Haiku | `src/main.ts`, `src/browser/`, `index.html`, `test/browser-shell.mjs` | done |
| 2 | C. End-to-end headless play-through | Haiku | `test/playthrough.mjs` | done |
| 2 | D. Seeded fuzz and soak | Haiku | `test/soak.mjs` | done |
| 2 | E. Manual feature audit (read-only) | Haiku | none | done |
| 3 | Fix defects and gaps found in phase 2 | Haiku | per defect | done (see Findings) |
| 4 | F. Real-browser smoke test | Haiku | `tools/browser-smoke.mjs` | done |
| 5 | Review, wire tests into `npm test`, update notes | coordinator | docs, `package.json` | done |

## Rules for every task

- The working tree holds a large amount of uncommitted work. No `git checkout`, `reset`, `restore`, `stash`, `clean`, commit or push.
- Edit only the files the task owns. Report anything else that needs a change.
- Never copy game data (bytes, text, graphics) into the repo. Tests read `original/` at run time and skip when it is missing.
- Original behaviour needs evidence (see `AGENTS.md`). A crash fix may be made from the code; a behaviour change must cite the trace in `notes/formats/`.
- A task is done only when its check was run and its output reported. The coordinator re-runs it.

## Findings and decisions

Status as of 2026-11-25. The coordinator re-ran the build, the test chain, the soak, the autoplay and the real-browser smoke test on the final tree; all exited 0 with no failed checks.

**Goal status**

- W1 done: `test/serve.mjs`; `npm start` builds and serves `http://127.0.0.1:8080/` (`PORT` changes it).
- W2 done: `tools/browser-smoke.mjs` passed in headless Chrome: all 10 scenarios and the tutorial, a building placed, save, reload and load. 0 console errors, 0 failed requests, 0 page exceptions. Screenshots are saved to a temp folder; only a few were looked at by eye.
- W3, W5, W6: `test/playthrough.mjs` (886 checks) covers every scenario, the windows, save and load, the colony fall and a forced alien victory. `test/ship-lifecycle.mjs` (115 checks) covers all six ship classes, tanks sent to the front, and an alien defeat reached through normal weekly battles. It uses declared resource and event pokes.
- W4: `test/soak.mjs` (seeded fuzz) on seeds 1-4, about 6.7 million updates, no defect found (task owner; the coordinator re-ran the default run only). `test/autoplay.mjs` ran 21 runs (294 checks ok). Its keep-alive mode reaches 100 years only with heavy declared state pokes, built no ships, and takes about 9 minutes.
- Not shown: long late-game play without pokes. Without them the bot's colonies fall within 26 years. This reflects the bot, not a verified late game.
- W7: manual audit done. Decisions:
  - The assassination event is absent from the original's code, so it stays absent.
  - Sports events do not reduce output in the original (static trace; the manual differs and the original wins). They do block building placement for the month.
  - Hospitals act through medic staffing.
  - Turret facings, the refuel window and ship costs follow the static traces where the manual differs.
  - The format-disk function stays a stub.
  - Saves are the remake's own.
- W7 open items the audit could not settle: names and effects of several inventions, radar visibility of enemies, and the effect of the Security HQ on crime.
- W8 done: `npm run build` and `npm test` exit 0 (97 s, 6,290 `ok` lines, no failures). Capture comparisons that need local emulator captures are skipped by their harnesses.

**Fixed in this work**

- There was no way to run the app. Added `tools/serve.mjs` and `npm start`.
- Frame catch-up after a background tab.
- Stuck mouse buttons and keys after release outside the canvas or on blur.
- Errors are now shown on the page.
- Canvas is 320x200.
- Favicon request.
- Startup crash on a non-byte file read.
- Demolishing a sports complex now clears the sports countdown ($745A).
- Warehouse demolition now uses the original divide semantics ($7488-$749A).

**Not bugs (verified statically)**

- Negative goods stock after warehouse loss ($A30E-$A324).
- New ships have no fuel ($38D6-$38DC).

**Observations**

- The user's `disk.4` has only EMPTY slots. Disk.4 continuation is therefore tested only with a synthetic image.

**Open decision for the user**

- Whether to add a remake-only key that skips the 4-minute loading sequence. Not done: it would deviate from the original.

## Handoff

See `notes/HANDOFF-2026-11-25-playable.md`.
