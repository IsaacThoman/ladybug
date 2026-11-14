import { createHash } from "node:crypto";
import type {
  LogEvent,
  LogEventType,
  Page,
  UrlRecord,
  UrlScope,
  Verdict,
  VerdictSource,
  Decision,
} from "@ladybug/shared";
import { typesense } from "./typesense.ts";
import type { CollectionSchema, SearchParams } from "./typesense.ts";
import { hostAndParents } from "./urls.ts";

// Split URLs into words so the admin search can match "example", "phishing", etc.
const TOKEN_SEPARATORS = [".", "/", ":", "-", "_", "?", "=", "&", "%", "+", "~"];

const URLS = "urls";
const EVENTS = "events";

const URLS_SCHEMA: CollectionSchema = {
  name: URLS,
  fields: [
    { name: "scope", type: "string", facet: true },
    { name: "url", type: "string" },
    { name: "host", type: "string", facet: true },
    { name: "verdict", type: "string", facet: true },
    { name: "reason", type: "string" },
    { name: "source", type: "string", facet: true },
    { name: "checkedAt", type: "int64", sort: true },
  ],
  default_sorting_field: "checkedAt",
  token_separators: TOKEN_SEPARATORS,
};

const EVENTS_SCHEMA: CollectionSchema = {
  name: EVENTS,
  fields: [
    { name: "type", type: "string", facet: true },
    { name: "at", type: "int64", sort: true },
    { name: "message", type: "string" },
    { name: "url", type: "string", optional: true },
    { name: "host", type: "string", facet: true, optional: true },
    { name: "decision", type: "string", facet: true, optional: true },
    { name: "verdict", type: "string", facet: true, optional: true },
    { name: "durationMs", type: "int64", optional: true },
    // Stored as JSON, not searchable.
    { name: "details", type: "string", optional: true, index: false },
  ],
  default_sorting_field: "at",
  token_separators: TOKEN_SEPARATORS,
};

let ready = false;

/** True once Typesense is reachable and the collections exist. */
export const isStoreReady = () => ready;

export async function initStore() {
  await typesense.health();
  await typesense.ensureCollection(URLS_SCHEMA);
  await typesense.ensureCollection(EVENTS_SCHEMA);
  ready = true;
}

// ---------------------------------------------------------------------------
// URL records

/** Stable id, so a URL (or host) maps to exactly one document. */
export const recordId = (scope: UrlScope, key: string) =>
  createHash("sha256").update(`${scope}:${key}`).digest("hex").slice(0, 40);

export function buildRecord(input: Omit<UrlRecord, "id">): UrlRecord {
  const key = input.scope === "url" ? input.url : input.host;
  return { id: recordId(input.scope, key), ...input };
}

/**
 * Looks the URL up in one Typesense search: the exact URL, plus host-wide
 * records for its host and parent domains. The most specific match wins.
 */
export async function findRecord(url: string, host: string) {
  const candidates = [
    recordId("url", url),
    ...hostAndParents(host).map((h) => recordId("host", h)),
  ];
  const result = await typesense.search<UrlRecord>(URLS, {
    q: "*",
    filter_by: `id:[${candidates.join(",")}]`,
    per_page: candidates.length,
  });
  const byId = new Map(result.hits?.map((hit) => [hit.document.id, hit.document]));
  for (const id of candidates) {
    const record = byId.get(id);
    if (record) return record;
  }
  return null;
}

export async function saveRecord(input: Omit<UrlRecord, "id">) {
  const record = buildRecord(input);
  await typesense.upsert(URLS, record);
  return record;
}

/** Inserts the record unless one already exists. Resolves whether it was created. */
export const createRecordIfMissing = (record: UrlRecord) => typesense.create(URLS, record);

export const getRecord = (id: string) => typesense.retrieve<UrlRecord>(URLS, id);

export const deleteRecord = (id: string) => typesense.remove(URLS, id);

export async function searchRecords(options: {
  q?: string;
  verdict?: Verdict;
  scope?: UrlScope;
  source?: VerdictSource;
  page: number;
  perPage: number;
}): Promise<Page<UrlRecord>> {
  const filters = [
    options.verdict && `verdict:=${options.verdict}`,
    options.scope && `scope:=${options.scope}`,
    options.source && `source:=${options.source}`,
  ].filter(Boolean);
  return searchPage<UrlRecord>(URLS, "url,host,reason", "checkedAt", options, filters);
}

// ---------------------------------------------------------------------------
// Activity log

type EventDocument = Omit<LogEvent, "details"> & { details?: string };

export async function saveEvent(event: LogEvent) {
  const document: EventDocument = {
    ...event,
    details: event.details ? JSON.stringify(event.details) : undefined,
  };
  await typesense.create(EVENTS, document);
}

export async function searchEvents(options: {
  q?: string;
  types?: LogEventType[];
  decision?: Decision;
  verdict?: Verdict;
  page: number;
  perPage: number;
}): Promise<Page<LogEvent>> {
  const filters = [
    options.types?.length && `type:[${options.types.join(",")}]`,
    options.decision && `decision:=${options.decision}`,
    options.verdict && `verdict:=${options.verdict}`,
  ].filter(Boolean);
  const page = await searchPage<EventDocument>(EVENTS, "message,url,host", "at", options, filters);
  return {
    ...page,
    items: page.items.map(({ details, ...event }) => ({
      ...event,
      details: details ? (JSON.parse(details) as Record<string, unknown>) : undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers

async function searchPage<T>(
  collection: string,
  queryBy: string,
  timeField: string,
  options: { q?: string; page: number; perPage: number },
  filters: (string | false | 0 | undefined)[],
): Promise<Page<T>> {
  const q = options.q?.trim() || "*";
  const params: SearchParams = {
    q,
    query_by: queryBy,
    filter_by: filters.length > 0 ? filters.join(" && ") : undefined,
    sort_by: q === "*" ? `${timeField}:desc` : `_text_match:desc,${timeField}:desc`,
    page: options.page,
    per_page: options.perPage,
  };
  const result = await typesense.search<T>(collection, params);
  return {
    items: result.hits?.map((hit) => hit.document) ?? [],
    found: result.found,
    page: options.page,
    perPage: options.perPage,
  };
}

/** Total documents and per-value counts for one facet field. */
export async function countBy(collection: "urls" | "events", field: string) {
  const result = await typesense.search<unknown>(collection, {
    q: "*",
    facet_by: field,
    per_page: 0,
  });
  const counts = Object.fromEntries(
    result.facet_counts?.find((f) => f.field_name === field)?.counts.map((c) => [c.value, c.count]) ??
      [],
  ) as Record<string, number>;
  return { total: result.found, counts };
}
