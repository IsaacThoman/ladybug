import { artifactPath, eventsPath } from "@ladybug/shared";
import type { ApiError, AuthResponse, CreateScanResponse, MeResponse, ScanListResponse, ScanResponse } from "@ladybug/shared";
import { getSession, setAccountStatus, setSession } from "./session.ts";

export const API_BASE = (import.meta.env.VITE_SERVER_URL ?? "").replace(/\/+$/, "");

export const artifactUrl = (scanId: string, key: string) => API_BASE + artifactPath(scanId, key);
export const eventsUrl = (scanId: string) => API_BASE + eventsPath(scanId);

export type ApiFailure =
  | { kind: "unreachable" }
  | { kind: "unauthorized"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "http"; status: number; message: string };

export class ApiRequestError extends Error {
  failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super("message" in failure ? failure.message : "Can't reach the ladybug server");
    this.failure = failure;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const session = getSession();
  const headers = new Headers(init?.headers);
  if (session && !headers.has("authorization")) headers.set("authorization", `Bearer ${session.token}`);
  try {
    res = await fetch(API_BASE + path, { ...init, headers });
  } catch {
    throw new ApiRequestError({ kind: "unreachable" });
  }
  if (res.ok) {
    try {
      return (await res.json()) as T;
    } catch {
      // A dev proxy with no upstream, or an HTML error page.
      throw new ApiRequestError({ kind: "unreachable" });
    }
  }
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (typeof body.error === "string") message = body.error;
    // Keep the stored session in line with what the server says about it.
    if (body.code === "signed_out" && session) setSession(null);
    else if (body.code === "pending" || body.code === "rejected") setAccountStatus(body.code);
  } catch {
    // Not JSON: keep the generic message.
  }
  if (res.status === 401 || res.status === 403) throw new ApiRequestError({ kind: "unauthorized", message });
  if (res.status === 404) throw new ApiRequestError({ kind: "not_found", message });
  if (res.status === 429) throw new ApiRequestError({ kind: "rate_limited", message });
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ApiRequestError({ kind: "unreachable" });
  }
  throw new ApiRequestError({ kind: "http", status: res.status, message });
}

export const getScan = (scanId: string, signal?: AbortSignal) =>
  request<ScanResponse>(`/api/scans/${encodeURIComponent(scanId)}`, { signal });

export const listScans = (limit = 20, signal?: AbortSignal) =>
  request<ScanListResponse>(`/api/scans?limit=${limit}`, { signal });

export const createScan = (url: string) =>
  request<CreateScanResponse>("/api/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });

/** Signs in, or creates an account, and stores the session. */
export async function signIn(mode: "login" | "signup", username: string, password: string) {
  const res = await request<AuthResponse>(`/api/auth/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, client: "web" }),
  });
  setSession({ token: res.token, account: res.account });
}

export async function signOut() {
  const session = getSession();
  setSession(null);
  if (!session) return;
  await fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
  }).catch(() => {});
}

/** Picks up an approval (or a revoked session) since the page was opened. */
export async function refreshAccount() {
  if (!getSession()) return;
  const { account } = await request<MeResponse>("/api/auth/me");
  setAccountStatus(account.status);
}

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
