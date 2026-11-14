import { config } from "../config.ts";
import { DockerProvider } from "./docker.ts";
import { K8sProvider } from "./k8s.ts";
import type { SandboxProvider } from "./provider.ts";

export function createProvider(): SandboxProvider {
  return config.sandboxProvider === "k8s" ? new K8sProvider() : new DockerProvider();
}
