# Contracts between components

The source of truth is `packages/shared/src/scan.ts` (scan, event, report and HTTP API types) and `packages/shared/src/sandbox.ts` (the sandbox daemon API). This file covers what types can't: names, ports, labels and environment variables.

## Code conventions

- TypeScript everywhere, ESM, run directly by Node 22.18+ type stripping (no build step for Node apps). That means `erasableSyntaxOnly`: no `enum`, no constructor parameter properties, no namespaces. Relative imports carry the `.ts` extension.
- Vite + React for `apps/web` and `apps/desktop`.
- 2-space indent, double quotes, semicolons, sparse comments.

## HTTP API (apps/server, port 3001)

| Route | Auth | Returns |
|---|---|---|
| `POST /api/scans {url}` | `x-api-key` when `API_KEYS` is set | `202 CreateScanResponse` |
| `GET /api/scans?limit=20` | none | `ScanListResponse` |
| `GET /api/scans/:id` | none | `ScanResponse` |
| `GET /api/scans/:id/events` | none | SSE, see `eventsPath` in shared |
| `GET /api/scans/:id/artifacts/:key` | none | 302 to a presigned URL (or the file in local dev), see `artifactPath` |

Errors are `ApiError` JSON with 400/401/404/429. Scan ids are UUIDs, so reads don't need a key.

## Images

Built from the repo root as the Docker context. Registry is the Vultr Container Registry (`<region>.vultrcr.com/<registry-name>/…`).

| Image | Dockerfile | Port |
|---|---|---|
| `ladybug-server` | `apps/server/Dockerfile` | 3001 |
| `ladybug-worker` | `apps/worker/Dockerfile` | none |
| `ladybug-web` | `apps/web/Dockerfile` (nginx; proxies `/api/` to the server) | 8080 |
| `ladybug-sandbox` | `apps/sandbox/Dockerfile` | 7000 |
| `ladybug-gateway` | `infra/gateway/Dockerfile` (mitmproxy + addon) | 8080 |

## Kubernetes names and labels

- Namespaces: `ladybug` (trusted), `sandbox` (untrusted).
- Pod labels (`app.kubernetes.io/name`): `server`, `worker`, `web`, `gateway` in `ladybug`; `ladybug-sandbox` on every sandbox pod in `sandbox`. Sandbox pods also carry `ladybug.dev/scan-id`.
- Gateway Service: `gateway.ladybug.svc.cluster.local:8080`. Sandbox pods have no DNS, so the worker resolves that name and passes the ClusterIP in `PROXY_URL`.
- Sandbox node pool: label `pool=sandbox`, taint `pool=sandbox:NoSchedule`.
- Worker ServiceAccount `worker`, with a Role in `sandbox` for pods: create, get, list, watch, delete.
- Secret `gateway-ca` in `ladybug`: `mitmproxy-ca.pem` (key + cert, gateway only) and `ca.crt` (public cert, given to the worker as `GATEWAY_CA_PEM`).
- Secret `ladybug-secrets` in `ladybug`: everything in the env tables below marked secret.
- Secret `registry-pull` (dockerconfigjson) in both namespaces; the worker passes it to sandbox pods as `SANDBOX_IMAGE_PULL_SECRET`.

## Environment variables

Shared by server and worker:

| Var | Secret | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres URL |
| `DATABASE_SSL` | | `true` for Vultr Managed Postgres |
| `REDIS_URL` | yes | Valkey URL (`rediss://` for managed Valkey) |
| `ARTIFACT_STORE` | | `s3` or `local` (default `local`) |
| `ARTIFACT_DIR` | | local store directory (default `.artifacts` at the repo root) |
| `S3_ENDPOINT` | | e.g. `https://sjc1.vultrobjects.com` |
| `S3_REGION` | | e.g. `us-east-1` (Vultr ignores it) |
| `S3_BUCKET` | | `ladybug-artifacts` |
| `S3_ACCESS_KEY_ID` | yes | |
| `S3_SECRET_ACCESS_KEY` | yes | |

Server only: `PORT` (3001), `API_KEYS` (comma-separated; unset disables auth), `RATE_LIMIT_PER_MINUTE` (default 10 per key), `TRUST_PROXY_HOPS` (reverse proxies in front; default 1, 2 on Kubernetes).

Worker only:

| Var | Secret | Meaning |
|---|---|---|
| `LLM_BASE_URL` | | OpenAI-compatible Chat Completions base URL, default `https://api.openai.com/v1` |
| `LLM_API_KEY` | yes | unset = signal-only reports |
| `LLM_MODEL` | | model name at that endpoint; unset = signal-only reports |
| `LLM_VISION` | | `false` for text-only models (screenshots aren't sent) |
| `LLM_REASONING_EFFORT` | | optional `reasoning_effort` for endpoints that support it |
| `LLM_TOKEN_BUDGET` | | stop investigating past this many tokens, default 400000 |
| `SANDBOX_PROVIDER` | | `docker` (default) or `k8s` |
| `SANDBOX_IMAGE` | | default `ladybug-sandbox:dev` |
| `SANDBOX_NAMESPACE` | | default `sandbox` |
| `SANDBOX_IMAGE_PULL_SECRET` | | k8s only |
| `GATEWAY_HOST` | | k8s: `gateway.ladybug.svc.cluster.local` |
| `GATEWAY_PROXY_URL` | | docker: optional explicit proxy URL |
| `GATEWAY_CA_PEM` | | public CA cert of the gateway |
| `SAFE_BROWSING_API_KEY` | yes | Google Safe Browsing v4 |
| `URLHAUS_AUTH_KEY` | yes | abuse.ch Auth-Key (URLhaus + MalwareBazaar) |
| `WORKER_CONCURRENCY` | | default 10 |

Web and desktop (Vite, build time): `VITE_SERVER_URL` (desktop default `http://localhost:3001` in dev, `PUBLIC_URL` when packaged; web default same origin, Vite dev proxies `/api`), `VITE_WEB_URL` (desktop, default `http://localhost:5175` in dev, `PUBLIC_URL` when packaged), `VITE_API_KEY` (desktop). The extension defaults to `http://localhost:3001` in `--mode development` builds and `PUBLIC_URL` otherwise.

`PUBLIC_URL` (in shared) is `https://ladybugg.garden`: on Kubernetes the `edge` Service (Caddy, automatic HTTPS) serves it, proxying to `web`, which forwards `/api/` to `server`. `SITE_DOMAIN` in `ladybug-config` sets the domain Caddy serves.
