import type { CallState } from "../src/calls/types";
import { contextBridge, ipcRenderer } from "electron";
import type { LadybugApi, OverlayLayout } from "../src/ladybug-api";

const api: LadybugApi = {
  setInteractiveRects: (rects) => ipcRenderer.send("ladybug:set-interactive-rects", rects),
  faceTime: {
    prepare: () => ipcRenderer.invoke("ladybug:call-prepare"),
    dial: (id) => ipcRenderer.invoke("ladybug:call-dial", id),
    end: (id) => ipcRenderer.invoke("ladybug:call-end", id),
    getState: () => ipcRenderer.invoke("ladybug:call-state"),
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: CallState) => callback(state);
      ipcRenderer.on("ladybug:call-state", handler);
      return () => { ipcRenderer.removeListener("ladybug:call-state", handler); };
    },
  },
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
  onAccountRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("ladybug:show-account", handler);
    return () => {
      ipcRenderer.removeListener("ladybug:show-account", handler);
    };
  },
  focusWindow: () => ipcRenderer.send("ladybug:focus"),
  openExternal: (url) => ipcRenderer.send("ladybug:open-external", url),
};

contextBridge.exposeInMainWorld("ladybug", api);
