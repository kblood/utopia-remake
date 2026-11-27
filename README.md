# Utopia – decompile og genskabning

## Mål

Dekompilere Amiga-spillet **Utopia** (*Utopia: The Creation of a Nation*) og genskabe det som en selvstændig motor. ScummVM er kun en sammenligning for idéen om at indlæse brugerens egne spilfiler, ikke et krav om at bruge eller integrere med ScummVM. Den nuværende referenceimplementation er TypeScript med Canvas 2D i en webbrowser.

Motoren er egen kode og indeholder ingen spildata. Spillet bruger de originale assets fra brugerens egen kopi, og de læses lokalt fra `original/`. Originale diskbilleder, grafik, musik eller kode må ikke committes eller distribueres med resultatet.

Arkitekturen er beskrevet i [notes/ARCHITECTURE.md](notes/ARCHITECTURE.md).

## Kør spillet

Krav: Node.js 20 eller nyere.

1. `npm install`
2. `npm start` bygger `dist/` og starter en lokal server på `http://127.0.0.1:8080/` (`PORT=<nummer>` ændrer porten).
3. Åbn adressen, der udskrives i terminalen.
4. Vælg mappen med de udpakkede WHDLoad 1.2 (0757)-filer. Mappen skal indeholde `Disk.1`, `Disk.2` og `Utopia.Slave`; `disk.4` er valgfri.
5. Musen: venstre knap klikker og vælger, højre knap åbner de sekundære vinduer (fx ordrer og diskmenuens ekstra sider).

Filerne læses lokalt i din browser og uploades aldrig.

**Start.** Efter sprogvalget kører originalens indlæsning og diashow i ca. 4 minutter. At holde en musknap nede gør kun den skrevne tekst hurtigere. Kodetjekket accepterer et vilkårligt tal efterfulgt af Enter (sådan opfører WHDLoad-slaven sig).

**Diskmenuen.** Scenarie-ikonet kræver et ekstra klik for at åbne listen. Vælg et scenarie og tryk på EXIT-ikonet for at spille. Tutorial-ikonet starter med det samme. Gemte spil er remakens egne: de ligger i browserens localStorage, ikke på originalens gemmedisk. Højreklik på diskmenuen åbner remakens menu (REMAKE MENU).

**Skibe.** Bemand skibsværftet i bemandingsvinduet, byg et skibsværft nær en opsendelsesrampe, og bestil en klasse i værftsvinduet. Værftet har brug for malm og våben på lagrene. Et nyt skib har ingen brændstof (undtagen den femte skibstype, der kræver fusion-opfindelsen); det fyldes op ugentligt fra en brændstoftank inden for rækkevidde. Skibe kan sendes til fronten, når en efterretningsrapport er kommet (finansieres i efterretningsvinduet).

**Tanke.** Et bemandet tankværft med malm og våben bygger tanke. Vælg "to the front" i tankvinduet, indtast antal, tryk Return og luk vinduet. Tanke har ingen vejfinding og kan stoppe bag forhindringer; bestil dem igen.

**Aliens.** Frontflåden kæmper ugentligt. Styrken afhænger af antal og type enheder og af teknologiniveauet.

## Status

