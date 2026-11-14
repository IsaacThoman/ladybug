import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The 3D ladybug (three.js) is one lazy chunk of about 580 kB.
  build: { chunkSizeWarningLimit: 650 },
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
