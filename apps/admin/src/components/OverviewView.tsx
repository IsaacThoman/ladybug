import type { AdminSummary, LogEvent, PendingAnalysis } from "@ladybug/shared";
import type { EventFilter } from "../api";
import { useEventFeed } from "../useEventFeed";
import CheckForm from "./CheckForm";
import EventList from "./EventList";
import PendingList from "./PendingList";
import StatTiles from "./StatTiles";

const DETECTIONS: EventFilter = { types: ["decision", "analysis_completed"], verdict: "unsafe" };
const EVERYTHING: EventFilter = {};

export default function OverviewView({
  summary,
  pending,
  live,
}: {
  summary: AdminSummary | null;
  pending: PendingAnalysis[];
  live: LogEvent[];
}) {
  const detections = useEventFeed(DETECTIONS, live, 8);
  const recent = useEventFeed(EVERYTHING, live, 12);

  return (
    <div className="stack">
      <StatTiles summary={summary} running={pending.length} />
      <div className="columns">
        <div className="stack">
          <CheckForm />
          <PendingList pending={pending} />
        </div>
        <div className="stack">
          <section className="card">
            <h2>Recent detections</h2>
            <EventList
              events={detections.events.slice(0, 8)}
              compactRows
              emptyText="No unsafe sites seen yet."
            />
          </section>
          <section className="card">
            <div className="card-header">
              <h2>Latest activity</h2>
              <a className="link" href="#activity">
                Full log
              </a>
            </div>
            <EventList events={recent.events.slice(0, 12)} compactRows emptyText="No activity yet." />
          </section>
        </div>
      </div>
    </div>
  );
}
