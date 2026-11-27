// Synthetic checks of the browser shell logic (src/browser/*.ts): frame clock, input state and pointer mapping.
// DOM-free: no window, canvas or events are created. Run after `npm run build`.

const { FrameClock, FRAME_MS, MAX_UPDATES_PER_FRAME } = await import("../dist/browser/frame-clock.js");
const { InputState } = await import("../dist/browser/input-state.js");
const { mapClientToScreen, SCREEN_WIDTH, SCREEN_HEIGHT } = await import("../dist/browser/pointer-map.js");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// Frame clock
{
  const clock = new FrameClock(0);
  check("frame clock: 20 ms is one update", FRAME_MS === 20 && clock.advance(20) === 1);
  check("frame clock: 45 ms in one step is two updates", new FrameClock(0).advance(45) === 2);
  check("frame clock: zero delta is no update", new FrameClock(100).advance(100) === 0);
}
{
  // Remainder is kept across calls: 25 -> 1 (5 left), 35 -> 0 (15 left), 40 -> 1 (0 left).
  const clock = new FrameClock(0);
  const got = [clock.advance(25), clock.advance(35), clock.advance(40)];
  check("frame clock: fractional remainder carries over", got.join(",") === "1,0,1", `got ${got.join(",")}`);
  check("frame clock: remainder below one frame after a call", new FrameClock(0).advance(7) === 0);
}
{
  const clock = new FrameClock(0);
  const first = clock.advance(1000); // 50 frames due, capped
  check("frame clock: cap at 10 updates per call", first === MAX_UPDATES_PER_FRAME && MAX_UPDATES_PER_FRAME === 10, `got ${first}`);
  const next = clock.advance(1005); // the excess was discarded, so only 5 ms is owed now
  check("frame clock: excess beyond the cap is discarded", next === 0, `got ${next}`);
  check("frame clock: remainder after a discard is the new delta only", clock.remainderMs === 5, `got ${clock.remainderMs}`);
}
{
  const clock = new FrameClock(500);
  const back = clock.advance(400); // timestamp went backwards
  check("frame clock: negative delta gives 0", back === 0);
  check("frame clock: resyncs after a negative delta", clock.advance(420) === 1);
}
{
  const clock = new FrameClock(0);
  check("frame clock: NaN timestamp gives 0", clock.advance(Number.NaN) === 0);
  check("frame clock: Infinity timestamp gives 0", clock.advance(Number.POSITIVE_INFINITY) === 0);
  check("frame clock: finite timestamp after non-finite works", clock.advance(40) === 2);
}

