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
  const line = `[ladybugg] ${parts.filter(Boolean).join(" ")}`;
  if (event.type === "error") console.error(line);
  else console.log(line);

  const message: AdminStreamEvent = { kind: "event", event };
  adminChannel.send("message", message);

  if (isStoreReady()) {
    saveEvent(event).catch((error: unknown) => {
      console.error(`[ladybugg] failed to store event ${event.id}:`, error);
    });
  }
  return event;
}

/**
 * Who an alert is for: one user's pets (by user id), or every pet, for checks
 * an admin runs from the admin UI.
 */
export type AlertRecipient = { userId: string; username: string } | "everyone";

/** Pushes an alert to the recipient's desktop pets, and logs that it did. */
export function sendPetAlert(
  recipient: AlertRecipient,
  level: AlertLevel,
  message: string,
  url: string,
  host: string,
  scanId?: string,
) {
  const alert: PetAlert = { id: newId(), level, message, url, host, at: Date.now(), ...(scanId ? { scanId } : {}) };
  let pets: number;
  if (recipient === "everyone") {
    petChannel.send("alert", alert);
    pets = petChannel.size;
  } else {
    petChannel.sendTo(recipient.userId, "alert", alert);
    pets = petChannel.sizeOf(recipient.userId);
  }
  const to = recipient === "everyone" ? "every pet" : `${recipient.username}'s pets`;
  logEvent({
    type: "alert",
    message: `Pet alert (${level}) to ${to} (${pets} listening): ${message}`,
    url,
    host,
    details: {
      level,
      petsConnected: pets,
      alertId: alert.id,
      scanId,
      ...(recipient === "everyone" ? {} : { user: recipient.username }),
    },
  });
  return alert;
}
