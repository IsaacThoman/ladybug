import { DEFAULT_SERVER_PORT, PUBLIC_URL } from "@ladybug/shared";
import type { Account, ApiError, AuthResponse, CheckResponse, MeResponse } from "@ladybug/shared";

export type Settings = {
  /** Base URL of the Ladybugg server, without a trailing slash. */
  serverUrl: string;
  /** Whether page visits are reported at all. */
  enabled: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  // Release builds report to the hosted server; `npm run dev:extension` to localhost.
  // Either can be changed in the popup.
  serverUrl: import.meta.env.MODE === "development" ? `http://localhost:${DEFAULT_SERVER_PORT}` : PUBLIC_URL,
  enabled: true,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function saveSettings(settings: Partial<Settings>) {
  await chrome.storage.sync.set(settings);
}

export function normalizeServerUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must start with http:// or https://");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** One reported visit, shown in the popup. Kept in session storage only. */
export type RecentCheck = {
  url: string;
  at: number;
  result: CheckResponse | { status: "error"; error: string };
};

const RECENT_KEY = "recent";
const RECENT_LIMIT = 25;

export async function getRecent(): Promise<RecentCheck[]> {
  const stored = await chrome.storage.session.get(RECENT_KEY);
  return (stored[RECENT_KEY] as RecentCheck[] | undefined) ?? [];
}

export async function addRecent(check: RecentCheck) {
  const recent = await getRecent();
  await chrome.storage.session.set({ [RECENT_KEY]: [check, ...recent].slice(0, RECENT_LIMIT) });
}

// ---------------------------------------------------------------------------
// Account. The token is kept in local storage, never synced to other browsers.

export type Auth = { token: string; account: Account };

const AUTH_KEY = "auth";

export async function getAuth(): Promise<Auth | null> {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  return (stored[AUTH_KEY] as Auth | undefined) ?? null;
}

export async function setAuth(auth: Auth | null) {
  if (auth) await chrome.storage.local.set({ [AUTH_KEY]: auth });
  else await chrome.storage.local.remove(AUTH_KEY);
}

async function readError(res: Response) {
  const body = (await res.json().catch(() => ({}))) as Partial<ApiError>;
  return body.error ?? `Request failed (${res.status})`;
}

/** Signs in (or signs up) and stores the token. Throws with a message to show. */
export async function signIn(serverUrl: string, mode: "login" | "signup", username: string, password: string) {
  const res = await fetch(`${serverUrl}/api/auth/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, client: "extension" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(await readError(res));
  const auth = (await res.json()) as AuthResponse;
  await setAuth(auth);
  return auth;
}

export async function signOut(serverUrl: string) {
  const auth = await getAuth();
  await setAuth(null);
  if (!auth) return;
  await fetch(`${serverUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

/** Fetches the account's current status (an admin may have approved it). */
export async function refreshAccount(serverUrl: string): Promise<Auth | null> {
  const auth = await getAuth();
  if (!auth) return null;
  const res = await fetch(`${serverUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 401) {
    // Signed out on the server, or the account was deleted.
    await setAuth(null);
    return null;
  }
  if (!res.ok) return auth;
  const { account } = (await res.json()) as MeResponse;
  const next = { ...auth, account };
  await setAuth(next);
  return next;
}
