// Entry point. Lets the user point at their own copy of the game folder,
// identifies the data set, and shows a placeholder frame until rendering exists.
// Game data is read from the user's folder at runtime and is never bundled.

import { detectProfile } from "./data/detect.js";
import { summariseInputErrors } from "./data/profile-input.js";
import { startFromFiles } from "./startup.js";
import { createMusic } from "./audio/music.js";
import { createSfx } from "./audio/sfx.js";
import { Game } from "./game/game.js";
import { KEYPAD_ENTER_TOKEN, keypadToken } from "./game/intro.js";
import type { Screen } from "./gfx/screen.js";
import { drawPointer, POINTER_ARROW, POINTER_CELL_HOVER, readBootPointer, readPointer } from "./gfx/pointer.js";
import { FrameClock } from "./browser/frame-clock.js";
import { InputState } from "./browser/input-state.js";
import { mapClientToScreen, SCREEN_HEIGHT as HEIGHT, SCREEN_WIDTH as WIDTH } from "./browser/pointer-map.js";

function getElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) {
    throw new Error(`Element #${id} not found or wrong type`);
  }
  return el;
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D context not available");
  }
  return ctx;
}

function drawPlaceholder(ctx: CanvasRenderingContext2D): void {
  const frame = ctx.createImageData(WIDTH, HEIGHT);
  const pixels = frame.data;

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      pixels[i] = x;
      pixels[i + 1] = y;
      pixels[i + 2] = 128;
      pixels[i + 3] = 255;
    }
  }

  ctx.putImageData(frame, 0, 0);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runGame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  files: File[],
  status: HTMLElement,
): Promise<boolean> {
  // Recognise, read and validate the files first; music, sound and Game are only constructed on valid input.
  // Disk.4 (save seed) is optional: when present it is only offered through the disk menu as an
  // experimental continuation source; it is read, never written.
  const started = await startFromFiles(
    files.map((f) => ({ name: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) })),
    {
      createMusic: (disk1, disk2) => createMusic(disk1, disk2),
      createSfx: (disk1, disk2, music) => createSfx(disk1, disk2, { music }),
      createGame: (disk1, disk2, music, sfx) => new Game(disk1, disk2, music, sfx),
    },
  );
  if (!started.ok) {
    status.textContent = `Ugyldige spilfiler: ${summariseInputErrors(started.errors)}`;
    return false;
  }
  const { music, sfx, game } = started;
  const disk = started.input.disk1;
  const disk4 = started.input.disk4;
  if (disk4) game.setDisk4(disk4.bytes, disk4.name);
  if (started.warnings.length > 0) status.textContent += ` (${started.warnings.map((w) => w.message).join(" ")})`;
  const pointerArrow = readPointer(disk, POINTER_ARROW);
  const pointerCellHover = readPointer(disk, POINTER_CELL_HOVER);
  const pointerBoot = readBootPointer(disk);
  const wake = (): void => {
    music.resume();
    sfx.resume();
  };
  canvas.addEventListener("mousedown", wake);
  window.addEventListener("keydown", wake);

  const state = new InputState();
  const input = state.input;
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    // A keypad digit is a digit to the number entries but not a pin key (intro.ts `keypadToken`).
    // Keypad Enter has its own token (intro.ts `KEYPAD_ENTER_TOKEN`): the save name prompt ignores it, the entries accept it.
    const keypadDigit = /^Numpad[0-9]$/.test(e.code) && /^[0-9]$/.test(e.key);
    const keypadEnter = e.code === "NumpadEnter";
    state.keyDown(e.key, keypadDigit ? keypadToken(e.key) : keypadEnter ? KEYPAD_ENTER_TOKEN : e.key);
    if (/^F[1-6]$/.test(e.key) || e.key === " " || e.key === "Backspace" || e.key === "Tab") e.preventDefault();
  });
  // Releases share the batch, in order: the original's handler stores them in the same key cell (intro.ts `keyUpToken`).
  window.addEventListener("keyup", (e) => {
    state.keyUp(e.key);
  });
  // Losing focus (alt-tab, a dialog) releases the buttons and held keys; otherwise they would stay down.
  window.addEventListener("blur", () => {
    state.blur();
  });
  // Presses start only on the canvas; releases are heard on the window so a release outside the canvas is not lost.
  canvas.addEventListener("mousedown", (e) => {
    state.pressButton(e.button);
  });
  window.addEventListener("mouseup", (e) => {
    state.releaseButton(e.button);
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Tracked on the window so the pointer leaves the canvas at its edge rather than freezing.
  window.addEventListener("mousemove", (e) => {
    const point = mapClientToScreen(e.clientX, e.clientY, canvas.getBoundingClientRect());
    state.setPointer(point.x, point.y);
  });

  // The game draws its own pointer, so the browser cursor is hidden over the canvas while the game runs.
  canvas.style.cursor = "none";
  const clock = new FrameClock(performance.now());
  let stopped = false;
  const stop = (err: unknown): void => {
    stopped = true;
    canvas.style.cursor = "";
    console.error("Utopia: game loop stopped", err);
    status.textContent = `Spillet stoppede på grund af en fejl: ${errorText(err)}`;
  };
  const step = (now: number): void => {
    if (stopped) return;
    try {
      const updates = clock.advance(now);
      for (let i = 0; i < updates; i++) {
        game.update(input);
        state.afterUpdate();
      }
      const active: Screen = game.screen;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      const rgba = active.toRgba();
      if (game.pointerVisible) {
        const point = game.pointerPoint(input.pointerX, input.pointerY);
        const pointer = game.pointerUsesBootSprite ? pointerBoot : game.pointerUsesCellHover ? pointerCellHover : pointerArrow;
        drawPointer(pointer, active, rgba, point.x, point.y);
      }
      ctx.putImageData(new ImageData(rgba, WIDTH, HEIGHT), 0, 0);
    } catch (err) {
      stop(err);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return true;
}

function setupPicker(status: HTMLElement, ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): (picked: File[]) => void {
  const input = getElement("folder", HTMLInputElement);
  let started = false;

  const start = (picked: File[]): void => {
    if (started) return;
    const result = detectProfile(picked.map((f) => ({ name: f.name, size: f.size })));

    // Recognition by name and size only; runGame then validates the bytes before anything is constructed.
    if (result.profile) {
      status.textContent = `Fundet: ${result.profile.label}`;
      started = true;
      input.disabled = true;
      const reopen = (): void => {
        started = false;
        input.disabled = false;
      };
      runGame(ctx, canvas, picked, status)
        .then((ok) => {
          if (!ok) reopen();
        })
        .catch((err) => {
          reopen();
          status.textContent = `Fejl ved titelbillede: ${err instanceof Error ? err.message : String(err)}`;
        });
    } else {
      status.textContent = `Mangler eller forkerte filer: ${result.missing.join(", ")}`;
    }
  };

  input.addEventListener("change", () => start(Array.from(input.files ?? [])));
  return start;
}

// Only used when the page is opened by tools/launch-local.mjs (?local=1). The server then serves the user's own
// WHDLoad files from their local folder on 127.0.0.1; without that flag the folder picker is the only input.
const LOCAL_FILE_NAMES = ["Disk.1", "Disk.2", "Utopia.Slave", "disk.4"];

async function loadLocalFiles(): Promise<File[]> {
  const files: File[] = [];
  for (const name of LOCAL_FILE_NAMES) {
    const response = await fetch(`/local/${name}`);
    if (!response.ok) continue; // disk.4 is optional; missing required files are reported by recognition
    files.push(new File([await response.blob()], name));
  }
  return files;
}

const canvas = getElement("screen", HTMLCanvasElement);
const ctx = getContext(canvas);
drawPlaceholder(ctx);
const status = getElement("status", HTMLParagraphElement);
const start = setupPicker(status, ctx, canvas);
if (new URLSearchParams(location.search).get("local") === "1") {
  status.textContent = "Læser dine filer ...";
  loadLocalFiles()
    .then((files) => start(files))
    .catch((err) => {
      status.textContent = `Kunne ikke læse de lokale filer: ${err instanceof Error ? err.message : String(err)}`;
    });
}
