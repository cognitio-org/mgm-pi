import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev proxy to the local api (packages/api, `npm run dev` there) so the web dev server can hit
// /api/* and /agent/* (SSE) without CORS wrangling. Production build is static files served by
// packages/api/src/routes/static.ts at "/", same origin, no proxy needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8082",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    // jsdom's Storage API needs a real (non-opaque) origin to back localStorage/sessionStorage;
    // the default "about:blank" leaves window.localStorage undefined.
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
  },
});
