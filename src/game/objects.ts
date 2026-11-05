// Objects drawn over the map: own units, the eight marker pins, short-lived effects and any extra
// sprites. Positions, hiding rules and draw order follow $333A/$3694/$6540/$3768/$3310, see
// notes/formats/map-rendering.md sections 7.2-7.5. Enemy units, spaceships and missiles live in an
// EnemySystem attached with `enemies` (stepped after the own units in every pass); anything else with a
// sprite can be shown through `extra`.

import { MAP_WIDTH, TILE_ID_MASK, type Tile } from "../data/scenario.js";
import { SPRITE_WIDTH, type SpriteSet } from "../data/sprites.js";
import { Screen, SCREEN_HEIGHT, SCREEN_WIDTH } from "../gfx/screen.js";
import type { EnemySystem } from "./enemies.js";
import { UnitSystem, type Unit, type UnitHooks } from "./units.js";

const VIEW = 8;
const CLIP_RIGHT = 256; // objects are clipped at the right edge of the map window
const MARKER_COUNT = 8;
const NO_MARKER = 0xff;
const MAX_EFFECTS = 30;
const EFFECT_START = 4; // byte +5 of a new effect; it counts down to 0 and is drawn with that frame
const MAX_NEIGHBOUR_ROWS = 16; // neighbour tiles drawn in front of a unit must be flat ($66FC)
// Object types of the two explosion effects ($1243A, $1244C).
export const EFFECT_EXPLOSION = 0x12;
export const EFFECT_EXPLOSION_HIGH = 0x14;
// The original runs its main-loop pass (units, effects) once per displayed frame at best; the real pass
// time is unknown. Guess: two 50 Hz frames per pass.
const FRAMES_PER_PASS = 2;

// Anything with a sprite on a map cell. Fields follow the entry layout: +0 type, +1/+2 cell, +3/+4 pixel
// offset, +5 frame, +6/+$10 lift.
export interface Drawable {
  type: number;
  x: number;
  y: number;
  dx?: number;
  dy?: number;
  frame?: number;
  lift?: number; // pixels the sprite is drawn higher (airborne objects)
  anim?: number; // extra animation counter of type $18
}

export interface Marker {
  type: number; // 1..8
  x: number;
  y: number; // 0xFF = not placed
}

export interface Effect {
  type: number;
  x: number;
  y: number;
  frame: number; // byte +5: counts down, freed below 0
  lift: number;
}

