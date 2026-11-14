import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type {
  ClickRequest,
  ContextRequest,
  ExecRequest,
  FilesResponse,
  HealthzResponse,
  NavigateRequest,
  RequestsResponse,
  TypeRequest,
} from "@ladybug/shared";
import { SANDBOX_TOKEN_HEADER } from "@ladybug/shared";
import type { BrowserManager } from "./browser.ts";
import type { Config } from "./config.ts";
import { runExec } from "./exec.ts";
import { listFiles, resolveSandboxFile } from "./files.ts";
import { buildHar, toRecord } from "./har.ts";
import type { NetworkSetup } from "./network.ts";
import { childEnv } from "./network.ts";
import { errorMessage } from "./util.ts";

const VERSION = "0.0.0";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

/**
 * The token arrives as `Authorization: Bearer`, or in X-Sandbox-Token when the
 * worker comes through the Kubernetes API server's pod proxy, which keeps
 * Authorization for itself.
 */
function authorized(req: IncomingMessage, expected: Buffer) {
  const header = req.headers[SANDBOX_TOKEN_HEADER];
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const token = (typeof header === "string" ? header : bearer)?.trim();
  return timingSafeEqual(digest(token ?? ""), expected) && token !== undefined;
}

async function readJson<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {} as T;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `${name} is required`);
  return value;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function createServer(config: Config, browser: BrowserManager, network: NetworkSetup) {
  const expectedToken = digest(config.token);
  const execEnv = childEnv(config, network);
  const body = <T>(req: IncomingMessage) => readJson<T>(req, config.maxBodyBytes);
  const locked = <T>(task: () => Promise<T>) => browser.mutex.run(task);

  const routes: Record<string, Handler> = {
    "POST /browser/navigate": async (req, res) => {
      const input = await body<NavigateRequest>(req);
      const url = requireString(input.url, "url");
      sendJson(res, 200, await locked(() => browser.navigate({ ...input, url })));
    },

    "POST /browser/click": async (req, res) => {
      const input = await body<ClickRequest>(req);
      sendJson(res, 200, await locked(() => browser.click(input)));
    },

    "POST /browser/type": async (req, res) => {
      const input = await body<TypeRequest>(req);
      if (typeof input.text !== "string") throw new HttpError(400, "text is required");
      sendJson(res, 200, await locked(() => browser.type(input)));
    },

    "POST /browser/context": async (req, res) => {
      const input = await body<ContextRequest>(req);
      sendJson(res, 200, await locked(() => browser.newContext(input.mobile === true)));
    },

    "GET /browser/screenshot": async (_req, res, url) => {
      const fullPage = url.searchParams.get("fullPage") === "1" || url.searchParams.get("fullPage") === "true";
      const png = await locked(() => browser.screenshot(fullPage));
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store" });
      res.end(png);
    },

    "GET /browser/dom": async (_req, res, url) => {
      const raw = Number(url.searchParams.get("maxChars") ?? 50_000);
      const maxChars = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 5_000_000) : 50_000;
      sendJson(res, 200, await locked(() => browser.dom(maxChars)));
    },

    "GET /browser/requests": async (_req, res, url) => {
      if (url.searchParams.get("format") === "har") {
        sendJson(res, 200, buildHar(browser.requests, VERSION));
        return;
      }
      const response: RequestsResponse = { requests: browser.requests.map(toRecord) };
      sendJson(res, 200, response);
    },

    "GET /browser/events": async (_req, res) => {
      sendJson(res, 200, browser.events);
    },

    "POST /exec": async (req, res) => {
      const input = await body<ExecRequest>(req);
      const cmd = requireString(input.cmd, "cmd");
      await fs.mkdir(config.workDir, { recursive: true });
      sendJson(res, 200, await runExec({ cmd, timeoutMs: input.timeoutMs }, config.workDir, execEnv));
    },

    "GET /files": async (_req, res) => {
      const response: FilesResponse = { files: await listFiles(config) };
      sendJson(res, 200, response);
    },
  };

  const serveFile: Handler = async (_req, res, url) => {
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice("/files/".length));
    } catch {
      throw new HttpError(400, "bad path");
    }
    const file = await resolveSandboxFile(config, rel);
    if (!file) throw new HttpError(404, "file not found");
    const stat = await fs.stat(file);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": stat.size,
      "content-disposition": `attachment; filename="${path.basename(file).replace(/[^\w.() -]/g, "_")}"`,
      "cache-control": "no-store",
    });
    await new Promise<void>((resolve, reject) => {
      createReadStream(file).on("error", reject).on("end", resolve).pipe(res);
    });
  };

  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://sandbox.local");
    } catch {
      sendJson(res, 400, { error: "bad url" });
      return;
    }
    try {
      if (method === "GET" && url.pathname === "/healthz") {
        const response: HealthzResponse = { ok: true, browser: browser.alive };
        sendJson(res, 200, response);
        return;
      }
      if (!authorized(req, expectedToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const handler =
        routes[`${method} ${url.pathname}`] ??
        (method === "GET" && url.pathname.startsWith("/files/") ? serveFile : undefined);
      if (!handler) {
        sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
        return;
      }
      await handler(req, res, url);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(`[sandbox] ${method} ${url.pathname} failed:`, error);
      if (!res.headersSent) sendJson(res, status, { error: errorMessage(error) });
      else res.destroy();
    }
  });
}
