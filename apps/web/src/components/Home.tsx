import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ScanListItem } from "@ladybug/shared";
import { MascotStage } from "@ladybug/mascot/react";
import type { LadybugMascotHandle, LadybugMood } from "@ladybug/mascot/react";
import { ApiRequestError, createScan, isAbort, listScans, loadApiKey, saveApiKey } from "../api.ts";
import type { ApiFailure } from "../api.ts";
import { hostOf, timeAgo } from "../format.ts";
import { navigate } from "../router.ts";
import { useNow } from "../useNow.ts";
import Link from "./Link.tsx";
import VerdictChip from "./VerdictChip.tsx";

type Recent = { state: "loading" } | { state: "ok"; scans: ScanListItem[] } | { state: "error"; failure: ApiFailure };

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

export default function Home() {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState(loadApiKey);
  const [showKey, setShowKey] = useState(() => loadApiKey() === "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; needsKey?: boolean } | null>(null);
  const [recent, setRecent] = useState<Recent>({ state: "loading" });
  const now = useNow(true, 30_000);
  const mascotRef = useRef<LadybugMascotHandle>(null);
  const target = normalizeUrl(url);

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

  const onKeyChange = (value: string) => {
    setApiKey(value);
    saveApiKey(value.trim());
    if (error?.needsKey) setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) {
      mascotRef.current?.startle();
      setError({ message: "That doesn't look like a web address. Try something like https://example.com/login." });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { scanId } = await createScan(target, apiKey.trim());
      navigate(`/scans/${scanId}`);
    } catch (err) {
      const failure: ApiFailure = err instanceof ApiRequestError ? err.failure : { kind: "unreachable" };
      if (failure.kind === "unauthorized") {
        setShowKey(true);
        setError({
          message: apiKey.trim()
            ? "The server rejected that API key. Check it and try again."
            : "This server needs an API key. Paste yours below, then scan again.",
          needsKey: true,
        });
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
                if (error && !error.needsKey) setError(null);
              }}
              autoFocus
            />
            <button type="submit" className="button primary scan-button" disabled={submitting || !url.trim()}>
              {submitting ? <span className="spinner small" aria-hidden="true" /> : null}
              {submitting ? "Starting…" : "Scan"}
            </button>
          </form>
          {error && (
            <p className={`form-error${error.needsKey ? " needs-key" : ""}`} role="alert">
              {error.message}
            </p>
          )}
          <div className="key-row">
            {showKey ? (
              <label className={`key-field${error?.needsKey ? " is-highlighted" : ""}`}>
                <span>API key</span>
                <input
                  type="password"
                  className="mono"
                  value={apiKey}
                  onChange={(e) => onKeyChange(e.target.value)}
                  placeholder="paste x-api-key"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            ) : (
              <button type="button" className="link-button" onClick={() => setShowKey(true)}>
                API key saved · change
              </button>
            )}
            <Link href="/demo" className="link-button">
              Watch a recorded scan →
            </Link>
          </div>
        </div>
        <div className="hero-mascot">
          <MascotStage unit={230} mood={mood} followPointer={mood === "calm"} ref={mascotRef}>
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

      <section className="recent" aria-label="Recent scans">
        <h2 className="section-title">Recent scans</h2>
        <p className="section-sub">What the garden's been looking at lately.</p>
        {recent.state === "loading" && <p className="muted">Loading…</p>}
        {recent.state === "error" && (
          <p className="muted recent-error">
            {recent.failure.kind === "unreachable"
              ? "Can't reach the ladybug server, so recent scans aren't available."
              : "Couldn't load recent scans."}{" "}
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
    </main>
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
