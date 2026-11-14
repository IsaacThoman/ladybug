import { useEffect, useRef } from "react";
import type { AdminSummary, LogEvent, PendingAnalysis } from "@ladybug/shared";
import { Ladybug, SpeechBubble } from "@ladybug/garden";
import type { BubbleTone, LadybugHandle, LadybugMood } from "@ladybug/garden";
import { compact } from "../format";
import { useNow } from "../useAdminStream";

/** An unsafe find keeps the ladybug worried for this long. */
const ALARM_MS = 30_000;

const isUnsafeFind = (event: LogEvent) =>
  (event.type === "analysis_completed" && event.verdict === "unsafe") ||
  (event.type === "decision" && event.decision === "known_unsafe");

function hello(now: number) {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The ladybug keeps watch over the garden and says what's going on. */
export default function Greeting({
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
  const now = useNow(5_000);
  const bug = useRef<LadybugHandle>(null);
  const latest = live[0];
  const lastFind = live.find(isUnsafeFind);
  const alarmed = lastFind !== undefined && now - lastFind.at < ALARM_MS;

  // React to news as it arrives, not to history loaded on the first render.
  const seen = useRef(latest?.id);
  useEffect(() => {
    if (!latest || latest.id === seen.current) return;
    seen.current = latest.id;
    if (isUnsafeFind(latest)) bug.current?.alarm();
    else if (latest.type === "analysis_completed") bug.current?.celebrate();
  }, [latest]);

  let mood: LadybugMood = "calm";
  let say = "Nothing to report!";
  let tone: BubbleTone = "chat";
  let headline = "All quiet in the garden";
  if (summaryError) {
    mood = "nervous";
    say = "Hello? Server?";
    tone = "warn";
    headline = "Can't reach the server";
  } else if (alarmed) {
    mood = "alarmed";
    say = `Yikes! ${lastFind?.host ?? "That one"} is unsafe.`;
    tone = "danger";
    headline = "Spotted an unsafe site";
  } else if (pending.length > 0) {
    mood = "sniffing";
    say = "Sniff, sniff…";
    headline = `Checking ${pending.length} new link${pending.length === 1 ? "" : "s"}`;
  }

  const pets = summary?.petsConnected ?? 0;
  const known = summary?.urls.total ?? 0;

  return (
    <section className="card greeting">
      <div className="greeting-perch">
        <Ladybug ref={bug} mood={mood} size={104} wander={30}>
          <SpeechBubble text={say} tone={tone} />
        </Ladybug>
        <svg className="greeting-mound" viewBox="0 0 220 40" aria-hidden="true">
          <path d="M0 40C30 14 70 6 110 6s80 8 110 34Z" />
          <path className="grass" d="M44 18l-3-9 7 7M78 10l-1-9 5 8M146 10l2-9 3 9M178 18l4-8 1 9" />
        </svg>
      </div>
      <div className="greeting-copy">
        <p className="hand greeting-hello">{hello(now)}, gardener</p>
        <h1>{headline}</h1>
        <p className="greeting-detail">
          {summary
            ? `${pets} pet${pets === 1 ? "" : "s"} listening · ${compact(known)} known URL${known === 1 ? "" : "s"}`
            : "Counting the flowers…"}
        </p>
      </div>
    </section>
  );
}
