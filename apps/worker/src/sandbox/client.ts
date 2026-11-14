import type {
  ActionResponse,
  BrowserEvents,
  ClickRequest,
  ContextResponse,
  DomSnapshot,
  ExecRequest,
  ExecResponse,
  FilesResponse,
  NavigateRequest,
  NavigateResponse,
  RequestsResponse,
  TypeRequest,
} from "@ladybug/shared";

/** Typed client for the in-sandbox daemon (apps/sandbox). */
export class DaemonClient {
  readonly baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private async request(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`sandbox ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  }

  private async json<T>(path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  async healthy() {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; browser?: boolean };
      return body.ok === true && body.browser !== false;
    } catch {
      return false;
    }
  }

  navigate(body: NavigateRequest) {
    return this.json<NavigateResponse>("/browser/navigate", { body, timeoutMs: (body.timeoutMs ?? 30_000) + 20_000 });
  }
  click(body: ClickRequest) {
    return this.json<ActionResponse>("/browser/click", { body });
  }
  type(body: TypeRequest) {
    return this.json<ActionResponse>("/browser/type", { body });
  }
  setContext(mobile: boolean) {
    return this.json<ContextResponse>("/browser/context", { body: { mobile } });
  }
  async screenshot(fullPage = false): Promise<Buffer> {
    const res = await this.request(`/browser/screenshot?fullPage=${fullPage ? 1 : 0}`);
    return Buffer.from(await res.arrayBuffer());
  }
  dom(maxChars = 50_000) {
    return this.json<DomSnapshot>(`/browser/dom?maxChars=${maxChars}`);
  }
  requests() {
    return this.json<RequestsResponse>("/browser/requests?format=json");
  }
  async har(): Promise<string> {
    return (await this.request("/browser/requests?format=har")).text();
  }
  events() {
    return this.json<BrowserEvents>("/browser/events");
  }
  exec(body: ExecRequest) {
    return this.json<ExecResponse>("/exec", { body, timeoutMs: (body.timeoutMs ?? 30_000) + 10_000 });
  }
  files() {
    return this.json<FilesResponse>("/files");
  }
  async file(path: string): Promise<Buffer> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.request(`/files/${encoded}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
