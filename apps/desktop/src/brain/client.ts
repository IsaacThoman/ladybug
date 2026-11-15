import type { BrainRequest, BrainResponse, BrainSenses, BrainState } from "@ladybug/brain";

/**
 * - off: the setting is off
 * - loading: reading the connectome and building the brain
 * - running: ticking
 * - unavailable: the connectome isn't installed
 * - failed: the worker crashed, errored or stopped answering; turning the brain off and on retries
 */
export type BrainStatus = "off" | "loading" | "running" | "unavailable" | "failed";

/** The worker running the brain, behind the two callbacks the client needs. */
export type BrainWorker = {
  post: (request: BrainRequest, transfer?: Transferable[]) => void;
  terminate: () => void;
};
export type BrainWorkerFactory = (onMessage: (response: BrainResponse) => void, onError: (message: string) => void) => BrainWorker;

/** Most fly time one tick covers. Time beyond it, while the brain is busy, is dropped: it runs slower than real time. */
export const MAX_TICK_MS = 100;
/** A tick unanswered for this long means the brain has stalled. */
export const STALL_MS = 2000;
/** Building the brain from the connectome may take a while, but not this long. */
export const LOAD_TIMEOUT_MS = 30_000;
/** Spike rate and simulation speed are averaged over this much wall-clock time. */
const ACTIVITY_WINDOW_MS = 1000;

export type BrainActivity = {
  /** Spikes per second of fly time. */
  spikesPerSecond: number;
  /** Fly time simulated per unit of real time: 1 is real time. */
  speed: number;
};

const toArrayBuffer = (bytes: ArrayBuffer | Uint8Array): ArrayBuffer => {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
};

/**
 * Owns the brain's worker. The pet calls `tick` every frame; at most one tick
 * is with the worker at a time, so a slow brain falls behind instead of
 * piling up work, and `state` is always the latest answer.
 */
export class BrainClient {
  status: BrainStatus = "off";
  /** The latest answer, or null when there isn't a running brain. */
  state: BrainState | null = null;
  /** When `state` arrived. */
  stateAt = 0;
  neurons = 0;
  connections = 0;
  /** What went wrong, when failed. */
  error: string | null = null;

  private createWorker: BrainWorkerFactory;
  private loadData: () => Promise<ArrayBuffer | Uint8Array | null>;
  private now: () => number;
  private worker: BrainWorker | null = null;
  /** Bumped whenever the brain stops, so stragglers from an old one are ignored. */
  private generation = 0;
  private loadingSince = 0;
  private inFlight = false;
  private sentAt = 0;
  private pendingMs = 0;
  private runningSince = 0;
  private history: { at: number; simMs: number; spikes: number }[] = [];

  constructor({ createWorker, loadData, now = () => performance.now() }: {
    createWorker: BrainWorkerFactory;
    loadData: () => Promise<ArrayBuffer | Uint8Array | null>;
    now?: () => number;
  }) {
    this.createWorker = createWorker;
    this.loadData = loadData;
    this.now = now;
  }

  /** Loads and starts the brain, unless it's already loading or running. */
  start() {
    if (this.status === "loading" || this.status === "running") return;
    this.reset();
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.status = "loading";
    this.loadingSince = this.now();
    this.loadData().then((bytes) => {
      if (!current()) return;
      if (!bytes) { this.status = "unavailable"; return; }
      const data = toArrayBuffer(bytes);
      try {
        this.worker = this.createWorker(
          (response) => { if (current()) this.receive(response); },
          (message) => { if (current()) this.fail(message); },
        );
        this.loadingSince = this.now();
        this.worker.post({ type: "init", data }, [data]);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    }, () => { if (current()) this.fail("Couldn't read the fly brain's data."); });
  }

  /** Stops the brain and lets go of its worker and data. */
  stop() {
    this.reset();
    this.status = "off";
  }

  dispose() {
    this.stop();
  }

  /**
   * Called every frame with the fly time that passed and what the body feels
   * now. Sends a tick when the previous one has been answered.
   */
  tick(dtMs: number, senses: BrainSenses) {
    const now = this.now();
    if (this.status === "loading") {
      if (this.worker && now - this.loadingSince > LOAD_TIMEOUT_MS) this.fail("The fly brain took too long to start.");
      return;
    }
    if (this.status !== "running" || !this.worker) return;
    this.pendingMs = Math.min(this.pendingMs + Math.max(0, dtMs), MAX_TICK_MS);
    if (this.inFlight) {
      if (now - this.sentAt > STALL_MS) this.fail("The fly brain stopped responding.");
      return;
    }
    if (this.pendingMs <= 0) return;
    this.inFlight = true;
    this.sentAt = now;
    const dt = this.pendingMs;
    this.pendingMs = 0;
    this.worker.post({ type: "tick", dtMs: dt, senses: { ...senses } });
  }

  /** Spike rate and speed over the last second, for the activity panel. */
  activity(): BrainActivity {
    const now = this.now();
    this.trimHistory(now);
    const simMs = this.history.reduce((sum, entry) => sum + entry.simMs, 0);
    const spikes = this.history.reduce((sum, entry) => sum + entry.spikes, 0);
    const span = Math.min(ACTIVITY_WINDOW_MS, now - this.runningSince);
    return {
      spikesPerSecond: simMs > 0 ? spikes / (simMs / 1000) : 0,
      speed: span > 0 ? simMs / span : 0,
    };
  }

  private receive(response: BrainResponse) {
    const now = this.now();
    switch (response.type) {
      case "ready":
        if (this.status !== "loading") return;
        this.neurons = response.neurons;
        this.connections = response.connections;
        this.status = "running";
        this.runningSince = now;
        break;
      case "state":
        if (!this.inFlight) return;
        this.inFlight = false;
        this.state = response.state;
        this.stateAt = now;
        this.history.push({ at: now, simMs: response.state.stats.simMs, spikes: response.state.stats.spikes });
        this.trimHistory(now);
        break;
      case "error":
        this.fail(response.message);
        break;
    }
  }

  private fail(message: string) {
    this.reset();
    this.status = "failed";
    this.error = message;
  }

  private trimHistory(now: number) {
    while (this.history.length > 0 && now - this.history[0].at > ACTIVITY_WINDOW_MS) this.history.shift();
  }

  private reset() {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    this.state = null;
    this.stateAt = 0;
    this.error = null;
    this.inFlight = false;
    this.pendingMs = 0;
    this.history = [];
  }
}
