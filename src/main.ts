// Entry point. Lets the user point at their own copy of the game folder,
// identifies the data set, and shows a placeholder frame until rendering exists.
// Game data is read from the user's folder at runtime and is never bundled.

import { detectProfile } from "./data/detect.js";

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

function setupPicker(status: HTMLElement): void {
  const input = getElement("folder", HTMLInputElement);

  input.addEventListener("change", () => {
    const picked = Array.from(input.files ?? []);
    const summary = picked.map((f) => ({ name: f.name, size: f.size }));
    const result = detectProfile(summary);

    if (result.profile) {
      status.textContent = `Fundet: ${result.profile.label}`;
    } else {
      status.textContent = `Mangler eller forkerte filer: ${result.missing.join(", ")}`;
    }
  });
}

const canvas = getElement("screen", HTMLCanvasElement);
drawPlaceholder(getContext(canvas));
setupPicker(getElement("status", HTMLParagraphElement));
