// Synthetic coverage of profile recognition (src/data/detect.ts), byte validation
// (src/data/profile-input.ts) and the startup gate (src/startup.ts). No original data is used or stored;
// all disks are generated here with the documented signatures and sizes. Run after `npm run build`.

const { detectProfile, findByName, PROFILES } = await import("../dist/data/detect.js");
const { validateProfileBytes, summariseInputErrors } = await import("../dist/data/profile-input.js");
const { loadValidatedInput, startFromFiles } = await import("../dist/startup.js");

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failed++; };

const DISK1_SIZE = 970752;
const DISK2_SIZE = 983040;
const SLAVE_SIZE = 1264;
const HEADER = 0x3c0 * 512;
const RANGE_FIELDS = ["sprites", "tiles", "descriptors", "map", "block", "intel", "text[0]", "text[1]", "text[2]", "text[3]"];

function put16(b, o, v) { b[o] = v >> 8; b[o + 1] = v & 0xff; }
function setRange(disk2, record, fieldIndex, first, last) {
  const at = HEADER + 10 + record * 0x40 + 0x10 + fieldIndex * 4;
  put16(disk2, at, first);
  put16(disk2, at + 2, last);
}
function makeDisk1(size = DISK1_SIZE) {
  const b = new Uint8Array(size);
  b.set([0x44, 0x4f, 0x53, 0x00]); // "DOS\0"
  return b;
}
/** Synthetic scenario disk: UTOPSCEN header, ten records whose ranges are small and valid. */
function makeDisk2(size = DISK2_SIZE) {
  const b = new Uint8Array(size);
  for (const [i, c] of [..."UTOPSCEN"].entries()) b[HEADER + i] = c.charCodeAt(0);
  for (let r = 0; r < 10; r++) {
    for (const [i, c] of [..."SYNTH"].entries()) b[HEADER + 10 + r * 0x40 + i] = c.charCodeAt(0);
    RANGE_FIELDS.forEach((_, f) => setRange(b, r, f, 10 + f, 12 + f));
  }
  return b;
}

/**
 * A picked file. `size` is what the host reports and defaults to the bytes' length; passing a different
 * `size` models a file whose metadata claims the profile size while the bytes read are different.
 */
function file(name, bytes, size = bytes.length) {
  return { name, size, read: async () => bytes };
}
function standardFiles({ disk1 = makeDisk1(), disk2 = makeDisk2(), disk4 = null, slave = true, claim = true } = {}) {
  const files = [
    file("Disk.1", disk1, claim ? DISK1_SIZE : disk1.length),
    file("Disk.2", disk2, claim ? DISK2_SIZE : disk2.length),
  ];
  if (slave) files.push({ name: "Utopia.Slave", size: SLAVE_SIZE, read: async () => new Uint8Array(0) });
  if (disk4) files.push(file("disk.4", disk4));
  return files;
}
function spyFactories(order = []) {
  return {
    order,
    createMusic: (d1, d2) => { order.push("music"); return { tag: "music", d1, d2 }; },
    createSfx: (d1, d2, music) => { order.push("sfx"); return { tag: "sfx", music }; },
    createGame: (d1, d2, music, sfx) => { order.push("game"); return { tag: "game", music, sfx }; },
  };
}
const codes = (res) => (res.ok ? [] : res.errors.map((e) => e.code));

