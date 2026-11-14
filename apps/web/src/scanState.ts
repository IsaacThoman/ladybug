import { isTerminalStatus } from "@ladybug/shared";
import type { Finding, ScanEvent, ScanReport, ScanResponse, ScanStatus, ScoreSignal, ScanVerdict } from "@ladybug/shared";

export type LiveScreenshot = { artifactKey: string; label: string; at: string | null };
export type LiveFinding = Finding & { id: string; at: string | null };
export type ActivityItem =
  | { id: string; kind: "note"; text: string; at: string }
  | { id: string; kind: "tool"; tool: string; summary: string; at: string }
  | { id: string; kind: "signal"; signal: ScoreSignal; at: string }
  | { id: string; kind: "status"; status: ScanStatus; message?: string; at: string };

export type ScanState = {
  scanId: string;
  inputUrl: string;
  status: ScanStatus;
  /** Message from a failed status event, or the scan's error column. */
  error: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  statusAt: Partial<Record<ScanStatus, string>>;
  screenshots: LiveScreenshot[];
  findings: LiveFinding[];
  activity: ActivityItem[];
  signals: ScoreSignal[];
  redirectChain: string[];
  /** From the `report` event; the full report may follow later. */
  result: { score: number; verdict: ScanVerdict } | null;
  report: ScanReport | null;
  eventCount: number;
};

export const emptyScan = (scanId: string, inputUrl = ""): ScanState => ({
  scanId,
  inputUrl,
  status: "queued",
  error: null,
  createdAt: null,
  finishedAt: null,
  statusAt: {},
  screenshots: [],
  findings: [],
  activity: [],
  signals: [],
  redirectChain: [],
  result: null,
  report: null,
  eventCount: 0,
});

export function applyScan(state: ScanState, scan: ScanResponse): ScanState {
  const report = scan.report;
  const terminal = isTerminalStatus(scan.status);
  const next: ScanState = {
    ...state,
    scanId: scan.scanId,
    inputUrl: scan.inputUrl,
    // Events can be ahead of a stale GET; never step the stepper backwards.
    status: laterStatus(state.status, scan.status),
    error: scan.error ?? state.error,
    createdAt: scan.createdAt,
    finishedAt: report?.finishedAt ?? (terminal ? scan.updatedAt : state.finishedAt),
  };
  if (!report) return next;

  const seenShots = new Set(state.screenshots.map((s) => s.artifactKey));
  const extraShots = report.screenshots.filter((s) => !seenShots.has(s.artifactKey)).map((s) => ({ ...s, at: null }));
  return {
    ...next,
    report,
    result: { score: report.score, verdict: report.verdict },
    screenshots: [...state.screenshots, ...extraShots],
    findings: report.findings.map((f, i) => ({
      ...f,
      id: state.findings.find((lf) => lf.title === f.title)?.id ?? `report-${i}`,
      at: state.findings.find((lf) => lf.title === f.title)?.at ?? null,
    })),
    signals: report.signals,
    redirectChain: report.redirectChain.length ? report.redirectChain : state.redirectChain,
  };
}

const ORDER: Record<ScanStatus, number> = {
  queued: 0,
  provisioning: 1,
  detonating: 2,
  investigating: 3,
  scoring: 4,
  done: 5,
  failed: 5,
};

function laterStatus(a: ScanStatus, b: ScanStatus): ScanStatus {
  return ORDER[b] >= ORDER[a] ? b : a;
}

export function applyEvent(state: ScanState, event: ScanEvent, id: string): ScanState {
  const s = { ...state, eventCount: state.eventCount + 1 };
  switch (event.type) {
    case "status":
      return {
        ...s,
        status: event.status,
        statusAt: { ...s.statusAt, [event.status]: event.at },
        createdAt: s.createdAt ?? event.at,
        error: event.status === "failed" ? (event.message ?? s.error ?? "Scan failed") : s.error,
        finishedAt: isTerminalStatus(event.status) ? event.at : s.finishedAt,
        activity: [...s.activity, { id, kind: "status", status: event.status, message: event.message, at: event.at }],
      };
    case "screenshot":
      if (s.screenshots.some((shot) => shot.artifactKey === event.artifactKey)) return s;
      return {
        ...s,
        screenshots: [...s.screenshots, { artifactKey: event.artifactKey, label: event.label, at: event.at }],
      };
    case "finding":
      return { ...s, findings: [...s.findings, { ...event.finding, id, at: event.at }] };
    case "agent_note":
      return { ...s, activity: [...s.activity, { id, kind: "note", text: event.text, at: event.at }] };
    case "tool_call":
      return {
        ...s,
        activity: [...s.activity, { id, kind: "tool", tool: event.tool, summary: event.summary, at: event.at }],
      };
    case "signal":
      return {
        ...s,
        signals: s.signals.some((sig) => sig.id === event.signal.id) ? s.signals : [...s.signals, event.signal],
        activity: [...s.activity, { id, kind: "signal", signal: event.signal, at: event.at }],
      };
    case "redirect_chain":
      return { ...s, redirectChain: event.chain };
    case "report":
      return { ...s, result: { score: event.score, verdict: event.verdict } };
    default:
      return s;
  }
}

export function isScanEvent(value: unknown): value is ScanEvent {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
