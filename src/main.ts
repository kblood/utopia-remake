// Entry point. Lets the user point at their own copy of the game folder,
// identifies the data set, and shows a placeholder frame until rendering exists.
// Game data is read from the user's folder at runtime and is never bundled.

import { detectProfile } from "./data/detect.js";
import { summariseInputErrors } from "./data/profile-input.js";
import { startFromFiles } from "./startup.js";
import { createMusic } from "./audio/music.js";
import { createSfx } from "./audio/sfx.js";
import { Game } from "./game/game.js";
import type { Input } from "./game/intro.js";
import type { Screen } from "./gfx/screen.js";
import { drawPointer, POINTER_ARROW, POINTER_CELL_HOVER, readPointer } from "./gfx/pointer.js";

const WIDTH = 320;
const HEIGHT = 256;

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

const FRAME_MS = 20; // 50 Hz, like the original PAL display

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
  const wake = (): void => {
    music.resume();
    sfx.resume();
  };
  canvas.addEventListener("mousedown", wake);
  window.addEventListener("keydown", wake);

  const input: Input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0, keys: [] };
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    input.keys?.push(e.key);
    if (/^F[1-6]$/.test(e.key) || e.key === " ") e.preventDefault();
  });
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) input.leftButton = true;
    if (e.button === 2) input.rightButton = true;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // A release is applied after the next update, so a click shorter than one frame is still seen.
  const release = { left: false, right: false };
  canvas.addEventListener("mouseup", (e) => {
    if (e.button === 0) release.left = true;
    if (e.button === 2) release.right = true;
  });
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    input.pointerX = Math.max(0, Math.min(319, Math.floor(((e.clientX - rect.left) * WIDTH) / rect.width)));
    input.pointerY = Math.max(0, Math.min(199, Math.floor(((e.clientY - rect.top) * HEIGHT) / rect.height)));
  });

  let last = performance.now();
  let owed = 0;
  const step = (now: number): void => {
    owed += now - last;
    last = now;
    while (owed >= FRAME_MS) {
      owed -= FRAME_MS;
      game.update(input);
      if (release.left) input.leftButton = false;
      if (release.right) input.rightButton = false;
      release.left = false;
      release.right = false;
    }
    const active: Screen = game.screen;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const rgba = active.toRgba();
    if (game.pointerVisible) {
      const point = game.pointerPoint(input.pointerX, input.pointerY);
      drawPointer(game.pointerUsesCellHover ? pointerCellHover : pointerArrow, active, rgba, point.x, point.y);
    }
    ctx.putImageData(new ImageData(rgba, 320, 200), 0, 0);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return true;
}

function setupPicker(status: HTMLElement, ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const input = getElement("folder", HTMLInputElement);
  let started = false;

  input.addEventListener("change", () => {
    if (started) return;
    const picked = Array.from(input.files ?? []);
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
  });
}

const canvas = getElement("screen", HTMLCanvasElement);
const ctx = getContext(canvas);
drawPlaceholder(ctx);
setupPicker(getElement("status", HTMLParagraphElement), ctx, canvas);
