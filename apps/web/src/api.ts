import { API_KEY_HEADER, artifactPath, eventsPath } from "@ladybug/shared";
import type { ApiError, CreateScanResponse, ScanListResponse, ScanResponse } from "@ladybug/shared";

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
  try {
    res = await fetch(API_BASE + path, init);
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

export const createScan = (url: string, apiKey: string) =>
  request<CreateScanResponse>("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { [API_KEY_HEADER]: apiKey } : {}),
    },
    body: JSON.stringify({ url }),
  });

const API_KEY_STORAGE = "ladybug.apiKey";

export function loadApiKey(): string {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function saveApiKey(key: string) {
  try {
    if (key) window.localStorage.setItem(API_KEY_STORAGE, key);
    else window.localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Storage blocked: the key lives for this session only.
  }
}

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
