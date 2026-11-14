import cors from "cors";
import express from "express";
import type { ErrorRequestHandler } from "express";
import type { GreetingResponse, HealthResponse } from "@ladybug/shared";
import { scansRouter } from "./scans.ts";
import type { ScanDeps } from "./scans.ts";

const GREETINGS = [
  "Hi there!",
  "Hello from the server!",
  "Keep going, you're doing great.",
  "Time for a stretch?",
  "*happy wiggle*",
  "Got a sketchy link? Drop it on me.",
];

export function createApp(deps: ScanDeps) {
  const app = express();

  // Behind the Vultr load balancer / nginx, so req.ip is the client.
  app.set("trust proxy", 1);
  app.use(cors());
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
    };
    res.json(body);
  });

  app.get("/api/greeting", (_req, res) => {
    const message = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const body: GreetingResponse = { message };
    res.json(body);
  });

  app.use("/api/scans", scansRouter(deps));

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    console.error("[server]", err);
    if (res.headersSent) return next(err);
    const status = typeof err?.status === "number" && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? "internal error" : String(err.message) });
  };
  app.use(onError);

  return app;
}
