// Synthetic checks of Builder.demolish ($7372) quirks in src/game/build.ts. No original data is needed: the state
// is zeroed and the object-type table is written by hand (tile word, footprint byte, total, stored amount).
// Run after `npm run build`.
//
// Static trace (Disk.1, 2026-11-25):
//   $7454  cmpi.w #$5C,d0 / bne $7470 / clr.b $144B2 : demolishing a sports complex clears the sports countdown.
//   $7470  cmpi.w #$44,d0 / bne $74A8               : warehouse branch (real buildings only).
//   $748A  d3 = stock long; divu.w d2,d3 (d2 = word at T+$C); ext.l d3; stock -= d3.
//          mulu.w d4,d3 (d4 = weight long, low word); weight($13166) -= d3; loop over 5 goods.
//   $749E  capacity($14432) -= $13880 (80000).
// divu.w keeps the register on quotient overflow (> $FFFF), so for a stock as unsigned long the quotient is
// often > $FFFF and the share is the sign-extended low word of the stock. For a negative stock the quotient
// always overflows (a word divisor cannot bring 2^32 - k below $10000), so the share is s16(low word of stock).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { GameState, STATE_BYTES } = await import("../dist/game/state.js");
const { World, TYPE_TABLE, TYPE_SIZE, T } = await import("../dist/game/world.js");
const { Builder } = await import("../dist/game/build.js");
const { MAP_WIDTH, MAP_HEIGHT } = await import("../dist/data/scenario.js");
const { GOOD_WEIGHT } = await import("../dist/game/sim-tables.js");

// Addresses of the state words Builder uses (the same constants as build.ts V and the notes).
const OBJECT_COUNT = 0x142c2; // V.objects
const STOCK = 0x13152; // five goods, 4 bytes each
const WEIGHT = 0x13166; // stored weight
const CAPACITY = 0x14432;
const SPORTS_COUNTDOWN = 0x144b2; // byte, weeks until another sports event may be called

const TILE_WAREHOUSE = 0x44;
const TILE_SPORTS = 0x5c;
const TILE_OTHER = 0x20; // any single-cell building type that is not special-cased

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A zeroed state image, a world with an empty map, and the three object types.
function fresh() {
  const snap = GameState.fromSnapshot(new Uint8Array(STATE_BYTES));
  if (!snap.ok) throw new Error(`zero state rejected: ${snap.error.message}`);
  const state = snap.value;
  // Every cell starts as id $62 (not a building or ground id, so buildObjects creates no record; cell id 0 would make tile 1).
  const world = new World(state, new Uint16Array(MAP_WIDTH * MAP_HEIGHT).fill(0x62));
  const types = [
    { tile: TILE_WAREHOUSE, total: 3 },
    { tile: TILE_SPORTS, total: 1 },
    { tile: TILE_OTHER, total: 1 },
  ];
  types.forEach((ty, i) => {
    const t = TYPE_TABLE + TYPE_SIZE * i;
    state.setWord(t + T.tile, ty.tile);
    state.setByte(t + 1, 1); // footprint: one cell
    state.setWord(t + T.total, ty.total);
    state.setByte(t + 4, 0); // workers
  });
  const said = [];
  const builder = new Builder(world, new Uint8Array(256), GOOD_WEIGHT.slice(), (m) => said.push(m));
  return { state, world, builder, said };
}

// Places one real building record at (x, y) in slot 0 with its origin cell tile, as buildObjects would.
function place(world, state, tile, x, y) {
  const o = world.objects;
  o[0] = tile >> 8;
  o[1] = tile & 0xff;
  o[4] = x;
  o[5] = y;
  world.cells[y * MAP_WIDTH + x] = tile;
  state.setWord(OBJECT_COUNT, 1);
}

// ---- sports countdown ($7454) ---------------------------------------------------------------------------------------
{
  const { state, world, builder } = fresh();
  place(world, state, TILE_SPORTS, 10, 10);
  state.setByte(SPORTS_COUNTDOWN, 7);
  const ok = builder.demolish(10, 10);
  check("demolishing a sports complex returns true and clears the sports countdown", ok === true && state.byte(SPORTS_COUNTDOWN) === 0, `countdown ${state.byte(SPORTS_COUNTDOWN)}`);
}
{
  const { state, world, builder } = fresh();
  place(world, state, TILE_OTHER, 12, 12);
  state.setByte(SPORTS_COUNTDOWN, 7);
  const ok = builder.demolish(12, 12);
  check("demolishing another building leaves the sports countdown alone", ok === true && state.byte(SPORTS_COUNTDOWN) === 7, `countdown ${state.byte(SPORTS_COUNTDOWN)}`);
}
{
  // A construction site is cancelled, not demolished: the countdown is not touched ($74FE never reaches $7454).
  const { state, world, builder } = fresh();
  const o = world.objects;
  o[0] = 0x00;
  o[1] = 0x00;
  state.setByte(SPORTS_COUNTDOWN, 7);
  check("no record at a cell: demolition refused, countdown alone", builder.demolish(20, 20) === false && state.byte(SPORTS_COUNTDOWN) === 7);
}

