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

export type Point = { x: number; y: number };

/**
 * Whether the bug's eyes can see the real screen:
 * - allowed: yes
 * - not-allowed: macOS hasn't given Computerbug Screen Recording permission
 * - unavailable: not here (the development window, or a Wayland session,
 *   which would ask every time the capture starts)
 */
export type ScreenAccess = "allowed" | "not-allowed" | "unavailable";

/** The fly brain preferences from the tray menu. */
export type BrainSettings = {
  /** The fly brain decides how the pet moves. */
  enabled: boolean;
  /** Show what the brain is doing in a panel. */
  showActivity: boolean;
  /** Fly Eyes: the brain sees the screen, or a plain wall when it can't. Only while it's enabled. */
  eyes: boolean;
  screen: ScreenAccess;
};

export type BrainApi = {
  /** The packed connectome, or null when it isn't installed. */
  getData: () => Promise<Uint8Array | null>;
  getSettings: () => Promise<BrainSettings>;
  onSettingsChanged: (callback: (settings: BrainSettings) => void) => () => void;
  /**
   * The cursor anywhere on screen, in renderer coordinates, whenever it moves.
   * Only sent while the fly brain is on, since the click-through overlay
   * doesn't otherwise see it.
   */
  onCursor: (callback: (point: Point) => void) => () => void;
  /**
   * The primary display's capture source, for the bug's eyes. Only while Fly
   * Eyes is on and the screen can be seen; it allows one capture stream.
   */
  getEyesSource: () => Promise<{ id: string }>;
};

export type LadybugApi = {
  faceTime: FaceTimeApi;
  brain: BrainApi;
  getCallCaptureSource: (id: string) => Promise<{ id: string; platform: string }>;
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
  /** true while the pet or its berry is being dragged, so the overlay stays interactive. */
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
  /** "Feed" was picked from the tray or right-click menu. */
  onFeedRequested: (callback: () => void) => () => void;
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
