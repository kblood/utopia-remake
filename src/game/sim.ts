// The periodic simulation: the ported parts of the original's main-loop worker $99C4.
// Source analysis: notes/formats/game-state.md section 5, port status: notes/formats/sim-port.md.
// Every function names the original routine it follows; arithmetic keeps the original's
// register widths (see sim-math.ts), quirks included.

import { A, PERIOD, type GameState } from "./state.js";
import { T, type World } from "./world.js";
import { createRng, divsQ, divuQ, divuReg, mulu, muls, s16, s8, type Rng } from "./sim-math.js";
import { GOOD_WEIGHT, JOB_POOL_TYPES, POWER_TYPES, RESEARCH_BITS, RESEARCH_INDEX, RESEARCH_SCALE, RESEARCH_THRESHOLD, STARVATION_LEVEL, TAX_MORALE, TAX_QOL } from "./sim-tables.js";

// Variable-block addresses used by the simulation (game-state.md section 3).
const V = {
  freeColonists: 0x13136,
  employed: 0x1313a,
  medics: 0x1313e,
  scientists: 0x13142,
  security: 0x13146,
  population: 0x1314a,
  fuelCopy: 0x1314e, // trade slot 0 (fuel), goods follow at $13152
  stock: 0x13152,
  weight: 0x13166,
  market: 0x1316a, // 12 entries x 10 bytes
  tradable: 0x14234, // 6 longs
  retain: 0x144cc, // 6 longs
  supply: 0x1443a,
  demand: 0x14452,
  money: 0x135ba,
  spent: 0x135b6,
  grant: 0x135be,
  capacity: 0x14432,
  jobRequired: 0x143c6,
  jobAssigned: 0x143ea,
  jobShortage: 0x1440e,
  jobCap: 0x14500,
  farmA: 0x143be,
  farmB: 0x143c2,
  births: 0x1432e,
  deaths: 0x14332,
  deathsPending: 0x14336,
  crime: 0x142ce,
  security_pct: 0x144c6,
  power: 0x144c8,
  eclipse: 0x144bb,
  airShort: 0x144b5,
  starving: 0x144b4,
  crowded: 0x144c4,
  crowdDeaths: 0x144c5,
  virusLevel: 0x144b7,
  virusTime: 0x144b8,
  virusDeaths: 0x144b9,
  tradeFail: 0x144ba,
  warnBits: 0x144b1,
  inventionDelay: 0x144c7,
  eventIndex: 0x144bf,
  invention: 0x14472,
  inventionQueue: 0x14476,
  researchAccum: 0x142da,
  tanks: 0x1429c,
  ships: 0x1429e,
  fuelStored: 0x14342,
  objects: 0x142c2,
  tradeBits: 0x144c2,
} as const;

// Type indices with a special role.
const TY = {
  powerStore: 0,
  housing: 7,
  solarA: 11,
  solarB: 12,
  boiler: 14, // job pool 0
  fuelPlant: 15,
  tankA: 16,
  tankB: 17,
  farmA: 18,
  farmB: 19,
  airB: 24,
  mine: 26,
  commandCentre: 29,
  airA: 30,
  powerStation: 31,
  sports: 32,
} as const;

// Bits of the system flag byte $156AA (kept in Sim.sysFlags).
export const SYS = { noUnitBonus: 0x04, gameOver: 0x08, qol80: 0x10, qol90: 0x20, eclipse: 0x40, attack: 0x80 } as const;

const TILE_MINE = 0x60;
const TILE_FUEL = 0x3e;
const MAX_POOL = 9;

export type SimEvent =
  | { kind: "announce"; id: number } // $E770 d1: 1 game over, 2 quality of life 80, 3 quality of life 90
  | { kind: "invention"; bit: number } // $DF5A
  | { kind: "offer"; what: "colonists" | "scientists" | "tanks"; count: number; price: number; accepted: boolean };

export interface Offer {
  what: "colonists" | "scientists" | "tanks";
  count: number;
  price: number; // Gr per colonist (colonists) or total fine (scientists)
}

export interface SimOptions {
  rng?: Rng;
  // Answer of the original's two-button dialog $DECC: true = first button (accept the Earth
  // request: buy the colonists / hand over the scientists), false = second button.
  decide?: (offer: Offer) => boolean;
  // Called in the weekly step where the original runs $7000 (construction countdown).
  onWeek?: () => void;
  // $37CA at the end of the tank yard step: put a finished unit next to the yard at (x, y).
  // Returns false when no neighbouring cell is free. Without a unit layer the unit is only counted.
  spawnUnit?: (x: number, y: number, advanced: boolean) => boolean;
  // $4692: remove the first unit from the map; returns its type (9 or 10), or null when none exists.
  // Without a unit layer a unit of the type with a non-zero count is chosen.
  destroyUnit?: () => number | null;
  // $7372: knock down the building at a cell (used by the mine collapse event).
  demolishAt?: (x: number, y: number) => void;
  // When true an Earth offer waits in `pending` (and time stops) until resolveOffer() is called,
  // instead of asking `decide`.
  interactive?: boolean;
}

export class Sim {
  readonly state: GameState;
  readonly messages: number[] = []; // string-table indices shown through $5A8C / $551A
  readonly events: SimEvent[] = [];
  sysFlags = 0x01; // $156AA default
  paused = false; // $156A9 bit 2

  private readonly rng: Rng;
  private readonly decide: (offer: Offer) => boolean;

  private onWeek: (() => void) | undefined;
  private spawnUnit: (x: number, y: number, advanced: boolean) => boolean;
  private readonly interactive: boolean;
  private demolishAt: (x: number, y: number) => void;
  private destroyUnit: () => number | null;
  pending: { offer: Offer; apply: (accepted: boolean) => void } | null = null;

  constructor(
    readonly world: World,
    options: SimOptions = {},
  ) {
    this.state = world.state;
    this.rng = options.rng ?? createRng(0x55746f70);
    this.decide = options.decide ?? (() => false);
    this.onWeek = options.onWeek;
    this.spawnUnit = options.spawnUnit ?? (() => true);
    this.interactive = options.interactive ?? false;
    this.demolishAt = options.demolishAt ?? (() => {});
    this.destroyUnit = options.destroyUnit ?? (() => (this.s.long(0x14254) > 0 ? 9 : this.s.long(0x14258) > 0 ? 10 : null));
    if (this.state.long(V.capacity) === 0) this.state.setLong(V.capacity, world.warehouseCapacity);
  }

  get gameOver(): boolean {
    return (this.sysFlags & SYS.gameOver) !== 0;
  }

  // One video frame: advances the frame countdown and runs whatever became due.
  tick(): void {
    if (this.pending) return;
    this.state.tickFrame();
    this.run();
  }

