// Game state as the original keeps it: one flat memory image holding the scenario block
// (loaded from Disk.2) followed by the variable block. Addresses are the original's, so the
// notes in notes/formats/game-state.md apply directly, and saving to Disk.4 stays possible.

import { SECTOR_SIZE, type SectorRange } from "../data/picture.js";

export const STATE_BASE = 0x13034;
/** The scenario's displayed start year; `$142A6` counts elapsed years from this date. */
export const START_YEAR = 2090;
const SCENARIO_BYTES = 9 * SECTOR_SIZE; // $13034-$14233
export const STATE_BYTES = 0x1600; // through $14633: scenario block + variable block

// Variable block addresses (see game-state.md, section 3).
export const A = {
  money: 0x135ba,
  population: 0x1314a,
  freeColonists: 0x13136,
  qualityOfLife: 0x142c6,
  year: 0x142a6,
  retainPercent: 0x144cc,
  morale: 0x144ec,
  pollution: 0x144f0,
  tax: 0x144f4,
  nextTax: 0x144f8,
  frameCountdown: 0x14590,
  stepByte: 0x14591,
  techLevel: 0x14592,
  day: 0x1459f,
  month: 0x145a0,
  weekday: 0x145a1,
  difficulty: 0x145a2,
  pending: 0x144c1,
  scrollX: 0x144e4,
  scrollY: 0x144e6,
} as const;

// Bits of the pending-period byte ($144C1).
export const PERIOD = { daily: 1, weekly: 2, monthly: 4, yearly: 8, special: 16 } as const;

const FRAMES_PER_DAY = 90;
const DAYS_PER_MONTH = 28;
const MONTHS_PER_YEAR = 12;
const WEEK = 7;

/** Why a snapshot-based constructor (GameState.fromSnapshot, World.fromSnapshot) refused its input. */
export type SnapshotErrorCode = "not-bytes" | "state-size" | "map-size" | "flags-size" | "object-size" | "object-count";

export interface SnapshotError {
  readonly code: SnapshotErrorCode;
  readonly message: string;
}

export type SnapshotResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SnapshotError };

// Module-private marker: selects the constructor overload that adopts a finished image.
const FROM_IMAGE: unique symbol = Symbol("GameState.fromSnapshot");

export class GameState {
  private readonly bytes = new Uint8Array(STATE_BYTES);
  private readonly view = new DataView(this.bytes.buffer);

  constructor(disk2: Uint8Array, block: SectorRange);
  /** Internal: adopts a validated image verbatim; use GameState.fromSnapshot. */
  constructor(marker: typeof FROM_IMAGE, image: Uint8Array);
  constructor(source: Uint8Array | typeof FROM_IMAGE, arg: SectorRange | Uint8Array) {
    if (source === FROM_IMAGE) {
      this.bytes.set(arg as Uint8Array);
      return;
    }
    const block = arg as SectorRange;
    const raw = source.subarray(block.first * SECTOR_SIZE, (block.last + 1) * SECTOR_SIZE);
    if (raw.length !== SCENARIO_BYTES) throw new Error(`GameState: scenario block is ${raw.length} bytes`);
    this.bytes.set(raw, 0);
    this.applyDefaults();
  }

  /**
   * Builds a state from a complete flat image ($13034-$14633, STATE_BYTES) byte for byte: the
   * scenario block and the variable block are adopted as given. The new-game defaults ($866E) are NOT
   * applied and nothing is normalised or clamped. The image is copied, so the caller's buffer stays
   * independent. Pure: no existing state is touched, and a bad input yields a typed error and no object.
   */
  static fromSnapshot(image: Uint8Array): SnapshotResult<GameState> {
    if (!(image instanceof Uint8Array)) return { ok: false, error: { code: "not-bytes", message: "State image must be a Uint8Array" } };
    if (image.length !== STATE_BYTES) {
      return { ok: false, error: { code: "state-size", message: `State image is ${image.length} bytes, expected exactly ${STATE_BYTES}` } };
    }
    return { ok: true, value: new GameState(FROM_IMAGE, image) };
  }

  // The whole flat image ($13034-$14633), as the original's save area B holds it.
  snapshot(): Uint8Array {
    return this.bytes.slice();
  }

  restore(image: Uint8Array): void {
    if (image.length !== STATE_BYTES) throw new Error("GameState.restore: wrong image size");
    this.bytes.set(image);
  }

  byte(addr: number): number {
    return this.bytes[addr - STATE_BASE];
  }

