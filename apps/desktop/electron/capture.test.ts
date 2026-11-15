import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createCapture, compositionGeometry, cropCamera } from "../src/calls/capture.ts";
import type { CaptureStatus } from "../src/calls/capture.ts";
import { createCallMedia } from "../src/calls/media.ts";
import { FaceTimeController } from "../src/calls/controller.ts";
import type { FaceTimeApi, PreparedCall } from "@ladybug/shared";
import type { Room, LocalAudioTrack, LocalVideoTrack } from "livekit-client";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class FakeTrack extends EventTarget {
  kind: string;
  readyState = "live";
  constructor(kind: string) { super(); this.kind = kind; }
  stop() { this.readyState = "ended"; }
  end() { this.stop(); this.dispatchEvent(new Event("ended")); }
}
function stream(kind: string) {
  const track = new FakeTrack(kind);
  return { track, getTracks: () => [track], getVideoTracks: () => kind === "video" ? [track] : [], getAudioTracks: () => kind === "audio" ? [track] : [] };
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const screen = stream("video"), microphone = stream("audio"), camera = stream("video"), composite = stream("video");
  const requests: MediaStreamConstraints[] = [];
  const draws: unknown[][] = [];
  const statuses: CaptureStatus[] = [];
  const elements: { srcObject: unknown; readyState: number; videoWidth: number; videoHeight: number; muted: boolean; playsInline: boolean; play: () => Promise<void>; pause: () => void; remove: () => void }[] = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ fillRect: () => {}, drawImage: (...args: unknown[]) => draws.push(args) }), captureStream: (fps: number) => { assert.equal(fps, 15); return composite; } };
  const options = {
    source: async () => ({ id: "screen-id", platform: "linux" }),
    acquire: async (constraints: MediaStreamConstraints) => constraints.video && typeof constraints.video === "object" ? screen : constraints.audio ? microphone : camera,
  };
  const globals: Record<string, unknown> = {
    window: { ladybug: { getCallCaptureSource: () => options.source() } },
    navigator: { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => { requests.push(constraints); return options.acquire(constraints); } } },
    document: { createElement: (tag: string) => {
      if (tag === "canvas") return canvas;
      const element = { srcObject: null as unknown, readyState: 2, videoWidth: 2560, videoHeight: 1440, muted: false, playsInline: false, play: async () => {}, pause: () => {}, remove: () => {} };
      elements.push(element); return element;
    } },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  let ended = 0;
  const capture = createCapture(() => ended++, (status) => statuses.push(status));
  t.after(capture.stop);
  const render = async () => { await flush(); t.mock.timers.tick(70); await flush(); };
  return { screen, microphone, camera, composite, requests, draws, statuses, elements, canvas, options, capture, render, ended: () => ended };
}

test("geometry preserves wide, portrait, and small sources; camera crop fills the bottom-right inset", () => {
  for (const [w, h, expected] of [[3840, 2160, [1920, 1080]], [1080, 1920, [607, 1080]], [640, 480, [640, 480]]] as const) {
    const g = compositionGeometry(w, h);
    assert.deepEqual([g.width, g.height], expected);
    assert.equal(g.inset.width, g.width * 0.22);
    assert.ok(g.inset.x > g.width / 2 && g.inset.y > g.height / 2);
    assert.ok(g.inset.x + g.inset.width < g.width && g.inset.y + g.inset.height < g.height);
  }
  assert.deepEqual(cropCamera(1920, 1080, 400, 300), { x: 240, y: 0, width: 1440, height: 1080 });
});

