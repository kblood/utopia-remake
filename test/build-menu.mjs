// Checks of the build menu panel (src/game/build-menu.ts) and its wiring in Controls. Run after `npm run build`.
// Part 1 uses synthetic tiles only (tile / mask / row order / 2 x 2 composition / page data / hit rectangles).
// Part 2 uses the player's own Disk.1 / Disk.2 in original/utopia-whdload and is skipped when they are missing: it
// compares the page and rectangle constants with the static tables of the game image, renders all three pages
// (with and without research substitutions), checks the name / price lines, panel and side previews, the T[22] price
// 6000, and that rendering reads but never writes the disks, the game state, the world or the tile images.
// These are static-derived layout checks of the remake; they are not an art-parity comparison with the running original.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bm = await import("../dist/game/build-menu.js");
const { Screen } = await import("../dist/gfx/screen.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// ---- 1. synthetic ------------------------------------------------------------------------------------------------
function colourTile(rows, colourOfRow, maskByte = 0xff) {
  const planeBytes = rows * 4;
  const planes = new Uint8Array(6 * planeBytes);
  for (let row = 0; row < rows; row++) {
    const colour = colourOfRow(row);
    for (let p = 0; p < 5; p++) if ((colour >> p) & 1) planes.fill(0xff, p * planeBytes + row * 4, p * planeBytes + row * 4 + 4);
  }
  planes.fill(maskByte, 5 * planeBytes, 6 * planeBytes);
  return { rows, planes };
}
const pixel = (screen, x, y) => screen.pixels[y * 320 + x];

{
  // Row order: stored row 0 is the BOTTOM row and is drawn on `bottomRow` ($69D8 draws upward from the given row).
  const screen = new Screen();
  screen.pixels.fill(31);
  bm.blitTile(screen, colourTile(3, (r) => r + 1), 10, 50);
  check("blitTile: stored row 0 lands on the bottom row, later rows go up", pixel(screen, 10, 50) === 1 && pixel(screen, 10, 49) === 2 && pixel(screen, 10, 48) === 3 && pixel(screen, 10, 47) === 31 && pixel(screen, 10, 51) === 31);
  check("blitTile: 32 pixels wide", pixel(screen, 41, 50) === 1 && pixel(screen, 42, 50) === 31 && pixel(screen, 9, 50) === 31);
}
{
  // The sixth plane is a mask: only pixels with a set mask bit are painted, the rest keep the background.
  const screen = new Screen();
  screen.pixels.fill(31);
  bm.blitTile(screen, colourTile(2, () => 5, 0xf0), 0, 20);
  check("blitTile: mask bits select pixels (left nibble of each byte painted, right nibble untouched)", pixel(screen, 0, 20) === 5 && pixel(screen, 3, 20) === 5 && pixel(screen, 4, 20) === 31 && pixel(screen, 8, 20) === 5 && pixel(screen, 12, 20) === 31 && pixel(screen, 31, 20) === 31);
  const blank = new Screen();
  blank.pixels.fill(7);
  bm.blitTile(blank, colourTile(2, () => 9, 0x00), 0, 20);
  check("blitTile: an all-zero mask paints nothing", blank.pixels.every((v) => v === 7));
  bm.blitTile(blank, undefined, 0, 20);
  check("blitTile: a missing tile image is skipped", blank.pixels.every((v) => v === 7));
  const edge = new Screen();
  bm.blitTile(edge, colourTile(2, () => 3), 310, 199);
  bm.blitTile(edge, colourTile(2, () => 3), -8, 0);
  check("blitTile: off-screen pixels are dropped without error", pixel(edge, 319, 199) === 3 && pixel(edge, 0, 0) === 3);
}
{
  // 2 x 2 composition: ids $48-$5F are four consecutive tiles drawn top, right, left, bottom (later pieces overwrite).
  check("isQuadTile covers exactly $48-$5F", !bm.isQuadTile(0x47) && bm.isQuadTile(0x48) && bm.isQuadTile(0x5f) && !bm.isQuadTile(0x60) && !bm.isQuadTile(0x01));
  const single = bm.tilePlacements(0x45, 16, 130);
  check("tilePlacements: a single tile is one placement at (x, row)", single.length === 1 && single[0].tile === 0x45 && single[0].x === 16 && single[0].bottomRow === 130);
  const quad = bm.tilePlacements(0x48, 100, 100);
  check(
    "tilePlacements: quad = top (x,r-16), right (x+16,r-8), left (x-16,r-8), bottom (x,r) in that draw order",
    quad.map((p) => `${p.tile}:${p.x}:${p.bottomRow}`).join() === "72:100:84,73:116:92,74:84:92,75:100:100",
    quad.map((p) => `${p.tile}:${p.x}:${p.bottomRow}`).join(),
  );
  const tiles = [];
  for (let k = 0; k < 4; k++) tiles[0x47 + k] = colourTile(12, () => k + 1);
  const screen = new Screen();
  screen.pixels.fill(31);
  const before = tiles.map((t) => t && t.planes.slice());
  for (const p of quad) bm.blitTile(screen, tiles[p.tile - 1], p.x, p.bottomRow);
  check("composite: single-piece areas show that piece (top 1, right 2, left 3)", pixel(screen, 105, 75) === 1 && pixel(screen, 140, 85) === 2 && pixel(screen, 90, 85) === 3);
  check("composite: overlap order right over top, left over top, bottom over both", pixel(screen, 120, 82) === 2 && pixel(screen, 105, 82) === 3 && pixel(screen, 105, 90) === 4 && pixel(screen, 120, 90) === 4);
  const drawn = new Screen();
  drawn.pixels.fill(31);
  bm.drawBuilding(drawn, tiles, 0x48, 100, 100);
  check("drawBuilding composes the same pixels as the placements", Buffer.compare(Buffer.from(drawn.pixels), Buffer.from(screen.pixels)) === 0);
  check("drawing leaves the tile images unchanged", tiles.every((t, i) => !t || Buffer.compare(Buffer.from(t.planes), Buffer.from(before[i])) === 0));
}
{
  // Page data: the lists and research substitutions of $B2AA, the rectangles $E9E2 / $EA3C.
  const hex = (a) => a.map((t) => t.toString(16)).join(",");
  // `$B2AA` sets page 1 slot 10 and page 2 slots 8-10 to $FFFF on every open; only research bits 15 / 0 / 5 / 6 fill them.
  check("page 1 list without research (slot 10 blank = -1)", hex(bm.menuTiles(0, 0)) === "2f,1,41,44,3e,6,60,1f,30,33,-1", hex(bm.menuTiles(0, 0)));
  check("page 2 list without research (slots 8-10 blank)", hex(bm.menuTiles(1, 0)) === "e,3d,3f,4,43,45,46,36,-1,-1,-1", hex(bm.menuTiles(1, 0)));
  check("page 3 list", hex(bm.menuTiles(2, 0)) === "48,4c,54,58,5c");
  check(
    "page 1 research bits 12,7,11,13,14,15 replace slots 2,5,7,8,9,10",
    hex(bm.menuTiles(0, (1 << 12) | (1 << 7) | (1 << 11) | (1 << 13) | (1 << 14) | (1 << 15))) === "2f,1,42,44,3e,a,60,f,31,34,47",
  );
  check("page 2 research bits 1,0,5,6 replace slots 2,8,9,10", hex(bm.menuTiles(1, (1 << 1) | 1 | (1 << 5) | (1 << 6))) === "e,3d,40,4,43,45,46,36,3c,35,61");
  check("each bit alone changes only its own slot", hex(bm.menuTiles(0, 1 << 12)) === "2f,1,42,44,3e,6,60,1f,30,33,-1" && hex(bm.menuTiles(0, 1 << 15)) === "2f,1,41,44,3e,6,60,1f,30,33,47" && hex(bm.menuTiles(1, 1)) === "e,3d,3f,4,43,45,46,36,3c,-1,-1" && hex(bm.menuTiles(1, 1 << 6)) === "e,3d,3f,4,43,45,46,36,-1,-1,61");
  check("research-gated slots are not items until researched: 10, 8, 5 items (11, 11, 5 with every bit)", [0, 1, 2].map((p) => bm.menuItems(p, 0).length).join() === "10,8,5" && [0, 1, 2].map((p) => bm.menuItems(p, 0xffff).length).join() === "11,11,5");
  let consistent = true;
  for (let page = 0; page < bm.MENU_PAGE_COUNT; page++) {
    for (const item of bm.menuItems(page, 0)) {
      const cx = (item.hitbox.x0 + item.hitbox.x1) >> 1;
      const cy = (item.hitbox.y0 + item.hitbox.y1) >> 1;
      if (bm.menuHitIndex(page, cx, cy) !== item.index) consistent = false;
      if (bm.menuHitIndex(page, item.hitbox.x0, item.hitbox.y0) !== item.index || bm.menuHitIndex(page, item.hitbox.x1, item.hitbox.y1) !== item.index) consistent = false;
    }
  }
  check("hit testing returns the displayed item's own index (inclusive rectangle corners)", consistent);
  check("outside every rectangle there is no hit", bm.menuHitIndex(0, 10, 10) === -1 && bm.menuHitIndex(0, 208, 50) === -1 && bm.menuHitIndex(2, 16, 100) === 0 && bm.menuHitIndex(2, 16, 101) === -1 && bm.menuHitIndex(2, 16, 104) === -1 && bm.menuHitIndex(2, 16, 105) === 3);
  check(
    "page 3 is made of 2 x 2 buildings, anchored +16 in x with the bottom tile on the rectangle's last row",
    bm.menuItems(2, 0).every((it) => {
      const p = bm.itemPlacements(it);
      return p.length === 4 && p[3].x === it.hitbox.x0 + 16 && p[3].bottomRow === it.hitbox.y1 && p[2].x === it.hitbox.x0 && p[1].x === it.hitbox.x0 + 32;
    }),
  );
  const first = bm.itemPlacements(bm.menuItems(0, 0)[0]);
  check("1 x 1 items are anchored at the rectangle's left edge and last row", first.length === 1 && first[0].x === 16 && first[0].bottomRow === 80 && first[0].tile === 0x2f);
}

// ---- 2. local game data ------------------------------------------------------------------------------------------
const d1 = path.join(root, "original", "utopia-whdload", "Disk.1");
const d2 = path.join(root, "original", "utopia-whdload", "Disk.2");
if (!fs.existsSync(d1) || !fs.existsSync(d2)) {
  console.log("build-menu game-data checks skipped: original/utopia-whdload/Disk.1 or Disk.2 not found");
} else {
  const { readScenarioRecords, loadMap, loadTileSet } = await import("../dist/data/scenario.js");
  const { GameState } = await import("../dist/game/state.js");
  const { World } = await import("../dist/game/world.js");
  const { Builder } = await import("../dist/game/build.js");
  const { Controls } = await import("../dist/game/controls.js");
  const { GameStrings } = await import("../dist/data/gamestrings.js");
  const { drawGameText, COLOR } = await import("../dist/data/gamefont.js");
  const { readFlagTable, readWeights } = await import("../dist/data/gameimage.js");
  const { GameImage } = await import("../dist/game/screens/image.js");
  const { Ui } = await import("../dist/game/screens/ui.js");

  const disk1 = new Uint8Array(fs.readFileSync(d1));
  const disk2 = new Uint8Array(fs.readFileSync(d2));
  const record = readScenarioRecords(disk2)[0];
  const tileSet = loadTileSet(disk1, disk2, record);
  const strings = new GameStrings(disk1, 0);
  const world = new World(new GameState(disk2, record.block), loadMap(disk2, record));
  const builder = new Builder(world, readFlagTable(disk1), readWeights(disk1), () => {});
  const s = world.state;
  const img = new GameImage(disk1);

  // Static tables of the game image against the constants (read-only).
  {
    const baseTiles = (a) => Array.from({ length: 11 }, (_, i) => img.word(a + 2 * i));
    check("page 1 list matches $E9A0 in the image", baseTiles(0xe9a0).join() === bm.MENU_PAGES[0].tiles.join());
    check("page 2 list matches $E9B6 in the image", baseTiles(0xe9b6).join() === bm.MENU_PAGES[1].tiles.join());
    check("page 3 list matches $E9CC (five entries then $FFFF)", baseTiles(0xe9cc).join() === [...bm.MENU_PAGES[2].tiles, ...Array(6).fill(0xffff)].join());
    const rect = (a, i) => ({ x0: img.word(a + 8 * i), x1: img.word(a + 8 * i + 2), y0: img.word(a + 8 * i + 4), y1: img.word(a + 8 * i + 6) });
    const same = (a, b) => a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
    check("pages 1 and 2 rectangles match the 11 entries of $E9E2", [0, 1].every((p) => bm.BUILD_MENU_HITBOXES[p].every((r, i) => same(r, rect(0xe9e2, i)))) && img.signedWord(0xe9e2 + 8 * 11) === -1);
    check("page 3 rectangles match the first five entries of $EA3C", bm.BUILD_MENU_HITBOXES[2].every((r, i) => same(r, rect(0xea3c, i))));
    check("page pointer pairs at $E988 are (E9A0,E9E2) (E9B6,E9E2) (E9CC,EA3C)", [0xe9a0, 0xe9e2, 0xe9b6, 0xe9e2, 0xe9cc, 0xea3c].every((v, i) => img.long(0xe988 + 4 * i) === v));
    check("panel window $E908 is {0,24,31,21} and buttons 8 / 9 have their own images", img.word(0xe908) === 0 && img.word(0xe90a) === 24 && img.word(0xe90c) === 31 && img.word(0xe90e) === 21 && img.long(0xe95c + 32) === 0x174c2 && img.long(0xe95c + 36) === 0x17422 && Array.from({ length: 8 }, (_, i) => img.long(0xe95c + 4 * i)).every((v) => v === 0));
    check("the cost string (index $26) has a five-character number placeholder at offset 6", strings.placeholder(0x26) === 6 && strings.get(0x26).slice(6, 11).every((c) => c === 0x78));
  }

  const copy = (a) => Uint8Array.from(a);
  const snapshots = () => ({ d1: copy(disk1), d2: copy(disk2), state: s.snapshot(), cells: copy(world.cells), objects: copy(world.objects), flags: copy(world.cellFlags), tiles: tileSet.tiles.map((t) => copy(t.planes)) });
  const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

  const renderer = new bm.BuildMenuRenderer(disk1, strings, tileSet.tiles);
  const render = (view, r = renderer) => {
    const screen = new Screen();
    screen.pixels.fill(0);
    r.draw(screen, view);
    return screen;
  };
  const diffRect = (a, b) => {
    let box = null;
    for (let i = 0; i < a.pixels.length; i++) {
      if (a.pixels[i] === b.pixels[i]) continue;
      const x = i % 320;
      const y = (i / 320) | 0;
      box = box ? { x0: Math.min(box.x0, x), x1: Math.max(box.x1, x), y0: Math.min(box.y0, y), y1: Math.max(box.y1, y), n: box.n + 1 } : { x0: x, x1: x, y0: y, y1: y, n: 1 };
    }
    return box;
  };

  const before = snapshots();
  const allResearch = (1 << 12) | (1 << 7) | (1 << 11) | (1 << 13) | (1 << 14) | (1 << 15) | (1 << 1) | 1 | (1 << 5) | (1 << 6);
  const bare = new bm.BuildMenuRenderer(disk1, strings, []); // same panel without art
  const base = { selected: null, detail: null };

  for (let page = 0; page < 3; page++) {
    for (const bits of [0, allResearch]) {
      const view = { page, researchBits: bits, ...base };
      const withArt = render(view);
      const noArt = render(view, bare);
      const items = bm.menuItems(page, bits);
      // Expected: the artless panel plus the item placements composed in order with the independent blit.
      const expected = new Screen();
      expected.pixels.set(noArt.pixels);
      for (const it of items) for (const p of bm.itemPlacements(it)) bm.blitTile(expected, tileSet.tiles[p.tile - 1], p.x, p.bottomRow);
      check(`page ${page + 1} (research ${bits ? "all" : "none"}): artwork is exactly the item placements over the panel`, same(withArt.pixels, expected.pixels));
      const box = diffRect(withArt, noArt);
      check(`page ${page + 1} (research ${bits ? "all" : "none"}): artwork stays inside the item area (x 16-239, y 40-156)`, box !== null && box.x0 >= 16 && box.x1 <= 239 && box.y0 >= 40 && box.y1 <= 156, JSON.stringify(box));
      check(`page ${page + 1} (research ${bits ? "all" : "none"}): every placement has a decoded tile image`, items.every((it) => bm.itemPlacements(it).every((p) => tileSet.tiles[p.tile - 1] && tileSet.tiles[p.tile - 1].rows > 0)));
    }
  }
  {
    const p0 = render({ page: 0, researchBits: 0, ...base });
    const p1 = render({ page: 1, researchBits: 0, ...base });
    const p2 = render({ page: 2, researchBits: 0, ...base });
    check("the three pages render differently", !same(p0.pixels, p1.pixels) && !same(p1.pixels, p2.pixels) && !same(p0.pixels, p2.pixels));
    // Independent decode of page 1 item 0 (tile $2F): every opaque pixel sits at (x0 + px, y1 - row), image rows bottom first.
    const t = tileSet.tiles[0x2f - 1];
    const pb = t.rows * 4;
    let ok = true;
    for (let row = 0; row < t.rows; row++) {
      for (let px = 0; px < 32; px++) {
        const at = row * 4 + (px >> 3);
        const bit = 7 - (px & 7);
        if (((t.planes[5 * pb + at] >> bit) & 1) === 0) continue;
        let idx = 0;
        for (let pl = 0; pl < 5; pl++) idx |= ((t.planes[pl * pb + at] >> bit) & 1) << pl;
        if (p0.pixels[(80 - row) * 320 + 16 + px] !== idx) ok = false;
      }
    }
    check("page 1 item 0 (tile $2F) matches an independent plane decode at (16, bottom row 80)", ok);
    check("1 x 1 tile heights fit their rectangles (all page 1 / 2 tiles have <= 31 rows)", [...bm.MENU_PAGES[0].tiles, ...bm.MENU_PAGES[1].tiles].every((id) => tileSet.tiles[id - 1].rows <= 31));
  }
  // Detail lines (name, T+6 price) and the "can't afford" line.
  {
    const view = { page: 1, researchBits: 0, selected: null };
    const none = render({ ...view, detail: null });
    const ok = render({ ...view, detail: { nameIndex: 27, cost: 6000, affordable: true } });
    const poor = render({ ...view, detail: { nameIndex: 27, cost: 6000, affordable: false } });
    const other = render({ ...view, detail: { nameIndex: 27, cost: 7000, affordable: true } });
    const expected = new Screen();
    expected.pixels.set(none.pixels);
    drawGameText(disk1, expected, strings.get(27), 16, 159, COLOR.text);
    const template = strings.get(0x26);
    const digits = new Ui(disk1, strings).numberText(6000, 5);
    for (let i = 0; i < 5; i++) template[6 + i] = digits[i];
    drawGameText(disk1, expected, template, 16, 168, COLOR.text);
    check("name at (16,159) and price line at (16,168) with '#6000' digits for T[22]'s 6000", same(ok.pixels, expected.pixels));
    const box = diffRect(ok, none);
    check("detail lines stay within rows 159-173 right of x=16 and below the item grid", box !== null && box.y0 >= 159 && box.y1 <= 173 && box.x0 >= 16, JSON.stringify(box));
    const boxPoor = diffRect(poor, ok);
    check("unaffordable adds only the message line at y=177", boxPoor !== null && boxPoor.y0 >= 177 && boxPoor.y1 <= 182 && boxPoor.x0 >= 16, JSON.stringify(boxPoor));
    const boxCost = diffRect(other, ok);
    check("a different price changes only the digits of the price line", boxCost !== null && boxCost.y0 >= 168 && boxCost.y1 <= 173 && boxCost.x0 > 16 + 6 * 5, JSON.stringify(boxCost));
  }

  // Preview of the pending item at (192, 181) inside the erased area x 176-239, y 126-181.
  {
    const view = { page: 1, researchBits: 0, detail: null };
    const none = render({ ...view, selected: null });
    for (const id of [0x45, 0x48, 0x5c]) {
      const shown = render({ ...view, selected: id });
      const expected = new Screen();
      expected.pixels.set(none.pixels);
      bm.drawBuilding(expected, tileSet.tiles, id, 192, 181);
      const box = diffRect(shown, none);
      check(`pending tile $${id.toString(16)}: preview drawn at (192, row 181) inside x 176-239, y 126-181`, box !== null && same(shown.pixels, expected.pixels) && box.x0 >= 176 && box.x1 <= 239 && box.y0 >= 126 && box.y1 <= 181, JSON.stringify(box));
    }
  }

  check("rendering did not write the disks, game state, world or tile images", (() => {
    const after = snapshots();
    return same(after.d1, before.d1) && same(after.d2, before.d2) && same(after.state, before.state) && same(after.cells, before.cells) && same(after.objects, before.objects) && same(after.flags, before.flags) && after.tiles.every((t, i) => same(t, before.tiles[i]));
  })());

  // Mode icon (`$6B10` at (272, bottom row 52)): a fresh Controls is in select mode and draws tile $39 (`$15EF0`, the
  // select entry the map runs before its first pass); demolish mode draws $3A (`$15ECA`). The box is x 272..303, rows 30..52,
  // the rows of the tile itself; expected pixels are the tile composed by blitTile over a blank screen (the same helper as the
  // side preview), so nothing else in the box may change. Static trace, map-rendering.md section 9; the $39 pixels also match
  // the Copperline capture (section 11).
  {
    const controls = new Controls(disk1, world, builder, strings, () => {}, () => ({ x: 47, y: 33 }), () => {}, tileSet.tiles);
    const boxMatches = (tile) => {
      const got = new Screen();
      controls.draw(got);
      const want = new Screen();
      bm.blitTile(want, tileSet.tiles[tile - 1], 272, 52);
      let opaque = 0;
      for (let y = 30; y <= 52; y++) for (let x = 272; x <= 303; x++) {
        if (want.pixels[y * 320 + x] !== 0) opaque++;
        if (got.pixels[y * 320 + x] !== want.pixels[y * 320 + x]) return { ok: false, opaque };
      }
      return { ok: opaque > 0, opaque };
    };
    const select = boxMatches(0x39);
    check("select mode draws tile $39 in the mode icon box (x 272..303, rows 30..52)", controls.mode === "select" && select.ok, `opaque ${select.opaque}`);
    controls.mode = "demolish";
    const demolish = boxMatches(0x3a);
    check("demolish mode draws tile $3A in the mode icon box", demolish.ok, `opaque ${demolish.opaque}`);
  }

  // Controls wiring: the same page mapping selects what is drawn; T[22] shows 6000.
  {
    const controls = new Controls(disk1, world, builder, strings, () => {}, () => ({ x: 47, y: 33 }), () => {}, tileSet.tiles);
    const click = (x, y) => {
      controls.update({ leftButton: true, rightButton: false, pointerX: x, pointerY: y, keys: [] });
      controls.update({ leftButton: false, rightButton: false, pointerX: x, pointerY: y, keys: [] });
    };
    s.setLong(0x135ba, 5000000);
    for (const bits of [0, allResearch]) {
      s.setLong(0x14472, bits);
      click(272, 63); // build command: opens page 1
      for (let page = 0; page < 3; page++) {
        const picked = [];
        let resolved = 0;
        for (const it of bm.menuItems(page, bits)) {
          let type = -1;
          try { type = world.findType(it.tile); } catch { /* no type row for this tile in this scenario */ }
          const prev = JSON.stringify(controls.menuState);
          click((it.hitbox.x0 + it.hitbox.x1) >> 1, (it.hitbox.y0 + it.hitbox.y1) >> 1);
          const st = controls.menuState;
          if (type < 0) picked.push(JSON.stringify(st) === prev); // untyped tiles are ignored, as in the port
          else {
            resolved++;
            picked.push(st.pending?.tile === it.tile && st.detail !== null);
          }
        }
        check(`Controls page ${page + 1} (research ${bits ? "all" : "none"}): a click on each rectangle picks the tile drawn there`, picked.every(Boolean) && resolved > 0 && controls.menuState.page === page, `resolved ${resolved}/${bm.menuItems(page, bits).length}`);
        click(296, 139); // page button
      }
      click(272, 139); // exit
      check("exit closes the menu", !controls.menuVisible);
    }
    s.setLong(0x14472, 0);

    // The page pointer changes on release; the original's 14 strip fills occur synchronously between VBL waits.
    s.setLong(0x14472, 0);
    click(272, 63);
    controls.update({ leftButton: true, rightButton: false, pointerX: 296, pointerY: 139, keys: [] });
    controls.update({ leftButton: false, rightButton: false, pointerX: 296, pointerY: 139, keys: [] });
    const switched = new Screen();
    controls.draw(switched);
    const switchedState = controls.menuState;
    const expectedPage = render({
      page: switchedState.page,
      researchBits: 0,
      selected: switchedState.pending?.tile ?? null,
      detail: switchedState.detail,
    });
    check("page-button release immediately renders the destination page after the synchronous erase loop", controls.menuState.page === 1 && same(switched.pixels, expectedPage.pixels));
    // Close this temporary menu before the next research-gated-slot assertions.
    controls.update({ leftButton: true, rightButton: false, pointerX: 272, pointerY: 139, keys: [] });
    controls.update({ leftButton: false, rightButton: false, pointerX: 272, pointerY: 139, keys: [] });
    controls.mode = "select";

    // Research-gated slots (`$B2AA` blanks them): their rectangles exist but select nothing until the bit is set.
    {
      click(272, 63);
      // This Controls instance remembers its page; normalize to page 1 (index 0) before testing the gated slots.
      while (controls.menuState.page !== 0) click(296, 139);
      const open = JSON.stringify(controls.menuState);
      click(191, 65); // page 1, slot 10 ({176,207,50,80})
      let quiet = JSON.stringify(controls.menuState) === open;
      click(296, 139); // page 2
      const page2 = JSON.stringify(controls.menuState);
      for (const [x, y] of [[127, 115], [159, 115], [191, 65]]) {
        click(x, y); // slots 8, 9, 10
        quiet &&= JSON.stringify(controls.menuState) === page2;
      }
      check("blank research-gated slots ignore clicks (page 1 slot 10, page 2 slots 8-10)", quiet);
      s.setLong(0x14472, 1 | (1 << 6)); // research bits 0 and 6 fill page 2 slots 8 and 10
      let hasType = true;
      try { world.findType(0x3c); } catch { hasType = false; }
      const beforeClick = JSON.stringify(controls.menuState);
      click(127, 115);
      const after = controls.menuState;
      check("with research bit 0 set page 2 slot 8 selects tile $3C (when the scenario has a type row for it)", hasType ? after.pending?.tile === 0x3c && after.detail !== null : JSON.stringify(after) === beforeClick);
      s.setLong(0x14472, 0);
      click(272, 139);
    }

    const snap = s.snapshot();
    click(272, 63);
    // The original keeps `$156B0` across menu visits; move to page 2 (zero-based 1) from the current page.
    while (controls.menuState.page !== 1) click(296, 139);
    click(25, 115); // tank yard, page 2
    const st = controls.menuState;
    check("tank yard pick shows the name string index 27 and the original price 6000 (T[22] +6)", st.pending?.tile === 0x45 && st.pending.type === 22 && st.detail?.nameIndex === 27 && st.detail.cost === 6000 && st.detail.affordable);
    const screen = new Screen();
    controls.draw(screen);
    const expected = render({ page: 1, researchBits: 0, selected: 0x45, detail: { nameIndex: 27, cost: 6000, affordable: true } });
    check("Controls.draw shows exactly the renderer output for that menu state", same(screen.pixels, expected.pixels));
    check("Controls.draw did not change the game state", same(s.snapshot(), snap));
    click(272, 139);
    check("exit commits the pick", controls.mode === "build" && controls.selection?.tile === 0x45);
    const sidePreview = new Screen();
    const previewState = s.snapshot();
    controls.draw(sidePreview);
    const expectedSidePreview = new Screen();
    bm.drawBuilding(expectedSidePreview, tileSet.tiles, 0x45, 272, 52);
    let previewMatches = true;
    for (let y = 20; y <= 52; y++) for (let x = 272; x < 320; x++) {
      const at = y * 320 + x;
      if (sidePreview.pixels[at] !== expectedSidePreview.pixels[at]) previewMatches = false;
    }
    check("committed build selection draws the side preview at x=272, bottom row 52", previewMatches);
    check("drawing the side preview does not mutate game state", same(s.snapshot(), previewState));
    // Reopening starts from the committed selection (`$B386`): its preview is shown, no name/price lines yet.
    click(272, 63);
    const re = controls.menuState;
    check("reopened menu keeps page 2 and carries the previous selection without detail lines", re.page === 1 && re.pending?.tile === 0x45 && re.detail === null);
    click(272, 139);

    // Pressed feedback (`$5756` flips on the press, `$57FA` flips back on the release, which is also when the action runs).
    {
      const at = (leftButton, x, y) => controls.update({ leftButton, rightButton: false, pointerX: x, pointerY: y, keys: [] });
      click(272, 63);
      const shot = () => {
        const screen = new Screen();
        controls.draw(screen);
        return screen;
      };
      const idle = shot();
      at(true, 296, 139); // page button, command button 8
      const held = shot();
      const box = diffRect(held, idle);
      let flipOnly = true;
      for (let i = 0; i < idle.pixels.length; i++) {
        const x = i % 320;
        const y = (i / 320) | 0;
        const inside = x >= 296 && x <= 311 && y >= 139 && y <= 154;
        if (held.pixels[i] !== (inside ? idle.pixels[i] ^ 8 : idle.pixels[i])) flipOnly = false;
      }
      check("pressed command button is drawn flipped (colour ^ 8, plane 3) inside its 16x16 rectangle and nowhere else", box !== null && box.n === 256 && box.x0 === 296 && box.x1 === 311 && box.y0 === 139 && box.y1 === 154 && flipOnly);
      const fromPage = controls.menuState.page;
      check("holding the page button has not changed the remembered page yet", fromPage === 1);
      at(false, 20, 20); // released away from the button: `$5DD4` still names button 8 (`$B3F2-$B45E`)
      check("releasing away from the page button still advances the remembered page", controls.menuState.page === 2);
      const after = shot();
      const expectedPage = render({ page: 2, researchBits: s.long(0x14472), selected: 0x45, detail: null });
      check("page release redraws the settled destination page immediately", same(after.pixels, expectedPage.pixels));
      at(true, 20, 20); // a press that is not on a button (outside the item rectangles too)
      at(false, 272, 139); // released over the exit button: nothing was pressed, so nothing runs
      check("a release over the exit button does nothing when the press was elsewhere", controls.menuVisible);
      at(true, 272, 63);
      at(false, 272, 63);
      check("blank command buttons only flip and click: no page change, no exit", controls.menuVisible && controls.menuState.page === 2);
      click(272, 139);
      check("exit button still leaves through its release", !controls.menuVisible);
    }
  }

  check("tank yard type row T[22] +6 in the Disk.2 scenario block is 6000", s.word(world.typeAddress(22) + 6) === 6000);
}

if (failed) {
  console.log(`${failed} build-menu check(s) failed`);
  process.exit(1);
}
console.log("all build-menu checks passed");
