import type {
  ApiError,
  CheckRequest,
  CheckResponse,
  CheckStatusResponse,
  FocusRequest,
  UrlRecord,
} from "@ladybug/shared";
import { mountOverlay, unmountOverlay } from "./overlay";
import { addRecent, getAuth, getSettings, setAuth, updateRecent } from "./settings";
import type { Auth, RecentCheck, Settings } from "./settings";
import { isWarningMessage } from "./warning";
import type { Warning, WarningDetails, WarningMessage } from "./warning";

// Service worker: reports every top-level page the user visits to the Computerbug
// server, as the signed-in user. The server decides whether that user's
// desktop pet should raise an alert. Pages flagged as unsafe also get a
// warning over the page, with the ladybug, until the user leaves or continues.

/** Ignore the same URL in the same tab twice within this window (redirect/SPA noise). */
const DEDUPE_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** How often to ask about a page that's still being analysed. */
const POLL_MS = 5_000;
/** Stop asking after this long: the server gives up on scans after 10 minutes. */
const POLL_LIMIT_MS = 11 * 60_000;

type Visit = {
  url: string;
  at: number;
  /** Set once the page is known to be unsafe. */
  flagged?: UrlRecord;
};

const lastReported = new Map<number, Visit>();

type Badge = { text: string; color: string; title: string };

function badgeFor(result: RecentCheck["result"]): Badge {
  switch (result.status) {
    case "known":
      return result.verdict === "unsafe"
        ? { text: "!", color: "#d93025", title: "Computerbug: this page is flagged as unsafe" }
        : { text: "", color: "#000", title: "Computerbug: known safe" };
    case "pending":
      return { text: "…", color: "#e8a317", title: "Computerbug: checking this page" };
    case "skipped":
      return { text: "", color: "#000", title: `Computerbug: not checked (${result.reason})` };
    case "error":
      return { text: "?", color: "#80868b", title: `Computerbug: ${result.error}` };
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether this tab is still on the visit (it hasn't navigated or closed since). */
const isCurrent = (tabId: number, visit: Visit) => lastReported.get(tabId) === visit;

// ---------------------------------------------------------------------------
// Warnings over unsafe pages. Kept in session storage so a restarted service
// worker can still answer the warning page.

const WARNINGS_KEY = "warnings";
/** What the user chose "Continue anyway" on, until the browser closes. */
const ALLOWED_KEY = "allowed";

/** Session storage read-modify-writes, one at a time. */
let writes: Promise<unknown> = Promise.resolve();
function serially(write: () => Promise<void>) {
  const next = writes.then(write, write);
  writes = next.catch(() => {});
  return next;
}

async function getWarnings(): Promise<Record<string, Warning>> {
  const stored = await chrome.storage.session.get(WARNINGS_KEY);
  return (stored[WARNINGS_KEY] as Record<string, Warning> | undefined) ?? {};
}

/** Replaces the tab's warning with `warning`, or just drops it when null. */
function setTabWarning(tabId: number, warning: Warning | null) {
  return serially(async () => {
    const warnings = await getWarnings();
    for (const [token, existing] of Object.entries(warnings)) {
      if (existing.tabId === tabId) delete warnings[token];
    }
    if (warning) warnings[warning.token] = warning;
    await chrome.storage.session.set({ [WARNINGS_KEY]: warnings });
  });
}

async function getAllowed(): Promise<string[]> {
  const stored = await chrome.storage.session.get(ALLOWED_KEY);
  return (stored[ALLOWED_KEY] as string[] | undefined) ?? [];
}

function allow(key: string) {
  return serially(async () => {
    const allowed = await getAllowed();
    if (!allowed.includes(key)) await chrome.storage.session.set({ [ALLOWED_KEY]: [...allowed, key] });
  });
}

/** A host-wide record covers the whole site, so continuing past it does too. */
const allowKeyFor = (record: UrlRecord) => (record.scope === "host" ? `host:${record.host}` : `url:${record.url}`);

async function warn(tabId: number, visit: Visit, record: UrlRecord, late: boolean) {
  const allowKey = allowKeyFor(record);
  if ((await getAllowed()).includes(allowKey) || !isCurrent(tabId, visit)) return;
  const warning: Warning = {
    token: crypto.randomUUID(),
    tabId,
    url: visit.url,
    host: record.host,
    reason: record.reason,
    late,
    allowKey,
    mode: "overlay",
  };
  await setTabWarning(tabId, warning);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: mountOverlay,
      args: [chrome.runtime.getURL(`warning.html#${warning.token}`), warning.token],
      injectImmediately: true,
    });
  } catch {
    // The tab closed, or it's a page extensions can't touch (like the Web Store).
  }
}

