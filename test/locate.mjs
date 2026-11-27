// Byte-pattern search (src/data/locate.ts) and content-based table lookup (src/data/anchors.ts).
// The WHDLoad check needs the user's Disk.1 under original/utopia-whdload/ and skips when it is missing.
// The ADF check runs only when UTOPIA_ADF_PROGRAM points at an unpacked game program image (loaded at $1000); no game data is stored here.
// Run after `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const locate = await import(pathToFileURL(path.join(root, "dist/data/locate.js")).href);
const anchors = await import(pathToFileURL(path.join(root, "dist/data/anchors.js")).href);

let failures = 0;
const check = (ok, label) => {
  console.log(ok ? "ok  " : "FAIL", label);
  if (!ok) failures++;
};

// ---- pattern parsing and matching on synthetic data --------------------------------------------------------------------------
const synthetic = Uint8Array.from([1, 2, 3, 9, 2, 7, 3, 0, 2, 7, 3]);
check(locate.findAll(synthetic, locate.parsePattern("02 ?? 03")).join() === "4,8", "wildcard pattern finds every match");
check(locate.locateUnique(synthetic, locate.parsePattern("03 03")).ok === false, "pattern with no hit is not resolved");
check(locate.locateUnique(synthetic, locate.parsePattern("09 02 07")).offset === 3, "unique pattern resolves to its offset");
check(locate.locateUnique(synthetic, locate.parsePattern("02 ?? 03"), 0, 3).ok === false, "search respects the region end");
for (const bad of ["", "zz", "0", "?? ??"]) {
  let threw = false;
  try {
    locate.parsePattern(bad);
  } catch {
    threw = true;
  }
  check(threw, `malformed pattern rejected: "${bad}"`);
}

// ---- WHDLoad: the content lookup must return the documented addresses -------------------------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
if (!fs.existsSync(disk1Path)) {
  console.log("skip WHDLoad content lookup: original/utopia-whdload/Disk.1 is missing");
} else {
  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  const programStart = 0x14c * 512;
  const programSize = 96768;
  const program = disk1.subarray(programStart, programStart + programSize);
  const results = anchors.locateAnchors(program, program);
  results.forEach((result, i) => {
    const want = anchors.TABLE_ANCHORS[i].address;
    check(result.ok && result.address === want, `WHDLoad ${anchors.TABLE_ANCHORS[i].name} at documented address`);
  });

  const adf = process.env.UTOPIA_ADF_PROGRAM;
  if (adf && fs.existsSync(adf)) {
    const other = new Uint8Array(fs.readFileSync(adf));
    for (const r of anchors.locateAnchors(program, other)) {
      check(r.ok, `ADF program: ${r.name} found once${r.ok ? ` at $${r.address.toString(16)}` : ` (matches: ${r.count})`}`);
    }
  } else {
    console.log("skip ADF program lookup: set UTOPIA_ADF_PROGRAM to an unpacked program image");
  }
}

console.log(failures === 0 ? "locate: all checks ok" : `locate: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
