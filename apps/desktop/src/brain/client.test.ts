import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainRequest, BrainResponse, BrainSenses } from "@ladybug/brain";
import { BrainClient, LOAD_TIMEOUT_MS, MAX_TICK_MS, STALL_MS } from "./client.ts";
import type { BrainWorkerFactory } from "./client.ts";
import { RESTING, stateWith } from "./test-helpers.ts";

type FakeWorker = {
  posted: { request: BrainRequest; transfer?: Transferable[] }[];
  terminated: boolean;
  reply: (response: BrainResponse) => void;
  crash: (message: string) => void;
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ data = new ArrayBuffer(8) as ArrayBuffer | Uint8Array | null, failLoad = false, failCreate = false } = {}) {
  let time = 1000;
  const workers: FakeWorker[] = [];
  let loads = 0;
  const createWorker: BrainWorkerFactory = (onMessage, onError) => {
    if (failCreate) throw new Error("Workers aren't supported.");
    const worker: FakeWorker = { posted: [], terminated: false, reply: onMessage, crash: onError };
    workers.push(worker);
    return { post: (request, transfer) => worker.posted.push({ request, transfer }), terminate: () => { worker.terminated = true; } };
  };
  const client = new BrainClient({
    createWorker,
    loadData: async () => { loads++; if (failLoad) throw new Error("no"); return data; },
    now: () => time,
  });
  return {
    client,
    workers,
    loads: () => loads,
    advance: (ms: number) => { time += ms; },
    ticks: (worker: FakeWorker) => worker.posted.filter((p) => p.request.type === "tick").map((p) => p.request as Extract<BrainRequest, { type: "tick" }>),
  };
}

async function running(options?: Parameters<typeof setup>[0]) {
  const env = setup(options);
  env.client.start();
  await flush();
  const worker = env.workers[0];
  worker.reply({ type: "ready", neurons: 166_700, connections: 50, eyes: null });
  return { ...env, worker };
}

const senses = (touch: number): BrainSenses => ({ ...RESTING, touch });

test("starting loads the connectome and hands it to the worker without copying", async () => {
  const data = new ArrayBuffer(8);
  const { client, workers, loads } = setup({ data });
  assert.equal(client.status, "off");
  client.start();
  client.start();
  assert.equal(client.status, "loading");
  await flush();
  assert.equal(loads(), 1);
  assert.equal(workers.length, 1);
  const [init] = workers[0].posted;
  assert.equal(init.request.type, "init");
  assert.equal((init.request as { data: ArrayBuffer }).data, data);
  assert.deepEqual(init.transfer, [data]);

  workers[0].reply({ type: "ready", neurons: 166_700, connections: 50, eyes: null });
  assert.equal(client.status, "running");
  assert.equal(client.neurons, 166_700);
  assert.equal(client.connections, 50);
});

test("bytes that are a view into a larger buffer are copied out before transfer", async () => {
  const backing = new Uint8Array([9, 1, 2, 3, 9]);
  const { client, workers } = setup({ data: backing.subarray(1, 4) });
  client.start();
  await flush();
  const { data } = workers[0].posted[0].request as { data: ArrayBuffer };
  assert.deepEqual([...new Uint8Array(data)], [1, 2, 3]);
  assert.notEqual(data, backing.buffer);
});

test("a missing connectome makes the brain unavailable, without a worker", async () => {
  const { client, workers } = setup({ data: null });
  client.start();
  await flush();
  assert.equal(client.status, "unavailable");
  assert.equal(workers.length, 0);
  client.tick(16, RESTING);
  assert.equal(workers.length, 0);
});

test("a failure to read the data or start the worker fails the brain", async () => {
  const unreadable = setup({ failLoad: true });
  unreadable.client.start();
  await flush();
  assert.equal(unreadable.client.status, "failed");

  const noWorker = setup({ failCreate: true });
  noWorker.client.start();
  await flush();
  assert.equal(noWorker.client.status, "failed");
  assert.match(noWorker.client.error!, /supported/);
});

