// Instance-wide settings an admin can change at runtime, plus the list of
// models the worker's LLM endpoint offers (published to Valkey by the worker,
// which is the only one holding the API key).
import type pg from "pg";
import type { Redis } from "ioredis";
import type { LlmCatalog } from "@ladybug/shared";
import type { Db } from "./db.ts";

export const SETTINGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
`;

export async function setupSettings(client: pg.PoolClient) {
  await client.query(SETTINGS_TABLE_SQL);
}

/** The model scans investigate with. Unset = the worker's LLM_MODEL. */
export const LLM_MODEL_SETTING = "llm_model";

export async function getSetting<T>(db: Db, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

/** null removes the setting, so its default applies again. */
export async function setSetting(db: Db, key: string, value: unknown) {
  if (value === null) {
    await db.query("DELETE FROM settings WHERE key = $1", [key]);
    return;
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

const LLM_CATALOG_KEY = "llm:catalog";
/**
 * The worker refreshes the catalog every few minutes. If it stops, the
 * catalog expires and the admin UI says no worker is reporting.
 */
export const LLM_CATALOG_REFRESH_MS = 5 * 60_000;
const LLM_CATALOG_TTL_SECONDS = 20 * 60;

export async function publishLlmCatalog(redis: Redis, catalog: LlmCatalog) {
  await redis.set(LLM_CATALOG_KEY, JSON.stringify(catalog), "EX", LLM_CATALOG_TTL_SECONDS);
}

export async function readLlmCatalog(redis: Redis): Promise<LlmCatalog | null> {
  const raw = await redis.get(LLM_CATALOG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LlmCatalog;
  } catch {
    return null;
  }
}

/** The scan model setting, as the admin API sees it. Postgres + Valkey in the server; in memory in tests. */
export type ModelSettingsStore = {
  /** What the worker last reported, or null if no worker has recently. */
  catalog(): Promise<LlmCatalog | null>;
  /** The admin's pick, or null for the worker's default. */
  selected(): Promise<string | null>;
  select(model: string | null): Promise<void>;
};

export function createModelSettings(db: Db, redis: Redis): ModelSettingsStore {
  return {
    catalog: () => readLlmCatalog(redis),
    async selected() {
      const value = await getSetting<unknown>(db, LLM_MODEL_SETTING);
      return typeof value === "string" && value ? value : null;
    },
    select: (model) => setSetting(db, LLM_MODEL_SETTING, model),
  };
}