// ---- recognition (metadata only) ---------------------------------------------------------------
{
  check("profile has Disk.4 marked optional", PROFILES[0].files.find((f) => f.name === "disk.4")?.optional === true);
  const without = detectProfile([{ name: "Disk.1", size: DISK1_SIZE }, { name: "Disk.2", size: DISK2_SIZE }, { name: "Utopia.Slave", size: SLAVE_SIZE }]);
  check("recognised without disk.4", without.profile !== null && without.missing.length === 0 && without.problems.length === 0);
  const withIt = detectProfile([{ name: "DISK.1", size: DISK1_SIZE }, { name: "disk.2", size: DISK2_SIZE }, { name: "utopia.slave", size: SLAVE_SIZE }, { name: "Disk.4", size: 656 }]);
  check("recognised with disk.4 of any size, any case", withIt.profile !== null);
  const noDisk1 = detectProfile([{ name: "Disk.2", size: DISK2_SIZE }, { name: "Utopia.Slave", size: SLAVE_SIZE }]);
  check("missing Disk.1 reported", noDisk1.profile === null && noDisk1.missing.join() === "Disk.1" && noDisk1.problems[0].kind === "missing");
  const bad = detectProfile([{ name: "Disk.1", size: 5 }, { name: "Disk.2", size: DISK2_SIZE }, { name: "Utopia.Slave", size: SLAVE_SIZE }]);
  check("wrong size reported with sizes", bad.profile === null && bad.problems[0].kind === "wrong-size" && bad.problems[0].actualSize === 5 && bad.problems[0].expectedSize === DISK1_SIZE);
  const absentOptional = detectProfile([{ name: "Disk.1", size: DISK1_SIZE }, { name: "Disk.2", size: DISK2_SIZE }]);
  check("missing Utopia.Slave still reported (optional only for disk.4)", absentOptional.profile === null && absentOptional.missing.join() === "Utopia.Slave");
  const dup = [{ name: "disk.1", size: 1, tag: "first" }, { name: "Disk.1", size: 2, tag: "second" }];
  check("findByName returns first case-insensitive match", findByName(dup, "Disk.1")?.tag === "first");
  check("detectProfile uses the same first match", detectProfile([...dup, { name: "Disk.2", size: DISK2_SIZE }, { name: "Utopia.Slave", size: SLAVE_SIZE }]).problems[0].actualSize === 1);
}

