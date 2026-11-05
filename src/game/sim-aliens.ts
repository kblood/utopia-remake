// The alien side: appearance (event 1), meteor (event 8 and its impact $11676), attack waves (event 9 $11724, the
// per-pass spawner $1187C), intelligence reports (events 13 $ADA6 and 3 $12A16, daily $AF12, $B018), the weekly
// fleet-versus-alien battle $127A0, tank defection (event 17 $11566). No graphics: hooks and Sim.events only.
// The alien record at $13456, the 16 spawn groups at $135C6 (stride $92) and all intelligence tables live in the
// scenario block of GameState and are read from there. Notes: notes/formats/sim-port.md.

import { MAP_WIDTH, MAP_HEIGHT, TILE_ID_MASK } from "../data/scenario.js";
import { divsQ, divuQ, mulu, s16, s8 } from "./sim-math.js";
import { SYS } from "./sim.js";
import type { Sim } from "./sim.js";

const REC = 0x13456; // alien record: +$10 min strength, +$11 level, +$14 age (word), +$18 strength, +$19..+$1F rates
const GROUPS = 0x135c6; // 16 groups: +0..+$F eight spawn cells (x, y), +$10 queue of 32 longs, +$90 count, +$91 direction
const GROUP_SIZE = 0x92;
const WAVES = REC + 0x20; // per alien level 8 entries x 8 bytes (64 bytes per level)
const FRONT = 0x14274; // 8 longs: own units that left the map, per type 9..16
const LOST = 0x14294;
const SLOTS = 0x1447c; // 16 pairs (countdown, value): the intelligence ticker shown on the defence screen
const INTEL_LEVEL = 0x144ca;
const FUNDS = 0x1446a;

const bytesLeft = (r: number, limit: number): boolean => ((r - limit) & 0x80) !== 0; // cmp.b: r < limit as signed bytes

export interface EnemySpawn {
  air: boolean; // type >= $19 spawns in the air layer
  type: number; // entry byte +0
  x: number;
  y: number;
  dir: number; // group byte +$91
  entry: number[]; // the 8 wave-entry bytes (hit points +1, +3 -> $F, +4 count, +5 -> $13, +6/+7 -> $E/$14)
}

export class Aliens {
  // $144A8 alien sprite (type 19) and $1449C meteor (type 21, timer in +6).
  alien: { x: number; y: number } | null = null;
  meteor: { x: number; y: number; timer: number } | null = null;
  private groupIndex = 0; // $156B2
  private cursor = 0x80; // $12A94

  constructor(private readonly sim: Sim) {
    // $6EFC: the builder keeps up to 10 marker-tile ($7F) cells in $14524 / $144A6.
    const s = sim.state;
    if (s.word(0x144a6) === 0) {
      let n = 0;
      for (let y = 0; y < MAP_HEIGHT && n < 10; y++) {
        for (let x = 0; x < MAP_WIDTH && n < 10; x++) {
          if ((sim.world.cells[y * MAP_WIDTH + x] & TILE_ID_MASK) !== 0x7f) continue;
          s.setByte(0x14524 + 2 * n, x);
          s.setByte(0x14525 + 2 * n, y);
          n++;
        }
      }
      s.setWord(0x144a6, n);
    }
  }

  private get s() {
    return this.sim.state;
  }

  // Write a ticker pair (countdown 6, value) and announce an intelligence report (message $157).
  private report(addr: number, value: number, silent = false): void {
    this.s.setByte(addr, 6);
    this.s.setByte(addr + 1, value);
    this.sim.events.push({ kind: "intel", slot: addr, value });
    if (!silent) this.sim.msg(0x157);
  }

  private clampMax(v: number, cap: number): number {
    return bytesLeft(v, cap) ? v & 0xff : cap;
  }
  private clampMin(v: number, min: number): number {
    return bytesLeft(v, min) ? min : v & 0xff;
  }