test("composes a first screen frame, resizes, removes ended camera, and cleans up all resources", async (t) => {
  const f = fixture(t);
  const result = f.capture.start("call");
  await f.render();
  await result;
  assert.equal(f.draws.length, 2);
  assert.deepEqual([f.canvas.width, f.canvas.height], [1920, 1080]);
  assert.deepEqual(f.requests.map((r) => [!!r.audio, !!r.video]), [[false, true], [true, false], [false, true]]);
  assert.equal((f.requests[0].video as { mandatory: { chromeMediaSourceId: string } }).mandatory.chromeMediaSourceId, "screen-id");
  const screenDraw = f.draws[0];
  const cameraDraw = f.draws[1];
  assert.deepEqual(screenDraw.slice(1), [0, 0, 1920, 1080]);
  const inset = compositionGeometry(2560, 1440).inset;
  assert.deepEqual(cameraDraw.slice(5), [inset.x, inset.y, inset.width, inset.height]);
  const screenElement = f.elements[1];
  screenElement.videoWidth = 1080; screenElement.videoHeight = 1920;
  f.camera.track.end();
  const before = f.draws.length;
  await f.render();
  assert.equal(f.draws.length, before + 1);
  assert.deepEqual([f.canvas.width, f.canvas.height], [607, 1080]);
  assert.equal(f.statuses.at(-1)?.cameraUnavailable, true);
  assert.equal(f.ended(), 0);
  f.capture.stop();
  for (const s of [f.screen, f.camera, f.microphone, f.composite]) assert.equal(s.track.readyState, "ended");
  assert.ok(f.elements.every((e) => e.srcObject === null));
  const count = f.draws.length;
  await f.render();
  assert.equal(f.draws.length, count);
});

test("camera denial still yields screen video and microphone", async (t) => {
  const f = fixture(t);
  const acquire = f.options.acquire;
  f.options.acquire = async (constraints) => { if (constraints.video === true) throw new Error("denied"); return acquire(constraints); };
  const result = f.capture.start("call");
  await f.render();
  await result;
  assert.equal(f.draws.length, 1);
  assert.deepEqual([f.canvas.width, f.canvas.height], [1920, 1080]);
  assert.equal(f.statuses.at(-1)?.cameraUnavailable, true);
  assert.equal(f.microphone.track.readyState, "live");
});

for (const device of ["screen", "microphone"] as const) test(`${device} failure blocks readiness and cleans up`, async (t) => {
  const f = fixture(t);
  const acquire = f.options.acquire;
  f.options.acquire = async (constraints) => {
    if (device === "screen" ? typeof constraints.video === "object" : !!constraints.audio) throw new Error("denied");
    return acquire(constraints);
  };
  await assert.rejects(f.capture.start("call"), device === "screen" ? /Screen sharing/ : /Microphone/);
  if (device === "microphone") assert.equal(f.screen.track.readyState, "ended");
  assert.equal(f.draws.length, 0);
});

for (const device of ["screen", "microphone", "camera"] as const) test(`cancellation during ${device} acquisition disposes late stream`, async (t) => {
  const f = fixture(t);
  const late = deferred<ReturnType<typeof stream>>();
  const acquire = f.options.acquire;
  f.options.acquire = async (constraints) => {
    if (device === "screen" ? typeof constraints.video === "object" : device === "microphone" ? !!constraints.audio : constraints.video === true) return late.promise;
    return acquire(constraints);
  };
  const pending = f.capture.start("call");
  const rejected = assert.rejects(pending);
  await flush(); f.capture.stop();
  await rejected;
  const lateStream = stream(device === "microphone" ? "audio" : "video");
  late.resolve(lateStream); await flush();
  assert.equal(lateStream.track.readyState, "ended");
  assert.equal(f.draws.length, 0);
});

test("cancellation while portal is pending never requests a device", async (t) => {
  const f = fixture(t);
  const late = deferred<{ id: string; platform: string }>();
  f.options.source = () => late.promise;
  const pending = assert.rejects(f.capture.start("call"));
  f.capture.stop(); await pending;
  late.resolve({ id: "late", platform: "linux" }); await flush();
  assert.equal(f.requests.length, 0);
});

for (const device of ["screen", "microphone"] as const) test(`ending ${device} ends capture and reports call failure`, async (t) => {
  const f = fixture(t);
  const result = f.capture.start("call"); await f.render(); await result;
  f[device].track.end();
  assert.equal(f.ended(), 1);
  assert.equal(f.screen.track.readyState, "ended");
  assert.equal(f.microphone.track.readyState, "ended");
  assert.equal(f.composite.track.readyState, "ended");
});