test("only one tick is in flight; time in between adds up to a cap, with the latest senses", async () => {
  const { client, worker, ticks, advance } = await running();
  client.tick(16, senses(0.1));
  client.tick(16, senses(0.2));
  client.tick(20, senses(0.3));
  assert.equal(ticks(worker).length, 1);
  assert.equal(ticks(worker)[0].dtMs, 16);

  advance(50);
  worker.reply({ type: "state", state: stateWith({ walk: 0.7 }) });
  assert.equal(client.state?.command.walk, 0.7);
  assert.equal(client.stateAt, 1050);
  client.tick(10, senses(0.4));
  assert.equal(ticks(worker).length, 2);
  assert.equal(ticks(worker)[1].dtMs, 46);
  assert.equal(ticks(worker)[1].senses.touch, 0.4);

  // A slow brain falls behind instead of catching up: the rest is dropped.
  for (let i = 0; i < 20; i++) client.tick(16, senses(0.5));
  worker.reply({ type: "state", state: stateWith({}) });
  client.tick(16, senses(0.6));
  assert.equal(ticks(worker)[2].dtMs, MAX_TICK_MS);
  assert.equal(ticks(worker)[2].senses.touch, 0.6);

  // Answers nobody asked for are ignored.
  worker.reply({ type: "state", state: stateWith({ walk: 0.1 }) });
  worker.reply({ type: "state", state: stateWith({ walk: 0.2 }) });
  assert.equal(client.state?.command.walk, 0.1);
});

test("a tick unanswered for too long fails the brain and terminates the worker", async () => {
  const { client, worker, ticks, advance } = await running();
  client.tick(16, RESTING);
  worker.reply({ type: "state", state: stateWith({ walk: 1 }) });
  client.tick(16, RESTING);
  advance(STALL_MS);
  client.tick(16, RESTING);
  assert.equal(client.status, "running");
  advance(1);
  client.tick(16, RESTING);
  assert.equal(client.status, "failed");
  assert.equal(worker.terminated, true);
  assert.equal(client.state, null);

  // Late answers and further frames do nothing.
  worker.reply({ type: "state", state: stateWith({ walk: 1 }) });
  client.tick(16, RESTING);
  assert.equal(client.state, null);
  assert.equal(ticks(worker).length, 2);
});

test("worker crashes and error responses fail the brain; it doesn't retry by itself", async () => {
  const crashed = await running();
  crashed.worker.crash("Out of memory");
  assert.equal(crashed.client.status, "failed");
  assert.equal(crashed.client.error, "Out of memory");
  assert.equal(crashed.worker.terminated, true);

  const errored = await running();
  errored.client.tick(16, RESTING);
  errored.worker.reply({ type: "error", message: "NaN in membrane" });
  assert.equal(errored.client.status, "failed");
  assert.equal(errored.worker.terminated, true);
  await flush();
  assert.equal(errored.workers.length, 1);

  // Off and on again starts a fresh one.
  errored.client.stop();
  errored.client.start();
  await flush();
  assert.equal(errored.workers.length, 2);
  assert.equal(errored.client.status, "loading");
  assert.equal(errored.client.error, null);
});

test("a brain that never finishes loading fails", async () => {
  const { client, workers, advance } = setup();
  client.start();
  await flush();
  advance(LOAD_TIMEOUT_MS + 1);
  client.tick(16, RESTING);
  assert.equal(client.status, "failed");
  assert.equal(workers[0].terminated, true);
});

test("turning it off terminates the worker and ignores anything still on its way", async () => {
  const { client, worker } = await running();
  client.tick(16, RESTING);
  client.stop();
  assert.equal(client.status, "off");
  assert.equal(worker.terminated, true);
  worker.reply({ type: "state", state: stateWith({ walk: 1 }) });
  worker.crash("late");
  assert.equal(client.state, null);
  assert.equal(client.status, "off");

  // Off while the data is still loading: it's dropped when it arrives.
  const loading = setup();
  loading.client.start();
  loading.client.stop();
  await flush();
  assert.equal(loading.workers.length, 0);
  assert.equal(loading.client.status, "off");
});

test("activity is the spike rate in fly time and the speed against real time", async () => {
  const { client, worker, advance } = await running();
  for (let i = 0; i < 4; i++) {
    client.tick(16, RESTING);
    advance(100);
    worker.reply({ type: "state", state: stateWith({}, { simMs: 50, spikes: 500 }) });
  }
  const { spikesPerSecond, speed } = client.activity();
  assert.equal(spikesPerSecond, 10_000);
  assert.equal(speed, 0.5);
  client.stop();
  assert.deepEqual(client.activity(), { spikesPerSecond: 0, speed: 0 });
});
