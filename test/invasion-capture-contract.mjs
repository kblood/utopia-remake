// Pure contract pieces of test/invasion-original-compare.mjs (no process exit, no file or capture access of its own).
// Kept separate so test/invasion-contract.mjs can check them with synthetic input; NO original capture is involved or implied.
//
// 1. Capture provenance (manifest `provenance`): was the baseline reached by ordinary play or by RAM staging, and if staged,
//    which writes were made before the baseline. Declared by the capture author; the comparator validates the shape and the
//    internal consistency, it cannot prove the declaration true.
// 2. Original call/read bindings: every supported RNG / TOD / raster label is bound to the exact instruction in the user's
//    Disk.1 game image (static audit, notes/formats/original-rng-callers.md section 5, plus the Disk.1 bytes below) and to the
//    exact return address a capture tool must record for it. A row whose `ret` differs from its label's address is rejected;
//    a label with merely a self-consistent `ret` is not enough.

export class ContractError extends Error {
  constructor(kind, code, message) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}
const malformed = (code, msg) => { throw new ContractError("malformed-capture", code, msg); };

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
export const hex = (v, w = 2) => `$${(v >>> 0).toString(16).toUpperCase().padStart(w, "0")}`;

function exactKeys(value, keys, what) {
  const got = Object.keys(value).sort();
  const allowed = [...keys].sort();
  const extra = got.filter((k) => !allowed.includes(k));
  const missing = allowed.filter((k) => !got.includes(k));
  if (extra.length || missing.length) malformed("schema", `${what}: unexpected keys [${extra.join(", ")}], missing keys [${missing.join(", ")}]`);
}

// ---- 1. provenance ---------------------------------------------------------------------------------------------------------
export const SETUP_MODES = ["ordinary-play", "ram-staged"];
export const MAX_REASON_LENGTH = 500;

/**
 * Validate manifest.provenance:
 *   { "setup": "ordinary-play" | "ram-staged",
 *     "stagingWrites": [ { "addr": int, "width": 1|2|4, "before": uint, "after": uint, "reason": "<text>" }, ... ],  // chronological
 *     "noWritesAfterBaseline": true }
 * `ordinary-play` requires an empty list; `ram-staged` requires at least one write. Each write must lie inside the captured RAM
 * bound `ramSize`, fit its width, really change a value, and agree with any earlier write to the same bytes (before == the value
 * that earlier write left). `noWritesAfterBaseline` must be literally true: a capture that was poked after the baseline pass top
 * breaks the no-input replay and is an unsupported-capture error, not a silently accepted one.
 * Returns { setup, writes, bytes }.
 */
export function validateProvenance(p, ramSize) {
  const bad = (code, msg) => malformed(code, `manifest.json provenance: ${msg}`);
  if (!isObject(p)) bad("provenance", `must be an object { setup, stagingWrites, noWritesAfterBaseline }; the capture must declare whether setup was ordinary play or RAM-staged`);
  exactKeys(p, ["setup", "stagingWrites", "noWritesAfterBaseline"], "manifest.json provenance");
  if (!SETUP_MODES.includes(p.setup)) bad("provenance-setup", `setup must be one of ${SETUP_MODES.map((m) => JSON.stringify(m)).join(", ")}, got ${JSON.stringify(p.setup)}`);
  if (!Array.isArray(p.stagingWrites)) bad("provenance-writes", "stagingWrites must be an array (empty for ordinary play)");
  if (typeof p.noWritesAfterBaseline !== "boolean") bad("provenance-after", "noWritesAfterBaseline must be the boolean true (explicit declaration)");
  if (p.noWritesAfterBaseline !== true) throw new ContractError("unsupported-capture", "writes-after-baseline", "manifest.json provenance: noWritesAfterBaseline is false; a capture with RAM writes after the baseline cannot be replayed without input");
  if (p.setup === "ordinary-play" && p.stagingWrites.length !== 0) bad("provenance-contradiction", `setup "ordinary-play" cannot list ${p.stagingWrites.length} staging write(s)`);
  if (p.setup === "ram-staged" && p.stagingWrites.length === 0) bad("provenance-contradiction", `setup "ram-staged" must list at least one pre-baseline write (address, width, before, after, reason)`);
  const last = new Map(); // byte address -> value left by the latest earlier write
  let bytes = 0;
  p.stagingWrites.forEach((w, i) => {
    const at = `stagingWrites[${i}]`;
    if (!isObject(w)) bad("provenance-write", `${at} must be an object { addr, width, before, after, reason }`);
    exactKeys(w, ["addr", "width", "before", "after", "reason"], `manifest.json provenance ${at}`);
    if (![1, 2, 4].includes(w.width)) bad("provenance-write", `${at}: width must be 1, 2 or 4 (bytes), got ${JSON.stringify(w.width)}`);
    if (!isInt(w.addr) || w.addr < 0 || w.addr + w.width > ramSize) bad("provenance-write", `${at}: addr ${JSON.stringify(w.addr)} (+${w.width}) must be an integer inside the captured RAM range 0..${hex(ramSize, 5)}`);
    const max = 2 ** (8 * w.width);
    for (const key of ["before", "after"]) {
      if (!isInt(w[key]) || w[key] < 0 || w[key] >= max) bad("provenance-write", `${at}: ${key} must be an unsigned ${8 * w.width}-bit integer, got ${JSON.stringify(w[key])}`);
    }
    if (w.before === w.after) bad("provenance-write", `${at}: before equals after (${w.before}); a write that changes nothing is not a staging write`);
    if (typeof w.reason !== "string" || w.reason.trim() === "" || w.reason.length > MAX_REASON_LENGTH) bad("provenance-write", `${at}: reason must be a non-empty string of at most ${MAX_REASON_LENGTH} characters`);
    for (let k = 0; k < w.width; k++) {
      const shift = 8 * (w.width - 1 - k); // big-endian, as the 68k writes it
      const before = Math.floor(w.before / 2 ** shift) % 256;
      const after = Math.floor(w.after / 2 ** shift) % 256;
      const a = w.addr + k;
      if (last.has(a) && last.get(a) !== before) bad("provenance-chain", `${at}: byte ${hex(a, 5)} is recorded as ${hex(before)} before this write, but the earlier write left ${hex(last.get(a))}`);
      last.set(a, after);
    }
    bytes += w.width;
  });
  return { setup: p.setup, writes: p.stagingWrites.length, bytes };
}

