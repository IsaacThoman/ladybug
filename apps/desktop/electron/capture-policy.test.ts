import assert from "node:assert/strict";
import { test } from "node:test";
import { CapturePolicy, selectScreen } from "./capture-policy.ts";
import type { CallState } from "@ladybug/shared";

test("screen selection prefers primary, falls back to first (including portal), and rejects no selection", () => {
  const sources = [{ id: "first", display_id: "2" }, { id: "primary", display_id: "1" }];
  assert.equal(selectScreen(sources, "1").id, "primary");
  assert.equal(selectScreen(sources, "unknown").id, "first");
  assert.equal(selectScreen([{ id: "portal", display_id: "" }], "1").id, "portal");
  assert.throws(() => selectScreen([], "1"), /No screen/);
});

test("source and both media permissions require trusted main frame and selected ready call", async () => {
  let state: CallState = { id: "call", phase: "ready", message: "", bridgeReady: false };
  const policy = new CapturePolicy(() => state);
  let enumerated = false;
  const enumerate = async () => { enumerated = true; return "screen"; };
  await assert.rejects(policy.source(() => false, "call", enumerate));
  await assert.rejects(policy.source(() => true, "old", enumerate));
  assert.equal(enumerated, false);
  assert.equal(policy.allows(true, "media"), false);
  await policy.source(() => true, "call", enumerate);
  assert.equal(policy.allows(true, "media"), true);
  assert.equal(policy.allows(true, "display-capture"), true);
  assert.equal(policy.allows(false, "display-capture"), false);
  assert.equal(policy.allows(true, "geolocation"), false);
  state = { ...state, phase: "active" };
  assert.equal(policy.allows(true, "media"), false);
  state = { ...state, id: "next", phase: "ready" };
  assert.equal(policy.allows(true, "display-capture"), false);
});

test("portal completion rechecks cancellation, call identity, and frame trust", async () => {
  for (const change of ["cancel", "replace", "frame"]) {
    let state: CallState = { id: "call", phase: "ready", message: "", bridgeReady: false };
    let trusted = true;
    const policy = new CapturePolicy(() => state);
    const result = policy.source(() => trusted, "call", async () => {
      if (change === "cancel") state = { ...state, phase: "ending" };
      if (change === "replace") state = { ...state, id: "next" };
      if (change === "frame") trusted = false;
      return "late-screen";
    });
    await assert.rejects(result, /canceled/);
    assert.equal(policy.allows(true, "display-capture"), false);
  }
});
