# Contracts between components

The source of truth is `packages/shared/src/scan.ts` (scan, event, report and HTTP API types) and `packages/shared/src/sandbox.ts` (the sandbox daemon API). This file covers what types can't: names, ports, labels and environment variables.

## Code conventions

- TypeScript everywhere, ESM, run directly by Node 22.18+ type stripping (no build step for Node apps). That means `erasableSyntaxOnly`: no `enum`, no constructor parameter properties, no namespaces. Relative imports carry the `.ts` extension.
- Vite + React for `apps/web` and `apps/desktop`.
- 2-space indent, double quotes, semicolons, sparse comments.

## HTTP API (apps/server, port 3001)

| Route | Auth | Returns |
|---|---|---|
| `POST /api/auth/signup`, `/login` `{username, password, client?}` | none (10 per minute per IP) | `AuthResponse` (201 / 200) |
| `POST /api/auth/logout` | bearer | 204 |
| `GET /api/auth/me` | bearer, any status | `MeResponse` |
| `POST /api/check {url, title?}` | approved account | `CheckResponse` |
| `GET /api/pet/stream` | approved account | SSE, `alert` events for this user |
| `POST /api/scans {url}` | approved account, or `x-api-key` from `API_KEYS` | `202 CreateScanResponse` |
| `GET /api/scans?limit=20` | approved account | `ScanListResponse`, this user's scans |
| `GET /api/scans/:id` | none | `ScanResponse` |
| `GET /api/scans/:id/events` | none | SSE, see `eventsPath` in shared |
| `GET /api/scans/:id/artifacts/:key` | none | 302 to a presigned URL (or the file in local dev), see `artifactPath` |
| `GET /api/admin/session` | none | `AdminSession` |
| `POST /api/admin/login {password}` | none, 10 wrong tries per 15 min | `204`, sets the `ladybug_admin` cookie |
| `POST /api/admin/logout` | none | `204`, clears the cookie |
| `GET /api/admin/timeline?range=1h\|24h\|7d` | admin | `CheckTimeline` |
| `GET /api/admin/users` | admin | `AdminAccountsResponse` |
| `POST /api/admin/users/:id/approve`, `/reject`, `DELETE /api/admin/users/:id` | admin | `Account` / 204 |
| `PUT /api/admin/users/:id/calls` `AdminCallsRequest` | admin | `Account` |
| `GET /api/calls/state`, `POST /api/calls/prepare`, `/:id/dial`, `/:id/end` | approved account with calls on | see `packages/shared/src/calls.ts` |
| `GET /api/calls/support/stream` | approved account with calls on | SSE, `support` events |

"Approved account" means `Authorization: Bearer <token>`, the token from sign-in, for a user an admin approved (see `packages/shared/src/accounts.ts`). Refusals carry `ApiError.code`: 401 `signed_out`, 403 `pending` or `rejected`. Call routes also refuse with a plain 403 until an admin turns calls on for the account. "Admin" is the `ladybug_admin` cookie from `POST /api/admin/login`, or HTTP Basic auth with `ADMIN_PASSWORD`.

Errors are `ApiError` JSON with 400/401/403/404/409/429. Scan ids are UUIDs, so reads don't need a key.

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
- Sandboxes-only clusters (`bootstrap.sh --sandbox-only`) have no `worker`. ServiceAccount `remote-worker` is for a worker outside the cluster (pods and `pods/proxy` in `sandbox`), and `deployer` is for the deploy workflow (Deployments in `ladybug`). ConfigMap `sandbox-env` in `sandbox` gives the pods `PROXY_URL` and `GATEWAY_CA_PEM`.
- Secret `gateway-ca` in `ladybug`: `mitmproxy-ca.pem` (key + cert, gateway only) and `ca.crt` (public cert, given to the worker as `GATEWAY_CA_PEM`).
- Secret `ladybug-secrets` in `ladybug`: everything in the env tables below marked secret.
- Secret `registry-pull` (dockerconfigjson) in both namespaces; the worker passes it to sandbox pods as `SANDBOX_IMAGE_PULL_SECRET`.

## Environment variables

Shared by server and worker:

| Var | Secret | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres URL. In Compose, unset = the bundled TimescaleDB; a Tiger Cloud service URL (with `?sslmode=require`) works as is |
| `DATABASE_SSL` | | `true` for Vultr Managed Postgres |

