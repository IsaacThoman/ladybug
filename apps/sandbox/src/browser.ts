import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";
import type { BrowserContext, Dialog, Download, Frame, Page, Request, Response } from "playwright";
import type {
  ActionResponse,
  BrowserEvents,
  ClickRequest,
  ContextResponse,
  DomSnapshot,
  NavigateRequest,
  NavigateResponse,
  TypeRequest,
} from "@ladybug/shared";
import type { Config } from "./config.ts";
import { extractDom } from "./dom.ts";
import type { Header, TrackedRequest } from "./har.ts";
import { instrumentPage, REPORT_BINDING } from "./instrument.ts";
import type { InstrumentReport } from "./instrument.ts";
import { Mutex } from "./mutex.ts";
import type { NetworkSetup } from "./network.ts";
import { proxyUsername } from "./network.ts";
import { errorMessage, now, pushCapped, sleep, truncate } from "./util.ts";

const MAX_REQUESTS = 2000;
const MAX_POST_DATA = 2048;
const MAX_EVENTS = 500;
const MAX_CONSOLE_TEXT = 2000;
const NETWORK_IDLE_MS = 5_000;
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_DEVICE = devices["iPhone 15 Pro"] ?? devices["iPhone 14 Pro"] ?? devices["iPhone 13"];

function emptyEvents(): BrowserEvents {
  return {
    dialogs: [],
    console: [],
    clipboardWrites: [],
    permissionRequests: [],
    popups: [],
    downloads: [],
    dynamicCode: [],
    decodes: [],
    pageErrors: [],
  };
}

