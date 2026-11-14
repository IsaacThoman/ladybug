import type { IconName, Tone } from "../format";
import Icon from "./Icon";

/** Status is never color alone: every badge carries an icon and a label. */
export default function Badge({ tone, icon, label }: { tone: Tone; icon: IconName; label: string }) {
  return (
    <span className="badge" data-tone={tone}>
      <Icon name={icon} size={12} />
      {label}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: "safe" | "unsafe" }) {
  return verdict === "safe" ? (
    <Badge tone="good" icon="check" label="Safe" />
  ) : (
    <Badge tone="critical" icon="alert" label="Unsafe" />
  );
}
