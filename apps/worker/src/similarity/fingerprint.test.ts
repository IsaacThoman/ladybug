import assert from "node:assert/strict";
import { test } from "node:test";
import type { DomSnapshot } from "@ladybug/shared";
import { cosineSimilarity, pageFingerprint } from "./fingerprint.ts";

const page = (title: string, text: string, overrides: Partial<DomSnapshot> = {}): DomSnapshot => ({
  url: "https://example.net/",
  title,
  html: "",
  truncated: false,
  text,
  forms: [],
  scripts: [],
  iframes: [],
  metaRefresh: null,
  linkCount: 0,
  ...overrides,
});

const loginForm = {
  action: "next.php",
  resolvedAction: "https://example.net/next.php",
  method: "POST",
  inputs: [
    { name: "login", type: "email", placeholder: null, autocomplete: null },
    { name: "passwd", type: "password", placeholder: null, autocomplete: null },
  ],
  hasPasswordField: true,
};

const MICROSOFT_KIT =
  "Sign in to continue to Outlook. Email, phone, or Skype. No account? Create one! Can't access your account? Sign-in options. Your session has expired, please verify your identity to keep receiving email. Terms of use Privacy and cookies.";
const PAYPAL_KIT =
  "Log in to your PayPal account. We noticed unusual activity on your account and limited it until you confirm your billing information. Enter your card number, expiry date and security code to restore full access. Need help? Contact us.";
const BLOG =
  "Ten tips for growing tomatoes on a balcony. Start with a deep pot, rich compost and plenty of sun. Water in the morning, feed every two weeks once flowers appear, and pinch out side shoots so the plant puts its energy into fruit rather than leaves.";

const fp = (dom: DomSnapshot) => {
  const vector = pageFingerprint(dom);
  assert.ok(vector, "expected a fingerprint");
  return vector;
};

test("fingerprints are unit length and deterministic", () => {
  const a = fp(page("Sign in to your account", MICROSOFT_KIT));
  assert.equal(a.length, 512);
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-3);
  assert.deepEqual(a, fp(page("Sign in to your account", MICROSOFT_KIT)));
});

test("the same kit on another domain, lightly edited, is a near match", () => {
  const original = fp(page("Sign in to your account", MICROSOFT_KIT, { forms: [loginForm] }));
  const rehosted = fp(
    page("Sign in to your account", MICROSOFT_KIT.replace("Outlook", "OneDrive").replace("Skype", "Teams"), {
      url: "https://totally-different.top/",
      forms: [{ ...loginForm, resolvedAction: "https://totally-different.top/next.php" }],
    }),
  );
  assert.ok(cosineSimilarity(original, rehosted) > 0.85, `got ${cosineSimilarity(original, rehosted)}`);
});

test("different pages are far apart, even two login pages", () => {
  const microsoft = fp(page("Sign in to your account", MICROSOFT_KIT, { forms: [loginForm] }));
  const paypal = fp(page("Log in to your PayPal account", PAYPAL_KIT, { forms: [loginForm] }));
  const blog = fp(page("Balcony tomatoes", BLOG));
  assert.ok(cosineSimilarity(microsoft, paypal) < 0.5, `got ${cosineSimilarity(microsoft, paypal)}`);
  assert.ok(cosineSimilarity(microsoft, blog) < 0.3, `got ${cosineSimilarity(microsoft, blog)}`);
});

test("pages with too little text get no fingerprint", () => {
  assert.equal(pageFingerprint(page("Loading", "Please wait")), null);
  assert.equal(pageFingerprint(null), null);
});
