import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
  systemPreferences,
} from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OverlayLayout, Rect } from "../src/ladybug-api";
import { parseHttpUrl, urlFromClipboardText } from "../src/urls";
import { SupportSubscription } from "./support-stream";
import { CallService } from "./call-service";
import { CapturePolicy, selectScreen } from "./capture-policy";
import { parseCallAuth } from "./call-config";
import type { CallAuth } from "./call-config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// Use ['ENV_NAME'] to avoid vite:define replacing it at build time.
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const windowedDev = Boolean(VITE_DEV_SERVER_URL) && !process.argv.includes("--overlay");
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

const ICON_PATH = path.join(process.env.VITE_PUBLIC, "icon.png");

const HOVER_POLL_MS = 16;

let overlayWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The pet's hit box in overlay-window coordinates, as reported by the renderer. */
let petRect: Rect | null = null;
/** Additional interactive surfaces, including the FaceTime panel. */
let interactiveRects: Rect[] = [];
/** The pet is being dragged; keep mouse events even if the cursor slips off it. */
let petHeld = false;
let ignoringMouse = true;
/** The signed-in account, from the renderer. Support calls are placed as this user. */
let callAuth: CallAuth | null = null;
let supportReady = false;
const calls = new CallService({ auth: () => callAuth });
const capturePolicy = new CapturePolicy(calls.getState);
const support = new SupportSubscription(() => {
  if (overlayWin && !overlayWin.isDestroyed() && ["idle", "ended", "error"].includes(calls.getState().phase)) {
    showOverlay();
    overlayWin.webContents.send("ladybug:support-request");
  }
}, { auth: () => callAuth });
const fromOverlay = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
  event.sender === overlayWin?.webContents && event.senderFrame === event.sender.mainFrame;
ipcMain.on("ladybug:support-ready", (event, ready: boolean) => {
  if (!fromOverlay(event)) return;
  supportReady = ready;
  if (ready) support.start(); else support.stop();
});
ipcMain.on("ladybug:set-call-session", (event, input: unknown) => {
  if (!fromOverlay(event)) return;
  let next: CallAuth | null;
  try { next = parseCallAuth(input); } catch { next = null; }
  if (next?.url === callAuth?.url && next?.token === callAuth?.token) return;
  const switched = callAuth !== null;
  callAuth = next;
  // Signing out (or in as someone else) hangs up the previous account's call.
  if (switched) void calls.endCurrent();
  support.stop();
  if (supportReady) support.start();
});
ipcMain.on("ladybug:scan-clipboard", (event) => {
  if (event.sender === overlayWin?.webContents) void scanClipboard();
});
ipcMain.on("ladybug:menu-open", (event, open: boolean) => {
  if (event.sender !== overlayWin?.webContents) return;
  if (open) overlayWin?.focus();
});
calls.subscribe((state) => {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send("ladybug:call-state", state);
});
function trustedCall(event: Electron.IpcMainInvokeEvent) {
  if (!overlayWin || event.sender !== overlayWin.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Untrusted call request.");
  }
}
ipcMain.handle("ladybug:call-prepare", (event) => {
  trustedCall(event);
  return calls.prepare();
});
ipcMain.handle("ladybug:call-dial", (event, id: string) => { trustedCall(event); return calls.dial(id); });
ipcMain.handle("ladybug:call-end", (event, id: string) => { trustedCall(event); return calls.end(id); });
ipcMain.handle("ladybug:call-state", (event) => { trustedCall(event); return calls.getState(); });

ipcMain.handle("ladybug:call-capture-source", async (event, id: string) => {
  trustedCall(event);
  const source = await capturePolicy.source(() => fromOverlay(event), id, async () =>
    selectScreen(await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }),
      String(screen.getPrimaryDisplay().id)).id);
  return { id: source, platform: process.platform };
});

/** Movement bounds in renderer coordinates. */
function getOverlayLayout(): OverlayLayout {
  if (windowedDev && overlayWin) {
    const [width, height] = overlayWin.getContentSize();
    const padding = 24;
    return {
      width,
      height,
      workArea: {
        x: padding,
        y: padding,
        width: width - padding * 2,
        height: height - padding * 2,
      },
    };
  }
  const { bounds, workArea } = screen.getPrimaryDisplay();
  return {
    width: bounds.width,
    height: bounds.height,
    workArea: {
      x: workArea.x - bounds.x,
      y: workArea.y - bounds.y,
      width: workArea.width,
      height: workArea.height,
    },
  };
}

