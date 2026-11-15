import type {
  AdminAccountsResponse,
  AdminModelSettings,
  AdminSandboxesResponse,
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

/** Fired on window when the API says the admin session is gone. */
export const SIGNED_OUT = "ladybug:signed-out";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  // Signed out (session expired, or the password changed): back to the sign-in page.
  if (res.status === 401 && !path.startsWith("/api/admin/login")) window.dispatchEvent(new Event(SIGNED_OUT));
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
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
  session: () => request<AdminSession>("/api/admin/session"),

  login: (password: string) =>
    request<void>("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) }),

  logout: () => request<void>("/api/admin/logout", { method: "POST" }),

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

  users: () => request<AdminAccountsResponse>("/api/admin/users"),

  approveUser: (id: string) => request<unknown>(`/api/admin/users/${id}/approve`, { method: "POST" }),

  rejectUser: (id: string) => request<unknown>(`/api/admin/users/${id}/reject`, { method: "POST" }),

  deleteUser: (id: string) => request<void>(`/api/admin/users/${id}`, { method: "DELETE" }),

  setUserCalls: (id: string, enabled: boolean) =>
    request<unknown>(`/api/admin/users/${id}/calls`, { method: "PUT", body: JSON.stringify({ enabled }) }),

  sandboxes: (limit: number) => request<AdminSandboxesResponse>(`/api/admin/sandboxes${query({ limit })}`),

  modelSettings: () => request<AdminModelSettings>("/api/admin/settings/model"),

  setModel: (model: string | null) =>
    request<AdminModelSettings>("/api/admin/settings/model", { method: "PUT", body: JSON.stringify({ model }) }),

  check: (url: string) =>
    request<CheckResponse>("/api/admin/check", { method: "POST", body: JSON.stringify({ url }) }),
};
