# The remake's own save (localStorage, version 12)

Code: `src/game/save-session.ts` (schema, capture, validation, atomic restore), `src/game/save.ts` (text form, slots, old-save
handling), `Game.saveToSlot` / `Game.loadFromSlot` in `src/game/game.ts`. Tests: `test/save.mjs` (synthetic part always runs,
the Game wiring part needs the player's Disk.1/Disk.2).

## What this is, and what it is not

- It is the **remake's own record** of a live session, kept in the browser's `localStorage` (slots 0-7, key
  `utopia-remake-save-<n>`). It is **not** the original's Disk.4 record, shares no layout with it, and nothing here reads,
  writes or exports Disk.4. No Disk.4 import/export, roundtrip or parity is claimed anywhere in this note.
- It stores **no original game file, asset or captured RAM**: only the remake's runtime state (the flat state image is the
  remake's own copy of the scenario variables it already holds in memory; a save of a scenario therefore contains numbers
  derived from the game's scenario record, as the pre-version-2 saves already did). The game files are still read from the
  player's folder at load time.
- Evidence level: the *schema* is a design of the remake. The statements about which live fields exist and how the original
  uses them are taken from the other notes (`units.md`, `enemies.md`, `ship-control.md` 5c, `sim-port.md`, `game-state.md`) and
  keep their VERIFIED / HYPOTHESIS labels there. Round trips are covered by **synthetic tests**; nothing here was compared with
  the running original, and a loaded session is exactly as faithful as the live session it was saved from.

## Text form

`JSON { "format": "utopia-remake-session", "version": 12, ...fields }`. The four binary parts (`state`, `cells`, `cellFlags`,
`objects`) are base64 strings; the map words are written as **explicit little-endian** 16-bit values (7500 words = 15000 bytes),
independent of the host. Everything else is plain JSON. `decodeSave(text)` never throws: it returns the validated session or a
typed `SlotError`.

## Fields (version 12)

| Field | Content | Checked |
|---|---|---|
| `scenario` | scenario record index (Disk.2) | integer 0..65535; `Game` also requires `< scenario count` |
| `name` | Player-entered name from the original save-name key table, or `null` for programmatic and migrated saves | `null` or 1..15 allowed characters; added in version 12, versions 2..11 migrate to `null` |
| `scroll` | view origin `{x, y}` | 0..92 / 0..67 |
| `state` | flat state image (`$13034`..`$14633`, 0x1600 bytes) | exact length |
| `cells` | 100 x 75 map words, tile id + flag bits as live | exact length |
| `cellFlags` | the 75 x 102 per-cell flag bytes, padding columns included | exact length |
| `objects`, `world.objectCount` | 1000 x 8 object records, the count `World.objectCount` | exact length, 0..1000 |
| `world.solarPhaseRng` | Separate serializable PRNG state for future solar-building phase rolls; distinct from Sim RNG | null or unsigned 32-bit; null in older saves restores the fixed state `FIXED_SOLAR_PHASE_STATE` (0), not the target's host-random stream (handoff 2026-11-13-solar-phase) |
| `sim.sysFlags` `paused` `dayQueued` `blastMark` | `$156AA`, `$156A9` bit 2, a day change waiting for the next pass, `$156A9` bit 5 (the blast mark, ship-control.md 5e; version 10) | byte / booleans; `blastMark` is required from version 10 and migrates as `false` from versions 2–9 |
| `sim.tileExchange` `sim.tileExchangeAssumed` | the parity of the descriptor exchange `$11024` (`Sim.tileExchange`; eclipse-tiles.ts), and the flag that it was assumed at a migration (`tileExchangeAssumed`, kept true by later saves) | booleans, both required from version 11; versions 2–10 migrate with `tileExchange` false and `tileExchangeAssumed` true (slot label ` TBL UNK` alone, otherwise combined as in Slot labels) |
| `sim.rng` | the 32-bit counter of the port's own RNG (not the original's generator) | `null` or unsigned 32-bit |
| `sim.hardware` | separate deterministic approximation counters for CIA TOD and raster-parity reads | `null` or two unsigned 32-bit counters; versions 2–4 migrate as `null` |
| `sim.fuelWarned` | `$156B3` | boolean |
| `sim.lights` | the four warning lights (0 or 255) | exactly 0/255 |
| `sim.aliens` | alien `{x,y}`/null, meteor `{x,y,timer}`/null, spawner `groupIndex` (`$156B2`) and `cursor` (`$12A94`) | ranges, meteor timer 1..255, cursor 0..$80, group 0..15 |
| `loop` | `{vblPerPass, vbls, passes, phase, immediatePass}` of the `MainLoop` | valid positive cadence, safe nonnegative counters, `passes <= vbls`, `phase` in `0..vblPerPass-1`; the one-shot flag is boolean |
| `passClock` | `$144C9` sub-tick 0..8 plus the move / enemy tick flags of the pass | move tick only on sub 0, enemy tick only on sub 4; `null` = target clock reset |
| `markers` | the eight pins, `y = 255` unplaced | 8 entries, a placed pin is on the map; `null` = pins cleared |
| `tanks` | 99 fixed slots, `null` = free | see below |
| `enemies` | `ground` (60) / `air` (30) fixed slots, `groundPointers` (60) / `airPointers` (30) raw `+$16` longs, legacy `lastCountdown`, `lastTarget` | see below; pointer arrays: exact counts, unsigned 32-bit values |
| `ships` | 40 fixed slots of `Ship` or launched missile, `null` = free | see below |
| `effectSlots` | the 30 FIXED effect (explosion) slots of the `ObjectLayer` pool (`$39D4A`, stride 8), each `null` (free) or a record; slot index = identity (version 8) | exactly 30 entries; the OUTER `null` = no object layer (present exactly when `tanks` is); an empty pool is 30 `null`s; see below |
| `effectSlotsAssumed` | `true` when the slot numbers of the records are an assumption (migrated from the dense list of version 6/7) | boolean; `true` needs at least one record and an object layer; see "Effects in versions 6 and 7" |

