import type { Request, Response } from "express";

/** Ephemeral delivery to one desktop; there is deliberately no event history. */
export class SupportStream {
  private clients = new Map<Response, string>();
  /** `userId` is the account the desktop signed in with. */
  attach(req: Request, res: Response, userId: string) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    this.clients.set(res, userId);
    const timer = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { clearInterval(timer); this.clients.delete(res); });
  }
  deliver(id: string) {
    const client = [...this.clients.keys()].reverse().find((res) => !res.destroyed && !res.writableEnded);
    if (!client) return false;
    client.write(`event: support\ndata: ${JSON.stringify({ id })}\n\n`);
    return true;
  }
  /** Ends every stream, or only those of one account. */
  close(userId?: string) {
    for (const [res, owner] of this.clients) {
      if (userId !== undefined && owner !== userId) continue;
      res.end();
      this.clients.delete(res);
    }
  }
}
