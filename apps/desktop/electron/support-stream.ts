import type { CallAuth } from "./call-config.ts";

const RETRY_MS = 3000;
/** Signed out, or calls are off for the account: an admin has to act first. */
const REFUSED_RETRY_MS = 30_000;

/** Authenticated SSE stays in the main process; reconnects never replay requests. */
export class SupportSubscription {
  private abort?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private active = false;
  private receive: (id: string) => void;
  private options: { fetch?: typeof fetch; auth: () => CallAuth | null };
  constructor(receive: (id: string) => void, options: SupportSubscription["options"]) { this.receive = receive; this.options = options; }
  start() { if (this.active) return; this.active = true; void this.connect(); }
  stop() { this.active = false; this.abort?.abort(); clearTimeout(this.retry); }
  private async connect() {
    const abort = new AbortController(); this.abort = abort;
    let wait = RETRY_MS;
    try {
      const config = this.options.auth();
      // Signed out: the main process restarts the subscription on sign-in.
      if (!config) { this.active = false; return; }
      const handshake = setTimeout(() => abort.abort(), 20_000);
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(`${config.url}/api/calls/support/stream`, {
          headers: { Authorization: `Bearer ${config.token}`, Accept: "text/event-stream" }, redirect: "error", signal: abort.signal,
        });
      } finally { clearTimeout(handshake); }
      if (response.status === 401 || response.status === 403) wait = REFUSED_RETRY_MS;
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        while (this.active && !abort.signal.aborted) {
          // A dead half-open connection must not remain eligible forever.
          const timeout = setTimeout(() => abort.abort(), 45_000);
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); } finally { clearTimeout(timeout); }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 65_536) throw new Error("Invalid support stream");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (!block.split("\n").includes("event: support")) continue;
            const line = block.split("\n").find((value) => value.startsWith("data: "));
            if (!line) continue;
            const data = JSON.parse(line.slice(6)) as { id?: unknown };
            if (this.active && !abort.signal.aborted && typeof data.id === "string" && /^[a-f0-9-]{36}$/i.test(data.id)) this.receive(data.id);
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch { /* Reconnect without exposing server configuration or credentials. */ }
    finally {
      if (this.active && this.abort === abort) this.retry = setTimeout(() => { void this.connect(); }, wait);
    }
  }
}
