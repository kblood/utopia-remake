// Focused checks of the type-24 (crusher) continuation: Disk.4 hydration of +$13 (toggle bit 7 + counter) and +$14
// (animation), adoption, and the crusher-specific step of `$11F12` / `$11F42`. Run after `npm run build`.
//
// Expected values are derived from the disassembly of the original (Disk.1 game image), NOT from the port:
//   $1193E: +9 bit 7 set -> return (waiting gate). $11F12: mode 6 -> +D = 0, pick a target ($119AC); mode 1 -> $11F42, +D++ (byte),
//           mode 6 when +D == $50 or +B is negative; any other mode does nothing.
//   $11F42: +B negative -> return BEFORE touching +$13; `bchg #7,$13`: previous bit clear -> return (skip call); set -> counter
//           = (+$13 byte, bit 7 now clear) - 1, below 0 -> 7, stored back (bit 7 stays clear), +$14 = table $12D60[counter];
//           the 8 bytes +0..+7 are saved ($4B6E); add.b offset += velocity, cmp.b against $4C1A[dir]; at a cell centre: target
//           reached -> $1231A; acid tile $61 -> $11ECA; candidates d, +1..+4, +5, +5 of the $4BCA row (d, d+1, d-1, d+2,
//           d-2, d+3, d+3), where d is the direction toward the target; border word $73FF -> $11C5C; blocked unless low byte
//           N-clear after cmpi.b #$88 or bit 10 set. Acid ($11ECA) is decided at the cell centre BEFORE any candidate is looked
//           at; only a death there (and the explosion) reaches $11C5C that way. A border exit reaches $11C5C from the candidate
//           scan, never through $11ECA, so it has no acid explosion.
//   $1228A: bset #6 on the next cell word; building destroyed (btst #2 of the high byte = bit 10, jsr $7124/$12332) BEFORE
//           $122B4 clears bit 6 / flag bit 0 of the cell the unit stands on, sets the next flag byte, stores it in +$16,
//           and writes +$10..+$12 (reverse direction and its neighbours), +5 and the velocity ($4BCA +8/+9).
//   $1231A: only `st.b $B(a6)`. $12322: the last candidate was occupied -> the 8 saved bytes are restored.
//   $11ECA: hp -= byte($13116) + 2 * byte($14592) (byte subtraction, bgt); dead -> $11C5C (+$16 cell released, $142A2--,
//           kills++).

