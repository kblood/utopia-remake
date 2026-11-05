// Lookup tables of the combat code, read from the game image at runtime (Disk.1, address + $28800 = file
// offset). Nothing from the image is stored in the source: only the offsets and the decoding are.
//   $12C96  48 entries of 4 bytes: map-word step, dx, dy (relative to the previous cell) of the spiral scan
//   $12A96  8 facings x 32 words: map-word offsets of the cells in a gun's fire arc
//   $4C5A   8 x 8 bytes: new direction when turning from direction d towards direction w (index d * 8 + w)
//   $12D60  8 bytes: crusher animation set per step counter

const IMAGE_OFFSET = 0x28800;
const ROW_WORDS = 102; // the original's map rows are 102 words wide ($66)

export interface CombatTables {
  spiral: [number, number][]; // 48 cells around a unit, nearest first
  arcs: [number, number][][]; // per gun facing 0..7: 32 cells (dx, dy)
  turn: number[]; // 64
  crusherAnim: number[]; // 8
}

function s16(data: Uint8Array, at: number): number {
  const v = (data[at] << 8) | data[at + 1];
  return v >= 0x8000 ? v - 0x10000 : v;
}

function s8(v: number): number {
  return v >= 0x80 ? v - 0x100 : v;
}

// A word offset into the 102-word-wide map array as a (dx, dy) cell offset: the pair with the smallest |dx|.
function cellOffset(byteOffset: number): [number, number] {
  const words = byteOffset >> 1;
  let best: [number, number] = [words, 0];
  for (let dy = -12; dy <= 12; dy++) {
    const dx = words - dy * ROW_WORDS;
    if (Math.abs(dx) < Math.abs(best[0])) best = [dx, dy];
  }
  return best;
}

export function loadCombatTables(disk1: Uint8Array): CombatTables {
  const at = (address: number): number => address + IMAGE_OFFSET;
  const spiral: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < 48; i++) {
    const p = at(0x12c96) + 4 * i;
    x += s8(disk1[p + 2]);
    y += s8(disk1[p + 3]);
    spiral.push([x, y]);
  }
  const arcs: [number, number][][] = [];
  for (let facing = 0; facing < 8; facing++) {
    const cells: [number, number][] = [];
    for (let i = 0; i < 32; i++) cells.push(cellOffset(s16(disk1, at(0x12a96) + 64 * facing + 2 * i)));
    arcs.push(cells);
  }
  const turn = Array.from(disk1.subarray(at(0x4c5a), at(0x4c5a) + 64));
  const crusherAnim = Array.from(disk1.subarray(at(0x12d60), at(0x12d60) + 8));
  return { spiral, arcs, turn, crusherAnim };
}
