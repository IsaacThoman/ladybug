import { contextBridge, ipcRenderer } from "electron";
import type { LadybugApi, OverlayLayout } from "../src/ladybug-api";

const api: LadybugApi = {
  getLayout: () => ipcRenderer.invoke("ladybug:get-layout"),
  onLayoutChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, layout: OverlayLayout) =>
      callback(layout);
    ipcRenderer.on("ladybug:layout-changed", handler);
    return () => {
      ipcRenderer.removeListener("ladybug:layout-changed", handler);
    };
  },
  setPetRect: (rect) => ipcRenderer.send("ladybug:set-pet-rect", rect),
  setPetHeld: (held) => ipcRenderer.send("ladybug:set-pet-held", held),
  showMenu: () => ipcRenderer.send("ladybug:show-menu"),
  onScanRequested: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string | null) => callback(url);
    ipcRenderer.on("ladybug:scan-url", handler);
    return () => {
      ipcRenderer.removeListener("ladybug:scan-url", handler);
    };
  },
  openExternal: (url) => ipcRenderer.send("ladybug:open-external", url),
};

contextBridge.exposeInMainWorld("ladybug", api);
