import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { UrlRecord, UrlScope, Verdict } from "@ladybug/shared";
import { api } from "../api";
import { formatFull, timeAgo } from "../format";
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
                  <tr key={record.id}>
                    <td>
                      <VerdictBadge verdict={record.verdict} />
                    </td>
                    <td className="url-cell">
                      <span className="mono truncate" title={record.url}>
                        {record.scope === "host" ? record.host : record.url}
                      </span>
                      {record.scope === "host" && <span className="scope-tag">Whole host</span>}
                    </td>
                    <td className="reason-cell">{record.reason}</td>
                    <td>{SOURCE_LABEL[record.source]}</td>
                    <td className="muted" title={formatFull(record.checkedAt)}>
                      {timeAgo(record.checkedAt)}
                    </td>
                    <td className="actions">
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
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
