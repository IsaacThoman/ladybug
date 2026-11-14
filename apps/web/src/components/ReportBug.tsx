import { useEffect, useRef } from "react";
import { Ladybug, SpeechBubble } from "@ladybug/garden";
import type { BubbleTone, LadybugHandle, LadybugMood } from "@ladybug/garden";
import type { ScanStatus, ScanVerdict } from "@ladybug/shared";

const WORKING: Partial<Record<ScanStatus, string>> = {
  queued: "Waiting my turn…",
  provisioning: "Fetching my magnifier…",
  detonating: "Opening it up…",
  investigating: "Sniff, sniff…",
  scoring: "Adding it all up…",
};

const VERDICT: Record<ScanVerdict, { mood: LadybugMood; say: string; tone: BubbleTone }> = {
  benign: { mood: "happy", say: "Looks safe to me!", tone: "ok" },
  suspicious: { mood: "nervous", say: "Hmm, be careful here.", tone: "warn" },
  malicious: { mood: "alarmed", say: "Don't go in there!", tone: "danger" },
};

/** The ladybug sniffs around while a scan runs, then reacts to the verdict. */
export default function ReportBug({ status, verdict }: { status: ScanStatus; verdict: ScanVerdict | null }) {
  const bug = useRef<LadybugHandle>(null);
  const done = status === "done" && verdict !== null;

  useEffect(() => {
    if (!done) return;
    if (verdict === "malicious") bug.current?.alarm();
    else if (verdict === "benign") bug.current?.celebrate();
    else bug.current?.startle();
  }, [done, verdict]);

  let reaction: { mood: LadybugMood; say: string; tone: BubbleTone };
  if (done) reaction = VERDICT[verdict];
  else if (status === "failed") reaction = { mood: "nervous", say: "I couldn't finish this one.", tone: "warn" };
  else reaction = { mood: "sniffing", say: WORKING[status] ?? "Sniff, sniff…", tone: "chat" };

  return (
    <Ladybug ref={bug} className="report-bug" mood={reaction.mood} size={92} wander={done ? 40 : 110}>
      <SpeechBubble text={reaction.say} tone={reaction.tone} />
    </Ladybug>
  );
}
