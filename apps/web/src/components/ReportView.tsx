import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { SCAN_STATUSES, isTerminalStatus } from "@ladybug/shared";
import type { CommunityTally, ScanStatus, ScanVerdict } from "@ladybug/shared";
import { MascotStage } from "@ladybug/mascot/react";
import type { LadybugMascotHandle, LadybugMood } from "@ladybug/mascot/react";
import { formatElapsed } from "../format.ts";
import type { ScanState } from "../scanState.ts";
import { useNow } from "../useNow.ts";
import ActivityLog from "./ActivityLog.tsx";
import CommunityPanel from "./CommunityPanel.tsx";
import Header from "./Header.tsx";
import Link from "./Link.tsx";
import Findings from "./Findings.tsx";
import RedirectChain from "./RedirectChain.tsx";
import { DomainPanel, IocList, ReportSummary, Signals, SimilarPages } from "./ReportDetails.tsx";
import ScoreGauge from "./ScoreGauge.tsx";
import ScreenshotFeed from "./ScreenshotFeed.tsx";
import StatusStepper from "./StatusStepper.tsx";

type Props = {
  scan: ScanState;
  artifactSrc: (key: string) => string;
  /** Connection notices, shown under the top bar. */
  notice?: ReactNode;
  /** Shown in the page header, e.g. demo controls. */
  headerExtra?: ReactNode;
  /** A fixed community tally instead of the live one (the demo). */
  communitySample?: CommunityTally;
};

export default function ReportView({ scan, artifactSrc, notice, headerExtra, communitySample }: Props) {
  const terminal = isTerminalStatus(scan.status);
  const running = !terminal;
  const now = useNow(running && scan.createdAt !== null);
  const report = scan.report;

  const start = scan.createdAt ? Date.parse(scan.createdAt) : null;
  const end = scan.finishedAt ? Date.parse(scan.finishedAt) : now;
  const elapsed = start !== null ? formatElapsed(end - start) : "0:00";

  const reached =
    [...SCAN_STATUSES]
      .reverse()
      .find((s): s is ScanStatus => s !== "failed" && s !== "done" && scan.statusAt[s] !== undefined) ?? null;

  const finalUrl = report?.finalUrl ?? scan.redirectChain.at(-1) ?? null;
  const showFinal = finalUrl && finalUrl !== scan.inputUrl;
  const siteUrl = finalUrl ?? scan.inputUrl;
  const showActivity = scan.activity.length > 0 || running;
  const verdict = scan.result?.verdict ?? null;
  const mascotRef = useRef<LadybugMascotHandle>(null);

  // The ladybug reacts once when the verdict lands, like the desktop pet.
  useEffect(() => {
    if (verdict === "malicious") mascotRef.current?.alarm();
    else if (verdict === "benign") mascotRef.current?.celebrate();
  }, [verdict]);

  return (
    <>
      <Header>
        {headerExtra}
        <Link href="/" className="button ghost small">
          Scan another URL
        </Link>
      </Header>
      <main className="report">
        <section className={`topbar verdict-${scan.result?.verdict ?? "none"}`} aria-label="Scan status">
          <div className="topbar-main">
            <div className="topbar-url">
              <span className="eyebrow">
                {running ? "Scanning" : scan.status === "failed" ? "Scan failed" : "Scanned"}
                <span className="elapsed" title="Elapsed time">
                  <ClockIcon /> {elapsed}
                </span>
              </span>
              <h1 className="input-url mono" title={scan.inputUrl}>
                {scan.inputUrl || " "}
              </h1>
              {showFinal && (
                <p className="final-url mono" title={finalUrl}>
                  <span aria-hidden="true">↳</span> {finalUrl}
                </p>
              )}
            </div>
            <StatusStepper status={scan.status} reached={reached} error={scan.error} />
          </div>
          <div className="topbar-side">
            <MascotStage unit={74} mood={moodFor(running, scan.status === "failed", verdict)} ref={mascotRef} className="topbar-mascot" />
            <ScoreGauge
              score={scan.result?.score ?? null}
              verdict={verdict}
              confidence={report?.confidence ?? null}
              pending={running}
            />
          </div>
        </section>

        {notice}

        <div className="report-grid">
          <div className="report-left">
            <ScreenshotFeed
              screenshots={scan.screenshots}
              artifactSrc={artifactSrc}
              running={running}
              status={scan.status}
            />
          </div>
          <div className="report-right">
            {report && <ReportSummary report={report} />}
            {terminal && siteUrl && <CommunityPanel key={siteUrl} url={siteUrl} sample={communitySample} />}
            <Findings findings={scan.findings} artifactSrc={artifactSrc} running={running} />
            {showActivity && <ActivityLog items={scan.activity} running={running} />}
            <RedirectChain chain={scan.redirectChain} />
            <Signals signals={scan.signals} />
            {report?.similar && <SimilarPages pages={report.similar} />}
            {report?.domain && <DomainPanel domain={report.domain} />}
            {report && <IocList iocs={report.iocs} />}
          </div>
        </div>
      </main>
    </>
  );
}

function moodFor(running: boolean, failed: boolean, verdict: ScanVerdict | null): LadybugMood {
  if (running) return "sniffing";
  if (failed || verdict === "suspicious") return "nervous";
  if (verdict === "malicious") return "alarmed";
  if (verdict === "benign") return "happy";
  return "calm";
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
