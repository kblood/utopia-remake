// Objects drawn over the map: own units, the eight marker pins, short-lived effects and any extra
// sprites. Positions, hiding rules and draw order follow $333A/$3694/$4860/$6540/$3768/$3310, see
// notes/formats/map-rendering.md sections 7.2-7.5 and draw-list.ts (the pure part). Enemy units, spaceships and missiles
// live in an EnemySystem attached with `enemies` (stepped after the own units in every pass); anything else with a
// sprite can be shown through `extra` (an explicit approximation, not part of the traced list).
//
// Drawing is a pure read of the game state: `beginFrame()` builds the admitted draw list in the `$333A` source order
// (own tanks, ships/missiles, enemy ground, enemy air, effect slots, alien, meteor, extras), sorts it globally with the
// literal `$4860` selection sort and hands out one `FramePass` that owns the redraw's neighbour-tile marks and cursor. The
// layer retains only the `$156A9` redraw-gate snapshot for the current main-loop pass.

import { MAP_WIDTH, TILE_ID_MASK, type Tile } from "../data/scenario.js";
import { SPRITE_WIDTH, type SpriteSet } from "../data/sprites.js";
import { Screen, SCREEN_HEIGHT, SCREEN_WIDTH } from "../gfx/screen.js";
import { CELL_FLAG_BYTES } from "./cell-flags.js";
import {
  DrawCursor,
  FLAG_NEIGHBOURS,
  neighbourOffsets,
  orderKey,
  PAINTER_CELLS,
  SOURCE_ORDER,
  sortDrawList,
  VIEW_CELLS,
  type DrawKind,
} from "./draw-list.js";
import { EffectPool, EFFECT_START, MAX_EFFECTS, type Effect } from "./effect-pool.js";
import type { EnemySystem } from "./enemies.js";
import { UnitSystem, type Unit, type UnitHooks } from "./units.js";

export { EFFECT_START, MAX_EFFECTS, type Effect };
export type { DrawKind };

const VIEW = VIEW_CELLS;
const CLIP_RIGHT = 256; // objects whose left edge is at x >= 256 (or x < 0) are not drawn at all ($3768..$3770)
const MARKER_COUNT = 8;
const NO_MARKER = 0xff;
const MAX_NEIGHBOUR_ROWS = 16; // neighbour tiles drawn in front of a unit must be flat ($66FC)
/** Map flag bit 10: an animated cell; any visible one sets the redraw gate `$156A9` bit 3 in `$6936`, whether or not its id changes. */
const CELL_ANIMATED = 0x400;
/** Bit 17 of the invention long `$14472` also sets the redraw gate (static trace). */
export const INVENTION_GATE_BIT = 0x20000;
export const INVENTION_ADDRESS = 0x14472;
// Object types of the two explosion effects ($1243A, $1244C).
export const EFFECT_EXPLOSION = 0x12;
export const EFFECT_EXPLOSION_HIGH = 0x14;

/**
 * Number of leading source pixel columns (index p = 0..count-1, destination x + p) the original blit `$3260` draws for a
 * sprite whose left edge is at `x`; 0 when the sprite is rejected (x < 0 or x > 255, `$3768..$3770`). Static trace of the
 * `$4C9A` mask table and `$32B6..$32F6` (notes/formats/map-rendering.md section 7.3):
 *  - x <= 223: all 32 columns (the last lands on x + 31 <= 254);
 *  - x = 224..254: only p <= 254 - x, i.e. destination columns up to 254, never 255 and beyond;
 *  - x = 255: all 32 columns (up to x = 286). This is an original quirk, not a clip at 255 or 256: source index 31 aliases the
 *    scratch longword `$4D16`, which is reset to $FFFFFFFF. It is deliberately preserved.
 */
export function spriteVisibleColumns(x: number): number {
  if (x < 0 || x >= CLIP_RIGHT) return 0;
  if (x <= 223 || x === 255) return SPRITE_WIDTH;
  return 255 - x;
}

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
  ref?: object; // the record behind the sprite (what a right click picks, see orders.ts)
  /**
   * Which original list the drawable belongs to ("ship", "ground" or "air": `EnemySystem.drawables()` tags them). Untagged
   * drawables are arbitrary extras and join the list last with flags 0, which is an approximation of the remake.
   */
  kind?: DrawKind;
}

