# Utopia handoff: what can occupy rows 159..165 at a line expiry, and the menu exit frame (2026-11-13)

Model and routing: Claude Haiku 5.5, inline, as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed, and no subscription usage was checked or timer scheduled. No emulator was run and nothing under `original/` was written (the Disk.1 and Disk.2 files were only read by the scratch probes and the tests). Nothing was committed or pushed. The dirty worktree was preserved.

Scope: follow-up to `HANDOFF-2026-11-13-row159-erase.md`. Questions: (1) can active effects or moving sprites occupy rows 159..165 during a line expiry in the remake; (2) does `presentLineErase()` overwrite pixels that a following pass should retain.

## 1. Answer to (1): no reachable object or tile pixel is in rows 159..165 (STATIC plus scratch probes)

`ObjectLayer.blit` clips only to the 200-row screen, not to the map window, so the bound comes from the anchor and the admission rule (`shown()`, objects.ts). A sprite's bottom row is `39 + 8(vx+vy) - 1 + dy - lift`; the largest anchor is view cell (7,7), giving row 150 + dy.

| Source | Bottom row bound | Why |
|---|---|---|
| Units, enemy ground, aircraft, ships | 157 (upper bound); 153 measured | `dy` stays inside the current direction's step (`STEP_PIXELS`). `shown()` hides dir 1..3 with dy > 0 at view column 7, dir 3 with dy > 0 and dir 4 with dx < 0 at view row 7. The row-159 handoff's worst case (7,6) dir 3 dy 14 is hidden by the column rule. |
| Effects (explosions) | 150 | `lift` is clamped to >= 0 (`enemies.ts`, `drawables`, `blastCell`); `dy` 0. |
| Tiles, pins, building preview | 150 | Anchored at row 151 or above and drawn upward (`drawTile`, `drawMarkers`). |
| Meteor | 150 | `dy` 0 at creation; `lift` is the countdown from $78, steps of 4, impact at 0, so never negative. |
| Alien apparition | 137 | The remake writes only its frame and timer after creation; `dy` 0 at creation; the -13 adjustment. A restored Disk.4 record could carry another `dy`: not reached by play in the remake (not verified). |
| Alert lights, command buttons, mode icon | 154 / 154 / row 52 | Lights at rows 139..154 (`sim-alerts.ts`); buttons end at row 154. |

Probe, unit sweep (scratch, outside the repository): every direction, view rows 5..7 and columns 0..7, `dy` and `dx` over each direction's reachable range (the step, exclusive of its end), sentinel fill: the lowest map-window pixel row is 153, with no hit in rows 155..199. The sweep is a superset of the walker's reachable states.

So in every state the remake reaches, nothing in the map window is in rows 159..165 at an expiry. The erase removes no object pixel in the remake.

## 2. Answer to (2): the erase does not take pixels a following pass keeps (STATIC plus test)

Each completed pass restores rows 89..159 (x 0..255) and rows 22..159 (x 272..319) from the picture, and the message band rows 160..199 from the picture, before it draws its objects (`drawPass`, `restoreOverlayAreas`). The gap x 256..271 in rows 159..165 is written by nothing except the picture and the line glyphs, which the band restore clears. So the next pass's output in these rows does not depend on what the expiry erase left in the frame. Tests: `test/map-loop.mjs` 7g, 7h (the next pass equals the quiet twin).

## 3. Corruption found and fixed: the menu's exit frame kept the expired line

Reproduction (scratch probe, then `test/map-loop.mjs` 7i):

- A line is posted, the build menu opens while it shows, and the line expires while the menu stays open.
- The modal frame itself is clean: `controls.draw` covers the glyph rows and `messages.draw` draws nothing after the expiry (rows 160..165 equal the no-line twin).
- But `presentLineErase()` returned early while a modal was visible, so the persistent buffer kept the glyph rows. The menu's exit frame (`modalAtStart` branch) copies that buffer to the screen and showed the expired glyphs for one displayed update (145 pixels differ from the no-line twin). The queued pass removed them on the next update.

Static trace: `$558A` writes both bitmaps during VBL, so the original's exit frame has none of the line. The exit frame content of the original is not observed.

Change (`src/game/map.ts`, `presentLineErase()`): while a modal is visible, the expiry repaints rows 159..165 of the persistent buffer from `initialPicture` and returns; the screen is still left to `drawModal`, which owns the modal frame (writing the screen there would erase the menu's own pixels). Outside a modal, behaviour is unchanged (screen and buffer are both repainted). The doc comment is updated.

Mutant check (compiled `dist/game/map.js` only; restored and rebuilt afterwards): removing the modal-path buffer repaint fails exactly the two exit-frame checks of 7i ("the exit frame has no expired line in rows 159..165" and "the exit frame equals the quiet twin across the whole frame").

## 4. Tests

- `test/map-loop.mjs` section 7i (new, 8 checks): the menu opens while the line shows; the line is visible in the modal before it expires (the check can fail); the line expires while the menu is open; the expiry's modal frame has no line in rows 159..165; the menu exit runs; the exit frame has no expired line in rows 159..165; the exit frame equals the quiet twin across the whole frame; the next pass equals the twin across the whole frame.
- Section 7h is unchanged (it still passes).

## 5. Verification (2026-11-13)

| Command | Result |
|---|---|
| `npm run build` (`tsc`) | exit 0 |
| `node test/map-loop.mjs` | exit 0, 309 `ok` (was 301), no `FAIL` |
| `node test/message-panel.mjs` | "message panel tests passed" |
| `npm test` (full chain) | exit 0, 4,548 `ok` (was 4,540), no `FAIL` |

Scratch probes (kept in the user's temp folder, not in the repository): the reachable-offset sweep, the modal expiry and exit probe, and the earlier modal probes that reproduced the stale exit frame before the fix.

## 6. Still open (needs original evidence)

1. **Object pixels at an expiry in the original.** Unchanged from `HANDOFF-2026-11-13-row159-erase.md` section 6.1. The remake's geometry says no object reaches row 159; a Copperline frame at an expiry with a unit or effect in view row 7 would settle whether `$558A` erases object pixels there.
2. **The exit frame in the original.** The fix follows the static trace that `$558A` writes both bitmaps during VBL, so the modal's displayed bitmap has no line after an expiry during the modal. A Copperline capture of the build-menu exit after an expiry would confirm it.
3. **Restored alien `dy`.** A restored Disk.4 apparition could carry a non-zero `dy` that moves its sprite into rows 159..165. The remake would then repaint it with the erase, as `$558A` does. Not reached by play; not verified.
4. **Other modal screens.** The fix covers the build-menu modal (`controls.menuVisible`). Other modal loops that draw the map were not swept in this slice.

## 7. Notes changed

- `notes/formats/game-text.md` section 4: the paragraph "Expiry erase: what can occupy rows 159..165, and the modal exit". The row-159 bound of 157 is kept as an upper bound (the measured lowest row is 153).
- `notes/HANDOFF-2026-11-13-line-expiry.md`: section 2 (the early return) and section 5, item 5 (modal frames, now partly resolved) point here.
- `notes/README.md`: newest handoff pointer.
- This note.

Repository state: nothing committed or pushed. The dirty worktree is preserved. `original/` was only read.
