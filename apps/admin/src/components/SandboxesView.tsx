import { useEffect, useState } from "react";
import { DEFAULT_WEB_PORT, artifactPath } from "@ladybug/shared";
import type { AdminSandbox, AdminSandboxesResponse, ScanStatus, ScanVerdict } from "@ladybug/shared";
import { api } from "../api";
import { formatFull, timeAgo } from "../format";
import type { IconName, Tone } from "../format";
import { useNow } from "../useAdminStream";
import Icon from "./Icon";

const POLL_MS = 2_000;
const PAGE = 24;
/** The most finished sandboxes the server lists at once. */
const MAX_LIMIT = 100;

/** Report pages are on the web app: the same origin in production, its own dev server locally. */
const WEB_BASE = import.meta.env.DEV ? `http://localhost:${DEFAULT_WEB_PORT}` : "";
const reportUrl = (scanId: string) => `${WEB_BASE}/scans/${encodeURIComponent(scanId)}`;

const RUNNING_LABEL: Record<Exclude<ScanStatus, "done" | "failed">, string> = {
  queued: "Queued",
  provisioning: "Starting sandbox",
  detonating: "Loading page",
  investigating: "Investigating",
  scoring: "Scoring",
};

const WAITING_COPY: Partial<Record<ScanStatus, string>> = {
  queued: "Waiting for a sandbox…",
  provisioning: "Spinning up a disposable browser…",
};

const VERDICT_BANNER: Record<ScanVerdict, { tone: Tone; icon: IconName; label: string }> = {
  benign: { tone: "good", icon: "check", label: "Benign" },
  suspicious: { tone: "warning", icon: "alert", label: "Suspicious" },
  malicious: { tone: "critical", icon: "alert", label: "Malicious" },
};

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const ms = (iso: string) => Date.parse(iso);

/** The banner across a finished (or stalled) sandbox's screen. */
function banner(sandbox: AdminSandbox, now: number): { tone: Tone; icon: IconName; label: string; detail?: string } {
  if (sandbox.stalled) {
    return { tone: "warning", icon: "clock", label: "Stalled", detail: `no news for ${duration(now - ms(sandbox.lastActivityAt))}` };
  }
  if (sandbox.status === "failed") return { tone: "neutral", icon: "x", label: "Failed" };
  if (!sandbox.verdict) return { tone: "neutral", icon: "check", label: "Finished" };
  const verdict = VERDICT_BANNER[sandbox.verdict];
  return { ...verdict, detail: sandbox.score === null ? undefined : `${sandbox.score}/100` };
}

