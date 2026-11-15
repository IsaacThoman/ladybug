import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { WARNING_CHOICES } from "@ladybug/shared";
import type { GreetingResponse, HealthResponse } from "@ladybug/shared";
import { createModelSettings, createReportStore } from "@ladybug/backend";
import type { ModelSettingsStore, ReportStore } from "@ladybug/backend";
import { requireAccount, userOf } from "./accounts.ts";
import { checkVisit, lookupVisit } from "./checker.ts";
import { config } from "./config.ts";
import { focus } from "./focus.ts";
import { adminAuthRouter, requireAdmin } from "./adminAuth.ts";
import { HttpError, errorHandler, optionalString, requireEnum, requireStore, requireString } from "./http.ts";
import { adminRouter } from "./routes/admin.ts";
import type { SandboxLister } from "./routes/admin.ts";
import { adminReports, REPORTS_PER_MINUTE, reportsRouter } from "./reports.ts";
import { authRouter, redisLimiter } from "./routes/auth.ts";
import type { Limiter } from "./routes/auth.ts";
import { listSandboxes } from "./sandboxes.ts";
import { scansRouter } from "./scans.ts";
import type { ScanDeps } from "./scans.ts";
import { petChannel } from "./sse.ts";
import type { ReportChain } from "./solana/chain.ts";
import { isStoreReady, verdictsForHosts } from "./store.ts";
import { chooseForWarning, openWarning, warningsFor } from "./warnings.ts";
import { SupportService, configureSupport } from "./support/service.ts";
import { createCallRouter } from "./calls/router.ts";

const GREETINGS = [
  "Hi there!",
  "Hello from the server!",
  "Keep going, you're doing great.",
  "Time for a stretch?",
  "*happy wiggle*",
  "Got a sketchy link? Drop it on me.",
];

export type AppDeps = ScanDeps & {
  authLimit: Limiter;
  modelSettings?: ModelSettingsStore;
  sandboxes?: SandboxLister;
  reports?: ReportStore;
  /** Solana client for community reports; null or absent = Postgres only. */
  chain?: ReportChain | null;
  reportLimit?: Limiter;
};

export function createApp(deps: AppDeps) {
  const app = express();

  // How many reverse proxies sit in front, so req.ip (used for rate limits) is the client.
  app.set("trust proxy", config.trustProxyHops);
  app.use(cors());
  const calls = createCallRouter({ accounts: deps.accounts });
  app.locals.calls = calls;
  const support = new SupportService(deps.redis, calls.deliverSupport).start();
  app.locals.support = support;
  configureSupport(support);
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

  // Community reports: tallies for anyone, votes from approved accounts.
  const reports = deps.reports ?? createReportStore(deps.db);
  app.use(
    "/api/reports",
    reportsRouter({
      accounts: deps.accounts,
      reports,
      chain: deps.chain ?? null,
      limit: deps.reportLimit ?? redisLimiter(deps.redis, REPORTS_PER_MINUTE),
    }),
  );

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

  // Polled by the extension while a page it reported is analysed, so it can
  // warn over the page once the verdict is in. Not counted as a visit.
  app.post("/api/check/status", signedIn, requireStore, async (req, res) => {
    res.json(await lookupVisit(requireString(req.body?.url, "url", 8192)));
  });

  // The extension reports the page in the browser's active tab whenever it
  // changes, so the pet can stop to look over a page while it's checked.
  app.post("/api/pet/focus", signedIn, (req, res) => {
    const url = req.body?.url === null ? null : requireString(req.body?.url, "url", 8192);
    focus.set(userOf(res).id, url);
    res.status(204).end();
  });

  // Desktop pets subscribe here for their user's alerts, the pages their
  // browser is blocking, and whether the page in their active tab is being
  // checked ("focus").
  app.get("/api/pet/stream", signedIn, (req, res) => {
    const user = userOf(res);
    const send = petChannel.attach(req, res, user.id);
    send("warnings", warningsFor(user.id));
    send("focus", focus.of(user.id));
  });

  // Opened by the extension's blocked page, which keeps the response (an
  // event stream) open for as long as the page is blocked.
  app.post("/api/pet/warnings", signedIn, (req, res) => {
    const late = req.body?.late ?? false;
    if (typeof late !== "boolean") throw new HttpError(400, '"late" must be a boolean');
    openWarning(req, res, userOf(res), {
      url: requireString(req.body?.url, "url", 8192),
      host: requireString(req.body?.host, "host", 500),
      reason: optionalString(req.body?.reason, "reason", 2000) ?? "",
      late,
    });
  });

  // A pet's answer to a blocked page: leave it, or continue anyway.
  app.post("/api/pet/warnings/:id/choice", signedIn, (req, res) => {
    const choice = requireEnum(req.body?.choice, WARNING_CHOICES, "choice");
    if (!chooseForWarning(userOf(res), String(req.params.id), choice)) {
      throw new HttpError(404, "That page isn't blocked anymore");
    }
    res.status(204).end();
  });

  // Sign-in first: the admin UI calls these while signed out.
  app.use("/api/admin", adminAuthRouter());
  const modelSettings = deps.modelSettings ?? createModelSettings(deps.db, deps.redis);
  const sandboxes = deps.sandboxes ?? ((limit: number) => listSandboxes(deps.db, deps.redis, limit));
  app.use(
    "/api/admin",
    requireAdmin,
    adminRouter(deps.accounts, modelSettings, sandboxes, calls.revoke, adminReports(reports, verdictsForHosts)),
  );

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