Slots keep their **numbers and holes**: a freed slot stays free and the next spawn takes the first free slot, as in the live
system. Nothing is compacted.

Version 9 stores the scheduler phase independently from the video-update and pass totals, plus a pending one-shot immediate
pass. The original build-menu modal loop polls without returning through the main pass; on exit, control returns directly to
the main-loop top. The remake resumes on its next browser video update. Versions 2–8 used the regular cadence, so migration
derives `phase = vbls % vblPerPass` and sets `immediatePass` to `false`; this is exact for those earlier remake saves.

Version 10 stores `sim.blastMark`, the `$156A9` bit-5 mark that a missile hit on a FREE enemy slot leaves set (ship-control.md
5e). The mark survives passes, so it is written whether or not anything is pending. Versions 2–9 never stored it and migrate with
it CLEAR: that is exact only when no such hit was pending at the save, which those versions could not record. The loss is one
stale blast at the next destruction; the reader does not report it in its result (`save.ts` header lists it as a lossy assumption).

- **Tank** (`SavedTank`): type 9/10, cell, tech, pixel offset, direction 0..7, velocity, hp, the full `+9` control byte (bit 7 =
  waiting for the move tick), target, the three `recent` turn-back directions, and the reservation cell (`+$14`) as `reserveX/Y`.
- **Enemy** (`SavedEnemy`): type in the list's type set (ground 9, 10, walkers, crusher 24 / air bomber, kamikazes), the fields
  of `Enemy` (mode, steps, aux, `p14`, `p15`, lift, tech, waiting, reservation cell) and, for crushers only, `toggle` / `counter`
  (0..7) / `anim`. Zero for every other type. `reserveX/Y` is the **mirror** of the cell the slot's raw pointer names (below): a pair
  of map coordinates, or `-1 / -1` together when the pointer names no playable cell (e.g. a freshly spawned wave enemy over a
  zero pointer).
- **Raw enemy `+$16` pointers** (`enemies.groundPointers` 60 entries, `enemies.airPointers` 30 entries, added in version 7 and retained in version 8). One unsigned
  32-bit long per fixed slot, **free slots included**: the original's death routine never clears `+$16..+$19` and wave spawn never
  writes it, so a free slot carries the pointer of its last occupant into the next spawn, and a death before the next movement
  claim releases the cell that stale pointer names (enemies.md section 3b; static Disk.1 trace). Without these arrays a reload
  would change the outcome of such a death. `validateSession` checks the array lengths, that every value is an unsigned 32-bit
  integer, and that each **occupied** slot's `reserveX/Y` agrees with its pointer (the cell it names on the 102-byte rows, or
  `-1 / -1` when it names none); a free slot's pointer may be any unsigned long (zero, padding, off-map are all legal stale
  values). Capture copies `EnemySystem.groundFlagPointers` / `airFlagPointers`; restore installs them verbatim inside the same
  atomic commit.
- **Ship / missile** (`SavedShip`): `kind` `"ship"` (type 11..16, `cls == type - 11`, `fuel`, a negative word means unlimited)
  or `"missile"` (type 17, no class, no fuel, mode 1/2/4). `extra` is the `ShipExtra` (velocity, `next` mode, `turn`, reservation
  cell `rx/ry`, -1 = none) or `null` for a ship that has not been stepped or ordered yet; it stays lazy.
