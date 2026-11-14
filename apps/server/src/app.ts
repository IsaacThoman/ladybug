import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import type { GreetingResponse, HealthResponse } from "@ladybug/shared";
import { checkVisit } from "./checker.ts";
import { config } from "./config.ts";
import { errorHandler, optionalString, requireAdmin, requireStore, requireString } from "./http.ts";
import { adminRouter } from "./routes/admin.ts";
import { scansRouter } from "./scans.ts";
import type { ScanDeps } from "./scans.ts";
import { petChannel } from "./sse.ts";
import { isStoreReady } from "./store.ts";

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

  // How many reverse proxies sit in front, so req.ip (used for rate limits) is the client.
  app.set("trust proxy", config.trustProxyHops);
  app.use(cors());
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      typesense: isStoreReady() ? "ready" : "unavailable",
    };
    res.json(body);
  });

  app.get("/api/greeting", (_req, res) => {
    const message = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const body: GreetingResponse = { message };
    res.json(body);
  });

  // Sandbox scans: started by the pet, the web page, or the analyzer below.
  app.use("/api/scans", scansRouter(deps));

  // Called by the browser extension for every page visit.
  app.post("/api/check", requireStore, async (req, res) => {
    res.json(
      await checkVisit(
        {
          url: requireString(req.body?.url, "url", 8192),
          title: optionalString(req.body?.title, "title", 500),
        },
        "extension",
      ),
    );
  });

  // Desktop pets subscribe here for alerts.
  app.get("/api/pet/stream", (req, res) => {
    petChannel.attach(req, res);
  });

  app.use("/api/admin", requireAdmin, adminRouter());

  // Built admin UI (see apps/admin).
  if (fs.existsSync(config.adminDist)) {
    app.use("/admin", requireAdmin, express.static(config.adminDist));
    app.get("/admin/{*path}", requireAdmin, (_req, res) => {
      res.sendFile(path.join(config.adminDist, "index.html"));
    });
    app.get("/", (_req, res) => res.redirect("/admin/"));
  }

  app.use(errorHandler);
  return app;
}