export interface Marker {
  type: number; // 1..8
  x: number;
  y: number; // 0xFF = not placed
}

/** One admitted entry of the draw list (the 12-byte record of `$2954A`, with the source identity kept). */
export interface DrawEntry {
  readonly kind: DrawKind;
  /** `63 - painterSeq` of the entry's view cell (`$7BA8`). */
  readonly order: number;
  /** Flag bit 0 neighbour redraw, bit 1 redraw gate (draw-list.ts). */
  readonly flags: number;
  readonly vx: number;
  readonly vy: number;
  readonly type: number;
  readonly frame: number;
  readonly anim: number;
  readonly dx: number;
  readonly dy: number;
  /** Pixels the sprite is drawn higher; includes the alien's `$3604` adjustment. */
  readonly lift: number;
  /** The record behind the entry (tank, ship, enemy, effect slot record, or a shared marker for the specials). */
  readonly ref?: object;
}

/** What a right click can pick: the screen position (left edge x, bottom row y) of an admitted entry, in draw-list order. */
export interface Pickable {
  readonly x: number;
  readonly y: number;
  readonly ref: object;
  readonly kind: DrawKind;
}

/** Why the redraw gate (`$156A9` bit 3) is open for a frame: any one source opens it; enemies, effects and specials never do. */
export interface FrameGate {
  readonly open: boolean;
  /** An admitted own tank. */
  readonly tank: boolean;
  /** An admitted own ship or missile. */
  readonly ship: boolean;
  /** A visible window cell with the animated flag (bit 10), whether or not its animation changes anything. */
  readonly animatedCell: boolean;
  /** Invention bit 17. */
  readonly invention: boolean;
}

/** Stand-ins for the two special records in `Pickable.ref` / `DrawEntry.ref`: they are not game objects an order can target. */
export const ALIEN_REF: object = Object.freeze({ special: "alien" });
export const METEOR_REF: object = Object.freeze({ special: "meteor" });

/**
 * Static trace (Disk.1 `$3604`, after `$3694`): the type-19 alien insertion block subtracts 13 from the y anchor, so the
 * apparition's bottom row is `anchorY - 1 + dy - 13`. Only the alien takes this adjustment; no pixel comparison exists.
 */
export const ALIEN_ANCHOR_Y_ADJUST = 13;

function anchorX(vx: number, vy: number): number {
  return 112 + 16 * (vx - vy);
}

function anchorY(vx: number, vy: number): number {
  return 39 + 8 * (vx + vy);
}

export class ObjectLayer {
  readonly units: UnitSystem;
  readonly markers: Marker[] = Array.from({ length: MARKER_COUNT }, (_, i) => ({ type: i + 1, x: 0, y: NO_MARKER }));
  /** The 30 fixed effect slots (`$39D4A`, count `$156AE`): see effect-pool.ts. */
  readonly pool = new EffectPool();
  /**
   * Other drawables that are NOT part of the traced `$333A` list. They join the draw list after everything else with flags 0
   * (an approximation, order among equal cells included), are not saved (native capture refuses a non-empty list) and are
   * pickable only when they carry a `ref`.
   */
  readonly extra: Drawable[] = [];
  enemies: EnemySystem | null = null;
  /**
   * Read-only source of the active alien apparition ($144A8, alien-sprite.ts). Polled at draw time only: it must not
   * write anything, and the layer never stores what it returns. It is an admitted draw-list entry (so it sorts, blocks and
   * can be picked as an obstacle), but never an order target.
   */
  apparition: (() => Drawable | null) | null = null;
  /**
   * Read-only source of the active meteor ($1449C, meteor-sprite.ts). Same contract as `apparition`: polled at draw time,
   * never written through, never retained (no meteor effect is created) and not an order target.
   */
  meteor: (() => Drawable | null) | null = null;
  /** Read-only source of invention bit 17 (the long `$14472`), which opens the redraw gate. MapScene installs the state reader. */
  inventionGate: () => boolean = () => false;
  paused = false;
  /** `$156A9` bit 3 is reset once per `$333A` pass, then retained through the following video redraws. */
  private passGate: FrameGate | null = null;
  /** `$142A0`: number of original (non-remake-extra) entries built for the current `$333A` pass. */
  private originalPassDrawCount = 0;