- **Effect slots** (`SavedEffect` per slot, version 8): `type` (`$12` explosion or `$14` high explosion, the only two `spawnEffect` callers use), map
  cell `x/y`, `frame` and `lift`. The pool is the original's 30 FIXED 8-byte slots (static Disk.1 trace of `$1237C` and `$333A`,
  units.md section 6): a new effect takes the FIRST free slot, an expiry frees only its own slot, the update and the draw-list scan walk
  the slots in ascending order and skip holes, so survivors keep their slot index and the slot order decides where effects enter the
  draw list (map-rendering.md 7.4). A dense list loses exactly that, which is why version 8 stores every slot, holes included
  (`effectSlots[i] === null` is a hole; the word `$156AE` is the number of non-null entries and is derived, not stored). The pool is
  also **gameplay-relevant**, not just presentation: `MapScene.enemyExplosion` allocates a blast sprite for an in-view kill and returns
  `false` when all 30 slots are taken, and that outcome decides whether the killed enemy's occupancy bit is cleared (enemies.md
  section 6, static trace plus one staged live capture, not broad parity). A reload that emptied the pool, or that moved a record
  to another slot, could change combat continuation or draw order. Domains, from the live code: a new effect starts at `frame` 4 and
  `EffectPool.tick` (called by `ObjectLayer.update`) frees it when the counter would drop below 0, so a live record holds **0..4**
  (-1 is never kept); `lift` is the victim's altitude byte passed through from the kill (enemy `lift` is allowed -128..255 by the
  enemy record, ground and tank kills use 0), so the saved range is **-128..255**; the cell is on the 100 x 75 map. Capture copies the
  slots (detached); restore creates new `Effect` objects and replaces the 30 slots of the layer's own pool in place only after all
  validation and target checks passed. Capture and restore play no sound, run no hook, use no RNG, step nothing and allocate no
  effect. An empty pool (30 `null`s) and `effectSlots: null` (no object layer) are distinct: `null` clears the target's effects, like
  tanks and pins, and a save with an object layer refuses a target without one (`mismatch`). Error paths name the slot
  (`effectSlots[3].frame`).
- **References.** A missile's `extra.target` is a fixed enemy slot `{air, index}` (ground 0..59, air 0..29), never an object copy
  or a coordinate pair: after a load it resolves to the occupant the *restored* slot holds, exactly like the live `$4408` /
  `$ACE2` behaviour documented in `ship-control.md` 5c. `enemies.lastTarget` is the same kind of slot reference (`$E904`);
  `enemies.lastCountdown` is retained as an unused version-4 compatibility field. Gun scheduling uses the saved `$144C1` pending-period bits; it no longer compares countdown samples.
- **Shared buffers.** The tank system, the enemy system and the world share one `cells` array and one `cellFlags` array; the
  save holds each once and a restore **copies into the live arrays** (identity kept), so the sharing survives. Cell flags and map
  words are restored verbatim; whether an occupancy bit sits under every reservation is **not** cross-checked (the save restores
  the state the live system had).

## Validation and atomicity

`validateSession(save)` is pure and checks types, buffer lengths, integer ranges, slot counts, list/type agreement, missile and
launch-target slot references, the loop/clock arithmetic, the effect slots (exactly 30 entries, each `null` or type `$12`/`$14`, map cell,
frame 0..4, lift -128..255; `effectSlotsAssumed` a boolean that is only `true` with at least one record and an object layer) and the
marker/section dependencies (tanks need pins, enemies need tanks, ship extras need an enemy system, effect slots and tanks are both
present or both `null`). `restoreSession(save, parts)`:

1. validates the save;
2. checks the target (not a Disk.4 scene; one shared world / buffer set; same video updates per pass; an object layer / enemy
   system when the save has tanks / enemies; an RNG that can be set when the save has a counter);
3. builds every `Unit`, `Enemy` and ship record **detached**;
4. only then commits (assignments and copies of validated, equally sized data).

Every refusal happens before step 4, so an invalid or non-fitting save leaves the live session byte-for-byte as it was (covered by
`test/save.mjs`: the full printed session and every slot object identity are compared before and after each refusal). `Game`
adds the scene level: the target scene is created off to the side and the running scene is replaced only after the restore
succeeded; a failed load keeps the running scene, stage and scenario and records the typed reason in `Game.lastLoadError`
(`Game.lastSaveError` for saving); both stay readable for app code until the next attempt.

A successful load builds its scene from the scenario's default state (the constructor draws that picture) and then restores the saved
state into it. Before the scene is held, `MapScene.presentRestoredState()` draws the restored state (same presentation-only draw as
the restored-graph constructor, no pass or tick), so the frame shown on the disk-menu EXIT and the descriptor view (eclipse parity,
`syncTileView`) are the loaded ones. Before 2026-11-13 the first frames after EXIT showed the default scenario picture for up to
`vblPerPass - 1` updates, because a saved loop carries no pending immediate pass (a fresh scenario has one, so a new game was not
affected). This is a remake presentation fix; the original's exact first frame after a load is not observed.

## Disk menu behaviour on failure

