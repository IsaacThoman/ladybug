import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { BubbleTone, LadybugHandle, LadybugMood } from "@ladybug/garden";
import type { ScanListItem } from "@ladybug/shared";
import { ApiRequestError, createScan, isAbort, listScans, loadApiKey, saveApiKey } from "../api.ts";
import type { ApiFailure } from "../api.ts";
import { hostOf, timeAgo } from "../format.ts";
import { navigate } from "../router.ts";
import { useNow } from "../useNow.ts";
import HeroScene from "./HeroScene.tsx";
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
  const bug = useRef<LadybugHandle>(null);

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
    const target = normalizeUrl(url);
    if (!target) {
      setError({ message: "That doesn't look like a web address. Try something like https://example.com/login." });
      bug.current?.startle();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { scanId } = await createScan(target, apiKey.trim());
      navigate(`/scans/${scanId}`);
    } catch (err) {
      bug.current?.startle();
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
      setSubmitting(false);
    }
  };

  let mood: LadybugMood = "calm";
  let say = "Got a sketchy link? Show me!";
  let tone: BubbleTone = "chat";
  if (submitting) {
    mood = "sniffing";
    say = "Sniff, sniff…";
  } else if (error) {
    mood = "nervous";
    say = error.needsKey ? "I need a key for this one." : "Hmm, that didn't work.";
    tone = "warn";
  } else if (url.trim()) {
    mood = "expectant";
    say = "Ooh, what's that one?";
  }

  return (
    <main className="home">
      <section className="hero">
        <div className="hero-copy">
          <p className="hero-kicker hand">a little bug that checks links for you</p>
          <h1>Is this link safe?</h1>
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
              onChange={(e) => setUrl(e.target.value)}
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
        <HeroScene ref={bug} mood={mood} say={say} tone={tone} />
      </section>

      <section className="steps" id="how" aria-labelledby="how-title">
        <h2 id="how-title" className="section-title">
          How it works
        </h2>
        <ol className="step-cards">
          <li className="step-card">
            <span className="step-num">1</span>
            <h3>Opens it somewhere safe</h3>
            <p>A throwaway browser in a sandbox loads the page, so nothing on it ever touches your computer.</p>
          </li>
          <li className="step-card">
            <span className="step-num">2</span>
            <h3>Has a good look around</h3>
            <p>
              An AI agent clicks through it, fills in its forms, watches the network traffic and looks up the domain.
            </p>
          </li>
          <li className="step-card">
            <span className="step-num">3</span>
            <h3>Tells you straight</h3>
            <p>
              Hard signals and the agent&apos;s findings add up to a score out of 100, with screenshots as evidence.
            </p>
          </li>
        </ol>
      </section>

      <section className="recent" aria-labelledby="recent-title">
        <h2 id="recent-title" className="section-title">
          Freshly checked
        </h2>
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
