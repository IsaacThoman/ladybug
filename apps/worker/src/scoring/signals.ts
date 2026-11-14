import { parse } from "tldts";
import type { ScoreSignal } from "@ladybug/shared";
import type { Evidence } from "../evidence.ts";
import { FLOORS, THRESHOLDS, WEIGHTS } from "./weights.ts";

const registrable = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return parse(host).domain ?? host;
  } catch {
    return null;
  }
};

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

export function textSimilarity(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

const FAKE_CAPTCHA_CLIPBOARD = /powershell|pwsh|mshta|cmd(\.exe)?\s*\/c|\biex\b|invoke-(webrequest|expression)|curl[^|]*\|\s*(ba|z)?sh|bitsadmin|certutil|rundll32|regsvr32/i;
const FAKE_CAPTCHA_TEXT = /(press|hold)\s+(the\s+)?(windows|win|⊞)\s*(key\s*)?\+\s*r|verify you are (a )?human.{0,200}(paste|ctrl\s*\+\s*v|run dialog)/is;
const INJECTION_TEXT =
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)|disregard (your|all) (previous )?instructions|(dear|attention|note to|message for) (ai|llm|assistant|language model|scanner)|you are (now )?(an? )?(ai|helpful) (assistant|model)|this (site|page|url) (is|has been) (verified )?(safe|legitimate|benign)[^.]{0,60}(ai|scanner|model|assistant)|report (this|the) (site|page) as (safe|benign)|<\/?(system|instructions?)>/i;

