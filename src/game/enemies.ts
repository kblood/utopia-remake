// The enemy side of the map and the combat of everything that flies or fights: enemy ground units ($3A12C,
// $1193E) and aircraft ($39E20, $11A9E), their attacks ($1266A), the own tanks' and ships' fire ($12588), the
// ship mode machine ($42BE, $4526), missiles, the two kinds of gun ($11D34), the unit bookkeeping of $4692 /
// $46CC / $11C30 / $11C5C, defecting tanks, weekly repairs and the overview feed. Notes: notes/formats/enemies.md.
//
// The system is driven once per main-loop pass by `pass(clock)` (after the own tanks, as in $333A). Gun rounds are
// bound into Sim and run when `$99C4` consumes pending-period bit 4 / the daily bit. It touches the simulation only through Sim (state words, `bomb`,
// `roll`, `applyMorale`, the fleet), so it can run headless. Lookup tables come from the game image at runtime
// (src/data/combat.ts).

import { MAP_HEIGHT, MAP_WIDTH, TILE_ID_MASK } from "../data/scenario.js";
import { CELL_FLAG_BYTES, cellFlagIndex, cellFlagPointer, mapIndex, resolveCellFlagPointer } from "./cell-flags.js";
import type { Disk4EnemyAirSlot, Disk4EnemyGroundSlot } from "../data/disk4-entities.js";
import type { CombatTables } from "../data/combat.js";
import { DISK4_ADDR } from "../data/disk4-state.js";
import { SFX } from "../audio/sfx.js";
import type { Drawable } from "./objects.js";
import type { EnemySpawn } from "./sim-aliens.js";
import { MAX_SHIPS, isMissile, type FleetRecord, type MissileRecord, type Ship } from "./sim-ships.js";
import { ENEMY_RECORD_SIZE, MISSILE_TARGET_MASK, ShipRoster, resolveEnemyRecordPointer, type RestoredMissile } from "./ship-roster.js";
import type { Sim } from "./sim.js";
import { OBJECT_SLOTS, TYPE_SIZE, TYPE_TABLE } from "./world.js";
import {
  BLOCKED,
  DIR_STEP,
  NO_TARGET,
  OCCUPIED,
  ROCK_FIRST_ID,
  STEP_PIXELS,
  UNIT_ADVANCED,
  VELOCITY,
  inMap,
  walkerStep,
  type PassClock,
  type StepEnv,
  type Unit,
  type UnitSystem,
  type Walker,
} from "./units.js";

// ---- constants ------------------------------------------------------------------------------------

export const ENEMY_WALKER_A = 22; // ground: walks to random buildings and bombs active cells
export const ENEMY_WALKER_B = 23;
export const ENEMY_CRUSHER = 24; // ground: crosses and destroys active buildings
export const ENEMY_BOMBER = 25; // air: flies over buildings and bombs them
export const ENEMY_KAMIKAZE = 26; // air: dives onto a building
export const ENEMY_KAMIKAZE_FAST = 27; // as 26 at double speed
export const MAX_GROUND = 60;
export const MAX_AIR = 30;
export const FRONT_X = 0x135c4; // $135C4/$135C5: the front, a cell off the map
export const FRONT_Y = 0x135c5;
// Ship orders of the ship window ($F173, dispatched at $3F9E): what a flying or landed ship is told to do.
export const SHIP_ORDER = { land: 0, hover: 1, goLand: 2, goHover: 3, buildPad: 4, front: 9 } as const;
export const MSG_NO_FUEL = 0xed; // $3F94: a ship without fuel cannot be ordered

const AIR_LAYER = 0x2000; // map word bit 13
const ACTIVE = 0x0400; // map word bit 10: animated / active building
const AIR_START_LIFT = 0x22;
export const FLAG_GROUND = 1; // per-cell flag byte bits ($3D3A6): enemy ground, enemy air, own ground, flying ship
export const FLAG_AIR = 2;
export const FLAG_OWN = 4;
export const FLAG_SHIP = 8;
const LAND_CELL_BLOCK = 0x5000; // $41DA: a ship cannot land on a blocked or occupied cell
const TILE_ACID = 0x61; // enemy ground units standing on it take damage ($11ECA)
const TILE_PAD = 0x48; // launch pad tile
const GUN_A = 0x1f;
const GUN_B = 0x0f;
const POWER_LEVEL = 0x144c8;
const KILLS = 0x14298;
const LOST = 0x14294;

// Desired direction from (x, y) towards (tx, ty) ($11B70-$11BAE); -1 = on the target.
export function dirToward(x: number, y: number, tx: number, ty: number): number {
  if (x === tx) return y === ty ? -1 : y < ty ? 4 : 0;
  if (x < tx) return y < ty ? 3 : y === ty ? 2 : 1;
  return y < ty ? 5 : y === ty ? 6 : 7;
}

function s8(v: number): number {
  return ((v + 128) & 255) - 128;
}

// ---- records ----------------------------------------------------------------------------------------

// One entry of the enemy ground list ($3A12C, stride $1A) or the enemy air list ($39E20).
export class Enemy implements Walker {
  dx = 0;
  dy = 0;
  vx = 0;
  vy = 0;
  mode = 6; // +9: 6 choose a target, 1 on the way, 5 frozen, 2 diving, 3 flying on
  targetX = NO_TARGET;
  targetY = NO_TARGET;
  recent: [number, number, number] = [0xff, 0xff, 0xff];
  // The cell the slot's raw +$16 flag pointer currently names, or -1 / -1 when that pointer names no playable cell
  // (zero, padding, off the map). A mirror only: the raw per-slot pointer lives in the EnemySystem
  // (`groundFlagPointers` / `airFlagPointers`) because the original's +$16 belongs to the fixed slot and survives death
  // and reuse. The death routine releases the cell the POINTER names, not x/y.
  reserveX = -1;
  reserveY = -1;
  waiting = false; // +9 bit 7
  steps = 0; // +D: cell moves / steps in the current mode
  aux = 0; // +$13 (signed): bomb count of a bomber, dive altitude of a kamikaze
  p14 = 0; // +$14: bomb chance in percent (air)
  p15 = 0; // +$15: non-zero = a bomber that has dropped everything turns into a kamikaze
  // Crusher (type 24): +$13 packs both, byte = toggle << 7 | counter ($11F4E bchg #7, $11F58..$11F64 subq/store).
  toggle = false; // bit 7 of +$13: true = the NEXT call performs the step, false = it only flips the bit
  counter = 0; // low 7 bits of +$13: step counter, 0..7 (the animation table $12D60 has 8 bytes)
  anim = 0; // +$14: repeat count the sprite routine $3768 adds to the frame address (0..2 from the table)
  lift = 0; // +$10: altitude of an aircraft
  tech = 0; // +A (raw wave level on allocated enemies; Disk.4 hydration copies the saved byte)
  // Saved-record provenance; -1 / null for a spawned enemy. Set only by Enemy.fromDisk4.
  readonly slot: number;
  readonly sourceRaw: Uint8Array | null;
  readonly sourceAddress: number | null;
  readonly flagPointer: number | null;
  /** Full saved +9 byte. Ground bit 7 means waiting; air records retain +9 as an uninterpreted mode byte. */
  readonly savedControl: number | null;

  constructor(
    public type: number,
    public x: number,
    public y: number,
    public dir: number,
    public hp: number,
    public dmg: number, // +F: damage of an attack
    public bombPct: number, // +E: chance in percent that an attack on a building drops a bomb
    readonly air: boolean,
    source?: { slot: number; raw: Uint8Array; address: number; flagPointer: number; control: number },
  ) {
    this.slot = source?.slot ?? -1;
    this.sourceRaw = source ? source.raw.slice() : null;
    this.sourceAddress = source?.address ?? null;
    this.flagPointer = source?.flagPointer ?? null;
    this.savedControl = source?.control ?? null;
  }

  /**
   * Detached runtime enemy from one occupied saved record. Documented fields are copied as stored;
   * `reservation` is the playable cell the saved flag pointer names (not necessarily x/y), or -1 / -1 when it names none. A crusher's +$13 is split into
   * `toggle` (bit 7) and `counter` (low 7 bits, kept raw even above 7) and +$14 becomes `anim`; `fromRoster`
   * rejects out-of-domain values. The exact bytes stay in `sourceRaw`, as do all other undocumented bytes.
   */
  static fromDisk4(slot: Disk4EnemyAirSlot | Disk4EnemyGroundSlot, reservation: { x: number; y: number }): Enemy {
    const air = slot.list === "enemyAir";
    const e = new Enemy(slot.type, slot.x, slot.y, slot.direction, slot.hp, slot.damage, slot.bombChance, air, {
      slot: slot.index, raw: slot.raw, address: slot.address, flagPointer: slot.flagPointer, control: slot.control,
    });
    e.dx = slot.dx; e.dy = slot.dy; e.vx = slot.vx; e.vy = slot.vy;
    e.mode = air ? slot.control : slot.control & 0x7f;
    // Only enemy ground is documented as checking bit 7 for the move-tick wait flag.
    e.waiting = !air && (slot.control & 0x80) !== 0;
    e.tech = slot.tech;
    e.targetX = slot.targetX; e.targetY = slot.targetY;
    e.steps = slot.stepCounter;
    e.aux = air ? slot.auxSigned : slot.aux; // same convention as spawn(): aircraft signed, ground unsigned
    e.p14 = slot.byte14; e.p15 = slot.byte15;
    if (slot.type === ENEMY_CRUSHER && !air) {
      e.toggle = (slot.aux & 0x80) !== 0; // $11F4E: bchg.b #7,$13(a6)
      e.counter = slot.aux & 0x7f;
      e.anim = slot.byte14;
    }
    if (slot.list === "enemyAir") e.lift = slot.lift;
    else e.recent = [...slot.recentDirections];
    e.reserveX = reservation.x; e.reserveY = reservation.y;
    return e;
  }
}

export const ENEMY_GROUND_TYPES: readonly number[] = [9, 10, ENEMY_WALKER_A, ENEMY_WALKER_B, ENEMY_CRUSHER];
export const ENEMY_AIR_TYPES: readonly number[] = [ENEMY_BOMBER, ENEMY_KAMIKAZE, ENEMY_KAMIKAZE_FAST];

export interface EnemyRestoreError {
  readonly code: "slot-count" | "slot-index" | "enemy-type" | "position" | "direction" | "flag-pointer" | "buffers";
  readonly list?: "enemyAir" | "enemyGround";
  readonly slot?: number;
  readonly field?: string;
  readonly message: string;
}
export type EnemyRestoreResult = { readonly ok: true; readonly value: EnemyRoster } | { readonly ok: false; readonly error: EnemyRestoreError };

/**
 * Detached fixed-slot enemy lists of a Disk.4 restore: 60 ground and 30 air slots, null = free. It is NOT
 * an EnemySystem and drives nothing: no spawn/defect/step/combat, no RNG, no hooks, no counter updates.
 * `cells` / `flags` are the caller's world buffers, kept by reference and never written here; the
 * occupancy bits the saved enemies imply are whatever the saved map already holds. Ships are not restored.
 */
export class EnemyRoster {
  readonly ground: (Enemy | null)[] = new Array<Enemy | null>(MAX_GROUND).fill(null);
  readonly air: (Enemy | null)[] = new Array<Enemy | null>(MAX_AIR).fill(null);
  /**
   * The raw saved +$16 long of EVERY slot, free records included (the original never clears it, so a free slot keeps the
   * pointer of its last occupant; enemies.md section 3b). Copied from the decoded records without interpretation; an
   * `EnemySystem` that adopts the roster works directly on these arrays.
   */
  readonly groundPointers: number[] = new Array<number>(MAX_GROUND).fill(0);
  readonly airPointers: number[] = new Array<number>(MAX_AIR).fill(0);
  private constructor(readonly cells: Uint16Array, readonly flags: Uint8Array) {}

  /** Occupied enemies in stable slot order. */
  get groundEnemies(): Enemy[] { return this.ground.filter((e): e is Enemy => e !== null); }
  get airEnemies(): Enemy[] { return this.air.filter((e): e is Enemy => e !== null); }

