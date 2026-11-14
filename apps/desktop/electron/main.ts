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
const windowedDev = Boolean(VITE_DEV_SERVER_URL) && !process.argv.includes("--overlay");
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

const ICON_PATH = path.join(process.env.VITE_PUBLIC, "pulpo.png");

let overlayWin: BrowserWindow | null = null;
let tray: Tray | null = null;

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
    title: windowedDev ? "Ladybug — Development" : "Ladybug",
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

    // Forward mouse moves so the renderer can detect hovering over the pet.
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
  }

  overlayWin.once("ready-to-show", () => {
    // macOS may clamp the initial bounds below the menu bar.
    fitOverlayToDisplay();
    if (windowedDev) overlayWin?.show();
    else overlayWin?.showInactive();
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
    ...(!windowedDev ? [
      { label: "Show / Hide Pet", click: togglePetVisibility },
      { type: "separator" as const },
    ] : []),
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
  if (windowedDev) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.setIgnoreMouseEvents(clickThrough, { forward: true });
});

ipcMain.on("ladybug:show-menu", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) buildMenu().popup({ window: win });
});

// The pet lives in the tray, so keep running when the overlay is closed.
app.on("window-all-closed", () => {
  if (windowedDev) app.quit();
});

app.whenReady().then(() => {
  if (!windowedDev) {
    app.dock?.hide();
    createTray();
  }
  createOverlayWindow();

  screen.on("display-metrics-changed", fitOverlayToDisplay);
  screen.on("display-added", fitOverlayToDisplay);
  screen.on("display-removed", fitOverlayToDisplay);
});
