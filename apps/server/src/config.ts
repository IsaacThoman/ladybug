import path from "node:path";
import { DEFAULT_SERVER_PORT } from "@ladybug/shared";

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const config = {
  port: numberFromEnv("PORT", DEFAULT_SERVER_PORT),
  typesenseUrl: process.env.TYPESENSE_URL ?? "http://localhost:8108",
  typesenseApiKey: process.env.TYPESENSE_API_KEY ?? "ladybug-dev-key",
  /** How long the placeholder analysis "thinks" before deciding. */
  analysisDelayMs: numberFromEnv("ANALYSIS_DELAY_MS", 30_000),
  /** Built admin UI, served at /admin when it exists. */
  adminDist:
    process.env.ADMIN_DIST ?? path.resolve(import.meta.dirname, "../../admin/dist"),
};
