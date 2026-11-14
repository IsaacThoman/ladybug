import type {
  AdminLoginRequest,
  AdminSession,
  AdminSummary,
  CheckResponse,
  CheckTimeline,
  LogEvent,
  LogEventType,
  Page,
  UrlRecord,
  TimelineRange,
  UrlScope,
  Verdict,
} from "@ladybug/shared";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SIGNED_OUT = "ladybug:signed-out";

/** Called when the server says the session is gone, e.g. it expired or the password changed. */
export function onSignedOut(listener: () => void) {
  window.addEventListener(SIGNED_OUT, listener);
  return () => window.removeEventListener(SIGNED_OUT, listener);
}

async function request<T>(path: string, init?: RequestInit, { auth = true } = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401 && auth) window.dispatchEvent(new Event(SIGNED_OUT));
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

export type EventFilter = {
  q?: string;
  types?: LogEventType[];
  verdict?: Verdict;
};

export type UrlFilter = {
  q?: string;
  verdict?: Verdict;
};

export const api = {
  session: () => request<AdminSession>("/api/admin/session", undefined, { auth: false }),

  login: (password: string) =>
    request<void>(
      "/api/admin/login",
      { method: "POST", body: JSON.stringify({ password } satisfies AdminLoginRequest) },
      { auth: false },
    ),

  logout: () => request<void>("/api/admin/logout", { method: "POST" }, { auth: false }),

  summary: () => request<AdminSummary>("/api/admin/summary"),

  timeline: (range: TimelineRange) => request<CheckTimeline>(`/api/admin/timeline${query({ range })}`),

  events: (filter: EventFilter, page: number, perPage: number) =>
    request<Page<LogEvent>>(
      `/api/admin/events${query({
        q: filter.q,
        type: filter.types?.join(","),
        verdict: filter.verdict,
        page,
        perPage,
      })}`,
    ),

  urls: (filter: UrlFilter, page: number, perPage: number) =>
    request<Page<UrlRecord>>(`/api/admin/urls${query({ ...filter, page, perPage })}`),

  addUrl: (body: { url: string; scope: UrlScope; verdict: Verdict; reason?: string }) =>
    request<UrlRecord>("/api/admin/urls", { method: "POST", body: JSON.stringify(body) }),

  setVerdict: (id: string, verdict: Verdict) =>
    request<UrlRecord>(`/api/admin/urls/${id}`, {
      method: "PUT",
      body: JSON.stringify({ verdict }),
    }),

  deleteUrl: (id: string) => request<void>(`/api/admin/urls/${id}`, { method: "DELETE" }),

  check: (url: string) =>
    request<CheckResponse>("/api/admin/check", { method: "POST", body: JSON.stringify({ url }) }),
};
