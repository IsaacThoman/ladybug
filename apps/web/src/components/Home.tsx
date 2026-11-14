import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ScanListItem } from "@ladybug/shared";
import { MascotStage } from "@ladybug/mascot/react";
import type { LadybugMascotHandle, LadybugMood } from "@ladybug/mascot/react";
import { ApiRequestError, createScan, isAbort, listScans, refreshAccount } from "../api.ts";
import type { ApiFailure } from "../api.ts";
import { hostOf, timeAgo } from "../format.ts";
import { navigate } from "../router.ts";
import { getSession, useSession } from "../session.ts";
import { useNow } from "../useNow.ts";
import Link from "./Link.tsx";
import VerdictChip from "./VerdictChip.tsx";

type Recent = { state: "loading" } | { state: "ok"; scans: ScanListItem[] } | { state: "error"; failure: ApiFailure };

const STATUS_TEXT = {
  pending: "An admin still has to approve your account. You can scan links once they do.",
  rejected: "An admin turned down this account, so it can't scan links.",
} as const;

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Signing in to scan a link: the sign-in page brings it back as ?url=. */
const signInFor = (target: string) => navigate(`/signin?url=${encodeURIComponent(target)}`);

export default function Home() {
  // Back from signing in with a link that still needs scanning.
  const [url, setUrl] = useState(() => new URLSearchParams(window.location.search).get("url") ?? "");
  const session = useSession();
  const approved = session?.account.status === "approved";
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const mascotRef = useRef<LadybugMascotHandle>(null);
  const target = normalizeUrl(url);

  // Picks up an approval since the page was opened, and tidies ?url= away.
  useEffect(() => {
    void refreshAccount().catch(() => {});
    if (window.location.search) window.history.replaceState(null, "", "/");
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) {
      mascotRef.current?.startle();
      setError({ message: "That doesn't look like a web address. Try something like https://example.com/login." });
      return;
    }
    // Signed out: sign in first, then the scan carries on.
    if (!session) {
      signInFor(target);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { scanId } = await createScan(target);
      navigate(`/scans/${scanId}`);
    } catch (err) {
      const failure: ApiFailure = err instanceof ApiRequestError ? err.failure : { kind: "unreachable" };
      if (failure.kind === "unauthorized" && !getSession()) {
        // The session ended on the server.
        signInFor(target);
        return;
      } else if (failure.kind === "unreachable") {
        setError({ message: "Can't reach the ladybug server. Is it running?" });
      } else {
        setError({ message: failure.message });
      }
      mascotRef.current?.startle();
      setSubmitting(false);
    }
  };

  const { mood, says } = mascotLine(submitting, error !== null, target);

  return (
    <main className="home">
      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">A sandbox for suspicious links</p>
          <h1>
            Is this link <em>safe?</em>
          </h1>
          <p className="hero-sub">
            Ladybug opens the page in a disposable sandboxed browser, lets an AI agent poke at it, and scores what it
            finds.
          </p>
          <form className="scan-form" onSubmit={submit} noValidate>
            <label htmlFor="scan-url" className="visually-hidden">
              URL to scan
            </label>
            <input
              id="scan-url"
              className="scan-input mono"
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="https://suspicious.example/login"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) setError(null);
              }}
              autoFocus
            />
            <button type="submit" className="button primary scan-button" disabled={submitting || !url.trim()}>
              {submitting ? <span className="spinner small" aria-hidden="true" /> : null}
              {submitting ? "Starting…" : "Scan"}
            </button>
          </form>
          {error && (
            <p className="form-error" role="alert">
              {error.message}
            </p>
          )}
          <div className="key-row">
            <Link href="/demo" className="link-button">
              Watch a recorded scan →
            </Link>
          </div>
          {session && session.account.status !== "approved" && (
            <p className="account-status" data-status={session.account.status} role="status">
              {STATUS_TEXT[session.account.status]}
            </p>
          )}
        </div>
        <div className="hero-mascot">
          <MascotStage unit={230} mood={mood} ref={mascotRef}>
            <p className="mascot-bubble" key={mood} aria-hidden="true">
              {says}
            </p>
          </MascotStage>
        </div>
      </section>

      <section className="how" id="how" aria-labelledby="how-title">
        <h2 id="how-title" className="section-title">
          How it works
        </h2>
        <ol className="how-steps">
          {STEPS.map((step, i) => (
            <li key={step.title} className="how-step">
              <span className="how-icon" aria-hidden="true">
                {step.icon}
              </span>
              <h3>
                <span className="how-number">{i + 1}</span> {step.title}
              </h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {session && approved ? (
        <YourScans key={session.token} />
      ) : (
        <section className="recent" aria-label="Your scans">
          <h2 className="section-title">Your scans</h2>
          <p className="section-sub">
            {session ? (
              "Your scans show up here once your account is approved."
            ) : (
              <>
                <Link href="/signin">Sign in</Link> to see the links you've scanned.
              </>
            )}{" "}
            <Link href="/demo">Watch the demo meanwhile.</Link>
          </p>
        </section>
      )}
    </main>
  );
}

/** The signed-in user's latest scans, refreshed every few seconds. */
function YourScans() {
  const [recent, setRecent] = useState<Recent>({ state: "loading" });
  const now = useNow(true, 30_000);

  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      listScans(20, abort.signal)
        .then((res) => setRecent({ state: "ok", scans: res.scans }))
        .catch((err: unknown) => {
          if (isAbort(err)) return;
          setRecent({
            state: "error",
            failure: err instanceof ApiRequestError ? err.failure : { kind: "unreachable" },
          });
        });
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="recent" aria-label="Your scans">
      <h2 className="section-title">Your scans</h2>
      <p className="section-sub">The links you've scanned lately.</p>
      {recent.state === "loading" && <p className="muted">Loading…</p>}
      {recent.state === "error" && (
        <p className="muted recent-error">
          {recent.failure.kind === "unreachable"
            ? "Can't reach the ladybug server, so your scans aren't available."
            : "Couldn't load your scans."}{" "}
          <Link href="/demo">Watch the demo instead.</Link>
        </p>
      )}
      {recent.state === "ok" && recent.scans.length === 0 && (
        <p className="muted">No scans yet. Paste a URL above.</p>
      )}
      {recent.state === "ok" && recent.scans.length > 0 && (
        <ul className="recent-list">
          {recent.scans.map((s) => (
            <li key={s.scanId}>
              <Link href={`/scans/${s.scanId}`} className="recent-item">
                {s.status === "done" ? (
                  <VerdictChip verdict={s.verdict} />
                ) : (
                  <span className={`status-chip ${s.status}`}>{s.status}</span>
                )}
                <span className={`recent-score ${s.verdict ?? ""}`}>{s.score ?? "–"}</span>
                <span className="recent-url">
                  <span className="recent-host">{hostOf(s.finalUrl ?? s.inputUrl)}</span>
                  <span className="mono recent-full">{s.inputUrl}</span>
                </span>
                <time className="recent-time" dateTime={s.createdAt}>
                  {timeAgo(s.createdAt, now)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function mascotLine(
  submitting: boolean,
  failed: boolean,
  target: string | null,
): { mood: LadybugMood; says: string } {
  if (submitting) return { mood: "sniffing", says: "Sniffing it out…" };
  if (failed) return { mood: "nervous", says: "Hmm, that didn't work." };
  if (target) return { mood: "expectant", says: `Ooh, ${hostOf(target)}. Shall I?` };
  return { mood: "calm", says: "Got a sketchy link? I'll take a look." };
}

const icon = (d: string) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const STEPS = [
  {
    title: "Planted in a sandbox",
    body: "The page opens in a throwaway browser, walled off from everything else, with its traffic recorded.",
    icon: icon("M12 21v-8M12 13c0-4 3-6.5 7-6.5 0 4-3 6.5-7 6.5zM12 15.5c0-3-2.2-5-5.5-5 0 3 2.2 5 5.5 5zM6 21h12"),
  },
  {
    title: "Poked by an agent",
    body: "An AI agent clicks around like a curious visitor would, following redirects and filling in forms.",
    icon: icon("M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.2 15.2 21 21M8 10.5a2.5 2.5 0 0 1 2.5-2.5"),
  },
  {
    title: "Scored, with evidence",
    body: "You get a risk score from 0 to 100, the findings behind it, and screenshots of what it saw.",
    icon: icon("M4 17a8 8 0 0 1 16 0M12 17l3.5-5M4 21h16"),
  },
];
