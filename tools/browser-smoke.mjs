#!/usr/bin/env node
// Real-browser smoke test for the remake. Node built-ins only (no npm dependencies).
//
// Starts tools/serve.mjs on 127.0.0.1, launches Chrome (or Edge) headless with a fresh temporary profile, and drives the page
// over the Chrome DevTools Protocol (Node's global WebSocket). Every step is checked by an observable effect: canvas pixels
// sampled with Runtime.evaluate, the #status text, the top-bar date and money read back from the canvas pixels, and localStorage
// for the save. Screenshots go to a directory in the system temp folder. Browser and server are killed and the profile removed
// on exit, also on failure.
//
// The top-bar date is read by matching the canvas pixels of the date field against every date the game can show (dd/mm/yyyy
// from START_YEAR, rendered with the game's own font through dist/data/gamefont.js). A date that matches no candidate reads as
// null. The money is only compared as pixels (changed or not); its digits are not decoded.
//
// Needs a built dist/ (this script does not build) and the user's own game files in original/utopia-whdload (Disk.1 and Disk.2;
// disk.4 is optional). Skips (exit 0) when no browser or no game files are found. Env: CHROME_PATH overrides the browser;
// UTOPIA_SMOKE_ALL=1 adds step 10 (every scenario and the tutorial, one map screenshot each).
// Exit 1 on any failed step or check, any page exception, any console error or log error, any failed request or HTTP 4xx/5xx.
//
// Usage: node tools/browser-smoke.mjs        (UTOPIA_SMOKE_ALL=1 node tools/browser-smoke.mjs)

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "./serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_DIR = path.join(ROOT, "original", "utopia-whdload");
const DISK1 = path.join(GAME_DIR, "Disk.1");
const DISK2 = path.join(GAME_DIR, "Disk.2");
const DIST_MAIN = path.join(ROOT, "dist", "main.js");
const RUN_ALL = process.env.UTOPIA_SMOKE_ALL === "1";
const W = 320;
const H = 200;
const VIEW_W = 1100;
const VIEW_H = 900;
const BOOT_TIMEOUT_MS = 9 * 60_000;
// Top-bar fields (map.ts drawTopBar): the date at x 8, the money at x 110, both at y 2 with 6 glyph rows.
const DATE_OCR = { x: 0, y: 0, w: 100, h: 10 };
const MONEY_BOX = { x: 110, y: 0, w: 69, h: 10 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- coordinates (the same as test/playthrough.mjs; the disk menu and command buttons come from the dist modules) ----------------

const ARROW_CENTRE = { left: [226, 127], up: [250, 127], down: [226, 141], right: [250, 141] };
const pageRow = (row) => [50, 40 + 16 + row * 12 + 4];
const listRow = (row) => [100, 0x20 + row * 9 + 4];
const INTRO_CLICK = [100, 0x10];
const ENGLISH = [160, 0x10];
// Map view cell (vx, vy): the centre of its 32 x 15 rectangle (controls.ts pickCell: x0 = 112 + 16 (vx - vy), y0 = 24 + 8 (vx + vy)).
const viewCell = (vx, vy) => [112 + 16 * (vx - vy) + 15, 24 + 8 * (vx + vy) + 7];

// ---- page-side JavaScript -------------------------------------------------------------------------------------------------------

// Wraps AudioContext so the page's contexts can be inspected later (state only; nothing else changes).
const AUDIO_WRAP = `(() => {
  const Real = window.AudioContext || window.webkitAudioContext;
  window.__audioContexts = [];
  if (!Real) return;
  const Wrapped = function (...args) { const ctx = new Real(...args); window.__audioContexts.push(ctx); return ctx; };
  Wrapped.prototype = Real.prototype;
  window.AudioContext = Wrapped;
  if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
})();`;

const rectJs = (box) => `Array.from(document.getElementById('screen').getContext('2d').getImageData(${box.x}, ${box.y}, ${box.w}, ${box.h}).data)`;
const HASH_JS = `(() => {
  const c = document.getElementById('screen');
  const d = c.getContext('2d').getImageData(0, 0, ${W}, ${H}).data;
  let h = 2166136261 >>> 0;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4) {
    h = Math.imul(h ^ d[i], 16777619) >>> 0;
    h = Math.imul(h ^ d[i + 1], 16777619) >>> 0;
    h = Math.imul(h ^ d[i + 2], 16777619) >>> 0;
    seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  return { hash: h, colours: seen.size };
})()`;

const PIXELS_JS = `Array.from(document.getElementById('screen').getContext('2d').getImageData(0, 0, ${W}, ${H}).data)`;
const RECT_JS = `(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`;
const STATUS_JS = `document.getElementById('status').textContent`;
const RECT_JS_CANVAS = RECT_JS;

// ---- pixel helpers (Node side, on the RGBA arrays from the page) ----------------------------------------------------------------

function diffCount(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

// Changed pixels inside a game-pixel box of the 320 x 200 frame.
function boxDiff(a, b, x0, y0, w, h) {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const i = (y * W + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    }
  }
  return n;
}

// Best whole-pixel offset of `b` against `a` inside a box (game pixels) that avoids the side panel and the buildings. Returns the
// matching ratio over the pixels both frames share. The default box is the whole view: its dark corners do not move with a scroll,
// so for a scroll use a patch of land (see the scroll check).
function bestShift(a, b, range = 24, box = [16, 24, 304, 176]) {
  const [x0, y0, x1, y1] = box;
  let best = { dx: 0, dy: 0, ratio: -1 };
  for (let dy = -range / 2; dy <= range / 2; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      let same = 0, total = 0;
      for (let y = y0; y < y1; y += 2) {
        const sy = y + dy;
        if (sy < 0 || sy >= H) continue;
        for (let x = x0; x < x1; x += 2) {
          const sx = x + dx;
          if (sx < 0 || sx >= W) continue;
          const i = (y * W + x) * 4, j = (sy * W + sx) * 4;
          total++;
          if (a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2]) same++;
        }
      }
      const ratio = total ? same / total : 0;
      if (ratio > best.ratio) best = { dx, dy, ratio };
    }
  }
  return best;
}

