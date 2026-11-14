import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SANDBOX_DAEMON_PORT, SANDBOX_ENV } from "@ladybug/shared";
import { config } from "../config.ts";
import { DaemonClient } from "./client.ts";
import { gatewayCaPem, newSandboxToken, waitForDaemon } from "./provider.ts";
import type { Sandbox, SandboxProvider } from "./provider.ts";

const run = promisify(execFile);
const LABEL = "dev.ladybug.sandbox";

const docker = async (args: string[]) => (await run("docker", args, { maxBuffer: 1024 * 1024 })).stdout.trim();

/**
 * One container per scan on the local Docker daemon.
 *
 * - Worker on the host (`npm run dev:worker`): the daemon port is published on
 *   127.0.0.1. No egress gateway unless GATEWAY_PROXY_URL is set, so the
 *   sandbox has normal internet access. Fine on a dev laptop.
 * - Worker in a container (compose / Coolify, SANDBOX_DOCKER_NETWORK set): the
 *   sandbox joins only that network, which should be `internal` so its one way
 *   out is the egress gateway, and the worker reaches it by IP.
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
    const ca = await gatewayCaPem();
    if (ca) env[SANDBOX_ENV.gatewayCaPem] = ca;
    const network = config.sandboxDockerNetwork;

    const id = await docker([
      "run",
      "-d",
      "--label",
      `${LABEL}=1`,
      "--label",
      `${LABEL}.scan-id=${scanId}`,
      "--label",
      `${LABEL}.created-at=${Date.now()}`,
      ...(network ? ["--network", network] : ["-p", `127.0.0.1::${SANDBOX_DAEMON_PORT}`]),
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
      let baseUrl: string;
      if (network) {
        const ip = await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, id]);
        if (!ip) throw new Error(`sandbox ${id} has no address on network ${network}`);
        baseUrl = `http://${ip}:${SANDBOX_DAEMON_PORT}`;
      } else {
        const mapping = await docker(["port", id, `${SANDBOX_DAEMON_PORT}/tcp`]);
        baseUrl = `http://127.0.0.1:${mapping.split("\n")[0].split(":").pop()}`;
      }
      const client = new DaemonClient(baseUrl, token);
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
