# Sound effects: descriptors, samples, the play routine and its call sites

Nothing from the original is reproduced here; only addresses, sizes and structure numbers. Code: `src/audio/sfx.ts` (`parseSfxBank` reads the data from the user's `Disk.1` at run time, `SfxScheduler` is the channel model, `createSfx` plays through WebAudio). Test: `test/sfx.mjs`. Addresses are game-image addresses (`game-proper.md`: sectors `$14C`-`$208` loaded at `$1000`, file offset = address + `$28800`). Tags: **VERIFIED** = read directly from disassembly or data, **HYPOTHESIS** = inferred.

## Verdict (VERIFIED)

The game **does** have sound effects, but only six. They are Paula sample playbacks started outside the module player. A scan of the whole game image for the audio registers `$DFF0A0-$DFF0DF` finds writes only in the vertical-blank tick `$1264` (the effect starter, `$12B0`-`$13B2`) and in the module player (`$15F4`-`$1A7C`, which uses a register base). `$DFF096` (DMACON) writes elsewhere in the game are only the display DMA (`$100`/`$8100`), the loader, and the effect/music channel switch-off. There is exactly one entry point, `$11B4`, with 19 call sites; every one loads one of six descriptors. No effect data exists on `Disk.2`/`disk.4` (the scenario disks hold graphics, maps and text only) and none in the boot stage (the boot stage only plays a module).

## Data

### Descriptor table `$1490` (6 entries of 12 bytes, big endian) (VERIFIED)

| Offset | Size | Field | Goes to |
|---|---|---|---|
| +0 | long | address of the 8-bit signed sample | `AUDxLC` |
| +4 | word | length in words | `AUDxLEN` |
| +6 | word | period | `AUDxPER` |
| +8 | word | volume 0..64 | `AUDxVOL` (call sites may overwrite it first) |
| +10 | word | duration in frames | channel timer `$1518 + 2 * channel` |

| id | Table | Sample address | Length (words / bytes) | Period (rate) | Volume | Duration field | Sounding time |
|---|---|---|---|---|---|---|---|
| 0 | `$1490` | `$2227A` | 4506 / 9012 | 864 (4105 Hz) | 64 (set by caller: 32 or 64) | 98 | 97 frames = 1.94 s |
| 1 | `$149C` | `$2227A` | 4506 / 9012 | 608 (5834 Hz) | 64 (set by caller: 32 or 64) | 68 | 67 frames = 1.34 s |
| 2 | `$14A8` | `$2227A` | 4506 / 9012 | 384 (9237 Hz) | 32 | 44 | 43 frames = 0.86 s |
| 3 | `$14B4` | `$245AE` | 3560 / 7120 | 544 (6520 Hz) | 64 | 48 | 47 frames = 0.94 s |
| 4 | `$14C0` | `$14E0` | 4 / 8 | 630 (5630 Hz) | 32 | 2 | 1 frame = 20 ms |
| 5 | `$14CC` | `$14E0` | 4 / 8 | 680 (5216 Hz) | 54 | 12 | 11 frames = 220 ms |

Ids are the table index (`SFX` in `sfx.ts`). Bytes `$14D8`-`$14DF` hold an 8-byte ramp that nothing references (unused leftover).

### Samples

- **Raw samples on `Disk.1`, sectors `$368`-`$386`** (31 sectors, 15,872 bytes, no packing). Loaded to `$2227A` by `$7D3E` (called from the init code at `$1579A`). Signed 8-bit, no header. Sample A = bytes 0..9011 (ids 0-2 play it at three pitches), sample B starts at 9012 (address `$245AE`, id 3). Sample B's descriptor length (7120 bytes) is longer than the 6860 bytes that remain in the region, but the 47-frame duration at period 544 only plays 6129 bytes, so the end is never reached (tested). The loader reads this region and the effects never touch other disk data.
- **8-byte sine cycle at `$14E0`** inside the game image (`0, 90, 127, 90, 0, -90, -127, -90`): the "sample" for ids 4 and 5. Looped by DMA, so id 4 is a 20 ms blip at about 703 Hz and id 5 a 220 ms tone at about 652 Hz.

### Playback rules (VERIFIED from `$11B4` and `$1264`)

- There is no end-of-sample logic: DMA restarts at `AUDxLC` after `length` words, so a sample that is shorter than its duration loops. Every duration in the table is shorter than the data, except the two sine effects which loop on purpose.
- The timer is decremented once per vertical blank right after the start and again every frame; when it reaches 0 the channel's DMA bit is cleared. A duration field `n` therefore sounds for `n - 1` frames. Frame rate 50 Hz (the slave forces `$910` = 50).

## The play routine `$11B4` and the VBL starter (VERIFIED)

Flags byte `$1581` (image default `$04`): bit 0 extra memory, bit 1 music active, **bit 2 effects enabled** (default on; toggled by the music-menu button at `$10BC`, whose messages are the "Effects on."/"Effects off." strings 404/405), bit 3 explosion variant (below), bit 4 loading (`$111E`-`$1132`), bit 5 toggled by a screen routine at `$4DCA` (unrelated, HYPOTHESIS).

`$11B4` (a6 = descriptor, caller loads `d0 = byte $1582`, which the routine ignores):

1. Return if bit 2 of `$1581` is clear. Disable the VBL interrupt (INTENA `$20`) while working.
2. **Music active (bit 1):** the track's flags word (`$1582` high byte, `$1583` low byte; `$103`, `$203`, `$102`, `$103` for tracks 0-3) names two Paula channels the effects may use. Try the first, then the second; a channel is free when its timer word `$1518 + 2 * ch` is 0. If both are busy the request is dropped. On success the module player's voice on that channel is silenced (player command 7 at `$176E`: clear the channel record, DMACON off, mask bit in `$250C`) and restored when the timer ends (command 8 at `$1794`).
3. **No music:** channels 0, 1, 2, 3 in that order, first free one; all busy = dropped.
4. The descriptor pointer is stored in the one-entry queue `$1520 + 4 * channel`.
5. Re-enable the VBL interrupt.

The VBL handler `$1264` (after the module tick) starts **at most one queued effect per frame**, lowest channel first (`$129C`-`$13B2`): writes `AUDxLC`, `LEN`, `PER`, `VOL`, sets the timer from +10 and turns the DMA bit on; then it runs the four timers (`$13B6`-`$1486`).

Consequences, all VERIFIED from the code and modelled by `SfxScheduler`:
- A channel counts as busy only once the effect has really started (timer non-zero). Two requests within one frame therefore pick the same channel and the second replaces the first in the queue. This makes the double alert at `$117AE`/`$117C0` a single alert.
- Up to two effects at once while music plays (channels from the flags word), up to four otherwise. Panning follows Paula: channels 0 and 3 left, 1 and 2 right.

## Call sites and what they mean

19 calls of `jsr $11B4` in the whole image (the table is complete: a raw scan for the long `$000011B4` finds no other reference, and every descriptor address occurs only at the places below).

| Id | Call site(s) | Routine / event | Status |
|---|---|---|---|
| 0 | `$123EC` / `$12434` through `$1237C`, with bit 3 of `$1581` clear | **Area explosion.** `$12332` (callers `$10D60`, `$116B8`, `$11A50`, `$11CFC`, `$122AC`, `$12798`: blast events, alien/enemy attacks, raids) builds a list of cells at `$7C28` (`$7372`) and calls `$1237C(x, y)` for each, clearing bit 3 first. | routine and variant selection VERIFIED; which in-game event each caller is: HYPOTHESIS |
| 1 | same `$1237C`, with bit 3 of `$1581` set | **Single object destroyed in combat.** `$4732` (the destroy path of units/buildings, callers `$46B4`, `$470A`, `$11C44`, `$11C68`) tests and clears bit 5 of `$156A9` (the "destroyed by an attack" mark, set by the attacker), and if it was set sets bit 3 and calls `$1237C`. | VERIFIED |
| 0/1 volume | `$123E6` / `$1242E` | `$1237C` puts the effect's volume in the descriptor before the call: **32 (`$20`)** at `$123CA` when the cell is outside the 8 x 8 visible map window (sound only); **64 (`$40`)** at `$12412` when the cell is inside the window (an explosion sprite is created too, see `units.md`). | VERIFIED |
| 2 | `$11E90` | Gun building (`$11D34`: daily and per-bit-4 with `a0 = $13248`/`$1325A`, d1 `$1F`/`$0F`) hits an enemy: damage `d7` is subtracted from the target's +8 hit points, then the sound; at 0 the target is destroyed (`$11C30`/`$11C5C`, which leads to id 1). | sound/damage order VERIFIED; "gun turret" naming HYPOTHESIS |
| 2 | `$125FA`, `$12640` | `$12588` (called after each own-unit update, `units.md` "combat hook"): own ground unit hits an enemy in range; destroy via `$11C30`/`$11C5C`. | VERIFIED structure |
| 2 | `$126FC`, `$12746` | The next routine after `$12588` (`$126D6`), same pattern against the object lists `$3A75E`/`$3AB1E`/`$3B466`; destroy via `$46CC`/`$4692`. | structure VERIFIED, target kind HYPOTHESIS |
| 3 | `$E1A2` | Launch confirmed in the missile-launcher dialog `$E086` (reached from the tile-click dispatcher `$7194`-`$71A0` for tiles `$30`/`$31`; strings "This launcher is armed" / "Launch Malfunction!"). After the target check (`$49E8`) a launch record is filled, then the sound. | call path VERIFIED; "missile launch" HYPOTHESIS (title strings fit) |
| 4 | `$57C6` (`$5756`, called from the dialog button loop `$593E` and 10 window routines), `$5990` (`$5948`, called from `$7FC0`) | **Button pressed:** the button rectangle is inverted (`not` over the bitplane rows) and the blip plays; the release routines `$57FA`/`$59C8` are silent. | VERIFIED |
| 4 | `$4136` | **Ship completed.** `$4060` (called from the ship-yard progress `$ACBE`) finds a free launchpad (tile `$48`), places the ship (`$387E`), and plays the blip four times, 11 frames apart (loop `d2 = 3`, `$413E` waits 10 frames per iteration); with no free pad it shows message 199. | VERIFIED |
| 5 | `$AE4A` | Alien-intelligence step `$ADA6` (event 13): spy-report message (string index `$157`) for the current intel level. | message VERIFIED, event name from `game-state.md` |
| 5 | `$B010`, `$B07E` | `$AF12` (alien intelligence, every 10th call) and `$B018` (countdown `$141B2`, from the event handler `$11724`): spy-report message `$157`. | VERIFIED |
| 5 | `$117AE` (+ `$117C0`) | Event 9 handler `$11724` via `$1176E`: attack-warning message (`$8D`). The sound is requested twice back to back, which yields one alert (queue quirk above). | VERIFIED |
| 5 | `$1285C` | Weekly enemy event `$127A0` (`$9A74`): "important news" message (`$186`, queue entry type 6 / 3). | VERIFIED |
| 5 | `$12A0E`, `$12A80` | Event 3 handler `$12A16`: spy-report message `$157` for the intel level. | VERIFIED |

All id 5 sites follow the same pattern: queue a type-6 entry at `$14484`-`$14498`, call `$5A8C` with a message index, then play the alert. So id 5 means "a report/news message arrived" (the strings read "Spy report in...", "Attack Warning", "Important news").

### Event table for hooking (what the remake should call)

| Game event | Effect | Call |
|---|---|---|
| any dialog or window button pressed | 4 (click) | `sfx.play(SFX.CLICK)` |
| ship completed at the ship yard | 4 x 4, 220 ms apart | four `play(SFX.CLICK)` |
| unit or building destroyed by an attack (explosion sprite visible in the window) | 1 (explosion-high), full volume | `play(SFX.EXPLOSION_HIGH, 64)` |
| same, but the cell is outside the visible 8 x 8 window | 1, half volume | `play(SFX.EXPLOSION_HIGH, 32)` |
| area blast, missile impact, raid explosion | 0 (explosion-low), 64 in view, 32 off screen | `play(SFX.EXPLOSION_LOW, vol)` |
| weapon hit on a unit or building | 2 (hit) | `play(SFX.HIT)` |
| missile launched | 3 (launch) | `play(SFX.LAUNCH)` |
| spy report / attack warning / important news line shown | 5 (alert) | `play(SFX.ALERT)` once |

## API (`src/audio/sfx.ts`)

```ts
const sfx = createSfx(disk1, disk2, { music });   // music: the Music object, optional
sfx.play(SFX.CLICK);                               // id 0..5, optional volume 0..64 (explosions: 64 in view, 32 off screen)
sfx.setEnabled(false); sfx.setVolume(0.8); sfx.resume();
```

- Shares the single `AudioContext` of the music (`sharedAudioContext()` in `webaudio.ts`); `Music.dispose()` no longer closes it. Effects are pre-rendered `AudioBuffer`s (cached per id, volume, side) played through their own gain node, so music fades do not affect them.
- With `{ music }` the effects use the allocation rules above: only the two channels of the playing track while music plays, and the module's voice on that channel is muted for the duration (`Music.setChannelMuted`, new). Without it every effect plays on top of the full music.
- Levels use the module mixer's scale and separation (0.5), so an effect at volume 64 peaks at the same level as a module channel at volume 64.
- `play` is a no-op until the browser allows audio; call it from a click/key handler at least once (or `resume()`).

## Not verified

- Never compared with an emulator capture (none was run); the pitch and loop behaviour follow from the descriptors and the DMA rules.
- The DMA start latency (up to one frame) is modelled as "next frame boundary"; Paula's hardware low-pass filter is not emulated (same as for the music).
- Which of the area-blast callers (`$10D60`, `$116B8`, `$11A50`, `$11CFC`, `$122AC`, `$12798`) correspond to which named game event is not traced; the explosion variant is decided by bit 3 of `$1581`, not by the caller.
