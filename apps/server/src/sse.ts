import type { Request, Response } from "express";

const HEARTBEAT_MS = 25_000;

const format = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * A set of open server-sent-event streams that can all be sent to at once, or
 * only to the streams opened under one key (a user id).
 */
export class SseChannel {
  private readonly clients = new Map<Response, string | undefined>();
  private readonly listeners = new Set<(key: string | undefined) => void>();

  get size() {
    return this.clients.size;
  }

  /** Open streams under this key. */
  sizeOf(key: string) {
    let count = 0;
    for (const owner of this.clients.values()) if (owner === key) count++;
    return count;
  }

  /** Calls `listener` with the key whenever a stream opens or closes under it. */
  onChange(listener: (key: string | undefined) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed(key: string | undefined) {
    for (const listener of this.listeners) listener(key);
  }

  /** Opens the stream. Returns a function that sends to just this client. */
  attach(req: Request, res: Response, key?: string) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    this.clients.set(res, key);
    this.changed(key);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const detach = () => {
      clearInterval(heartbeat);
      if (this.clients.delete(res)) this.changed(key);
    };
    req.on("close", detach);
    res.on("close", detach);
    return (event: string, data: unknown) => res.write(format(event, data));
  }

  send(event: string, data: unknown) {
    const payload = format(event, data);
    for (const client of this.clients.keys()) client.write(payload);
  }

  sendTo(key: string, event: string, data: unknown) {
    const payload = format(event, data);
    for (const [client, owner] of this.clients) if (owner === key) client.write(payload);
  }

  /** Ends every stream under this key, e.g. when its user loses access. */
  close(key: string) {
    let closed = false;
    for (const [client, owner] of this.clients) {
      if (owner !== key) continue;
      this.clients.delete(client);
      client.end();
      closed = true;
    }
    if (closed) this.changed(key);
  }
}

/** Desktop pets listening for alerts, keyed by their user's id. */
export const petChannel = new SseChannel();

/** Blocked pages in users' browsers, keyed by their user's id (see warnings.ts). */
export const warningChannel = new SseChannel();

/** Admin UIs listening for live activity. */
export const adminChannel = new SseChannel();
