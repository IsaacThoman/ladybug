// Community reports: approved accounts say a site is safe or unsafe, one vote
// per host. Postgres has every vote; when Solana is configured, each one is
// also written on-chain in the background (see docs/solana.md).
import express from "express";
import { REPORT_VERDICTS } from "@ladybug/shared";
import type {
  AdminReportsResponse,
  ChainScan,
  CommunityTally,
  MyReport,
  ScanReport,
  Verdict,
} from "@ladybug/shared";
import type { AccountStore, ReportStore, SiteReport, UserRecord } from "@ladybug/backend";
import { accessProblem, currentUser, requireAccount, userOf } from "./accounts.ts";
import { logEvent } from "./activity.ts";
import { HttpError, requireEnum, requireString } from "./http.ts";
import type { Limiter } from "./routes/auth.ts";
import type { ReportChain } from "./solana/chain.ts";
import { MAX_HOST_BYTES, reportHash, urlHash } from "./solana/codec.ts";
import type { SiteState } from "./solana/codec.ts";
import { normalizeUrl } from "./urls.ts";

/** Reports (new or changed votes) allowed per account per minute. */
export const REPORTS_PER_MINUTE = 10;

export type ReportsDeps = {
  accounts: AccountStore;
  reports: ReportStore;
  /** null when Solana isn't configured. */
  chain: ReportChain | null;
  limit: Limiter;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function readTarget(value: unknown) {
  const target = normalizeUrl(requireString(value, "url", 8192));
  if (!target.ok) throw new HttpError(400, target.reason);
  if (Buffer.byteLength(target.host, "utf8") > MAX_HOST_BYTES) throw new HttpError(400, "That host name is too long");
  return target;
}

let lastRpcWarning = 0;
function warnRpc(err: unknown) {
  if (Date.now() - lastRpcWarning < 60_000) return;
  lastRpcWarning = Date.now();
  console.warn(`[solana] reading a site failed, showing Postgres tallies: ${errorText(err)}`);
}

/**
 * The tally for a host. On-chain counts win once the Site account exists and
 * none of the host's votes are still on their way there; otherwise (Solana
 * off, RPC down, or writes pending) Postgres counts.
 */
export async function communityTally(deps: Pick<ReportsDeps, "reports" | "chain">, host: string, userId: string | null) {
  const { reports, chain } = deps;
  const [counts, mine, site, notarised] = await Promise.all([
    reports.counts(host),
    userId ? reports.mine(userId, host) : undefined,
    chain
      ? chain.readSite(host).catch((err: unknown): SiteState | null | undefined => {
          warnRpc(err);
          return undefined;
        })
      : undefined,
    chain ? reports.latestScan(host) : null,
  ]);
  const fromChain = site && counts.pending === 0;
  let lastScan: ChainScan | null = null;
  if (chain) {
    // undefined: the RPC failed, so fall back to the last scan we know landed.
    const scan = site === undefined ? notarised : site?.scan;
    if (scan) {
      const signature = notarised && notarised.reportHash === scan.reportHash ? notarised.signature : null;
      lastScan = {
        verdict: scan.verdict,
        score: scan.score,
        reportHash: scan.reportHash,
        scannedAt: scan.scannedAt,
        signature,
        explorerUrl: signature ? chain.txUrl(signature) : null,
      };
    }
  }
  const tally: CommunityTally = {
    host,
    safe: fromChain ? site.safeReports : counts.safe,
    unsafe: fromChain ? site.unsafeReports : counts.unsafe,
    chain: chain ? chain.siteInfo(host) : null,
    lastScan,
  };
  if (mine !== undefined) tally.mine = mine ? myReport(mine, chain) : null;
  return tally;
}

const myReport = (report: SiteReport, chain: ReportChain | null): MyReport => ({
  verdict: report.verdict,
  reportedAt: report.updatedAt,
  chainStatus: report.chainStatus,
  signature: report.signature,
  explorerUrl: report.signature && chain ? chain.txUrl(report.signature) : null,
});

/** Sends a vote on-chain and records how it went. Never throws. */
async function writeReport(deps: ReportsDeps, user: UserRecord, report: SiteReport) {
  const { chain, reports } = deps;
  if (!chain) return;
  let signature: string;
  try {
    signature = await chain.submitReport({
      accountId: user.id,
      host: report.host,
      verdict: report.verdict,
      urlHash: urlHash(report.url),
    });
  } catch (err) {
    logEvent({
      type: "error",
      message: `Couldn't write ${user.username}'s report on ${report.host} to Solana: ${errorText(err)}`,
      host: report.host,
      details: { userId: user.id, user: user.username, verdict: report.verdict },
    });
    await reports.setChainStatus(user.id, report.host, report.verdict, "failed", null).catch((dbErr: unknown) => {
      console.error("[server] saving a report's chain status failed:", dbErr);
    });
    return;
  }
  await reports.setChainStatus(user.id, report.host, report.verdict, "confirmed", signature).catch((err: unknown) => {
    console.error(`[server] saving report signature ${signature} failed:`, err);
  });
}

export function reportsRouter(deps: ReportsDeps) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Anyone can read a tally; signed-in approved accounts also see their own vote.
  router.get("/", async (req, res) => {
    const target = readTarget(req.query.url);
    const user = await currentUser(deps.accounts, req);
    const body: CommunityTally = await communityTally(deps, target.host, accessProblem(user) ? null : user!.id);
    res.json(body);
  });

  router.post("/", requireAccount(deps.accounts), async (req, res) => {
    const user = userOf(res);
    if (!(await deps.limit(`reports:${user.id}`))) {
      res.setHeader("Retry-After", "60");
      throw new HttpError(429, "That's a lot of reports. Try again in a minute");
    }
    const target = readTarget(req.body?.url);
    const verdict = requireEnum(req.body?.verdict, REPORT_VERDICTS, "verdict");
    const previous = await deps.reports.mine(user.id, target.host);
    const report = await deps.reports.upsert({
      userId: user.id,
      host: target.host,
      url: target.url,
      verdict,
      chainStatus: deps.chain ? "pending" : "off",
    });
    const change = previous && previous.verdict !== verdict ? ` (was ${previous.verdict})` : "";
    logEvent({
      type: "report",
      message: `${user.username} reported ${target.host} as ${verdict}${change}`,
      url: target.url,
      host: target.host,
      verdict,
      details: { userId: user.id, user: user.username, previous: previous?.verdict ?? null, chainStatus: report.chainStatus },
    });
    void writeReport(deps, user, report);
    const body: CommunityTally = await communityTally(deps, target.host, user.id);
    res.json(body);
  });

  return router;
}

