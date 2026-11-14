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

test("an unsafe scan that matches a flagged page says so", () => {
  const similar = [
    {
      scanId: "11111111-1111-4111-8111-111111111111",
      url: "https://old-phish.example/login",
      title: null,
      verdict: "malicious" as const,
      score: 88,
      similarity: 0.926,
      scannedAt: "2026-11-01T10:00:00.000Z",
    },
  ];
  const { reason } = verdictFromReport({ ...report("malicious", 91), similar });
  assert.match(reason, /score 91\/100\. It's a 93% match for a page I flagged on old-phish\.example\. A login page/);
  assert.doesNotMatch(verdictFromReport({ ...report("benign", 5), similar }).reason, /match/);
});
