import { randomUUID } from "node:crypto";
import type { CallState, PreparedCall } from "@ladybug/shared";
import type { CallAuth } from "./call-config.ts";

const terminal = (state: CallState) => ["idle", "ended", "error"].includes(state.phase);
const SIGNED_OUT = "Sign in to Computerbug to request help.";

/** The server refused the request: `status` is its HTTP status. */
class CallApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
/** The session no longer works for calls (signed out, deleted, or calls turned off). */
const lostAccess = (error: unknown) => error instanceof CallApiError && (error.status === 401 || error.status === 403);

/** Desktop transport only. Provider credentials and call control live on the server. */
export class CallService {
  private state: CallState = { phase: "idle", message: "Ready to call", bridgeReady: false };
  private listeners = new Set<(state: CallState) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private pendingEnd = false;
  private preparing = false;
  private request: typeof fetch;
  private auth: () => CallAuth | null;
  /** The account that placed the current call. It keeps the call even if the pet signs in as someone else. */
  private caller: CallAuth | null = null;
  constructor(options: { fetch?: typeof fetch; auth?: () => CallAuth | null } = {}) {
    this.request = options.fetch ?? fetch;
    this.auth = options.auth ?? (() => null);
  }
  getState = () => ({ ...this.state });
  subscribe(listener: (state: CallState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private update(state: CallState) {
    this.state = state;
    for (const listener of this.listeners) listener(this.getState());
  }
  private async api<T>(path: string, body?: unknown): Promise<T> {
    const config = this.caller;
    if (!config) throw new CallApiError(SIGNED_OUT, 401);
    let response: Response;
    try {
      response = await this.request(`${config.url}/api/calls${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000),
      });
    } catch { throw new Error("Could not reach the call server."); }
    if (!response.ok) {
      // Do not forward arbitrary proxy/server responses or credential-bearing URLs.
      const errors: Record<number, string> = {
        400: "Invalid call request.", 401: SIGNED_OUT,
        403: "Calls aren't turned on for this account yet. Ask a Computerbug admin.",
        404: "This call is no longer available on the server.", 409: "The call line is busy or still cleaning up.",
        429: "Too many call attempts. Wait a minute and try again.", 503: "Calls are not configured on the server.",
      };
      throw new CallApiError(errors[response.status] ?? "The call server could not complete the request.", response.status);
    }
    return await response.json() as T;
  }
  async prepare(): Promise<PreparedCall> {
    if (this.preparing || !terminal(this.state)) throw new Error("A FaceTime call is already in progress or still cleaning up.");
    this.preparing = true;
    this.pendingEnd = false;
    this.update({ phase: "preparing", message: "Preparing FaceTime…", bridgeReady: false });
    const requestId = randomUUID();
    try {
      this.caller = this.auth();
      if (!this.caller) throw new Error(SIGNED_OUT);
      // The server caches this request ID: a lost response must not allocate a second room.
      const prepared = await this.api<PreparedCall>("/prepare", { requestId });
      this.update({ id: prepared.id, phase: this.pendingEnd ? "ending" : "ready", message: "Connecting screen sharing and microphone…", bridgeReady: false });
      if (this.pendingEnd) await this.end(prepared.id);
      this.schedule();
      return prepared;
    } catch (error) {
      this.update({ phase: "error", message: error instanceof Error ? error.message : "Could not prepare FaceTime.", bridgeReady: false });
      throw error;
    } finally { this.preparing = false; }
  }
  async dial(id: string) {
    this.require(id);
    await this.api(`/${encodeURIComponent(id)}/dial`, {});
    await this.poll();
  }
  async end(id: string) {
    this.require(id);
    this.pendingEnd = true;
    this.update({ ...this.state, phase: "ending", message: "Hanging up; waiting for cleanup…", bridgeReady: false });
    // Keep retrying if the network drops; the server also expires unattended sessions.
    try { await this.api(`/${encodeURIComponent(id)}/end`, {}); } catch { /* poll retries */ }
    this.schedule();
  }
  private require(id: string) {
    if (id !== this.state.id) throw new Error("This call is no longer current.");
  }
  private schedule() {
    if (this.timer || terminal(this.state)) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 1000);
  }
  async poll() {
    if (!this.state.id || terminal(this.state)) return;
    const id = this.state.id;
    try {
      if (this.pendingEnd) {
        try { await this.api(`/${encodeURIComponent(id)}/end`, {}); }
        catch { /* Still observe state: the call may already be gone after a server restart. */ }
      }
      const state = await this.api<CallState>("/state");
      if (this.state.id !== id) return;
      if (state.id !== id) {
        this.update({ id, phase: "ended", message: "Call ended", bridgeReady: false });
      } else {
        // A late active snapshot must never reopen capture after Hang up.
        this.update(this.pendingEnd && !terminal(state)
          ? { ...state, phase: "ending", message: "Hanging up; waiting for cleanup…", bridgeReady: false }
          : state);
      }
      if (terminal(this.state)) this.pendingEnd = false;
    } catch (error) {
      if (this.state.id !== id) return;
      if (lostAccess(error)) {
        // Nothing this session can do; the server hangs up calls nobody checks in on.
        this.pendingEnd = false;
        this.update({ id, phase: "ended", message: "Call ended: this account can no longer place calls.", bridgeReady: false });
        return;
      }
      this.pendingEnd = true;
      this.update({ id, phase: "ending", message: "Call server disconnected; stopping media and retrying hang-up…", bridgeReady: false });
    } finally { this.schedule(); }
  }
  async endCurrent() {
    if (this.preparing) this.pendingEnd = true;
    if (this.state.id && !terminal(this.state)) await this.end(this.state.id);
  }
}
