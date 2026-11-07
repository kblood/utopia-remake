// The original's draw list as implemented in src/game/draw-list.ts (pure algorithms) and src/game/objects.ts (admission, gate,
// neighbour redraws, picking) plus the 30 fixed effect slots of src/game/effect-pool.ts. Run after `npm run build`. Fully
// asset-free: a hand-made one-row SpriteSet stands in for the artwork, so this checks STRUCTURE (static trace of $333A, $3694,
// $4860, $6540: source order, order keys, the literal selection sort with its unstable ties, the gate and its blocked suffix,
// neighbour redraws, pick scan, renderer purity). It makes no claim of pixel parity with the running original.
//
// Expected values for the sort come from hand simulation of the documented loop (see the comments), not from a second copy of
// the implementation, except for the randomized comparison, which is labelled as a reference transliteration.

const { sortDrawList, orderKey, PAINTER_CELLS, DrawCursor, neighbourOffsets, FLAG_NEIGHBOURS, FLAG_GATED, SOURCE_ORDER } = await import("../dist/game/draw-list.js");
const { ObjectLayer, ALIEN_REF, METEOR_REF, ALIEN_ANCHOR_Y_ADJUST } = await import("../dist/game/objects.js");
const { EffectPool, MAX_EFFECTS, EFFECT_START } = await import("../dist/game/effect-pool.js");
const { pickObject } = await import("../dist/game/orders.js");
const { SpriteSet } = await import("../dist/data/sprites.js");
const { Screen } = await import("../dist/gfx/screen.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- 1. order keys and the 64-cell interleave ----------------------------------------------------------------------------
{
  check("64 painter cells, diagonals ascending, vx ascending inside a diagonal", PAINTER_CELLS.length === 64 && PAINTER_CELLS[0].vx === 0 && PAINTER_CELLS[0].vy === 0 && PAINTER_CELLS[1].vx === 0 && PAINTER_CELLS[1].vy === 1 && PAINTER_CELLS[2].vx === 1 && PAINTER_CELLS[2].vy === 0 && PAINTER_CELLS[63].vx === 7 && PAINTER_CELLS[63].vy === 7);
  check("order key = 63 - painter sequence for every one of the 64 cells, strictly descending along the traversal", PAINTER_CELLS.every((c, seq) => orderKey(c.vx, c.vy) === 63 - seq));
  const keys = new Set();
  for (let vy = 0; vy < 8; vy++) for (let vx = 0; vx < 8; vx++) keys.add(orderKey(vx, vy));
  check("the 64 keys are unique and cover 0..63", keys.size === 64 && Math.min(...keys) === 0 && Math.max(...keys) === 63);
  check("corner keys: (0,0) = 63, (7,7) = 0, (0,7) = 35, (7,0) = 28 (the longest diagonal runs vx ascending)", orderKey(0, 0) === 63 && orderKey(7, 7) === 0 && orderKey(0, 7) === 35 && orderKey(7, 0) === 28);
  check("source order and flags of $333A: tanks 1, ships 0, ground 3, air 2, effects 0, alien 0, meteor 0, extras (approximate) last", SOURCE_ORDER.map((s) => `${s.kind}:${s.flags}`).join() === "tank:1,ship:0,ground:3,air:2,effect:0,alien:0,meteor:0,extra:0" && FLAG_NEIGHBOURS === 1 && FLAG_GATED === 2);
}

// ---- 2. the $4860 selection sort -----------------------------------------------------------------------------------------
{
  const mk = (orders) => orders.map((order, i) => ({ order, id: String.fromCharCode(97 + i) }));
  const ids = (list) => list.map((e) => e.id).join("");
  // Hand simulation of the loop (end = n-1..1, selected = 0, scan = 1..end, swap selected <-> end inside every inner iteration).
  check("three equal keys a, b, c end as a, c, b (not stable)", ids(sortDrawList(mk([5, 5, 5]))) === "acb");
  check("four equal keys a, b, c, d end as a, b, d, c", ids(sortDrawList(mk([5, 5, 5, 5]))) === "abdc");
  check("five equal keys x0..x4 end as x0, x4, x2, x1, x3", ids(sortDrawList(mk([5, 5, 5, 5, 5]))) === "aecbd");
  check("[1, 2, 2, 3] ends as d, c, b, a: the two 2s swap (hand simulation)", ids(sortDrawList(mk([1, 2, 2, 3]))) === "dcba");
  check("two equal keys keep their order", ids(sortDrawList(mk([7, 7]))) === "ab");
  check("a plain stable sort would differ (sanity: the port is not Array.prototype.sort)", ids(mk([5, 5, 5]).sort((p, q) => q.order - p.order)) === "abc" && ids(sortDrawList(mk([5, 5, 5]))) !== "abc");
  check("empty and one-entry lists", sortDrawList([]).length === 0 && ids(sortDrawList(mk([3]))) === "a");
  const input = mk([1, 2, 2, 3]);
  const copy = input.slice();
  sortDrawList(input);
  check("the input array is not modified", input.every((e, i) => e === copy[i]));

  // Every permutation of up to 6 distinct keys comes out globally descending.
  const permutations = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((v, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [v, ...p])));
  let allSorted = true;
  let count = 0;
  for (const n of [2, 3, 4, 5, 6]) {
    for (const p of permutations(Array.from({ length: n }, (_, i) => i * 3))) {
      count++;
      const out = sortDrawList(mk(p)).map((e) => e.order);
      for (let i = 1; i < out.length; i++) if (out[i - 1] < out[i]) allSorted = false;
    }
  }
  check(`globally descending for all ${count} permutations of 2..6 distinct keys`, allSorted);

  // Randomized: with duplicate keys (cross-cell ties) the result is globally descending, a permutation of the input, and equal
  // to a reference transliteration of the documented loop.
  const reference = (list) => {
    const e = list.slice();
    for (let end = e.length - 1; end > 0; end--) {
      let sel = 0;
      for (let scan = 1; scan <= end; scan++) {
        if (e[sel].order >= e[scan].order) sel = scan;
        if (sel !== end) [e[sel], e[end]] = [e[end], e[sel]];
      }
    }
    return e;
  };
  let seed = 12345;
  const rand = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
  let ok = true;
  let worst = 0;
  for (let round = 0; round < 400; round++) {
    const n = 1 + rand(14);
    const list = mk(Array.from({ length: n }, () => rand(6)));
    const out = sortDrawList(list);
    const ref = reference(list);
    for (let i = 1; i < out.length; i++) if (out[i - 1].order < out[i].order) ok = false;
    if (out.some((e, i) => e !== ref[i])) ok = false;
    if ([...out].map((e) => e.id).sort().join("") !== list.map((e) => e.id).sort().join("")) ok = false;
    worst = Math.max(worst, n);
  }
  check("400 random lists with duplicate keys: descending, a permutation, identical to the reference loop", ok, `up to ${worst} entries`);

  // Cross-cell: entries of two cells interleaved by admission order keep their per-cell tie permutation and cells stay ordered.
  const cells = [{ order: 40, id: "a" }, { order: 41, id: "b" }, { order: 40, id: "c" }, { order: 41, id: "d" }, { order: 40, id: "e" }, { order: 41, id: "f" }];
  const sorted = sortDrawList(cells);
  check("two cells' entries interleaved: all of cell 41 first, then cell 40, each group permuted by the sort", sorted.map((e) => e.order).join() === "41,41,41,40,40,40" && sorted.map((e) => e.id).join("") === ids(reference(cells)));
}

