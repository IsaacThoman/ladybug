# Egress gateway for sandboxes: mitmproxy plus a small addon that tags every
# flow with its scan id and refuses to connect to internal addresses.
FROM mitmproxy/mitmproxy:12.3.1

COPY infra/gateway/ladybug_addon.py /addons/ladybug_addon.py

EXPOSE 8080
# proxyauth=any: clients must send proxy credentials (the sandbox sends the
# scan id as the username) but any value is accepted.
# The CA lives in /home/mitmproxy/.mitmproxy, mounted from the gateway-ca Secret.
CMD ["mitmdump", "--listen-port", "8080", "--set", "proxyauth=any", "--set", "block_global=false", "--set", "connection_strategy=lazy", "-s", "/addons/ladybug_addon.py", "--quiet"]
