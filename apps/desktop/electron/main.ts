import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OverlayLayout, Rect } from "../src/ladybug-api";
import { parseHttpUrl, urlFromClipboardText } from "../src/urls";

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
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

const ICON_PATH = path.join(process.env.VITE_PUBLIC, "pulpo.png");

const HOVER_POLL_MS = 16;

let overlayWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The pet's hit box in overlay-window coordinates, as reported by the renderer. */
let petRect: Rect | null = null;
/** The pet is being dragged; keep mouse events even if the cursor slips off it. */
let petHeld = false;
let ignoringMouse = true;

/** Layout of the primary display, relative to the overlay window. */
function getOverlayLayout(): OverlayLayout {
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
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setBounds(screen.getPrimaryDisplay().bounds);
  overlayWin.webContents.send("ladybug:layout-changed", getOverlayLayout());
}

function createOverlayWindow() {
  const { bounds } = screen.getPrimaryDisplay();

  overlayWin = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
  });

  // Float above everything, including fullscreen apps and the macOS menu bar.
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The overlay is click-through by default; see updateMouseTracking.
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  ignoringMouse = true;

  // Dropping a link anywhere the pet doesn't handle it would navigate the overlay.
  overlayWin.webContents.on("will-navigate", (event) => event.preventDefault());
  overlayWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  overlayWin.once("ready-to-show", () => {
    // macOS may clamp the initial bounds below the menu bar.
    fitOverlayToDisplay();
    overlayWin?.showInactive();
  });

  overlayWin.on("closed", () => {
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
 * Makes the overlay interactive only while the cursor is over the pet.
 *
 * Hover can't be left to the renderer. With setIgnoreMouseEvents(true,
 * { forward: true }), Electron forwards plain mouse moves, but an OS drag from
 * another app produces drag events instead, which aren't forwarded, and an
 * NSWindow that ignores mouse events is never a drag destination. So the renderer would never see the link hover, and could
 * never turn click-through off. Instead the main process polls the cursor,
 * which keeps updating mid-drag, against the pet rect the renderer reports.
 * Once the window accepts mouse events, the drag session targets it and the
 * page gets ordinary dragenter/dragover/drop events. The same check also
 * makes plain hover independent of forwarded events (Linux has none).
 */
function updateMouseTracking() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  let overPet = false;
  if (petRect) {
    const cursor = screen.getCursorScreenPoint();
    const bounds = overlayWin.getBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    overPet =
      x >= petRect.x &&
      x <= petRect.x + petRect.width &&
      y >= petRect.y &&
      y <= petRect.y + petRect.height;
  }
  const ignore = !(overPet || petHeld);
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  overlayWin.setIgnoreMouseEvents(ignore, { forward: true });
}

function showOverlay() {
  if (!overlayWin) createOverlayWindow();
  else if (!overlayWin.isVisible()) overlayWin.showInactive();
}

async function scanClipboard() {
  const url = urlFromClipboardText(await clipboard.readText().catch(() => ""));
  showOverlay();
  const send = () => overlayWin?.webContents.send("ladybug:scan-url", url);
  if (overlayWin?.webContents.isLoading()) overlayWin.webContents.once("did-finish-load", send);
  else send();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Scan Clipboard URL", click: () => void scanClipboard() },
    { type: "separator" },
    { label: "Show / Hide Pet", click: togglePetVisibility },
    { type: "separator" },
    { label: "Quit Ladybug", role: "quit" },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Ladybug");
  tray.setContextMenu(buildMenu());
}

ipcMain.handle("ladybug:get-layout", () => getOverlayLayout());

ipcMain.on("ladybug:set-pet-rect", (_event, rect: Rect) => {
  petRect = rect;
});

ipcMain.on("ladybug:set-pet-held", (_event, held: boolean) => {
  petHeld = held;
  updateMouseTracking();
});

ipcMain.on("ladybug:open-external", (_event, url: unknown) => {
  const safe = typeof url === "string" ? parseHttpUrl(url) : null;
  if (safe) void shell.openExternal(safe);
});

ipcMain.on("ladybug:show-menu", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) buildMenu().popup({ window: win });
});

// The pet lives in the tray, so keep running when the overlay is closed.
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  // Overlay-only app: no dock icon on macOS.
  app.dock?.hide();

  createTray();
  createOverlayWindow();
  setInterval(updateMouseTracking, HOVER_POLL_MS);

  screen.on("display-metrics-changed", fitOverlayToDisplay);
  screen.on("display-added", fitOverlayToDisplay);
  screen.on("display-removed", fitOverlayToDisplay);
});