// ---- 3. the single cursor and its blocked suffix -----------------------------------------------------------------------------
{
  const e = (order, flags, id) => ({ order, flags, id });
  const list = [e(60, 0, "a"), e(60, FLAG_GATED, "b"), e(60, 0, "c"), e(59, 0, "d"), e(58, FLAG_GATED, "f")];
  const closed = new DrawCursor(list);
  const first = closed.turn(60, false);
  check("closed gate: entries before the first gated one are returned, the gated one is NOT consumed", first.map((x) => x.id).join("") === "a" && closed.isBlocked);
  check("everything later stays blocked: later cells return nothing for the rest of the frame (nothing is skipped or filtered)", closed.turn(59, false).length === 0 && closed.turn(58, true).length === 0 && closed.turn(57, true).length === 0);
  const open = new DrawCursor(list);
  const drawn = [60, 59, 58].flatMap((k) => open.turn(k, true).map((x) => x.id)).join("");
  check("open gate: the cursor returns every entry once, cell by cell, in list order", drawn === "abcdf" && !open.isBlocked);
  const midClosed = new DrawCursor([e(60, 0, "a"), e(59, FLAG_GATED, "b"), e(58, 0, "c")]);
  check("a gated entry on a later cell blocks from there on, earlier cells were drawn", midClosed.turn(60, false).map((x) => x.id).join("") === "a" && midClosed.turn(59, false).length === 0 && midClosed.turn(58, false).length === 0 && midClosed.isBlocked);
  const ungatedClosed = new DrawCursor([e(60, 0, "a"), e(59, 0, "b"), e(58, FLAG_NEIGHBOURS, "c")]);
  check("flag bit 0 alone (own units) is never gated", [60, 59, 58].flatMap((k) => ungatedClosed.turn(k, false).map((x) => x.id)).join("") === "abc" && !ungatedClosed.isBlocked);
  const jump = new DrawCursor([e(60, 0, "a"), e(59, 0, "b")]);
  check("a call that jumps ahead walks past the earlier cells (they are not returned)", jump.turn(59, true).map((x) => x.id).join("") === "b");
  const jumpBlocked = new DrawCursor([e(60, FLAG_GATED, "a"), e(59, 0, "b")]);
  check("a jump over a gated entry with a closed gate is blocked exactly as the full walk would be", jumpBlocked.turn(59, false).length === 0 && jumpBlocked.isBlocked);

  check("neighbour table: 1 -> (+1,-1),(+1,0); 2 -> (+1,0); 3 -> (+1,0),(0,+1),(+1,+1); 4 and 5 -> (0,+1); else none",
    JSON.stringify(neighbourOffsets(1)) === "[[1,-1],[1,0]]" && JSON.stringify(neighbourOffsets(2)) === "[[1,0]]" && JSON.stringify(neighbourOffsets(3)) === "[[1,0],[0,1],[1,1]]" &&
    JSON.stringify(neighbourOffsets(4)) === "[[0,1]]" && JSON.stringify(neighbourOffsets(5)) === "[[0,1]]" && [0, 6, 7, 8, 9, -1].every((f) => neighbourOffsets(f).length === 0));
}

