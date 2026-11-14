// The admin Sandboxes page: every running scan with its newest screenshot and
// what it's doing, plus the newest finished ones. Running scans are read from
// their Valkey event streams, finished ones from their stored reports.
import { isTerminalStatus } from "@ladybug/shared";
import type { AdminSandbox, AdminSandboxesResponse } from "@ladybug/shared";
import { latestEvents, listSandboxScans } from "@ladybug/backend";
import type { Db, SandboxScanRow, StreamEntry } from "@ladybug/backend";
import type { Redis } from "ioredis";

/** A running scan with no news for this long has probably lost its worker. */
export const STALLED_AFTER_MS = 20 * 60_000;
/** How far back into a scan's stream to look. Scans emit far fewer events than this. */
const STREAM_WINDOW = 500;

/** Valkey stream ids start with the entry's epoch ms. */
const entryTime = (id: string) => {
  const ms = Number(id.split("-")[0]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};

const later = (a: string, b: string | null) => (b && Date.parse(b) > Date.parse(a) ? b : a);

/**
 * One tile from a scan row and its stream entries (newest first, maybe none).
 * The stored report wins over the stream where both have something.
 */
export function sandboxTile(row: SandboxScanRow, entries: StreamEntry[], now = Date.now()): AdminSandbox {
  const terminal = isTerminalStatus(row.status);
  const tile: AdminSandbox = {
    scanId: row.scanId,
    inputUrl: row.inputUrl,
    finalUrl: null,
    status: row.status,
    stalled: false,
    startedBy: row.startedBy,
    createdAt: row.createdAt,
    lastActivityAt: later(row.updatedAt, entries[0] ? entryTime(entries[0].id) : null),
    finishedAt: terminal ? row.updatedAt : null,
    screenshot: null,
    screenshotCount: 0,
    activity: null,
    verdict: null,
    score: null,
    error: row.error,
  };

  for (const { event } of entries) {
    switch (event.type) {
      case "screenshot":
        tile.screenshot ??= { artifactKey: event.artifactKey, label: event.label };
        tile.screenshotCount++;
        break;
      case "tool_call":
        tile.activity ??= event.summary;
        break;
      case "agent_note":
        tile.activity ??= event.text;
        break;
      case "redirect_chain":
        tile.finalUrl ??= event.chain.at(-1) ?? null;
        break;
      case "report":
        tile.verdict ??= event.verdict;
        tile.score ??= event.score;
        break;
      case "status":
        if (event.status === "failed") tile.error ??= event.message ?? null;
        break;
    }
  }

  const report = row.report;
  if (report) {
    const shots = report.screenshots ?? [];
    if (shots.length) {
      tile.screenshot = shots.at(-1)!;
      tile.screenshotCount = shots.length;
    }
    tile.finalUrl = report.finalUrl || tile.finalUrl;
    tile.verdict = report.verdict;
    tile.score = report.score;
    tile.activity = report.summary || tile.activity;
    tile.finishedAt = report.finishedAt || tile.finishedAt;
  }
  if (tile.finalUrl === tile.inputUrl) tile.finalUrl = null;
  tile.stalled = !terminal && now - Date.parse(tile.lastActivityAt) > STALLED_AFTER_MS;
  return tile;
}

export async function listSandboxes(db: Db, redis: Redis, limit: number): Promise<AdminSandboxesResponse> {
  const scans = await listSandboxScans(db, limit);
  // Finished scans with a report don't need their stream; failed ones may still have screenshots in it.
  const withEvents = (row: SandboxScanRow) =>
    row.report ? Promise.resolve(sandboxTile(row, [])) : latestEvents(redis, row.scanId, STREAM_WINDOW).then((entries) => sandboxTile(row, entries));
  const [running, finished] = await Promise.all([
    Promise.all(scans.running.map(withEvents)),
    Promise.all(scans.finished.map(withEvents)),
  ]);
  return { running, finished, moreFinished: scans.moreFinished };
}
