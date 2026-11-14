import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SANDBOX_DAEMON_PORT, SANDBOX_ENV } from "@ladybug/shared";
import { config } from "../config.ts";
import { DaemonClient } from "./client.ts";
import { newSandboxToken, waitForDaemon } from "./provider.ts";
import type { Sandbox, SandboxProvider } from "./provider.ts";

const run = promisify(execFile);
const LABEL = "dev.ladybug.sandbox";

const docker = async (args: string[]) => (await run("docker", args, { maxBuffer: 1024 * 1024 })).stdout.trim();

/**
 * Local-development provider: one container per scan on the local Docker
 * daemon, daemon port published on 127.0.0.1 only. No egress gateway unless
 * GATEWAY_PROXY_URL is set, so the container has normal internet access —
 * fine on a dev laptop, not something to point at a shared network.
 */
export class DockerProvider implements SandboxProvider {
  readonly name = "docker";

  async create(scanId: string): Promise<Sandbox> {
    const token = newSandboxToken();
    const env: Record<string, string> = {
      [SANDBOX_ENV.token]: token,
      [SANDBOX_ENV.scanId]: scanId,
    };
    if (config.gatewayProxyUrl) env[SANDBOX_ENV.proxyUrl] = config.gatewayProxyUrl;
    if (config.gatewayCaPem) env[SANDBOX_ENV.gatewayCaPem] = config.gatewayCaPem;

    const id = await docker([
      "run",
      "-d",
      "--label",
      `${LABEL}=1`,
      "--label",
      `${LABEL}.scan-id=${scanId}`,
      "--label",
      `${LABEL}.created-at=${Date.now()}`,
      "-p",
      `127.0.0.1::${SANDBOX_DAEMON_PORT}`,
      "--shm-size=1g",
      "--memory=3g",
      "--cpus=2",
      "--pids-limit=1024",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      config.sandboxImage,
    ]);

    try {
      const mapping = await docker(["port", id, `${SANDBOX_DAEMON_PORT}/tcp`]);
      const port = mapping.split("\n")[0].split(":").pop();
      const client = new DaemonClient(`http://127.0.0.1:${port}`, token);
      await waitForDaemon(client, 60_000);
      return { id, client };
    } catch (err) {
      await docker(["rm", "-f", id]).catch(() => {});
      throw err;
    }
  }

  async destroy(id: string) {
    await docker(["rm", "-f", id]).catch((err) => console.warn("[worker] docker rm failed", err.message));
  }

  async reap(maxAgeMs: number) {
    const out = await docker([
      "ps",
      "-a",
      "--filter",
      `label=${LABEL}=1`,
      "--format",
      `{{.ID}}\t{{.Label "${LABEL}.created-at"}}`,
    ]);
    const stale = out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .filter(([, createdAt]) => Date.now() - Number(createdAt) > maxAgeMs)
      .map(([id]) => id);
    if (stale.length > 0) await docker(["rm", "-f", ...stale]);
    return stale.length;
  }
}