  /**
   * Hydrates all slots, or returns one typed error and nothing. Free slots (type 0) stay null whatever stale
   * bytes the record holds (those remain in the decoded slot). Occupied records need a supported type for
   * their list, a map position and direction 0..7. The +$16 long of every record (free or occupied) is kept raw and may be
   * any unsigned 32-bit value (zero, padding column, outside the flag array); only a playable cell becomes the reserve mirror.
   */
  static fromDisk4(
    cells: Uint16Array,
    flags: Uint8Array,
    ground: readonly Disk4EnemyGroundSlot[],
    air: readonly Disk4EnemyAirSlot[],
  ): EnemyRestoreResult {
    const fail = (error: EnemyRestoreError): EnemyRestoreResult => ({ ok: false, error });
    if (!(cells instanceof Uint16Array) || !(flags instanceof Uint8Array) || cells.length !== MAP_WIDTH * MAP_HEIGHT || flags.length !== CELL_FLAG_BYTES) {
      return fail({ code: "buffers", message: "Enemy hydration needs the world's 7500 cell words and 7650 flag bytes" });
    }
    const roster = new EnemyRoster(cells, flags);
    const lists = [
      { name: "enemyGround", records: ground, out: roster.ground, pointers: roster.groundPointers, size: MAX_GROUND, types: ENEMY_GROUND_TYPES },
      { name: "enemyAir", records: air, out: roster.air, pointers: roster.airPointers, size: MAX_AIR, types: ENEMY_AIR_TYPES },
    ] as const;
    for (const list of lists) {
      const { name } = list;
      if (list.records.length !== list.size) {
        return fail({ code: "slot-count", list: name, message: `${name} has ${list.records.length} slots, expected ${list.size}` });
      }
      for (let i = 0; i < list.size; i++) {
        const r = list.records[i];
        if (!r || r.list !== name || r.index !== i || !(r.raw instanceof Uint8Array) || r.raw.length !== 0x1a) {
          return fail({ code: "slot-index", list: name, slot: i, field: "record", message: `${name} slot ${i} has missing or inconsistent provenance` });
        }
        if (!isUnsignedLong(r.flagPointer)) {
          return fail({ code: "flag-pointer", list: name, slot: i, field: "+$16", message: `${name} slot ${i} +$16 ${String(r.flagPointer)} is not an unsigned 32-bit long` });
        }
        list.pointers[i] = r.flagPointer; // raw, free records too: nothing is guessed from x/y
        if (r.status === "free") continue;
        if (!list.types.includes(r.type)) return fail({ code: "enemy-type", list: name, slot: i, field: "+0", message: `${name} slot ${i} has unsupported type ${r.type}` });
        if (!inMap(r.x, r.y)) return fail({ code: "position", list: name, slot: i, field: "+1/+2", message: `${name} slot ${i} position (${r.x}, ${r.y}) is outside the map` });
        if (!Number.isInteger(r.direction) || r.direction < 0 || r.direction > 7) {
          return fail({ code: "direction", list: name, slot: i, field: "+5", message: `${name} slot ${i} direction ${r.direction} is outside 0..7` });
        }
        // Any unsigned +$16 is valid on an occupied record: a wave enemy is occupied before its first claim and the allocators
        // leave the slot tail untouched (zero, padding or any stale long). It is kept raw in `pointers`; the mirror cell is
        // set only when it names a playable cell, else -1 / -1. Nothing is rejected on the pointer alone.
        (list.out as (Enemy | null)[])[i] = Enemy.fromDisk4(r, reservationOf(r.flagPointer));
      }
    }
    return { ok: true, value: roster };
  }
}

// Extra state of a ship (the Ship record of sim-ships.ts has no room for it).
interface ShipExtra {
  vx: number; // +6, +7
  vy: number;
  next: number; // +$11: the mode to switch to when the current one ends
  turn: number; // +$12: the direction the ship turns to while it climbs or descends
  rx: number; // the cell holding the ship's map mark = the cell its +$14 flag pointer names (-1 = none)
  ry: number;
  // Every missile (launched by launchMissile or restored from Disk.4): the fixed enemy slot the pointer at +$C..+$F names
  // ($E904 at launch, the saved pointer on restore). The occupant is looked up in the slot every time it is needed (never
  // kept: a dead Enemy must not outlive its slot, and nothing is matched by coordinates), exactly like $4408 / $ACE2
  // dereference the address. null for ordinary ships.
  targetSlot: EnemySlotRef | null;
}

/** A ship's extra state as the remake save stores it (same fields as the private ShipExtra; rx/ry -1 = no reservation cell). */
export interface ShipExtraState {
  readonly vx: number;
  readonly vy: number;
  readonly next: number;
  readonly turn: number;
  readonly rx: number;
  readonly ry: number;
  readonly targetSlot: EnemySlotRef | null;
}

/** A fixed enemy slot: the 30 air slots ($39E3A + i * $1A) or the 60 ground slots ($3A146 + i * $1A). */
export interface EnemySlotRef {
  readonly air: boolean;
  readonly index: number;
}

/** Original RAM address of the slot start: the 24-bit pointer a missile stores in +$D..+$F. */
export function enemySlotAddress(slot: EnemySlotRef): number {
  return (slot.air ? DISK4_ADDR.enemyAir : DISK4_ADDR.enemyGround) + slot.index * ENEMY_RECORD_SIZE;
}

/** Plain copy of a ShipExtra for observers (`EnemySystem.inspectShip`); `rx`/`ry` = -1 means no reservation cell. */
export interface ShipInspection {
  readonly vx: number;
  readonly vy: number;
  readonly next: number;
  readonly turn: number;
  readonly rx: number;
  readonly ry: number;
  /** The enemy slot a missile follows (null for ordinary ships). */
  readonly targetSlot: EnemySlotRef | null;
  /** Whether that slot currently holds an enemy (null without a target slot). */
  readonly targetOccupied: boolean | null;
}

export interface EnemyTarget {
  x: number;
  y: number;
  enemy: Enemy;
}

export interface EnemyHooks {
  // $1237C: an explosion at a cell; `lift` is the altitude of an airborne victim, `high` the unit-destroyed sound.
  // Return value (enemies.md section 6): `true` = the routine clobbered A6, the register `$11C5C`/`$11C30` still
  // hold the victim's map-word pointer in, so the map occupancy clear of the kill is lost (off-view sound-only path, or
  // inside the view with an effect allocated). `false` = A6 survived (effect list full: no sprite, no sound), the map
  // bit is cleared. Anything else (no return value, no hook) counts as "pointer survived".
  explode?: (x: number, y: number, lift: number, high: boolean) => boolean | void;
  sound?: (id: number) => void;
  // Stored height of a building tile: the descriptor's `rows - 1` (table $1612E, long at +0; its low byte is +3).
  // Called with the tile word of the building's object record (+0), not the map cell. A kamikaze dives to
  // (stored - 10) as a byte (enemies.md section 3c).
  buildingHeight?: (tile: number) => number;
  // $771E: a hovering ship starts a launchpad on the 2x2 cells at (x, y); false = refused (the builder says why).
  buildPad?: (x: number, y: number) => boolean;
}

export interface EnemyAdoptError {
  /**
   * "unsupported-state": an occupied record whose runtime state is not grounded: a crusher whose +$13 counter is above 7
   * (`crusher-counter`: `$11F68` would index past the 8-byte table `$12D60`) or whose +$14 is above the table's largest
   * value (`crusher-anim`: the sprite sheet has no such frame set), a restored missile in a mode other than 1, 2, 4 (the only modes $4408 sets), or a lift above $7F (the original
   * reads +$10 as a signed byte). "roster": the enemy roster is corrupt (shape, type/list, identity, duplicate
   * objects). "buffers": the roster was built over other map/flag buffers than this system's. "tables": malformed
   * CombatTables. "already-adopted": the roster's slots already belong to another EnemySystem.
   * Own-ship adoption: "ship-roster" (shape, kind/type/class/slot identity, ranges, duplicates, a non-empty Fleet, or a
   * missile whose saved target disagrees with the adopted enemy slots), "ship-count" (the saved $1429E word differs
   * from the occupied slots: $ACE2/$4798 loop by that word), "flag-pointer" (the +$14 pointer is not a playable cell).
   */
  readonly code: "unsupported-state" | "roster" | "buffers" | "tables" | "already-adopted" | "ship-roster" | "ship-count" | "flag-pointer";
  readonly reason?: "crusher-counter" | "crusher-anim" | "missile-mode" | "lift";
  readonly list?: "enemyAir" | "enemyGround" | "ownShips";
  readonly slot?: number;
  /** Record field associated with an adoption refusal, when applicable (for example `+$16`). */
  readonly field?: string;
  readonly message: string;
}
export type EnemyAdoptResult = { readonly ok: true; readonly value: EnemySystem } | { readonly ok: false; readonly error: EnemyAdoptError };

const adoptedRosters = new WeakSet<EnemyRoster>();
const adoptedShipRosters = new WeakSet<ShipRoster>();
const FLEET_COUNT = 0x1429e; // $1429E: own ships in the ship list (also bounds the $ACE2 / $4798 loops)

interface AdoptedShip {
  readonly record: FleetRecord;
  readonly extra: ShipExtra;
}

// Validates a ShipRoster for adoption into `sim.fleet` next to the given enemy slots and builds the ShipExtra of every
// record from the SAVED bytes: +6/+7 -> vx/vy, +$11 -> next, +$12 -> turn, and the cell of the +$14 flag pointer
// ($4152/$4526/$43EE write it as the ship's current reservation, $4732 releases exactly that cell) -> rx/ry. Nothing
// is changed here; any problem returns one typed error.
function planShips(
  sim: Sim,
  ships: ShipRoster,
  ground: readonly (Enemy | null)[],
  air: readonly (Enemy | null)[],
): { readonly plan: (AdoptedShip | null)[] } | { readonly error: EnemyAdoptError } {
  const err = (e: Omit<EnemyAdoptError, "list">): { error: EnemyAdoptError } => ({ error: { list: "ownShips", ...e } });
  if (!(ships instanceof ShipRoster) || !Array.isArray(ships.slots) || ships.slots.length !== MAX_SHIPS) {
    return err({ code: "ship-roster", message: `Ship roster must hold a fixed array of ${MAX_SHIPS} slots` });
  }
  if (adoptedShipRosters.has(ships)) return err({ code: "already-adopted", message: "This ship roster's records already belong to an EnemySystem" });
  if (sim.fleet.slots.some((r) => r !== null)) return err({ code: "ship-roster", message: "The Fleet already holds ships; a roster can only be adopted into an empty one" });
  let occupiedSlots = 0;
  for (const r of ships.slots) if (r !== null) occupiedSlots++;
  const savedCount = sim.state.word(FLEET_COUNT);
  if (savedCount !== occupiedSlots) {
    return err({ code: "ship-count", message: `Saved ship count ${savedCount} differs from ${occupiedSlots} occupied slots; the original loops by that word` });
  }
  const seen = new Set<object>();
  const plan: (AdoptedShip | null)[] = new Array<AdoptedShip | null>(MAX_SHIPS).fill(null);
  for (let i = 0; i < MAX_SHIPS; i++) {
    const r = ships.slots[i];
    if (r === null) continue;
    const bad = (message: string, code: EnemyAdoptError["code"] = "ship-roster", reason?: EnemyAdoptError["reason"]) =>
      err({ code, slot: i, ...(reason ? { reason } : {}), message: `ownShips slot ${i}: ${message}` });
    if (typeof r !== "object" || r === undefined || seen.has(r) || r.slot !== i) return bad("foreign, duplicated or mismatched record");
    seen.add(r);
    const missileKind = r.kind === "missile";
    if (!missileKind && r.kind !== "ship") return bad("unknown record kind");
    const rec: FleetRecord = r;
    if (missileKind ? rec.type !== 17 : !(rec.type >= 11 && rec.type <= 16 && (rec as Ship).cls === rec.type - 11)) return bad("type does not match the record kind or class");
    if (!inMap(rec.x, rec.y)) return bad("position is outside the map");
    if (!Number.isInteger(rec.dir) || rec.dir < 0 || rec.dir > 8) return bad("direction is outside 0..8");
    if (!Number.isInteger(rec.mode) || rec.mode < 0 || rec.mode > 8) return bad("mode is outside 0..8");
    if (!Number.isInteger(rec.lift) || rec.lift < 0) return bad("lift is not a non-negative integer");
    if (rec.lift > 0x7f) return bad("lift above $7F: the original reads +$10 as a signed byte", "unsupported-state", "lift");
    const e = (r as { extra?: { vx: number; vy: number; next: number; turn: number } }).extra;
    const sb = (v: number): boolean => Number.isInteger(v) && v >= -128 && v <= 127;
    if (!e || !sb(e.vx) || !sb(e.vy) || !sb(rec.dx) || !sb(rec.dy) || !Number.isInteger(e.next) || !Number.isInteger(e.turn)) return bad("saved extra record is missing or malformed");
    const fp = resolveCellFlagPointer(r.flagPointer?.raw);
    if (fp.kind !== "playable") return bad(`+$14 flag pointer is ${fp.kind}: only a pointer to a playable cell can become the reservation`, "flag-pointer");
    let targetSlot: EnemySlotRef | null = null;
    if (r.kind === "missile") {
      const m: RestoredMissile = r;
      if (m.mode !== 1 && m.mode !== 2 && m.mode !== 4) return bad(`missile mode ${m.mode} is not one $4408 sets (1, 2 or 4)`, "unsupported-state", "missile-mode");
      const t = m.target;
      const res = t ? resolveEnemyRecordPointer(t.address) : null;
      if (!t || !res || res.kind !== "record" || ((t.rawLong & MISSILE_TARGET_MASK) >>> 0) !== t.address ||
        t.ref?.list !== res.list || t.ref.index !== res.index || t.ref.address !== res.address) {
        return bad("missile target pointer does not name a fixed enemy slot");
      }
      const occupant = (res.list === "enemyAir" ? air : ground)[res.index] ?? null;
      if ((t.ref.status === "occupied") !== (occupant !== null) || (t.enemy !== undefined && t.enemy !== occupant)) {
        return bad("missile target disagrees with the adopted enemy slots (occupancy or Enemy identity)");
      }
      targetSlot = { air: res.list === "enemyAir", index: res.index };
    }
    plan[i] = { record: rec, extra: { vx: e.vx, vy: e.vy, next: e.next, turn: e.turn, rx: fp.x, ry: fp.y, targetSlot } };
  }
  return { plan };
}

