import type { HealthResponse } from "@ladybug/shared";
import {
  getAuth,
  getRecent,
  getSettings,
  normalizeServerUrl,
  refreshAccount,
  saveSettings,
  signIn,
  signOut,
} from "./settings";
import type { Auth, RecentCheck } from "./settings";
import "./popup.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = $<HTMLParagraphElement>("status");
const enabledEl = $<HTMLInputElement>("enabled");
const formEl = $<HTMLFormElement>("server-form");
const serverUrlEl = $<HTMLInputElement>("server-url");
const formErrorEl = $<HTMLParagraphElement>("form-error");
const recentEl = $<HTMLUListElement>("recent");
const recentEmptyEl = $<HTMLParagraphElement>("recent-empty");
const signedOutEl = $<HTMLElement>("signed-out");
const signedInEl = $<HTMLElement>("signed-in");
const authFormEl = $<HTMLFormElement>("auth-form");
const usernameEl = $<HTMLInputElement>("username");
const passwordEl = $<HTMLInputElement>("password");
const authErrorEl = $<HTMLParagraphElement>("auth-error");
const accountNameEl = $<HTMLElement>("account-name");
const accountStatusEl = $<HTMLParagraphElement>("account-status");
const signOutEl = $<HTMLButtonElement>("sign-out");

const STATUS_TEXT = {
  pending: "Waiting for an admin to approve your account. Ladybugg starts checking pages as soon as they do.",
  rejected: "An admin turned down this account, so pages aren't checked.",
} as const;

function renderAuth(auth: Auth | null) {
  signedOutEl.hidden = auth !== null;
  signedInEl.hidden = auth === null;
  if (!auth) return;
  accountNameEl.textContent = auth.account.username;
  const status = auth.account.status;
  accountStatusEl.hidden = status === "approved";
  if (status !== "approved") {
    accountStatusEl.dataset.status = status;
    accountStatusEl.textContent = STATUS_TEXT[status];
  }
}

function setStatus(state: "checking" | "ok" | "degraded" | "down", text: string) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

async function checkServer(serverUrl: string) {
  setStatus("checking", "Checking server…");
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(4_000) });
    const health = (await res.json()) as HealthResponse;
    if (health.typesense === "ready") setStatus("ok", "Connected");
    else setStatus("degraded", "Connected, but the server can't reach Typesense");
  } catch {
    setStatus("down", `Can't reach ${serverUrl}`);
  }
}

function describe(result: RecentCheck["result"]): { label: string; tone: string } {
  switch (result.status) {
    case "known":
      return result.verdict === "unsafe"
        ? { label: "Unsafe", tone: "danger" }
        : { label: "Safe", tone: "ok" };
    case "pending":
      return { label: "Checking", tone: "pending" };
    case "skipped":
      return { label: "Skipped", tone: "muted" };
    case "error":
      return { label: "Error", tone: "muted" };
  }
}

function timeAgo(at: number) {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function renderRecent(recent: RecentCheck[]) {
  recentEl.replaceChildren(
    ...recent.map((check) => {
      let host = check.url;
      let path = "";
      try {
        const url = new URL(check.url);
        host = url.host;
        path = url.pathname + url.search;
      } catch {
        // Show the raw string.
      }
      const { label, tone } = describe(check.result);
      const item = document.createElement("li");
      item.title = check.result.status === "error" ? check.result.error : check.url;

      const hostEl = document.createElement("span");
      hostEl.className = "host";
      hostEl.textContent = host;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.tone = tone;
      chip.textContent = label;
      const pathEl = document.createElement("span");
      pathEl.className = "path";
      pathEl.textContent = `${path} · ${timeAgo(check.at)}`;

      item.append(hostEl, chip, pathEl);
      return item;
    }),
  );
  recentEmptyEl.hidden = recent.length > 0;
}

async function init() {
  const settings = await getSettings();
  enabledEl.checked = settings.enabled;
  serverUrlEl.value = settings.serverUrl;
  void checkServer(settings.serverUrl);
  renderRecent(await getRecent());
  renderAuth(await getAuth());
  // An admin may have approved the account since the last look.
  void refreshAccount(settings.serverUrl).then(renderAuth).catch(() => {});

  authFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const mode = ((event.submitter as HTMLButtonElement | null)?.dataset.mode ?? "login") as "login" | "signup";
    const buttons = authFormEl.querySelectorAll("button");
    buttons.forEach((button) => (button.disabled = true));
    authErrorEl.hidden = true;
    void getSettings()
      .then(({ serverUrl }) => signIn(serverUrl, mode, usernameEl.value, passwordEl.value))
      .then((auth) => {
        passwordEl.value = "";
        renderAuth(auth);
      })
      .catch((error: unknown) => {
        authErrorEl.textContent =
          error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")
            ? "Can't reach the server."
            : error instanceof Error
              ? error.message
              : String(error);
        authErrorEl.hidden = false;
      })
      .finally(() => buttons.forEach((button) => (button.disabled = false)));
  });

  signOutEl.addEventListener("click", () => {
    void getSettings()
      .then(({ serverUrl }) => signOut(serverUrl))
      .then(() => renderAuth(null));
  });

  chrome.storage.local.onChanged.addListener(() => {
    void getAuth().then(renderAuth);
  });

  enabledEl.addEventListener("change", () => {
    void saveSettings({ enabled: enabledEl.checked });
  });

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const serverUrl = normalizeServerUrl(serverUrlEl.value);
      serverUrlEl.value = serverUrl;
      formErrorEl.hidden = true;
      const previous = settings.serverUrl;
      settings.serverUrl = serverUrl;
      // An account belongs to one server: switching servers signs out.
      if (serverUrl !== previous) void signOut(previous).then(() => renderAuth(null));
      void saveSettings({ serverUrl });
      void checkServer(serverUrl);
    } catch (error) {
      formErrorEl.textContent = error instanceof Error ? error.message : "Invalid URL";
      formErrorEl.hidden = false;
    }
  });

  chrome.storage.session.onChanged.addListener(() => {
    void getRecent().then(renderRecent);
  });
}

void init();
