import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { parse } from "tldts";
import type { DomainInfo } from "@ladybug/shared";
import { checkLookalike } from "./lookalike.ts";

const USER_AGENT = "ladybug-scanner/0.1";
const resolver = new Resolver({ timeout: 3000, tries: 2 });

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type RdapResponse = {
  events?: { eventAction?: string; eventDate?: string }[];
  entities?: { roles?: string[]; vcardArray?: [string, [string, object, string, string][]] }[];
};

async function rdap(domain: string) {
  const data = await fetchJson<RdapResponse>(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    headers: { Accept: "application/rdap+json" },
  });
  const registeredAt = data?.events?.find((e) => e.eventAction === "registration")?.eventDate ?? null;
  const registrarEntity = data?.entities?.find((e) => e.roles?.includes("registrar"));
  const registrar = registrarEntity?.vcardArray?.[1]?.find((field) => field[0] === "fn")?.[3] ?? null;
  return { registeredAt, registrar };
}

type CrtShEntry = { not_before?: string; id?: number };

async function crtSh(domain: string) {
  // crt.sh is slow and often overloaded; give it a while but don't depend on it.
  const data = await fetchJson<CrtShEntry[]>(
    `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json&exclude=expired`,
    {},
    6_000,
  );
  if (!Array.isArray(data)) return { certificateCount: null, firstCertificateAt: null };
  const dates = data.map((e) => e.not_before).filter((d): d is string => Boolean(d)).sort();
  return { certificateCount: data.length, firstCertificateAt: dates[0] ? new Date(`${dates[0]}Z`).toISOString() : null };
}

async function resolveIps(hostname: string) {
  if (isIP(hostname)) return [hostname];
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  return [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
}

/** Team Cymru's DNS interface: no API key, answers in milliseconds. */
async function asnFor(ip: string) {
  if (isIP(ip) !== 4) return null;
  try {
    const reversed = ip.split(".").reverse().join(".");
    const [origin] = await resolver.resolveTxt(`${reversed}.origin.asn.cymru.com`);
    const asn = origin?.join("").split("|")[0]?.trim();
    if (!asn) return null;
    const [desc] = await resolver.resolveTxt(`AS${asn.split(" ")[0]}.asn.cymru.com`);
    const name = desc?.join("").split("|").pop()?.trim();
    return name ? `AS${asn.split(" ")[0]} ${name}` : `AS${asn}`;
  } catch {
    return null;
  }
}

export async function lookupDomain(hostname: string): Promise<DomainInfo> {
  const host = hostname.toLowerCase();
  const registrableDomain = isIP(host) ? null : parse(host).domain;
  const [registration, certs, ips] = await Promise.all([
    registrableDomain ? rdap(registrableDomain) : Promise.resolve({ registeredAt: null, registrar: null }),
    registrableDomain ? crtSh(registrableDomain) : Promise.resolve({ certificateCount: null, firstCertificateAt: null }),
    resolveIps(host),
  ]);
  const asn = ips[0] ? await asnFor(ips[0]) : null;
  const ageDays = registration.registeredAt
    ? Math.floor((Date.now() - new Date(registration.registeredAt).getTime()) / 86_400_000)
    : null;
  return {
    hostname: host,
    registrableDomain,
    registeredAt: registration.registeredAt,
    ageDays,
    registrar: registration.registrar,
    ips,
    asn,
    certificateCount: certs.certificateCount,
    firstCertificateAt: certs.firstCertificateAt,
    lookalike: checkLookalike(host),
  };
}
