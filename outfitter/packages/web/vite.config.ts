import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev proxy to the local api (packages/api, `npm run dev` there) so the web dev server can hit
// /api/* and /agent/* (SSE) without CORS wrangling. Production build is static files served by
// packages/api/src/routes/static.ts at "/", same origin, no proxy needed.
export default defineConfig({
  plugins: [react()],
  // OUTFITTER_DEV baked in at build time (not runtime -- Vite only exposes VITE_-prefixed env vars
  // to import.meta.env by default) so App.tsx's dev-only /panic-test route (the KERNAL PANIC
  // screen, for a screenshot) can gate on the same flag the API already uses, without adding a
  // second env var to remember. A production build with OUTFITTER_DEV unset bakes in "" (falsy),
  // same as never setting it.
  define: {
    "import.meta.env.OUTFITTER_DEV": JSON.stringify(process.env.OUTFITTER_DEV ?? ""),
  },
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
    // Node by default: most of this suite is pure logic (tokenizers, key handling, game engines,
    // status derivation) and spinning up a jsdom per file cost ~13s of a ~21s run. Files that need
    // a DOM opt in with a `@vitest-environment jsdom` docblock on their first line.
    environment: "node",
    // jsdom's Storage API needs a real (non-opaque) origin to back localStorage/sessionStorage;
    // the default "about:blank" leaves window.localStorage undefined.
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
  },
});
