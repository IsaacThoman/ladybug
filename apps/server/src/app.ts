import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import type { GreetingResponse, HealthResponse } from "@ladybug/shared";
import { checkVisit } from "./checker.ts";
import { config } from "./config.ts";
import { errorHandler, optionalString, requireStore, requireString } from "./http.ts";
import { adminRouter } from "./routes/admin.ts";
import { petChannel } from "./sse.ts";
import { isStoreReady } from "./store.ts";

const GREETINGS = [
  "Hi there!",
  "Hello from the server!",
  "Keep going, you're doing great.",
  "Time for a stretch?",
  "*happy wiggle*",
];

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

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

  app.use("/api/admin", adminRouter());

  // Built admin UI (see apps/admin).
  if (fs.existsSync(config.adminDist)) {
    app.use("/admin", express.static(config.adminDist));
    app.get("/admin/{*path}", (_req, res) => {
      res.sendFile(path.join(config.adminDist, "index.html"));
    });
    app.get("/", (_req, res) => res.redirect("/admin/"));
  }

  app.use(errorHandler);
  return app;
}
