import { DEFAULT_SERVER_PORT, PUBLIC_URL } from "@ladybug/shared";
import type { CheckResponse } from "@ladybug/shared";

export type Settings = {
  /** Base URL of the Ladybug server, without a trailing slash. */
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