export function describeProvenance(s) {
  return s.setup === "ordinary-play"
    ? "setup: ordinary play (self-declared, no RAM staging, not verifiable here)"
    : `setup: RAM-staged (${s.writes} declared pre-baseline write(s), ${s.bytes} byte(s); self-declared, not verifiable here)`;
}

// ---- 2. original call/read bindings ----------------------------------------------------------------------------------------
/** Loaded game address = Disk.1 file offset - $28800 (game image, sectors $14C-$208; tools/rng_call_sites.py). */
export const GAME_IMAGE_FILE_DELTA = 0x28800;
const JSR_ABS_L = "4eb9";
const RNG_A = "00002dca"; // $2DCA: moveq #100,d2 then $2DCC
const RNG_C = "00002dcc";

function bound(fn, at, code, extra = {}) {
  return { fn, at, code, ret: at + code.length / 2, ...extra };
}
const rngA = (fn, at, range, extra = {}) => bound(fn, at, JSR_ABS_L + RNG_A, { range, ...extra });
const rngC = (fn, at, extra) => bound(fn, at, JSR_ABS_L + RNG_C, extra);
/**
 * The name Copperline's capture tool gives a $2DCA/$2DCC call it has no label for: "unmapped-" + the six-digit hex address of the
 * `jsr` (NOT the return address). It is derived from the address, so it names exactly one instruction; it is accepted ONLY as the
 * `captureAlias` of a site that is bound below to that same instruction (address, bytes, return address, remake function). There is
 * no wildcard: any other `unmapped-XXXXXX` (an unaudited caller) stays an unknown site.
 */
export const unmappedCaptureName = (at) => `unmapped-${(at >>> 0).toString(16).toUpperCase().padStart(6, "0")}`;
const aliased = (site) => ({ ...site, captureAlias: unmappedCaptureName(site.at) });

/**
 * RNG call sites. `at` is the `jsr abs.l` instruction, `ret` the pushed return address (at + 6, the convention of every recorded
 * $2DCC tape, e.g. $9BCC -> $9BD2), `fn` the remake function that must make the draw. Derived from the static caller audit
 * (original-rng-callers.md section 5) and confirmed byte for byte against Disk.1 by verifySiteBindings().
 *   $2DCA sites: range is 100 by construction. $2DCC sites with a preceding `moveq #n,d2` pin the range to n (`d2Moveq`).
 */
