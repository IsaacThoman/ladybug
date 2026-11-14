import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config.ts";
import { DaemonClient } from "./client.ts";

export type Sandbox = {
  /** Container id or pod name. */
  id: string;
  client: DaemonClient;
};

export interface SandboxProvider {
  readonly name: string;
  create(scanId: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  /** Deletes sandboxes older than maxAgeMs that a crashed worker left behind. Returns how many. */
  reap(maxAgeMs: number): Promise<number>;
}

export const newSandboxToken = () => randomBytes(24).toString("base64url");

/** The gateway's public CA cert, for the sandbox's Chrome to trust. Read per sandbox: the gateway may create it after the worker starts. */
export async function gatewayCaPem(): Promise<string | null> {
  if (config.gatewayCaPem) return config.gatewayCaPem;
  if (!config.gatewayCaFile) return null;
  try {
    return await readFile(config.gatewayCaFile, "utf8");
  } catch {
    console.warn(`[worker] gateway CA not readable at ${config.gatewayCaFile}; sandboxes will skip certificate checks`);
    return null;
  }
}

export async function waitForDaemon(client: DaemonClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.healthy()) return;
    await sleep(500);
  }
  throw new Error(`sandbox daemon at ${client.baseUrl} didn't become ready in ${timeoutMs / 1000}s`);
}