// Neighbour cells (dvx, dvy) a unit is drawn in front of, by facing ($6626-$6682): flat tiles only.
const NEIGHBOURS: Record<number, readonly (readonly [number, number])[]> = {
  1: [
    [1, -1],
    [1, 0],
  ],
  2: [[1, 0]],
  3: [
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  4: [[0, 1]],
  5: [[0, 1]],
};

function anchorX(vx: number, vy: number): number {
  return 112 + 16 * (vx - vy);
}

function anchorY(vx: number, vy: number): number {
  return 39 + 8 * (vx + vy);
}

export class ObjectLayer {
  readonly units: UnitSystem;
  readonly markers: Marker[] = Array.from({ length: MARKER_COUNT }, (_, i) => ({ type: i + 1, x: 0, y: NO_MARKER }));
  readonly effects: Effect[] = [];
  readonly extra: Drawable[] = [];
  enemies: EnemySystem | null = null;
  paused = false;
  private frames = 0;
  private readonly early = new Set<number>(); // view cells whose tile was already drawn

  constructor(
    private readonly sprites: SpriteSet,
    private readonly tiles: Tile[],
    private readonly cells: Uint16Array,
    private readonly drawTile: (tile: Tile, x: number, bottomY: number) => void,
    techLevel: () => number = () => 1,
    hooks: UnitHooks = {},
  ) {
    this.units = new UnitSystem(cells, techLevel, hooks);
  }

  // Call once per 50 Hz frame.
  update(): void {
    if (this.paused || ++this.frames % FRAMES_PER_PASS !== 0) return;
    this.units.tick();
    this.enemies?.pass(this.units.clock);
    // Effects ($3560): count down byte +5, free the entry once it goes below 0.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (--this.effects[i].frame < 0) this.effects.splice(i, 1);
    }
  }

  spawnEffect(type: number, x: number, y: number, lift = 0): boolean {
    if (this.effects.length >= MAX_EFFECTS) return false;
    this.effects.push({ type, x, y, frame: EFFECT_START, lift });
    return true;
  }

  // A unit destroyed in combat: gone from the map, an explosion in its place ($4732, $1237C).
  destroyUnit(unit: Unit): void {
    this.units.remove(unit);
    this.spawnEffect(EFFECT_EXPLOSION, unit.x, unit.y);
  }

  // Keys 1-8 ($3202): a pin already standing on the cell is removed (whatever its number), otherwise
  // pin `n` (1-8) is put on the cell, moving it if it was elsewhere. Returns what happened.
  toggleMarker(n: number, x: number, y: number): "placed" | "removed" {
    const there = this.markers.find((m) => m.y !== NO_MARKER && m.x === x && m.y === y);
    if (there) {
      there.y = NO_MARKER;
      return "removed";
    }
    const marker = this.markers[n - 1];
    marker.x = x;
    marker.y = y;
    return "placed";
  }

  // Key $22 ($31CC).
  clearMarkers(): void {
    for (const m of this.markers) m.y = NO_MARKER;
  }

  // Where unit orders go: the position of marker pin n (1-8), or null when it is not placed.
  markerCell(n: number): { x: number; y: number } | null {
    const m = this.markers[n - 1];
    return m && m.y !== NO_MARKER ? { x: m.x, y: m.y } : null;
  }

  // True when the tile of view cell (vx, vy) was already drawn in front of a unit; consumes the mark.
  claimed(vx: number, vy: number): boolean {
    return this.early.delete(vy * VIEW + vx);
  }

  // $3694: is the object shown, given its cell in the window and its motion? The window edge rules
  // hide units that are on their way out of the last column or row.
  private static shown(type: number, vx: number, vy: number, dx: number, dy: number, facing: number): boolean {
    if (vx < 0 || vy < 0 || vx >= VIEW || vy >= VIEW) return false;
    if (type === EFFECT_EXPLOSION || type === EFFECT_EXPLOSION_HIGH) return true;
    if (vx === VIEW - 1 && facing !== 0 && facing < 4 && (dx > 0 || dy > 0)) return false;
    if (vy === VIEW - 1 && facing !== 7) {
      if (facing === 6) return !(dx < 0 || dy < 0);
      if (facing === 3) return !(dy > 0);
      if (facing >= 4) return !(dx < 0);
    }
    return true;
  }

  // Draws everything standing on view cell (vx, vy) right after that cell's tile ($6540).
  drawAfterCell(screen: Screen, scrollX: number, scrollY: number, vx: number, vy: number): void {
    const cx = scrollX + vx;
    const cy = scrollY + vy;
    for (const u of this.units.units) {
      if (u.x === cx && u.y === cy && ObjectLayer.shown(u.type, vx, vy, u.dx, u.dy, u.dir)) {
        if ((u.dx !== 0 || u.dy !== 0) && NEIGHBOURS[u.dir]) this.drawNeighbours(scrollX, scrollY, vx, vy, u.dir);
        this.blit(screen, u.type, u.dir, 0, vx, vy, u.dx, u.dy, 0);
      }
    }
    for (const d of [...(this.enemies?.drawables() ?? []), ...this.extra]) {
      const frame = d.frame ?? 0;
      if (d.x === cx && d.y === cy && ObjectLayer.shown(d.type, vx, vy, d.dx ?? 0, d.dy ?? 0, frame)) {
        this.blit(screen, d.type, frame, d.anim ?? 0, vx, vy, d.dx ?? 0, d.dy ?? 0, d.lift ?? 0);
      }
    }
    for (const e of this.effects) {
      if (e.x === cx && e.y === cy && ObjectLayer.shown(e.type, vx, vy, 0, 0, e.frame)) {
        this.blit(screen, e.type, e.frame, 0, vx, vy, 0, 0, e.lift);
      }
    }
  }

  // The flat tiles in front of a moving unit are drawn before it so it appears on top of them; each is
  // marked so the normal cell loop skips it later.
  private drawNeighbours(scrollX: number, scrollY: number, vx: number, vy: number, facing: number): void {
    for (const [ox, oy] of NEIGHBOURS[facing]) {
      const nx = vx + ox;
      const ny = vy + oy;
      if (nx >= VIEW || ny >= VIEW || ny < 0) continue;
      const key = ny * VIEW + nx;
      if (this.early.has(key)) continue;
      const tile = this.tiles[(this.cells[(scrollY + ny) * MAP_WIDTH + scrollX + nx] & TILE_ID_MASK) - 1];
      if (!tile || tile.rows > MAX_NEIGHBOUR_ROWS) continue;
      this.drawTile(tile, anchorX(nx, ny), anchorY(nx, ny));
      this.early.add(key);
    }
  }

  // $3310: the pins are drawn last, over all tiles and objects.
  drawMarkers(screen: Screen, scrollX: number, scrollY: number): void {
    this.early.clear();
    for (const m of this.markers) {
      if (m.y === NO_MARKER) continue;
      const vx = m.x - scrollX;
      const vy = m.y - scrollY;
      if (ObjectLayer.shown(m.type, vx, vy, 0, 0, 0)) this.blit(screen, m.type, 0, 0, vx, vy, 0, 0, 0);
    }
  }

  // $3768/$3260: the sprite's bottom row lies on the bottom row of the cell box, plus the pixel offset.
  private blit(
    screen: Screen,
    type: number,
    frameIndex: number,
    anim: number,
    vx: number,
    vy: number,
    dx: number,
    dy: number,
    lift: number,
  ): void {
    const x = anchorX(vx, vy) + dx;
    if (x < 0 || x >= CLIP_RIGHT) return; // the original does not draw objects outside x 0..255 at all
    const frame = this.sprites.frame(type, frameIndex, anim);
    if (!frame) return;
    const bottom = anchorY(vx, vy) - 1 + dy - lift;
    for (let row = 0; row < frame.rows; row++) {
      const y = bottom - (frame.rows - 1) + row;
      if (y < 0 || y >= SCREEN_HEIGHT) continue;
      for (let px = 0; px < SPRITE_WIDTH; px++) {
        const sx = x + px;
        if (sx >= CLIP_RIGHT) break;
        if (!frame.opaque[row * SPRITE_WIDTH + px]) continue;
        screen.pixels[y * SCREEN_WIDTH + sx] = frame.index[row * SPRITE_WIDTH + px];
      }
    }
  }
}