function toHeaders(headers: Record<string, string>): Header[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/** Keeps a downloaded file name inside the downloads dir and readable. */
export function sanitizeFilename(name: string) {
  const base = path.basename(name.replaceAll("\\", "/"));
  const cleaned = Array.from(base, (ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? "_" : ch))
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "download";
}

async function uniquePath(dir: string, name: string) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await fs.lstat(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/**
 * One headful Chromium with a persistent (temp) profile, the request log and
 * the behaviour events. Browser-touching operations are serialized.
 */
export class BrowserManager {
  readonly config: Config;
  readonly network: NetworkSetup;
  readonly mutex = new Mutex();
  readonly events: BrowserEvents = emptyEvents();
  readonly requests: TrackedRequest[] = [];
  droppedRequests = 0;

  #context: BrowserContext | null = null;
  #profileDir: string | null = null;
  #mobile = false;
  #activePage: Page | null = null;
  #tracked = new WeakMap<Request, TrackedRequest>();
  #closing = false;
  /** Set while the daemon itself opens a page, so it isn't counted as a popup. */
  #openingOwnPage = false;

  constructor(config: Config, network: NetworkSetup) {
    this.config = config;
    this.network = network;
  }

  get alive() {
    return this.#context !== null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  async start(mobile = false) {
    await this.#closeContext();
    this.#mobile = mobile;
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.config.downloadsDir, { recursive: true });
    this.#profileDir = await fs.mkdtemp(path.join(this.config.stateDir, "profile-"));

    const { proxyUrl } = this.config;
    const device = mobile ? MOBILE_DEVICE : null;
    const context = await chromium.launchPersistentContext(this.#profileDir, {
      headless: this.config.headless,
      // Playwright adds --no-sandbox because chromiumSandbox defaults to false.
      // Production hardening: run with the Chrome sandbox (needs a seccomp
      // profile / user namespaces in the pod). Today the container is the boundary.
      chromiumSandbox: false,
      args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--no-first-run"],
      ignoreDefaultArgs: ["--enable-automation"],
      acceptDownloads: true,
      downloadsPath: path.join(this.config.stateDir, "tmp-downloads"),
      locale: "en-US",
      ...(device
        ? {
            viewport: device.viewport,
            screen: device.viewport,
            userAgent: device.userAgent,
            deviceScaleFactor: device.deviceScaleFactor,
            isMobile: device.isMobile,
            hasTouch: device.hasTouch,
          }
        : { viewport: DESKTOP_VIEWPORT, screen: DESKTOP_VIEWPORT }),
      ...(proxyUrl
        ? {
            proxy: { server: proxyUrl, username: proxyUsername(this.config), password: "x" },
            ignoreHTTPSErrors: !this.network.caTrusted,
          }
        : {}),
    });
    this.#context = context;

    await context.exposeBinding(REPORT_BINDING, (_source, payload: InstrumentReport) => this.#onReport(payload));
    await context.addInitScript(instrumentPage, REPORT_BINDING);

    context.on("request", (req) => this.#onRequest(req));
    context.on("response", (res) => this.#onResponse(res));
    context.on("requestfinished", (req) => void this.#onRequestDone(req, null));
    context.on("requestfailed", (req) => void this.#onRequestDone(req, req.failure()?.errorText ?? "failed"));
    context.on("page", (page) => this.#onPage(page, !this.#openingOwnPage));
    context.on("close", () => {
      if (this.#context === context) {
        this.#context = null;
        this.#activePage = null;
        if (!this.#closing) console.warn("[sandbox] browser context closed unexpectedly");
      }
    });

    for (const page of context.pages()) this.#onPage(page, false);
    if (!this.#activePage) await this.#newPage(context);
  }

  async #closeContext() {
    const context = this.#context;
    const profileDir = this.#profileDir;
    this.#context = null;
    this.#activePage = null;
    this.#profileDir = null;
    if (context) {
      this.#closing = true;
      try {
        await context.close();
      } catch {
        // already dead
      } finally {
        this.#closing = false;
      }
    }
    if (profileDir) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async shutdown() {
    await this.#closeContext();
  }

  async #page(): Promise<Page> {
    if (!this.#context) await this.start(this.#mobile);
    const context = this.#context!;
    if (this.#activePage && !this.#activePage.isClosed()) return this.#activePage;
    const open = context.pages().filter((p) => !p.isClosed());
    this.#activePage = open.at(-1) ?? (await this.#newPage(context));
    return this.#activePage;
  }

  async #newPage(context: BrowserContext) {
    this.#openingOwnPage = true;
    try {
      const page = await context.newPage();
      this.#activePage = page;
      return page;
    } finally {
      this.#openingOwnPage = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Listeners

  #onPage(page: Page, isPopup: boolean) {
    this.#activePage = page;
    if (isPopup) {
      const record = { url: page.url(), at: now() };
      pushCapped(this.events.popups, record, MAX_EVENTS);
      if (record.url === "about:blank" || record.url === "") {
        const update = (frame: Frame) => {
          if (frame !== page.mainFrame()) return;
          record.url = frame.url();
          page.off("framenavigated", update);
        };
        page.on("framenavigated", update);
      }
    }
    page.on("dialog", (dialog) => void this.#onDialog(dialog));
    page.on("download", (download) => void this.#onDownload(download));
    page.on("console", (msg) => {
      pushCapped(
        this.events.console,
        { type: msg.type(), text: truncate(msg.text(), MAX_CONSOLE_TEXT), at: now() },
        MAX_EVENTS,
      );
    });
    page.on("pageerror", (error) => {
      pushCapped(this.events.pageErrors, { message: truncate(errorMessage(error), MAX_CONSOLE_TEXT), at: now() }, MAX_EVENTS);
    });
    page.on("close", () => {
      if (this.#activePage === page) {
        const open = this.#context?.pages().filter((p) => !p.isClosed()) ?? [];
        this.#activePage = open.at(-1) ?? null;
      }
    });
  }

  async #onDialog(dialog: Dialog) {
    pushCapped(
      this.events.dialogs,
      { type: dialog.type(), message: truncate(dialog.message(), MAX_CONSOLE_TEXT), at: now() },
      MAX_EVENTS,
    );
    try {
      // Dismissing beforeunload would cancel the navigation, so let it through.
      if (dialog.type() === "beforeunload") await dialog.accept();
      else await dialog.dismiss();
    } catch {
      // page went away
    }
  }

  async #onDownload(download: Download) {
    const record: BrowserEvents["downloads"][number] = {
      url: download.url(),
      suggestedFilename: download.suggestedFilename(),
      path: null,
      at: now(),
    };
    pushCapped(this.events.downloads, record, MAX_EVENTS);
    try {
      await fs.mkdir(this.config.downloadsDir, { recursive: true });
      const target = await uniquePath(this.config.downloadsDir, sanitizeFilename(download.suggestedFilename()));
      await download.saveAs(target);
      record.path = `downloads/${path.basename(target)}`;
    } catch (error) {
      console.warn(`[sandbox] download failed: ${errorMessage(error)}`);
    }
  }

  #onReport(payload: InstrumentReport) {
    if (!payload || typeof payload !== "object") return;
    const at = now();
    switch (payload.kind) {
      case "dynamicCode":
        pushCapped(
          this.events.dynamicCode,
          { kind: String(payload.type), snippet: truncate(String(payload.snippet), 500), length: Number(payload.length) || 0, at },
          MAX_EVENTS,
        );
        break;
      case "decode":
        pushCapped(this.events.decodes, { kind: String(payload.type), length: Number(payload.length) || 0, at }, MAX_EVENTS);
        break;
      case "clipboard": {
        const text = truncate(String(payload.text), 10_000);
        const last = this.events.clipboardWrites.at(-1);
        // execCommand("copy") and its copy handler's setData often report the same text.
        if (last && last.text === text && Date.now() - Date.parse(last.at) < 2_000) break;
        pushCapped(this.events.clipboardWrites, { text, at }, MAX_EVENTS);
        break;
      }
      case "permission":
        pushCapped(this.events.permissionRequests, { permission: truncate(String(payload.permission), 100), at }, MAX_EVENTS);
        break;
    }
  }

  #onRequest(req: Request) {
    if (this.requests.length >= MAX_REQUESTS) {
      this.droppedRequests++;
      return;
    }
    let frameUrl: string | null = null;
    try {
      frameUrl = req.frame().url();
    } catch {
      // service worker requests have no frame
    }
    const postData = req.postData();
    const tracked: TrackedRequest = {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status: null,
      mimeType: null,
      postData: postData === null ? null : truncate(postData, MAX_POST_DATA),
      failure: null,
      isNavigation: req.isNavigationRequest(),
      frameUrl,
      startedAt: now(),
      durationMs: null,
      responseSize: null,
      remoteAddress: null,
      requestHeaders: toHeaders(req.headers()),
      responseHeaders: [],
      statusText: "",
      httpVersion: "HTTP/1.1",
      redirectUrl: "",
    };
    this.#tracked.set(req, tracked);
    this.requests.push(tracked);
  }

  #onResponse(res: Response) {
    const tracked = this.#tracked.get(res.request());
    if (!tracked) return;
    tracked.status = res.status();
    tracked.statusText = res.statusText();
    const headers = res.headers();
    tracked.responseHeaders = toHeaders(headers);
    tracked.mimeType = headers["content-type"]?.split(";")[0]?.trim() || null;
    tracked.redirectUrl = headers["location"] ?? "";
    void res
      .serverAddr()
      .then((addr) => {
        if (addr) tracked.remoteAddress = addr.ipAddress.includes(":") ? `[${addr.ipAddress}]:${addr.port}` : `${addr.ipAddress}:${addr.port}`;
      })
      .catch(() => undefined);
  }

  async #onRequestDone(req: Request, failure: string | null) {
    const tracked = this.#tracked.get(req);
    if (!tracked) return;
    tracked.failure = failure;
    try {
      const timing = req.timing();
      if (timing.responseEnd > 0) tracked.durationMs = Math.round(timing.responseEnd);
      else tracked.durationMs = Date.now() - Date.parse(tracked.startedAt);
    } catch {
      tracked.durationMs = Date.now() - Date.parse(tracked.startedAt);
    }
    if (failure) return;
    try {
      const sizes = await req.sizes();
      tracked.responseSize = sizes.responseBodySize;
    } catch {
      // response body evicted
    }
  }

  // ---------------------------------------------------------------------------
  // Operations (callers hold the mutex)

  async navigate(body: NavigateRequest): Promise<NavigateResponse> {
    const page = await this.#page();
    const waitUntil = body.waitUntil ?? "load";
    const timeout = typeof body.timeoutMs === "number" ? Math.min(Math.max(body.timeoutMs, 1_000), 120_000) : 30_000;

    const chain: string[] = [];
    const push = (url: string) => {
      if (url && chain.at(-1) !== url) chain.push(url);
    };
    // Main-frame navigation requests catch every HTTP hop, including those of
    // later client-side redirects; framenavigated catches data:/about:/history ones.
    const onRequest = (req: Request) => {
      try {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) push(req.url());
      } catch {
        // ignore
      }
    };
    let committed = false;
    const onNavigated = (frame: Frame) => {
      // Chrome's net-error page commits as chrome-error://; that's not a destination.
      if (frame !== page.mainFrame() || frame.url().startsWith("chrome-error:")) return;
      committed = true;
      push(frame.url());
    };
    page.on("request", onRequest);
    page.on("framenavigated", onNavigated);

    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await page.goto(body.url, { waitUntil, timeout });
      status = response?.status() ?? null;
    } catch (e) {
      error = errorMessage(e);
    }
    if (!page.isClosed()) {
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS }).catch(() => undefined);
    }
    page.off("request", onRequest);
    page.off("framenavigated", onNavigated);

    if (chain.length === 0 || (chain[0] !== body.url && !this.#sameUrl(chain[0], body.url))) chain.unshift(body.url);

    // Nothing committed (a download, or a failure before any response): the
    // tab still shows the previous page, so report where the request ended.
    const current = page.isClosed() ? "" : page.url();
    const finalUrl = committed && current && !current.startsWith("chrome-error:") ? current : (chain.at(-1) ?? body.url);
    if (chain.at(-1) !== finalUrl && finalUrl !== "about:blank") chain.push(finalUrl);
    let title = "";
    try {
      title = committed && !page.isClosed() ? await page.title() : "";
    } catch {
      // navigating
    }
    return { finalUrl, status, title, redirectChain: chain, error };
  }

  #sameUrl(a: string | undefined, b: string) {
    try {
      return a !== undefined && new URL(a).href === new URL(b).href;
    } catch {
      return false;
    }
  }

  async #settle(page: Page) {
    await sleep(300);
    const active = this.#activePage && !this.#activePage.isClosed() ? this.#activePage : page;
    await active.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
    return active;
  }

  async click(body: ClickRequest): Promise<ActionResponse> {
    const page = await this.#page();
    try {
      if (typeof body.selector === "string") {
        await page.click(body.selector, { timeout: 10_000 });
      } else if (typeof body.x === "number" && typeof body.y === "number") {
        await page.mouse.click(body.x, body.y);
      } else {
        return { ok: false, url: page.url(), error: "selector or x,y required" };
      }
      const active = await this.#settle(page);
      return { ok: true, url: active.url(), error: null };
    } catch (e) {
      return { ok: false, url: this.#safeUrl(), error: errorMessage(e) };
    }
  }

  async type(body: TypeRequest): Promise<ActionResponse> {
    const page = await this.#page();
    try {
      if (typeof body.selector === "string") {
        await page.focus(body.selector, { timeout: 10_000 });
      } else if (typeof body.x === "number" && typeof body.y === "number") {
        await page.mouse.click(body.x, body.y);
      }
      await page.keyboard.type(String(body.text ?? ""), { delay: 15 });
      if (body.pressEnter) await page.keyboard.press("Enter");
      const active = await this.#settle(page);
      return { ok: true, url: active.url(), error: null };
    } catch (e) {
      return { ok: false, url: this.#safeUrl(), error: errorMessage(e) };
    }
  }

  #safeUrl() {
    try {
      return this.#activePage?.url() ?? "";
    } catch {
      return "";
    }
  }

  async newContext(mobile: boolean): Promise<ContextResponse> {
    await this.start(mobile);
    const page = await this.#page();
    let userAgent: string;
    try {
      userAgent = await page.evaluate(() => navigator.userAgent);
    } catch {
      userAgent = MOBILE_DEVICE && mobile ? MOBILE_DEVICE.userAgent : "";
    }
    return { ok: true, userAgent };
  }

  async screenshot(fullPage: boolean): Promise<Buffer> {
    const page = await this.#page();
    return page.screenshot({ type: "png", fullPage, scale: "css", timeout: 20_000, animations: "disabled" });
  }

  async dom(maxChars: number): Promise<DomSnapshot> {
    const page = await this.#page();
    const read = async () => {
      const html = await page.content();
      const extract = await page.evaluate(extractDom, Math.floor(maxChars / 4));
      return { ...extract, html: html.slice(0, maxChars), truncated: html.length > maxChars };
    };
    try {
      return await read();
    } catch {
      // "Execution context was destroyed" mid-navigation: wait and retry once.
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      return read();
    }
  }
}