  // ---- event 1: an alien object shows up at a marker cell ($1146A) ----------------------------

  eventAlienAppears(chance: number): void {
    const s = this.s;
    if (this.sim.roll(100) >= chance) return;
    this.alien = null; // clr.b $144A8
    const n = s.word(0x144a6);
    if (n === 0) return;
    const i = this.sim.roll(n);
    this.alien = { x: s.byte(0x14524 + 2 * i), y: s.byte(0x14525 + 2 * i) };
    this.sim.effect("alienAppear", this.alien.x, this.alien.y);
  }

  // ---- event 8 and the meteor ($1160E, $11676) --------------------------------------------------

  // From year 3 on (word compare, always true with the calendar), unless invention bit 8 is known and no meteor
  // is on its way: the meteor falls on a random building cell and hits after 30 main-loop passes.
  eventMeteor(chance: number): void {
    const s = this.s;
    const sim = this.sim;
    if (s16(s.long(0x142a6) & 0xffff) < 3) return;
    if (sim.roll(100) >= chance) return;
    if (s.long(0x14472) & 0x100) return;
    if (this.meteor) return;
    const spot = sim.randomBuilding();
    if (!spot) return;
    sim.effect("focus", spot[0], spot[1]);
    this.meteor = { x: spot[0], y: spot[1], timer: 0x78 };
    sim.effect("meteorFall", spot[0], spot[1]);
    sim.msg(0x182);
  }

  // Call once per main-loop pass (not while paused): timer -4, impact at 0 ($3626-$3640).
  meteorStep(): void {
    const m = this.meteor;
    if (!m) return;
    m.timer = (m.timer - 4) & 0xff;
    if (m.timer !== 0) return;
    this.meteor = null;
    this.impact(m.x, m.y);
  }

  // $11676: cells within 2 of the impact that carry the building flag $0400 are bombed ($12332); when anything was
  // hit the morale drops by 1000.
  private impact(x: number, y: number): void {
    const sim = this.sim;
    const before = this.s.word(0x1346a);
    sim.effect("meteorImpact", x, y);
    for (let cy = y - 2; cy <= y + 2; cy++) {
      for (let cx = x - 2; cx <= x + 2; cx++) {
        if (cx < 0 || cy < 0 || cx >= MAP_WIDTH || cy >= MAP_HEIGHT) continue;
        if (sim.world.cells[cy * MAP_WIDTH + cx] & 0x0400) sim.bomb(cx, cy);
      }
    }
    if (this.s.word(0x1346a) !== before) sim.applyMorale(-1000);
  }

  // ---- event 17: the first own tank defects ($11566) ---------------------------------------------

  eventTankDefect(chance: number): void {
    const s = this.s;
    const sim = this.sim;
    if (sim.roll(100) >= chance) return;
    if (s.word(0x1429c) === 0) return;
    if (s.word(0x142a2) === 0x3c) return;
    const unit = sim.defectUnit();
    if (!unit) return;
    s.setWord(0x142a2, s.word(0x142a2) + 1);
    s.setWord(0x1429c, s.word(0x1429c) - 1);
    if (unit.x >= 0) sim.effect("focus", unit.x, unit.y);
    sim.msg(0x181);
  }

  // $3C54: a ground unit walks off the map and joins the front ($14274 + 4 * (type - 9)); $4692 takes it out
  // of the home counts and costs 50 morale.
  sendToFront(type: number): void {
    const s = this.s;
    const addr = FRONT + 4 * (type - 9);
    s.setLong(addr, s.long(addr) + 1);
    s.setWord(0x1429c, s.word(0x1429c) - 1);
    const home = 0x14254 + 4 * (type - 9);
    s.setLong(home, s.long(home) - 1);
    this.sim.applyMorale(-50);
  }

  // ---- attack waves: event 9 ($11724) -------------------------------------------------------------

