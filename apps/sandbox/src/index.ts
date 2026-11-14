import fs from "node:fs/promises";
import { BrowserManager } from "./browser.ts";
import { config } from "./config.ts";
import { setupNetwork } from "./network.ts";
import { createServer } from "./server.ts";
import { errorMessage } from "./util.ts";

if (!config.token) {
  console.error("[sandbox] SANDBOX_TOKEN is not set; refusing to start");
  process.exit(1);
}

await fs.mkdir(config.downloadsDir, { recursive: true });
await fs.mkdir(config.workDir, { recursive: true });

const network = await setupNetwork(config);
const browser = new BrowserManager(config, network);

try {
  await browser.mutex.run(() => browser.start(false));
} catch (error) {
  // Keep serving: /healthz reports browser:false and the next browser call retries.
  console.error(`[sandbox] browser failed to start: ${errorMessage(error)}`);
}

const server = createServer(config, browser, network);
server.requestTimeout = 180_000;
server.listen(config.port, config.host, () => {
  console.log(
    `[sandbox] listening on ${config.host}:${config.port} (headless=${config.headless}, proxy=${config.proxyUrl || "none"}, caTrusted=${network.caTrusted})`,
  );
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[sandbox] ${signal}, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close();
  server.closeAllConnections();
  await browser.shutdown().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