// ---- helpers for the layer tests -----------------------------------------------------------------------------------------------
const PLANE = 4; // one-row sprites: 5 planes of 4 bytes, then the mask
const FRAME_BYTES = 6 * PLANE;
const COLOUR = { 1: 11, 9: 3, 12: 4, 22: 5, 25: 6, 0x12: 7, 0x14: 8, 19: 9, 21: 10 };
function spriteSet() {
  const types = Array.from({ length: 27 }, () => null);
  for (const [t, colour] of Object.entries(COLOUR)) {
    const sheet = new Uint8Array(FRAME_BYTES);
    for (let p = 0; p < 5; p++) if ((colour >> p) & 1) sheet.fill(0xff, p * PLANE, p * PLANE + 4);
    sheet.fill(0xff, 5 * PLANE, 5 * PLANE + 4); // fully opaque
    types[Number(t) - 1] = { type: Number(t), rows: 1, frameBytes: FRAME_BYTES, planeBytes: PLANE, frameOffsets: [0, 0, 0, 0, 0, 0, 0, 0, 0], image: 0, mask: 5 * PLANE, sheet };
  }
  return new SpriteSet(types);
}
const BG = 31;
const fresh = () => { const s = new Screen(); s.pixels.fill(BG); return s; };
const SX = 10, SY = 10; // scroll origin used below: map cell (SX + vx, SY + vy)
const ax = (vx, vy) => 112 + 16 * (vx - vy);
const ay = (vx, vy) => 38 + 8 * (vx + vy); // bottom row of the cell box
const px = (s, vx, vy, dx = 0, dy = 0, lift = 0) => s.pixels[(ay(vx, vy) + dy - lift) * 320 + ax(vx, vy) + dx];
const flatTile = { rows: 15, planes: new Uint8Array(24 * 15) };
function makeLayer({ tiles = [], tileCalls = null, cellFill = 0 } = {}) {
  const cells = new Uint16Array(7500).fill(cellFill);
  const layer = new ObjectLayer(spriteSet(), tiles, cells, (t, x, y) => tileCalls?.push(`${x},${y}`));
  return { layer, cells };
}
// Stand-in enemy system: the real one hands out ground, air, ships in that order (enemies.ts `drawables`).
function stubEnemies(layer, { ground = [], air = [], ships = [] } = {}) {
  const tag = (list, kind, type) => list.map((d) => ({ type, dx: 0, dy: 0, frame: 0, ref: { kind, d }, kind, ...d }));
  layer.enemies = { drawables: () => [...tag(ground, "ground", 22), ...tag(air, "air", 25), ...tag(ships, "ship", 12)], pass() {} };
}
const cell = (vx, vy) => ({ x: SX + vx, y: SY + vy });

// ---- 4. admission and the $333A source order ---------------------------------------------------------------------------------
{
  const { layer } = makeLayer();
  layer.units.spawn(9, SX + 5, SY + 5, 1); // own tank, view (5,5)
  layer.spawnEffect(0x12, SX + 1, SY + 4); // effect
  stubEnemies(layer, { ground: [cell(2, 2)], air: [cell(6, 1)], ships: [cell(3, 6)] });
  layer.apparition = () => ({ type: 19, x: SX + 4, y: SY + 0, frame: 0 });
  layer.meteor = () => ({ type: 21, x: SX + 0, y: SY + 5, frame: 0, lift: 0 });
  layer.extra.push({ type: 1, x: SX + 7, y: SY + 7 });
  const admitted = layer.admitted(SX, SY);
  check("admitted order is the $333A insertion order (tank, ship, ground, air, effect, alien, meteor, extra) whatever the cells", admitted.map((a) => a.kind).join() === "tank,ship,ground,air,effect,alien,meteor,extra");
  check("flags per source: tank 1, ship 0, ground 3, air 2, effect 0, alien 0, meteor 0, extra 0", admitted.map((a) => a.flags).join() === "1,0,3,2,0,0,0,0");
  check("each entry's order key is 63 - painter sequence of its view cell", admitted.every((a) => a.order === orderKey(a.vx, a.vy)));
  layer.preparePassGate(SX, SY);
  check("$142A0 pass draw count includes original admitted entries and excludes remake-only extras", layer.passDrawCount === 7);
  check("the alien carries the $3604 y adjustment as extra lift, others keep their own lift", admitted.find((a) => a.kind === "alien").lift === ALIEN_ANCHOR_Y_ADJUST && admitted.find((a) => a.kind === "meteor").lift === 0);
  check("the specials point at shared non-target markers", admitted.find((a) => a.kind === "alien").ref === ALIEN_REF && admitted.find((a) => a.kind === "meteor").ref === METEOR_REF);
  const sorted = layer.drawList(SX, SY);
  const drawSignature = (e) => [e.kind, e.order, e.type, e.vx, e.vy, e.frame, e.anim, e.dx, e.dy, e.lift].join(":");
  check("drawList sorts the same entries globally by cell: keys descending, nothing added or lost", sorted.length === admitted.length && sorted.every((e, i) => i === 0 || sorted[i - 1].order >= e.order) && sorted.map(drawSignature).sort().join("|") === admitted.map(drawSignature).sort().join("|"));
  check("sorted list = painter order of the entries' cells", sorted.map((e) => `${e.vx},${e.vy}`).join("|") === "0,5|1,4|2,2|3,6|4,0|5,5|6,1|7,7".split("|").sort((p, q) => {
    const [a, b] = p.split(",").map(Number); const [c, d] = q.split(",").map(Number);
    return orderKey(c, d) - orderKey(a, b);
  }).join("|"));

  // outside the window and the $3694 edge rule are decided before the sort
  const { layer: l2 } = makeLayer();
  l2.units.spawn(9, SX + 8, SY + 0, 1); // view column 8: outside
  l2.units.spawn(9, SX - 1, SY + 2, 1); // view column -1: outside
  const t = l2.units.spawn(9, SX + 7, SY + 2, 1);
  t.dx = 4; t.dy = 2; t.dir = 2; // last column, facing 2, dx > 0: hidden by $3694
  check("$3694 admission: cells outside the window and a unit leaving the last column are not admitted", l2.admitted(SX, SY).length === 0);

  // a blit-rejected entry (left edge >= 256) is STILL admitted and stays in the sort and the pick list; no sprite pixels either
  const { layer: l3 } = makeLayer();
  const far = l3.units.spawn(9, SX + 7, SY + 0, 1);
  far.dx = 32; far.dy = 0; far.dir = 0; // x = 224 + 32 = 256: $3768 rejects the blit, $3694 admits it
  const s3 = fresh();
  l3.drawMap(s3, SX, SY);
  check("a blit-rejected entry remains admitted, sorted and pickable but paints nothing", l3.admitted(SX, SY).length === 1 && l3.drawList(SX, SY).length === 1 && l3.pickables(SX, SY).length === 1 && s3.pixels.every((v) => v === BG));
  // an entry whose sprite type has no artwork is admitted too
  const { layer: l4 } = makeLayer();
  l4.units.spawn(10, SX + 3, SY + 3, 1); // type 10 has no sprite in the synthetic set
  const s4 = fresh();
  l4.drawMap(s4, SX, SY);
  check("an entry without any sprite pixels (no artwork) is still in the list", l4.drawList(SX, SY).length === 1 && s4.pixels.every((v) => v === BG));
}