  // $99C4: consume the pending period bits in the original's order.
  run(): void {
    if (this.paused || this.gameOver) return;
    const s = this.state;
    const bit = (b: number): boolean => {
      const pending = s.byte(A.pending);
      if ((pending & b) === 0) return false;
      s.setByte(A.pending, pending & ~b);
      return true;
    };
    bit(PERIOD.special); // $11D34 (gun animation) is not ported
    if (bit(PERIOD.daily)) this.daily();
    if (this.gameOver) return;
    if (bit(PERIOD.weekly)) this.weekly();
    if (bit(PERIOD.monthly)) this.monthly();
    if (bit(PERIOD.yearly)) this.yearly();
  }

  // ---- small helpers ----------------------------------------------------------------------

  private get s(): GameState {
    return this.state;
  }

  private msg(index: number): void {
    this.messages.push(index);
  }

  private roll(range: number): number {
    return this.rng(range);
  }

  private tAddr(i: number): number {
    return this.world.typeAddress(i);
  }
  private tActive(i: number): number {
    return this.s.word(this.tAddr(i) + T.active);
  }
  private tCount(i: number): number {
    return this.s.word(this.tAddr(i) + T.total);
  }
  private tStored(i: number): number {
    return this.s.word(this.tAddr(i) + T.stored);
  }
  private setTStored(i: number, value: number): void {
    this.s.setWord(this.tAddr(i) + T.stored, value);
  }

  private add32(addr: number, delta: number): void {
    this.s.setLong(addr, this.s.long(addr) + delta);
  }

  // $A246: morale change. d0 is used as a signed word; the change shrinks towards +-100%.
  applyMorale(d0: number): void {
    const s = this.s;
    let m = s.signedLong(A.morale);
    const mag = m < 0 ? -m : m;
    const d2 = (100 - divsQ(mag, 100)) & 0xffff; // subi.w #100 / neg.w
    const delta = divsQ(muls(d0, d2), 100);
    m = (m + delta) | 0;
    s.setLong(A.morale, m);
  }

  // $A2DE: add units of a good to the warehouse (capped by the weight capacity).
  // Returns the units actually added and whether the capacity overflowed.
  addGoods(units: number, good: number): { added: number; overflow: boolean } {
    const s = this.s;
    const w = GOOD_WEIGHT[good];
    let d0 = units;
    let d2 = mulu(units, w);
    let overflow = false;
    if (((s.long(V.weight) + d2) | 0) > (s.signedLong(V.capacity) | 0)) {
      overflow = true;
      d2 = (s.long(V.capacity) - s.long(V.weight)) >>> 0;
      d0 = divuQ(d2, w);
    }
    s.setLong(V.weight, s.long(V.weight) + d2);
    this.add32(V.stock + 4 * good, d0);
    return { added: d0 >>> 0, overflow };
  }

  // $A32C: remove up to `units` of a good; returns the units removed.
  removeGoods(units: number, good: number): number {
    const s = this.s;
    const have = s.long(V.stock + 4 * good);
    const d0 = units > have ? have : units;
    s.setLong(V.stock + 4 * good, have - d0);
    s.setLong(V.weight, s.long(V.weight) - mulu(d0, GOOD_WEIGHT[good]));
    return d0;
  }

  // ---- daily -----------------------------------------------------------------------------

  // $99C4 daily branch. $ACE2 (ship fuel), $11D34, message timers and $AF12 (alien
  // intelligence) are not ported.
  private daily(): void {
    if (this.s.byte(A.day) === 1) this.qualityOfLife();
    this.checkGameOver();
    if (this.gameOver) return;
    this.eventScheduler();
  }

  // $B086
  private checkGameOver(): void {
    const s = this.s;
    const pop = s.long(V.population);
    let lost = s.word(V.objects) === 0;
    if (!lost) lost = this.tCount(TY.housing) === 0 ? pop < 60 : pop < 30;
    if (lost) {
      this.events.push({ kind: "announce", id: 1 });
      this.sysFlags |= SYS.gameOver;
    }
  }

  // $AB0C: scientists turn the two research funds into progress; reaching the next threshold
  // raises the technology level and queues the invention bits of that level (announced one at a time by $1135A).
  research(): void {
    const s = this.s;
    if (s.byte(V.power) >= 7) return;
    if (s.word(0x133f8) === 0) {
      this.msg(0xef);
      return;
    }
    const tech = s.byte(A.techLevel);
    const price = 25 + tech * 10;
    let progress = s.long(0x142de);
    const scientists = s.long(V.scientists);
    progress = (progress + scientists) >>> 0;
    let spend = mulu(scientists, price) >>> 0;
    const second = spend;
    let fundA = s.long(0x142d2);
    if (((fundA - spend) | 0) < 0) spend = fundA;
    fundA = (fundA - spend) >>> 0;
    progress = (progress + s16(divuQ(spend, price))) >>> 0;
    s.setLong(0x142d2, fundA);
    let fundB = s.long(0x142d6);
    let share = second;
    if (((fundB - share) | 0) < 0) share = fundB;
    fundB = (fundB - share) >>> 0;
    share = s16(divuQ(share, price)) >> 1;
    progress = (progress + share) >>> 0;
    s.setLong(V.researchAccum, (s.long(V.researchAccum) + share) >>> 0);
    s.setLong(0x142d6, fundB);
    s.setLong(0x142de, progress);
    if (((progress - RESEARCH_THRESHOLD[tech - 1]) | 0) < 0) return;

    let level = tech + 1;
    if (level === 11) level = 10;
    s.setByte(A.techLevel, level);
    const index = level - 1;
    s.setLong(V.inventionQueue, (s.long(V.inventionQueue) | RESEARCH_BITS[index]) >>> 0);
    s.setByte(V.inventionDelay, 0);
    const scale = RESEARCH_INDEX[index];
    s.setByte(0x145a3, scale);
    for (let i = 0; i < 6; i++) s.setByte(0x145a4 + i, RESEARCH_SCALE[i] * scale);
  }

  // ---- weekly ----------------------------------------------------------------------------

  // $99C4 weekly branch: $10FCA (eclipse) and the $144B2 counter. $7000 (construction
  // countdown, through the onWeek option), $4798, $12510 and $127A0 are not ported.
  private weekly(): void {
    this.eclipseWeekly();
    this.onWeek?.();
    const c = this.s.byte(0x144b2);
    if (c !== 0) this.s.setByte(0x144b2, c - 1);
  }

  // $10FCA
  private eclipseWeekly(): void {
    const s = this.s;
    if (this.sysFlags & SYS.attack) return;
    if (s.byte(V.eclipse) !== 0) {
      s.setByte(V.eclipse, s.byte(V.eclipse) - 1);
      if (s.byte(V.eclipse) !== 0) return;
      this.sysFlags &= ~SYS.eclipse;
      this.msg(0xde);
      return;
    }
    if (s.byte(A.month) === 11 && s.byte(A.day) === 0x15) {
      s.setByte(V.eclipse, 3);
      this.sysFlags |= SYS.eclipse;
      this.msg(0xdd);
    }
  }

  // ---- events ($10E1E) -------------------------------------------------------------------

  // One event slot per day (k = $144BF, reset monthly); chance bytes at $13118+k.
  private eventScheduler(): void {
    const s = this.s;
    if (this.sysFlags & SYS.attack) return;
    const k = s.byte(V.eventIndex);
    const chance = s.byte(0x13118 + k);
    if (chance !== 0) this.runEvent(k, chance);
    s.setByte(V.eventIndex, k + 1);
  }