  // $B018: a countdown ($141B2, scenario data) that gates the attacks; reports at 6 and 1 days left.
  intelCountdown(): void {
    const s = this.s;
    let d0 = s.byte(0x141b2);
    if (d0 === 0) return;
    d0--;
    s.setByte(0x141b2, d0);
    let table: number;
    let slot: number;
    if (d0 === 0) {
      table = 0x14036;
      slot = 0x1448c;
    } else if (d0 === 6) {
      table = 0x1400c;
      slot = 0x1448a;
    } else return;
    const lvl = s.byte(INTEL_LEVEL);
    if (lvl === 0) return;
    const r = this.sim.roll(100);
    if (!bytesLeft(r, s.byte(table + lvl - 1))) return;
    this.report(slot, lvl - 1);
  }

  eventWave(): void {
    const s = this.s;
    const sim = this.sim;
    if (sim.sysFlags & SYS.noUnitBonus) return;
    this.intelCountdown();
    if (s.byte(0x141b2) !== 0) return;
    if (sim.sysFlags & SYS.attackPending) {
      sim.sysFlags &= ~SYS.attackPending;
      return this.launchWave();
    }
    // strength decays towards its minimum; the roll against it announces an attack
    const strength = this.clampMin((s.byte(REC + 0x18) - s.byte(REC + 0x1d)) & 0xff, s.byte(REC + 0x10));
    s.setByte(REC + 0x18, strength);
    if (!bytesLeft(sim.roll(100), strength)) return;
    const lvl = s.byte(INTEL_LEVEL);
    if (lvl !== 0) {
      const r = sim.roll(100);
      if (!bytesLeft(r - s.byte(0x14060 + lvl - 1), 0)) return; // intelligence only passes some warnings
      s.setByte(0x1448e, 6);
      s.setByte(0x1448f, lvl - 1);
      sim.events.push({ kind: "intel", slot: 0x1448e, value: lvl - 1 });
      sim.msg(0x8d);
    }
    sim.sysFlags |= SYS.attackPending;
    const after = (s.byte(REC + 0x18) - s.byte(REC + 0x1f)) & 0xff;
    s.setByte(REC + 0x18, this.clampMin(after, s.byte(REC + 0x10)));
  }

  // $117EE: queue copies of the wave entries of the alien's level into a random spawn group.
  private launchWave(): void {
    const s = this.s;
    const sim = this.sim;
    const group = GROUPS + sim.roll(16) * GROUP_SIZE;
    let count = s8(s.byte(group + 0x90));
    if (count === 0x20) return;
    const level = s.byte(REC + 0x11);
    const row = WAVES + (((level - 1) << 6) & 0xffff);
    const end = row + 0x40;
    let entry = row + sim.roll(8) * 8;
    for (let k = 0; k < 8; k++) {
      const type = s.byte(entry);
      if (type !== 0) {
        let n = sim.roll(2) !== 0 ? -2 : 2;
        n = s8(n + s.byte(entry + 4));
        for (let i = 0; i < n; i++) {
          let at = group + 0x10;
          while (s.long(at) !== 0) at += 4;
          s.setLong(at, entry);
          count++;
          s.setByte(group + 0x90, s.byte(group + 0x90) + 1);
          if (count === 0x20) return;
        }
      }
      entry += 8;
      if (entry === end) entry = row;
    }
  }