The browser engine runs the title and intro, scenario selection, map, interface screens, simulation, units, music and sound from a user-selected WHDLoad 1.2 (0757) game folder. It contains no game assets. After the language choice the picture fades out for 45 updates and then the boot stages run (`src/game/boot-stages.ts`): the LOADING message, the code-check picture from block A, the 29-slide show from block B with its captions, the final message and the module ramp. Their timing follows the traced VBL counts. The code check is the WHDLoad 1.2 slave's patched version: it shows the typed number but accepts any entry, so no answer is derived from the manual. The sector loads take no time, and no emulator comparison of the boot stages exists (`notes/formats/text.md`, "Language screen and what follows"). Then the boot disk menu opens. Input is handled in three separate steps: names and sizes recognise the profile (`Disk.4` is optional, so a folder without the save seed starts); the bytes of `Disk.1` (`DOS\0`) and `Disk.2` (`UTOPSCEN` header and every sector range declared by the ten scenario records in bounds) are then validated before music, sound or `Game` are constructed, with typed errors instead of exceptions for malformed or truncated files; neither step proves runtime compatibility with the original, and ADF images are not accepted. Disk.4 preparation includes a bounded XPKF/MASH decoder (`src/data/xpk-mash.ts`), parsers and typed area decoders (`src/data/disk4*.ts`), and detached restore layers in `src/game/disk4-load.ts`. These prepare state, map, flags, object slots, own tanks, inert Sim helpers, enemy rosters, and own ships/missiles. `prepareDisk4HeadlessEnemies` additionally adopts the fixed-slot enemy roster and the own ship/missile roster into one `EnemySystem` (ships into `sim.fleet`) without initializing or mutating anything; the caller advances enemy movement with `pass(clock)`; `Sim.periodicPass()` (inside the headless `Sim.loopPass()`) consumes traced gun periods, and `frame()` is a legacy no-op. Enemy allocation reuses the first free fixed slot, matching the scanned original routines. Saved ships continue from their saved velocity, next mode, turn and `+$14` reservation cell; restored missiles follow the traced `$4408` flight and the daily `$ACE2` destroy/refresh, resolving the current occupant of their saved enemy slot. Type-24 crushers are adopted with their saved `+$13` toggle/counter and `+$14` animation and use a crusher-specific step traced from `$11F12`/`$11F42` (candidate order, arrival, occupancy and building-destruction order, acid, border; notes/formats/enemies.md 3a); only a counter above 7 or an animation above the table maximum is refused, as are unsupported missile modes and bad pointers, because those saved states are untraced. Evidence is a static trace plus synthetic tests only. Game.activateDisk4 reads the saved Disk.2 id at $1453E and scenario index at $135C2, matching the original load path; the map matcher is advisory and can suggest recovery only when the saved index is invalid. The load path applies the traced shared reset and clears the 30 effect slots, but other post-load behavior remains incomplete. Synthetic tests include an optional golden check against local files when present. An experimental, opt-in activation (`MapScene.fromPrepared`, `Game.activateDisk4`, disk menu entry LOAD DISK.4 when the picked folder contains `disk.4`) builds a live map scene around that same prepared graph with hook-binding APIs, without replacing it or advancing saved state while constructing; the initial frame is drawn without ticking. It is labelled experimental Disk.4 continuation, not full save fidelity: the traced `$875C-$87DA` reset is modelled for `sysFlags`, pause, queued day and warning lights, and `$88DC-$88E6` clears the 30 effect slots. The RNG state and remaining `$802C` post-load behavior are not restored; active alien/meteor records are accepted only within validated traced domains. The remake Save is disabled for such a session. Scenario choice is requested only when saved `$135C2` is invalid; a valid saved index is authoritative. A failed activation keeps the previous scene. Tests use synthetic Disk.4 state; the `disk4-scene` activation/rendering checks require the player's local Disk.1/Disk.2 assets. No running-original activation comparison has been made; export and direct ADF/HDF/IPF support are not implemented. The local ADFs do not match this profile as drop-in inputs, and the discovered HDF paths do not contain usable game data; see [notes/formats/utopia-disks.md](notes/formats/utopia-disks.md).

