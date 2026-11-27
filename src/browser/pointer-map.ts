// Maps client (viewport) coordinates to game screen pixels. Pure: the caller passes the canvas rectangle.

export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 200;

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number; // 0..SCREEN_WIDTH-1
  y: number; // 0..SCREEN_HEIGHT-1
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

/**
 * Maps a viewport point onto the 320x200 screen. Points outside the rectangle are clamped to its edge, so a pointer
 * that leaves the canvas stays at the border. A zero or non-finite rectangle has no usable scale and maps to (0, 0).
 */
export function mapClientToScreen(clientX: number, clientY: number, rect: ClientRect): ScreenPoint {
  if (!(Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0)) {
    return { x: 0, y: 0 };
  }
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
    return { x: 0, y: 0 };
  }
  const x = Math.floor(((clientX - rect.left) * SCREEN_WIDTH) / rect.width);
  const y = Math.floor(((clientY - rect.top) * SCREEN_HEIGHT) / rect.height);
  return { x: clamp(x, SCREEN_WIDTH - 1), y: clamp(y, SCREEN_HEIGHT - 1) };
}