// Input state
{
  const s = new InputState();
  s.pressButton(0);
  s.afterUpdate(); // press seen by an update before release is applied
  check("input: press is visible until released", s.input.leftButton === true);
  s.releaseButton(0);
  s.afterUpdate();
  check("input: release applied after the update", s.input.leftButton === false);
}
{
  // A click shorter than one frame: press and release both arrive before the next update.
  const s = new InputState();
  let seen = 0;
  s.pressButton(0);
  s.releaseButton(0);
  const fake = { update() { if (s.input.leftButton) seen++; } };
  fake.update();
  s.afterUpdate();
  fake.update();
  check("input: short click is seen exactly once", seen === 1, `seen ${seen}`);
  check("input: button is up after the click", s.input.leftButton === false);
}
{
  // Release outside the canvas: the window mouseup is handled, so the button is not stuck.
  const s = new InputState();
  s.pressButton(2);
  s.releaseButton(2);
  s.afterUpdate();
  check("input: right button released outside the canvas", s.input.rightButton === false);
}
{
  // Only the buttons named by the event change: other buttons (middle = 1) are ignored.
  const s = new InputState();
  s.pressButton(1);
  s.releaseButton(1);
  s.afterUpdate();
  check("input: middle button is ignored", s.input.leftButton === false && s.input.rightButton === false);
}
{
  // Blur releases both buttons at once and any held key gets its release entry, in press order.
  const s = new InputState();
  s.pressButton(0);
  s.pressButton(2);
  s.keyDown("a");
  s.keyDown("F2");
  s.blur();
  check("input: blur releases both buttons", s.input.leftButton === false && s.input.rightButton === false);
  check("input: blur pushes release entries for held keys in press order",
    JSON.stringify(s.input.keys) === JSON.stringify(["a", "F2", "keyup:a", "keyup:F2"]),
    JSON.stringify(s.input.keys));
  check("input: blur clears the held set", s.heldKeys().length === 0);
}
{
  // Keys released before blur are not released again.
  const s = new InputState();
  s.keyDown("x");
  s.keyUp("x");
  s.blur();
  check("input: no second release for a key already up", JSON.stringify(s.input.keys) === JSON.stringify(["x", "keyup:x"]), JSON.stringify(s.input.keys));
}
{
  // Key order: presses and releases share one batch in the order they happened.
  const s = new InputState();
  s.keyDown("1");
  s.keyDown("Enter");
  s.keyUp("1");
  s.keyDown("b");
  s.keyUp("Enter");
  check("input: key batch keeps event order",
    JSON.stringify(s.input.keys) === JSON.stringify(["1", "Enter", "keyup:1", "b", "keyup:Enter"]),
    JSON.stringify(s.input.keys));
}
{
  // A keypad token is pushed as the token, but the release matches the KeyboardEvent.key.
  const s = new InputState();
  s.keyDown("5", "keypad:5");
  s.keyUp("5");
  check("input: keypad token pushed, release uses key name",
    JSON.stringify(s.input.keys) === JSON.stringify(["keypad:5", "keyup:5"]), JSON.stringify(s.input.keys));
  check("input: keypad key leaves nothing held", s.heldKeys().length === 0);
}
{
  const s = new InputState();
  s.setPointer(12, 34);
  check("input: setPointer updates the input object", s.input.pointerX === 12 && s.input.pointerY === 34);
}

// Pointer mapping
const rect = { left: 10, top: 20, width: 640, height: 400 };
{
  check("pointer: canvas size is 320x200", SCREEN_WIDTH === 320 && SCREEN_HEIGHT === 200);
  const tl = mapClientToScreen(10, 20, rect);
  check("pointer: top-left corner maps to 0,0", tl.x === 0 && tl.y === 0, JSON.stringify(tl));
  const br = mapClientToScreen(650, 420, rect);
  check("pointer: bottom-right corner maps to 319,199", br.x === 319 && br.y === 199, JSON.stringify(br));
  const mid = mapClientToScreen(330, 220, rect);
  check("pointer: centre maps to 160,100", mid.x === 160 && mid.y === 100, JSON.stringify(mid));
  // 1 css px in x is 0.5 screen px (floors to 0); 3 css px in y is 1.5 screen px (floors to 1).
  const scaled = mapClientToScreen(11, 23, rect);
  check("pointer: floors fractional screen pixels", scaled.x === 0 && scaled.y === 1, JSON.stringify(scaled));
}
{
  const left = mapClientToScreen(-500, 5000, rect);
  check("pointer: outside left/bottom clamps to edge", left.x === 0 && left.y === 199, JSON.stringify(left));
  const right = mapClientToScreen(99999, -99999, rect);
  check("pointer: outside right/top clamps to edge", right.x === 319 && right.y === 0, JSON.stringify(right));
}
{
  const zero = { left: 0, top: 0, width: 0, height: 0 };
  const z = mapClientToScreen(50, 50, zero);
  check("pointer: zero-size rect maps to 0,0", z.x === 0 && z.y === 0, JSON.stringify(z));
  const zw = mapClientToScreen(50, 50, { left: 0, top: 0, width: 0, height: 100 });
  check("pointer: zero-width rect maps to 0,0", zw.x === 0 && zw.y === 0, JSON.stringify(zw));
  const nan = mapClientToScreen(Number.NaN, 50, rect);
  check("pointer: NaN client coordinate maps to 0,0", nan.x === 0 && nan.y === 0, JSON.stringify(nan));
}

if (failed > 0) {
  console.log(`\n${failed} browser-shell check(s) failed`);
  process.exit(1);
}
console.log("\nall browser-shell checks passed");
