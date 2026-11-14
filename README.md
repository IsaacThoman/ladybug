# ladybug

A desktop pet that lives on top of your screen.

## Layout

npm-workspaces monorepo:

| Path | What |
| --- | --- |
| `apps/desktop` | Electron + Vite + React app. A transparent, click-through window covers the whole primary display, and a 3D ladybug (three.js) walks around on top of it. |
| `apps/server` | Node + Express backend (TypeScript, run directly with Node's type stripping). |
| `packages/shared` | Types and constants shared by the server and the desktop app. |

## Getting started

Requires Node 22.18+.

```sh
npm install
npm run dev          # server + desktop together
```

Or run them individually:

```sh
npm run dev:server   # http://localhost:3001
npm run dev:desktop  # Vite dev server + Electron
```

Electron downloads its binary the first time the desktop app starts.

### Config

- `apps/server/.env`: `PORT` (default `3001`)
- `apps/desktop/.env`: `VITE_SERVER_URL` (default `http://localhost:3001`)

See the `.env.example` files.

## Using the pet

- It wanders along the bottom of the screen on its own.
- Click it to make it hop and say something (greeting comes from the server).
- Drag it around and throw it.
- Right-click it, or use the tray icon, to hide it or quit.

Everything else on the overlay is click-through, so it never gets in the way of the apps underneath.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Server and desktop in watch mode |
| `npm run build` | Typecheck and build every workspace |
| `npm run typecheck` | Typecheck every workspace |
| `npm run lint` | ESLint across the repo |
| `npm run dist -w @ladybug/desktop` | Package the desktop app with electron-builder |

The ladybug is built procedurally in `apps/desktop/src/components/ladybug/`: `ladybugModel.ts` is the model, `LadybugRenderer.ts` handles the camera, lighting and animation. The tray icon is still the Pulpo smiley placeholder.