  // $1187C, once per main-loop pass: the next group (round robin over 16) tries up to six queued entries and puts
  // them on free cells of its spawn list. Ground entries (type < $19) need a cell without unit/blocked flags,
  // air entries a cell without the air flag; `spawnEnemy` creates the unit (returns false when its list is full).
  spawnStep(): void {
    const s = this.s;
    const sim = this.sim;
    const cells = sim.world.cells;
    const group = GROUPS + this.groupIndex * GROUP_SIZE;
    if (s.byte(group + 0x90) !== 0) {
      let cursor = this.cursor;
      const dir = s.byte(group + 0x91);
      let tries = 6;
      let done = false;
      while (tries-- > 0 && !done) {
        cursor -= 0x14;
        if (cursor < 0) cursor += 0x80;
        const entry = s.long(group + 0x10 + cursor);
        if (entry === 0) continue;
        const type = s.byte(entry);
        const air = type >= 0x19;
        let spawned = false;
        let failed = false;
        for (let c = 0; c < 8 && !spawned && !failed; c++) {
          const x = s.byte(group + 2 * c);
          const y = s.byte(group + 2 * c + 1);
          const idx = y * MAP_WIDTH + x;
          const w = cells[idx];
          if (air ? (w & 0x2000) !== 0 : (w & 0x5000) !== 0) continue;
          const bytes: number[] = [];
          for (let i = 0; i < 8; i++) bytes.push(s.byte(entry + i));
          if (!sim.spawnEnemy({ air, type, x, y, dir, entry: bytes })) {
            failed = true;
            break;
          }
          cells[idx] |= air ? 0x2000 : 0x4000;
          const counter = air ? 0x142a4 : 0x142a2;
          s.setWord(counter, s.word(counter) + 1);
          spawned = true;
        }
        if (spawned) {
          s.setLong(group + 0x10 + cursor, 0);
          s.setByte(group + 0x90, s.byte(group + 0x90) - 1);
          if (s.byte(group + 0x90) === 0) done = true;
        }
      }
      this.cursor = cursor;
    }
    this.groupIndex = (this.groupIndex + 1) & 15;
  }

  // ---- intelligence ------------------------------------------------------------------------------

  // $AD70: intelligence level from the funds sent to Earth's agents ($1446A).
  private updateIntelLevel(): void {
    const s = this.s;
    if (this.sim.sysFlags & SYS.noUnitBonus) return;
    const funds = s.signedLong(FUNDS);
    let lvl = 3;
    if (funds - 20000 < 0) {
      lvl = 2;
      if (funds - 5000 < 0) {
        lvl = 1;
        if (funds === 0) lvl = 0;
      }
    }
    s.setByte(INTEL_LEVEL, lvl);
  }

  // Event 13 ($ADA6, once a month): the funds decay, the level is recomputed, the ticker counts down, and one of
  // five reports (each one-shot, flagged by the first byte of its table at $13EE6 + $2A * k) may come in.
  eventIntelStep(): void {
    const s = this.s;
    const sim = this.sim;
    if (sim.sysFlags & SYS.noUnitBonus) return;
    let funds = s.signedLong(FUNDS);
    const level = s.byte(INTEL_LEVEL);
    if (level !== 0) {
      funds -= level === 1 ? 200 : level === 2 ? 600 : 1000;
      if (funds < 0) funds = 0;
    }
    s.setLong(FUNDS, funds);
    this.updateIntelLevel();
    for (let i = 0; i < 16; i++) {
      const a = SLOTS + 2 * i;
      if (s8(s.byte(a)) <= 0) continue;
      s.setByte(a, s.byte(a) - 1);
      if (s.byte(a) === 0 && s8(s.byte(a + 1)) < 0) s.setByte(a, 0xff);
    }
    const lvl = s.byte(INTEL_LEVEL);
    if (lvl === 0) return;
    const idx = lvl - 1;
    const stages = [
      { base: 0x13ee6, slot: SLOTS },
      { base: 0x13f10, slot: SLOTS + 2 },
      { base: 0x13f3a, slot: SLOTS + 4 },
      { base: 0x13f64, slot: SLOTS + 6 },
    ];
    for (let k = 0; k < stages.length; k++) {
      const { base, slot } = stages[k];
      if (s8(s.byte(base)) < 0) continue; // already reported
      if (!bytesLeft(sim.roll(100), s.byte(base + idx))) return;
      this.report(slot, k === 0 ? idx : idx | 0x80);
      s.setByte(base, 0xff);
      return;
    }
    // last stage ($AEAC): repeatable; the alien grows stronger by +$19
    if (!bytesLeft(sim.roll(100), s.byte(0x141b3))) return;
    const base = 0x13fb8 + 0x2a;
    if (!bytesLeft(sim.roll(100), s.byte(base + idx))) return;
    s.setByte(SLOTS + 12, 6);
    s.setByte(SLOTS + 13, idx);
    sim.events.push({ kind: "intel", slot: SLOTS + 12, value: idx });
    s.setByte(REC + 0x18, this.clampMax((s.byte(REC + 0x19) + s.byte(REC + 0x18)) & 0xff, s.byte(REC + 0x1e)));
    sim.msg(0x157);
  }

