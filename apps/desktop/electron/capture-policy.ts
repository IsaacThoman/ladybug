import type { CallState } from "@ladybug/shared";

export function selectScreen<T extends { id: string; display_id: string }>(sources: T[], primary: string): T {
  const source = sources.find((s) => s.display_id === primary) ?? sources[0];
  if (!source) throw new Error("No screen source was selected.");
  return source;
}

/** Authorization is tied to one prepared call, including across OS permission dialogs. */
export class CapturePolicy {
  private selectedCall?: string;
  constructor(privateState: () => CallState) { this.state = privateState; }
  private state: () => CallState;
  current(id: string | undefined) { const state = this.state(); return !!id && state.id === id && state.phase === "ready"; }
  allows(trustedMainFrame: boolean, permission: string) {
    return trustedMainFrame && ["media", "display-capture"].includes(permission) && this.current(this.selectedCall);
  }
  async source(trustedMainFrame: () => boolean, id: string, enumerate: () => Promise<string>) {
    if (!trustedMainFrame() || !this.current(id)) throw new Error("Screen capture is only available for the current prepared call.");
    const source = await enumerate();
    if (!trustedMainFrame() || !this.current(id)) throw new Error("Screen capture was canceled.");
    this.selectedCall = id;
    return source;
  }
}
