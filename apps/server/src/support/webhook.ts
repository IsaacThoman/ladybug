import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readMessagingConfig, verifySignature } from "./chert.ts";
import type { MessagingConfig } from "./chert.ts";
import type { SupportService } from "./service.ts";

export function supportWebhook(service: SupportService, config: () => MessagingConfig | null = readMessagingConfig) {
  const router = express.Router();
  router.post("/", express.raw({ type: "application/json", limit: "64kb", inflate: false }), async (req, res) => {
    const received = Date.now(), settings = config();
    if (!settings) { res.sendStatus(503); return; }
    if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.header("X-Webhook-Signature") ?? req.header("x-chert-signature") ?? "", settings.secret, received)) {
      res.sendStatus(401); return;
    }
    let event: unknown;
    try { event = JSON.parse(req.body.toString("utf8")); } catch { res.sendStatus(400); return; }
    try { await service.reply(event, received); res.sendStatus(204); }
    catch { res.sendStatus(503); }
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    if (status === 400 || status === 413 || status === 415) { res.sendStatus(status); return; }
    next(error);
  });
  return router;
}
