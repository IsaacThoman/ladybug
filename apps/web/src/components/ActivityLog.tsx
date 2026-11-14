import { useEffect, useRef } from "react";
import { clockTime, humanize } from "../format.ts";
import type { ActivityItem } from "../scanState.ts";

export default function ActivityLog({ items, running }: { items: ActivityItem[]; running: boolean }) {
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <section className="panel" aria-label="Activity log">
      <h2 className="panel-title">
        Agent activity
        {running && (
          <span className="typing" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </h2>
      {items.length === 0 ? (
        <p className="muted empty">
          {running ? "Waiting for the agent…" : "The live log is no longer available for this scan."}
        </p>
      ) : (
        <ol className="activity" ref={listRef} onScroll={onScroll} aria-live="polite">
          {items.map((item) => (
            <li key={item.id} className={`act act-${item.kind}`}>
              <time className="act-time">{clockTime(item.at)}</time>
              <ActivityBody item={item} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ActivityBody({ item }: { item: ActivityItem }) {
  switch (item.kind) {
    case "note":
      return <p className="act-text">{item.text}</p>;
    case "tool":
      return (
        <p className="act-text">
          <code className="act-badge-tool">{item.tool}</code> {item.summary}
        </p>
      );
    case "signal":
      return (
        <p className="act-text">
          <span className="act-badge-signal">signal</span> {item.signal.label}
          {item.signal.weight > 0 && <span className="act-weight">+{item.signal.weight}</span>}
        </p>
      );
    case "status":
      return (
        <p className="act-text act-status-text">
          {humanize(item.status)}
          {item.message ? `: ${item.message}` : ""}
        </p>
      );
  }
}
