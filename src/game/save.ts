// Saved games. The original writes two areas to Disk.4 (notes/formats/game-proper.md, save
// record): A = object list and map, B = the state block. A browser cannot write to the user's
// disk image, so the remake keeps its own copy of the same data in localStorage: slot 0-7,
// each holding the state image, the map cells, the object records and the scenario index.

import type { Sim } from "./sim.js";
import type { World } from "./world.js";

export const SAVE_SLOTS = 8;
const PREFIX = "utopia-remake-save-";

export interface SaveSummary {
  slot: number;
  scenario: number;
  date: string;
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface SaveData {
  scenario: number;
  state: Uint8Array;
  cells: Uint16Array;
  objects: Uint8Array;
  sysFlags: number;
  scrollX: number;
  scrollY: number;
}

export function captureGame(world: World, sim: Sim, scenario: number, scrollX: number, scrollY: number): SaveData {
  return {
    scenario,
    state: world.state.snapshot(),
    cells: world.cells.slice(),
    objects: world.objects.slice(),
    sysFlags: sim.sysFlags,
    scrollX,
    scrollY,
  };
}

export function applyGame(data: SaveData, world: World, sim: Sim): void {
  world.state.restore(data.state);
  world.cells.set(data.cells);
  world.objects.set(data.objects);
  sim.sysFlags = data.sysFlags;
}

export function writeSlot(slot: number, data: SaveData): boolean {
  const store = storage();
  if (!store) return false;
  const body = JSON.stringify({
    scenario: data.scenario,
    sysFlags: data.sysFlags,
    scrollX: data.scrollX,
    scrollY: data.scrollY,
    state: toBase64(data.state),
    cells: toBase64(new Uint8Array(data.cells.buffer, data.cells.byteOffset, data.cells.byteLength)),
    objects: toBase64(data.objects),
  });
  try {
    store.setItem(PREFIX + slot, body);
    return true;
  } catch {
    return false;
  }
}

export function readSlot(slot: number): SaveData | null {
  const store = storage();
  const text = store?.getItem(PREFIX + slot);
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const cellBytes = fromBase64(j.cells);
    return {
      scenario: j.scenario,
      sysFlags: j.sysFlags,
      scrollX: j.scrollX,
      scrollY: j.scrollY,
      state: fromBase64(j.state),
      cells: new Uint16Array(cellBytes.buffer, cellBytes.byteOffset, cellBytes.byteLength / 2),
      objects: fromBase64(j.objects),
    };
  } catch {
    return null;
  }
}

export function slotSummaries(): (SaveSummary | null)[] {
  return Array.from({ length: SAVE_SLOTS }, (_, slot) => {
    const data = readSlot(slot);
    if (!data) return null;
    const view = new DataView(data.state.buffer, data.state.byteOffset);
    const base = 0x13034;
    const day = data.state[0x1459f - base];
    const month = data.state[0x145a0 - base] + 1;
    const year = view.getUint32(0x142a6 - base);
    return { slot, scenario: data.scenario, date: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}` };
  });
}
