import type { Request, Response } from "express";

/** Ephemeral delivery to one desktop; there is deliberately no event history. */
export class SupportStream {
  private clients = new Map<Response, { userId: string; connectedAt: number }>();
  private now: () => number;
  constructor(now = Date.now) { this.now = now; }
  /** `userId` is the account the desktop signed in with. */
  attach(req: Request, res: Response, userId: string) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    this.clients.set(res, { userId, connectedAt: this.now() });
    const timer = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { clearInterval(timer); this.clients.delete(res); });
  }
  deliver(id: string, sentAt = this.now()) {
    const client = [...this.clients].reverse().find(([res, { connectedAt }]) =>
      connectedAt <= sentAt && !res.destroyed && !res.writableEnded)?.[0];
    if (!client) return false;
    client.write(`event: support\ndata: ${JSON.stringify({ id })}\n\n`);
    return true;
  }
  /** Ends every stream, or only those of one account. */
  close(userId?: string) {
    for (const [res, client] of this.clients) {
      if (userId !== undefined && client.userId !== userId) continue;
      res.end();
      this.clients.delete(res);
    }
  }
}