// ---- byte validation ---------------------------------------------------------------------------
const profile = PROFILES[0];
const named = (name, bytes) => ({ name, bytes });
function validate(disk1, disk2, disk4 = null) {
  return validateProfileBytes(profile, { disk1: disk1 && named("Disk.1", disk1), disk2: disk2 && named("Disk.2", disk2), disk4 });
}
{
  const ok = validate(makeDisk1(), makeDisk2());
  check("valid synthetic disks pass", ok.ok && ok.input.records.length === 10 && ok.input.disk4 === null);

  check("Disk.1 wrong signature", codes(validate((() => { const d = makeDisk1(); d[0] = 0x41; return d; })(), makeDisk2())).join() === "disk1-signature");
  check('Disk.1 "DOS\\1" (other filesystem flag) rejected', codes(validate((() => { const d = makeDisk1(); d[3] = 1; return d; })(), makeDisk2())).includes("disk1-signature"));
  check("Disk.1 empty", codes(validate(new Uint8Array(0), makeDisk2())).includes("disk1-too-small"));
  check("Disk.1 wrong size", codes(validate(makeDisk1(1000), makeDisk2())).join() === "file-size-mismatch");

  check("Disk.2 wrong magic", codes(validate(makeDisk1(), (() => { const d = makeDisk2(); d[HEADER + 7] = 0x58; return d; })())).join() === "disk2-signature");
  check("Disk.2 UTOPSAVE is not a scenario disk", codes(validate(makeDisk1(), (() => { const d = makeDisk2(); d.set([...("UTOPSAVE")].map((c) => c.charCodeAt(0)), HEADER); return d; })())).includes("disk2-signature"));
  check("Disk.2 truncated before header", codes(validate(makeDisk1(), makeDisk2(HEADER + 512))).includes("disk2-header-truncated"));
  check("Disk.2 empty", codes(validate(makeDisk1(), new Uint8Array(0))).includes("disk2-header-truncated"));

  const missing = validate(null, null);
  check("absent bytes -> missing-file for both", codes(missing).join() === "missing-file,missing-file");

  // Range bounds: the last sector of the 1920-sector file is 1919.
  const edge = makeDisk2(); setRange(edge, 3, 3, 1000, 1919);
  check("range ending on the final sector is accepted", validate(makeDisk1(), edge).ok);
  const over = makeDisk2(); setRange(over, 3, 3, 1000, 1920);
  const overRes = validate(makeDisk1(), over);
  const e0 = overRes.ok ? null : overRes.errors[0];
  check("range one past the end is rejected with context", e0 && e0.code === "scenario-range-out-of-bounds" && e0.scenario === 3 && e0.field === "map" && e0.first === 1000 && e0.last === 1920 && /truncated/.test(e0.message));
  const farOut = makeDisk2(); setRange(farOut, 0, 0, 0xfff0, 0xffff);
  check("range far out of bounds rejected", codes(validate(makeDisk1(), farOut)).join() === "scenario-range-out-of-bounds");
  const inverted = makeDisk2(); setRange(inverted, 5, 1, 40, 30);
  const invRes = validate(makeDisk1(), inverted);
  check("inverted range rejected", !invRes.ok && invRes.errors.length === 1 && invRes.errors[0].code === "scenario-range-inverted" && invRes.errors[0].field === "tiles");
  const lastRec = makeDisk2(); setRange(lastRec, 9, 9, 2000, 2001);
  const lastRes = validate(makeDisk1(), lastRec);
  check("all ten records are checked (record 9, text[3])", !lastRes.ok && lastRes.errors[0].scenario === 9 && lastRes.errors[0].field === "text[3]");
  const firstRec = makeDisk2(); setRange(firstRec, 0, 0, 2000, 2001);
  check("record 0 is checked too", !validate(makeDisk1(), firstRec).ok);
  const every = makeDisk2(); for (let r = 0; r < 10; r++) for (let f = 0; f < 10; f++) setRange(every, r, f, 3000, 3001);
  const everyRes = validate(makeDisk1(), every);
  check("every bad range is reported (100)", !everyRes.ok && everyRes.errors.length === 100);

  // Header intact but the body truncated to just past the header: ranges beyond it are out of bounds.
  const cut = makeDisk2(HEADER + 1024);
  const cutRes = validate(makeDisk1(), cut);
  check("Disk.2 cut after the header with in-bounds ranges: only the size mismatch is reported",
    !cutRes.ok && codes(cutRes).join() === "file-size-mismatch");
  const cut2 = makeDisk2(HEADER + 1024); for (let f = 0; f < 10; f++) setRange(cut2, 0, f, 1000, 1010);
  check("... and header-only disk with far ranges rejected", codes(validate(makeDisk1(), cut2)).includes("scenario-range-out-of-bounds"));

  const disk4 = named("disk.4", new Uint8Array([1, 2, 3]));
  const withSeed = validate(makeDisk1(), makeDisk2(), disk4);
  check("disk.4 presence is carried through unvalidated", withSeed.ok && withSeed.input.disk4 === disk4);

  check("summary limits messages", summariseInputErrors(everyRes.errors, 2).endsWith("(+98 more)"));
  check("summary of a single error has no suffix", !/more/.test(summariseInputErrors(overRes.errors)));

  // Hostile lengths never throw, whatever their size.
  let threw = false, anyOk = false;
  try {
    for (const n of [0, 1, 3, 4, 7, 511, 512, 513, HEADER - 1, HEADER, HEADER + 7, HEADER + 8, HEADER + 649, HEADER + 650, HEADER + 1023, HEADER + 1024, HEADER + 1025]) {
      const d2 = makeDisk2().subarray(0, n);
      if (validate(makeDisk1().subarray(0, n), d2).ok) anyOk = true;
    }
  } catch { threw = true; }
  check("truncations at every boundary neither throw nor pass", !threw && !anyOk);
}

