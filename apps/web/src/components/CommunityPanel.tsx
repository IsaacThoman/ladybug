import { useEffect, useState } from "react";
import type { CommunityTally, MyReport, ReportVerdict, SiteChainInfo, ChainScan } from "@ladybug/shared";
import { ApiRequestError, getCommunity, isAbort, reportSite } from "../api.ts";
import { timeAgo } from "../format.ts";
import { useSession } from "../session.ts";
import Link from "./Link.tsx";
import VerdictChip from "./VerdictChip.tsx";

/** While a vote is being written on-chain, look again this often, for this long. */
const CHAIN_POLL_MS = 3_000;
const CHAIN_POLL_LIMIT_MS = 60_000;

type Props = {
  /** The page whose site the tally is for. Mount under `key={url}`. */
  url: string;
  /** A fixed tally to show instead of asking the server (the demo). No voting. */
  sample?: CommunityTally;
};

/** What signed-in people say about the site, and, when Solana is on, what's on-chain. */
export default function CommunityPanel({ url, sample }: Props) {
  const session = useSession();
  const token = session?.token ?? null;
  const [tally, setTally] = useState<CommunityTally | null>(sample ?? null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped on each vote, so the on-chain wait starts over. */
  const [votes, setVotes] = useState(0);

  // Again on sign-in or out: the account's own vote comes with the tally.
  useEffect(() => {
    if (sample) return;
    const abort = new AbortController();
    getCommunity(url, abort.signal)
      .then((next) => {
        setTally(next);
        setUnavailable(false);
      })
      .catch((err: unknown) => {
        // An unsupported URL, or a server without community reports.
        if (!isAbort(err)) setUnavailable(true);
      });
    return () => abort.abort();
  }, [url, token, sample]);

  const pending = tally?.mine?.chainStatus === "pending";
  useEffect(() => {
    if (!pending || sample) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > CHAIN_POLL_LIMIT_MS) {
        window.clearInterval(timer);
        return;
      }
      getCommunity(url).then(setTally, () => {});
    }, CHAIN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, votes, url, sample]);

  if (unavailable || !tally) return null;

  const vote = async (verdict: ReportVerdict) => {
    setBusy(true);
    setError(null);
    try {
      setTally(await reportSite(url, verdict));
      setVotes((n) => n + 1);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.failure.kind === "unreachable"
          ? "Can't reach the computerbug server."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const total = tally.safe + tally.unsafe;
  const mine = tally.mine ?? null;
  const status = session?.account.status;

  return (
    <section className="panel community" aria-label="Community reports">
      <h2 className="panel-title">
        Community {total > 0 && <span className="count">{total}</span>}
      </h2>
      <p className="panel-note">
        What signed-in people say about <span className="mono">{tally.host}</span>.
      </p>

      {total === 0 ? (
        <p className="muted community-none">No reports yet.</p>
      ) : (
        <>
          <div className="community-tally">
            <span className="unsafe">
              <strong>{tally.unsafe}</strong> {tally.unsafe === 1 ? "says" : "say"} unsafe
            </span>
            <span className="safe">
              <strong>{tally.safe}</strong> {tally.safe === 1 ? "says" : "say"} safe
            </span>
          </div>
          <div className="community-bar" aria-hidden="true">
            <span className="unsafe" style={{ width: `${(tally.unsafe / total) * 100}%` }} />
            <span className="safe" style={{ width: `${(tally.safe / total) * 100}%` }} />
          </div>
        </>
      )}

      {!sample &&
        (!session ? (
          <p className="community-note">
            <Link href="/signin">Sign in</Link> to add yours.
          </p>
        ) : status === "approved" ? (
          <>
            <div className="community-votes" role="group" aria-label="Your report">
              {(["unsafe", "safe"] as const).map((verdict) => (
                <button
                  key={verdict}
                  type="button"
                  className="button ghost small community-vote"
                  data-verdict={verdict}
                  aria-pressed={mine?.verdict === verdict}
                  disabled={busy}
                  onClick={() => void vote(verdict)}
                >
                  {verdict === "unsafe" ? "Report unsafe" : "Mark safe"}
                </button>
              ))}
            </div>
            {mine && <MyVote mine={mine} chain={tally.chain} />}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          status === "pending" && (
            <p className="community-note">You can add yours once an admin approves your account.</p>
          )
        ))}

      {tally.chain && <OnChain chain={tally.chain} lastScan={tally.lastScan} />}
    </section>
  );
}

function MyVote({ mine, chain }: { mine: MyReport; chain: SiteChainInfo | null }) {
  const href = mine.explorerUrl ?? chain?.explorerUrl;
  return (
    <p className="community-note">
      You said {mine.verdict} {timeAgo(mine.reportedAt)}
      {chain && mine.chainStatus === "pending" && " · Recording on Solana…"}
      {chain && mine.chainStatus === "confirmed" && href && (
        <>
          {" · "}
          <a href={href} target="_blank" rel="noreferrer">
            Recorded on Solana ↗
          </a>
        </>
      )}
    </p>
  );
}

const shorten = (value: string, head = 6, tail = 6) =>
  value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;

function OnChain({ chain, lastScan }: { chain: SiteChainInfo; lastScan: ChainScan | null }) {
  return (
    <div className="community-chain">
      <h3>On Solana</h3>
      <dl className="kv">
        <div>
          <dt>site account</dt>
          <dd className="mono">
            <a href={chain.explorerUrl} target="_blank" rel="noreferrer" title={chain.siteAddress}>
              {shorten(chain.siteAddress)} ↗
            </a>
          </dd>
        </div>
        {lastScan ? (
          <>
            <div>
              <dt>last scan</dt>
              <dd className="community-scan">
                <VerdictChip verdict={lastScan.verdict} />
                <span>
                  {lastScan.score}/100 · {timeAgo(lastScan.scannedAt)}
                </span>
              </dd>
            </div>
            <div>
              <dt>report hash</dt>
              <dd className="mono" title={lastScan.reportHash}>
                {lastScan.explorerUrl ? (
                  <a href={lastScan.explorerUrl} target="_blank" rel="noreferrer">
                    {shorten(lastScan.reportHash, 8)} ↗
                  </a>
                ) : (
                  shorten(lastScan.reportHash, 8)
                )}
              </dd>
            </div>
          </>
        ) : (
          <div>
            <dt>last scan</dt>
            <dd className="muted">None recorded yet</dd>
          </div>
        )}
        {chain.cluster !== "mainnet-beta" && (
          <div>
            <dt>network</dt>
            <dd>{chain.cluster}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
