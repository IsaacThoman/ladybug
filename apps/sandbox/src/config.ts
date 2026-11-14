import os from "node:os";
import path from "node:path";
import { SANDBOX_DAEMON_PORT, SANDBOX_ENV } from "@ladybug/shared";

const env = process.env;

function defaultHome() {
  if (process.platform === "linux") return "/home/sandbox";
  return path.join(os.tmpdir(), "ladybug-sandbox");
}

function defaultHeadless() {
  if (env.HEADLESS) return env.HEADLESS === "1" || env.HEADLESS === "true";
  // On Linux we run headful on the Xvfb display. Elsewhere (local dev on a Mac)
  // headless keeps windows from popping up.
  return process.platform !== "linux" || !env.DISPLAY;
}

const home = path.resolve(env.SANDBOX_HOME ?? defaultHome());

export const config = {
  port: Number(env[SANDBOX_ENV.port] ?? SANDBOX_DAEMON_PORT),
  host: env.DAEMON_HOST ?? "0.0.0.0",
  token: env[SANDBOX_ENV.token] ?? "",
  scanId: env[SANDBOX_ENV.scanId] ?? "",
  proxyUrl: env[SANDBOX_ENV.proxyUrl] ?? "",
  gatewayCaPem: env[SANDBOX_ENV.gatewayCaPem] ?? "",
  home,
  downloadsDir: path.resolve(env.SANDBOX_DOWNLOADS_DIR ?? path.join(home, "downloads")),
  workDir: path.resolve(env.SANDBOX_WORK_DIR ?? path.join(home, "work")),
  /** Daemon-private state: CA bundle, browser profiles. Not listed by /files. */
  stateDir: path.resolve(env.SANDBOX_STATE_DIR ?? path.join(home, ".ladybug")),
  headless: defaultHeadless(),
  maxBodyBytes: 1024 * 1024,
};

export type Config = typeof config;
