import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import * as k8s from "@kubernetes/client-node";
import { GATEWAY_PORT, SANDBOX_DAEMON_PORT, SANDBOX_ENV } from "@ladybug/shared";
import { config } from "../config.ts";
import { apiProxyFetch, podProxyUrl } from "./api-proxy.ts";
import { DaemonClient } from "./client.ts";
import { gatewayCaPem, newSandboxToken, waitForDaemon } from "./provider.ts";
import type { Sandbox, SandboxProvider } from "./provider.ts";

export const SANDBOX_APP_LABEL = "ladybug-sandbox";

/** "pool=sandbox" by default; set SANDBOX_NODE_SELECTOR="" to schedule anywhere (e.g. a local kind cluster). */
function nodeSelector(): Record<string, string> | undefined {
  const raw = process.env.SANDBOX_NODE_SELECTOR ?? "pool=sandbox";
  if (!raw) return undefined;
  return Object.fromEntries(raw.split(",").map((pair) => pair.split("=").map((s) => s.trim()) as [string, string]));
}

export function sandboxPodSpec(opts: {
  name: string;
  scanId: string;
  token: string;
  proxyUrl: string | null;
  caPem: string | null;
  /** A ConfigMap in the pod's namespace that supplies the proxy URL and CA instead. */
  envConfigMap?: string | null;
}): k8s.V1Pod {
  const env: k8s.V1EnvVar[] = [
    { name: SANDBOX_ENV.token, value: opts.token },
    { name: SANDBOX_ENV.scanId, value: opts.scanId },
  ];
  if (opts.proxyUrl) env.push({ name: SANDBOX_ENV.proxyUrl, value: opts.proxyUrl });
  if (opts.caPem) env.push({ name: SANDBOX_ENV.gatewayCaPem, value: opts.caPem });
  const selector = nodeSelector();

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: opts.name,
      labels: { "app.kubernetes.io/name": SANDBOX_APP_LABEL, "ladybug.dev/scan-id": opts.scanId },
    },
    spec: {
      restartPolicy: "Never",
      // Backstop: the worker deletes the pod when the scan ends.
      activeDeadlineSeconds: 600,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // No DNS: Chrome resolves hostnames through the gateway proxy, which also
      // closes off DNS tunnelling. NetworkPolicy blocks port 53 regardless.
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      nodeSelector: selector,
      tolerations: selector
        ? Object.entries(selector).map(([key, value]) => ({ key, operator: "Equal", value, effect: "NoSchedule" }))
        : undefined,
      imagePullSecrets: config.sandboxImagePullSecret ? [{ name: config.sandboxImagePullSecret }] : undefined,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "sandbox",
          // No pull policy: Kubernetes then always pulls a `:latest` tag, so a
          // newly pushed sandbox image is used by the next scan.
          image: config.sandboxImage,
          env,
          envFrom: opts.envConfigMap ? [{ configMapRef: { name: opts.envConfigMap } }] : undefined,
          ports: [{ containerPort: SANDBOX_DAEMON_PORT, name: "daemon" }],
          readinessProbe: {
            httpGet: { path: "/healthz", port: SANDBOX_DAEMON_PORT },
            periodSeconds: 1,
            failureThreshold: 60,
          },
          resources: {
            requests: { cpu: "1", memory: "2Gi" },
            limits: { cpu: "2", memory: "3Gi", "ephemeral-storage": "2Gi" },
          },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          volumeMounts: [{ name: "dshm", mountPath: "/dev/shm" }],
        },
      ],
      volumes: [{ name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } }],
    },
  };
}

/**
 * Production provider: one bare Pod per scan in the `sandbox` namespace.
 * The worker owns its lifetime; `activeDeadlineSeconds` and the janitor are
 * backstops for a crashed worker.
 *
 * The worker can run in the cluster and talk to each pod's IP, or outside it
 * (SANDBOX_KUBECONFIG_B64, or a local kubeconfig) and reach the pods through
 * the API server's pod proxy.
 */
export class K8sProvider implements SandboxProvider {
  readonly name: string;
  private kc = new k8s.KubeConfig();
  private core: k8s.CoreV1Api;
  private namespace = config.sandboxNamespace;
  private viaApiProxy: boolean;

  constructor() {
    const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST) && !config.sandboxKubeconfig;
    if (config.sandboxKubeconfig) this.kc.loadFromString(config.sandboxKubeconfig);
    else if (inCluster) this.kc.loadFromCluster();
    else this.kc.loadFromDefault();
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.viaApiProxy = !inCluster;
    this.name = this.viaApiProxy ? "k8s (remote, through the API server)" : "k8s";
  }

  private daemonClient(pod: string, podIp: string, token: string) {
    if (!this.viaApiProxy) return new DaemonClient(`http://${podIp}:${SANDBOX_DAEMON_PORT}`, token);
    const server = this.kc.getCurrentCluster()?.server;
    if (!server) throw new Error("the kubeconfig has no current cluster");
    return new DaemonClient(podProxyUrl(server, this.namespace, pod), token, apiProxyFetch(this.kc));
  }

  /** The sandbox has no DNS, so it gets the gateway as an IP. */
  private async proxyUrl() {
    if (config.gatewayProxyUrl) return config.gatewayProxyUrl;
    if (!config.gatewayHost) return null;
    const { address } = await lookup(config.gatewayHost, { family: 4 });
    return `http://${address}:${GATEWAY_PORT}`;
  }

  async create(scanId: string): Promise<Sandbox> {
    const name = `sandbox-${scanId.slice(0, 8)}-${randomBytes(3).toString("hex")}`;
    const token = newSandboxToken();
    const envConfigMap = config.sandboxEnvConfigMap;
    const body = sandboxPodSpec({
      name,
      scanId,
      token,
      proxyUrl: envConfigMap ? null : await this.proxyUrl(),
      caPem: envConfigMap ? null : await gatewayCaPem(),
      envConfigMap,
    });
    await this.core.createNamespacedPod({ namespace: this.namespace, body });

    try {
      const deadline = Date.now() + config.sandboxStartTimeoutMs;
      let podIp: string | undefined;
      while (Date.now() < deadline) {
        const pod = await this.core.readNamespacedPod({ name, namespace: this.namespace });
        const phase = pod.status?.phase;
        if (phase === "Failed" || phase === "Succeeded") throw new Error(`sandbox pod ${name} exited (${phase})`);
        const ready = pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");
        if (ready && pod.status?.podIP) {
          podIp = pod.status.podIP;
          break;
        }
        await sleep(500);
      }
      if (!podIp) throw new Error(`sandbox pod ${name} wasn't ready in ${config.sandboxStartTimeoutMs / 1000}s`);
      const client = this.daemonClient(name, podIp, token);
      await waitForDaemon(client, 30_000);
      return { id: name, client };
    } catch (err) {
      await this.destroy(name);
      throw err;
    }
  }

  async destroy(id: string) {
    try {
      await this.core.deleteNamespacedPod({ name: id, namespace: this.namespace, gracePeriodSeconds: 0 });
    } catch (err) {
      if ((err as { code?: number }).code !== 404) console.warn(`[worker] deleting pod ${id} failed`, err);
    }
  }

  async reap(maxAgeMs: number) {
    const pods = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `app.kubernetes.io/name=${SANDBOX_APP_LABEL}`,
    });
    let reaped = 0;
    for (const pod of pods.items) {
      const created = pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).getTime() : 0;
      const finished = pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed";
      if (pod.metadata?.name && (finished || Date.now() - created > maxAgeMs)) {
        await this.destroy(pod.metadata.name);
        reaped++;
      }
    }
    return reaped;
  }
}