// ---- 5. unstable ties inside one cell through the real layer --------------------------------------------------------------------
{
  const { layer } = makeLayer();
  const c = cell(3, 3);
  layer.spawnEffect(0x12, c.x, c.y); // slot 0: colour 7
  layer.spawnEffect(0x14, c.x, c.y); // slot 1: colour 8
  layer.spawnEffect(0x12, c.x, c.y); // slot 2: colour 7
  const refs = layer.pool.slots.slice(0, 3);
  const list = layer.drawList(SX, SY);
  check("three effects on one cell sort as slot 0, slot 2, slot 1 (the $4860 tie permutation, not the slot order)", list.length === 3 && list[0].ref === refs[0] && list[1].ref === refs[2] && list[2].ref === refs[1]);
  const s = fresh();
  layer.drawMap(s, SX, SY);
  check("the last drawn of the three is slot 1, so its sprite shows on top (stable order would have shown slot 2)", px(s, 3, 3) === COLOUR[0x14]);

  const { layer: four } = makeLayer();
  for (let i = 0; i < 4; i++) four.spawnEffect(i === 3 ? 0x14 : 0x12, c.x, c.y);
  const f4 = four.pool.slots.slice(0, 4);
  const l4 = four.drawList(SX, SY).map((e) => f4.indexOf(e.ref)).join("");
  check("four effects on one cell sort as slots 0, 1, 3, 2", l4 === "0132");

  // mixed sources on one cell: admission tank, ground, effect, alien, meteor -> sorted tank, meteor, effect, ground, alien
  const { layer: mix } = makeLayer();
  mix.units.spawn(9, c.x, c.y, 1);
  stubEnemies(mix, { ground: [c] });
  mix.spawnEffect(0x12, c.x, c.y);
  mix.apparition = () => ({ type: 19, x: c.x, y: c.y, frame: 0 });
  mix.meteor = () => ({ type: 21, x: c.x, y: c.y, frame: 0, lift: 0 });
  check("mixed sources on one cell: admission tank, ground, effect, alien, meteor", mix.admitted(SX, SY).map((e) => e.kind).join() === "tank,ground,effect,alien,meteor");
  check("...and the sorted draw order is tank, meteor, effect, ground, alien (hand-simulated five-way tie)", mix.drawList(SX, SY).map((e) => e.kind).join() === "tank,meteor,effect,ground,alien");

  // cross-cell: later cells never come before earlier ones; ties stay inside their cell
  const { layer: cross } = makeLayer();
  cross.spawnEffect(0x12, SX + 4, SY + 4); // later cell, listed first
  cross.spawnEffect(0x12, SX + 1, SY + 0);
  cross.spawnEffect(0x14, SX + 4, SY + 4);
  cross.spawnEffect(0x12, SX + 1, SY + 0);
  cross.spawnEffect(0x14, SX + 4, SY + 4);
  const cells4 = cross.drawList(SX, SY).map((e) => `${e.vx}${e.vy}`).join();
  check("two cells with several tied entries: all entries of the earlier cell come first", cells4 === "10,10,44,44,44");
  const slotsOf = (l) => l.drawList(SX, SY).map((e) => l.pool.slots.indexOf(e.ref)).join();
  // Hand simulation of the loop for orders [24, 61, 24, 61, 24] (slots 0..4): the 61s end first as slots 3, 1; the 24s as 4, 2, 0.
  check("cross-cell tie permutation: cell (1,0) holds slots 1, 3 and cell (4,4) holds slots 0, 2, 4 -> 3,1 then 4,2,0", slotsOf(cross) === "3,1,4,2,0");
}