/** Resolves once the tab's top frame navigates, or after `timeoutMs`. */
function nextNavigation(tabId: number, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const done = (details: { tabId: number; frameId: number }) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      finish();
    };
    const finish = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(done);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(done);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.webNavigation.onCommitted.addListener(done);
    chrome.webNavigation.onHistoryStateUpdated.addListener(done);
  });
}

const leaveToNewTab = (tabId: number) => chrome.tabs.update(tabId, { url: "chrome://newtab/" }).catch(() => {});

/** "Get me out of here": back to the previous page, or a new tab page if that's still the flagged site. */
async function leave(tabId: number, host: string) {
  try {
    const navigated = nextNavigation(tabId, 3_000);
    await chrome.tabs.goBack(tabId);
    await navigated;
    // Going back can land on the same site (it may have pushed history entries of its own).
    const { url } = await chrome.tabs.get(tabId);
    if (url && new URL(url).hostname !== host) return;
  } catch {
    // Nothing to go back to, e.g. the link opened in a new tab.
  }
  await leaveToNewTab(tabId);
}

async function onWarningMessage(message: WarningMessage, sender: chrome.runtime.MessageSender): Promise<WarningDetails> {
  const warning = (await getWarnings())[message.token];
  if (!warning || sender.tab?.id !== warning.tabId) return null;
  if (message.type === "warning:tampered") {
    // From the overlay in the page itself. Swap the page for the warning.
    if (sender.frameId !== 0 || warning.mode !== "overlay") return null;
    await setTabWarning(warning.tabId, { ...warning, mode: "page" });
    await chrome.tabs
      .update(warning.tabId, { url: chrome.runtime.getURL(`warning.html?page#${warning.token}`) })
      .catch(() => {});
    return null;
  }
  // Everything else comes from the warning page, in the tab it was shown in.
  if (!sender.url?.startsWith(chrome.runtime.getURL("warning.html"))) return null;
  switch (message.type) {
    case "warning:get":
      return { url: warning.url, host: warning.host, reason: warning.reason, late: warning.late };
    case "warning:continue":
      await allow(warning.allowKey);
      await setTabWarning(warning.tabId, null);
      if (warning.mode === "page") {
        await chrome.tabs.update(warning.tabId, { url: warning.url }).catch(() => {});
      } else {
        await chrome.scripting
          .executeScript({ target: { tabId: warning.tabId, frameIds: [0] }, func: unmountOverlay })
          .catch(() => {});
      }
      return null;
    case "warning:exit":
      // In page mode, going back would load the flagged page again.
      if (warning.mode === "page") await leaveToNewTab(warning.tabId);
      else await leave(warning.tabId, warning.host);
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isWarningMessage(message)) return;
  void onWarningMessage(message, sender).then(sendResponse, () => sendResponse(null));
  return true;
});

// ---------------------------------------------------------------------------
// Checks

