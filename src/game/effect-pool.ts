// The short-lived effect list (explosions) as the original keeps it: 30 FIXED 8-byte slots at `$39D4A`, count word `$156AE`
// (static trace of `$1237C` and `$333A`, notes/formats/units.md section 6). A new effect takes the FIRST free slot; an expired
// effect frees only its own slot; the update and the draw-list scan walk the slots in ascending order and skip holes. So a
// freed slot is reused before later ones and the survivors keep their slot index (identity), which decides the order in which
// they enter the draw list. Pure data: no screen, no hook, no RNG, no sound.

/** Capacity of the effect list. A full list makes `spawn` fail, which changes combat occupancy handling (map.ts `enemyExplosion`). */
export const MAX_EFFECTS = 30;
/** Byte +5 of a new effect; it counts down to 0 and is drawn with that frame; it is freed when it would go below 0, so a live effect holds 0..EFFECT_START. */
export const EFFECT_START = 4;

export interface Effect {
  type: number;
  x: number;
  y: number;
  frame: number; // byte +5: counts down, freed below 0
  lift: number;
}

export class EffectPool {
  /** The 30 slots (null = free), index = slot number. Restore replaces their content in place; nothing else may add or remove entries. */
  readonly slots: (Effect | null)[] = new Array<Effect | null>(MAX_EFFECTS).fill(null);
  /**
   * True when the live effects come from a save that could not say which slot each one held (versions 6 and 7 stored a dense
   * list): the records are all kept but their slot numbers, and so the first-free-slot allocation and the draw order of
   * ties, are an assumption (slots 0..n-1 in list order). It clears itself as soon as the pool is empty (an empty pool is
   * exact). Persisted by version 8 saves, so a later save keeps the warning.
   */
  assumedSlots = false;

  /** The word `$156AE`: the number of occupied slots. */
  get count(): number {
    let n = 0;
    for (const s of this.slots) if (s !== null) n++;
    return n;
  }

  /** Occupied slots in ascending slot order (live records, a fresh array). */
  records(): Effect[] {
    return this.slots.filter((s): s is Effect => s !== null);
  }

  /** `$1237C`: takes the first free slot. Returns false (nothing allocated) when all 30 are occupied. */
  spawn(type: number, x: number, y: number, lift = 0): boolean {
    const slot = this.slots.indexOf(null);
    if (slot < 0) return false;
    this.slots[slot] = { type, x, y, frame: EFFECT_START, lift };
    return true;
  }

  /** `$333A` effect step, once per unpaused pass: slots ascending, byte +5 counts down, below 0 frees that slot only. */
  tick(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const e = this.slots[i];
      if (e !== null && --e.frame < 0) this.slots[i] = null;
    }
    if (this.assumedSlots && this.count === 0) this.assumedSlots = false;
  }

  /** Save restore: replaces the 30 slots with `records` (already validated, exactly 30 entries) in place. */
  restore(records: readonly (Effect | null)[], assumed: boolean): void {
    for (let i = 0; i < MAX_EFFECTS; i++) this.slots[i] = records[i];
    this.assumedSlots = assumed && this.count > 0;
  }
}