export const RNG_SITES = {
  "intel-countdown": rngA("intelCountdown", 0xb056, 100), // $B018 daily report roll, called from $11724 via bsr $B018
  "wave-warning-strength": rngA("eventWave", 0x11762, 100), // $11724 strength roll
  "wave-warning-intel": rngA("eventWave", 0x11786, 100), // $11724 intelligence pass-through roll (after $144CA -> ext.w/subq)
  "wave-group": rngC("launchWave", 0x117f6, { range: 16, d2Moveq: { at: 0x117f4, imm: 16 } }), // $117EE group
  "wave-entry": rngC("launchWave", 0x1182e, { range: 8, d2Moveq: { at: 0x1182c, imm: 8 } }), // $117EE first entry
  "random-building": rngC("randomBuilding", 0x11a74, { maxRange: 254 }), // $11A5C target choice; D2 = min($142C2, $FE)
  "enemy-bomb-chance": rngA("attack", 0x12772, 100), // $1266A bomb-percent roll behind the TOD gate
  // ---- direct sites exercised by the RAM-staged Copperline invasion capture (live-8). Each is `captureAlias`ed (see above) and is a
  // row of original-rng-callers.md section 5; the remake function is its "TS" column. Ranges: $2DCA is 100, a `moveq #n,d2` pins n,
  // and the two D2-from-data sites carry an upper bound only (a looser bound never rejects a genuine row).
  "births-rate": aliased(rngC("births", 0x9bcc, { maxRange: 0xff })), // $9BB6 births: D2 = byte $145A2 (zero skips); tape range 30
  "market-walk-value": aliased(rngC("walkEntry", 0xa7ba, { range: 4, d2Moveq: { at: 0xa7b8, imm: 4 } })), // $A7AE market entry, `moveq #4,d2`
  "market-walk-spread": aliased(rngC("walkEntry", 0xa7cc, { maxRange: 0xffff })), // D2.w = d5 - d1 (max - min)
  "market-walk-demand": aliased(rngA("marketWalk", 0xa84e, 100)), // $A814 per-commodity demand coin flip (> $32)
  "crime-monthly": aliased(rngC("crimeMonthly", 0x10be8, { range: 20, d2Moveq: { at: 0x10be6, imm: 20 } })), // $10BC8 monthly, `moveq #20,d2`
  // random-event chance rolls ($13118 handler table; k = table index, original-rng-callers.md section 3)
  "event-virus-chance": aliased(rngA("eventVirus", 0x10ee6, 100)), // $10ED2 (k = 18)
  "event-power-accident-chance": aliased(rngA("eventPowerAccident", 0x10f68, 100)), // $10F5E (k = 6)
  "event-trade-computer-chance": aliased(rngA("eventTradeComputer", 0x10f96, 100)), // $10F8E (k = 7)
  "event-eclipse-chance": aliased(rngA("eventEclipse", 0x11060, 100)), // $11058 (k = 14)
  "event-mine-collapse-chance": aliased(rngA("eventMineCollapse", 0x11090, 100)), // $11090 (k = 4)
  "event-colonist-offer-chance": aliased(rngA("eventColonistOffer", 0x110fe, 100)), // $110FE (k = 0)
  "event-scientists-requisition-chance": aliased(rngA("eventScientistsRequisition", 0x111a6, 100)), // $111A6 (k = 10)
  "event-tank-requisition-chance": aliased(rngA("eventTankRequisition", 0x11280, 100)), // $11280 (k = 11)
  "event-ship-explosion-chance": aliased(rngA("eventShipExplosion", 0x113a6, 100)), // $113A6 (k = 12)
  "event-alien-appears-chance": aliased(rngA("eventAlienAppears", 0x1146a, 100)), // $1146A (k = 1)
  "event-tank-defect-chance": aliased(rngA("eventTankDefect", 0x11566, 100)), // $11566 (k = 17)
};
/** `at` is `move.b $BFE801.l,d1` in $1266A; `ret` is the address of the instruction after the read (the PC a capture records). */
export const TOD_SITES = { "enemy-attack-tod-gate": bound("attack", 0x12694, "123900bfe801") };
/** `at` is `jsr $2E00` in $117EE (raster parity -> jitter sign); `ret` its return address. */
export const RASTER_SITES = { "wave-entry-jitter-raster": bound("launchWave", 0x11842, JSR_ABS_L + "00002e00") };
export const SITE_TABLES = { RNG: RNG_SITES, TOD: TOD_SITES, raster: RASTER_SITES };

