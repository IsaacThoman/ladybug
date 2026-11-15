import { useEffect, useState } from "react";
import type { AdminSiteReports, Verdict } from "@ladybug/shared";
import { api } from "../api";
import { formatFull, timeAgo } from "../format";
import Badge, { VerdictBadge } from "./Badge";

const LIMIT = 50;

/**
 * Hosts people have reported as safe or unsafe (docs/solana.md). Reports never
 * change a verdict on their own: an admin settles it here with a host rule.
 */
export default function CommunityReports({ version, onChange }: { version: number; onChange: () => void }) {
  const [sites, setSites] = useState<AdminSiteReports[] | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .reports(LIMIT)
      .then(({ sites }) => {
        if (cancelled) return;
        setSites(sites);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [version]);

  // A server without community reports: leave the card out.
  if (sites === null) return null;

  const mark = async (host: string, verdict: Verdict) => {
    setBusy(host);
    try {
      await api.addUrl({ url: host, scope: "host", verdict, reason: "Reviewed community reports" });
      setError(null);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toReview = sites.filter((site) => site.needsReview).length;
  const shown = reviewOnly ? sites.filter((site) => site.needsReview) : sites;

  return (
    <section className="card">
      <div className="card-header">
        <h2>Community reports</h2>
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={!reviewOnly} onClick={() => setReviewOnly(false)}>
            All
          </button>
          <button type="button" aria-pressed={reviewOnly} onClick={() => setReviewOnly(true)}>
            Needs review{toReview > 0 ? ` (${toReview})` : ""}
          </button>
        </div>
      </div>
      <p className="hint">
        What signed-in people say about a host. Reports don't change a verdict on their own; marking a host
        here saves a whole-host rule.
      </p>
      {error && <p className="form-error">{error}</p>}
      {shown.length === 0 ? (
        <p className="empty">{reviewOnly ? "Nothing needs a look." : "No community reports yet."}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Reports</th>
                <th>Stored verdict</th>
                <th>Last report</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((site) => {
                const last = Date.parse(site.lastReportAt);
                const targets: Verdict[] = site.verdict ? [site.verdict === "safe" ? "unsafe" : "safe"] : ["unsafe", "safe"];
                return (
                  <tr key={site.host}>
                    <td className="url-cell">
                      <span className="mono truncate" title={site.host}>
                        {site.host}
                      </span>
                    </td>
                    <td>
                      <span className="badges">
                        {site.unsafe > 0 && <Badge tone="critical" icon="alert" label={`${site.unsafe} unsafe`} />}
                        {site.safe > 0 && <Badge tone="good" icon="check" label={`${site.safe} safe`} />}
                      </span>
                    </td>
                    <td>
                      <span className="badges">
                        {site.verdict ? (
                          <VerdictBadge verdict={site.verdict} />
                        ) : (
                          <Badge tone="neutral" icon="minus" label="None" />
                        )}
                        {site.needsReview && <Badge tone="warning" icon="clock" label="Needs review" />}
                      </span>
                    </td>
                    <td className="muted" title={formatFull(last)}>
                      {timeAgo(last)}
                    </td>
                    <td className="actions">
                      {targets.map((verdict) => (
                        <button
                          key={verdict}
                          type="button"
                          className="secondary small"
                          disabled={busy === site.host}
                          onClick={() => void mark(site.host, verdict)}
                        >
                          Mark {verdict}
                        </button>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
