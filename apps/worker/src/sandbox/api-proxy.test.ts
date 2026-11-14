import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import * as k8s from "@kubernetes/client-node";
import { SANDBOX_TOKEN_HEADER } from "@ladybug/shared";
import { apiProxyFetch, podProxyUrl } from "./api-proxy.ts";
import { DaemonClient } from "./client.ts";
import { sandboxPodSpec } from "./k8s.ts";

test("pod proxy URL", () => {
  assert.equal(
    podProxyUrl("https://cluster.example:6443/", "sandbox", "sandbox-abc"),
    "https://cluster.example:6443/api/v1/namespaces/sandbox/pods/sandbox-abc:7000/proxy",
  );
});

test("requests carry the cluster's credentials and the daemon token separately", async () => {
  const seen: { url?: string; method?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromOptions({
      // The client only allows plain HTTP with skipTLSVerify.
      clusters: [{ name: "c", server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true }],
      users: [{ name: "u", token: "cluster-token" }],
      contexts: [{ name: "x", cluster: "c", user: "u" }],
      currentContext: "x",
    });
    const base = podProxyUrl(kc.getCurrentCluster()!.server, "sandbox", "sandbox-abc");
    const client = new DaemonClient(base, "daemon-token", apiProxyFetch(kc));

    assert.deepEqual(await client.click({ selector: "#go" }), { ok: true });
    const [request] = seen;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/v1/namespaces/sandbox/pods/sandbox-abc:7000/proxy/browser/click");
    assert.equal(request.headers.authorization, "Bearer cluster-token");
    assert.equal(request.headers[SANDBOX_TOKEN_HEADER], "daemon-token");
    assert.deepEqual(JSON.parse(request.body), { selector: "#go" });
  } finally {
    server.close();
  }
});

test("pod spec takes the gateway settings from a ConfigMap when asked", () => {
  const base = { name: "sandbox-abc", scanId: "scan-1", token: "t" };
  const direct = sandboxPodSpec({ ...base, proxyUrl: "http://10.0.0.1:8080", caPem: "PEM" }).spec!.containers[0];
  assert.deepEqual(direct.env?.map((entry) => entry.name), ["SANDBOX_TOKEN", "SCAN_ID", "PROXY_URL", "GATEWAY_CA_PEM"]);
  assert.equal(direct.envFrom, undefined);

  const fromMap = sandboxPodSpec({ ...base, proxyUrl: null, caPem: null, envConfigMap: "sandbox-env" }).spec!.containers[0];
  assert.deepEqual(fromMap.env?.map((entry) => entry.name), ["SANDBOX_TOKEN", "SCAN_ID"]);
  assert.deepEqual(fromMap.envFrom, [{ configMapRef: { name: "sandbox-env" } }]);
});
