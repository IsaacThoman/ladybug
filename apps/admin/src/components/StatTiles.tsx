import type { AdminSummary } from "@ladybug/shared";
import { compact } from "../format";

type Tile = { label: string; value: number; note: string };

export default function StatTiles({ summary, running }: { summary: AdminSummary | null; running: number }) {
  const tiles: Tile[] = [
    {
      label: "Known URLs",
      value: summary?.urls.total ?? 0,
      note: `${compact(summary?.urls.safe ?? 0)} safe · ${compact(summary?.urls.unsafe ?? 0)} unsafe`,
    },
    { label: "Visits checked", value: summary?.events.requests ?? 0, note: "Reported by the extension or admin" },
    { label: "Pet alerts sent", value: summary?.events.alerts ?? 0, note: "Unsafe, unknown and all-clear" },
    {
      label: "Analyses running",
      value: running,
      note: `Each takes ${Math.round((summary?.analysisDelayMs ?? 30_000) / 1000)}s (placeholder)`,
    },
  ];
  return (
    <div className="tiles">
      {tiles.map((tile) => (
        <div className="tile" key={tile.label}>
          <div className="tile-label">{tile.label}</div>
          <div className="tile-value">{summary ? compact(tile.value) : "–"}</div>
          <div className="tile-note">{tile.note}</div>
        </div>
      ))}
    </div>
  );
}
