import assert from "node:assert/strict";
import { test } from "node:test";
import type { PetAlert, UrlRecord } from "@ladybug/shared";
import { isAnalysisRunning, pendingAnalysis } from "./analyzer.ts";
import { checkVisit, lookupVisit } from "./checker.ts";
import { demoDelayMs, markDemoRevealed, resetDemoReveal, withDemoState, withoutDemo } from "./demo.ts";
import { petChannel } from "./sse.ts";
import { buildRecord } from "./store.ts";
import { typesense } from "./typesense.ts";

const record = (fields: Partial<UrlRecord> = {}): UrlRecord =>
  buildRecord({
    scope: "url",
    url: "https://demo.example/login",
    host: "demo.example",
    verdict: "unsafe",
    reason: "Sandbox scan: malicious, score 91/100",
    source: "analysis",
    checkedAt: 0,
    demoDelaySeconds: 10,
    demoHoldSeconds: 120,
    ...fields,
  });

test("a staged record acts unknown until revealed, then holds before staging again", () => {
  const demo = record();
  resetDemoReveal(demo.id);
  assert.equal(demoDelayMs(demo, 1_000), 10_000);
  markDemoRevealed(demo, 1_000);
  assert.equal(demoDelayMs(demo, 1_000 + 119_000), null, "known unsafe during the hold");
  assert.equal(withDemoState(demo, 1_000 + 119_000).demoRevealedUntil, 121_000);
  assert.equal(demoDelayMs(demo, 1_000 + 120_000), 10_000, "staged again after the hold");
  assert.equal(withDemoState(demo, 1_000 + 120_000).demoRevealedUntil, undefined);
});

test("only unsafe records with a delay are staged, and holds have a floor", () => {
  assert.equal(demoDelayMs(record({ verdict: "safe" })), null);
  assert.equal(demoDelayMs(withoutDemo(record())), null);
  const short = record({ url: "https://short-hold.example/", demoHoldSeconds: 0 });
  markDemoRevealed(short, 0);
  assert.equal(demoDelayMs(short, 9_999), null, "held long enough for the extension's next poll");
  assert.equal(demoDelayMs(short, 10_000), 10_000);
});

test("a visit to a staged record pretends to analyse it, then alerts unsafe without saving", async (t) => {
  const demo = record({ demoDelaySeconds: 1 });
  resetDemoReveal(demo.id);
  t.mock.method(typesense, "search", async (_collection: string, options: { filter_by: string }) => ({
    hits: options.filter_by.includes(demo.id) ? [{ document: demo }] : [],
  }));
  const upsert = t.mock.method(typesense, "upsert", async () => ({}));
  const alerts: PetAlert[] = [];
  t.mock.method(petChannel, "send", (_event: string, alert: PetAlert) => void alerts.push(alert));

  const started = Date.now();
  const response = await checkVisit({ url: demo.url }, "admin", "everyone");
  assert.equal(response.status, "pending");
  assert.ok(response.status === "pending" && response.etaMs > 900 && response.etaMs <= 1_000);
  assert.equal(pendingAnalysis(demo.url)?.scanId, undefined, "no sandbox scan behind it");
  assert.equal((await lookupVisit(demo.url)).status, "pending", "the extension's poll doesn't spoil it");
  assert.equal(alerts.at(-1)?.level, "info");

  while (isAnalysisRunning(demo.url)) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(Date.now() - started >= 1_000);
  assert.equal(alerts.at(-1)?.level, "danger");
  assert.match(alerts.at(-1)!.message, /demo\.example looks unsafe\. Sandbox scan: malicious/);
  assert.equal(upsert.mock.callCount(), 0, "the stored record is left alone");

  const after = await lookupVisit(demo.url);
  assert.equal(after.status, "known");
  assert.equal(after.status === "known" && after.verdict, "unsafe");
  const again = await checkVisit({ url: demo.url }, "admin", "everyone");
  assert.equal(again.status, "known", "revisits during the hold are flagged right away");
  resetDemoReveal(demo.id);
});
