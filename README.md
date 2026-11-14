# ladybug

A desktop pet that checks links for you. Drop a URL on the ladybug and it sends it off to be opened in a disposable sandbox, where a scripted pass and an LLM agent investigate it. The pet sniffs around while that happens, then reacts to the verdict; click it to open the full report.

## How a scan works

1. **API** (`apps/server`): `POST /api/scans {url}` validates the URL, stores a row in Postgres and queues a BullMQ job on Valkey.
2. **Worker** (`apps/worker`) picks up the job and moves it through `provisioning → detonating → investigating → scoring → done`, publishing every step to a Valkey Stream (`scan:{id}`):
   - **provisioning:** starts a sandbox (a Docker container locally, a bare Pod on Kubernetes) while running lookups that never touch the target: RDAP domain age, crt.sh certificate history, DNS and hosting ASN, Safe Browsing, URLhaus, and a punycode / homoglyph / brand look-alike check.
   - **detonating:** a scripted baseline with no LLM. Load the page, take screenshots 0, 3 and 10 seconds after load, capture the DOM, network log (HAR), downloads and page behaviour (dialogs, clipboard writes, permission prompts, eval and decode calls), then reload as a phone to catch cloaking.
   - **investigating:** an LLM agent, on any OpenAI-compatible Chat Completions endpoint with tool calling, drives the sandboxed browser, follows the flow a victim would with throwaway credentials, inspects downloads, and calls `record_finding` as it goes, so findings appear live. It finishes with a strict `submit_report`.
   - **scoring:** hard signals plus the agent's score give the final 0–100 score and a verdict (under 30 benign, 30–69 suspicious, 70+ malicious). Weights live in `apps/worker/src/scoring/weights.ts`.
3. **Report page** (`apps/web`) streams the events over SSE: a live screenshot feed, findings as they're recorded, the redirect chain, IOCs and a score gauge. `/demo` replays a recorded scan without a server.
4. **Pet** (`apps/desktop`): drop a link on the bug, or use "Scan clipboard URL" in the tray menu.

The sandbox (`apps/sandbox`) is a Playwright image running a headful Chrome on Xvfb, plus a small HTTP daemon the worker drives with a per-sandbox bearer token. On Kubernetes its only route out is the mitmproxy gateway (`infra/gateway`). The gateway records traffic, tags each flow with its scan, and refuses internal addresses. The sandbox has no DNS. NetworkPolicies enforce all of this.

## Layout

npm-workspaces monorepo, TypeScript everywhere. Node apps run their `.ts` sources directly with Node's type stripping.

| Path | What |
| --- | --- |
| `apps/server` | Express API: scans, SSE event stream, artifact redirects |
| `apps/worker` | Queue consumer: sandbox lifecycle, pre-scan, detonation, LLM agent loop, scoring |
| `apps/sandbox` | Sandbox image and in-container tool daemon |
| `apps/web` | Vite + React report page |
| `apps/desktop` | Electron + Vite + React desktop pet (three.js ladybug) |
| `packages/shared` | Types shared by everything: scan events, the report, the daemon API |
| `packages/backend` | Node-only helpers for server and worker: Postgres, Valkey, artifact store |
| `infra/terraform` | Vultr: VPC, VKE with system and autoscaling sandbox pools, Managed Postgres and Valkey, Object Storage, Container Registry |
| `infra/k8s` | Namespaces, NetworkPolicies, RBAC, deployments, bootstrap and deny-test scripts |
| `infra/gateway` | mitmproxy egress gateway and addon |
| `docs/contracts.md` | Names, ports, labels and environment variables the pieces agree on |

## Running it locally

Requires Node 22.18+ and Docker.

```sh
npm install
npm run services:up      # Postgres + Valkey in Docker
docker build -f apps/sandbox/Dockerfile -t ladybug-sandbox:dev .
cp apps/server/.env.example apps/server/.env
cp apps/worker/.env.example apps/worker/.env   # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm run dev              # server, worker, web report page and the pet
```

Without `LLM_API_KEY` and `LLM_MODEL`, scans still run end to end and score from hard signals only; the report is flagged `llm_skipped`. If ports 5432 or 6379 are taken, set `LADYBUG_POSTGRES_PORT` and `LADYBUG_VALKEY_PORT` for `services:up`, and update the URLs in the `.env` files.

To scan one URL without the queue, database or server, printing events as they happen and the report as JSON:

```sh
npm run scan -w @ladybug/worker -- https://example.com
```

Locally, the worker's docker provider gives sandboxes normal internet access, with the daemon port bound to 127.0.0.1. The egress gateway and NetworkPolicies are what isolate them in the cluster. See `infra/README.md` to deploy on Vultr.

### Config

Every environment variable is listed in [`docs/contracts.md`](docs/contracts.md). The main ones:

- `apps/server/.env`: `PORT`, `DATABASE_URL`, `REDIS_URL`, `API_KEYS` (unset means anyone can start scans)
- `apps/worker/.env`: the same database settings, plus `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `SANDBOX_PROVIDER`, `SAFE_BROWSING_API_KEY`, `URLHAUS_AUTH_KEY`
- `apps/desktop/.env`: `VITE_SERVER_URL`, `VITE_WEB_URL`, `VITE_API_KEY`

## Using the pet

- It wanders along the bottom of the screen on its own.
- Drop a link on it, or choose "Scan clipboard URL" from the tray or right-click menu, and it goes to investigate.
- When the scan finishes, it reacts to the verdict: a happy wiggle, nervous, or alarmed. Click it to open the report.
- Otherwise, a click makes it hop and say something. You can drag it around and throw it.

Everything else on the overlay is click-through, so it never gets in the way of the apps underneath.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Server, worker, web and desktop in watch mode |
| `npm run services:up` / `services:down` | Local Postgres and Valkey |
| `npm run scan -w @ladybug/worker -- <url>` | One-off scan, report to stdout |
| `npm run build` | Typecheck and build every workspace |
| `npm run typecheck` | Typecheck every workspace |
| `npm test` | Unit tests (Node's test runner) |
| `npm run lint` | ESLint across the repo |
| `scripts/build-images.sh` | Build (and push) all five container images |
| `npm run dist -w @ladybug/desktop` | Package the desktop app with electron-builder |
