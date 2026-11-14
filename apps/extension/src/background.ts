import type { ApiError, CheckRequest, CheckResponse } from "@ladybug/shared";
import { addRecent, getAuth, getSettings, setAuth } from "./settings";
import type { RecentCheck } from "./settings";

// Service worker: reports every top-level page the user visits to the Ladybug
// server, as the signed-in user. The server decides whether that user's
// desktop pet should raise an alert.

/** Ignore the same URL in the same tab twice within this window (redirect/SPA noise). */
const DEDUPE_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

const lastReported = new Map<number, { url: string; at: number }>();

type Badge = { text: string; color: string; title: string };

function badgeFor(result: RecentCheck["result"]): Badge {
  switch (result.status) {
    case "known":
      return result.verdict === "unsafe"
        ? { text: "!", color: "#d93025", title: "Ladybug: this page is flagged as unsafe" }
        : { text: "", color: "#000", title: "Ladybug: known safe" };
    case "pending":
      return { text: "…", color: "#e8a317", title: "Ladybug: checking this page" };
    case "skipped":
      return { text: "", color: "#000", title: `Ladybug: not checked (${result.reason})` };
    case "error":
      return { text: "?", color: "#80868b", title: `Ladybug: ${result.error}` };
  }
}

async function setBadge(tabId: number, result: RecentCheck["result"]) {
  const badge = badgeFor(result);
  try {
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    await chrome.action.setTitle({ tabId, title: badge.title });
  } catch {
    // The tab may have closed in the meantime.
  }
}

async function report(tabId: number, url: string) {
  if (!/^https?:/i.test(url)) return;

  const now = Date.now();
  const last = lastReported.get(tabId);
  if (last && last.url === url && now - last.at < DEDUPE_MS) return;
  lastReported.set(tabId, { url, at: now });

  const settings = await getSettings();
  if (!settings.enabled) return;
  // Don't report the server's own pages (e.g. the admin UI).
  if (url.startsWith(`${settings.serverUrl}/`)) return;

  let title: string | undefined;
  try {
    title = (await chrome.tabs.get(tabId)).title || undefined;
  } catch {
    // Not available yet; the server doesn't need it.
  }

  // Nothing is reported until the user signs in from the popup.
  const auth = await getAuth();
  if (!auth) {
    await setBadge(tabId, { status: "error", error: "Sign in from the Ladybug popup to check pages" });
    return;
  }

  let result: RecentCheck["result"];
  try {
    const body: CheckRequest = { url, title };
    const res = await fetch(`${settings.serverUrl}/api/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json()) as CheckResponse | ApiError;
    if ("error" in data && data.code) {
      // Not allowed (yet). The popup says why; don't fill the list with it.
      if (data.code === "signed_out") await setAuth(null);
      else if (auth.account.status !== data.code) {
        await setAuth({ ...auth, account: { ...auth.account, status: data.code } });
      }
      await setBadge(tabId, { status: "error", error: data.error });
      return;
    }
    if ("error" in data) {
      result = { status: "error", error: data.error };
    } else {
      result = data;
      if (auth.account.status !== "approved") await setAuth({ ...auth, account: { ...auth.account, status: "approved" } });
    }
  } catch (error) {
    result = {
      status: "error",
      error: `Can't reach ${settings.serverUrl} (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  await Promise.all([addRecent({ url, at: now, result }), setBadge(tabId, result)]);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || details.documentLifecycle === "prerender") return;
  void report(details.tabId, details.url);
});

// Single-page apps change the URL without a new navigation.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  void report(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastReported.delete(tabId));
