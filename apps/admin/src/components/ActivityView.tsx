import { useEffect, useMemo, useState } from "react";
import type { LogEvent, LogEventType } from "@ladybug/shared";
import type { EventFilter } from "../api";
import { useEventFeed } from "../useEventFeed";
import EventList from "./EventList";

const FILTERS: { label: string; types?: LogEventType[] }[] = [
  { label: "All" },
  { label: "Visits", types: ["request"] },
  { label: "Decisions", types: ["decision"] },
  { label: "Analyses", types: ["analysis_started", "analysis_completed"] },
  { label: "Pet alerts", types: ["alert"] },
  { label: "Admin", types: ["admin"] },
  { label: "Sign-ups", types: ["account"] },
  { label: "Reports", types: ["report"] },
  { label: "Errors", types: ["error"] },
];

export default function ActivityView({ live }: { live: LogEvent[] }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [filterIndex, setFilterIndex] = useState(0);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);

  const filter = useMemo<EventFilter>(
    () => ({ q: q || undefined, types: FILTERS[filterIndex].types }),
    [q, filterIndex],
  );
  const feed = useEventFeed(filter, live, 50);

  return (
    <section className="card">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search messages, URLs and hosts"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Search the activity log"
        />
        <div className="segmented" role="group" aria-label="Event type">
          {FILTERS.map((option, index) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={index === filterIndex}
              onClick={() => setFilterIndex(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">
        {feed.found.toLocaleString()} event{feed.found === 1 ? "" : "s"} · click a row for details · new
        events appear live
      </p>
      {feed.error && <p className="form-error">{feed.error}</p>}
      <EventList events={feed.events} emptyText={feed.loading ? "Loading…" : "No matching events."} />
      {feed.hasMore && (
        <button type="button" className="secondary load-more" onClick={feed.loadMore} disabled={feed.loading}>
          {feed.loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
