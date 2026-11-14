import type { CallState, FaceTimeApi } from "./types.ts";

export type CallMedia = {
  connect: () => Promise<void>;
  publish: () => Promise<void>;
  activate: () => void;
  stop: () => void;
};
type Attempt = { canceled: boolean; id?: string; media?: CallMedia };
export class FaceTimeController {
  private api: FaceTimeApi;
  private makeMedia: (prepared: Awaited<ReturnType<FaceTimeApi["prepare"]>>, disconnected: () => void) => CallMedia;
  private attempt?: Attempt;
  private listeners = new Set<() => void>();
  private state: CallState = { phase: "idle", message: "Ready to call", bridgeReady: false };

  constructor(api: FaceTimeApi, makeMedia: FaceTimeController["makeMedia"]) {
    this.api = api;
    this.makeMedia = makeMedia;
  }
  observe() {
    let received = false;
    let disposed = false;
    const receive = (state: CallState) => {
      received = true;
      const attempt = this.attempt;
      if (attempt?.id && state.id !== attempt.id) return;
      if (attempt) attempt.id = state.id;
      this.setState(state);
      if (state.phase === "ending" || state.phase === "ended" || state.phase === "error") {
        if (attempt) { attempt.canceled = true; attempt.media?.stop(); }
      }
      if (state.phase === "ended" || state.phase === "error") this.attempt = undefined;
      if (state.bridgeReady && attempt && !attempt.canceled) attempt.media?.activate();
    };
    const unsubscribe = this.api.onState(receive);
    void this.api.getState().then((state) => { if (!disposed && !received && !this.attempt) receive(state); });
    return () => { disposed = true; unsubscribe(); void this.end(); };
  }
  getSnapshot = () => this.state;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  };
  private setState(state: CallState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async start() {
    if (this.attempt || !["idle", "ended", "error"].includes(this.state.phase)) return;
    const attempt: Attempt = { canceled: false };
    this.attempt = attempt;
    this.setState({ phase: "preparing", message: "Preparing FaceTime…", bridgeReady: false });
    try {
      const prepared = await this.api.prepare();
      attempt.id = prepared.id;
      if (attempt.canceled) { await this.api.end(prepared.id); return; }
      const media = this.makeMedia(prepared, () => { if (this.attempt === attempt) void this.end(); });
      attempt.media = media;
      await media.connect();
      if (attempt.canceled) { media.stop(); return; }
      await media.publish();
      if (attempt.canceled) { media.stop(); return; }
      await this.api.dial(prepared.id);
    } catch (error) {
      attempt.media?.stop();
      if (this.attempt !== attempt) return;
      const message = error instanceof Error ? error.message : "Could not start FaceTime.";
      const wasCanceled = attempt.canceled;
      if (attempt.id) {
        this.setState({ ...this.state, phase: "ending", message, bridgeReady: false });
        await this.api.end(attempt.id).catch(() => {});
      } else {
        this.attempt = undefined;
        this.setState({ phase: "error", message, bridgeReady: false });
        return;
      }
      if (!wasCanceled && (!this.attempt || this.attempt === attempt)) this.setState({ ...this.state, message, bridgeReady: false });
    }
  }
  async end() {
    const attempt = this.attempt;
    const id = attempt?.id ?? this.state.id;
    if (!attempt && ["idle", "ended", "error"].includes(this.state.phase)) return;
    if (attempt) { attempt.canceled = true; attempt.media?.stop(); }
    this.setState({ ...this.state, phase: "ending", message: "Hanging up; waiting for cleanup…", bridgeReady: false });
    if (id) {
      try { await this.api.end(id); }
      catch { this.setState({ ...this.state, message: "Could not request hang-up. Try Hang up again." }); }
    }
  }
}