  private runEvent(k: number, chance: number): void {
    switch (k) {
      case 0:
        return this.eventColonistOffer(chance);
      case 2:
        return this.eventInvention();
      case 4:
        return this.eventMineCollapse(chance);
      case 6:
        return this.eventPowerAccident(chance);
      case 7:
        return this.eventTradeComputer(chance);
      case 10:
        return this.eventScientistsRequisition(chance);
      case 11:
        return this.eventTankRequisition(chance);
      case 14:
        return this.eventEclipse(chance);
      case 16:
        return this.eventStrike(chance);
      case 18:
        return this.eventVirus(chance);
      case 19:
        return this.eventCrime();
      default:
        return; // 1, 3, 8, 9, 12, 13, 15, 17 not ported; 5 is empty in the original
    }
  }

  // The $DECC dialog: answered by `decide`, or left pending for the interface.
  private ask(offer: Offer, apply: (accepted: boolean) => void): void {
    if (this.interactive) {
      this.pending = { offer, apply };
      return;
    }
    const accepted = this.decide(offer);
    this.events.push({ kind: "offer", ...offer, accepted });
    apply(accepted);
  }

  // Answer of the pending Earth dialog: true = first button.
  resolveOffer(accepted: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.events.push({ kind: "offer", ...pending.offer, accepted });
    pending.apply(accepted);
  }

  // $110FE: Earth offers colonists, 100 Gr each, population/4 of them.
  private eventColonistOffer(chance: number): void {
    const s = this.s;
    if (this.roll(100) >= chance) return;
    if (s.byte(V.crowded) !== 0) return;
    const count = s.long(V.population) >> 2;
    const price = mulu(count, 100);
    if (((price - s.long(V.money)) | 0) >= 0) return;
    this.ask({ what: "colonists", count, price: 100 }, (accepted) => {
      if (!accepted) return;
      s.setLong(V.money, s.long(V.money) - price);
      this.add32(V.population, count);
      this.add32(V.freeColonists, count);
    });
  }

  // $1135A: the next queued invention is announced every sixth call.
  private eventInvention(): void {
    const s = this.s;
    const delay = (s.byte(V.inventionDelay) - 1) & 0xff;
    s.setByte(V.inventionDelay, delay);
    if ((delay & 0x80) === 0) return;
    let queue = s.long(V.inventionQueue);
    if (queue === 0) {
      s.setByte(V.inventionDelay, 0);
      return;
    }
    let bitNo = 0;
    while ((queue & (1 << bitNo)) === 0) bitNo++;
    queue = (queue & ~(1 << bitNo)) >>> 0;
    s.setLong(V.inventionQueue, queue);
    s.setLong(V.invention, s.long(V.invention) | (1 << bitNo));
    s.setByte(V.inventionDelay, 5);
    this.events.push({ kind: "invention", bit: bitNo });
    this.applyMorale(0x5dc);
  }

  // $11280: Earth requisitions 1..9 tanks (only above 10 units); refusing costs a fine.
  eventTankRequisition(chance: number): void {
    const s = this.s;
    if (this.roll(100) >= chance) return;
    if (s16(s.word(V.tanks)) <= 10) return;
    const count = this.roll(9) + 1;
    let fine = divuReg(s.long(V.money), this.roll(8) + 2) & 0xfffe;
    if (fine >= 0xf423f) fine = 0xf423f;
    this.ask({ what: "tanks", count, price: fine }, (accepted) => {
      if (!accepted) {
        s.setLong(V.money, s.long(V.money) - fine);
        return;
      }
      for (let i = 0; i < count; i++) {
        const type = this.destroyUnit();
        if (type === null) break;
        s.setWord(V.tanks, s.word(V.tanks) - 1);
        this.add32(type === 9 ? 0x14254 : 0x14258, -1);
        this.add32(0x14294, 1);
        this.applyMorale(-50);
      }
    });
  }

  // $11090: a random mine collapses.
  eventMineCollapse(chance: number): void {
    const s = this.s;
    if (this.roll(100) >= chance) return;
    const mines = s.word(0x133c2);
    if (mines === 0) return;
    let skip = this.roll(mines);
    const o = this.world.objects;
    for (let slot = 0; slot < this.world.objectCount; slot++) {
      const at = slot * 8;
      if (((o[at] << 8) | o[at + 1]) !== TILE_MINE) continue;
      if (skip-- > 0) continue;
      this.demolishAt(o[at + 4], o[at + 5]);
      this.msg(0xdf);
      this.applyMorale(-300);
      return;
    }
  }

  // $10F5E: lightning in the power storage.
  private eventPowerAccident(chance: number): void {
    const s = this.s;
    const d3 = mulu(chance, this.tCount(TY.powerStore));
    if (((this.roll(100) - d3) & 0x80) === 0) return;
    const e = (this.tStored(TY.powerStore) - s.word(0x1310c)) & 0xffff;
    this.setTStored(TY.powerStore, (e & 0x8000) !== 0 ? 0 : e);
    this.msg(0xda);
  }

  // $10F8E: trading computer failure for 1..4 months.
  private eventTradeComputer(chance: number): void {
    const s = this.s;
    if (s.byte(V.tradeFail) === 0) {
      if (((this.roll(100) - chance) & 0x80) === 0) return;
      s.setByte(V.tradeFail, this.roll(4) + 1);
      this.msg(0xdb);
      return;
    }
    s.setByte(V.tradeFail, s.byte(V.tradeFail) - 1);
    if (s.byte(V.tradeFail) === 0) this.msg(0xdc);
  }

  // $111A6: Earth requisitions scientists; refusing costs a fine.
  private eventScientistsRequisition(chance: number): void {
    const s = this.s;
    if (((this.roll(100) - chance) & 0x80) === 0) return;
    const sci = s.long(V.scientists);
    if (s8(sci) <= 0xf) return;
    const count = Math.max(sci >> 2, 5);
    this.msg(0xe5);
    const fine = divuReg(s.long(V.money), this.roll(8) + 2) & 0xfffe;
    this.msg(0xe6);
    this.ask({ what: "scientists", count, price: fine }, (accepted) => {
      if (!accepted) {
        s.setLong(V.money, s.long(V.money) - fine);
        return;
      }
      this.add32(V.jobAssigned + 4 * 7, -count);
      this.add32(V.population, -count);
      this.add32(V.scientists, -count);
      this.allocateJobs(0);
      this.applyMorale(-500);
    });
  }

  // $11058: eclipse (solar output 0 for 1..10 weeks).
  private eventEclipse(chance: number): void {
    const s = this.s;
    if (s.byte(V.eclipse) !== 0) return;
    if (((this.roll(100) - chance) & 0x80) !== 0) {
      s.setByte(V.eclipse, this.roll(10) + 1);
      this.msg(0xdd);
      this.sysFlags |= SYS.eclipse;
    }
  }

