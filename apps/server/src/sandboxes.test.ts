import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxScanRow, StreamEntry } from "@ladybug/backend";
import { STALLED_AFTER_MS, sandboxTile } from "./sandboxes.ts";

const T0 = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const row = (over: Partial<SandboxScanRow> = {}): SandboxScanRow => ({
  scanId: "11111111-1111-4111-8111-111111111111",
  inputUrl: "https://example.com/",
  status: "investigating",
  startedBy: "ana",
  createdAt: iso(T0),
  updatedAt: iso(T0 + 1_000),
  error: null,
  report: null,
  ...over,
});

/** Entries newest first, `seconds` after T0. */
const entry = (seconds: number, event: StreamEntry["event"]): StreamEntry => ({ id: `${T0 + seconds * 1000}-0`, event });
const at = iso(T0);

test("a running scan shows its newest screenshot and what it's doing", () => {
  const tile = sandboxTile(
    row(),
    [
      entry(30, { type: "tool_call", tool: "browser_click", summary: "click: Sign in", at }),
      entry(20, { type: "screenshot", artifactKey: "scans/x/screenshots/02-agent.png", label: "agent", at }),
      entry(15, { type: "agent_note", text: "Looks like a login page.", at }),
      entry(10, { type: "redirect_chain", chain: ["https://example.com/", "https://login.example.net/"], at }),
      entry(5, { type: "screenshot", artifactKey: "scans/x/screenshots/01-t-0s.png", label: "t+0s", at }),
    ],
    T0 + 60_000,
  );
  assert.deepEqual(tile.screenshot, { artifactKey: "scans/x/screenshots/02-agent.png", label: "agent" });
  assert.equal(tile.screenshotCount, 2);
  assert.equal(tile.activity, "click: Sign in");
  assert.equal(tile.finalUrl, "https://login.example.net/");
  assert.equal(tile.lastActivityAt, iso(T0 + 30_000));
  assert.equal(tile.finishedAt, null);
  assert.equal(tile.stalled, false);
});

test("a running scan with no news for a long while is stalled", () => {
  const tile = sandboxTile(row(), [entry(1, { type: "status", status: "investigating", at })], T0 + STALLED_AFTER_MS + 5_000);
  assert.equal(tile.stalled, true);
});

test("a finished scan comes from its report", () => {
  const tile = sandboxTile(
    row({
      status: "done",
      updatedAt: iso(T0 + 90_000),
      report: {
        finalUrl: "https://example.com/",
        verdict: "malicious",
        score: 88,
        summary: "Credential phishing kit.",
        screenshots: [
          { artifactKey: "scans/x/a.png", label: "t+0s" },
          { artifactKey: "scans/x/b.png", label: "mobile" },
        ],
        finishedAt: iso(T0 + 89_000),
      },
    }),
    [],
    T0 + 10 * STALLED_AFTER_MS,
  );
  assert.deepEqual(tile.screenshot, { artifactKey: "scans/x/b.png", label: "mobile" });
  assert.equal(tile.screenshotCount, 2);
  assert.equal(tile.verdict, "malicious");
  assert.equal(tile.score, 88);
  assert.equal(tile.activity, "Credential phishing kit.");
  // Same as the input URL: nothing to add.
  assert.equal(tile.finalUrl, null);
  assert.equal(tile.finishedAt, iso(T0 + 89_000));
  assert.equal(tile.stalled, false);
});

test("a failed scan without a report keeps what its stream caught", () => {
  const tile = sandboxTile(
    row({ status: "failed", error: null, updatedAt: iso(T0 + 40_000) }),
    [
      entry(40, { type: "status", status: "failed", message: "sandbox didn't start", at }),
      entry(20, { type: "screenshot", artifactKey: "scans/x/a.png", label: "t+0s", at }),
    ],
  );
  assert.equal(tile.error, "sandbox didn't start");
  assert.equal(tile.screenshot?.artifactKey, "scans/x/a.png");
  assert.equal(tile.finishedAt, iso(T0 + 40_000));
});