Opt-in runtime checkpoints for comparing the live map loop with the running original: `MapScene.enableCheckpoints()` / `captureCheckpoint()` (`src/game/checkpoint.ts`) return deep-frozen, JSON-serializable snapshots of the day timer, pass and `$144C9` counters, economy, population/job/resource counters, object records and construction sites, fixed tank/enemy/ship slots (offsets, health, mode, reservation pointer), occupancy bits and queued messages/events at the end of each completed main-loop pass. They are read-only, off by default, kept only in memory (the engine never persists or logs them) and contain no asset bytes or hashes; exact boundary, fields and limits are in [notes/formats/runtime-checkpoints.md](notes/formats/runtime-checkpoints.md). They are remake instrumentation. Three optional local original comparisons exist: the tank slice `test/tank-original-compare.mjs` (one run, one tank, an order baseline plus passes 6/14/22/30/38) matched at all six compared checkpoints in runs on 2026-11-06 and 2026-11-07; the separate November production comparison `test/production-original-compare.mjs` matched the monthly production transition and four continuous special-sprite checkpoints with zero divergences on 2026-11-06 and was rerun with zero divergences on 2026-11-07. The RAM-staged invasion comparison `test/invasion-original-compare.mjs` also passed six checkpoints through gun-kill and the next pass with zero divergences in its compared groups; its staged baseline is internally inconsistent and does not establish ordinary-play parity. All require the player's external Copperline captures and are skipped otherwise; see [runtime-checkpoints.md](notes/formats/runtime-checkpoints.md) section 6 and [sim-port.md](notes/formats/sim-port.md) for exact results and limits. A fourth optional, read-only pixel comparator, `test/pixel-compare.mjs` (`UTOPIA_PIXEL_CAPTURE=<png>`, `UTOPIA_PIXEL_STATE=title|language`), checks one native 320 x 200 PNG of the title art or the language picture against the remake's own frame at offset (0,0); it reports other sizes and other screens as unavailable rather than comparing them. On the player's reference captures the title region (rows 0..179) and the language picture (all rows, excluding the 12-pixel hardware pointer overlay) matched exactly on 2026-11-10; the evidence and limits are in [graphics-and-music-blocks.md](notes/formats/graphics-and-music-blocks.md). A fifth optional comparator, `test/map-capture-compare.mjs` (`UTOPIA_MAP_CAPTURE=<png>`, `npm run compare:map`), aligns one Copperline window grab of scenario 0 (2x horizontal, searched origin) and compares the map layer only: on 2026-11-10 its 34,816 map pixels matched, including one selection cell verified against tile 58, while the top bar, the right-panel indicator and the message panel are reported and not compared ([map-rendering.md](notes/formats/map-rendering.md) section 11). A sixth optional, read-only comparator, `test/build-menu-capture-compare.mjs` (`UTOPIA_MENU_CAPTURE=<png>`, `npm run compare:menu`), aligns one Copperline window grab of the build menu panel with the remake's own render of page 2 (tank construction yard picked): on 2026-11-10 its 41,635 non-pointer panel pixels matched exactly, with the 29 hardware-pointer pixels excluded by an explicit input; see [building.md](notes/formats/building.md) "Panel pixel comparison". Two further optional capture comparators exist, `test/build-side-preview-capture-compare.mjs` (`npm run compare:side`) and `test/construction-site-capture-compare.mjs` (`npm run compare:site`); the 2026-11-13 documentation audit did not re-check their results.

The disk menu (`src/game/disk-menu.ts`) is the original picture with its nine icons (pressed look, one click per press, action on the release), the shared music list, music and effects toggles with their original messages, exit and the tutorial start; all of it is a static Disk.1 trace with synthetic tests, not an emulator comparison. The floppy handlers (load, save, scenario disk, format) are not emulated: the remake's own save/load, scenario list and the experimental Disk.4 continuation are separate remake pages (right button on the disk menu), not original screens. The remake's own save/load (`src/game/save-session.ts`, `src/game/save.ts`, `Game.saveToSlot` / `Game.loadFromSlot`, localStorage slots 0-7, version 12) stores the live session of the current remake (or, from the disk picture, the scene held on the scenario list, which is what the original's RAM holds at that point): state image, map words, cell flags, objects, the 99 tank / 60+30 enemy / 40 ship-missile fixed slots with extras, reservation cells, the raw per-slot enemy `+$16` pointer of every enemy slot (free ones included, because the original's death routine releases the cell that stored pointer names) and missile slot references, clocks, flags, simulation RNG, separate solar-phase RNG, exact main-loop phase and a pending immediate pass after modal exit, deterministic CIA/raster approximation counters, the `$156A9` bit-5 blast mark (version 10; older saves migrate with it clear), pins, the 30 fixed effect (explosion) slots with their holes and view. Save names follow the original name step (date default or a typed name); the name is stored in version 12 and shown in the slot list. The effect pool is gameplay-relevant (a full pool changes the occupancy outcome of a combat explosion, and the slot order decides draw order), so native v6 and later persist it (version 8 stores every slot; versions 6 and 7 stored a dense list and migrate with all records kept in slots 0..n-1 but ASSUMED slot numbers, flagged `FX SLOT UNK` and carried by a durable `effectSlotsAssumed` flag until the pool drains, not exact continuation); versions 2-5 never stored it and migrate with an empty pool as a lossy compatibility assumption, not exact continuation. Capture refuses a non-empty untagged `ObjectLayer.extra` list instead of losing it. Versions 2-6 never stored the raw enemy pointers either: they migrate with occupied slots derived from their saved reservation cell and free slots set to 0, also a lossy assumption (the slot list shows `FX UNKNOWN`, `PTR UNKNOWN` or `FX/PTR UNK`). The zero default rests on one external pre-November RAM snapshot and is not proven for first-boot RAM. Loading validates everything and builds the target scene off to the side, so a refused save never changes the running session; a refused save or load opens a disk-menu error screen (typed code and message, retry, another slot, back; the map is untouched), and a missing localStorage labels the slots `STORAGE OFF` instead of `EMPTY`; old saves migrate where their missing state can be reconstructed and otherwise are rejected. It is the remake's own record, not Disk.4: Disk.4 write/export and parity do not exist, imported Disk.4 sessions cannot be saved, and the Earth offer, message queues and other presentation state are not saved (field list and exclusions in [notes/formats/remake-save.md](notes/formats/remake-save.md)). Verified by synthetic round-trip tests and scripted menu-click tests (`test/save.mjs`, the menu part needs the local Disk.1/Disk.2) only; no comparison with the running original.

