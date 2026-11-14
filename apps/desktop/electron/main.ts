import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OverlayLayout } from "../src/ladybug-api";

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

let overlayWin: BrowserWindow | null = null;
let tray: Tray | null = null;

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

  // The overlay is click-through by default. The renderer turns mouse events
  // back on while the cursor is over the pet; `forward` keeps mousemove events
  // flowing so it can detect that.
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

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

function buildMenu() {
  return Menu.buildFromTemplate([
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

ipcMain.on("ladybug:set-click-through", (event, clickThrough: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.setIgnoreMouseEvents(clickThrough, { forward: true });
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

  screen.on("display-metrics-changed", fitOverlayToDisplay);
  screen.on("display-added", fitOverlayToDisplay);
  screen.on("display-removed", fitOverlayToDisplay);
});
