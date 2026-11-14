import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { readMessagingConfig, sendMessage, SendError, verifySignature } from "./chert.ts";

const config = { key: "messaging-secret", line: "line", secret: "webhook-secret", destination: "+15551234567", tenant: "tenant" };

test("messaging shares the FaceTime key and line and requires its own webhook secret and a fixed destination", () => {
  assert.equal(readMessagingConfig({}), null);
  assert.equal(readMessagingConfig({ CHERT_API_KEY: "facetime-key" }), null);
  const env = { CHERT_API_KEY: "shared-key", CHERT_LINE_ID: "shared-line", CHERT_WEBHOOK_SECRET: "secret", EMERGENCY_NUMBER: "+15551234567" };
  assert.equal(readMessagingConfig(env)?.key, "shared-key");
  assert.equal(readMessagingConfig(env)?.line, "shared-line");
  assert.equal(readMessagingConfig({ ...env, CHERT_WEBHOOK_SECRET: "" }), null);
  assert.throws(() => readMessagingConfig({ ...env, EMERGENCY_NUMBER: "5551234567" }));
});

test("modern and legacy signatures cover raw bytes and expire after five minutes", () => {
  const raw = Buffer.from('{ "text": "SUPPORT" }'), now = Date.now(), ts = Math.floor(now / 1000);
  const signature = createHmac("sha256", config.secret).update(`${ts}.`).update(raw).digest("hex");
  for (const header of [`t=${ts},v1=${signature}`, `v1,${ts},${signature}`]) {
    assert.equal(verifySignature(raw, header, config.secret, now), true);
    assert.equal(verifySignature(Buffer.from('{"text":"SUPPORT"}'), header, config.secret, now), false);
    assert.equal(verifySignature(raw, header, "wrong", now), false);
    assert.equal(verifySignature(raw, header, config.secret, now + 301_000), false);
    assert.equal(verifySignature(raw, header, config.secret, now - 301_000), false);
  }
  assert.equal(verifySignature(raw, `t=${ts},v1=aa`, config.secret, now), false);
});

test("send uses documented messaging fields, fixed contact and server-side bearer credentials", async () => {
  const chat = await sendMessage(config, "stable-key", "https://bad.example/", async (url, init) => {
    assert.equal(String(url), "https://console.trychert.com/api/v1/send");
    assert.deepEqual(init?.headers, { Authorization: "Bearer messaging-secret", "Content-Type": "application/json", "x-chert-tenant": "tenant" });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      phone: config.destination, phone_line_id: "line", idempotency_key: "stable-key",
      body: "The user is accessing a website that might not be trustworthy: https://bad.example/. If you would like to initiate a FaceTime call for support, reply SUPPORT.",
    });
    return Response.json({ status: "sent", chat_id: "chat" });
  });
  assert.equal(chat, "chat");
});

test("only confirmed sends open windows; transient and permanent failures are distinguished", async () => {
  for (const [status, body, transient] of [
    [429, {}, true], [503, {}, true], [400, { status: "failed", retryable: true }, true],
    [400, { status: "failed" }, false], [202, { status: "queued", chat_id: "chat" }, false],
    [200, { status: "duplicate", chat_id: "chat" }, false], [200, { status: "sent" }, false],
  ] as const) {
    await assert.rejects(sendMessage(config, "key", "https://bad.example", async () => Response.json(body, { status })), (error) => error instanceof SendError && error.transient === transient);
  }
  await assert.rejects(sendMessage(config, "key", "https://bad.example", async () => { throw new Error("lost response"); }), (error) => error instanceof SendError && error.transient);
});
