// Indexed-colour frame buffer, mirroring the 5-bitplane, 32-colour OCS display the game uses.

export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 200;
export const PALETTE_SIZE = 32;

export type Rgb = [number, number, number];

export class Screen {
  readonly pixels = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  palette: Rgb[] = Array.from({ length: PALETTE_SIZE }, () => [0, 0, 0] as Rgb);

  clear(index = 0): void {
    this.pixels.fill(index);
  }

  set(x: number, y: number, index: number): void {
    if (x < 0 || y < 0 || x >= SCREEN_WIDTH || y >= SCREEN_HEIGHT) return;
    this.pixels[y * SCREEN_WIDTH + x] = index;
  }

  // Converts to RGBA for canvas output.
  toRgba(): Uint8ClampedArray<ArrayBuffer> {
    const rgba = new Uint8ClampedArray(new ArrayBuffer(SCREEN_WIDTH * SCREEN_HEIGHT * 4));
    for (let i = 0; i < this.pixels.length; i++) {
      const [r, g, b] = this.palette[this.pixels[i]];
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }
}

// Converts an OCS colour word (0x0RGB, 4 bits per channel) to 8-bit RGB.
export function ocsColor(word: number): Rgb {
  return [((word >> 8) & 15) * 17, ((word >> 4) & 15) * 17, (word & 15) * 17];
}
