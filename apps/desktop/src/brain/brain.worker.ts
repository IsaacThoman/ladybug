// Runs the fly brain off the render thread. See host.ts for the protocol.
import { createBrain } from "@ladybug/brain";
import type { BrainRequest, BrainResponse } from "@ladybug/brain";
import { createBrainHost } from "./host";

const handle = createBrainHost(createBrain, (response: BrainResponse) => self.postMessage(response));

self.onmessage = (event: MessageEvent<BrainRequest>) => handle(event.data);
