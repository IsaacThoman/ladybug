// Contract between the Electron preload script and the renderer.

export type Rect = { x: number; y: number; width: number; height: number };

/** Display or development-window layout, in renderer coordinates. */
export type OverlayLayout = {
  width: number;
  height: number;
  /** Display work area, or the padded interior of the development window. */
  workArea: Rect;
};

export type LadybugApi = {
  getLayout: () => Promise<OverlayLayout>;
  onLayoutChanged: (callback: (layout: OverlayLayout) => void) => () => void;
  /**
   * The pet's hit box, in overlay-window coordinates. The main process makes
   * the overlay interactive while the cursor is inside it and click-through
   * everywhere else.
   */
  setPetRect: (rect: Rect) => void;
  /** true while the pet is being dragged, so the overlay stays interactive. */
  setPetHeld: (held: boolean) => void;
  showMenu: () => void;
  /**
   * "Scan clipboard URL" was picked from a menu. `url` is null when the
   * clipboard didn't hold one.
   */
  onScanRequested: (callback: (url: string | null) => void) => () => void;
  /** Opens an http(s) URL in the default browser. */
  openExternal: (url: string) => void;
};

declare global {
  interface Window {
    ladybug: LadybugApi;
  }
}
