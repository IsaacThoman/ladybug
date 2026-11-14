import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDesktopCallConfig, loadCallEnv } from "./call-config.ts";

test("desktop needs only its own server credential; remote plaintext is rejected", () => {
  assert.deepEqual(readDesktopCallConfig({ CALL_SERVER_URL: "http://localhost:3001", CALL_SERVER_TOKEN: "device-token" }), { url: "http://localhost:3001", token: "device-token" });
  assert.throws(() => readDesktopCallConfig({ CALL_SERVER_URL: "http://remote.example", CALL_SERVER_TOKEN: "token" }), /HTTPS/);
  assert.throws(() => readDesktopCallConfig({}), /CALL_SERVER_TOKEN/);
});

test("desktop runtime env never overrides explicitly supplied settings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ladybug-call-env-"));
  try {
    const file = path.join(dir, ".env"); writeFileSync(file, 'CALL_SERVER_TOKEN=file-token\nCALL_SERVER_URL=http://localhost:3001\n');
    const env: Record<string, string | undefined> = { CALL_SERVER_TOKEN: "shell-token" };
    loadCallEnv(file, env);
    assert.equal(env.CALL_SERVER_TOKEN, "shell-token");
    assert.equal(env.CALL_SERVER_URL, "http://localhost:3001");
  } finally { rmSync(dir, { recursive: true }); }
});
