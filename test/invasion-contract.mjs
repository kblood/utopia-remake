// Synthetic checks of the invasion capture CONTRACT (test/invasion-capture-contract.mjs): the manifest `provenance` field and the
// exact RNG/TOD/raster return-address bindings. No original capture is read or invented and no emulator runs; the Disk.1 part
// uses the player's local game image when present (skipped otherwise) and a mutated in-memory copy for the negative case.
// This does NOT test the comparator's replay, which still has never run against a real capture.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ContractError, GAME_IMAGE_FILE_DELTA, RASTER_SITES, RNG_SITES, TOD_SITES, checkReturn, checkSiteTable, describeProvenance, resolveSiteName, unmappedCaptureName, validateProvenance, verifySiteBindings,
} from "./invasion-capture-contract.mjs";

const RAM = 0x43100;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

function rejects(fn, kind, code, why) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ContractError, `${why}: threw ${e && e.message}`);
    assert.equal(e.kind, kind, `${why}: kind (${e.message})`);
    assert.equal(e.code, code, `${why}: code (${e.message})`);
    checks++;
    return;
  }
  assert.fail(`${why}: was accepted`);
}
const w = (over = {}) => ({ addr: 0x142c9, width: 1, before: 3, after: 7, reason: "set the pass clock so the baseline lands on a known sub-tick", ...over });
const prov = (over = {}) => ({ setup: "ram-staged", stagingWrites: [w()], noWritesAfterBaseline: true, ...over });
const bad = (p, code, why) => rejects(() => validateProvenance(p, RAM), "malformed-capture", code, why);

