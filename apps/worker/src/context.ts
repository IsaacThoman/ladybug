import type { ArtifactStore } from "@ladybug/backend";
import type { DistributiveOmit, ScanEvent, Screenshot } from "./types.ts";

export type EmitFn = (event: ScanEvent) => Promise<void>;

/** Per-scan helpers for emitting events and storing artifacts. */
export class ScanContext {
  readonly scanId: string;
  private emitFn: EmitFn;
  readonly artifacts: ArtifactStore;
  private screenshotCount = 0;

  constructor(scanId: string, emit: EmitFn, artifacts: ArtifactStore) {
    this.scanId = scanId;
    this.emitFn = emit;
    this.artifacts = artifacts;
  }

  async emit(event: DistributiveOmit<ScanEvent, "at">) {
    try {
      await this.emitFn({ ...event, at: new Date().toISOString() } as ScanEvent);
    } catch (err) {
      // Live events are nice to have; never fail a scan over them.
      console.warn(`[worker] ${this.scanId}: emitting ${event.type} failed`, err);
    }
  }

  key(name: string) {
    return `scans/${this.scanId}/${name}`;
  }

  async putArtifact(name: string, body: Buffer | string, contentType: string) {
    const key = this.key(name);
    await this.artifacts.put(key, body, contentType);
    return key;
  }

  /** Stores a screenshot and emits it to the live view. */
  async addScreenshot(png: Buffer, label: string): Promise<Screenshot> {
    const n = String(++this.screenshotCount).padStart(2, "0");
    const slug = label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "shot";
    const artifactKey = await this.putArtifact(`screenshots/${n}-${slug}.png`, png, "image/png");
    await this.emit({ type: "screenshot", artifactKey, label });
    return { artifactKey, label };
  }
}
