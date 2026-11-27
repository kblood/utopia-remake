# Handoff 2026-11-25: playable remake

## What changed

- The app runs from the browser: `npm start` builds `dist/` and serves `http://127.0.0.1:8080/` (`PORT` changes it). Server: `tools/serve.mjs`.
- Browser shell fixes: frame catch-up after a background tab, stuck buttons and keys after release or blur, errors shown on the page, canvas 320x200, favicon request.
- Gameplay fixes: sports complex demolition clears the sports countdown (`$745A`); warehouse demolition uses the original divide semantics (`$7488-$749A`).
- Ships and tanks: the full chain (staffing, funding, market, ship yard, order, refuelling, the front, tank yard) is covered by `test/ship-lifecycle.mjs`.
- `notes/PLAN.md` holds the goals, statuses and findings.
- `package.json`: `test` runs `serve`, `browser-shell`, `robustness`, `demolish-quirks`, `playthrough` and `ship-lifecycle`. Also `test:soak`, `test:autoplay`, `test:browser`.

## How to run

```
npm install
npm start            # http://127.0.0.1:8080/
npm test             # full chain
npm run test:browser # headless Chrome smoke (needs Chrome or Edge)
```

The user's WHDLoad 1.2 (0757) files (`Disk.1`, `Disk.2`, `Utopia.Slave`, optional `disk.4`) are chosen in the browser. Nothing is read from `original/` by the tests unless it is present; the tests skip when it is missing.

## Tests and rough runtimes

Coordinator run on the final tree: all of the following exited 0 with no failed checks. `npm run build && npm test` took 97 s in total.

| Script | What it covers | Runtime |
|---|---|---|
| `test/serve.mjs` | static server, refused and malformed requests | in `npm test` |
| `test/browser-shell.mjs`, `test/robustness.mjs`, `test/demolish-quirks.mjs` | shell, input robustness, demolition quirks | in `npm test` |
| `test/playthrough.mjs` | 886 checks: all scenarios and tutorial, windows, save and load, colony fall, alien victory | in `npm test`, about 28 s |
| `test/ship-lifecycle.mjs` | 115 checks: six ship classes, tanks to the front, alien defeat | in `npm test`, about 33 s |
| `test/soak.mjs` (`test:soak`) | seeded fuzz; the default run is 11 runs, 530,570 updates, 33 checks (a longer run over seeds 1-4, about 6.7 million updates, was done by the task owner only) | 46 s |
| `test/autoplay.mjs` (`test:autoplay`) | bot play, 21 runs, 294 checks ok | 521 s |
| `tools/browser-smoke.mjs` (`test:browser`) | headless Chrome with `UTOPIA_SMOKE_ALL=1`: 10 scenarios, tutorial, build, save and load; 94 checks ok, 0 errors collected | 775 s |

## Not verified

- No emulator comparison against WinUAE or Copperline for this work (pixel, timing or behaviour parity).
- No listening test of audio.
- No real manual play by a person.
- Long late-game play without declared state pokes is not shown. The autoplay bot's colonies fall within 26 years without pokes.
- Disk.4 continuation is tested only with a synthetic image; the user's `disk.4` has only empty slots.
- Open manual items: names and effects of several inventions, radar visibility of enemies, Security HQ effect on crime.
- Nothing is committed. The working tree holds all changes.
