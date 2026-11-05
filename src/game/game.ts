// Scene flow of the whole program: credit roll -> language -> scenario choice -> map, with the
// disk menu (save / load / new scenario) opened from the map. Follows the original's stages
// (notes/formats/text.md, game-proper.md); the slide show and code check are left out.

import type { Music } from "../audio/music.js";
import { GameStrings } from "../data/gamestrings.js";
import { loadMap, loadTileSet, readScenarioRecords, type ScenarioRecord } from "../data/scenario.js";
import type { Screen } from "../gfx/screen.js";
import { loadSprites } from "../data/sprites.js";
import { AnnounceScene } from "./announce.js";
import { OfferScene } from "./offer.js";
import { IntroScene, type Input } from "./intro.js";
import { LanguageScene, type Language } from "./language.js";
import { MapScene } from "./map.js";
import { MenuScene } from "./menu.js";
import { applyGame, captureGame, readSlot, SAVE_SLOTS, slotSummaries, writeSlot } from "./save.js";
import { GameState } from "./state.js";
import { World } from "./world.js";

type Stage = "intro" | "language" | "scenario" | "map" | "disk" | "save" | "load" | "announce" | "offer";

export class Game {
  private stage: Stage = "intro";
  private readonly intro: IntroScene;
  private language: LanguageScene | null = null;
  private strings: GameStrings | null = null;
  private menu: MenuScene | null = null;
  private announce: AnnounceScene | null = null;
  private offer: OfferScene | null = null;
  private map: MapScene | null = null;
  private scenario = 0;
  private readonly records: ScenarioRecord[];
  pointerVisible = false;

  constructor(
    private readonly disk1: Uint8Array,
    private readonly disk2: Uint8Array,
    private readonly music: Music | null = null,
  ) {
    this.intro = new IntroScene(disk1);
    this.records = readScenarioRecords(disk2);
  }

  get screen(): Screen {
    if (this.stage === "intro") return this.intro.screen;
    if (this.stage === "language") return this.language!.screen;
    if (this.announce) return this.announce.screen;
    if (this.menu) return this.menu.screen;
    return this.map!.screen;
  }

  private openMenu(stage: Stage, title: string, labels: { label: string; enabled?: boolean }[]): void {
    this.stage = stage;
    this.menu = new MenuScene(this.disk1, title, labels);
  }

  private startScenario(index: number): void {
    const record = this.records[index];
    this.scenario = index;
    this.map = new MapScene(
      this.disk1,
      loadTileSet(this.disk1, this.disk2, record).tiles,
      new World(new GameState(this.disk2, record.block), loadMap(this.disk2, record)),
      this.strings!,
      { onDiskMenu: () => this.openDiskMenu(), sprites: loadSprites(this.disk1, this.disk2, record) },
    );
    this.menu = null;
    this.stage = "map";
    // Which track belongs to which screen is not known (notes/formats/music.md): track 0 for
    // the title and menus, one of the other three per scenario in the game.
    this.music?.play(1 + (index % 3));
  }

  private openScenarioMenu(): void {
    this.openMenu(
      "scenario",
      "CHOOSE A SCENARIO",
      this.records.map((r, i) => ({ label: `${i + 1}. ${r.name || "SCENARIO"}` })),
    );
  }

  private openDiskMenu(): void {
    this.openMenu("disk", "DISK MENU", [{ label: "SAVE GAME" }, { label: "LOAD GAME" }, { label: "NEW SCENARIO" }, { label: `MUSIC: TRACK ${(this.music?.current ?? 0) + 1}`, enabled: this.music !== null }, { label: "BACK TO GAME" }]);
  }

  private slotLabels(): { label: string; enabled?: boolean }[] {
    return slotSummaries().map((s, i) => ({ label: s ? `SLOT ${i + 1}  ${s.date}` : `SLOT ${i + 1}  EMPTY` }));
  }

  update(input: Input): void {
    switch (this.stage) {
      case "intro":
        if (this.intro.update(input) === "clicked") {
          this.language = new LanguageScene(this.disk1, this.intro.screen);
          this.music?.play(0);
          this.stage = "language";
        }
        break;
      case "language": {
        this.pointerVisible = this.language!.pointerVisible;
        const result = this.language!.update(input);
        if (result.state === "chosen") {
          this.strings = new GameStrings(this.disk1, result.language as Language);
          this.pointerVisible = true;
          this.openScenarioMenu();
        }
        break;
      }
      case "scenario": {
        const choice = this.menu!.update(input);
        if (choice !== null && choice >= 0) this.startScenario(choice);
        break;
      }
      case "map": {
        const map = this.map!;
        map.update(input);
        for (const event of map.sim.events.splice(0)) {
          if (event.kind === "invention") map.announceInvention(event.bit);
          if (event.kind === "announce" && !this.announce) {
            this.announce = new AnnounceScene(this.disk1, this.strings!, map.screen, event.id);
            this.stage = "announce";
          }
        }
        if (map.sim.pending && !this.announce && this.stage === "map") {
          this.offer = new OfferScene(this.disk1, this.strings!, map.sim.pending.offer);
          this.stage = "offer";
        }
        break;
      }
      case "offer": {
        const map = this.map!;
        this.offer!.draw(map.screen);
        const answer = this.offer!.update(input);
        if (answer !== null) {
          map.sim.resolveOffer(answer);
          this.offer = null;
          this.stage = "map";
        }
        break;
      }
      case "announce": {
        if (this.announce!.update(input)) {
          const over = this.announce!.id === 1;
          this.announce = null;
          if (over) this.openScenarioMenu();
          else this.stage = "map";
        }
        break;
      }
      case "disk": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        if (choice === 0) this.openMenu("save", "SAVE GAME", this.slotLabels());
        else if (choice === 1) this.openMenu("load", "LOAD GAME", this.slotLabels());
        else if (choice === 2) this.openScenarioMenu();
        else if (choice === 3 && this.music) {
          this.music.play(((this.music.current < 0 ? 0 : this.music.current) + 1) % this.music.trackCount);
          this.openDiskMenu();
        } else this.closeMenu();
        break;
      }
      case "save": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        if (choice >= 0 && choice < SAVE_SLOTS) {
          const map = this.map!;
          writeSlot(choice, captureGame(map.sim.world, map.sim, this.scenario, map.scrollX, map.scrollY));
        }
        this.closeMenu();
        break;
      }
      case "load": {
        const choice = this.menu!.update(input);
        if (choice === null) break;
        const data = choice >= 0 ? readSlot(choice) : null;
        if (data) {
          this.startScenario(data.scenario);
          const map = this.map!;
          applyGame(data, map.sim.world, map.sim);
          map.scrollX = data.scrollX;
          map.scrollY = data.scrollY;
        } else {
          this.closeMenu();
        }
        break;
      }
    }
  }

  private closeMenu(): void {
    this.menu = null;
    this.stage = "map";
  }
}
