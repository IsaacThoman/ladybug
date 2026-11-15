import type { FaceTimeApi } from "./calls/types";

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
  faceTime: FaceTimeApi;
  /**
   * The signed-in session (or null after signing out). The main process
   * places support calls as this account, on the server that issued it.
   */
  setCallSession: (session: { url: string; token: string } | null) => void;
  getLayout: () => Promise<OverlayLayout>;
  onLayoutChanged: (callback: (layout: OverlayLayout) => void) => () => void;
  /**
   * The pet's hit box, in overlay-window coordinates. The main process makes
   * the overlay interactive while the cursor is inside it and click-through
   * everywhere else.
   */
  setPetRect: (rect: Rect) => void;
  /** Other clickable surfaces, polled with the pet's hit box in the main process. */
  setInteractiveRects: (rects: Rect[]) => void;
  /** true while the pet is being dragged, so the overlay stays interactive. */
  setPetHeld: (held: boolean) => void;
  scanClipboard: () => void;
  setMenuOpen: (open: boolean) => void;
  onMenuDismiss: (callback: () => void) => () => void;
  showMenu: () => void;
  /**
   * "Scan clipboard URL" was picked from a menu. `url` is null when the
   * clipboard didn't hold one.
   */
  onScanRequested: (callback: (url: string | null) => void) => () => void;
  /** "Account…" was picked from a menu. */
  onAccountRequested: (callback: () => void) => () => void;
  /** Gives the overlay keyboard focus, for typing into the sign-in form. */
  focusWindow: () => void;
  /** Opens an http(s) URL in the default browser. */
  openExternal: (url: string) => void;
};

declare global {
  interface Window {
    ladybug: LadybugApi;
  }
}
