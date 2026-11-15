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

The desktop needs no call settings of its own. It calls as the Ladybugg account
it is signed in to, on the same server. The account must be approved, and an
admin has to turn on calls for it under **Users** in the admin UI. Calls are off
by default because they ring a real phone and incur provider charges. Turning
calls off, turning the account down or deleting it hangs up that account's
call and drops its support stream.

The renderer passes its session token and server URL to the Electron main
process, which makes every call request. Remote servers must use HTTPS; HTTP is
allowed only on loopback for local development. Signing out, or in as someone
else, hangs up the previous account's call.

For Compose hosting, set the provider variables in the root deployment
environment (or the host's secret settings); `compose.yaml` passes them only to
the server. The local values in `apps/server/.env` are not
uploaded or deployed automatically. Deployments require approval.

## Call flow

The desktop requests a call from `/api/calls/prepare` using its account's
session token. The server authenticates it, creates the LiveKit room, and returns a
five-minute, room-scoped participant token. The desktop joins the room and
publishes its camera and microphone, then asks the server to dial. The server
waits up to five seconds for LiveKit to confirm both tracks and places the
outbound Chert call to its configured destination. The desktop cannot choose
another phone number, project, line, room, or bridge token.

Provider API calls, token signing, status polling, retries, and room cleanup
all run on the server. Only the assigned room token and safe call status reach
the renderer. Microphone samples stay silent until Chert reports `bridge_ready`.

Every call endpoint requires an approved, signed-in account with calls turned
on, even during local use. Call state and operations are isolated between
accounts. The
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

With the server running and a recipient configured, sign the pet in to an
approved account and turn on its calls in the admin UI. Then:

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

Ladybug uses Chert's **shared-line texts**, authenticated with the same server-only
`CHERT_API_KEY`, `CHERT_PROJECT_ID`, and `CHERT_LINE_ID` as FaceTime. The fixed
`EMERGENCY_NUMBER` is also shared. No tenant slug, messaging signing secret, or
webhook subscription is needed for this product.

Open **app.trychert.com → Messages** in the Ladybug project. From the emergency
contact's phone, text `join <code>` to the line using the join code shown there.
The phone must register before the project can exchange texts with it.

Shared-line contract, checked against the live API:

- `POST https://app.trychert.com/api/v1/shared-messages` with
  `{ "line_id": "...", "recipient": "+15551234567", "text": "..." }`.
- Send the project API key as `Authorization: Bearer ftk...`, the project UUID as
  `X-Chert-Project-Id`, and a stable `Idempotency-Key` for every POST retry.
- Poll GET on the same endpoint for the newest 50 messages. There is currently
  no shared-line text webhook.

A successful POST returns `{ data: { id, state: "sent" } }`; queued sends return
their message ID and current state for polling.

The live GET returns `{ data: { items, total, limit, offset } }`; rows include
`id`, `line_id`, `direction`, `state`, `masked_recipient`, `created_at`, and `text`.
Ladybug polls every 15 seconds. More than 50 messages between polls can cause
messages to be missed; the endpoint provides no durable event cursor here.

Browser visits to known unsafe sites and analyses finding unsafe sites queue:

> The user is accessing a website that might not be trustworthy: {url}. If you would like to initiate a FaceTime call for support, reply SUPPORT.

URLs have credentials and fragments removed. Admin checks and manual scans alone
do not message anyone. Redis reserves one notification per normalized hostname
per hour, including concurrent visits and server restarts. Subdomains have separate
limits. The durable outbox retries transient POST failures up to five times with
the same idempotency key. Accepted pending sends retain their returned message ID
and are checked through GET without creating another send. Only `state: sent`
opens a support window; pending/unknown states do not establish delivery.
Messaging failures do not interrupt site checks or pet alerts.

A confirmed send opens a 30-minute support window scoped to the project, line,
and emergency contact. Only inbound `received` text equal to SUPPORT (ignoring
case and surrounding whitespace) is eligible. Both the message's `created_at`
and the polling receipt must fall inside the window. IDs are deduplicated in
Redis; each window is consumed once. Messages predating server startup are ignored.

**Sender matching:** shared-line GET currently masks phone numbers as `•••1234`.
The deployment owner accepts matching the last four digits of registered senders
to `EMERGENCY_NUMBER`. This is not a full-number identity check: registered phones
sharing those digits cannot be distinguished. Full unmasked numbers, if returned,
are compared exactly. No phone number or private message text is written to logs.

The most recently connected eligible desktop receives the request through an
authenticated main-process SSE connection. A desktop must already have been
connected when the reply was recorded. Offline requests are discarded and
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

These tests clear that database. For acceptance after the emergency phone joins,
visit a known unsafe URL, verify the message, reply SUPPORT, and confirm exactly
one desktop starts one call after polling. Check duplicate/expired replies,
wrong line or last-four digits, outbound texts, busy calls and offline/reconnected
desktops. Device media permissions and actual FaceTime remain manual checks.
