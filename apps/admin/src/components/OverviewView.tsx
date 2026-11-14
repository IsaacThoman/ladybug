import type { AdminSummary, LogEvent, PendingAnalysis } from "@ladybug/shared";
import type { EventFilter } from "../api";
import { useEventFeed } from "../useEventFeed";
import CheckForm from "./CheckForm";
import EventList from "./EventList";
import Greeting from "./Greeting";
import PendingList from "./PendingList";
import StatTiles from "./StatTiles";
import VisitsChart from "./VisitsChart";

const DETECTIONS: EventFilter = { types: ["decision", "analysis_completed"], verdict: "unsafe" };
const EVERYTHING: EventFilter = {};

export default function OverviewView({
  summary,
  summaryError,
  pending,
  live,
}: {
  summary: AdminSummary | null;
  summaryError: boolean;
  pending: PendingAnalysis[];
  live: LogEvent[];
}) {
  const detections = useEventFeed(DETECTIONS, live, 8);
  const recent = useEventFeed(EVERYTHING, live, 12);
  const lastDecision = live.find((event) => event.type === "decision")?.id;

  return (
    <div className="stack">
      <div className="overview-top">
        <Greeting summary={summary} summaryError={summaryError} pending={pending} live={live} />
        <StatTiles summary={summary} running={pending.length} />
      </div>
      <VisitsChart refreshKey={lastDecision} />
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