const { prepareDisk4HeadlessEnemies, prepareDisk4ShipLoad } = await import("../dist/game/disk4-load.js");
const { EnemySystem } = await import("../dist/game/enemies.js");
const { CELL_FLAG_BASE, cellFlagIndex, mapIndex } = await import("../dist/game/cell-flags.js");
const { DISK4_HEADER_OFFSET, DISK4_RECORDS_OFFSET, DISK4_RECORD_SIZE, DISK4_SLOT_COUNT } = await import("../dist/data/disk4.js");
const { DISK4_ADDR, DISK4_AREA_A_BASE, DISK4_AREA_B_BASE, DISK4_AREA_A_BYTES, DISK4_AREA_B_BYTES } = await import("../dist/data/disk4-state.js");

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const offA = (addr) => addr - DISK4_AREA_A_BASE;
const offB = (addr) => addr - DISK4_AREA_B_BASE;
const put16 = (b, o, v) => { b[o] = v >> 8; b[o + 1] = v & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

const SECTORS = 1920;
const SLOT = 2;
const A_FIRST = 100;
const B_FIRST = 174;
const STRIDE = 0x1a;
const BLOCKED = 0x1000;
const OCCUPIED = 0x4000;
const ACTIVE = 0x0400;
const FLAG_GROUND = 1;
const recOffset = (i) => DISK4_HEADER_OFFSET + DISK4_RECORDS_OFFSET + i * DISK4_RECORD_SIZE;

function makeImage(fillA, fillB) {
  const img = new Uint8Array(SECTORS * 512);
  for (let k = 0; k < 8; k++) img[DISK4_HEADER_OFFSET + k] = "UTOPSAVE".charCodeAt(k);
  for (let i = 0; i < DISK4_SLOT_COUNT; i++) {
    const name = i === SLOT ? "SYNTH" : "EMPTY";
    for (let k = 0; k < name.length; k++) img[recOffset(i) + k] = name.charCodeAt(k);
  }
  const rec = recOffset(SLOT);
  put16(img, rec + 0x10, A_FIRST); put16(img, rec + 0x12, A_FIRST + 72);
  put16(img, rec + 0x14, B_FIRST); put16(img, rec + 0x16, B_FIRST + 10);
  fillA?.(img.subarray(A_FIRST * 512, A_FIRST * 512 + DISK4_AREA_A_BYTES));
  fillB?.(img.subarray(B_FIRST * 512, B_FIRST * 512 + DISK4_AREA_B_BYTES));
  return img;
}
const request = () => ({ slot: SLOT, scenario: 4, scenarioCount: 10 });
const ptr = (x, y) => CELL_FLAG_BASE + cellFlagIndex(x, y);
const groundAt = (i) => offA(DISK4_ADDR.enemyGround) + i * STRIDE;

// Crusher record. Offsets as in enemies.md section 2: +3/+4 pixel offset, +6/+7 velocity, +B/+C target, +D steps,
// +$10..+$12 recent directions, +$13 toggle|counter, +$14 animation, +$16 flag pointer.
function putCrusher(a, slot, o) {
  const at = groundAt(slot);
  a[at] = 24; a[at + 1] = o.x; a[at + 2] = o.y;
  a[at + 3] = (o.dx ?? 0) & 255; a[at + 4] = (o.dy ?? 0) & 255; a[at + 5] = o.dir ?? 2;
  a[at + 6] = (o.vx ?? 0) & 255; a[at + 7] = (o.vy ?? 0) & 255;
  a[at + 8] = o.hp ?? 20; a[at + 9] = o.mode ?? 1; a[at + 10] = o.tech ?? 0;
  a[at + 0x0b] = o.tx ?? 0xff; a[at + 0x0c] = o.ty ?? 0xff; a[at + 0x0d] = o.steps ?? 0; a[at + 0x0e] = 30; a[at + 0x0f] = 5;
  const recent = o.recent ?? [0xff, 0xff, 0xff];
  a[at + 0x10] = recent[0]; a[at + 0x11] = recent[1]; a[at + 0x12] = recent[2];
  a[at + 0x13] = o.aux ?? 0; a[at + 0x14] = o.anim ?? 0; a[at + 0x15] = 0;
  put32(a, at + 0x16, ptr(o.rx ?? o.x, o.ry ?? o.y));
}

// SYNTHETIC animation table (8 bytes, values 0..2). It is NOT the contents of $12D60: the repository records no values for
// that table (only "8 entries, feeds the sprite's second dimension"), so these numbers are a stand-in with the same shape.
// The optional local-data block at the end checks the real table against BOUNDS ONLY (8 entries, min 0, max 2), never its values.
const TABLE = [1, 1, 2, 2, 1, 1, 0, 0];
const tables = (anim = TABLE) => ({
  spiral: Array.from({ length: 48 }, () => [0, 0]),
  arcs: Array.from({ length: 8 }, () => Array.from({ length: 32 }, () => [0, 0])),
  turn: Array.from({ length: 64 }, (_, k) => { const d = k >> 3, w = k & 7; return d === w ? d : (d + 1) & 7; }),
  crusherAnim: anim,
});

function load(fill, o = {}) {
  const r = prepareDisk4HeadlessEnemies(makeImage(fill, o.fillB), request(), o.tables ?? tables(), { rng: () => 0, ...(o.options ?? {}) }, o.hooks ?? {});
  if (!r.ok) throw new Error(`load failed: ${JSON.stringify(r.error)}`);
  return r.value;
}
const run = (v, n) => { for (let i = 0; i < n; i++) v.enemySystem.pass(v.tanks.clock); };
const mark = (v, x, y) => { v.world.cells[mapIndex(x, y)] |= OCCUPIED; v.world.cellFlags[cellFlagIndex(x, y)] |= FLAG_GROUND; };
const setCell = (v, x, y, word) => { v.world.cells[mapIndex(x, y)] = word; };
const occ = (v, x, y) => (v.world.cells[mapIndex(x, y)] & OCCUPIED) !== 0;
const flg = (v, x, y) => (v.world.cellFlags[cellFlagIndex(x, y)] & FLAG_GROUND) !== 0;
const byte13 = (e) => (e.toggle ? 0x80 : 0) | e.counter;
const setCount = (n) => (b) => put16(b, offB(DISK4_ADDR.countEnemyGround), n);
const ring = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // direction -> cell step

// ---- 1. inert restore: identity, decoded fields, no writes -------------------------------------------------------------
{
  const img = makeImage((a) => {
    putCrusher(a, 7, { x: 10, y: 10, rx: 13, ry: 12, aux: 0x85, anim: 2, dir: 3, dx: 5, dy: -3, vx: 2, vy: 1, steps: 9, tx: 40, ty: 41, mode: 1, tech: 4, recent: [1, 2, 3] });
  }, setCount(1));
  const before = img.slice();
  let rng = 0, hooks = 0, demolish = 0;
  const p = prepareDisk4ShipLoad(img, request(), { rng: () => { rng++; return 0; }, demolishAt: () => demolish++ });
  const cells0 = p.value.world.cells.slice(), flags0 = p.value.world.cellFlags.slice(), state0 = p.value.state.snapshot();
  const raw0 = p.value.enemies.ground[7].sourceRaw.slice();
  const r = EnemySystem.fromRoster(p.value.sim, p.value.tanks, tables(), p.value.enemies, { sound: () => hooks++, explode: () => hooks++ }, p.value.ships);
  check("crusher with toggle|counter $85 and animation 2 is adopted", r.ok);
  const c = p.value.enemies.ground[7];
  check("adoption keeps the roster's object in its fixed slot", r.ok && r.value.groundSlots[7] === c && r.value.groundSlots.filter((e) => e).length === 1 && c.slot === 7);
  check("+$13 is split: bit 7 = toggle, low 7 bits = counter; +$14 = animation", c.toggle === true && c.counter === 5 && c.anim === 2 && c.aux === 0x85 && c.p14 === 2);
  check("all other saved fields survive (cell, reservation, offsets, velocity, steps, target, recent, tech, mode)",
    c.x === 10 && c.y === 10 && c.reserveX === 13 && c.reserveY === 12 && c.dx === 5 && c.dy === -3 && c.dir === 3 && c.vx === 2 && c.vy === 1 &&
    c.steps === 9 && c.targetX === 40 && c.targetY === 41 && c.mode === 1 && c.tech === 4 && sameBytes(c.recent, [1, 2, 3]) && c.waiting === false);
  check("raw record bytes are unchanged", sameBytes(c.sourceRaw, raw0) && c.sourceRaw[0x13] === 0x85 && c.sourceRaw[0x14] === 2);
  check("adoption writes nothing, draws no RNG and calls no hook",
    sameBytes(p.value.world.cells, cells0) && sameBytes(p.value.world.cellFlags, flags0) && sameBytes(p.value.state.snapshot(), state0) && rng === 0 && hooks === 0 && demolish === 0 && sameBytes(img, before));
}

// ---- 2. domain validation: typed, atomic ------------------------------------------------------------------------------
{
  const tryAdopt = (aux, anim, table = TABLE, extra) => {
    const img = makeImage((a) => { putCrusher(a, 4, { x: 10, y: 10, aux, anim }); extra?.(a); }, setCount(1));
    const p = prepareDisk4ShipLoad(img, request());
    const cells0 = p.value.world.cells.slice(), flags0 = p.value.world.cellFlags.slice(), state0 = p.value.state.snapshot();
    const r = EnemySystem.fromRoster(p.value.sim, p.value.tanks, tables(table), p.value.enemies, {}, p.value.ships);
    return { r, p, clean: sameBytes(p.value.world.cells, cells0) && sameBytes(p.value.world.cellFlags, flags0) && sameBytes(p.value.state.snapshot(), state0) };
  };
  for (const [aux, ok] of [[0x00, true], [0x07, true], [0x80, true], [0x87, true], [0x08, false], [0x88, false], [0x7f, false], [0xff, false]]) {
    const t = tryAdopt(aux, 0);
    check(`counter/toggle byte $${aux.toString(16)} ${ok ? "is adopted" : "-> unsupported-state crusher-counter"}`,
      ok ? t.r.ok : (!t.r.ok && t.r.error.code === "unsupported-state" && t.r.error.reason === "crusher-counter" && t.r.error.slot === 4 && t.r.error.list === "enemyGround" && t.clean));
  }
  for (const [anim, ok] of [[0, true], [1, true], [2, true], [3, false], [0x80, false], [0xff, false]]) {
    const t = tryAdopt(0, anim);
    check(`animation byte ${anim} against a table maximum of 2 ${ok ? "is adopted" : "-> unsupported-state crusher-anim"}`,
      ok ? t.r.ok : (!t.r.ok && t.r.error.code === "unsupported-state" && t.r.error.reason === "crusher-anim" && t.r.error.slot === 4 && t.clean));
  }
  check("the animation domain follows the table: a table of zeros only allows 0", tryAdopt(0, 0, Array(8).fill(0)).r.ok && !tryAdopt(0, 1, Array(8).fill(0)).r.ok);
  const both = tryAdopt(0x09, 9);
  check("counter is reported before animation", !both.r.ok && both.r.error.reason === "crusher-counter");
  const second = tryAdopt(0, 0, TABLE, (a) => putCrusher(a, 20, { x: 30, y: 30, aux: 0x09 }));
  check("a valid crusher does not mask a later invalid one (lowest bad slot reported)", !second.r.ok && second.r.error.slot === 20);
  // Atomic: the failed attempt did not mark the roster adopted; once the object is within the domain it can be adopted.
  const bad = tryAdopt(0x09, 0);
  const obj = bad.p.value.enemies.ground[4];
  obj.counter = 3;
  const retry = EnemySystem.fromRoster(bad.p.value.sim, bad.p.value.tanks, tables(), bad.p.value.enemies, {}, bad.p.value.ships);
  check("a refused roster stays adoptable (nothing was marked or installed)", !bad.r.ok && retry.ok);
  // Other kinds of record are not affected by the crusher decoding.
  const w = prepareDisk4ShipLoad(makeImage((a) => { putCrusher(a, 0, { x: 10, y: 10 }); a[groundAt(0)] = 22; a[groundAt(0) + 0x13] = 0xff; a[groundAt(0) + 0x14] = 0xff; }, setCount(1)), request());
  const wk = w.value.enemies.ground[0];
  check("a walker keeps the crusher fields at their defaults (its +$13/+$14 are not a crusher state)", wk.toggle === false && wk.counter === 0 && wk.anim === 0 && wk.aux === 0xff);
}

// ---- 3. phase: toggle skip / step, counter, animation ------------------------------------------------------------------
{
  const v = load((a) => {
    putCrusher(a, 3, { x: 10, y: 10, aux: 0x03, anim: 1, tx: 40, ty: 10 }); // toggle clear, counter 3
    putCrusher(a, 4, { x: 30, y: 30, aux: 0x80, anim: 1, tx: 50, ty: 30 }); // toggle set, counter 0
  }, { fillB: setCount(2) });
  mark(v, 10, 10); mark(v, 30, 30);
  const a = v.enemies.ground[3], b = v.enemies.ground[4];
  run(v, 1);
  check("toggle clear: the first call only sets bit 7 (counter, animation and position unchanged)", a.toggle === true && a.counter === 3 && a.anim === 1 && byte13(a) === 0x83 && a.x === 10 && a.dx === 0 && a.vx === 0 && a.steps === 1);
  check("toggle set: the first call steps (counter 0 -> 7, animation = table[7], bit 7 cleared)", b.toggle === false && b.counter === 7 && b.anim === TABLE[7] && byte13(b) === 0x07);
  run(v, 1);
  check("second call: counter 3 -> 2, animation = table[2], bit 7 cleared", a.toggle === false && a.counter === 2 && a.anim === TABLE[2] && byte13(a) === 0x02);
  check("a step at a cell centre reserves the next cell: velocity from the $4BCA row, +$10..+$12, reservation",
    a.dir === 2 && a.vx === 2 && a.vy === 1 && sameBytes(a.recent, [6, 5, 7]) && a.reserveX === 11 && a.reserveY === 10 && a.x === 10 && a.dx === 0 &&
    occ(v, 11, 10) && flg(v, 11, 10) && !occ(v, 10, 10) && !flg(v, 10, 10));
  run(v, 1);
  check("a skip call leaves the counter and sets bit 7 again", a.toggle === true && a.counter === 2 && a.dx === 0);
  run(v, 1);
  check("the next step moves the pixel offset by the velocity and counts down", a.toggle === false && a.counter === 1 && a.anim === TABLE[1] && a.dx === 2 && a.dy === 1);
  const seen = new Set([a.counter]);
  for (let i = 0; i < 40; i++) { run(v, 2); seen.add(a.counter); }
  check("the counter cycles through 0..7", [0, 1, 2, 3, 4, 5, 6, 7].every((c) => seen.has(c)));
}

// ---- 4. byte-width retargeting: +B negative, +D wraps ------------------------------------------------------------------
{
  const v = load((a) => {
    putCrusher(a, 0, { x: 20, y: 20, aux: 0x81, tx: 0x90, ty: 5, steps: 0x10 });   // +B = $90: negative, but not $FF
    putCrusher(a, 1, { x: 30, y: 40, aux: 0x00, tx: 60, ty: 40, steps: 0xff });    // +D wraps to 0, mode stays 1
    putCrusher(a, 2, { x: 60, y: 60, aux: 0x00, tx: 70, ty: 60, steps: 0x4f });    // +D reaches $50 -> mode 6
    putCrusher(a, 3, { x: 80, y: 20, aux: 0x81, tx: 0xff, ty: 0xff, mode: 2 });    // another mode: the routine does nothing
  }, { fillB: setCount(4) });
  const [n, w, e, o] = [0, 1, 2, 3].map((i) => v.enemies.ground[i]);
  run(v, 1);
  check("+B in $80..$FE counts as no target: no toggle change and no step, +D++, mode 6", n.toggle === true && n.counter === 1 && n.steps === 0x11 && n.mode === 6 && n.x === 20 && n.targetX === 0x90 && n.targetY === 5);
  check("+D is a byte: $FF + 1 wraps to 0 and does not end mode 1", w.steps === 0 && w.mode === 1);
  check("+D reaching $50 ends mode 1", e.steps === 0x50 && e.mode === 6);
  check("a mode other than 1 or 6 is inert", o.mode === 2 && o.toggle === true && o.counter === 1 && o.steps === 0);
  run(v, 1);
  check("mode 6 clears +D and picks a target; without a building the target is $FF/$FF and mode 1", n.steps === 0 && n.mode === 1 && n.targetX === 0xff && n.targetY === 0xff);
}

// ---- 4b. byte-wrapped pixel offsets, negative velocity, and a saved +D above $50 ------------------------------------------
// Expected values come from the trace of $11F88 (add.b offset += velocity) / $11FA0 (cmp.b against $4C1A[dir]): offsets are
// bytes, so the sum wraps at 256 (read back as signed) and a wrapped sum can never equal a step distance by accident.
{
  const v = load((a) => {
    // slot 0: dir 2 (step 16,8), offset (127,127) + velocity (2,1) = (129,128) -> byte (-127,-128); the offset is still between centres
    putCrusher(a, 0, { x: 30, y: 60, dir: 2, dx: 127, dy: 127, vx: 2, vy: 1, aux: 0x80, tx: 90, ty: 60 });
    // slot 1: negative velocity: dir 6, offset (-128,-128) + (-2,-1) = (-130,-129) -> byte (126,127)
    putCrusher(a, 1, { x: 50, y: 60, dir: 6, dx: -128, dy: -128, vx: -2, vy: -1, aux: 0x80, tx: 20, ty: 60 });
    // slot 2: negative velocity without wrapping: dir 6 (step -16,-8), offset (-14,-7) + (-2,-1) = (-16,-8) -> cell change west
    putCrusher(a, 2, { x: 80, y: 60, rx: 79, ry: 60, dir: 6, dx: -14, dy: -7, vx: -2, vy: -1, aux: 0x80, tx: 20, ty: 60, recent: [2, 1, 3] });
  }, { fillB: setCount(3) });
  mark(v, 79, 60);
  const [p, q, m] = [0, 1, 2].map((i) => v.enemies.ground[i]);
  run(v, 1);
  check("byte wrap: (127,127) + (2,1) becomes (-127,-128), not (129,128); no cell change, velocity kept",
    p.dx === -127 && p.dy === -128 && p.x === 30 && p.y === 60 && p.vx === 2 && p.vy === 1 && p.targetX === 90 && p.mode === 1);
  check("byte wrap with negative velocity: (-128,-128) + (-2,-1) becomes (126,127), not (-130,-129)",
    q.dx === 126 && q.dy === 127 && q.x === 50 && q.y === 60 && q.vx === -2 && q.vy === -1 && q.targetX === 20 && q.mode === 1);
  check("negative velocity without wrap: (-14,-7) + (-2,-1) = (-16,-8) reaches the cell to the west and chooses direction 6 again (reserves (79,60) -> (78,60))",
    m.x === 79 && m.y === 60 && m.dx === 0 && m.dy === 0 && m.dir === 6 && m.vx === -2 && m.vy === -1 && m.reserveX === 78 && m.reserveY === 60 && m.mode === 1);
}
{
  // A saved +D above $50 never equals $50 on the way up: it wraps through $FF to 0 first and only then needs another $50 steps
  // ($11F12: addq.b #1,$D(a6); cmpi.b #$50). From $51 that is 175 calls to reach 0 and 255 calls to end the walk.
  const v = load((a) => { putCrusher(a, 0, { x: 10, y: 10, aux: 0x80, tx: 90, ty: 10, steps: 0x51 }); }, { fillB: setCount(1) });
  mark(v, 10, 10);
  const c = v.enemies.ground[0];
  let early = false;
  const at = {};
  for (let n = 1; n <= 255; n++) {
    run(v, 1);
    if (n < 255 && (c.mode !== 1 || c.targetX !== 90)) early = true;
    if (n === 1 || n === 174 || n === 175 || n === 254 || n === 255) at[n] = { steps: c.steps, mode: c.mode };
  }
  check("+D = $51: the first call gives $52 (above $50 does not end the walk)", at[1].steps === 0x52 && at[1].mode === 1);
  check("+D = $51: after 174 calls it is $FF, after 175 it has wrapped to 0, both still mode 1", at[174].steps === 0xff && at[174].mode === 1 && at[175].steps === 0 && at[175].mode === 1);
  check("+D = $51: the walk neither ends nor loses its target before the 255th call ($4F after 254 calls)", !early && at[254].steps === 0x4f && at[254].mode === 1);
  check("+D = $51: the 255th call reaches $50 and goes to mode 6 (the target is not what ended it)", at[255].steps === 0x50 && at[255].mode === 6 && c.targetX === 90);
}

// ---- 5. arrival keeps everything but +B -------------------------------------------------------------------------------
{
  const v = load((a) => {
    // one pixel step from the centre of (11,50): offset (14,7) + velocity (2,1) = (16,8) for direction 2
    putCrusher(a, 0, { x: 10, y: 50, rx: 11, ry: 50, dir: 2, dx: 14, dy: 7, vx: 2, vy: 1, aux: 0x80, anim: 0, tx: 11, ty: 50, recent: [6, 5, 7] });
  }, { fillB: setCount(1) });
  mark(v, 11, 50);
  const c = v.enemies.ground[0];
  run(v, 1);
  check("arrival: only +B becomes $FF (+C, direction, velocity, offset, reservation stay), mode 6 follows in the same call",
    c.x === 11 && c.y === 50 && c.targetX === 0xff && c.targetY === 50 && c.dir === 2 && c.vx === 2 && c.vy === 1 && c.dx === 0 && c.dy === 0 &&
    c.reserveX === 11 && c.reserveY === 50 && c.mode === 6 && c.steps === 1 && sameBytes(c.recent, [6, 5, 7]));
  check("arrival does not release the cell mark", occ(v, 11, 50) && flg(v, 11, 50));
  // The velocity survives, so after the next target the unit first slides on in its old direction (an unreserved cell).
  v.world.objects[1] = 1; v.world.objects[4] = 40; v.world.objects[5] = 50; v.state.setWord(0x142c2, 1);
  run(v, 1);
  check("mode 6 picks the (only) building and goes to mode 1", c.mode === 1 && c.targetX === 40 && c.targetY === 50 && c.steps === 0);
  // A real step is a call in which the toggle goes from set to clear (every second call); count them until the cell changes.
  let real = 0, slid = false, afterFirst = null;
  for (let i = 0; i < 40 && c.x === 11; i++) {
    const was = c.toggle;
    run(v, 1);
    if (was && !c.toggle) {
      real++;
      if (real === 1) afterFirst = { x: c.x, dx: c.dx, dy: c.dy, rx: c.reserveX, o: occ(v, 12, 50), f: flg(v, 12, 50) };
      if (c.x === 11 && c.dx !== 0) slid = true;
    }
  }
  check("the retained velocity moves the pixel offset first: after the 1st real step the offset is (2,1), no cell change, no new reservation",
    slid && afterFirst !== null && afterFirst.x === 11 && afterFirst.dx === 2 && afterFirst.dy === 1 && afterFirst.rx === 11 && !afterFirst.o && !afterFirst.f);
  check("counted: it takes exactly 8 real steps (offset 2,4,..,16 / 1,2,..,8) to arrive in (12,50), a cell it never reserved, then it chooses direction 2 and reserves (13,50)",
    real === 8 && c.x === 12 && c.y === 50 && c.dx === 0 && c.dy === 0 && c.dir === 2 && c.reserveX === 13 && c.reserveY === 50 && occ(v, 13, 50) && flg(v, 13, 50));
  check("the stale reservation of (11,50) is never released: the step clears the marks of the cell it stands on",
    occ(v, 11, 50) && flg(v, 11, 50) && !occ(v, 12, 50) && !flg(v, 12, 50));
}

// ---- 5b. untraced: sliding off the map ------------------------------------------------------------------------------
{
  // the pixel step would end in x = 100, one past the last column
  const v = load((a) => { putCrusher(a, 0, { x: 99, y: 30, dir: 2, dx: 14, dy: 7, vx: 2, vy: 1, aux: 0x80, tx: 99, ty: 40 }); }, { fillB: setCount(1) });
  mark(v, 99, 30);
  const cells0 = v.world.cells.slice();
  run(v, 1);
  // HYPOTHESIS (untraced: the original reads the pad words): a unit that slides off the map counts as leaving it.
  check("[untraced policy] a crusher that slides off the map is removed through the border path and releases its reservation",
    v.enemySystem.groundSlots[0] === null && v.state.word(0x142a2) === 0 && !occ(v, 99, 30) && !flg(v, 99, 30) &&
    cells0.every((w, i) => i === mapIndex(99, 30) || w === v.world.cells[i]));
}

// ---- 6. candidate chain: d+3 repeated, retry vs abandon ---------------------------------------------------------------
{
  const blockAll = (v, x, y, except, tile = 0x10) => { ring.forEach(([dx, dy], d) => { if (!except.includes(d)) setCell(v, x + dx, y + dy, BLOCKED | tile); }); };
  // (a) only d-3 (direction 7) is free: the original repeats d+3 (5) in the last slot and never tries d-3, so the target is abandoned.
  {
    const v = load((a) => { putCrusher(a, 0, { x: 50, y: 50, dir: 2, aux: 0x80, tx: 60, ty: 50 }); }, { fillB: setCount(1) });
    mark(v, 50, 50);
    blockAll(v, 50, 50, [7]);
    const c = v.enemies.ground[0];
    run(v, 1);
    check("d-3 is never tried: with only direction 7 free the crusher stays and abandons the target", c.x === 50 && c.y === 50 && !occ(v, 49, 49) && !flg(v, 49, 49) &&
      c.targetX === 0xff && c.targetY === 50 && c.vx === 0 && c.vy === 0 && c.dir === 2 && occ(v, 50, 50) && c.mode === 6);
  }
  // (b) the repeated d+3 slot: enterable but occupied -> the 8 bytes are restored and the target kept (retry next time).
  {
    const v = load((a) => { putCrusher(a, 0, { x: 50, y: 10, rx: 51, ry: 10, dir: 2, dx: 14, dy: 7, vx: 2, vy: 1, aux: 0x80, tx: 60, ty: 10, recent: [6, 5, 7] }); }, { fillB: setCount(1) });
    mark(v, 51, 10);
    blockAll(v, 51, 10, [5]);         // the unit would stand on (51,10); only d+3 = direction 5 -> (50,11) is open ...
    v.world.cells[mapIndex(50, 11)] |= OCCUPIED; // ... but taken
    // recent directions [6,5,7] would skip 5: clear them so the candidate is considered
    v.enemies.ground[0].recent = [0xff, 0xff, 0xff];
    const c = v.enemies.ground[0];
    run(v, 1);
    check("last candidate occupied: x, y, offset, direction and velocity are restored, the target is kept",
      c.x === 50 && c.y === 10 && c.dx === 14 && c.dy === 7 && c.dir === 2 && c.vx === 2 && c.vy === 1 && c.targetX === 60 && c.targetY === 10 && c.mode === 1);
    check("the restore does not undo the toggle/counter update", c.toggle === false && c.counter === 7 && c.anim === TABLE[7]);
    check("no mark changed", occ(v, 51, 10) && flg(v, 51, 10) && occ(v, 50, 11) && !flg(v, 50, 11) && c.reserveX === 51);
  }
  // (b2) ordering proof for the repeated slot: d+3 (5 -> (50,11)) is occupied AND d-3 (7 -> (50,9)) is free. Slots 0..4 are blocked.
  // If the last slot tried d-3 (the shared default), the crusher would claim (50,9) and turn to direction 7. Because the original repeats
  // d+3, the last attempt meets the occupied cell again, so the 8 bytes are restored and nothing is claimed. This is what separates
  // "slot 5 = d+3, slot 6 = d+3" from "d+3 tried once, then d-3". ((b) with d-3 blocked only shows that the last slot is not a blocked d-3 -
  // that would abandon; it cannot show that d-3 is never entered. (a) shows the same with d+3 blocked.) The identical outcome of the two
  // d+3 attempts cannot be told apart from a single attempt by any observable state; only the absence of a d-3 claim is observable.
  {
    const v = load((a) => { putCrusher(a, 0, { x: 50, y: 10, rx: 51, ry: 10, dir: 2, dx: 14, dy: 7, vx: 2, vy: 1, aux: 0x80, tx: 60, ty: 10, recent: [0xff, 0xff, 0xff] }); }, { fillB: setCount(1) });
    mark(v, 51, 10);
    blockAll(v, 51, 10, [5, 7]);
    v.world.cells[mapIndex(50, 11)] |= OCCUPIED;
    const c = v.enemies.ground[0];
    run(v, 1);
    check("d+3 occupied with d-3 free: d-3 is never tried (nothing claimed at (50,9)), the 8 bytes are restored and the target kept",
      !occ(v, 50, 9) && !flg(v, 50, 9) && c.x === 50 && c.y === 10 && c.dx === 14 && c.dy === 7 && c.dir === 2 && c.vx === 2 && c.vy === 1 &&
      c.targetX === 60 && c.targetY === 10 && c.mode === 1 && c.reserveX === 51 && c.reserveY === 10);
  }
  // (b3) counterpart: d+3 free (and d-3 free) -> it is taken in the first d+3 slot.
  {
    const v = load((a) => { putCrusher(a, 0, { x: 50, y: 10, rx: 51, ry: 10, dir: 2, dx: 14, dy: 7, vx: 2, vy: 1, aux: 0x80, tx: 60, ty: 10, recent: [0xff, 0xff, 0xff] }); }, { fillB: setCount(1) });
    mark(v, 51, 10);
    blockAll(v, 51, 10, [5, 7]);
    const c = v.enemies.ground[0];
    run(v, 1);
    check("d+3 free: it is taken (direction 5 -> (50,11)), d-3 stays untouched", c.dir === 5 && c.reserveX === 50 && c.reserveY === 11 && occ(v, 50, 11) && !occ(v, 50, 9));
  }
  // (c) the repeated slot, blocked instead of occupied: abandon.
  {
    const v = load((a) => { putCrusher(a, 0, { x: 50, y: 10, rx: 51, ry: 10, dir: 2, dx: 14, dy: 7, vx: 2, vy: 1, aux: 0x80, tx: 60, ty: 10 }); }, { fillB: setCount(1) });
    mark(v, 51, 10);
    blockAll(v, 51, 10, []);
    const c = v.enemies.ground[0];
    run(v, 1);
    check("every candidate blocked: the cell change stays (x = 51) and only +B becomes $FF", c.x === 51 && c.dx === 0 && c.targetX === 0xff && c.targetY === 10 && c.vx === 2 && c.vy === 1 && c.mode === 6);
  }
  // (d) a candidate listed in +$10..+$12 is skipped; if it is the last slot the order ends.
  {
    const v = load((a) => { putCrusher(a, 0, { x: 50, y: 50, dir: 2, aux: 0x80, tx: 60, ty: 50, recent: [2, 0xff, 0xff] }); }, { fillB: setCount(1) });
    mark(v, 50, 50);
    const c = v.enemies.ground[0];
    run(v, 1);
    check("the straight way is skipped when it is a recent direction: d+1 (3) is taken", c.dir === 3 && c.reserveX === 51 && c.reserveY === 51);
  }
}

// ---- 7. occupancy and building destruction ordering --------------------------------------------------------------------
{
  // The demolishAt option below is a RECORDING hook: it observes the state at the moment of the call. The real removal of the
  // world object (Builder.demolish, wired by MapScene) needs the disk's flag table and weights and is NOT exercised here, so
  // this block proves only the call (once, with the cell, at the traced point, with `Sim.bomb`'s damage counter), not that an
  // object record is removed.
  const log = [];
  let V = null;
  const v = load((a) => {
    putCrusher(a, 0, { x: 70, y: 20, dir: 7, vx: 0, vy: 0, aux: 0x80, tx: 90, ty: 20, recent: [5, 4, 6] });   // building to the east
    putCrusher(a, 1, { x: 70, y: 40, dir: 7, aux: 0x80, tx: 90, ty: 40 });                                    // blocked, not active
    putCrusher(a, 2, { x: 70, y: 60, dir: 7, aux: 0x80, tx: 90, ty: 60 });                                    // rock (low byte >= $88)
    putCrusher(a, 3, { x: 70, y: 10, dir: 7, aux: 0x80, tx: 90, ty: 10 });                                    // low byte $05 (cmpi.b/bpl wrap)
  }, {
    fillB: setCount(4),
    options: {
      demolishAt: (x, y) => {
        const c = V.enemies.ground[0];
        log.push({
          x, y,
          nextOcc: occ(V, 71, 20), nextFlag: flg(V, 71, 20), oldOcc: occ(V, 70, 20), oldFlag: flg(V, 70, 20),
          dir: c.dir, vx: c.vx, vy: c.vy, rx: c.reserveX, ry: c.reserveY, recent: [...c.recent], px: c.x, py: c.y,
        });
      },
    },
  });
  V = v;
  for (const [x, y] of [[70, 20], [70, 40], [70, 60], [70, 10]]) mark(v, x, y);
  setCell(v, 71, 20, BLOCKED | ACTIVE | 0x20);
  setCell(v, 71, 40, BLOCKED | 0x20);
  setCell(v, 71, 60, BLOCKED | 0x90);
  setCell(v, 71, 10, BLOCKED | 0x05);
  const [b, k, r, q] = [0, 1, 2, 3].map((i) => v.enemies.ground[i]);
  const bombs0 = v.state.word(0x1346a);
  run(v, 1);
  check("an active building under the next cell is destroyed once", log.length === 1 && log[0].x === 71 && log[0].y === 20 && v.state.word(0x1346a) === bombs0 + 1);
  const L = log[0];
  check("destruction runs after the next cell's occupancy bit and before anything else moves (old marks, reservation, recent, direction, velocity)",
    L.nextOcc === true && L.nextFlag === false && L.oldOcc === true && L.oldFlag === true && L.rx === 70 && L.ry === 20 && L.dir === 7 && L.vx === 0 && L.vy === 0 &&
    sameBytes(L.recent, [5, 4, 6]) && L.px === 70 && L.py === 20);
  check("after the step: old marks cleared, next flag set, reservation (71,20), recent [6,5,7], direction 2, velocity (2,1)",
    !occ(v, 70, 20) && !flg(v, 70, 20) && occ(v, 71, 20) && flg(v, 71, 20) && b.reserveX === 71 && b.reserveY === 20 && sameBytes(b.recent, [6, 5, 7]) && b.dir === 2 && b.vx === 2 && b.vy === 1);
  check("a blocked, non-active building is not crossed: the next candidate (d+1) is taken and nothing is bombed", k.dir === 3 && k.reserveX === 71 && k.reserveY === 41 && log.length === 1);
  check("a rock (low byte >= $88) is crossed without destroying anything", r.dir === 2 && r.reserveX === 71 && r.reserveY === 60 && log.length === 1);
  check("low byte $05 passes cmpi.b #$88 / bpl by wrap-around and is crossed", q.dir === 2 && q.reserveX === 71 && q.reserveY === 10 && log.length === 1);
}

// ---- 8. acid, death, border, reservation ------------------------------------------------------------------------------
{
  const explosions = [];
  const v = load((a) => {
    putCrusher(a, 0, { x: 20, y: 70, rx: 21, ry: 70, hp: 5, dir: 2, aux: 0x80, tx: 30, ty: 70 });   // dies: 5 - (3 + 2*1) = 0
    putCrusher(a, 1, { x: 20, y: 60, hp: 6, dir: 2, aux: 0x80, tx: 30, ty: 60 });                     // survives with 1
    putCrusher(a, 2, { x: 20, y: 72, hp: 3, dir: 2, aux: 0x80, tx: 20, ty: 72 });                     // on the target: arrival comes first
  }, { fillB: setCount(3), hooks: { explode: (x, y, lift, high) => explosions.push({ x, y, lift, high }) } });
  v.state.setByte(0x13116, 3); v.state.setByte(0x14592, 1);
  for (const [x, y] of [[20, 70], [21, 70], [20, 60], [20, 72]]) mark(v, x, y);
  for (const [x, y] of [[20, 70], [20, 60], [20, 72]]) v.world.cells[mapIndex(x, y)] |= 0x61;
  const kills0 = v.state.long(0x14298);
  const [d, s, t] = [0, 1, 2].map((i) => v.enemies.ground[i]);
  run(v, 1);
  check("acid: hp -= $13116 + 2 * $14592 (byte arithmetic), hp <= 0 destroys the crusher", v.enemySystem.groundSlots[0] === null && v.enemies.ground[0] === null);
  check("death: the slot is freed in place (survivors keep their slots), counters and kills updated, one explosion", v.enemySystem.groundSlots[1] === s && v.enemySystem.groundSlots[2] === t &&
    v.state.word(0x142a2) === 2 && v.state.long(0x14298) === kills0 + 1 && explosions.length === 1 && explosions[0].x === 20 && explosions[0].y === 70 && explosions[0].high === true);
  check("death releases the cell the +$16 pointer names (21,70), not the cell it stands on (20,70)", !occ(v, 21, 70) && !flg(v, 21, 70) && occ(v, 20, 70) && flg(v, 20, 70));
  check("a surviving crusher keeps the reduced hp and still moves on", s.hp === 1 && s.reserveX === 21 && s.reserveY === 60 && s.dir === 2);
  check("the target cell is not checked for acid: arrival comes first", t.hp === 3 && t.targetX === 0xff && t.targetY === 72);
}
{
  const explosions = [];
  const v = load((a) => { putCrusher(a, 0, { x: 0, y: 10, dir: 4, aux: 0x80, tx: 0, ty: 40 }); }, { fillB: setCount(1), hooks: { explode: () => explosions.push(1) } });
  mark(v, 0, 10);
  setCell(v, 0, 11, BLOCKED | 0x10); // the straight way (south) is blocked, the next candidate (d+1 = 5) is off the map
  const kills0 = v.state.long(0x14298);
  run(v, 1);
  check("border: an off-map candidate destroys the crusher without an explosion, kills++, count--, reservation released",
    v.enemySystem.groundSlots[0] === null && explosions.length === 0 && v.state.long(0x14298) === kills0 + 1 && v.state.word(0x142a2) === 0 && !occ(v, 0, 10) && !flg(v, 0, 10));
}

// ---- 9. waiting gate and fresh spawn -----------------------------------------------------------------------------------
{
  const v = load((a) => { putCrusher(a, 0, { x: 10, y: 10, mode: 0x81, aux: 0x80, tx: 40, ty: 10 }); }, { fillB: (b) => { setCount(1)(b); b[offB(0x144c9)] = 3; } });
  mark(v, 10, 10);
  const c = v.enemies.ground[0];
  check("a saved +9 bit 7 is the waiting flag and the mode keeps its low bits", c.waiting === true && c.mode === 1 && c.savedControl === 0x81);
  run(v, 1);
  check("waiting and no enemy tick: the pass does not touch it", c.waiting === true && c.toggle === true && c.counter === 0 && c.steps === 0);
  v.tanks.clock.advance();
  run(v, 1);
  check("at the enemy tick the waiting bit is cleared and the saved toggle steps", c.waiting === false && c.toggle === false && c.counter === 7 && c.steps === 1);
}
{
  const v = load(() => {});
  const sys = v.enemySystem;
  const entry = [24, 40, 0, 0, 1, 0x82, 1, 0];
  check("spawn: a crusher takes +$13 = e[5] (toggle $80, counter 2) and +$14 = e[6]", sys.spawn({ air: false, type: 24, x: 30, y: 30, dir: 2, entry }) &&
    sys.groundSlots[0].toggle === true && sys.groundSlots[0].counter === 2 && sys.groundSlots[0].anim === 1 && sys.groundSlots[0].aux === 0x82);
  check("spawn: a walker with the same entry has no crusher state", sys.spawn({ air: false, type: 22, x: 32, y: 30, dir: 2, entry }) &&
    sys.groundSlots[1].toggle === false && sys.groundSlots[1].counter === 0 && sys.groundSlots[1].anim === 0);
}

// ---- 10. optional: the player's local files ------------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
  const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
  if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
    console.log("skip local checks: original/utopia-whdload/Disk.1 or Disk.2 not found");
  } else {
    const { loadCombatTables } = await import("../dist/data/combat.js");
    const { readScenarioRecords } = await import("../dist/data/scenario.js");
    const { loadSprites } = await import("../dist/data/sprites.js");
    const disk1 = new Uint8Array(fs.readFileSync(d1));
    const disk2 = new Uint8Array(fs.readFileSync(d2));
    const real = loadCombatTables(disk1);
    // Bounds only: the exact byte values of $12D60 are not recorded in the repository or the notes, so none are asserted.
    check("local Disk.1 [bounds only, values not asserted]: the crusher animation table has 8 entries with minimum 0 and maximum 2 (the sprite sets hold three frame sets)", real.crusherAnim.length === 8 && Math.max(...real.crusherAnim) === 2 && Math.min(...real.crusherAnim) === 0);
    const records = readScenarioRecords(disk2);
    const withCrusher = records.map((rec, i) => (loadSprites(disk1, disk2, rec).has(24) ? i : -1)).filter((i) => i >= 0);
    check("local Disk.2: scenarios whose sprite set has the crusher (type 24) are 3, 5, 7, 8 and 9", withCrusher.join() === "3,5,7,8,9");
    const accepted = (anim) => {
      const img = makeImage((a) => putCrusher(a, 0, { x: 10, y: 10, aux: 0x02, anim }), setCount(1));
      return prepareDisk4HeadlessEnemies(img, request(), real).ok;
    };
    check("local table: animation 0..2 is adopted, 3 is refused", accepted(0) && accepted(2) && !accepted(3));
    if (withCrusher.length > 0) {
      const sprites = loadSprites(disk1, disk2, records[withCrusher[0]]);
      const img = makeImage((a) => putCrusher(a, 0, { x: 10, y: 10, dir: 5, aux: 0x82, anim: 2 }), setCount(1));
      const r = prepareDisk4HeadlessEnemies(img, request(), real);
      const d = r.ok ? r.value.enemySystem.drawables().find((x) => x.type === 24) : null;
      check(`scenario ${withCrusher[0]} sprite set draws the adopted crusher (frame ${d?.frame}, animation ${d?.anim})`, d !== undefined && d !== null && d.anim === 2 && d.frame === 5 && sprites.frame(24, d.frame, d.anim) !== null);
    }
  }
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall disk4-crusher checks passed");