function identicalRatio(a, b) {
  let same = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
  }
  return same / n;
}

function fnv(values) {
  let h = 2166136261 >>> 0;
  for (const v of values) h = Math.imul(h ^ v, 16777619) >>> 0;
  return h;
}

// Reads the top-bar date from an RGBA crop of DATE_OCR. The ink is every pixel that is not the crop's most common colour; it must
// equal, pixel for pixel, the ink of exactly one candidate date rendered with the game's font at the game's position.
function makeDateReader(disk, drawGameText, Screen, SCREEN_WIDTH, startYear) {
  const screen = new Screen();
  const texts = [];
  for (let year = startYear; year <= startYear + 110; year++) {
    for (let month = 0; month < 12; month++) {
      for (let day = 0; day < 32; day++) {
        texts.push(`${String(day).padStart(2, "0")}/${String(month + 1).padStart(2, "0")}/${year}`);
      }
    }
  }
  const { w, h } = DATE_OCR;
  const maskOf = (text) => {
    screen.pixels.fill(0, 0, (DATE_OCR.y + h) * SCREEN_WIDTH);
    drawGameText(disk, screen, Array.from(text, (c) => c.charCodeAt(0)), 8, 2, 1);
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = screen.pixels[(DATE_OCR.y + y) * SCREEN_WIDTH + DATE_OCR.x + x] ? 1 : 0;
    return m;
  };
  let masks = null;
  return {
    texts,
    // The map's top bar sits on a dithered backdrop, so no single colour is "the background". The ink is the text colour
    // (a palette index, the same for every glyph pixel): each colour in the crop is tried as the ink, most common first.
    read(rgba) {
      const n = w * h;
      const keys = new Uint32Array(n);
      const counts = new Map();
      for (let p = 0; p < n; p++) {
        const i = p * 4;
        const k = ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0;
        keys[p] = k;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const colours = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k]) => k);
      masks ??= texts.map(maskOf);
      const crop = new Uint8Array(n);
      for (const ink of colours) {
        let count = 0;
        for (let p = 0; p < n; p++) {
          crop[p] = keys[p] === ink ? 1 : 0;
          count += crop[p];
        }
        if (count === 0) continue;
        for (let c = 0; c < texts.length; c++) {
          const m = masks[c];
          let same = true;
          for (let p = 0; p < n; p++) if (m[p] !== crop[p]) { same = false; break; }
          if (same) return { text: texts[c], ink: count };
        }
      }
      return { text: null, ink: 0 };
    },
  };
}

// Reads the top-bar money (map.ts drawTopBar: patchNumber(template, money, 0, 7) drawn at x 110, y 2). The seven digit positions are
// decoded left to right: each takes the first candidate ('0'-'9', or the blank '#' of a leading zero) whose rendering of the decoded
// prefix matches the canvas pixels in the columns that prefix covers. Returns the money as a number, or null when no ink colour
// decodes all seven positions.
function makeMoneyReader(disk, drawGameText, Screen, SCREEN_WIDTH) {
  const screen = new Screen();
  const TEXT_Y = 2;
  const BLANK = 0x23;
  const CANDIDATES = [...Array.from({ length: 10 }, (_, i) => 0x30 + i), BLANK];
  const { x: X0, w, h } = MONEY_BOX;
  // The mask of `codes` drawn at (X0, TEXT_Y), in the columns it reaches; `drawGameText` returns the x after the last glyph.
  const renderMask = (codes) => {
    screen.pixels.fill(0, 0, h * SCREEN_WIDTH);
    const xEnd = drawGameText(disk, screen, codes, X0, TEXT_Y, 1);
    const cols = xEnd - X0;
    const m = new Uint8Array(cols * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < cols; x++) m[y * cols + x] = screen.pixels[y * SCREEN_WIDTH + X0 + x] ? 1 : 0;
    return m;
  };
  const cropMask = (rgba, ink, cols) => {
    const m = new Uint8Array(cols * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * w + x) * 4;
        m[y * cols + x] = ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0 === ink ? 1 : 0;
      }
    }
    return m;
  };
  const sameMask = (a, b) => {
    if (a.length !== b.length) return false;
    for (let p = 0; p < a.length; p++) if (a[p] !== b[p]) return false;
    return true;
  };
  return {
    read(rgba) {
      const counts = new Map();
      for (let p = 0; p < w * h; p++) {
        const i = p * 4;
        const k = ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const colours = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k]) => k);
      for (const ink of colours) {
        const codes = [];
        let ok = true;
        for (let pos = 0; pos < 7 && ok; pos++) {
          const hit = CANDIDATES.find((c) => {
            const test = [...codes, c];
            const m = renderMask(test);
            return sameMask(m, cropMask(rgba, ink, m.length / h));
          });
          if (hit === undefined) ok = false;
          else codes.push(hit);
        }
        if (ok) {
          const digits = codes.filter((c) => c !== BLANK).map((c) => String.fromCharCode(c)).join("");
          return digits === "" ? 0 : Number(digits);
        }
      }
      return null;
    },
  };
}

// Order key of a "dd/mm/yyyy" date.
const dateKey = (t) => Number(t.slice(6)) * 10000 + Number(t.slice(3, 5)) * 100 + Number(t.slice(0, 2));