  // $113FA: strike messages (the original only toggles bit 2 of $144B1 and shows text).
  private eventStrike(chance: number): void {
    const s = this.s;
    const bits = s.byte(V.warnBits);
    s.setByte(V.warnBits, bits & ~0x04);
    if (bits & 0x04) return this.msg(0x11e);
    if (s.signedLong(A.morale) >= -3000) return;
    if (((this.roll(100) - chance) & 0x80) === 0) return;
    s.setByte(V.warnBits, s.byte(V.warnBits) | 0x04);
    this.msg(0x11d);
  }

  // $10ED2: virus. Level/duration/death bonus in $144B7/$144B8/$144B9.
  private eventVirus(chance: number): void {
    const s = this.s;
    if (s.byte(V.virusLevel) === 0) {
      if (s.long(V.invention) & 0x10000) return;
      if (((this.roll(100) - chance) & 0x80) === 0) return;
      const level = this.roll(9) + 1;
      s.setByte(V.virusLevel, level);
      s.setByte(V.virusDeaths, level * 2);
      s.setByte(V.virusTime, this.roll(5) + 2);
      this.msg(0xd7);
      return;
    }
    let medics = s.long(V.medics);
    if (medics !== 0) {
      medics >>= 1;
      if (medics >= 50) medics = 50;
      const r = this.roll(100);
      if (r <= medics) {
        this.clearVirus();
        return this.msg(0xd9);
      }
    }
    s.setByte(V.virusTime, s.byte(V.virusTime) - 1);
    if (s.byte(V.virusTime) !== 0) return;
    this.clearVirus();
    this.msg(0xd8);
  }

  private clearVirus(): void {
    this.s.setByte(V.virusLevel, 0);
    this.s.setByte(V.virusDeaths, 0);
  }

  // $10C72: crime consequences. The riot branches of $10D00/$10D9E (crime above 50) are not
  // ported.
  private eventCrime(): void {
    const s = this.s;
    const crime = s.signedLong(V.crime);
    if (crime < 0) return;
    // $10CB4: thieves take 1..7 percent of the money, and one unit of good 2.
    const pct = this.roll(6) + 1;
    s.setLong(V.money, s.long(V.money) - mulu(divuQ(s.long(V.money), 100), pct));
    if (s.long(0x1315a) !== 0) this.removeGoods(1, 2);
    if (s8(crime) <= 0x14) return this.msg(0x10f);
    // $10CE8: two percent of the colonists die.
    const dead = this.deaths(2);
    s.setLong(V.deathsPending, dead);
    this.allocateJobs(0);
    if (s8(crime) <= 0x32) return this.msg(0x110);
  }

  // ---- monthly ---------------------------------------------------------------------------

  // $99C4 monthly branch.
  monthly(): void {
    const s = this.s;
    s.setByte(V.warnBits, s.byte(V.warnBits) & ~0x02);
    if (s.byte(V.warnBits) & 0x01) {
      s.setByte(V.warnBits, (s.byte(V.warnBits) & ~0x01) | 0x02);
      this.msg(0x62); // $9B06
      this.applyMorale(0x1f4);
    }
    // $9B20
    this.tradeIncome();
    this.marketWalk();
    s.setByte(V.tradeBits, (s.byte(V.tradeBits) | 0x01) & ~0x02);
    this.assignFarmers();
    this.food();
    this.housing();
    this.air();
    this.births();
    this.finance();
    this.power();
    this.commandCentreCheck();
    this.jobs();
    this.moraleMonthly();
    this.crimeMonthly();
    this.production();
    this.tankYard();
    this.research();
    s.setLong(0x1436a, s.long(0x14376));
    s.setLong(0x14376, 0);
    s.setLong(0x14372, s.long(0x1437a));
    s.setLong(0x1437a, 0);
    s.setByte(V.eventIndex, 0);
  }

  // $9B52: after a power failure took the Command Centre offline it comes back once the
  // power level is below 14 again.
  private commandCentreCheck(): void {
    const s = this.s;
    if (s.byte(V.power) >= 0xe) return;
    if (this.tCount(TY.commandCentre) !== 0) return;
    if (this.tActive(TY.commandCentre) === 0) return;
    this.setCommandCentreActive(0xff, -1);
    s.setWord(this.tAddr(TY.commandCentre) + T.total, 1);
  }

  // Record byte +3 of the first Command Centre object (tile $4C): $FF online, 0 offline.
  // `only` >= 0 restricts the search to a record whose byte currently has that value.
  private setCommandCentreActive(flag: number, only: number): boolean {
    const objects = this.world.objects;
    for (let i = 0; i < objects.length; i += 8) {
      if (((objects[i] << 8) | objects[i + 1]) !== 0x4c) continue;
      if (only >= 0 && objects[i + 3] !== only) continue;
      objects[i + 3] = flag;
      return true;
    }
    return false;
  }

  // $9E3A: colonists on farms (type 19 is filled first, then type 18), 10 per building.
  private assignFarmers(): void {
    const s = this.s;
    let free = s.long(V.freeColonists) + s.long(V.farmA) + s.long(V.farmB);
    const needB = mulu(this.tActive(TY.farmB), 10);
    let b: number;
    let a: number;
    if (free < needB) {
      b = free;
      free = 0;
      a = 0;
    } else {
      b = needB;
      free -= needB;
      const needA = mulu(this.tActive(TY.farmA), 10);
      if (free < needA) {
        a = free;
        free = 0;
      } else {
        a = needA;
        free -= needA;
      }
    }
    s.setLong(V.freeColonists, free);
    s.setLong(V.farmA, a);
    s.setLong(V.farmB, b);
  }

  // $9E98: food. All food in stock is taken out, production added, population eats; the
  // balance goes back into the warehouse or causes starvation.
  private food(): void {
    const s = this.s;
    s.setByte(V.starving, 0);
    const taken = this.removeGoods(s.long(V.stock), 0);
    s.setLong(0x1433e, taken);
    const pop = s.long(V.population);
    s.setLong(0x14366, pop);
    this.add32(0x14396, pop);
    let prod = (mulu(s.long(V.farmA), s.word(0x13108)) + mulu(s.long(V.farmB), s.word(0x1310a))) >>> 0;
    if (s.byte(V.power) >= 0x12) prod = 0;
    s.setLong(0x14352, prod);
    const net = (taken + prod - pop) | 0;
    if (net >= 0) {
      if (this.addGoods(net, 0).overflow) this.msg(0x6d);
      return;
    }
    const level = divuQ(mulu(-net, 20), pop);
    s.setByte(V.starving, STARVATION_LEVEL[level] ?? 0);
    this.applyMorale((level + 1) * -100);
  }

