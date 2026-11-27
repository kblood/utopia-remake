# Utopia handoff: release bytes and keypad digits in the key cell (2026-11-14)

Model and routing: Claude Haiku 5.5, run inline as the research sub-agent. No orchestration tool was called, so `claudeAgent` routing was not confirmed and no model switch is claimed. No emulator, no original writes, nothing committed or pushed. The dirty worktree was preserved. Disassembly used `tools/game_dis.py` (capstone was installed into the user's Python for it) on `original/utopia-whdload/Disk.1` (read-only). The RAM-to-file mapping is `file = address + $28800` for the game image (`tools/key_reach.py`) and `file = address - $74F18` for the boot stage.

Read first: [HANDOFF-2026-11-14-key-cell-batch.md](HANDOFF-2026-11-14-key-cell-batch.md) (its open points 1 and 4 are updated here), [formats/game-proper.md](formats/game-proper.md) "Keyboard encodings".

## 1. Questions and answers

| Question | Answer | Evidence level |
|---|---|---|
| Does the original store release bytes in the key cell? | Yes. Both keyboard IRQs (game `$2BC2`, boot `$78EE8`) store every serial byte after `not.b` + `ror.b #1`. Nothing before the store tests the byte. | VERIFIED static |
| Do release bytes have bit 7 set? | Almost certainly, by the Amiga convention: the Hardware Reference Manual gives release = code + `$80` (its example: B pressed `$35`, released `$B5`), and the Libraries Manual says a raw value `>= $80` is a release. The image's `not.b`/`ror.b #1` decode is the standard one that moves the up/down bit into bit 7. The image itself does not decode or test the release bit. | CONVENTION (external docs, consistent with the image's decode); not traced in the image |
| Do the consumers match the release encoding? | Yes, for dispatch and entry. Every reader tests exact values or the range 1-8, so a byte with bit 7 set matches nothing. The remake's release token (`keyup:` + name) matches no name, so it dispatches nothing and types nothing, as the original would. | VERIFIED static (given bit 7 = release) |
| Does the remake's encoding and decoding match the key values the handlers consume? | Found one provable mismatch (section 2): keypad digits placed pins. The release token is consistent. | VERIFIED static |

## 2. The mismatch: keypad digits placed pins

- Count entry digit table `$650A` (read by `$5110`; pairs of raw code and digit, read from Disk.1): `$01`-`$09` = 1-9, `$0A` = 0 (top row); `$0F` = 0, `$1D`-`$1F` = 1-3, `$2D`-`$2F` = 4-6, `$3D`-`$3F` = 7-9 (keypad). So the original's entries type keypad digits.
- Pin dispatch in `$15B4A` (`$15C3C` `cmpi.b #$1` / `bmi`, `cmpi.b #$8` / `bgt`, then `tst.b $14636` and `jsr $3202`) accepts raw `$01`-`$08` only. Every keypad code is above 8, so a keypad digit places no pin.
- The remake matched `KeyboardEvent.key` `"1"`-`"8"`, which a keypad digit also produces (NumLock on). So a keypad `1` placed pin 1. That was the mismatch.

## 3. Change

- `src/game/intro.ts`: `KEYPAD_PREFIX` (`"keypad:"`), `keypadToken(digit)`, `isKeypadToken(entry)`, and `typedDigit(entry)` (the digit of a top-row digit or a keypad token; undefined for names, Enter and releases). The `keyUpToken` comment now cites the convention and says the value is not read from the image.
- `src/main.ts`: a keydown with `e.code` `Numpad0`-`Numpad9` and a digit `e.key` pushes `keypadToken(e.key)`; other keys are unchanged. Keypad Enter is still `"Enter"` (both `$43` and `$44` confirm, so no change there).
- `src/game/screens/ui.ts` (`NumberEntry.feed`) and `src/game/boot-stages.ts` (the code check): accept digits through `typedDigit`, so keypad digits are still typed.
- `src/game/map.ts` (`key()`): pins only for `/^[1-8]$/`, so a keypad token (and any other entry) places nothing.