The active alien apparition (type 19, record `$144A8`) is drawn on the map by a read-only drawable adapter (`src/game/alien-sprite.ts`, `ObjectLayer.apparition`): static Disk.1 traces establish its anchor (including the `$3604` y adjustment of -13), signed `+3`/`+4` pixel offsets and `$3694` edge rules for animation frames 0..3. It uses the masked blit and shared per-pixel right clip (including the x = 255 quirk), and drawing does not write state, RNG, occupancy or effects. Artwork/palette parity with the original remains unverified. Valid active alien and meteor records in Disk.4 are accepted within their traced state domains and continue through inert hydration; malformed active records return `special-state`. These are bounded static-trace/synthetic-state checks, not graphics or Disk.4 restore parity (`test/alien-sprite.mjs`, `test/meteor-sprite.mjs`, `notes/formats/map-rendering.md` 7.2).

Map hover now alternates the original selection tile (descriptor index 58) over the pointed cell, based on the static `$6568-$658E` trace and synthetic/local-data map-loop checks. A cell already drawn as a neighbour skips the blink toggle, matching the original claim check order. The software pointer switches between the original Disk.1 arrow and map-cell hover graphics using the `$2FBA` selection rule, and applies `$2CDA`'s 312×192 limits from modes 1/3 and the `$15620` image defaults in mode 2. Browser-vs-original hotspot/pixel alignment remains open (`notes/formats/map-rendering.md` sections 8 and 10).

The active meteor (type 21, record `$1449C`) is drawn the same way by a second read-only adapter (`src/game/meteor-sprite.ts`, `ObjectLayer.meteor`, polled at draw time, nothing retained or written): static-trace anchor, signed offsets `+3`/`+4`, frame `+5`, and `+6` as both the countdown and the drawing lift (`$78` at creation, so a new meteor starts 120 pixels above its cell), through the existing masked blit; the simulation lifecycle and effect hooks are unchanged (a valid saved meteor record from a Disk.4 image is drawn and continues its traced countdown; see `notes/formats/game-proper.md`). Unresolved and not claimed: the original's paused-meteor control-flow anomaly, and any emulator visual parity (same-cell order is the traced draw-list sort, see the next paragraph) (`test/meteor-sprite.mjs`, map-rendering.md 7.2).

Sound-effect channel ownership is modelled from a static re-trace of the original (2026-11-07; notes/formats/sfx.md "Channel ownership", music.md): `SfxScheduler` (`src/audio/sfx-scheduler.ts`) is a frame-stepped, event-emitting model of the request routine `$11B4`, the vertical-blank starter and timers `$1264`, the music switch `$1062`, the effects switch `$10BC`, the track loader `$110A` and the player's channel hand-over commands 7/8: the module's voice is released at the request, handed back only if the music is active at the expiry, music off / track load cut the sounding effect but not its timer, effects off clears the timers and holds queued entries. `createSfx` projects its events onto one cancellable WebAudio node per voice on the AudioContext clock, `Music.onChange`/`onBlock` carry the transitions and the audio-block tick, and the former `setTimeout` mute timers and the fade-out timer are gone (`test/audio-ownership.mjs`, synthetic fake context, plus the real `Music` when Disk.1 is present). Static trace and synthetic tests only: no emulator or audio capture exists, so no waveform, timing or Paula-level parity is claimed. Approximations that remain: mute and hand-back at block (about 46 ms) granularity, the effect tail after an expiry and the module's restart from its loop pointer after a music off/on are not modelled, and the traced cases where a released module voice is never handed back are reproduced from the code reading alone.