// ---- startup gate: rejection happens before constructors ----------------------------------------
{
  const s = spyFactories();
  const r = await startFromFiles(standardFiles(), s);
  check("valid folder without disk.4 starts", r.ok && r.input.disk4 === null && r.warnings.length === 0);
  check("constructors called in order music, sfx, game", s.order.join() === "music,sfx,game");
  check("sfx receives the music and game receives both", r.ok && r.sfx.music === r.music && r.game.music === r.music && r.game.sfx === r.sfx);
  check("factories receive validated disk bytes", r.ok && r.music.d1.length === DISK1_SIZE && r.music.d2.length === DISK2_SIZE);
}
{
  const s = spyFactories();
  const r = await startFromFiles(standardFiles({ disk4: new Uint8Array([0x58, 0x50, 0x4b, 0x46]) }), s);
  check("valid folder with disk.4 passes the seed through with its name", r.ok && r.input.disk4?.name === "disk.4" && r.input.disk4.bytes.length === 4);
  check("... and still constructs", s.order.join() === "music,sfx,game");
}
async function rejected(label, files, expectCode) {
  const s = spyFactories();
  let r, threw = false;
  try { r = await startFromFiles(files, s); } catch { threw = true; }
  check(`${label}: no throw`, !threw);
  check(`${label}: typed error ${expectCode}`, !threw && !r.ok && r.errors.some((e) => e.code === expectCode && e.message.length > 0), !threw && !r.ok ? r.errors.map((e) => e.code).join() : "");
  check(`${label}: no constructor called`, s.order.length === 0);
}
await rejected("Disk.1 wrong signature", standardFiles({ disk1: (() => { const d = makeDisk1(); d.fill(0x41, 0, 4); return d; })() }), "disk1-signature");
await rejected("Disk.1 truncated but claiming profile size", standardFiles({ disk1: new Uint8Array(2) }), "disk1-too-small");
await rejected("Disk.1 truncated, honest size", standardFiles({ disk1: makeDisk1(5000), claim: false }), "file-size-mismatch");
await rejected("Disk.2 wrong magic", standardFiles({ disk2: (() => { const d = makeDisk2(); d.fill(0, HEADER, HEADER + 8); return d; })() }), "disk2-signature");
await rejected("Disk.2 truncated before header", standardFiles({ disk2: makeDisk2(4096) }), "disk2-header-truncated");
await rejected("Disk.2 range out of bounds", standardFiles({ disk2: (() => { const d = makeDisk2(); setRange(d, 7, 4, 1900, 1925); return d; })() }), "scenario-range-out-of-bounds");
await rejected("Disk.2 inverted range", standardFiles({ disk2: (() => { const d = makeDisk2(); setRange(d, 2, 2, 9, 3); return d; })() }), "scenario-range-inverted");
await rejected("missing Disk.2", standardFiles().filter((f) => f.name !== "Disk.2"), "missing-file");
await rejected("missing Disk.1", standardFiles().filter((f) => f.name !== "Disk.1"), "missing-file");
await rejected("missing slave", standardFiles({ slave: false }), "missing-file");
await rejected("empty selection", [], "missing-file");
{
  const files = standardFiles();
  files[0] = { ...files[0], read: async () => { throw new Error("denied"); } };
  await rejected("Disk.1 unreadable", files, "read-failed");
}
{
  const files = standardFiles();
  files[1] = { ...files[1], read: () => { throw new Error("sync failure"); } };
  await rejected("Disk.2 read throws synchronously", files, "read-failed");
}
{
  const unreadable = { name: "disk.4", size: 656, read: async () => { throw new Error("locked"); } };
  const s = spyFactories();
  const r = await startFromFiles([...standardFiles(), unreadable], s);
  check("unreadable optional disk.4 only warns", r.ok && r.input.disk4 === null && r.warnings.length === 1 && r.warnings[0].code === "disk4-unreadable");
  check("... and still starts", s.order.join() === "music,sfx,game");
}
{
  // loadValidatedInput does not read file contents when recognition already fails.
  let reads = 0;
  const files = [{ name: "Disk.1", size: 1, read: async () => { reads++; return new Uint8Array(1); } }];
  const r = await loadValidatedInput(files);
  check("no bytes are read when recognition fails", !r.ok && reads === 0);
  check("size mismatch message names expected and actual sizes", !r.ok && r.errors.some((e) => e.code === "file-size-mismatch" && /1 bytes/.test(e.message) && /970752/.test(e.message)));
}
{
  // A factory defect is not turned into a validation error.
  let caught = false;
  try { await startFromFiles(standardFiles(), { ...spyFactories(), createSfx: () => { throw new Error("boom"); } }); } catch (e) { caught = e.message === "boom"; }
  check("factory exceptions on valid input propagate", caught);
}

if (failed > 0) {
  console.log(`\n${failed} profile-input check(s) failed`);
  process.exit(1);
}
console.log("\nall profile-input checks passed");
