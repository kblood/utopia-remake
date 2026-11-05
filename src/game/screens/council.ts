// The council room (icon column button 5, $15CFE): a full-screen picture of the six advisers. Pressing
// one of them shows his portrait and caption and opens the matching F-key report (F1-F6, same order as
// the picture's rectangle table $1614E); pressing anywhere else leaves. Refused with message $B2 while
// no game is active ($133F8 = 0). Picture 2 of the table at $8C8C (sectors $2F8-$327, palette from its
// tail at $3998A), portraits in sectors $328-$34B (six 88 x 79 pixel images). Notes:
// notes/formats/screens.md section 9.

import { COLOR } from "../../data/gamefont.js";
import { decodePicture, SECTOR_SIZE, type SectorRange } from "../../data/picture.js";
import { unpackLz } from "../../data/unpack.js";
import type { Screen, Rgb } from "../../gfx/screen.js";
import type { Input } from "../intro.js";
import { GameImage } from "./image.js";
import { drawPlanar, restoreMainBackground } from "./planar.js";
import { BuildingScreen, ColonyScreen, DefenceScreen, FinanceScreen, ResearchScreen, ResourceScreen } from "./reports.js";
import type { ScreenContext, ScreenScene } from "./types.js";
import { Pointer, Ui } from "./ui.js";

const PICTURE: SectorRange = { first: 0x2f8, last: 0x327 };
const PORTRAIT_SHEET: SectorRange = { first: 0x328, last: 0x34b };
const ADVISER_RECTS = 0x1614e; // 6 x {x0, x1, y0, y1}, ended by $FFFF
const CAPTION_WINDOW = 0xe850; // {224, 112, 11, 7}
const CAPTION_LISTS = 0xe858; // 6 pointers to label lists (two lines each)
const PORTRAIT = { x: 224, y: 33, rowBytes: 11, rows: 79, planes: 5 } as const;
const PORTRAIT_BYTES = PORTRAIT.rowBytes * PORTRAIT.rows * PORTRAIT.planes;
export const ADVISER_COUNT = 6;
export const COUNCIL_REFUSAL = 0xb2;
const TRADE_ALLOWED = 0x133f8; // word: non-zero while a game is active

interface CouncilAssets {
  picture: Screen;
  portraits: Uint8Array;
}

const assetCache = new WeakMap<Uint8Array, CouncilAssets>();

function loadAssets(disk: Uint8Array): CouncilAssets {
  let a = assetCache.get(disk);
  if (!a) {
    const sheet = unpackLz(disk.subarray(PORTRAIT_SHEET.first * SECTOR_SIZE, (PORTRAIT_SHEET.last + 1) * SECTOR_SIZE));
    a = { picture: decodePicture(disk, PICTURE), portraits: sheet };
    assetCache.set(disk, a);
  }
  return a;
}

// $15CFE: why the council cannot be entered (the message-line index) or -1.
export function councilRefusal(ctx: ScreenContext): number {
  return ctx.world.state.word(TRADE_ALLOWED) === 0 ? COUNCIL_REFUSAL : -1;
}

class ClosedScreen implements ScreenScene {
  update(): "running" | "close" {
    return "close";
  }
  draw(): void {}
}

export function openCouncil(ctx: ScreenContext): ScreenScene {
  const refusal = councilRefusal(ctx);
  if (refusal >= 0) {
    ctx.say?.(refusal);
    return new ClosedScreen();
  }
  return new CouncilScreen(ctx);
}

export class CouncilScreen implements ScreenScene {
  private readonly ui: Ui;
  private readonly image: GameImage;
  private readonly assets: CouncilAssets;
  private readonly pointer = new Pointer();
  private readonly rects: { x0: number; x1: number; y0: number; y1: number }[] = [];
  private child: ScreenScene | null = null;
  private target: Screen | null = null;
  adviser = -1; // 0-5 while its report is open
  private done = false;

  constructor(private readonly ctx: ScreenContext) {
    this.ui = new Ui(ctx.disk, ctx.strings);
    this.image = this.ui.image;
    this.assets = loadAssets(ctx.disk);
    for (let a = ADVISER_RECTS; this.image.signedWord(a) !== -1; a += 8) {
      this.rects.push({ x0: this.image.word(a), x1: this.image.word(a + 2), y0: this.image.word(a + 4), y1: this.image.word(a + 6) });
    }
  }

  adviserAt(px: number, py: number): number {
    return this.rects.findIndex((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
  }

  // The report of adviser i: F1 ($B81C) ... F6 ($E1AA).
  private openReport(i: number): ScreenScene {
    const ctx = this.ctx;
    const ui = this.ui;
    const report =
      i === 0
        ? new ColonyScreen(ctx, ui)
        : i === 1
          ? new ResourceScreen(ctx, ui)
          : i === 2
            ? new FinanceScreen(ctx, ui)
            : i === 3
              ? new BuildingScreen(ctx, ui)
              : i === 4
                ? new ResearchScreen(ctx, ui)
                : new DefenceScreen(ctx, ui);
    report.setCouncilMode(); // no button column; a left press leaves
    return report;
  }

  update(input: Input): "running" | "close" {
    if (this.done) return "close";
    if (this.child) {
      // The report waits for a button and leaves; the council picture is shown again afterwards.
      if (this.child.update(input) === "close") {
        this.child = null;
        this.adviser = -1;
        this.pointer.update(input);
      }
      return "running";
    }
    const keys = input.keys ? input.keys.slice() : [];
    if (input.keys) input.keys.length = 0;
    this.pointer.update(input);
    const p = this.pointer;
    if (keys.includes("Escape") || p.rightPressed) return this.leave();
    if (p.pressedEdge) {
      const i = this.adviserAt(p.x, p.y);
      if (i < 0) return this.leave(); // a press elsewhere ends the visit ($15DBC)
      this.adviser = i;
      this.child = this.openReport(i);
    }
    return "running";
  }

  private leave(): "close" {
    this.done = true;
    if (this.target) restoreMainBackground(this.target, this.ctx.disk);
    return "close";
  }

  draw(screen: Screen): void {
    this.target = screen;
    const picture = this.assets.picture;
    screen.pixels.set(picture.pixels);
    screen.palette = picture.palette.map((c) => [...c] as Rgb);
    if (this.adviser < 0) return;
    // $E28C: caption window below the portrait, then the report on top of the left part.
    const ui = this.ui;
    ui.frame(screen, ui.readWindow(CAPTION_WINDOW));
    ui.labels(screen, ui.readLabels(this.image.long(CAPTION_LISTS + 4 * this.adviser)), COLOR.text);
    drawPlanar(screen, this.assets.portraits, this.adviser * PORTRAIT_BYTES, PORTRAIT.rowBytes * PORTRAIT.rows, PORTRAIT.rowBytes, PORTRAIT.rows, PORTRAIT.x, PORTRAIT.y);
    this.child?.draw(screen);
  }
}
