import { isIP } from "node:net";

export type NormalizedUrl =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: string };

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
];

function isLocalHost(host: string) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) return PRIVATE_IPV4.some((range) => range.test(host));
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host) || /^fe80:/.test(host);
  return false;
}

/**
 * Canonical form used as the lookup key: http(s) only, lowercase host, no
 * credentials, no fragment. Local and private-network pages are skipped.
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Only http(s) pages are checked, not ${url.protocol}` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return { ok: false, reason: "URL has no host" };
  if (isLocalHost(host)) return { ok: false, reason: "Local or private-network address" };

  url.username = "";
  url.password = "";
  url.hash = "";
  return { ok: true, url: url.toString(), host };
}

/** The host and each parent domain, most specific first: a.b.example.com → b.example.com → example.com. */
export function hostAndParents(host: string) {
  if (isIP(host)) return [host];
  const labels = host.split(".");
  const hosts: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) hosts.push(labels.slice(i).join("."));
  return hosts.length > 0 ? hosts : [host];
}