  get passDrawCount(): number {
    return this.originalPassDrawCount;
  }

  constructor(
    private readonly sprites: SpriteSet,
    private readonly tiles: Tile[],
    private readonly cells: Uint16Array,
    private readonly drawTile: (tile: Tile, x: number, bottomY: number) => void,
    techLevel: () => number = () => 1,
    hooks: UnitHooks = {},
    cellFlags: Uint8Array = new Uint8Array(CELL_FLAG_BYTES),
    /**
     * An existing own-unit system to present instead of making a new one (Disk.4 restore: the prepared
     * `UnitSystem` keeps its slots, clock and provenance). `techLevel`, `hooks` and `cellFlags` are then ignored
     * (bind hooks with `adopt.bindHooks`); it must run over `cells` and `cellFlags` or the constructor throws.
     */
    adopt?: UnitSystem,
  ) {
    if (adopt) {
      if (!adopt.usesBuffers(cells, cellFlags)) throw new Error("ObjectLayer: the adopted UnitSystem runs over other map or flag buffers");
      this.units = adopt;
    } else {
      this.units = new UnitSystem(cells, techLevel, hooks, cellFlags);
    }
  }

  /** Occupied effect slots in ascending slot order (live records, a fresh array; use `pool.slots` for the fixed layout). */
  get effects(): Effect[] {
    return this.pool.records();
  }

  /** The 30 fixed effect slots, null = free. */
  get effectSlots(): readonly (Effect | null)[] {
    return this.pool.slots;
  }

  /**
   * Disk.4 restore: sets the pins from saved marker records (index 0..7 = pin 1..8; null = not placed) exactly as
   * stored. Not a key press: no toggling, no removal of a pin standing on the same cell, no message. Cells are
   * not range-checked here (the caller validates).
   */
  restoreMarkers(saved: readonly ({ x: number; y: number } | null)[]): void {
    for (let i = 0; i < MARKER_COUNT; i++) {
      const at = saved[i] ?? null;
      const m = this.markers[i];
      if (at) {
        m.x = at.x;
        m.y = at.y;
      } else {
        m.y = NO_MARKER;
      }
    }
  }

  // Call once per main-loop pass ($333A; the scheduler is main-loop.ts, 4 video frames per pass by default). This is
  // the FIRST part of the pass: own tanks, then ships / enemy ground / enemy air (EnemySystem.pass), then effects. The
  // alien frame, meteor and spawner (Sim.pass) and the periodic worker (Sim.periodicPass) follow it, never precede it.
  // The pass clock ($144C9) advances on every pass, also while paused (observed). Disk.1 checks pause bit 2 before
  // the tank step ($3394), ship step ($3414), enemy-ground step ($34A6), enemy-air step ($350E) and effect countdown
  // ($3574); the remake's early return keeps those entities fixed while still advancing the shared pass clock.
  update(): void {
    if (this.paused) {
      this.units.clock.advance();
      return;
    }
    this.units.tick();
    this.enemies?.pass(this.units.clock);
    // Effects ($333A): slots ascending, byte +5 counts down, a slot is freed once it goes below 0 (holes stay holes).
    this.pool.tick();
  }

  spawnEffect(type: number, x: number, y: number, lift = 0): boolean {
    return this.pool.spawn(type, x, y, lift);
  }

