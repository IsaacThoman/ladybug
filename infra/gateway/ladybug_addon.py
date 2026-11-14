"""mitmproxy addon for the ladybug sandbox gateway.

- Refuses upstream connections to private, loopback, link-local, metadata and
  other non-public addresses (the gateway's NetworkPolicy blocks them too).
- Tags each flow with the scan id the sandbox sent as its proxy username.
- Logs one JSON line per flow to stdout.
"""

import ipaddress
import json
import socket
import time

from mitmproxy import ctx, http
from mitmproxy.proxy import server_hooks


def _is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def _resolve(host: str) -> list[str]:
    try:
        return sorted({info[4][0] for info in socket.getaddrinfo(host, None)})
    except socket.gaierror:
        return []


def _scan_id(flow: http.HTTPFlow) -> str:
    auth = flow.metadata.get("proxyauth")
    if isinstance(auth, (tuple, list)) and auth:
        return str(auth[0])[:64]
    return "unknown"


class LadybugGateway:
    def server_connect(self, data: server_hooks.ServerConnectionHookData) -> None:
        if not data.server.address:
            return
        host = data.server.address[0]
        ips = [host] if _looks_like_ip(host) else _resolve(host)
        blocked = [ip for ip in ips if not _is_public(ip)]
        if not ips or blocked:
            reason = "does not resolve" if not ips else f"resolves to non-public address {blocked[0]}"
            data.server.error = f"ladybug gateway: {host} {reason}"
            ctx.log.warn(json.dumps({"event": "blocked", "host": host, "reason": reason}))

    def response(self, flow: http.HTTPFlow) -> None:
        self._log(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        self._log(flow)

    def _log(self, flow: http.HTTPFlow) -> None:
        record = {
            "event": "flow",
            "ts": round(time.time(), 3),
            "scan": _scan_id(flow),
            "method": flow.request.method,
            "url": flow.request.pretty_url[:2000],
            "status": flow.response.status_code if flow.response else None,
            "bytes": len(flow.response.raw_content or b"") if flow.response else None,
            "server_ip": flow.server_conn.peername[0] if flow.server_conn and flow.server_conn.peername else None,
            "error": flow.error.msg if flow.error else None,
        }
        print(json.dumps(record), flush=True)


def _looks_like_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


addons = [LadybugGateway()]
