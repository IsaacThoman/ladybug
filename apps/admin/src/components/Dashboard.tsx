import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminSummary, LogEvent, PendingAnalysis } from "@ladybug/shared";
import { LadybugMark, MascotStage } from "@ladybug/mascot/react";
import type { LadybugMascotHandle, LadybugMood } from "@ladybug/mascot/react";
import { api } from "../api";
import type { IconName } from "../format";
import { useAdminStream, useNow } from "../useAdminStream";
import ActivityView from "./ActivityView";
import Icon from "./Icon";
import OverviewView from "./OverviewView";
import UrlsView from "./UrlsView";

const TABS = [
  { id: "overview", label: "Overview", icon: "home", sub: "What's happening in the garden right now." },
  { id: "activity", label: "Activity log", icon: "pulse", sub: "Every visit, decision and alert, newest first." },
  { id: "urls", label: "URL database", icon: "database", sub: "Pages and hosts Ladybug already has a verdict for." },
] as const satisfies readonly { id: string; label: string; icon: IconName; sub: string }[];
type TabId = (typeof TABS)[number]["id"];

const SUMMARY_POLL_MS = 3_000;
const LIVE_LIMIT = 300;
/** How long the ladybug keeps reacting to a fresh verdict. */
const REACTION_MS = 8_000;

const tabFromHash = (): TabId => {
  const hash = window.location.hash.slice(1);
  return TABS.some((tab) => tab.id === hash) ? (hash as TabId) : "overview";
};

/** Hostnames can be long; the bubble has room for about this much. */
const short = (host: string | undefined, fallback: string) =>
  !host ? fallback : host.length > 26 ? `${host.slice(0, 25)}…` : host;

type Line = { mood: LadybugMood; says: string; tone?: "danger" | "ok" | "info" };

/** What the ladybug in the sidebar is doing and saying about the live state. */
function narrate({
  unreachable,
  connected,
  pending,
  fresh,
  pets,
}: {
  unreachable: boolean;
  connected: boolean;
  pending: PendingAnalysis[];
  fresh: LogEvent | undefined;
  pets: number;
}): Line {
  if (unreachable) return { mood: "nervous", says: "I can't reach the server.", tone: "danger" };
  if (fresh?.verdict === "unsafe" || fresh?.decision === "known_unsafe") {
    return { mood: "alarmed", says: `Unsafe: ${short(fresh.host, "a page")}`, tone: "danger" };
  }
  if (fresh) return { mood: "happy", says: `${short(fresh.host, "That page")} looks fine.`, tone: "ok" };
  if (pending.length > 0) {
    return {
      mood: "sniffing",
      says: pending.length === 1 ? `Sniffing ${short(pending[0].host, "a link")}…` : `Sniffing ${pending.length} links…`,
      tone: "info",
    };
  }
  if (!connected) return { mood: "nervous", says: "Reconnecting…" };
  return { mood: "calm", says: pets > 0 ? `All quiet. ${pets} pet${pets === 1 ? "" : "s"} listening.` : "All quiet in the garden." };
}

/** A verdict worth reacting to: an analysis just finished, or a known-bad page was visited. */
const isVerdict = (event: LogEvent) =>
  event.type === "analysis_completed" || (event.type === "decision" && event.decision === "known_unsafe");

export default function Dashboard({ onSignOut }: { onSignOut?: () => void }) {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [live, setLive] = useState<LogEvent[]>([]);
  // Bumped whenever the URL database may have changed.
  const [urlsVersion, setUrlsVersion] = useState(0);
  const mascotRef = useRef<LadybugMascotHandle>(null);
  const now = useNow(1_000);

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

  const latest = live.find(isVerdict);
  const fresh = latest && now - latest.at < REACTION_MS ? latest : undefined;
  const pets = summary?.petsConnected ?? 0;
  const line = narrate({ unreachable: summaryError, connected, pending, fresh, pets });

  // Each new verdict gets one big reaction: a flash for unsafe, a hop for safe.
  const freshId = fresh?.id;
  const freshUnsafe = line.mood === "alarmed";
  useEffect(() => {
    if (!freshId) return;
    if (freshUnsafe) mascotRef.current?.alarm();
    else mascotRef.current?.celebrate();
  }, [freshId, freshUnsafe]);

  const typesenseOk = !summaryError && summary?.typesense === "ready";
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="shell garden-sky">
      <aside className="sidebar">
        <a className="sidebar-brand" href="#overview">
          <LadybugMark size={28} className="brand-mark" />
          <span className="brand-name">ladybug</span>
          <span className="brand-tag">admin</span>
        </a>

        <div className="sidebar-mascot">
          <MascotStage unit={104} mood={line.mood} followPointer={line.mood === "calm"} ref={mascotRef}>
            <p className="mascot-bubble" data-tone={line.tone} key={`${line.mood}:${line.says}`}>
              {line.says}
            </p>
          </MascotStage>
        </div>
        {/* The bubble is decorative motion; this says the same for screen readers. */}
        <p className="visually-hidden" role="status">
          {line.says}
        </p>

        <nav className="side-nav" aria-label="Sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
              <Icon name={t.icon} size={16} />
              {t.label}
            </a>
          ))}
        </nav>

        <ul className="statuses" aria-label="System status">
          <li className="status" data-ok={!summaryError && connected}>
            <Icon name={!summaryError && connected ? "check" : "x"} size={12} />
            {summaryError ? "Server unreachable" : connected ? "Live updates" : "Reconnecting"}
          </li>
          <li className="status" data-ok={typesenseOk}>
            <Icon name={typesenseOk ? "check" : "x"} size={12} />
            Typesense {typesenseOk ? "ready" : "unavailable"}
          </li>
          <li className="status" data-ok={pets > 0 ? "true" : "warn"}>
            <Icon name="bell" size={12} />
            {pets} pet{pets === 1 ? "" : "s"} listening
          </li>
        </ul>

        {onSignOut && (
          <button type="button" className="sign-out" onClick={onSignOut}>
            <Icon name="signout" size={15} />
            Sign out
          </button>
        )}
      </aside>

      <main className="content">
        <header className="page-head">
          <h1>{current.label}</h1>
          <p>{current.sub}</p>
        </header>
        {tab === "overview" && <OverviewView summary={summary} pending={pending} live={live} />}
        {tab === "activity" && <ActivityView live={live} />}
        {tab === "urls" && <UrlsView version={urlsVersion} />}
      </main>
    </div>
  );
}