  // $9DBA: housing, 50 colonists per housing building.
  private housing(): void {
    const s = this.s;
    s.setByte(V.crowded, 0);
    s.setByte(V.crowdDeaths, 0);
    const cap = mulu(this.tCount(TY.housing), 50);
    if (cap === 0) {
      s.setByte(V.crowded, 0xff);
      s.setByte(V.crowdDeaths, 0x50);
      this.applyMorale(-0x50 * 20);
      return this.msg(0x63);
    }
    let over = (divuQ(mulu(s.long(V.population), 100), cap) - 100) & 0xffff;
    if (s16(over) <= 0) return;
    s.setByte(V.crowded, 0xff);
    this.applyMorale(muls(over, -20));
    if (((over & 0xff) - 0x32) & 0x80) return this.msg(0x63);
    const limit = cap + (cap >> 1);
    const pop = s.long(V.population);
    over = divuQ(mulu(pop - limit, 100), pop);
    s.setByte(V.crowdDeaths, over);
    this.msg(0x63);
  }

  // $9CDA: air. Two plant types produce and store air.
  private air(): void {
    const s = this.s;
    s.setByte(V.airShort, 0);
    const pop = s.long(V.population);
    s.setLong(0x14362, pop);
    this.add32(0x14392, pop);
    const a = TY.airA;
    const b = TY.airB;
    let d0 = s16(this.tStored(a)) + s16(this.tStored(b));
    s.setLong(0x1433a, d0 >>> 0);
    const countA = this.tCount(a);
    const countB = this.tCount(b);
    let prod = (mulu(countA, s.word(0x13100)) + mulu(countB, s.word(0x13102))) >>> 0;
    if (s.byte(V.power) >= 0x14) prod = 0;
    s.setLong(0x1434e, prod);
    d0 = (d0 + prod - pop) | 0;
    if (d0 < 0) {
      s.setByte(V.airShort, 10);
      this.setTStored(a, 0);
      this.setTStored(b, 0);
      this.applyMorale(muls(divuQ(mulu(-d0, 100), pop), -20));
      return;
    }
    // Storage: the first type's capacity test uses count*capacity, but the overflow keeps one
    // building's worth (original behaviour, see notes).
    const capA = mulu(countA, s.word(0x13104));
    let d1: number;
    if (capA === 0) {
      d1 = d0;
      d0 = 0;
    } else if (((capA - d0) | 0) >= 0) {
      this.setTStored(a, d0);
      return;
    } else {
      d1 = d0;
      d0 = s16(s.word(0x13104));
      d1 -= d0;
    }
    const capB = mulu(countB, s.word(0x13106));
    if (((capB - d1) | 0) < 0) d1 = s.word(0x13106);
    if (countB !== 0) this.setTStored(b, d1);
    this.setTStored(a, d0);
  }

  // $9BAE: births, then deaths ($9C80). The difficulty byte sets the birth rate band.
  private births(): void {
    const s = this.s;
    const difficulty = s.byte(A.difficulty);
    if (difficulty === 0) {
      s.setLong(V.births, 0);
    } else {
      const base = difficulty === 0x14 ? 0 : difficulty === 0x1e ? 0x1e : 0x3c;
      const rate = (this.roll(difficulty) + base) & 0xff;
      const q = divuQ(mulu(s.long(V.population), 10) + 500, 1000);
      const born = divuQ(mulu(q, rate) + 5, 10);
      s.setLong(V.births, born >>> 0);
      this.add32(V.population, born);
      this.add32(V.freeColonists, born);
    }
    let pct = (1 + s.byte(V.starving) + s.byte(V.airShort) + s.byte(V.virusDeaths)) & 0xff;
    const pop = s.long(V.population);
    const d1 = (divuQ(pop, 0x14) - s.long(V.medics)) | 0;
    if (d1 > 0) {
      pct = (pct + 1) & 0xff;
      if (s16(d1) > 10) pct = (pct + 1) & 0xff;
      if (s16(d1) > 30) pct = (pct + 1) & 0xff;
    }
    if (((pct - 0x14) & 0x80) === 0) this.applyMorale(muls(pct, -20));
    if ((pct - s.byte(V.crowdDeaths)) & 0x80) pct = s.byte(V.crowdDeaths);
    const dead = this.deaths(pct) + s.long(V.deathsPending);
    s.setLong(V.deaths, dead);
    s.setLong(V.deathsPending, 0);
  }

  // $9C80: remove pct percent of the free colonists and of every job pool (fractions are
  // decided by a roll). Returns the number removed from the population.
  private deaths(pct: number): number {
    const s = this.s;
    let removed = divuQ(mulu(s.long(V.freeColonists), pct), 100);
    if (removed !== 0) s.setLong(V.freeColonists, s.long(V.freeColonists) - removed);
    for (let i = 0; i < MAX_POOL; i++) {
      const addr = V.jobAssigned + 4 * i;
      const assigned = s.long(addr);
      if (assigned === 0) continue;
      const reg = divuReg(mulu(assigned, pct), 100);
      let d1: number;
      if ((reg & 0xffff) !== 0) {
        d1 = s16(reg & 0xffff);
      } else {
        const remainder = (reg >>> 16) & 0xff;
        const r = this.roll(pct);
        d1 = ((remainder - r) & 0x80) !== 0 ? 0 : 1;
        if (d1 === 0) continue;
      }
      s.setLong(addr, assigned - d1);
      s.setLong(V.employed, s.long(V.employed) - d1);
      removed += d1;
    }
    s.setLong(V.population, s.long(V.population) - removed);
    return removed;
  }

  // $A010: monthly statistics, tax income and the research grant.
  private finance(): void {
    const s = this.s;
    s.setLong(0x142e2, s.long(0x142f2));
    s.setLong(0x142e6, s.long(0x142f6));
    s.setLong(0x142ea, s.long(0x142fa));
    this.add32(0x14316, s.long(0x142f2));
    this.add32(0x1431a, s.long(0x142f6));
    this.add32(0x1431e, s.long(0x142fa));
    const spent = s.long(0x142ca);
    s.setLong(V.spent, spent);
    this.add32(0x14326, spent);
    s.setLong(0x142ca, 0);
    s.setLong(0x142f6, 0);
    const tax = s.long(A.tax);
    s.setLong(0x144fc, tax);
    let income = mulu(s.long(V.population), tax);
    s.setLong(0x142fa, income);
    let grant = s.long(V.grant);
    s.setLong(0x142f2, grant);
    if (grant !== 0) {
      income = (income + grant) >>> 0;
      grant = ((grant & 0xffff0000) | ((grant - 100) & 0xffff)) >>> 0;
      s.setLong(V.grant, grant);
      if (grant === 0) this.msg(0x65);
    }
    s.setLong(V.money, s.long(V.money) + income);
  }

