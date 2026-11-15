import assert from "node:assert/strict";
import { test } from "node:test";
import { EYES_ARM_MS, EyesCapturePolicy, screenAccess } from "./eyes-capture-policy.ts";

test("the eyes see the screen with Screen Recording on macOS, anywhere else but Wayland, and never from the development window", () => {
  const base = { platform: "darwin", windowed: false, wayland: false, status: "granted" };
  assert.equal(screenAccess(base), "allowed");
  for (const status of ["not-determined", "denied", "restricted", "unknown"]) {
    assert.equal(screenAccess({ ...base, status }), "not-allowed");
  }
  assert.equal(screenAccess({ ...base, windowed: true }), "unavailable");
  assert.equal(screenAccess({ ...base, platform: "win32", status: "granted" }), "allowed");
  assert.equal(screenAccess({ ...base, platform: "linux" }), "allowed");
  assert.equal(screenAccess({ ...base, platform: "linux", wayland: true }), "unavailable");
});

test("one video stream from the trusted page, only after a source was handed out while Fly Eyes is on", () => {
  let on = true;
  let time = 0;
  const policy = new EyesCapturePolicy(() => on, () => time);
  // Nothing before a source is handed out.
  assert.equal(policy.allows(true, "media"), false);
  assert.equal(policy.claim(true, "media", ["video"]), false);

  policy.arm();
  assert.equal(policy.allows(true, "media"), true);
  assert.equal(policy.allows(false, "media"), false, "not from another frame");
  assert.equal(policy.allows(true, "display-capture"), false);
  assert.equal(policy.allows(true, "geolocation"), false);
  assert.equal(policy.claim(true, "media", ["audio"]), false, "no microphone");
  assert.equal(policy.claim(true, "media", ["video", "audio"]), false);
  assert.equal(policy.claim(true, "media", undefined), false);
  assert.equal(policy.claim(false, "media", ["video"]), false);
  assert.equal(policy.claim(true, "media", ["video"]), true);
  assert.equal(policy.claim(true, "media", ["video"]), false, "only one");

  // A source goes stale.
  policy.arm();
  time += EYES_ARM_MS + 1;
  assert.equal(policy.allows(true, "media"), false);
  assert.equal(policy.claim(true, "media", ["video"]), false);

  // Turning Fly Eyes off takes it back, and it can't be armed while off.
  policy.arm();
  on = false;
  assert.equal(policy.claim(true, "media", ["video"]), false);
  assert.throws(() => policy.arm(), /off/);
  on = true;
  policy.arm();
  policy.disarm();
  assert.equal(policy.claim(true, "media", ["video"]), false);
});
