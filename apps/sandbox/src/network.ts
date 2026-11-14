import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { errorMessage } from "./util.ts";

const execFileAsync = promisify(execFile);

const SYSTEM_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"];

export type NetworkSetup = {
  /** Gateway CA installed into Chrome's NSS db. */
  caTrusted: boolean;
  caPath: string | null;
  /** System bundle + gateway CA, for curl/openssl/python children. */
  caBundlePath: string | null;
};

function normalizePem(pem: string) {
  // Env vars sometimes arrive with literal "\n".
  const text = pem.includes("\\n") && !pem.includes("\n") ? pem.replaceAll("\\n", "\n") : pem;
  return text.trim() + "\n";
}

/**
 * Writes the gateway CA to disk and trusts it in the user's NSS db (which
 * Chrome on Linux reads) before Chrome starts.
 */
export async function setupNetwork(config: Config): Promise<NetworkSetup> {
  const setup: NetworkSetup = { caTrusted: false, caPath: null, caBundlePath: null };
  if (!config.gatewayCaPem) return setup;

  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const caPath = path.join(config.stateDir, "gateway-ca.pem");
  const pem = normalizePem(config.gatewayCaPem);
  await fs.writeFile(caPath, pem, { mode: 0o644 });
  setup.caPath = caPath;

  const systemBundle = SYSTEM_BUNDLES.find((p) => existsSync(p));
  const bundlePath = path.join(config.stateDir, "ca-bundle.pem");
  const system = systemBundle ? await fs.readFile(systemBundle, "utf8") : "";
  await fs.writeFile(bundlePath, system + "\n" + pem, { mode: 0o644 });
  setup.caBundlePath = bundlePath;

  const nssDir = path.join(config.home, ".pki", "nssdb");
  try {
    await fs.mkdir(nssDir, { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(nssDir, "cert9.db"))) {
      await execFileAsync("certutil", ["-d", `sql:${nssDir}`, "-N", "--empty-password"]);
    }
    await execFileAsync("certutil", [
      "-d",
      `sql:${nssDir}`,
      "-A",
      "-t",
      "C,,",
      "-n",
      "ladybug-gateway",
      "-i",
      caPath,
    ]);
    setup.caTrusted = true;
  } catch (error) {
    console.warn(`[sandbox] could not install gateway CA into NSS db: ${errorMessage(error)}`);
  }
  return setup;
}

/** Environment for /exec children: proxy + CA, minus daemon secrets. */
export function childEnv(config: Config, network: NetworkSetup): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SANDBOX_TOKEN;
  delete env.GATEWAY_CA_PEM;
  env.HOME = config.home;
  if (config.proxyUrl) {
    const proxy = proxyUrlWithAuth(config);
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
      env[name] = proxy;
    }
    env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
  }
  if (network.caBundlePath) {
    env.CURL_CA_BUNDLE = network.caBundlePath;
    env.SSL_CERT_FILE = network.caBundlePath;
    env.REQUESTS_CA_BUNDLE = network.caBundlePath;
  }
  if (network.caPath) env.NODE_EXTRA_CA_CERTS = network.caPath;
  return env;
}

export function proxyUsername(config: Config) {
  return config.scanId || "ladybug";
}

function proxyUrlWithAuth(config: Config) {
  try {
    const url = new URL(config.proxyUrl);
    if (!url.username) {
      url.username = encodeURIComponent(proxyUsername(config));
      url.password = "x";
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return config.proxyUrl;
  }
}
