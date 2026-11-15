import { config } from "./config.ts";

/**
 * Minimal Typesense REST client: just the endpoints the server needs.
 * https://typesense.org/docs/latest/api/
 */

export class TypesenseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TypesenseError";
    this.status = status;
  }
}

export type FieldSchema = {
  name: string;
  type: "string" | "string[]" | "int32" | "int64" | "float" | "bool";
  facet?: boolean;
  optional?: boolean;
  sort?: boolean;
  index?: boolean;
};

export type CollectionSchema = {
  name: string;
  fields: FieldSchema[];
  default_sorting_field?: string;
  token_separators?: string[];
};

export type SearchParams = {
  q: string;
  query_by?: string;
  filter_by?: string;
  sort_by?: string;
  facet_by?: string;
  max_facet_values?: number;
  page?: number;
  per_page?: number;
};

export type SearchResult<T> = {
  found: number;
  page: number;
  hits?: { document: T }[];
  facet_counts?: { field_name: string; counts: { value: string; count: number }[] }[];
};

type Query = Record<string, string | number | undefined>;

async function request<T>(method: string, path: string, body?: unknown, query?: Query) {
  const url = new URL(path, config.typesenseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    method,
    headers: {
      "X-TYPESENSE-API-KEY": config.typesenseApiKey,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const message = (data as { message?: string } | undefined)?.message ?? text.slice(0, 200);
    throw new TypesenseError(res.status, `Typesense ${method} ${path}: ${message}`);
  }
  return data as T;
}

const documents = (collection: string) => `/collections/${collection}/documents`;

export const typesense = {
  health: () => request<{ ok: boolean }>("GET", "/health"),

  async ensureCollection(schema: CollectionSchema) {
    try {
      await request("GET", `/collections/${schema.name}`);
      return false;
    } catch (error) {
      if (!(error instanceof TypesenseError) || error.status !== 404) throw error;
      await request("POST", "/collections", schema);
      return true;
    }
  },

  /** Creates a document; resolves false if one with that id already exists. */
  async create(collection: string, document: object) {
    try {
      await request("POST", documents(collection), document, { action: "create" });
      return true;
    } catch (error) {
      if (error instanceof TypesenseError && error.status === 409) return false;
      throw error;
    }
  },

  upsert: <T>(collection: string, document: T) =>
    request<T>("POST", documents(collection), document, { action: "upsert" }),

  retrieve: <T>(collection: string, id: string) =>
    request<T>("GET", `${documents(collection)}/${encodeURIComponent(id)}`),

  remove: (collection: string, id: string) =>
    request("DELETE", `${documents(collection)}/${encodeURIComponent(id)}`),

  search: <T>(collection: string, params: SearchParams) =>
    request<SearchResult<T>>("GET", `${documents(collection)}/search`, undefined, params),
};
