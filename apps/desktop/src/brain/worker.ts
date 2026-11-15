import type { BrainResponse } from "@ladybug/brain";
import type { BrainWorkerFactory } from "./client";

/** Starts brain.worker.ts. Vite bundles it as its own chunk, loaded relative to this module. */
export const createBrainWorker: BrainWorkerFactory = (onMessage, onError) => {
  const worker = new Worker(new URL("./brain.worker.ts", import.meta.url), { type: "module", name: "fly-brain" });
  worker.onmessage = (event: MessageEvent<BrainResponse>) => onMessage(event.data);
  worker.onmessageerror = () => onError("The fly brain sent a message that couldn't be read.");
  worker.onerror = (event) => {
    event.preventDefault();
    onError(event.message || "The fly brain crashed.");
  };
  return {
    post: (request, transfer = []) => worker.postMessage(request, transfer),
    terminate: () => worker.terminate(),
  };
};