Save page (2026-11-14 save-page slice; `MenuScene` `release` mode, `Game.openMenu`, `Game.returnFromSave`): a slot row is chosen on the
RELEASE of a left press that began on it (the row latched at the press, as the original's `$7FCE`/`$2E52`/`$8CFE` do; a press off the
rows, or released elsewhere, chooses nothing). The page opens from icon 1 with `$138` on its status line, and after a successful save
shows `$141` ("Save complete.") until its BACK or its close. BACK returns to the picture or the scenario list the page came from, with
`$141` on the prompt (the pre-save prompt is not restored). The page has an EXIT row after the slots (icon 5, release-chosen, no BACK first; 2026-11-14 load slice). The load page chooses its row on the release too, the same route as the save row (game-proper.md, "Load and save rows").

Stage `sloterror` (`Game.openSlotErrorMenu`, `src/game/game.ts`). A refused SAVE or LOAD chosen in the slot list no longer closes the
menu silently: the map scene stays exactly as it was (same scene object, scenario and bytes; the stage is a menu over it, the map
is not ticked) and an error screen is drawn with the same list menu as the rest of the disk menu:

- title `SAVE FAILED - SLOT n` / `LOAD FAILED - SLOT n`, a line `CODE: <typed code>` (the codes listed under "Typed codes") and the typed
  `message`, wrapped to 30 columns, longer words cut, at most 5 lines (a longer message ends in `...`; the full text stays in
  `lastSaveError` / `lastLoadError`);
- actions: `RETRY SLOT n` (repeats the same operation; success leaves the screen - a save keeps the save page with `$141` as its status
  line for every origin (save-page slice, 2026-11-14; `test/save-page.mjs`; its BACK goes back to the picture or list it came from with
  `$141`), a load enters the restored scene or is held; a new failure shows the new error), `CHOOSE ANOTHER SLOT` (back to the save / load slot list), `DISK MENU`, `BACK TO DISK MENU` (2026-11-14: a save's and a load's
  BACK both return to the disk-menu loop with no exit effect; before, a load's BACK ran `closeMenu`, which could exchange the eclipse tiles
  and enter the map. Original basis: a refused load returns to `$7EF6` (game-proper.md, "Load failure and return"); a save returns through
  `$8A40`). A held scene is entered only by EXIT, and the LOAD icon stays available while one is held (remake choice, no original
  counterpart verified). The game-over
  case is asserted in `test/save.mjs` (game wiring): with `$156AA` bit 3 set the remake LOAD entry stays open, and an empty slot keeps the
  load list with `$143` over the untouched game-over session (2026-11-14 empty-load slice: no error screen for an empty row; a right
  click returns to the disk menu, not the map). A corrupt slot still opens the error screen, whose `BACK TO DISK MENU` reopens the disk
  menu (not the map). A failed save never writes the slot (validation and capture happen first, a refused `setItem` throws before anything
  is stored), a failed load never replaces the running scene (see above).
- **Empty record on the load list (2026-11-14 empty-load slice, `HANDOFF-2026-11-14-empty-load-list.md`).** A load-page row whose
  record is EMPTY is not sent to an error screen. `Game.refuseLoad` prints `$143` (`EMPTY_RECORD_STRING`, the list prompt) with
  `MenuScene.setPrompt`, keeps the list (stage `load`, `lastLoadError` = `empty`), builds no scene and leaves the held scene as it is.
  The rows and the EXIT row keep working (EXIT as in "Load and save rows" of game-proper.md), and a right click returns to the disk menu
  (the picture, or the scenario list the page came from). The original's trace (`$8804`-`$881E`) is in game-proper.md, "Load and save
  rows". A corrupt or unsupported slot still opens `sloterror`. A sloterror RETRY that finds the slot empty (storage changed while the
  screen was open) returns to a fresh load list with `$143`, the same route.
- **Picture under the error (2026-11-14, `HANDOFF-2026-11-14-error-picture.md`).** The original keeps the slot list drawn after a refused
  empty load (game-proper.md, "Load failure and return"). The remake's empty refusal keeps its own load list (the bullet above), so that
  case has no error page to compare. For a corrupt slot the remake does not keep the list: `openMenu` replaces the disk-menu scene and the slot page
  (`MenuScene`, the main picture plus its own panel), and the error page is a new `MenuScene` over the main picture. The prior page is not
  kept under it, and the remake's load list is not the original's (the original's list rows are not drawn by `DiskMenuScene`, which
  carries music labels only). A kept underlay would show the cut-off bottom of the eighth slot row, since the one-line error panel is 108 px
  high and the eight-slot list is 120 px (measured, scratch probe), so it was not added. `test/save.mjs` "visual" checks pin the remake
  pages for the empty-refusal list and a corrupt slot from the disk icon (remake baselines, not original captures) and check that BACK redraws the
  loop exactly as a fresh one.
