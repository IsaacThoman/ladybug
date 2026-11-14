# @ladybug/sandbox

The disposable detonation container. One per scan: a headful Chromium on an Xvfb display, driven by a small HTTP tool daemon that the worker (and through it, the LLM agent) calls. The API is `packages/shared/src/sandbox.ts`.

## Build and run

From the repo root:

```sh
docker build -f apps/sandbox/Dockerfile -t ladybug-sandbox:dev .
docker run --rm -d --name sbx -p 127.0.0.1:17000:7000 -e SANDBOX_TOKEN=test --shm-size=1g ladybug-sandbox:dev
```

(On macOS, host port 7000 belongs to AirPlay Receiver, so map another one.)

Local iteration without Docker (headless, state under `$TMPDIR/ladybug-sandbox`, uses your Playwright browser cache):

```sh
SANDBOX_TOKEN=dev npm run dev -w @ladybug/sandbox
```

## Examples

```sh
T='Authorization: Bearer test'; S=http://localhost:17000
curl $S/healthz
curl -H "$T" -X POST $S/browser/navigate -d '{"url":"https://example.com"}'
curl -H "$T" "$S/browser/screenshot?fullPage=1" -o shot.png
curl -H "$T" "$S/browser/dom?maxChars=20000"
curl -H "$T" "$S/browser/requests?format=har" -o scan.har
curl -H "$T" $S/browser/events
curl -H "$T" -X POST $S/browser/click -d '{"selector":"text=Verify"}'
curl -H "$T" -X POST $S/browser/type -d '{"selector":"#email","text":"a@b.c","pressEnter":true}'
curl -H "$T" -X POST $S/browser/context -d '{"mobile":true}'
curl -H "$T" -X POST $S/exec -d '{"cmd":"yara -r rules.yar ../downloads","timeoutMs":60000}'
curl -H "$T" $S/files
curl -H "$T" "$S/files/downloads/invoice.zip" -o invoice.zip
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `SANDBOX_TOKEN` | required | Bearer token for every route but `GET /healthz`. The daemon exits without it. |
| `SCAN_ID` | | Sent as the proxy username so the gateway can attribute flows (`ladybug` if unset). |
| `PROXY_URL` | | e.g. `http://10.0.0.5:8080`. Chrome and `/exec` children (`HTTP(S)_PROXY`) use it. |
| `GATEWAY_CA_PEM` | | Gateway CA cert. Installed into `~/.pki/nssdb` before Chrome starts; `/exec` gets `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`. With a proxy but no CA, Chrome ignores certificate errors. |
| `DAEMON_PORT` | `7000` | |
| `SANDBOX_HOME` | `/home/sandbox` (Linux) | `downloads/`, `work/` and the daemon's private `.ladybug/` live here. |
| `HEADLESS` | headful on Linux with `DISPLAY` | `1` forces headless. |

## Behaviour notes

- One persistent browser context with a fresh temp profile. `/browser/context` throws it away and starts another (desktop 1280x800, or an iPhone 15 Pro descriptor). The request log and events accumulate across contexts for the whole scan.
- The "active page" is the most recently opened one; popups are recorded and become active. Browser routes run one at a time.
- `navigate` never 500s on navigation failure: it returns `error` plus whatever it learned. `redirectChain` covers HTTP hops and later client-side navigations seen until network idle (bounded at 5 s).
- Dialogs are recorded and dismissed (`beforeunload` is accepted so navigation proceeds). Downloads land in `downloads/` under a sanitised name.
- The init script wraps `eval`, `Function`, string `setTimeout`/`setInterval`, `atob`/`unescape`/`String.fromCharCode` (results of 200+ chars), clipboard writes (`writeText`, `write`, `execCommand("copy")`, `clipboardData.setData`) and permission prompts (notifications, geolocation, camera/mic, push, `permissions.query`). Wrappers are Proxies, so `toString()` still looks native; Playwright's own evaluations are filtered out.
- Request log is capped at 2000 records, post bodies at 2 KB, `/exec` output at 64 KB per stream.

## Security notes

- Chrome runs with `--no-sandbox` (Playwright's default when `chromiumSandbox` is false). The container is the isolation boundary; re-enabling the Chrome sandbox (seccomp profile / user namespaces in the pod) is a production-hardening item.
- Everything runs as the unprivileged `sandbox` user (uid 1001, the base image's `pwuser` renamed), including `/exec`.
- The token is stripped from `/exec` children's environment, but they run as the same uid as the daemon, so a determined payload could still read it from `/proc/<daemon>/environ`. Treat the token as per-sandbox and short-lived, and keep the sandbox network policy to "gateway only, plus ingress from the worker".
- `GET /files/<path>` only serves regular files inside `downloads/` or `work/`; `..`, absolute paths and symlinks anywhere in the path are rejected.
