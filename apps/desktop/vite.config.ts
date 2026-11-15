import path from "node:path";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // The fly brain's worker is a module worker (src/brain/worker.ts), so it
  // can share chunks with the page.
  worker: { format: "es" },
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        async onstart({ startup }) {
          await startup(mode === "overlay" ? [".", "--overlay"] : ["."]);
        },
      },
      preload: {
        input: path.join(import.meta.dirname, "electron/preload.ts"),
      },
      // Polyfill the Electron and Node.js API for the renderer process.
      renderer: process.env.NODE_ENV === "test" ? undefined : {},
    }),
  ],
}));
