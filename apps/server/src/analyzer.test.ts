import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScanReport } from "@ladybug/shared";
import { placeholderVerdict, verdictFromReport } from "./analyzer.ts";

const report = (verdict: ScanReport["verdict"], score: number) =>
  ({ verdict, score, summary: "A login page on a two-day-old domain." }) as ScanReport;

test("benign scans are safe", () => {
  assert.equal(verdictFromReport(report("benign", 4)).verdict, "safe");
});

test("suspicious and malicious scans are unsafe", () => {
  assert.equal(verdictFromReport(report("suspicious", 45)).verdict, "unsafe");
  const malicious = verdictFromReport(report("malicious", 91));
  assert.equal(malicious.verdict, "unsafe");
  assert.match(malicious.reason, /malicious, score 91\/100\. A login page/);
});

test("the placeholder still flags obvious cases", () => {
  assert.equal(placeholderVerdict("http://1.2.3.4/", "1.2.3.4").verdict, "unsafe");
  assert.equal(placeholderVerdict("https://example.com/", "example.com").verdict, "safe");
});
