import {
  API_KEY_HEADER,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  PUBLIC_URL,
  eventsPath,
  isTerminalStatus,
} from "@ladybug/shared";
import type {
  ApiError,
  AuthResponse,
  CreateScanRequest,
  CreateScanResponse,
  GreetingResponse,
  PetAlert,
  ScanEvent,
  ScanResponse,
} from "@ladybug/shared";
import { getSession, setAccountStatus, setSession, subscribeSession } from "./session";

// Packaged builds use the hosted server, where the report pages share the
// API's origin. `npm run dev` talks to the local server and report page.
export const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? `http://localhost:${DEFAULT_SERVER_PORT}` : PUBLIC_URL);
export const WEB_URL =
  import.meta.env.VITE_WEB_URL ?? (import.meta.env.DEV ? `http://localhost:${DEFAULT_WEB_PORT}` : PUBLIC_URL);
const API_KEY = import.meta.env.VITE_API_KEY;

/** The server couldn't be reached at all. */
export class OfflineError extends Error {}

const FRIENDLY_ERRORS: Record<number, string> = {
  400: "That doesn't look like a link I can check.",
  401: "Sign in first, then I can check links.",
  403: "An admin still has to let you in.",
  429: "That's a lot of links! Give me a minute.",
};

const authHeaders = (): Record<string, string> => {
  const session = getSession();
  return session ? { Authorization: `Bearer ${session.token}` } : {};
};

/**
 * Keeps the stored session in line with an auth refusal: a 401 means the
 * token is gone (signed out, or the account was deleted), a 403 says why
 * the account can't be used yet.
 */
async function noteAuthFailure(res: Response) {
  if (res.status !== 401 && res.status !== 403) return;
  const body = (await res.clone().json().catch(() => ({}))) as Partial<ApiError>;
  if (body.code === "signed_out") setSession(null);
  else if (body.code === "pending" || body.code === "rejected") setAccountStatus(body.code);
}

/** Signs in, or creates an account, and stores the session. Errors carry a message to show. */
export async function signIn(mode: "login" | "signup", username: string, password: string) {
  const res = await request(`/api/auth/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, client: "desktop" }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<AuthResponse & ApiError>;
  if (!res.ok || !body.token || !body.account) throw new Error(body.error ?? "Something went wrong signing in.");
  setSession({ token: body.token, account: body.account });
}

export async function signOut() {
  const headers = authHeaders();
  setSession(null);
  await request("/api/auth/logout", { method: "POST", headers }).catch(() => {});
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${SERVER_URL}${path}`, init);
  } catch (err) {
    throw new OfflineError(err instanceof Error ? err.message : String(err));
  }
}

export const reportUrl = (scanId: string) => `${WEB_URL}/scans/${encodeURIComponent(scanId)}`;

export async function fetchGreeting(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/greeting`);
  if (!res.ok) throw new Error(`Greeting request failed: ${res.status}`);
  const body = (await res.json()) as GreetingResponse;
  return body.message;
}

/** Enqueues a scan and returns its id. Errors carry a message the pet can say. */
export async function createScan(url: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeaders() };
  if (API_KEY) headers[API_KEY_HEADER] = API_KEY;
  const res = await request("/api/scans", {
    method: "POST",
    headers,
    body: JSON.stringify({ url } satisfies CreateScanRequest),
  });
  if (!res.ok) {
    await noteAuthFailure(res);
    throw new Error(FRIENDLY_ERRORS[res.status] ?? "Something went wrong starting the scan.");
  }
  const body = (await res.json()) as CreateScanResponse;
  return body.scanId;
}

export async function getScan(scanId: string): Promise<ScanResponse> {
  const res = await request(`/api/scans/${encodeURIComponent(scanId)}`);
  if (!res.ok) throw new Error(`Scan request failed: ${res.status}`);
  return (await res.json()) as ScanResponse;
}

/**
 * Follows a scan's live events. The stream replays from the start, so nothing
 * is missed. Closes itself after a terminal status; call the returned
 * function to stop early. `onError` fires when the connection drops
 * (EventSource keeps retrying unless the stream was closed).
 */
export function watchScan(
  scanId: string,
  onEvent: (event: ScanEvent) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`${SERVER_URL}${eventsPath(scanId)}`);
  source.onmessage = (message: MessageEvent<string>) => {
    let event: ScanEvent;
    try {
      event = JSON.parse(message.data) as ScanEvent;
    } catch {
      return;
    }
    if (event.type === "status" && isTerminalStatus(event.status)) source.close();
    onEvent(event);
  };
  source.onerror = () => onError?.();
  return () => source.close();
}

const ALERT_RECONNECT_MS = 5_000;
/** How often a pet waiting for approval checks back. */
const ALERT_PENDING_RETRY_MS = 15_000;

/** Reads a server-sent-event stream until it ends. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) onEvent(event, data.join("\n"));
    }
  }
}

/**
 * Listens for the signed-in user's alerts (unsafe or unknown sites their
 * browser extension reported). Connects whenever someone signs in, and keeps
 * checking back while the account waits for approval. Uses fetch rather than
 * EventSource so the token travels in a header. Returns an unsubscribe function.
 */
export function subscribeToAlerts(onAlert: (alert: PetAlert) => void) {
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let connectedToken: string | null = null;

  const schedule = (ms: number) => {
    clearTimeout(retry);
    retry = setTimeout(() => void connect(), ms);
  };

  const connect = async () => {
    clearTimeout(retry);
    controller?.abort();
    const session = getSession();
    connectedToken = session?.token ?? null;
    if (closed || !session) return;
    const current = new AbortController();
    controller = current;
    try {
      const res = await fetch(`${SERVER_URL}/api/pet/stream`, {
        headers: { Authorization: `Bearer ${session.token}` },
        signal: current.signal,
      });
      if (res.status === 401 || res.status === 403) {
        await noteAuthFailure(res);
        if (res.status === 403) schedule(ALERT_PENDING_RETRY_MS);
        return;
      }
      if (!res.ok || !res.body) {
        schedule(ALERT_RECONNECT_MS);
        return;
      }
      setAccountStatus("approved");
      await readEvents(res.body, (event, data) => {
        if (event === "alert") onAlert(JSON.parse(data) as PetAlert);
      });
      // The server ended the stream (a restart, or access was revoked): reconnecting tells which.
      if (!current.signal.aborted) schedule(ALERT_RECONNECT_MS);
    } catch {
      if (!current.signal.aborted && !closed) schedule(ALERT_RECONNECT_MS);
    }
  };

  // Reconnect as the new user after signing in or out.
  const unsubscribeSession = subscribeSession(() => {
    if ((getSession()?.token ?? null) !== connectedToken) void connect();
  });
  void connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    controller?.abort();
    unsubscribeSession();
  };
}
