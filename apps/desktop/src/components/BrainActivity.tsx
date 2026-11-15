import { useEffect, useState } from "react";
import type { BrainCommand } from "@ladybug/brain";
import type { FlyBrain } from "../brain/fly-brain";
import type { BrainStatus } from "../brain/client";
import type { OverlayLayout } from "../ladybug-api";

/** How often the panel reads the brain. */
const REFRESH_MS = 100;
/** Space between the panel and the corner of the work area. */
const MARGIN = 12;

const COMMANDS: { key: keyof BrainCommand; label: string }[] = [
  { key: "walk", label: "Walk" },
  { key: "turn", label: "Turn" },
  { key: "back", label: "Back up" },
  { key: "escape", label: "Escape" },
  { key: "wings", label: "Wings" },
  { key: "groom", label: "Groom" },
  { key: "feed", label: "Feed" },
];

const STATUS: Record<BrainStatus, string> = {
  off: "Fly brain off",
  loading: "Waking up the fly brain…",
  running: "Fly brain running",
  unavailable: "The fly brain isn't installed",
  failed: "The fly brain stopped working",
};

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const speedFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Snapshot = {
  status: BrainStatus;
  error: string | null;
  neurons: number;
  connections: number;
  spikesPerSecond: number;
  speed: number;
  active: number;
  command: BrainCommand | null;
};

function read(brain: FlyBrain): Snapshot {
  const { client } = brain;
  const { spikesPerSecond, speed } = client.activity();
  return {
    status: client.status,
    error: client.error,
    neurons: client.neurons,
    connections: client.connections,
    spikesPerSecond,
    speed,
    active: client.state?.stats.active ?? 0,
    command: client.state?.command ?? null,
  };
}

function Meter({ command, label, value }: { command: keyof BrainCommand; label: string; value: number }) {
  const bipolar = command === "turn";
  const clamped = Math.min(1, Math.max(bipolar ? -1 : 0, Number.isFinite(value) ? value : 0));
  // Turning toward the fly's left heads it to the right of the screen, so the bar points that way.
  const fill = bipolar
    ? { left: `${50 + Math.min(0, -clamped) * 50}%`, width: `${Math.abs(clamped) * 50}%` }
    : { left: 0, width: `${clamped * 100}%` };
  const text = bipolar
    ? clamped === 0 ? "straight" : `${clamped.toFixed(2).replace("-", "")} toward its ${clamped < 0 ? "left" : "right"}`
    : clamped.toFixed(2);
  return (
    <div className="brain-panel-meter" data-command={command}>
      <span className="brain-panel-meter-label">{label}</span>
      <span
        className="brain-panel-meter-track"
        data-bipolar={bipolar || undefined}
        role="meter"
        aria-label={label}
        aria-valuemin={bipolar ? -1 : 0}
        aria-valuemax={1}
        aria-valuenow={Number(clamped.toFixed(2))}
        aria-valuetext={text}
      >
        <span className="brain-panel-meter-fill" style={fill} />
      </span>
    </div>
  );
}

/** A quiet corner panel showing what the fly brain is doing, refreshed about ten times a second. */
export default function BrainActivity({ brain, layout }: { brain: FlyBrain; layout: OverlayLayout }) {
  const [view, setView] = useState(() => read(brain));
  useEffect(() => {
    const interval = setInterval(() => setView(read(brain)), REFRESH_MS);
    return () => clearInterval(interval);
  }, [brain]);

  const { workArea } = layout;
  const running = view.status === "running";
  return (
    <aside
      className="brain-panel"
      aria-label="Fly brain activity"
      style={{
        top: workArea.y + MARGIN,
        right: layout.width - (workArea.x + workArea.width) + MARGIN,
        maxHeight: workArea.height - MARGIN * 2,
      }}
    >
      <p className="brain-panel-status" data-status={view.status} role="status">{STATUS[view.status]}</p>
      {running && <>
        <dl className="brain-panel-stats">
          <div><dt>Neurons</dt><dd>{whole.format(view.neurons)}</dd></div>
          <div><dt>Connections</dt><dd>{compact.format(view.connections)}</dd></div>
          <div><dt>Spikes per second</dt><dd>{compact.format(view.spikesPerSecond)}</dd></div>
          <div><dt>Active neurons</dt><dd>{whole.format(view.active)}</dd></div>
          <div><dt>Speed</dt><dd>{speedFormat.format(view.speed)}× real time</dd></div>
        </dl>
        <div className="brain-panel-meters">
          {COMMANDS.map(({ key, label }) => (
            <Meter key={key} command={key} label={label} value={view.command?.[key] ?? 0} />
          ))}
        </div>
      </>}
      {view.status === "unavailable" && <p className="brain-panel-note">Its data wasn't found on this computer.</p>}
      {view.status === "failed" && <>
        {view.error && <p className="brain-panel-note brain-panel-error">{view.error}</p>}
        <p className="brain-panel-note">Turn Fly Brain off and on again to retry.</p>
      </>}
    </aside>
  );
}