function isUnsignedLong(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

/** The (x, y) a raw +$16 pointer names when it names a playable cell, else the "no reservation" marker -1 / -1. */
function reservationOf(pointer: number): { x: number; y: number } {
  const t = resolveCellFlagPointer(pointer);
  return t.kind === "playable" ? { x: t.x, y: t.y } : { x: -1, y: -1 };
}

/** Index of the first free slot (the scan of $48B6 / $48EC), or -1 when the list is full. */
function firstFree(slots: readonly (Enemy | null)[]): number {
  return slots.indexOf(null);
}

function occupied(slots: readonly (Enemy | null)[]): Enemy[] {
  return slots.filter((e): e is Enemy => e !== null);
}

export class EnemySystem {
  /**
   * Stable fixed slots: 60 ground / 30 air, null = free ($3A146 / $39E3A type byte 0). A freed slot never shifts
   * the survivors and a new enemy takes the first free slot. After `fromRoster` these ARE the roster's arrays.
   */
  readonly groundSlots: (Enemy | null)[];
  readonly airSlots: (Enemy | null)[];
  /** Occupied ground enemies in slot order (a fresh dense view; capacity is counted on the slots, not on this). */
  get ground(): Enemy[] { return occupied(this.groundSlots); }
  /** Occupied aircraft in slot order (a fresh dense view). */
  get air(): Enemy[] { return occupied(this.airSlots); }
  get groundCount(): number { return this.groundSlots.reduce((n, e) => n + (e === null ? 0 : 1), 0); }
  get airCount(): number { return this.airSlots.reduce((n, e) => n + (e === null ? 0 : 1), 0); }
  /**
   * The raw +$16 long of every fixed slot (60 ground / 30 air), occupied or free. Static Disk.1 trace (enemies.md 3b): the
   * spawn allocators $48B6 / $48EC never write +$16..+$19 and the death routine $4732 clears only +0..+2 and +8/+9, so the
   * long belongs to the SLOT and survives death and reuse; a movement claim or the event tank defection overwrites it.
   * A never-used slot starts at 0: that is what one captured pre-spawn RAM image held in all 90 slots (one scenario, one
   * machine); initial RAM is NOT proven universal. Adopted Disk.4 rosters and native saves bring their own values.
   * `reserveX/Y` of an enemy is a mirror of the cell its slot's pointer names.
   */
  readonly groundFlagPointers: number[];
  readonly airFlagPointers: number[];
  private readonly cells: Uint16Array;
  private readonly flags: Uint8Array;
  private readonly extras = new WeakMap<FleetRecord, ShipExtra>();
  private clock: PassClock | null = null;
  private lastTargetSlot: EnemySlotRef | null = null; // $E904: a pointer into the fixed enemy slots, not an object
  // Version-4 save compatibility only; original firing schedule is the pending bit in GameState.$144C1.
  private lastCountdown = -1;
  private cache: Drawable[] = [];
  private dirty = true;
  private readonly walkEnv: StepEnv;
  private readonly crushEnv: StepEnv;

  constructor(
    private readonly sim: Sim,
    private readonly units: UnitSystem,
    private readonly tables: CombatTables,
    private hooks: EnemyHooks = {},
    /** Internal: slot arrays to adopt (EnemySystem.fromRoster). Omitted = empty lists. */
    adopt?: { readonly ground: (Enemy | null)[]; readonly air: (Enemy | null)[]; readonly groundPointers: number[]; readonly airPointers: number[] },
  ) {
    this.groundSlots = adopt?.ground ?? new Array<Enemy | null>(MAX_GROUND).fill(null);
    this.airSlots = adopt?.air ?? new Array<Enemy | null>(MAX_AIR).fill(null);
    this.groundFlagPointers = adopt?.groundPointers ?? new Array<number>(MAX_GROUND).fill(0);
    this.airFlagPointers = adopt?.airPointers ?? new Array<number>(MAX_AIR).fill(0);
    this.cells = sim.world.cells;
    this.flags = units.flags;
    this.sim.bindRuntimeHooks({
      gunA: () => this.fireGuns(GUN_A, this.s.long(0x1310e)),
      gunB: () => this.fireGuns(GUN_B, this.s.long(0x13112)),
    });
    this.sim.fleet.setReservationRelease((ship, blasted) => this.releaseShip(ship, this.extra(ship), blasted));
    this.sim.fleet.setMissileDaily((m) => this.dailyMissile(m)); // $ACE2 for every missile, launched or restored
    const leave = (u: Walker): void => this.destroyGround(u as Enemy, false);
    this.walkEnv = {
      cells: this.cells,
      flags: this.flags,
      flagBit: FLAG_GROUND,
      canEnter: (word, u) => !(word & BLOCKED) || (u.type === UNIT_ADVANCED && (word & TILE_ID_MASK) >= ROCK_FIRST_ID),
      leave,
      entered: (u, x, y) => this.claimGround(u as Enemy, x, y),
    };
    this.crushEnv = {
      cells: this.cells,
      flags: this.flags,
      flagBit: FLAG_GROUND,
      // $1207E-$12098: an unblocked cell, or a blocked one whose low byte passes `cmpi.b #$88` + bpl (N clear after the
      // byte subtraction: $88..$FF and, by wrap-around, $00..$07), or an active building (bit 10).
      canEnter: (word) => !(word & BLOCKED) || (((word & 0xff) - ROCK_FIRST_ID) & 0x80) === 0 || (word & ACTIVE) !== 0,
      leave,
      entered: (u, x, y) => this.claimGround(u as Enemy, x, y),
      atCentre: (u) => this.acid(u as Enemy),
      // $1228A: the building is destroyed (jsr $7124, $12332) after the next cell got its occupancy bit and before the
      // old cell's marks, the reservation pointer, the recent directions, the direction and the velocity change.
      claimed: (_u, x, y, word) => {
        if (word & ACTIVE) this.sim.bomb(x, y);
      },
      // $1231A: only +B becomes $FF; +C, the velocity, the direction and the pixel offset stay.
      arrive: (u) => {
        u.targetX = NO_TARGET;
      },
      repeatLastCandidate: true, // $12234 re-tries the +5 entry of the $4BCA row (d+3) instead of d-3
      byteOffsets: true, // $11F88 add.b, $11FA0 cmp.b
    };
  }

  /**
   * Headless, inert adoption of a detached `EnemyRoster`: the roster's Enemy objects keep their identity and
   * their fixed slots (the system works directly on `roster.ground` / `roster.air`; a roster can be adopted once).
   * Nothing is written: no state word, map cell, flag byte, object record, counter, RNG call, hook call, spawn,
   * step or combat. The system is driven only by explicit `pass(clock)` / `frame()` calls from the caller.
   * Everything is validated first and a failure returns one typed error with nothing adopted or changed.
   * Crusher records (type 24) are adopted with the toggle/counter (+$13) and animation (+$14) decoded by
   * `Enemy.fromDisk4`; only a counter above 7 or an animation above the table's largest value is refused, as typed
   * "unsupported-state" (`crusher-counter` / `crusher-anim`), before anything is installed. `sim`'s spawn/defect/repair
   * hooks and the units' hooks are the caller's own and are not wired here.
   *
   * With `ships` (a detached ShipRoster) the same call also adopts the own ships and missiles: the roster's record
   * objects become the live entries of `sim.fleet` in their saved slots (all 40 positions and holes kept), via
   * `Fleet.adoptRestored`, never `createShip`, and this system gets a ShipExtra for each from the saved +6/+7,
   * +$11, +$12 and the cell of the +$14 flag pointer (the current reservation). No counter, RNG draw, hook call or
   * map / flag / state / object write happens; the saved $1429E word must equal the occupied slots. Restored
   * missiles resolve their target as the CURRENT occupant of the saved enemy slot (see missileStep and
   * dailyMissile, shared with launched missiles). All validation precedes any change, so an error leaves everything as it was.
   *
   * The roster's raw +$16 long of every slot, free records included, is adopted unchanged (`groundFlagPointers` /
   * `airFlagPointers` ARE the roster's arrays afterwards): a free slot keeps its stale pointer for the next spawn and the
   * next pre-movement death, exactly as the static trace says the original does. Occupied and free records alike may hold any
   * unsigned long (zero, padding, off the array): it stays raw, the enemy's reserve mirror is the named playable cell or
   * -1 / -1, and death releases only a playable cell (padding / out-of-range release nothing in this port).
   */
  static fromRoster(sim: Sim, units: UnitSystem, tables: CombatTables, roster: EnemyRoster, hooks: EnemyHooks = {}, ships?: ShipRoster): EnemyAdoptResult {
    const fail = (error: EnemyAdoptError): EnemyAdoptResult => ({ ok: false, error });
    if (!(roster instanceof EnemyRoster) || !Array.isArray(roster.ground) || roster.ground.length !== MAX_GROUND || !Array.isArray(roster.air) || roster.air.length !== MAX_AIR) {
      return fail({ code: "roster", message: `Roster must hold fixed arrays of ${MAX_GROUND} ground and ${MAX_AIR} air slots` });
    }
    if (adoptedRosters.has(roster)) return fail({ code: "already-adopted", message: "This roster's slots already belong to an EnemySystem" });
    const t = tables as CombatTables | null | undefined;
    if (!t || !Array.isArray(t.spiral) || t.spiral.length !== 48 || !Array.isArray(t.arcs) || t.arcs.length !== 8 || !t.arcs.every((a) => Array.isArray(a) && a.length === 32) ||
      !Array.isArray(t.turn) || t.turn.length !== 64 || !Array.isArray(t.crusherAnim) || t.crusherAnim.length !== 8) {
      return fail({ code: "tables", message: "CombatTables must have 48 spiral cells, 8 arcs of 32, 64 turn entries and 8 crusher animation entries" });
    }
    if (roster.cells !== sim.world.cells || roster.flags !== units.flags) {
      return fail({ code: "buffers", message: "The roster was built over different map or flag buffers than this Sim / UnitSystem" });
    }
    const seen = new Set<Enemy>();
    const lists = [
      { name: "enemyGround", slots: roster.ground, pointers: roster.groundPointers, air: false, types: ENEMY_GROUND_TYPES },
      { name: "enemyAir", slots: roster.air, pointers: roster.airPointers, air: true, types: ENEMY_AIR_TYPES },
    ] as const;
    for (const list of lists) {
      if (!Array.isArray(list.pointers) || list.pointers.length !== list.slots.length || !list.pointers.every(isUnsignedLong)) {
        return fail({ code: "roster", list: list.name, field: "+$16", message: `${list.name} must carry exactly ${list.slots.length} raw unsigned-long +$16 pointers (free slots included)` });
      }
      for (let i = 0; i < list.slots.length; i++) {
        const e = list.slots[i];
        if (e === null) continue;
        if (!(e instanceof Enemy) || e.air !== list.air || !list.types.includes(e.type) || e.slot !== i || !inMap(e.x, e.y) || seen.has(e)) {
          return fail({ code: "roster", list: list.name, slot: i, message: `${list.name} slot ${i} holds a foreign, mismatched or duplicated enemy` });
        }
        const named = reservationOf(list.pointers[i]);
        if (e.reserveX !== named.x || e.reserveY !== named.y) {
          return fail({ code: "roster", list: list.name, slot: i, field: "+$16", message: `${list.name} slot ${i}: the enemy's reserve mirror does not match the cell its slot pointer names (or -1 / -1)` });
        }
        seen.add(e);
      }
    }
    // The table $12D60 (checked above to have 8 entries) is the domain of both crusher fields: $11F68 reads entry
    // `counter`, and the animation byte is only ever written from it ($11F6E) or at spawn from a wave entry ($4974).
    const maxAnim = Math.max(...t.crusherAnim);
    for (let i = 0; i < roster.ground.length; i++) {
      const c = roster.ground[i];
      if (c?.type !== ENEMY_CRUSHER) continue;
      if (typeof c.toggle !== "boolean" || !Number.isInteger(c.counter) || c.counter < 0 || c.counter > 7) {
        return fail({ code: "unsupported-state", reason: "crusher-counter", list: "enemyGround", slot: i, message: `enemyGround slot ${i} is a crusher whose +$13 counter ${c.counter} is outside 0..7 (the animation table has 8 entries)` });
      }
      if (!Number.isInteger(c.anim) || c.anim < 0 || c.anim > maxAnim) {
        return fail({ code: "unsupported-state", reason: "crusher-anim", list: "enemyGround", slot: i, message: `enemyGround slot ${i} is a crusher whose +$14 animation ${c.anim} is outside 0..${maxAnim} (the table's largest value)` });
      }
    }
    let planned: (AdoptedShip | null)[] | null = null;
    if (ships !== undefined) {
      const p = planShips(sim, ships, roster.ground, roster.air);
      if ("error" in p) return fail(p.error);
      planned = p.plan;
    }
    const system = new EnemySystem(sim, units, tables, hooks, { ground: roster.ground, air: roster.air, groundPointers: roster.groundPointers, airPointers: roster.airPointers });
    if (ships !== undefined && planned !== null) {
      for (const a of planned) if (a) system.extras.set(a.record, a.extra);
      if (!sim.fleet.adoptRestored(planned.map((a) => a?.record ?? null))) {
        return fail({ code: "ship-roster", list: "ownShips", message: "The Fleet refused the adoption" });
      }
      adoptedShipRosters.add(ships);
    }
    adoptedRosters.add(roster);
    return { ok: true, value: system };
  }

  /**
   * Replaces the presentation callbacks (explosion, sound, launchpad builder, building height) of an existing system,
   * e.g. one adopted headlessly by `fromRoster` before a scene exists. Only the hook object changes: the slot arrays,
   * Enemy / ship / missile objects, ShipExtras, clock, RNG use, the Fleet reservation-release and restored-missile
   * daily callbacks and all map / flag / state bytes are untouched, and nothing is called. A second system must never
   * be built over an adopted roster; bind the one you have.
   */
  bindHooks(hooks: EnemyHooks): void {
    this.hooks = hooks;
  }

  /** True when this system was built over exactly this Sim and own-unit system (identity check for activation). */
  isComposedOf(sim: Sim, units: UnitSystem): boolean {
    return this.sim === sim && this.units === units;
  }

  /**
   * Remake-save access (save-session.ts), read side: the two private values no other accessor shows. `lastCountdown` is
   * retained only for version-4 compatibility; `lastTarget` is the fixed enemy slot `findTarget` remembered for the next
   * launch ($E904). Ship extras are read with `inspectShip`.
   */
  get sessionState(): { readonly lastCountdown: number; readonly lastTarget: EnemySlotRef | null } {
    return { lastCountdown: this.lastCountdown, lastTarget: this.lastTarget() };
  }

  private lastTarget(): EnemySlotRef | null {
    return this.lastTargetSlot ? { air: this.lastTargetSlot.air, index: this.lastTargetSlot.index } : null;
  }

  /**
   * Remake-save access, write side: REPLACES the whole fixed-slot content of this system and of `sim.fleet` with the given
   * records (holes and slot numbers kept; the arrays and the system keep their identity, hooks and buffers). The ship extras
   * are installed per record (`null` = the record has none yet; it then gets the usual lazy default). No counter, map word,
   * flag byte, state word, RNG draw, hook call or ShipExtra default is produced here; the caller has validated everything
   * and restores the world buffers itself. The per-slot +$16 pointers (free slots too) are replaced with the saved values.
   * Returns false, with nothing changed, only for a wrong array shape or a pointer that is not an unsigned long.
   */
  installSession(session: {
    readonly ground: readonly (Enemy | null)[];
    readonly air: readonly (Enemy | null)[];
    /** Raw +$16 long of every ground / air slot (60 / 30), free slots included. */
    readonly groundPointers: readonly number[];
    readonly airPointers: readonly number[];
    readonly ships: readonly (FleetRecord | null)[];
    readonly shipExtras: readonly (ShipExtraState | null)[];
    readonly lastCountdown: number;
    readonly lastTarget: EnemySlotRef | null;
  }): boolean {
    const { ground, air, ships, shipExtras, groundPointers, airPointers } = session;
    if (ground.length !== MAX_GROUND || air.length !== MAX_AIR || ships.length !== MAX_SHIPS || shipExtras.length !== MAX_SHIPS) return false;
    if (groundPointers.length !== MAX_GROUND || airPointers.length !== MAX_AIR || !groundPointers.every(isUnsignedLong) || !airPointers.every(isUnsignedLong)) return false;
    for (let i = 0; i < MAX_GROUND; i++) { this.groundSlots[i] = ground[i]; this.groundFlagPointers[i] = groundPointers[i]; }
    for (let i = 0; i < MAX_AIR; i++) { this.airSlots[i] = air[i]; this.airFlagPointers[i] = airPointers[i]; }
    const slots = this.sim.fleet.slots;
    for (let i = 0; i < MAX_SHIPS; i++) {
      const record = ships[i];
      slots[i] = record;
      const extra = shipExtras[i];
      if (record && extra) {
        this.extras.set(record, { vx: extra.vx, vy: extra.vy, next: extra.next, turn: extra.turn, rx: extra.rx, ry: extra.ry, targetSlot: extra.targetSlot ? { air: extra.targetSlot.air, index: extra.targetSlot.index } : null });
      }
    }
    this.lastCountdown = session.lastCountdown;
    this.lastTargetSlot = session.lastTarget ? { air: session.lastTarget.air, index: session.lastTarget.index } : null;
    this.dirty = true;
    return true;
  }

  private get s() {
    return this.sim.state;
  }

  private isGround(e: Enemy): boolean {
    return this.groundSlots.includes(e);
  }

  private isAir(e: Enemy): boolean {
    return this.airSlots.includes(e);
  }

  // ---- creation ---------------------------------------------------------------------------------------

  // $48EC / $48B6: a new enemy from a wave entry. Returns false when its list is full.
  //
  // `spawn.origin === "wave"` is the alien spawner $1187C (static trace): the routine first compares the count word
  // ($142A2 ground against 60, $142A4 air against 30) and only then scans for the first free type byte; it sets the
  // OCCUPANCY BIT IN THE MAP WORD ONLY. The per-cell flag byte (the bit tanks, guns and the enemy scan look at) and the
  // reservation pointer +$16 are written later, when the first movement step claims the next cell ($3BC6-style claim,
  // walkerStep / airMove), so a freshly spawned enemy cannot be shot until it has moved. The allocators $48B6 / $48EC
  // leave +$16..+$19 of the slot untouched (static Disk.1 trace), so the new enemy inherits the slot's raw pointer
  // (`groundFlagPointers` / `airFlagPointers`: zero in a never-used slot per ONE captured scenario, the stale pointer
  // of the previous occupant otherwise) and `reserveX/Y` mirror what that pointer names. $4732 releases the cell the
  // POINTER names, so an enemy that dies before its first claim leaves the spawn cell's map bit set and clears the
  // stale target (if it is a playable cell). Without `origin` (a caller that stages an enemy directly: tests, Disk.4
  // style fixtures) the staging behaviour is kept: map word, flag byte AND the pointer / reservation on the spawn cell.
  spawn(spawn: EnemySpawn): boolean {
    const e = spawn.entry;
    const index = mapIndex(spawn.x, spawn.y);
    const flag = cellFlagIndex(spawn.x, spawn.y);
    const fromWave = spawn.origin === "wave";
    if (fromWave && this.s.word(spawn.air ? 0x142a4 : 0x142a2) >= (spawn.air ? MAX_AIR : MAX_GROUND)) return false; // count word first
    if (spawn.air) {
      const slot = firstFree(this.airSlots); // $48B6: the first free type byte of the 30 slots
      if (slot < 0) return false;
      const a = new Enemy(spawn.type, spawn.x, spawn.y, spawn.dir & 7, e[1], e[3], e[6], true);
      a.lift = AIR_START_LIFT;
      a.tech = spawn.level ?? 0;
      a.aux = s8(e[5]);
      a.p14 = e[6];
      a.p15 = e[7];
      this.cells[index] |= AIR_LAYER;
      if (!fromWave) {
        this.flags[flag] |= FLAG_AIR;
        this.airFlagPointers[slot] = cellFlagPointer(spawn.x, spawn.y);
      }
      const named = reservationOf(this.airFlagPointers[slot]);
      a.reserveX = named.x;
      a.reserveY = named.y;
      this.airSlots[slot] = a;
    } else {
      const slot = firstFree(this.groundSlots); // $48EC: the first free type byte of the 60 slots
      if (slot < 0) return false;
      const g = new Enemy(spawn.type, spawn.x, spawn.y, spawn.dir & 7, e[1], e[3], e[6], false);
      g.tech = spawn.level ?? 0;
      g.aux = e[5];
      g.p14 = e[6];
      g.p15 = e[7];
      if (spawn.type === ENEMY_CRUSHER) { // $496E/$4974 copy +$13 = e[5] and +$14 = e[6]: the same packing as a save
        g.toggle = (e[5] & 0x80) !== 0;
        g.counter = e[5] & 0x7f;
        g.anim = e[6];
      }
      this.cells[index] |= OCCUPIED;
      if (!fromWave) {
        this.flags[flag] |= FLAG_GROUND;
        this.groundFlagPointers[slot] = cellFlagPointer(spawn.x, spawn.y);
      }
      const named = reservationOf(this.groundFlagPointers[slot]);
      g.reserveX = named.x;
      g.reserveY = named.y;
      this.groundSlots[slot] = g;
    }
    this.dirty = true;
    return true;
  }

  // The movement claim of a ground enemy ($3BC6-style, via `StepEnv.entered`): the slot's +$16 now names the claimed cell.
  private claimGround(e: Enemy, x: number, y: number): void {
    const at = this.groundSlots.indexOf(e);
    if (at >= 0) this.groundFlagPointers[at] = cellFlagPointer(x, y);
  }

  // Event 17 ($11566): the first own tank turns into an enemy ground unit (the type stays 9 or 10; it spins in
  // place and shoots). Returns its cell, or null when there is no tank or the list is full. The counters
  // ($142A2, $1429C) are changed by the caller (Aliens.eventTankDefect).
  defect(): { x: number; y: number } | null {
    const u = this.units.units[0];
    if (!u) return null;
    const slot = firstFree(this.groundSlots);
    if (slot < 0) return null;
    // Static Disk.1 trace of $11566 (enemies.md 7 and 3e; no emulator comparison). $115BA-$115BE copy the tank's 16 bytes
    // +0..+F into the free slot; $115C2 then clears +6/+7 (velocity), $115C6 writes +$E = 10 and $115CC copies $145A3 to
    // +$F (damage). So the converted record keeps the tank's type (+0), cell (+1/+2), pixel offset (+3/+4), facing (+5),
    // hit points (+8), control byte (+9: bit 7 = waiting, low bits = mode), tech (+A) and target (+B/+C), with velocity zero.
    // +D is 0 for a tank (units.md 3; the Unit record does not hold it). +$10..+$15 are NOT copied: they keep the slot's
    // previous bytes, which no reader of a defected (type 9/10) unit uses, so the fresh record defaults stand in for them.
    const g = new Enemy(u.type, u.x, u.y, u.dir, u.hp, this.s.byte(0x145a3), 10, false);
    g.dx = u.dx;
    g.dy = u.dy;
    g.tech = u.tech;
    g.targetX = u.targetX;
    g.targetY = u.targetY;
    g.waiting = u.waiting;
    g.mode = u.control & 0x7f;
    // $115D4 clears only the tank's type byte: `vacate` frees the slot without releasing the tank's reservation. The
    // reserved cell keeps its bit 14 and own-unit flag, which matters while the tank is between cells (units.md 5: the
    // reservation is the NEXT cell, the departure cell was already released). No map word is written here.
    this.units.vacate(u);
    // $115F6-$115FE: bclr #2 and bset #0 on the flag byte of the tank's (x, y), then +$16 = that cell's flag pointer.
    const at = cellFlagIndex(u.x, u.y);
    this.flags[at] = (this.flags[at] & ~FLAG_OWN) | FLAG_GROUND;
    this.groundFlagPointers[slot] = cellFlagPointer(u.x, u.y);
    g.reserveX = u.x;
    g.reserveY = u.y;
    this.groundSlots[slot] = g;
    this.dirty = true;
    return { x: u.x, y: u.y };
  }

  // $12510: every own ground unit gains `amount` hit points, capped at the base value 8 of table $4B76
  // (the cap ignores the tech bonus the unit was created with, so a tank of 10 hit points drops to 8: original).
  repair(amount: number): void {
    for (const u of this.units.units) {
      u.hp = (u.hp + amount) & 0xff;
      if (s8(8 - u.hp) < 0) u.hp = 8;
    }
  }

  // ---- bookkeeping (destruction) ------------------------------------------------------------------------

  // Returns whether `$1237C` clobbered A6 (the hook's `true`); see `EnemyHooks.explode`.
  private explode(x: number, y: number, lift: number, high: boolean): boolean {
    return this.hooks.explode?.(x, y, Math.max(0, lift), high) === true;
  }

  // $11C5C: an enemy ground unit is gone (no morale change). The cell the slot's +$16 pointer names (NOT x/y) loses its
  // reservation flag always; its map occupancy bit (`$4000`) is cleared only when the kill had no explosion, or `$1237C`
  // left A6 (the map-word pointer that `$4732` loaded) intact. $4732 clears only +0..+2 and +8/+9: the pointer itself is
  // left in the freed slot (`groundFlagPointers`), so an enemy that dies before its first claim releases a STALE cell
  // (none when the pointer is 0 / not playable) and leaves its own spawn cell's map bit set. Static trace plus one staged
  // live capture (enemies.md section 6), not broad parity.
  destroyGround(e: Enemy, explosion: boolean): void {
    const at = this.groundSlots.indexOf(e);
    if (at < 0) return;
    this.groundSlots[at] = null; // the slot is freed in place: survivors keep their slots
    const target = resolveCellFlagPointer(this.groundFlagPointers[at]);
    const reserved = target.kind === "playable";
    if (reserved) this.flags[cellFlagIndex(target.x, target.y)] &= ~FLAG_GROUND;
    this.s.setWord(0x142a2, Math.max(0, this.s.word(0x142a2) - 1));
    this.s.setLong(KILLS, this.s.long(KILLS) + 1);
    const clobbered = this.sim.takeBlastMark(explosion) && this.explode(e.x, e.y, 0, true);
    if (reserved && !clobbered) this.cells[mapIndex(target.x, target.y)] &= ~OCCUPIED;
    this.dirty = true;
  }

  // $11C30: an enemy aircraft is gone (also when it flies off the map); the colony gains 50 morale. The air-layer bit
  // (`$2000`) follows the same exg a5,a6 shape as `$11C5C` [static, not observed].
  destroyAir(e: Enemy, explosion: boolean): void {
    const at = this.airSlots.indexOf(e);
    if (at < 0) return;
    this.airSlots[at] = null;
    const target = resolveCellFlagPointer(this.airFlagPointers[at]); // the slot's raw +$16, kept after death like the ground list's
    const reserved = target.kind === "playable";
    if (reserved) this.flags[cellFlagIndex(target.x, target.y)] &= ~FLAG_AIR;
    this.s.setWord(0x142a4, Math.max(0, this.s.word(0x142a4) - 1));
    this.s.setLong(KILLS, this.s.long(KILLS) + 1);
    this.sim.applyMorale(50);
    const clobbered = this.sim.takeBlastMark(explosion) && this.explode(e.x, e.y, e.lift, true);
    if (reserved && !clobbered) this.cells[mapIndex(target.x, target.y)] &= ~AIR_LAYER;
    this.dirty = true;
  }

  private destroyEnemy(e: Enemy, explosion: boolean): void {
    if (e.air) this.destroyAir(e, explosion);
    else this.destroyGround(e, explosion);
  }

  // $4692: an own tank is destroyed: counts, the lost-units statistic and -50 morale.
  destroyTank(u: Unit, explosion = true): void {
    if (!this.units.units.includes(u)) return;
    this.units.remove(u);
    const s = this.s;
    s.setWord(0x1429c, Math.max(0, s.word(0x1429c) - 1));
    const addr = u.type === 9 ? 0x14254 : 0x14258;
    s.setLong(addr, Math.max(0, s.long(addr) - 1));
    s.setLong(LOST, s.long(LOST) + 1);
    this.sim.applyMorale(-50);
    if (this.sim.takeBlastMark(explosion)) this.explode(u.x, u.y, 0, true);
    this.dirty = true;
  }

  // $3C40: an own tank walked off the map: it joins the front fleet ($14274), -50 morale. The original's `$4692` for this
  // walk-off ends in `$4732` without a `bset`, so a stale mark (ship-control.md 5e) blasts at the tank's last cell here.
  tankLeft(u: Unit): void {
    this.sim.aliens.sendToFront(u.type);
    if (this.sim.takeBlastMark(false)) this.explode(u.x, u.y, 0, true);
    this.dirty = true;
  }

  // $46CC for the ships: counts, -100 morale (not for missiles), the reservation of the ship is released. `explosion` =
  // the destroyer set bit 5 of $156A9: $4732 blasts at the ship first (lift as height), and an A6-clobbering blast keeps
  // the map bit (enemies.md 6, ship-control.md 5e). A stale mark blasts here too (`Sim.takeBlastMark`). The Fleet call
  // releases nothing more: rx/ry are cleared here.
  destroyShip(ship: FleetRecord, explosion = true): void {
    const ex = this.extra(ship);
    const lift = ship.lift;
    const x = ship.x;
    const y = ship.y;
    const blasted = this.sim.takeBlastMark(explosion) && this.explode(x, y, lift, true);
    this.releaseShip(ship, ex, blasted);
    this.sim.fleet.destroyShip(ship, 0, false);
    this.dirty = true;
  }

  // $4732 + $46CC: releases the reservation cell named by +$14 (ex.rx/ry, never x/y). The branch is `tst.b` of the record's
  // lift for every record, missiles included: lift != 0 frees the air mark and the ship flag, lift 0 the ground mark and the
  // own flag (a launched missile climbs from lift 0, so the two marks it set at launch are not the ones it frees then; the
  // trace is followed, not tidied). The map bit goes only when the destruction's blast did not clobber A6 (`blasted`).
  private releaseShip(ship: FleetRecord, ex: ShipExtra, blasted = false): void {
    if (inMap(ex.rx, ex.ry)) {
      const i = mapIndex(ex.rx, ex.ry);
      if (ship.lift !== 0) {
        if (!blasted) this.cells[i] &= ~AIR_LAYER;
        this.flags[cellFlagIndex(ex.rx, ex.ry)] &= ~FLAG_SHIP;
      } else {
        if (!blasted) this.cells[i] &= ~OCCUPIED;
        this.flags[cellFlagIndex(ex.rx, ex.ry)] &= ~FLAG_OWN;
      }
    }
    ex.rx = ex.ry = -1;
  }

  // ---- own units: fire ($12588) ------------------------------------------------------------------------------

  // Own tank hook (UnitHooks.combat): on the move tick the tank shoots the first enemy around it.
  tankCombat(unit: Unit, moveTick: boolean): void {
    if (!moveTick) return;
    this.fire(unit.x, unit.y, this.s.byte(0x145a3), () => (unit.waiting = true));
  }

  // The 48 cells around (x, y) in spiral order; the first one holding an enemy (flag bit 0 ground, bit 1 air) is
  // hit for `damage`. The scan ends at the map edge or when the flagged cell has no enemy within one cell.
  private fire(x: number, y: number, damage: number, shooterWaits: () => void): void {
    for (const [dx, dy] of this.tables.spiral) {
      const cx = x + dx;
      const cy = y + dy;
      if (!inMap(cx, cy)) return;
      const f = this.flags[cellFlagIndex(cx, cy)] & 3;
      if (f === 0) continue;
      const list = f & FLAG_GROUND ? this.groundSlots : this.airSlots;
      const target = list.find((e) => e !== null && Math.abs(e.x - cx) <= 1 && Math.abs(e.y - cy) <= 1);
      if (!target) return;
      this.hooks.sound?.(SFX.HIT);
      shooterWaits();
      target.hp = s8(target.hp - damage);
      if (target.hp <= 0) this.destroyEnemy(target, true);
      return;
    }
  }

  // ---- enemy attack ($1266A) ----------------------------------------------------------------------------------

  // On the enemy tick an enemy looks at the 48 cells around it: an active building (one time in ten, then with
  // chance +E percent) is bombed; otherwise the first own tank or ship found is hit for +F.
  private attack(e: Enemy): void {
    if (!this.clock?.enemyTick) return;
    // $1266A reads the CIA TOD low byte ($BFE801) once per call and tests it for 0..24. A hardware approximation
    // (Sim.todLow, sim-hardware.ts): it never consumes the Sim RNG, so the later bomb-chance rolls are unaffected.
    const gate = this.sim.todLow() <= 24;
    for (const [dx, dy] of this.tables.spiral) {
      const cx = e.x + dx;
      const cy = e.y + dy;
      if (!inMap(cx, cy)) return;
      const index = mapIndex(cx, cy);
      if (this.cells[index] & ACTIVE && gate) {
        if (this.sim.roll(100) >= e.bombPct) return;
        e.waiting = true;
        // `$12790` stores the selected cell in the shared bomb-coordinate words before `$12332`.
        this.sim.state.setWord(0x142ba, cx);
        this.sim.state.setWord(0x142bc, cy);
        this.sim.bomb(cx, cy);
        return;
      }
      const f = this.flags[cellFlagIndex(cx, cy)] & (FLAG_OWN | FLAG_SHIP);
      if (f === 0) continue;
      if (f & FLAG_OWN) {
        const tank = this.units.units.find((u) => Math.abs(u.x - cx) <= 1 && Math.abs(u.y - cy) <= 1);
        if (tank) {
          this.hooks.sound?.(SFX.HIT);
          e.waiting = true;
          tank.hp = s8(tank.hp - e.dmg);
          if (tank.hp <= 0) this.destroyTank(tank);
          return;
        }
      }
      const ship = this.sim.fleet.ships.find((p) => Math.abs(p.x - cx) <= 1 && Math.abs(p.y - cy) <= 1);
      if (!ship) return;
      this.hooks.sound?.(SFX.HIT);
      e.waiting = true;
      ship.hp = s8(ship.hp - e.dmg);
      if (ship.hp <= 0) this.destroyShip(ship);
      return;
    }
  }

  // ---- the main-loop pass -------------------------------------------------------------------------------------

  // One pass of $333A after the own tanks: ships, enemy ground units, enemy aircraft.
  pass(clock: PassClock): void {
    this.clock = clock;
    for (const ship of this.sim.fleet.ships) {
      this.shipStep(ship);
      if (isMissile(ship) || !this.sim.fleet.slots.includes(ship)) continue;
      const damage = this.s.byte(0x145a4 + ship.cls);
      if (damage !== 0 && clock.moveTick) this.fire(ship.x, ship.y, damage, () => {});
    }
    for (const g of this.ground) { // a snapshot in slot order; units destroyed during the pass are skipped below
      if (!this.isGround(g)) continue;
      if (g.waiting && !clock.enemyTick) continue;
      g.waiting = false;
      this.groundStep(g);
    }
    for (const a of this.air) {
      if (this.isAir(a)) this.airStep(a);
    }
    this.dirty = true;
  }

  // ---- enemy ground units ($1193E) ----------------------------------------------------------------------------

  // $119AC / $11A5C: a random building becomes the target (mode 1). Returns the picked record's tile word, or null.
  private pickTarget(e: Enemy): number | null {
    const t = this.sim.randomBuilding();
    e.targetX = t ? t[0] : NO_TARGET;
    e.targetY = t ? t[1] : NO_TARGET;
    e.mode = 1;
    return t ? t[2] : null;
  }

  private groundStep(g: Enemy): void {
    if (g.type === ENEMY_WALKER_A || g.type === ENEMY_WALKER_B) {
      if (g.mode === 6) this.pickTarget(g);
      else if (g.mode !== 5) {
        walkerStep(g, this.walkEnv);
        if (g.targetX & 0x80) g.mode = 6; // the order is finished
      }
      if (this.isGround(g)) this.attack(g);
    } else if (g.type === ENEMY_CRUSHER) {
      this.crusher(g);
    } else {
      g.dir = (g.dir + 7) & 7; // a defected tank spins and shoots
      this.attack(g);
    }
  }

  // $11F12: the crusher walks to a building, destroying active buildings on its way, for at most 80 steps.
  private crusher(g: Enemy): void {
    if (g.mode === 6) {
      g.steps = 0;
      this.pickTarget(g);
    } else if (g.mode === 1) {
      this.crusherStep(g);
      g.steps = (g.steps + 1) & 0xff; // addq.b #1,$D(a6); cmpi.b #$50 (a saved count above $50 wraps first)
      if (g.steps === 0x50 || g.targetX & 0x80) g.mode = 6;
    }
  }

  // $11F42: a step on every second call, with its own animation counter.
  private crusherStep(g: Enemy): void {
    if (g.targetX & 0x80) return;
    const was = g.toggle;
    g.toggle = !was;
    if (!was) return;
    g.counter = g.counter - 1 < 0 ? 7 : g.counter - 1;
    g.anim = this.tables.crusherAnim[g.counter] ?? 0; // supported states keep the counter in 0..7 (see fromRoster)
    walkerStep(g, this.crushEnv);
  }

  // $11ECA: standing on an acid tile hurts; returns true when the unit died.
  private acid(g: Enemy): boolean {
    if ((this.cells[g.y * MAP_WIDTH + g.x] & TILE_ID_MASK) !== TILE_ACID) return false;
    g.hp = s8(g.hp - (this.s.byte(0x13116) + 2 * this.s.byte(0x14592)));
    if (g.hp > 0) return false;
    this.destroyGround(g, true);
    return true;
  }

  // ---- enemy aircraft ($11A9E) --------------------------------------------------------------------------------

  private airStep(a: Enemy): void {
    if (a.type === ENEMY_KAMIKAZE || a.type === ENEMY_KAMIKAZE_FAST) {
      this.kamikaze(a);
      if (a.type === ENEMY_KAMIKAZE && this.isAir(a)) this.attackFromAir(a);
    } else {
      this.bomber(a);
      if (this.isAir(a)) this.attackFromAir(a);
    }
  }

  // $11AC2 / $11ADE: after `$1266A` the aircraft step runs `bclr.b #7,$9(a6)` whether or not the attack fired. `attack()`
  // sets bit 7 on the attacker (the ground wait gate), so an aircraft must not keep that mirror. Aircraft have no wait gate
  // (enemies.md section 2 and 3d); the bit is state only.
  private attackFromAir(a: Enemy): void {
    this.attack(a);
    a.waiting = false;
  }

  // $11AE6: the aircraft step: -1 between two cells (or gone), 0 on the target cell, 1 a new step was started.
  private airMove(a: Enemy): number {
    let dx = a.dx + a.vx;
    let dy = a.dy + a.vy;
    if (a.type === ENEMY_KAMIKAZE_FAST) {
      dx += a.vx;
      dy += a.vy;
    }
    const [sx, sy] = STEP_PIXELS[a.dir];
    if (dx === sx && dy === sy) {
      dx = dy = 0;
      a.x += DIR_STEP[a.dir][0];
      a.y += DIR_STEP[a.dir][1];
    }
    a.dx = dx;
    a.dy = dy;
    if (dx !== 0 || dy !== 0) return -1;
    if (!inMap(a.x, a.y)) {
      // $11C24: off the map the aircraft is gone (and counts as a kill)
      this.destroyAir(a, false);
      return -1;
    }
    if (a.mode !== 3) {
      const want = dirToward(a.x, a.y, a.targetX, a.targetY);
      if (want < 0) return 0;
      if (a.dir !== want) a.dir = this.tables.turn[a.dir * 8 + want];
    }
    [a.vx, a.vy] = VELOCITY[a.dir];
    // The air layer mark moves to the next cell when the step starts.
    const here = mapIndex(a.x, a.y);
    this.cells[here] &= ~AIR_LAYER;
    this.flags[cellFlagIndex(a.x, a.y)] &= ~FLAG_AIR;
    const nx = a.x + DIR_STEP[a.dir][0];
    const ny = a.y + DIR_STEP[a.dir][1];
    const at = this.airSlots.indexOf(a);
    if (at >= 0) this.airFlagPointers[at] = cellFlagPointer(nx, ny); // raw pointer, also for a cell off the map (names no playable cell)
    if (inMap(nx, ny)) {
      this.cells[mapIndex(nx, ny)] |= AIR_LAYER;
      this.flags[cellFlagIndex(nx, ny)] |= FLAG_AIR;
      a.reserveX = nx;
      a.reserveY = ny;
    } else {
      a.reserveX = a.reserveY = -1;
    }
    return 1;
  }

  // $119C0: kamikaze: pick a building, fly there, dive onto it and blow up.
  private kamikaze(a: Enemy): void {
    if (a.mode === 6) {
      const tile = this.pickTarget(a);
      if (tile !== null) {
        // $119C6..$119DC: byte +3 of the descriptor (rows - 1), then minus 8 and minus 2 as bytes: +$13 = stored - 10.
        const stored = this.hooks.buildingHeight?.(tile) ?? 20;
        a.aux = s8((stored & 0xff) - 10); // +$13: the altitude at which it hits
      }
    } else if (a.mode === 1) {
      if (this.airMove(a) !== 0) return;
      if (inMap(a.targetX, a.targetY) && this.cells[a.targetY * MAP_WIDTH + a.targetX] & ACTIVE) {
        a.mode = 2;
        a.dir = 3;
        a.vx = a.vy = 0;
      } else {
        a.mode = 6;
      }
    } else if (a.mode === 2) {
      a.lift -= 2;
      if (a.type === ENEMY_KAMIKAZE_FAST) a.lift -= 2;
      if (a.aux < a.lift) return;
      const x = a.x;
      const y = a.y;
      this.destroyAir(a, false);
      this.sim.bomb(x, y);
    } else {
      this.airMove(a);
    }
  }

  // $11C7A: bomber: fly from building to building, drop bombs on active cells.
  private bomber(a: Enemy): void {
    if (a.aux < 0) return this.kamikaze(a);
    if (a.mode === 6) {
      a.steps = 0;
      this.pickTarget(a);
    } else if (a.mode === 1) {
      const r = this.airMove(a);
      if (r < 0) return;
      if (r === 1) {
        if (++a.steps === 0x14) {
          a.mode = 6;
          return;
        }
        if (this.sim.roll(100) >= 10) return;
      }
      this.bombRun(a);
    } else {
      this.airMove(a);
    }
  }

  // $11CC2: over an active building a bomber drops a bomb with chance +$14 percent.
  private bombRun(a: Enemy): void {
    if (!(this.cells[a.y * MAP_WIDTH + a.x] & ACTIVE)) return;
    a.aux = s8(a.aux - 1);
    if (a.aux < 0) {
      a.mode = 6;
      if (a.p15 === 0) {
        a.aux = 0;
        a.mode = 3; // out of bombs: flies on straight and leaves the map
      }
      return;
    }
    a.mode = 6;
    if (this.sim.roll(100) >= a.p14) return;
    this.sim.bomb(a.x, a.y);
  }

  // ---- ships ($42BE, $4526) ------------------------------------------------------------------------------------

  private extra(ship: FleetRecord): ShipExtra {
    let ex = this.extras.get(ship);
    if (!ex) {
      // A restored record gets its ShipExtra from the saved bytes at adoption, a launched missile from launchMissile;
      // inventing defaults for either is a bug (a missile without a target slot cannot run).
      if ("sourceRaw" in ship || isMissile(ship)) throw new Error("restored or missile record without its own ShipExtra");
      const landed = ship.lift === 0 && ship.mode === 0;
      ex = { vx: 0, vy: 0, next: 0, turn: 2, rx: landed ? ship.x : -1, ry: landed ? ship.y : -1, targetSlot: null };
      this.extras.set(ship, ex);
    }
    return ex;
  }

  /**
   * Read-only copy of a ship's or missile's extra state (velocity +6/+7, +$11 next, +$12 turn, the reservation cell
   * named by +$14 and the followed enemy slot of a missile) for observers such as runtime checkpoints. Unlike the
   * internal accessor it never creates an extra: a ship that has not been stepped or ordered yet has none and gives
   * null. Writes nothing, draws no RNG and calls no hook.
   */
  inspectShip(ship: FleetRecord): ShipInspection | null {
    const ex = this.extras.get(ship);
    if (!ex) return null;
    const target: EnemySlotRef | null = ex.targetSlot ? { air: ex.targetSlot.air, index: ex.targetSlot.index } : null;
    const occupied = target ? this.occupant(target) !== null : null;
    return { vx: ex.vx, vy: ex.vy, next: ex.next, turn: ex.turn, rx: ex.rx, ry: ex.ry, targetSlot: target, targetOccupied: occupied };
  }

  // ---- orders ($3F9E dispatch, $41A8, $4204, $4260/$427C, takeoff $4152) ----
  //
  // +$11 (`next`) is the mode the ship takes when its current movement ends; +$B/+$C is the target cell.

  // $4152: a landed ship lifts off: its marks move from the ground layer to the air layer, it faces direction 2, loses 8
  // fuel (not when the word is negative = unlimited; never below 0) and climbs in mode 7 turning towards +$12.
  private takeoff(ship: Ship, ex: ShipExtra): void {
    const want = dirToward(ship.x, ship.y, ship.targetX, ship.targetY);
    ex.turn = ex.next === 1 ? 2 : want < 0 ? 6 : want; // $44DE gives 6 when the ship is on the target
    const i = ship.y * MAP_WIDTH + ship.x;
    this.cells[i] = (this.cells[i] & ~OCCUPIED) | AIR_LAYER;
    this.flags[cellFlagIndex(ship.x, ship.y)] = (this.flags[cellFlagIndex(ship.x, ship.y)] & ~FLAG_OWN) | FLAG_SHIP;
    ex.rx = ship.x;
    ex.ry = ship.y;
    ship.dir = 2;
    if (ship.fuel < 0x8000) ship.fuel = Math.max(0, ship.fuel - 8);
    ship.mode = 7;
    this.dirty = true;
  }

  // $41A8 with order 1 (hover) or 4 (build a launchpad): +$11 = order. Landed: take off; flying to a cell (2, 3, 5):
  // stop (mode 6) and then continue in +$11; coming down: climb again (mode 7).
  private holdOrder(ship: Ship, order: number): void {
    const ex = this.extra(ship);
    ex.next = order;
    if (ship.mode === 0) this.takeoff(ship, ex);
    else if (ship.mode === 2 || ship.mode === 3 || ship.mode === 5) ship.mode = 6;
    else if (ship.mode === 8) ship.mode = 7;
  }

  // $4204 (order 0): land where the ship is. Hovering or climbing: descend at once (hover again on a blocked cell);
  // flying: stop and descend (mode 5). Other modes (4, 5, 8) ignore it, but +$11 is set.
  private landOrder(ship: Ship): void {
    const ex = this.extra(ship);
    ex.turn = 2;
    ex.next = 0;
    if (ship.mode === 1 || ship.mode === 7) {
      ship.mode = 8;
      if (this.cells[ship.y * MAP_WIDTH + ship.x] & LAND_CELL_BLOCK) ship.mode = 1;
      ship.dx = ship.dy = 0;
      ex.vx = ex.vy = 0;
    } else if (ship.mode === 2 || ship.mode === 3 || ship.mode === 6) {
      ship.mode = 5;
    }
  }

  // $427C (order 2 = go and land, 3 = go and hover; the target is already in +$B/+$C).
  private goOrder(ship: Ship, order: number): void {
    const ex = this.extra(ship);
    ex.next = order;
    if (ship.mode === 0) this.takeoff(ship, ex);
    else if (ship.mode === 8) ship.mode = 7;
    else if (ship.mode < 5 && ship.mode !== order) ship.mode = order;
  }

  // +$11 = 4: the ship is on its way to build a launchpad or is building it; the ship window refuses it ($DA9E).
  padPending(ship: Ship): boolean {
    return this.extra(ship).next === SHIP_ORDER.buildPad;
  }

  // The dispatch of $3F9E after the ship window: `order` is one of SHIP_ORDER, `target` the cell of the chosen pin
  // (orders 2 and 3). Returns the string index of a refusal message ($ED, no fuel), 0 when the order was given.
  commandShip(ship: Ship, order: number, target: { x: number; y: number } | null): number {
    if (isMissile(ship as FleetRecord)) return 0; // a missile has no window, class or fuel
    if (ship.fuel === 0) return MSG_NO_FUEL;
    if (order === SHIP_ORDER.hover || order === SHIP_ORDER.buildPad) this.holdOrder(ship, order);
    else if (order === SHIP_ORDER.land) this.landOrder(ship);
    else if (order === SHIP_ORDER.front) this.sendShipToFront(ship);
    else if (order === SHIP_ORDER.goLand || order === SHIP_ORDER.goHover) {
      // $4260: without a pin the original reads a stale table row; the port leaves the ship alone.
      if (!target) return 0;
      ship.targetX = target.x;
      ship.targetY = target.y;
      this.goOrder(ship, order);
    }
    this.dirty = true;
    return 0;
  }

  // Order a ship to fly to a cell (`land`: come down there, otherwise hover).
  orderShip(ship: Ship, tx: number, ty: number, land: boolean): void {
    ship.targetX = tx;
    ship.targetY = ty;
    this.goOrder(ship, land ? SHIP_ORDER.goLand : SHIP_ORDER.goHover);
    this.dirty = true;
  }

  // A ship goes to the front ($135C4/$135C5, off the map): it leaves and joins the front fleet ($1427C).
  sendShipToFront(ship: Ship): void {
    ship.targetX = this.s.byte(FRONT_X);
    ship.targetY = this.s.byte(FRONT_Y);
    this.goOrder(ship, SHIP_ORDER.goLand); // $3FD2: order 2 to the front cell
    this.dirty = true;
  }

  // $4526: like the aircraft step; also -1 between cells, 0 when holding (modes 5, 6) or on the target cell.
  private shipMove(ship: FleetRecord, ex: ShipExtra): number {
    let dx = ship.dx + ex.vx;
    let dy = ship.dy + ex.vy;
    if (isMissile(ship)) {
      dx += ex.vx;
      dy += ex.vy;
    }
    const facing = ship.dir & 7;
    const [sx, sy] = STEP_PIXELS[facing];
    if (dx === sx && dy === sy) {
      dx = dy = 0;
      ship.x += DIR_STEP[facing][0];
      ship.y += DIR_STEP[facing][1];
    }
    ship.dx = dx;
    ship.dy = dy;
    if (dx !== 0 || dy !== 0) return -1;
    if (ship.mode === 5 || ship.mode === 6) return 0;
    if (!inMap(ship.x, ship.y)) {
      // $4672: off the map the ship joins the front fleet of its class ($1427C); no lost-unit statistic. The index is
      // the byte at +$D; for a missile (launched or restored alike) that is the top byte of its 24-bit enemy-slot
      // address (3 for every enemy slot), so the original counts it in the front fleet of "class 3" - reproduced, not
      // invented (a launched missile has no class: the old fictitious class 6 pointed at $14294 itself).
      const front = 0x1427c + 4 * (isMissile(ship) ? s8(enemySlotAddress(this.missileSlot(ex)) >>> 16) : ship.cls);
      this.s.setLong(front, this.s.long(front) + 1);
      ship.x = Math.max(0, Math.min(MAP_WIDTH - 1, ship.x));
      ship.y = Math.max(0, Math.min(MAP_HEIGHT - 1, ship.y));
      // the reservation is released by the Fleet removal, after its blast (a stale mark, `Sim.takeBlastMark`), as `$46CC` does
      this.sim.fleet.destroyShip(ship, 0, false);
      this.s.setLong(LOST, this.s.long(LOST) - 1);
      this.dirty = true;
      return -1;
    }
    const want = dirToward(ship.x, ship.y, ship.targetX, ship.targetY);
    if (want < 0) return 0;
    if (ship.dir > 7 || ship.dir !== want) ship.dir = this.tables.turn[(ship.dir & 7) * 8 + want];
    [ex.vx, ex.vy] = VELOCITY[ship.dir];
    // the air layer mark follows the ship when the step starts: $4646/$464A clear it on the ship's OWN cell (x, y via
    // $497E) and $4660 then stores the flag pointer of the next cell in +$14. At a cell centre that is the cell +$14
    // names, so this equals the reservation cell for every ship the port moves itself.
    this.cells[mapIndex(ship.x, ship.y)] &= ~AIR_LAYER;
    this.flags[cellFlagIndex(ship.x, ship.y)] &= ~FLAG_SHIP;
    const nx = ship.x + DIR_STEP[ship.dir][0];
    const ny = ship.y + DIR_STEP[ship.dir][1];
    if (inMap(nx, ny)) {
      this.cells[mapIndex(nx, ny)] |= AIR_LAYER;
      this.flags[cellFlagIndex(nx, ny)] |= FLAG_SHIP;
      ex.rx = nx;
      ex.ry = ny;
    } else {
      ex.rx = ex.ry = -1;
    }
    return -1;
  }

  // Rotate towards +$12 every 8 lift units ($4386).
  private rotateShip(ship: Ship, ex: ShipExtra): void {
    if ((ship.lift & 7) !== 0 || ship.dir > 7 || ship.dir === ex.turn) return;
    ship.dir = this.tables.turn[ship.dir * 8 + ex.turn];
  }

  // $42D8: start the descent; on a blocked or occupied cell the ship hovers instead.
  private startLanding(ship: Ship, ex: ShipExtra): void {
    ship.mode = 8;
    ex.turn = 2;
    if (this.cells[ship.y * MAP_WIDTH + ship.x] & LAND_CELL_BLOCK) ship.mode = 1;
    ship.dx = ship.dy = 0;
    ex.vx = ex.vy = 0;
  }

  // $4346: the climb or the stop is over: continue in the stored next mode.
  // Mode 4 starts the launchpad ($771E); a refusal makes the ship land again.
  private nextMode(ship: Ship, ex: ShipExtra): void {
    ship.mode = ex.next;
    if (ship.mode === 4 && !(this.hooks.buildPad?.(ship.x, ship.y) ?? false)) this.startLanding(ship, ex);
  }

  // $43BC-$4406: finish descent. The original restores the current map/flag pointers from $1424C, which $41DA
  // captured from the ship's x/y when descent was accepted. A restored Disk.4 has no serialized copy of those
  // transient pointers; mode 8 does not move x/y, so derive that same cell from the saved coordinates here.
  // This also intentionally does not release the previously saved +$14 reservation: the original completion
  // writes the landing cell pointer to +$14 and clears/sets only the current cell's map/flag bits.
  private land(ship: Ship, ex: ShipExtra): void {
    ship.lift = 0;
    ship.dir = 8;
    ship.mode = 0;
    ex.next = 0;
    ex.vx = ex.vy = 0;
    ship.dx = ship.dy = 0;
    const i = ship.y * MAP_WIDTH + ship.x;
    this.cells[i] = (this.cells[i] & ~AIR_LAYER) | OCCUPIED;
    this.flags[cellFlagIndex(ship.x, ship.y)] = (this.flags[cellFlagIndex(ship.x, ship.y)] & ~FLAG_SHIP) | FLAG_OWN;
    ex.rx = ship.x;
    ex.ry = ship.y;
    if (ship.fuel < 0x8000) ship.fuel = Math.max(0, ship.fuel - 4);
  }

  private shipStep(ship: FleetRecord): void {
    const ex = this.extra(ship);
    if (isMissile(ship)) return this.missileStep(ship, ex);
    switch (ship.mode) {
      case 2:
      case 5:
        if (this.shipMove(ship, ex) >= 0) this.startLanding(ship, ex);
        break;
      case 3:
        if (this.shipMove(ship, ex) === 0) ship.mode = 1; // arrived: hover
        break;
      case 4:
        if ((this.cells[ship.y * MAP_WIDTH + ship.x] & TILE_ID_MASK) === TILE_PAD) this.startLanding(ship, ex);
        break;
      case 6:
        if (this.shipMove(ship, ex) >= 0) this.nextMode(ship, ex);
        break;
      case 7:
        ship.lift += 2;
        if (ship.lift >= AIR_START_LIFT) this.nextMode(ship, ex);
        else this.rotateShip(ship, ex);
        break;
      case 8:
        ship.lift -= 2;
        if (ship.lift > 0) this.rotateShip(ship, ex);
        else this.land(ship, ex);
        break;
      default:
        break; // 0 landed, 1 hovering
    }
  }

  // ---- missiles (ship list type 17) -------------------------------------------------------------------------------

  // $12456: the enemy a launcher at (x, y) can aim at within `range` cells. Kamikaze aircraft and crushers come
  // first, otherwise the last enemy found; the result is remembered for the launch as a fixed slot ($E904 is a pointer
  // into the enemy lists, not an object: a launch resolves whatever stands in that slot at that moment).
  findTarget(range: number, x: number, y: number): EnemyTarget | null {
    let found: { enemy: Enemy; slot: EnemySlotRef } | null = null;
    for (const air of [false, true]) {
      const list = air ? this.airSlots : this.groundSlots;
      for (let index = 0; index < list.length; index++) {
        const e = list[index];
        if (e === null) continue;
        if (Math.abs(e.x - x) > range || Math.abs(e.y - y) > range) continue;
        if (e.type === ENEMY_CRUSHER || e.type === ENEMY_KAMIKAZE || e.type === ENEMY_KAMIKAZE_FAST) {
          this.lastTargetSlot = { air, index };
          return { x: e.x, y: e.y, enemy: e };
        }
        found = { enemy: e, slot: { air, index } };
      }
    }
    this.lastTargetSlot = found ? found.slot : null;
    return found ? { x: found.enemy.x, y: found.enemy.y, enemy: found.enemy } : null;
  }

  // The fixed slot an installed enemy stands in (null when it is not installed any more).
  private slotOf(e: Enemy): EnemySlotRef | null {
    const air = this.airSlots.indexOf(e);
    if (air >= 0) return { air: true, index: air };
    const ground = this.groundSlots.indexOf(e);
    return ground >= 0 ? { air: false, index: ground } : null;
  }

  // The enemy that currently occupies a fixed slot (null = free, type byte 0).
  private occupant(slot: EnemySlotRef): Enemy | null {
    return (slot.air ? this.airSlots : this.groundSlots)[slot.index] ?? null;
  }

  // $E158..$49E8: a missile from a launcher cell at the enemy of the launch slot. The pointer stored in +$C..+$F is the slot
  // identity: an explicit `target.enemy` is resolved to the slot it stands in NOW (a dead one cannot be launched at), without
  // one the slot `findTarget` remembered ($E904) is used. A free slot refuses the launch: the original would read the stale
  // bytes of the freed record, which are not modelled. +B/+C start as the occupant's +1/+2 ($ACE2 refreshes them daily).
  // False when the ship list is full, so the caller says $12B (no $C8 here: $49E8 has its own check).
  launchMissile(from: { x: number; y: number }, target?: { x: number; y: number }): boolean {
    const given = (target as EnemyTarget | undefined)?.enemy;
    const slot = given !== undefined ? this.slotOf(given) : this.lastTargetSlot;
    const enemy = slot ? this.occupant(slot) : null;
    if (!slot || !enemy) return false;
    const missile = this.sim.fleet.createMissile(from.x, from.y);
    if (!missile) return false;
    missile.targetX = enemy.x;
    missile.targetY = enemy.y;
    this.cells[mapIndex(from.x, from.y)] |= AIR_LAYER; // a missile flies: air mark on the launcher cell ($497E reservation)
    this.flags[cellFlagIndex(from.x, from.y)] |= FLAG_SHIP;
    this.extras.set(missile, { vx: 0, vy: 0, next: 0, turn: 2, rx: from.x, ry: from.y, targetSlot: slot });
    this.dirty = true;
    this.hooks.sound?.(SFX.LAUNCH); // $E1A2
    return true;
  }

  private missileSlot(ex: ShipExtra): EnemySlotRef {
    if (!ex.targetSlot) throw new Error("missile without a target slot");
    return ex.targetSlot;
  }

  // The hit ($4408 at 44A8-44B2, air target from mode 1 and ground target from mode 2 with lift <= 0): `$46CC` removes the
  // missile BEFORE `bset.b #5,$156A9`, so the missile's own removal is silent and releases its map marks (no A6 clobber),
  // unless a mark left by an earlier free-slot hit is still set (then that blast is at the missile). Only the occupant's
  // `$11C30` / `$11C5C` (a `$4732` with bit 5 set) explodes. Static trace, ship-control.md 5e.
  private missileHit(ship: FleetRecord, target: Enemy): void {
    this.destroyShip(ship, false);
    this.destroyEnemy(target, true);
  }

  // $4408 at 44A8 with a FREE slot (the occupant was killed while the missile waited, so `tst.b (a6)` is zero): `$46CC`
  // removes the missile (its own `$4732` consumes any earlier mark), then `bset.b #5,$156A9` runs and the routine returns
  // without a kill. Bit 5 therefore STAYS SET and the next `$4732` anywhere (a `$46CC`, `$4692`, `$11C30`, `$11C5C`) blasts
  // once at that victim. Static trace, Disk.1 `$4408` 44A8-44DC (ship-control.md 5e).
  private missileFreeHit(ship: FleetRecord): void {
    this.destroyShip(ship, false);
    this.sim.blastMark = true;
  }

  // $4408 for every missile, launched and restored alike, with the pointer semantics of the original: +$C..+$F names a
  // fixed enemy slot and the CURRENT occupant is read from it each time (a reused slot is followed, a dead Enemy is not kept).
  //  - mode 4: climb 4 per call to $22, then mode 1 and the direction of $44DE (6 when already on +B/+C).
  //  - mode 1: $4526 moves it; +B/+C are NOT refreshed here (only the daily $ACE2 does that). At a cell centre / on arrival
  //    the occupant is tested: within one cell on both axes a ground target (list slot < $19) freezes (mode 5, +B = $FF) and
  //    the missile switches to mode 2 (dir 3, no velocity), an air target is hit at once. The main pass has NO "target is
  //    gone" check: a free slot is only noticed by $ACE2.
  //  - mode 2 (the else branch): lift -4; when it is <= 0 the missile and the occupant (if any) are destroyed.
  // A FREE slot is compared with cell (0,0): `$4732` zeroes the freed record's x and y (enemies.md 3d), so the arrival test
  // on cells (0,0)..(1,1) freezes the missile (mode 2, dir 3, no velocity) like a ground hit, and then `missileFreeHit`
  // removes it with bit 5 left set. Elsewhere a free-slot missile flies on (mode 1) until the next daily pass destroys it.
  // The original's stray writes into the freed record (+$B = $FF, +$9 = 5) and its other stale bytes are not kept: no routine
  // reads them before the next spawn rewrites +$9/+$B/+$C (enemies.md 3e, test/freed-records.mjs section 4).
  private missileStep(m: MissileRecord, ex: ShipExtra): void {
    const slot = this.missileSlot(ex);
    if (m.mode === 4) {
      m.lift += 4;
      if (m.lift > AIR_START_LIFT) {
        m.lift = AIR_START_LIFT;
        m.mode = 1;
        const want = dirToward(m.x, m.y, m.targetX, m.targetY);
        m.dir = want < 0 ? 6 : want; // $44DE
      }
    } else if (m.mode === 1) {
      if (this.shipMove(m, ex) < 0) return;
      // $4408 44xx compares the POINTED record even when its slot is free. `$4732` clears a freed record's +0 (type) and
      // +1/+2 (x, y), so a free slot is compared with cell (0,0); its type 0 takes the ground branch. Its own +B/+9 writes
      // land in a record that the next spawn re-initialises, so they are not kept (enemies.md 3e, ship-control.md 5e).
      const target = this.occupant(slot);
      const tx = target ? target.x : 0;
      const ty = target ? target.y : 0;
      if (Math.abs(m.x - tx) > 1 || Math.abs(m.y - ty) > 1) return;
      if (!target || !target.air) {
        m.mode = 2;
        m.dir = 3;
        ex.vx = ex.vy = 0;
        if (target) {
          target.targetX = NO_TARGET;
          target.mode = 5;
        }
      } else {
        this.missileHit(m, target);
      }
    } else {
      m.lift -= 4;
      if (m.lift > 0) return;
      const target = this.occupant(slot);
      if (target) this.missileHit(m, target);
      else this.missileFreeHit(m);
    }
  }

  // $ACE2 for a missile (called from Fleet.dailyFuel in slot order): `tst.b (a0)` of the slot it points at.
  // Type byte zero (free slot) -> $46CC with d0 = 0 after setting bit 5 of $156A9, which $4732 turns into one explosion
  // at the missile (no message, no kill/lost count for type 17). Otherwise +B/+C := the occupant's +1/+2, so the
  // missile always aims at where the CURRENT occupant stands (a reused slot's new enemy included).
  private dailyMissile(m: MissileRecord): void {
    const slot = this.missileSlot(this.extra(m));
    const target = this.occupant(slot);
    if (!target) {
      this.destroyShip(m, true);
      return;
    }
    m.targetX = target.x;
    m.targetY = target.y;
  }

  // ---- guns ($11D34) -------------------------------------------------------------------------------------------

  // Compatibility no-op: the original schedules gun rounds through the pending-period byte in Sim, not by sampling
  // the countdown at a pass boundary. Kept for older callers while save-v4 retains the historical baseline field.
  frame(): void {
  }

  /** Legacy no-op: pending period bits are the authoritative saved firing schedule. */
  primeRestoredFrame(): void {
  }

  // One firing round of all guns with tile `tile` (record byte +3 = $FF: finished). Each gun counts its timer
  // (+7) down; flash tile +8 shows for the call after a shot, and when the timer runs out the gun looks for an
  // enemy in the cells of its fire arc (+2 = facing). Without a target it turns by +6.
  fireGuns(tile: number, damage: number): void {
    if (this.s.byte(POWER_LEVEL) >= 0x10) return;
    const o = this.sim.world.objects;
    // $99C4 passes A0=$13248 for Gun A and A0=$1325A for Gun B: the addresses of the +$C total word of the fixed
    // T[5] (row $1323C) / T[6] (row $1324E) rows, which $11D34 reads as its DBRA budget (not row bases). They are fixed rows;
    // do not rediscover them through World.findType(), whose tile column may be absent in some scenarios.
    // $11D34 starts its DBRA budget from the row's +$C total. In-progress records are skipped without consuming it.
    const typeIndex = tile === GUN_A ? 5 : tile === GUN_B ? 6 : -1;
    if (typeIndex < 0) return;
    let remaining = this.s.word(TYPE_TABLE + TYPE_SIZE * typeIndex + 0x0c);
    if (remaining === 0) return;
    for (let slot = 0; slot < OBJECT_SLOTS && remaining > 0; slot++) {
      const at = slot * 8;
      if (((o[at] << 8) | o[at + 1]) !== tile || o[at + 3] !== 0xff) continue;
      remaining--;
      const x = o[at + 4];
      const y = o[at + 5];
      const index = y * MAP_WIDTH + x;
      const timer = (o[at + 7] - 1) & 0xff;
      o[at + 7] = timer;
      if (!(timer & 0x80)) {
        if (timer === 1) this.setTileLow(index, -8); // the muzzle flash ends
        continue;
      }
      o[at + 7] = 0;
      const rot = o[at + 2] & 7;
      const arc = this.tables.arcs[rot];
      const reach = tile === GUN_A ? 16 : 32;
      let hit = false;
      let ended = false;
      for (let i = 0; i < reach && !ended && !hit; i++) {
        const cx = x + arc[i][0];
        const cy = y + arc[i][1];
        if (!inMap(cx, cy)) break;
        const word = this.cells[cy * MAP_WIDTH + cx];
        if (i < 8 && word & ACTIVE) break; // a building in the way ends the first part of the arc
        const f = this.flags[cellFlagIndex(cx, cy)];
        if (f & FLAG_GROUND || f & FLAG_AIR) {
          const list = f & FLAG_GROUND ? this.groundSlots : this.airSlots;
          const target = list.find((e) => e !== null && Math.abs(e.x - cx) <= 1 && Math.abs(e.y - cy) <= 1);
          if (!target) {
            ended = true; // flagged cell without an enemy: this gun does nothing this round
            hit = true;
            break;
          }
          target.hp = s8(target.hp - damage);
          if (target.hp <= 0) this.destroyEnemy(target, true);
          o[at + 7] = 3;
          this.setTileLow(index, 8);
          o[at + 6] = 0;
          this.hooks.sound?.(SFX.HIT);
          hit = true;
        }
      }
      if (hit) continue;
      // no enemy in the arc: turn by +6 (the tile low byte holds base tile + facing, +8 while flashing)
      const step = s8(o[at + 6]);
      if (step === 0) continue;
      let low = this.cells[index] & 0xff;
      if (low >= 0x27 || (low >= 0x17 && low < 0x1f)) low -= 8;
      low += step;
      let facing = rot + step;
      if (facing < 0) {
        facing = 7;
        low = tile + 7;
      } else if (facing === 8) {
        facing = 0;
        low = tile;
      }
      o[at + 2] = facing;
      this.cells[index] = (this.cells[index] & ~0xff) | (low & 0xff);
    }
  }

  private setTileLow(index: number, delta: number): void {
    const word = this.cells[index];
    this.cells[index] = (word & ~0xff) | ((word + delta) & 0xff);
  }

  // ---- views ---------------------------------------------------------------------------------------------------------

  // Positions for the overview map (ScreenContext.otherUnits).
  overview(): { ships: { x: number; y: number }[]; enemyGround: { x: number; y: number }[]; enemyAir: { x: number; y: number }[] } {
    return {
      ships: this.sim.fleet.ships.map((p) => ({ x: p.x, y: p.y })),
      enemyGround: this.ground.map((e) => ({ x: e.x, y: e.y })),
      enemyAir: this.air.map((e) => ({ x: e.x, y: e.y })),
    };
  }

  // Everything this system draws on the map: enemy ground units, aircraft (lifted by their altitude), ships and missiles, each tagged
  // with its original draw-list source (`kind`); ObjectLayer orders the sources as `$333A` does (ships, ground, air).
  drawables(): Drawable[] {
    if (!this.dirty) return this.cache;
    const out: Drawable[] = [];
    for (const g of this.ground) out.push({ type: g.type, x: g.x, y: g.y, dx: g.dx, dy: g.dy, frame: g.dir, anim: g.anim, ref: g, kind: "ground" });
    for (const a of this.air) out.push({ type: a.type, x: a.x, y: a.y, dx: a.dx, dy: a.dy, frame: a.dir, lift: Math.max(0, a.lift), ref: a, kind: "air" });
    for (const p of this.sim.fleet.ships) out.push({ type: p.type, x: p.x, y: p.y, dx: p.dx, dy: p.dy, frame: p.dir, lift: Math.max(0, p.lift), ref: p, kind: "ship" });
    this.cache = out;
    this.dirty = false;
    return out;
  }
}
