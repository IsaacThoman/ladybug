import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { IDLE_MS, OVERLAY_SELECTOR, READ_MS, captureScreen } from "./eyes-capture.ts";
import { Vision } from "./vision.ts";
import { FLAT_WALL } from "./wall.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeTrack extends EventTarget {
  kind = "video";
  readyState = "live";
  stop() { this.readyState = "ended"; }
  end() { this.stop(); this.dispatchEvent(new Event("ended")); }
}

/** A DOM just big enough for the capture: a video, a canvas that reads back one grey, and the overlay's elements. */
function fixture(t: TestContext, { grey = 0, overlay = [] as { x: number; y: number; width: number; height: number }[] } = {}) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let time = 1000;
  t.mock.method(performance, "now", () => time);
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const video = { muted: false, playsInline: false, srcObject: null as unknown, readyState: 2, videoWidth: 640, videoHeight: 400, play: async () => {}, pause: () => {} };
  const reads: number[][] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        reads.push([width, height]);
        return { data: new Uint8ClampedArray(width * height * 4).fill(grey) };
      },
    }),
  };
  const selectors: string[] = [];
  const document = {
    createElement: (tag: string) => (tag === "video" ? video : canvas),
    querySelectorAll: (selector: string) => {
      selectors.push(selector);
      return overlay.map((rect) => ({ getBoundingClientRect: () => rect }));
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); });

  const vision = new Vision();
  vision.wall.resize(600, 300);
  const opened: { width: number; height: number }[] = [];
  const open = { result: (): Promise<MediaStream> => Promise.resolve(stream) };
  const ended: boolean[] = [];
  const start = () => captureScreen((size) => { opened.push(size); return open.result(); })(vision, (failed) => ended.push(failed));
  const tick = async (ms: number) => { time += ms; t.mock.timers.tick(ms); await flush(); };
  return { vision, track, video, canvas, reads, selectors, opened, open, ended, start, tick, look: () => { vision.lastLook = time; } };
}

const mean = (vision: Vision) => vision.wall.integral(0, 0, vision.wall.width, vision.wall.height) / (vision.wall.width * vision.wall.height);

test("it opens the screen at twice the wall's resolution and reads it into the wall a few times a second, without the overlay", async (t) => {
  const panel = { x: 0, y: 0, width: 300, height: 300 };
  const f = fixture(t, { grey: 255, overlay: [panel] });
  const stop = f.start();
  assert.equal(f.vision.source, "starting");
  await flush();
  assert.deepEqual(f.opened, [{ width: f.vision.wall.cols * 2, height: f.vision.wall.rows * 2 }]);
  assert.equal(f.video.srcObject !== null, true);

  f.look();
  await f.tick(READ_MS);
  assert.equal(f.vision.source, "screen");
  assert.deepEqual(f.reads, [[f.vision.wall.cols, f.vision.wall.rows]]);
  assert.deepEqual([f.canvas.width, f.canvas.height], [f.vision.wall.cols, f.vision.wall.rows]);
  assert.deepEqual(f.selectors, [OVERLAY_SELECTOR]);
  // The left half, under the panel, is still the plain wall; the right half is the white screen.
  assert.ok(Math.abs(f.vision.wall.integral(0, 0, 300, 300) / 90_000 - FLAT_WALL) < 1e-6);
  assert.ok(Math.abs(f.vision.wall.integral(300, 0, 600, 300) / 90_000 - 1) < 1e-6);

  stop();
  assert.equal(f.track.readyState, "ended");
  assert.equal(f.video.srcObject, null);
  assert.equal(f.vision.source, "flat");
  assert.ok(Math.abs(mean(f.vision) - FLAT_WALL) < 1e-6, "nothing of the screen is kept");
  await f.tick(READ_MS * 4);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.ended, []);
});

test("a capture that can't open fails back to the plain wall", async (t) => {
  const f = fixture(t, { grey: 0 });
  f.open.result = () => Promise.reject(new Error("denied"));
  f.start();
  await flush();
  assert.equal(f.vision.source, "failed");
  assert.deepEqual(f.ended, [true]);
});

test("a capture whose track ends fails back to the plain wall", async (t) => {
  const g = fixture(t, { grey: 0 });
  g.start();
  await flush();
  g.look();
  await g.tick(READ_MS);
  assert.ok(mean(g.vision) < 0.01);
  g.track.end();
  assert.equal(g.vision.source, "failed");
  assert.deepEqual(g.ended, [true]);
  assert.ok(Math.abs(mean(g.vision) - FLAT_WALL) < 1e-6);
});

test("nothing looking through it for a while stops it", async (t) => {
  const f = fixture(t);
  f.start();
  await flush();
  await f.tick(IDLE_MS + READ_MS);
  assert.deepEqual(f.ended, [false]);
  assert.equal(f.track.readyState, "ended");
  assert.equal(f.vision.source, "flat");
});

test("a stream that arrives after stopping is closed", async (t) => {
  const g = fixture(t);
  let resolve!: (stream: MediaStream) => void;
  g.open.result = () => new Promise((done) => { resolve = done; });
  const stop = g.start();
  stop();
  resolve({ getTracks: () => [g.track], getVideoTracks: () => [g.track] } as unknown as MediaStream);
  await flush();
  assert.equal(g.track.readyState, "ended");
  assert.equal(g.video.srcObject, null);
  assert.deepEqual(g.ended, []);
});
