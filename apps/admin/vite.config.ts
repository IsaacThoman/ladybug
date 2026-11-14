import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production the server serves the built UI at /admin/ on the same origin as
// the API. In dev, Vite proxies API calls to the server.
const server = process.env.LADYBUG_SERVER_URL ?? "http://localhost:3001";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  // The 3D ladybug (three.js) is one lazy chunk of about 580 kB.
  build: { chunkSizeWarningLimit: 650 },
  server: {
    port: 5174,
    proxy: {
      "/api": server,
      "/health": server,
    },
  },
});