// ---- CDP over Node's WebSocket -------------------------------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const msg = JSON.parse(text);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result ?? {});
        return;
      }
      const list = this.handlers.get(msg.method);
      if (list) for (const h of [...list]) h(msg.params ?? {}, msg.sessionId);
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.ws.send(JSON.stringify(message));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  off(method, fn) {
    const list = this.handlers.get(method);
    if (list) this.handlers.set(method, list.filter((h) => h !== fn));
  }
}

// ---- browser and profile lifecycle ---------------------------------------------------------------------------------------------

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Kills the launched process and, on Windows, every process whose command line names this profile directory.
function killBrowser(child, profile) {
  try {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } catch {
    // already gone
  }
  if (process.platform === "win32") {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", timeout: 20_000 });
    } catch {
      // nothing matched or PowerShell unavailable
    }
  } else {
    try {
      execFileSync("pkill", ["-KILL", "-f", profile], { stdio: "ignore" });
    } catch {
      // nothing matched
    }
  }
}

async function waitForFile(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text.split(/\r?\n/).length >= 2) return text.split(/\r?\n/);
    }
    await sleep(100);
  }
  return null;
}

function waitEvent(cdp, method, sessionId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off(method, handler);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    const handler = (params, sid) => {
      if (sid !== sessionId) return;
      clearTimeout(timer);
      cdp.off(method, handler);
      resolve(params);
    };
    cdp.on(method, handler);
  });
}