  // $A0D4: power. Output first, then use in priority order; the first type that cannot be
  // powered sets the shortage level ($144C8 = 21 - its position).
  private power(): void {
    const s = this.s;
    let d0 = 0;
    if (s.byte(V.eclipse) === 0) {
      d0 += mulu(this.tStored(TY.solarA), this.tCount(TY.solarA));
      d0 += mulu(this.tStored(TY.solarB), this.tCount(TY.solarB));
    }
    d0 += mulu(this.tStored(TY.powerStation), this.tCount(TY.powerStation));
    s.setLong(0x1435a, divuQ(d0, 10));
    d0 += s16(this.tStored(TY.powerStore));
    let used = 0;
    let level = 21;
    for (let k = 0; k < POWER_TYPES.length; k++) {
      const t = this.tAddr(POWER_TYPES[k]);
      const need = mulu(s.byte(t + T.power), s.word(t + T.total));
      used += need;
      d0 -= need;
      if (d0 < 0) {
        for (let j = k + 1; j < POWER_TYPES.length; j++) {
          const u = this.tAddr(POWER_TYPES[j]);
          used += mulu(s.byte(u + T.power), s.word(u + T.total));
        }
        level = 21 - k;
        break;
      }
      level--;
    }
    const usedUnits = divuQ(used, 10);
    s.setLong(0x1436e, usedUnits);
    this.add32(0x1439e, usedUnits);
    if (level === 0) {
      // Everything powered: the remainder is stored up to the storage capacity.
      const cap = mulu(this.tCount(TY.powerStore), s.word(0x1310c));
      if (((cap - d0) | 0) < 0) d0 = cap;
      this.setTStored(TY.powerStore, d0);
      s.setLong(0x14346, divuQ(d0, 10));
      s.setByte(V.power, 0);
      return;
    }
    s.setByte(V.power, level);
    if (level >= 0xe && this.setCommandCentreActive(0, 0xff)) {
      // The Command Centre goes offline: its record is switched off and it stops counting.
      s.setWord(this.tAddr(TY.commandCentre) + T.total, 0);
      this.msg(0x12c);
    }
    if (level >= 2) s.setByte(V.warnBits, s.byte(V.warnBits) & ~0x03);
    this.setTStored(TY.powerStore, 0);
    s.setLong(0x14346, 0);
  }

  // $9F36: job allocation. A fifth of the free colonists (+1) take part each month.
  private jobs(): void {
    const s = this.s;
    const free = s.long(V.freeColonists);
    const d0 = divuQ(free, 5) + 1;
    s.setLong(V.freeColonists, free - d0);
    this.allocateJobs(d0);
  }

  // $9F4A: d0 = colonists available for filling jobs. Staff above the requirement is
  // released, shortages are filled proportionally; the remainder goes back to the free pool.
  // The per-pool caps $14500[] are the player's staffing choices (0 by default).
  private allocateJobs(avail: number): void {
    const s = this.s;
    let d0 = avail | 0;
    let totalShort = 0;
    for (let i = 0; i < MAX_POOL; i++) {
      const required = mulu(this.tCount(JOB_POOL_TYPES[i]), i === 6 ? 20 : 10);
      s.setLong(V.jobRequired + 4 * i, required);
      let short = 0;
      const assigned = s.long(V.jobAssigned + 4 * i);
      const excess = (assigned - required) | 0;
      if (excess >= 0) {
        d0 = (d0 + excess) | 0;
        s.setLong(V.jobAssigned + 4 * i, required);
      } else {
        const cap = s.long(V.jobCap + 4 * i);
        short = ((cap - required) | 0) >= 0 ? required : cap;
        short = (short - assigned) | 0;
      }
      s.setLong(V.jobShortage + 4 * i, short);
      totalShort = (totalShort + short) | 0;
    }
    if (totalShort !== 0) {
      const pool = d0;
      for (let i = 0; i < MAX_POOL; i++) {
        const short = s.long(V.jobShortage + 4 * i) | 0;
        if (short === 0) continue;
        let share = divuQ(mulu(short, pool), totalShort);
        if (share > short) share = short;
        s.setLong(V.jobAssigned + 4 * i, s.long(V.jobAssigned + 4 * i) + share);
        s.setLong(V.jobShortage + 4 * i, short - share);
        d0 -= share;
      }
    }
    s.setLong(V.freeColonists, s.long(V.freeColonists) + d0);
    s.setLong(V.medics, s.long(V.jobAssigned + 4 * 6));
    s.setLong(V.scientists, s.long(V.jobAssigned + 4 * 7));
    s.setLong(V.security, s.long(V.jobAssigned + 4 * 8));
    let employed = 0;
    for (let i = 0; i < MAX_POOL; i++) employed += s.long(V.jobAssigned + 4 * i);
    s.setLong(V.employed, employed >>> 0);
  }

  // $A270: monthly morale drift.
  private moraleMonthly(): void {
    const s = this.s;
    const sports = this.tCount(TY.sports);
    if (sports !== 0) this.applyMorale(mulu(((sports & 0xff) - 6) & 0x80 ? sports : 5, 100));
    const grant = s.long(V.grant);
    if (grant !== 0) this.applyMorale(divuQ(grant, 10));
    if (this.tCount(TY.commandCentre) === 0) this.applyMorale(-500);
    // The yearly tax-rise term uses the same table as every month.
    this.applyMorale(TAX_MORALE[s.long(A.tax)] ?? 0);
    const virus = s.byte(V.virusLevel);
    if (virus !== 0) this.applyMorale(muls(virus, -100));
    if (s.signedLong(A.morale) < 0) s.setLong(A.morale, s.long(A.morale) + 1);
  }

  // $10BC8: crime level from morale, a random term, the early-game bonus and security staff.
  private crimeMonthly(): void {
    const s = this.s;
    const m = s.signedLong(A.morale);
    const q = m >= 0 ? divuQ(m, 100) : -divuQ(-m, 100);
    let d1 = 100 - ((q + 100) >> 1);
    d1 -= this.roll(20) - 8 - 2;
    const early = 5 - s.long(A.year);
    if (early > 0) d1 -= early << 3;
    let pct = divuQ(mulu(s.long(V.security), 100), s.long(V.population)) & 0xff;
    if (s.byte(V.power) >= 0xd) pct = (pct & 0xff) >> 1;
    s.setByte(V.security_pct, pct);
    let reduction = 0;
    if (pct !== 0) {
      let p = pct;
      if (s8(p) > 10) {
        if (s8(p) > 20) {
          p = 20;
          s.setByte(V.security_pct, p);
        }
        reduction = 0x3c + ((p - 10) & 0xff);
      } else if (s8(p) > 5) {
        const t = (p - 5) & 0xff;
        reduction = 0x1e + ((t * 3) & 0xff);
      } else {
        reduction = (p * 6) & 0xff;
      }
    }
    s.setLong(V.crime, (d1 - reduction) >>> 0);
  }