No simulation, timing, or pass order changed. The release handling is unchanged.

## 4. Tests

| File | Added checks | Result |
|---|---|---|
| `test/map-loop.mjs` | keypad `1` completes a pass and places nothing; top-row `1` (control) places pin 1 | 379 -> 381 `ok`, exit 0 |
| `test/screens.mjs` section 2h | `typedDigit` cases; `keypadToken` prefix only; `NumberEntry` takes keypad and top-row digits in order, ignores a release, Enter confirms 429 | 92 -> 95 `ok`, exit 0 |
| `test/boot-stages.mjs` | code check: keypad `4`, release of `4` (types nothing), `2`, then Enter passes with `42` | 45 `ok`, exit 0 |

Mutant (compiled `dist/game/map.js` only, then rebuilt): the pin regex was changed to accept `keypad:` tokens. `test/map-loop.mjs` exits 1. The failure is a crash inside the pin path (`toggleMarker` with a NaN number), not a clean assertion. It is still a detection, and the build was restored (`npm run build` exit 0; `test/map-loop.mjs` exit 0 again).

## 5. Verification

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node test/map-loop.mjs` | exit 0, 381 `ok` |
| `node test/screens.mjs` | exit 0, 95 `ok` |
| `node test/boot-stages.mjs` | exit 0, 45 `ok` |
| `node test/button-sound.mjs` | exit 0, 42 `ok` |
| `node test/intro.mjs` | exit 0, 36 `ok` |
| `node test/window-input.mjs` | exit 0, 173 `ok` |
| `node test/order-input.mjs` | exit 0, 52 `ok` |
| `npm test` (full chain) | exit 0 |

## 6. Static facts recorded (game-proper.md "Keyboard encodings")

- Boot IRQ `$78EE8` (vector `$68`, installed at `$78EA0`): same decode, store to `$79108`. Readers: the boot code-check loop `$78BFC`-`$78C6C` only.
- The spin loops (count entry `$5160`, boot `$78C08`, disk menu `$8334`, save-name `$8958`) read the cell with no VBL wait. The count entry and boot loops clear the cell on each read. The disk menu and save-name loops do not clear it in the loop body.

## 7. Open points (not changed)

1. **Release bit value (CONVENTION, not traced).** The image's decode is consistent with bit 7 = release and no reader contradicts it. A byte-level capture of `$161A0` (or `$79108`) for a press and release would settle the value. No emulator was used.
2. **Overwrite in the spin loops (ASSESSED, not timed).** The count entry, boot code check, disk menu and save-name loops are tight spins. A second key byte would have to arrive between two reads of a few instructions each. The keyboard's byte spacing (handshake-paced) was not measured, so "unreachable" is an assessment. This refines key-cell-batch open point 4: the remake keeping every digit in `NumberEntry` matches the spins in practice.
3. **Disk menu leaves a digit (ANSWERED 2026-11-14, see [HANDOFF-2026-11-14-disk-menu-key.md](HANDOFF-2026-11-14-disk-menu-key.md)).** Static trace: the menu loop `$7EF6` reads no cell; the format prompt `$8314` reads `$8334` and clears nothing; its mouse exit's callees `$2E52` and `$82B8` touch no cell; the unrefused exit `$802C` touches none. A digit left in the cell is therefore dispatched by the first `$15B4A` after the return (`$158B0` -> `$158C2`), in the same iteration as the exit. The remake kept the digit but dispatched it one or more updates late; fixed in `Game.update` (the exit's immediate pass now receives the real key batch), with `test/disk-menu-keys.mjs`.
4. **Keyboard auto-repeat** (unchanged from key-cell-batch open point 2): the remake ignores `e.repeat`; not traced.
5. **Keypad with NumLock off** produces `e.key` names such as `ArrowDown`. Those are not digits, so they are not typed and do not pin, which matches the original's keypad codes. The remake keys off `e.code` for keypad digits, so this relies on `e.code` being `Numpad0`-`Numpad9`.
