import { useState } from "react";
import type { DomainInfo, Iocs, ReportFlag, ScanReport, ScoreSignal, SimilarPage } from "@ladybug/shared";
import { humanize } from "../format.ts";
import Link from "./Link.tsx";

const FLAG_COPY: Record<ReportFlag, string> = {
  llm_skipped: "No model key was configured, so this score comes from hard signals only.",
  llm_refused: "The model declined to analyze this page; the score comes from hard signals only.",
  llm_failed: "The agent hit an error; the score comes from hard signals only.",
  navigation_failed: "The page never finished loading in the sandbox.",
};

export function ReportSummary({ report }: { report: ScanReport }) {
  return (
    <section className={`panel summary verdict-${report.verdict}`} aria-label="Summary">
      <h2 className="panel-title">Summary</h2>
      <p className="summary-text">{report.summary}</p>
      {report.categories.length > 0 && (
        <ul className="categories">
          {report.categories.map((c) => (
            <li key={c}>{humanize(c)}</li>
          ))}
        </ul>
      )}
      <dl className="score-split">
        <div>
          <dt>signal score</dt>
          <dd>{report.signalScore}</dd>
        </div>
        <div>
          <dt>agent score</dt>
          <dd>{report.llmScore ?? "—"}</dd>
        </div>
        <div>
          <dt>final</dt>
          <dd>{report.score}</dd>
        </div>
      </dl>
      {report.flags.length > 0 && (
        <ul className="flags">
          {report.flags.map((f) => (
            <li key={f}>{FLAG_COPY[f] ?? humanize(f)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Signals({ signals }: { signals: ScoreSignal[] }) {
  if (signals.length === 0) return null;
  const sorted = [...signals].sort((a, b) => (b.floor ?? 0) - (a.floor ?? 0) || b.weight - a.weight);
  const max = Math.max(...signals.map((s) => s.weight), 1);
  return (
    <section className="panel" aria-label="Signals">
      <h2 className="panel-title">
        Signals <span className="count">{signals.length}</span>
      </h2>
      <ul className="signals">
        {sorted.map((s) => (
          <li key={s.id}>
            <div className="signal-head">
              <span className="signal-label">{s.label}</span>
              <span className="signal-weight">
                {s.floor !== undefined && <span className="signal-floor">floor {s.floor}</span>}
                {s.weight > 0 ? `+${s.weight}` : s.floor === undefined ? "0" : ""}
              </span>
            </div>
            <div className="signal-bar" aria-hidden="true">
              <span style={{ width: `${(s.weight / max) * 100}%` }} />
            </div>
            <p className="signal-evidence">{s.evidence}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Earlier flagged scans of pages that look like this one (pgvector nearest neighbours). */
export function SimilarPages({ pages }: { pages: SimilarPage[] }) {
  if (pages.length === 0) return null;
  return (
    <section className="panel" aria-label="Similar flagged pages">
      <h2 className="panel-title">
        Similar pages <span className="count">{pages.length}</span>
      </h2>
      <p className="panel-note">Earlier flagged scans whose page fingerprint is a near match for this one.</p>
      <ul className="recent-list similar-list">
        {pages.map((p) => (
          <li key={p.scanId}>
            <Link href={`/scans/${p.scanId}`} className="recent-item similar-item">
              <span className={`recent-score ${p.verdict}`} title={`${p.verdict}, ${p.score}/100`}>
                {p.score}
              </span>
              <span className="recent-url">
                <span className="recent-host">{p.title || hostOf(p.url)}</span>
                <span className="mono recent-full">{p.url}</span>
              </span>
              <span className="similar-match">{Math.round(p.similarity * 100)}% match</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const isoDate = (iso: string) => iso.slice(0, 10);

export function DomainPanel({ domain }: { domain: DomainInfo }) {
  const rows: [string, string | null][] = [
    ["hostname", domain.hostname],
    ["registrable", domain.registrableDomain],
    [
      "registered",
      domain.registeredAt
        ? `${isoDate(domain.registeredAt)}${domain.ageDays !== null ? ` (${domain.ageDays} day${domain.ageDays === 1 ? "" : "s"} ago)` : ""}`
        : domain.ageDays !== null
          ? `${domain.ageDays} days ago`
          : null,
    ],
    ["registrar", domain.registrar],
    ["IPs", domain.ips.length ? domain.ips.join(", ") : null],
    ["network", domain.asn],
    [
      "certificates",
      domain.certificateCount !== null
        ? `${domain.certificateCount}${domain.firstCertificateAt ? `, first ${isoDate(domain.firstCertificateAt)}` : ""}`
        : null,
    ],
  ];
  const young = domain.ageDays !== null && domain.ageDays < 30;
  return (
    <section className="panel" aria-label="Domain">
      <h2 className="panel-title">Domain</h2>
      {domain.lookalike && <p className="lookalike">{domain.lookalike}</p>}
      <dl className="kv">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className={k === "registered" && young ? "is-warn" : undefined}>
              <dt>{k}</dt>
              <dd className="mono">{v}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

export function IocList({ iocs }: { iocs: Iocs }) {
  const groups = (
    [
      ["domains", iocs.domains],
      ["IPs", iocs.ips],
      ["URLs", iocs.urls],
      ["sha256", iocs.sha256],
    ] as const
  ).filter(([, list]) => list.length > 0);
  if (groups.length === 0) return null;
  const all = groups.flatMap(([, list]) => list).join("\n");
  return (
    <section className="panel" aria-label="Indicators of compromise">
      <h2 className="panel-title">
        IOCs
        <CopyButton text={all} label="Copy all" />
      </h2>
      {groups.map(([name, list]) => (
        <div key={name} className="ioc-group">
          <h3>{name}</h3>
          <ul className="iocs">
            {list.map((v) => (
              <li key={v}>
                <span className="mono">{v}</span>
                <CopyButton text={v} label="Copy" compact />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function CopyButton({ text, label, compact }: { text: string; label: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard blocked (insecure origin): the text is still selectable.
    }
  };
  return (
    <button
      type="button"
      className={`copy${compact ? " compact" : ""}${copied ? " copied" : ""}`}
      onClick={copy}
      aria-label={`${label}: ${text.split("\n")[0]}`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