/** Table self-consistency: unique return addresses, ranges agree with the target / moveq. Throws on a coding error. */
export function checkSiteTable() {
  const seen = new Map();
  const names = new Map(); // every accepted tape name (label or alias) -> label
  for (const [kind, sites] of Object.entries(SITE_TABLES)) {
    for (const [label, s] of Object.entries(sites)) {
      if (label.startsWith("unmapped-")) throw new Error(`site table: ${kind} label ${label} is a generic capture name, not an audited label`);
      for (const name of s.captureAlias === undefined ? [label] : [label, s.captureAlias]) {
        if (names.has(`${kind}:${name}`)) throw new Error(`site table: ${kind} name ${name} is used twice`);
        names.set(`${kind}:${name}`, label);
      }
      if (s.captureAlias !== undefined && s.captureAlias !== unmappedCaptureName(s.at)) throw new Error(`site table: ${label} alias ${s.captureAlias} is not the capture name of its own instruction ${hex(s.at, 5)}`);
    }
  }
  for (const [kind, sites] of Object.entries(SITE_TABLES)) {
    for (const [label, s] of Object.entries(sites)) {
      if (seen.has(s.ret)) throw new Error(`site table: ${kind} ${label} and ${seen.get(s.ret)} share return address ${hex(s.ret, 5)}`);
      seen.set(s.ret, `${kind} ${label}`);
      if (s.ret !== s.at + s.code.length / 2) throw new Error(`site table: ${label} return address is not at + instruction length`);
      if (kind === "RNG") {
        if (s.code.endsWith(RNG_A) && s.range !== 100) throw new Error(`site table: ${label} calls $2DCA, the range must be 100`);
        if (s.d2Moveq && (s.d2Moveq.imm !== s.range || s.d2Moveq.at + 2 !== s.at)) throw new Error(`site table: ${label} moveq does not pin range ${s.range} directly before the call`);
        if (s.range === undefined && s.maxRange === undefined) throw new Error(`site table: ${label} has no range rule`);
      }
    }
  }
}

/** The label (any kind) that owns return address `ret`, or null. */
function ownerOf(ret) {
  for (const [kind, sites] of Object.entries(SITE_TABLES)) for (const [label, s] of Object.entries(sites)) if (s.ret === ret) return `${kind} site ${label}`;
  return null;
}

/**
 * Resolve the name a tape row carries to its table label: the label itself or the exact `captureAlias` of one audited site.
 * Anything else (unknown labels, unaudited `unmapped-XXXXXX` names, prototype keys) is null and must be rejected by the caller.
 */
export function resolveSiteName(sites, name) {
  if (typeof name !== "string") return null;
  if (Object.hasOwn(sites, name)) return name;
  for (const [label, s] of Object.entries(sites)) if (s.captureAlias !== undefined && s.captureAlias === name) return label;
  return null;
}

/**
 * A tape row names `label` and carries return address `ret` (integer). The address must be EXACTLY the one bound to the label.
 * @throws ContractError malformed-capture/ret-mismatch
 */
export function checkReturn(sites, label, ret, where) {
  const s = Object.hasOwn(sites, label) ? sites[label] : undefined;
  if (!s) throw new ContractError("unsupported-capture", "unknown-site", `${where}: site ${JSON.stringify(label)} is not in the site table`);
  if (ret === s.ret) return;
  const owner = ownerOf(ret);
  malformed("ret-mismatch", `${where}: site ${label} must return to ${hex(s.ret, 5)} (instruction at ${hex(s.at, 5)} of Disk.1), the row says ${hex(ret, 5)}${owner ? ` which belongs to ${owner}` : " which is not a known call/read site"}`);
}

/**
 * Compare every table entry with the user's Disk.1 image. A mismatch (other release, damaged or wrong file) is an `original-input`
 * error: the address table is only meaningful against the 0757 game image it was derived from.
 */
export function verifySiteBindings(disk1) {
  const bytesAt = (addr, len) => {
    const o = addr + GAME_IMAGE_FILE_DELTA;
    if (o < 0 || o + len > disk1.length) throw new ContractError("original-input", "site-binding", `Disk.1 is too short for the code at ${hex(addr, 5)}`);
    return Buffer.from(disk1.subarray(o, o + len)).toString("hex");
  };
  for (const [kind, sites] of Object.entries(SITE_TABLES)) {
    for (const [label, s] of Object.entries(sites)) {
      const got = bytesAt(s.at, s.code.length / 2);
      if (got !== s.code) throw new ContractError("original-input", "site-binding", `${kind} site ${label}: Disk.1 holds ${got} at ${hex(s.at, 5)}, expected ${s.code}; this is not the game image the address table was derived from`);
      if (s.d2Moveq) {
        const m = bytesAt(s.d2Moveq.at, 2);
        const want = `74${s.d2Moveq.imm.toString(16).padStart(2, "0")}`;
        if (m !== want) throw new ContractError("original-input", "site-binding", `${kind} site ${label}: Disk.1 holds ${m} at ${hex(s.d2Moveq.at, 5)}, expected moveq #${s.d2Moveq.imm},d2 (${want})`);
      }
    }
  }
}
