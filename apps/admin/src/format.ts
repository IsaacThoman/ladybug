import type { LogEvent } from "@ladybug/shared";

export type Tone = "good" | "warning" | "critical" | "neutral" | "accent";
export type IconName =
  | "check"
  | "alert"
  | "clock"
  | "minus"
  | "globe"
  | "bell"
  | "user"
  | "x"
  | "home"
  | "pulse"
  | "database"
  | "signout";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTime(at: number) {
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  return sameDay ? timeFormat.format(at) : dateTimeFormat.format(at);
}

export const formatFull = (at: number) => new Date(at).toLocaleString();

export function timeAgo(at: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export const compact = (value: number) => compactFormat.format(value);

/** Label, tone and icon for an activity-log event. */
export function describeEvent(event: LogEvent): { label: string; tone: Tone; icon: IconName } {
  switch (event.type) {
    case "request":
      return { label: "Visit", tone: "neutral", icon: "globe" };
    case "decision":
      switch (event.decision) {
        case "known_safe":
          return { label: "Known safe", tone: "good", icon: "check" };
        case "known_unsafe":
          return { label: "Known unsafe", tone: "critical", icon: "alert" };
        case "unknown":
          return { label: "Unknown", tone: "warning", icon: "clock" };
        default:
          return { label: "Skipped", tone: "neutral", icon: "minus" };
      }
    case "analysis_started":
      return { label: "Analysing", tone: "warning", icon: "clock" };
    case "analysis_completed":
      return event.verdict === "unsafe"
        ? { label: "Found unsafe", tone: "critical", icon: "alert" }
        : { label: "Found safe", tone: "good", icon: "check" };
    case "alert":
      return { label: "Pet alert", tone: "accent", icon: "bell" };
    case "admin":
      return { label: "Admin", tone: "neutral", icon: "user" };
    case "account":
      return { label: "Sign-up", tone: "warning", icon: "user" };
    case "error":
      return { label: "Error", tone: "critical", icon: "x" };
  }
}
