// Window screens of the original (F1-F6 reports, trade, market, staffing, intelligence).
// Usage: const scene = createScreen("f3", { disk, world, sim, strings }); call scene.update(input)
// once per frame and scene.draw(screen) on top of the frozen map frame until it returns "close".
// Layouts and state fields: notes/formats/screens.md.

import { BuildingScreen, ColonyScreen, DefenceScreen, FinanceScreen, ResearchScreen, ResourceScreen } from "./reports.js";
import { IntelScreen } from "./intel.js";
import { StaffingScreen } from "./staff.js";
import { MarketScreen, TradeScreen, openMarket } from "./trade.js";
import type { ScreenContext, ScreenKind, ScreenScene } from "./types.js";

export type { ScreenContext, ScreenKind, ScreenScene } from "./types.js";
export { marketRefusal } from "./trade.js";

export function createScreen(kind: ScreenKind, ctx: ScreenContext): ScreenScene {
  switch (kind) {
    case "f1":
      return new ColonyScreen(ctx);
    case "f2":
      return new ResourceScreen(ctx);
    case "f3":
      return new FinanceScreen(ctx);
    case "f4":
      return new BuildingScreen(ctx);
    case "f5":
      return new ResearchScreen(ctx);
    case "f6":
      return new DefenceScreen(ctx);
    case "trade":
      return new TradeScreen(ctx);
    case "market":
      return openMarket(ctx);
    case "staff":
      return new StaffingScreen(ctx);
    case "intel":
      return new IntelScreen(ctx);
  }
}

export { BuildingScreen, ColonyScreen, DefenceScreen, FinanceScreen, IntelScreen, MarketScreen, ResearchScreen, ResourceScreen, StaffingScreen, TradeScreen };
