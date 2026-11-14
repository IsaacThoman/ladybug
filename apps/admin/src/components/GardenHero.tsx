import { useEffect, useRef } from "react";
import { Cloud, Hills, Mascot } from "@ladybug/mascot/web";
import type { LadybugMood, MascotHandle } from "@ladybug/mascot/web";
import type { AdminSummary, LogEvent, PendingAnalysis } from "@ladybug/shared";
import { useNow } from "../useAdminStream";
import LadybugMark from "./LadybugMark";
import StatTiles from "./StatTiles";

/** How long the ladybug keeps talking about a fresh verdict. */
const REACTION_MS = 20_000;

type Props = {
  summary: AdminSummary | null;
  summaryError: boolean;
  connected: boolean;
  pending: PendingAnalysis[];
  live: LogEvent[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const isUnsafe = (event: LogEvent) =>
  (event.type === "analysis_completed" && event.verdict === "unsafe") ||
  (event.type === "decision" && event.decision === "known_unsafe");
const isVerdict = (event: LogEvent) =>
  isUnsafe(event) || (event.type === "analysis_completed" && event.verdict === "safe");

/** What the ladybug makes of the server right now, the way the desktop pets would. */
function statusFor({ summary, summaryError, connected, pending, live }: Props, now: number) {
  const say = (mood: LadybugMood, text: string) => ({ mood, text });
  if (summaryError) return say("nervous", "I can't reach the server right now.");
  if (!connected) return say("nervous", "Lost the live feed. Reconnecting…");
  if (summary && summary.typesense !== "ready") return say("nervous", "Typesense isn't ready, so I can't look links up yet.");
  const verdict = live.find(isVerdict);
  const fresh = verdict && now - verdict.at < REACTION_MS ? verdict : null;
  if (fresh && isUnsafe(fresh)) return say("alarmed", `Careful! ${fresh.host ?? "That page"} is unsafe.`);
  if (pending.length > 0) return say("sniffing", `Sniffing ${plural(pending.length, "link")}…`);
  if (fresh) return say("happy", `${fresh.host ?? "That page"} checked out fine.`);
  if (!summary) return say("calm", "Having a look around…");
  const pets = summary.petsConnected;
  return say("calm", pets > 0 ? `All quiet. ${plural(pets, "pet")} listening.` : "All quiet. No pets are listening yet.");
}

/** The top of the overview: the ladybug in its garden, reacting to live activity, beside the stats. */
export default function GardenHero(props: Props) {
  const now = useNow(1000);
  const { mood, text } = statusFor(props, now);
  const mascot = useRef<MascotHandle>(null);
  const latest = props.live.find(isVerdict);
  const reacted = useRef(latest?.id);

  // A verdict arriving live gets the full reaction: wings flared, or a happy hop.
  useEffect(() => {
    if (!latest || reacted.current === latest.id) return;
    reacted.current = latest.id;
    if (isUnsafe(latest)) mascot.current?.alarm();
    else mascot.current?.celebrate();
  }, [latest]);

  return (
    <section className="garden-hero" aria-label="Status">
      <div className="clouds" aria-hidden="true">
        <Cloud className="cloud-shape cloud-a" />
        <Cloud className="cloud-shape cloud-b" />
      </div>
      <div className="garden-hero-mascot">
        <p className="bubble" data-tone={mood === "alarmed" || mood === "nervous" ? "warn" : undefined}>
          {text}
        </p>
        <Mascot ref={mascot} mood={mood} fallback={<LadybugMark size={96} />} />
      </div>
      <div className="garden-hero-stats">
        <StatTiles summary={props.summary} running={props.pending.length} />
      </div>
      <Hills className="garden-hills" />
    </section>
  );
}