  // $AF12 (daily, every 10th call): the alien ages; its level follows age / 100 + 1 (max 5). A level rise or fall
  // moves its strength by +$1B / -$1C within [+$10, +$1E] and may produce a report.
  dailyIntel(): void {
    const s = this.s;
    const sim = this.sim;
    if (sim.sysFlags & SYS.noUnitBonus) return;
    let d0 = (s.byte(0x144c0) + 1) & 0xff;
    if (d0 !== 10) {
      s.setByte(0x144c0, d0);
      return;
    }
    d0 = 0;
    const age = (s.word(REC + 0x14) + 1) & 0xffff;
    s.setWord(REC + 0x14, age);
    const old = s.byte(REC + 0x11);
    let level = (divuQ(age, 100) + 1) & 0xff;
    if (s8(level - 6) >= 0) level = 5;
    s.setByte(REC + 0x11, level);
    s.setByte(0x144c0, 0);
    if (level === old) return;
    const lvl = s.byte(INTEL_LEVEL);
    if (s8(level - old) > 0) {
      s.setByte(REC + 0x18, this.clampMax((s.byte(REC + 0x1b) + s.byte(REC + 0x18)) & 0xff, s.byte(REC + 0x1e)));
      if (lvl === 0) return;
      if (s8(s.byte(0x13f10)) >= 0) return;
      if (!bytesLeft(sim.roll(100), s.byte(0x13f8e + lvl - 1))) return;
      this.report(0x14484, lvl - 1);
      return;
    }
    s.setByte(REC + 0x18, this.clampMin((s.byte(REC + 0x18) - s.byte(REC + 0x1c)) & 0xff, s.byte(REC + 0x10)));
    if (lvl === 0) return;
    if (!bytesLeft(sim.roll(100), s.byte(0x14108 + lvl - 1))) return;
    this.report(0x14496, lvl - 1);
  }

  // Event 3 ($12A16): after four battles the accumulated tally $1446E selects a report table; then the tallies reset.
  eventBattleReport(): void {
    const s = this.s;
    const sim = this.sim;
    if (s.byte(0x144cb) === 4) {
      let table = 0x140de;
      let slot = 0x14494;
      const tally = s.long(0x1446e);
      let skip = tally === 0;
      if (!skip && s16(tally) >= 0x64) {
        if (s16(tally) < 0xaa) skip = true;
        else {
          table = 0x1408a;
          slot = 0x14490;
        }
      }
      const lvl = s.byte(INTEL_LEVEL);
      if (!skip && lvl !== 0) {
        const idx = lvl - 1;
        if (bytesLeft(sim.roll(100), s.byte(table + idx))) this.report(slot, idx);
      }
      s.setByte(0x144cb, 0);
    }
    s.setLong(0x1446e, 0);
  }

  // ---- weekly battle ($127A0) ---------------------------------------------------------------------

