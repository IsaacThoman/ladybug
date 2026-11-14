// A recorded phishing scan, replayed on a timer for offline demos. The brand
// (Northwind Bank) is fictional; IPs are from documentation ranges.
import type { Finding, ScanEvent, ScanReport, ScanResponse, ScoreSignal } from "@ladybug/shared";
import { shotCard, shotLogin, shotMobile, shotOtp, shotRedirect } from "./demoShots.ts";

export const DEMO_SCAN_ID = "demo";
export const DEMO_INPUT_URL = "https://nw-alerts.click/r/5Kq8vD";

const PHISH_HOST = "northwlnd-secure.top";
/** Where the kit sends what it steals: a different domain, so the cross-domain form signal fires. */
const COLLECTOR = "nw-verify-cdn.xyz";
const CHAIN = [
  DEMO_INPUT_URL,
  "https://trk.nw-alerts.click/c/5Kq8vD?src=sms&u=aHR0cHM6Ly9ub3J0aHdsbmQtc2VjdXJlLnRvcA",
  `https://${PHISH_HOST}/signin/?session=8f3c21e0b7`,
];

const KEYS = {
  redirect: "scans/demo/screenshots/t0.png",
  login: "scans/demo/screenshots/t10.png",
  mobile: "scans/demo/screenshots/mobile.png",
  otp: "scans/demo/screenshots/agent-otp.png",
  card: "scans/demo/screenshots/agent-card.png",
  har: "scans/demo/har/credential-post.har",
};

let shotCache: Record<string, string> | null = null;
/** Resolve a demo artifact key to an inline image. */
export function demoArtifactSrc(key: string): string {
  shotCache ??= {
    [KEYS.redirect]: shotRedirect(),
    [KEYS.login]: shotLogin(),
    [KEYS.mobile]: shotMobile(),
    [KEYS.otp]: shotOtp(),
    [KEYS.card]: shotCard(),
  };
  return shotCache[key] ?? "about:blank";
}

// Same ids and weights as apps/worker/src/scoring (signals.ts, weights.ts).
const SIGNALS: Record<string, ScoreSignal> = {
  age: {
    id: "young_domain",
    label: "Domain is under 30 days old",
    weight: 15,
    evidence: `${PHISH_HOST} registered 2 day(s) ago (2026-11-12T08:14:00Z)`,
  },
  form: {
    id: "credential_form_cross_domain",
    label: "Credential form posts to a different domain",
    weight: 25,
    evidence: `Password form on ${PHISH_HOST} submits to https://${COLLECTOR}/gate.php`,
  },
  lookalike: {
    id: "brand_lookalike",
    label: "Looks like a well-known brand",
    weight: 20,
    evidence: `Northwind Bank: logo, colours and copy match northwind-bank.com; ${PHISH_HOST} swaps ‘i’ for ‘l’`,
  },
  obfuscation: {
    id: "obfuscation",
    label: "Heavy JavaScript obfuscation",
    weight: 10,
    evidence: "4 eval/Function call(s), e.g. eval: (function(p,a,c,k,e,d){…; 1 large decode(s) (atob, 18342 chars)",
  },
};

const FINDINGS: Record<string, Finding> = {
  impersonation: {
    title: "Impersonates Northwind Bank",
    severity: "high",
    evidence:
      "Logo, colours, navigation and footer copy match northwind-bank.com, but the page is served from " +
      `${PHISH_HOST}, a look-alike that swaps ‘i’ for ‘l’.`,
    artifactKeys: [KEYS.login, KEYS.mobile],
  },
  credentialPost: {
    title: "Credentials sent to an unrelated host",
    severity: "high",
    evidence: `The sign-in form POSTs user_id and password to https://${COLLECTOR}/gate.php. The test credentials came back in the response cookie, confirming they were stored.`,
    artifactKeys: [KEYS.har],
  },
  keylogger: {
    title: "Obfuscated keystroke logger",
    severity: "medium",
    evidence:
      `An inline script unpacks itself with eval(atob(…)) and sends every keydown to ${COLLECTOR}/k.php, so typing is captured even if the form is never submitted.`,
    artifactKeys: [],
  },
  relay: {
    title: "Asks for SMS code and full card details",
    severity: "high",
    evidence:
      "After a fake login the kit asks for the 6-digit SMS code, then card number, expiry, CVV and ATM PIN. It relays the session live to get past two-factor sign-in.",
    artifactKeys: [KEYS.otp, KEYS.card],
  },
  urgency: {
    title: "Threatens account suspension",
    severity: "low",
    evidence: "“Your Online Banking access will be suspended within 24 hours unless you verify your identity.”",
    artifactKeys: [],
  },
  antiAnalysis: {
    title: "Blocks right-click and devtools",
    severity: "info",
    evidence: "contextmenu and F12 handlers call preventDefault, and a debugger loop starts when devtools opens.",
    artifactKeys: [],
  },
};

