import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  identifyDisk4Scenario,
  rankDisk4ScenarioMaps,
  readDisk4SaveMetadata,
  resolveDisk4Scenario,
  DISK4_DISK_ID_ADDR,
  DISK4_SCENARIO_INDEX_ADDR,
} from "../dist/data/disk4-scenario.js";
import { DISK4_AREA_B_BASE, DISK4_AREA_B_BYTES } from "../dist/data/disk4-state.js";

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log(`ok ${name}`);
}
const put16 = (bytes, at, value) => { bytes[at] = value >>> 8; bytes[at + 1] = value & 0xff; };
const metadataArea = (diskId, scenarioIndex) => {
  const areaB = new Uint8Array(DISK4_AREA_B_BYTES);
  put16(areaB, DISK4_DISK_ID_ADDR - DISK4_AREA_B_BASE, diskId);
  put16(areaB, DISK4_SCENARIO_INDEX_ADDR - DISK4_AREA_B_BASE, scenarioIndex);
  return areaB;
};

const cellCount = 100 * 75;
const first = Uint16Array.from({ length: cellCount }, (_, i) => (i * 17 + Math.floor(i / 11)) & 0x3ff);
const second = Uint16Array.from(first, (tile) => tile ^ 0x155);
const saved = Uint16Array.from(first, (tile, i) => tile | ((i % 4) << 10));
const ranked = rankDisk4ScenarioMaps(saved, [
  { index: 0, name: "FIRST", cells: first },
  { index: 1, name: "SECOND", cells: second },
]);
check("tile comparison ignores saved map flag bits", ranked.status === "identified" && ranked.scenario === 0 && ranked.candidate.matches === cellCount);

const edited = saved.slice();
for (let i = 0; i < 1500; i++) edited[i * 3] = (edited[i * 3] & 0xfc00) | (second[i * 3] & 0x3ff);
const afterEdits = rankDisk4ScenarioMaps(edited, [
  { index: 0, name: "FIRST", cells: first },
  { index: 1, name: "SECOND", cells: second },
]);
check("distinctive map remains identifiable with 20 percent changed tiles", afterEdits.status === "identified" && afterEdits.scenario === 0);

const blank = new Uint16Array(cellCount);
const ambiguous = rankDisk4ScenarioMaps(blank, [
  { index: 0, name: "FIRST", cells: first },
  { index: 1, name: "SECOND", cells: second },
]);
check("poor or tied map evidence requests a caller choice", ambiguous.status === "ambiguous");
check("invalid map dimensions return a typed error", "code" in rankDisk4ScenarioMaps(new Uint16Array(2), []));

// The original load path uses the saved disk id and scenario index; map matching is advisory recovery only.
{
  const areaB = metadataArea(2, 4);
  const read = readDisk4SaveMetadata(areaB);
  check("saved metadata reads big-endian disk id and scenario index from their RAM addresses",
    read.ok && read.value.diskId === 2 && read.value.scenarioIndex === 4);
  check("saved area B with the wrong byte length returns a typed error",
    !readDisk4SaveMetadata(new Uint8Array(DISK4_AREA_B_BYTES - 1)).ok);
  const selected = resolveDisk4Scenario(areaB, { diskId: 2, scenarioCount: 10 });
  check("valid saved metadata is authoritative", selected.ok && selected.value.scenario === 4 && selected.value.by === "saved" &&
    selected.value.saved.diskId === 2 && selected.value.saved.scenarioIndex === 4);
  const same = resolveDisk4Scenario(areaB, { diskId: 2, scenarioCount: 10 }, 4);
  check("an explicit recovery choice matching valid metadata is a no-op", same.ok && same.value.scenario === 4 && same.value.by === "saved");
  const conflict = resolveDisk4Scenario(areaB, { diskId: 2, scenarioCount: 10 }, 3);
  check("a different caller choice cannot override a valid saved index", !conflict.ok && conflict.error.code === "scenario-conflict");
  const wrongDisk = resolveDisk4Scenario(areaB, { diskId: 1, scenarioCount: 10 }, 3);
  check("scenario recovery cannot override a saved disk-id mismatch", !wrongDisk.ok && wrongDisk.error.code === "unsupported-disk-id");
  const invalidIndexArea = metadataArea(2, 0xffff);
  const needsChoice = resolveDisk4Scenario(invalidIndexArea, { diskId: 2, scenarioCount: 10 });
  check("an out-of-table saved index requires deliberate recovery", !needsChoice.ok && needsChoice.error.code === "scenario-index");
  const recovered = resolveDisk4Scenario(invalidIndexArea, { diskId: 2, scenarioCount: 10 }, 7);
  check("recovery applies only to an invalid saved index and retains its raw metadata", recovered.ok && recovered.value.scenario === 7 &&
    recovered.value.by === "recovery" && recovered.value.saved.scenarioIndex === 0xffff);
  const badRecovery = resolveDisk4Scenario(invalidIndexArea, { diskId: 2, scenarioCount: 10 }, 10);
  check("out-of-range recovery choices return a typed error", !badRecovery.ok && badRecovery.error.code === "recovery-index");
  const badReference = resolveDisk4Scenario(areaB, { diskId: 2, scenarioCount: 0 });
  check("malformed Disk.2 references return a typed error without throwing", !badReference.ok && badReference.error.code === "reference");
  const nullReference = resolveDisk4Scenario(areaB, null);
  check("missing Disk.2 reference returns a typed error without throwing", !nullReference.ok && nullReference.error.code === "reference");
}

const disk2Path = "original/utopia-whdload/Disk.2";
const observedPath = path.join(os.tmpdir(), "UtopiaReferenceRun-20261106", "disk4-area-a-memory.bin");
if (fs.existsSync(disk2Path)) {
  const { readScenarioRecords, readScenarioDiskId } = await import("../dist/data/scenario.js");
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const records = readScenarioRecords(disk2);
  const blockScenarioIndices = records.map((record) => {
    const at = record.block.first * 512 + (DISK4_SCENARIO_INDEX_ADDR - DISK4_AREA_B_BASE);
    return ((disk2[at] << 8) | disk2[at + 1]) & 0xffff;
  });
  check("local Disk.2 header id is 2, as required by the saved Disk.4 id", readScenarioDiskId(disk2) === 2);
  check("all ten scenario blocks store their own index at the saved $135C2 offset",
    blockScenarioIndices.length === 10 && blockScenarioIndices.every((index, i) => index === i));
} else {
  console.log("skip local Disk.2 metadata check: original/utopia-whdload/Disk.2 is absent");
}

if (fs.existsSync(disk2Path) && fs.existsSync(observedPath)) {
  const disk2 = new Uint8Array(fs.readFileSync(disk2Path));
  const areaA = new Uint8Array(fs.readFileSync(observedPath));
  const savedMap = new Uint16Array(cellCount);
  const view = new DataView(areaA.buffer, areaA.byteOffset, areaA.byteLength);
  for (let i = 0; i < cellCount; i++) {
    const x = i % 100;
    const y = Math.floor(i / 100);
    savedMap[i] = view.getUint16(0x3f256 - 0x39e3a + (y * 102 + x) * 2, false);
  }
  const result = identifyDisk4Scenario(savedMap, disk2);
  check("observed memory capture identifies as Disk.2 scenario 0 ELDORIANS", result.ok && result.value.status === "identified" && result.value.scenario === 0 && result.value.candidate.matches === cellCount);
} else {
  console.log("skip observed capture scenario check: local Disk.2 or temporary memory capture is absent");
}

console.log(`${passed} disk4-scenario checks passed`);