// ---- warehouse share ($7470-$749E) ----------------------------------------------------------------------------------
// Normal stock. Total 3 (type word T+$C), stock goods 0..4 = 10, 20, 30, 0, 5, stored weight 10030, capacity 200000.
// Weights $B0EC = 100, 200, 1, 2000, 1000.
// Shares (divu.w, no overflow): 10/3 = 3, 20/3 = 6, 30/3 = 10, 0/3 = 0, 5/3 = 1.
// Stock left: 7, 14, 20, 0, 4. Weight removed: 3*100 + 6*200 + 10*1 + 0 + 1*1000 = 300 + 1200 + 10 + 1000 = 2510.
// Weight left: 10030 - 2510 = 7520. Check: 7*100 + 14*200 + 20*1 + 0 + 4*1000 = 700 + 2800 + 20 + 4000 = 7520. Capacity: 200000 - 80000 = 120000.
{
  const { state, world, builder } = fresh();
  place(world, state, TILE_WAREHOUSE, 30, 30);
  [10, 20, 30, 0, 5].forEach((units, i) => state.setLong(STOCK + 4 * i, units));
  state.setLong(WEIGHT, 10030);
  state.setLong(CAPACITY, 200000);
  const ok = builder.demolish(30, 30);
  const stock = [0, 1, 2, 3, 4].map((i) => state.signedLong(STOCK + 4 * i));
  check(
    "warehouse, normal stock: each good loses stock / total, weight loses units x weight",
    ok && JSON.stringify(stock) === JSON.stringify([7, 14, 20, 0, 4]) && state.signedLong(WEIGHT) === 7520,
    `stock ${stock} weight ${state.signedLong(WEIGHT)}`,
  );
  check("warehouse: capacity drops by 80000", state.signedLong(CAPACITY) === 120000, `capacity ${state.signedLong(CAPACITY)}`);
}

// Negative stock, good 2 (weight 1) = -70000, total 3, stored weight 100000, capacity 200000.
// The stock as unsigned long is 0xFFFEEE90; the quotient by 3 is > $FFFF, so divu.w keeps the register and ext.l gives
// the low word 0xEE90 = -4464. Share = -4464. Stock: -70000 - (-4464) = -65536. Weight: 100000 - mulu(0xEE90, 1)
// = 100000 - 61072 = 38928. Good 2 is the only non-zero good, so the other shares are 0.
{
  const { state, world, builder } = fresh();
  place(world, state, TILE_WAREHOUSE, 40, 40);
  state.setLong(STOCK + 4 * 2, -70000);
  state.setLong(WEIGHT, 100000);
  state.setLong(CAPACITY, 200000);
  const ok = builder.demolish(40, 40);
  const good2 = state.signedLong(STOCK + 8);
  check(
    "warehouse, negative stock -70000 (divu.w overflow): share is the sign-extended low word (-4464), stock -65536",
    ok && good2 === -65536,
    `stock ${good2}`,
  );
  check("warehouse, negative stock: weight drops by mulu.w of that share and weight (38928)", state.signedLong(WEIGHT) === 38928, `weight ${state.signedLong(WEIGHT)}`);
}

// Negative stock, good 0 (weight 100) = -5, total 3, stored weight 10000.
// Unsigned 0xFFFFFFFB / 3 overflows, so the share is -5 and the stock becomes -5 - (-5) = 0 (the whole stock is taken).
// Weight: 10000 - mulu.w(0xFFFB, 100) = 10000 - 65531 * 100 = 10000 - 6553100 = -6543100.
{
  const { state, world, builder } = fresh();
  place(world, state, TILE_WAREHOUSE, 50, 50);
  state.setLong(STOCK, -5);
  state.setLong(WEIGHT, 10000);
  state.setLong(CAPACITY, 200000);
  const ok = builder.demolish(50, 50);
  check("warehouse, stock -5 (divu.w overflow): the share is -5, so the stock becomes 0", ok && state.long(STOCK) === 0, `stock ${state.signedLong(STOCK)}`);
  check("warehouse, stock -5: weight -= mulu.w(0xFFFB, 100), giving -6543100", state.signedLong(WEIGHT) === -6543100, `weight ${state.signedLong(WEIGHT)}`);
}

// Cleared ground ($61) is not a building: no sports or warehouse effect, and the refusal path is unchanged.
{
  const { state, world, builder, said } = fresh();
  world.cells[60 * MAP_WIDTH + 60] = 0x61;
  state.setByte(SPORTS_COUNTDOWN, 7);
  const ok = builder.demolish(60, 60);
  check("ground $61 with no record: the cell becomes $9E, the countdown stays", ok === true && state.byte(SPORTS_COUNTDOWN) === 7 && said.length === 0);
}

console.log(failed === 0 ? "demolish-quirks: all checks passed" : `demolish-quirks: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