  // Silent removal of an own unit from the map and its cell marks: `$4692` without a blast. The Earth tank requisition
  // ($11280 -> $4692) uses it; `$4732` calls `$1237C` only when the attacker set bit 5 of `$156A9`, which the requisition
  // never does. A unit destroyed in combat goes through `EnemySystem.destroyTank` (counts, morale, blast hook) instead.
  removeUnit(unit: Unit): void {
    this.units.remove(unit);
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

  /**
   * The admitted entries in the `$333A` insertion order, before the sort: own tanks (ascending slot, flags 1), own ships and
   * missiles (0), enemy ground (3), enemy air (2), the effect slots (0), alien (0), meteor (0), then the remake's extras
   * (0, not original). Admission is `$3694` visibility only: whether the blit later rejects the sprite or paints nothing
   * does not remove an entry. Pure read; nothing is stored.
   */
  admitted(scrollX: number, scrollY: number): DrawEntry[] {
    const out: DrawEntry[] = [];
    const flagsOf = (kind: DrawKind): number => SOURCE_ORDER.find((s) => s.kind === kind)?.flags ?? 0;
    const add = (kind: DrawKind, type: number, x: number, y: number, dx: number, dy: number, frame: number, anim: number, lift: number, ref?: object): void => {
      const vx = x - scrollX;
      const vy = y - scrollY;
      if (!ObjectLayer.shown(type, vx, vy, dx, dy, frame)) return;
      out.push({ kind, order: orderKey(vx, vy), flags: flagsOf(kind), vx, vy, type, frame, anim, dx, dy, lift, ref });
    };
    for (const u of this.units.units) add("tank", u.type, u.x, u.y, u.dx, u.dy, u.dir, 0, 0, u);
    const drawables = this.enemies?.drawables() ?? [];
    for (const kind of ["ship", "ground", "air"] as const) {
      for (const d of drawables) {
        if (d.kind === kind) add(kind, d.type, d.x, d.y, d.dx ?? 0, d.dy ?? 0, d.frame ?? 0, d.anim ?? 0, d.lift ?? 0, d.ref);
      }
    }
    for (const e of this.pool.slots) {
      if (e !== null) add("effect", e.type, e.x, e.y, 0, 0, e.frame, 0, e.lift, e);
    }
    // The alien apparition ($144A8): same anchor / offset / visibility / clip as every other object, except that the $3604
    // insertion block lowers its y anchor by 13 (ALIEN_ANCHOR_Y_ADJUST, static trace).
    const a = this.apparition?.();
    if (a) add("alien", a.type, a.x, a.y, a.dx ?? 0, a.dy ?? 0, a.frame ?? 0, a.anim ?? 0, (a.lift ?? 0) + ALIEN_ANCHOR_Y_ADJUST, ALIEN_REF);
    // The meteor ($1449C): ordinary anchor, offset (+3/+4), lift (+6, the countdown) and window-edge rule, no extra y adjustment.
    const m = this.meteor?.();
    if (m) add("meteor", m.type, m.x, m.y, m.dx ?? 0, m.dy ?? 0, m.frame ?? 0, m.anim ?? 0, m.lift ?? 0, METEOR_REF);
    for (const d of this.extra.concat(drawables.filter((x) => x.kind === undefined))) {
      add("extra", d.type, d.x, d.y, d.dx ?? 0, d.dy ?? 0, d.frame ?? 0, d.anim ?? 0, d.lift ?? 0, d.ref);
    }
    return out;
  }

  /** The admitted entries after the `$4860` sort: the order the frame (and the pick scan) walks them. Pure; no game state is read beyond the lists. */
  drawList(scrollX: number, scrollY: number): DrawEntry[] {
    return sortDrawList(this.admitted(scrollX, scrollY));
  }

  /**
   * The redraw gate `$156A9` bit 3 of a frame whose admitted entries are `entries`: opened by an admitted own tank, an
   * admitted own ship or missile, any visible animated map cell (bit 10, even if its animation does not change the id) or
   * invention bit 17. Enemies, effects and the specials never open it. `preparePassGate` snapshots these sources once per
   * normal main-loop pass; every video redraw until the next pass uses that value.
   */
  gate(entries: readonly DrawEntry[], scrollX: number, scrollY: number): FrameGate {
    const tank = entries.some((e) => e.kind === "tank");
    const ship = entries.some((e) => e.kind === "ship");
    let animatedCell = false;
    for (let vy = 0; vy < VIEW && !animatedCell; vy++) {
      for (let vx = 0; vx < VIEW; vx++) {
        const mx = scrollX + vx;
        const my = scrollY + vy;
        if (mx < 0 || my < 0 || mx >= MAP_WIDTH) continue;
        const word = this.cells[my * MAP_WIDTH + mx];
        if (word !== undefined && (word & CELL_ANIMATED) !== 0) {
          animatedCell = true;
          break;
        }
      }
    }
    const invention = this.inventionGate();
    return { open: tank || ship || animatedCell || invention, tank, ship, animatedCell, invention };
  }

  /**
   * Snapshot the original redraw gate for one normal main-loop pass. The original clears the gate at the pass boundary;
   * per-video redraws use that latched result until the next pass, even if the view or source records change after the
   * input poll. Modal build-menu loops do not call this and therefore keep the previous pass's value.
   */
  preparePassGate(scrollX: number, scrollY: number): FrameGate {
    const list = this.drawList(scrollX, scrollY);
    // `$333A` builds the original 12-byte entries before `$4860` sorts them. Remake-only `extra` sprites are
    // appended for presentation and do not consume an original list slot or affect `$142A0`.
    this.originalPassDrawCount = list.reduce((count, entry) => count + (entry.kind === "extra" ? 0 : 1), 0);
    this.passGate = this.gate(list, scrollX, scrollY);
    return this.passGate;
  }

  /** One redraw: builds and sorts the list; diagnostics compute a live gate unless an explicit snapshot is supplied. */
  beginFrame(scrollX: number, scrollY: number, gateOverride?: FrameGate): FramePass {
    const list = this.drawList(scrollX, scrollY);
    return new FramePass(this, list, gateOverride ?? this.gate(list, scrollX, scrollY), scrollX, scrollY);
  }

  /**
   * The whole map window of one redraw ($6540, then $3310): the 64 tiles in painter order (a tile already drawn in front of
   * a unit is skipped at its own turn), each followed by its draw-list entries under the current pass gate, then pins on top.
   */
  drawMap(
    screen: Screen,
    scrollX: number,
    scrollY: number,
    cursor?: { readonly vx: number; readonly vy: number; readonly phase: { value: number } },
  ): void {
    const pass = this.beginFrame(scrollX, scrollY, this.passGate ?? undefined);
    for (const { vx, vy } of PAINTER_CELLS) {
      const skip = pass.claimed(vx, vy);
      // `$655E-$658E`: the claimed-tile test precedes the `$14636` comparison and Bchg. A claimed cell is skipped
      // without advancing the selection phase; otherwise bit 1 alternates descriptor index 58 ($1D0 bytes) with its tile.
      let tile = this.tileAt(scrollX, scrollY, vx, vy);
      if (!skip && cursor && cursor.vx === vx && cursor.vy === vy) {
        const cursorTile = cursor.phase.value === 0;
        cursor.phase.value ^= 1;
        if (cursorTile) tile = this.tiles[58];
      }
      if (tile && !skip) this.drawTile(tile, anchorX(vx, vy), anchorY(vx, vy));
      pass.drawAfterCell(screen, vx, vy);
    }
    this.drawMarkers(screen, scrollX, scrollY);
  }

  /**
   * Diagnostic: the entries of ONE cell as `drawMap` would paint them (the earlier cells' entries are walked past, with the
   * same gate blocking, and not painted). Builds a fresh frame each call, so no neighbour marks survive it.
   */
  drawAfterCell(screen: Screen, scrollX: number, scrollY: number, vx: number, vy: number): void {
    this.beginFrame(scrollX, scrollY).drawAfterCell(screen, vx, vy);
  }

  /** @internal map tile of a view cell (ids are 1-based); undefined when there is none. */
  tileAt(scrollX: number, scrollY: number, vx: number, vy: number): Tile | undefined {
    return this.tiles[(this.cells[(scrollY + vy) * MAP_WIDTH + scrollX + vx] & TILE_ID_MASK) - 1];
  }

  /** @internal draws a tile (used by the neighbour redraw of a frame pass). */
  paintTile(tile: Tile, vx: number, vy: number): void {
    this.drawTile(tile, anchorX(vx, vy), anchorY(vx, vy));
  }

  /**
   * The pick list of `$3EDC` / `$3F1E`: EVERY admitted entry (the whole globally sorted list, including enemies, effects, the
   * alien and meteor, which are obstacles but not order targets; not filtered by the gate or by the blit's x clip) with its
   * screen position (left edge x, bottom row y). Pins are not listed. Untagged extras are approximate: listed only when they
   * carry a `ref`.
   */
  pickables(scrollX: number, scrollY: number): Pickable[] {
    const out: Pickable[] = [];
    for (const e of this.drawList(scrollX, scrollY)) {
      // Extras are outside the traced list: only those that carry a record take part (as before).
      if (e.kind === "extra" && !e.ref) continue;
      // An unclassifiable entry still blocks: give it itself as the reference so the scan reports a hit that no order can use.
      out.push({ x: anchorX(e.vx, e.vy) + e.dx, y: anchorY(e.vx, e.vy) - 1 + e.dy - e.lift, ref: e.ref ?? e, kind: e.kind });
    }
    return out;
  }

  // $3310: the pins are drawn last, over all tiles and objects.
  drawMarkers(screen: Screen, scrollX: number, scrollY: number): void {
    for (const m of this.markers) {
      if (m.y === NO_MARKER) continue;
      const vx = m.x - scrollX;
      const vy = m.y - scrollY;
      if (ObjectLayer.shown(m.type, vx, vy, 0, 0, 0)) this.blit(screen, m.type, 0, 0, vx, vy, 0, 0, 0);
    }
  }

  /** @internal $3768/$3260: the sprite's bottom row lies on the bottom row of the cell box, plus the pixel offset. */
  blit(
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
    const columns = spriteVisibleColumns(x); // the original's exact per-pixel clip, same for every sprite type
    if (columns === 0) return;
    const frame = this.sprites.frame(type, frameIndex, anim);
    if (!frame) return;
    const bottom = anchorY(vx, vy) - 1 + dy - lift;
    for (let row = 0; row < frame.rows; row++) {
      const y = bottom - (frame.rows - 1) + row;
      if (y < 0 || y >= SCREEN_HEIGHT) continue;
      for (let px = 0; px < columns; px++) {
        if (!frame.opaque[row * SPRITE_WIDTH + px]) continue;
        screen.pixels[y * SCREEN_WIDTH + x + px] = frame.index[row * SPRITE_WIDTH + px];
      }
    }
  }
}

/**
 * Everything one redraw mutates, kept apart from the layer: the sorted admitted list, its single cursor, the pass-latched
 * gate and the set of neighbour tiles already drawn in front of an entry. Cells are meant to be visited in painter order (`drawMap`).
 */
export class FramePass {
  private readonly cursor: DrawCursor<DrawEntry>;
  private readonly marked = new Set<number>(); // view cells whose tile was already drawn (bit 15 of the `$7828` word)

