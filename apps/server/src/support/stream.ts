import type { Request, Response } from "express";

/** Ephemeral delivery to one desktop; there is deliberately no event history. */
export class SupportStream {
  private clients = new Map<Response, number>();
  private now: () => number;
  constructor(now = Date.now) { this.now = now; }
  attach(req: Request, res: Response) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    this.clients.set(res, this.now());
    const timer = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { clearInterval(timer); this.clients.delete(res); });
  }
  deliver(id: string, sentAt = this.now()) {
    const client = [...this.clients].reverse().find(([res, connectedAt]) =>
      connectedAt <= sentAt && !res.destroyed && !res.writableEnded)?.[0];
    if (!client) return false;
    client.write(`event: support\ndata: ${JSON.stringify({ id })}\n\n`);
    return true;
  }
  close() { for (const res of this.clients.keys()) res.end(); this.clients.clear(); }
}
