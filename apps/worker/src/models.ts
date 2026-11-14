// Which model scans investigate with. The admin picks one of the models the
// endpoint offers; the worker lists them (it holds the API key) and publishes
// the list to Valkey for the admin UI.
import OpenAI from "openai";
import type { Redis } from "ioredis";
import { LLM_CATALOG_REFRESH_MS, LLM_MODEL_SETTING, getSetting, publishLlmCatalog } from "@ladybug/backend";
import type { Db } from "@ladybug/backend";
import type { LlmCatalog } from "@ladybug/shared";
import { config } from "./config.ts";

/** Models that can't run a tool-calling chat loop: embeddings, speech, images, moderation, legacy completions. */
const NOT_CHAT = /embed|tts|whisper|transcribe|dall-e|image|moderation|davinci|babbage|realtime|audio|search|sora|computer-use/i;

/** The ids worth offering, sorted so versions read in order (gpt-4.1 before gpt-4.10). */
export function chatModels(ids: string[]) {
  return [...new Set(ids)]
    .filter((id) => !NOT_CHAT.test(id))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export async function fetchCatalog(): Promise<LlmCatalog> {
  const { apiKey, baseUrl, model } = config.llm;
  const catalog: LlmCatalog = { baseUrl, defaultModel: model, models: [], fetchedAt: Date.now() };
  try {
    const client = new OpenAI({ apiKey: apiKey ?? undefined, baseURL: baseUrl, timeout: 20_000, maxRetries: 1 });
    const ids: string[] = [];
    for await (const entry of client.models.list()) ids.push(entry.id);
    catalog.models = chatModels(ids);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    catalog.error = err instanceof OpenAI.APIError ? `${err.status ?? "network"}: ${message}`.slice(0, 200) : message.slice(0, 200);
  }
  return catalog;
}

/**
 * Publishes the catalog now and every few minutes after. Does nothing without
 * an API key: then there's no model to pick and reports use hard signals only.
 */
export function startCatalogPublisher(redis: Redis) {
  if (!config.llm.apiKey) return () => {};
  const publish = async () => {
    const catalog = await fetchCatalog();
    if (catalog.error) console.warn(`[worker] listing models at ${catalog.baseUrl} failed: ${catalog.error}`);
    await publishLlmCatalog(redis, catalog).catch((err: unknown) => console.warn("[worker] publishing models failed", err));
  };
  void publish();
  const timer = setInterval(publish, LLM_CATALOG_REFRESH_MS);
  return () => clearInterval(timer);
}

/** The admin's pick, else LLM_MODEL. A database hiccup falls back to LLM_MODEL rather than failing the scan. */
export async function scanModel(db: Db): Promise<string | null> {
  try {
    const selected = await getSetting<unknown>(db, LLM_MODEL_SETTING);
    if (typeof selected === "string" && selected) return selected;
  } catch (err) {
    console.warn("[worker] reading the selected model failed; using LLM_MODEL", err);
  }
  return config.llm.model;
}
