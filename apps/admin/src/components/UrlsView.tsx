import { Fragment, useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  DEMO_DEFAULT_DELAY_SECONDS,
  DEMO_DEFAULT_HOLD_SECONDS,
  DEMO_MAX_DELAY_SECONDS,
  DEMO_MAX_HOLD_SECONDS,
  DEMO_MIN_HOLD_SECONDS,
} from "@ladybug/shared";
import type { UrlRecord, UrlScope, Verdict } from "@ladybug/shared";
import { api } from "../api";
import { formatFull, timeAgo } from "../format";
import { useNow } from "../useAdminStream";
import { VerdictBadge } from "./Badge";
import CommunityReports from "./CommunityReports";

const PER_PAGE = 50;

const SOURCE_LABEL: Record<UrlRecord["source"], string> = {
  seed: "Seed",
  analysis: "Analysis",
  admin: "Admin",
};

export default function UrlsView({ version }: { version: number }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [verdict, setVerdict] = useState<Verdict | "">("");
  const [records, setRecords] = useState<UrlRecord[]>([]);
  const [found, setFound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // The record whose demo delay is being edited.
  const [editingDemo, setEditingDemo] = useState<string | null>(null);
  const now = useNow(1_000);

  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    let cancelled = false;
    api
      .urls({ q: q || undefined, verdict: verdict || undefined }, 1, PER_PAGE)
      .then((page) => {
        if (cancelled) return;
        setRecords(page.items);
        setFound(page.found);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [q, verdict, version, reload]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="stack">
      <CommunityReports version={version + reload} onChange={refresh} />
      <AddRecordForm onAdded={refresh} />
      <section className="card">
        <div className="toolbar">
          <input
            type="search"
            placeholder="Search URLs, hosts and reasons"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Search known URLs"
          />
          <div className="segmented" role="group" aria-label="Verdict">
            {(["", "safe", "unsafe"] as const).map((option) => (
              <button
                key={option || "all"}
                type="button"
                aria-pressed={verdict === option}
                onClick={() => setVerdict(option)}
              >
                {option === "" ? "All" : option === "safe" ? "Safe" : "Unsafe"}
              </button>
            ))}
          </div>
        </div>
        <p className="hint">
          {found.toLocaleString()} record{found === 1 ? "" : "s"} in Typesense. Host records cover every
          page on that host and its subdomains.
        </p>
        {error && <p className="form-error">{error}</p>}
        {records.length === 0 ? (
          <p className="empty">No matching records.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Verdict</th>
                  <th>URL or host</th>
                  <th>Reason</th>
                  <th>Source</th>
                  <th>Checked</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <Fragment key={record.id}>
                    <tr>
                      <td>
                        <VerdictBadge verdict={record.verdict} />
                      </td>
                      <td className="url-cell">
                        <span className="mono truncate" title={record.url}>
                          {record.scope === "host" ? record.host : record.url}
                        </span>
                        {record.scope === "host" && <span className="scope-tag">Whole host</span>}
                        {record.verdict === "unsafe" && record.demoDelaySeconds !== undefined && (
                          <span className="demo-tag">{demoStatus(record, now)}</span>
                        )}
                      </td>
                      <td className="reason-cell">{record.reason}</td>
                      <td>{SOURCE_LABEL[record.source]}</td>
                      <td className="muted" title={formatFull(record.checkedAt)}>
                        {timeAgo(record.checkedAt)}
                      </td>
                      <td className="actions">
                        {record.verdict === "unsafe" && (
                          <button
                            type="button"
                            className="secondary small"
                            aria-expanded={editingDemo === record.id}
                            onClick={() => setEditingDemo((id) => (id === record.id ? null : record.id))}
                          >
                            Demo delay
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() =>
                            act(() => api.setVerdict(record.id, record.verdict === "safe" ? "unsafe" : "safe"))
                          }
                        >
                          Mark {record.verdict === "safe" ? "unsafe" : "safe"}
                        </button>
                        <button
                          type="button"
                          className="danger small"
                          onClick={() => {
                            const name = record.scope === "host" ? record.host : record.url;
                            if (confirm(`Forget ${name}? It will be analysed again next time it's visited.`)) {
                              void act(() => api.deleteUrl(record.id));
                            }
                          }}
                        >
                          Forget
                        </button>
                      </td>
                    </tr>
                    {editingDemo === record.id && record.verdict === "unsafe" && (
                      <tr className="demo-row">
                        <td colSpan={6}>
                          <DemoForm
                            record={record}
                            onDone={() => {
                              setEditingDemo(null);
                              refresh();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** "m:ss" for a countdown. */
function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function demoStatus(record: UrlRecord, now: number) {
  if (record.demoRevealedUntil !== undefined && record.demoRevealedUntil > now) {
    return `Demo · revealed, re-arms in ${countdown(record.demoRevealedUntil - now)}`;
  }
  return `Demo · reveals unsafe ${record.demoDelaySeconds}s after a visit`;
}

/**
 * Stages an unsafe record for a demo: a visit acts unknown while the bug
 * pretends to check, then it's revealed as unsafe after the delay, and stays
 * that way for the hold time before staging again.
 */
function DemoForm({ record, onDone }: { record: UrlRecord; onDone: () => void }) {
  const staged = record.demoDelaySeconds !== undefined;
  const [delay, setDelay] = useState(String(record.demoDelaySeconds ?? DEMO_DEFAULT_DELAY_SECONDS));
  const [hold, setHold] = useState(String(record.demoHoldSeconds ?? DEMO_DEFAULT_HOLD_SECONDS));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.setDemo(record.id, { delaySeconds: Number(delay), holdSeconds: Number(hold) }));
  };

  return (
    <form className="demo-form" onSubmit={submit}>
      <p className="hint">
        Visits act unknown while the bug pretends to check, then get flagged unsafe after the delay. It stays
        flagged for the hold time, then re-arms for the next run.
      </p>
      <div className="demo-fields">
        <label>
          Reveal after
          <input
            type="number"
            min={1}
            max={DEMO_MAX_DELAY_SECONDS}
            step={1}
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            required
          />
          s
        </label>
        <label>
          Hold for
          <input
            type="number"
            min={DEMO_MIN_HOLD_SECONDS}
            max={DEMO_MAX_HOLD_SECONDS}
            step={1}
            value={hold}
            onChange={(e) => setHold(e.target.value)}
            required
          />
          s
        </label>
        <button type="submit" className="small" disabled={busy}>
          {staged ? "Save and re-arm" : "Stage demo"}
        </button>
        {staged && (
          <button type="button" className="danger small" disabled={busy} onClick={() => run(() => api.clearDemo(record.id))}>
            Stop staging
          </button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

function AddRecordForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<UrlScope>("url");
  const [verdict, setVerdict] = useState<Verdict>("unsafe");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.addUrl({ url, scope, verdict, reason: reason.trim() || undefined });
      setUrl("");
      setReason("");
      setError(null);
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Add a rule</h2>
      <form className="rule-form" onSubmit={submit}>
        <input
          type="text"
          placeholder={scope === "host" ? "example.com" : "https://example.com/page"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          spellCheck={false}
          aria-label={scope === "host" ? "Host" : "URL"}
        />
        <select value={scope} onChange={(e) => setScope(e.target.value as UrlScope)} aria-label="Scope">
          <option value="url">Exact URL</option>
          <option value="host">Whole host</option>
        </select>
        <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)} aria-label="Verdict">
          <option value="unsafe">Unsafe</option>
          <option value="safe">Safe</option>
        </select>
        <input
          type="text"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason"
        />
        <button type="submit" disabled={busy}>
          Save
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