// ---- 6. the redraw gate: every source and the blocked suffix ---------------------------------------------------------------------
{
  const gateOf = (setup) => {
    const { layer, cells } = makeLayer();
    setup(layer, cells);
    const entries = layer.admitted(SX, SY);
    return layer.gate(entries, SX, SY);
  };
  check("empty window: gate closed", gateOf(() => {}).open === false);
  check("an enemy ground unit does not set the gate", gateOf((l) => stubEnemies(l, { ground: [cell(2, 2)] })).open === false);
  check("an enemy aircraft does not set the gate", gateOf((l) => stubEnemies(l, { air: [cell(2, 2)] })).open === false);
  check("an effect does not set the gate", gateOf((l) => l.spawnEffect(0x12, SX + 2, SY + 2)).open === false);
  check("the alien and the meteor do not set the gate", gateOf((l) => { l.apparition = () => ({ type: 19, x: SX + 2, y: SY + 2, frame: 0 }); l.meteor = () => ({ type: 21, x: SX + 3, y: SY + 2, frame: 0, lift: 0 }); }).open === false);
  check("an untagged extra does not set the gate", gateOf((l) => l.extra.push({ type: 1, x: SX + 2, y: SY + 2 })).open === false);
  const tank = gateOf((l) => l.units.spawn(9, SX + 2, SY + 2, 1));
  check("an admitted own tank sets the gate", tank.open && tank.tank && !tank.ship && !tank.animatedCell && !tank.invention);
  check("a tank outside the window does not", gateOf((l) => l.units.spawn(9, SX + 12, SY + 2, 1)).open === false);
  const ship = gateOf((l) => stubEnemies(l, { ships: [cell(2, 2)] }));
  check("an admitted own ship or missile sets the gate", ship.open && ship.ship && !ship.tank);
  const anim = gateOf((l, cells) => { cells[(SY + 3) * 100 + SX + 4] = 0x0400 | 100; }); // id 100 does not animate, the flag alone counts
  check("a visible animated cell (flag bit 10) sets the gate even if its id never changes", anim.open && anim.animatedCell && !anim.tank);
  check("an animated cell outside the 8 x 8 window does not", gateOf((l, cells) => { cells[(SY + 3) * 100 + SX + 8] = 0x0400 | 100; cells[(SY + 8) * 100 + SX] = 0x0400 | 6; }).open === false);
  const inv = gateOf((l) => { l.inventionGate = () => true; });
  check("invention bit 17 sets the gate", inv.open && inv.invention && !inv.tank);

  // blocked suffix: effect (earlier cell) -> gated ground (middle) -> effect (later cell) -> pin. Tiles and pins continue.
  const run = (gateOpen) => {
    const calls = [];
    const { layer } = makeLayer({ tiles: [flatTile], tileCalls: calls, cellFill: 1 });
    layer.spawnEffect(0x12, SX + 0, SY + 0); // view (0,0), key 63: before the gated entry
    stubEnemies(layer, { ground: [cell(1, 0)] }); // view (1,0), key 62: flags 3, gated
    layer.spawnEffect(0x14, SX + 2, SY + 0); // view (2,0): after the gated entry
    layer.toggleMarker(1, SX + 3, SY + 3); // pin at view (3,3)
    if (gateOpen) layer.inventionGate = () => true;
    layer.preparePassGate(SX, SY);
    const s = fresh();
    layer.drawMap(s, SX, SY);
    return { s, calls, layer };
  };
  const closed = run(false);
  check("closed gate: objects before the gated entry are drawn", px(closed.s, 0, 0) === COLOUR[0x12]);
  check("closed gate: the gated enemy itself is not drawn", px(closed.s, 1, 0) === BG);
  check("closed gate: a later ungated object (effect on a later cell) stays blocked behind it (the whole suffix)", px(closed.s, 2, 0) === BG);
  check("closed gate: the pin is still drawn, over everything", px(closed.s, 3, 3) === COLOUR[1]);
  check("closed gate: all 64 tiles are still drawn in painter order", closed.calls.length === 64 && closed.calls[0] === `${ax(0, 0)},${ay(0, 0) + 1}` && closed.calls[1] === `${ax(0, 1)},${ay(0, 1) + 1}` && closed.calls[63] === `${ax(7, 7)},${ay(7, 7) + 1}`);
  check("closed gate: changing a source between redraws does not open it mid-pass", (() => {
    closed.layer.inventionGate = () => true;
    const s = fresh();
    closed.layer.drawMap(s, SX, SY);
    return px(s, 1, 0) === BG;
  })());
  check("the next pass sees the invention source and opens the gate", (() => {
    closed.layer.preparePassGate(SX, SY);
    const s = fresh();
    closed.layer.drawMap(s, SX, SY);
    return px(s, 1, 0) === COLOUR[22];
  })());
  const open = run(true);
  check("open gate: the enemy and the later effect are drawn too", px(open.s, 0, 0) === COLOUR[0x12] && px(open.s, 1, 0) === COLOUR[22] && px(open.s, 2, 0) === COLOUR[0x14] && px(open.s, 3, 3) === COLOUR[1]);
  check("the redraw gate stays latched across redraws even if its source changes", (() => {
    open.layer.inventionGate = () => false;
    const s = fresh();
    open.layer.drawMap(s, SX, SY);
    return px(s, 1, 0) === COLOUR[22] && px(s, 2, 0) === COLOUR[0x14];
  })());
  check("the next main-loop pass recomputes the gate and closes it when no source remains", (() => {
    open.layer.preparePassGate(SX, SY);
    const s = fresh();
    open.layer.drawMap(s, SX, SY);
    return px(s, 1, 0) === BG && px(s, 2, 0) === BG && px(s, 0, 0) === COLOUR[0x12];
  })());
  // the gated entry shadows later entries of ITS OWN cell as well (no skipping of just that entry)
  const { layer: same } = makeLayer();
  stubEnemies(same, { ground: [cell(4, 1)] });
  same.spawnEffect(0x12, SX + 4, SY + 1);
  const ss = fresh();
  same.drawMap(ss, SX, SY);
  check("a closed gate on the first entry of a cell also withholds the ungated entries after it in that cell", px(ss, 4, 1) === BG && same.beginFrame(SX, SY).list.map((e) => e.kind).join() === "ground,effect");
  // an own tank anywhere opens the gate for the enemy
  const { layer: withTank } = makeLayer();
  stubEnemies(withTank, { ground: [cell(1, 0)] });
  withTank.units.spawn(9, SX + 6, SY + 6, 1);
  const wt = fresh();
  withTank.drawMap(wt, SX, SY);
  check("with an own tank in view the gated enemy is drawn", px(wt, 1, 0) === COLOUR[22] && px(wt, 6, 6) === COLOUR[9]);
}

