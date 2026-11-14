# Outbound FaceTime calls

Press **facetime** to call the server's `EMERGENCY_NUMBER` using this computer's
camera and microphone. **Hang up** stops local capture immediately and asks the
server to end the call. No AI model or model-provider API key is needed.

## Credentials and environment

Provider credentials belong only in `apps/server/.env`:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` from one LiveKit project.
- `CHERT_API_KEY` with `facetime:read` and `facetime:write` access.
- `CHERT_PROJECT_ID` and its assigned `CHERT_LINE_ID`.
- `EMERGENCY_NUMBER` in international format, including `+` and country code.
- `CALL_CLIENT_KEYS`: comma-separated, randomly generated access tokens, one per desktop installation.

The desktop's `apps/desktop/.env` contains only its server connection settings:

```dotenv
CALL_SERVER_URL=http://localhost:3001
CALL_SERVER_TOKEN=<this installation's token from CALL_CLIENT_KEYS>
```

The desktop token is a revocable credential for Ladybug's call API, not a Chert
or LiveKit key. Supply it privately per installation in Electron's user-data
`.env` for packaged apps. Do not embed a shared token into a distributed app or
prefix it with `VITE_`. Remote call servers must use HTTPS; HTTP is allowed only
on loopback for local development. Real `.env` files are ignored by Git and
excluded from packaged assets. Environment variables override file settings.

For Compose hosting, set the provider variables and `CALL_CLIENT_KEYS` in the
root deployment environment (or the host's secret settings); `compose.yaml`
passes them only to the server. The local values in `apps/server/.env` are not
uploaded or deployed automatically. Deployments require approval.

## Call flow

The desktop requests a call from `/api/calls/prepare` using its private access
token. The server authenticates it, creates the LiveKit room, and returns a
five-minute, room-scoped participant token. The desktop joins the room and
publishes its camera and microphone, then asks the server to dial. The server
waits up to five seconds for LiveKit to confirm both tracks and places the
outbound Chert call to its configured destination. The desktop cannot choose
another phone number, project, line, room, or bridge token.

Provider API calls, token signing, status polling, retries, and room cleanup
all run on the server. Only the assigned room token and safe call status reach
the renderer. Microphone samples stay silent until Chert reports `bridge_ready`.

Every call endpoint requires a dedicated desktop token, even during local
use. Call state and operations are isolated between installation tokens. The
server accepts one call at a time for its configured line, rate limits new
attempts, and deduplicates repeated prepare requests. The desktop checks status
every second; if it disconnects, it stops capture and retries hang-up. The server
also ends sessions after 30 seconds without authenticated client check-ins.

Call state is held in memory: run one server process/replica per configured
line. Planned shutdown attempts call cleanup, but a hard server crash cannot
recover active calls automatically. Multi-replica operation and durable crash
recovery require a shared session store. LiveKit and Chert usage may incur
provider charges; this adapter makes no model API requests.

## Development and verification

Start the normal backend dependencies with `npm run services:up` if needed.
Use `npm run dev:overlay` for overlay mode or `npm run dev` for an explicitly
requested development window. The desktop no longer runs a privileged inbound
agent worker or requires `chert dev`; outbound calls go through Ladybug's server.
Camera and microphone capture begins only when **facetime** is pressed.

```sh
npm test
npm run typecheck
npm run lint
npm run build -w @ladybug/desktop
```

With the server running and a recipient configured:

1. Press **facetime**, grant device access, and answer on the recipient's phone.
2. Confirm the phone sees the computer's camera and hears its microphone after
   Chert reports `bridge_ready`.
3. Confirm Ladybug plays the recipient's audio and displays available video.
4. Press **Hang up** and verify capture stops immediately. Wait for cleanup and repeat.
5. End the call on the phone and verify Ladybug stops capture.
6. Disconnect the desktop from the server and verify local capture stops and
   the server ends the unattended call after its lease expires.

The renderer controller is `src/calls/controller.ts`, the desktop HTTP transport
is `electron/call-service.ts`, and the provider lifecycle lives in
`apps/server/src/calls/`.
