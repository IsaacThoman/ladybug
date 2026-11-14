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
  setClickThrough: (clickThrough) =>
    ipcRenderer.send("ladybug:set-click-through", clickThrough),
  showMenu: () => ipcRenderer.send("ladybug:show-menu"),
};

contextBridge.exposeInMainWorld("ladybug", api);