// ---- 7. neighbour redraws ---------------------------------------------------------------------------------------------------------
{
  const anchors = (...cellsList) => cellsList.map(([vx, vy]) => `${ax(vx, vy)},${ay(vx, vy) + 1}`);
  const withUnit = (setup, tiles = [flatTile]) => {
    const calls = [];
    const { layer } = makeLayer({ tiles, tileCalls: calls, cellFill: 1 });
    setup(layer);
    const s = fresh();
    layer.drawMap(s, SX, SY);
    return { calls, layer, s };
  };
  const tankAt = (vx, vy, dir, dx, dy) => (l) => { const u = l.units.spawn(9, SX + vx, SY + vy, 1); u.dir = dir; u.dx = dx; u.dy = dy; return u; };

  const t3 = withUnit(tankAt(3, 3, 3, 2, 2));
  const own = anchors([3, 3]);
  const at = t3.calls.indexOf(own[0]);
  check("own tank facing 3 with an offset: (+1,0), (0,+1), (+1,+1) are drawn right after its own tile, in that order", t3.calls.slice(at + 1, at + 4).join("|") === anchors([4, 3], [3, 4], [4, 4]).join("|"));
  check("...each neighbour tile is painted once overall (64 tiles in all): the marks suppress the normal turn", t3.calls.length === 64 && new Set(t3.calls).size === 64);
  const t1 = withUnit(tankAt(3, 3, 1, 1, 0));
  const a1 = t1.calls.indexOf(anchors([3, 3])[0]);
  check("facing 1: (+1,-1) then (+1,0)", t1.calls.slice(a1 + 1, a1 + 3).join("|") === anchors([4, 2], [4, 3]).join("|") && t1.calls.length === 64);
  const t2 = withUnit(tankAt(3, 3, 2, 0, 1));
  check("facing 2 (offset in dy only): (+1,0)", t2.calls[t2.calls.indexOf(anchors([3, 3])[0]) + 1] === anchors([4, 3])[0] && t2.calls.length === 64);
  const t4 = withUnit(tankAt(3, 3, 4, 2, 0));
  const t5 = withUnit(tankAt(3, 3, 5, 0, 2));
  check("facings 4 and 5: (0,+1)", t4.calls[t4.calls.indexOf(anchors([3, 3])[0]) + 1] === anchors([3, 4])[0] && t5.calls[t5.calls.indexOf(anchors([3, 3])[0]) + 1] === anchors([3, 4])[0]);
  check("facing 0 or 6 or 7: no neighbours (the cell loop order is untouched)", [0, 6, 7].every((d) => withUnit(tankAt(3, 3, d, 2, 2)).calls.map((c, i) => c === anchors(...PAINTER_CELLS.map((p) => [p.vx, p.vy]))[i]).every(Boolean)));
  const still = withUnit(tankAt(3, 3, 3, 0, 0));
  check("zero dx and dy: no neighbour redraw", still.calls.every((c, i) => c === anchors(...PAINTER_CELLS.map((p) => [p.vx, p.vy]))[i]));
  const tall = withUnit(tankAt(3, 3, 3, 2, 2), [{ rows: 17, planes: new Uint8Array(24 * 17) }]);
  check("tiles taller than 16 rows are not redrawn in front of the unit", tall.calls.every((c, i) => c === anchors(...PAINTER_CELLS.map((p) => [p.vx, p.vy]))[i]) && tall.calls.length === 64);
  const edge = withUnit(tankAt(7, 3, 1, -1, 0)); // dx < 0 so the $3694 edge rule still admits it
  check("a neighbour outside the window (column 8) is skipped; the unit itself is admitted", edge.layer.admitted(SX, SY).length === 1 && edge.calls.length === 64 && new Set(edge.calls).size === 64);
  const top = withUnit(tankAt(3, 0, 1, 1, 0));
  const topAt = top.calls.indexOf(anchors([3, 0])[0]);
  check("facing 1 on row 0: (+1,-1) is out of the window, (+1,0) is still drawn", top.calls[topAt + 1] === anchors([4, 0])[0] && top.calls.length === 64);

  // already-marked neighbours are skipped by the second unit
  const two = withUnit((l) => { tankAt(2, 3, 3, 2, 2)(l); tankAt(3, 2, 4, 0, 2)(l); });
  const marked = two.calls.filter((c) => c === anchors([3, 3])[0]).length;
  check("a neighbour marked by an earlier unit is not drawn again by the next one", marked === 1 && two.calls.length === 64);

  // the mark never hides objects: an effect on a pre-drawn neighbour cell is still drawn at that cell's turn
  const fx = withUnit((l) => { tankAt(3, 3, 3, 2, 2)(l); l.spawnEffect(0x12, SX + 4, SY + 3); });
  check("an object standing on a pre-drawn neighbour cell is still drawn", px(fx.s, 4, 3) === COLOUR[0x12] && fx.calls.length === 64);

  const claimedCell = makeLayer({ tiles: Array.from({ length: 59 }, () => flatTile), cellFill: 1 });
  tankAt(3, 3, 2, 0, 1)(claimedCell.layer); // facing 2 claims (4,3), the cursor cell for this draw
  const blinkPhase = { value: 0 };
  claimedCell.layer.drawMap(fresh(), SX, SY, { vx: 4, vy: 3, phase: blinkPhase });
  check("a neighbour-claimed cursor cell skips its tile and does not toggle the selection phase ($655E precedes $6570)", blinkPhase.value === 0);
  claimedCell.layer.units.units[0].dx = 0;
  claimedCell.layer.units.units[0].dy = 0;
  claimedCell.layer.drawMap(fresh(), SX, SY, { vx: 4, vy: 3, phase: blinkPhase });
  check("an unclaimed cursor cell toggles its phase once when reached in painter order", blinkPhase.value === 1);

  // enemy ground (flags 3) redraws neighbours (own gate opened by a tank elsewhere); air, ships and effects do not
  const ground = withUnit((l) => { l.units.spawn(9, SX + 7, SY + 7, 1); stubEnemies(l, { ground: [{ ...cell(3, 3), dx: 2, dy: 2, frame: 3 }] }); });
  const gAt = ground.calls.indexOf(anchors([3, 3])[0]);
  check("enemy ground unit with an offset also redraws its neighbours (flag bit 0)", ground.calls.slice(gAt + 1, gAt + 4).join("|") === anchors([4, 3], [3, 4], [4, 4]).join("|") && ground.calls.length === 64);
  const noOnes = withUnit((l) => { l.units.spawn(9, SX + 7, SY + 7, 1); stubEnemies(l, { air: [{ ...cell(3, 3), dx: 2, dy: 2, frame: 3 }], ships: [{ ...cell(2, 5), dx: 2, dy: 2, frame: 3 }] }); l.spawnEffect(0x12, SX + 5, SY + 2); });
  check("enemy air, ships and effects never trigger a neighbour redraw", noOnes.calls.every((c, i) => c === anchors(...PAINTER_CELLS.map((p) => [p.vx, p.vy]))[i]) && noOnes.calls.length === 64);
}

