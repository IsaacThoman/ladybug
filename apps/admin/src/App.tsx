import { useCallback, useEffect, useState } from "react";
import type { AdminSummary, LogEvent } from "@ladybug/shared";
import { api } from "./api";
import ActivityView from "./components/ActivityView";
import Icon from "./components/Icon";
import OverviewView from "./components/OverviewView";
import UrlsView from "./components/UrlsView";
import { useAdminStream } from "./useAdminStream";

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

export default function App() {
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/admin/favicon.png" alt="" width={26} height={26} />
          <span>Ladybug Admin</span>
        </div>
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
          <span className="status" data-ok={(summary?.petsConnected ?? 0) > 0 ? "true" : "warn"}>
            <Icon name="bell" size={12} />
            {summary?.petsConnected ?? 0} pet{summary?.petsConnected === 1 ? "" : "s"} listening
          </span>
        </div>
      </header>

      <main className="content">
        {tab === "overview" && (
          <OverviewView summary={summary} pending={pending} live={live} />
        )}
        {tab === "activity" && <ActivityView live={live} />}
        {tab === "urls" && <UrlsView version={urlsVersion} />}
      </main>
    </div>
  );
}