function fitOverlayToDisplay() {
  if (windowedDev || !overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setBounds(screen.getPrimaryDisplay().bounds);
  overlayWin.webContents.send("ladybug:layout-changed", getOverlayLayout());
}

function createOverlayWindow() {
  const { bounds } = screen.getPrimaryDisplay();

  overlayWin = new BrowserWindow({
    ...(windowedDev ? { width: 960, height: 640, minWidth: 480, minHeight: 360 } : bounds),
    title: windowedDev ? "Ladybugg — Development" : "Ladybugg",
    show: false,
    transparent: !windowedDev,
    backgroundColor: windowedDev ? "#e8edf2" : "#00000000",
    frame: windowedDev,
    hasShadow: windowedDev,
    resizable: windowedDev,
    movable: windowedDev,
    minimizable: windowedDev,
    maximizable: windowedDev,
    fullscreenable: false,
    skipTaskbar: !windowedDev,
    alwaysOnTop: !windowedDev,
    enableLargerThanScreen: !windowedDev,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      backgroundThrottling: false,
    },
  });

  if (windowedDev) {
    overlayWin.center();
    overlayWin.on("resize", () => {
      overlayWin?.webContents.send("ladybug:layout-changed", getOverlayLayout());
    });
  } else {
    // Float above everything, including fullscreen apps and the macOS menu bar.
    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // The overlay is click-through by default; see updateMouseTracking.
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    ignoringMouse = true;
  }

  // Dropping a link anywhere the pet doesn't handle it would navigate the window.
  overlayWin.webContents.on("will-navigate", (event) => event.preventDefault());
  overlayWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  overlayWin.once("ready-to-show", () => {
    // macOS may clamp the initial bounds below the menu bar.
    fitOverlayToDisplay();
    if (windowedDev) overlayWin?.show();
    else overlayWin?.showInactive();
  });

  overlayWin.on("blur", () => overlayWin?.webContents.send("ladybug:menu-dismiss"));
  const endMedia = () => {
    support.stop();
    void calls.endCurrent();
  };
  overlayWin.webContents.on("render-process-gone", endMedia);
  overlayWin.webContents.on("did-start-loading", endMedia);
  const trustedMediaFrame = (contents: Electron.WebContents | null, details: { isMainFrame: boolean; requestingUrl?: string }) =>
    contents === overlayWin?.webContents && details.isMainFrame && details.requestingUrl === contents?.mainFrame.url;
  overlayWin.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    capturePolicy.allows(trustedMediaFrame(contents, details), permission));
  overlayWin.webContents.session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const allowed = () => capturePolicy.allows(trustedMediaFrame(contents, details), permission);
    if (!allowed()) { callback(false); return; }
    const id = calls.getState().id;
    if (process.platform === "darwin" && permission === "media") {
      try {
        const types = "mediaTypes" in details ? details.mediaTypes : undefined;
        if (!types?.length) { callback(false); return; }
        for (const type of types) {
          if (!await systemPreferences.askForMediaAccess(type === "audio" ? "microphone" : "camera") || !allowed() || !capturePolicy.current(id)) {
            callback(false); return;
          }
        }
        callback(allowed() && capturePolicy.current(id));
      } catch { callback(false); }
    } else callback(allowed() && capturePolicy.current(id));
  });

  overlayWin.on("closed", () => {
    endMedia();
    interactiveRects = [];
    petRect = null;
    petHeld = false;
    overlayWin = null;
  });

  if (VITE_DEV_SERVER_URL) {
    overlayWin.loadURL(VITE_DEV_SERVER_URL);
  } else {
    overlayWin.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

function togglePetVisibility() {
  if (!overlayWin) {
    createOverlayWindow();
    return;
  }
  if (overlayWin.isVisible()) overlayWin.hide();
  else overlayWin.showInactive();
}

/**
 * Makes the overlay interactive while the cursor is over the pet or call panel.
 *
 * Hover can't be left to the renderer. With setIgnoreMouseEvents(true,
 * { forward: true }), Electron forwards plain mouse moves, but an OS drag from
 * another app produces drag events instead, which aren't forwarded, and an
 * NSWindow that ignores mouse events is never a drag destination. So the
 * renderer would never see the link hover, and could never turn click-through
 * off. Instead the main process polls the cursor,
 * which keeps updating mid-drag, against the pet rect the renderer reports.
 * Once the window accepts mouse events, the drag session targets it and the
 * page gets ordinary dragenter/dragover/drop events. The same check also
 * makes plain hover independent of forwarded events (Linux has none).
 */
function updateMouseTracking() {
  // The development window is an ordinary window that always takes clicks.
  if (windowedDev) return;
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = overlayWin.getBounds();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  const rects = petRect ? [petRect, ...interactiveRects] : interactiveRects;
  const overInteractive = rects.some((rect) =>
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
  const ignore = !(overInteractive || petHeld);
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  overlayWin.setIgnoreMouseEvents(ignore, { forward: true });
}

function showOverlay() {
  if (!overlayWin) createOverlayWindow();
  else if (windowedDev) overlayWin.show();
  else if (!overlayWin.isVisible()) overlayWin.showInactive();
}

async function scanClipboard() {
  const url = urlFromClipboardText(await clipboard.readText().catch(() => ""));
  showOverlay();
  const send = () => overlayWin?.webContents.send("ladybug:scan-url", url);
  if (overlayWin?.webContents.isLoading()) overlayWin.webContents.once("did-finish-load", send);
  else send();
}

function showAccount() {
  showOverlay();
  const send = () => overlayWin?.webContents.send("ladybug:show-account");
  if (overlayWin?.webContents.isLoading()) overlayWin.webContents.once("did-finish-load", send);
  else send();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Scan Clipboard URL", click: () => void scanClipboard() },
    { label: "Account…", click: showAccount },
    { type: "separator" },
    ...(!windowedDev ? [
      { label: "Show / Hide Pet", click: togglePetVisibility },
      { type: "separator" as const },
    ] : []),
    { label: "Quit Ladybugg", role: "quit" },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Ladybugg");
  tray.setContextMenu(buildMenu());
}

ipcMain.handle("ladybug:get-layout", () => getOverlayLayout());

ipcMain.on("ladybug:set-pet-rect", (_event, rect: Rect) => {
  petRect = rect;
});

ipcMain.on("ladybug:set-interactive-rects", (event, rects: Rect[]) => {
  if (event.sender !== overlayWin?.webContents || !Array.isArray(rects)) return;
  interactiveRects = rects.filter((rect) => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0).slice(0, 32);
  updateMouseTracking();
});

ipcMain.on("ladybug:set-pet-held", (_event, held: boolean) => {
  petHeld = held;
  updateMouseTracking();
});

ipcMain.on("ladybug:open-external", (_event, url: unknown) => {
  const safe = typeof url === "string" ? parseHttpUrl(url) : null;
  if (safe) void shell.openExternal(safe);
});

// The overlay is shown without focus so it never steals the keyboard; the
// sign-in form asks for it when the user clicks into it.
ipcMain.on("ladybug:focus", (event) => {
  if (!overlayWin || event.sender !== overlayWin.webContents) return;
  if (process.platform === "darwin") app.focus({ steal: true });
  overlayWin.focus();
});

ipcMain.on("ladybug:show-menu", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) buildMenu().popup({ window: win });
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || ["idle", "ended", "error"].includes(calls.getState().phase)) return;
  event.preventDefault();
  void calls.endCurrent();
  const unsubscribe = calls.subscribe((state) => {
    if (["ended", "error"].includes(state.phase)) { unsubscribe(); quitting = true; app.quit(); }
  });
  setTimeout(() => { quitting = true; app.quit(); }, 15_000).unref();
});

// The pet lives in the tray, so keep running when the overlay is closed.
app.on("window-all-closed", () => {
  if (windowedDev) app.quit();
});

app.whenReady().then(() => {
  // Keep renderer media queries and native menus aligned with the system theme.
  nativeTheme.themeSource = "system";
  if (!windowedDev) {
    app.dock?.hide();
    createTray();
  }
  createOverlayWindow();
  // Click-through only applies to the overlay; the development window takes clicks.
  if (!windowedDev) setInterval(updateMouseTracking, HOVER_POLL_MS);

  screen.on("display-metrics-changed", fitOverlayToDisplay);
  screen.on("display-added", fitOverlayToDisplay);
  screen.on("display-removed", fitOverlayToDisplay);
});
