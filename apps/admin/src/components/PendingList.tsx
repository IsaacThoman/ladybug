import type { PendingAnalysis } from "@ladybug/shared";
import { useNow } from "../useAdminStream";

export default function PendingList({ pending }: { pending: PendingAnalysis[] }) {
  const now = useNow(250);
  return (
    <section className="card">
      <h2>Analyses in progress</h2>
      {pending.length === 0 ? (
        <p className="empty">Nothing running. Unknown URLs show up here while they're checked.</p>
      ) : (
        <ul className="pending">
          {pending.map((item) => {
            const total = Math.max(1, item.etaAt - item.startedAt);
            const progress = Math.min(1, (now - item.startedAt) / total);
            const left = Math.max(0, Math.ceil((item.etaAt - now) / 1000));
            return (
              <li key={item.url}>
                <div className="pending-row">
                  <span className="mono truncate" title={item.url}>
                    {item.url}
                  </span>
                  <span className="muted">{left}s left</span>
                </div>
                <div
                  className="meter"
                  role="progressbar"
                  aria-label={`Analysis of ${item.host}`}
                  aria-valuenow={Math.round(progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="meter-fill" style={{ width: `${progress * 100}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