Map drawing follows the statically traced original draw list (`src/game/draw-list.ts`, `src/game/objects.ts`, `src/game/effect-pool.ts`; notes/formats/map-rendering.md 7.2b/7.4, units.md section 6): entries are admitted in the `$333A` order (own tanks, ships/missiles, enemy ground, enemy air, the 30 fixed effect slots, alien, meteor), sorted globally with the literal unstable `$4860` selection sort, and drawn through one cursor over the 64 painter cells; flag-bit-1 entries (enemies) are withheld, together with everything after them, while the redraw gate is closed (opened by an own tank/ship, a visible animated cell or invention bit 17), and own tanks and enemy ground units redraw their flat neighbour tiles first. `MapScene` snapshots the gate once per normal main-loop pass and reuses it across video redraws; modal passes retain the previous snapshot. Effects live in 30 fixed slots (first free slot, slot-local expiry), and picking scans the same sorted list (enemies, effects and the specials block, only own tanks and ships are order targets). Static trace and synthetic tests only (`test/draw-list.mjs`); no emulator frame comparison or pixel parity. Still open: exact snapshot placement/frame timing within the pass, paused-meteor control flow, artwork parity, and the untagged `ObjectLayer.extra` list, which is an explicit approximation outside the traced list (appended last, not saved).


The map window background follows the static `$16012`/`$15F9A` trace (`src/game/map-background.ts`, map-rendering.md section 9): rows 0..23 and 24..87 (x 0..255) come from the picture's own 32x16 texture strip, the latter ANDed with the generated 63-state mask pattern, rows 89..159 and the x 256..271 column from the initial picture, and row 88 is never written. `MapScene` maintains two persistent pixel buffers and draws on scheduled main-loop passes, restoring those four regions while preserving other pixels in each buffer. Between passes it keeps the displayed image; modal menu redraws do not swap buffers or write them back (the pre-menu frame returns on exit), and the remake's own overlays (button flips, message line/log, side preview) are reset from the picture each pass because `$16012` never restores those areas. This implements the statically traced cadence, while the configured browser pass timing remains an approximation. Asset-free vector checks and a local-picture region check live in `test/map-background.mjs`, with a `MapScene` integration assertion in `test/map-loop.mjs`. No emulator frame comparison establishes background pixel parity; sprite/tile artwork parity is separate.

The build menu (`src/game/build-menu.ts`, used by `Controls`) draws the panel from the same page data it uses for hit testing: the `$E908` frame, the `$E95C` button column, the building artwork of every listed tile (1x1 tiles and the four-tile 2x2 buildings of page 3, composed in the traced `$6A22` order), the title, a name/T+6-price detail after an item click (with the unaffordable line) and the selected-building preview, all from decoded tiles passed in by `MapScene` and read-only. After commit, build mode also redraws the side preview at `(272,52)` from the committed tile, as `$6B10` does. Following the static trace of `$B2AA`-`$B680`, an item click now only picks the item (the menu stays open) and the exit button commits it, and the four research-gated slots (page 1 slot 10, page 2 slots 8-10) are empty until their research bit is set. The remake keeps the original's last build-menu page and renders the destination page on release; the original's 14 strip erases are synchronous between VBL waits, not a 14-frame animation. Text uses colour 1, as the map loop resets `$156AB` before polling the menu-open click. These behaviours follow static code evidence and synthetic/local-data tests, not a running-original screenshot comparison, so no art parity is claimed. Checked by `test/build-menu.mjs` and `test/build.mjs`.

