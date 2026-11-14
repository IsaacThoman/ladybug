import { useEffect, useRef, useState } from "react";
import type { Confidence, Verdict } from "@ladybug/shared";

type Props = {
  score: number | null;
  verdict: Verdict | null;
  confidence: Confidence | null;
  /** Scan still running: pulse while waiting for a score. */
  pending: boolean;
};

const R = 80;
const ARC = `M ${100 - R} 100 A ${R} ${R} 0 0 1 ${100 + R} 100`;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useCountUp(target: number | null, durationMs = 1400) {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (target === null) return;
    const duration = prefersReducedMotion() ? 0 : durationMs;
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (t: number) => {
      const k = duration ? Math.min(1, Math.max(0, (t - start) / duration)) : 1;
      const eased = 1 - Math.pow(1 - k, 3);
      const v = origin + (target - origin) * eased;
      from.current = v;
      setValue(v);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return target === null ? null : value;
}

export default function ScoreGauge({ score, verdict, confidence, pending }: Props) {
  const shown = useCountUp(score);
  const hasScore = score !== null && shown !== null;
  const state = hasScore ? (verdict ?? "pending") : pending ? "waiting" : "empty";

  return (
    <div className={`gauge gauge-${state}`}>
      <svg
        viewBox="0 0 200 112"
        className="gauge-svg"
        role="img"
        aria-label={hasScore ? `Score ${score} of 100` : "Score pending"}
      >
        <path d={ARC} className="gauge-track" pathLength={100} />
        {[30, 70].map((t) => {
          const a = Math.PI * (1 - t / 100);
          return (
            <line
              key={t}
              className="gauge-tick"
              x1={100 + (R - 13) * Math.cos(a)}
              y1={100 - (R - 13) * Math.sin(a)}
              x2={100 + (R + 13) * Math.cos(a)}
              y2={100 - (R + 13) * Math.sin(a)}
            />
          );
        })}
        <path
          d={ARC}
          className="gauge-fill"
          pathLength={100}
          strokeDasharray="100 100"
          strokeDashoffset={hasScore ? 100 - Math.max(0.5, shown) : 100}
        />
        <text x="100" y="96" className="gauge-number" textAnchor="middle">
          {hasScore ? Math.round(shown) : "··"}
        </text>
      </svg>
      <div className="gauge-meta">
        <span className={`gauge-verdict ${verdict ?? ""}`}>
          {hasScore && verdict ? verdict : pending ? "analyzing" : "no score"}
        </span>
        <span className="gauge-confidence">
          {confidence ? `${confidence} confidence` : hasScore ? "score / 100" : " "}
        </span>
      </div>
    </div>
  );
}
