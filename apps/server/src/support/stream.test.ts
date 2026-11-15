import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Request, Response } from "express";
import { SupportStream } from "./stream.ts";
import type { SupportCommand } from "./service.ts";

for (const broadcast of ["browser-kill", "device-shutdown"] as const) test(`SUPPORT selects the newest account desktop; ${broadcast} broadcasts only to eligible account desktops`, () => {
  let now = 100;
  const stream = new SupportStream(() => now);
  const clients: { req: EventEmitter; events: string[] }[] = [];
  const connect = (accountId: string) => {
    const req = new EventEmitter(), events: string[] = [];
    const res = {
      destroyed: false, writableEnded: false,
      writeHead: () => {}, write: (data: string) => { if (data.startsWith("event:")) events.push(data); },
      end: () => { res.writableEnded = true; req.emit("close"); },
    };
    stream.attach(req as Request, res as unknown as Response, accountId);
    clients.push({ req, events });
    return { events, disconnect: () => req.emit("close") };
  };
  const command = (kind: SupportCommand["kind"], overrides: Partial<SupportCommand> = {}): SupportCommand => ({
    id: "request", accountId: "a", kind, sentAt: now, expiresAt: 1000, ...overrides,
  });
  try {
    assert.equal(stream.deliver(command("support")), false);
    const old = connect("a"), newest = connect("a"), other = connect("b");
    assert.equal(stream.deliver(command("support")), true);
    assert.equal(old.events.length, 0); assert.equal(other.events.length, 0);
    assert.match(newest.events[0], /event: support/);
    assert.equal(stream.deliver(command(broadcast)), true);
    assert.equal(old.events.length, 1); assert.equal(newest.events.length, 2);
    assert.equal(other.events.length, 0);
    assert.ok(old.events[0].includes(`event: ${broadcast}\ndata: {"id":"request","expiresAt":1000}`));
    newest.disconnect();
    assert.equal(stream.deliver(command("support")), true); assert.equal(old.events.length, 2);
    assert.equal(stream.deliver(command(broadcast, { expiresAt: 99 })), false);
    stream.close("a");
    assert.equal(stream.deliver(command(broadcast)), false);
    now = 200;
    const reconnected = connect("a");
    assert.equal(stream.deliver(command(broadcast, { sentAt: 100 })), false);
    assert.equal(reconnected.events.length, 0);
    assert.equal(stream.deliver(command(broadcast)), true);
    stream.close();
    assert.equal(stream.deliver(command(broadcast, { accountId: "b" })), false);
  } finally { stream.close(); for (const client of clients) client.req.emit("close"); }
});
