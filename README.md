# ladybugg

A desktop pet that lives on top of your screen and warns you about unsafe websites.

A browser extension reports every page you visit to the backend. The backend looks the URL up in Typesense:

- **Known safe:** nothing happens.
- **Known unsafe:** the ladybug raises an alert.
- **Unknown:** the ladybug says it's checking. The backend analyses the URL, remembers the verdict in Typesense, and the ladybug reports back. The analysis is a placeholder for now: it waits 30 seconds and runs a few naive URL heuristics.

Every request and decision is logged and can be browsed in the admin UI.

## Layout

npm-workspaces monorepo:

| Path | What |
| --- | --- |
| `apps/desktop` | Electron + Vite + React app. A transparent, click-through window covers the whole primary display, and a 3D ladybug (three.js) walks around on top of it. It listens to the server for alerts. |
| `apps/server` | Node + Express backend (TypeScript, run directly with Node's type stripping). Checks URLs, runs analyses, logs activity, serves the admin UI. |
| `apps/admin` | Vite + React admin UI: stats, live activity log, running analyses, and the URL database. |
| `apps/extension` | Chrome extension (Manifest V3) that reports each page you visit to the server. |
| `packages/shared` | Types and constants shared by all of the above. |
| `docker-compose.yml` | The backend stack: Typesense plus the server, with the admin UI built in. |

## Getting started

Requires Node 22.18+ and Docker.

```sh
npm install
```

### 1. Backend

Either run the whole backend in Docker:

```sh
docker compose up --build    # Typesense + server on http://localhost:3001
```

or run only Typesense in Docker and the server locally with hot reload:

```sh
npm run typesense            # Typesense on localhost:8108
npm run dev:server           # server on http://localhost:3001
```

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

To see it work, visit `https://example.com/` (nothing happens), the phishing test page above (the ladybug alerts), and any other site (the ladybug checks it, then reports back 30 seconds later).

### 4. Admin UI

- With docker compose: <http://localhost:3001/admin/>
- With `npm run dev:server`: `npm run dev:admin`, then <http://localhost:5174/admin/>. It proxies API calls to the server.

It has three tabs:

- **Overview:** stats, a "check a URL" box that runs the same pipeline as a visit, analyses in progress, recent detections and the latest activity.
- **Activity log:** every request, decision, analysis, pet alert and admin change. You can search and filter it, click a row for details, and new events appear live.
- **URL database:** known URLs and hosts, searched in Typesense. You can add rules, flip verdicts, or forget a record so it's analysed again.

`npm run dev` starts the server, desktop app, admin UI and extension watcher together. It still needs `npm run typesense`.

### Config

- `.env` (docker compose): `TYPESENSE_API_KEY`, `ANALYSIS_DELAY_MS`, `SERVER_PORT`, `SERVER_BIND`, `TYPESENSE_PORT`
- `apps/server/.env`: `PORT`, `TYPESENSE_URL`, `TYPESENSE_API_KEY`, `ANALYSIS_DELAY_MS`, `ADMIN_DIST`
- `apps/desktop/.env`: `VITE_SERVER_URL` (default `http://localhost:3001`)
- Extension: the server URL is set in its popup.

See the `.env.example` files. Nothing is authenticated yet, so docker compose only publishes the server and Typesense on localhost by default. Change `TYPESENSE_API_KEY` before exposing anything.

## How it works

```
browser ──POST /api/check──▶ server ──search──▶ Typesense (urls)
                               │
                               ├─ known safe ─────▶ (nothing)
                               ├─ known unsafe ───▶ pet alert
                               └─ unknown ────────▶ pet alert "checking…"
                                                    └─ analysis (placeholder, 30s)
                                                        └─ save verdict to Typesense ─▶ pet alert with the result

desktop pet ◀── GET /api/pet/stream (server-sent events)
admin UI    ◀── GET /api/admin/stream (server-sent events) + /api/admin/*
```

- URLs are normalised before lookup: http(s) only, no fragment or credentials. Local and private-network pages are skipped.
- A lookup is a single Typesense search for the exact URL plus host-wide records for the host and each parent domain. The most specific match wins.
- The same URL is never analysed twice at once.
- Every step is printed to the server's stdout and stored in a Typesense `events` collection, which is what the admin UI searches.
- To plug in the real check, replace `placeholderVerdict` and the delay in `apps/server/src/analyzer.ts`.

### API

| Endpoint | Used by |
| --- | --- |
| `POST /api/check` `{ url, title? }` | Extension |
| `GET /api/pet/stream` | Desktop pet (SSE, `alert` events) |
| `GET /api/admin/summary`, `/events`, `/urls`, `/stream` | Admin UI |
| `POST /api/admin/check`, `POST/PUT/DELETE /api/admin/urls` | Admin UI |
| `GET /health` | Everything |

## Using the pet

- It wanders along the bottom of the screen on its own.
- Click it to make it hop and say something (greeting comes from the server). Clicking also dismisses an alert.
- Drag it around and throw it.
- Right-click it, or use the tray icon, to hide it or quit.

Everything else on the overlay is click-through, so it never gets in the way of the apps underneath.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Server, windowed desktop, admin UI and extension in watch mode |
| `npm run dev:overlay` | All watchers, with the desktop overlay |
| `npm run dev:server` / `dev:desktop` / `dev:admin` / `dev:extension` | One of them |
| `npm run typesense` | Start Typesense in Docker |
| `docker compose up --build` | Whole backend in Docker |
| `npm run build` | Typecheck and build every workspace |
| `npm run typecheck` | Typecheck every workspace |
| `npm run lint` | ESLint across the repo |
| `npm run dist -w @ladybug/desktop` | Package the desktop app with electron-builder |

The ladybug is built procedurally in `apps/desktop/src/components/ladybug/`: `ladybugModel.ts` is the model, `LadybugRenderer.ts` handles the camera, lighting and animation. The tray icon is still the Pulpo smiley placeholder.
