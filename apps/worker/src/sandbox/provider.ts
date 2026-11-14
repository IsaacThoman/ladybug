import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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

export async function waitForDaemon(client: DaemonClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.healthy()) return;
    await sleep(500);
  }
  throw new Error(`sandbox daemon at ${client.baseUrl} didn't become ready in ${timeoutMs / 1000}s`);
}