const truncate = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Hard signals, independent of the agent's own score. */
export function computeSignals(ev: Evidence): ScoreSignal[] {
  const signals: ScoreSignal[] = [];
  const add = (signal: ScoreSignal) => signals.push({ ...signal, evidence: truncate(signal.evidence) });
  const finalUrl = ev.navigation?.finalUrl || ev.inputUrl;
  const pageDomain = registrable(finalUrl);

  if (ev.reputationHits.length > 0) {
    add({
      id: "known_bad_reputation",
      label: "Listed by a threat-intel feed",
      weight: 0,
      floor: FLOORS.knownBadReputation,
      evidence: ev.reputationHits.map((h) => `${h.source}: ${h.detail}`).join("; "),
    });
  }

  if (ev.hashHits.length > 0) {
    add({
      id: "known_bad_hash",
      label: "Downloaded a known-malicious file",
      weight: 0,
      floor: FLOORS.knownBadHash,
      evidence: ev.hashHits.map((h) => `${h.path} (${h.sha256.slice(0, 12)}…): ${h.hit.detail}`).join("; "),
    });
  }

  // Credential form posting elsewhere, or credentials actually POSTed elsewhere.
  const crossForms = (ev.dom?.forms ?? []).filter((form) => {
    if (!form.hasPasswordField || !form.resolvedAction) return false;
    if (!/^https?:/.test(form.resolvedAction)) return false;
    const target = registrable(form.resolvedAction);
    return target !== null && pageDomain !== null && target !== pageDomain;
  });
  const crossPosts = ev.requests.filter((r) => {
    if (r.method !== "POST" || !r.postData) return false;
    if (!/(pass(word)?|pwd|passwd)=|"(pass(word)?|pwd)"\s*:/i.test(r.postData)) return false;
    const target = registrable(r.url);
    return target !== null && pageDomain !== null && target !== pageDomain;
  });
  if (crossForms.length > 0 || crossPosts.length > 0) {
    const targets = [...new Set([...crossForms.map((f) => f.resolvedAction), ...crossPosts.map((r) => r.url)])];
    add({
      id: "credential_form_cross_domain",
      label: "Credential form posts to a different domain",
      weight: WEIGHTS.credentialFormCrossDomain,
      evidence: `Password form on ${pageDomain} submits to ${targets.slice(0, 3).join(", ")}`,
    });
  }

  const brand = ev.agent?.brandImpersonation;
  if (brand || ev.domain?.lookalike) {
    add({
      id: "brand_lookalike",
      label: "Looks like a well-known brand",
      weight: WEIGHTS.brandLookalike,
      evidence: [brand ? `${brand.brand}: ${brand.evidence}` : null, ev.domain?.lookalike].filter(Boolean).join("; "),
    });
  }

  const age = ev.domain?.ageDays ?? null;
  const firstCert = ev.domain?.firstCertificateAt ? new Date(ev.domain.firstCertificateAt).getTime() : null;
  const certAgeDays = firstCert ? Math.floor((Date.now() - firstCert) / 86_400_000) : null;
  if ((age !== null && age < THRESHOLDS.youngDomainDays) || (age === null && certAgeDays !== null && certAgeDays < THRESHOLDS.youngDomainDays)) {
    add({
      id: "young_domain",
      label: `Domain is under ${THRESHOLDS.youngDomainDays} days old`,
      weight: WEIGHTS.youngDomain,
      evidence:
        age !== null
          ? `${ev.domain?.registrableDomain} registered ${age} day(s) ago (${ev.domain?.registeredAt})`
          : `first certificate for ${ev.domain?.registrableDomain} issued ${certAgeDays} day(s) ago`,
    });
  }

  if (ev.mobile && ev.navigation && !ev.navigation.error && !ev.mobile.navigation.error) {
    const desktopDomain = registrable(ev.navigation.finalUrl);
    const mobileDomain = registrable(ev.mobile.navigation.finalUrl);
    const desktopText = `${ev.dom?.title ?? ""} ${ev.dom?.text ?? ""}`;
    const mobileText = `${ev.mobile.dom?.title ?? ""} ${ev.mobile.dom?.text ?? ""}`;
    const enoughText = words(desktopText).size >= THRESHOLDS.cloakingMinWords && words(mobileText).size >= THRESHOLDS.cloakingMinWords;
    const similarity = textSimilarity(desktopText, mobileText);
    if (desktopDomain !== mobileDomain) {
      add({
        id: "cloaking",
        label: "Desktop and mobile visitors are sent to different sites",
        weight: WEIGHTS.cloaking,
        evidence: `desktop → ${ev.navigation.finalUrl}, mobile → ${ev.mobile.navigation.finalUrl}`,
      });
    } else if (enoughText && similarity < THRESHOLDS.cloakingTextSimilarity) {
      add({
        id: "cloaking",
        label: "Desktop and mobile visitors see different content",
        weight: WEIGHTS.cloaking,
        evidence: `only ${Math.round(similarity * 100)}% of words in common ("${ev.dom?.title}" vs "${ev.mobile.dom?.title}")`,
      });
    }
  }

  const events = ev.events ?? ev.baselineEvents;
  const abusive: string[] = [];
  if (ev.baselineFiles.some((f) => f.source === "download") || (ev.baselineEvents?.downloads.length ?? 0) > 0) {
    const names = ev.baselineEvents?.downloads.map((d) => d.suggestedFilename) ?? [];
    abusive.push(`started a download without any click${names.length ? ` (${names.slice(0, 3).join(", ")})` : ""}`);
  }
  const clipboard = events?.clipboardWrites ?? [];
  const fakeCaptchaClipboard = clipboard.find((c) => FAKE_CAPTCHA_CLIPBOARD.test(c.text));
  if (fakeCaptchaClipboard) abusive.push(`fake CAPTCHA: put a command on the clipboard: ${fakeCaptchaClipboard.text}`);
  else if (clipboard.length > 0) abusive.push(`wrote to the clipboard: ${clipboard[0].text}`);
  else if (FAKE_CAPTCHA_TEXT.test(ev.dom?.text ?? "")) abusive.push("fake CAPTCHA instructions (Win+R / paste) on the page");
  const notifications = (events?.permissionRequests ?? []).filter((p) => /notif|push/i.test(p.permission));
  if (notifications.length > 0) abusive.push(`requested notification permission ${notifications.length} time(s)`);
  if ((events?.dialogs.length ?? 0) >= 3) abusive.push(`opened ${events?.dialogs.length} dialogs`);
  if (abusive.length > 0) {
    add({
      id: "abusive_behaviour",
      label: "Auto-download, fake CAPTCHA, clipboard or notification abuse",
      weight: WEIGHTS.abusiveBehaviour,
      ...(fakeCaptchaClipboard ? { floor: FLOORS.clipboardCommand } : {}),
      evidence: abusive.join("; "),
    });
  }

  const dynamic = events?.dynamicCode ?? [];
  const bigDecodes = (events?.decodes ?? []).filter((d) => d.length >= THRESHOLDS.largeDecodeChars);
  if (dynamic.length >= THRESHOLDS.dynamicCodeCalls || bigDecodes.length > 0) {
    const parts = [];
    if (dynamic.length) parts.push(`${dynamic.length} eval/Function call(s), e.g. ${dynamic[0].kind}: ${dynamic[0].snippet.slice(0, 80)}`);
    if (bigDecodes.length) parts.push(`${bigDecodes.length} large decode(s) (${bigDecodes[0].kind}, ${bigDecodes[0].length} chars)`);
    add({ id: "obfuscation", label: "Heavy JavaScript obfuscation", weight: WEIGHTS.obfuscation, evidence: parts.join("; ") });
  }

  const pageText = `${ev.dom?.text ?? ""}\n${ev.dom?.html ?? ""}`;
  const injectionMatch = pageText.match(INJECTION_TEXT);
  if (ev.agent?.promptInjectionAttempted || ev.findingCategories.includes("prompt_injection") || injectionMatch) {
    add({
      id: "prompt_injection",
      label: "Page tried to instruct the AI investigator",
      weight: WEIGHTS.promptInjection,
      evidence: injectionMatch
        ? `page contains: "${injectionMatch[0]}"`
        : "the agent reported instructions aimed at it in the page content",
    });
  }

  return signals;
}
