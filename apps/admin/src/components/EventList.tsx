import { useState } from "react";
import type { LogEvent } from "@ladybug/shared";
import { describeEvent, formatFull, formatTime } from "../format";
import Badge from "./Badge";

export default function EventList({
  events,
  compactRows = false,
  emptyText,
}: {
  events: LogEvent[];
  compactRows?: boolean;
  emptyText: string;
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (events.length === 0) return <p className="empty">{emptyText}</p>;

  return (
    <ul className={compactRows ? "events compact" : "events"}>
      {events.map((event) => {
        const { label, tone, icon } = describeEvent(event);
        const expanded = open === event.id;
        return (
          <li key={event.id} className={expanded ? "expanded" : undefined}>
            <button
              type="button"
              className="event-row"
              onClick={() => setOpen(expanded ? null : event.id)}
              aria-expanded={expanded}
            >
              <time className="event-time muted" dateTime={new Date(event.at).toISOString()} title={formatFull(event.at)}>
                {formatTime(event.at)}
              </time>
              <span className="event-badge">
                <Badge tone={tone} icon={icon} label={label} />
              </span>
              <span className="event-message">{event.message}</span>
              {event.durationMs !== undefined && (
                <span className="event-duration muted">
                  {event.durationMs >= 1000 ? `${(event.durationMs / 1000).toFixed(1)}s` : `${event.durationMs}ms`}
                </span>
              )}
            </button>
            {expanded && (
              <pre className="event-details">
                {JSON.stringify(
                  {
                    type: event.type,
                    at: new Date(event.at).toISOString(),
                    url: event.url,
                    host: event.host,
                    decision: event.decision,
                    verdict: event.verdict,
                    durationMs: event.durationMs,
                    ...event.details,
                  },
                  null,
                  2,
                )}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
