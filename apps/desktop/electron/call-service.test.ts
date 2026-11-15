import assert from "node:assert/strict";
import { test } from "node:test";
import { FaceTimeController } from "../src/calls/controller.ts";
import { CallService } from "./call-service.ts";
import type { CallState, FaceTimeApi } from "@ladybug/shared";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("a failed poll from a previous call cannot change or hang up the current call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const staleResponse = deferred<Response>();
  const requests: string[] = [];
  let prepares = 0;
  let polls = 0;
  const service = new CallService({
    auth: () => ({ url: "https://example.test", token: "test" }),
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/prepare")) {
        return Response.json({ id: ++prepares === 1 ? "old" : "new" });
      }
      if (path.endsWith("/state")) {
        if (++polls === 1) return staleResponse.promise;
        return Response.json({ id: polls === 2 ? "old" : "new", phase: polls === 2 ? "ended" : "active", message: "", bridgeReady: true });
      }
      return Response.json({});
    },
  });

  await service.prepare();
  const stalePoll = service.poll();
  await service.poll();
  await service.prepare();
  const currentState = service.getState();
  staleResponse.reject(new Error("Delayed network failure"));
  await stalePoll;
  assert.deepEqual(service.getState(), currentState);

  await service.poll();
  assert.equal(service.getState().id, "new");
  assert.equal(service.getState().phase, "active");
  assert.ok(!requests.some((path) => path.endsWith("/end")));
});
test("calls need a signed-in session, and keep the caller's session after the pet switches accounts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let auth: { url: string; token: string } | null = null;
  const tokens: string[] = [];
  const service = new CallService({
    auth: () => auth,
    fetch: async (input, init) => {
      tokens.push((init?.headers as Record<string, string>).Authorization);
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prepare")) return Response.json({ id: "call" });
      return Response.json({ id: "call", phase: "active", message: "", bridgeReady: true });
    },
  });
  await assert.rejects(service.prepare(), /Sign in/);
  assert.equal(service.getState().phase, "error");
  assert.equal(tokens.length, 0);

  auth = { url: "https://example.test", token: "alice" };
  await service.prepare();
  auth = { url: "https://example.test", token: "bob" };
  await service.poll();
  assert.deepEqual(tokens, ["Bearer alice", "Bearer alice"]);
});

test("losing access mid-call ends the call locally instead of retrying forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refused = false;
  const service = new CallService({
    auth: () => ({ url: "https://example.test", token: "session" }),
    fetch: async (input) => {
      if (refused) return Response.json({ error: "nope" }, { status: 401 });
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prepare")) return Response.json({ id: "call" });
      return Response.json({ id: "call", phase: "active", message: "", bridgeReady: true });
    },
  });
  await service.prepare(); await service.poll();
  assert.equal(service.getState().phase, "active");
  refused = true;
  await service.poll();
  assert.equal(service.getState().phase, "ended");
  assert.match(service.getState().message, /can no longer place calls/);
});

function controllerFixture() {
  let listener: (state: CallState) => void = () => {};
  const published = deferred<void>();
  const actions: string[] = [];
  const api: FaceTimeApi = {
    onSupportRequest: () => () => {},
    prepare: async () => { actions.push("prepare"); return { id: "session", url: "wss://example", token: "device-only", bridgeIdentity: "bridge" }; },
    dial: async () => { actions.push("dial"); }, end: async () => { actions.push("end"); },
    getState: async () => ({ phase: "idle", message: "", bridgeReady: false }),
    onState: (callback) => { listener = callback; return () => {}; },
  };
  const controller = new FaceTimeController(api, () => ({
    connect: async () => { actions.push("connect"); },
    publish: async () => { actions.push("publish"); await published.promise; },
    activate: () => { actions.push("activate"); }, stop: () => { actions.push("stop"); },
  }));
  const dispose = controller.observe();
  return { api, controller, actions, published, dispose, emit: (phase: CallState["phase"], bridgeReady = false) => listener({ id: "session", phase, message: "", bridgeReady }) };
}

test("device publishes before dialing, duplicate starts are ignored, bridge_ready activates audio", async () => {
  const f = controllerFixture();
  const start = f.controller.start(); await f.controller.start();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(f.actions, ["prepare", "connect", "publish"]);
  f.published.resolve(); await start;
  assert.deepEqual(f.actions, ["prepare", "connect", "publish", "dial"]);
  f.emit("active", true); assert.equal(f.actions.at(-1), "activate");
  f.emit("ended"); assert.equal(f.actions.at(-1), "stop");
  f.dispose();
});

test("cancellation while capture is pending stops media and suppresses dialing and late activation", async () => {
  const f = controllerFixture();
  const start = f.controller.start(); await new Promise((done) => setImmediate(done));
  await f.controller.end(); f.emit("active", true);
  f.published.resolve(); await start;
  assert.ok(f.actions.includes("stop")); assert.ok(f.actions.includes("end"));
  assert.ok(!f.actions.includes("dial")); assert.ok(!f.actions.includes("activate"));
  f.emit("ended"); f.dispose();
});

test("a signed-out request is visible and allows retry", async () => {
  const f = controllerFixture();
  f.published.promise.catch(() => {});
  f.api.prepare = async () => { throw new Error("Sign in to Ladybugg to request help."); };
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().phase, "error");
  assert.match(f.controller.getSnapshot().message, /Sign in/);
  f.dispose();
});

test("permission failure stops capture and requests cleanup", async () => {
  const f = controllerFixture();
  const starting = f.controller.start();
  await new Promise((done) => setImmediate(done));
  f.published.reject(new Error("Camera or microphone permission denied."));
  await starting;
  assert.ok(f.actions.includes("stop"));
  assert.ok(f.actions.includes("end"));
  assert.ok(!f.actions.includes("dial"));
  assert.match(f.controller.getSnapshot().message, /permission denied/);
  f.emit("ended"); f.dispose();
});
