// The original save-name prompt/editor (`$8918` / `$5110`), and the remake save page's two-step slot confirmation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diskPath = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(diskPath)) {
  console.log("save-name tests skipped: Disk.1 not found");
  process.exit(0);
}

const { NAME_KEY_TABLE, NAME_TYPED_MAX, SAVED_NAME_LENGTH, SaveNameEntry, isSaveName, typedCharacter, wrapWords } = await import("../dist/game/save-name.js");
const { KEYPAD_ENTER_TOKEN } = await import("../dist/game/intro.js");
const { GameStrings } = await import("../dist/data/gamestrings.js");
const { Game } = await import("../dist/game/game.js");
const { DISK_BUTTON, DISK_MENU_BUTTONS } = await import("../dist/game/disk-menu.js");
const { MENU_PANEL } = await import("../dist/game/menu.js");
const { readSlot } = await import("../dist/game/save.js");

let failed = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const disk1 = new Uint8Array(fs.readFileSync(diskPath));
const keyTableAt = 0x64c8 + 0x28800;
const rawTable = disk1.subarray(keyTableAt, keyTableAt + NAME_KEY_TABLE.length * 2);
const expectedTable = Uint8Array.from(NAME_KEY_TABLE.flatMap(([code, char]) => [code, char.charCodeAt(0)]));
check("raw Disk.1 `$64C8` name table matches all 53 code/character pairs", rawTable.length === expectedTable.length && rawTable.every((v, i) => v === expectedTable[i]), `${NAME_KEY_TABLE.length} pairs`);
check("name table maps lower-case input to uppercase and keypad digits to digits", typedCharacter("q") === "Q" && typedCharacter("keypad:7") === "7" && typedCharacter("_") === undefined);
check("save names accept 1..15 original-table characters only", isSaveName("UTOPIA 2090") && !isSaveName("") && !isSaveName("X".repeat(16)) && !isSaveName("NAME!"));
check("prompt wrapping stays within its configured character width", wrapWords("ONE TWO THREE FOUR", 8).every((line) => line.length <= 8));

const noInput = (keys = [], leftButton = false, rightButton = false) => ({ keys, leftButton, rightButton, pointerX: 0, pointerY: 0 });
const promptEntry = new SaveNameEntry("28/06/2090");
promptEntry.update(noInput());
const returnKey = ["Enter"];
promptEntry.update(noInput(returnKey));
check("main Return enters name editing and is consumed", promptEntry.phase === "edit" && returnKey.length === 0);
const releasedReturn = new SaveNameEntry("28/06/2090");
releasedReturn.update(noInput());
const quickReturn = ["Enter", "keyup:Enter"];
releasedReturn.update(noInput(quickReturn));
check("a Return overwritten by its release before the prompt poll does not enter edit mode", releasedReturn.phase === "prompt" && quickReturn.length === 2);
releasedReturn.update(noInput(["Enter"]));
const foldedText = ["A", "B"];
releasedReturn.update(noInput(foldedText));
check("the editor reads the last key in an input batch, as the original single key cell does", releasedReturn.text === "B" && foldedText.length === 0);
const nameKeys = [..."abcdefghijklmnop"].map((c) => c);
for (const key of nameKeys) promptEntry.update(noInput([key]));
check("editor accepts at most 16 typed characters, uppercasing letters", promptEntry.text === "ABCDEFGHIJKLMNOP" && promptEntry.text.length === NAME_TYPED_MAX);
const finish = [KEYPAD_ENTER_TOKEN];
const typedOutcome = promptEntry.update(noInput(finish));
check("keypad Enter confirms the editor and the saved name is truncated to 15 bytes", typedOutcome?.kind === "confirm" && typedOutcome.name === "ABCDEFGHIJKLMNO" && SAVED_NAME_LENGTH === 15);
const defaultEntry = new SaveNameEntry("28/06/2090");
defaultEntry.update(noInput());
defaultEntry.update(noInput([], true));
const defaultOutcome = defaultEntry.update(noInput());
check("a left click in the prompt accepts the date-derived default name", defaultOutcome?.kind === "confirm" && defaultOutcome.name === "28/06/2090");
const pendingEntry = new SaveNameEntry("28/06/2090");
pendingEntry.update(noInput());
const pendingKey = ["p"];
pendingEntry.update(noInput(pendingKey));
pendingEntry.update(noInput(pendingKey, true));
const pendingOutcome = pendingEntry.update(noInput(pendingKey));
check("the prompt ignores but preserves a non-Return key cell through default-name confirmation", pendingKey.join() === "p" && pendingOutcome?.kind === "confirm" && pendingOutcome.name === "28/06/2090");