// ---- 8. picking agrees with the sorted list ------------------------------------------------------------------------------------------
{
  const { layer } = makeLayer();
  const tank = layer.units.spawn(9, SX + 3, SY + 3, 1);
  const none = () => pickObject(layer, [], SX, SY, 114, 76, null);
  check("baseline: a tank under the pointer is picked", none()?.kind === "tank" && none().unit === tank);
  // an effect on the earlier cell (2,3) whose 20 x 20 box overlaps the tank's box at the pointer (114, 76)
  layer.spawnEffect(0x12, SX + 2, SY + 3);
  const pk = layer.pickables(SX, SY);
  check("pickables list effects too, in sorted order, kind-tagged (effect on the earlier cell first)", pk.map((p) => p.kind).join() === "effect,tank");
  check("an earlier-sorted effect is an obstacle: the pick scan hits it first and no order target results", none() === null);
  check("direct-cell precedence is kept: with the cell given, the tank on exactly that cell is picked despite the blocker", pickObject(layer, [], SX, SY, 114, 76, { x: SX + 3, y: SY + 3 })?.unit === tank);
  layer.pool.slots[layer.pool.slots.indexOf(layer.pool.records()[0])] = null;
  check("remove the effect: the tank is pickable again", none()?.unit === tank);

  // enemies, alien, meteor as obstacles
  const probe = (setup) => { const { layer: l } = makeLayer(); const t = l.units.spawn(9, SX + 3, SY + 3, 1); setup(l); return { picked: pickObject(l, [], SX, SY, 114, 76, null), t, l }; };
  check("an enemy ground unit sorted earlier blocks the pick", probe((l) => stubEnemies(l, { ground: [cell(2, 3)] })).picked === null);
  check("an enemy aircraft sorted earlier blocks the pick", probe((l) => stubEnemies(l, { air: [cell(2, 3)] })).picked === null);
  check("the alien sorted earlier blocks the pick", probe((l) => { l.apparition = () => ({ type: 19, x: SX + 2, y: SY + 3, frame: 0, dy: 13 }); }).picked === null);
  check("the meteor sorted earlier blocks the pick", probe((l) => { l.meteor = () => ({ type: 21, x: SX + 2, y: SY + 3, frame: 0, lift: 0 }); }).picked === null);
  check("an effect sorted LATER than the tank (cell (4,3)) does not block it", probe((l) => l.spawnEffect(0x12, SX + 4, SY + 3)).picked?.kind === "tank");
  check("an effect on the tank's own cell is listed after it (two-way tie keeps order): the tank still wins", probe((l) => l.spawnEffect(0x12, SX + 3, SY + 3)).picked?.kind === "tank");
  const ship = { type: 12, x: SX + 2, y: SY + 3, dx: 0, dy: 0, dir: 0, hp: 5, mode: 1, tech: 1, targetX: 255, targetY: 255, lift: 0, cls: 1, fuel: 10 };
  const shipProbe = (() => { const { layer: l } = makeLayer(); l.units.spawn(9, SX + 3, SY + 3, 1); stubEnemies(l, { ships: [{ ...cell(2, 3), ref: ship }] }); return pickObject(l, [ship], SX, SY, 114, 76, null); })();
  check("an own ship drawn earlier on an overlapping box is picked as a ship", shipProbe?.kind === "ship" && shipProbe.ship === ship);
  const { layer: ex } = makeLayer();
  ex.units.spawn(9, SX + 3, SY + 3, 1);
  ex.extra.push({ type: 1, x: SX + 2, y: SY + 3 }); // untagged extra without a record: not part of the traced list, never a blocker
  ex.extra.push({ type: 1, x: SX + 6, y: SY + 6, ref: { tag: "x" } });
  check("an untagged extra without a record is skipped by the pick list, one with a record is listed", ex.pickables(SX, SY).map((p) => p.kind).join() === "tank,extra" && pickObject(ex, [], SX, SY, 114, 76, null)?.kind === "tank");
  const { layer: clipped } = makeLayer();
  const edgeUnit = clipped.units.spawn(9, SX + 7, SY + 0, 1);
  edgeUnit.dx = 32; edgeUnit.dir = 0;
  check("the pick list is not filtered by the blit's x clip (the entry is admitted)", clipped.pickables(SX, SY).length === 1 && clipped.pickables(SX, SY)[0].x === 256);
}