type Step = { t: number; event: (at: string) => ScanEvent };

const status = (s: ScanEvent & { type: "status" }) => s;

/** Seconds from the start of the replay. */
export const DEMO_TIMELINE: Step[] = [
  { t: 0, event: (at) => status({ type: "status", status: "queued", at }) },
  { t: 1.2, event: (at) => status({ type: "status", status: "provisioning", at }) },
  {
    t: 2.4,
    event: (at) => ({
      type: "agent_note",
      text: `Pre-scan: ${PHISH_HOST} is 2 days old; hosted on AS205100 F3 Netze e.V., DE; not on Safe Browsing or URLhaus.`,
      at,
    }),
  },
  { t: 4.2, event: (at) => status({ type: "status", status: "detonating", at }) },
  { t: 5.0, event: (at) => ({ type: "screenshot", artifactKey: KEYS.redirect, label: "t+0s", at }) },
  { t: 6.4, event: (at) => ({ type: "redirect_chain", chain: CHAIN, at }) },
  { t: 8.6, event: (at) => ({ type: "signal", signal: SIGNALS.age, at }) },
  { t: 9.4, event: (at) => ({ type: "signal", signal: SIGNALS.obfuscation, at }) },
  { t: 10.4, event: (at) => ({ type: "screenshot", artifactKey: KEYS.login, label: "t+10s", at }) },
  { t: 11.4, event: (at) => ({ type: "signal", signal: SIGNALS.form, at }) },
  { t: 12.6, event: (at) => ({ type: "screenshot", artifactKey: KEYS.mobile, label: "mobile", at }) },
  { t: 13.6, event: (at) => ({ type: "signal", signal: SIGNALS.lookalike, at }) },
  { t: 14.4, event: (at) => status({ type: "status", status: "investigating", at }) },
  {
    t: 15.6,
    event: (at) => ({
      type: "agent_note",
      text: `This is a Northwind Bank sign-in page, but the host is ${PHISH_HOST}. Northwind's real domain is northwind-bank.com. Checking where the form submits.`,
      at,
    }),
  },
  {
    t: 17.0,
    event: (at) => ({
      type: "tool_call",
      tool: "browser_dom",
      summary: "read the DOM",
      at,
    }),
  },
  {
    t: 18.4,
    event: (at) => ({ type: "tool_call", tool: "browser_screenshot", summary: "screenshot: sign-in page", at }),
  },
  { t: 19.6, event: (at) => ({ type: "finding", finding: FINDINGS.impersonation, at }) },
  { t: 20.8, event: (at) => ({ type: "finding", finding: FINDINGS.urgency, at }) },
  {
    t: 22.0,
    event: (at) => ({
      type: "tool_call",
      tool: "browser_events",
      summary: "check page behaviour",
      at,
    }),
  },
  {
    t: 23.6,
    event: (at) => ({
      type: "tool_call",
      tool: "exec",
      summary: "$ node -e 'console.log(atob(require(\"fs\").readFileSync(\"packed.txt\",\"utf8\")))'",
      at,
    }),
  },
  { t: 24.6, event: (at) => ({ type: "finding", finding: FINDINGS.keylogger, at }) },
  { t: 25.6, event: (at) => ({ type: "finding", finding: FINDINGS.antiAnalysis, at }) },
  {
    t: 26.8,
    event: (at) => ({
      type: "agent_note",
      text: "Submitting obviously fake credentials to see what the kit does next.",
      at,
    }),
  },
  {
    t: 28.0,
    event: (at) => ({
      type: "tool_call",
      tool: "browser_type",
      summary: 'type "test@example.com" into #user_id',
      at,
    }),
  },
  { t: 29.0, event: (at) => ({ type: "tool_call", tool: "browser_click", summary: "click button[type=submit]", at }) },
  { t: 30.2, event: (at) => ({ type: "screenshot", artifactKey: KEYS.otp, label: "agent: 2FA prompt", at }) },
  {
    t: 31.2,
    event: (at) => ({
      type: "tool_call",
      tool: "browser_requests",
      summary: "read the network log",
      at,
    }),
  },
  { t: 32.2, event: (at) => ({ type: "finding", finding: FINDINGS.credentialPost, at }) },
  { t: 33.4, event: (at) => ({ type: "tool_call", tool: "browser_type", summary: 'type "000000" into #otp', at }) },
  { t: 34.6, event: (at) => ({ type: "screenshot", artifactKey: KEYS.card, label: "agent: card step", at }) },
  {
    t: 35.8,
    event: (at) => ({
      type: "agent_note",
      text: "The kit wants the SMS code, then card number, CVV and ATM PIN. That's a real-time relay built to get past two-factor sign-in. Confident this is phishing.",
      at,
    }),
  },
  { t: 37.0, event: (at) => ({ type: "finding", finding: FINDINGS.relay, at }) },
  { t: 38.2, event: (at) => status({ type: "status", status: "scoring", at }) },
  { t: 40.2, event: (at) => ({ type: "report", score: 83, verdict: "malicious", at }) },
  { t: 41.0, event: (at) => status({ type: "status", status: "done", at }) },
];