  setByte(addr: number, value: number): void {
    this.bytes[addr - STATE_BASE] = value & 0xff;
  }

  word(addr: number): number {
    return this.view.getUint16(addr - STATE_BASE);
  }

  setWord(addr: number, value: number): void {
    this.view.setUint16(addr - STATE_BASE, value & 0xffff);
  }

  long(addr: number): number {
    return this.view.getUint32(addr - STATE_BASE);
  }

  signedLong(addr: number): number {
    return this.view.getInt32(addr - STATE_BASE);
  }

  setLong(addr: number, value: number): void {
    this.view.setUint32(addr - STATE_BASE, value >>> 0);
  }

  // The defaults the original sets in $866E after zeroing $14234-$144CB.
  private applyDefaults(): void {
    this.bytes.fill(0, 0x14234 - STATE_BASE, 0x144cc - STATE_BASE);
    for (let i = 0; i < 6; i++) this.setLong(A.retainPercent + 4 * i, 100);
    this.setWord(A.scrollX, 0x2f);
    this.setWord(A.scrollY, 0x21);
    this.setWord(0x144e8, 0x2f);
    this.setWord(0x144ea, 0x21);
    this.setLong(A.morale, 5000);
    this.setLong(A.pollution, 50);
    this.setLong(A.tax, 10);
    this.setLong(A.nextTax, 10);
    this.setWord(0x1453e, 2); // `$8B02`'s current Disk.2 id
    for (let i = 0; i < 8; i++) {
      this.setByte(0x14540 + 10 * i, i + 1); // marker ids are static image data, not reset by `$866E`
      this.setByte(0x14540 + 10 * i + 2, 0xff); // marker slots unused
    }
    this.setByte(A.frameCountdown, FRAMES_PER_DAY);
    this.setByte(A.stepByte, 1);
    this.setByte(A.techLevel, 1);
    this.setByte(A.day, 0x1c);
    this.setByte(A.month, 5);
    this.setByte(A.weekday, 0);
    this.setByte(A.difficulty, 0x1e);
    this.setLong(A.year, 0);
    // These combat values live after the variable block cleared above. They are initialized data in the
    // original image, so reproduce them when constructing a new scenario state.
    this.setByte(0x145a3, 1);
    [0, 2, 3, 4, 3, 1].forEach((value, i) => this.setByte(0x145a4 + i, value));
  }

  // Called once per video frame. Returns the period bits that became due (daily, weekly, ...).
  tickFrame(): number {
    return this.countFrame() ? this.advanceDay() : 0;
  }

  // The VBL half of the day timer ($14590): one decrement per video frame; true when it ran out and was reloaded
  // (the original then flags the date change for the next main-loop pass; here the caller queues it).
  countFrame(): boolean {
    const left = this.byte(A.frameCountdown) - 1;
    if (left > 0) {
      this.setByte(A.frameCountdown, left);
      return false;
    }
    this.setByte(A.frameCountdown, FRAMES_PER_DAY);
    return true;
  }

  // $564A: day, weekday, month and year chain. 28-day months, 12 months, 7-day weeks. Returns the period bits
  // that became due (also OR-ed into the pending byte).
  advanceDay(): number {
    let due: number = PERIOD.daily;
    let day = this.byte(A.day) + 1;
    if (day > DAYS_PER_MONTH) {
      day = 1;
      due |= PERIOD.monthly;
      const month = (this.byte(A.month) + 1) % MONTHS_PER_YEAR;
      this.setByte(A.month, month);
      if (month === 0) {
        due |= PERIOD.yearly;
        this.setLong(A.year, this.long(A.year) + 1);
      }
    }
    this.setByte(A.day, day);
    const weekday = (this.byte(A.weekday) + 1) % WEEK;
    this.setByte(A.weekday, weekday);
    if (weekday === 0) due |= PERIOD.weekly;
    this.setByte(A.pending, this.byte(A.pending) | due);
    return due;
  }

  // "dd/mm/yyyy", as shown in the top bar.
  dateText(): string {
    const dd = String(this.byte(A.day)).padStart(2, "0");
    const mm = String(this.byte(A.month) + 1).padStart(2, "0");
    return `${dd}/${mm}/${START_YEAR + this.long(A.year)}`;
  }

  // Money as the top bar shows it: clamped to 9,999,999.
  displayMoney(): number {
    return Math.max(0, Math.min(9_999_999, this.signedLong(A.money)));
  }
}
