import type { Request, Response } from "express";
import type { SupportCommand } from "./service.ts";

/** Account-scoped ephemeral command delivery with no event history. */
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
  deliver(command: SupportCommand) {
    if (command.expiresAt < this.now()) return false;
    const clients = [...this.clients].reverse().filter(([res, { userId, connectedAt }]) =>
      userId === command.accountId && connectedAt <= command.sentAt && !res.destroyed && !res.writableEnded);
    const targets = command.kind === "support" ? clients.slice(0, 1) : clients;
    for (const [client] of targets) {
      client.write(`event: ${command.kind}\ndata: ${JSON.stringify({ id: command.id, expiresAt: command.expiresAt })}\n\n`);
    }
    return targets.length > 0;
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
