import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLookalike } from "./lookalike.ts";

test("real brand domains are fine", () => {
  for (const host of ["www.paypal.com", "login.microsoftonline.com", "accounts.google.com", "example.com", "github.com"]) {
    assert.equal(checkLookalike(host), null, host);
  }
});

test("brand in a foreign domain", () => {
  assert.match(checkLookalike("paypal.com.secure-login.xyz") ?? "", /paypal/);
  assert.match(checkLookalike("secure-paypal-verify.top") ?? "", /paypal/);
  assert.match(checkLookalike("microsoft-365-login.net") ?? "", /microsoft/);
});

test("typos and homoglyphs", () => {
  assert.match(checkLookalike("paypa1.com") ?? "", /paypal/);
  assert.match(checkLookalike("arnazon.com") ?? "", /amazon/);
  assert.match(checkLookalike("netfllx-billing.com") ?? "", /netflix/);
});

test("punycode with mixed scripts", () => {
  // "аpple.com" with a Cyrillic а.
  const note = checkLookalike("xn--pple-43d.com") ?? "";
  assert.match(note, /punycode/);
  assert.match(note, /apple/);
});
