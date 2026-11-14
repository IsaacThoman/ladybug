import {
  API_KEY_HEADER,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  eventsPath,
  isTerminalStatus,
} from "@ladybug/shared";
import type {
  CreateScanRequest,
  CreateScanResponse,
  GreetingResponse,
  PetAlert,
  ScanEvent,
  ScanResponse,
} from "@ladybug/shared";

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;
export const WEB_URL = import.meta.env.VITE_WEB_URL ?? `http://localhost:${DEFAULT_WEB_PORT}`;
const API_KEY = import.meta.env.VITE_API_KEY;

/** The server couldn't be reached at all. */
export class OfflineError extends Error {}

const FRIENDLY_ERRORS: Record<number, string> = {
  400: "That doesn't look like a link I can check.",
  401: "I'm not allowed to scan. Check the API key.",
  429: "That's a lot of links! Give me a minute.",
};

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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers[API_KEY_HEADER] = API_KEY;
  const res = await request("/api/scans", {
    method: "POST",
    headers,
    body: JSON.stringify({ url } satisfies CreateScanRequest),
  });
  if (!res.ok) {
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

/**
 * Listens for alerts from the server (unsafe or unknown sites reported by the
 * browser extension). Returns an unsubscribe function.
 */
export function subscribeToAlerts(onAlert: (alert: PetAlert) => void) {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const connect = () => {
    source = new EventSource(`${SERVER_URL}/api/pet/stream`);
    source.addEventListener("alert", (event) => {
      onAlert(JSON.parse((event as MessageEvent<string>).data) as PetAlert);
    });
    source.onerror = () => {
      // EventSource reconnects by itself after network drops, but gives up
      // for good on HTTP errors, so retry those by hand.
      if (source?.readyState === EventSource.CLOSED && !closed) {
        retry = setTimeout(connect, ALERT_RECONNECT_MS);
      }
    };
  };

  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
  };
}
