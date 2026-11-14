import type { UrlRecord } from "@ladybug/shared";
import { logEvent } from "./activity.ts";
import { buildRecord, createRecordIfMissing } from "./store.ts";

/** Example records so the demo has one known-good and one known-bad site. */
const SEEDS: Omit<UrlRecord, "id" | "checkedAt">[] = [
  {
    scope: "host",
    url: "https://example.com/",
    host: "example.com",
    verdict: "safe",
    reason: "IANA's reserved example domain",
    source: "seed",
  },
  {
    scope: "url",
    url: "https://testsafebrowsing.appspot.com/s/phishing.html",
    host: "testsafebrowsing.appspot.com",
    verdict: "unsafe",
    reason: "Google Safe Browsing's phishing test page",
    source: "seed",
  },
];

/** Adds any seed records that are missing. Never overwrites existing ones. */
export async function seedUrls() {
  for (const seed of SEEDS) {
    const record = buildRecord({ ...seed, checkedAt: Date.now() });
    if (await createRecordIfMissing(record)) {
      logEvent({
        type: "admin",
        message: `Seeded ${record.verdict} ${record.scope} record: ${record.scope === "host" ? record.host : record.url}`,
        url: record.url,
        host: record.host,
        verdict: record.verdict,
        details: { recordId: record.id },
      });
    }
  }
}
