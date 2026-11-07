// Pointer graphics are decoded from the player's Disk.1 at runtime. Synthetic checks cover the descriptor and masked
// 5-plane blit; local-data checks compare the arrow and map-cell hover descriptors in the supplied image.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { readPointer, drawPointer, POINTER_ARROW, POINTER_CELL_HOVER } = await import("../dist/gfx/pointer.js");
const { mapPointerPoint } = await import("../dist/game/pointer-input.js");
const { Screen } = await import("../dist/gfx/screen.js");
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

const IMAGE_START = 0x14c * 512;
const offset = (address) => IMAGE_START + address - 0x1000;
const put32 = (bytes, address, value) => {
  const at = offset(address);
  bytes[at] = value >>> 24;
  bytes[at + 1] = value >>> 16;
  bytes[at + 2] = value >>> 8;
  bytes[at + 3] = value;
};
{
  const disk = new Uint8Array(0x40000);
  put32(disk, POINTER_ARROW, 1); // two rows
  put32(disk, POINTER_ARROW + 4, 0x5000);
  put32(disk, POINTER_ARROW + 8, 0x5040);
  put32(disk, 0x5040, 0x80000001); // mask covers x=0 and x=31 on row 0
  put32(disk, 0x5044, 0x40000000); // row 1 x=1
  put32(disk, 0x5000, 0x80000000); // plane 0, row 0, x=0
  put32(disk, 0x5004, 0x40000000); // plane 0, row 1, x=1
  put32(disk, 0x5008, 0x80000000); // plane 1, row 0: x=0 gets colour 3, x=31 is masked to 0
  const pointer = readPointer(disk, POINTER_ARROW);
  check("descriptor row count includes the stored rows-minus-one word", pointer.rows === 2);
  check("mask gates both opacity and decoded colour", pointer.opaque[0] === 1 && pointer.index[0] === 3 && pointer.opaque[31] === 1 && pointer.index[31] === 0 && pointer.opaque[32] === 0);
  const screen = new Screen();
  screen.palette[3] = [17, 34, 51];
  const rgba = screen.toRgba();
  drawPointer(pointer, screen, rgba, 10, 20);
  const pixel = (x, y) => Array.from(rgba.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)).join(",");
  check("masked pointer blit uses the screen palette at its top-left hotspot", pixel(10, 20) === "17,34,51,255");
  check("transparent pointer pixels leave the destination unchanged", pixel(11, 20) === "0,0,0,255");
  const clipped = screen.toRgba();
  drawPointer(pointer, screen, clipped, 319, 199);
  check("pointer blit clips pixels beyond the 320x200 frame", clipped.slice((199 * 320 + 319) * 4, (199 * 320 + 319) * 4 + 3).join(",") === "17,34,51");
}

{
  const mode1 = mapPointerPoint(319, 199, "select");
  const mode3 = mapPointerPoint(400, -4, "demolish");
  const mode2 = mapPointerPoint(319, 199, "build");
  check("screen modes 1 and 3 clamp pointer x/y to 312/192", mode1.x === 312 && mode1.y === 192 && mode3.x === 312 && mode3.y === 0);
  check("screen mode 2 uses the $15620 image defaults of 312/192", mode2.x === 312 && mode2.y === 192);
  const lower = mapPointerPoint(-8, -20, "select");
  check("clamped modes also stop negative software-pointer coordinates at zero", lower.x === 0 && lower.y === 0);
}

const disk1 = path.join(root, "original", "utopia-whdload", "Disk.1");
if (fs.existsSync(disk1)) {
  const disk = new Uint8Array(fs.readFileSync(disk1));
  const arrow = readPointer(disk, POINTER_ARROW);
  const hover = readPointer(disk, POINTER_CELL_HOVER);
  const opaqueCount = (p) => p.opaque.reduce((sum, value) => sum + value, 0);
  const same = arrow.rows === hover.rows && arrow.index.every((v, i) => v === hover.index[i]) && arrow.opaque.every((v, i) => v === hover.opaque[i]);
  check("local Disk.1 pointer descriptors decode to nonempty graphics", arrow.rows > 0 && hover.rows > 0 && opaqueCount(arrow) > 0 && opaqueCount(hover) > 0, `arrow=${arrow.rows} rows hover=${hover.rows} rows`);
  check("local arrow and map-cell hover graphics are distinct descriptors", !same && POINTER_ARROW !== POINTER_CELL_HOVER);
} else {
  console.log("pointer local Disk.1 checks skipped: original/utopia-whdload/Disk.1 not found");
}

if (failed) process.exit(1);
console.log("all pointer checks passed");
