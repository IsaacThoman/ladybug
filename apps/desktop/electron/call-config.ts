import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { DEFAULT_SERVER_PORT, PUBLIC_URL } from "@ladybug/shared";

export function loadCallEnv(file: string, env: Record<string, string | undefined> = process.env) {
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function readDesktopCallConfig(env: Record<string, string | undefined> = process.env) {
  const url = new URL(env.CALL_SERVER_URL || env.VITE_SERVER_URL || (env.VITE_DEV_SERVER_URL ? `http://localhost:${DEFAULT_SERVER_PORT}` : PUBLIC_URL));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error("CALL_SERVER_URL must use HTTPS, or HTTP on localhost for development.");
  }
  if (!env.CALL_SERVER_TOKEN?.trim()) throw new Error("Configure CALL_SERVER_TOKEN in the desktop .env file before calling.");
  return { url: url.toString().replace(/\/$/, ""), token: env.CALL_SERVER_TOKEN.trim() };
}
