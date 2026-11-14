import { useCallback, useEffect, useState } from "react";
import type { AdminSummary, LogEvent } from "@ladybug/shared";
import { Garden, ladybugSnapshot } from "@ladybug/garden";
import { api } from "../api";
import { useAdminStream } from "../useAdminStream";
import ActivityView from "./ActivityView";
import Icon from "./Icon";
import OverviewView from "./OverviewView";
import UrlsView from "./UrlsView";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity log" },
  { id: "urls", label: "URL database" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const SUMMARY_POLL_MS = 3_000;
const LIVE_LIMIT = 300;

const tabFromHash = (): TabId => {
  const hash = window.location.hash.slice(1);
  return TABS.some((tab) => tab.id === hash) ? (hash as TabId) : "overview";
};

export default function Dashboard({
  passwordRequired,
  onSignOut,
}: {
  /** False when the server has no ADMIN_PASSWORD, so there's nothing to sign out of. */
  passwordRequired: boolean;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [live, setLive] = useState<LogEvent[]>([]);
  // Bumped whenever the URL database may have changed.
  const [urlsVersion, setUrlsVersion] = useState(0);

  const onEvent = useCallback((event: LogEvent) => {
    setLive((current) => [event, ...current].slice(0, LIVE_LIMIT));
    if (event.type === "analysis_completed" || event.type === "admin") setUrlsVersion((v) => v + 1);
  }, []);
  const { pending, connected } = useAdminStream(onEvent);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .summary()
        .then((s) => {
          if (cancelled) return;
          setSummary(s);
          setSummaryError(false);
        })
        .catch(() => !cancelled && setSummaryError(true));
    void load();
    const timer = setInterval(load, SUMMARY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [urlsVersion]);

  const typesenseOk = !summaryError && summary?.typesense === "ready";
  const pets = summary?.petsConnected ?? 0;

  return (
    <div className="app">
      <Garden />
      <header className="topbar">
        <a className="brand" href="#overview">
          <img src={ladybugSnapshot} alt="" width={32} height={32} />
          <span className="brand-name">ladybug</span>
          <span className="brand-tag">admin</span>
        </a>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
        <div className="statuses">
          <span className="status" data-ok={!summaryError && connected}>
            <Icon name={!summaryError && connected ? "check" : "x"} size={12} />
            {summaryError ? "Server unreachable" : connected ? "Live" : "Reconnecting"}
          </span>
          <span className="status" data-ok={typesenseOk}>
            <Icon name={typesenseOk ? "check" : "x"} size={12} />
            Typesense {typesenseOk ? "ready" : "unavailable"}
          </span>
          <span className="status" data-ok={pets > 0 ? "true" : "warn"}>
            <Icon name="bell" size={12} />
            {pets} pet{pets === 1 ? "" : "s"} listening
          </span>
          {passwordRequired ? (
            <button type="button" className="secondary small sign-out" onClick={onSignOut}>
              Sign out
            </button>
          ) : (
            <span className="status" data-ok="warn" title="Set ADMIN_PASSWORD on the server to require a login">
              <Icon name="alert" size={12} />
              No admin password
            </span>
          )}
        </div>
      </header>

      <main className="content">
        {tab === "overview" && (
          <OverviewView summary={summary} summaryError={summaryError} pending={pending} live={live} />
        )}
        {tab === "activity" && <ActivityView live={live} />}
        {tab === "urls" && <UrlsView version={urlsVersion} />}
      </main>
    </div>
  );
}
