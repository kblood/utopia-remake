// Constant tables of the game program (numbers only), copied from the game image so the
// simulation never has to read the disk. Source addresses are given per table.

// $B0C4: job pools, as indices into the object-type table T[i] (pool 0..8).
export const JOB_POOL_TYPES = [14, 15, 26, 27, 22, 23, 4, 1, 20] as const;

// $B100: 21 types in power-priority order; the first types are powered first. Index k of the
// type that cannot be powered gives power-shortage level 21 - k ($144C8).
export const POWER_TYPES = [30, 24, 19, 18, 6, 5, 4, 29, 20, 26, 15, 22, 27, 14, 1, 13, 2, 3, 23, 32, 25] as const;

// $B0EC: weight in kg of one unit of goods 0..4.
export const GOOD_WEIGHT = [100, 200, 1, 2000, 1000] as const;

// $B178: morale change per month by tax rate 0..20 (units of 1/100 percent, through $A246).
export const TAX_MORALE = [500, 450, 400, 350, 300, 250, 200, 150, 100, 50, 0, 0, -50, -100, -150, -200, -250, -300, -350, -400, -450] as const;

// $B1A2: quality-of-life term by tax rate 0..20 (added before the final /100).
export const TAX_QOL = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 0, 0, -50, -100, -150, -200, -250, -300, -350, -400, -450] as const;

// $B23C: starvation level written to $144B4 by food shortage (index = shortage*20/population).
export const STARVATION_LEVEL = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40] as const;