// ---- main ---------------------------------------------------------------------------------------------------------------------

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log("skip: no Chrome or Edge found (set CHROME_PATH to a browser executable)");
    return 0;
  }
  if (!fs.existsSync(DISK1) || !fs.existsSync(DISK2)) {
    console.log(`skip: game files not found in ${GAME_DIR} (Disk.1 and Disk.2 are needed)`);
    return 0;
  }

  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "utopia-smoke-shots-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "utopia-smoke-profile-"));
  const server = createServer(ROOT);
  let child = null;
  let cdp = null;
  let sid = null;
  let snapshotAudio = async () => {}; // replaced once the page session exists; also used by the finally block

  const errors = []; // { kind, text }
  const requestUrls = new Map();
  const failures = [];
  const shots = [];
  const audioByDocument = [];
  let aborted = false;
  let browserStderr = "";
  let fileMethod = "none";
  let placeholderHash = null; // the start-up gradient; a game frame is anything else with more than three colours
  const isGameFrame = (h) => h.hash !== placeholderHash && h.colours > 3;

  const record = (kind, text) => errors.push({ kind, text: String(text).slice(0, 400) });
  const check = (name, cond, detail = "") => {
    if (cond) console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
    else {
      console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
      failures.push(`${name}${detail ? ` (${detail})` : ""}`);
    }
    return cond;
  };
  const step = async (name, fn) => {
    if (aborted) {
      console.log(`skip ${name}  (an earlier step failed)`);
      return;
    }
    const before = failures.length;
    console.log(`--- ${name}`);
    try {
      await fn();
    } catch (err) {
      failures.push(`exception: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  FAIL exception: ${err instanceof Error ? err.stack?.split("\n").slice(0, 3).join(" | ") : String(err)}`);
    }
    if (failures.length > before) {
      console.log(`FAIL step ${name}  ${failures.slice(before).join("; ")}`);
      aborted = true;
    } else {
      console.log(`ok   step ${name}`);
    }
  };

  const ev = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) {
      throw new Error(`page evaluation failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  };
  const hashNow = () => ev(HASH_JS);
  const frame = () => ev(PIXELS_JS);
  const status = () => ev(STATUS_JS);
  const shot = async (name) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
    const file = path.join(shotDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    shots.push(file);
    return file;
  };
  const sleepHash = async (ms) => {
    const a = await hashNow();
    await sleep(ms);
    const b = await hashNow();
    return { same: a.hash === b.hash, a, b };
  };
  const waitUntil = async (fn, timeoutMs, interval = 250) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() >= end) return false;
      await sleep(interval);
    }
  };

  // Top-bar readings from the canvas pixels. The date is decoded only when its crop changes; null when no date is shown.
  let dateReader = null;
  let moneyReader = null;
  let lastDateCrop = null;
  let lastDate = null;
  // The top-bar money as a number (null when the digits do not decode); cached by the crop hash like dateNow.
  let lastMoneyCrop = null;
  let lastMoney = null;
  const moneyNow = async () => {
    const px = await ev(rectJs(MONEY_BOX));
    const h = fnv(px);
    if (h !== lastMoneyCrop) {
      lastMoneyCrop = h;
      lastMoney = moneyReader.read(px);
    }
    return lastMoney;
  };
  const dateNow = async () => {
    const px = await ev(rectJs(DATE_OCR));
    const h = fnv(px);
    if (h !== lastDateCrop) {
      lastDateCrop = h;
      lastDate = dateReader.read(px).text;
    }
    return lastDate;
  };
  // The date as it is now and whether it changes within `ms` (the map's day is about two seconds of video at this speed).
  const dateChangesWithin = async (ms) => {
    const from = await dateNow();
    if (from === null) return { changed: false, from, to: null };
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(250);
      const d = await dateNow();
      if (d !== null && d !== from) return { changed: true, from, to: d };
    }
    return { changed: false, from, to: from };
  };
  // Every date seen over `ms` (sampled every 500 ms); one value means the calendar stood still.
  const datesOver = async (ms) => {
    const seen = [await dateNow()];
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(500);
      seen.push(await dateNow());
    }
    return seen;
  };
  const moneyKey = async () => fnv(await ev(rectJs(MONEY_BOX)));

  // Input. Game coordinates go through the canvas rectangle; the centre of the game pixel is used.
  let buttons = 0;
  const toClient = async (gx, gy) => {
    const r = await ev(`(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    return { x: r.left + ((gx + 0.5) * r.width) / W, y: r.top + ((gy + 0.5) * r.height) / H };
  };
  const moveClient = (x, y) => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons }, sid);
  const pressClient = (x, y, button = "left") => {
    buttons |= button === "right" ? 2 : 1;
    return cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 }, sid);
  };
  const releaseClient = (x, y, button = "left") => {
    buttons &= ~(button === "right" ? 2 : 1);
    return cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons, clickCount: 1 }, sid);
  };
  const press = async (gx, gy, { hold = 200, button = "left" } = {}) => {
    const p = await toClient(gx, gy);
    await moveClient(p.x, p.y);
    await pressClient(p.x, p.y, button);
    await sleep(hold);
    await releaseClient(p.x, p.y, button);
    await sleep(350);
  };
  // The key is held for a moment: the map keeps only the last entry of a batch (map.ts foldKeys), so a release that arrives in the
  // same pass as its press would overwrite it. A real tap lasts longer than one pass (80 ms).
  const tapKey = async (key, code, vk, text) => {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, unmodifiedText: text }, sid);
    await sleep(120);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid);
    await sleep(150);
  };
  const tapDigit1 = () => tapKey("1", "Digit1", 49, "1");
  const tapEnter = () => tapKey("Enter", "Enter", 13, "\r");
  const tapP = () => tapKey("p", "KeyP", 80, "p");
  const tapF1 = () => tapKey("F1", "F1", 112, undefined);

  // Folder pick: a webkitdirectory input takes the directory path (tried first); the individual file paths are the fallback.
  const pickFolder = async () => {
    const doc = await cdp.send("DOM.getDocument", { depth: 1 }, sid);
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#folder" }, sid);
    const attempt = async (method, files) => {
      try {
        await cdp.send("DOM.setFileInputFiles", { nodeId, files }, sid);
      } catch (err) {
        return { method, ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      const accepted = await waitUntil(async () => (await status()).startsWith("Fundet:"), 6000, 200);
      return { method, ok: accepted, detail: await status() };
    };
    const dirResult = await attempt("directory", [GAME_DIR]);
    if (dirResult.ok) {
      fileMethod = "directory";
      return dirResult;
    }
    const files = fs.readdirSync(GAME_DIR).map((f) => path.join(GAME_DIR, f)).filter((f) => fs.statSync(f).isFile());
    const fileResult = await attempt("files", files);
    fileMethod = fileResult.ok ? "files" : `none (directory: ${dirResult.detail}; files: ${fileResult.detail})`;
    return fileResult;
  };

  // The intro (credit roll) is left with a click; the language screen is recognised as the picture that stays still for three
  // seconds. The choice is only accepted when the screen changes (fade-out), so a misread picture does not count.
  const reachLanguageAndChooseEnglish = async (tag = "") => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      await press(...INTRO_CLICK, { hold: 200 });
      let last = null;
      let since = Date.now();
      let still = false;
      const end = Date.now() + 25_000;
      while (Date.now() < end) {
        const h = (await hashNow()).hash;
        if (h !== last) {
          last = h;
          since = Date.now();
        } else if (Date.now() - since >= 3000) {
          still = true;
          break;
        }
        await sleep(250);
      }
      if (!still) continue;
      const before = (await hashNow()).hash;
      await shot(`03b-language${tag}`);
      await press(...ENGLISH, { hold: 200 });
      const accepted = await waitUntil(async () => (await hashNow()).hash !== before, 6000, 200);
      if (accepted) return attempt;
    }
    throw new Error("the language screen did not accept an English choice after 8 attempts");
  };

  // Boot stages: Return (with a digit before it) at the code check; no key reaches a stage that does not read keys. The disk menu
  // is recognised by a probe: the scenario icon, then a press that opens the scenario list (as test/playthrough.mjs pickFromDisk).
  // The probe runs only while the picture has been still for six seconds (a boot slide or the fade is not a menu).
  const bootToDiskMenu = async () => {
    const end = Date.now() + BOOT_TIMEOUT_MS;
    let lastKeys = 0;
    let lastProbe = 0;
    let lastHash = null;
    let stillSince = Date.now();
    let lastReport = Date.now();
    let probes = 0;
    while (Date.now() < end) {
      if (Date.now() - lastKeys >= 2500) {
        await tapDigit1();
        await tapEnter();
        lastKeys = Date.now();
      }
      const h = (await hashNow()).hash;
      if (h !== lastHash) {
        lastHash = h;
        stillSince = Date.now();
      }
      if (Date.now() - lastReport >= 30_000) {
        console.log(`  ... boot in progress (${Math.round((Date.now() - (end - BOOT_TIMEOUT_MS)) / 1000)} s)`);
        lastReport = Date.now();
      }
      if (Date.now() - stillSince >= 6000 && Date.now() - lastProbe >= 8000) {
        lastProbe = Date.now();
        probes++;
        const before = await frame();
        await press(...icon(DISK_BUTTON.scenario), { hold: 150 });
        await sleep(700);
        await press(0, 0, { hold: 150 });
        await sleep(900);
        const after = await frame();
        if (diffCount(before, after) > 200) return probes;
      }
      await sleep(250);
    }
    throw new Error(`the boot stages did not reach the disk menu within ${BOOT_TIMEOUT_MS / 60_000} minutes`);
  };

  // ---- coordinates and the date reader from the dist modules (read-only) ------------------------------------------------------
  let cmd = null;
  let icon = null;
  let DISK_BUTTON = null;
  let BUILD_MENU_HITBOXES = null;
  const importDist = (p) => import(pathToFileURL(path.join(ROOT, "dist", p)).href);
  try {
    const { GameStrings } = await importDist("data/gamestrings.js");
    const { Ui } = await importDist("game/screens/ui.js");
    const disk = await importDist("game/disk-menu.js");
    const { drawGameText } = await importDist("data/gamefont.js");
    const { Screen, SCREEN_WIDTH } = await importDist("gfx/screen.js");
    const { START_YEAR } = await importDist("game/state.js");
    ({ BUILD_MENU_HITBOXES } = await importDist("game/build-menu.js"));
    DISK_BUTTON = disk.DISK_BUTTON;
    const disk1 = new Uint8Array(fs.readFileSync(DISK1));
    const ui = new Ui(disk1, new GameStrings(disk1, 0));
    cmd = (i) => {
      const p = ui.buttonPosition(i);
      return [p.x + 8, p.y + 8];
    };
    icon = (i) => {
      const r = disk.DISK_MENU_BUTTONS[i];
      return [r.x0 + 16, r.y0 + 16];
    };
    dateReader = makeDateReader(disk1, drawGameText, Screen, SCREEN_WIDTH, START_YEAR);
    moneyReader = makeMoneyReader(disk1, drawGameText, Screen, SCREEN_WIDTH);
  } catch (err) {
    console.log(`FAIL coordinates: could not load dist modules (${err instanceof Error ? err.message : String(err)}); run the build first`);
    failures.push("coordinates");
    aborted = true;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port: serverPort } = server.address();
    const url = `http://127.0.0.1:${serverPort}/`;

    if (!fs.existsSync(DIST_MAIN)) {
      failures.push("dist/main.js is missing (build first)");
      aborted = true;
    }

    // Launch the browser.
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-client-side-phishing-detection",
      "--disable-features=Translate,OptimizationHints,MediaRouter",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      `--window-size=${VIEW_W},${VIEW_H}`,
      "about:blank",
    ];
    child = spawn(browserPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stderr.on("data", (d) => {
      browserStderr = (browserStderr + d.toString()).slice(-2000);
    });
    child.stdout.on("data", () => {});
    const devtools = await waitForFile(path.join(profile, "DevToolsActivePort"), 30_000);
    if (!devtools) throw new Error(`browser did not open a DevTools port (${browserPath}); stderr: ${browserStderr.slice(-300)}`);
    const wsUrl = `ws://127.0.0.1:${devtools[0]}${devtools[1]}`;
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    });
    cdp = new Cdp(socket);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));

    // Collectors. Runtime, Log and Network events are handled for this page session only.
    const forPage = (fn) => (params, s) => {
      if (s === sid) fn(params);
    };
    cdp.on("Runtime.exceptionThrown", forPage((p) => {
      const d = p.exceptionDetails ?? {};
      record("page-exception", `${d.exception?.description ?? d.text ?? "exception"} (${d.url ?? ""}:${d.lineNumber ?? ""})`);
    }));
    cdp.on("Runtime.consoleAPICalled", forPage((p) => {
      if (p.type !== "error" && p.type !== "assert") return;
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      record("console-error", text);
    }));
    cdp.on("Log.entryAdded", forPage((p) => {
      const e = p.entry ?? {};
      if (e.level === "error") record("log-error", `${e.text}${e.url ? ` [${e.url}]` : ""}`);
    }));
    cdp.on("Network.requestWillBeSent", forPage((p) => requestUrls.set(p.requestId, p.request?.url)));
    cdp.on("Network.responseReceived", forPage((p) => {
      const status = p.response?.status ?? 0;
      if (status >= 400) record("http-status", `${status} ${p.response?.url}`);
    }));
    cdp.on("Network.loadingFailed", forPage((p) => {
      record("request-failed", `${requestUrls.get(p.requestId) ?? p.requestId}: ${p.errorText}${p.canceled ? " (canceled)" : ""}`);
    }));

    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);
    await cdp.send("Log.enable", {}, sid);
    await cdp.send("Network.enable", {}, sid);
    await cdp.send("DOM.enable", {}, sid);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: AUDIO_WRAP }, sid);

    const navigate = async () => {
      const loaded = waitEvent(cdp, "Page.loadEventFired", sid, 30_000);
      await cdp.send("Page.navigate", { url }, sid);
      await loaded;
      await sleep(300);
    };
    snapshotAudio = async () => {
      try {
        const states = await ev(`(window.__audioContexts || []).map((c) => c.state)`);
        audioByDocument.push(states);
      } catch (err) {
        audioByDocument.push(`unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const resetPage = async () => {
      await navigate();
      const ok = await waitUntil(async () => (await ev(`document.readyState === 'complete' && !!document.getElementById('folder')`)), 10_000);
      if (!ok) throw new Error("the page did not show the folder input");
    };
    // Canvas and folder state after a reload start from the placeholder.
    const placeholderPixel = async () => ev(`Array.from(document.getElementById('screen').getContext('2d').getImageData(100, 50, 1, 1).data)`);

    // Hold a button press on a disk icon: the disk picture's own probe is a static one (no change for `ms`).
    const diskPictureStill = async (ms) => (await sleepHash(ms)).same;

    // ---- 1. load ----
    await step("1 load page", async () => {
      await resetPage();
      const pixel = await placeholderPixel();
      placeholderHash = (await hashNow()).hash;
      check("page loaded with the folder input and status", (await status()) === "Ingen mappe valgt.", await status());
      check("placeholder frame drawn (pixel 100,50 = 100,50,128)", pixel[0] === 100 && pixel[1] === 50 && pixel[2] === 128, pixel.join(","));
      await shot("01-loaded");
    });

    // ---- 2. files ----
    await step("2 pick the game folder", async () => {
      const result = await pickFolder();
      check(`folder accepted (${fileMethod})`, result.ok && (await status()).startsWith("Fundet:"), await status());
      const drawn = await waitUntil(async () => isGameFrame(await hashNow()), 30_000, 300);
      check("game started: canvas drawn with the intro", drawn);
      await shot("02-folder-picked");
    });

    // ---- 3. title, language, English ----
    await step("3 title, language, choose English", async () => {
      await sleep(1500);
      const title = await hashNow();
      check("title and credits drawn (not the placeholder, more than 3 colours)", isGameFrame(title), `colours ${title.colours}`);
      await shot("03a-title");
      const attempts = await reachLanguageAndChooseEnglish(); // throws unless the picture changed after the English click
      check("English chosen: the picture changed after the click", attempts >= 1, `intro clicks ${attempts}`);
    });

    // ---- 4. boot stages to the disk menu ----
    await step("4 boot stages to the disk menu", async () => {
      await sleep(1000);
      await shot("04a-boot");
      const probes = await bootToDiskMenu();
      check(`disk menu: the scenario icon press changed the picture (probe ${probes}, boot stages ended)`, probes >= 1);
      await shot("04b-disk-menu");
    });

    // ---- 5. scenario 1 and EXIT ----
    await step("5 scenario 1, EXIT to the map", async () => {
      const listOpen = await frame();
      await press(...listRow(0), { hold: 150 });
      await sleep(600);
      const picked = await frame();
      check("scenario 1 row picked: the disk picture changed (scenario message)", diffCount(listOpen, picked) > 200, `changed pixels ${diffCount(listOpen, picked)}`);
      await shot("05a-scenario-picked");
      const pictureBeforeExit = await frame();
      await press(...icon(DISK_BUTTON.exit), { hold: 150 });
      await sleep(1000);
      const running = await dateChangesWithin(20_000);
      const map = await frame();
      check("EXIT leads to the map: a date is shown in the top bar and it changes within 20 s", running.changed, `date ${running.from} -> ${running.to}`);
      check("the map replaced the disk picture", diffCount(pictureBeforeExit, map) > 300, `changed ${diffCount(pictureBeforeExit, map)}`);
      await shot("05b-map");
    });

    // ---- 6. scroll, F1 window, build menu, P ----
    await step("6 scroll, F1 window, build menu, pause", async () => {
      const [sx, sy] = ARROW_CENTRE.left;
      const before = await frame();
      const p = await toClient(sx, sy);
      await moveClient(p.x, p.y);
      await pressClient(p.x, p.y);
      await sleep(300);
      await releaseClient(p.x, p.y);
      await sleep(600);
      const after = await frame();
      // What is checked: the left-arrow hold changes the map picture. Not checked: the scroll amount. A land-patch shift search
      // (x 80..120, y 60..100) found a four-cell shift (64,32) in one probe, but in the full runs the buildings and the terrain
      // texture changed with no translation that the search could match, so the shift is reported, not asserted.
      const shift = bestShift(before, after, 128, [80, 60, 120, 100]);
      const wholeSame = identicalRatio(before, after);
      check("the left-arrow hold changes the map picture (more than 300 pixels)", diffCount(before, after) > 300, `changed ${diffCount(before, after)}; land-patch best shift dx ${shift.dx} dy ${shift.dy} match ${shift.ratio.toFixed(3)}; whole frame identical ${wholeSame.toFixed(3)}`);
      await shot("06a-scrolled");

      const beforeF1 = await frame();
      await tapF1();
      await sleep(900);
      const windowFrame = await frame();
      const window1 = await sleepHash(1500);
      check("F1 opens a report window (frame changed and then held still)", diffCount(beforeF1, windowFrame) > 300 && window1.same, `changed ${diffCount(beforeF1, windowFrame)} still ${window1.same}`);
      await shot("06b-f1-window");
      await press(...cmd(9), { hold: 150 });
      await sleep(600);
      const afterF1 = await dateChangesWithin(20_000);
      check("the report window closes to the running map (the date changes within 20 s)", afterF1.changed, `date ${afterF1.from} -> ${afterF1.to}`);

      const beforeBuild = await frame();
      await press(...cmd(0), { hold: 150 });
      await sleep(900);
      const buildOpen = await frame();
      const changed = diffCount(beforeBuild, buildOpen);
      check("build menu opens (pixels change beyond the animation)", changed > 300, `changed ${changed}`);
      await shot("06c-build-menu");
      await press(...cmd(9), { hold: 150 });
      await sleep(700);
      await shot("06d-build-menu-closed");

      // Pause: the date is the calendar's own readout. Running before P; still for 15 s after P; running again after the second P.
      const running = await dateChangesWithin(20_000);
      check("the map is running before P (the date changes within 20 s)", running.changed, `date ${running.from} -> ${running.to}`);
      await tapP();
      await sleep(1500);
      const paused = await datesOver(15_000);
      const stillDates = [...new Set(paused)];
      check("P pauses the map: the date does not change for 15 s", stillDates.length === 1 && stillDates[0] !== null, `dates ${stillDates.join(", ")}`);
      await shot("06d-paused");
      await tapP();
      const resumed = await dateChangesWithin(20_000);
      check("second P resumes the map: the date changes within 20 s", resumed.changed, `date ${resumed.from} -> ${resumed.to}`);
      await shot("06e-resumed");
    });

    // ---- 6b. place a building through the build menu; the top-bar money changes ----
    await step("6b place a building through the build menu: the money in the top bar changes", async () => {
      // Every view cell, nearest the centre first: a placement is refused "too far" from a flux pod, and the pods are not known here.
      const cells = Array.from({ length: 64 }, (_, i) => [i % 8, Math.floor(i / 8)]).sort(
        (a, b) => Math.hypot(a[0] - 3.5, a[1] - 3.5) - Math.hypot(b[0] - 3.5, b[1] - 3.5),
      );
      let placed = null;
      let items = 0;
      const attempts = [];
      for (let item = 0; item < 4 && placed === null; item++) {
        // Open the build menu, pick item `item` of page 0 (the pending item), exit (button 9) to build mode, then click cells.
        await press(...cmd(0), { hold: 150 });
        await sleep(900);
        const r = BUILD_MENU_HITBOXES[0][item];
        await press((r.x0 + r.x1) >> 1, (r.y0 + r.y1) >> 1, { hold: 150 });
        await sleep(600);
        await press(...cmd(9), { hold: 150 });
        await sleep(700);
        items++;
        for (const [vx, vy] of cells) {
          const [cx, cy] = viewCell(vx, vy);
          const moneyBefore = await moneyNow();
          const cellBefore = await frame();
          await press(cx, cy, { hold: 150 });
          await sleep(400);
          const moneyAfter = await moneyNow();
          attempts.push(`item ${item} cell (${vx},${vy}) money ${moneyBefore} -> ${moneyAfter}`);
          // Only a decrease counts: monthly income raises the money without any placement.
          if (moneyBefore !== null && moneyAfter !== null && moneyAfter < moneyBefore) {
            placed = { item, vx, vy, cx, cy, moneyBefore, moneyAfter, cellBefore, cellAfter: await frame() };
            break;
          }
        }
        if (placed === null) {
          await press(0, 0, { hold: 150, button: "right" }); // a right click returns to select mode
          await sleep(500);
        }
      }
      check("placing a building lowers the money in the top bar", placed !== null, `build items tried ${items}; ${attempts.length} attempts; last: ${attempts.at(-1) ?? "none"}`);
      if (placed) {
        const changed = boxDiff(placed.cellBefore, placed.cellAfter, placed.cx - 16, placed.cy - 24, 32, 39);
        check(`the cell (${placed.vx},${placed.vy}) shows a change where the building went`, changed >= 20, `box changed ${changed} px`);
        console.log(`  money ${placed.moneyBefore} -> ${placed.moneyAfter} after item ${placed.item} at cell (${placed.vx},${placed.vy})`);
        await shot("06f-building-placed");
        await press(0, 0, { hold: 150, button: "right" });
        await sleep(500);
      }
    });

    // ---- 7. map runs 60 s ----
    await step("7 map runs for 60 seconds", async () => {
      const dates = [];
      const seen = new Set();
      for (let i = 0; i < 12; i++) {
        seen.add((await hashNow()).hash);
        dates.push(await dateNow());
        await sleep(5000);
      }
      const known = dates.filter((d) => d !== null);
      const distinct = [...new Set(known)];
      const monotonic = known.every((d, i) => i === 0 || dateKey(d) >= dateKey(known[i - 1]));
      check("the top-bar date is shown throughout 60 s", known.length === dates.length, `shown ${known.length} of ${dates.length}`);
      check("the date advances over 60 s and never goes back", distinct.length > 1 && monotonic, `distinct ${distinct.length}: ${distinct[0]} .. ${distinct[distinct.length - 1]}`);
      check("frames change over 60 seconds (more than one distinct frame)", seen.size > 1, `distinct ${seen.size}`);
      const text = await status();
      check("status shows no loop error", !/stoppede/.test(text), text);
      await shot("07-after-60s");
    });

    // ---- 8. save, reload, load ----
    let dateAtSave = null;
    await step("8 save slot 0, reload, load slot 0", async () => {
      const preSave = await frame();
      dateAtSave = await dateNow(); // the last map frame before the disk picture opens
      check("the map shows the date just before the save", dateAtSave !== null, `date ${dateAtSave}`);
      await shot("08a-before-save");
      await press(...cmd(8), { hold: 150 });
      await sleep(800);
      check("map disk icon opens the disk picture (static)", await diskPictureStill(900));
      await press(...icon(DISK_BUTTON.save), { hold: 150 });
      await sleep(600);
      await shot("08b-save-page");
      await press(...pageRow(0), { hold: 150 });
      await sleep(600);
      await press(...pageRow(0), { hold: 150 });
      await sleep(900);
      const stored = await ev(`localStorage.getItem('utopia-remake-save-0')`);
      check("slot 0 is written to localStorage", typeof stored === "string" && stored.length > 0, `length ${stored?.length ?? 0}`);
      await press(0, 0, { hold: 150, button: "right" });
      await sleep(700);
      check("right click (BACK) returns to the disk picture (static)", await diskPictureStill(900));
      await press(...icon(DISK_BUTTON.exit), { hold: 150 });
      await sleep(1200);
      const afterSave = await dateChangesWithin(20_000);
      check("EXIT after the save returns to the running map (the date changes within 20 s)", afterSave.changed, `date ${afterSave.from} -> ${afterSave.to}`);
      await shot("08c-after-save");

      await snapshotAudio(); // the first document's AudioContexts, before the reload replaces them
      await cdp.send("Page.reload", { ignoreCache: false }, sid);
      await waitEvent(cdp, "Page.loadEventFired", sid, 30_000);
      await sleep(400);
      check("reload shows the folder input again", (await status()) === "Ingen mappe valgt.", await status());
      lastDateCrop = null;
      const picked = await pickFolder();
      check(`folder accepted after reload (${fileMethod})`, picked.ok && (await status()).startsWith("Fundet:"), await status());
      const redrawn = await waitUntil(async () => isGameFrame(await hashNow()), 30_000, 300);
      check("game started again after reload", redrawn);
      await sleep(1500);
      await reachLanguageAndChooseEnglish("-after-reload");
      await sleep(1000);
      await bootToDiskMenu();
      await shot("08d-boot-disk-menu");

      const before = await frame();
      await press(...icon(DISK_BUTTON.load), { hold: 150 });
      await sleep(700);
      const loadPage = await frame();
      check("load icon opens the slot page", diffCount(before, loadPage) > 200, `changed ${diffCount(before, loadPage)}`);
      await press(...pageRow(0), { hold: 150 });
      await sleep(900);
      const held = await frame();
      check("slot 0 loads and holds its scene on the disk picture", diffCount(loadPage, held) > 200, `changed ${diffCount(loadPage, held)}`);
      await shot("08e-loaded-held");
      await press(...icon(DISK_BUTTON.exit), { hold: 150 });
      await sleep(1000);
      const loaded = await waitUntil(async () => (await dateNow()) !== null, 20_000, 250);
      const dateLoaded = await dateNow();
      check("EXIT shows the loaded map with a date", loaded, `date ${dateLoaded}`);
      check(
        "the loaded date is the saved one or later",
        dateAtSave !== null && dateLoaded !== null && dateKey(dateLoaded) >= dateKey(dateAtSave),
        `saved ${dateAtSave} loaded ${dateLoaded}`,
      );
      const map2 = await frame();
      const ratio = identicalRatio(preSave, map2);
      check("loaded map matches the view at the save (identical pixels >= 0.85)", ratio >= 0.85, `identical ${ratio.toFixed(3)}`);
      await shot("08f-loaded-map");
    });

    // ---- 9. release outside the canvas, window blur ----
    await step("9 mouse release outside the canvas, window blur, input still works", async () => {
      const r = await ev(RECT_JS_CANVAS);
      check("point outside the canvas is outside it", 4 < r.left && 4 < r.top, JSON.stringify(r));
      const p = await toClient(...cmd(8));
      await moveClient(p.x, p.y);
      await pressClient(p.x, p.y);
      await sleep(200);
      await moveClient(4, 4);
      await releaseClient(4, 4);
      await sleep(1200);
      const disk = await sleepHash(1000);
      check("release outside the canvas still opens the disk picture (static)", disk.same);
      await shot("09a-released-outside");

      await ev(`window.dispatchEvent(new Event('blur'))`);
      await sleep(300);
      const beforeExit = await frame();
      await press(...icon(DISK_BUTTON.exit), { hold: 150 });
      await sleep(1000);
      const afterExit = await frame();
      check("after the blur a click still works: EXIT changes the picture", diffCount(beforeExit, afterExit) > 300, `changed ${diffCount(beforeExit, afterExit)}`);
      const running = await dateChangesWithin(20_000);
      check("the map after the blur runs (the date changes within 20 s)", running.changed, `date ${running.from} -> ${running.to}`);
      await shot("09b-after-blur-map");
    });

    // ---- 10. (UTOPIA_SMOKE_ALL=1) every scenario and the tutorial, one map screenshot each ----
    if (RUN_ALL) {
      await step("10 every scenario (1-10) and the tutorial: each opens a map with a date", async () => {
        const entries = [...Array.from({ length: 10 }, (_, i) => ({ label: `scenario ${i + 1}`, index: i })), { label: "tutorial", tutorial: true }];
        let prev = null;
        let k = 0;
        for (const entry of entries) {
          k++;
          const name = `10-${String(k).padStart(2, "0")}-${entry.tutorial ? "tutorial" : `scenario-${entry.index + 1}`}`;
          // From the map: its disk icon opens the disk picture.
          await press(...cmd(8), { hold: 150 });
          await sleep(800);
          const pic = await frame();
          if (entry.tutorial) {
            await press(...icon(DISK_BUTTON.tutorial), { hold: 150 });
            await sleep(1000);
          } else {
            await press(...icon(DISK_BUTTON.scenario), { hold: 150 });
            await sleep(600);
            const listOn = await frame();
            check(`${entry.label}: the scenario icon opens the list (picture changed)`, diffCount(pic, listOn) > 200, `changed ${diffCount(pic, listOn)}`);
            await press(...listRow(entry.index), { hold: 150 });
            await sleep(600);
            await press(...icon(DISK_BUTTON.exit), { hold: 150 });
            await sleep(1000);
          }
          const shown = await waitUntil(async () => (await dateNow()) !== null, 20_000, 250);
          const now = await frame();
          check(`${entry.label}: a map with a date is shown`, shown, `date ${await dateNow()}`);
          if (prev) check(`${entry.label}: the map differs from the previous entry`, diffCount(prev, now) > 300, `changed ${diffCount(prev, now)}`);
          const status2 = await status();
          check(`${entry.label}: the status shows no loop error`, !/stoppede/.test(status2), status2);
          await shot(name);
          prev = now;
        }
      });
    } else {
      console.log("--- 10 skipped (set UTOPIA_SMOKE_ALL=1 for every scenario and the tutorial)");
    }

    // ---- the whole run: no console errors, no failed or error requests, no page exceptions ----
    check(
      "no console errors, log errors, failed requests, HTTP 4xx/5xx or page exceptions",
      errors.length === 0,
      errors.length ? errors.map((e) => `[${e.kind}] ${e.text}`).join(" | ").slice(0, 600) : "",
    );
  } finally {
    // Everything below runs on success and on failure.
    try {
      if (cdp) {
        await snapshotAudio();
        try {
          cdp.ws.close();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    killBrowser(child, profile);
    if (child) await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      console.log(`warning: temp profile not removed (${profile}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- report ----
  console.log("");
  console.log(`browser: ${browserPath}`);
  console.log(`game folder: ${GAME_DIR} (picked as ${fileMethod})`);
  console.log(`screenshots: ${shotDir}`);
  for (const s of shots) console.log(`  ${path.basename(s)}`);
  console.log(`AudioContext per document (state after the run): ${audioByDocument.length ? JSON.stringify(audioByDocument) : "not read"}`);
  console.log(`errors collected: ${errors.length}`);
  for (const e of errors) console.log(`  [${e.kind}] ${e.text}`);
  const exceptions = errors.filter((e) => e.kind === "page-exception").length;
  const failedChecks = failures.length;
  console.log(failedChecks === 0 && exceptions === 0 ? "RESULT: passed" : `RESULT: FAILED (${failedChecks} failed checks, ${exceptions} page exceptions)`);
  return failedChecks === 0 && exceptions === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.log(`FAIL harness: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