// ---- provenance: accepted ----------------------------------------------------------------------------------------------------
{
  const plain = validateProvenance({ setup: "ordinary-play", stagingWrites: [], noWritesAfterBaseline: true }, RAM);
  assert.deepEqual(plain, { setup: "ordinary-play", writes: 0, bytes: 0 }); checks++;
  ok(/ordinary play/.test(describeProvenance(plain)) && !/RAM-staged/.test(describeProvenance(plain)), "ordinary text");
  const staged = validateProvenance(prov({ stagingWrites: [
    w(),
    w({ addr: 0x12a94, width: 2, before: 0, after: 4, reason: "queue cursor to one entry" }),
    w({ addr: 0x14298, width: 4, before: 0, after: 0x01020304, reason: "kill counter baseline" }),
    w({ addr: 0x14298, width: 1, before: 1, after: 9, reason: "high byte re-poked; chain agrees with the long above" }),
  ] }), RAM);
  assert.deepEqual(staged, { setup: "ram-staged", writes: 4, bytes: 8 }); checks++;
  ok(/RAM-staged \(4 declared pre-baseline write\(s\), 8 byte\(s\)/.test(describeProvenance(staged)), "staged text");
  validateProvenance(prov({ stagingWrites: [w({ addr: RAM - 4, width: 4, before: 0, after: 0xffffffff })] }), RAM); checks++; // last bytes of the range, full-width long
}

// ---- provenance: rejected ----------------------------------------------------------------------------------------------------
bad(undefined, "provenance", "missing provenance");
bad(null, "provenance", "null provenance");
bad([], "provenance", "array provenance");
bad({ setup: "ordinary-play", stagingWrites: [] }, "schema", "missing no-writes-after-baseline declaration");
bad({ setup: "ordinary-play", noWritesAfterBaseline: true }, "schema", "missing stagingWrites");
bad({ stagingWrites: [], noWritesAfterBaseline: true }, "schema", "missing setup");
bad({ ...prov(), notes: "x" }, "schema", "unknown key");
bad(prov({ setup: "staged" }), "provenance-setup", "unknown setup value");
bad(prov({ setup: "" }), "provenance-setup", "empty setup");
bad(prov({ stagingWrites: "none" }), "provenance-writes", "stagingWrites not an array");
bad(prov({ noWritesAfterBaseline: "true" }), "provenance-after", "declaration not a boolean");
bad(prov({ noWritesAfterBaseline: 1 }), "provenance-after", "declaration is a number");
rejects(() => validateProvenance(prov({ noWritesAfterBaseline: false }), RAM), "unsupported-capture", "writes-after-baseline", "writes after the baseline declared");
bad({ setup: "ordinary-play", stagingWrites: [w()], noWritesAfterBaseline: true }, "provenance-contradiction", "ordinary play with writes");
bad(prov({ stagingWrites: [] }), "provenance-contradiction", "RAM-staged without writes");
bad(prov({ stagingWrites: [5] }), "provenance-write", "write is not an object");
bad(prov({ stagingWrites: [{ ...w(), extra: 1 }] }), "schema", "write with unknown key");
bad(prov({ stagingWrites: [(({ reason, ...rest }) => rest)(w())] }), "schema", "write without reason");
for (const width of [0, 3, 8, "1", 1.5, undefined]) bad(prov({ stagingWrites: [w({ width })] }), "provenance-write", `width ${String(width)}`);
for (const addr of [-1, 1.5, "1", RAM, RAM + 10]) bad(prov({ stagingWrites: [w({ addr })] }), "provenance-write", `addr ${String(addr)}`);
bad(prov({ stagingWrites: [w({ addr: RAM - 1, width: 2, before: 0, after: 1 })] }), "provenance-write", "write crosses the end of the captured range");
bad(prov({ stagingWrites: [w({ before: 256 })] }), "provenance-write", "byte before out of range");
bad(prov({ stagingWrites: [w({ after: -1 })] }), "provenance-write", "negative after");
bad(prov({ stagingWrites: [w({ width: 2, after: 0x10000 })] }), "provenance-write", "word after out of range");
bad(prov({ stagingWrites: [w({ width: 4, after: 2 ** 32 })] }), "provenance-write", "long after out of range");
bad(prov({ stagingWrites: [w({ before: 2.5 })] }), "provenance-write", "fractional before");
bad(prov({ stagingWrites: [w({ before: 7, after: 7 })] }), "provenance-write", "write that changes nothing");
bad(prov({ stagingWrites: [w({ reason: "" })] }), "provenance-write", "empty reason");
bad(prov({ stagingWrites: [w({ reason: "   " })] }), "provenance-write", "blank reason");
bad(prov({ stagingWrites: [w({ reason: 5 })] }), "provenance-write", "non-string reason");
bad(prov({ stagingWrites: [w({ reason: "x".repeat(501) })] }), "provenance-write", "oversized reason");
bad(prov({ stagingWrites: [w(), w({ before: 4, after: 9 })] }), "provenance-chain", "second write on the same byte does not start from the first one's result");
bad(prov({ stagingWrites: [w({ addr: 0x100, width: 2, before: 0x0102, after: 0x0304 }), w({ addr: 0x101, width: 1, before: 0xff, after: 0 })] }), "provenance-chain", "byte inside an earlier word write disagrees");

// ---- address table -----------------------------------------------------------------------------------------------------------
checkSiteTable(); checks++;
// Pinned from the caller audit (original-rng-callers.md section 5 and the Disk.1 bytes): call/read instruction -> return address.
const EXPECTED = {
  RNG: {
    "intel-countdown": [0xb056, 0xb05c], "wave-warning-strength": [0x11762, 0x11768], "wave-warning-intel": [0x11786, 0x1178c],
    "wave-group": [0x117f6, 0x117fc], "wave-entry": [0x1182e, 0x11834], "random-building": [0x11a74, 0x11a7a], "enemy-bomb-chance": [0x12772, 0x12778],
    // exercised by the RAM-staged live-8 capture (capture-tool names: unmapped-<jsr address>)
    "births-rate": [0x9bcc, 0x9bd2], "market-walk-value": [0xa7ba, 0xa7c0], "market-walk-spread": [0xa7cc, 0xa7d2], "market-walk-demand": [0xa84e, 0xa854],
    "crime-monthly": [0x10be8, 0x10bee], "event-virus-chance": [0x10ee6, 0x10eec], "event-power-accident-chance": [0x10f68, 0x10f6e],
    "event-trade-computer-chance": [0x10f96, 0x10f9c], "event-eclipse-chance": [0x11060, 0x11066], "event-mine-collapse-chance": [0x11090, 0x11096],
    "event-colonist-offer-chance": [0x110fe, 0x11104], "event-scientists-requisition-chance": [0x111a6, 0x111ac], "event-tank-requisition-chance": [0x11280, 0x11286],
    "event-ship-explosion-chance": [0x113a6, 0x113ac], "event-alien-appears-chance": [0x1146a, 0x11470], "event-tank-defect-chance": [0x11566, 0x1156c],
  },
  TOD: { "enemy-attack-tod-gate": [0x12694, 0x1269a] },
  raster: { "wave-entry-jitter-raster": [0x11842, 0x11848] },
};
const TABLES = { RNG: RNG_SITES, TOD: TOD_SITES, raster: RASTER_SITES };
for (const [kind, expected] of Object.entries(EXPECTED)) {
  assert.deepEqual(Object.keys(TABLES[kind]).sort(), Object.keys(expected).sort(), `${kind} label set`); checks++;
  for (const [label, [at, ret]] of Object.entries(expected)) {
    assert.equal(TABLES[kind][label].at, at, `${label} at`);
    assert.equal(TABLES[kind][label].ret, ret, `${label} ret`);
    checks += 2;
  }
}
assert.deepEqual([RNG_SITES["wave-group"].range, RNG_SITES["wave-entry"].range, RNG_SITES["intel-countdown"].range], [16, 8, 100]); checks++;

// exact return addresses accepted, everything else rejected, with a hint when the address belongs to another label
for (const [kind, expected] of Object.entries(EXPECTED)) {
  for (const [label, [, ret]] of Object.entries(expected)) {
    checkReturn(TABLES[kind], label, ret, "row"); checks++;
    rejects(() => checkReturn(TABLES[kind], label, ret + 2, "row"), "malformed-capture", "ret-mismatch", `${label} at ret+2`);
    rejects(() => checkReturn(TABLES[kind], label, ret - 6, "row"), "malformed-capture", "ret-mismatch", `${label} at the call address itself`);
    rejects(() => checkReturn(TABLES[kind], label, 0, "row"), "malformed-capture", "ret-mismatch", `${label} at 0`);
  }
}
try { checkReturn(RNG_SITES, "wave-group", RNG_SITES["wave-entry"].ret, "row"); assert.fail("swapped labels accepted"); } catch (e) { ok(e instanceof ContractError && /belongs to RNG site wave-entry/.test(e.message), "swapped labels name the owner"); }
try { checkReturn(RNG_SITES, "wave-group", 0x9cb6, "row"); assert.fail("unrelated address accepted"); } catch (e) { ok(/not a known call\/read site/.test(e.message), "unknown address reported"); }
rejects(() => checkReturn(RNG_SITES, "market-walk", 0xa7c0, "row"), "unsupported-capture", "unknown-site", "label not in the table");

// capture-tool names: only the exact "unmapped-<jsr address>" of an audited site resolves; everything else fails closed
const LIVE8_ALIASES = {
  "unmapped-0111A6": "event-scientists-requisition-chance", "unmapped-011280": "event-tank-requisition-chance", "unmapped-0113A6": "event-ship-explosion-chance",
  "unmapped-011060": "event-eclipse-chance", "unmapped-011566": "event-tank-defect-chance", "unmapped-010EE6": "event-virus-chance",
  "unmapped-00A7BA": "market-walk-value", "unmapped-00A7CC": "market-walk-spread", "unmapped-00A84E": "market-walk-demand", "unmapped-009BCC": "births-rate",
  "unmapped-010BE8": "crime-monthly", "unmapped-0110FE": "event-colonist-offer-chance", "unmapped-01146A": "event-alien-appears-chance",
  "unmapped-011090": "event-mine-collapse-chance", "unmapped-010F68": "event-power-accident-chance", "unmapped-010F96": "event-trade-computer-chance",
};
for (const [alias, label] of Object.entries(LIVE8_ALIASES)) {
  assert.equal(resolveSiteName(RNG_SITES, alias), label, alias); checks++;
  assert.equal(RNG_SITES[label].captureAlias, alias); assert.equal(unmappedCaptureName(RNG_SITES[label].at), alias); checks += 2;
  assert.equal(Object.hasOwn(RNG_SITES, alias), false, "an unmapped name is never a table label"); checks++;
  checkReturn(RNG_SITES, resolveSiteName(RNG_SITES, alias), RNG_SITES[label].at + 6, "row"); checks++; // the row's ret ($xxxxx = jsr + 6)
  rejects(() => checkReturn(RNG_SITES, resolveSiteName(RNG_SITES, alias), RNG_SITES[label].at + 8, "row"), "malformed-capture", "ret-mismatch", `${alias} with a wrong return`);
}
assert.equal(Object.keys(LIVE8_ALIASES).length, 16); checks++;
assert.equal(resolveSiteName(RNG_SITES, "wave-group"), "wave-group"); checks++;
for (const bad of ["unmapped-0111A7", "unmapped-0111a6", "unmapped-111A6", "unmapped-0111AC", "unmapped-011398", "unmapped-", "unmapped-*", "__proto__", "", null, 5]) {
  assert.equal(resolveSiteName(RNG_SITES, bad), null, `${String(bad)} must not resolve`); checks++;
}
assert.equal(resolveSiteName(TOD_SITES, "unmapped-0111A6"), null, "an RNG alias in the TOD table"); checks++;
// an alias whose return address belongs to another audited site is a ret mismatch that names the owner
try { checkReturn(RNG_SITES, resolveSiteName(RNG_SITES, "unmapped-0111A6"), RNG_SITES["event-tank-requisition-chance"].ret, "row"); assert.fail("swapped alias accepted"); } catch (e) { ok(e instanceof ContractError && /belongs to RNG site event-tank-requisition-chance/.test(e.message), "alias with another site's return names the owner"); }
// ranges the live-8 tape uses
assert.deepEqual([RNG_SITES["market-walk-value"].range, RNG_SITES["crime-monthly"].range, RNG_SITES["event-virus-chance"].range, RNG_SITES["births-rate"].maxRange], [4, 20, 100, 255]); checks++;
rejects(() => checkReturn(RNG_SITES, "__proto__", 0, "row"), "unsupported-capture", "unknown-site", "prototype key is not a label");
rejects(() => checkReturn(TOD_SITES, "wave-entry", 0x11834, "row"), "unsupported-capture", "unknown-site", "RNG label in the TOD table");

// ---- Disk.1 binding (the player's local image; mutated copies for the negative cases) --------------------------------------------
const disk1Path = path.join(root, "original", "utopia-whdload", "Disk.1");
const disk2Path = path.join(root, "original", "utopia-whdload", "Disk.2");
const haveDisk1 = fs.existsSync(disk1Path);
if (!haveDisk1) {
  console.log("invasion contract: Disk.1 binding checks skipped (original/utopia-whdload/Disk.1 not present)");
} else {
  const disk1 = new Uint8Array(fs.readFileSync(disk1Path));
  verifySiteBindings(disk1); checks++;
  for (const [kind, sites] of Object.entries(TABLES)) {
    for (const [label, s] of Object.entries(sites)) {
      const copy = Uint8Array.from(disk1);
      copy[s.at + GAME_IMAGE_FILE_DELTA + s.code.length / 2 - 1] ^= 0x01; // last operand byte of the call/read instruction
      rejects(() => verifySiteBindings(copy), "original-input", "site-binding", `${kind} ${label}: Disk.1 byte flipped`);
      if (s.d2Moveq) {
        const m = Uint8Array.from(disk1);
        m[s.d2Moveq.at + GAME_IMAGE_FILE_DELTA + 1] ^= 0x01; // the moveq immediate that fixes the range
        rejects(() => verifySiteBindings(m), "original-input", "site-binding", `${label}: moveq range byte flipped`);
      }
    }
  }
  rejects(() => verifySiteBindings(disk1.subarray(0, 1000)), "original-input", "site-binding", "truncated Disk.1");

  // ---- comparator wiring (negative paths only; the manifest below is synthetic and deliberately not a capture) ----------------
  if (fs.existsSync(disk2Path)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "utopia-invasion-contract-"));
    try {
      const machine = { emulator: "synthetic", version: "0", cpu: "68020", chipset: "AGA", video: "PAL", chipRamKiB: 2048, fastRamKiB: 8192 };
      const run = (manifest) => {
        fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));
        return spawnSync(process.execPath, [path.join(root, "test", "invasion-original-compare.mjs")], { env: { ...process.env, UTOPIA_INVASION_CAPTURE_DIR: tmp }, encoding: "utf8" });
      };
      const base = { schema: "utopia-invasion-capture/1", scenario: 0, machine, checkpoints: [], passTops: [] };
      let r = run({ ...base });
      assert.equal(r.status, 1); ok(/malformed-capture \[schema\].*missing keys \[provenance\]/.test(r.stderr), `missing provenance rejected by the comparator: ${r.stderr}`);
      r = run({ ...base, provenance: { setup: "ram-staged", stagingWrites: [], noWritesAfterBaseline: true } });
      assert.equal(r.status, 1); ok(/\[provenance-contradiction\]/.test(r.stderr), `staged-without-writes rejected: ${r.stderr}`);
      r = run({ ...base, provenance: { setup: "ordinary-play", stagingWrites: [], noWritesAfterBaseline: true } });
      // valid provenance gets past its check and stops at the (intentionally empty) checkpoint list
      assert.equal(r.status, 1); ok(/checkpoints must list exactly/.test(r.stderr) && !/provenance/.test(r.stderr), `valid provenance passes to the next check: ${r.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    console.log("invasion contract: comparator wiring checks skipped (Disk.2 not present)");
  }
}
console.log(`invasion contract: ${checks} checks passed (synthetic provenance and address-table validation; no original capture exists, the replay is unverified)`);
