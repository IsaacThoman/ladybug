// Contract for the in-sandbox tool daemon (apps/sandbox). The worker drives
// it over HTTP. Every route except GET /healthz needs
// `Authorization: Bearer <SANDBOX_TOKEN>`.

export const SANDBOX_DAEMON_PORT = 7000;
export const GATEWAY_PORT = 8080;

/**
 * Environment the worker passes to a sandbox container/pod.
 * - SANDBOX_TOKEN    required, per-sandbox bearer token
 * - SCAN_ID          scan id, sent to the gateway as the proxy username so flows can be attributed
 * - PROXY_URL        optional, e.g. http://10.0.0.5:8080 (an IP: the sandbox has no DNS)
 * - GATEWAY_CA_PEM   optional, the gateway's public CA cert; installed into Chrome's NSS store
 * - DAEMON_PORT      optional, default 7000
 */
export const SANDBOX_ENV = {
  token: "SANDBOX_TOKEN",
  scanId: "SCAN_ID",
  proxyUrl: "PROXY_URL",
  gatewayCaPem: "GATEWAY_CA_PEM",
  port: "DAEMON_PORT",
} as const;

export type HealthzResponse = { ok: true; browser: boolean };

// POST /browser/navigate
export type NavigateRequest = {
  url: string;
  /** Default "load". The daemon then waits (bounded) for network idle either way. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Default 30000. */
  timeoutMs?: number;
};
export type NavigateResponse = {
  finalUrl: string;
  /** HTTP status of the main document, null if navigation failed before a response. */
  status: number | null;
  title: string;
  /** Every main-frame URL from the requested one to the final one, HTTP and client-side redirects. */
  redirectChain: string[];
  /** Set when navigation threw (timeout, DNS failure via the proxy, etc.). */
  error: string | null;
};

// POST /browser/click — selector OR coordinates
export type ClickRequest =
  | { selector: string; x?: never; y?: never }
  | { x: number; y: number; selector?: never };
// POST /browser/type — focuses selector or clicks x,y first, if given
export type TypeRequest = {
  text: string;
  selector?: string;
  x?: number;
  y?: number;
  pressEnter?: boolean;
};
export type ActionResponse = { ok: boolean; url: string; error: string | null };

// POST /browser/context — recreate the browser context (fresh profile)
export type ContextRequest = {
  /** true = iPhone-like viewport, touch and mobile Safari user agent. */
  mobile: boolean;
};
export type ContextResponse = { ok: true; userAgent: string };

// GET /browser/screenshot?fullPage=0|1 → image/png body

// GET /browser/dom?maxChars=50000
export type DomForm = {
  action: string | null;
  /** Absolute URL the form posts to (resolved against the page). */
  resolvedAction: string | null;
  method: string;
  inputs: { name: string | null; type: string; placeholder: string | null; autocomplete: string | null }[];
  hasPasswordField: boolean;
};
export type DomScript = {
  src: string | null;
  /** Inline script length in characters (0 for external). */
  inlineLength: number;
  /** First ~500 chars of inline scripts. */
  inlineSnippet: string | null;
};
export type DomSnapshot = {
  url: string;
  title: string;
  /** Serialized document, truncated to maxChars. */
  html: string;
  truncated: boolean;
  /** Visible text, truncated to maxChars / 4. */
  text: string;
  forms: DomForm[];
  scripts: DomScript[];
  iframes: { src: string | null; visible: boolean }[];
  /** <meta http-equiv="refresh"> content, if any. */
  metaRefresh: string | null;
  linkCount: number;
};

// GET /browser/requests?format=json|har
export type RequestRecord = {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  mimeType: string | null;
  /** Request body, truncated to 2 KB. */
  postData: string | null;
  failure: string | null;
  isNavigation: boolean;
  frameUrl: string | null;
  startedAt: string;
  durationMs: number | null;
  responseSize: number | null;
  remoteAddress: string | null;
};
export type RequestsResponse = { requests: RequestRecord[] };
// format=har → HAR 1.2 JSON built from the same records.

// GET /browser/events — behaviour the init script and page listeners caught
export type BrowserEvents = {
  dialogs: { type: string; message: string; at: string }[];
  console: { type: string; text: string; at: string }[];
  /** navigator.clipboard.writeText / execCommand("copy") payloads. Classic fake-CAPTCHA tell. */
  clipboardWrites: { text: string; at: string }[];
  /** Notification / geolocation / etc. permission requests. */
  permissionRequests: { permission: string; at: string }[];
  /** Popups and new windows. */
  popups: { url: string; at: string }[];
  downloads: { url: string; suggestedFilename: string; path: string | null; at: string }[];
  /** Calls to eval / new Function / setTimeout(string), with a snippet. */
  dynamicCode: { kind: string; snippet: string; length: number; at: string }[];
  /** Calls to atob / unescape / String.fromCharCode with large payloads. */
  decodes: { kind: string; length: number; at: string }[];
  pageErrors: { message: string; at: string }[];
};

// POST /exec — runs as the unprivileged sandbox user, in /home/sandbox/work
export type ExecRequest = {
  cmd: string;
  /** Default 30000, max 120000. */
  timeoutMs?: number;
};
export type ExecResponse = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output is capped at 64 KB per stream. */
  truncated: boolean;
};

// GET /files
export type SandboxFile = {
  /** Relative to the sandbox root, e.g. "downloads/invoice.zip" or "work/out.txt". */
  path: string;
  size: number;
  sha256: string;
  /** Output of `file --brief`, if available. */
  type: string | null;
  source: "download" | "workspace";
};
export type FilesResponse = { files: SandboxFile[] };
// GET /files/<path> → raw bytes (application/octet-stream)
