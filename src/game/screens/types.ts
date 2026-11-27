// Contract shared by the window screens (F-keys and icon screens).

import type { GameStrings } from "../../data/gamestrings.js";
import type { Screen } from "../../gfx/screen.js";
import type { Input } from "../intro.js";
import type { ObjectLayer } from "../objects.js";
import type { Sim } from "../sim.js";
import type { World } from "../world.js";

export interface IntelligenceAssets {
  portraits: Uint8Array;
  text: Uint8Array;
}

export interface ScreenScene {
  // One call per video frame. "close" = the screen was left (the map scene continues).
  update(input: Input): "running" | "close";
  // Paints the window over whatever is already in `screen` (the frozen map frame). The full-screen
  // scenes ("overview", "council") replace the whole frame and its palette; when they close they put
  // the gameplay background and palette back into the screen they last drew on.
  draw(screen: Screen): void;
}

// Positions (map cells) of the unit classes the overview map colours besides own ground units, which it
// reads from `ScreenContext.objects`. `Game.screenContext()` supplies these from the live EnemySystem.
export interface Cell {
  x: number;
  y: number;
}

export interface OverviewUnits {
  own: Cell[]; // list $3AB06
  ships: Cell[]; // list $3A746
  enemyGround: Cell[]; // list $3A12C
  enemyAir: Cell[]; // list $39E20
}

export interface ScreenContext {
  disk: Uint8Array; // Disk.1
  world: World;
  sim: Sim;
  strings: GameStrings;
  intelligence?: IntelligenceAssets;
  // Optional message line / log hook ($551A / $5A8C string indices), for refusals the
  // original reports on the map screen. The scene closes at once when it does so.
  say?: (index: number) => void;
  // Live scroll position of the map view ($144E4/$144E6). The overview reads it when it opens and writes
  // the clicked position back; without it the words in the state image are used.
  scroll?: { x: number; y: number };
  // Units, marker pins and effects of the map scene. The overview shows the own ground units and the
  // pins, and clicks in its preview window place or lift pins through it.
  objects?: ObjectLayer;
  // Extra unit classes for the overview map (ships, enemy ground units and aircraft).
  otherUnits?: () => Partial<OverviewUnits>;
  // The map's press latch (`$156A9` bit 0, a scroll arrow pressed with the left button, held since): a window opened while it
  // is set starts its `$50B2` poll with it, so a held left button repeats its press each pass (mouse-poll.ts). Absent = clear.
  pressLatch?: () => boolean;
  // Sound hook (SFX id, see audio/sfx.ts). PanelScene and OverviewScreen call it once with SFX.CLICK when a
  // button is pressed ($5756/$5948 request id 4; release routines $57FA/$59C8 are silent). PanelScene stays silent while a
  // number entry is open ($5110 never reaches $5756). Absent = silent.
  sound?: (id: number) => void;
}

export type ScreenKind = "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "trade" | "market" | "staff" | "intel" | "overview" | "council";
