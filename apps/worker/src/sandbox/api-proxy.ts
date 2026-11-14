import http from "node:http";
import https from "node:https";
import type * as k8s from "@kubernetes/client-node";
import { SANDBOX_DAEMON_PORT } from "@ladybug/shared";
import type { DaemonFetch } from "./client.ts";

/** A sandbox daemon's URL behind the API server's pod proxy. */
export function podProxyUrl(server: string, namespace: string, pod: string) {
  return `${server.replace(/\/$/, "")}/api/v1/namespaces/${namespace}/pods/${pod}:${SANDBOX_DAEMON_PORT}/proxy`;
}

/**
 * fetch() through the Kubernetes API server, for a worker outside the cluster.
 * The kubeconfig supplies the CA and credentials. The API server keeps
 * Authorization for itself, so the daemon's token travels in X-Sandbox-Token,
 * which DaemonClient always sends.
 */
export function apiProxyFetch(kc: k8s.KubeConfig): DaemonFetch {
  return async (url, init = {}) => {
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"),
    );
    if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
    const options: https.RequestOptions = { method: init.method ?? "GET", headers, signal: init.signal };
    await kc.applyToHTTPSOptions(options);
    const send = url.startsWith("https:") ? https.request : http.request;

    return new Promise<Response>((resolve, reject) => {
      const req = send(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          // A Response with one of these statuses can't carry a body.
          const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
          const type = res.headers["content-type"];
          resolve(new Response(body, { status, headers: type ? { "content-type": type } : undefined }));
        });
      });
      req.on("error", reject);
      req.end(init.body);
    });
  };
}