export const DEMO_DURATION_S = DEMO_TIMELINE.at(-1)!.t;

export function demoResponse(startMs: number): ScanResponse {
  const iso = (s: number) => new Date(startMs + s * 1000).toISOString();
  const report: ScanReport = {
    scanId: DEMO_SCAN_ID,
    inputUrl: DEMO_INPUT_URL,
    finalUrl: CHAIN.at(-1)!,
    redirectChain: CHAIN,
    // round(0.5 × 70 + 0.5 × 96), as the worker computes it.
    score: 83,
    signalScore: 70,
    llmScore: 96,
    verdict: "malicious",
    confidence: "high",
    categories: ["phishing", "brand_impersonation"],
    findings: Object.values(FINDINGS),
    signals: Object.values(SIGNALS),
    iocs: {
      domains: ["nw-alerts.click", "trk.nw-alerts.click", PHISH_HOST, COLLECTOR],
      ips: ["203.0.113.47", "198.51.100.212"],
      urls: [CHAIN.at(-1)!, `https://${COLLECTOR}/gate.php`, `https://${COLLECTOR}/k.php`],
      sha256: ["9f2c4e71b0a8d3f6e5c21a7b94d08e3f6a1c5b2d7e9f0a4b8c3d6e1f2a5b7c90"],
    },
    summary:
      "A credential-phishing kit impersonating Northwind Bank, reached from an SMS-style alert link through a link tracker. " +
      `The look-alike domain ${PHISH_HOST} is two days old and not on any blocklist yet. Its sign-in form sends passwords to an unrelated host, ` +
      "a hidden script logs every keystroke, and after a fake login it asks for the SMS code and full card details to take over the account in real time. " +
      "Don't enter anything on this page, and block the domains below.",
    screenshots: [
      { artifactKey: KEYS.redirect, label: "t+0s" },
      { artifactKey: KEYS.login, label: "t+10s" },
      { artifactKey: KEYS.mobile, label: "mobile" },
      { artifactKey: KEYS.otp, label: "agent: 2FA prompt" },
      { artifactKey: KEYS.card, label: "agent: card step" },
    ],
    domain: {
      hostname: PHISH_HOST,
      registrableDomain: PHISH_HOST,
      registeredAt: "2026-11-12T03:18:00Z",
      ageDays: 2,
      registrar: "Hostinet Registrar Ltd",
      ips: ["203.0.113.47"],
      asn: "AS64512 VPS-CLOUD-EU",
      certificateCount: 2,
      firstCertificateAt: "2026-11-12T03:41:00Z",
      lookalike: "Look-alike of northwind-bank.com: ‘l’ in place of ‘i’ (northwlnd)",
    },
    flags: [],
    startedAt: iso(0),
    finishedAt: iso(DEMO_DURATION_S),
  };
  return {
    scanId: DEMO_SCAN_ID,
    inputUrl: DEMO_INPUT_URL,
    status: "done",
    createdAt: iso(0),
    updatedAt: iso(DEMO_DURATION_S),
    report,
    error: null,
  };
}