/** Hosts with reports, newest first, beside what the URL store says about them. */
export type AdminReportsLister = (limit: number) => Promise<AdminReportsResponse>;

/** Worth an admin's look: the majority disagrees with the stored verdict, or there's none and someone says unsafe. */
export function needsReview(safe: number, unsafe: number, verdict: Verdict | null) {
  if (verdict === null) return unsafe > 0;
  const majority: Verdict | null = unsafe > safe ? "unsafe" : safe > unsafe ? "safe" : null;
  return majority !== null && majority !== verdict;
}

export function adminReports(
  reports: ReportStore,
  verdicts: (hosts: string[]) => Promise<Map<string, Verdict>>,
): AdminReportsLister {
  return async (limit) => {
    const sites = await reports.sites(limit);
    const known = await verdicts(sites.map((site) => site.host));
    return {
      sites: sites.map((site) => {
        const verdict = known.get(site.host) ?? null;
        return { ...site, verdict, needsReview: needsReview(site.safe, site.unsafe, verdict) };
      }),
    };
  };
}

/** Writes a sandbox verdict on-chain in the background. Failures are logged, never thrown. */
export function notariseScan(chain: ReportChain, reports: ReportStore, host: string, scanId: string, report: ScanReport) {
  const hash = reportHash(report);
  const score = Math.max(0, Math.min(100, Math.round(report.score)));
  chain
    .recordScan({ host, verdict: report.verdict, score, reportHash: hash })
    .then((signature) =>
      reports.saveScan({
        host,
        scanId,
        verdict: report.verdict,
        score,
        reportHash: hash.toString("hex"),
        signature,
        scannedAt: new Date().toISOString(),
      }),
    )
    .catch((err: unknown) => {
      logEvent({
        type: "error",
        message: `Couldn't record the scan of ${host} on Solana: ${errorText(err)}`,
        host,
        details: { scanId },
      });
    });
}
