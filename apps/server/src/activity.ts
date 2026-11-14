import { randomUUID } from "node:crypto";
import type { AdminStreamEvent, AlertLevel, LogEvent, PetAlert } from "@ladybug/shared";
import { adminChannel, petChannel } from "./sse.ts";
import { isStoreReady, saveEvent } from "./store.ts";

/** Ids sort by time, so they double as a stable tiebreaker. */
const newId = () => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const TYPE_WIDTH = 18;

/**
 * Records something the server did or decided: prints it, streams it to the
 * admin UI, and stores it in Typesense (best effort) so it can be searched.
 */
export function logEvent(input: Omit<LogEvent, "id" | "at">): LogEvent {
  const event: LogEvent = { id: newId(), at: Date.now(), ...input };

  const parts = [
    new Date(event.at).toISOString(),
    event.type.padEnd(TYPE_WIDTH),
    event.message,
    event.durationMs !== undefined ? `(${event.durationMs}ms)` : "",
  ];
  const line = `[ladybug] ${parts.filter(Boolean).join(" ")}`;
  if (event.type === "error") console.error(line);
  else console.log(line);

  const message: AdminStreamEvent = { kind: "event", event };
  adminChannel.send("message", message);

  if (isStoreReady()) {
    saveEvent(event).catch((error: unknown) => {
      console.error(`[ladybug] failed to store event ${event.id}:`, error);
    });
  }
  return event;
}

/** Pushes an alert to every connected desktop pet, and logs that it did. */
export function sendPetAlert(level: AlertLevel, message: string, url: string, host: string) {
  const alert: PetAlert = { id: newId(), level, message, url, host, at: Date.now() };
  petChannel.send("alert", alert);
  logEvent({
    type: "alert",
    message: `Pet alert (${level}) to ${petChannel.size} pet(s): ${message}`,
    url,
    host,
    details: { level, petsConnected: petChannel.size, alertId: alert.id },
  });
  return alert;
}
