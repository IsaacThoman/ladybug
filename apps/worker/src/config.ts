const env = process.env;

export const config = {
  /** Any OpenAI-compatible Chat Completions endpoint. Unset key or model = signal-only reports. */
  llm: {
    baseUrl: env.LLM_BASE_URL || "https://api.openai.com/v1",
    apiKey: env.LLM_API_KEY || null,
    model: env.LLM_MODEL || null,
    /** Send screenshots to the model. Turn off for text-only models. */
    vision: env.LLM_VISION !== "false",
    /** Optional reasoning_effort for endpoints that support it (low / medium / high). */
    reasoningEffort: env.LLM_REASONING_EFFORT || null,
    /** Stop the investigation once prompt + completion tokens pass this. */
    tokenBudget: Number(env.LLM_TOKEN_BUDGET || 400_000),
  },
  sandboxProvider: (env.SANDBOX_PROVIDER || "docker") as "docker" | "k8s",
  sandboxImage: env.SANDBOX_IMAGE || "ladybug-sandbox:dev",
  sandboxNamespace: env.SANDBOX_NAMESPACE || "sandbox",
  sandboxImagePullSecret: env.SANDBOX_IMAGE_PULL_SECRET || null,
  gatewayHost: env.GATEWAY_HOST || null,
  gatewayProxyUrl: env.GATEWAY_PROXY_URL || null,
  gatewayCaPem: env.GATEWAY_CA_PEM || null,
  /** Or a file holding it, e.g. the gateway's mitmproxy-ca-cert.pem on a shared volume. */
  gatewayCaFile: env.GATEWAY_CA_FILE || null,
  /**
   * Docker provider: run sandboxes on this network and reach them by IP, instead
   * of publishing their port on 127.0.0.1. Needed when the worker itself runs in
   * a container (docker compose / Coolify).
   */
  sandboxDockerNetwork: env.SANDBOX_DOCKER_NETWORK || null,
  safeBrowsingApiKey: env.SAFE_BROWSING_API_KEY || null,
  urlhausAuthKey: env.URLHAUS_AUTH_KEY || null,
  concurrency: Number(env.WORKER_CONCURRENCY || 10),
  /** Hard cap on one scan, end to end. */
  scanTimeoutMs: Number(env.SCAN_TIMEOUT_MS || 8 * 60_000),
  /** Sandboxes older than this are deleted by the janitor. */
  sandboxMaxAgeMs: 15 * 60_000,
};
