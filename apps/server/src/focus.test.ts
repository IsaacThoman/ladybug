import assert from "node:assert/strict";
import { test } from "node:test";
import type { PetFocus } from "@ladybug/shared";
import { FocusTracker } from "./focus.ts";

function tracker() {
  const pending = new Set<string>();
  const sent: [string, PetFocus][] = [];
  const focus = new FocusTracker(
    (url) => pending.has(url),
    (userId, value) => sent.push([userId, value]),
  );
  return { focus, pending, sent };
}

test("the pet hears when the active tab's page is being checked", () => {
  const { focus, pending, sent } = tracker();
  pending.add("https://new-site.example/");
  focus.set("ana", "https://NEW-SITE.example/#top");
  assert.deepEqual(sent, [["ana", { url: "https://new-site.example/", investigating: true }]]);
});

test("an analysis starting or ending for the open page updates its pets", () => {
  const { focus, pending, sent } = tracker();
  focus.set("ana", "https://new-site.example/");
  pending.add("https://new-site.example/");
  focus.pendingChanged("https://new-site.example/");
  pending.delete("https://new-site.example/");
  focus.pendingChanged("https://new-site.example/");
  assert.deepEqual(
    sent.map(([, value]) => value.investigating),
    [false, true, false],
  );
});

test("other users and other pages aren't disturbed", () => {
  const { focus, pending, sent } = tracker();
  focus.set("ana", "https://a.example/");
  focus.set("ben", "https://b.example/");
  sent.length = 0;
  pending.add("https://a.example/");
  focus.pendingChanged("https://a.example/");
  assert.deepEqual(sent, [["ana", { url: "https://a.example/", investigating: true }]]);
});

test("switching away, or to a page that isn't checked, stops the investigation", () => {
  const { focus, pending, sent } = tracker();
  pending.add("https://a.example/");
  focus.set("ana", "https://a.example/");
  focus.set("ana", "http://localhost:3000/");
  assert.deepEqual(sent.at(-1), ["ana", { url: null, investigating: false }]);
  focus.set("ana", "https://a.example/");
  focus.set("ana", null);
  assert.deepEqual(sent.at(-1), ["ana", { url: null, investigating: false }]);
});

test("repeats aren't sent twice", () => {
  const { focus, sent } = tracker();
  focus.set("ana", "https://a.example/");
  focus.set("ana", "https://a.example/");
  focus.pendingChanged("https://a.example/");
  assert.equal(sent.length, 1);
});
