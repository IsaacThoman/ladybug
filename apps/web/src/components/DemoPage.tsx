import { useEffect, useReducer, useRef, useState } from "react";
import type { ScanEvent, ScanResponse } from "@ladybug/shared";
import {
  DEMO_DURATION_S,
  DEMO_INPUT_URL,
  DEMO_SCAN_ID,
  DEMO_TIMELINE,
  demoArtifactSrc,
  demoResponse,
} from "../demo.ts";
import { applyEvent, applyScan, emptyScan } from "../scanState.ts";
import type { ScanState } from "../scanState.ts";
import ReportView from "./ReportView.tsx";

type Action = { type: "events"; events: { event: ScanEvent; id: string }[] } | { type: "scan"; scan: ScanResponse };

function reducer(state: ScanState, action: Action): ScanState {
  if (action.type === "scan") return applyScan(state, action.scan);
  return action.events.reduce((s, e) => applyEvent(s, e.event, e.id), state);
}

const stepEvent = (start: number, i: number) => {
  const step = DEMO_TIMELINE[i];
  return { event: step.event(new Date(start + step.t * 1000).toISOString()), id: `demo-${i}` };
};

export default function DemoPage() {
  const [run, setRun] = useState(0);
  return <DemoRun key={run} onReplay={() => setRun((r) => r + 1)} />;
}

function DemoRun({ onReplay }: { onReplay: () => void }) {
  const [start] = useState(() => Date.now());
  const [scan, dispatch] = useReducer(reducer, null, () => ({
    ...emptyScan(DEMO_SCAN_ID, DEMO_INPUT_URL),
    createdAt: new Date(start).toISOString(),
  }));
  const timers = useRef<number[]>([]);
  const next = useRef(0);

  useEffect(() => {
    const ids = timers.current;
    const after = (t: number, fn: () => void) =>
      ids.push(window.setTimeout(fn, Math.max(0, start + t * 1000 - Date.now())));
    DEMO_TIMELINE.forEach((step, i) =>
      after(step.t, () => {
        next.current = i + 1;
        dispatch({ type: "events", events: [stepEvent(start, i)] });
      }),
    );
    // The full report lands just after the terminal status, as with a live scan.
    after(DEMO_DURATION_S + 0.6, () => dispatch({ type: "scan", scan: demoResponse(start) }));
    return () => {
      ids.forEach((id) => window.clearTimeout(id));
      ids.length = 0;
    };
  }, [start]);

  const skip = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current.length = 0;
    const rest = [];
    for (let i = next.current; i < DEMO_TIMELINE.length; i++) rest.push(stepEvent(start, i));
    next.current = DEMO_TIMELINE.length;
    dispatch({ type: "events", events: rest });
    dispatch({ type: "scan", scan: demoResponse(start) });
  };

  const done = scan.report !== null;
  const notice = (
    <div className="demo-bar" role="status">
      <span className="demo-tag">Demo</span>
      <span className="demo-copy">Recorded phishing scan · fictional brand</span>
      <span className="demo-actions">
        {!done && (
          <button type="button" className="button ghost small" onClick={skip}>
            Skip to report
          </button>
        )}
        <button type="button" className="button ghost small" onClick={onReplay}>
          Replay
        </button>
      </span>
    </div>
  );

  return <ReportView scan={scan} artifactSrc={demoArtifactSrc} headerExtra={notice} />;
}
