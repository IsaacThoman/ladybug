import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { seedUrls } from "./seed.ts";
import { initStore } from "./store.ts";

const RETRY_MS = 3_000;

createApp().listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
});

// Typesense may still be starting (e.g. under docker compose), so keep trying.
async function connectStore() {
  for (let attempt = 1; ; attempt++) {
    try {
      await initStore();
      await seedUrls();
      console.log(`[server] connected to Typesense at ${config.typesenseUrl}`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt === 1 || attempt % 10 === 0) {
        console.warn(
          `[server] Typesense not ready at ${config.typesenseUrl} (${reason}); retrying every ${RETRY_MS / 1000}s`,
        );
      }
      await sleep(RETRY_MS);
    }
  }
}

void connectStore();
