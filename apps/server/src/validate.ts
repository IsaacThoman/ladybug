import { isIP } from "node:net";

const MAX_URL_LENGTH = 2048;

/**
 * Normalises a user-supplied URL and rejects anything we shouldn't detonate:
 * non-http(s) schemes, localhost and internal names, and private, link-local
 * or metadata IP literals. The sandbox gateway blocks internal ranges at egress
 * too; this just fails fast with a clear error.
 */
export function normaliseScanUrl(input: unknown): { url: string } | { error: string } {
  if (typeof input !== "string" || !input.trim()) return { error: "url is required" };
  let raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) return { error: "url is too long" };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "url is not valid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "only http and https URLs can be scanned" };

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { error: "url has no host" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { error: "internal hosts can't be scanned" };
  }
  if (isIP(host) && isPrivateIp(host)) return { error: "private addresses can't be scanned" };
  if (!isIP(host) && !host.includes(".")) return { error: "url host must be a domain name" };

  return { url: url.toString() };
}

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("::ffff:")) {
    // IPv4-mapped. WHATWG URL serialises it as hex, e.g. ::ffff:a00:1.
    const rest = v6.slice(7);
    if (isIP(rest) === 4) return isPrivateIp(rest);
    const [hi, lo] = rest.split(":").map((part) => parseInt(part, 16));
    return isPrivateIp([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
  }
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}
