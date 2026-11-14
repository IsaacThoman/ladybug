# Outbound FaceTime calls

Click the ladybug and select **Request help** to call the server's `EMERGENCY_NUMBER` using this computer's
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

The desktop token is a revocable credential for Ladybugg's call API, not a Chert
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
agent worker or requires `chert dev`; outbound calls go through Ladybugg's server.
Camera and microphone capture begins only when **Request help** is selected or a valid emergency-contact SUPPORT reply arrives.

```sh
npm test
npm run typecheck
npm run lint
npm run build -w @ladybug/desktop
```

With the server running and a recipient configured:

1. Click the ladybug and select **Request help**, grant device access, and answer on the recipient's phone.
2. Confirm the phone sees the computer's camera and hears its microphone after
   Chert reports `bridge_ready`.
3. Confirm Ladybugg plays the recipient's audio and displays available video.
4. Press **Hang up** and verify capture stops immediately. Wait for cleanup and repeat.
5. End the call on the phone and verify Ladybugg stops capture.
6. Disconnect the desktop from the server and verify local capture stops and
   the server ends the unattended call after its lease expires.

The renderer controller is `src/calls/controller.ts`, the desktop HTTP transport
is `electron/call-service.ts`, and the provider lifecycle lives in
`apps/server/src/calls/`.

## Risky-site alerts and remote support

Messaging and FaceTime share the server-only `CHERT_API_KEY` and `CHERT_LINE_ID`.
The key must have access to both messaging and FaceTime. Configure:

- `CHERT_API_KEY`: shared Chert bearer secret for messaging and FaceTime.
- `CHERT_TENANT_SLUG`: optional tenant slug for multi-tenant accounts.
- `CHERT_LINE_ID`: shared assigned sender line (used as `phone_line_id` for messaging).
- `CHERT_WEBHOOK_SECRET`: the webhook subscription secret, independent of the messaging key.
- `EMERGENCY_NUMBER`: the same E.164 destination used for FaceTime.

Use an iMessage-enabled line with automatic SMS fallback disabled. Register the
public HTTPS endpoint `https://<your-host>/api/support/chert/webhook` with Chert's
console or `POST /api/v1/webhook-subscriptions`, selecting
`events: ["message.received"]`. Store the subscription's signing secret in
`CHERT_WEBHOOK_SECRET`. Follow Chert's [send contract](https://docs.trychert.com/api/sending)
and [signed reply contract](https://docs.trychert.com/api/receiving-replies).
The receiver accepts modern `X-Webhook-Signature` and legacy `x-chert-signature`
headers and requires a signature timestamp within five minutes.

Browser visits to known unsafe sites and analyses finding unsafe sites queue:

> The user is accessing a website that might not be trustworthy: {url}. If you would like to initiate a FaceTime call for support, reply SUPPORT.

URLs have credentials and fragments removed. Admin checks and manual scans alone
do not message anyone. Redis reserves one notification per normalized hostname
per hour, including concurrent visits and server restarts. Subdomains have separate
limits. The durable outbox retries transient failures up to five times using the
same idempotency key. Chert currently cannot guarantee duplicate-free sends after
a lost response, even with that key. A saved provider failure can also prevent a
retry from making another attempt. Pending/duplicate responses do not open support
windows; only a confirmed `sent` result with a chat ID does. Messaging failures
are logged independently and do not block site checks or pet alerts.

A successful send opens a 30-minute support window for that chat and contact.
Only inbound one-to-one text equal to SUPPORT (ignoring case and surrounding
whitespace) can consume it. Both the message timestamp and webhook receipt must
fall inside the window. Events are deduplicated in Redis; each window is consumed
once. The most recently connected eligible desktop receives the request through
an authenticated main-process SSE connection. Offline requests are discarded;
reconnects have no backlog. Busy calls ignore additional requests. Keep one server
process per call line, as required by the existing call lifecycle.

Clicking the ladybug opens a menu above it with **Request help**, **Scan clipboard
URL**, and **View report** when available. Arrow keys and Tab move through items;
Escape closes the menu. Dragging and the right-click menu remain available.
The call panel appears during calls and offers **Hang up**; terminal status can
be dismissed. Media elements stay mounted for remote requests. First use may
prompt for permissions; permission failures appear in the panel without redial.

For Redis integration tests, use a dedicated disposable Redis/Valkey database:

```sh
TEST_REDIS_URL=redis://localhost:16379/15 npm test -w @ladybug/server
```

These tests clear that database. For acceptance with the configured test contact,
visit a known unsafe URL, verify the message, reply SUPPORT, and confirm exactly
one desktop starts one call. Check that a second reply, an expired reply, a reply
from another sender, and a reply while offline start no call. Verify menu placement
at all display edges, keyboard and outside-click dismissal, dragging/throwing,
link dropping, report access, overlay click-through, and permission failures.
