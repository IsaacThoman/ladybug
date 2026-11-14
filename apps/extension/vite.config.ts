import path from "node:path";
import { defineConfig } from "vite";

// Builds an unpacked Chrome extension into dist/: load that folder from
// chrome://extensions with "Developer mode" on.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Service workers can't load source maps from eval; keep output readable instead.
    minify: false,
    rollupOptions: {
      input: {
        background: path.join(import.meta.dirname, "src/background.ts"),
        popup: path.join(import.meta.dirname, "popup.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