- Right click on the save or load slot list returns to the disk menu (`Game.update`, `case "save"` / `case "load"`), not to the map: the
  disk menu stays open and any held scene stays held (test/save.mjs, "slot list"). It is not an error and no entry or exit runs.
  (Corrected 2026-11-13: an earlier line here said it closed to the map.) 2026-11-14 third slice: when icon 0 or 1 opened the page from
  the scenario list, the right click (and the error page's BACK TO DISK MENU) brings the list back with its prompt and the held scene
  (`Game.leaveDiskPage`, test/scenario-icons.mjs). From the picture the picture comes back, as before.
- **Held scene save (2026-11-14 third slice, `Game.saveToSlot` / `saveRefusal`; remake adaptation).** A scene picked on the scenario list
  (or loaded, waiting for EXIT) is what the original's RAM holds at that point, so the remake's save writes that held session under its
  own scenario index, not the live map (which is still the old game). The original would ask for a save disk here (`$855A`); the remake has
  no disk, so the adaptation is the slot page. A held Disk.4 continuation and a held game over are still refused. Test:
  test/scenario-icons.mjs (slot 1 reloads to the held cells, which differ from the live map's), test/boot-menu.mjs section 8 (a boot-held
  scene saved before any map exists), test/disk-menu-keys.mjs 4i (the slot holds the held index).
- The Disk.4 restriction is unchanged: with an imported Disk.4 session the `SAVE GAME` entry is disabled
  (`SAVE GAME (OFF: DISK.4 SESSION)`) and cannot be chosen, so that case does not reach this screen from the menu
  (`saveToSlot` still returns `disk4-session` if called directly).
- Game over (`$156AA` bit 3, the original's `$856C` -> `$18A`): the REMAKE MENU entry is off as `SAVE GAME (OFF: GAME OVER)`
  and cannot be chosen; `saveToSlot` returns `game-over` and writes nothing if called directly. The disk-menu save icon prints
  `$18A` as before. Game over is checked before the Disk.4 restriction, so a Disk.4 game over reads `GAME OVER`. The refusal
  lives in `Game` (`saveRefusal`), not in `captureSession`, so the session format and load are unchanged. Covered in
  `test/save.mjs` (section 10) and `test/game-music.mjs`.

**Slot list when localStorage is missing or unreadable.** `slotSummaries()` returns `status: "unavailable"` (with the `no-storage`
error) per slot instead of `null`; the list labels such a slot `STORAGE OFF`, not `EMPTY`. Choosing a slot then shows the
`no-storage` error screen. `EMPTY` (summary `null`) now means only that the storage was readable and the slot holds nothing.

Covered in `test/save.mjs` section 10 (Game wiring, needs the player's Disk.1/Disk.2) with real `Game.update` clicks on the menus:
failed load (corrupt, empty, retry, another slot, back, right click, retry succeeding after the cause is removed), failed save
(refused write, retry failing and succeeding, disk menu, another slot, pending offer), long message wrapping, localStorage
removed (labels, load and save errors, recovery), and the disabled Disk.4 save entry. Synthetic tests; the layout is the remake's
own list menu, not the original's disk-menu artwork.

## Typed codes

Session: `disk4-session`, `disk4-provenance`, `offer-pending`, `graph`, `unsupported-state`, `invalid` (with the field
path), `mismatch`. Slot: `empty`, `no-storage`, `corrupt`, `unsupported-version`, `invalid`, `legacy-incomplete`, `bad-slot`,
`write-failed`. `Game` adds `resources` (scenario graphics could not be built) to the load errors and `game-over` (save refused while `$156AA` bit 3 is set) to the save errors.

## Included and excluded, exactly

**Included:** everything in the field table above, i.e. state image, map words, cell flags, object records and count, the 99 tank
slots, 60 + 30 enemy slots with their crusher fields and the raw `+$16` pointer of every enemy slot (free ones included, added in version 7), 40 ship/missile slots with their extras and reservation cells, the gun
baseline and remembered launch target, `$144C9` sub-tick and tick flags, loop position, system flags, pause, queued day, warning
lights, alien / meteor / spawner, fuel warning, simulation and solar-phase RNG states, marker pins, the 30 effect slots with their holes and
the slot-assumption flag (version 8; versions 6 and 7 stored a dense list) and view origin.

**Excluded (by design, with consequences):**

- Sim `messages` and `events` queues (emptied on load). They are presentation hand-offs: `Game.updateMap` (`game.ts`) drains
  `Sim.events` after every map update, and the map is ticked only in the map stage (the disk menu is not). So none is pending at an
  ordinary idle save (static trace, 2026-11-13). If one were ever pending it would be lost.
- A **pending Earth offer**: it holds a continuation closure; capture refuses (`offer-pending`) instead of dropping it.
- The message log (`Messages`), blinking, UI modes (marker mode, build menu, windows), sound state: presentation only. (The effect
  slots are **not** in this group since version 6, see above; no other presentation state is saved.) The alien and meteor sprites are
  read from the saved alien / meteor records. The untagged `ObjectLayer.extra` drawables are outside the traced draw list and
  have no saved form: **capture refuses a non-empty `extra` list** (`unsupported-state`) instead of silently losing it; nothing in
  the shipped game fills it. Solar phase generation was added in version 4: the remake keeps a World-owned PRNG separate from
  Sim RNG and saves its state. The seed comes from `Math.random`, approximating the original beam-position bit; it is not an
  original-compatible RNG. Versions 2, 3 and version-less saves have no such state and are restored to the fixed state 0 (`FIXED_SOLAR_PHASE_STATE`). Before 2026-11-13 they kept the target world's `Math.random` seed, so loading one slot twice gave different future solar phases and the next save stored a random state (handoff 2026-11-13-solar-phase).
- Anything a custom Sim random generator without `getState` produced: the save then has `rng: null` and the target keeps its own.
- The checkpoint recorder, hooks and callbacks (rebound by the new scene).

**Refused, never written:** a non-empty `ObjectLayer.extra` list (`unsupported-state`, see above), a Disk.4 continuation scene (`disk4-session`, the SAVE menu entry also stays disabled), any record with
Disk.4 provenance (`sourceRaw` / address / flag pointer / saved control) (`disk4-provenance`), a graph whose objects do not share
one world / buffer set (`graph`), and live state outside the ranges the loader accepts (`unsupported-state`: written nowhere
instead of saved unloadable). A remake save also cannot be loaded *into* a Disk.4 scene; loading from the disk menu builds a new
ordinary scene and so ends a Disk.4 session.

## Save name (version 12)

A save-page row release now opens the original two-stage name interaction. The default is the live date (`DD/MM/YYYY`); clicking accepts it. Main Return opens the editor, whose allowed characters are taken from the raw 53-pair table at Disk.1 `$64C8`; the source table is checked by `test/save-name.mjs`. `$5110` accepts up to 16 characters, but the save tail `$89B4` copies only 15 bytes, so the persisted name is truncated to 15. The save list shows a stored name in place of the date. A programmatic `Game.saveToSlot(slot)` has no user prompt and stores `name: null`; versions 2..11 and version-less saves likewise migrate with `name: null`.

The original prompt strings `$13E`, `$13F` and `$142` are shown on the remake slot page with a wrapped layout. That layout is a remake presentation, not a comparison with the original. Escape and right-click cancel the prompt/editor in the remake; the traced original loop has no cancellation path. The original name routine and save tail are static Disk.1 evidence; no runtime capture of the prompt was made.

## Older saves and year migration

The current version 12, like versions 3 to 9, stores `$142A6` as elapsed years, matching the original's new-game clear and January increment. The top-bar year is
`2090 + $142A6`. Version-2 remake saves stored the visible absolute year in `$142A6`; the reader converts it to elapsed years
by subtracting 2090 before validation/restore. Version 3 already stored elapsed years. Version-less saves use the same conversion when they pass the existing
completeness checks. A legacy absolute year below 2090 is rejected as invalid. Reading does not rewrite localStorage; the next
successful save writes version 12.

**Enemy `+$16` pointers in versions 2..6 (lossy assumption).** Versions 2 to 6 stored only each enemy's `reserveX/Y`, never the
raw per-slot `+$16` long. The reader migrates every such save that has an enemy system (`enemies` not null) deterministically:
an **occupied** slot's pointer is `cellFlagPointer(saved reserveX, reserveY)` when the saved reservation is on the map (the
best available fact: for an enemy that had claimed a cell it is exact; for a wave enemy that had **not yet moved**, the old
port stored the spawn cell there, whereas the original would hold the slot's older value, so that case is already an
approximation). An outbound aircraft can be alive for a pass with `reserveX/Y = -1/-1` after its movement code has stored the
pointer of the off-map next cell; for that case the migration reconstructs `cellFlagPointer(x + dx[dir], y + dy[dir])` from
the saved position and direction. A ground slot with no playable reservation and every **free** slot instead gets pointer
**0**. The free tail cannot be recovered: the stale pointers that freed slots really held were never written down, and 0 is
only the value one external pre-November RAM snapshot showed for never-used slots (enemies.md section 3b; not proven for
first-boot RAM, and a slot that was used and freed would normally hold a stale cell). The result is reported as
`ReadResult.enemyPointersAssumed = true` (also in `SlotSummary`) and is **not a claim of exact continuation**: a later death
that would have released a stale cell releases nothing instead. Pointer arrays found in a text of version 2..6 are ignored (overwritten by the derivation). A save without an enemy system assumes
nothing (`enemyPointersAssumed = false`); a version 7 or 8 text must carry its own arrays (missing = `invalid`). Migration is all-or-nothing:
a malformed enemy record in an old save is a typed `invalid` slot error, never a partly migrated save. Effects and every
earlier migration (year, solar RNG, hardware counters, effect pool) still apply unchanged.

**Slot labels.** `slotWarning()` in `save.ts` builds the suffix of the slot list line (`slotListLabel()` composes the whole line).
The suffix is a character budget: `SLOT n  dd/mm/yyyy` (18 characters) plus at most 13 characters (`SLOT_SUFFIX_COLUMNS`), so
reachable labels are at most 30 characters. The real limit is pixels: the list (`MenuScene`, `MENU_PANEL` in `menu.ts`) draws its
text from x 40 in a 240-px panel (right edge x 279) with the Disk.1 font (5 px a glyph, 4 for space and "/"). MEASURED from the
user's Disk.1 by `test/slot-label-width.mjs`: the widest reachable label, `SLOT 8  31/12/2099 PTR UNKNOWN`, has 143 px of ink (right
edge x 182); the widest of ANY flag combination, the unreachable `FX/PTR/V1/TBL`, has 150 px (right edge x 189). Every label fits with 90 px
to spare, so no label is clipped. This is a measured fit with the local font, not a comparison with the original screen. Pixel widths
for the single-assumption labels: EMPTY 63, STORAGE OFF 90, UNUSABLE 76, date alone 84, ` V1` 97 (ink, from x 40).
Every applicable assumption is named, so a migrated save can show several at once (FX = effect pool or slot numbers assumed,
PTR = enemy pointers assumed, V1 = version-less, TBL = descriptor parity assumed, see the table below):

| Assumptions held | Label (suffix) | Columns |
|---|---|---|
| none | (empty) | 0 |
| FX, empty pool (versions 2..5, `effectsAssumedEmpty`) | `" FX UNKNOWN"` | 11 |
| FX, slot numbers (versions 6..8+, `effectSlotsAssumed`) | `" FX SLOT UNK"` | 12 |
| PTR | `" PTR UNKNOWN"` | 12 |
| V1 (version-less) | `" V1"` | 3 |
| TBL (versions 2..10) | `" TBL UNK"` | 8 |
| FX + PTR (either FX kind) | `" FX/PTR UNK"` | 11 |
| FX + TBL (either FX kind) | `" FX/TBL UNK"` | 11 |
| PTR + TBL | `" PTR/TBL UNK"` | 12 |
| V1 + TBL | `" V1/TBL UNK"` | 11 |
| FX + PTR + TBL | `" FX/PTR/TBL"` | 11 |

Rule: one assumption keeps its wording above. Two or more are joined with `/` in the order FX, PTR, V1, TBL, and ` UNK` is added
only when it fits in 13 columns. The three-way combination therefore has no `UNK` (`" FX/PTR/TBL UNK"` is 15 columns). Consequences:
(a) the FX kind is not shown when FX is combined (the `SLOT` wording of `" FX SLOT UNK"` is lost in `" FX/TBL UNK"`); the save
still stores and validates the distinction, and the single-assumption label keeps it; (b) a version-less save never holds FX or PTR,
so the four-way combination (14 columns) is unreachable. Every reachable combination of the flags is pinned in `test/save.mjs`
(14 combinations, widest 30 columns) and the per-version labels in `test/eclipse-parity.mjs` Part 1j (v2..5 `" FX/PTR/TBL"`, v6
`" PTR/TBL UNK"`, v7..10 `" TBL UNK"`, all at 31 columns or fewer with the `SLOT 4  31/12/2099` prefix). A version 11 save of the
current build shows none unless it carries an assumption forward.

**Descriptor exchange parity in versions 2..10 (lossy assumption).** Versions 2 to 10 stored no parity of the `$11024` swap. The reader migrates them with `tileExchange` = false (the disk-menu value: every save is taken inside the disk menu, where the original's entry has already toggled the table) and `tileExchangeAssumed` = true, reported as `ReadResult.tableAssumed`. The slot label is ONE suffix (`slotWarning`), so `" TBL UNK"` appears only when no FX, PTR or V1 warning applies: `test/eclipse-parity.mjs` Part 1j shows `" FX/PTR UNK"` (v2-v5), `" PTR UNKNOWN"` (v6) and `" TBL UNK"` (v7-v10). For v2-v6 the table assumption is therefore not shown; the flag is still kept, and whether it should be shown is an open display decision. This is a static inference, not a verified state. The review of 2026-11-13 found that the raw Disk.1 bytes support every traced caller (game-state.md 5.1 item 3), and that under those callers the map parity equals bit 6 in every reachable state (`test/eclipse-parity.mjs` Part 1k, a 20000-step walk), so the menu parity is 0 for every save taken from the disk menu. The assumption is exact under the traced model; it is not verified against the running original, and the carry through the tail and Disk.4 paths is not verified. The bit-6 value was rejected: the menu's own parity is 0 while bit 6 is set, so bit 6 would invert the view after an exit. A version 11 or later text stores the parity exactly; a later save keeps the assumption flag, since nothing traced can verify it.

**Effects in versions 2..5 (lossy assumption).** Versions 2 to 5 never stored the effect list. The reader migrates such a save
that has an object layer (tanks present) to an **empty effect pool** and reports it as `ReadResult.effectsAssumedEmpty = true`; the slot list marks it `FX UNKNOWN`. A save
without object layer gets `effects: null` and assumes nothing. This is a compatibility assumption, **not** a claim of exact
continuation: the live pool at save time may have held explosions, and a full pool changes the combat occupancy outcome (see the
effect entry above). Any `effects` key found in a text of version 2..5 is ignored. Version-less saves have no object layer and so
`effectSlots: null` (and `effectsAssumedEmpty = false`).

**Effects in versions 6 and 7 (explicit slot assumption).** Versions 6 and 7 stored the effects as a DENSE list (`effects`, at most 30
records in list order, `null` without an object layer) and so lost the slot numbers the original uses for allocation and draw
order. The reader validates every record with the same rules as version 8/9 (a malformed one is `invalid` with the old path, e.g.
`effects[0].type`; a null record, more than 30, a missing list or a list without an object layer is `invalid`) and converts: all
records are KEPT, in slots 0..n-1 in list order, slots n..29 free. An EMPTY list converts cleanly (30 free slots, no warning).
A non-empty list is reported as `ReadResult.effectSlotsAssumed = true` (also in `SlotSummary`, label `FX SLOT UNK`) and the
decoded save carries `effectSlotsAssumed: true`: the original slot identities cannot be recovered, so the continuation (which
slot the next explosion takes, the draw order of effects that share a cell) is **not claimed exact**. The flag is durable:
restore stores it in the live `EffectPool` (`assumedSlots`), every later save writes it into version 10 (`effectSlotsAssumed`),
and decoding that text reports the assumption again. The pool clears the flag itself the moment it is empty (an empty pool is
exact), so it disappears once the migrated explosions have expired (at most five passes). Versions 6/7 keys `effectSlots` /
`effectSlotsAssumed` found in a text of those versions are ignored; version 8 and 9 texts must carry both (missing = `invalid`) and a
text that assumes slots for an empty pool is `invalid`.

## Older saves (version-less)

The earlier format had no `version`, and stored only state, map words, objects, `sysFlags` and scroll (no cell flags, no units,
enemies, ships, extras, clocks, RNG or markers). Policy:

- An old save is **migrated** (and flagged `legacy`, shown as `V1` in the slot list) **only if** no map word carries a ground-layer
  mark (bit 14) or air mark (bit 13) and `$1429E` (own ships) is 0, i.e. nothing that the old format could not store was on the map.
  Units, enemies, ships and flags then start empty, the loop position at 0, pins cleared.
- Otherwise it is **rejected** as `legacy-incomplete`: loading it would give counters and occupancy bits without the units behind
  them. The slot is shown as `UNUSABLE`; nothing is deleted.
- A `version` other than 2 to 10 is `unsupported-version`; text that is not JSON or a known shape is `corrupt`; a well-formed old save with
  an impossible field is `invalid`. The old map words were written in host byte order, read here as little-endian (the only
  host the old format was produced on in practice; **HYPOTHESIS**, no big-endian host was available).

## Open points

- Crusher counter range: `validateSession` (and so capture) refuses a live crusher whose `counter` is above 7 (`unsupported-state`).
  Wave spawns copy `counter = e[5] & 0x7f` without a check (`enemies.ts` spawn). A read-only scan of the ten shipped Disk.2 wave
  tables (local data, not committed; 2026-11-13) found 17 crusher entries, all with `e[5] = 0` and `e[6] = 0`, so the refusal is not
  reached with the shipped data. It would be reached only with a modified table.
- Continuation equality is covered for the synthetic graph of `test/save.mjs` (tanks, enemies, ships, a missile, flags, state,
  clock, RNG, and, over the real `ObjectLayer`, the 30 fixed effect slots including holes, a 29 -> 30 allocation into the free slot
  (also a free slot in the middle) and a full-pool refusal that clears the occupancy bit). It is not a statement about
  original-faithful play after a load, and no live original comparison of the full-pool outcome across a save/reload is claimed.
- Version 6/7 saves with explosions migrate with ASSUMED slot numbers (see above); exact continuation of those explosions is not
  claimed, and there is no way to recover the true slots.
- `ObjectLayer.extra` (untagged extra drawables) is approximate and unsaveable; the shipped game never fills it.
- The Earth offer, announce events and the message log could be made part of a save if a case shows they influence play; today
  the disk menu can only open between them.