test("exactly one gated microphone and composite camera publication precede dialing", async (t) => {
  const f = fixture(t);
  const events: string[] = [];
  const videoPublished = deferred<void>();
  const output = stream("audio");
  const gain = { gain: { value: 0 }, connect: () => {} };
  let closed = false;
  const prepared = { id: "call", bridgeIdentity: "bridge", url: "wss://test", token: "token" } as PreparedCall;
  const room = { remoteParticipants: new Map(), on: () => {}, removeAllListeners: () => {}, connect: async () => {}, disconnect: async () => {}, localParticipant: {
    publishTrack: async (track: { mediaStreamTrack: unknown }, options: { source: string; dtx?: boolean }) => {
      events.push(options.source);
      if (options.source === "microphone") { assert.equal(track.mediaStreamTrack, output.track); assert.equal(options.dtx, false); }
      else { assert.equal(track.mediaStreamTrack, f.composite.track); assert.ok(f.draws.length > 0); await videoPublished.promise; }
    },
  } } as unknown as Room;
  const wrap = (track: MediaStreamTrack) => ({ mediaStreamTrack: track, stop: () => track.stop() });
  const media = createCallMedia(prepared, () => {}, { srcObject: null } as HTMLVideoElement, { srcObject: null } as HTMLAudioElement, () => {}, () => {}, () => {}, {
    room: () => room,
    audioContext: () => ({ state: "running", createGain: () => gain, createMediaStreamSource: () => ({ connect: () => {} }), createMediaStreamDestination: () => ({ stream: output }), resume: async () => {}, close: async () => { closed = true; } }) as unknown as AudioContext,
    audioTrack: (track) => wrap(track) as unknown as LocalAudioTrack,
    videoTrack: (track) => wrap(track) as unknown as LocalVideoTrack,
  });
  const api = { prepare: async () => prepared, dial: async () => { events.push("dial"); }, end: async () => {} } as unknown as FaceTimeApi;
  const controller = new FaceTimeController(api, () => media);
  const starting = controller.start();
  await f.render();
  assert.deepEqual(events, ["microphone", "camera"]);
  assert.equal(gain.gain.value, 0);
  videoPublished.resolve(); await starting;
  assert.deepEqual(events, ["microphone", "camera", "dial"]);
  media.activate(); assert.equal(gain.gain.value, 1);
  await controller.end();
  assert.equal(gain.gain.value, 0);
  assert.equal(output.track.readyState, "ended");
  assert.equal(closed, true);
});

test("canceling before the first screen frame releases devices and prevents readiness", async (t) => {
  const f = fixture(t);
  const result = f.capture.start("call");
  const rejected = assert.rejects(result, /canceled/);
  await flush();
  f.elements[1].readyState = 0;
  await f.render();
  assert.equal(f.draws.length, 0);
  f.capture.stop();
  await rejected;
  assert.equal(f.screen.track.readyState, "ended");
  assert.equal(f.microphone.track.readyState, "ended");
  assert.equal(f.camera.track.readyState, "ended");
});


test("a slow camera adds its inset without delaying screen sharing or changing output dimensions", async (t) => {
  const f = fixture(t);
  const result = f.capture.start("call");
  await flush();
  const camera = f.elements[0];
  camera.readyState = 0; camera.videoWidth = 0; camera.videoHeight = 0;
  await f.render(); await result;
  assert.equal(f.draws.length, 1);
  assert.deepEqual([f.canvas.width, f.canvas.height], [1920, 1080]);
  camera.readyState = 2; camera.videoWidth = 1280; camera.videoHeight = 720;
  await f.render();
  assert.equal(f.draws.length, 3);
  camera.readyState = 0;
  await f.render();
  assert.deepEqual([f.canvas.width, f.canvas.height], [1920, 1080]);
  assert.equal(f.draws.length, 4, "only the screen is drawn while the camera is stalled");
});

test("camera frame timeout continues screen sharing without an inset", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const result = f.capture.start("call");
  await flush();
  f.elements[0].videoWidth = 0;
  await f.render(); await result;
  assert.equal(f.draws.length, 1);
  now += 5001;
  await f.render();
  assert.deepEqual([f.canvas.width, f.canvas.height], [1920, 1080]);
  assert.equal(f.draws.length, 2);
  assert.equal(f.statuses.at(-1)?.cameraUnavailable, true);
  assert.equal(f.camera.track.readyState, "ended");
});