The game image and data formats have been analyzed in the notes, and the implementation has headless subsystem coverage. One original Copperline run observed a tank yard producing a tank, a marker-pin order, and tank movement through arrival; the remake's connected lifecycle test remains a staged synthetic regression. Separately, `test/tank-original-compare.mjs` (optional, reads the player's external captures via `UTOPIA_TANK_TRACE_DIR`, never copied into the repo) stages a live scene on the scenario-0 map and compares tank fields, occupancy/flag bytes, `$144C9` and the pin at the baseline after the order and at passes 6/14/22/30/38 of that one run; it found and fixed one divergence (the remake cleared `+C` on arrival, the original keeps it). This is one tank on one route at 5-VBL passes, not broad gameplay parity. A second, separate run (01/11/2090) is the basis of the optional `test/production-original-compare.mjs` (`UTOPIA_PRODUCTION_TRACE_DIR`): it seeds a real scene from the captured pre-transition RAM where covered, replays the ordinary monthly pass with the captured RNG results injected and checks call order/ranges, stocks, economy, the yard/tank spawn and covered map cells (details and limits in [notes/formats/sim-port.md](notes/formats/sim-port.md)); it exposed and fixed one divergence (the `$9C80` fraction roll range). That capture also confirmed `$142A6` is elapsed years, now used by new-game initialization, the early-crime bonus and meteor gate; old remake saves migrate their absolute-year value. One month of one scenario; no broad parity claim. Static Disk.1 tracing now drives wave scheduling, hardware-input approximations, spawn ordering and CIA-gated attacks; `test/invasion-lifecycle.mjs` connects a queued ground wave, movement, a real building demolition, and a scheduled gun kill through the live MapScene using a synthetic fixture. In addition, the optional `npm run compare:invasion` replay has passed one RAM-staged original capture at queued, spawned, moving, demolished, gun-kill and after-kill checkpoints, with zero differences in the compared groups under captured RNG/TOD/raster inputs. The staged baseline has an inconsistent object count relative to its non-empty records, so this is evidence for that captured state sequence only, not ordinary-play invasion parity. Its manifest requires a validated `provenance` block and each supported RNG/TOD/raster label is bound to an exact Disk.1 return address; `test/invasion-contract.mjs` checks the contract synthetically. The tank, production and invasion comparators are separate from `npm test` and require their external capture directories. Disk.4 still needs original post-load initialization, unsupported-state coverage, robust scenario identification for heavily edited maps, validation of the experimental activation against the original, export, and compatibility checks against a persisted save; restored ship landing is statically traced and synthetically covered, without an emulator comparison; no full playable restore or roundtrip compatibility is claimed. The original random routine `$2DCC`/`$2DCA` exists only as an isolated arithmetic model (`src/game/original-rng.ts`, `test/original-rng.mjs`): its arithmetic matches 50 raw calls of one local capture (7 of the 62 call sites), but it is not the Sim's generator. A static per-site audit records D0/D2 setup and unresolved contexts in [notes/formats/original-rng-callers.md](notes/formats/original-rng-callers.md), but it does not prove dynamic reachability; the seed initializer `$2DA0` and first-use seed provenance remain unverified, and no full call-site parity is claimed.

Fresh scenario entry now queues the original first day and initializes the marker-selected alien at the boot-menu exit (the first entry into the map); new scenario states also restore the initialized weapon values at `$145A3..$145A9`. This follows a static Disk.1 trace and synthetic/local-data tests. The initial alien marker choice uses the remake RNG, and the first update still follows the remake's configured VBL cadence, so exact first-frame timing and original RNG placement are not claimed.

## Emulatorer

| Emulator | Sti | Bemærkning |
|---|---|---|
| WinUAE 6.0.3 | `E:\Games\Emulator\Amiga\WinUAE-6.0.3\winuae64.exe` | **Brug denne** som referencemaskine og til debugging. Udgivet 3. marts 2026; samme version som i [referencekørslen](notes/reference-run.md). |
| WinUAE 4.9.1 | `E:\Games\Emulator\Amiga\WinUAE\winuae64.exe` | Ældre build. |
| WinUAE 4.5 | `E:\Games\Emulator\Amiga\WinUAE\winuae64_floppy.exe` og `E:\Games\Emulator\Amiga\New Releases\WinUAEFloppy\WinUAE\winuae64.exe` | Gamle floppy-varianter fra 2021. Brug dem ikke til sporing. |
| WinUAE 3.x og ældre | `E:\Games\Emulator\Amiga\Emulation\WinUAE\`, `E:\Games\Emulator\Amiga\Amiga Forever 2016\WinUAE\` | Ældre builds. |
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