  // $A620: each tank yard (record tile $45) takes goods 1 until its counter (byte +6) reaches 20,
  // then 2 of good 3, then puts a unit on a free neighbouring cell and starts over. Unit type 10
  // when invention bit 2 is set, else 9.
  tankYard(): void {
    const s = this.s;
    if (s8(s.byte(V.power)) >= 0xa) return;
    if (s.word(0x133f8) === 0) return this.msg(0xb3);
    const yards = s.word(0x1337a);
    if (yards === 0) return;
    const per = divuQ(s.long(0x143fa), yards);
    if (per === 0) return;
    const objects = this.world.objects;
    let left = yards;
    for (let slot = 0; slot < this.world.objectCount && left > 0; slot++) {
      const at = slot * 8;
      if (((objects[at] << 8) | objects[at + 1]) !== 0x45) continue;
      left--;
      let counter = objects[at + 6];
      if (counter < 0x80) {
        if (counter < 20) {
          const want = s8(per) < 20 - counter ? per & 0xff : 20 - counter;
          const took = this.removeGoods(want, 1);
          if (took === 0) return this.msg(0x96);
          counter = (counter + took) & 0xff;
          objects[at + 6] = counter;
          this.add32(0x1437a, took);
          this.add32(0x143a2, took);
          s.setLong(0x1434a, s.long(0x1434a) - took);
          if (s8(counter) < 20) continue;
        }
        if (this.removeGoods(2, 3) === 0) return this.msg(0x94);
        objects[at + 6] = 0xff;
      }
      const advanced = (s.long(V.invention) & 4) !== 0;
      if (s.word(V.tanks) >= 99) {
        objects[at + 6] = 0;
        this.msg(0x8f); // $37CA: the unit list is full
      } else if (this.spawnUnit(objects[at + 4], objects[at + 5], advanced)) {
        objects[at + 6] = 0;
        this.add32(0x143b6, 1);
        s.setWord(V.tanks, s.word(V.tanks) + 1);
        this.add32(advanced ? 0x14258 : 0x14254, 1);
      } else {
        this.msg(0x95);
      }
    }
  }

  // $A360: production. Pool 5 (workshop) makes good 4, pool 0 turns good 1 into good 3,
  // mines (pool 2) yield good 2 and ore, the fuel plant (pool 1) fills the tanks.
  // $AC04 (ship yard) is not ported.
  private production(): void {
    const s = this.s;
    for (let i = 0; i < 6; i++) s.setLong(0x143a6 + 4 * i, 0);
    const lvl = s.byte(V.power);
    const assigned = (i: number): number => s.long(V.jobAssigned + 4 * i);
    body: {
      if (lvl < 3 && assigned(5) !== 0) {
        const r = this.addGoods(assigned(5), 4);
        s.setLong(0x143ba, r.added);
        if (r.overflow) {
          this.msg(0x6c);
          break body;
        }
      }
      if (lvl < 8 && assigned(0) !== 0) {
        const used = this.removeGoods(mulu(assigned(0), 1), 1);
        this.add32(0x1437a, used);
        this.add32(0x143a2, used);
        s.setLong(0x1434a, s.long(0x1434a) - used);
        const r = this.addGoods(used, 3);
        s.setLong(0x143a6, r.added);
        if (r.overflow) {
          this.msg(0x6c);
          break body;
        }
      }
      s.setByte(0x144c3, 0);
      s.setLong(0x1435e, 0);
      if (lvl < 0xc && assigned(2) !== 0) {
        let found = 0;
        const miners = assigned(2) & 0xffff;
        for (let i = 0; i < miners; i++) if (this.roll(100) === 0) found++;
        const r = this.addGoods(found, 2);
        s.setLong(0x14436, r.added);
        if (r.overflow) {
          this.msg(0x6c);
          break body;
        }
        if (this.tCount(TY.mine) !== 0) {
          const ore = this.richnessSum(assigned(2), this.tCount(TY.mine), TILE_MINE);
          const o = this.addGoods(ore, 1);
          s.setLong(0x143ae, o.added);
          s.setLong(0x1435e, o.added);
          this.add32(0x1434a, o.added);
          if (o.overflow) this.msg(0x6c);
        }
      }
    }
    s.setLong(0x14356, 0);
    if (lvl < 0xb && assigned(1) !== 0 && this.tCount(TY.fuelPlant) !== 0) {
      const fuel = this.richnessSum(assigned(1), this.tCount(TY.fuelPlant), TILE_FUEL);
      s.setLong(0x143aa, fuel);
      s.setLong(0x14356, fuel);
      if (this.storeFuel(fuel)) this.msg(0x6e);
    }
  }

  // $A4A8: workers fill the buildings of one tile type in descending order of the richness
  // byte (+6 of the record), 10 workers per building; the sum is halved. Also writes the
  // average richness to $144C3.
  private richnessSum(workers: number, count: number, tile: number): number {
    const objects = this.world.objects;
    const values: number[] = [];
    for (let i = 0; i < objects.length && values.length < count; i += 8) {
      if (((objects[i] << 8) | objects[i + 1]) === tile) values.push(objects[i + 6]);
    }
    let sum = 0;
    for (const v of values) sum += v;
    this.s.setByte(0x144c3, divuQ(sum & 0xff, values.length || 1));
    values.sort((x, y) => y - x);
    let total = 0;
    for (let w = 0; w < workers; w++) total += values[Math.floor(w / 10)] ?? 0;
    return total >> 1;
  }

  // $A51A: store fuel in the two tank types. Returns true when there is nowhere to put it
  // (no tanks, or full: message 110). The stored words follow the original, including its
  // flat 800/1200 limits and the untouched second type when everything fits the first.
  storeFuel(produced: number): boolean {
    const s = this.s;
    const a = TY.tankA;
    const b = TY.tankB;
    const countA = this.tCount(a);
    const countB = this.tCount(b);
    if (countB === 0 && countA === 0) return true;
    const stored = this.tStored(a) + this.tStored(b);
    let d0 = (produced + stored) | 0;
    let d1 = 0;
    let flag = false;
    const capA = mulu(countA, 800);
    let fits = false;
    if (capA === 0) {
      d1 = d0;
      d0 = 0;
    } else if (((capA - d0) | 0) >= 0) {
      fits = true;
    } else {
      d1 = d0;
      d0 = 800;
      d1 -= 800;
    }
    if (!fits) {
      const capB = mulu(countB, 1200);
      if (((capB - d1) | 0) < 0) {
        d1 = (d1 & 0xffff0000) | 1200;
        flag = true;
      }
      if (countB === 0) d1 = 0;
      this.setTStored(b, d1);
    }
    this.setTStored(a, d0);
    s.setLong(V.fuelStored, (d0 + d1) | 0);
    return flag;
  }

  // ---- trade -----------------------------------------------------------------------------

  // $A7AE: one step of the random walk of a market entry (value, min, max, step, countdown).
  private walkEntry(addr: number): void {
    const s = this.s;
    const min = s16(s.word(addr + 2));
    const max = s16(s.word(addr + 4));
    let value = s16(s.word(addr));
    let step = s16(s.word(addr + 6));
    let countdown = s16(s.word(addr + 8));
    if (countdown === 0) {
      let d2 = this.roll(4) & 0xff;
      if (d2 === 0) return;
      countdown = d2 + 3;
      d2 = this.roll(max - min) + min;
      let diff = s16(d2 - value);
      if (diff >= 0) {
        step = s16(divuQ(diff, countdown) + 1);
      } else {
        diff = -diff;
        step = s16(-(divuQ(diff, countdown) + 1));
      }
    }
    value = s16(value + step);
    if (((value - min) & 0x8000) !== 0) value = min;
    if (value > max) value = max;
    countdown = s16(countdown - 1);
    s.setWord(addr, value);
    s.setWord(addr + 2, min);
    s.setWord(addr + 4, max);
    s.setWord(addr + 6, step);
    s.setWord(addr + 8, countdown);
  }

