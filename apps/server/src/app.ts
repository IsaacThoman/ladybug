import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import type { GreetingResponse, HealthResponse } from "@ladybug/shared";
import { createModelSettings } from "@ladybug/backend";
import type { ModelSettingsStore } from "@ladybug/backend";
import { requireAccount, userOf } from "./accounts.ts";
import { checkVisit } from "./checker.ts";
import { config } from "./config.ts";
import { adminAuthRouter, requireAdmin } from "./adminAuth.ts";
import { errorHandler, optionalString, requireStore, requireString } from "./http.ts";
import { adminRouter } from "./routes/admin.ts";
import type { SandboxLister } from "./routes/admin.ts";
import { authRouter } from "./routes/auth.ts";
import type { Limiter } from "./routes/auth.ts";
import { listSandboxes } from "./sandboxes.ts";
import { scansRouter } from "./scans.ts";
import type { ScanDeps } from "./scans.ts";
import { petChannel } from "./sse.ts";
import { isStoreReady } from "./store.ts";
import { SupportService, configureSupport } from "./support/service.ts";
import { supportWebhook } from "./support/webhook.ts";
import { createCallRouter } from "./calls/router.ts";

const GREETINGS = [
  "Hi there!",
  "Hello from the server!",
  "Keep going, you're doing great.",
  "Time for a stretch?",
  "*happy wiggle*",
  "Got a sketchy link? Drop it on me.",
];

export function createApp(
  deps: ScanDeps & { authLimit: Limiter; modelSettings?: ModelSettingsStore; sandboxes?: SandboxLister },
) {
  const app = express();

  // How many reverse proxies sit in front, so req.ip (used for rate limits) is the client.
  app.set("trust proxy", config.trustProxyHops);
  app.use(cors());
  const calls = createCallRouter({ accounts: deps.accounts });
  app.locals.calls = calls;
  const support = new SupportService(deps.redis, calls.deliverSupport).start();
  app.locals.support = support;
  configureSupport(support);
  app.use("/api/support/chert/webhook", supportWebhook(support));
  app.use(express.json({ limit: "16kb" }));
  app.use("/api/calls", calls);

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

  // Sign-up and sign-in for the extension, the pet and the web page.
  app.use("/api/auth", authRouter({ accounts: deps.accounts, limit: deps.authLimit, clientIpHeader: deps.clientIpHeader }));
  const signedIn = requireAccount(deps.accounts);

  // Sandbox scans: started by the pet, the web page, or the analyzer below.
  app.use("/api/scans", scansRouter(deps));

  // Called by the browser extension for every page visit. Alerts go to the same user's pets.
  app.post("/api/check", signedIn, requireStore, async (req, res) => {
    const user = userOf(res);
    res.json(
      await checkVisit(
        {
          url: requireString(req.body?.url, "url", 8192),
          title: optionalString(req.body?.title, "title", 500),
        },
        "extension",
        { userId: user.id, username: user.username },
      ),
    );
  });

  // Desktop pets subscribe here for their user's alerts.
  app.get("/api/pet/stream", signedIn, (req, res) => {
    petChannel.attach(req, res, userOf(res).id);
  });

  // Sign-in first: the admin UI calls these while signed out.
  app.use("/api/admin", adminAuthRouter());
  const modelSettings = deps.modelSettings ?? createModelSettings(deps.db, deps.redis);
  const sandboxes = deps.sandboxes ?? ((limit: number) => listSandboxes(deps.db, deps.redis, limit));
  app.use("/api/admin", requireAdmin, adminRouter(deps.accounts, modelSettings, sandboxes, calls.revoke));

  // Built admin UI (see apps/admin). It's public: it holds no data, and shows
  // its sign-in page until the API accepts the session.
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
