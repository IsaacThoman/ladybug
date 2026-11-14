import { useSyncExternalStore } from "react";
import type { Account, AccountStatus } from "@ladybug/shared";

// The signed-in account and its token, kept in local storage so the page
// stays signed in across visits.

export type Session = { token: string; account: Account } | null;

const STORAGE_KEY = "ladybug.session";
const listeners = new Set<() => void>();

function load(): Session {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

let session: Session = load();

export const getSession = () => session;

export function setSession(next: Session) {
  session = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: signed in until the app quits.
  }
  for (const listener of listeners) listener();
}

/** Records what the server said about the account (an admin approved or turned it down). */
export function setAccountStatus(status: AccountStatus) {
  if (session && session.account.status !== status) {
    setSession({ ...session, account: { ...session.account, status } });
  }
}

export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useSession = () => useSyncExternalStore(subscribeSession, getSession);
