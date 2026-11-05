// Player orders for own ground units and launched ships: what a right click on the map picks ($3EDC) and what the
// tank window ($C5BE) does with its answer (single order, group orders by distance, stop). The ship window ($DA94)
// and its dispatch ($3F9E) are in screens/orders.ts and EnemySystem.commandShip. Notes: notes/formats/ship-control.md.

import type { ObjectLayer } from "./objects.js";
import type { Ship } from "./sim-ships.js";
import { NO_TARGET, type Unit, type UnitSystem } from "./units.js";

export const MISSILE_TYPE = 17; // ship list type of a guided projectile: has no window

export type Pick = { kind: "tank"; unit: Unit } | { kind: "ship"; ship: Ship };

const BOX = 20; // $3F28: the hit box of a sprite is 20 x 20 pixels

// Screen position of the corner a cell hit is tested with ($5D28 leaves the rectangle's x0, y0 in d0, d1).
function cellCorner(vx: number, vy: number): { x: number; y: number } {
  return { x: 112 + 16 * (vx - vy), y: 24 + 8 * (vx + vy) };
}

// $3F5E: what a record is: an own tank (type 9 / 10) or one of the six ship types; missiles, enemies and the rest
// have no window and end the search.
function classify(ref: unknown, units: UnitSystem, ships: Ship[]): Pick | null {
  if (ref && (units.units as unknown[]).includes(ref)) return { kind: "tank", unit: ref as Unit };
  if (ref && (ships as unknown[]).includes(ref) && (ref as Ship).type !== MISSILE_TYPE) return { kind: "ship", ship: ref as Ship };
  return null;
}

// $3F1E: the first drawn object whose 20 x 20 box (left edge x, bottom row y) contains the point.
function scan(list: { x: number; y: number; ref: object }[], px: number, py: number): { ref: object } | null {
  for (const e of list) {
    if (e.x > px || e.y < py) continue;
    if (e.y - BOX > py) continue;
    if (e.x + BOX >= px) return e;
  }
  return null;
}

// Right click in select mode ($3EDC). `cell` is the map cell under the pointer ($5CDA, null when none).
//  1. With a cell: the first ship (list order), then the first own tank, standing exactly on that cell.
//  2. Otherwise the first drawn object whose box contains the point: the point is the pointer, but after a cell hit the
//     original uses that cell's top-left corner instead.
// Deviation: when both fail the pointer itself is tried too, so a flying ship can be picked by its sprite.
export function pickObject(
  layer: ObjectLayer,
  ships: Ship[],
  scrollX: number,
  scrollY: number,
  px: number,
  py: number,
  cell: { x: number; y: number } | null,
): Pick | null {
  if (cell) {
    const ship = ships.find((s) => s.x === cell.x && s.y === cell.y);
    if (ship) return classify(ship, layer.units, ships);
    const unit = layer.units.units.find((u) => u.x === cell.x && u.y === cell.y);
    if (unit) return classify(unit, layer.units, ships);
  }
  const list = layer.pickables(scrollX, scrollY);
  const corner = cell ? cellCorner(cell.x - scrollX, cell.y - scrollY) : { x: px, y: py };
  const hit = scan(list, corner.x, corner.y) ?? (cell ? scan(list, px, py) : null);
  return hit ? classify(hit.ref, layer.units, ships) : null;
}

// ---- the tank window's orders ($C880 ff.) ----------------------------------------------------------------------

// $3FEE: the own units sorted by Chebyshev distance to (x, y), nearest first. The original's bubble sort swaps equal
// neighbours too, which is kept (it decides the order among units that are equally far away).
export function sortByDistance(units: Unit[], x: number, y: number): Unit[] {
  const list = units.map((u) => ({ u, d: Math.max(Math.abs(u.x - x), Math.abs(u.y - y)) }));
  for (let pass = 0; pass < list.length - 1; pass++) {
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].d >= list[i + 1].d) [list[i], list[i + 1]] = [list[i + 1], list[i]];
    }
  }
  return list.map((e) => e.u);
}

export type GroupOrder = "front" | "nearTank" | "nearPin";

// $C960 / $C99A / $C9D0 + $C9FC: the `count` nearest tanks (counted from the window's tank for "front" and "nearTank",
// from the pin for "nearPin") walk to `target`. A count of 0 does nothing, more than there are tanks means all.
// Returns the tanks that got the order.
export function orderGroup(units: UnitSystem, tank: Unit, kind: GroupOrder, count: number, target: { x: number; y: number }): Unit[] {
  if (count <= 0) return [];
  const from = kind === "nearPin" ? target : tank;
  const sorted = sortByDistance(units.units, from.x, from.y);
  const chosen = sorted.slice(0, Math.min(count, sorted.length));
  for (const u of chosen) units.order(u, target.x, target.y);
  return chosen;
}

// $C8DC: stop the tank: no target, no speed, no pixel offset.
export function stopUnit(unit: Unit): void {
  unit.targetX = NO_TARGET;
  unit.vx = 0;
  unit.vy = 0;
  unit.dx = 0;
  unit.dy = 0;
}
