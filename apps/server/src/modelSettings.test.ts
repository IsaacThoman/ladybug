import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AdminModelSettings, LlmCatalog } from "@ladybug/shared";
import type { ModelSettingsStore } from "@ladybug/backend";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import type { ScanDeps } from "./scans.ts";

let catalog: LlmCatalog | null = null;
let selected: string | null = null;
const store: ModelSettingsStore = {
  catalog: async () => catalog,
  selected: async () => selected,
  select: async (model) => void (selected = model),
};

let server: Server;
let base = "";

before(async () => {
  config.adminPassword = null;
  const deps = { accounts: {}, modelSettings: store, authLimit: async () => true } as unknown as ScanDeps & {
    authLimit: () => Promise<boolean>;
    modelSettings: ModelSettingsStore;
  };
  server = createApp(deps).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  selected = null;
  catalog = { baseUrl: "https://api.example/v1", defaultModel: "gpt-a", models: ["gpt-a", "gpt-b"], fetchedAt: Date.now() };
});

const put = (model: unknown) =>
  fetch(`${base}/api/admin/settings/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });

test("shows the pick and what the worker offers", async () => {
  selected = "gpt-b";
  const res = await fetch(`${base}/api/admin/settings/model`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as AdminModelSettings;
  assert.equal(body.selected, "gpt-b");
  assert.deepEqual(body.catalog?.models, ["gpt-a", "gpt-b"]);
});

test("picks any offered model, and goes back to the default with null", async () => {
  const res = await put("gpt-b");
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as AdminModelSettings).selected, "gpt-b");
  assert.equal(selected, "gpt-b");

  const reset = await put(null);
  assert.equal(reset.status, 200);
  assert.equal(selected, null);
});

test("refuses models the endpoint doesn't offer", async () => {
  const res = await put("gpt-made-up");
  assert.equal(res.status, 400);
  assert.equal(selected, null);
  assert.equal((await put("")).status, 400);
  assert.equal((await put(42)).status, 400);
});

test("refuses a pick before any worker has reported", async () => {
  catalog = null;
  assert.equal((await put("gpt-a")).status, 409);
  assert.equal(selected, null);
});
