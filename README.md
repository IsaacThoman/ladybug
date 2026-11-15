# computerbug

A desktop pet that lives on top of your screen and warns you about unsafe websites.

A browser extension reports every page you visit to the backend, as you. The backend looks the URL up in Typesense:

- **Known safe:** nothing happens.
- **Known unsafe:** the ladybug raises an alert.
- **Unknown:** the ladybug says it's checking and sniffs around with its magnifying glass. The backend opens the URL in a disposable sandbox, where a scripted pass and an LLM agent investigate it, remembers the verdict in Typesense, and the ladybug reacts. Click it to open the full report.

You can also hand the pet a link directly: drop it on the bug, or use "Scan clipboard URL" in the tray menu.

Every request and decision is logged and can be browsed in the admin UI. Each sandbox scan also has a live report page.

People need an account, approved by an admin, before the extension reports their visits or their pet hears anything. See [Accounts](#accounts).

## Layout

npm-workspaces monorepo:

| Path | What |
| --- | --- |
| `apps/desktop` | Electron + Vite + React app. A transparent, click-through window covers the whole primary display, and a 3D ladybug (three.js) walks around on top of it. It listens to the server for alerts. |
| `apps/server` | Node + Express backend (TypeScript, run directly with Node's type stripping). Checks URLs, runs analyses, logs activity, serves the admin UI. |
| `apps/admin` | Vite + React admin UI: a sign-in page, stats, live activity log, running analyses, the URL database and account approvals, with the ladybug narrating from the sidebar. |
| `apps/extension` | Chrome extension (Manifest V3) that reports each page you visit to the server. |
| `apps/worker` | Scan worker: sandbox lifecycle, pre-scan lookups, scripted detonation, the LLM agent loop, scoring. |
| `apps/sandbox` | Sandbox image: headful Chrome on Xvfb plus an HTTP tool daemon the worker drives. |
| `apps/web` | Vite + React landing page and live scan report, with a recorded demo at `/demo`. |
| `packages/shared` | Types and constants shared by all of the above. |
| `packages/brain` | The fly brain: a spiking simulation of the fruit fly's nervous system, wired from the FlyEM male CNS connectome, that can drive the desktop pet. See [`packages/brain/README.md`](packages/brain/README.md). |
| `packages/mascot` | The 3D ladybug (three.js), used by the desktop pet, plus the garden look the web and admin pages share: colors, fonts, the ladybug on its leaf, the hills. |
| `packages/backend` | Node-only helpers for the server and worker: Postgres (with the TimescaleDB and pgvector parts, and community reports), Valkey, the artifact store. |
| `infra/` | Vultr deployment: Terraform, kustomize manifests with NetworkPolicies, the mitmproxy egress gateway. See [`infra/README.md`](infra/README.md). |
| `docs/contracts.md` | Names, ports, labels and environment variables the pieces agree on. |
| `compose.yaml`, `compose.local.yaml` | The whole backend as a deployable Compose stack (Coolify or any Docker host), and the local override that publishes ports. |

## Getting started

Requires Node 22.18+ and Docker.

```sh
npm install
```

### 1. Backend

Copy the compose settings first. To get real LLM scans, set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` in it; the model can be any OpenAI-compatible Chat Completions API with tool calling. `LLM_MODEL` is only the default: an admin can switch to any other model the endpoint offers on the admin UI's **Settings** tab.

```sh
cp .env.example .env
```

Without `LLM_API_KEY`, or with no model set or picked, scans still run end to end and score from hard signals only; the report is flagged `llm_skipped`. To skip sandbox scans altogether and use the old URL heuristics, set `ANALYZER=placeholder`.

Either run the whole backend in Docker. This is the same stack a deployment runs (see [Deploy](#deploy)), with ports published on localhost:

```sh
npm run stack:up             # report page on http://localhost:8080, server on http://localhost:3001
npm run stack:down
```

Or run only the data services in Docker, and the server and worker on your machine with hot reload. The worker then starts sandbox containers on your local Docker, so build the sandbox image once (and again when `apps/sandbox` changes):

```sh
docker build -f apps/sandbox/Dockerfile -t ladybug-sandbox:dev .
cp apps/worker/.env.example apps/worker/.env   # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm run services:up          # Typesense :8108, Postgres (TimescaleDB) :5432, Valkey :6379
npm run dev:server           # server on http://localhost:3001
npm run dev:worker
```

If those ports are taken, change `TYPESENSE_PORT`, `POSTGRES_PORT`, `VALKEY_PORT`, `SERVER_PORT` or `WEB_PORT` in `.env`, and update the URLs in the apps' `.env` files.

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

Until you sign in, a sign-in panel sits in the top-left corner of the overlay (or the development window). Create an account there or sign in; it stays up with a "waiting for approval" note until an admin approves you, then gets out of the way. "Account…" in the tray or right-click menu brings it back.

### 3. Browser extension

```sh
npm run dev:extension                  # rebuilds on change, reports to http://localhost:3001
npm run build -w @ladybug/extension    # release build, reports to https://computerbug.garden
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `apps/extension/dist`. A server URL saved in the popup overrides the build's default. Sign in (or create an account) in its popup: nothing is reported until you do, and nothing is checked until an admin approves the account. The popup also shows whether it can reach the server and the last pages it reported, and lets you pause reporting or point it at another server (which signs you out). The toolbar badge shows `!` on unsafe pages, `…` while a page is being checked, and `?` when it can't check (signed out, waiting for approval, or the server is unreachable).

To see it work, visit `https://example.com/` (nothing happens), the phishing test page above (the ladybug alerts), and any other site (the ladybug checks it in the sandbox, then reports back, usually within a minute or two).

### 4. Admin UI

- With `npm run stack:up`: <http://localhost:8080/admin/>, or the server directly at <http://localhost:3001/admin/>. If `ADMIN_PASSWORD` is set, it opens on a sign-in page that asks for it. Scripts can still use HTTP Basic (`curl -u :password`).
- With `npm run dev:server`: `npm run dev:admin`, then <http://localhost:5174/admin/>. It proxies API calls to the server.

It has five tabs:

- **Overview:** stats, a chart of visits checked over the last hour, day or week (from TimescaleDB, see [Postgres and Tiger Data](#postgres-and-tiger-data)), a "check a URL" box that runs the same pipeline as a visit, analyses in progress, recent detections and the latest activity.
- **Activity log:** every request, decision, analysis, pet alert and admin change. You can search and filter it, click a row for details, and new events appear live.
- **URL database:** known URLs and hosts, searched in Typesense. You can add rules, flip verdicts, or forget a record so it's analysed again.
- **Users:** sign-ups waiting for approval (the tab shows how many), and every account with when it was last seen and how many devices are signed in. Approve or turn down requests, revoke access, or delete an account.
- **Settings:** the model scans investigate with. The worker lists the models its endpoint offers (`GET /models`, minus embedding, speech, image and moderation models) every 5 minutes and publishes them to Valkey, since only it holds `LLM_API_KEY`. The pick is stored in Postgres and the next scan uses it; **Default** goes back to the worker's `LLM_MODEL`.

`npm run dev` starts the server, worker, report page, desktop app, admin UI and extension watcher together. It still needs `npm run services:up`.

### 5. Scan report page

```sh
npm run dev:web              # http://localhost:5175
```

Paste a URL to scan it. If you're signed out, Scan takes you to the sign-in page first and carries on with the link afterwards. Your recent scans are listed below. Or open `/scans/<id>` (the pet's click goes there) to watch one live: screenshots, findings as the agent records them, the redirect chain, IOCs, the score, and earlier flagged scans of near-identical pages. `/demo` replays a recorded phishing scan without a server, as a backup for demos.

To scan one URL without the queue, database or server, printing events as they happen and the report as JSON:

```sh
npm run scan -w @ladybug/worker -- https://example.com
```

### Config

- `.env` (Compose): `POSTGRES_PASSWORD` and `TYPESENSE_API_KEY` (required), `DATABASE_URL` (to use Tiger Cloud), `ADMIN_PASSWORD`, `API_KEYS`, `LLM_*`, `WORKER_CONCURRENCY`, and the local ports
- `apps/server/.env`: `PORT`, `TYPESENSE_URL`, `TYPESENSE_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `ANALYZER`, `ANALYSIS_DELAY_MS`, `API_KEYS`, `ADMIN_PASSWORD`, `ADMIN_DIST`, and optionally `SOLANA_*` (see [Community reports](#community-reports))
- `apps/worker/.env`: `DATABASE_URL`, `REDIS_URL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `SANDBOX_PROVIDER`, `SAFE_BROWSING_API_KEY`, `URLHAUS_AUTH_KEY`
- `apps/desktop/.env`: `VITE_SERVER_URL`, `VITE_WEB_URL`, and optionally `VITE_API_KEY`. In `npm run dev` the pet uses `http://localhost:3001` and `http://localhost:5175`; packaged builds use the hosted `https://computerbug.garden` for both.
- Extension: release builds report to `https://computerbug.garden`, and `npm run dev:extension` builds report to `http://localhost:3001`. Either can be changed in its popup.

See the `.env.example` files, and [`docs/contracts.md`](docs/contracts.md) for every variable. `compose.local.yaml` only publishes ports on localhost. Before exposing anything, set strong `POSTGRES_PASSWORD`, `TYPESENSE_API_KEY` and `ADMIN_PASSWORD`. Reporting visits, starting scans and pet alerts need an approved account (or, for scans, a key from `API_KEYS`); reading a report only needs its link.

## Accounts

Accounts are a username and a password, stored in Postgres (`users`, and one `sessions` row per signed-in device; only scrypt hashes of the passwords and SHA-256 hashes of the tokens are kept).

- Anyone can sign up from the extension popup, the pet's sign-in panel or the website's sign-in page (`/signin`, the **Sign in** button at the top). New accounts are **pending**: they can sign in, but the server refuses their visits, scans and pet stream with `403` until an admin approves them on the admin UI's **Users** tab. Clients notice on their own when that happens.
- Each user's visits alert only their own pets. If two users visit the same unknown URL while it's being analysed, there is still one analysis, and both pets hear the result. The URL database is shared: a page one user's visit flagged is known unsafe for everyone.
- "Check a URL" in the admin UI alerts every pet, as before.
- Turning an account down, revoking it or deleting it disconnects its pets at once.
- Sign-up and sign-in are limited to 10 attempts per minute per client IP.
- The admin UI itself has no accounts: it is protected by `ADMIN_PASSWORD`.

## How it works

```
browser ──POST /api/check (as a user)──▶ server ──search──▶ Typesense (urls)
                               │
                               ├─ known safe ─────▶ (nothing)
                               ├─ known unsafe ───▶ pet alert (that user's pets)
                               └─ unknown ────────▶ pet alert "checking…" (with the scan id)
                                                    └─ sandbox scan (queue ▶ worker ▶ sandbox)
                                                        └─ save verdict to Typesense ─▶ pet alert with the result

desktop pet ◀── GET /api/pet/stream (server-sent events, the signed-in user's alerts)
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

Right after the scripted pass, the worker fingerprints the page and looks for earlier flagged pages like it (see below). A match is a hard signal, goes to the agent as context, and is named in the pet's alert: "It's a 93% match for a page I flagged on …".

### Postgres and Tiger Data

Postgres is [TimescaleDB](https://github.com/timescale/timescaledb) with [pgvector](https://github.com/pgvector/pgvector), the same Postgres that [Tiger Cloud](https://www.tigerdata.com/cloud) runs. Compose starts it from the `timescale/timescaledb` image; or point `DATABASE_URL` at a Tiger Cloud service. Besides the `scans` table, it holds:

- **Visit history** (TimescaleDB). Every check the server decides (known safe, known unsafe, unknown) is a row in the `url_checks` hypertable, in 1-day chunks, compressed after 7 days and dropped after 90. The continuous aggregate `url_checks_5m` keeps 5-minute counts per decision. It's real-time, so rows newer than the last refresh still show up. The admin chart reads it with `time_bucket_gapfill`, re-bucketed per range: 5 minutes for the last hour, hourly for a day, 6-hourly for a week.
- **Page fingerprints** (pgvector). Each finished scan stores a 512-dimension vector of its page in `page_fingerprints`: its words and word pairs (title weighted double) and its form fields, hashed into fixed slots and normalised. Phishing kits are copied verbatim from domain to domain, so a re-hosted kit lands right next to the original. A new scan asks the HNSW index for the nearest suspicious or malicious pages, and a cosine similarity of 0.85 or more counts as a match (`THRESHOLDS.similarPage`). Pages with fewer than 20 distinct words get no fingerprint, so blank and error pages don't match each other. No embedding model or API key is involved.

The server and worker create all of this on startup. If an extension is missing (plain Postgres, or a managed Postgres without it), they log a warning and run without that feature: no chart, or no similarity check. Scans work either way.

**Tiger Cloud.** Create a service (the free plan has both extensions), copy its connection string, and set it as `DATABASE_URL`, `?sslmode=require` included, in `.env` or Coolify. The stack's own `postgres` service still starts, but sits idle. The same `DATABASE_URL` works for `npm run dev:server` and `dev:worker` without Docker.

Switching an existing deployment from `postgres:17-alpine` to the TimescaleDB image keeps its data: both use the same data directory and user, and the compose file preloads TimescaleDB itself.

On Kubernetes, the sandbox's only route out is the mitmproxy gateway, which refuses internal addresses and tags each flow with its scan. The sandbox has no DNS, and NetworkPolicies enforce all of this. Locally, sandboxes have normal internet access with the daemon bound to 127.0.0.1.

### Community reports

Signed-in people can report a site as safe or unsafe, one vote per account per host, changeable. Votes are kept in Postgres (`site_reports`; deleting an account deletes its votes, and rejected accounts stop counting). They never flip a verdict on their own:

- The extension, the blocked page and the report page show the tally next to the verdict (`GET /api/reports?url=…`).
- The admin UI's URL database marks a host for review when the majority disagrees with its stored verdict, or when there's no verdict yet and someone said unsafe.
- Three or more "unsafe" reports from different accounts are one hard signal in the scan score (`community_reports`, `COMMUNITY_SIGNAL_MIN_REPORTS`).

With `SOLANA_RPC_URL`, `SOLANA_PROGRAM_ID`, `SOLANA_AUTHORITY_KEY` and `SOLANA_REPORTER_SECRET` set, the server also writes every vote and every sandbox verdict to the `computerbug_verdicts` program on-chain, so the tallies can be checked without trusting our database. The server co-signs each vote with a key derived for that account and pays the fees, so nobody needs a wallet or SOL. On startup it creates the program's config if it's missing (its key must be the program's upgrade authority). Writes happen in the background: a vote is `pending` until its transaction confirms, then `confirmed` with a signature and an Explorer link, or `failed`. Tallies come from the chain once nothing for that host is pending, and from Postgres otherwise or when the RPC is down. A scan's on-chain `report_hash` is SHA-256 of the report JSON as `GET /api/scans/:id` returns it. Unset, reports work the same in Postgres only. See [`docs/solana.md`](docs/solana.md) for the program and every variable.

### API

| Endpoint | Used by |
| --- | --- |
| `POST /api/auth/signup`, `/login` `{ username, password, client? }`, `POST /api/auth/logout`, `GET /api/auth/me` | Extension, pet, report page |
| `POST /api/check` `{ url, title? }` | Extension (approved account) |
| `GET /api/pet/stream` | Desktop pet (SSE, `alert` events; approved account) |
| `POST /api/scans` `{ url }`, `GET /api/scans` (your own) | Pet, report page (approved account, or an `API_KEYS` key to start scans) |
| `GET /api/scans/:id` | Pet, report page |
| `GET /api/scans/:id/events` | Report page, pet (SSE, replays from the start) |
| `GET /api/scans/:id/artifacts/:key` | Report page (screenshots, HAR) |
| `GET /api/reports?url=` (anyone; your own vote when signed in), `POST /api/reports` `{ url, verdict }` | Extension, blocked page, report page (approved account to vote) |
| `GET /api/admin/summary`, `/events`, `/urls`, `/stream`, `/timeline?range=1h\|24h\|7d` | Admin UI |
| `POST /api/admin/check`, `POST/PUT/DELETE /api/admin/urls` | Admin UI |
| `GET /api/admin/users`, `POST /api/admin/users/:id/approve\|reject`, `DELETE /api/admin/users/:id` | Admin UI |
| `GET /api/admin/reports?limit=50` | Admin UI (reported hosts, flagged for review) |
| `GET/PUT /api/admin/settings/model` | Admin UI |
| `GET /health` | Everything |

## Deploy

### Coolify (or any Docker host)

`compose.yaml` is the whole backend: report page, server, worker, egress gateway, Typesense, Postgres and Valkey. It publishes no host ports.

1. Create a Git-based application in Coolify with the **Docker Compose** build pack, using `compose.yaml` at the repository root. Don't add `compose.local.yaml`.
2. Set environment variables:
   - `POSTGRES_PASSWORD` and `TYPESENSE_API_KEY` (required: strong, URL-safe values)
   - `ADMIN_PASSWORD`, to protect `/admin`, where accounts are approved
   - `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`
   - optionally `DATABASE_URL` (a Tiger Cloud service instead of the bundled Postgres), `API_KEYS`, `SAFE_BROWSING_API_KEY`, `URLHAUS_AUTH_KEY` and `WORKER_CONCURRENCY`

   `.env.example` lists them all.
3. Give service **`web`** the domain, on internal port `8080`: for example `https://computerbug.garden:8080`. Traefik routes it, and `web` proxies `/api`, `/admin` and `/health` to the server. Don't give any other service a domain.
4. Deploy. The first build takes a while: it also builds the sandbox image (service `sandbox-image`, which only holds the image and sleeps).

Things to know:

- **Docker socket.** The worker mounts `/var/run/docker.sock` to start one sandbox container per scan, which is root-equivalent on the host. Sandboxes join only the internal `ladybug-sandboxes` network (rename it with `SANDBOX_NETWORK`). Their only way out is the gateway, which refuses private and link-local addresses, so they can't reach the other containers, the host's private networks or cloud metadata. They can still reach anything public, including services on the host's own public IP.
- **Sizing.** Each scan's sandbox can use up to 2 CPUs and 3 GB of RAM, so set `WORKER_CONCURRENCY` (default 2) to fit the server.
- **Artifacts.** Screenshots and HAR files live on the `artifacts` volume. To use Object Storage instead, set `ARTIFACT_STORE=s3` and the `S3_*` variables.
- **Cloudflare Tunnel.** Point the tunnel at Coolify's proxy, and set the `web` domain as `http://computerbug.garden:8080` (http, so Traefik doesn't try to get its own certificate behind Cloudflare). Set `CLIENT_IP_HEADER=cf-connecting-ip` so rate limits see visitors' real IPs. Only do that if the tunnel is the only way in, or clients could spoof the header. Live updates use server-sent events with regular heartbeats, so they stay open through Cloudflare.
- **Proxy hops.** Without the tunnel, `TRUST_PROXY_HOPS=2` (the default here) covers Traefik, then web's nginx.
- **Kubernetes.** The Vultr Kubernetes setup is an alternative: see [`infra/README.md`](infra/README.md). It can also take over just the sandboxes, with autoscaling, while everything else stays on this stack: see ["Sandboxes only"](infra/README.md#sandboxes-only).

## Using the pet

- It wanders along the bottom of the screen on its own.
- Drop a link on it, or choose "Scan clipboard URL" from the tray or right-click menu, and it goes to investigate. When the scan finishes it reacts to the verdict: a happy wiggle, nervous, or alarmed.
- Click it during or after a scan to open the report. Otherwise, a click makes it hop and say something (greeting comes from the server). Clicking also dismisses an alert. While you're signed out or waiting for approval, a click brings up the sign-in panel instead.
- Drag it around and throw it.
- Right-click it, or use the tray icon, to hide it, open "Account…" (sign in or out) or quit.

Everything else on the overlay is click-through, so it never gets in the way of the apps underneath.

### Fly brain

The pet can be driven by a simulated fly brain: a spiking model of the fruit fly's whole central nervous system, 166,700 neurons wired as they are in the real animal ([FlyEM male CNS connectome](https://male-cns.janelia.org/), Janelia Research Campus, CC-BY 4.0). It's off by default.

```sh
npm run brain:fetch          # download the packed connectome (21 MB), once
```

Then check **Fly Brain** in the tray or right-click menu. **Show Brain Activity** opens a small panel with what the brain is doing.

- It wanders in bouts and turns around when the brain says so, instead of picking random spots.
- Swat at it with the cursor and it takes off: the looming detectors in its eyes fire the giant fiber, as in a real fly. Reaching over to click it doesn't.
- Throw it and it wipes its face when it lands: wind on the antennae sets off grooming.
- Everything the pet does for its job (scans, warnings, reactions, bedtime) still comes first.

The brain uses about a tenth of one CPU core on a recent laptop while the pet is awake. [`packages/brain/README.md`](packages/brain/README.md) covers the model, what it does and doesn't reproduce, and the data; [`apps/desktop/FLYBRAIN.md`](apps/desktop/FLYBRAIN.md) covers how the pet's senses and actions map onto it.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Server, worker, report page, windowed desktop, admin UI and extension in watch mode |
| `npm run dev:overlay` | All watchers, with the desktop overlay |
| `npm run dev:server` / `dev:worker` / `dev:web` / `dev:desktop` / `dev:admin` / `dev:extension` | One of them |
| `npm run typesense` | Start Typesense in Docker |
| `npm run services:up` / `services:down` | Start Typesense, Postgres (TimescaleDB) and Valkey in Docker / stop them |
| `npm run stack:up` / `stack:down` | The whole backend in Docker, ports on localhost |
| `npm run scan -w @ladybug/worker -- <url>` | One-off sandbox scan, report to stdout |
| `npm run brain:fetch` / `brain:pack` | Download the packed fly connectome / pack it from the CSV export |
| `npm run build` | Typecheck and build every workspace |
| `npm run typecheck` | Typecheck every workspace |
| `npm test` | Unit tests (Node's test runner) |
| `npm run lint` | ESLint across the repo |
| `scripts/build-images.sh` | Build (and push) the container images for Vultr |
| `npm run dist -w @ladybug/desktop` | Package the desktop app with electron-builder |

The ladybug is built procedurally in `packages/mascot/src/`: `ladybugModel.ts` is the model, `LadybugRenderer.ts` handles the camera, lighting and animation, and `LadybugMascot.tsx` puts it on a web page. The tray icon is still the Pulpo smiley placeholder.
