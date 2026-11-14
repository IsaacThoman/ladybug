import assert from "node:assert/strict";
import { test } from "node:test";
import { normaliseScanUrl } from "./validate.ts";

test("adds https:// to bare domains", () => {
  assert.deepEqual(normaliseScanUrl("example.com/login"), { url: "https://example.com/login" });
});

test("keeps http URLs", () => {
  assert.deepEqual(normaliseScanUrl(" http://example.com "), { url: "http://example.com/" });
});

test("rejects other schemes", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com"]) {
    assert.ok("error" in normaliseScanUrl(url), url);
  }
});

test("rejects internal targets", () => {
  for (const url of [
    "http://localhost:3001",
    "http://127.0.0.1",
    "http://10.1.2.3",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.0.1",
    "http://[::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://intranet",
    "http://db.internal",
  ]) {
    assert.ok("error" in normaliseScanUrl(url), url);
  }
});

test("allows public IP literals", () => {
  assert.deepEqual(normaliseScanUrl("http://93.184.215.14/"), { url: "http://93.184.215.14/" });
});

test("rejects junk", () => {
  assert.ok("error" in normaliseScanUrl(""));
  assert.ok("error" in normaliseScanUrl(42));
  assert.ok("error" in normaliseScanUrl(`https://example.com/${"a".repeat(3000)}`));
});