function SandboxTile({ sandbox, now }: { sandbox: AdminSandbox; now: number }) {
  const running = sandbox.status !== "done" && sandbox.status !== "failed" && !sandbox.stalled;
  const host = hostOf(sandbox.inputUrl);
  const finalHost = sandbox.finalUrl ? hostOf(sandbox.finalUrl) : null;
  const started = ms(sandbox.createdAt);
  const ended = sandbox.finishedAt ? ms(sandbox.finishedAt) : null;
  const flag = running ? null : banner(sandbox, now);
  const activity = sandbox.status === "failed" ? (sandbox.error ?? sandbox.activity) : sandbox.activity;

  return (
    <li className="sandbox" data-running={running || undefined}>
      <a
        className="sandbox-screen"
        href={reportUrl(sandbox.scanId)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open the report for ${host}`}
      >
        {sandbox.screenshot ? (
          <img
            key={sandbox.screenshot.artifactKey}
            src={artifactPath(sandbox.scanId, sandbox.screenshot.artifactKey)}
            alt={`${host}, ${sandbox.screenshot.label}`}
            loading="lazy"
            // The mobile pass is portrait: show all of it rather than a cropped strip.
            onLoad={(e) => {
              const img = e.currentTarget;
              img.dataset.portrait = String(img.naturalHeight > img.naturalWidth);
            }}
          />
        ) : (
          <div className="sandbox-empty">
            <div className="sandbox-empty-browser" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>{running ? (WAITING_COPY[sandbox.status] ?? "Opening the page…") : "No screenshots were captured."}</p>
          </div>
        )}

        {flag ? (
          <div className="sandbox-banner" data-tone={flag.tone}>
            <Icon name={flag.icon} size={13} />
            <span className="sandbox-banner-label">{flag.label}</span>
            {flag.detail && <span className="sandbox-banner-detail">{flag.detail}</span>}
          </div>
        ) : (
          <div className="sandbox-overlay">
            <span className="live-dot">Live</span>
            <span className="sandbox-chip">{RUNNING_LABEL[sandbox.status as keyof typeof RUNNING_LABEL]}</span>
          </div>
        )}
        {sandbox.screenshot && (
          <span className="sandbox-shot-label">
            {sandbox.screenshot.label}
            {sandbox.screenshotCount > 1 && ` · ${sandbox.screenshotCount} shots`}
          </span>
        )}
      </a>

      <div className="sandbox-body">
        <div className="sandbox-host">
          <span className="mono truncate" title={sandbox.inputUrl}>
            {host}
          </span>
          {finalHost && finalHost !== host && (
            <span className="mono truncate muted" title={sandbox.finalUrl ?? undefined}>
              → {finalHost}
            </span>
          )}
        </div>
        <p className="sandbox-activity" title={activity ?? undefined}>
          {activity ??
            (running
              ? "Getting started…"
              : sandbox.stalled
                ? `Stuck at "${RUNNING_LABEL[sandbox.status as keyof typeof RUNNING_LABEL]}". The worker may have stopped.`
                : "Nothing to report.")}
        </p>
        <div className="sandbox-meta">
          <span className="truncate">{sandbox.startedBy ?? "Admin check"}</span>
          <span title={formatFull(ended ?? started)}>
            {ended
              ? `${timeAgo(ended, now)} · took ${duration(ended - started)}`
              : sandbox.stalled
                ? `started ${timeAgo(started, now)}`
                : `running ${duration(now - started)}`}
          </span>
        </div>
      </div>
    </li>
  );
}

export default function SandboxesView({ version }: { version: number }) {
  const [data, setData] = useState<AdminSandboxesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const now = useNow(1_000);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      // A background tab doesn't need a live grid; catch up when it's shown again.
      if (!document.hidden) {
        try {
          const next = await api.sandboxes(limit);
          if (cancelled) return;
          setData(next);
          setError(null);
        } catch (e) {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!cancelled) timer = window.setTimeout(load, POLL_MS);
    };
    void load();
    const onVisible = () => {
      if (document.hidden) return;
      window.clearTimeout(timer);
      void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [limit, version]);

  const live = data?.running.filter((sandbox) => !sandbox.stalled) ?? [];
  // Stalled sandboxes aren't doing anything, so they sit with the finished ones.
  const stalled = data?.running.filter((sandbox) => sandbox.stalled) ?? [];
  const finished = [...stalled, ...(data?.finished ?? [])];

  return (
    <div className="stack">
      {error && <p className="form-error">{error}</p>}

      <section className="card">
        <div className="card-header">
          <h2>Running now</h2>
          {data && (
            <span className="muted">
              {live.length} sandbox{live.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
        <p className="hint">Each tile follows its sandbox's browser. Open one for the full live report.</p>
        {data === null ? (
          <p className="empty">Loading…</p>
        ) : live.length === 0 ? (
          <p className="empty">No sandboxes running. Scans show up here the moment they start.</p>
        ) : (
          <ul className="sandbox-grid">
            {live.map((sandbox) => (
              <SandboxTile key={sandbox.scanId} sandbox={sandbox} now={now} />
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Finished</h2>
          {data && (
            <span className="muted">
              {finished.length}
              {data.moreFinished ? "+" : ""} sandbox{finished.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
        <p className="hint">Newest first. The banner shows how each one ended.</p>
        {data === null ? (
          <p className="empty">Loading…</p>
        ) : finished.length === 0 ? (
          <p className="empty">No finished sandboxes yet.</p>
        ) : (
          <ul className="sandbox-grid">
            {finished.map((sandbox) => (
              <SandboxTile key={sandbox.scanId} sandbox={sandbox} now={now} />
            ))}
          </ul>
        )}
        {data?.moreFinished && limit < MAX_LIMIT && (
          <button type="button" className="secondary load-more" onClick={() => setLimit((n) => Math.min(MAX_LIMIT, n + PAGE))}>
            Show more
          </button>
        )}
      </section>
    </div>
  );
}