  // Own units at the front ($14274..) fight the alien: the fleet strength (weights 1, 1, -, 2, 4, 3, 3, 1 for
  // types 9, 10, 11 (none), 12, 13, 14, 15, 16) times tech/2 wears the alien's age ($13456+$14) down; at 0
  // the aliens are beaten (flag $156AA bit 2, +5000 morale, the intelligence funds go to the treasury). Otherwise
  // the fleet takes casualties (tanks first, the rest with a chance of heavy-unit percentage).
  weeklyBattle(): void {
    const s = this.s;
    const sim = this.sim;
    if (sim.sysFlags & SYS.noUnitBonus) return;
    const f = (i: number): number => s.long(FRONT + 4 * i);
    let d0 = f(0) + f(1) + 2 * f(3) + 4 * f(4) + 3 * (f(5) + f(6)) + f(7);
    const heavy = 2 * f(3) + 4 * f(4) + 3 * (f(5) + f(6)) + f(7);
    if (d0 === 0) return;
    const percent = divsQ(mulu(heavy, 100), d0);
    let budget = d0;
    s.setByte(REC + 0x18, this.clampMax((s.byte(REC + 0x1a) + s.byte(REC + 0x18)) & 0xff, s.byte(REC + 0x1e)));
    let t = s.byte(0x14592);
    if (t & 1) t++;
    t >>= 1;
    d0 = mulu(d0, t);
    d0 = (d0 & 0xffff0000) | ((d0 & 0xffff) >>> 1);
    const age = s16(s.word(REC + 0x14) - (d0 & 0xffff));
    s.setWord(REC + 0x14, age);
    if (age > 0) return this.battle(budget, percent);
    // victory
    s.setWord(REC + 0x14, 0);
    s.setByte(0x14132, 0xff);
    s.setByte(0x14498, 6);
    s.setByte(0x14499, 3);
    sim.events.push({ kind: "intel", slot: 0x14498, value: 3 });
    sim.msg(0x186);
    sim.sysFlags |= SYS.noUnitBonus;
    sim.sysFlags &= ~SYS.attackPending;
    for (let g = 0; g < 16; g++) s.setByte(GROUPS + g * GROUP_SIZE + 0x90, 0);
    sim.applyMorale(0x1388);
    s.setByte(INTEL_LEVEL, 4);
    s.setLong(0x135ba, s.long(0x135ba) + s.long(FUNDS));
    s.setLong(FUNDS, 0);
    sim.events.push({ kind: "aliensDefeated" });
  }

  private battle(budget: number, percent: number): void {
    const s = this.s;
    const sim = this.sim;
    const d2 = sim.roll(4) + 2;
    s.setLong(0x1446e, s.long(0x1446e) + Math.floor(100 / d2));
    budget = s16(divuQ(budget, d2) + 1);
    s.setByte(0x144cb, s.byte(0x144cb) + 1);
    // casualty steps: [index, cost, certain]
    const steps: [number, number, boolean][] = [
      [0, 1, true],
      [1, 1, true],
      [3, 2, false],
      [4, 3, false],
      [5, 4, false],
      [6, 3, false],
      [7, 1, false],
    ];
    for (;;) {
      if (budget <= 0) break;
      let died = false;
      let over = false;
      for (const [i, cost, certain] of steps) {
        const addr = FRONT + 4 * i;
        if (s.long(addr) === 0) continue;
        if (!certain && !bytesLeft(sim.roll(100), percent & 0xff)) continue;
        s.setLong(addr, s.long(addr) - 1);
        s.setLong(LOST, s.long(LOST) + 1);
        died = true;
        budget = s16(budget - cost);
        if (budget <= 0) {
          over = true;
          break;
        }
      }
      if (over) break;
      if (!died) break;
    }
    if (budget <= 0) {
      let left = 0;
      for (const i of [0, 1, 3, 4, 5, 6, 7]) left += s.long(FRONT + 4 * i);
      if (left !== 0) return;
    }
    // the fleet is gone (or nobody could be hit): maybe an intelligence report
    const lvl = s.byte(INTEL_LEVEL);
    if (lvl === 0) return;
    if (bytesLeft(sim.roll(100), s.byte(0x140b4 + lvl - 1))) this.report(0x14492, lvl - 1);
  }
}
