import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { SupportSubscription } from "./support-stream.ts";

const turn = () => new Promise((resolve) => setImmediate(resolve));
test("main-process subscription keeps credentials private and decodes split events without replaying after stop", async () => {
  const received: string[] = [];
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const subscription = new SupportSubscription((id) => received.push(id), {
    config: () => ({ url: "https://ladybug.example", token: "private-desktop-token" }),
    fetch: async (url, init) => {
      assert.equal(url, "https://ladybug.example/api/calls/support/stream");
      assert.deepEqual(init?.headers, { Authorization: "Bearer private-desktop-token", Accept: "text/event-stream" });
      return new Response(new ReadableStream({ start(controller) { writer = controller; } }));
    },
  });
  subscription.start(); await turn();
  const id = randomUUID();
  writer.enqueue(encoder.encode(': ping\n\nevent: support\ndata: {"id":"' + id.slice(0, 12)));
  await turn(); assert.equal(received.length, 0);
  writer.enqueue(encoder.encode(id.slice(12) + '"}\n\nevent: other\ndata: {}\n\n'));
  await turn(); assert.deepEqual(received, [id]);
  subscription.stop(); writer.enqueue(encoder.encode(`event: support\ndata: {"id":"${randomUUID()}"}\n\n`));
  await turn(); assert.deepEqual(received, [id]);
});

test("unauthorized streams reconnect without emitting requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0, received = 0;
  const subscription = new SupportSubscription(() => received++, {
    config: () => ({ url: "https://ladybug.example", token: "private-token" }),
    fetch: async () => { attempts++; return new Response(null, { status: 401 }); },
  });
  subscription.start(); await turn();
  t.mock.timers.tick(3000); await turn();
  assert.equal(attempts, 2); assert.equal(received, 0);
  subscription.stop(); t.mock.timers.tick(3000); await turn(); assert.equal(attempts, 2);
});
