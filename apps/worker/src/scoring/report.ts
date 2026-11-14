import { isIP } from "node:net";
import { verdictForScore } from "@ladybug/shared";
import type { Confidence, Iocs, ScanReport, ScoreSignal } from "@ladybug/shared";
import type { Evidence } from "../evidence.ts";
import { computeSignals } from "./signals.ts";
import { SIGNAL_SHARE } from "./weights.ts";

const SIGNAL_CATEGORIES: Record<string, string> = {
  known_bad_hash: "malware_delivery",
  credential_form_cross_domain: "phishing",
  brand_lookalike: "brand_impersonation",
  cloaking: "cloaking",
  prompt_injection: "prompt_injection",
};

export function combineScores(signals: ScoreSignal[], llmScore: number | null) {
  const signalScore = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  const floor = Math.max(0, ...signals.map((s) => s.floor ?? 0));
  const blended = llmScore === null ? signalScore : Math.round(SIGNAL_SHARE * signalScore + (1 - SIGNAL_SHARE) * llmScore);
  return { signalScore, score: Math.max(floor, Math.min(100, blended)) };
}

const uniq = (items: (string | null | undefined)[]) => [...new Set(items.filter((x): x is string => Boolean(x)))];

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function collectIocs(ev: Evidence, finalUrl: string, chain: string[]): Iocs {
  const agent = ev.agent?.iocs;
  const hosts = uniq([...chain, finalUrl].map(hostOf));
  return {
    domains: uniq([...hosts.filter((h) => !isIP(h)), ...(agent?.domains ?? [])]),
    ips: uniq([...hosts.filter((h) => isIP(h)), ...(ev.domain?.ips ?? []), ...(agent?.ips ?? [])]),
    urls: uniq([...chain, finalUrl, ...(agent?.urls ?? [])]),
    sha256: uniq([...ev.files.filter((f) => f.source === "download").map((f) => f.sha256), ...(agent?.sha256 ?? [])]),
  };
}

function fallbackSummary(ev: Evidence, signals: ScoreSignal[], score: number) {
  const verdict = verdictForScore(score);
  if (signals.length === 0) return `No hard warning signs on ${hostOf(ev.inputUrl)}. Scored from signals only.`;
  return `${verdict[0].toUpperCase()}${verdict.slice(1)} (signals only): ${signals.map((s) => s.label.toLowerCase()).join("; ")}.`;
}

export function buildReport(ev: Evidence): ScanReport {
  const signals = computeSignals(ev);
  const llmScore = ev.agent?.llmScore ?? null;
  const { signalScore, score } = combineScores(signals, llmScore);
  const verdict = verdictForScore(score);
  const finalUrl = ev.navigation?.finalUrl || ev.inputUrl;
  const redirectChain = ev.navigation?.redirectChain.length ? ev.navigation.redirectChain : [ev.inputUrl];

  const floorHit = signals.some((s) => s.floor);
  const confidence: Confidence = floorHit ? "high" : (ev.agent?.confidence ?? (signals.length >= 2 ? "medium" : "low"));
  const categories = uniq([
    ...(ev.agent?.categories ?? []),
    ...ev.findingCategories,
    ...signals.map((s) => SIGNAL_CATEGORIES[s.id]),
    ...(signals.some((s) => s.id === "abusive_behaviour" && /fake CAPTCHA/i.test(s.evidence)) ? ["fake_captcha"] : []),
  ]);
  const flags = [...new Set(ev.flags)];

  return {
    scanId: ev.scanId,
    inputUrl: ev.inputUrl,
    finalUrl,
    redirectChain,
    score,
    signalScore,
    llmScore,
    verdict,
    confidence,
    categories,
    findings: ev.findings,
    signals,
    iocs: verdict === "benign" ? { domains: [], ips: [], urls: [], sha256: [] } : collectIocs(ev, finalUrl, redirectChain),
    summary: ev.agent?.summary || fallbackSummary(ev, signals, score),
    screenshots: ev.screenshots,
    domain: ev.domain,
    ...(ev.similar.length > 0 ? { similar: ev.similar } : {}),
    flags,
    startedAt: ev.startedAt,
    finishedAt: new Date().toISOString(),
  };
}