  // $A802: price walk for the 12 market entries, then this month's supply and demand.
  private marketWalk(): void {
    const s = this.s;
    for (let i = 0; i < 12; i++) {
      const addr = V.market + 10 * i;
      this.walkEntry(addr);
    }
    const base = divuQ(s.long(V.population), 100) + 1;
    for (let i = 0; i < 6; i++) {
      const entry = s.word(V.market + 10 * (6 + i));
      let amount = mulu(base, entry);
      if (amount >= 0x2710) amount = 0x270f;
      s.setLong(V.supply + 4 * i, amount);
      s.setLong(V.demand + 4 * i, 0);
      if (this.roll(100) > 0x32) {
        s.setLong(V.demand + 4 * i, amount);
        s.setLong(V.supply + 4 * i, 0);
      }
    }
  }

  // $A86A (with $A784): automatic sales. Per commodity (fuel, then goods 0..4) the tradable
  // share (stock above the retain percentage), limited by this month's demand, is sold at
  // the market price.
  private tradeIncome(): void {
    const s = this.s;
    const bits = s.byte(V.tradeBits);
    s.setByte(V.tradeBits, bits & ~0x01);
    if ((bits & 0x01) === 0) return;
    if (s.byte(V.tradeFail) !== 0) return;
    s.setLong(V.fuelCopy, s.long(V.fuelStored));
    for (let i = 0; i < 6; i++) {
      const src = s.long(V.fuelCopy + 4 * i);
      const kept = divuQ(mulu(s.long(V.retain + 4 * i), src), 100);
      s.setLong(V.tradable + 4 * i, src - kept);
    }
    for (let i = 0; i < 6; i++) {
      let units = s.long(V.tradable + 4 * i);
      const demand = s.long(V.demand + 4 * i);
      if (units === 0 || demand === 0) continue;
      if (((demand - units) | 0) < 0) units = demand;
      if (i === 0) this.add32(V.fuelStored, -units);
      else units = this.removeGoods(units, i - 1);
      const income = mulu(units, s.word(V.market + 10 * i));
      this.add32(V.money, income);
      this.add32(0x142f6, income);
    }
    s.setLong(0x1434a, s.long(0x13156));
  }

  // ---- quality of life ($A8E8, on the first day of each month) ---------------------------

  qualityOfLife(): void {
    const s = this.s;
    let pollution = s.long(A.pollution);
    if (((150 - s.long(V.researchAccum)) | 0) < 0) {
      s.setLong(V.researchAccum, s.long(V.researchAccum) - 150);
      pollution = (pollution - 1) >>> 0;
      s.setLong(A.pollution, pollution);
      const low = pollution & 0xff;
      if (low === 0x31) this.msg(0x17d);
      else if (low === 0x28 || low === 0x1e) this.msg(0x17e);
      else if (low === 0x14) this.msg(0x180);
    }
    let q = 0;
    const crime = s.signedLong(V.crime);
    if (crime < 0) {
      q += 200;
    } else {
      let c = mulu(crime, 100) >> 3;
      if (s8(c) > 6) c = 6;
      q -= c;
    }
    q += divuQ(Math.min(s.long(V.population), 10000), 5);
    if (this.sysFlags & SYS.noUnitBonus) {
      q += 2000;
    } else {
      let units = s.word(V.tanks) + s.word(V.ships);
      for (const i of [5, 6, 8, 9]) units += this.tCount(i);
      q += s16(mulu(units & 0xffff, 10));
    }
    q += TAX_QOL[s.long(A.tax)] ?? 0;
    if (s.long(V.invention) & 0x10000) q += 300;
    if (s.byte(V.virusTime) !== 0) q -= 300;
    if (this.tCount(TY.commandCentre) === 0) q -= 350;
    q += Math.min(this.tCount(TY.sports), 5) * 100;
    if (s.byte(V.crowded) !== 0) q -= 400;
    if (s.byte(V.starving) !== 0) q -= 400;
    if (s.byte(V.airShort) !== 0) q -= 400;
    // Original quirk: the power-shortage term ($144C8) is added to a6, not to the sum.
    let weights = this.tCount(TY.mine);
    weights += this.tCount(TY.fuelPlant) * 3;
    weights += this.tCount(TY.powerStation) * 3;
    weights += this.tCount(TY.airA) * 2;
    weights += this.tCount(23) * 2;
    weights += this.tCount(TY.boiler);
    weights += this.tCount(22) * 2;
    weights += this.tCount(27) * 2;
    if (weights > 0x32) weights = 0x32;
    q -= mulu(weights, pollution);
    let qol = divsQ(q, 100) + 0x37;
    if (qol > 0x62) qol = 0x62;
    if (this.sysFlags & SYS.attack) qol = s16(qol - 0x1e);
    if (qol < 0x0a) qol = 0x0a;
    s.setLong(A.qualityOfLife, qol);
    if (((qol & 0xff) - 0x50) & 0x80) return;
    if ((((qol & 0xff) - 0x5a) & 0x80) !== 0) {
      const done = this.sysFlags & SYS.qol80;
      this.sysFlags |= SYS.qol80;
      if (!done) this.events.push({ kind: "announce", id: 2 });
    } else {
      this.sysFlags |= SYS.qol80;
      const done = this.sysFlags & SYS.qol90;
      this.sysFlags |= SYS.qol90;
      if (!done) this.events.push({ kind: "announce", id: 3 });
    }
  }

  // ---- yearly ----------------------------------------------------------------------------

  // $A096 plus the register copy in $99C4: the tax chosen for next year takes effect.
  // Original quirk: a tax rise applies a positive morale change.
  private yearly(): void {
    const s = this.s;
    for (let i = 0; i < 5; i++) s.setLong(0x14302 + 4 * i, s.long(0x14316 + 4 * i));
    s.setLong(0x1431a, 0);
    s.setLong(0x14326, 0);
    const oldTax = s.long(A.tax);
    const next = s.long(A.nextTax);
    s.setLong(A.tax, next);
    const rise = (next - oldTax) | 0;
    if (rise > 0) this.applyMorale(mulu(rise, 300));
    for (let i = 0; i < 5; i++) {
      s.setLong(0x1437e + 4 * i, s.long(0x14392 + 4 * i));
      s.setLong(0x14392 + 4 * i, 0);
    }
  }

  // ---- player-facing setters ---------------------------------------------------------------

  // Staffing level the player wants for a job pool (0..8): $14500[pool].
  setJobCap(pool: number, staff: number): void {
    this.s.setLong(V.jobCap + 4 * pool, staff);
  }

  // Tax rate for the next year (applied at the year change), 0..20.
  setNextTax(rate: number): void {
    this.s.setLong(A.nextTax, rate);
  }

  // Percentage of a trade commodity (0 = fuel, 1..5 = goods 0..4) the player keeps back.
  setRetainPercent(commodity: number, percent: number): void {
    this.s.setLong(V.retain + 4 * commodity, percent);
  }
}
