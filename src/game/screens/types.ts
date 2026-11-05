// Contract shared by the window screens (F-keys and icon screens).

import type { GameStrings } from "../../data/gamestrings.js";
import type { Screen } from "../../gfx/screen.js";
import type { Input } from "../intro.js";
import type { Sim } from "../sim.js";
import type { World } from "../world.js";

export interface ScreenScene {
  // One call per video frame. "close" = the screen was left (the map scene continues).
  update(input: Input): "running" | "close";
  // Paints the window over whatever is already in `screen` (the frozen map frame).
  draw(screen: Screen): void;
}

export interface ScreenContext {
  disk: Uint8Array; // Disk.1
  world: World;
  sim: Sim;
  strings: GameStrings;
  // Optional message line / log hook ($551A / $5A8C string indices), for refusals the
  // original reports on the map screen. The scene closes at once when it does so.
  say?: (index: number) => void;
}

export type ScreenKind = "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "trade" | "market" | "staff" | "intel";
