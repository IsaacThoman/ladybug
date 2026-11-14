import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TIMELINE_RANGES } from "@ladybug/shared";
import type { CheckTimeline, TimelineBucket, TimelineRange } from "@ladybug/shared";
import { api } from "../api";
import type { IconName } from "../format";
import Icon from "./Icon";

const POLL_MS = 15_000;
/** Wait this long after a visit before refetching, so a burst of visits is one request. */
const LIVE_REFRESH_DELAY_MS = 1_500;
const HEIGHT = 200;
const MARGIN = { top: 8, right: 4, bottom: 24, left: 36 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

type SeriesKey = "unsafe" | "unknown" | "safe";

/** Bottom to top. Unsafe sits on the baseline, where it's easiest to read. */
const SERIES: { key: SeriesKey; label: string; icon: IconName }[] = [
  { key: "unsafe", label: "Known unsafe", icon: "alert" },
  { key: "unknown", label: "Unknown, analysed", icon: "clock" },
  { key: "safe", label: "Known safe", icon: "check" },
];

const RANGE_LABELS: Record<TimelineRange, string> = { "1h": "Last hour", "24h": "24 hours", "7d": "7 days" };

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTimeFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });

const tickLabel = (at: number, range: TimelineRange) => (range === "7d" ? dayFormat : timeFormat).format(at);
const bucketLabel = (bucket: TimelineBucket, bucketMs: number, range: TimelineRange) => {
  const format = range === "7d" ? dayTimeFormat : timeFormat;
  return `${format.format(bucket.at)} – ${timeFormat.format(bucket.at + bucketMs)}`;
};

const total = (bucket: TimelineBucket) => bucket.safe + bucket.unsafe + bucket.unknown;

/** A clean axis maximum (1, 2, 5, 10, 20, …) and the ticks under it. */
function niceTicks(max: number) {
  if (max <= 0) return [0, 1];
  const step = [1, 2, 5].map((m) => m * 10 ** Math.floor(Math.log10(max / 2))).find((s) => max / s <= 4) ?? 10 ** Math.ceil(Math.log10(max / 2));
  const ticks = [];
  for (let t = 0; t < max + step; t += step) ticks.push(t);
  return ticks;
}

