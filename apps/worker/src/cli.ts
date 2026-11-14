// One-off scan without the queue, database or server:
//   npm run scan -w @ladybug/worker -- https://example.com
// Events stream to stderr, the report JSON goes to stdout, artifacts to the
// local artifact store (.artifacts/ by default).
import { randomUUID } from "node:crypto";
import { createArtifactStore } from "@ladybug/backend";
import { runScan } from "./pipeline.ts";
import { createProvider } from "./sandbox/index.ts";

const url = process.argv[2];
if (!url) {
  console.error("usage: npm run scan -w @ladybug/worker -- <url>");
  process.exit(1);
}

const scanId = randomUUID();
const started = Date.now();
const report = await runScan(scanId, url, {
  provider: createProvider(),
  artifacts: createArtifactStore(),
  emit: async (event) => {
    const t = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
    const rest: Record<string, unknown> = { ...event };
    delete rest.type;
    delete rest.at;
    console.error(`${t}s ${event.type.padEnd(14)} ${JSON.stringify(rest).slice(0, 220)}`);
  },
});
console.log(JSON.stringify(report, null, 2));