// Exercise actual menu transitions and storage with the local game resources.
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
};
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
if (fs.existsSync(disk2Path)) {
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const strings = new GameStrings(disk1, 0);
  const game = new Game(disk1, disk2);
  game.strings = strings;
  game.bootMenuOpen = false;
  game.startScenario(0);
  game.openDiskMenu();
  const input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  const frame = (down, x = 0, y = 0, keys = [], right = false) => {
    input.leftButton = down; input.rightButton = right; input.pointerX = x; input.pointerY = y; input.keys = keys;
    game.update({ ...input });
  };
  const idle = () => frame(false);
  const icon = (index) => [DISK_MENU_BUTTONS[index].x0 + 16, DISK_MENU_BUTTONS[index].y0 + 16];
  const clickIcon = (index) => { idle(); const [x, y] = icon(index); frame(true, x, y); frame(true, x, y); frame(false, x, y); };
  const slotY = (row) => MENU_PANEL.top + 16 + row * MENU_PANEL.row + 4;
  const slotX = 50;
  const tapSlot = (row) => { idle(); frame(false, slotX, slotY(row)); frame(true, slotX, slotY(row)); frame(false, slotX, slotY(row)); };
  clickIcon(DISK_BUTTON.save);
  tapSlot(0);
  const string = (index) => String.fromCharCode(...strings.get(index));
  check("save-row release opens the name prompt without writing the selected slot", game.stage === "save" && game.nameEntry?.entry.phase === "prompt" && !readSlot(0).ok && game.menu.promptLines.length >= 2);
  // Disk.1 `$8918` copies 15 bytes of the date block (`$14594`: "28/06/2090", NUL, day, month, weekday, difficulty) over the `$13E`
  // placeholder; the NUL lands on the closing quote, so the drawn line stops at the date. (The date block was read from Disk.1 file offset
  // `$3CD94` = `$14594` + `$28800` when this check was written; the template is `GameStrings` index `$13E`.)
  check("the first prompt line stops at the date: \"Game will be saved as '28/06/2090\" (no closing quote or dots)", String.fromCharCode(...game.menu.promptLines[0]) === "Game will be saved as '28/06/2090", `line ${String.fromCharCode(...game.menu.promptLines[0])}`);

  idle();
  frame(false, 0, 0, ["Enter"]);
  check("main Return switches the live save page to the edit prompt", game.stage === "save" && game.nameEntry?.entry.phase === "edit");
  for (const key of [..."utopia 1"]) frame(false, 0, 0, [key]);
  frame(false, 0, 0, ["Enter"]);
  const named = readSlot(0);
  check("editing and Return commits the typed name, and the save page lists it", named.ok && named.save.name === "UTOPIA 1" && game.stage === "save" && game.menu.entries[0].label.includes("UTOPIA 1"), named.ok ? named.save.name : "slot missing");
  check("the prompt's source string codes are available for the original two prompt states", string(0x13e).includes("x") && string(0x13f).includes("RETURN") && string(0x142).includes("RETURN"));

  // A failed write retains the entered name through RETRY.
  const realSetItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error("quota"); };
  frame(false, 0, 0, [], true); idle(); clickIcon(DISK_BUTTON.save);
  idle(); frame(false, 50, MENU_PANEL.top + 16 + 2 * MENU_PANEL.row + 4); frame(true, 50, MENU_PANEL.top + 16 + 2 * MENU_PANEL.row + 4); frame(false, 50, MENU_PANEL.top + 16 + 2 * MENU_PANEL.row + 4); idle();
  frame(false, 0, 0, ["Enter"]);
  for (const key of [..."retry"]) frame(false, 0, 0, [key]);
  frame(false, 0, 0, ["Enter"]);
  check("a refused typed-name save opens the error screen without losing the name", game.stage === "sloterror" && game.slotError?.name === "RETRY");
  globalThis.localStorage.setItem = realSetItem;
  const retryRow = game.menu.entries.findIndex((entry) => entry.label === "RETRY SLOT 3");
  frame(false, 50, MENU_PANEL.top + 16 + retryRow * MENU_PANEL.row + 4);
  frame(true, 50, MENU_PANEL.top + 16 + retryRow * MENU_PANEL.row + 4);
  check("retry writes the same typed name", readSlot(2).ok && readSlot(2).save.name === "RETRY" && game.stage === "save");

  // A fresh slot accepts the default date by click. The default comes from the live simulation state.
  frame(false, 0, 0, [], true); // return from the successfully saved page to its picture origin
  idle();
  clickIcon(DISK_BUTTON.save);
  tapSlot(1);
  idle();
  idle();
  frame(true, 0, 0);
  frame(false, 0, 0);
  const dated = readSlot(1);
  check("click-to-confirm stores the live date as the default save name", dated.ok && dated.save.name === "28/06/2090", dated.ok ? dated.save.name : "slot missing");
} else {
  console.log("save-name Game integration checks skipped: Disk.2 not found");
}

if (failed > 0) {
  console.log(`\nsave-name: ${failed} of ${checks} check(s) FAILED`);
  process.exit(1);
}
console.log(`save-name: ${checks} checks passed`);
