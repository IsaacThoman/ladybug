import type { Verdict } from "@ladybug/shared";

export default function VerdictChip({ verdict, large }: { verdict: Verdict | null; large?: boolean }) {
  return <span className={`verdict-chip ${verdict ?? "pending"}${large ? " large" : ""}`}>{verdict ?? "pending"}</span>;
}
