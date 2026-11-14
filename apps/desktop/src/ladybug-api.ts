// Contract between the Electron preload script and the renderer.

export type Rect = { x: number; y: number; width: number; height: number };

/** Primary display layout, in overlay-window coordinates. */
export type OverlayLayout = {
  width: number;
  height: number;
  /** Area not covered by the dock/taskbar/menu bar. */
  workArea: Rect;
};

export type LadybugApi = {
  getLayout: () => Promise<OverlayLayout>;
  onLayoutChanged: (callback: (layout: OverlayLayout) => void) => () => void;
  /** true = clicks pass through the overlay to the apps underneath. */
  setClickThrough: (clickThrough: boolean) => void;
  showMenu: () => void;
};

declare global {
  interface Window {
    ladybug: LadybugApi;
  }
}
