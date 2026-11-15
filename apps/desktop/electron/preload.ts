import type { CallState } from "../src/calls/types";
import { contextBridge, ipcRenderer } from "electron";
import type { BrainSettings, LadybugApi, OverlayLayout, Point } from "../src/ladybug-api";

const api: LadybugApi = {
  getCallCaptureSource: (id) => ipcRenderer.invoke("ladybug:call-capture-source", id),
  setInteractiveRects: (rects) => ipcRenderer.send("ladybug:set-interactive-rects", rects),
  setCallSession: (session) => ipcRenderer.send("ladybug:set-call-session", session),
  faceTime: {
    prepare: () => ipcRenderer.invoke("ladybug:call-prepare"),
    dial: (id) => ipcRenderer.invoke("ladybug:call-dial", id),
    end: (id) => ipcRenderer.invoke("ladybug:call-end", id),
    getState: () => ipcRenderer.invoke("ladybug:call-state"),
    onSupportRequest: (callback) => {
      const handler = () => callback();
      ipcRenderer.on("ladybug:support-request", handler);
      ipcRenderer.send("ladybug:support-ready", true);
      return () => { ipcRenderer.removeListener("ladybug:support-request", handler); ipcRenderer.send("ladybug:support-ready", false); };
    },
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: CallState) => callback(state);
      ipcRenderer.on("ladybug:call-state", handler);
      return () => { ipcRenderer.removeListener("ladybug:call-state", handler); };
    },
  },
  brain: {
    getData: () => ipcRenderer.invoke("ladybug:brain-data"),
    getSettings: () => ipcRenderer.invoke("ladybug:brain-settings"),
    onSettingsChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: BrainSettings) => callback(settings);
      ipcRenderer.on("ladybug:brain-settings", handler);
      return () => { ipcRenderer.removeListener("ladybug:brain-settings", handler); };
    },
    onCursor: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, point: Point) => callback(point);
      ipcRenderer.on("ladybug:brain-cursor", handler);
      return () => { ipcRenderer.removeListener("ladybug:brain-cursor", handler); };
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
  scanClipboard: () => ipcRenderer.send("ladybug:scan-clipboard"),
  setMenuOpen: (open) => ipcRenderer.send("ladybug:menu-open", open),
  onMenuDismiss: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("ladybug:menu-dismiss", handler);
    return () => { ipcRenderer.removeListener("ladybug:menu-dismiss", handler); };
  },
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
  onFeedRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("ladybug:feed", handler);
    return () => {
      ipcRenderer.removeListener("ladybug:feed", handler);
    };
  },
  focusWindow: () => ipcRenderer.send("ladybug:focus"),
  openExternal: (url) => ipcRenderer.send("ladybug:open-external", url),
};

contextBridge.exposeInMainWorld("ladybug", api);
