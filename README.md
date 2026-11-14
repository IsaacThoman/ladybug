# ladybugg

A desktop pet that lives on top of your screen and warns you about unsafe websites.

A browser extension reports every page you visit to the backend. The backend looks the URL up in Typesense:

- **Known safe:** nothing happens.
- **Known unsafe:** the ladybug raises an alert.
- **Unknown:** the ladybug says it's checking and sniffs around with its magnifying glass. The backend opens the URL in a disposable sandbox, where a scripted pass and an LLM agent investigate it, remembers the verdict in Typesense, and the ladybug reacts. Click it to open the full report.

You can also hand the pet a link directly: drop it on the bug, or use "Scan clipboard URL" in the tray menu.

Every request and decision is logged and can be browsed in the admin UI. Each sandbox scan also has a live report page.

## Layout

npm-workspaces monorepo:

| Path | What |
| --- | --- |
| `apps/desktop` | Electron + Vite + React app. A transparent, click-through window covers the whole primary display, and a 3D ladybug (three.js) walks around on top of it. It listens to the server for alerts. |
| `apps/server` | Node + Express backend (TypeScript, run directly with Node's type stripping). Checks URLs, runs analyses, logs activity, serves the admin UI. |
| `apps/admin` | Vite + React admin UI: stats, live activity log, running analyses, and the URL database. |
| `apps/extension` | Chrome extension (Manifest V3) that reports each page you visit to the server. |
| `apps/worker` | Scan worker: sandbox lifecycle, pre-scan lookups, scripted detonation, the LLM agent loop, scoring. |
| `apps/sandbox` | Sandbox image: headful Chrome on Xvfb plus an HTTP tool daemon the worker drives. |
| `apps/web` | Vite + React live scan report page, with a recorded demo at `/demo`. |
| `packages/shared` | Types and constants shared by all of the above. |
| `packages/backend` | Node-only helpers for the server and worker: Postgres, Valkey, the artifact store. |
| `infra/` | Vultr deployment: Terraform, kustomize manifests with NetworkPolicies, the mitmproxy egress gateway. See [`infra/README.md`](infra/README.md). |
| `docs/contracts.md` | Names, ports, labels and environment variables the pieces agree on. |
| `docker-compose.yml` | The backend stack: Typesense, Postgres, Valkey and the server, with the admin UI built in. |

## Getting started

Requires Node 22.18+ and Docker.

```sh
npm install
```

### 1. Backend

Build the sandbox image once (and again when `apps/sandbox` changes):

```sh
docker build -f apps/sandbox/Dockerfile -t ladybug-sandbox:dev .
```

The scan worker runs on your machine, because it starts sandbox containers on your local Docker. Configure its model endpoint, any OpenAI-compatible Chat Completions API with tool calling, then start it:

```sh
cp apps/worker/.env.example apps/worker/.env   # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm run dev:worker
```

Without `LLM_API_KEY` and `LLM_MODEL`, scans still run end to end and score from hard signals only; the report is flagged `llm_skipped`. To skip sandbox scans altogether and use the old URL heuristics, set `ANALYZER=placeholder` for the server.

Either run the whole backend in Docker:

```sh
docker compose up --build    # Typesense + server on http://localhost:3001
```

or run only the data services in Docker and the server locally with hot reload:

```sh
npm run services:up          # Typesense :8108, Postgres :5432, Valkey :6379
npm run dev:server           # server on http://localhost:3001
```

If those ports are taken, set `TYPESENSE_PORT`, `POSTGRES_PORT` or `VALKEY_PORT` and update the URLs in the `.env` files.

On startup the server creates its Typesense collections and seeds two examples:

| Seed | Verdict |
| --- | --- |
| `example.com` (whole host, including subdomains) | Safe |
| `https://testsafebrowsing.appspot.com/s/phishing.html` (Google's phishing test page) | Unsafe |

### 2. Desktop pet

```sh
npm run dev:desktop          # Vite dev server + Electron
```

Development mode uses an opaque, resizable window with normal title-bar controls.
The ladybug stays inside the window, including when you resize it. The window
accepts clicks normally and does not stay above other apps. Closing it quits Electron.

To develop with the full-screen, click-through overlay instead:

```sh
npm run dev:overlay          # all watchers, with the desktop overlay
npm run dev:desktop:overlay  # desktop overlay only
```

Packaged builds continue to use the desktop overlay.

Electron downloads its binary the first time the desktop app starts.

### 3. Browser extension

```sh
npm run build -w @ladybug/extension    # or `npm run dev:extension` to rebuild on change
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `apps/extension/dist`. Its popup shows whether it can reach the server and the last pages it reported, and lets you pause reporting or point it at another server. The toolbar badge shows `!` on unsafe pages and `…` while a page is being checked.

To see it work, visit `https://example.com/` (nothing happens), the phishing test page above (the ladybug alerts), and any other site (the ladybug checks it in the sandbox, then reports back, usually within a minute or two).

### 4. Admin UI

- With docker compose: <http://localhost:3001/admin/>
- With `npm run dev:server`: `npm run dev:admin`, then <http://localhost:5174/admin/>. It proxies API calls to the server.

It has three tabs:

- **Overview:** stats, a "check a URL" box that runs the same pipeline as a visit, analyses in progress, recent detections and the latest activity.
- **Activity log:** every request, decision, analysis, pet alert and admin change. You can search and filter it, click a row for details, and new events appear live.
- **URL database:** known URLs and hosts, searched in Typesense. You can add rules, flip verdicts, or forget a record so it's analysed again.

`npm run dev` starts the server, desktop app, admin UI and extension watcher together. It still needs `npm run typesense`.

### 5. Scan report page

```sh
npm run dev:web              # http://localhost:5175
```

Paste a URL to scan it, or open `/scans/<id>` (the pet's click goes there) to watch one live: screenshots, findings as the agent records them, the redirect chain, IOCs and the score. `/demo` replays a recorded phishing scan without a server, as a backup for demos.

To scan one URL without the queue, database or server, printing events as they happen and the report as JSON:

```sh
npm run scan -w @ladybug/worker -- https://example.com
```

### Config

- `.env` (docker compose): `TYPESENSE_API_KEY`, `ANALYSIS_DELAY_MS`, `SERVER_PORT`, `SERVER_BIND`, `TYPESENSE_PORT`
- `apps/server/.env`: `PORT`, `TYPESENSE_URL`, `TYPESENSE_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `ANALYZER`, `ANALYSIS_DELAY_MS`, `API_KEYS`, `ADMIN_DIST`
- `apps/worker/.env`: `DATABASE_URL`, `REDIS_URL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `SANDBOX_PROVIDER`, `SAFE_BROWSING_API_KEY`, `URLHAUS_AUTH_KEY`
- `apps/desktop/.env`: `VITE_SERVER_URL` (default `http://localhost:3001`), `VITE_WEB_URL` (default `http://localhost:5175`), `VITE_API_KEY`
- Extension: the server URL is set in its popup.

See the `.env.example` files, and [`docs/contracts.md`](docs/contracts.md) for every variable. Only starting scans can be authenticated (`API_KEYS`), so docker compose only publishes the server and Typesense on localhost by default. Change `TYPESENSE_API_KEY` before exposing anything.

## How it works

```
browser ──POST /api/check──▶ server ──search──▶ Typesense (urls)
                               │
                               ├─ known safe ─────▶ (nothing)
                               ├─ known unsafe ───▶ pet alert
                               └─ unknown ────────▶ pet alert "checking…" (with the scan id)
                                                    └─ sandbox scan (queue ▶ worker ▶ sandbox)
                                                        └─ save verdict to Typesense ─▶ pet alert with the result

desktop pet ◀── GET /api/pet/stream (server-sent events)
admin UI    ◀── GET /api/admin/stream (server-sent events) + /api/admin/*
```

- URLs are normalised before lookup: http(s) only, no fragment or credentials. Local and private-network pages are skipped.
- A lookup is a single Typesense search for the exact URL plus host-wide records for the host and each parent domain. The most specific match wins.
- The same URL is never analysed twice at once.
- Every step is printed to the server's stdout and stored in a Typesense `events` collection, which is what the admin UI searches.
- Benign scans are stored as safe; suspicious and malicious ones as unsafe, with the score and summary as the reason.

### Sandbox scans

`POST /api/scans` (or the analyzer) stores a scan in Postgres and queues it on Valkey. The worker moves it through `provisioning → detonating → investigating → scoring → done`, publishing every step to a Valkey Stream that the report page and the pet follow over SSE:

- **provisioning:** starts a sandbox (a Docker container locally, a bare Pod on Kubernetes) while running lookups that never touch the target: RDAP domain age, crt.sh certificate history, DNS and hosting ASN, Safe Browsing, URLhaus, and a punycode / homoglyph / brand look-alike check.
- **detonating:** a scripted baseline with no LLM. It loads the page, takes screenshots 0, 3 and 10 seconds after load, and captures the DOM, the network log (HAR), downloads and page behaviour (dialogs, clipboard writes, permission prompts, eval and decode calls). Then it reloads as a phone to catch cloaking.
- **investigating:** an LLM agent drives the sandboxed browser. It follows the flow a victim would with throwaway credentials, inspects downloads, and records findings as it goes, so they appear live. It finishes with a structured report.
- **scoring:** hard signals plus the agent's score give a final 0–100 and a verdict (under 30 benign, 30–69 suspicious, 70+ malicious). Weights live in `apps/worker/src/scoring/weights.ts`.

On Kubernetes, the sandbox's only route out is the mitmproxy gateway, which refuses internal addresses and tags each flow with its scan. The sandbox has no DNS, and NetworkPolicies enforce all of this. Locally, sandboxes have normal internet access with the daemon bound to 127.0.0.1.

### API

| Endpoint | Used by |
| --- | --- |
| `POST /api/check` `{ url, title? }` | Extension |
| `GET /api/pet/stream` | Desktop pet (SSE, `alert` events) |
| `POST /api/scans` `{ url }`, `GET /api/scans`, `GET /api/scans/:id` | Pet, report page |
| `GET /api/scans/:id/events` | Report page, pet (SSE, replays from the start) |
| `GET /api/scans/:id/artifacts/:key` | Report page (screenshots, HAR) |
| `GET /api/admin/summary`, `/events`, `/urls`, `/stream` | Admin UI |
| `POST /api/admin/check`, `POST/PUT/DELETE /api/admin/urls` | Admin UI |
| `GET /health` | Everything |

## Using the pet

- It wanders along the bottom of the screen on its own.
- Drop a link on it, or choose "Scan clipboard URL" from the tray or right-click menu, and it goes to investigate. When the scan finishes it reacts to the verdict: a happy wiggle, nervous, or alarmed.
- Click it during or after a scan to open the report. Otherwise, a click makes it hop and say something (greeting comes from the server). Clicking also dismisses an alert.
- Drag it around and throw it.
- Right-click it, or use the tray icon, to hide it or quit.

Everything else on the overlay is click-through, so it never gets in the way of the apps underneath.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Server, worker, report page, windowed desktop, admin UI and extension in watch mode |
| `npm run dev:overlay` | All watchers, with the desktop overlay |
| `npm run dev:server` / `dev:worker` / `dev:web` / `dev:desktop` / `dev:admin` / `dev:extension` | One of them |
| `npm run typesense` | Start Typesense in Docker |
| `npm run services:up` / `services:down` | Start Typesense, Postgres and Valkey in Docker / stop them |
| `npm run scan -w @ladybug/worker -- <url>` | One-off sandbox scan, report to stdout |
| `docker compose up --build` | Whole backend in Docker |
| `npm run build` | Typecheck and build every workspace |
| `npm run typecheck` | Typecheck every workspace |
| `npm test` | Unit tests (Node's test runner) |
| `npm run lint` | ESLint across the repo |
| `scripts/build-images.sh` | Build (and push) the container images for Vultr |
| `npm run dist -w @ladybug/desktop` | Package the desktop app with electron-builder |

The ladybug is built procedurally in `apps/desktop/src/components/ladybug/`: `ladybugModel.ts` is the model, `LadybugRenderer.ts` handles the camera, lighting and animation. The tray icon is still the Pulpo smiley placeholder.
