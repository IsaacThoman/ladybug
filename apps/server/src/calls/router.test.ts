import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import type { ParticipantInfo, Room } from "livekit-server-sdk";
import type { CallState, PreparedCall } from "@ladybug/shared";
import { CallService } from "./call-service.ts";
import { createCallRouter } from "./router.ts";
import { CallService as DesktopCalls } from "../../../desktop/electron/call-service.ts";

const provider = {
  url: "wss://example.livekit.cloud", key: "provider-key", secret: "provider-secret-at-least-thirty-two-characters",
  chertKey: "private-chert", project: "private-project", line: "private-line", destination: "+15551234567",
};
async function fixture(keys = ["desktop-one", "desktop-two"]) {
  let roomCount = 0, status = "active", now = 0;
  const requests: { url: string; body?: string }[] = [];
  const calls = new CallService({
    config: () => provider,
    rooms: () => ({
      createRoom: async () => { roomCount++; return {} as Room; }, deleteRoom: async () => {},
      listParticipants: async (room) => [{ identity: `device-${room.slice("ladybug-".length)}`, tracks: [{ type: 0, muted: false }, { type: 1, muted: false }] }] as ParticipantInfo[],
    }),
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body as string | undefined });
      const data = String(url).endsWith("/events") ? [{ event_type: "bridge_ready" }] : init?.method === "POST" ? { id: "chert-call" } : { status };
      return new Response(JSON.stringify({ data }));
    },
  });
  const router = createCallRouter({ service: calls, keys, now: () => now, leaseMs: 30_000 });
  const app = express(); app.use(express.json()); app.use("/api/calls", router);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const api = (path: string, body?: unknown, token = "desktop-one") => fetch(url + "/api/calls" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { url, api, calls, router, requests, roomCount: () => roomCount, advance: () => { now += 31_000; }, finish: () => { status = "ended"; },
    close: async () => {
      status = "ended";
      await calls.endCurrent(); await calls.poll(); await router.shutdown();
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("call routes fail closed without a dedicated client key", async () => {
  const f = await fixture([]);
  try { assert.equal((await f.api("/state")).status, 503); assert.equal(f.roomCount(), 0); }
  finally { await f.close(); }
});

test("authenticated prepare is idempotent, isolated per client, and returns only a short-lived room token", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.api("/prepare", { requestId: randomUUID() }, "wrong")).status, 401);
    const requestId = randomUUID();
    const replies = await Promise.all([f.api("/prepare", { requestId }), f.api("/prepare", { requestId })]);
    const [a, b] = await Promise.all(replies.map(async (r) => await r.json() as PreparedCall));
    assert.equal(a.id, b.id); assert.equal(f.roomCount(), 1);
    for (const secret of [provider.secret, provider.chertKey, provider.project, provider.line, provider.destination]) assert.ok(!JSON.stringify(a).includes(secret));
    const claims = JSON.parse(Buffer.from(a.token.split(".")[1], "base64url").toString());
    assert.ok(claims.exp - claims.nbf <= 300);
    assert.equal(claims.video.roomAdmin, undefined);
    assert.equal((await f.api("/prepare", { requestId: randomUUID() }, "desktop-two")).status, 409);
    assert.equal((await (await f.api("/state", undefined, "desktop-two")).json() as CallState).id, undefined);
    assert.equal((await f.api(`/${a.id}/end`, {}, "desktop-two")).status, 404);
    assert.equal((await f.api(`/${a.id}/dial`, { destination: "+15559999999" })).status, 200);
    assert.equal(JSON.parse(f.requests.find((r) => r.url.endsWith("/calls"))!.body!).destination, provider.destination);
    f.advance(); await f.router.checkLease();
    assert.equal(f.calls.getState().phase, "ending");
    await f.calls.poll();
    assert.ok(f.requests.some((r) => r.url.endsWith("/end")), "expired clients cannot leave an unattended outbound call");
  } finally { await f.close(); }
});

test("desktop proxy controls a server call without provider credentials and stops on connection loss", async () => {
  const f = await fixture();
  let offline = false;
  const desktop = new DesktopCalls({
    config: () => ({ url: f.url, token: "desktop-one" }),
    fetch: async (...args) => { if (offline) throw new Error("network down"); return fetch(...args); },
  });
  try {
    const prepared = await desktop.prepare();
    await desktop.dial(prepared.id); await f.calls.poll(); await desktop.poll();
    assert.equal(desktop.getState().phase, "active");
    assert.equal(desktop.getState().bridgeReady, true);
    offline = true; await desktop.poll();
    assert.equal(desktop.getState().phase, "ending");
    assert.equal(desktop.getState().bridgeReady, false);
    offline = false; await desktop.poll();
    f.finish(); await f.calls.poll(); await desktop.poll();
    assert.equal(desktop.getState().phase, "ended");
    assert.ok(f.requests.some((r) => r.url.endsWith("/end")));
  } finally { f.finish(); await f.calls.poll(); await desktop.poll(); await f.close(); }
});