async function post<T>(settings: Settings, auth: Auth, path: string, body: unknown) {
  const res = await fetch(`${settings.serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { res, data: (await res.json()) as T | ApiError };
}

/**
 * Asks about a page that's still being analysed until there's a verdict, then
 * updates the badge and the popup, and warns over the page if it's unsafe.
 */
async function watchPending(tabId: number, visit: Visit) {
  while (Date.now() - visit.at < POLL_LIMIT_MS) {
    await sleep(POLL_MS);
    if (!isCurrent(tabId, visit)) return;
    try {
      // Also keeps the service worker awake while waiting.
      await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
    if (!settings.enabled || !auth) return;

    let status: CheckStatusResponse;
    try {
      const { res, data } = await post<CheckStatusResponse>(settings, auth, "/api/check/status", { url: visit.url });
      // An older server without this endpoint, or the account lost access.
      if (!res.ok || "error" in data) return;
      status = data;
    } catch {
      continue; // Offline for a moment: try again.
    }
    if (status.status === "pending") continue;
    if (status.status !== "known" || !isCurrent(tabId, visit)) return;

    await Promise.all([updateRecent(visit.url, visit.at, status), setBadge(tabId, status)]);
    if (status.verdict === "unsafe") {
      visit.flagged = status.record;
      await warn(tabId, visit, status.record, true);
    }
    return;
  }
}

/** `newDocument`: a fresh page load, rather than a single-page app changing its URL. */
async function report(tabId: number, url: string, newDocument: boolean) {
  if (!/^https?:/i.test(url)) return;

  const now = Date.now();
  const last = lastReported.get(tabId);
  if (last && last.url === url && now - last.at < DEDUPE_MS) {
    // A quick reload of a flagged page: the new document needs the warning too.
    if (newDocument && last.flagged) void warn(tabId, last, last.flagged, false);
    return;
  }
  const visit: Visit = { url, at: now };
  lastReported.set(tabId, visit);

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
    await setBadge(tabId, { status: "error", error: "Sign in from the Computerbug popup to check pages" });
    return;
  }

  let result: RecentCheck["result"];
  try {
    const body: CheckRequest = { url, title };
    const { data } = await post<CheckResponse>(settings, auth, "/api/check", body);
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

  if (result.status === "known" && result.verdict === "unsafe") {
    visit.flagged = result.record;
    await warn(tabId, visit, result.record, false);
  } else if (result.status === "pending") {
    void watchPending(tabId, visit);
  }
}

// ---------------------------------------------------------------------------
// The active tab. The server tells the user's pet when the page in front of
// them is the one being checked, so it can stop and look it over.

/** The last report the server accepted, so each change is sent once. */
let reportedFocus: string | null = null;
let focusReports: Promise<void> = Promise.resolve();

/** The page in the active tab of the browser window used last, if there is one. */
async function activeTabUrl(): Promise<string | null> {
  try {
    const window = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
    return window.tabs?.find((tab) => tab.active)?.url ?? null;
  } catch {
    return null; // No browser windows left.
  }
}

async function reportFocus() {
  const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
  if (!auth) {
    reportedFocus = null;
    return;
  }
  let url = settings.enabled ? await activeTabUrl() : null;
  if (url && (!/^https?:/i.test(url) || url.startsWith(`${settings.serverUrl}/`))) url = null;
  const key = JSON.stringify([settings.serverUrl, auth.token, url]);
  if (key === reportedFocus) return;
  try {
    const body: FocusRequest = { url };
    const res = await fetch(`${settings.serverUrl}/api/pet/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    reportedFocus = res.ok ? key : null;
  } catch {
    reportedFocus = null; // Offline: the next change tries again.
  }
}

/** Tells the server what's in the active tab now, one report at a time. */
function syncFocus() {
  focusReports = focusReports.then(reportFocus, reportFocus);
}

chrome.tabs.onActivated.addListener(syncFocus);
chrome.windows.onFocusChanged.addListener((windowId) => {
  // Leaving the browser for another app doesn't change which page is open.
  if (windowId !== chrome.windows.WINDOW_ID_NONE) syncFocus();
});
// Signing in or out, or turning checks on or off.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local" || area === "sync") syncFocus();
});
// The worker may have restarted and forgotten what it last said.
syncFocus();

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || details.documentLifecycle === "prerender") return;
  void report(details.tabId, details.url, true);
  syncFocus();
});

// Single-page apps change the URL without a new navigation.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  void report(details.tabId, details.url, false);
  syncFocus();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastReported.delete(tabId);
  void setTabWarning(tabId, null);
  syncFocus();
});
