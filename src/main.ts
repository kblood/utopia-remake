// Entry point. Lets the user point at their own copy of the game folder,
// identifies the data set, and shows a placeholder frame until rendering exists.
// Game data is read from the user's folder at runtime and is never bundled.

import { detectProfile } from "./data/detect.js";
import { IntroScene, type Input } from "./game/intro.js";
import { LanguageScene } from "./game/language.js";
import { MapScene } from "./game/map.js";
import { GameState } from "./game/state.js";
import { World } from "./game/world.js";
import { loadMap, loadTileSet, readScenarioRecords } from "./data/scenario.js";
import type { Screen } from "./gfx/screen.js";

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

// Placeholder pointer (arrow outline); the original sprite format is not decoded yet.
const POINTER_SHAPE = ["X", "XX", "XXX", "XXXX", "XXXXX", "XXXXXX", "XXXXXXX", "XXXXXXXX", "XXXXX", "XX XX", "X  XX", "    XX"];

function drawPointer(rgba: Uint8ClampedArray, x: number, y: number): void {
  POINTER_SHAPE.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (row[dx] !== "X" || px < 0 || py < 0 || px >= 320 || py >= 200) continue;
      const i = (py * 320 + px) * 4;
      const edge = dx === 0 || dx === row.length - 1 || dy === 0 || dy === POINTER_SHAPE.length - 1;
      const v = edge ? 0 : 255;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    }
  });
}

async function runGame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, files: File[]): Promise<void> {
  const disk1 = files.find((f) => f.name.toLowerCase() === "disk.1");
  if (!disk1) return;
  const disk2 = files.find((f) => f.name.toLowerCase() === "disk.2");
  if (!disk2) return;
  const disk = new Uint8Array(await disk1.arrayBuffer());
  const scenarioDisk = new Uint8Array(await disk2.arrayBuffer());
  const intro = new IntroScene(disk);
  let language: LanguageScene | null = null;
  let map: MapScene | null = null;

  const input: Input = { leftButton: false, rightButton: false, pointerX: 0, pointerY: 0 };
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) input.leftButton = true;
    if (e.button === 2) input.rightButton = true;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mouseup", (e) => {
    if (e.button === 0) input.leftButton = false;
    if (e.button === 2) input.rightButton = false;
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
      if (map) {
        map.update(input);
      } else if (language === null) {
        if (intro.update(input) === "clicked") language = new LanguageScene(disk, intro.screen);
      } else if (language.update(input).state === "chosen") {
        const record = readScenarioRecords(scenarioDisk)[0];
        map = new MapScene(
          disk,
          loadTileSet(disk, scenarioDisk, record).tiles,
          new World(new GameState(scenarioDisk, record.block), loadMap(scenarioDisk, record)),
        );
      }
    }
    const active: Screen = map ? map.screen : intro.screen;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const rgba = active.toRgba();
    if (map || language?.pointerVisible) drawPointer(rgba, input.pointerX, input.pointerY);
    ctx.putImageData(new ImageData(rgba, 320, 200), 0, 0);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setupPicker(status: HTMLElement, ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const input = getElement("folder", HTMLInputElement);

  input.addEventListener("change", () => {
    const picked = Array.from(input.files ?? []);
    const summary = picked.map((f) => ({ name: f.name, size: f.size }));
    const result = detectProfile(summary);

    if (result.profile) {
      status.textContent = `Fundet: ${result.profile.label}`;
      runGame(ctx, canvas, picked).catch((err) => {
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
