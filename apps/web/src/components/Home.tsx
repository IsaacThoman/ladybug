import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Hills, Mascot } from "@ladybug/mascot/web";
import type { LadybugMood, MascotHandle, MascotLook } from "@ladybug/mascot/web";
import type { ScanListItem } from "@ladybug/shared";
import { ApiRequestError, createScan, isAbort, listScans, loadApiKey, saveApiKey } from "../api.ts";
import type { ApiFailure } from "../api.ts";
import { hostOf, timeAgo } from "../format.ts";
import { navigate } from "../router.ts";
import { useNow } from "../useNow.ts";
import { Clouds, SiteFooter } from "./Garden.tsx";
import Header from "./Header.tsx";
import LadybugMark from "./LadybugMark.tsx";
import Link from "./Link.tsx";
import VerdictChip from "./VerdictChip.tsx";

type Recent = { state: "loading" } | { state: "ok"; scans: ScanListItem[] } | { state: "error"; failure: ApiFailure };
type FormError = { message: string; bubble: string; needsKey?: boolean };

const GREETING_MS = 2600;

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
  const [error, setError] = useState<FormError | null>(null);
  const [recent, setRecent] = useState<Recent>({ state: "loading" });
  const [look, setLook] = useState<MascotLook | null>(null);
  const [greeting, setGreeting] = useState(false);
  const now = useNow(true, 30_000);
  const mascot = useRef<MascotHandle>(null);
  const mascotBox = useRef<HTMLDivElement>(null);
  const greetingTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(greetingTimer.current), []);

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

  const fail = (next: FormError) => {
    setError(next);
    mascot.current?.startle();
  };

  /** While you type, the ladybug watches the box. */
  const onUrlChange = (input: HTMLInputElement) => {
    setUrl(input.value);
    if (error && !error.needsKey) setError(null);
    const box = mascotBox.current?.getBoundingClientRect();
    if (!input.value.trim() || !box) {
      setLook(null);
      return;
    }
    const field = input.getBoundingClientRect();
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    setLook({
      x: clamp((field.left + field.width / 2 - (box.left + box.width / 2)) / (window.innerWidth / 2)),
      y: clamp((field.top + field.height / 2 - (box.top + box.height / 2)) / (window.innerHeight / 2)),
    });
  };

  const sayHi = () => {
    mascot.current?.celebrate();
    setGreeting(true);
    window.clearTimeout(greetingTimer.current);
    greetingTimer.current = window.setTimeout(() => setGreeting(false), GREETING_MS);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const target = normalizeUrl(url);
    if (!target) {
      fail({
        message: "That doesn't look like a web address. Try something like https://example.com/login.",
        bubble: "Hmm, that doesn't look like a link.",
      });
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
        fail({
          message: apiKey.trim()
            ? "The server rejected that API key. Check it and try again."
            : "This server needs an API key. Paste yours below, then scan again.",
          bubble: "I need an API key for that one.",
          needsKey: true,
        });
      } else if (failure.kind === "unreachable") {
        fail({ message: "Can't reach the ladybug server. Is it running?", bubble: "I can't reach the server." });
      } else {
        fail({ message: failure.message, bubble: "Something went wrong there." });
      }
      setSubmitting(false);
    }
  };

  const typing = url.trim() !== "";
  const mood: LadybugMood = submitting ? "sniffing" : error ? "nervous" : greeting ? "happy" : "calm";
  const bubble = submitting
    ? "Off to the sandbox…"
    : error
      ? error.bubble
      : greeting
        ? "Hi there!"
        : typing
          ? "Ooh, what's this one?"
          : "Hand me a link and I'll sniff it out.";

  return (
    <>
      <div className="home-sky">
        <Clouds />
        <Header>
          <Link href="/demo" className="button ghost small">
            Watch a demo
          </Link>
        </Header>
        <main className="home">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow-pill">
                <LeafIcon /> Sandboxed link checks
              </p>
              <h1>Is this link safe?</h1>
              <p className="hero-sub">
                Ladybug opens it in a throwaway sandboxed browser, lets an AI agent poke around, and tells you what it
                found.
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
                  onChange={(e) => onUrlChange(e.currentTarget)}
                  onBlur={() => setLook(null)}
                  autoFocus
                />
                <button type="submit" className="button primary scan-button" disabled={submitting || !typing}>
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
            <div className="hero-mascot" ref={mascotBox}>
              <p className="bubble" data-tone={error ? "warn" : undefined} aria-hidden="true" key={bubble}>
                {bubble}
              </p>
              <button type="button" className="mascot-button" onClick={sayHi} aria-label="Say hi to the ladybug">
                <Mascot
                  ref={mascot}
                  mood={mood}
                  look={look ?? "pointer"}
                  fallback={
                    <span className="mascot-fallback">
                      <LadybugMark size={120} />
                    </span>
                  }
                />
              </button>
            </div>
          </section>
        </main>
        <Hills className="hills" />
      </div>

      <div className="meadow home-meadow">
        <section className="recent panel" aria-label="Recent scans">
          <div className="recent-head">
            <h2 className="section-title">Recent scans</h2>
            {recent.state === "ok" && recent.scans.length > 0 && <span className="recent-note">Updates live</span>}
          </div>
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
      </div>
      <SiteFooter />
    </>
  );
}

function LeafIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 2.5C7 2.5 3 5.6 3 10.2c0 1.3.4 2.3 1 3.3 4.9-.2 8.3-3.6 9.5-11z" fill="currentColor" />
      <path d="M2.5 14c2-3.2 4.4-5.6 7.5-7.5" stroke="var(--paper)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
