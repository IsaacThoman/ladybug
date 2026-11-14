import { config } from "../config.ts";
import { fetchJson } from "./osint.ts";

export type ReputationHit = { source: string; detail: string };

type SafeBrowsingResponse = { matches?: { threatType: string; platformType: string; threat: { url: string } }[] };

/** Google Safe Browsing v4 Lookup API. Batches up to 500 URLs. */
export async function safeBrowsing(urls: string[]): Promise<ReputationHit[]> {
  if (!config.safeBrowsingApiKey || urls.length === 0) return [];
  const data = await fetchJson<SafeBrowsingResponse>(
    `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(config.safeBrowsingApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "ladybug", clientVersion: "0.1" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: [...new Set(urls)].slice(0, 500).map((url) => ({ url })),
        },
      }),
    },
  );
  return (data?.matches ?? []).map((m) => ({
    source: "Google Safe Browsing",
    detail: `${m.threatType} on ${m.threat.url}`,
  }));
}

type UrlhausUrlResponse = { query_status: string; url_status?: string; threat?: string; tags?: string[] | null };
type UrlhausHostResponse = { query_status: string; url_count?: string; urls?: { url_status: string; threat: string }[] };

const abuseChForm = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Auth-Key": config.urlhausAuthKey ?? "", "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

/** abuse.ch URLhaus: exact URL first, then the host's recent malware URLs. */
export async function urlhaus(url: string, host: string): Promise<ReputationHit[]> {
  if (!config.urlhausAuthKey) return [];
  const [byUrl, byHost] = await Promise.all([
    fetchJson<UrlhausUrlResponse>("https://urlhaus-api.abuse.ch/v1/url/", abuseChForm({ url })),
    fetchJson<UrlhausHostResponse>("https://urlhaus-api.abuse.ch/v1/host/", abuseChForm({ host })),
  ]);
  const hits: ReputationHit[] = [];
  if (byUrl?.query_status === "ok") {
    hits.push({ source: "URLhaus", detail: `URL listed (${byUrl.threat ?? "malware"}, ${byUrl.url_status ?? "unknown"})` });
  }
  const online = byHost?.urls?.filter((u) => u.url_status === "online") ?? [];
  if (byHost?.query_status === "ok" && online.length > 0) {
    hits.push({ source: "URLhaus", detail: `host serves ${online.length} live malware URL(s)` });
  }
  return hits;
}

type MalwareBazaarResponse = {
  query_status: string;
  data?: { signature?: string | null; file_type?: string; tags?: string[] | null; first_seen?: string }[];
};

/** abuse.ch MalwareBazaar hash lookup. */
export async function malwareBazaar(sha256: string): Promise<ReputationHit | null> {
  if (!config.urlhausAuthKey) return null;
  const data = await fetchJson<MalwareBazaarResponse>(
    "https://mb-api.abuse.ch/api/v1/",
    abuseChForm({ query: "get_info", hash: sha256 }),
  );
  const sample = data?.query_status === "ok" ? data.data?.[0] : undefined;
  if (!sample) return null;
  const tags = sample.tags?.length ? `, tags ${sample.tags.join(", ")}` : "";
  return {
    source: "MalwareBazaar",
    detail: `known malware ${sample.signature ?? sample.file_type ?? "sample"} (first seen ${sample.first_seen ?? "?"}${tags})`,
  };
}