Postgres extensions: `timescaledb` (the `url_checks` hypertable and `url_checks_5m` continuous aggregate) and `vector` (`page_fingerprints`). Both are optional: without one, its feature is off and everything else works.
| `REDIS_URL` | yes | Valkey URL (`rediss://` for managed Valkey) |
| `ARTIFACT_STORE` | | `s3` or `local` (default `local`) |
| `ARTIFACT_DIR` | | local store directory (default `.artifacts` at the repo root) |
| `S3_ENDPOINT` | | e.g. `https://sjc1.vultrobjects.com` |
| `S3_REGION` | | e.g. `us-east-1` (Vultr ignores it) |
| `S3_BUCKET` | | `ladybug-artifacts` |
| `S3_ACCESS_KEY_ID` | yes | |
| `S3_SECRET_ACCESS_KEY` | yes | |

Server only: `PORT` (3001), `API_KEYS` (comma-separated keys that may start scans without an account, for scripts; optional), `RATE_LIMIT_PER_MINUTE` (scans per minute per account or key, default 10), `TRUST_PROXY_HOPS` (reverse proxies in front; default 1, 2 on Kubernetes and in `compose.yaml`), `CLIENT_IP_HEADER` (trusted header with the client IP, e.g. `cf-connecting-ip` behind a Cloudflare Tunnel), `ADMIN_PASSWORD` (the admin sign-in page's password, where accounts are approved; `/api/admin` then wants the session cookie from `POST /api/admin/login`, or HTTP Basic with any username for scripts; unset = open).

Worker only:

| Var | Secret | Meaning |
|---|---|---|
| `LLM_BASE_URL` | | OpenAI-compatible Chat Completions base URL, default `https://api.openai.com/v1` |
| `LLM_API_KEY` | yes | unset = signal-only reports |
| `LLM_MODEL` | | default model name at that endpoint, until an admin picks one in the admin UI; neither = signal-only reports |
| `LLM_VISION` | | `false` for text-only models (screenshots aren't sent) |
| `LLM_REASONING_EFFORT` | | optional `reasoning_effort` for endpoints that support it |
| `LLM_TOKEN_BUDGET` | | stop investigating past this many tokens, default 400000 |
| `SANDBOX_PROVIDER` | | `docker` (default) or `k8s` |
| `SANDBOX_IMAGE` | | default `ladybug-sandbox:dev` |
| `SANDBOX_NAMESPACE` | | default `sandbox` |
| `SANDBOX_IMAGE_PULL_SECRET` | | k8s only |
| `SANDBOX_KUBECONFIG_B64` | yes | k8s, worker outside the cluster: a base64 kubeconfig. Sandboxes are then reached through the API server's pod proxy |
| `SANDBOX_ENV_CONFIGMAP` | | k8s: a ConfigMap in the sandbox namespace that gives pods the gateway address and CA, instead of `GATEWAY_*` |
| `SANDBOX_START_TIMEOUT_MS` | | k8s: how long a pod may take to be ready, default 360000 (covers a node scaling up) |
| `GATEWAY_HOST` | | k8s: `gateway.ladybug.svc.cluster.local` |
| `GATEWAY_PROXY_URL` | | docker: optional explicit proxy URL |
| `GATEWAY_CA_PEM` | | public CA cert of the gateway |
| `GATEWAY_CA_FILE` | | or a file holding it (compose: the gateway's shared volume) |
| `SANDBOX_DOCKER_NETWORK` | | docker provider: run sandboxes on this network and reach them by IP (compose: `ladybug-sandboxes`, `internal`) |
| `SAFE_BROWSING_API_KEY` | yes | Google Safe Browsing v4 |
| `URLHAUS_AUTH_KEY` | yes | abuse.ch Auth-Key (URLhaus + MalwareBazaar) |
| `WORKER_CONCURRENCY` | | default 10 |

Web and desktop (Vite, build time): `VITE_SERVER_URL` (desktop default `http://localhost:3001` in dev, `PUBLIC_URL` when packaged; web default same origin, Vite dev proxies `/api`), `VITE_WEB_URL` (desktop, default `http://localhost:5175` in dev, `PUBLIC_URL` when packaged), `VITE_API_KEY` (desktop, optional: sent as `x-api-key` with scans as well as the account token). The extension defaults to `http://localhost:3001` in `--mode development` builds and `PUBLIC_URL` otherwise.

`PUBLIC_URL` (in shared) is `https://computerbug.garden`: on Kubernetes the `edge` Service (Caddy, automatic HTTPS) serves it, proxying to `web`, which forwards `/api/` to `server`. `SITE_DOMAIN` in `ladybug-config` sets the domain Caddy serves.