  constructor(
    private readonly layer: ObjectLayer,
    /** The admitted entries in sorted (drawing) order. */
    readonly list: readonly DrawEntry[],
    readonly gate: FrameGate,
    private readonly scrollX: number,
    private readonly scrollY: number,
  ) {
    this.cursor = new DrawCursor(list);
  }

  /** True when the entry cursor is stuck on a gated entry with a closed gate (every later entry of the frame stays undrawn). */
  get blocked(): boolean {
    return this.cursor.isBlocked;
  }

  /** True when the tile of view cell (vx, vy) was already drawn in front of an entry; consumes the mark ($6540 `bclr`). */
  claimed(vx: number, vy: number): boolean {
    return this.marked.delete(vy * VIEW + vx);
  }

  /** Draws the entries the cursor yields for view cell (vx, vy), each after its own neighbour redraw when flag bit 0 asks for it. */
  drawAfterCell(screen: Screen, vx: number, vy: number): void {
    for (const e of this.cursor.turn(orderKey(vx, vy), this.gate.open)) {
      if ((e.flags & FLAG_NEIGHBOURS) !== 0 && (e.dx !== 0 || e.dy !== 0)) this.drawNeighbours(e);
      this.layer.blit(screen, e.type, e.frame, e.anim, e.vx, e.vy, e.dx, e.dy, e.lift);
    }
  }

  // The flat tiles in front of a moving entry are drawn right before it so it appears on top of them; each is marked so the
  // normal cell loop skips it later. An already marked neighbour is left alone; the mark never hides objects.
  private drawNeighbours(e: DrawEntry): void {
    for (const [ox, oy] of neighbourOffsets(e.frame)) {
      const nx = e.vx + ox;
      const ny = e.vy + oy;
      if (nx < 0 || nx >= VIEW || ny >= VIEW || ny < 0) continue;
      const key = ny * VIEW + nx;
      if (this.marked.has(key)) continue;
      const tile = this.layer.tileAt(this.scrollX, this.scrollY, nx, ny);
      if (!tile || tile.rows > MAX_NEIGHBOUR_ROWS) continue;
      this.layer.paintTile(tile, nx, ny);
      this.marked.add(key);
    }
  }
}
