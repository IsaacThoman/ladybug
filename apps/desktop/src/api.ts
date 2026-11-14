import { DEFAULT_SERVER_PORT } from "@ladybug/shared";
import type { GreetingResponse, PetAlert } from "@ladybug/shared";

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;

export async function fetchGreeting(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/greeting`);
  if (!res.ok) throw new Error(`Greeting request failed: ${res.status}`);
  const body = (await res.json()) as GreetingResponse;
  return body.message;
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
