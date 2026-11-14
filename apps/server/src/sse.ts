import type { Request, Response } from "express";

const HEARTBEAT_MS = 25_000;

const format = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A set of open server-sent-event streams that can all be sent to at once. */
export class SseChannel {
  private readonly clients = new Set<Response>();

  get size() {
    return this.clients.size;
  }

  /** Opens the stream. Returns a function that sends to just this client. */
  attach(req: Request, res: Response) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    this.clients.add(res);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
    return (event: string, data: unknown) => res.write(format(event, data));
  }

  send(event: string, data: unknown) {
    const payload = format(event, data);
    for (const client of this.clients) client.write(payload);
  }
}

/** Desktop pets listening for alerts. */
export const petChannel = new SseChannel();

/** Admin UIs listening for live activity. */
export const adminChannel = new SseChannel();
