import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCallAuth } from "./call-config.ts";

test("calls use the signed-in session; remote plaintext and malformed sessions are rejected", () => {
  assert.deepEqual(parseCallAuth({ url: "http://localhost:3001/", token: " session " }), { url: "http://localhost:3001", token: "session" });
  assert.deepEqual(parseCallAuth({ url: "https://ladybugg.garden", token: "session" }), { url: "https://ladybugg.garden", token: "session" });
  assert.equal(parseCallAuth(null), null);
  assert.throws(() => parseCallAuth({ url: "http://remote.example", token: "session" }), /HTTPS/);
  assert.throws(() => parseCallAuth({ url: "https://user:pass@ladybugg.garden", token: "session" }), /HTTPS/);
  assert.throws(() => parseCallAuth({ url: "https://ladybugg.garden", token: " " }), /session/);
  assert.throws(() => parseCallAuth({ url: "https://ladybugg.garden", token: "x".repeat(513) }), /session/);
  assert.throws(() => parseCallAuth({ url: "not a url", token: "session" }), /URL/);
  assert.throws(() => parseCallAuth(undefined), /session/);
});
