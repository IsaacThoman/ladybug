import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { OpenWarningRequest, PetWarning, WarningChoice, WarningStreamEvents } from "@ladybug/shared";
import { logEvent } from "./activity.ts";
import { petChannel, warningChannel } from "./sse.ts";

// Unsafe pages the extension is blocking right now. Each blocked page holds a
// stream open (warningChannel) for as long as it's on screen, so a page that
// closes, navigates away or loses its connection is no longer blocked as far
// as the pets are concerned. Pets get the whole list of their user's blocked
// pages whenever it changes, and the choice the user makes on a pet goes back
// down the page's stream.

type OpenWarning = {
  warning: PetWarning;
  userId: string;
  send: <E extends keyof WarningStreamEvents>(event: E, data: WarningStreamEvents[E]) => void;
  /** Stops listing the page as blocked and ends its stream. */
  end: () => void;
};

const open = new Map<string, OpenWarning>();

/** The user's blocked pages, oldest first. */
export const warningsFor = (userId: string): PetWarning[] =>
  [...open.values()].filter((entry) => entry.userId === userId).map((entry) => entry.warning);

const tellPets = (userId: string) => petChannel.sendTo(userId, "warnings", warningsFor(userId));

// Blocked pages show their options themselves when no pet is listening.
petChannel.onChange((userId) => {
  if (userId) warningChannel.sendTo(userId, "pets", { pets: petChannel.sizeOf(userId) });
});

/** Opens the stream for a page the extension just blocked, and tells the user's pets. */
export function openWarning(
  req: Request,
  res: Response,
  user: { id: string; username: string },
  input: OpenWarningRequest,
) {
  const warning: PetWarning = { id: randomUUID(), ...input, at: Date.now() };
  const send = warningChannel.attach(req, res, user.id) as OpenWarning["send"];

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    open.delete(warning.id);
    tellPets(user.id);
  };
  req.on("close", close);
  res.on("close", close);
  open.set(warning.id, { warning, userId: user.id, send, end: () => (close(), res.end()) });

  const pets = petChannel.sizeOf(user.id);
  send("ready", { id: warning.id, pets });
  tellPets(user.id);
  logEvent({
    type: "alert",
    message: `Blocked ${input.url} in ${user.username}'s browser (${pets} pets listening)`,
    url: input.url,
    host: input.host,
    details: { warningId: warning.id, user: user.username, late: input.late, petsConnected: pets },
  });
}

/**
 * Passes what the user picked on their pet to the blocked page. False when
 * that page isn't blocked anymore (or isn't this user's).
 *
 * The page is done once it has the choice, so the pets let go of it straight
 * away rather than waiting to notice its stream close (which can lag, or not
 * happen at all if the page vanished without hanging up). A page that's still
 * there after acting on it checks in again.
 */
export function chooseForWarning(user: { id: string; username: string }, id: string, choice: WarningChoice) {
  const entry = open.get(id);
  if (!entry || entry.userId !== user.id) return false;
  entry.send("choice", { choice });
  entry.end();
  logEvent({
    type: "alert",
    message: `${user.username} chose ${choice === "exit" ? "to leave" : "to continue to"} ${entry.warning.url} on their pet`,
    url: entry.warning.url,
    host: entry.warning.host,
    details: { warningId: id, user: user.username, choice },
  });
  return true;
}