/** A column segment: square at the bottom, rounded on top when it's the top of the stack. */
function segmentPath(x: number, y: number, width: number, height: number, roundTop: boolean) {
  const r = roundTop ? Math.min(RADIUS, height, width / 2) : 0;
  return `M${x},${y + height}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ""}H${x + width - r}${r ? `Q${x + width},${y} ${x + width},${y + r}` : ""}V${y + height}Z`;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Visits checked over time, by decision. `refreshKey` changes when a new visit is decided. */
export default function VisitsChart({ refreshKey }: { refreshKey: string | undefined }) {
  const [range, setRange] = useState<TimelineRange>("1h");
  const [timeline, setTimeline] = useState<CheckTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [plotRef, width] = useWidth();
  // Bumped a moment after each new visit, so the chart follows live traffic.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!refreshKey) return;
    const timer = setTimeout(() => setReloads((n) => n + 1), LIVE_REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .timeline(range)
        .then((t) => {
          if (cancelled) return;
          setTimeline(t);
          setError(null);
        })
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [range, reloads]);

  const shown = timeline?.available && timeline.range === range ? timeline : null;
  const buckets = shown?.buckets ?? [];
  const totals = Object.fromEntries(SERIES.map((s) => [s.key, buckets.reduce((sum, b) => sum + b[s.key], 0)])) as Record<SeriesKey, number>;
  const ticks = niceTicks(Math.max(0, ...buckets.map(total)));
  const axisMax = ticks[ticks.length - 1];

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const slot = buckets.length ? plotWidth / buckets.length : 0;
  const barWidth = Math.max(2, Math.min(MAX_BAR, slot * 0.6));
  const y = (value: number) => MARGIN.top + plotHeight - (value / axisMax) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotWidth / 72))));
  const hovered = hover !== null ? buckets[hover] : undefined;

  return (
    <section className="card visits-chart">
      <div className="card-header">
        <div>
          <h2>Visits checked</h2>
          <p className="hint">
            {shown
              ? `${(totals.safe + totals.unsafe + totals.unknown).toLocaleString()} in the ${range === "1h" ? "last hour" : `last ${RANGE_LABELS[range].toLowerCase()}`} · TimescaleDB continuous aggregate`
              : "By what Ladybugg decided, from the visit hypertable"}
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Time range">
          {TIMELINE_RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {timeline && !timeline.available ? (
        <p className="empty">
          Visit history needs TimescaleDB. Run the compose stack's Postgres, or point <code>DATABASE_URL</code> at a
          Tiger Cloud service.
        </p>
      ) : (
        <>
          <ul className="chart-legend">
            {SERIES.map((s) => (
              <li key={s.key}>
                <span className="swatch" data-series={s.key} aria-hidden="true" />
                <Icon name={s.icon} size={12} />
                {s.label}
                <span className="legend-value">{shown ? totals[s.key].toLocaleString() : "–"}</span>
              </li>
            ))}
          </ul>
          <div className="chart-plot" ref={plotRef} onMouseLeave={() => setHover(null)}>
            {width > 0 && (
              <svg width={width} height={HEIGHT} role="img" aria-label={`Visits checked per ${shown ? Math.round(shown.bucketMs / 60_000) : 5} minutes, by decision`}>
                {ticks.map((t) => (
                  <g key={t}>
                    <line className="chart-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} data-baseline={t === 0 || undefined} />
                    <text className="chart-tick" x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                      {t.toLocaleString()}
                    </text>
                  </g>
                ))}
                {buckets.map((bucket, i) => {
                  const x = MARGIN.left + i * slot + (slot - barWidth) / 2;
                  const top = SERIES.findLast((s) => bucket[s.key] > 0)?.key;
                  let base = 0;
                  return (
                    <g key={bucket.at} data-dim={hover !== null && hover !== i ? true : undefined}>
                      {SERIES.map((s) => {
                        const value = bucket[s.key];
                        if (value === 0) return null;
                        const y0 = y(base);
                        base += value;
                        // Every segment above another leaves a surface-colored gap under it.
                        const y1 = y(base);
                        const height = y0 - y1 - (y0 < y(0) ? GAP : 0);
                        if (height <= 0) return null;
                        return <path key={s.key} className="chart-bar" data-series={s.key} d={segmentPath(x, y1, barWidth, height, s.key === top)} />;
                      })}
                      {i % labelEvery === 0 && (
                        <text className="chart-tick" x={x + barWidth / 2} y={HEIGHT - 6} textAnchor="middle">
                          {tickLabel(bucket.at, range)}
                        </text>
                      )}
                      <rect
                        className="chart-hit"
                        x={MARGIN.left + i * slot}
                        y={MARGIN.top}
                        width={slot}
                        height={plotHeight}
                        onMouseEnter={() => setHover(i)}
                      />
                    </g>
                  );
                })}
              </svg>
            )}
            {hovered && shown && hover !== null && (
              <div
                className="chart-tooltip"
                style={{
                  left: Math.min(Math.max(MARGIN.left + (hover + 0.5) * slot, 90), width - 90),
                  top: Math.max(0, y(total(hovered)) - 12),
                }}
              >
                <div className="tooltip-title">{bucketLabel(hovered, shown.bucketMs, range)}</div>
                {[...SERIES].reverse().map((s) => (
                  <div className="tooltip-row" key={s.key}>
                    <span className="swatch" data-series={s.key} aria-hidden="true" />
                    {s.label}
                    <span className="legend-value">{hovered[s.key].toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            {shown && buckets.every((b) => total(b) === 0) && (
              <p className="chart-empty">No visits in this window yet.</p>
            )}
          </div>
          {error && <p className="form-error">{error}</p>}
          {shown && (
            <>
              <button type="button" className="link-button" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
                {showTable ? "Hide table" : "Show as table"}
              </button>
              {showTable && (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        {[...SERIES].reverse().map((s) => (
                          <th key={s.key}>{s.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {buckets
                        .filter((b) => total(b) > 0)
                        .reverse()
                        .map((b) => (
                          <tr key={b.at}>
                            <td>{bucketLabel(b, shown.bucketMs, range)}</td>
                            {[...SERIES].reverse().map((s) => (
                              <td key={s.key} className="num">
                                {b[s.key].toLocaleString()}
                              </td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