// ---- 9. renderer purity ---------------------------------------------------------------------------------------------------------------
{
  const calls = [];
  const { layer, cells } = makeLayer({ tiles: [flatTile], tileCalls: calls, cellFill: 1 });
  const t = layer.units.spawn(9, SX + 3, SY + 3, 1);
  t.dir = 3; t.dx = 2; t.dy = 2;
  layer.spawnEffect(0x12, SX + 4, SY + 4);
  layer.toggleMarker(2, SX + 5, SY + 5);
  stubEnemies(layer, { ground: [cell(1, 1)] });
  layer.apparition = () => ({ type: 19, x: SX + 2, y: SY + 1, frame: 0 });
  const snapshot = () => JSON.stringify({ units: layer.units.units.map((u) => ({ ...u })), slots: layer.pool.slots, markers: layer.markers, clock: [layer.units.clock.sub, layer.units.clock.moveTick], cells: Array.from(cells.slice(0, 2000)), assumed: layer.pool.assumedSlots, extra: layer.extra });
  const before = snapshot();
  const first = fresh();
  layer.drawMap(first, SX, SY);
  const afterFirst = snapshot();
  const callsFirst = calls.slice();
  calls.length = 0;
  const second = fresh();
  layer.drawMap(second, SX, SY);
  check("drawing writes no game state (units, effects, pins, clock, map words, extras)", before === afterFirst && afterFirst === snapshot());
  check("drawing is repeatable: identical pixels and identical tile calls (no mark survives a frame)", first.pixels.every((v, i) => v === second.pixels[i]) && callsFirst.join("|") === calls.join("|") && callsFirst.length === 64);
  check("beginFrame / drawList / admitted / pickables are pure reads too", (() => { layer.beginFrame(SX, SY); layer.drawList(SX, SY); layer.admitted(SX, SY); layer.pickables(SX, SY); return snapshot() === before; })());
  check("two frame passes of the same frame do not share marks", (() => {
    const a = layer.beginFrame(SX, SY);
    const b = layer.beginFrame(SX, SY);
    a.drawAfterCell(fresh(), 3, 3);
    return a.claimed(4, 3) && !b.claimed(4, 3);
  })());
  check("the layer exposes no per-frame mark state (claimed / early moved to FramePass)", layer.claimed === undefined && layer.early === undefined);
}

// ---- 10. effect-pool alloc / expiry on its own (no layer) -------------------------------------------------------------------------------
{
  const pool = new EffectPool();
  check("pool constants: 30 slots, a new effect starts at frame 4", MAX_EFFECTS === 30 && EFFECT_START === 4 && pool.slots.length === 30);
  for (let i = 0; i < 30; i++) pool.spawn(0x12, i, 0);
  check("spawn fills slot 0..29 in order and refuses the 31st", pool.slots.every((s, i) => s.x === i) && pool.spawn(0x12, 99, 0) === false && pool.count === 30);
  pool.slots[7] = null; pool.slots[3] = null;
  check("holes at 3 and 7: the next two spawns take 3 then 7", pool.spawn(0x14, 100, 0, 5) && pool.slots[3].x === 100 && pool.spawn(0x14, 101, 0) && pool.slots[7].x === 101 && pool.count === 30);
  const ids = pool.slots.slice();
  pool.slots[10].frame = 0;
  pool.tick();
  check("tick frees only the expired slot and keeps every other index and object", pool.slots[10] === null && pool.slots.every((s, i) => i === 10 || s === ids[i]) && pool.count === 29);
  check("restore replaces the slots in place and clears the assumption when empty", (() => {
    const arr = pool.slots;
    pool.restore(Array.from({ length: 30 }, () => null), true);
    return pool.slots === arr && pool.count === 0 && pool.assumedSlots === false;
  })());
}

console.log(failed === 0 ? "all draw-list tests passed" : `${failed} draw-list test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
